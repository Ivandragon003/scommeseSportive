'use strict';
// Offline diagnostic: no registration, operational state, provider or training calls.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveReferenceSource } = require('./kernel-replay');
const backend = path.resolve(__dirname, '../..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => sha(fs.readFileSync(file));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const researchHash = value => sha(JSON.stringify(canonical(value)));
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const requireThat = (condition, message) => { if (!condition) throw Error(message); };
const timestamp = value => { const t = Date.parse(value); requireThat(Number.isFinite(t), 'invalid timestamp'); return t; };

function uniqueRows(rows, label) {
  requireThat(Array.isArray(rows), `${label}: missing rows`);
  const result = new Map();
  for (const row of rows) {
    requireThat(row && typeof row.matchId === 'string' && !result.has(row.matchId), `${label}: invalid or duplicate matchId`);
    result.set(row.matchId, row);
  }
  return result;
}
function equalIds(actual, expected, label) {
  requireThat(actual.size === expected.size && [...expected.keys()].every(id => actual.has(id)), `${label}: missing or unexpected matchId`);
}
function project(row, names) {
  requireThat(Array.isArray(row.featureNames) && new Set(row.featureNames).size === row.featureNames.length
    && row.features?.length === row.featureNames.length, 'invalid feature projection');
  const features = names.map(name => {
    const index = row.featureNames.indexOf(name), value = row.features[index];
    requireThat(index >= 0 && Number.isFinite(value), `missing/non-finite consumed feature ${name}`);
    return value;
  });
  requireThat(Number.isFinite(row.lambdaHome) && Number.isFinite(row.lambdaAway)
    && Array.isArray(row.baselineMatrix) && row.baselineMatrix.length > 0
    && row.baselineMatrix.every(line => Array.isArray(line) && line.length === row.baselineMatrix.length
      && line.every(v => Number.isFinite(v) && v >= 0)), 'invalid consumed baseline');
  return { features, baselineMatrix: row.baselineMatrix, lambdaHome: row.lambdaHome, lambdaAway: row.lambdaAway };
}
const identityFields = ['matchId', 'competition', 'season', 'homeTeamId', 'awayTeamId', 'kickoffAt', 'forecastAt',
  'maxTrainingAvailableAt', 'trainingCount', 'modelFitAt', 'homeGoals', 'awayGoals', 'availableAt',
  'dataQualityPolicyHash', 'dataQualityBaselineClean', 'featureSchema', 'featureBlocks', 'challengerFeatureMetadata'];
function assertIdentity(oldRow, currentRow) {
  for (const field of identityFields) requireThat(same(oldRow[field], currentRow[field]), `cross-arm identity drift ${oldRow.matchId}: ${field}`);
  const forecast = timestamp(oldRow.forecastAt);
  requireThat(timestamp(oldRow.maxTrainingAvailableAt) < forecast && timestamp(oldRow.modelFitAt) <= forecast
    && forecast < timestamp(oldRow.kickoffAt), `future baseline information ${oldRow.matchId}`);
}
function validateTemporal(row, artifact) {
  const forecast = timestamp(row.forecastAt);
  requireThat(timestamp(artifact.trainedThrough) < forecast && timestamp(artifact.validationThrough) < forecast,
    `future model training/validation ${row.matchId}`);
  timestamp(artifact.createdAt); // Retrospective creation is declared, never backdated.
  const profile = artifact.calibrationProfilesV2?.C;
  requireThat(profile && timestamp(profile.fittedThrough) < forecast, `future/missing calibration ${row.matchId}`);
  for (const part of ['train', 'selection', 'calibration']) {
    const split = artifact.trainingSplit?.[part];
    requireThat(split && timestamp(split.to) < forecast && timestamp(split.availableThrough) < forecast,
      `future ${part} split ${row.matchId}`);
  }
  requireThat(artifact.holdoutProtection?.protectedRowsUsed === 0 && artifact.productionAdoptionEligible === false,
    'artifact is not the protected retrospective control');
}
function compareConsumed(datasetRows, currentRows, names) {
  const oldMap = uniqueRows(datasetRows, 'canonical'), newMap = uniqueRows(currentRows, 'current');
  equalIds(newMap, oldMap, 'current');
  const result = { rowsChecked: oldMap.size, differingConsumedRows: 0, firstConsumedDifference: null,
    flatBaselineDifferingRows: 0, flatBaselineDifferingKeys: {}, maxFlatBaselineDifference: 0 };
  for (const [id, old] of oldMap) {
    const current = newMap.get(id); assertIdentity(old, current);
    const before = project(old, names), after = project(current, names);
    if (!same(before, after)) {
      result.differingConsumedRows++;
      result.firstConsumedDifference ??= { matchId: id, fields: Object.keys(before).filter(key => !same(before[key], after[key])) };
    }
    let flatChanged = false;
    for (const key of new Set([...Object.keys(old.baselineProbabilities ?? {}), ...Object.keys(current.baselineProbabilities ?? {})])) {
      const a = old.baselineProbabilities?.[key], b = current.baselineProbabilities?.[key];
      if (a !== b) {
        flatChanged = true; result.flatBaselineDifferingKeys[key] = (result.flatBaselineDifferingKeys[key] ?? 0) + 1;
        if (Number.isFinite(a) && Number.isFinite(b)) result.maxFlatBaselineDifference = Math.max(result.maxFlatBaselineDifference, Math.abs(a - b));
      }
    }
    if (flatChanged) result.flatBaselineDifferingRows++;
  }
  return result;
}
function metrics(records, arm) {
  requireThat(records.length > 0, 'empty metric group');
  let logLoss = 0, brier = 0, correct = 0;
  const bins = Array.from({ length: 10 }, (_, index) => ({ lower: index / 10, upper: (index + 1) / 10, n: 0, confidence: 0, correct: 0 }));
  for (const row of records) {
    const p = row[arm], target = row.target;
    requireThat(Array.isArray(p) && p.length === 3 && p.every(v => Number.isFinite(v) && v >= 0 && v <= 1)
      && Math.abs(p.reduce((a, b) => a + b, 0) - 1) < 1e-10 && [0, 1, 2].includes(target), 'invalid metric probabilities/target');
    const predicted = p.indexOf(Math.max(...p)), hit = Number(predicted === target), confidence = p[predicted];
    logLoss -= Math.log(Math.max(1e-15, p[target]));
    brier += p.reduce((sum, value, index) => sum + (value - Number(index === target)) ** 2, 0);
    correct += hit;
    const bin = bins[Math.min(9, Math.floor(confidence * 10))]; bin.n++; bin.confidence += confidence; bin.correct += hit;
  }
  const ece10 = bins.reduce((sum, bin) => sum + (bin.n ? Math.abs(bin.correct - bin.confidence) / records.length : 0), 0);
  return { n: records.length, logLoss: logLoss / records.length, brier: brier / records.length, accuracy: correct / records.length, ece10,
    bins: bins.map(bin => ({ lower: bin.lower, upper: bin.upper, n: bin.n, confidence: bin.n ? bin.confidence / bin.n : null,
      accuracy: bin.n ? bin.correct / bin.n : null })) };
}
function groupedMetrics(records) {
  const summarize = rows => ({ frozen: metrics(rows, 'frozen'), currentProxy: metrics(rows, 'currentProxy') });
  const group = field => Object.fromEntries([...new Set(records.map(row => row[field]))].sort()
    .map(value => [value, summarize(records.filter(row => row[field] === value))]));
  return { ALL: summarize(records), byLeague: group('competition'), bySeason: group('season'),
    byLeagueSeason: Object.fromEntries([...new Set(records.map(row => `${row.competition} | ${row.season}`))].sort()
      .map(key => [key, summarize(records.filter(row => `${row.competition} | ${row.season}` === key))])) };
}
function weekOf(value) {
  const date = new Date(value); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
function pairedIntervals(records, samples = 2000, seed = 20261107) {
  const identical = records.every(row => same(row.frozen, row.currentProxy));
  const blocks = new Map();
  for (const row of records) {
    const key = `${row.competition}|${weekOf(row.forecastAt)}`;
    if (!blocks.has(key)) blocks.set(key, []); blocks.get(key).push(row);
  }
  if (identical) return { method: 'exact_zero_conditional_on_verified_identical_inputs_and_fixed_model', samples: 0, seed,
    blockDefinition: 'league x UTC Monday week', blocks: blocks.size, logLossDelta95: [0, 0], brierDelta95: [0, 0],
    probabilityLeagueJointImprovement: 0, jointLeagueCriterion: 'strict LL and Brier improvement in >=4/5 leagues', conditionalOnModel: true };
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const leagueBlocks = new Map();
  for (const [key, rows] of blocks) {
    const league = key.split('|')[0]; if (!leagueBlocks.has(league)) leagueBlocks.set(league, []);
    leagueBlocks.get(league).push(rows);
  }
  const losses = [], briers = []; let joint = 0;
  for (let i = 0; i < samples; i++) {
    const sampled = []; let improved = 0;
    for (const blocksForLeague of leagueBlocks.values()) {
      const leagueRows = [];
      for (let j = 0; j < blocksForLeague.length; j++) leagueRows.push(...blocksForLeague[Math.floor(random() * blocksForLeague.length)]);
      sampled.push(...leagueRows);
      const a = metrics(leagueRows, 'frozen'), b = metrics(leagueRows, 'currentProxy');
      if (b.logLoss < a.logLoss && b.brier < a.brier) improved++;
    }
    const a = metrics(sampled, 'frozen'), b = metrics(sampled, 'currentProxy');
    losses.push(b.logLoss - a.logLoss); briers.push(b.brier - a.brier); if (improved >= 4) joint++;
  }
  const interval = values => { values.sort((a, b) => a - b); return [values[Math.floor(samples * 0.025)], values[Math.ceil(samples * 0.975) - 1]]; };
  return { method: 'paired_stratified_league_week_block_bootstrap', samples, seed, blocks: blocks.size,
    blockDefinition: 'league x UTC Monday week', logLossDelta95: interval(losses), brierDelta95: interval(briers),
    probabilityLeagueJointImprovement: joint / samples, jointLeagueCriterion: 'strict LL and Brier improvement in >=4/5 leagues', conditionalOnModel: true };
}
function diagnosticArtifact(original, baselineVersion, replayFingerprint, createdAt) {
  const descriptor = { parentArtifactHash: researchHash(original), baselineVersion, replayFingerprint,
    protocol: 'c-current-kernel-diagnostic-equivalent-input-v1', createdAt };
  const artifact = { ...original, version: `C-diagnostic-proxy-${researchHash(descriptor).slice(0, 16)}`, baselineVersion, createdAt,
    diagnosticIdentity: descriptor, diagnosticOnly: true, registerable: false, productionValidated: false,
    productionAdoptionEligible: false, status: 'DIAGNOSTIC_CONTROL', availability: 'retrospective_development' };
  return { artifact, hash: researchHash(artifact), descriptor };
}
function validateReplays(replays, dataset, datasetHash) {
  const canonicalRows = uniqueRows(dataset.rows, 'canonical'), current = [], evidence = [];
  let commonManifest;
  for (const replay of replays) {
    const manifest = replay.baselineManifest;
    requireThat(replay.diagnosticOnly === true && replay.registerable === false && manifest?.registerable === false
      && manifest.protocol === 'current-kernel-raw-historical-proxy-v1'
      && replay.datasetFileHash === datasetHash && replay.matchesFileHash === dataset.reproduction.matchesFileHash,
    'replay provenance mismatch');
    const { fingerprint, version, description, registerable, ...identity } = manifest;
    requireThat(sha(JSON.stringify(identity)) === fingerprint && version === `experimental-current-kernel-${fingerprint.slice(0, 16)}`,
      'replay manifest fingerprint mismatch');
    if (!commonManifest) commonManifest = manifest;
    requireThat(same(manifest, commonManifest) && same(replay.currentDataset?.baselineManifest, manifest), 'cross-replay manifest mismatch');
    requireThat(replay.referenceVerificationTolerance === 1e-12, 'unexpected reference tolerance');
    const rows = uniqueRows(replay.currentDataset?.rows, 'replay'), differences = uniqueRows(replay.differences, 'replay verification');
    equalIds(differences, rows, 'replay verification');
    requireThat(replay.referenceRowsVerified === rows.size && replay.selection?.selectedRows === rows.size
      && replay.selection?.totalCanonicalRows === canonicalRows.size, 'incomplete replay reference verification');
    for (const row of rows.values()) {
      const verification = differences.get(row.matchId).verification;
      requireThat(canonicalRows.has(row.matchId) && row.baselineVersion === version && verification?.firstMismatch === null
        && Number.isFinite(verification.maxAbsoluteDifference) && verification.maxAbsoluteDifference <= 1e-12,
      `frozen reference not verified ${row.matchId}`);
      current.push(row);
    }
    evidence.push({ rows: rows.size, selection: replay.selection });
  }
  const currentMap = uniqueRows(current, 'combined replay'); equalIds(currentMap, canonicalRows, 'combined replay');
  return { current, manifest: commonManifest, evidence };
}
function verifySourceHashes(manifest, referenceSource) {
  const reference = resolveReferenceSource(referenceSource);
  requireThat(manifest.codeHashes && Object.keys(manifest.codeHashes).length > 0, 'missing compiled source hashes');
  for (const [relative, expected] of Object.entries(manifest.codeHashes)) {
    const file = path.resolve(backend, relative);
    requireThat(file.startsWith(path.join(backend, 'dist') + path.sep) && shaFile(file) === expected, `compiled source changed: ${relative}`);
  }
  requireThat(shaFile(reference) === manifest.frozenForecastCoreHash, 'historical reference source changed');
  requireThat(shaFile(path.join(__dirname, 'kernel-replay.js')) === manifest.comparatorHash, 'replay runner changed');
}
function optionsOf(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    requireThat(argv[i]?.startsWith('--') && ['replays', 'dataset', 'comparison', 'artifacts', 'out', 'reference-source'].includes(key)
      && argv[i + 1] && !Object.hasOwn(opts, key), 'invalid option'); opts[key] = argv[i + 1];
  }
  for (const key of ['replays', 'dataset', 'comparison', 'artifacts', 'out']) requireThat(opts[key], `missing --${key}`);
  requireThat(opts['reference-source'], 'historical reference unavailable: missing --reference-source; historical sources were removed from this repository');
  return opts;
}
function main(argv = process.argv.slice(2)) {
  const opts = optionsOf(argv), output = path.resolve(opts.out);
  const referenceFile = resolveReferenceSource(opts['reference-source']);
  requireThat(!fs.existsSync(output), 'output must be a new directory');
  const datasetFile = path.resolve(opts.dataset), comparisonFile = path.resolve(opts.comparison), artifactDir = path.resolve(opts.artifacts);
  const dataset = readJSON(datasetFile), comparison = readJSON(comparisonFile), datasetHash = shaFile(datasetFile);
  const replayFiles = opts.replays.split(',').map(file => path.resolve(file));
  requireThat(replayFiles.length === 5 && new Set(replayFiles).size === 5, 'expected five distinct full competition replays');
  requireThat(dataset.rows?.length === 6573 && dataset.developmentOnly === true && dataset.dataQualityBaselineClean === true
    && comparison.records?.length === 6573 && comparison.provenance?.datasetFileHash === datasetHash, 'unexpected canonical source/count');
  const replay = validateReplays(replayFiles.map(readJSON), dataset, datasetHash); verifySourceHashes(replay.manifest, referenceFile);
  const foldSpecs = comparison.variants?.c906_recipe_retrained?.foldArtifacts;
  requireThat(foldSpecs?.length === 6, 'expected six fixed-recipe folds');
  const createdAt = new Date().toISOString();
  const folds = foldSpecs.map((spec, index) => {
    const file = path.join(artifactDir, `fold-${index}-c906_recipe_retrained.json`), artifact = readJSON(file);
    requireThat(researchHash(artifact) === spec.hash && artifact.version === spec.version && artifact.datasetHash === datasetHash
      && artifact.baselineVersion === dataset.baselineManifest.version && artifact.featureNames.length === 40
      && artifact.comparisonArm === 'c906_recipe_retrained' && artifact.recipeCalibrationMode === 'isotonic_1x2'
      && artifact.weight === 0.75 && artifact.temperature === 0.8
      && artifact.hyperparameters?.iterations === 120 && artifact.hyperparameters?.depth === 5
      && artifact.hyperparameters?.learningRate === 0.05 && artifact.hyperparameters?.seed === 20261027,
    `fixed recipe/source mismatch fold ${index}`);
    const derived = diagnosticArtifact(artifact, replay.manifest.version, replay.manifest.fingerprint, createdAt);
    return { ...spec, index, file, fileHash: shaFile(file), artifact, derived };
  });
  requireThat(folds.every(fold => same(fold.artifact.featureNames, folds[0].artifact.featureNames)), 'fold feature names differ');
  const consumed = compareConsumed(dataset.rows, replay.current, folds[0].artifact.featureNames);
  const provenance = { dataset: { file: datasetFile, sha256: datasetHash }, comparison: { file: comparisonFile, sha256: shaFile(comparisonFile) },
    replays: replayFiles.map((file, i) => ({ file, sha256: shaFile(file), ...replay.evidence[i] })),
    replayManifest: replay.manifest, scorerSha256: shaFile(__filename), folds: folds.map(fold => ({ index: fold.index,
      from: fold.from, until: fold.until, referenceVersion: fold.version, referenceResearchHash: fold.hash,
      referenceFileHash: fold.fileHash, proxyVersion: fold.derived.artifact.version, proxyResearchHash: fold.derived.hash,
      proxyBaselineVersion: fold.derived.artifact.baselineVersion, proxyCreatedAt: createdAt, descriptor: fold.derived.descriptor })) };
  const limitations = ['Il proxy ricostruisce i kernel matematici correnti, non tutta APP-A storica.',
    'Artefatti della ricetta C906 rifatti per fold: non il vero C906 del 2026 retrodatato.',
    'Creazione dei controlli retrospettiva; train, selezione e calibrazione precedono ogni previsione.',
    'Dati già consultati: sola evidenza di sviluppo, nessuna adozione o conferma indipendente.',
    'Stagione 2021/2022 assente; 2022/2023 usata come riscaldamento, 2026/2027 esclusa dal test.',
    'Orario nominale nightly e disponibilità kickoff+2h sono proxy; mancano prime pubblicazioni storiche xG.',
    'Nessuna quota reale ammessa: nessuna conclusione su ROI, CLV o redditività.'];
  if (consumed.differingConsumedRows) {
    fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify({ status: 'isolated_refit_required',
      diagnosticOnly: true, registerable: false, consumed, provenance, limitations }, null, 2), { flag: 'wx' });
    fs.writeFileSync(path.join(output, 'REPORT.md'), '# Ricostruzione C: refit isolato necessario\n\nGli input consumati da C cambiano. Vietato riusare modelli o calibrazione dei vecchi fold. Nessun benchmark numerico prodotto.\n', { flag: 'wx' });
    throw Error('isolated_refit_required');
  }
  const { predictHybrid } = require(path.join(backend, 'dist/research/CatBoostModel'));
  const { applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash } = require(path.join(backend, 'dist/research/CoherentProbabilityPipeline'));
  requireThat(coherentProbabilityPipelineHash() === comparison.probabilityPipelineHash
    && folds.every(fold => fold.artifact.pipelineHashV2 === comparison.probabilityPipelineHash), 'probability pipeline source mismatch');
  const protectedIds = new Set(require(path.join(backend, 'dist/research/ResearchHoldoutPolicy')).ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
  requireThat(dataset.rows.every(row => !protectedIds.has(row.matchId)), 'protected target in dataset');
  const sourceRows = uniqueRows(dataset.rows, 'canonical'), currentRows = uniqueRows(replay.current, 'current');
  const allRecords = uniqueRows(comparison.records, 'comparison'); equalIds(allRecords, sourceRows, 'comparison');
  const development = comparison.records.filter(row => row.phase === 'development');
  requireThat(development.length === 4892, 'unexpected development count');
  for (const fold of folds) requireThat((fold.artifact.calibrationPredictions ?? []).every(row => !protectedIds.has(row.matchId)), 'protected calibration row');
  let maxReferenceDifference = 0, maxPairedDifference = 0, maxGoalMarketDifference = 0;
  const maxReferenceStageDifference = { raw: 0, calibrated: 0, decision: 0 };
  const predictions = development.map(record => {
    const original = sourceRows.get(record.matchId), current = currentRows.get(record.matchId);
    for (const key of ['competition', 'season', 'kickoffAt', 'forecastAt', 'homeGoals', 'awayGoals'])
      requireThat(same(original[key], record[key]), `comparison identity drift ${record.matchId}: ${key}`);
    const matching = folds.filter(fold => timestamp(record.forecastAt) >= timestamp(fold.from) && timestamp(record.forecastAt) < timestamp(fold.until));
    requireThat(matching.length === 1, `nonunique fold ${record.matchId}`); const fold = matching[0];
    const infer = (row, artifact) => {
      validateTemporal(row, artifact);
      const projected = { ...row, ...project(row, artifact.featureNames), featureNames: artifact.featureNames, featureSchema: artifact.featureSchema };
      const raw = predictHybrid(projected, artifact);
      return applyCoherentProbabilityPipeline({ matrix: raw.matrix, rawProbabilities: raw.probabilities, quotes: [],
        forecastAt: row.forecastAt, mode: artifact.probabilityCalibrationMode, profile: artifact.calibrationProfilesV2.C,
        temperature: artifact.probabilityTemperature });
    };
    // Two actual inference calls; the current output is never copied from reference.
    const a = infer(original, fold.artifact), b = infer(current, fold.derived.artifact);
    const vector = result => ['homeWin', 'draw', 'awayWin'].map(key => result.decision[key]);
    const frozen = vector(a), currentProxy = vector(b), stored = record.predictions?.c906_recipe_retrained;
    requireThat(stored?.modelVersion === fold.version && stored.probabilities?.length === 3, 'missing stored recipe reference');
    for (const stage of ['raw', 'calibrated', 'decision']) {
      requireThat(stored.probabilityStages?.[stage]?.length === 3, `missing reference stage ${stage}`);
      ['homeWin', 'draw', 'awayWin'].forEach((key, index) => {
        const difference = Math.abs(a[stage][key] - stored.probabilityStages[stage][index]);
        requireThat(Number.isFinite(difference) && difference <= 1e-12, `reference ${stage} differs ${record.matchId}`);
        maxReferenceStageDifference[stage] = Math.max(maxReferenceStageDifference[stage], difference);
      });
    }
    frozen.forEach((p, i) => { maxReferenceDifference = Math.max(maxReferenceDifference, Math.abs(p - stored.probabilities[i]));
      maxPairedDifference = Math.max(maxPairedDifference, Math.abs(p - currentProxy[i])); });
    requireThat(maxReferenceDifference <= 1e-12, `reference probabilities differ ${record.matchId}`);
    for (const key of Object.keys(a.decision)) {
      requireThat(Number.isFinite(a.decision[key]) && Number.isFinite(b.decision[key]), 'invalid goal probability');
      maxGoalMarketDifference = Math.max(maxGoalMarketDifference, Math.abs(a.decision[key] - b.decision[key]));
    }
    return { matchId: record.matchId, competition: record.competition, season: record.season, forecastAt: record.forecastAt,
      target: record.homeGoals > record.awayGoals ? 0 : record.homeGoals === record.awayGoals ? 1 : 2, homeGoals: record.homeGoals, awayGoals: record.awayGoals,
      fold: fold.index, frozenModelVersion: fold.version, proxyModelVersion: fold.derived.artifact.version,
      retrospective: true, frozen, currentProxy, frozenGoalMarkets: a.decision, currentProxyGoalMarkets: b.decision,
      frozenProbabilityStages: { raw: a.raw, calibrated: a.calibrated, decision: a.decision },
      proxyProbabilityStages: { raw: b.raw, calibrated: b.calibrated, decision: b.decision },
      frozenMatrixHash: researchHash(a.matrix), proxyMatrixHash: researchHash(b.matrix) };
  });
  const grouped = groupedMetrics(predictions), intervals = pairedIntervals(predictions);
  const summary = { status: 'completed_diagnostic_only', diagnosticOnly: true, registerable: false, createdAt,
    consumed, provenance, evaluatedRows: predictions.length, developmentSeasonCounts: Object.fromEntries(Object.entries(grouped.bySeason).map(([key, value]) => [key, value.frozen.n])),
    foldEvaluatedCounts: Object.fromEntries(folds.map(fold => [fold.index, predictions.filter(row => row.fold === fold.index).length])),
    maxReferenceDifference, maxReferenceStageDifference, referenceTolerance: 1e-12, maxPairedDifference, maxGoalMarketDifference,
    modelEquivalence: 'deterministic_recipe_with_identical_consumed_inputs_in_all_canonical_partitions',
    metrics: grouped, pairedIntervals: intervals, operationalAdoption: false, roi: null, clv: null, limitations };
  verifySourceHashes(replay.manifest, referenceFile);
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, 'predictions.jsonl'), predictions.map(row => JSON.stringify(row)).join('\n') + '\n', { flag: 'wx' });
  fs.writeFileSync(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' });
  const m = grouped.ALL;
  const lines = ['# C su baseline congelata e kernel corrente', '', 'Confronto locale retrospettivo della ricetta fissa C906; nessuna adozione operativa.', '',
    `Input C controllati su ${consumed.rowsChecked} partite; differenze consumate: ${consumed.differingConsumedRows}.`,
    `Probabilità piatte A diverse in ${consumed.flatBaselineDifferingRows} righe: non sono input consumati dalla ricetta C.`,
    `Test: ${predictions.length} partite, 6 fold, tre stagioni; scarto massimo probabilità tra bracci: ${maxPairedDifference}.`,
    `Riproduzione riferimento: scarto massimo ${maxReferenceDifference} (tolleranza 1e-12).`, '',
    '| Ambito | N | Log loss congelata | Log loss proxy | Brier congelato | Brier proxy | ECE10 congelata/proxy | Accuracy congelata/proxy |',
    '|---|---:|---:|---:|---:|---:|---:|---:|'];
  for (const [key, value] of [['ALL', m], ...Object.entries(grouped.byLeague), ...Object.entries(grouped.bySeason)]) {
    const a = value.frozen, b = value.currentProxy, f = x => x.toFixed(6);
    lines.push(`| ${key} | ${a.n} | ${f(a.logLoss)} | ${f(b.logLoss)} | ${f(a.brier)} | ${f(b.brier)} | ${f(a.ece10)} / ${f(b.ece10)} | ${f(a.accuracy)} / ${f(b.accuracy)} |`);
  }
  lines.push('', `IC 95% differenza proxy meno congelato: log loss ${JSON.stringify(intervals.logLossDelta95)}, Brier ${JSON.stringify(intervals.brierDelta95)}.`,
    'Se identici, gli intervalli [0,0] sono condizionati agli input e al modello verificati: non provano equivalenza di tutta APP-A o prestazioni future.', '', ...limitations.map(value => `- ${value}`), '',
    'SHA-256, identità dei sei controlli derivati e risultati per lega/stagione sono in summary.json; previsioni indipendenti dei due bracci in predictions.jsonl.', '');
  fs.writeFileSync(path.join(output, 'REPORT.md'), lines.join('\n'), { flag: 'wx' });
  console.log(JSON.stringify({ output, evaluatedRows: predictions.length, maxPairedDifference, maxReferenceDifference, status: summary.status }));
  return summary;
}
if (require.main === module) { try { main(); } catch (error) { console.error(`scorer failed: ${error.message}`); process.exitCode = 1; } }
module.exports = { uniqueRows, equalIds, project, assertIdentity, validateTemporal, compareConsumed, metrics,
  groupedMetrics, pairedIntervals, diagnosticArtifact, validateReplays, verifySourceHashes, researchHash, optionsOf, main };
