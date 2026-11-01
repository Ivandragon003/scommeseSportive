const test = require('node:test');
const assert = require('node:assert/strict');
const { MatchResultsRefreshService, RESULTS_REFRESH_MAX_MATCHES, RESULTS_REFRESH_WINDOW_MS } = require('../dist/services/MatchResultsRefreshService');

const NOW = '2026-10-31T18:00:00.000Z';
const KICKOFF = '2026-10-31T15:00:00.000Z';

function fixture(id = 31652, competition = 'Serie A') {
  const row = { match_id: `understat_${id}`, source_match_id: id, source: 'understat',
    home_team_id: `home-${id}`, away_team_id: `away-${id}`, competition, season: '2026/2027',
    date: KICKOFF, home_goals: null, away_goals: null,
    home_shots: 11, away_shots: 9, home_yellow_cards: 2, away_yellow_cards: 1,
    raw_json: JSON.stringify({ match: { id: String(id) }, details: { shots: { h: ['saved'], a: [] } }, supplemental: 'preserve' }) };
  const raw = { id: String(id), isResult: true, datetime: '2026-10-31 15:00:00',
    h: { id: String(id + 1), title: 'Home' }, a: { id: String(id + 2), title: 'Away' },
    goals: { h: '2', a: '1' }, xG: { h: '1.81', a: '0.79' } };
  const source = { matchId: row.match_id, sourceMatchId: id, date: raw.datetime,
    homeTeamId: raw.h.id, awayTeamId: raw.a.id, homeTeamName: 'Home', awayTeamName: 'Away',
    homeGoals: 2, awayGoals: 1, homeXG: 1.81, awayXG: .79, competition, season: '2026/2027', rawJson: JSON.stringify(raw) };
  return { row, raw, source };
}

function harness(fixtures = [fixture()], options = {}) {
  const matches = new Map(fixtures.map((item) => [item.row.match_id, structuredClone(item.row)]));
  const sourceRows = fixtures.map((item) => structuredClone(item.source));
  const teams = new Map(fixtures.flatMap((item) => [
    [item.row.home_team_id, { team_id: item.row.home_team_id, source_team_id: Number(item.raw.h.id) }],
    [item.row.away_team_id, { team_id: item.row.away_team_id, source_team_id: Number(item.raw.a.id) }],
  ]));
  const calls = { candidates: [], source: [], apply: [], forbidden: [] };
  const db = new Proxy({
    getRecentUnfinishedMatches: async (filters) => {
      calls.candidates.push(filters);
      const rows = options.candidates ?? [...matches.values()].filter((row) => row.home_goals == null || row.away_goals == null);
      const snapshot = rows.map((row) => structuredClone(row));
      if (options.afterCandidates) options.afterCandidates(matches);
      return snapshot;
    },
    getMatchById: async (id) => structuredClone(matches.get(id) ?? null),
    getTeam: async (id) => structuredClone(teams.get(id) ?? null),
    applyVerifiedFinalResult: async (input) => {
      calls.apply.push(structuredClone(input));
      if (options.applyFailure) throw new Error('private database transport details');
      if (options.applyResponse) return options.applyResponse;
      const row = matches.get(input.matchId);
      if (row.home_goals != null || row.away_goals != null) return { updated: false, reason: 'unchanged' };
      row.home_goals = input.homeGoals; row.away_goals = input.awayGoals;
      return { updated: true };
    },
  }, { get: (target, key) => key in target ? target[key] : (...args) => {
    calls.forbidden.push({ method: String(key), args }); throw new Error('Unexpected business operation');
  } });
  const source = { scrapeSeason: async (...args) => {
    calls.source.push(args);
    if (options.fetch) return options.fetch(...args);
    return sourceRows.filter((row) => row.competition === args[0]);
  } };
  const service = new MatchResultsRefreshService(db, { source, clock: () => new Date(NOW),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.sourceTimeoutMs ? { sourceTimeoutMs: options.sourceTimeoutMs } : {}) });
  return { service, matches, sourceRows, teams, calls };
}

function changeRaw(h, patch) {
  const row = h.sourceRows[0];
  row.rawJson = JSON.stringify({ ...JSON.parse(row.rawJson), ...patch });
}

