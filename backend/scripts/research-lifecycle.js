/* Registry writes are an explicit CLI operation, never part of training itself. */
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { enrichLifecycleArtifact, enrichCoherentLifecycleArtifact, rebindCoherentTrainerReport,
  registerLifecycleCandidate, rollbackUnhealthyChampion } = require('../dist/research/ResearchLifecycle');

const [command, ...argv] = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 2) {
  if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('Expected --option value');
  args[argv[i].slice(2)] = argv[i + 1];
}
const load = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
async function main() {
  if (command === 'finalize-coherent') {
    if (!args.artifact || !args.report || !args.out || !args.mode) throw new Error('--artifact, --report, --out and --mode required');
    const artifact = enrichCoherentLifecycleArtifact(load(args.artifact), { mode: args.mode,
      ...(args.temperature ? { temperature: Number(args.temperature) } : {}) });
    const report = rebindCoherentTrainerReport(load(args.report), artifact);
    const directory = resolve(args.out); mkdirSync(directory, { recursive: true });
    const artifactPath = resolve(directory, 'artifact.json'), reportPath = resolve(directory, 'report.json');
    if ([artifactPath, reportPath].some((path) => [resolve(args.artifact), resolve(args.report)].includes(path))) {
      throw new Error('Coherent migration requires a new output directory; original artifacts remain immutable');
    }
    if (existsSync(artifactPath) || existsSync(reportPath)) throw new Error('Coherent output already exists; overwriting an artifact is forbidden');
    writeFileSync(artifactPath, JSON.stringify(artifact), { flag: 'wx' }); writeFileSync(reportPath, JSON.stringify(report), { flag: 'wx' });
    console.log(JSON.stringify({ version: artifact.version, parentVersion: artifact.parentVersion,
      probabilityProtocol: artifact.probabilityProtocol, registryWrites: false }));
    return;
  }
  if (command === 'finalize') {
    if (!args.artifact) throw new Error('--artifact required');
    const artifact = enrichLifecycleArtifact(load(args.artifact));
    writeFileSync(resolve(args.artifact), JSON.stringify(artifact));
    console.log(JSON.stringify({ version: artifact.version, calibrators: Object.keys(artifact.calibrationProfiles || {}), registryWrites: false }));
    return;
  }
  if (!['register', 'rollback-health'].includes(command)) throw new Error('Commands: finalize --artifact PATH; register --artifact PATH --report PATH [--dataset PATH]; rollback-health');
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const db = new DatabaseService();
  try {
    const result = command === 'rollback-health' ? await rollbackUnhealthyChampion(db)
      : await registerLifecycleCandidate(db, { artifact: load(args.artifact), report: load(args.report),
        datasetRows: args.dataset ? load(args.dataset).rows : undefined });
    console.log(JSON.stringify(result));
  } finally { await db.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
