const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ChallengerPreviewService } = require('../dist/research/ChallengerPreviewService');
const { baselineManifest } = require('../dist/research/ForecastCore');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { COHERENT_PROBABILITY_PROTOCOL, coherentProbabilityPipelineHash } = require('../dist/research/CoherentProbabilityPipeline');
const { scoreMatrixMarkets } = require('../dist/research/GoalSettlement');

const at = '2026-10-31T12:00:00.000Z';
const clone = (value) => JSON.parse(JSON.stringify(value));
const matrix = [[.2, .2, 0], [.6, 0, 0], [0, 0, 0]];
function fixture() {
  const baselineVersion = baselineManifest().version;
  const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion,
    pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity' });
  const f = { now: Date.parse(at), row: { match_id: 'm1', date: '2026-10-31T20:00:00Z', competition: 'Serie A',
    season: '2026/2027', home_team_id: 'home', away_team_id: 'away', home_goals: null, away_goals: null },
  // This injected runtime returns synthetic identity-calibrated decisions, not the current release artifact.
  state: { deployment: { modelVersion: 'C-preview-service-fixture', baselineVersion,
    selectorPolicy: 'canonical-binary-v1', probabilityConfigurationHash: configuration.hash, artifactHash: null },
    revision: 'fixture', source: 'fallback' },
  archived: false, legacy: false, beforePrepare: null, preparedOverride: null,
  marketOverride: null, failPrepare: null, stateFailure: false, archiveFailure: false,
  calls: { prepared: [], factories: [], archive: 0, deployment: 0, writes: [] } };
  const noWrite = (name) => async () => { f.calls.writes.push(name); assert.fail(`Forbidden business mutation: ${name}`); };
  f.prepared = (job) => {
    const now = new Date(f.now).toISOString();
    const quotes = [['homeWin', 'home', 2], ['draw', 'draw', 4], ['awayWin', 'away', 4]].map(([selection, side, odds]) => ({
      selection, side, odds, market: '1x2', bookmaker: 'Real Book', source: 'odds_api', priceType: 'prematch', capturedAt: now, updatedAt: now,
    }));
    const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: f.state.deployment.baselineVersion,
      pipelineHashV2: coherentProbabilityPipelineHash(), mode: 'identity' });
    return { job, status: 'upcoming', kickoffAt: f.row.date, quotes, inputSnapshot: {}, decisions: [{
      family: 'C', modelVersion: f.state.deployment.modelVersion, validated: true, action: 'ABSTAIN',
      probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL, calibrationPipelineHash: coherentProbabilityPipelineHash(),
      calibrationAvailableAt: '2026-10-27T00:00:00Z', forecastAt: now, prospectiveMatrix: matrix,
      probabilityConfiguration: configuration.descriptor, probabilityConfigurationHash: configuration.hash,
      probabilityStages: { raw: scoreMatrixMarkets(matrix), decision: scoreMatrixMarkets(matrix) }, score: 0,
    }] };
  };
  f.db = {
    getMatchById: async (id) => f.row && clone({ ...f.row, match_id: id }),
    getMatches: noWrite('unexpected history access outside C runtime'),
    saveSchedulerRun: noWrite('saveSchedulerRun'), updateMatchKickoff: noWrite('updateMatchKickoff'),
    placeBet: noWrite('placeBet'), saveBet: noWrite('saveBet'), appendPredictions: noWrite('appendPredictions'),
    research: {
      listDecisions: async () => [], listLegacyDecisionViews: async ({ matchId }) => f.legacy
        ? [{ id: 'legacy', matchId, family: 'C', action: 'ABSTAIN', createdAt: at }] : [],
      listMarkets: async ({ family }) => {
        assert.equal(family, 'C');
        if (f.marketOverride) await f.marketOverride();
        return [{ family: 'C', market: '1x2', state: 'EXPERIMENTAL' }];
      },
      saveModel: noWrite('saveModel'), commitBatch: noWrite('commitBatch'), syncJobs: noWrite('syncJobs'),
      initializePortfolios: noWrite('initializePortfolios'), setMarketState: noWrite('setMarketState'),
      appendProspectiveResidual: noWrite('appendProspectiveResidual'),
    },
    recommendations: {
      listDecisionViews: async ({ matchId }) => {
        f.calls.archive++;
        if (f.archiveFailure) throw new Error('private-api-token-sentinel');
        return f.archived ? [{ id: 'execution', matchId, family: 'C', action: 'ABSTAIN', createdAt: at }] : [];
      }, claimJob: noWrite('claimJob'), commitBatch: noWrite('recommendationCommit'),
    },
    challengerAdoption: {
      getState: async () => { f.calls.deployment++; if (f.stateFailure) throw new Error('private-token-sentinel'); return clone(f.state); },
      reviewCandidates: noWrite('reviewCandidates'), recordPairedChallengerForecast: noWrite('recordPairedChallengerForecast'),
    },
  };
  f.odds = { getOdds: async () => assert.fail('The injected runtime must own its own quote acquisition'), getQuotaStatus: () => null };
  f.options = { clock: () => new Date(f.now), odds: f.odds, runtimeFactory: (_db, options) => {
    f.calls.factories.push(options);
    return { preparePreviewC: async (job) => {
      f.calls.prepared.push(job);
      if (f.failPrepare) throw f.failPrepare;
      const prepared = f.prepared(job);
      if (f.beforePrepare) await f.beforePrepare(job, prepared);
      return f.preparedOverride ? f.preparedOverride(prepared) : prepared;
    } };
  } };
  f.service = new ChallengerPreviewService(f.db, f.options);
  return f;
}

