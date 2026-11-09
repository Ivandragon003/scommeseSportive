const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const { ResearchStore, researchHash } = require('../dist/research/ResearchStore');
const { ResearchRecommendationStore } = require('../dist/research/ResearchRecommendationStore');
const { paperExecutionPolicy, fallbackChallengerState, validCStatEvidence } = require('../dist/research/ResearchRecommendationPolicy');
const { buildJointHeadProbabilityConfiguration } = require('../dist/research/JointHeadConfiguration');
const { buildChallengerTeamConfiguration } = require('../dist/research/ChallengerTeamRecommendation');
const { CHALLENGER_TEAM_MARKET_POLICY } = require('../dist/research/ChallengerMarketCoverage');
const { CURRENT_CHALLENGER_RELEASE: release } = require('../dist/research/CurrentChallengerRelease');
const { paperSelectionKey } = require('../dist/research/PaperBetSelections');
const artifact = JSON.parse(readFileSync(join(__dirname, '../current-models/challenger.json'), 'utf8'));
const START = new Date(Date.parse(artifact.createdAt) + 86400000).toISOString();
const KICKOFF = new Date(Date.parse(START) + 9 * 3600000).toISOString();
const END = new Date(Date.parse(START) + 16 * 3600000).toISOString();
const goal = buildJointHeadProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
  pipelineHashV2: artifact.pipelineHashV2, mode: artifact.probabilityCalibrationMode, profile: artifact.calibrationProfilesV2.C },
researchHash(artifact.models.jointHead));
const model = { source: 'PredictionService', version: 'APP-A-1234', codeHash: 'a'.repeat(64), configHash: 'b'.repeat(64), stateHash: 'c'.repeat(64) };
// A well-formed specialist payload still cannot expand the current release's coverage.
const specialistConfig = { version: 'c-team-probability-configuration-v1', family: 'C', marketPolicyVersion: CHALLENGER_TEAM_MARKET_POLICY,
  goalConfiguration: goal.descriptor, goalConfigurationHash: goal.hash,
  sharedSpecialistModel: { source: model.source, version: model.version, codeHash: model.codeHash, configHash: model.configHash } };
const guardConfig = buildChallengerTeamConfiguration({ probabilityConfiguration: goal.descriptor,
  probabilityConfigurationHash: goal.hash, opportunityGuard: artifact.opportunityGuard });
