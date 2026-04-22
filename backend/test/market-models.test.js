const test = require('node:test');
const assert = require('node:assert/strict');
const { SpecializedModels } = require('../dist/models/markets/SpecializedModels.js');
const { CardsModel, FoulsModel } = require('../dist/models/markets/CardsModel.js');
const { ShotsModel } = require('../dist/models/markets/ShotsModel.js');

test('SpecializedModels keeps shots, cards and fouls distributions coherent', () => {
  const models = new SpecializedModels();

  const shots = models.computeShotsDistribution({
    homeTeamAvgShots: 14.5,
    awayTeamAvgShots: 11.2,
    homeTeamAvgShotsOT: 5.4,
    awayTeamAvgShotsOT: 4.0,
    homeTeamShotsSuppression: 0.95,
    awayTeamShotsSuppression: 1.08,
    homeAdvantageShots: 1.07,
    homeTeamVarShots: 21.1,
    awayTeamVarShots: 17.3,
    homeTeamVarShotsOT: 6.2,
    awayTeamVarShotsOT: 4.9,
    homeTeamSampleSize: 24,
    awayTeamSampleSize: 24,
  });

  const homeDistSum = Object.values(shots.home.totalShots.distribution).reduce((sum, value) => sum + value, 0);
  assert.ok(shots.combined.totalShots.expected > 0);
  assert.ok(Math.abs(homeDistSum - 1) < 1e-4);
  assert.ok(shots.combined.overUnder.over155 >= shots.combined.overUnder.over315);
  assert.ok(shots.combined.onTargetOverUnder.over45 >= shots.combined.onTargetOverUnder.over125);

  const cards = models.computeCardsDistribution({
    homeTeamAvgYellow: 2.0,
    awayTeamAvgYellow: 2.4,
    homeTeamAvgRed: 0.08,
    awayTeamAvgRed: 0.12,
    refereeAvgYellow: 4.9,
    refereeAvgRed: 0.22,
    refereeAvgTotal: 5.34,
    leagueAvgYellow: 4.2,
    competitiveness: 0.78,
    homeTeamSampleSize: 20,
    awayTeamSampleSize: 20,
    refereeSampleSize: 16,
    homeTeamVarYellow: 3.2,
    awayTeamVarYellow: 3.6,
    refereeAvgFouls: 24.8,
    leagueAvgFouls: 22.6,
  });

  assert.ok(cards.expectedTotalYellow > 0);
  assert.ok(cards.overUnderYellow['2.5'].over >= cards.overUnderYellow['5.5'].over);
  assert.ok(cards.overUnderTotal['3.5'].over >= cards.overUnderTotal['7.5'].over);

  const fouls = models.computeFoulsDistribution({
    homeTeamAvgFouls: 12.7,
    awayTeamAvgFouls: 13.4,
    homePossessionEst: 0.56,
    refereeAvgFouls: 24.2,
    leagueAvgFouls: 22.8,
    homeTeamVarFouls: 20.1,
    awayTeamVarFouls: 21.7,
    homeTeamSampleSize: 22,
    awayTeamSampleSize: 22,
  });

  assert.ok(fouls.expectedTotalFouls > 0);
  assert.ok(fouls.overUnder['17.5'].over >= fouls.overUnder['29.5'].over);
});

test('CardsModel and FoulsModel preserve standalone market-model invariants', () => {
  const cardsModel = new CardsModel();
  const foulsModel = new FoulsModel();

  const homeProfile = cardsModel.estimateTeamProfile(
    'HOME',
    [{ yellowCards: 2 }, { yellowCards: 3 }, { yellowCards: 2 }, { yellowCards: 4 }],
    [{ yellowCards: 1 }, { yellowCards: 2 }, { yellowCards: 2 }]
  );
  const awayProfile = cardsModel.estimateTeamProfile(
    'AWAY',
    [{ yellowCards: 1 }, { yellowCards: 2 }, { yellowCards: 1 }],
    [{ yellowCards: 2 }, { yellowCards: 3 }, { yellowCards: 2 }, { yellowCards: 4 }]
  );

  const cardsPrediction = cardsModel.predictCards(homeProfile, awayProfile, {
    name: 'Ref',
    avgYellowPerGame: 4.6,
    avgRedPerGame: 0.2,
    avgFoulsPerGame: 24.1,
    stdYellow: 1.1,
    totalGames: 24,
    yellowRateHighStakes: 5.1,
    yellowRateDerby: 5.4,
  }, {
    isDerby: true,
    isHighStakes: true,
  });

  assert.ok(cardsPrediction.totalYellow.expected > 0);
  assert.ok(cardsPrediction.overUnder.over25 >= cardsPrediction.overUnder.over55);
  assert.ok(cardsPrediction.confidenceLevel > 0);

  const foulsPrediction = foulsModel.predictFouls(12.9, 13.7, 19.8, 22.4, 24.3, 22.5, 0.57);
  assert.ok(foulsPrediction.totalFouls.expected > 0);
  assert.ok(foulsPrediction.overUnder.over175 >= foulsPrediction.overUnder.over295);
});

test('ShotsModel preserves ZIP fitting and player/team shot monotonicity', () => {
  const shotsModel = new ShotsModel();

  const fit = shotsModel.fitZIPParameters([0, 0, 1, 2, 0, 3, 1, 0, 2, 1]);
  assert.ok(fit.pi >= 0 && fit.pi <= 1);
  assert.ok(fit.lambda > 0);

  const teamPrediction = shotsModel.predictTeamShots(
    {
      teamId: 'HOME',
      avgShotsHome: 15.1,
      avgShotsAway: 12.4,
      avgShotsOnTargetHome: 5.8,
      avgShotsOnTargetAway: 4.4,
      varianceShotsHome: 22.4,
      varianceShotsAway: 18.2,
      avgPossessionHome: 55,
      avgPossessionAway: 51,
      onTargetRateHome: 0.38,
      onTargetRateAway: 0.34,
    },
    {
      teamId: 'AWAY',
      avgShotsHome: 13.2,
      avgShotsAway: 10.8,
      avgShotsOnTargetHome: 4.9,
      avgShotsOnTargetAway: 3.8,
      varianceShotsHome: 18.1,
      varianceShotsAway: 16.5,
      avgPossessionHome: 52,
      avgPossessionAway: 47,
      onTargetRateHome: 0.36,
      onTargetRateAway: 0.33,
    },
    1.06,
    0.96,
    1.0,
    1.03
  );

  assert.ok(teamPrediction.combined.totalShots.expected > 0);
  assert.ok(teamPrediction.combined.overUnder.over195 >= teamPrediction.combined.overUnder.over285);

  const playerPrediction = shotsModel.predictPlayerShots({
    playerId: 'p1',
    playerName: 'Forward',
    teamId: 'HOME',
    position: 'FWD',
    zipPi: 0.28,
    zipLambda: 2.9,
    onTargetPi: 0.44,
    onTargetLambda: 1.15,
    avgMinutesPlayed: 82,
    homeMultiplier: 1.12,
    avgShotsVsTopDefence: 2.1,
    avgShotsVsWeakDefence: 3.4,
    sampleSize: 18,
    lastUpdated: new Date('2026-01-10T00:00:00.000Z'),
  }, true, 0.94, true, 86, 0.12);

  assert.ok(playerPrediction.expectedShots > 0);
  assert.ok(playerPrediction.markets.over05shots >= playerPrediction.markets.over25shots);
  assert.ok(playerPrediction.markets.zeroShots >= 0 && playerPrediction.markets.zeroShots <= 1);
});
