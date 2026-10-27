const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const dist = process.env.RESEARCH_COHERENT_TEST_DIST || join(__dirname, '../dist');
const { applyCoherentProbabilityPipeline, fitCoherentCalibration, coherentProbabilityPipelineHash,
  COHERENT_PROBABILITY_PROTOCOL, COHERENT_CALIBRATION_TARGET } = require(join(dist, 'research/CoherentProbabilityPipeline'));
const { scoreMatrixMarkets, evaluateGoalQuote } = require(join(dist, 'research/GoalSettlement'));
const { ValueBettingEngine } = require(join(dist, 'models/value/ValueBettingEngine'));

// These are deliberate probability/price fixtures, never football-quality evidence.
const AT = '2026-01-15T19:30:00Z';
const PAST = '2026-01-01T12:00:00Z';
const matrix = () => [[.08, .07, .02], [.15, .18, .08], [.12, .15, .15]];
const profile = () => ({ protocol: 'existing-isotonic-v1', fittedThrough: PAST, matches: 1000,
  nObservations: 3000, calibrationPoints: [{ x: 0, y: 0 }, { x: .25, y: .1 }, { x: .6, y: .8 }, { x: 1, y: 1 }],
  byFamily: {}, learnedBlendWeights: {}, targetProtocol: COHERENT_CALIBRATION_TARGET });
const run = (changes = {}) => applyCoherentProbabilityPipeline({ matrix: matrix(), forecastAt: AT, quotes: [], ...changes });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
function coherent(result) {
  close(result.matrix.flat().reduce((sum, value) => sum + value, 0), 1);
  for (const value of Object.values(result.decision)) assert.ok(Number.isFinite(value) && value >= 0 && value <= 1);
  const p = result.decision;
  close(p.homeWin + p.draw + p.awayWin, 1);
  close(p.double_chance_1x, p.homeWin + p.draw);
  close(p.double_chance_x2, p.awayWin + p.draw);
  close(p.double_chance_12, p.awayWin + p.homeWin);
  close(p.dnb_home + p.dnb_away, 1);
  close(p.dnb_home, p.homeWin / (p.homeWin + p.awayWin));
  close(p.btts + p.bttsNo, 1);
  for (const line of ['05', '15', '25', '35', '45']) close(p[`over${line}`] + p[`under${line}`], 1);
  for (const side of ['home', 'away']) for (const line of [.5, 1.5, 2.5, 3.5, 4.5]) {
    close(p[`team_${side}_over_${line}`] + p[`team_${side}_under_${line}`], 1);
    assert.ok(p[`team_${side}_over_${line}`] <= p[`over${String(line).replace('.', '')}`] + 1e-10);
  }
  for (const [key, value] of Object.entries(scoreMatrixMarkets(result.matrix))) close(p[key], value);
}
function sheet(bookmaker = 'Fixture bookmaker', changes = {}) {
  return ['homeWin', 'draw', 'awayWin'].map((selection, index) => ({
    selection, market: '1x2', side: ['home', 'draw', 'away'][index], odds: [2, 3.6, 4][index],
    bookmaker, source: 'odds_api', capturedAt: AT, updatedAt: AT, ...changes,
  }));
}

test('joint isotonic repair keeps every derived probability consistent while preserving raw evidence and inputs', () => {
  const raw = { homeWin: .6, draw: .3, awayWin: .2, btts: .8, bttsNo: .4 };
  const inputMatrix = matrix(), calibration = profile();
  const before = JSON.stringify({ inputMatrix, calibration, raw });
  const output = run({ matrix: inputMatrix, rawProbabilities: raw, profile: calibration });
  assert.equal(output.protocol, COHERENT_PROBABILITY_PROTOCOL);
  assert.equal(output.profileTarget, COHERENT_CALIBRATION_TARGET);
  assert.deepEqual(output.raw, raw);
  assert.notEqual(output.calibrated.homeWin, scoreMatrixMarkets(inputMatrix).homeWin);
  assert.deepEqual(output.calibrated, output.decision);
  coherent(output);
  close(output.matrix[2][0] / output.matrix[1][0], inputMatrix[2][0] / inputMatrix[1][0]);
  assert.equal(JSON.stringify({ inputMatrix, calibration, raw }), before);
});

