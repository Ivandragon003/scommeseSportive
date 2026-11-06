const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const build = process.env.PAPER_TEST_BUILD_DIR || join(__dirname, '../dist');
const { ResearchStore, researchHash } = require(join(build, 'research/ResearchStore'));
const { ResearchRecommendationStore } = require(join(build, 'research/ResearchRecommendationStore'));
const { PAPER_RECOMMENDATION_POLICY } = require(join(build, 'research/ResearchRecommendationPolicy'));
const { paperSelectionKey } = require(join(build, 'research/PaperBetSelections'));
const { listPaperBetViews, paperBetOverview, settlePaperBet, settlePaperModelBets } = require(join(build, 'research/PaperModelBetLedger'));
const { inspectPaperAccounting } = require(join(build, 'research/ResearchMonitoring'));
const START = '2026-11-06T10:00:00.000Z', KICKOFF = '2026-11-06T19:00:00.000Z', END = '2026-11-07T02:00:00.000Z';
const config = family => ({ version: 'fixture', family });
const policy = { ...PAPER_RECOMMENDATION_POLICY, familyC: { ...PAPER_RECOMMENDATION_POLICY.familyC, modelVersion: 'C-fixture' } };
const json = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item);

async function setup({ matches = 2, funded = false } = {}) {
  const path = join(tmpdir(), `paper-model-bets-${process.pid}-${randomUUID()}.db`), client = createClient({ url: `file:${path}` });
  for (const name of ['015_research_platform.sql', '020_research_nightly.sql', '023_research_recommendation_execution.sql', '028_paper_model_bets.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', name), 'utf8'));
  }
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT NOT NULL,home_goals INTEGER,away_goals INTEGER)');
  const clock = () => new Date(START), research = new ResearchStore(client, async () => {}, { now: clock });
  await research.initializePortfolios({ fundVirtual: funded });
  for (const family of ['A', 'C']) {
    await research.saveModel({ family, version: `${family}-fixture`, artifact: { fixture: true, family } });
    for (const market of ['1x2', 'totals', 'dnb']) await research.setMarketState({ family, modelVersion: `${family}-fixture`, market, state: 'EXPERIMENTAL' });
  }
  const fixtures = [];
  for (let index = 0; index < matches; index++) {
    const matchId = `paper-fixture-${index}`, job = `origin-job-${index}`, input = `origin-input-${index}`;
    fixtures.push({ matchId, kickoffAt: KICKOFF });
    await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: [matchId, KICKOFF] });
    await client.execute({ sql: `INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at) VALUES(?,?,?,?,'COMPLETED',?,?)`, args: [job, matchId, KICKOFF, START, START, START] });
    await client.execute({ sql: 'INSERT INTO research_inputs VALUES(?,?,?,?,?,?)', args: [input, job, researchHash({ matchId }), json({ matchId }), START, KICKOFF] });
    for (const family of ['A', 'C']) await client.execute({ sql: `INSERT INTO research_decisions
      (id,job_id,input_id,family,model_version,market,portfolio_id,action,snapshot_json,created_at) VALUES(?,?,?,?,?,'1x2',?,'ABSTAIN','{}',?)`,
      args: [`origin-${index}-${family}`, job, input, family, `${family}-fixture`, `shadow_${family}`, START] });
  }
  const recommendations = new ResearchRecommendationStore(client, async () => {}, { now: clock, research });
  const registered = await recommendations.registerPolicy(policy);
  return { client, path, research, recommendations, registered, fixtures, clock,
    async claim(descriptor = registered) { return recommendations.claimBatch({ policyHash: descriptor.hash, runId: 'paper-test', windowStartAt: START, windowEndAt: END, fixtures }); },
    async fingerprint() { return json(await Promise.all(['research_inputs', 'research_decisions', 'research_bets', 'research_settlements', 'research_ledger'].map(async table => [table, (await client.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows]))); },
    async close() { client.close(); for (const suffix of ['', '-wal', '-shm']) try { rmSync(path + suffix, { force: true }); } catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; } } };
}