test('C preview uses the genuine C selector without invoking A or mutating business state', async () => {
  const f = fixture();
  const original = JSON.stringify({ row: f.row, state: f.state });
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'RECOMMENDED');
  assert.equal(result.recommendationPacket.selected.selection, 'homeWin');
  assert.equal(result.recommendationPacket.selected.bookmakerOdds, 2);
  assert.equal(result.recommendationPacket.selected.bookmakerName, 'Real Book');
  assert.equal(result.recommendationPacket.selected.suggestedStakePercent, 1);
  assert.equal(result.suggestedStakePercent, 1); assert.equal(result.registered, false);
  assert.equal(result.asOf, at); assert.equal(result.expiresAt, '2026-10-31T12:05:00.000Z');
  assert.equal(result.modelVersion, f.state.deployment.modelVersion);
  assert.equal(result.kind, 'C_PREVIEW'); assert.equal(result.family, 'C');
  assert.ok(!('action' in result) && !('betId' in result) && !('stakeCents' in result));
  assert.deepEqual(f.calls.writes, []);
  assert.equal(JSON.stringify({ row: f.row, state: f.state }), original);
  assert.deepEqual(f.calls.factories[0].deploymentC, f.state.deployment);
  assert.equal(f.calls.factories[0].odds, f.odds);
  assert.equal(f.calls.factories[0].nightly.quoteMaxAgeMs, 300000);
});

test('exhausted C reads fail closed and log only a fixed internal stage and transport code', async (t) => {
  const f = fixture();
  f.failPrepare = Object.assign(new Error('https://private.example/?apiKey=private-api-token-sentinel'), {
    cause: { cause: { code: 'UND_ERR_SOCKET' } },
  });
  const logs = []; t.mock.method(console, 'warn', (value) => logs.push(value));
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.reason, 'challenger_preview_unavailable');
  assert.equal(result.registered, false); assert.equal(result.recommendationPacket, null);
  assert.equal(f.calls.prepared.length, 1);
  assert.deepEqual(logs.map(JSON.parse), [{ event: 'challenger_preview_failed', stage: 'compute', code: 'UND_ERR_SOCKET' }]);
  assert.ok(!JSON.stringify({ result, logs }).includes('private'));
});

