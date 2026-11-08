'use strict';
// Five predeclared annual folds. No model, calibration or quote selection from test scores.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), vm = require('node:vm');
const { createHash } = require('node:crypto'), { createRequire } = require('node:module');
const { metrics, losses } = require('../c-parameter-audit/metrics.cjs');
const { calibrationRawMatrix } = require('../c-tree-sample-projection/evaluate.cjs');
const root = path.resolve(__dirname, '../../..'), YEARS = [2021, 2022, 2023, 2024, 2025], ARMS = ['original', 'projected'];
const sha = value => createHash('sha256').update(value).digest('hex'), hashFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8')), hashIds = rows => sha(rows.map(row => row.matchId).sort().join('\n'));
const keys = ['homeWin', 'draw', 'awayWin'], visible = [...keys, 'over25', 'under25', 'btts', 'bttsNo'];
const fileAt = name => path.isAbsolute(name) ? name : path.join(root, name);

function modelInput(row, sourceNames, modelNames) {
  assert.equal(sourceNames.length, 56); assert.equal(new Set(sourceNames).size, 56);
  assert.equal(modelNames.length, 40); assert.equal(new Set(modelNames).size, 40);
  assert.equal(row.features.length, 56); assert(row.features.every(Number.isFinite));
  return modelNames.map(name => { const index = sourceNames.indexOf(name); assert(index >= 0, `Missing model feature ${name}`); return row.features[index]; });
}

function boundaries(year, limits) {
  assert(YEARS.includes(year) && limits, 'Frozen fold boundaries required');
  for (const key of ['trainBefore', 'reservedFrom', 'reservedTo', 'calibrationFrom', 'calibrationTo', 'testFrom', 'testTo']) assert(Number.isFinite(Date.parse(limits[key])), key);
  assert.equal(limits.trainBefore, limits.reservedFrom); assert.equal(limits.reservedTo, limits.calibrationFrom); assert.equal(limits.calibrationTo, limits.testFrom);
  assert(Date.parse(limits.trainBefore) < Date.parse(limits.calibrationFrom) && Date.parse(limits.calibrationFrom) < Date.parse(limits.testFrom) && Date.parse(limits.testFrom) < Date.parse(limits.testTo));
  return limits;
}

function partitionOf(row, year, limits) {
  const b = boundaries(year, limits), forecast = Date.parse(row.forecastAt), available = Date.parse(row.availableAt);
  assert(Number.isFinite(forecast) && Number.isFinite(available));
  if (forecast < Date.parse(b.trainBefore) && available < Date.parse(b.trainBefore)) return 'train';
  if (forecast >= Date.parse(b.trainBefore) && forecast < Date.parse(b.calibrationFrom)) return 'reserved';
  if (forecast >= Date.parse(b.calibrationFrom) && forecast < Date.parse(b.testFrom) && available < Date.parse(b.testFrom)) return 'calibration';
  if (forecast >= Date.parse(b.testFrom) && forecast < Date.parse(b.testTo)) return 'test';
  return null;
}