test('dedicated calibrator fits exactly three normalized one-hot outcomes per eligible match', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ matchId: `calibration-${index}`, availableAt: PAST,
    probabilities: { homeWin: .4 + index % 3 / 10, draw: .3, awayWin: .2,
      double_chance_1x: .9, dnb_home: .9, btts: .9 },
    outcomes: { homeWin: Number(index % 3 === 0), draw: Number(index % 3 === 1), awayWin: Number(index % 3 === 2),
      double_chance_1x: 1, dnb_home: 1, btts: 1 } }));
  const output = fitCoherentCalibration(rows, AT);
  assert.equal(output.targetProtocol, COHERENT_CALIBRATION_TARGET);
  assert.equal(output.matches, 200);
  assert.equal(output.nObservations, 600);
  const p = [], y = [];
  for (const row of rows) {
    const sum = row.probabilities.homeWin + row.probabilities.draw + row.probabilities.awayWin;
    for (const key of ['homeWin', 'draw', 'awayWin']) { p.push(row.probabilities[key] / sum); y.push(row.outcomes[key]); }
  }
  assert.deepEqual(output.calibrationPoints, new ValueBettingEngine().fitIsotonicCalibration(p, y).calibrationPoints);
  const future = { ...rows[0], matchId: 'future', availableAt: '2026-01-16T00:00:00Z', outcomes: { impossible: 1 } };
  assert.deepEqual(fitCoherentCalibration([...rows, future], AT), output);
  assert.throws(() => fitCoherentCalibration([{ ...rows[0], outcomes: { homeWin: 1, draw: 1, awayWin: 0 } }], AT), /onehot/);
});

test('identity and temperature modes keep zero cells and produce coherent goal and quoted handicap marginals', () => {
  const quote = { selection: 'ahcp_home_-0.25', market: 'asian_handicap', side: 'home', line: -.25,
    odds: 1.9, bookmaker: 'Fixture bookmaker', source: 'odds_api', capturedAt: AT, updatedAt: AT };
  const identity = run({ mode: 'identity', quotes: [quote], context: { enableMarketBlending: false } });
  coherent(identity);
  close(identity.decision[quote.selection], evaluateGoalQuote(identity.matrix, quote).probability);
  const output = run({ mode: 'temperature', temperature: .8, quotes: [quote] });
  coherent(output);
  assert.notDeepEqual(output.matrix, identity.matrix);
  close(output.decision[quote.selection], evaluateGoalQuote(output.matrix, quote).probability);
  const sparse = run({ mode: 'temperature', temperature: 2, matrix: [[.5, 0], [.25, .25]] });
  assert.equal(sparse.matrix[0][1], 0);
});

test('market blending uses one complete real operator sheet and reprojects the entire joint distribution', () => {
  const quotes = [...sheet('Fixture international'), ...sheet('Eurobet', { odds: 3 })];
  const output = run({ profile: profile(), quotes });
  assert.equal(output.bookmaker.bookmaker, 'Eurobet');
  close(Object.values(output.bookmaker.probabilities).reduce((sum, p) => sum + p, 0), 1);
  assert.equal(output.marketBlendingApplied, true);
  assert.notDeepEqual(output.decision, output.calibrated);
  coherent(output);
  assert.deepEqual(run({ profile: profile(), quotes: [...quotes].reverse() }), output);
  const disabled = run({ profile: profile(), quotes, context: { enableMarketBlending: false } });
  assert.equal(disabled.marketBlendingApplied, false);
  assert.deepEqual(disabled.calibrated, disabled.decision);
});

