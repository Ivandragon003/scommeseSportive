const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
if (process.env.RESEARCH_SOURCE_TESTS === '1') require('ts-node/register/transpile-only');
const moduleRoot = process.env.RESEARCH_SOURCE_TESTS === '1' ? '../src/research/' : '../dist/research/';
const { CHALLENGER_DATA_QUALITY_MANIFEST: policy, CHALLENGER_DATA_QUALITY_POLICY_HASH: policyHash,
  challengerDataQualityReason, filterChallengerHistory, getChallengerDataQualityEvidence } = require(moduleRoot + 'ChallengerDataQuality');
const { FEATURE_NAMES, FEATURE_SCHEMA_VERSION, baselineManifest } = require(moduleRoot + 'ForecastCore');
const { withChallengerFeatures, extendChallengerTrainingDataset, buildChallengerTrainingDataset } = require(moduleRoot + 'ChallengerFeatures');
const { ORIGINAL_HOLDOUT_POLICY } = require(moduleRoot + 'ResearchHoldoutPolicy');

const at = '2024-04-20T01:07:00Z', kickoff = '2024-04-20T19:00:00Z';
const base = () => ({ matchId: 'unit-target', competition: 'Serie A', homeTeamId: 'unit-home', awayTeamId: 'unit-away',
  forecastAt: at, kickoffAt: kickoff, modelFitAt: at, maxTrainingAvailableAt: null, trainingCount: 30,
  baselineVersion: 'A-unit-fixture', baselineMatrix: [[.2, .2], [.3, .3]],
  baselineProbabilities: { homeWin: .3, draw: .5, awayWin: .2 }, lambdaHome: 1.2, lambdaAway: .9,
  features: FEATURE_NAMES.map(() => .2), featureNames: [...FEATURE_NAMES], featureSchema: FEATURE_SCHEMA_VERSION });
const fixture = (matchId, date = kickoff, competition = 'Serie A') => ({ matchId, date, competition,
  homeTeamId: 'unit-home', awayTeamId: 'unit-away', homeGoals: 1, awayGoals: 0, homeXG: 1.2, awayXG: .8 });
const row = () => ({ ...base(), homeGoals: 1, awayGoals: 0, availableAt: '2024-04-20T21:00:00Z' });
const dataset = rows => ({ schemaVersion: FEATURE_SCHEMA_VERSION, featureNames: [...FEATURE_NAMES],
  baselineManifest: baselineManifest(), asOf: '2024-04-21T00:00:00Z', exclusions: {}, rows });
const tags = { dataQualityPolicyHash: policyHash, dataQualityBaselineClean: true };

test('C quarantine is immutable, content-addressed and contains the 22 reviewed disagreements', () => {
  assert.equal(policy.scope, 'C_only');
  assert.equal(policy.action, 'quarantine_not_timestamp_correction');
  assert.equal(policy.entries.length, 22);
  assert.equal(new Set(policy.entries.map(entry => entry.matchId)).size, 22);
  assert.equal(createHash('sha256').update(JSON.stringify(policy)).digest('hex'), policyHash);
  assert.ok(Object.isFrozen(policy) && Object.isFrozen(policy.entries) && Object.isFrozen(policy.entries[0]));
  assert.match(challengerDataQualityReason('understat_22621'), /suspended/);
  assert.match(challengerDataQualityReason('understat_27866'), /court/);
  assert.match(challengerDataQualityReason('understat_31948'), /home_away/);
  assert.equal(challengerDataQualityReason('not-reviewed'), null);
  assert.ok(policy.entries.every(entry => !Object.hasOwn(entry, 'correctedKickoffAt')));
});

test('filtering returns a new C-only array and counts excluded rows without editing source objects', () => {
  const quarantined = fixture('understat_22621', '2024-04-14T16:00:00Z');
  quarantined.homeGoals = 1; quarantined.awayGoals = 2; // Suspended fixture's eventual score is already present in the archive.
  const keep = fixture('keep'), archive = [quarantined, keep, quarantined], snapshot = JSON.stringify(archive);
  const filtered = filterChallengerHistory(archive);
  assert.notEqual(filtered, archive);
  assert.deepEqual(filtered, [keep]);
  assert.equal(filtered[0], keep);
  assert.equal(JSON.stringify(archive), snapshot);
  const evidence = getChallengerDataQualityEvidence(archive, [keep, quarantined]);
  assert.deepEqual(evidence.history, { inputRows: 3, retainedRows: 1, excludedRows: 2, excludedMatchIds: ['understat_22621'] });
  assert.deepEqual(evidence.targets, { inputRows: 2, retainedRows: 1, excludedRows: 1, excludedMatchIds: ['understat_22621'] });
  assert.equal(evidence.policyHash, policyHash);
});

