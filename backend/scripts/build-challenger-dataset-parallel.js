/* C-only historical reconstruction; no credentials, database access or provider calls. */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { buildChallengerTrainingDataset } = require('../dist/research/ChallengerFeatures');
const { TOP5_COMPETITIONS } = require('../dist/research/ForecastCore');
const { resolveNightlyForecastAt, NIGHTLY_DECISION_TIME_PROTOCOL } = require('../dist/research/ForecastDecisionTime');

function optionsOf(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!argv[index]?.startsWith('--') || !argv[index + 1] || Object.hasOwn(options, key)
      || !['matches', 'asof', 'out', 'workers', 'partition', 'partitions'].includes(key)) throw Error('Invalid C dataset option');
    options[key] = argv[index + 1];
  }
  if (!options.matches || !options.asof || !options.out || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(options.asof)
    || !Number.isFinite(Date.parse(options.asof))) throw Error('--matches, --asof with timezone, and a new --out are required');
  return options;
}
function save(file, value) { fs.writeFileSync(file, JSON.stringify(value), { flag: 'wx' }); }
async function main(argv = process.argv.slice(2)) {
  const options = optionsOf(argv), output = path.resolve(options.out);
  if (fs.existsSync(output)) throw Error('Output must be new');
  const workers = Number(options.workers ?? 5);
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 5) throw Error('Workers must be between one and five');
  if (options.partition !== undefined) {
    const partition = Number(options.partition), partitions = Number(options.partitions);
    if (!Number.isSafeInteger(partition) || !Number.isSafeInteger(partitions)
      || partitions !== workers || partition < 0 || partition >= partitions) throw Error('Invalid C dataset partition');
    const bytes = fs.readFileSync(path.resolve(options.matches)), matches = JSON.parse(bytes);
    const targetCompetitions = TOP5_COMPETITIONS.filter((_, index) => index % partitions === partition);
    const dataset = buildChallengerTrainingDataset(matches, options.asof, {
      forecastAt: kickoff => resolveNightlyForecastAt(kickoff, { hour: 3, minute: 7 }),
      forecastPolicy: NIGHTLY_DECISION_TIME_PROTOCOL, targetCompetitions,
    });
    save(output, { ...dataset, decisionSchedule: { hour: 3, minute: 7, timezone: 'Europe/Rome' },
      availabilityEvidence: 'kickoff_plus_two_hours_proxy_unverified_ingestion_timestamps', developmentOnly: true,
      reproduction: { matchesFileHash: createHash('sha256').update(bytes).digest('hex'), inputMatches: matches.length,
        targetCompetitions, partition, partitions } });
    console.log(JSON.stringify({ partition, rows: dataset.rows.length, complete: true }));
    return;
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const parts = `${output}.parts`;
  if (fs.existsSync(parts)) throw Error('Partition directory must be new');
  fs.mkdirSync(parts);
  await Promise.all(Array.from({ length: workers }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [__filename, '--matches', path.resolve(options.matches), '--asof', options.asof,
      '--out', path.join(parts, `${index}.json`), '--workers', String(workers), '--partition', String(index),
      '--partitions', String(workers)], { stdio: 'inherit', windowsHide: true });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(Error(`C dataset partition ${index} failed`)));
  })));
  const datasets = Array.from({ length: workers }, (_, index) => JSON.parse(fs.readFileSync(path.join(parts, `${index}.json`))));
  const combined = { ...datasets[0], rows: datasets.flatMap(dataset => dataset.rows)
    .sort((a, b) => Date.parse(a.forecastAt) - Date.parse(b.forecastAt) || a.matchId.localeCompare(b.matchId)) };
  if (new Set(combined.rows.map(row => row.matchId)).size !== combined.rows.length
    || datasets.some(dataset => dataset.asOf !== combined.asOf || dataset.dataQualityPolicyHash !== combined.dataQualityPolicyHash
      || JSON.stringify(dataset.baselineManifest) !== JSON.stringify(combined.baselineManifest))) throw Error('C dataset partitions disagree');
  combined.exclusions = Object.fromEntries(Object.keys(combined.exclusions).map(key =>
    [key, datasets.reduce((sum, dataset) => sum + Number(dataset.exclusions[key] ?? 0), 0)]));
  combined.protectedMatchesExcluded = datasets.reduce((sum, dataset) => sum + dataset.protectedMatchesExcluded, 0);
  combined.dataQualityEvidence.targets = {
    inputRows: datasets.reduce((sum, dataset) => sum + dataset.dataQualityEvidence.targets.inputRows, 0),
    retainedRows: datasets.reduce((sum, dataset) => sum + dataset.dataQualityEvidence.targets.retainedRows, 0),
    excludedRows: datasets.reduce((sum, dataset) => sum + dataset.dataQualityEvidence.targets.excludedRows, 0),
    excludedMatchIds: [...new Set(datasets.flatMap(dataset => dataset.dataQualityEvidence.targets.excludedMatchIds))].sort(),
  };
  combined.reproduction = { matchesFileHash: datasets[0].reproduction.matchesFileHash,
    inputMatches: datasets[0].reproduction.inputMatches, workers,
    command: ['node', 'backend/scripts/build-challenger-dataset-parallel.js', ...argv],
    partitions: datasets.map(dataset => dataset.reproduction) };
  save(output, combined);
  console.log(JSON.stringify({ complete: true, rows: combined.rows.length, protectedMatchesExcluded: combined.protectedMatchesExcluded,
    dataQualityPolicyHash: combined.dataQualityPolicyHash }));
}
if (require.main === module) main().catch(error => { console.error(`C dataset reconstruction failed: ${error.message}`); process.exitCode = 1; });
module.exports = { main, optionsOf };