function validateProjection(original, projected, names) {
  assert.equal(names.length, 40);
  for (const side of ['home', 'away']) {
    const old = original.models[side], current = projected.models[side];
    const { oblivious_trees: oldTrees, ...oldMeta } = old, { oblivious_trees: currentTrees, ...currentMeta } = current;
    assert.deepEqual(currentMeta, oldMeta); assert.equal(currentTrees.length, oldTrees.length); assert.equal(oldTrees.length, 120);
    const mapping = new Map(old.features_info.float_features.map(feature => [feature.feature_index, feature.flat_feature_index]));
    oldTrees.forEach((tree, index) => {
      const replacement = currentTrees[index], { leaf_values: before, ...oldTree } = tree, { leaf_values: after, ...newTree } = replacement;
      assert.deepEqual(newTree, oldTree); assert.equal(before.length, after.length);
      const bits = (tree.splits ?? []).flatMap((split, bit) => ['home_sample', 'away_sample'].includes(names[mapping.get(split.float_feature_index)]) ? [bit] : []);
      if (!bits.length) { assert.deepEqual(replacement, tree); return; }
      const mask = bits.reduce((sum, bit) => sum | 2 ** bit, 0), groups = new Map();
      before.forEach((value, leaf) => { const group = groups.get(leaf & ~mask) ?? { sum: 0, n: 0, leaves: [] };
        group.sum += value * tree.leaf_weights[leaf]; group.n += tree.leaf_weights[leaf]; group.leaves.push(leaf); groups.set(leaf & ~mask, group); });
      for (const group of groups.values()) {
        if (!group.n) assert(group.leaves.every(leaf => before[leaf] === 0));
        const expected = group.n ? group.sum / group.n : 0;
        for (const leaf of group.leaves) assert(Number.isFinite(after[leaf]) && Math.abs(after[leaf] - expected) <= 1e-12);
      }
      const oldMean = before.reduce((sum, value, leaf) => sum + value * tree.leaf_weights[leaf], 0);
      const newMean = after.reduce((sum, value, leaf) => sum + value * tree.leaf_weights[leaf], 0);
      assert(Math.abs(oldMean - newMean) <= 1e-10);
    });
  }
}

function pairedIntervals(rows, stage, { replications = 2000, seed = 20261108 } = {}) {
  const blocks = new Map();
  for (const row of rows) {
    const key = `${row.testSeason}:${Math.floor(Date.parse(row.kickoffAt) / (7 * 86400000))}`;
    const block = blocks.get(key) ?? { n: 0, logLoss: 0, brier: 0 };
    const old = losses(row, 'original', stage), current = losses(row, 'projected', stage); block.n++;
    for (const metric of ['logLoss', 'brier']) block[metric] += current[metric] - old[metric]; blocks.set(key, block);
  }
  const values = [...blocks.values()]; if (values.length < 2) return { blocks: values.length, intervals: null };
  let state = seed >>> 0; const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
  const draws = { logLoss: [], brier: [] };
  for (let replication = 0; replication < replications; replication++) {
    let n = 0, logLoss = 0, brier = 0;
    for (let i = 0; i < values.length; i++) { const block = values[Math.floor(random() * values.length)]; n += block.n; logLoss += block.logLoss; brier += block.brier; }
    draws.logLoss.push(logLoss / n); draws.brier.push(brier / n);
  }
  const quantile = (values, q) => { const at = (values.length - 1) * q, lo = Math.floor(at), hi = Math.ceil(at); return values[lo] + (values[hi] - values[lo]) * (at - lo); };
  return { blocks: values.length, replications, seed, independentEvidence: false, grouping: 'test-season-and-UTC-epoch-week',
    intervals: Object.fromEntries(Object.entries(draws).map(([key, sample]) => { sample.sort((a, b) => a - b); return [key, { lower: quantile(sample, .025), upper: quantile(sample, .975) }]; })) };
}

function compareRows(allRows, bootstrap) {
  return Object.fromEntries(['raw', 'calibrated', 'decision'].map(stage => {
    const rows = stage === 'decision' ? allRows.filter(row => row.closingQuoteAvailable) : allRows;
    if (!rows.length) return [stage, { n: 0, unavailable: true, reason: 'No matched real Bet365 closing 1X2 quote', allTestRows: allRows.length }];
    const original = metrics(rows, 'original', stage), projected = metrics(rows, 'projected', stage);
    return [stage, { n: rows.length, allTestRows: allRows.length, quotedRows: allRows.filter(row => row.closingQuoteAvailable).length,
      original, projected, deltaProjectedMinusOriginal: Object.fromEntries(Object.keys(original).filter(key => key !== 'n').map(key => [key, projected[key] - original[key]])),
      pairedWeekly95PercentInterval: pairedIntervals(rows, stage, bootstrap) }];
  }));
}

