const test = require('node:test');
const assert = require('node:assert/strict');
const { PredictionService } = require('../dist/services/PredictionService');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
const { formatPrediction } = require('../dist/api/predictionPayloadFormatter');
const fixture = require('./fixtures/format-prediction.input');
const service = Object.create(PredictionService.prototype);
const side = { avgShots: 0, avgShotsOT: 0, avgYellowCards: 2, avgRedCards: 0,
  avgFouls: 11, shotsSuppression: 1, sampleSize: 20, sampleSizeShots: 20,
  sampleSizeShotsOT: 20, sampleSizeYellow: 20, sampleSizeRed: 20 };

test('SOT requires samples for both total shots and shots on target in flat and structured API', () => {
  for (const changedSide of ['homeTeamStats', 'awayTeamStats']) {
    const supp = { homeTeamStats: { ...side }, awayTeamStats: { ...side } };
    supp[changedSide].sampleSizeShots = 0;
    const probs = new DixonColesModel().computeFullProbabilities('A', 'B', 1, 1, supp);
    assert.ok(Number.isFinite(probs.flatProbabilities.shotsOTUnder55));
    const goalBefore = probs.flatProbabilities.over25;
    service.applyStatMarketAvailability(probs, supp);
    assert.equal(probs.flatProbabilities.shotsOTUnder55, undefined);
    assert.equal(probs.flatProbabilities.over25, goalBefore);
    assert.deepEqual(probs.shotsOnTargetHome.distribution, {});
    assert.deepEqual(probs.shotsOnTargetAway.distribution, {});
    const formatted = formatPrediction({ ...structuredClone(fixture), probabilities: probs });
    assert.deepEqual(formatted.shotsPrediction.combined.onTargetOverUnder, {});
    assert.equal(formatted.shotsPrediction.home.shotsOnTarget.available, false);
    assert.equal(formatted.shotsPrediction.away.shotsOnTarget.available, false);
  }
});

test('real zero means with sufficient coverage preserve complete model output', () => {
  const supp = { homeTeamStats: { ...side }, awayTeamStats: { ...side } };
  const probs = new DixonColesModel().computeFullProbabilities('A', 'B', 1, 1, supp);
  const before = JSON.stringify(probs);
  service.applyStatMarketAvailability(probs, supp);
  assert.equal(JSON.stringify(probs), before);
  assert.ok(Number.isFinite(probs.flatProbabilities.shotsOTUnder55));
});

test('legacy profiles without field metadata retain the existing generic sample fallback', () => {
  const legacy = { homeTeamStats: { sampleSize: 20 }, awayTeamStats: { sampleSize: 20 } };
  const flat = { shotsOTUnder55: .4 };
  assert.deepEqual(service.dropInsufficientStatMarkets(flat, true, legacy), flat);
});
