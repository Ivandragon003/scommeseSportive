const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { paperExecutionPolicy, fundedExecutionPolicy, dynamicFundedExecutionPolicy, fallbackChallengerState } = require('../dist/research/ResearchRecommendationPolicy');
const { paperSelectionKey } = require('../dist/research/PaperBetSelections');

const START = '2026-11-09T10:00:00.000Z', KICKOFF = '2026-11-09T19:00:00.000Z', END = '2026-11-10T02:00:00.000Z';
const configuration = family => ({ version: 'isolated-single-match', family });
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? String(item) : item);

async function setup() {
  const path = join(tmpdir(), `challenger-single-match-${process.pid}-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  for (const migration of ['015_research_platform.sql', '020_research_nightly.sql', '023_research_recommendation_execution.sql',
    '026_manual_model_bets.sql', '028_paper_model_bets.sql', '029_funded_model_bets.sql', '030_dynamic_model_bets.sql', '031_dynamic_funded_cancellations.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
  }
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT NOT NULL,home_goals INTEGER,away_goals INTEGER)');
  await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: ['fixture', KICKOFF] });
  const clock = () => new Date(START), research = new ResearchStore(client, async () => {}, { now: clock });
  await research.initializePortfolios();
  for (const [family, version] of [['A', 'A-fixture'], ['C', 'C-fixture'], ['C', 'C-revised']]) {
    await research.saveModel({ family, version, artifact: { family, version, fixtureOnly: true } });
    await research.setMarketState({ family, modelVersion: version, market: '1x2', state: 'EXPERIMENTAL' });
  }
  await client.execute({ sql: `INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at)
    VALUES('origin-job','fixture',?,?,'COMPLETED',?,?)`, args: [KICKOFF, START, START, START] });
  await client.execute({ sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)', args: ['origin-input', 'origin-job', researchHash({}), '{}', START, KICKOFF] });
  for (const family of ['A', 'C']) await client.execute({ sql: `INSERT INTO research_decisions
    (id,job_id,input_id,family,model_version,market,portfolio_id,action,snapshot_json,created_at)
    VALUES(?,'origin-job','origin-input',?,?,'1x2',?,'ABSTAIN','{}',?)`, args: [`origin-${family}`, family, `${family}-fixture`, `shadow_${family}`, START] });
  const store = new ResearchRecommendationStore(client, async () => {}, { now: clock, research });
  return { client, store, research, path,
    async policy(kind = 'dynamic', revision = 'first', version = 'C-fixture') {
      const state = fallbackChallengerState(); state.deployment.modelVersion = version; state.revision = revision;
      return store.registerPolicy(({ paper: paperExecutionPolicy, funded: fundedExecutionPolicy, dynamic: dynamicFundedExecutionPolicy })[kind](state));
    },
    async claim(policy) {
      const result = await store.claimBatch({ policyHash: policy.hash, runId: `run-${policy.hash}`, windowStartAt: START,
        windowEndAt: END, fixtures: [{ matchId: 'fixture', kickoffAt: KICKOFF }] });
      assert.equal(result.jobs.length, 1); return result.jobs[0];
    },
    async close() { client.close();
      // Windows native libSQL handles may remain alive until finalization.
      if (process.platform === 'win32') return;
      for (const suffix of ['', '-wal', '-shm']) try { rmSync(path + suffix, { force: true }); }
      catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; } },
  };
}

function prepared(job, { primary = 0, version = 'C-fixture', abstainA = false } = {}) {
  const children = ['home', 'draw', 'away'].map((side, index) => {
    const quote = { market: '1x2', selection: ['homeWin', 'draw', 'awayWin'][index], side, odds: 2,
      bookmaker: 'Isolated fixture bookmaker', source: 'odds_api', priceType: 'prematch', capturedAt: START, updatedAt: START };
    return { market: quote.market, selection: quote.selection, selectionKey: paperSelectionKey(quote), quote,
      probability: .6, ev: .2 + index / 10, confidence: 'MEDIUM', suggestedStakePercent: 1 };
  });
  return { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
    inputSnapshot: { observedAt: START, match: { matchId: 'fixture', kickoffAt: KICKOFF }, quotes: children.map(child => child.quote) },
    decisions: ['A', 'C'].map(family => ({ family, modelVersion: family === 'C' ? version : 'A-fixture',
      originDecisionId: job.originDecisionIds[family], action: family === 'A' && abstainA ? 'ABSTAIN' : 'BET',
      recommended: true, validated: true, ...children[family === 'C' ? primary : 0], selections: children,
      probabilityConfiguration: configuration(family), probabilityConfigurationHash: researchHash(configuration(family)) })) };
}

test('C stores only its declared primary while A retains all eligible selections', async () => {
  const f = await setup(); try {
    const data = prepared(await f.claim(await f.policy()));
    const result = await f.store.commitBatch([data]);
    assert.equal(result.bets.filter(bet => bet.family === 'A').length, 3);
    assert.deepEqual(result.bets.filter(bet => bet.family === 'C').map(bet => bet.selection), ['homeWin']);
    assert.equal(result.decisions.find(decision => decision.family === 'C').selections.length, 1);
    assert.equal((await f.store.commitBatch([data])).bets.length, 4);
  } finally { await f.close(); }
});

test('invalid C primary never promotes a valid secondary, including allocation failures', async () => {
  for (const failure of ['quote', 'stake', 'missing', 'malformed']) {
    const f = await setup(); try {
      const data = prepared(await f.claim(await f.policy()), { abstainA: true }), decision = data.decisions[1];
      if (failure === 'quote') decision.selections[0].probability = NaN;
      if (failure === 'stake') decision.selections[0].suggestedStakePercent = 0;
      if (failure === 'missing') decision.selections.shift();
      if (failure === 'malformed') decision.selections = {};
      const result = await f.store.commitBatch([data]);
      assert.equal(result.bets.length, 0, failure);
      assert.equal(result.decisions.find(row => row.family === 'C').action, 'ABSTAIN', failure);
    } finally { await f.close(); }
  }
});

test('a changed primary, model or accounting policy cannot add another C bet for the match', async () => {
  const f = await setup(); try {
    const first = await f.store.commitBatch([prepared(await f.claim(await f.policy('funded')), { abstainA: true })]);
    assert.equal(first.bets.length, 1);
    const before = json((await f.client.execute('SELECT * FROM funded_model_bets ORDER BY id')).rows);
    for (const [kind, version] of [['dynamic', 'C-revised'], ['paper', 'C-fixture']]) {
      const result = await f.store.commitBatch([prepared(await f.claim(await f.policy(kind, 'revised', version)), { primary: 2, version, abstainA: true })]);
      assert.equal(result.bets.length, 0);
      assert.equal(result.decisions.find(row => row.family === 'C').reason, 'challenger_match_already_recorded');
    }
    assert.equal(json((await f.client.execute('SELECT * FROM funded_model_bets ORDER BY id')).rows), before);
  } finally { await f.close(); }
});

test('same-match policies in one cached batch reserve and insert at most one C stake', async () => {
  for (const samePrimary of [true, false]) {
    const f = await setup(); try {
      const jobs = await Promise.all([f.policy('dynamic', 'one'), f.policy('dynamic', 'two')]);
      const data = [];
      for (let index = 0; index < jobs.length; index++) data.push(prepared(await f.claim(jobs[index]), { primary: samePrimary ? 0 : index, abstainA: true }));
      const result = await f.store.commitBatch(data);
      assert.equal(result.bets.length, 1);
      assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS count FROM research_ledger WHERE event='STAKE'")).rows[0].count), 1);
      assert.equal(result.decisions.filter(row => row.family === 'C' && row.action === 'ABSTAIN')[0].reason, 'challenger_match_already_recorded');
    } finally { await f.close(); }
  }
});

test('concurrent commits on separate database clients cannot place two C bets', async () => {
  const f = await setup(); let otherClient; try {
    const first = prepared(await f.claim(await f.policy('dynamic', 'one')), { abstainA: true });
    const second = prepared(await f.claim(await f.policy('dynamic', 'two')), { primary: 1, abstainA: true });
    otherClient = createClient({ url: `file:${f.path}` });
    const other = new ResearchRecommendationStore(otherClient, async () => {}, { now: () => new Date(START) });
    const results = await Promise.allSettled([f.store.commitBatch([first]), other.commitBatch([second])]);
    assert.ok(results.some(result => result.status === 'fulfilled'));
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS count FROM dynamic_model_bets')).rows[0].count), 1);
    // A client that lost the database write lock also sees the match guard on retry.
    for (let index = 0; index < results.length; index++) if (results[index].status === 'rejected') {
      assert.match(String(results[index].reason), /SQLITE_BUSY|database is locked/i);
      const retry = await [f.store, other][index].commitBatch([[first, second][index]]);
      assert.equal(retry.bets.length, 0);
    }
  } finally { otherClient?.close(); await f.close(); }
});

test('old multiple C bets stay intact while a new policy cannot add another', async () => {
  const f = await setup(); try {
    const data = prepared(await f.claim(await f.policy()), { abstainA: true });
    const first = await f.store.commitBatch([data]), bet = first.bets[0];
    const originalDecision = (await f.client.execute({ sql: 'SELECT * FROM research_execution_decisions WHERE id=?', args: [bet.executionDecisionId] })).rows[0];
    const originalBet = (await f.client.execute({ sql: 'SELECT * FROM dynamic_model_bets WHERE id=?', args: [bet.id] })).rows[0];
    const evidence = JSON.parse(originalDecision.snapshot_json), secondary = { ...evidence.selections[0], ...data.decisions[1].selections[2] };
    const originalInput = (await f.client.execute({ sql: 'SELECT * FROM research_execution_inputs WHERE id=?', args: [bet.inputId] })).rows[0];
    const historicalJob = await f.claim(await f.policy('dynamic', 'historical'));
    const legacyId = 'legacy-secondary-decision', legacyBetId = 'dynamic:legacy-secondary', legacyInputId = 'legacy-secondary-input';
    const legacyEvidence = { ...evidence, ...secondary, selections: [secondary], effectiveExecutionDecisionId: legacyId,
      inputId: legacyInputId, policyHash: historicalJob.policyHash, runId: historicalJob.runId };
    const insert = (table, row) => f.client.execute({ sql: `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map(() => '?').join(',')})`, args: Object.values(row) });
    // Reproduce valid immutable evidence written by the former multi-selection policy.
    await insert('research_execution_inputs', { ...originalInput, id: legacyInputId, job_id: historicalJob.id });
    await insert('research_execution_decisions', { ...originalDecision, id: legacyId, input_id: legacyInputId, selection: secondary.selection, snapshot_json: json(legacyEvidence) });
    await insert('dynamic_model_bets', { ...originalBet, id: legacyBetId, execution_decision_id: legacyId, input_id: legacyInputId, policy_hash: historicalJob.policyHash,
      selection: secondary.selection, selection_key: secondary.selectionKey, snapshot_json: json({ ...legacyEvidence, selections: undefined, rejectedSelections: undefined }) });
    await f.client.execute({ sql: `INSERT INTO research_ledger VALUES(?,?,NULL,'STAKE',?,?,?)`,
      args: [`stake:${legacyBetId}`, 'shadow_C', -bet.stakeCents, bet.stakeCents, START] });
    const before = json((await f.client.execute('SELECT * FROM dynamic_model_bets ORDER BY id')).rows);
    assert.equal((await f.research.listBets()).filter(row => row.family === 'C').length, 2);
    const next = await f.store.commitBatch([prepared(await f.claim(await f.policy('dynamic', 'later')), { primary: 1, abstainA: true })]);
    assert.equal(next.bets.length, 0);
    assert.equal(json((await f.client.execute('SELECT * FROM dynamic_model_bets ORDER BY id')).rows), before);
    assert.equal((await f.research.listBets()).filter(row => row.family === 'C').length, 2);
  } finally { await f.close(); }
});

test('cancelled paper or fixed bets permit a new dynamic C primary and preserve old evidence', async () => {
  for (const kind of ['paper', 'funded']) {
    const f = await setup(); try {
      const first = await f.store.commitBatch([prepared(await f.claim(await f.policy(kind)), { abstainA: true })]);
      assert.equal(first.bets.length, 1);
      const table = kind === 'paper' ? 'paper_model_bets' : 'funded_model_bets';
      const before = json((await f.client.execute(`SELECT * FROM ${table}`)).rows);
      await f.client.execute({ sql: `INSERT INTO ${kind === 'paper' ? 'paper_model_bet_cancellations' : 'funded_model_bet_cancellations'} VALUES(?,?,?)`,
        args: [first.bets[0].id, START, 'isolated policy replacement'] });
      const next = await f.store.commitBatch([prepared(await f.claim(await f.policy('dynamic')), { primary: 2, abstainA: true })]);
      assert.equal(next.bets.length, 1); assert.equal(next.bets[0].selection, 'awayWin');
      assert.equal(json((await f.client.execute(`SELECT * FROM ${table}`)).rows), before);
    } finally { await f.close(); }
  }
});

test('existing manual C bets block automatic C without changing manual evidence or A', async () => {
  const f = await setup(); try {
    await f.client.execute({ sql: 'INSERT INTO manual_model_bets VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      args: ['manual-fixture', 'shadow_C', 'fixture', 'C', 'C-fixture', '1x2', 'awayWin', 2, 100, '{}', START] });
    const before = json((await f.client.execute('SELECT * FROM manual_model_bets')).rows);
    const result = await f.store.commitBatch([prepared(await f.claim(await f.policy()))]);
    assert.equal(result.bets.filter(bet => bet.family === 'A').length, 3);
    assert.equal(result.bets.filter(bet => bet.family === 'C').length, 0);
    assert.equal(json((await f.client.execute('SELECT * FROM manual_model_bets')).rows), before);
  } finally { await f.close(); }
});
