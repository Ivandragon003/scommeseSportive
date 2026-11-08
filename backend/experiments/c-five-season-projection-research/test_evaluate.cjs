'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { modelInput, boundaries, partitionOf, validateProjection, pairedIntervals, compareRows, normalizedQuotes } = require('./evaluate.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { createHash } = require('node:crypto');
const limits = { trainBefore: '2021-03-01T00:00:00.000Z', reservedFrom: '2021-03-01T00:00:00.000Z', reservedTo: '2021-05-01T00:00:00.000Z',
  calibrationFrom: '2021-05-01T00:00:00.000Z', calibrationTo: '2021-07-01T00:00:00.000Z', testFrom: '2021-07-01T00:00:00.000Z', testTo: '2022-07-01T00:00:00.000Z' };
test('chronology uses only frozen boundaries and purges unavailable fit/calibration labels', () => {
  assert.deepEqual(boundaries(2021, limits), limits); assert.throws(() => boundaries(2021));
  const row = (forecastAt, availableAt) => ({ forecastAt, availableAt });
  assert.equal(partitionOf(row('2021-02-28T03:07:00Z', '2021-02-28T22:00:00Z'), 2021, limits), 'train');
  assert.equal(partitionOf(row('2021-02-28T03:07:00Z', '2021-03-01T00:00:00Z'), 2021, limits), null);
  assert.equal(partitionOf(row('2021-03-15T03:07:00Z', '2021-03-15T22:00:00Z'), 2021, limits), 'reserved');
  assert.equal(partitionOf(row('2021-05-01T03:07:00Z', '2021-05-01T22:00:00Z'), 2021, limits), 'calibration');
  assert.equal(partitionOf(row('2021-06-30T03:07:00Z', '2021-07-01T00:00:00Z'), 2021, limits), null);
  assert.equal(partitionOf(row('2021-07-01T03:07:00Z', '2021-07-01T22:00:00Z'), 2021, limits), 'test');
});
function artifacts() {
  const names = Array.from({ length: 40 }, (_, i) => `feature${i}`); names[1] = 'home_sample'; names[17] = 'away_sample';
  const model = { features_info: { float_features: [{ feature_index: 0, flat_feature_index: 0 }, { feature_index: 1, flat_feature_index: 1 }] }, scale_and_bias: [1, [0]],
    oblivious_trees: Array.from({ length: 120 }, () => ({ splits: [{ split_type: 'FloatFeature', float_feature_index: 1, border: 10 }, { split_type: 'FloatFeature', float_feature_index: 0, border: 1 }], leaf_weights: [1, 3, 2, 2], leaf_values: [1, 3, 5, 7] })) };
  const original = { models: { home: structuredClone(model), away: structuredClone(model) } }, projected = structuredClone(original);
  for (const side of ['home', 'away']) for (const tree of projected.models[side].oblivious_trees) tree.leaf_values = [2.5, 2.5, 6, 6];
  return { original, projected, names };
}
test('projection is the original-support mean and changes only its intended leaves', () => {
  const { original, projected, names } = artifacts(); validateProjection(original, projected, names);
  const invalid = structuredClone(projected); invalid.models.home.oblivious_trees[0].leaf_values[0] = 3;
  assert.throws(() => validateProjection(original, invalid, names));
  const badSplit = structuredClone(projected); badSplit.models.home.oblivious_trees[0].splits[0].border = 20;
  assert.throws(() => validateProjection(original, badSplit, names));
});
function rows() {
  return [0, 1, 2].map(i => { const forecasts = {};
    for (const [arm, p] of [['original', [.4, .3, .3]], ['projected', [.45, .3, .25]]]) {
      const value = { homeWin: p[0], draw: p[1], awayWin: p[2], over25: .5, under25: .5, btts: .6, bttsNo: .4 };
      forecasts[arm] = { raw: value, calibrated: value, decision: i === 0 ? value : null };
    }
    return { matchId: `toy${i}`, testSeason: i === 2 ? '2022/2023' : '2021/2022', kickoffAt: '2021-08-01T12:00:00Z', homeGoals: i + 1, awayGoals: 0, closingQuoteAvailable: i === 0, forecasts };
  });
}
test('raw/calibrated retain every row while decision uses only the paired real-quote subset', () => {
  const input = rows(), result = compareRows(input, { replications: 50, seed: 1 });
  assert.equal(result.raw.n, 3); assert.equal(result.calibrated.n, 3); assert.equal(result.decision.n, 1);
  assert.equal(result.decision.allTestRows, 3); assert.equal(input[1].forecasts.projected.decision, null);
  for (const row of input) { row.closingQuoteAvailable = false; row.forecasts.original.decision = null; row.forecasts.projected.decision = null; }
  assert.equal(compareRows(input, { replications: 50, seed: 1 }).decision.unavailable, true);
});
test('bootstrap keeps season-week blocks separate and is deterministic', () => {
  const input = rows(); const a = pairedIntervals(input, 'raw', { replications: 100, seed: 20261108 });
  assert.equal(a.blocks, 2); assert.deepEqual(a, pairedIntervals(input, 'raw', { replications: 100, seed: 20261108 }));
  assert.equal(a.independentEvidence, false);
});
test('quote evidence is real, complete, unique and never synthesized', () => {
  const quote = { matchId: 'toy', bookmaker: 'Bet365', source: 'football_data_csv', priceType: 'closing', prices: [2, 3, 4], archiveAcquiredAt: '2026-11-08T12:00:00Z', sourceFile: 'synthetic-only.csv', sourceSha256: '0'.repeat(64) };
  assert.equal(normalizedQuotes({ rows: [quote] }).size, 1);
  assert.throws(() => normalizedQuotes({ rows: [quote, quote] }));
  assert.throws(() => normalizedQuotes({ rows: [{ ...quote, source: 'model' }] }));
  assert.throws(() => normalizedQuotes({ rows: [{ ...quote, prices: [2, 3, 1] }] }));
});
test('complete five-fold evaluator runs on hand-constructed synthetic models without any fit', () => {
  const { main } = require('./evaluate.cjs'), directory = fs.mkdtempSync(path.join(os.tmpdir(), 'five-season-toy-'));
  assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const root = path.resolve(__dirname, '../../..'), hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
  const names = require('../../dist/research/ForecastCore').FEATURE_NAMES, sourceNames = require('../../dist/research/ChallengerFeatures').challengerFeatureNames();
  const leagues = ['Bundesliga', 'La Liga', 'Ligue 1', 'Premier League', 'Serie A'], rows = [];
  for (let year = 2019; year <= 2026; year++) for (const month of [2, 4, 5, 8]) {
    if (year === 2026 && month > 5) continue;
    for (const [index, competition] of leagues.entries()) {
      const date = `${year}-${String(month).padStart(2, '0')}-15`, season = month < 7 ? `${year - 1}/${year}` : `${year}/${year + 1}`;
      rows.push({ matchId: `synthetic_${year}_${month}_${index}`, competition, season, homeGoals: 1, awayGoals: 0,
        forecastAt: `${date}T03:07:00.000Z`, kickoffAt: `${date}T18:00:00.000Z`, availableAt: `${date}T20:00:00.000Z`,
        features: Array(56).fill(0), featureNames: sourceNames, baselineMatrix: Array.from({ length: 3 }, () => Array(3).fill(1 / 9)) });
    }
  }
  try {
    const dataset = { rows, featureNames: sourceNames, featureBlocks: ['recent_xg', 'schedule'], reproduction: { planHash: '1'.repeat(64) } };
    const datasetFile = path.join(directory, 'dataset.json'), quotesFile = path.join(directory, 'quotes.json'), planFile = path.join(directory, 'plan.json'), trained = path.join(directory, 'trained');
    fs.mkdirSync(trained); write(datasetFile, dataset); write(quotesFile, { rows: [] });
    const files = ['models/value/ValueBettingEngine', 'models/value/EnhancedMarketAnalysis', 'research/CatBoostModel', 'research/GoalSettlement', 'research/CoherentProbabilityPipeline', 'research/ResearchProbabilityPipeline', 'research/ForecastCore', 'config/PredictionEngineConfig'];
    const sourceHashes = Object.fromEntries(files.flatMap(file => [`backend/src/${file}.ts`, `backend/dist/${file}.js`]).map(file => [file, hash(path.join(root, file))]));
    sourceHashes[quotesFile] = hash(quotesFile);
    const folds = [2021, 2022, 2023, 2024, 2025].map(year => {
      const boundaries = { trainBefore: `${year}-03-01T00:00:00.000Z`, reservedFrom: `${year}-03-01T00:00:00.000Z`, reservedTo: `${year}-05-01T00:00:00.000Z`, calibrationFrom: `${year}-05-01T00:00:00.000Z`, calibrationTo: `${year}-07-01T00:00:00.000Z`, testFrom: `${year}-07-01T00:00:00.000Z`, testTo: `${year + 1}-07-01T00:00:00.000Z` };
      const memberships = Object.fromEntries(['train', 'reserved', 'calibration', 'test'].map(part => { const members = rows.filter(row => partitionOf(row, year, boundaries) === part);
        return [part, { n: members.length, matchIds: members.map(row => row.matchId), matchIdsHash: createHash('sha256').update(members.map(row => row.matchId).sort().join('\n')).digest('hex') }]; }));
      return { year, boundaries, memberships };
    });
    const plan = { protocol: 'c-five-season-projection-research-v1', phase: 'execution', datasetHash: hash(datasetFile), inputsPlanHash: '1'.repeat(64), sourceHashes, folds };
    write(planFile, plan); const planHash = hash(planFile), summaries = [];
    for (const fold of folds) {
      const folder = path.join(trained, `fold-${fold.year}`); fs.mkdirSync(folder);
      const model = { features_info: { float_features: [] }, scale_and_bias: [1, [0]], oblivious_trees: Array.from({ length: 120 }, () => ({ splits: [], leaf_values: [0], leaf_weights: [fold.memberships.train.n] })) };
      const artifact = { models: { home: model, away: model }, featureNames: names, weight: .75, temperature: .8, candidateKind: 'calibrated_ensemble',
        trainedThrough: `${fold.year}-02-15T20:00:00.000Z`, validationThrough: `${fold.year}-05-15T20:00:00.000Z`, datasetHash: hash(datasetFile) };
      write(path.join(folder, 'original.json'), artifact); write(path.join(folder, 'projected.json'), artifact);
      write(path.join(folder, 'membership.json'), { year: fold.year, boundaries: fold.boundaries, memberships: fold.memberships });
      const parityRows = [], predictions = [];
      for (const row of rows) { const partition = partitionOf(row, fold.year, fold.boundaries); if (!['train', 'calibration', 'test'].includes(partition)) continue;
        const raw = { original: { home: [0], away: [0] }, projected: { home: [0], away: [0] } }; parityRows.push({ matchId: row.matchId, partition, raw });
        if (partition !== 'train') predictions.push({ ...row, partition, raw });
      }
      write(path.join(folder, 'parity.json'), { rows: parityRows }); write(path.join(folder, 'predictions.json'), { year: fold.year, featureNames: names, rows: predictions });
      const fileHashes = Object.fromEntries(['original.json', 'projected.json', 'membership.json', 'predictions.json', 'parity.json'].map(file => [file, hash(path.join(folder, file))]));
      write(path.join(folder, 'audit.json'), { planHash, datasetHash: hash(datasetFile), fileHashes });
      summaries.push({ year: fold.year, auditHash: hash(path.join(folder, 'audit.json')) });
    }
    write(path.join(trained, 'training.json'), { planHash, folds: summaries, allFiveDeclaredSeasonsCompleted: true, newRegressorFits: 10, projectedRegressorFits: 0 });
    const result = main(['--plan', planFile, '--dataset', datasetFile, '--trained', trained, '--quotes', quotesFile, '--out', path.join(directory, 'evaluated')]);
    assert.equal(Object.keys(result.summary.bySeason).length, 5); assert.equal(Object.keys(result.summary.byLeague).length, 5);
    assert.equal(result.featureProjection.sourceFeatures, 56); assert.equal(result.featureProjection.modelFeatures, 40); assert.equal(result.featureProjection.unusedSourceFeatures.length, 16);
    assert.equal(result.models.length, 10); assert.equal(result.summary.all.decision.unavailable, true);
    assert.equal(result.summary.all.raw.deltaProjectedMinusOriginal.logLoss, 0); assert(result.rows.every(row => row.forecasts.original.decision === null));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('source56 is projected by model40 names and discarded inputs never reach the predictor', () => {
  const source = require('../../dist/research/ChallengerFeatures').challengerFeatureNames(), names = require('../../dist/research/ForecastCore').FEATURE_NAMES;
  const row = { features: source.map((_, i) => i) };
  assert.deepEqual(modelInput(row, source, names), Array.from({ length: 40 }, (_, i) => i));
  assert.throws(() => modelInput({ features: row.features.slice(0, 40) }, source, names));
  assert.throws(() => modelInput(row, source, [...names.slice(0, 39), 'missing']));
  row.features[55] = NaN; assert.throws(() => modelInput(row, source, names));
});