test('NO_BET is a valid calibrated result with a current expiry, distinct from technical failure', async () => {
  const f = fixture();
  f.preparedOverride = (prepared) => ({ ...prepared, quotes: prepared.quotes.map((quote) => ({ ...quote, odds: 1.01 })) });
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'NO_BET'); assert.equal(result.reason, 'challenger_no_recommendation');
  assert.equal(result.recommendationPacket.selected, null); assert.equal(result.quote, null);
  assert.ok(Date.parse(result.expiresAt) > f.now);
  f.now += 31000;
  f.preparedOverride = (prepared) => ({ ...prepared, decisions: [{ ...prepared.decisions[0], validated: false,
    reason: 'validated_calibration_unavailable' }] });
  const failed = await f.service.preview('m1');
  assert.equal(failed.status, 'UNAVAILABLE'); assert.equal(failed.reason, 'validated_calibration_unavailable');
  assert.equal(failed.recommendationPacket, null);
});

test('the canonical binary split-stake exclusion stays a named no-bet instead of a technical model failure', async () => {
  const f = fixture();
  f.db.research.listMarkets = async () => [{ family: 'C', market: 'asian_handicap', state: 'EXPERIMENTAL' }];
  f.preparedOverride = (prepared) => ({ ...prepared, quotes: [
    { ...prepared.quotes[0], market: 'asian_handicap', selection: 'ahcp_-0.25', side: 'home', line: -.25 },
    { ...prepared.quotes[0], market: 'asian_handicap', selection: 'ahcp_away_0.25', side: 'away', line: .25 },
  ] });
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'NO_BET'); assert.equal(result.reason, 'non_binary_payout_not_supported_by_canonical_engine');
  assert.equal(result.recommendationPacket.selected, null); assert.equal(result.registered, false);
});

test('missing or suspended deployment fails closed before any inference', async () => {
  for (const mode of ['failure', 'suspended']) {
    const f = fixture();
    if (mode === 'failure') f.stateFailure = true; else f.state.source = 'suspended';
    const result = await f.service.preview('m1');
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(f.calls.prepared.length, 0);
    assert.equal(result.recommendationPacket, null);
    assert.ok(!JSON.stringify(result).includes('private-token-sentinel'));
  }
});

test('invalid, past, finished or unsupported fixtures never invoke C or obtain prices', async () => {
  for (const change of [null, { date: 'unknown' }, { date: '2026-10-31T12:00:00Z' },
    { home_goals: 0 }, { competition: 'Outside Top 5' }, { home_team_id: '' }]) {
    const f = fixture(); f.row = change === null ? null : { ...f.row, ...change };
    const result = await f.service.preview('m1');
    assert.equal(result.status, 'NOT_ELIGIBLE'); assert.equal(f.calls.prepared.length, 0);
  }
  const f = fixture();
  assert.equal((await f.service.preview('')).status, 'NOT_ELIGIBLE');
  assert.equal((await f.service.preview('x'.repeat(201))).status, 'NOT_ELIGIBLE');
});

test('effective Nightly C decisions retain priority; legacy research rows do not block a preview', async () => {
  const f = fixture(); f.archived = true;
  assert.equal((await f.service.preview('m1')).status, 'ARCHIVED');
  assert.equal(f.calls.prepared.length, 0);
  f.archived = false; f.legacy = true;
  assert.equal((await f.service.preview('m1')).status, 'RECOMMENDED');
  assert.equal(f.calls.prepared.length, 1);
});

test('an unavailable archive is not mistaken for an absent Nightly decision', async () => {
  const f = fixture(); f.archiveFailure = true;
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'UNAVAILABLE'); assert.equal(f.calls.prepared.length, 0);
  assert.ok(!JSON.stringify(result).includes('private-api-token-sentinel'));
});

test('a Nightly decision published during inference suppresses the completed preview', async () => {
  const f = fixture(); f.beforePrepare = async () => { f.archived = true; };
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'ARCHIVED'); assert.equal(result.recommendationPacket, null);
});

