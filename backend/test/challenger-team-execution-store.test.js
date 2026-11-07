const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { paperExecutionPolicy, fallbackChallengerState } = require('../dist/research/ResearchRecommendationPolicy');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { CURRENT_CHALLENGER_RELEASE: release } = require('../dist/research/CurrentChallengerRelease');
const { paperSelectionKey } = require('../dist/research/PaperBetSelections');
const START = '2026-11-06T10:00:00.000Z', KICKOFF = '2026-11-06T19:00:00.000Z', END = '2026-11-07T02:00:00.000Z';
const artifact = JSON.parse(readFileSync(join(__dirname, '../current-models/challenger.json'), 'utf8'));
const goal = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
  pipelineHashV2: artifact.pipelineHashV2, mode: artifact.probabilityCalibrationMode, profile: artifact.calibrationProfilesV2.C });
const model = { source: 'PredictionService', version: 'APP-A-1234', codeHash: 'a'.repeat(64), configHash: 'b'.repeat(64), stateHash: 'c'.repeat(64) };
const config = { version: 'c-team-probability-configuration-v1', family: 'C', marketPolicyVersion: 'c-team-markets-v1',
  goalConfiguration: goal.descriptor, goalConfigurationHash: goal.hash,
  sharedSpecialistModel: { source: model.source, version: model.version, codeHash: model.codeHash, configHash: model.configHash } };
const json = v => JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? Number(x) : x);
function cleanup(path) {
  for (const suffix of ['', '-wal', '-shm']) try { rmSync(path + suffix, { force: true }); }
  catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
}
async function scenario(kind) {
  const path = join(tmpdir(), `c-team-execution-${randomUUID()}.db`), client = createClient({ url: `file:${path}` });
  try {
    for (const migration of ['015_research_platform.sql', '020_research_nightly.sql', '023_research_recommendation_execution.sql', '028_paper_model_bets.sql'])
      await client.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
    await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT NOT NULL,home_goals INTEGER,away_goals INTEGER)');
    const clock = () => new Date(START), research = new ResearchStore(client, async () => {}, { now: clock });
    await research.initializePortfolios();
    for (const [family, version] of [['A', 'A-fixture'], ['C', release.modelVersion]])
      await research.saveModel({ family, version, artifact: { family, version, fixtureOnly: true } });
    await research.setMarketState({ family: 'C', modelVersion: release.modelVersion, market: 'cards_total', state: kind === 'suspended' ? 'SUSPENDED' : 'EXPERIMENTAL' });
    await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,NULL,NULL)', args: ['match', KICKOFF] });
    await client.execute({ sql: "INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at) VALUES('job','match',?,?,'COMPLETED',?,?)", args: [KICKOFF, START, START, START] });
    await client.execute({ sql: "INSERT INTO research_inputs VALUES('input','job',?,?,?,?)", args: [researchHash({ matchId: 'match' }), json({ matchId: 'match' }), START, KICKOFF] });
    for (const [family, version] of [['A', 'A-fixture'], ['C', release.modelVersion]])
      await client.execute({ sql: "INSERT INTO research_decisions(id,job_id,input_id,family,model_version,market,portfolio_id,action,snapshot_json,created_at) VALUES(?,'job','input',?,?,'1x2',?,'ABSTAIN','{}',?)", args: [`origin-${family}`, family, version, `shadow_${family}`, START] });
    const store = new ResearchRecommendationStore(client, async () => {}, { now: clock, research });
    const policy = paperExecutionPolicy(fallbackChallengerState());
    if (kind === 'no_policy') delete policy.familyC.marketPolicyVersion;
    const registered = await store.registerPolicy(policy);
    const job = (await store.claimBatch({ policyHash: registered.hash, runId: 'test', windowStartAt: START, windowEndAt: END, fixtures: [{ matchId: 'match', kickoffAt: KICKOFF }] })).jobs[0];
    assert.ok(job);
    const quote = { market: 'cards_total', selection: 'cards_total_over_3.5', side: 'over', line: 3.5, odds: 2,
      source: 'odds_api', bookmaker: 'Fixture bookmaker', priceType: 'prematch', capturedAt: START, updatedAt: START };
    if (kind === 'no_policy') quote.marketPolicyVersion = 'c-team-markets-v1';
    const cfg = kind === 'bad_config' ? { ...config, goalConfigurationHash: 'f'.repeat(64) } : config;
    const child = { market: quote.market, selection: quote.selection, selectionKey: paperSelectionKey(quote), quote,
      probability: .6, ev: .2, confidence: 'MEDIUM', qualificationEvidence: kind === 'no_evidence' ? undefined : { source: 'shared_A_specialist', model: kind === 'bad_state' ? { ...model, stateHash: '' } : model } };
    const decisions = [{ family: 'A', modelVersion: 'A-fixture', originDecisionId: job.originDecisionIds.A, action: 'ABSTAIN', reason: 'fixture_abstention' },
      { family: 'C', modelVersion: release.modelVersion, originDecisionId: job.originDecisionIds.C,
        action: 'BET', recommended: true, validated: true, ...child, selections: [child], probabilityConfiguration: cfg, probabilityConfigurationHash: researchHash(cfg) }];
    const result = await store.commitBatch([{ jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
      inputSnapshot: { observedAt: START, match: { matchId: 'match', kickoffAt: KICKOFF }, quotes: kind === 'unshared_quote' ? [] : [quote] }, decisions }]);
    return { result, bets: await store.listPaperBets() };
  } finally { client.close(); cleanup(path); }
}
test('C statistical execution requires current policy, specialist evidence and permitted registry state', async () => {
  assert.equal(goal.hash, release.probabilityConfigurationHash);
  for (const kind of ['valid', 'no_policy', 'no_evidence', 'bad_state', 'bad_config', 'suspended', 'unshared_quote']) {
    const { result, bets } = await scenario(kind), c = result.decisions.find(d => d.family === 'C');
    assert.equal(bets.length, kind === 'valid' ? 1 : 0, `${kind}: ${JSON.stringify(c)}`);
    assert.equal(c.action, kind === 'valid' ? 'BET' : 'ABSTAIN', kind);
    if (kind === 'valid') assert.equal(bets[0].market, 'cards_total');
  }
});
