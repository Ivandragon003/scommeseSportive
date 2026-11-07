const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
const { PoissonXgModel } = require('../dist/models/core/PoissonXgModel');
const { prepareSharedForecast, finishSharedForecast } = require('../dist/services/SharedForecastCalculator');

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const params = () => ({ rho: -0.13, attackParams: { h: Math.log(1.4), a: Math.log(0.9) },
  defenceParams: { h: 0, a: 0 }, homeAdvantage: 0, homeAdvantagePerTeam: {},
  levelCorrection: { home: 1.1, away: 0.8 } });
const partner = () => new PoissonXgModel({ leagueXG: 1.2, homeAdv: 1.1, levelScale: 1,
  attackRate: { h: 1.1, a: 0.9 }, defRate: { h: 1, a: 1 } });
const config = { enabled: true, weights: { default: 0.4, oneXTwo: 0.2, overUnder: 0.7, btts: 0.9 } };

// Independent oracle for the normalized truncated score distribution used by the legacy proxy.
function scoreMatrix(home, away, rho = 0) {
  const pmf = (lambda) => Array.from({ length: 11 }, (_, k) => {
    let value = Math.exp(-lambda);
    for (let i = 1; i <= k; i++) value *= lambda / i;
    return value;
  });
  const h = pmf(home), a = pmf(away);
  const matrix = h.map((x, i) => a.map((y, j) => {
    const tau = i === 0 && j === 0 ? 1 - home * away * rho
      : i === 1 && j === 0 ? 1 + away * rho
        : i === 0 && j === 1 ? 1 + home * rho
          : i === 1 && j === 1 ? 1 - rho : 1;
    return Math.max(0, x * y * tau);
  }));
  const mass = matrix.flat().reduce((sum, value) => sum + value, 0);
  return matrix.map((row) => row.map((value) => value / mass));
}
function compareMatrix(actual, expected) {
  assert.equal(actual.length, 11);
  actual.forEach((row, i) => { assert.equal(row.length, 11); row.forEach((p, j) => close(p, expected[i][j])); });
}

test('raw DC and family-weighted blend preserve context, level correction and inputs', () => {
  const model = new DixonColesModel(params()), poisson = partner();
  const supplementary = { contextAdjustments: { homeGoalMultiplier: 1.2, awayGoalMultiplier: 0.75 } };
  const snapshot = structuredClone({ params: model.getParams(), poisson: poisson.getParams(), supplementary, config });
  const expectedRaw = model.computeFullProbabilities('h', 'a', 2, 1, supplementary);
  const prepared = prepareSharedForecast(model, 'h', 'a', 2, 1, supplementary);
  assert.deepEqual(prepared.full, expectedRaw);
  compareMatrix(prepared.matrix.probabilities, scoreMatrix(prepared.full.lambdaHome, prepared.full.lambdaAway, -0.13));
  close(prepared.full.lambdaHome, (0.6 * 1.4 + 0.4 * 2) * 1.1 * 1.2);
  close(prepared.full.lambdaAway, (0.6 * 0.9 + 0.4 * 1) * 0.8 * 0.75);
  const result = finishSharedForecast(prepared, poisson, config, true);
  const p = poisson.computeGoalProbabilities('h', 'a');
  for (const [key, weight] of [['homeWin', 0.2], ['draw', 0.2], ['awayWin', 0.2],
    ['over25', 0.7], ['under25', 0.7], ['btts', 0.9], ['bttsNo', 0.9]]) {
    close(result.flatProbabilities[key], (1 - weight) * expectedRaw.flatProbabilities[key] + weight * p[key]);
  }
  assert.ok(Number.isFinite(expectedRaw.flatProbabilities.shotsHomeOver85));
  assert.equal(result.flatProbabilities.shotsHomeOver85, expectedRaw.flatProbabilities.shotsHomeOver85);
  const dc = scoreMatrix(prepared.full.lambdaHome, prepared.full.lambdaAway, -0.13);
  const lambdas = poisson.expectedGoals('h', 'a'), independent = scoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway);
  compareMatrix(result.jointProxy, dc.map((row, i) => row.map((v, j) => 0.6 * v + 0.4 * independent[i][j])));
  assert.deepEqual({ params: model.getParams(), poisson: poisson.getParams(), supplementary, config }, snapshot);
});