test('changes to kickoff or deployment during inference suppress the preview without persistence', async () => {
  for (const change of ['kickoff', 'revision', 'registry-failure']) {
    const f = fixture(); f.beforePrepare = async () => {
      if (change === 'kickoff') f.row.date = '2026-10-31T21:00:00Z';
      if (change === 'revision') f.state.revision = 'new-revision';
      if (change === 'registry-failure') f.stateFailure = true;
    };
    const result = await f.service.preview('m1');
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.recommendationPacket, null);
    assert.equal(result.reason, change === 'kickoff' ? 'fixture_changed' : change === 'revision' ? 'deployment_changed' : 'adoption_state_unavailable');
    assert.deepEqual(f.calls.writes, []);
  }
});

test('a change during the final market read is checked after selecting the recommendation', async () => {
  const f = fixture(); f.marketOverride = async () => { f.archived = true; };
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'ARCHIVED'); assert.equal(result.quote, null);
});

test('only real fresh pre-match prices can support a preview', async () => {
  for (const change of [{ source: 'odds_api_plus_model_completion' }, { priceType: 'closing' },
    { updatedAt: '2026-10-31T11:54:59Z' }, { capturedAt: '2026-10-31T12:00:01Z' }, { bookmaker: '' },
    { updatedAt: '' }, { timestampEvidence: 'observed_snapshot' }]) {
    const f = fixture(); f.preparedOverride = (prepared) => ({ ...prepared,
      quotes: prepared.quotes.map((quote) => ({ ...quote, ...change })) });
    const result = await f.service.preview('m1');
    assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.reason, 'real_fresh_quotes_unavailable');
    assert.equal(result.recommendationPacket, null);
  }
});

test('elapsed quote age and kickoff are rechecked after slow reads', async () => {
  const stale = fixture(); stale.marketOverride = async () => { stale.now += 300001; };
  const expired = await stale.service.preview('m1');
  assert.equal(expired.status, 'UNAVAILABLE'); assert.equal(expired.reason, 'real_fresh_quotes_unavailable');
  const started = fixture(); started.beforePrepare = async () => { started.now = Date.parse(started.row.date); };
  assert.equal((await started.service.preview('m1')).status, 'NOT_ELIGIBLE');
});

test('cache expiry is bounded by quote validity and by kickoff', async () => {
  const f = fixture();
  f.preparedOverride = (prepared) => ({ ...prepared, quotes: prepared.quotes.map((quote) => ({ ...quote,
    capturedAt: '2026-10-31T11:55:05Z', updatedAt: '2026-10-31T11:55:05Z' })) });
  assert.equal((await f.service.preview('m1')).expiresAt, '2026-10-31T12:00:05.000Z');
  const near = fixture(); near.row.date = '2026-10-31T12:00:04Z';
  assert.equal((await near.service.preview('m1')).expiresAt, '2026-10-31T12:00:04.000Z');
});

test('thirty-second response caching is independent from five-minute advice validity', async () => {
  const f = fixture();
  const first = await f.service.preview('m1');
  assert.equal(first.expiresAt, '2026-10-31T12:05:00.000Z');
  f.now += 29999;
  const cached = await f.service.preview('m1');
  assert.equal(cached.asOf, at); assert.equal(f.calls.prepared.length, 1);
  f.now += 1;
  const fresh = await f.service.preview('m1');
  assert.equal(f.calls.prepared.length, 2);
  assert.equal(fresh.asOf, '2026-10-31T12:00:30.000Z');
  assert.equal(fresh.expiresAt, '2026-10-31T12:05:30.000Z');
  assert.ok(Date.parse(first.expiresAt) > f.now, 'a valid old advice is not a reusable cache entry after30s');
});

test('a slow computation can exceed thirty seconds but never the authentic quote five-minute limit', async () => {
  const f = fixture();
  f.beforePrepare = async () => { f.now += 157000; };
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'RECOMMENDED');
  assert.equal(result.asOf, at); assert.equal(result.expiresAt, '2026-10-31T12:05:00.000Z');
  assert.equal(result.registered, false);
  const oldQuotes = fixture();
  oldQuotes.beforePrepare = async () => { oldQuotes.now += 300001; };
  assert.equal((await oldQuotes.service.preview('m1')).status, 'UNAVAILABLE');
});