test('refresh applies only a verified final result and leaves absent statistics out of the mutation', async () => {
  const item = fixture(), h = harness([item]);
  const before = structuredClone(h.matches.get(item.row.match_id));
  const result = await h.service.refresh();
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.updated, 1); assert.equal(result.errors.length, 0);
  assert.deepEqual(h.calls.source, [['Serie A', '2026/2027', { includeDetails: false }]]);
  assert.equal(h.calls.apply.length, 1);
  const input = h.calls.apply[0];
  assert.equal(input.homeGoals, 2); assert.equal(input.awayGoals, 1);
  assert.equal(input.homeXg, 1.81); assert.equal(input.awayXg, .79);
  assert.equal(input.expectedKickoffAt, KICKOFF); assert.equal(input.observedAt, NOW);
  assert.equal(input.source, 'understat'); assert.deepEqual(input.rawSource, item.raw);
  assert.equal(input.expectedHomeTeamId, item.row.home_team_id);
  assert.equal(input.expectedAwayTeamId, item.row.away_team_id);
  assert.ok(!Object.keys(input).some((key) => /shots|cards|corner|foul|possess|rawJson|newKickoff/i.test(key)));
  const after = h.matches.get(item.row.match_id);
  for (const key of ['date', 'home_shots', 'away_shots', 'home_yellow_cards', 'away_yellow_cards', 'raw_json']) assert.equal(after[key], before[key]);
  assert.deepEqual(h.calls.forbidden, []);
});

test('a repeated refresh is idempotent and does not refetch completed fixtures', async () => {
  const h = harness();
  assert.equal((await h.service.refresh()).updated, 1);
  assert.equal((await h.service.refresh()).updated, 0);
  assert.equal(h.calls.apply.length, 1); assert.equal(h.calls.source.length, 1);
  assert.deepEqual(h.calls.forbidden, []);
});

test('simultaneous manual requests share one refresh and perform one update', async () => {
  let release;
  const value = fixture();
  const h = harness([value], { fetch: () => new Promise((resolve) => { release = resolve; }) });
  const first = h.service.refresh(), second = h.service.refresh();
  assert.equal(first, second);
  await new Promise((resolve) => setImmediate(resolve));
  release([value.source]);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a, b); assert.equal(a.updated, 1); assert.equal(h.calls.apply.length, 1);
});

test('only exact boolean isResult=true authorizes final-score updates', async () => {
  for (const isResult of [false, 'true', 1, null, undefined]) {
    const h = harness(); changeRaw(h, { isResult });
    const result = await h.service.refresh();
    assert.equal(result.updated, 0); assert.equal(result.reasonCounts.source_not_final, 1);
    assert.equal(result.status, isResult === false ? 'SUCCESS' : 'PARTIAL');
    assert.equal(result.unchanged, isResult === false ? 1 : 0);
    assert.equal(result.rejected, isResult === false ? 0 : 1);
    assert.equal(h.calls.apply.length, 0);
  }
});

test('verified finals update successfully while explicitly unfinished fixtures remain pending', async () => {
  const final = fixture(31652), pending = fixture(31653);
  pending.raw.isResult = false; pending.source.rawJson = JSON.stringify(pending.raw);
  const h = harness([final, pending]);
  const result = await h.service.refresh();
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.updated, 1);
  assert.equal(result.unchanged, 1); assert.equal(result.rejected, 0);
  assert.equal(h.calls.apply.length, 1); assert.equal(h.calls.apply[0].matchId, final.row.match_id);
});

test('missing or malformed scores are never converted into zero goals', async () => {
  for (const goals of [{ h: null, a: '1' }, { h: '', a: '1' }, { h: '-1', a: '1' }, { h: '1.2', a: '1' }, {}, { h: 'NaN', a: '1' }]) {
    const h = harness(); changeRaw(h, { goals });
    const result = await h.service.refresh();
    assert.equal(result.reasonCounts.source_score_invalid, 1); assert.equal(h.calls.apply.length, 0);
  }
});

