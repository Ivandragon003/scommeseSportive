const test = require('node:test');
const assert = require('node:assert/strict');
const { CURRENT_CHALLENGER_RELEASE } = require('../dist/research/CurrentChallengerRelease');
const { challengerAllowedMarkets, challengerMarketAllowed, CHALLENGER_TEAM_MARKETS } = require('../dist/research/ChallengerMarketCoverage');
const { paperExecutionPolicy, fallbackChallengerState } = require('../dist/research/ResearchRecommendationPolicy');

test('current C coverage uses code without scientific registry labels or implicit unsupported markets', () => {
  for (const registry of [[], [{ market: '1x2', state: 'SUSPENDED' }], [{ market: 'corners', state: 'ACTIVE' }]]) {
    assert.deepEqual(challengerAllowedMarkets(CURRENT_CHALLENGER_RELEASE, registry), [...CHALLENGER_TEAM_MARKETS]);
  }
  const policy = paperExecutionPolicy(fallbackChallengerState()).familyC;
  for (const market of CHALLENGER_TEAM_MARKETS) assert.equal(challengerMarketAllowed(policy, market), true);
  for (const market of ['corners', 'fouls', 'correct_score', 'player_shots', 'unknown']) {
    assert.equal(challengerMarketAllowed(policy, market, 'ACTIVE'), false, market);
  }
});

test('previous policies and deployments retain scientific registry compatibility', () => {
  const policy = paperExecutionPolicy(fallbackChallengerState()).familyC;
  const legacy = { ...policy };
  delete legacy.marketEligibilityVersion;
  assert.equal(challengerMarketAllowed(legacy, '1x2'), false);
  assert.equal(challengerMarketAllowed(legacy, '1x2', 'SUSPENDED'), false);
  assert.equal(challengerMarketAllowed(legacy, '1x2', 'EXPERIMENTAL'), true);
  for (const key of ['artifactHash', 'probabilityConfigurationHash', 'baselineVersion', 'modelVersion', 'selectorPolicy']) {
    assert.equal(challengerMarketAllowed({ ...policy, [key]: 'mismatched' }, '1x2'), false, key);
  }
});