function selection(index, overrides = {}) {
  const quote = { market: 'totals', selection: `over${index + 0.5}`, side: 'over', line: index + .5, odds: 2,
    source: 'odds_api', bookmaker: 'Fixture bookmaker', priceType: 'prematch', capturedAt: START, updatedAt: START, ...overrides };
  return { market: quote.market, selection: quote.selection, selectionKey: paperSelectionKey(quote), quote, probability: .6, ev: .2, confidence: 'MEDIUM' };
}
function prepared(job, count = 1) {
  const children = Array.from({ length: count }, (_value, index) => selection(index));
  return { jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
    inputSnapshot: { observedAt: START, match: { matchId: job.matchId, matchLabel: 'Fixture Home – Fixture Away', competition: 'EPL', kickoffAt: KICKOFF }, quotes: children.map(item => item.quote) },
    decisions: ['A', 'C'].map(family => ({ family, modelVersion: `${family}-fixture`, originDecisionId: job.originDecisionIds[family],
      action: 'BET', recommended: true, validated: true, ...children[0], selections: children,
      probabilityConfiguration: config(family), probabilityConfigurationHash: researchHash(config(family)) })) };
}

for (const count of [5, 10, 20, 50, 125]) test(`paper commits ${count} selections per model/match without count or capital gates`, async () => {
  const f = await setup();
  try {
    const before = await f.fingerprint(), jobs = (await f.claim()).jobs, commits = jobs.map(job => prepared(job, count));
    const result = await f.recommendations.commitBatch(commits);
    assert.equal(result.bets.length, count * 4); assert.equal(result.decisions.length, 4);
    assert.ok(result.bets.every(row => row.stakeCents === 100 && row.stakeUnits === 1 && row.id.startsWith('paper:')));
    assert.equal(await f.fingerprint(), before);
    assert.equal((await f.research.listBets()).length, 0);
    assert.equal((await f.recommendations.listDecisionViews()).length, 0);
    const overview = paperBetOverview(await f.recommendations.listPaperBets());
    assert.equal(overview.totalStakeUnits, count * 4); assert.equal(overview.openCount, count * 4); assert.equal(overview.roiPercent, null);
    assert.equal((await f.recommendations.getRunMetrics('paper-test', f.registered.hash)).registeredBets, count * 4);
    const again = await f.recommendations.commitBatch(commits); assert.equal(again.bets.length, count * 4);
    assert.equal((await f.recommendations.listPaperBets()).length, count * 4); assert.equal(await f.fingerprint(), before);
    await assert.rejects(f.client.execute('UPDATE paper_model_bets SET stake_cents=100'), /immutable/);
    await assert.rejects(f.client.execute('DELETE FROM paper_model_bets'), /immutable/);
  } finally { await f.close(); }
});

test('paper deduplicates semantic aliases, verifies keys and selects the best qualified actual price', async () => {
  const f = await setup({ matches: 1 });
  try {
    const job = (await f.claim()).jobs[0], commit = prepared(job);
    const base = commit.decisions[0].selections[0], best = { ...base, quote: { ...base.quote, odds: 2.1, bookmaker: 'Other fixture bookmaker' } };
    const forged = { ...base, selectionKey: 'forged', quote: { ...base.quote, odds: 3 } };
    const synthetic = { ...base, quote: { ...base.quote, odds: 4, source: 'synthetic' } };
    commit.inputSnapshot.quotes.push(best.quote, forged.quote, synthetic.quote);
    for (const decision of commit.decisions) decision.selections = [forged, base, synthetic, best];
    const result = await f.recommendations.commitBatch([commit]);
    assert.equal(result.bets.length, 2); assert.ok(result.bets.every(row => row.odds === 2.1));
    const later = await f.recommendations.registerPolicy({ ...policy, revision: 'different-policy-same-candidates' });
    const secondJob = (await f.claim(later)).jobs[0]; assert.ok(secondJob);
    const repeat = await f.recommendations.commitBatch([prepared(secondJob)]);
    assert.equal(repeat.bets.length, 0); assert.ok(repeat.decisions.every(row => row.reason === 'paper_selection_already_recorded'));
    assert.equal((await f.recommendations.listPaperBets()).length, 2);
  } finally { await f.close(); }
});

