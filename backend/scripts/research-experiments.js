/* Local-only experiment registry. Never connects to TURSO_DATABASE_URL. */
const { createClient } = require('@libsql/client');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname, join } = require('node:path');
const { createHash } = require('node:crypto');
const { ResearchExperimentStore } = require('../dist/research/ResearchExperimentStore');
const [command, ...argv] = process.argv.slice(2);
const args = {};
for (let index = 0; index < argv.length; index += 2) {
  if (!argv[index].startsWith('--') || !argv[index + 1]) throw new Error('Expected --option value');
  args[argv[index].slice(2)] = argv[index + 1];
}
const sha = (value) => createHash('sha256').update(value).digest('hex');
const load = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
const metric = (value) => value ? Object.fromEntries(['n', 'logLoss', 'brier', 'ece', 'calibration']
  .map((key) => [key, value[key]])) : undefined;
const segment = (A, C) => Object.fromEntries([...new Set([...Object.keys(A || {}), ...Object.keys(C || {})])]
  .map((key) => [key, { A: metric(A?.[key]), C: metric(C?.[key]) }]));

function importanceOf(raw, kind) {
  const groups = (raw.featureImportance?.predictionValuesChange || []).filter((group) => group.kind === kind);
  const values = new Map();
  for (const group of groups) for (const value of group.values || []) {
    const current = values.get(value.feature) || { sum: 0, n: 0 };
    current.sum += value.importance; current.n++; values.set(value.feature, current);
  }
  return [...values].map(([feature, value]) => ({ feature, importance: value.sum / value.n }))
    .sort((a, b) => b.importance - a.importance);
}

function recordsOf(raw) {
  if (!raw.datasetHash || !Array.isArray(raw.experiments)) throw new Error('A diagnostics dataset and experiments are required');
  const policy = load(join(__dirname, '../src/research/original-holdout-policy.json'));
  const runId = `diagnosis-${raw.runnerHash.slice(0, 12)}-${raw.datasetHash.slice(0, 12)}`;
  const provenance = { runId, datasetHash: raw.datasetHash, originalReportHash: policy.originalReportSha256 };
  const experiments = [...raw.experiments, ...(raw.negativeControls || [])].map((item) => {
    const fullDefault = item.featureGroup === 'full' && item.historyDays == null && item.timeHalfLifeDays == null
      && item.hyperparameters?.depth === 5 && item.hyperparameters?.iterations === 120;
    return { ...provenance, id: `${runId}:${item.id}`, kind: item.kind, phase: 'development', report: {
      id: item.id, kind: item.kind, featureGroup: item.featureGroup ?? 'no_ml_control', hyperparameters: item.hyperparameters,
      history: { trainingHistoryDays: item.historyDays, timeHalfLifeDays: item.timeHalfLifeDays },
      calibration: item.calibration, metricsA: metric(item.metricsA), metricsC: metric(item.metricsC),
      pairedCI: { logLoss: item.paired?.weekLogLossCI, brier: item.paired?.weekBrierCI,
        weeklyLogLoss: item.paired?.weekLogLossCI, weeklyBrier: item.paired?.weekBrierCI,
        deltaLogLoss: item.paired?.deltaLogLoss, deltaBrier: item.paired?.deltaBrier, n: item.paired?.n },
      byLeague: segment(item.metricsA?.byLeague, item.metricsC?.byLeague),
      bySeason: segment(item.metricsA?.bySeason, item.metricsC?.bySeason),
      byMarket: segment(item.byMarket?.A, item.byMarket?.C),
      featureImportance: fullDefault ? importanceOf(raw, item.kind) : undefined,
      importanceScope: fullDefault ? 'full_default_models_averaged_over_development_folds' : undefined,
      featureMask: item.featureMask, modelArtifactPaths: item.modelArtifactPaths,
      rejectionReasons: ['Risultati di sviluppo: manca un nuovo test futuro indipendente.',
        'Artefatti diagnostici con maschere di feature: non abilitati al runtime.'],
    } };
  });
  experiments.push({ ...provenance, id: `${runId}:summary`, kind: 'DIAGNOSTIC_RUN', phase: 'diagnostic_audit', report: {
    protection: { protectedFinalCount: raw.protection?.excludedFinalN, originalReportHash: policy.originalReportSha256,
      originalFilesUnchanged: raw.protection?.originalFilesUnchanged, newIndependentTestAvailable: false },
    datasetAudit: raw.audit, developmentProtocol: raw.developmentProtocol,
    recommendation: 'A resta il riferimento. I confronti di sviluppo non autorizzano la promozione di C.',
    findings: [
      { severity: 'high', code: 'legacy_probability_incoherence', message: 'La pipeline storica correggeva marginali separati; V2 deriva i mercati da una distribuzione congiunta coerente.' },
      { severity: 'medium', code: 'calibration_confounding', message: 'Il controllo con contributo ML zero separa l’effetto della temperatura da quello di CatBoost.' },
      { severity: 'high', code: 'future_independent_test_missing', message: 'Il campione finale già consultato resta protetto; serve un nuovo periodo futuro.' },
    ], limitations: raw.limitations,
  } });
  return experiments;
}

