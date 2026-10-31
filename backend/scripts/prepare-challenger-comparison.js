/* Local files only: finalize every declared arm on its own calibration partition. */
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { resolve, join, relative } = require('node:path');
const { createHash } = require('node:crypto');
const { enrichCoherentLifecycleArtifact } = require('../dist/research/ResearchLifecycle');
const { buildProbabilityConfiguration } = require('../dist/research/ProbabilityConfiguration');

const load = file => JSON.parse(readFileSync(file, 'utf8'));
const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx' });

function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, '');
    if (!argv[index].startsWith('--') || !argv[index + 1] || Object.hasOwn(args, key)
      || !['training', 'dataset', 'out', 'incumbent', 'incumbent-registry'].includes(key)) throw new Error('Expected unique --option value');
    args[key] = argv[index + 1];
  }
  if (!args.training || !args.dataset || !args.out || !!args.incumbent !== !!args['incumbent-registry']) {
    throw new Error('--training, --dataset and new --out required; incumbent and incumbent-registry must be supplied together');
  }
  const training = resolve(args.training), out = resolve(args.out), report = load(join(training, 'report.json'));
  const datasetBytes = readFileSync(resolve(args.dataset)), dataset = JSON.parse(datasetBytes);
  const datasetHash = createHash('sha256').update(datasetBytes).digest('hex');
  if (report.schemaVersion !== 'controlled-challenger-development-v1' || report.datasetHash !== datasetHash
    || !Array.isArray(report.arms) || !report.arms.length || !Array.isArray(report.folds) || !report.folds.length
    || !Number.isFinite(Date.parse(dataset.asOf))) throw new Error('Controlled report and dataset must match');
  if (existsSync(out)) throw new Error('Output directory must be new');
  mkdirSync(out, { recursive: true });
  const variants = [];
  for (const arm of report.arms) {
    if (!/^[a-z_]+$/.test(arm.name)) throw new Error('Invalid controlled arm name');
    const folds = report.folds.map(fold => {
      if (!Number.isSafeInteger(fold.fold) || fold.fold < 0 || fold.fold > 7) throw new Error('Invalid fold');
      const artifact = enrichCoherentLifecycleArtifact(load(join(training, `fold-${fold.fold}`, arm.name, 'artifact.json')),
        { mode: 'isotonic_1x2' });
      if (artifact.datasetHash !== datasetHash) throw new Error('Fold dataset mismatch');
      const artifactPath = `fold-${fold.fold}-${arm.name}.json`;
      save(join(out, artifactPath), artifact);
      return { from: fold.trainingSplit.test.from,
        until: new Date(Date.parse(fold.trainingSplit.test.to) + 1).toISOString(), artifactPath };
    });
    variants.push({ id: arm.name, role: arm.name === 'no_ml' ? 'no_ml' : 'ablation',
      availability: 'retrospective_development', selectionPolicy: 'payout-aware-v1', folds });
  }
  if (args.incumbent) {
    const artifact = load(resolve(args.incumbent)), registry = load(resolve(args['incumbent-registry']));
    const config = value => buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
      pipelineHashV2: value.pipelineHashV2, mode: value.probabilityCalibrationMode,
      temperature: value.probabilityTemperature, profile: value.calibrationProfilesV2?.C }).hash;
    if (registry.modelVersion !== artifact.version || config(registry.benchmark ?? artifact) !== config(artifact)) {
      throw new Error('Effective incumbent configuration must match the frozen artifact');
    }
    const dates = [artifact.createdAt, registry.artifactCreatedAt, registry.benchmarkCreatedAt].filter(Boolean).map(Date.parse);
    if (dates.some(value => !Number.isFinite(value))) throw new Error('Incumbent availability must be known');
    const availableAt = new Date(Math.max(...dates)).toISOString();
    save(join(out, 'incumbent.json'), artifact);
    const incumbentLabel = artifact.version === 'C-906371b0b3a1e2c8' ? 'C906' : 'incumbent';
    for (const selectionPolicy of ['legacy-c906', 'payout-aware-v1']) {
      const suffix = selectionPolicy === 'legacy-c906' ? '' : '_new_selector';
      variants.push({ id: `actual_${incumbentLabel}${suffix}`, role: 'current', availability: 'recorded_available',
        from: availableAt, selectionPolicy, artifactPath: 'incumbent.json' });
      variants.push({ id: `${incumbentLabel}_reconstructed${suffix}`, role: 'ablation', availability: 'retrospective_development',
        selectionPolicy, artifactPath: 'incumbent.json' });
    }
  }
  const schedule = dataset.decisionSchedule ?? { hour: 3, minute: 7 };
  save(join(out, 'variants.json'), { variants });
  save(join(out, 'plan.json'), { asOf: dataset.asOf, developmentFrom: '1900-01-01T00:00:00.000Z',
    developmentUntil: dataset.asOf, independentFrom: new Date(Date.parse(dataset.asOf) + 1).toISOString(),
    schedule: { hour: schedule.hour, minute: schedule.minute }, allowedMarkets: ['1x2', 'totals', 'asian_handicap'],
    initialBankrollCents: 100000, bootstrapSamples: 500, seed: 20261031 });
  return { out: relative(process.cwd(), out), variants: variants.length, datasetHash, registryWrites: false };
}

if (require.main === module) {
  try { console.log(JSON.stringify(main())); }
  catch (error) { console.error(`comparison_preparation_failed: ${error.message}`); process.exitCode = 1; }
}
module.exports = { main };