test('an explicit final zero-zero score is accepted without confusing zero with missing data', async () => {
  const h = harness();
  changeRaw(h, { goals: { h: '0', a: '0' } });
  h.sourceRows[0].homeGoals = 0; h.sourceRows[0].awayGoals = 0;
  const result = await h.service.refresh();
  assert.equal(result.status, 'SUCCESS'); assert.equal(result.updated, 1);
  assert.equal(h.calls.apply[0].homeGoals, 0); assert.equal(h.calls.apply[0].awayGoals, 0);
  assert.deepEqual(h.calls.forbidden, []);
});

test('missing xG stays absent and malformed xG blocks the update', async () => {
  const missing = harness(); changeRaw(missing, { xG: { h: null } });
  assert.equal((await missing.service.refresh()).updated, 1);
  assert.equal('homeXg' in missing.calls.apply[0], false); assert.equal('awayXg' in missing.calls.apply[0], false);
  const invalid = harness(); changeRaw(invalid, { xG: { h: '-2', a: '0.8' } });
  assert.equal((await invalid.service.refresh()).reasonCounts.source_xg_invalid, 1);
  assert.equal(invalid.calls.apply.length, 0);
});

test('source and database team identities must agree, including orientation', async () => {
  const h = harness();
  h.teams.set(h.sourceRows[0].matchId.replace('understat_', 'home-'), { team_id: 'wrong', source_team_id: 1 });
  const result = await h.service.refresh();
  assert.equal(result.reasonCounts.team_identity_mismatch, 1); assert.equal(h.calls.apply.length, 0);
  const inverted = harness();
  const raw = JSON.parse(inverted.sourceRows[0].rawJson);
  changeRaw(inverted, { h: raw.a, a: raw.h });
  assert.equal((await inverted.service.refresh()).reasonCounts.source_identity_mismatch, 1);
});

test('missing source team IDs and missing database teams cannot accidentally match nulls', async () => {
  const h = harness(); changeRaw(h, { h: {} }); h.sourceRows[0].homeTeamId = '';
  const result = await h.service.refresh();
  assert.equal(result.reasonCounts.source_identity_mismatch, 1); assert.equal(h.calls.apply.length, 0);
  const missingTeam = harness(); missingTeam.teams.clear();
  assert.equal((await missingTeam.service.refresh()).reasonCounts.team_identity_mismatch, 1);
});

test('source kickoff drift, invalid calendar dates and a source future kickoff remain blocked', async () => {
  for (const datetime of ['2026-10-31 16:00:00', '2026-02-31 15:00:00', '2026-11-01 15:00:00']) {
    const h = harness(); changeRaw(h, { datetime }); h.sourceRows[0].date = datetime;
    const result = await h.service.refresh();
    assert.equal(result.reasonCounts.source_kickoff_mismatch_or_future, 1); assert.equal(h.calls.apply.length, 0);
  }
});

test('future, old, wrong-season and unsupported-league database candidates are skipped before HTTP', async () => {
  for (const patch of [{ date: '2026-11-01T15:00:00Z' }, { date: '2026-10-20T15:00:00Z' },
    { season: '2025/2026' }, { competition: 'Unsupported' }, { source: 'manual' }, { source_match_id: 2 }]) {
    const item = fixture(); Object.assign(item.row, patch);
    const h = harness([item]); const result = await h.service.refresh();
    assert.equal(result.updated, 0); assert.equal(h.calls.source.length, 0); assert.equal(h.calls.apply.length, 0);
  }
});