function normalizedQuotes(document) {
  assert(Array.isArray(document.rows)); const map = new Map();
  for (const row of document.rows) {
    assert(!map.has(row.matchId), 'Ambiguous normalized quote'); assert.equal(row.bookmaker, 'Bet365'); assert.equal(row.source, 'football_data_csv'); assert.equal(row.priceType, 'closing');
    assert(row.prices.length === 3 && row.prices.every(price => Number.isFinite(price) && price > 1)); assert(Number.isFinite(Date.parse(row.archiveAcquiredAt)));
    assert(typeof row.sourceFile === 'string' && /^[a-f0-9]{64}$/.test(row.sourceSha256)); map.set(row.matchId, row);
  }
  return map;
}

function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) { const key = argv[i]?.slice(2); assert(['plan', 'dataset', 'trained', 'quotes', 'out'].includes(key) && argv[i + 1] && !options[key]); options[key] = path.resolve(argv[i + 1]); }
  assert(['plan', 'dataset', 'trained', 'quotes', 'out'].every(key => options[key]) && !fs.existsSync(options.out));
  const plan = read(options.plan), planHash = hashFile(options.plan);
  assert.equal(plan.protocol, 'c-five-season-projection-research-v1'); assert.equal(plan.phase, 'execution');
  assert.equal(hashFile(options.dataset), plan.datasetHash); assert(plan.inputsPlanHash);
  const relativeQuotes = path.relative(root, options.quotes).split(path.sep).join('/');
  assert.equal(hashFile(options.quotes), plan.quotesHash ?? plan.sourceHashes?.[relativeQuotes] ?? plan.sourceHashes?.[options.quotes], 'Normalized quotes must be pinned');
  const sourceCheck = () => { assert.equal(hashFile(options.plan), planHash); for (const [file, hash] of Object.entries(plan.sourceHashes)) assert.equal(hashFile(fileAt(file)), hash, file); };
  sourceCheck();
  const dataset = read(options.dataset); assert.equal(dataset.reproduction.planHash, plan.inputsPlanHash); const { challengerFeatureNames, DEFAULT_CHALLENGER_BLOCKS } = require('../../dist/research/ChallengerFeatures');
  const modelNames = require('../../dist/research/ForecastCore').FEATURE_NAMES;
  assert.deepEqual(dataset.featureNames, challengerFeatureNames()); assert.deepEqual(dataset.featureBlocks, DEFAULT_CHALLENGER_BLOCKS);
  for (const row of dataset.rows) { assert.deepEqual(row.featureNames, dataset.featureNames); modelInput(row, dataset.featureNames, modelNames); }
  const featureProjection = { sourceFeatures: dataset.featureNames.length, modelFeatures: modelNames.length, modelFeatureNames: modelNames, unusedSourceFeatures: dataset.featureNames.filter(name => !modelNames.includes(name)), baselineUsesCanonicalPerMatchFit: true };
  assert.deepEqual(dataset.baselineManifest, plan.baselineManifest);
  const datasetById = new Map(dataset.rows.map(row => [row.matchId, row])); assert.equal(datasetById.size, dataset.rows.length);
  const ts = require('../../node_modules/typescript'), compilerOptions = { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true };
  const buildParity = Object.fromEntries(Object.keys(plan.sourceHashes).filter(file => file.endsWith('.ts') && plan.sourceHashes[file.replace('/src/', '/dist/').replace(/\.ts$/, '.js')]).map(file => {
    const compiled = ts.transpileModule(fs.readFileSync(fileAt(file), 'utf8'), { compilerOptions }).outputText;
    return [file, compiled.replace(/\r\n/g, '\n').trim() === fs.readFileSync(fileAt(file.replace('/src/', '/dist/').replace(/\.ts$/, '.js')), 'utf8').replace(/\r\n/g, '\n').trim()];
  })); assert(Object.keys(buildParity).length >= 8 && Object.values(buildParity).every(Boolean));
  const sourceFile = path.join(root, 'backend/src/research/CatBoostModel.ts'), filename = path.join(root, 'backend/dist/research/CatBoostModel.js');
  const compiled = ts.transpileModule(fs.readFileSync(sourceFile, 'utf8'), { compilerOptions }).outputText, moduleObject = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${compiled}\n})`, { filename: `${filename}.five-season-source` })(createRequire(filename), moduleObject, moduleObject.exports, filename, path.dirname(filename));
  const { predictCatBoostJson } = moduleObject.exports;
  const { normalizeScoreMatrix, scoreMatrixMarkets } = require('../../dist/research/GoalSettlement');
  const { fitCoherentCalibration, applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash } = require('../../dist/research/CoherentProbabilityPipeline');
  const adapter = require('../current-c-real-odds-backtest/selector-math.cjs'), adapterIdentity = adapter.identities(); assert(Object.values(adapterIdentity.buildParity).every(Boolean));
  const { ORIGINAL_HOLDOUT_POLICY } = require('../../dist/research/ResearchHoldoutPolicy');
  const { challengerDataQualityReason } = require('../../dist/research/ChallengerDataQuality');
  const protectedIds = new Set(ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
  assert(dataset.rows.every(row => !protectedIds.has(row.matchId) && !challengerDataQualityReason(row.matchId)));
  const quotes = normalizedQuotes(read(options.quotes)), quoteSources = new Map();
  for (const quote of quotes.values()) { const source = fileAt(quote.sourceFile); if (quoteSources.has(source)) assert.equal(quoteSources.get(source), quote.sourceSha256);
    else { const relative = path.relative(root, source).split(path.sep).join('/'); assert.equal(plan.sourceHashes[relative] ?? plan.sourceHashes[source], quote.sourceSha256);
      assert.equal(hashFile(source), quote.sourceSha256); quoteSources.set(source, quote.sourceSha256); } }
  const inputHashes = { dataset: hashFile(options.dataset), quotes: hashFile(options.quotes), training: hashFile(path.join(options.trained, 'training.json')) };
  const trained = read(path.join(options.trained, 'training.json')); assert.equal(trained.planHash, planHash);
  assert.equal(trained.allFiveDeclaredSeasonsCompleted, true); assert.equal(trained.newRegressorFits, 10); assert.equal(trained.projectedRegressorFits, 0);
  assert.deepEqual(trained.folds.map(fold => fold.year), YEARS);
  const fileHashes = {}, folds = [], allTestIds = new Set(); let parityMaximumError = 0;
  const rawMatrix = (row, artifact, raw) => calibrationRawMatrix({ baselineMatrix: row.baselineMatrix }, artifact,
    model => model === artifact.models.home ? raw.home : raw.away, normalizeScoreMatrix);
  for (const year of YEARS) {
    const directory = path.join(options.trained, `fold-${year}`), membership = read(path.join(directory, 'membership.json')), predictions = read(path.join(directory, 'predictions.json'));
    const artifacts = Object.fromEntries(ARMS.map(arm => [arm, read(path.join(directory, `${arm}.json`))]));
    for (const name of ['membership.json', 'predictions.json', 'parity.json', 'audit.json', 'original.json', 'projected.json']) fileHashes[path.join(directory, name)] = hashFile(path.join(directory, name));
    assert.equal(trained.folds.find(fold => fold.year === year).auditHash, fileHashes[path.join(directory, 'audit.json')]);
    const audit = read(path.join(directory, 'audit.json')); assert.equal(audit.planHash, planHash); assert.equal(audit.datasetHash, inputHashes.dataset);
    for (const [name, hash] of Object.entries(audit.fileHashes)) assert.equal(hashFile(path.join(directory, name)), hash);
    assert.equal(membership.year, year); assert.equal(predictions.year, year); assert.deepEqual(predictions.featureNames, modelNames);
    const limits = boundaries(year, membership.boundaries), declared = plan.folds?.find(fold => Number(fold.year) === year);
    assert(declared); assert.deepEqual(limits, declared.boundaries);
    const expectedGroups = Object.fromEntries(['train', 'reserved', 'calibration', 'test'].map(part => [part, dataset.rows.filter(row => partitionOf(row, year, limits) === part)]));
    for (const [part, rows] of Object.entries(expectedGroups)) {
      const record = membership.memberships[part]; assert.equal(record.n, rows.length); assert.equal(record.matchIdsHash, hashIds(rows));
      assert.deepEqual([...record.matchIds].sort(), rows.map(row => row.matchId).sort());
      const pinned = plan.folds?.find(fold => Number(fold.year) === year)?.memberships?.[part]; if (pinned) { assert.equal(pinned.n, rows.length); assert.equal(pinned.matchIdsHash, hashIds(rows)); }
    }
    for (const arm of ARMS) {
      assert.equal(artifacts[arm].weight, .75); assert.equal(artifacts[arm].temperature, .8); assert.equal(artifacts[arm].candidateKind, 'calibrated_ensemble'); assert.deepEqual(artifacts[arm].featureNames, modelNames);
      assert.equal(artifacts[arm].datasetHash, inputHashes.dataset); assert.equal(artifacts[arm].baselineVersion, dataset.baselineManifest?.version);
      assert(Date.parse(artifacts[arm].trainedThrough) < Date.parse(limits.trainBefore));
      assert(Date.parse(artifacts[arm].validationThrough) < Date.parse(limits.testFrom));
    }
    validateProjection(artifacts.original, artifacts.projected, modelNames);
    const nativeParity = read(path.join(directory, 'parity.json'));
    assert.equal(nativeParity.rows.length, expectedGroups.train.length + expectedGroups.calibration.length + expectedGroups.test.length);
    const parityById = new Map(nativeParity.rows.map(row => [row.matchId, row])); assert.equal(parityById.size, nativeParity.rows.length);
    for (const row of nativeParity.rows) {
      const source = datasetById.get(row.matchId); assert(source && partitionOf(source, year, limits) === row.partition);
      for (const arm of ARMS) for (const side of ['home', 'away']) {
        const actual = predictCatBoostJson(artifacts[arm].models[side], modelInput(source, dataset.featureNames, artifacts[arm].featureNames)), expected = row.raw[arm][side];
        assert(actual.length === expected.length && actual.every(Number.isFinite) && expected.every(Number.isFinite));
        parityMaximumError = Math.max(parityMaximumError, ...actual.map((value, i) => Math.abs(value - expected[i])));
      }
    }
    const calibration = predictions.rows.filter(row => row.partition === 'calibration'), tests = predictions.rows.filter(row => row.partition === 'test');
    assert.equal(hashIds(calibration), hashIds(expectedGroups.calibration)); assert.equal(hashIds(tests), hashIds(expectedGroups.test));
    assert(new Set(tests.map(row => row.competition)).size === 5 && new Set(calibration.map(row => row.competition)).size === 5);
    for (const row of predictions.rows) {
      const source = datasetById.get(row.matchId); assert(source && row.partition === partitionOf(source, year, limits));
      for (const key of ['homeGoals', 'awayGoals', 'competition', 'season', 'forecastAt', 'kickoffAt', 'availableAt']) assert.equal(row[key], source[key], key);
      assert.deepEqual(row.baselineMatrix, source.baselineMatrix);
      assert.deepEqual(row.raw, parityById.get(row.matchId).raw);
    }
    const asOf = new Date(Date.parse(limits.testFrom) - 1).toISOString();
    const observations = (arm, useBaseline = false) => calibration.map(row => {
      const p = scoreMatrixMarkets(useBaseline ? row.baselineMatrix : rawMatrix(row, artifacts[arm], row.raw[arm]));
      const total = keys.reduce((sum, key) => sum + p[key], 0), outcome = row.homeGoals > row.awayGoals ? 'homeWin' : row.homeGoals < row.awayGoals ? 'awayWin' : 'draw';
      return { matchId: row.matchId, availableAt: row.availableAt, probabilities: Object.fromEntries(keys.map(key => [key, p[key] / total])), outcomes: Object.fromEntries(keys.map(key => [key, Number(key === outcome)])) };
    });
    const profileA = fitCoherentCalibration(observations('original', true), asOf), profiles = {};
    for (const arm of ARMS) { profiles[arm] = fitCoherentCalibration(observations(arm), asOf); assert.equal(profiles[arm].matches, calibration.length); }
    for (const row of tests) { assert(!allTestIds.has(row.matchId)); allTestIds.add(row.matchId); }
    folds.push({ year, testSeason: `${year}/${year + 1}`, limits, artifacts, membership, calibration, tests, profileA, profiles });
  }
  assert(parityMaximumError <= 1e-12);
  const sourceHashes = Object.fromEntries(['evaluate.cjs', 'test_evaluate.cjs'].map(file => [file, hashFile(path.join(__dirname, file))]));
  sourceCheck(); fs.mkdirSync(options.out); const write = (file, value) => fs.writeFileSync(path.join(options.out, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
  const frozen = [];
  for (const fold of folds) {
    fs.mkdirSync(path.join(options.out, `fold-${fold.year}`));
    for (const arm of ARMS) {
      const artifact = structuredClone(fold.artifacts[arm]);
      artifact.calibrationProfilesV2 = { A: fold.profileA, C: fold.profiles[arm] };
      artifact.diagnosticOnly = true; artifact.productionAdoptionEligible = false; artifact.independentEvidence = false;
      artifact.calibrationAsOf = new Date(Date.parse(fold.limits.testFrom) - 1).toISOString();
      artifact.experimentPlanHash = planHash; artifact.calibrationCreatedAt = new Date().toISOString();
      const file = `fold-${fold.year}/${arm}.json`; write(file, artifact); frozen.push({ year: fold.year, arm, file, sha256: hashFile(path.join(options.out, file)) });
    }
  }
  const frozenAt = new Date().toISOString(); write('frozen-models.json', { planHash, frozenAt, models: frozen });
  const diagnosticStartedAt = new Date().toISOString(), records = [];
  for (const fold of folds) for (const row of fold.tests) {
    assert(Date.parse(row.forecastAt) >= Date.parse(fold.limits.testFrom));
    const quoted = quotes.get(row.matchId);
    if (quoted) for (const key of ['competition', 'season', 'kickoffAt']) assert.equal(quoted[key], row[key], `Quote target mismatch ${key}`);
    const quoteEvidence = quoted ? keys.map((selection, index) => ({ selection, market: '1x2', side: ['home', 'draw', 'away'][index], bookmaker: 'Bet365', source: 'football_data_csv', priceType: 'closing', capturedAt: quoted.archiveAcquiredAt, timestampEvidence: 'observed_snapshot', odds: quoted.prices[index] })) : [];
    const forecasts = {};
    for (const arm of ARMS) {
      const matrix = rawMatrix(row, fold.artifacts[arm], row.raw[arm]);
      const calibrated = applyCoherentProbabilityPipeline({ matrix, profile: fold.profiles[arm], mode: 'isotonic_1x2', forecastAt: row.forecastAt, quotes: [] });
      let decision = null;
      if (quoted) { const result = adapter.calibrateAndBlend({ matrix, profile: fold.profiles[arm], mode: 'isotonic_1x2', forecastAt: row.forecastAt, quotes: quoteEvidence }); assert(result.marketBlendingApplied && result.bookmaker.bookmaker === 'Bet365'); decision = result.decision; }
      forecasts[arm] = Object.fromEntries(Object.entries({ raw: scoreMatrixMarkets(matrix), calibrated: calibrated.calibrated, decision }).map(([stage, values]) => {
        if (values === null) return [stage, null];
        assert(Math.abs(values.homeWin + values.draw + values.awayWin - 1) < 1e-10); assert(Math.abs(values.over25 + values.under25 - 1) < 1e-10); assert(Math.abs(values.btts + values.bttsNo - 1) < 1e-10);
        return [stage, Object.fromEntries(visible.map(key => [key, values[key]]))];
      }));
    }
    records.push({ matchId: row.matchId, year: fold.year, testSeason: fold.testSeason, competition: row.competition, season: row.season,
      kickoffAt: row.kickoffAt, forecastAt: row.forecastAt, availableAt: row.availableAt, homeGoals: row.homeGoals, awayGoals: row.awayGoals,
      closingQuoteAvailable: Boolean(quoted), quoteEvidence, quoteSource: quoted ?? null, quoteTiming: quoted ? 'closing_download_observation_not_forecast_capture' : null, forecasts });
    if (records.length % 500 === 0) console.log(JSON.stringify({ completed: records.length, planned: allTestIds.size }));
  }
  const bootstrap = { replications: 2000, seed: 20261108 };
  const summary = { all: compareRows(records, bootstrap), bySeason: {}, byLeague: {}, bySeasonAndLeague: {} };
  for (const fold of folds) { const rows = records.filter(row => row.year === fold.year); summary.bySeason[fold.testSeason] = compareRows(rows, bootstrap);
    summary.bySeasonAndLeague[fold.testSeason] = Object.fromEntries([...new Set(rows.map(row => row.competition))].sort().map(league => [league, compareRows(rows.filter(row => row.competition === league), bootstrap)])); }
  for (const league of [...new Set(records.map(row => row.competition))].sort()) summary.byLeague[league] = compareRows(records.filter(row => row.competition === league), bootstrap);
  sourceCheck(); for (const [file, hash] of Object.entries(fileHashes)) assert.equal(hashFile(file), hash); for (const [file, hash] of quoteSources) assert.equal(hashFile(file), hash);
  assert.equal(hashFile(options.dataset), inputHashes.dataset); assert.equal(hashFile(options.quotes), inputHashes.quotes); assert.equal(hashFile(path.join(options.trained, 'training.json')), inputHashes.training);
  for (const model of frozen) assert.equal(hashFile(path.join(options.out, model.file)), model.sha256);
  const report = { protocol: plan.protocol, planHash, inputsPlanHash: plan.inputsPlanHash, sourceHashes, inputHashes, trainedFileHashes: fileHashes,
    quoteSourceHashes: Object.fromEntries(quoteSources), buildParity, sourceTypeScriptHash: hashFile(sourceFile), compiledTypeScriptHash: sha(compiled),
    featureProjection, pipelineHash: coherentProbabilityPipelineHash(), adapterIdentity, frozenAt, diagnosticStartedAt, completedAt: new Date().toISOString(),
    models: frozen, years: YEARS, diagnosticOnly: true, independentEvidence: false, productionAdoptionEligible: false, databaseWrites: 0,
    coverage: { allTestRows: records.length, realClosingQuotedRows: records.filter(row => row.closingQuoteAvailable).length,
      decisionCohort: 'Same real Bet365 closing quote and match for both arms; missing quotes excluded only from decision metrics' },
    checks: { allFiveFoldsCompleted: true, originalCalibrationEstimatorUnchanged: true, allModelsFrozenBeforeTestScoring: true, nativeSourceTypeScriptMaximumError: parityMaximumError, originalSourcesUnchanged: true },
    summary, rows: records };
  write('comparison.json', report); console.log(JSON.stringify({ rows: records.length, coverage: report.coverage, complete: true })); return report;
}
module.exports = { main, modelInput, boundaries, partitionOf, validateProjection, pairedIntervals, compareRows, normalizedQuotes };
if (require.main === module) main();
