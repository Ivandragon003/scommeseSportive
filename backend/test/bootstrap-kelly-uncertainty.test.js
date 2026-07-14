const test = require('node:test');
const assert = require('node:assert/strict');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine.js');
const { predictionEngineConfig } = require('../dist/config/PredictionEngineConfig.js');

const probabilities = { homeWin: 0.62 };
const oddsRecord = { homeWin: 2.05, draw: 3.4, awayWin: 3.9 };
const baseContext = {
  enableMarketBlending: false,
  richnessScore: 0.8,
  teamSampleSize: { home: 22, away: 22 },
};

test('modelUncertainty alza uncertaintyFactor e non aumenta mai lo stake', () => {
  const engine = new ValueBettingEngine();
  const groups = engine.buildMarketGroups(oddsRecord);

  const stable = engine.analyzeMarketsWithVigRemoval(probabilities, groups, {}, { ...baseContext, modelUncertainty: 0 });
  const unstable = engine.analyzeMarketsWithVigRemoval(probabilities, groups, {}, { ...baseContext, modelUncertainty: 0.9 });

  assert.ok(stable.length >= 1, 'scenario stabile deve produrre una opportunita');
  assert.ok(unstable.length >= 1, 'scenario incerto deve produrre una opportunita');
  assert.ok(
    unstable[0].uncertaintyFactor > stable[0].uncertaintyFactor,
    `uncertainty deve crescere: ${stable[0].uncertaintyFactor} -> ${unstable[0].uncertaintyFactor}`
  );
  assert.ok(
    unstable[0].suggestedStakePercent <= stable[0].suggestedStakePercent,
    `stake non deve crescere con incertezza: ${stable[0].suggestedStakePercent} -> ${unstable[0].suggestedStakePercent}`
  );
});

test('senza modelUncertainty il comportamento resta identico a modelUncertainty=0', () => {
  const engine = new ValueBettingEngine();
  const groups = engine.buildMarketGroups(oddsRecord);

  const absent = engine.analyzeMarketsWithVigRemoval(probabilities, groups, {}, { ...baseContext });
  const zero = engine.analyzeMarketsWithVigRemoval(probabilities, groups, {}, { ...baseContext, modelUncertainty: 0 });

  assert.ok(absent.length >= 1 && zero.length >= 1);
  assert.equal(absent[0].uncertaintyFactor, zero[0].uncertaintyFactor);
  assert.equal(absent[0].suggestedStakePercent, zero[0].suggestedStakePercent);
});

test('kellyMode quarter (default): la frazione ignora l\'incertezza', () => {
  const engine = new ValueBettingEngine();
  const withUncertainty = engine.kellyFraction(0.50, 2.1, 0.9);
  const withoutUncertainty = engine.kellyFraction(0.50, 2.1);
  assert.equal(withUncertainty, withoutUncertainty);
});

test('kellyMode dynamic: frazione alta con parametri stabili, bassa con incertezza', () => {
  const originalMode = predictionEngineConfig.valueBetting.kellyMode;
  predictionEngineConfig.valueBetting.kellyMode = 'dynamic';
  try {
    const engine = new ValueBettingEngine();
    // fullKelly(0.50, 2.1) = (1.1*0.5 - 0.5)/1.1 = 0.04545
    const certain = engine.kellyFraction(0.50, 2.1, 0);     // frazione 0.50 -> 0.0227
    const uncertain = engine.kellyFraction(0.50, 2.1, 1);   // frazione 0.10 -> 0.0045
    const legacy = engine.kellyFraction(0.50, 2.1);         // senza incertezza -> quarter 0.0114

    assert.ok(certain > legacy, `certo ${certain} > quarter ${legacy}`);
    assert.ok(legacy > uncertain, `quarter ${legacy} > incerto ${uncertain}`);
    assert.ok(Math.abs(certain - 0.04545 * 0.50) < 1e-4);
    assert.ok(Math.abs(uncertain - 0.04545 * 0.10) < 1e-4);
  } finally {
    predictionEngineConfig.valueBetting.kellyMode = originalMode;
  }
});

test('config bootstrapUncertainty presente con default sicuri', () => {
  assert.equal(predictionEngineConfig.valueBetting.bootstrapUncertainty.enableBootstrapUncertainty, true);
  assert.ok(predictionEngineConfig.valueBetting.bootstrapUncertainty.uncertaintyWeight > 0);
  assert.ok(predictionEngineConfig.valueBetting.bootstrapUncertainty.uncertaintyWeight <= 1);
});