test('different books, snapshot times, future or stale updates cannot be combined into a result sheet', () => {
  const split = sheet().map((quote, index) => ({ ...quote, bookmaker: `Book ${index}` }));
  const missing = run({ quotes: split });
  assert.equal(missing.bookmaker, null);
  assert.equal(missing.marketBlendingApplied, false);
  const splitTimes = sheet().map((quote, index) => ({ ...quote, capturedAt: `2026-01-15T19:2${index}:00Z`, updatedAt: `2026-01-15T19:2${index}:00Z` }));
  assert.equal(run({ quotes: splitTimes }).bookmaker, null);
  const future = run({ quotes: sheet('Eurobet', { updatedAt: '2026-01-15T19:31:00Z' }) });
  assert.equal(future.bookmaker, null);
  assert.equal(future.quoteExclusions.future_quote, 3);
  const fallback = run({ quotes: [...sheet('Eurobet', { priceType: 't15', updatedAt: '2026-01-15T19:20:00Z' }), ...sheet()] });
  assert.equal(fallback.bookmaker.bookmaker, 'Fixture bookmaker');
  assert.equal(fallback.quoteExclusions.stale_t15_quote, 3);
});

test('conflicting duplicate sheets and synthetic provenance are excluded without a made-up fallback', () => {
  const quotes = [...sheet('Eurobet'), { ...sheet('Eurobet')[0], odds: 2.5 }, ...sheet()];
  assert.equal(run({ quotes }).bookmaker.bookmaker, 'Fixture bookmaker');
  assert.equal(run({ quotes }).quoteExclusions.conflicting_result_sheet, 1);
  const synthetic = run({ quotes: sheet('Eurobet', { source: 'odds_api_plus_model_completion' }) });
  assert.equal(synthetic.bookmaker, null);
  assert.deepEqual(synthetic.decision, run().decision);
});

test('invalid matrices, unavailable calibrators and future profile weights fail explicitly', () => {
  assert.throws(() => run({ matrix: [[NaN]] }), /finite nonnegative/);
  assert.throws(() => run({ matrix: [[0]] }), /positive finite mass/);
  assert.throws(() => run({ rawProbabilities: { homeWin: 1.01 } }), /raw_probability/);
  assert.throws(() => run({ mode: 'isotonic_1x2' }), /calibration_profile/);
  assert.throws(() => run({ forecastAt: '2026-01-15T19:30:00' }), /forecast_time/);
  const future = { ...profile(), fittedThrough: '2026-01-16T00:00:00Z' };
  assert.throws(() => run({ profile: future }), /future_coherent/);
  assert.throws(() => run({ mode: 'identity', profile: future, quotes: sheet() }), /future_coherent/);
  assert.throws(() => run({ profile: { ...profile(), fittedThrough: null } }), /chronology/);
  assert.throws(() => run({ mode: 'temperature', temperature: 0 }), /temperature/);
  assert.throws(() => run({ mode: 'temperature', temperature: Infinity }), /temperature/);
  assert.throws(() => run({ mode: 'temperature' }), /temperature/);
  assert.throws(() => run({ matrix: [[1]], quotes: sheet() }), /partition_support/);
});

test('legacy curves cannot be rebound into v2 and implementation hashes are reproducible', () => {
  const legacy = profile(); delete legacy.targetProtocol;
  assert.throws(() => run({ profile: legacy }), /target_mismatch/);
  const hash = coherentProbabilityPipelineHash();
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(coherentProbabilityPipelineHash(), hash);
});

test('observation-only prices retain missing provider updates and are never relabelled T15', () => {
  const quotes = sheet('Observed fixture', { updatedAt: undefined, timestampEvidence: 'observed_snapshot', priceType: 'prematch' });
  const output = run({ quotes });
  assert.equal(output.bookmaker.bookmaker, 'Observed fixture');
  assert.equal(output.bookmaker.updatedAt, null);
  assert.equal(output.bookmaker.timestampEvidence, 'observed_snapshot');
  coherent(output);
  const delayed = run({ quotes, forecastAt: '2026-01-15T19:31:00Z' });
  assert.equal(delayed.bookmaker, null);
  assert.equal(delayed.quoteExclusions.observation_quote_requires_its_forecast_time, 3);
  const falseT15 = run({ quotes: quotes.map((quote) => ({ ...quote, priceType: 't15' })) });
  assert.equal(falseT15.bookmaker, null);
  assert.equal(falseT15.marketBlendingApplied, false);
  assert.equal(run({ quotes: sheet('Missing', { updatedAt: undefined }) }).bookmaker, null);
});