test('disabled, absent and unfit partners preserve DC; weights and lambdas clamp', () => {
  const model = new DixonColesModel(params());
  const prepared = prepareSharedForecast(model, 'h', 'a', 0, 0,
    { contextAdjustments: { homeGoalMultiplier: 100, awayGoalMultiplier: 0 } });
  close(prepared.full.lambdaHome, 6); close(prepared.full.lambdaAway, 0.05);
  for (const [candidate, setting] of [[partner(), { ...config, enabled: false }],
    [null, config], [new PoissonXgModel(), config]]) {
    const result = finishSharedForecast(prepared, candidate, setting, true);
    assert.deepEqual(result.flatProbabilities, prepared.full.flatProbabilities);
    compareMatrix(result.jointProxy, scoreMatrix(6, 0.05, -0.13));
  }
  const p = partner(), clamped = finishSharedForecast(prepared, p,
    { enabled: true, weights: { default: 5, oneXTwo: -1, overUnder: 2 } }, true);
  close(clamped.flatProbabilities.homeWin, prepared.full.flatProbabilities.homeWin);
  close(clamped.flatProbabilities.over25, p.computeGoalProbabilities('h', 'a').over25);
  const lambdas = p.expectedGoals('h', 'a');
  compareMatrix(clamped.jointProxy, scoreMatrix(lambdas.lambdaHome, lambdas.lambdaAway));
});


test('joint matrix retains the supplied dependence model and contextual adjustment', () => {
  const model = new DixonColesModel(params(), { scoreDependenceModel: { correction: () => 1 } });
  const prepared = prepareSharedForecast(model, 'h', 'a', undefined, undefined,
    { contextAdjustments: { homeGoalMultiplier: 0.8, awayGoalMultiplier: 1.25 } });
  const expected = scoreMatrix(prepared.full.lambdaHome, prepared.full.lambdaAway);
  compareMatrix(prepared.matrix.probabilities, expected);
  compareMatrix(finishSharedForecast(prepared, null, config, true).jointProxy, expected);
});

test('preparation happens before asynchronous partner loading and finish does not recompute DC', async () => {
  const events = [], model = new DixonColesModel(params());
  const original = model.computeFullProbabilitiesWithMatrix.bind(model);
  model.computeFullProbabilitiesWithMatrix = (...args) => { events.push('dc'); return original(...args); };
  const prepared = prepareSharedForecast(model, 'h', 'a');
  const loadPartner = async () => { events.push('load'); await Promise.resolve(); events.push('loaded'); return partner(); };
  const result = finishSharedForecast(prepared, await loadPartner(), config);
  assert.deepEqual(events, ['dc', 'load', 'loaded']);
  assert.equal(result.full, prepared.full);
  assert.equal(result.jointProxy, undefined);
});

test('operational, backtest and research callers use the shared stages and hash their dependency', () => {
  for (const file of ['services/PredictionService.ts', 'models/backtesting/BacktestingEngine.ts', 'research/ForecastCore.ts']) {
    const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
    assert.match(source, /import \{ prepareSharedForecast, finishSharedForecast \} from ['"].*SharedForecastCalculator['"]/);
    assert.match(source, /prepareSharedForecast\(/);
    assert.match(source, /finishSharedForecast\(/);
  }
  const { baselineManifest } = require('../dist/research/ForecastCore');
  assert.ok(Object.keys(baselineManifest().codeHashes).some((key) => key.includes('services/SharedForecastCalculator')));
});


test('Poisson shared score grid validates size and agrees with goal marginals', () => {
  const p = partner(), before = structuredClone(p.getParams());
  assert.equal(new PoissonXgModel().computeScoreMatrix('h', 'a'), null);
  assert.deepEqual(p.computeScoreMatrix('h', 'a', 0), [[1]]);
  for (const size of [-1, 1.5, NaN, Infinity]) {
    assert.throws(() => p.computeScoreMatrix('h', 'a', size), /invalid_max_goals/);
  }
  const matrix = p.computeScoreMatrix('h', 'a', 10), goal = p.computeGoalProbabilities('h', 'a');
  close(matrix.flat().reduce((sum, value) => sum + value, 0), 1);
  const total = (predicate) => matrix.reduce((sum, row, h) => sum + row.reduce(
    (inner, value, a) => inner + (predicate(h, a) ? value : 0), 0), 0);
  close(goal.homeWin, total((h, a) => h > a));
  close(goal.draw, total((h, a) => h === a));
  close(goal.awayWin, total((h, a) => h < a));
  close(goal.btts, total((h, a) => h > 0 && a > 0));
  close(goal.bttsNo, total((h, a) => h === 0 || a === 0));
  for (let i = 0; i <= 4; i++) {
    const suffix = `${i}5`;
    close(goal[`over${suffix}`], total((h, a) => h + a > i + 0.5));
    close(goal[`under${suffix}`], total((h, a) => h + a < i + 0.5));
  }
  assert.deepEqual(p.getParams(), before);
});