test('the bounded query uses the current Top5 season, last 72 hours and maximum 200 candidates', async () => {
  const h = harness([], { limit: 10000 });
  await h.service.refresh();
  const query = h.calls.candidates[0];
  assert.equal(query.limit, RESULTS_REFRESH_MAX_MATCHES);
  assert.equal(Date.parse(query.to) - Date.parse(query.from), RESULTS_REFRESH_WINDOW_MS);
  assert.deepEqual(query.competitions, ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1']);
  const bounded = harness([fixture(1), fixture(2), fixture(3)], { limit: 2 });
  const result = await bounded.service.refresh();
  assert.equal(result.checked, 2); assert.equal(result.updated, 2); assert.equal(result.limitReached, true);
});

test('duplicate source or database identities are rejected rather than chosen by order', async () => {
  const h = harness(); h.sourceRows.push(structuredClone(h.sourceRows[0]));
  assert.equal((await h.service.refresh()).reasonCounts.source_duplicate_match, 1);
  assert.equal(h.calls.apply.length, 0);
  const f = fixture(); const dup = harness([f], { candidates: [f.row, f.row] });
  assert.equal((await dup.service.refresh()).reasonCounts.duplicate_or_invalid_candidate, 2);
  assert.equal(dup.calls.source.length, 0);
});

test('completed conflicting results are never overwritten, while the same concurrent result is unchanged', async () => {
  const changed = harness([fixture()], { afterCandidates: (rows) => { rows.values().next().value.home_goals = 9; } });
  assert.equal((await changed.service.refresh()).reasonCounts.existing_result_conflict, 1);
  assert.equal(changed.calls.apply.length, 0);
  const same = harness([fixture()], { afterCandidates: (rows) => {
    const row = rows.values().next().value; row.home_goals = 2; row.away_goals = 1;
  } });
  assert.equal((await same.service.refresh()).unchanged, 1); assert.equal(same.calls.apply.length, 0);
});

test('a changed fixture is not updated after the provider request', async () => {
  const shifted = harness([fixture()], { afterCandidates: (rows) => {
    rows.values().next().value.date = '2026-10-31T16:00:00Z';
  } });
  const shiftedResult = await shifted.service.refresh();
  assert.equal(shiftedResult.updated, 0); assert.equal(shifted.calls.apply.length, 0);
  assert.equal(shiftedResult.reasonCounts.match_changed, 1);
});

test('atomic database admission can refuse a race without turning it into an update', async () => {
  const h = harness([fixture()], { applyResponse: { updated: false, reason: 'match_changed' } });
  const result = await h.service.refresh();
  assert.equal(result.updated, 0); assert.equal(result.reasonCounts.match_changed, 1);
});

test('HTTP errors are sanitized, partial leagues continue and no fallback provider is called', async () => {
  const a = fixture(31652), b = fixture(31260, 'Premier League');
  const h = harness([a, b], { fetch: async (competition) => {
    if (competition === 'Premier League') throw Error('https://private.invalid/?apiKey=must-not-appear');
    return [a.source];
  } });
  const result = await h.service.refresh();
  assert.equal(result.status, 'PARTIAL'); assert.equal(result.updated, 1);
  assert.deepEqual(result.errors, [{ competition: 'Premier League', reason: 'source_fetch_failed' }]);
  assert.doesNotMatch(JSON.stringify(result), /private.invalid|apiKey/);
  assert.deepEqual(h.calls.forbidden, []);
});

test('source requests time out within the configured bound without later writes', async () => {
  let release;
  const f = fixture();
  const h = harness([f], { sourceTimeoutMs: 5, fetch: () => new Promise((resolve) => { release = resolve; }) });
  const result = await h.service.refresh();
  assert.equal(result.status, 'FAILED'); assert.equal(result.errors[0].reason, 'source_timeout');
  release([f.source]); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.apply.length, 0);
});

test('malformed provider arrays and raw JSON are explicit failures or rejections', async () => {
  const malformed = harness([fixture()], { fetch: async () => ({ dates: [] }) });
  assert.equal((await malformed.service.refresh()).errors[0].reason, 'source_payload_invalid');
  const raw = harness(); raw.sourceRows[0].rawJson = 'not-json';
  assert.equal((await raw.service.refresh()).reasonCounts.source_payload_invalid, 1);
  assert.equal(raw.calls.apply.length, 0);
});

test('write errors do not expose internals or trigger prediction, calibration or betting methods', async () => {
  const h = harness([fixture()], { applyFailure: true });
  const result = await h.service.refresh();
  assert.equal(result.status, 'FAILED'); assert.equal(result.errors[0].reason, 'result_refresh_failed');
  assert.doesNotMatch(JSON.stringify(result), /transport/);
  assert.deepEqual(h.calls.forbidden, []);
});
