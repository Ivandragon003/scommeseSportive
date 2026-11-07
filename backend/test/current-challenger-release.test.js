'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { baselineManifest, buildForecastInput } = require('../dist/research/ForecastCore');
const { validateArtifact, predictHybrid } = require('../dist/research/CatBoostModel');
const { applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash } = require('../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');
const { researchHash } = require('../dist/research/ResearchStore');
const { CURRENT_CHALLENGER_RELEASE } = require('../dist/research/CurrentChallengerRelease');
const { INITIAL_CHALLENGER_DEPLOYMENT } = require('../dist/research/ChallengerAdoption');
const { FALLBACK_CHALLENGER_DEPLOYMENT } = require('../dist/research/ResearchRecommendationPolicy');
const { CHALLENGER_DATA_QUALITY_POLICY_HASH, challengerDataQualityReason } = require('../dist/research/ChallengerDataQuality');
const { ORIGINAL_HOLDOUT_POLICY } = require('../dist/research/ResearchHoldoutPolicy');
const artifact = JSON.parse(readFileSync(join(__dirname, '../current-models/challenger.json'), 'utf8'));

test('the sole packaged challenger matches the current baseline, configuration and release hashes', () => {
  validateArtifact(artifact);
  assert.equal(artifact.version, CURRENT_CHALLENGER_RELEASE.modelVersion);
  assert.equal(artifact.baselineVersion, baselineManifest().version);
  assert.equal(researchHash(artifact), CURRENT_CHALLENGER_RELEASE.artifactHash);
  assert.equal(artifact.pipelineHashV2, coherentProbabilityPipelineHash());
  const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
    pipelineHashV2: artifact.pipelineHashV2, mode: artifact.probabilityCalibrationMode, profile: artifact.calibrationProfilesV2.C });
  assert.equal(configuration.hash, CURRENT_CHALLENGER_RELEASE.probabilityConfigurationHash);
  assert.deepEqual(INITIAL_CHALLENGER_DEPLOYMENT, CURRENT_CHALLENGER_RELEASE);
  assert.deepEqual(FALLBACK_CHALLENGER_DEPLOYMENT, CURRENT_CHALLENGER_RELEASE);
  assert.equal(artifact.productionValidated, false);
  assert.equal(artifact.holdoutProtection.protectedRowsUsed, 0);
  assert.equal(artifact.dataQualityPolicyHash, CHALLENGER_DATA_QUALITY_POLICY_HASH);
  const protectedIds = new Set(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
  assert.equal(artifact.calibrationPredictions.length, 358);
  assert.ok(artifact.calibrationPredictions.every(row => !protectedIds.has(row.matchId) && !challengerDataQualityReason(row.matchId)));
});

test('the actual current model infers from shared A code and rejects an obsolete baseline', () => {
  // Synthetic match inputs verify integration; they are not accuracy evidence.
  const at = Date.parse(artifact.createdAt) + 60000;
  const history = Array.from({ length: 45 }, (_, i) => ({ matchId: `release-${i}`,
    homeTeamId: `team-${i % 4}`, awayTeamId: `team-${(i + 1) % 4}`, competition: 'Serie A', season: '2025/2026',
    date: new Date(at - (60 - i) * 86400000).toISOString(), homeGoals: i % 3, awayGoals: (i + 1) % 3,
    homeXG: 1.2, awayXG: .9 }));
  const target = { matchId: 'release-target', homeTeamId: 'team-0', awayTeamId: 'team-1', competition: 'Serie A',
    season: '2026/2027', date: new Date(at + 3600000).toISOString() };
  const input = { ...buildForecastInput(history, target, new Date(at).toISOString()),
    dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true };
  const raw = predictHybrid(input, artifact);
  const result = applyCoherentProbabilityPipeline({ matrix: raw.matrix, rawProbabilities: raw.probabilities,
    quotes: [], forecastAt: input.forecastAt, mode: artifact.probabilityCalibrationMode, profile: artifact.calibrationProfilesV2.C });
  assert.ok(Math.abs(result.matrix.flat().reduce((a, b) => a + b, 0) - 1) < 1e-12);
  assert.ok(Math.abs(result.decision.homeWin + result.decision.draw + result.decision.awayWin - 1) < 1e-12);
  assert.throws(() => predictHybrid({ ...input, baselineVersion: 'A-obsolete' }, artifact), /baseline_mismatch/);
  assert.ok(Object.keys(require.cache).every(file => !/[\\/]research[\\/]frozen[\\/]/.test(file)));
});

test('the actual packaged model passes registry integrity reads in an isolated SQLite database', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'current-c-release-'));
  try {
    // The child owns the native SQLite handles; process exit releases them on Windows.
    const code = `const fs=require('node:fs'),path=require('node:path');
      const {createClient}=require('@libsql/client');
      const {ResearchStore,researchHash}=require('./dist/research/ResearchStore');
      const {CURRENT_CHALLENGER_RELEASE:release}=require('./dist/research/CurrentChallengerRelease');
      const artifact=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
      const client=createClient({url:'file:'+path.join(process.argv[2],'registry.db')});
      (async()=>{try{
        await client.executeMultiple(fs.readFileSync('migrations/015_research_platform.sql','utf8'));
        const store=new ResearchStore(client,async()=>{}, {now:()=>new Date(Date.parse(artifact.createdAt)+60000)});
        await store.saveModel({family:'C',version:artifact.version,artifact});
        const loaded=await store.getPreviewModelC(artifact.version);
        if(researchHash(loaded.artifact)!==release.artifactHash||loaded.version!==release.modelVersion)throw Error('release_integrity');
        console.log(JSON.stringify({version:loaded.version,hash:researchHash(loaded.artifact)}));
      }finally{client.close();}})().catch(error=>{console.error(error);process.exitCode=1;});`;
    const child = spawnSync(process.execPath, ['-e', code, join(__dirname, '../current-models/challenger.json'), directory],
      { cwd: join(__dirname, '..'), encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { version: CURRENT_CHALLENGER_RELEASE.modelVersion,
      hash: CURRENT_CHALLENGER_RELEASE.artifactHash });
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 30 });
  }
});