test('cache hits recheck fixture, adoption and archive, and cannot be mutated by a caller', async () => {
  const f = fixture();
  const first = await f.service.preview('m1'); first.recommendationPacket.selected.selection = 'mutated';
  assert.equal((await f.service.preview('m1')).recommendationPacket.selected.selection, 'homeWin');
  assert.equal(f.calls.prepared.length, 1);
  f.state.revision = 'revision-2';
  assert.equal((await f.service.preview('m1')).status, 'RECOMMENDED');
  assert.equal(f.calls.prepared.length, 2);
  f.archived = true; assert.equal((await f.service.preview('m1')).status, 'ARCHIVED');
  f.archived = false; f.row.home_goals = 0;
  assert.equal((await f.service.preview('m1')).status, 'NOT_ELIGIBLE');
});

test('a Nightly publication during deployment resolution overrides an otherwise valid cache hit', async () => {
  const f = fixture();
  assert.equal((await f.service.preview('m1')).status, 'RECOMMENDED');
  f.db.challengerAdoption.getState = async () => {
    f.archived = true;
    return clone(f.state);
  };
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'ARCHIVED'); assert.equal(result.recommendationPacket, null);
  assert.equal(f.calls.prepared.length, 1);
});

test('each coalesced waiter checks the archive after the computation has resolved', async () => {
  const f = fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.beforePrepare = () => gate;
  f.db.challengerAdoption.getState = async () => {
    f.calls.deployment++;
    if (f.calls.deployment >= 3) f.archived = true;
    return clone(f.state);
  };
  const first = f.service.preview('m1'), waiter = f.service.preview('m1');
  while (f.calls.deployment < 2 || !f.calls.prepared.length) await new Promise((resolve) => setImmediate(resolve));
  release();
  const results = await Promise.all([first, waiter]);
  assert.ok(results.every((result) => result.status === 'ARCHIVED'));
  assert.equal(f.calls.prepared.length, 1);
});

test('pending callers recheck changed fixtures, suspended deployment and elapsed kickoff', async () => {
  for (const change of ['fixture', 'suspended', 'kickoff']) {
    const f = fixture();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    f.beforePrepare = () => gate;
    const first = f.service.preview('m1'), waiter = f.service.preview('m1');
    while (f.calls.deployment < 2 || !f.calls.prepared.length) await new Promise((resolve) => setImmediate(resolve));
    if (change === 'fixture') f.row.date = '2026-10-31T21:00:00Z';
    if (change === 'suspended') f.state.source = 'suspended';
    if (change === 'kickoff') f.now = Date.parse(f.row.date);
    release();
    const results = await Promise.all([first, waiter]);
    const expected = change === 'fixture' ? 'fixture_changed' : change === 'suspended' ? 'challenger_deployment_suspended' : 'match_started';
    assert.ok(results.every((result) => result.reason === expected && result.recommendationPacket === null), change);
    assert.equal(f.calls.prepared.length, 1);
  }
});

test('expiry during final deployment resolution is rechecked and the expired result is never cached', async () => {
  const f = fixture();
  let advance = true;
  f.db.challengerAdoption.getState = async () => {
    f.calls.deployment++;
    if (advance && f.calls.deployment >= 2) f.now += 300000;
    return clone(f.state);
  };
  const result = await f.service.preview('m1');
  assert.equal(result.status, 'UNAVAILABLE'); assert.equal(result.reason, 'challenger_preview_expired');
  advance = false;
  assert.equal((await f.service.preview('m1')).status, 'RECOMMENDED');
  assert.equal(f.calls.prepared.length, 2);
});