test('paper settlement handles void and quarter outcomes, repeated and concurrent writes, and negative cumulative profit', async () => {
  const f = await setup({ matches: 1 });
  try {
    const commit = prepared((await f.claim()).jobs[0], 4), result = await f.recommendations.commitBatch([commit]);
    const before = await f.fingerprint(), [lost, halfLost, halfWon, voided] = result.bets.filter(row => row.family === 'A');
    const settle = (bet, multiplier, status) => f.research.runResearchTransaction(tx => settlePaperBet(tx, bet.id, multiplier,
      { status, fixture: true }, new Date('2026-11-06T21:00:00Z')));
    await settle(lost, 0, 'LOST'); await settle(halfLost, .5, 'HALF_LOST'); await settle(halfWon, 1.5, 'HALF_WON');
    const repeated = await Promise.all([settle(voided, 1, 'VOID'), settle(voided, 1, 'VOID')]);
    assert.equal(repeated.filter(row => row.settled).length, 1);
    await assert.rejects(settle(voided, 0, 'LOST'), /immutable/);
    const overview = paperBetOverview(await f.recommendations.listPaperBets());
    assert.equal(overview.profitUnits, -1); assert.equal(overview.settledStakeUnits, 4); assert.equal(overview.roiPercent, -25);
    assert.ok(Math.abs(overview.winRatePercent - 100 / 3) < 1e-10); assert.equal(overview.history.at(-1).profitUnits, -1);
    const second = await f.recommendations.registerPolicy({ ...policy, revision: 'loss-does-not-block' });
    const more = await f.recommendations.commitBatch([prepared((await f.claim(second)).jobs[0], 5)]);
    assert.equal(more.bets.length, 2); assert.equal(await f.fingerprint(), before);
    await assert.rejects(f.client.execute('DELETE FROM paper_model_settlements'), /immutable/);
  } finally { await f.close(); }
});

test('paper runtime settlement leaves missing statistics pending and settles goal quarter and real card points', async () => {
  const f = await setup({ matches: 1 });
  try {
    const commit = prepared((await f.claim()).jobs[0]);
    const quarter = selection(0, { selection: 'quarter-fixture', line: 2.25 });
    const shots = selection(0, { market: 'shots', selection: 'shots_total_over_20.5', line: 20.5 });
    const cards = selection(0, { market: 'cards_total', selection: 'cards_total_over_4.5', line: 4.5 });
    commit.inputSnapshot.quotes = [quarter.quote, shots.quote, cards.quote];
    commit.decisions[0].selections = [quarter, shots, cards]; commit.decisions[1].selections = [quarter];
    await f.recommendations.commitBatch([commit]);
    const match = { match_id: f.fixtures[0].matchId, date: KICKOFF, home_goals: 1, away_goals: 1, source: 'fixture',
      home_yellow_cards: 1, away_yellow_cards: 2, home_red_cards: 1, away_red_cards: 0, home_shots: null, away_shots: 10 };
    const db = { recommendations: f.recommendations, research: f.research, getMatchById: async () => match };
    const before = await f.fingerprint(), settled = await settlePaperModelBets(db);
    assert.deepEqual(settled, { checked: 4, settled: 3, unresolved: 1 });
    const rows = await f.recommendations.listPaperBets();
    assert.equal(rows.find(row => row.market === 'shots').status, 'PENDING');
    assert.equal(rows.find(row => row.market === 'cards_total').status, 'WON');
    assert.equal(rows.find(row => row.family === 'C').status, 'HALF_LOST');
    assert.deepEqual(await settlePaperModelBets(db), { checked: 1, settled: 0, unresolved: 1 });
    assert.equal(await f.fingerprint(), before);
  } finally { await f.close(); }
});

