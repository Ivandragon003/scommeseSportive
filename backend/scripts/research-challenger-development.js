/* Local files only. Does not load credentials, open a database, contact providers or adopt a model. */
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const { createHash } = require('node:crypto');

function argumentsOf(argv) {
  const command = argv[0], options = {};
  if (!['dataset', 'evaluate'].includes(command)) throw new Error('Expected dataset or evaluate command');
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, '');
    if (!argv[index].startsWith('--') || !argv[index + 1] || Object.hasOwn(options, key)) throw new Error('Expected unique --option value');
    options[key] = argv[index + 1];
  }
  const allowed = command === 'dataset' ? ['matches', 'asof', 'out', 'hour', 'minute', 'from', 'until', 'blocks']
    : ['dataset', 'plan', 'variants', 'quotes', 'out', 'markdown'];
  const required = command === 'dataset' ? ['matches', 'asof', 'out'] : ['dataset', 'plan', 'variants', 'out', 'markdown'];
  if (Object.keys(options).some((key) => !allowed.includes(key)) || required.some((key) => !options[key])) throw new Error('Missing or unknown development option');
  return { command, options };
}
const load = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
const hash = (path) => createHash('sha256').update(readFileSync(resolve(path))).digest('hex');
function save(path, value) {
  const target = resolve(path); mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, typeof value === 'string' ? value : JSON.stringify(value), { flag: 'wx' });
}
function loadVariants(path) {
  const document = load(path), variants = Array.isArray(document) ? document : document.variants;
  if (!Array.isArray(variants)) throw new Error('Variant manifest must contain an array');
  return variants.map((variant) => {
    if (variant.artifact && variant.artifactPath) throw new Error('Specify one artifact source');
    const { artifactPath, ...metadata } = variant;
    return { ...metadata, ...(artifactPath ? { artifact: load(resolve(dirname(resolve(path)), artifactPath)) } : {}),
      ...(variant.folds ? { folds: variant.folds.map((fold) => {
        if (fold.artifact && fold.artifactPath) throw new Error('Specify one fold artifact source');
        const { artifactPath: foldPath, ...foldMetadata } = fold;
        return { ...foldMetadata, ...(foldPath ? { artifact: load(resolve(dirname(resolve(path)), foldPath)) } : {}) };
      }) } : {}) };
  });
}
function loadQuotes(path) {
  if (!path) return {};
  const document = load(path);
  if (!Array.isArray(document)) return document.quotesByMatch ?? document;
  const grouped = {};
  for (const entry of document) {
    if (!entry.matchId || !Array.isArray(entry.quotes)) throw new Error('Quote arrays require matchId and quotes');
    grouped[entry.matchId] ??= []; grouped[entry.matchId].push(...entry.quotes);
  }
  return grouped;
}

function main(argv = process.argv.slice(2)) {
  const { command, options } = argumentsOf(argv);
  const invocation = ['node', 'backend/scripts/research-challenger-development.js', ...argv];
  if (command === 'dataset') {
    const { buildChallengerTrainingDataset } = require('../dist/research/ChallengerFeatures');
    const { resolveNightlyForecastAt, forecastTimestamp, NIGHTLY_DECISION_TIME_PROTOCOL } = require('../dist/research/ForecastDecisionTime');
    const hour = options.hour === undefined ? 3 : Number(options.hour), minute = options.minute === undefined ? 7 : Number(options.minute);
    if (!Number.isFinite(forecastTimestamp(options.asof))) throw new Error('As-of needs an explicit timezone');
    const matches = load(options.matches);
    if (!Array.isArray(matches)) throw new Error('Match export must be an array');
    const dataset = buildChallengerTrainingDataset(matches, options.asof, {
      forecastAt: (kickoff) => resolveNightlyForecastAt(kickoff, { hour, minute }),
      forecastPolicy: NIGHTLY_DECISION_TIME_PROTOCOL, ...(options.blocks ? { blocks: options.blocks.split(',') } : {}),
      targetFrom: options.from, targetUntil: options.until,
    });
    const output = { ...dataset, decisionSchedule: { hour, minute, timezone: 'Europe/Rome' },
      reproduction: { command: invocation, matchesFileHash: hash(options.matches), inputMatches: matches.length,
        timingNote: 'Nominal nightly boundary; no historical execution timestamp is invented. Target window applies to forecastAt.' } };
    save(options.out, output);
    return { action: 'local_nightly_dataset', rows: dataset.rows.length, protectedMatchesExcluded: dataset.protectedMatchesExcluded,
      forecastTiming: dataset.forecastTiming, sourceHash: output.reproduction.matchesFileHash };
  }
  const { evaluateChallengerDevelopment, challengerDevelopmentMarkdown } = require('../dist/research/ChallengerDevelopment');
  const dataset = load(options.dataset), plan = load(options.plan), variants = loadVariants(options.variants);
  if (!dataset || !Array.isArray(dataset.rows)) throw new Error('Expected a Nightly dataset with rows');
  const report = evaluateChallengerDevelopment({ rows: dataset.rows, variants, plan, quotesByMatch: loadQuotes(options.quotes),
    provenance: { datasetFileHash: hash(options.dataset), variantManifestFileHash: hash(options.variants),
      planFileHash: hash(options.plan), quotesFileHash: options.quotes ? hash(options.quotes) : null,
      datasetReproduction: dataset.reproduction ?? null, commands: [invocation] } });
  save(options.out, report);
  save(options.markdown, challengerDevelopmentMarkdown(report, [invocation]));
  return { action: 'local_challenger_development', records: report.coverage.inputMatches, phases: report.coverage.phases,
    certificationEligible: false, variantIds: Object.keys(report.variants), conclusion: report.conclusion };
}
if (require.main === module) {
  try { console.log(JSON.stringify(main())); }
  catch (error) { console.error(`challenger_development_failed: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main, argumentsOf, loadVariants, loadQuotes };