test('preview errors are retryable and never leak provider URLs or keys', async () => {
  const f = fixture(); f.failPrepare = Object.assign(new Error('https://private/api?apiKey=secret-sentinel'), { code: 'odds_credit_budget_exhausted' });
  const denied = await f.service.preview('m1');
  assert.equal(denied.reason, 'odds_credit_budget_exhausted');
  assert.ok(!JSON.stringify(denied).includes('secret-sentinel'));
  f.failPrepare = null;
  assert.equal((await f.service.preview('m1')).status, 'RECOMMENDED');
  assert.equal(f.calls.prepared.length, 2);
  f.now += 31000;
  f.failPrepare = new Error('secret-sentinel');
  const unknown = await f.service.preview('m1');
  assert.equal(unknown.reason, 'challenger_preview_unavailable'); assert.ok(!JSON.stringify(unknown).includes('secret-sentinel'));
});

test('same-fixture requests coalesce while independent concurrent C work is bounded to two', async () => {
  const f = fixture();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.beforePrepare = () => gate;
  const first = f.service.preview('m1'), duplicate = f.service.preview('m1'), second = f.service.preview('m2');
  while (f.calls.prepared.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const busy = await f.service.preview('m3');
  assert.equal(busy.reason, 'challenger_preview_busy'); assert.equal(f.calls.prepared.length, 2);
  release();
  const results = await Promise.all([first, duplicate, second]);
  assert.ok(results.every((result) => result.status === 'RECOMMENDED'));
  assert.equal(f.calls.prepared.length, 2);
});

test('cached fixtures are bounded to one hundred entries and expired entries are recomputed', async () => {
  const f = fixture();
  for (let index = 0; index < 101; index++) assert.equal((await f.service.preview(`m${index}`)).status, 'RECOMMENDED');
  assert.equal(f.calls.prepared.length, 101);
  await f.service.preview('m100'); assert.equal(f.calls.prepared.length, 101);
  await f.service.preview('m0'); assert.equal(f.calls.prepared.length, 102);
  f.now += 31000;
  await f.service.preview('m100'); assert.equal(f.calls.prepared.length, 103);
});

test('the C preview odds feed is always cache-only even when an old deployment enables preview network', () => {
  const oddsModule = require('../dist/services/OddsApiService');
  const original = oddsModule.OddsApiService;
  const originalFlag = process.env.CHALLENGER_PREVIEW_NETWORK_ENABLED;
  const oldDashboardFlag = process.env.ODDS_INFORMATIONAL_NETWORK_ENABLED;
  const captured = [];
  try {
    oddsModule.OddsApiService = class { constructor(_key, options) { captured.push(options); } };
    delete process.env.CHALLENGER_PREVIEW_NETWORK_ENABLED;
    process.env.ODDS_INFORMATIONAL_NETWORK_ENABLED = 'false';
    const f = fixture(); new ChallengerPreviewService(f.db, { clock: f.options.clock, runtimeFactory: f.options.runtimeFactory });
    process.env.CHALLENGER_PREVIEW_NETWORK_ENABLED = 'true';
    new ChallengerPreviewService(f.db, { clock: f.options.clock, runtimeFactory: f.options.runtimeFactory });
    assert.equal(captured[0].operation, 'challenger_preview'); assert.equal(captured[0].priority, 'informational');
    assert.equal(captured[0].cacheMaxAgeMs, 300000); assert.equal(captured[0].allowNetwork, false);
    assert.equal(captured[1].allowNetwork, false); assert.equal(process.env.ODDS_INFORMATIONAL_NETWORK_ENABLED, 'false');
  } finally {
    oddsModule.OddsApiService = original;
    if (originalFlag === undefined) delete process.env.CHALLENGER_PREVIEW_NETWORK_ENABLED; else process.env.CHALLENGER_PREVIEW_NETWORK_ENABLED = originalFlag;
    if (oldDashboardFlag === undefined) delete process.env.ODDS_INFORMATIONAL_NETWORK_ENABLED; else process.env.ODDS_INFORMATIONAL_NETWORK_ENABLED = oldDashboardFlag;
  }
});