test('extra C features exclude quarantined historical labels while preserving A and refusing a quarantined target', () => {
  const input = base(), snapshot = JSON.stringify(input), identity = baselineManifest();
  const suspended = { ...fixture('understat_22621', '2024-04-14T16:00:00Z'), homeGoals: 1, awayGoals: 2, homeXG: 90, awayXG: 90 };
  const expected = withChallengerFeatures(input, []);
  const extended = withChallengerFeatures(input, [suspended]);
  assert.deepEqual(extended.features, expected.features);
  assert.equal(extended.challengerFeatureMetadata.quarantinedHistoryRows, 1);
  assert.equal(extended.dataQualityBaselineClean, false); // Recalculating extra columns does not prove the old baseline was clean.
  assert.equal(extended.baselineMatrix, input.baselineMatrix);
  assert.equal(extended.baselineProbabilities, input.baselineProbabilities);
  assert.equal(JSON.stringify(input), snapshot);
  assert.deepEqual(baselineManifest(), identity);
  assert.equal(withChallengerFeatures({ ...input, ...tags }, [suspended]).dataQualityBaselineClean, true);
  assert.throws(() => withChallengerFeatures({ ...input, matchId: suspended.matchId }, []), /target_data_quarantined/);
});

test('extension refuses a tainted unproven baseline and never invents a clean-baseline certificate', () => {
  const history = [fixture('understat_22621', '2024-04-14T16:00:00Z')], original = dataset([row()]);
  const snapshot = JSON.stringify(original);
  assert.throws(() => extendChallengerTrainingDataset(original, history), /baseline_data_quality_rebuild_required/);
  assert.equal(JSON.stringify(original), snapshot);
  assert.throws(() => extendChallengerTrainingDataset({ ...original, ...tags }, history), /baseline_data_quality_rebuild_required/);
  assert.throws(() => extendChallengerTrainingDataset({ ...original, dataQualityPolicyHash: 'wrong' }, []), /policy_mismatch/);
  assert.equal(extendChallengerTrainingDataset(original, []).dataQualityBaselineClean, false);
  const tagged = { ...dataset([{ ...row(), ...tags }]), ...tags, dataQualityPolicy: policy };
  const extended = extendChallengerTrainingDataset(tagged, history);
  assert.equal(extended.dataQualityBaselineClean, true);
  assert.equal(extended.rows[0].dataQualityBaselineClean, true);
  assert.equal(extended.dataQualityEvidence.history.excludedRows, 1);
});

test('C builder quarantines targets and history before fitting, keeps other-league history and blocks protected holdout targets', () => {
  const protectedId = ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds[0];
  const history = [fixture('unit-target'), fixture('understat_22621', '2024-04-14T16:00:00Z'),
    fixture(protectedId), fixture('other-league', '2024-04-12T14:00:00Z', 'Premier League')];
  const snapshot = JSON.stringify(history);
  const calls = [];
  const built = buildChallengerTrainingDataset(history, '2024-04-21T00:00:00Z', { forecastAt: (date) => `${date.slice(0, 10)}T01:07:00Z`,
    forecastPolicy: 'nightly-test-03:07-Europe-Rome', targetCompetitions: ['Serie A'],
    forecastBuilder: (cleanHistory, target, forecastAt) => {
      calls.push(target.matchId);
      assert.ok(!cleanHistory.some(match => match.matchId === 'understat_22621'));
      assert.ok(cleanHistory.some(match => match.matchId === 'other-league'));
      assert.equal(forecastAt, at);
      return { ...base(), matchId: target.matchId };
    } });
  assert.deepEqual(calls, ['unit-target']);
  assert.equal(built.rows.length, 1);
  assert.equal(built.protectedMatchesExcluded, 1);
  assert.equal(built.dataQualityPolicyHash, policyHash);
  assert.equal(built.dataQualityBaselineClean, true);
  assert.equal(built.rows[0].dataQualityPolicyHash, policyHash);
  assert.equal(built.rows[0].dataQualityBaselineClean, true);
  assert.equal(built.dataQualityEvidence.history.excludedRows, 1);
  assert.equal(built.dataQualityEvidence.targets.inputRows, 3);
  assert.equal(built.dataQualityEvidence.targets.excludedRows, 1);
  assert.equal(built.exclusions.outsideTop5, 0);
  assert.equal(JSON.stringify(history), snapshot);
});
