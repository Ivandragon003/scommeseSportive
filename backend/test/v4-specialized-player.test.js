const test = require('node:test');
const assert = require('node:assert/strict');
const { SpecializedModels } = require('../dist/models/markets/SpecializedModels.js');
const { ShotsModel } = require('../dist/models/markets/ShotsModel.js');
const { PlayerCardsModel } = require('../dist/models/markets/PlayerCardsModel.js');

test('SpecializedModels selects count distribution by dispersion and shrinks r for small samples', () => {
  const models = new SpecializedModels();

  assert.equal(models.selectCountDistribution(10, 18, 0.5).distributionType, 'negative_binomial');
  assert.equal(models.selectCountDistribution(10, 10.2, 0.5).distributionType, 'poisson');
  const under = models.selectCountDistribution(10, 7.5, 0.5);
  assert.equal(under.distributionType, 'underdispersed_poisson_fallback');
  assert.ok(under.warning);

  const shrunk = models.estimateDispersionWithShrinkage({
    mu: 10,
    variance: 30,
    sampleSize: 3,
    leagueDispersion: 20,
    maxR: 40,
    minSampleForTeamDispersion: 12,
  });
  assert.ok(shrunk > 5 && shrunk < 20, `expected shrinkage toward league r, got ${shrunk}`);
});

test('team count market returns distribution metadata without crashing on underdispersion', () => {
  const models = new SpecializedModels();
  const prediction = models.predictTeamCountMarket({
    market: 'yellow_cards',
    mean: 3.2,
    variance: 2.1,
    sampleSize: 10,
    leagueMean: 3.8,
    leagueDispersion: 18,
    lines: [2.5, 4.5],
  });

  assert.equal(prediction.distributionType, 'underdispersed_poisson_fallback');
  assert.equal(prediction.overUnder['2.5'].over + prediction.overUnder['2.5'].under, 1);
  assert.ok(prediction.confidence > 0 && prediction.confidence <= 1);
  assert.ok(prediction.dataRichness > 0 && prediction.dataRichness <= 1);
});

test('ShotsModel keeps ZIP default and can use ZINB plus team influence for player shots', () => {
  const shotsModel = new ShotsModel();
  const profile = {
    playerId: 'p1',
    playerName: 'Forward',
    teamId: 'T1',
    position: 'FWD',
    zipPi: 0.25,
    zipLambda: 2.4,
    onTargetPi: 0.45,
    onTargetLambda: 0.9,
    avgMinutesPlayed: 80,
    homeMultiplier: 1.05,
    avgShotsVsTopDefence: 1.8,
    avgShotsVsWeakDefence: 3.1,
    sampleSize: 30,
    lastUpdated: new Date('2026-01-01T00:00:00Z'),
  };

  const fitZinb = shotsModel.fitZINBParameters([0, 0, 1, 0, 2, 3, 0, 1, 2, 0, 4, 1]);
  assert.ok(fitZinb.pi >= 0 && fitZinb.pi <= 1);
  assert.ok(fitZinb.mu > 0);
  assert.ok(fitZinb.dispersion > 0);

  const zip = shotsModel.predictPlayerShots(profile, true, 1, true, 80, 0.15);
  const zinb = shotsModel.predictPlayerShots(profile, true, 1, true, 80, 0.15, {
    playerShotsDistribution: 'ZINB',
    dispersion: 4,
    teamShotsMean: 18,
    leagueAvgTeamShots: 12,
  });

  assert.equal(zip.modelUsed, 'ZIP');
  assert.equal(zinb.modelUsed, 'ZINB');
  assert.ok(zinb.expectedShots > zip.expectedShots);
  assert.notDeepEqual(zinb.shotDistribution, zinb.onTargetDistribution);
});

test('PlayerCardsModel separates player and team yellows with referee and team influence', () => {
  const model = new PlayerCardsModel();
  const prediction = model.predictPlayerYellowCards({
    playerId: 'p1',
    playerName: 'Defender',
    role: 'centreback',
    playerYellowCards: 5,
    playerMinutes: 450,
    expectedMinutes: 80,
    teamExpectedYellows: 5.2,
    leagueAvgTeamYellows: 2.1,
    refereeYellowAvg: 5.4,
    leagueAvgRefereeYellow: 3.8,
    refereeCoverage: 20,
  });

  assert.equal(prediction.modelUsed, 'ZIP');
  assert.ok(prediction.expectedPlayerYellows > 0);
  assert.ok(prediction.probabilityYellowOver0_5 > 0);
  assert.ok(prediction.probabilityYellowOver0_5 <= 1);
  assert.ok(prediction.fullDistribution[0] >= 0);
  assert.ok(prediction.fullDistribution[1] >= 0);
  assert.ok(prediction.confidence > 0 && prediction.confidence <= 1);
});