const json = v => JSON.stringify(v, (_k, x) => typeof x === 'bigint' ? Number(x) : x);
function cleanup(path) {
  for (const suffix of ['', '-wal', '-shm']) try { rmSync(path + suffix, { force: true }); }
  catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
}
async function scenario(kind, market = 'cards_total') {
  const path = join(tmpdir(), `c-team-execution-${randomUUID()}.db`), client = createClient({ url: `file:${path}` });
  try {
    for (const migration of ['015_research_platform.sql', '020_research_nightly.sql', '023_research_recommendation_execution.sql', '028_paper_model_bets.sql'])
      await client.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
    await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT NOT NULL,home_goals INTEGER,away_goals INTEGER)');
    const clock = () => new Date(START), research = new ResearchStore(client, async () => {}, { now: clock });
    await research.initializePortfolios();
    for (const [family, version] of [['A', 'A-fixture'], ['C', release.modelVersion]])
      await research.saveModel({ family, version, artifact: { family, version, fixtureOnly: true } });
    if (kind !== 'missing_registry') await research.setMarketState({ family: 'C', modelVersion: release.modelVersion, market, state: kind === 'suspended' ? 'SUSPENDED' : 'EXPERIMENTAL' });
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
    const quote = { market, ...(market === 'cards_total' ? { selection: 'cards_total_over_3.5', side: 'over', line: 3.5 }
      : { selection: 'ahcp_-0.5', side: 'home', line: .5 }), odds: 2,
      source: 'odds_api', bookmaker: 'Fixture bookmaker', priceType: 'prematch', capturedAt: START, updatedAt: START };
    if (kind === 'no_policy') quote.marketPolicyVersion = CHALLENGER_TEAM_MARKET_POLICY;
    if (kind === 'stale_quote') quote.updatedAt = new Date(Date.parse(START) - 6 * 60000).toISOString();
    if (kind === 'synthetic_quote') quote.usedSyntheticOdds = true;
    const config = market === 'cards_total' ? specialistConfig : guardConfig;
    const cfg = kind === 'bad_config' ? { ...config, goalConfigurationHash: 'f'.repeat(64) } : config;
    const child = { market: quote.market, selection: quote.selection, selectionKey: paperSelectionKey(quote), quote,
      probability: .6, ev: .2, confidence: 'MEDIUM', qualificationEvidence: kind === 'no_evidence' ? undefined : { source: 'shared_A_specialist', model: kind === 'bad_state' ? { ...model, stateHash: '' } : model } };
    if (kind === 'forged_key') child.selectionKey = 'forged-key';
    if (kind === 'bad_child_configuration') child.probabilityConfigurationHash = '0'.repeat(64);
    const configurationHash = kind === 'bad_identity' ? '0'.repeat(64) : researchHash(cfg);
    const decisions = [{ family: 'A', modelVersion: 'A-fixture', originDecisionId: job.originDecisionIds.A, action: 'ABSTAIN', reason: 'fixture_abstention' },
      { family: 'C', modelVersion: release.modelVersion, originDecisionId: job.originDecisionIds.C,
        action: 'BET', recommended: true, validated: true, ...child, selections: [child], probabilityConfiguration: cfg, probabilityConfigurationHash: configurationHash }];
    const result = await store.commitBatch([{ jobId: job.id, leaseToken: job.leaseToken, originInputId: job.originInputId,
      inputSnapshot: { observedAt: START, match: { matchId: 'match', kickoffAt: KICKOFF }, quotes: kind === 'unshared_quote' ? [] : [quote] }, decisions }]);
    return { result, bets: await store.listPaperBets(), evidenceValid: validCStatEvidence(cfg, child.qualificationEvidence) };
  } finally { client.close(); cleanup(path); }
}
test('current C rejects cards even with valid specialist evidence and any registry state', async () => {
  assert.equal(goal.hash, release.probabilityConfigurationHash);
  for (const kind of ['valid', 'no_policy', 'no_evidence', 'bad_state', 'bad_config', 'suspended', 'missing_registry', 'unshared_quote']) {
    const { result, bets, evidenceValid } = await scenario(kind), c = result.decisions.find(d => d.family === 'C');
    assert.equal(evidenceValid, !['no_evidence', 'bad_state', 'bad_config'].includes(kind), `specialist evidence: ${kind}`);
    assert.equal(bets.length, 0, `${kind}: ${JSON.stringify(c)}`);
    assert.equal(c.action, 'ABSTAIN', kind);
  }
});

test('current C accepts a valid AH primary independently of experimental, missing or suspended registry state', async () => {
  for (const kind of ['valid', 'missing_registry', 'suspended']) {
    const { result, bets } = await scenario(kind, 'asian_handicap'), c = result.decisions.find(d => d.family === 'C');
    assert.equal(c.action, 'BET', `${kind}: ${JSON.stringify(c)}`);
    assert.equal(bets.length, 1, kind); assert.equal(bets[0].market, 'asian_handicap');
    assert.equal(bets[0].selection, 'ahcp_-0.5'); assert.equal(c.selections.length, 1);
    assert.equal(c.probabilityConfiguration.goalConfigurationHash, release.probabilityConfigurationHash);
    assert.deepEqual(c.probabilityConfiguration.goalConfiguration, goal.descriptor);
  }
});

test('allowed current C goal markets still enforce configuration identity and quote provenance', async () => {
  const expected = { bad_identity: 'probability_configuration_identity_required',
    bad_child_configuration: 'probability_configuration_identity_required', unshared_quote: 'quote_not_in_shared_snapshot',
    stale_quote: 'real_fresh_quote_required', synthetic_quote: 'real_fresh_quote_required', forged_key: 'selection_quote_mismatch' };
  for (const [kind, reason] of Object.entries(expected)) {
    const { result, bets } = await scenario(kind, 'asian_handicap'), c = result.decisions.find(d => d.family === 'C');
    assert.equal(bets.length, 0, kind); assert.equal(c.action, 'ABSTAIN', kind); assert.equal(c.reason, reason, kind);
  }
});
