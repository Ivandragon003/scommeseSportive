/* Registry writes are an explicit CLI operation, never part of training itself. */
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { enrichLifecycleArtifact, enrichCoherentLifecycleArtifact, rebindCoherentTrainerReport,
  registerLifecycleCandidate, registerControlledChallengerCandidate, rollbackUnhealthyChampion } = require('../dist/research/ResearchLifecycle');
const { createHash } = require('node:crypto');

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
  if (!['register', 'rollback-health', 'register-candidate', 'review-challenger'].includes(command)) {
    throw new Error('Commands: finalize; finalize-coherent; register; rollback-health; register-candidate --artifact PATH --dataset PATH --selector POLICY; review-challenger');
  }
  if (command === 'register-candidate' && (!args.artifact || !args.dataset || !args.selector)) {
    throw new Error('--artifact, --dataset and explicit --selector required');
  }
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const db = new DatabaseService();
  try {
    let result;
    if (command === 'review-challenger') {
      result = await db.challengerAdoption.reviewCandidates();
      result = { state: result.state, rollback: result.rollback,
        assessments: result.assessments.map(({ adopted, reason, report, state }) => ({ adopted, reason, state,
          candidateId: report?.candidateId, validation: report?.validation, blockers: report?.blockers })) };
    } else if (command === 'register-candidate') {
      const datasetBytes = readFileSync(resolve(args.dataset));
      result = await registerControlledChallengerCandidate(db, { artifact: load(args.artifact),
        datasetHash: createHash('sha256').update(datasetBytes).digest('hex'),
        datasetRows: JSON.parse(datasetBytes.toString('utf8')).rows, selectorPolicy: args.selector });
    } else result = command === 'rollback-health' ? await rollbackUnhealthyChampion(db)
      : await registerLifecycleCandidate(db, { artifact: load(args.artifact), report: load(args.report),
        datasetRows: args.dataset ? load(args.dataset).rows : undefined });
    console.log(JSON.stringify(result));
  } finally { await db.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