test('paper units preserve half-win and three-decimal odds precision in profit, ROI and history', async () => {
  const f = await setup({ matches: 1 });
  try {
    const commit = prepared((await f.claim()).jobs[0], 2);
    const children = [selection(0, { odds: 2.01 }), selection(1, { odds: 2.123 })];
    commit.inputSnapshot.quotes = children.map(child => child.quote);
    for (const decision of commit.decisions) decision.selections = children;
    const result = await f.recommendations.commitBatch([commit]);
    const [halfWon, won] = result.bets.filter(row => row.family === 'A');
    const halfMultiplier = (halfWon.odds + 1) / 2;
    const first = await f.research.runResearchTransaction(tx => settlePaperBet(tx, halfWon.id, halfMultiplier,
      { status: 'HALF_WON' }, new Date('2026-11-06T21:00:00Z')));
    await f.research.runResearchTransaction(tx => settlePaperBet(tx, won.id, won.odds,
      { status: 'WON' }, new Date('2026-11-06T21:01:00Z')));
    const rows = await f.recommendations.listPaperBets(), halfView = rows.find(row => row.id === halfWon.id);
    assert.equal(first.returnCents, Math.round(100 * halfMultiplier));
    assert.equal(first.profitUnits, halfMultiplier - 1);
    assert.equal(halfView.returnUnits, halfMultiplier);
    assert.equal(halfView.profitUnits, halfMultiplier - 1);
    assert.equal(rows.find(row => row.id === won.id).returnUnits, 2.123);
    const overview = paperBetOverview(rows), close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
    close(overview.returnUnits, 3.628); close(overview.profitUnits, 1.628); close(overview.roiPercent, 81.4);
    close(overview.history[0].profitUnits, .505); close(overview.history[1].profitUnits, 1.628);
    close(overview.portfolios.find(row => row.family === 'A').profitUnits, 1.628);
    assert.equal(overview.wonCount, 2); assert.equal(overview.openCount, 2);
  } finally { await f.close(); }
});

test('legacy maintenance skips only a completely uninitialized paper ledger when explicitly allowed', async () => {
  const client = createClient({ url: ':memory:' });
  const research = new ResearchStore(client), recommendations = new ResearchRecommendationStore(client, async () => {}, { research });
  const db = { recommendations, research, getMatchById: async () => { throw new Error('Unexpected match lookup'); } };
  try {
    await assert.rejects(settlePaperModelBets(db), error => error.code === 'paper_schema_required');
    assert.deepEqual(await settlePaperModelBets(db, { allowUninitialized: true }),
      { checked: 0, settled: 0, unresolved: 0, accountingState: 'NOT_INITIALIZED' });
    await client.execute('CREATE TABLE paper_model_bets(id TEXT)');
    await assert.rejects(settlePaperModelBets(db, { allowUninitialized: true }), error => error.code === 'paper_schema_required');
    await client.execute('DROP TABLE paper_model_bets');
    await client.execute('CREATE TABLE research_execution_policies(hash TEXT,version TEXT)');
    await client.execute("INSERT INTO research_execution_policies VALUES('fixture','paper-fixed-unit-v1')");
    await assert.rejects(settlePaperModelBets(db, { allowUninitialized: true }), error => error.code === 'paper_schema_required');
    const unavailable = Object.assign(new Error('Database unavailable'), { code: 'CONNECTION_CLOSED' });
    await assert.rejects(settlePaperModelBets({ ...db, recommendations: {
      listPaperBets: async () => { throw unavailable; }, isPaperUninitialized: async () => true,
    } }, { allowUninitialized: true }), error => error === unavailable);
  } finally { client.close(); }
});

test('paper read is DDL-free and reports a missing migration explicitly', async () => {
  const client = createClient({ url: ':memory:' });
  try {
    const before = (await client.execute('SELECT * FROM sqlite_master')).rows;
    await assert.rejects(listPaperBetViews(client), error => error.code === 'paper_schema_required');
    assert.deepEqual((await client.execute('SELECT * FROM sqlite_master')).rows, before);
  } finally { client.close(); }
});

