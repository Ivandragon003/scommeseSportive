'use strict';
// Offline wrapper around the unchanged per-match ForecastCore dataset builder.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hashFile = file => sha(fs.readFileSync(file));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const TARGET_FROM = '2019-07-01T00:00:00.000Z', TARGET_UNTIL = '2026-07-01T00:00:00.000Z';

function optionsOf(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    assert(argv[i]?.startsWith('--') && ['plan', 'matches', 'asof', 'out', 'workers', 'partition', 'partitions'].includes(key) && argv[i + 1] && options[key] === undefined, 'Invalid dataset option');
    options[key] = argv[i + 1];
  }
  assert(options.plan && options.matches && options.out && /(?:Z|[+-]\d{2}:\d{2})$/i.test(options.asof ?? '') && Number.isFinite(Date.parse(options.asof)));
  options.workers = Number(options.workers ?? 2); assert(Number.isInteger(options.workers) && options.workers >= 1 && options.workers <= 2, 'At most two workers');
  if (options.partition !== undefined) {
    options.partition = Number(options.partition); options.partitions = Number(options.partitions);
    assert(options.partitions === options.workers && Number.isInteger(options.partition) && options.partition >= 0 && options.partition < options.partitions);
  }
  return options;
}

function buildPartition(history, asOf, competitions, implementation) {
  const runtime = implementation ?? {
    ...require('../../dist/research/ChallengerFeatures'),
    ...require('../../dist/research/ForecastDecisionTime'),
  };
  return runtime.buildChallengerTrainingDataset(history, asOf, {
    blocks: [], targetFrom: TARGET_FROM, targetUntil: TARGET_UNTIL, targetCompetitions: competitions,
    forecastAt: kickoff => runtime.resolveNightlyForecastAt(kickoff, { hour: 3, minute: 7 }),
    forecastPolicy: runtime.NIGHTLY_DECISION_TIME_PROTOCOL,
  });
}

function mergeDatasets(parts) {
  assert(parts.length >= 1 && parts.length <= 2);
  const first = parts[0];
  for (const part of parts) {
    for (const key of ['asOf', 'featureNames', 'featureBlocks', 'forecastTiming', 'targetWindow', 'baselineManifest',
      'dataQualityPolicyHash', 'dataQualityPolicy', 'dataQualityBaselineClean', 'protectedHoldoutPolicyVersion']) assert.deepEqual(part[key], first[key], `Partition mismatch: ${key}`);
    assert.equal(part.featureNames.length, 40); assert.deepEqual(part.featureBlocks, []);
    assert(part.rows.every(row => row.features.length === 40 && row.featureNames.length === 40));
  }
  const combined = { ...first, rows: parts.flatMap(part => part.rows).sort((a, b) => Date.parse(a.forecastAt) - Date.parse(b.forecastAt) || a.matchId.localeCompare(b.matchId)),
    dataQualityEvidence: structuredClone(first.dataQualityEvidence) };
  assert.equal(new Set(combined.rows.map(row => row.matchId)).size, combined.rows.length, 'Duplicate target across partitions');
  combined.exclusions = Object.fromEntries(Object.keys(first.exclusions).map(key => [key, parts.reduce((sum, part) => sum + Number(part.exclusions[key] ?? 0), 0)]));
  combined.protectedMatchesExcluded = parts.reduce((sum, part) => sum + part.protectedMatchesExcluded, 0);
  combined.dataQualityEvidence.targets = {
    ...Object.fromEntries(['inputRows', 'retainedRows', 'excludedRows'].map(key => [key, parts.reduce((sum, part) => sum + part.dataQualityEvidence.targets[key], 0)])),
    excludedMatchIds: [...new Set(parts.flatMap(part => part.dataQualityEvidence.targets.excludedMatchIds))].sort(),
  };
  return combined;
}

async function main(argv = process.argv.slice(2)) {
  const options = optionsOf(argv), planFile = path.resolve(options.plan), matchesFile = path.resolve(options.matches), output = path.resolve(options.out);
  assert(!fs.existsSync(output), 'New dataset output required');
  const plan = read(planFile), planHash = hashFile(planFile), relativeHistory = path.relative(root, matchesFile).split(path.sep).join('/');
  assert.equal(plan.protocol, 'c-five-season-projection-research-v1'); assert.equal(plan.phase, 'input_reconstruction');
  assert.equal(plan.reconstruction.targetFrom, TARGET_FROM); assert.equal(plan.reconstruction.targetUntil, TARGET_UNTIL);
  assert.equal(Date.parse(plan.reconstruction.asOf), Date.parse(options.asof));
  assert(plan.sourceHashes?.[relativeHistory], 'History must be pinned in the frozen plan');
  const check = () => { assert.equal(hashFile(planFile), planHash); for (const [file, hash] of Object.entries(plan.sourceHashes)) assert.equal(hashFile(path.join(root, file)), hash, file); };
  check();
  const { TOP5_COMPETITIONS } = require('../../dist/research/ForecastCore');
  const save = value => fs.writeFileSync(output, JSON.stringify(value), { flag: 'wx' });
  if (options.partition !== undefined) {
    const history = read(matchesFile), competitions = TOP5_COMPETITIONS.filter((_, index) => index % options.partitions === options.partition);
    const dataset = buildPartition(history, options.asof, competitions);
    assert.equal(dataset.featureNames.length, 40); assert.deepEqual(dataset.featureBlocks, []);
    check();
    save({ ...dataset, decisionSchedule: { hour: 3, minute: 7, timezone: 'Europe/Rome' },
      availabilityEvidence: 'kickoff_plus_two_hours_proxy_unverified_ingestion_timestamps', developmentOnly: true,
      reproduction: { matchesFileHash: hashFile(matchesFile), inputMatches: history.length, scriptHash: hashFile(__filename),
        planHash, targetCompetitions: competitions, partition: options.partition, partitions: options.partitions,
        perMatchBaselineFitPreserved: true, weeklyModelReuse: false } });
    return;
  }
  const directory = `${output}.parts`; assert(!fs.existsSync(directory)); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.mkdirSync(directory);
  await Promise.all(Array.from({ length: options.workers }, (_, partition) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--plan', planFile, '--matches', matchesFile, '--asof', options.asof,
      '--out', path.join(directory, `${partition}.json`), '--workers', String(options.workers), '--partition', String(partition), '--partitions', String(options.workers)], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(Error(`Dataset partition ${partition} failed (${code})`)));
  })));
  const parts = Array.from({ length: options.workers }, (_, i) => read(path.join(directory, `${i}.json`)));
  const dataset = mergeDatasets(parts);
  dataset.reproduction = { matchesFileHash: hashFile(matchesFile), scriptHash: hashFile(__filename), planHash,
    workers: options.workers, inputMatches: parts[0].reproduction.inputMatches, perMatchBaselineFitPreserved: true,
    weeklyModelReuse: false, partitions: parts.map(part => part.reproduction) };
  check(); save(dataset);
  console.log(JSON.stringify({ complete: true, rows: dataset.rows.length, features: dataset.featureNames.length, workers: options.workers, datasetHash: hashFile(output) }));
}
module.exports = { main, optionsOf, buildPartition, mergeDatasets, TARGET_FROM, TARGET_UNTIL };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
