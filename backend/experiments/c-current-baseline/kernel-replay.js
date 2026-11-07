'use strict';
// Local diagnostic only. This is neither an APP-A replay nor a registerable C dataset.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const backend = path.resolve(__dirname, '../..');
const dist = path.join(backend, 'dist');
const workspace = path.dirname(backend);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const shaFile = file => hash(fs.readFileSync(file));
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const mappedRequest = (request, current) => current && /^\.\.\/(models|config|services)\//.test(request)
  ? path.join(dist, request.slice(3)) : request;
function resolveReferenceSource(source) {
  const unavailable = detail => Error(`historical reference unavailable: ${detail}. Historical sources were removed from this repository; --reference-source must explicitly name an external historical ForecastCore.js with its original dependencies`);
  if (typeof source !== 'string' || !source.trim()) throw unavailable('missing --reference-source');
  let reference;
  try {
    reference = fs.realpathSync(path.resolve(source));
    if (!fs.statSync(reference).isFile() || path.extname(reference) !== '.js') throw Error('not a JavaScript file');
  } catch {
    throw unavailable('the supplied --reference-source is missing or is not a JavaScript file');
  }
  const relative = path.relative(workspace, reference);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw unavailable('--reference-source must be outside this workspace');
  }
  return reference;
}
function loadKernel(current, referenceSource) {
  const reference = resolveReferenceSource(referenceSource);
  const kernel = new Module(reference, module);
  kernel.filename = reference;
  kernel.paths = Module._nodeModulePaths(path.dirname(reference));
  const originalRequire = kernel.require.bind(kernel);
  kernel.require = request => originalRequire(mappedRequest(request, current));
  kernel._compile(fs.readFileSync(reference, 'utf8') + '\nexports.__eligibleHistory = eligibleHistory; exports.__fitBaseline = fitBaseline; exports.__forecastWithFit = forecastWithFit; exports.__normalizeCompetition = normalizeCompetition;', reference);
  return kernel.exports;
}
function targetInput(match) {
  return Object.fromEntries(['matchId', 'homeTeamId', 'awayTeamId', 'date', 'competition', 'season']
    .map(key => [key, match[key]]));
}
function validateInput(matches, dataset, bytesHash, quality, protectedIds) {
  if (!Array.isArray(matches) || !dataset || !Array.isArray(dataset.rows) || !dataset.rows.length
      || !dataset.baselineManifest || !String(dataset.baselineManifest.version).startsWith('A-80cb25df')
      || dataset.reproduction?.matchesFileHash !== bytesHash || dataset.dataQualityPolicyHash !== quality.CHALLENGER_DATA_QUALITY_POLICY_HASH
      || dataset.dataQualityBaselineClean !== true || !Array.isArray(dataset.featureBlocks)
      || !Number.isFinite(Date.parse(dataset.asOf))) throw Error('invalid input, provenance, frozen baseline or data quality policy');
  const byId = new Map();
  for (const m of matches) {
    if (!m || typeof m.matchId !== 'string' || byId.has(m.matchId)) throw Error('invalid or duplicate match identity');
    if (m.availableAt !== undefined && (typeof m.availableAt !== 'string' || !Number.isFinite(Date.parse(m.availableAt)))) throw Error('invalid explicit availableAt');
    byId.set(m.matchId, m);
  }
  const seen = new Set();
  for (const row of dataset.rows) {
    const m = byId.get(row.matchId);
    if (!m || seen.has(row.matchId) || protectedIds.has(row.matchId) || quality.challengerDataQualityReason(row.matchId)
        || !Number.isFinite(Date.parse(row.forecastAt)) || Date.parse(row.forecastAt) >= Date.parse(m.date)
        || row.homeGoals !== m.homeGoals || row.awayGoals !== m.awayGoals) throw Error(`invalid target ${row.matchId}`);
    seen.add(row.matchId);
  }
  return byId;
}
function collectHashes() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p); else if (/\.(js|json)$/.test(entry.name)) files.push(p);
    }
  }
  // Pin all compiled files, including transitive dependencies and configuration.
  walk(dist);
  return Object.fromEntries(files.sort().map(file => [path.relative(backend, file).replace(/\\/g, '/'), shaFile(file)]));
}
function compare(a, b) {
  let max = 0, count = 0, mismatch = null;
  function visit(x, y, key) {
    if (typeof x === 'number' && typeof y === 'number' && Number.isFinite(x) && Number.isFinite(y)) {
      const delta = Math.abs(x - y); max = Math.max(max, delta); count++;
      if (delta > 1e-12 && !mismatch) mismatch = key;
    } else if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) x.forEach((v, i) => visit(v, y[i], `${key}[${i}]`));
    else if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const keys = Object.keys(x).sort();
      if (JSON.stringify(keys) !== JSON.stringify(Object.keys(y).sort())) { if (!mismatch) mismatch = key; }
      else keys.forEach(k => visit(x[k], y[k], `${key}.${k}`));
    } else if (x !== y && !mismatch) mismatch = key;
  }
  visit(a, b, '$');
  return { maxAbsoluteDifference: max, numericValuesCompared: count, firstMismatch: mismatch };
}
function numericDifferences(oldValue, newValue) {
  if (typeof oldValue === 'number' && typeof newValue === 'number') {
    if (!Number.isFinite(oldValue) || !Number.isFinite(newValue)) throw Error('non-finite forecast');
    return newValue - oldValue;
  }
  if (Array.isArray(oldValue) && Array.isArray(newValue) && oldValue.length === newValue.length)
    return oldValue.map((value, index) => numericDifferences(value, newValue[index]));
  if (oldValue && newValue && typeof oldValue === 'object' && typeof newValue === 'object') {
    const keys = Object.keys(oldValue).sort();
    if (JSON.stringify(keys) !== JSON.stringify(Object.keys(newValue).sort())) throw Error('forecast keys differ');
    return Object.fromEntries(keys.map(key => [key, numericDifferences(oldValue[key], newValue[key])]));
  }
  throw Error('forecast shape differs');
}
function cachedForecast(kernel, cache, history, target, forecastAt) {
  const cutoff = Date.parse(forecastAt), competition = kernel.__normalizeCompetition(target.competition);
  const key = `${competition}\0${cutoff}`;
  let fit = cache.get(key);
  if (!fit) {
    const past = kernel.__eligibleHistory(history, target.matchId, cutoff, competition);
    fit = kernel.__fitBaseline(past, cutoff);
    cache.set(key, fit);
  }
  return kernel.__forecastWithFit(history, target, forecastAt, fit);
}
function optionsOf(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    if (!argv[i]?.startsWith('--') || !['matches', 'dataset', 'out', 'limit', 'competition', 'reference-source'].includes(key)
      || !argv[i + 1] || Object.hasOwn(options, key)) throw Error('invalid option');
    options[key] = argv[i + 1];
  }
  if (!options.matches || !options.dataset || !options.out) throw Error('--matches, --dataset and new --out are required');
  if (!options['reference-source']) throw Error('historical reference unavailable: missing --reference-source; historical sources were removed from this repository');
  if (options.limit !== undefined && (!/^\d+$/.test(options.limit) || !Number.isSafeInteger(Number(options.limit)) || Number(options.limit) < 1)) throw Error('invalid limit');
  return options;
}
function main(argv = process.argv.slice(2)) {
  const opts = optionsOf(argv), output = path.resolve(opts.out);
  const referenceFile = resolveReferenceSource(opts['reference-source']);
  if (fs.existsSync(output)) throw Error('output must be new');
  const matchBytes = fs.readFileSync(path.resolve(opts.matches)), matches = JSON.parse(matchBytes);
  const datasetBytes = fs.readFileSync(path.resolve(opts.dataset)), dataset = JSON.parse(datasetBytes);
  const quality = require(path.join(dist, 'research/ChallengerDataQuality'));
  const challenger = require(path.join(dist, 'research/ChallengerFeatures'));
  const holdout = require(path.join(dist, 'research/ResearchHoldoutPolicy'));
  const protectedIds = new Set(holdout.ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds);
  const byId = validateInput(matches, dataset, hash(matchBytes), quality, protectedIds);
  const cleanHistory = quality.filterChallengerHistory(matches);
  const reference = loadKernel(false, referenceFile), current = loadKernel(true, referenceFile);
  if (opts.competition && !reference.TOP5_COMPETITIONS.includes(opts.competition)) throw Error('invalid competition');
  const referenceFits = new Map(), currentFits = new Map();
  if (JSON.stringify(reference.baselineManifest()) !== JSON.stringify(dataset.baselineManifest)) throw Error('frozen manifest differs from canonical dataset');
  const codeHashes = collectHashes();
  const identity = { protocol: 'current-kernel-raw-historical-proxy-v1', frozenForecastCoreHash: shaFile(referenceFile), comparatorHash: shaFile(__filename), codeHashes };
  const fingerprint = hash(JSON.stringify(identity));
  const manifest = { ...identity, fingerprint, version: `experimental-current-kernel-${fingerprint.slice(0, 16)}`,
    description: 'current-kernel raw historical proxy, not APP-A exact', registerable: false };
  const competitionRows = opts.competition ? dataset.rows.filter(row => row.competition === opts.competition) : dataset.rows;
  if (!competitionRows.length) throw Error('selection contains no targets');
  const selected = opts.limit ? competitionRows.slice(0, Number(opts.limit)) : competitionRows;
  const selection = { competition: opts.competition ?? null, limit: opts.limit ? Number(opts.limit) : null, totalCanonicalRows: dataset.rows.length, selectedRows: selected.length };
  const results = [], rows = [];
  for (const canonical of selected) {
    const target = targetInput(byId.get(canonical.matchId));
    const forecast = (kernel, cache) => challenger.withChallengerFeatures({ ...cachedForecast(kernel, cache, cleanHistory, target, canonical.forecastAt),
      dataQualityPolicyHash: quality.CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true }, matches, dataset.featureBlocks);
    const old = forecast(reference, referenceFits);
    // Compare every reconstructed forecast field, including temporal metadata and all features.
    const canonicalForecast = Object.fromEntries(Object.keys(old).map(key => [key, canonical[key]]));
    const verification = compare(old, canonicalForecast);
    if (verification.firstMismatch) throw Error(`frozen reference mismatch ${canonical.matchId}: ${verification.firstMismatch}`);
    const updated = forecast(current, currentFits);
    const diffs = {};
    for (const field of ['features', 'baselineMatrix', 'baselineProbabilities', 'lambdaHome', 'lambdaAway']) diffs[field] = { ...compare(old[field], updated[field]), deltaCurrentMinusFrozen: numericDifferences(old[field], updated[field]) };
    const identityFields = ['matchId', 'competition', 'season', 'homeTeamId', 'awayTeamId', 'kickoffAt', 'forecastAt', 'trainingCount', 'modelFitAt', 'maxTrainingAvailableAt', 'featureNames', 'featureSchema'];
    const identities = compare(Object.fromEntries(identityFields.map(k => [k, old[k]])), Object.fromEntries(identityFields.map(k => [k, updated[k]])));
    if (identities.firstMismatch) throw Error(`kernel identity mismatch ${canonical.matchId}: ${identities.firstMismatch}`);
    results.push({ matchId: canonical.matchId, verification, diffs });
    rows.push({ ...canonical, ...updated, baselineVersion: manifest.version });
  }
  const result = { diagnosticOnly: true, registerable: false, partial: selected.length !== dataset.rows.length,
    label: manifest.description, selection, matchesFileHash: hash(matchBytes), datasetFileHash: hash(datasetBytes), referenceRowsVerified: results.length,
    referenceVerificationTolerance: 1e-12, baselineManifest: manifest, differences: results,
    currentDataset: { ...dataset, baselineManifest: manifest, rows, diagnosticOnly: true, registerable: false,
      experimentalProtocol: manifest.protocol, selection, partial: selected.length !== dataset.rows.length } };
  fs.writeFileSync(output, JSON.stringify(result), { flag: 'wx' });
  console.log(JSON.stringify({ rows: results.length, partial: result.partial, output }));
}
if (require.main === module) { try { main(); } catch (error) { console.error(`kernel replay failed: ${error.message}`); process.exitCode = 1; } }
module.exports = { resolveReferenceSource, loadKernel, mappedRequest, targetInput, validateInput, compare, optionsOf, cachedForecast, main };