test('paper records with negative funded balance and simultaneous retries without rewriting any funded record', async () => {
  const f = await setup({ matches: 1 });
  try {
    await f.research.runResearchTransaction(async tx => {
      await tx.execute({ sql: `INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at)
        VALUES('fixture-negative-balance','shadow_A',NULL,'STAKE',-500,0,?)`, args: [START] });
    });
    const before = await f.fingerprint(), commit = prepared((await f.claim()).jobs[0], 20);
    const retries = await Promise.all([f.recommendations.commitBatch([commit]), f.recommendations.commitBatch([commit])]);
    assert.ok(retries.every(result => result.bets.length === 40));
    assert.equal((await f.recommendations.listPaperBets()).length, 40);
    assert.equal((await f.research.listPortfolios()).find(row => row.family === 'A').availableCents, -500);
    assert.equal(await f.fingerprint(), before);
    const changed = structuredClone(commit); changed.decisions[0].selections[0].probability = .7;
    await assert.rejects(f.recommendations.commitBatch([changed]), /immutable/);
  } finally { await f.close(); }
});

test('paper policy is explicit and cannot carry a balance, exposure, count cap, or old recovery protocol', async () => {
  const f = await setup({ matches: 1 });
  try {
    for (const extra of [{ fixedStakeUnits: 2 }, { maxExposureFraction: .05 }, { maxBetsPerMatchPerFamily: 1 },
      { initialCapital: 1000 }, { recovery: { protocol: 'virtual-recommendation-technical-recovery-v1' } },
      { stakeModeA: 'RECOMMENDED_PERCENT' }]) {
      await assert.rejects(f.recommendations.registerPolicy({ ...policy, ...extra }), /Unsupported paper/);
    }
  } finally { await f.close(); }
});

test('paper ignores existing A/C funded bets for admission and preserves their records and ledger', async () => {
  const f = await setup({ matches: 1, funded: true });
  try {
    for (const family of ['A', 'C']) {
      const id = `old-funded-${family}`, matchId = f.fixtures[0].matchId;
      await f.client.execute({ sql: `INSERT INTO research_bets
        (id,decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at)
        VALUES(?,?,?,?,?,?,'1x2','homeWin',2,1000,'{}',?)`, args: [id, `origin-0-${family}`, `shadow_${family}`, matchId, family, `${family}-fixture`, START] });
      await f.client.execute({ sql: `INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at)
        VALUES(?,?,?,'STAKE',-1000,1000,?)`, args: [`stake:${id}`, `shadow_${family}`, id, START] });
    }
    const before = await f.fingerprint(), jobs = (await f.claim()).jobs;
    assert.equal(jobs.length, 1);
    assert.equal((await f.recommendations.commitBatch([prepared(jobs[0], 5)])).bets.length, 10);
    assert.equal(await f.fingerprint(), before);
    assert.equal((await f.research.listBets()).length, 2);
  } finally { await f.close(); }
});