async function main() {
  if (!args['local-db'] || !['import', 'import-economic', 'export'].includes(command)) throw new Error('Use import --input diagnostics.json --local-db PATH, import-economic --input benchmark.json --calibration MODE --local-db PATH, or export --out PATH --local-db PATH');
  if (/^[a-z]+:\/\//i.test(args['local-db']) || args['local-db'].startsWith('libsql:')) throw new Error('Only a local SQLite path is permitted');
  const path = resolve(args['local-db']); mkdirSync(dirname(path), { recursive: true });
  const client = createClient({ url: `file:${path}` });
  try {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/017_research_experiments.sql'), 'utf8'));
    const store = new ResearchExperimentStore(client);
    if (command === 'import') {
      const result = await store.saveBatch(recordsOf(load(args.input)));
      console.log(JSON.stringify({ localOnly: true, ...result, runtimeCandidatesCreated: 0 }));
    } else if (command === 'import-economic') {
      const report = load(args.input), policy = load(join(__dirname, '../src/research/original-holdout-policy.json'));
      if (!args.calibration || !report.A || !report.C) throw new Error('Economic replay report and --calibration required');
      const id = `observed-snapshot-${sha(readFileSync(resolve(args.input))).slice(0, 20)}`;
      const result = await store.saveBatch([{ id, runId: 'historical-observed-development-20261027',
        kind: 'historical_snapshot_replay', phase: 'development', datasetHash: policy.originalDatasetSha256,
        originalReportHash: policy.originalReportSha256, report: { id, kind: 'historical_snapshot_replay',
          featureGroup: 'full', calibration: args.calibration, metricsA: metric(report.A), metricsC: metric(report.C),
          pairedCI: { logLoss: report.paired?.weekLogLossCI, brier: report.paired?.weekBrierCI,
            deltaLogLoss: report.paired?.deltaLogLoss, deltaBrier: report.paired?.deltaBrier, n: report.paired?.n },
          byLeague: report.byLeague, bySeason: report.bySeason, byMarket: report.byMarket,
          economicAvailable: false, roi: null, clv: null,
          quoteProtocol: 'actual_snapshot_observation_without_provider_update_timestamp',
          rejectionReasons: ['Manca una coorte indipendente di quote per il valore prudenziale.',
            'Campione esplorativo di sviluppo, con timestamp di osservazione e non quote T−15 verificate.'],
        } }]);
      console.log(JSON.stringify({ localOnly: true, ...result, runtimeCandidatesCreated: 0 }));
    } else {
      const rows = await store.list(2000);
      const target = resolve(args.out); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, JSON.stringify(rows));
      console.log(JSON.stringify({ localOnly: true, records: rows.length, sha256: sha(readFileSync(target)) }));
    }
  } finally { client.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