test('migration installs paper guards before any policy registration and splits with the production SQL parser', async () => {
  const { DatabaseService } = require(join(build, 'db/DatabaseService'));
  const client = createClient({ url: ':memory:' });
  try {
    const legacySchema = () => client.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE 'paper_%' ORDER BY type,name");
    let beforePaper;
    for (const name of ['015_research_platform.sql', '023_research_recommendation_execution.sql', '028_paper_model_bets.sql']) {
      if (name.startsWith('028')) beforePaper = (await legacySchema()).rows;
      const sql = readFileSync(join(__dirname, '../migrations', name), 'utf8');
      const statements = DatabaseService.prototype.splitMigrationStatements.call({}, sql);
      if (name.startsWith('028')) assert.ok(statements.every(statement => /^\s*(?:--[^\n]*\n\s*)*CREATE\b/.test(statement)));
      for (const statement of statements) await client.execute(statement);
    }
    assert.deepEqual((await legacySchema()).rows, beforePaper);
    assert.equal((await client.execute('PRAGMA foreign_key_check')).rows.length, 0);
    const guards = (await client.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'paper_%'")).rows;
    assert.equal(guards.length, 5);
    const columns = (await client.execute('PRAGMA table_info(research_bets)')).rows;
    assert.equal(columns.length, 13); // The only added legacy column is migration 023's existing execution identity.
  } finally { client.close(); }
});

test('paper integrity and watchdog are read-only, accept zero-funded history, and detect independent evidence or settlement corruption', async () => {
  const f = await setup({ matches: 1 });
  try {
    await f.client.executeMultiple(readFileSync(join(__dirname, '../migrations/018_smart_odds.sql'), 'utf8'));
    await f.client.execute('CREATE TABLE scheduler_runs(scheduler_name TEXT,started_at TEXT,ended_at TEXT,success INTEGER,error TEXT,summary_json TEXT)');
    const result = await f.recommendations.commitBatch([prepared((await f.claim()).jobs[0], 5)]);
    const settled = result.bets[0];
    await f.research.runResearchTransaction(tx => settlePaperBet(tx, settled.id, 0, { status: 'LOST' }));
    const checked = { execute: async query => { assert.match((typeof query === 'string' ? query : query.sql).trim(), /^SELECT\b/i); return f.client.execute(query); } };
    const before = json((await f.client.execute('SELECT * FROM paper_model_bets ORDER BY id')).rows);
    const audit = await inspectPaperAccounting(checked);
    assert.equal(audit.errors, 0); assert.equal(audit.checked, true); assert.equal(audit.schemaPresent, true);
    const { inspectDatabase } = require('../scripts/check-research-nightly');
    const watchdog = await inspectDatabase(checked, { now: new Date(START) });
    assert.equal(watchdog.ok, true); assert.equal(watchdog.accounting.errors, 0); assert.equal(watchdog.paperAccounting.errors, 0);
    assert.equal(json((await f.client.execute('SELECT * FROM paper_model_bets ORDER BY id')).rows), before);
    const duplicateRead = { execute: async query => {
      const value = await checked.execute(query), sql = typeof query === 'string' ? query : query.sql;
      if (sql === 'SELECT * FROM paper_model_bets') return { ...value, rows: [...value.rows, { ...value.rows[0], id: 'duplicate-fixture' }] };
      return value;
    } };
    assert.ok((await inspectPaperAccounting(duplicateRead)).failures.some(value => value.endsWith(':duplicate_selection')));
    const missingAuthorization = { execute: async query => {
      const value = await checked.execute(query), sql = typeof query === 'string' ? query : query.sql;
      return sql.startsWith('SELECT d.id AS authorized_id') ? { ...value, rows: [] } : value;
    } };
    assert.ok((await inspectPaperAccounting(missingAuthorization)).failures.some(value => value.endsWith(':authorization')));
    const orphanSettlement = { execute: async query => {
      const value = await checked.execute(query), sql = typeof query === 'string' ? query : query.sql;
      if (sql.startsWith('SELECT s.*,b.id AS existing_bet')) return { ...value, rows: [...value.rows,
        { bet_id: 'orphan-fixture', existing_bet: null, multiplier: 1, return_cents: 100, evidence_json: '{"fixture":true}', settled_at: START }] };
      return value;
    } };
    assert.ok((await inspectPaperAccounting(orphanSettlement)).failures.includes('orphan-fixture:orphan_settlement'));
    await f.client.execute('DROP TRIGGER paper_model_settlements_immutable_update');
    await f.client.execute({ sql: 'UPDATE paper_model_settlements SET return_cents=7 WHERE bet_id=?', args: [settled.id] });
    const badReturn = await inspectPaperAccounting(checked);
    assert.ok(badReturn.failures.includes(`${settled.id}:settlement`));
    assert.ok((await inspectDatabase(checked, { now: new Date(START) })).issues.includes('paper_accounting_integrity'));
  } finally { await f.close(); }
});

test('paper schema is optional before activation and missing after activation is an explicit integrity failure', async () => {
  const client = createClient({ url: ':memory:' });
  try {
    const inactive = await inspectPaperAccounting(client);
    assert.equal(inactive.required, false); assert.equal(inactive.errors, 0);
    await client.execute('CREATE TABLE research_execution_policies(hash TEXT,version TEXT,descriptor_json TEXT,created_at TEXT)');
    await client.execute("INSERT INTO research_execution_policies VALUES('fixture','paper-fixed-unit-v1','{}','2026-11-06T10:00:00Z')");
    const activated = await inspectPaperAccounting(client);
    assert.equal(activated.required, true); assert.equal(activated.errors, 1); assert.deepEqual(activated.failures, ['paper_schema_required']);
  } finally { client.close(); }
});

test('paper diagnostic claiming alone ignores old match bets, preserving frozen inputs and existing lease rules', async () => {
  const f = await setup({ matches: 1 });
  try {
    const target = { matchId: 'new-paper-diagnostic-target', kickoffAt: KICKOFF };
    await f.client.execute({ sql: `INSERT INTO research_bets
      (id,decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at)
      VALUES('historical-fixture','origin-0-A','shadow_A',?,'A','A-fixture','1x2','homeWin',2,100,'{}',?)`, args: [target.matchId, START] });
    const before = await f.fingerprint();
    const old = await f.research.claimNightlyBatch({ startedAt: START, windowEndAt: END, fixtures: [target], runId: 'old-policy' });
    assert.deepEqual(old.skipped.map(row => row.reason), ['bet_already_recorded']);
    await f.research.finishNightlyRun(old.run.id, old.run.leaseToken, { status: 'COMPLETED', summary: {} });
    const paper = await f.research.claimNightlyBatch({ startedAt: START, windowEndAt: END, fixtures: [target, f.fixtures[0]], runId: 'paper-diagnostic', paperDiagnosticOnly: true });
    assert.equal(paper.jobs.length, 1); assert.equal(paper.jobs[0].matchId, target.matchId);
    assert.deepEqual(paper.skipped.map(row => row.reason), ['decision_already_recorded']);
    assert.equal((await f.research.claimNightlyBatch({ startedAt: START, windowEndAt: END, fixtures: [target], runId: 'competing-paper', paperDiagnosticOnly: true })).busy, true);
    assert.equal(await f.fingerprint(), before);
  } finally { await f.close(); }
});

test('new nightly attempts do not replay a selection with irrelevant metadata but preserve distinct new lines and A/C', async () => {
  const f = await setup({ matches: 1 });
  try {
    const before = await f.fingerprint(), firstJob = (await f.claim()).jobs[0];
    const first = prepared(firstJob), home = selection(0, { market: '1x2', selection: 'homeWin', side: 'home', line: undefined });
    first.inputSnapshot.quotes = [home.quote];
    first.decisions.forEach(decision => { decision.selections = [home]; });
    assert.equal((await f.recommendations.commitBatch([first])).bets.length, 2);
    const retry = await f.recommendations.claimBatch({ policyHash: f.registered.hash, runId: 'next-nightly',
      windowStartAt: START, windowEndAt: END, fixtures: f.fixtures });
    assert.equal(retry.jobs.length, 0); assert.equal(retry.skipped[0].reason, 'policy_decision_already_recorded');

    const nextPolicy = await f.recommendations.registerPolicy({ ...policy, revision: 'separate-verified-execution' });
    const nextJob = (await f.recommendations.claimBatch({ policyHash: nextPolicy.hash, runId: 'next-nightly-policy',
      windowStartAt: START, windowEndAt: END, fixtures: f.fixtures })).jobs[0];
    const next = prepared(nextJob), equivalent = selection(0, { market: '1x2', selection: 'homeWin', side: 'home',
      line: 7, team: 'away', playerName: 'Ignored metadata', bookmaker: 'Other actual bookmaker' });
    const distinct = selection(1);
    next.inputSnapshot.quotes = [equivalent.quote, distinct.quote];
    next.decisions.forEach(decision => { decision.selections = [equivalent, distinct]; });
    assert.equal((await f.recommendations.commitBatch([next])).bets.length, 2);
    const all = await f.recommendations.listPaperBets();
    assert.equal(all.length, 4);
    for (const family of ['A', 'C']) {
      assert.equal(all.filter(row => row.family === family && row.market === '1x2').length, 1);
      assert.equal(all.filter(row => row.family === family && row.market === 'totals').length, 1);
    }
    assert.equal(await f.fingerprint(), before);
  } finally { await f.close(); }
});
