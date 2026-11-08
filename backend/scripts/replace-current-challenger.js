/* Explicit C-only replacement. No application bootstrap, migrations or automatic promotion. */
const { createClient } = require('@libsql/client');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync, writeFileSync, existsSync, openSync, closeSync, writeSync, ftruncateSync, fsyncSync } = require('node:fs');
const { resolve } = require('node:path');
const compiled = process.env.RESEARCH_TEST_DIST || '../dist';
const moduleOf = name => require(resolve(__dirname, compiled, 'research', name));
const { researchHash, researchJson } = moduleOf('ResearchStore');
const { validateArtifact } = moduleOf('CatBoostModel');
const { baselineManifest } = moduleOf('ForecastCore');
const { buildProbabilityConfiguration } = moduleOf('ProbabilityConfiguration');
const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = moduleOf('CoherentProbabilityPipeline');
const { CURRENT_CHALLENGER_RELEASE } = moduleOf('CurrentChallengerRelease');
const { CHALLENGER_TEAM_MARKETS, CHALLENGER_TEAM_MARKET_POLICY } = moduleOf('ChallengerMarketCoverage');
const HOST = 'footpredictor-selloneciompi.aws-eu-west-1.turso.io';
const PROTOCOL = 'explicit-current-challenger-replacement-v1';
const sha = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, researchJson(value) + '\n', { flag: 'wx', mode: 0o600 });
const rows = async (db, sql, args = []) => (await db.execute({ sql, args })).rows.map(row => ({ ...row }));
const first = async (db, sql, args) => (await rows(db, sql, args))[0] ?? null;
const same = (a, b) => researchHash(a) === researchHash(b);
function writeJournal(fd, value) {
  const bytes = Buffer.from(researchJson(value) + '\n');
  let offset = 0;
  while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset, offset);
  ftruncateSync(fd, bytes.length); fsyncSync(fd);
}

function endpoint(value, expectedHost) {
  if (expectedHost !== HOST) throw Error('explicit_expected_host_required');
  if (String(value).startsWith('file:')) return { url: value, host: value };
  const target = new URL(String(value).replace(/^libsql:/, 'https:'));
  if (target.protocol !== 'https:' || target.hostname !== expectedHost || target.port || target.username || target.password
    || target.search || target.hash || target.pathname !== '/') throw Error('database_endpoint_mismatch');
  return { url: target.href, host: target.hostname };
}
function deployment(artifact) {
  validateArtifact(artifact);
  if (artifact.baselineVersion !== baselineManifest().version || artifact.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL
    || artifact.pipelineHashV2 !== coherentProbabilityPipelineHash() || artifact.diagnosticOnly === true
    || artifact.runtimeCompatible === false || artifact.productionAdoptionEligible === false) throw Error('artifact_configuration_invalid');
  return { modelVersion: artifact.version, baselineVersion: artifact.baselineVersion, selectorPolicy: 'canonical-binary-v1',
    probabilityConfigurationHash: buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
      pipelineHashV2: artifact.pipelineHashV2, mode: artifact.probabilityCalibrationMode,
      temperature: artifact.probabilityTemperature, profile: artifact.calibrationProfilesV2?.C }).hash,
    artifactHash: researchHash(artifact) };
}
function packagedRelease() {
  const artifact = read(resolve(__dirname, '../current-models/challenger.json'));
  const target = deployment(artifact);
  if (!same(target, CURRENT_CHALLENGER_RELEASE) || artifact.status !== 'CURRENT'
    || artifact.availability !== 'packaged_explicit_user_release' || artifact.productionValidated !== false
    || artifact.independentEvidence !== false || artifact.releaseAdoption?.authorization !== 'explicit_user_instruction'
    || artifact.releaseAdoption?.protocol !== 'explicit-user-tree-sample-projection-release-v1'
    || artifact.releaseAdoption?.productionValidated !== false || artifact.releaseAdoption?.independentEvidence !== false) {
    throw Error('packaged_manual_release_invalid');
  }
  return { artifact, target };
}
async function inspect(db, { host, previousVersion, previousArtifactHash, target }) {
  const schema = await rows(db, "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name");
  const required = ['research_models', 'research_markets', 'research_market_events', 'challenger_adoption_events'];
  if (required.some(name => !schema.some(row => row.type === 'table' && row.name === name))) throw Error('registry_schema_missing');
  const latestEvent = await first(db, 'SELECT * FROM challenger_adoption_events ORDER BY sequence DESC LIMIT 1');
  const models = await rows(db, "SELECT * FROM research_models WHERE family='C' AND version IN (?,?) ORDER BY version", [previousVersion, target.modelVersion]);
  const previousModel = models.find(row => row.version === previousVersion);
  if (!previousModel || previousModel.artifact_hash !== previousArtifactHash
    || researchHash(JSON.parse(previousModel.artifact_json)) !== previousArtifactHash) throw Error('previous_artifact_mismatch');
  const previous = deployment(JSON.parse(previousModel.artifact_json));
  if (previous.modelVersion === target.modelVersion || previous.baselineVersion !== target.baselineVersion) throw Error('replacement_identity_invalid');
  if (latestEvent && (latestEvent.action === 'SUSPEND' || !same(JSON.parse(latestEvent.deployment_json), previous))) throw Error('current_deployment_mismatch');
  const registered = models.find(row => row.version === target.modelVersion);
  if (registered && (registered.artifact_hash !== target.artifactHash || researchHash(JSON.parse(registered.artifact_json)) !== target.artifactHash)) throw Error('new_artifact_conflict');
  const markets = await rows(db, "SELECT * FROM research_markets WHERE family='C' AND model_version IN (?,?) ORDER BY model_version,market", [previousVersion, target.modelVersion]);
  if (markets.some(row => row.model_version === target.modelVersion && row.state !== 'EXPERIMENTAL')) throw Error('new_market_state_conflict');
  const marketEvents = await rows(db, "SELECT * FROM research_market_events WHERE family='C' AND model_version IN (?,?) ORDER BY created_at,id", [previousVersion, target.modelVersion]);
  return { host, schemaHash: researchHash(schema), schema, latestEvent, previous, models, markets, marketEvents };
}
async function planReplacement(db, options, backupPath) {
  const { artifact, target } = packagedRelease();
  const tx = await db.transaction('read');
  let snapshot;
  try { snapshot = await inspect(tx, { ...options, target }); } finally { await tx.rollback(); tx.close(); }
  const backup = { format: 'scoped-current-c-backup-v1', createdAt: new Date().toISOString(), snapshot };
  const backupBytes = researchJson(backup) + '\n';
  const plan = { format: PROTOCOL, createdAt: backup.createdAt, host: options.host,
    previousVersion: options.previousVersion, previousArtifactHash: options.previousArtifactHash,
    target, artifactHash: researchHash(artifact), snapshotHash: researchHash(snapshot),
    backupPath: resolve(backupPath), backupHash: sha(backupBytes),
    missingMarkets: CHALLENGER_TEAM_MARKETS.filter(market => !snapshot.markets.some(row => row.model_version === target.modelVersion && row.market === market)),
    manualReplacement: true, independentEvidence: false, retirePrevious: true, productionValidated: false };
  return { plan, backup };
}
async function applyReplacement(db, plan, backup, planHash) {
  const { artifact, target } = packagedRelease();
  if (plan.format !== PROTOCOL || !same(plan.target, target) || plan.artifactHash !== researchHash(artifact)
    || backup.format !== 'scoped-current-c-backup-v1' || sha(researchJson(backup) + '\n') !== plan.backupHash
    || researchHash(backup.snapshot) !== plan.snapshotHash
    || plan.manualReplacement !== true || plan.independentEvidence !== false || plan.retirePrevious !== true
    || plan.productionValidated !== false || researchHash(plan) !== planHash) throw Error('plan_or_backup_invalid');
  const tx = await db.transaction('write');
  let id;
  try {
    const snapshot = await inspect(tx, { host: plan.host, previousVersion: plan.previousVersion,
      previousArtifactHash: plan.previousArtifactHash, target });
    if (!same(snapshot, backup.snapshot)) throw Error('planned_state_changed');
    const missing = CHALLENGER_TEAM_MARKETS.filter(market => !snapshot.markets.some(row => row.model_version === target.modelVersion && row.market === market));
    if (!same(missing, plan.missingMarkets)) throw Error('planned_markets_changed');
    const now = new Date().toISOString();
    if (!snapshot.models.some(row => row.version === target.modelVersion)) {
      await tx.execute({ sql: "INSERT INTO research_models(family,version,artifact_json,artifact_hash,created_at) VALUES ('C',?,?,?,?)",
        args: [target.modelVersion, researchJson(artifact), target.artifactHash, now] });
    }
    const evidence = { protocol: PROTOCOL, manualReplacement: true, independentEvidence: false, retirePrevious: true,
      userDecision: 'Explicit user request to replace current C despite inconclusive statistical evidence',
      productionValidated: false, planHash, backupHash: plan.backupHash, marketPolicyVersion: CHALLENGER_TEAM_MARKET_POLICY };
    for (const market of missing) {
      await tx.execute({ sql: "INSERT INTO research_markets(family,model_version,market,state,evidence_json,updated_at) VALUES ('C',?,?,'EXPERIMENTAL',?,?)",
        args: [target.modelVersion, market, researchJson(evidence), now] });
      await tx.execute({ sql: "INSERT INTO research_market_events(id,family,model_version,market,previous_state,state,evidence_json,reason,created_at) VALUES (?,'C',?,?,NULL,'EXPERIMENTAL',?,'explicit current C replacement',?)",
        args: [randomUUID(), target.modelVersion, market, researchJson(evidence), now] });
    }
    id = randomUUID();
    await tx.execute({ sql: "INSERT INTO challenger_adoption_events(id,action,candidate_id,deployment_json,previous_json,evidence_json,evidence_hash,created_at) VALUES (?,'ADOPT',NULL,?,?,?,?,?)",
      args: [id, researchJson(target), researchJson(snapshot.previous), researchJson(evidence), researchHash(evidence), now] });
    const saved = await first(tx, 'SELECT * FROM challenger_adoption_events WHERE id=?', [id]);
    if (!saved || !same(JSON.parse(saved.deployment_json), target)) throw Error('transaction_verification_failed');
    await tx.commit();
  } catch (error) { await tx.rollback().catch(() => undefined); throw error; } finally { tx.close(); }
  const adopted = await first(db, 'SELECT * FROM challenger_adoption_events ORDER BY sequence DESC LIMIT 1');
  const registered = await first(db, "SELECT artifact_hash FROM research_models WHERE family='C' AND version=?", [target.modelVersion]);
  const markets = await rows(db, "SELECT market,state FROM research_markets WHERE family='C' AND model_version=? ORDER BY market", [target.modelVersion]);
  if (adopted?.id !== id || registered?.artifact_hash !== target.artifactHash
    || CHALLENGER_TEAM_MARKETS.some(market => !markets.some(row => row.market === market && row.state === 'EXPERIMENTAL'))) throw Error('post_commit_verification_failed');
  return { format: 'current-c-replacement-receipt-v1', verifiedAt: new Date().toISOString(), host: plan.host,
    planHash, backupHash: plan.backupHash, deployment: target, adoptionEvent: adopted, markets,
    verified: true, productionValidated: false, independentEvidence: false,
    historicalRecordsPreserved: true, writes: ['research_models INSERT if absent', 'research_markets INSERT if absent',
      'research_market_events INSERT if absent', 'challenger_adoption_events INSERT'] };
}
function parseArgs(args) {
  const opts = {};
  const allowed = ['plan', 'apply', 'expected-host', 'previous-version', 'previous-artifact-hash', 'expected-plan-hash', 'backup', 'receipt', 'database'];
  for (let i = 0; i < args.length; i++) {
    const key = args[i].replace(/^--/, '');
    if (args[i] !== `--${key}` || !allowed.includes(key) || opts[key] || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('invalid_arguments');
    opts[key] = args[++i];
  }
  if (!!opts.plan === !!opts.apply || !opts.backup || !opts['previous-version'] || !/^[a-f0-9]{64}$/.test(opts['previous-artifact-hash'] || '')
    || opts.apply && (!opts.receipt || !opts['expected-plan-hash']) || opts.plan && (opts.receipt || opts['expected-plan-hash'])) throw Error('explicit_plan_or_apply_required');
  return opts;
}
async function main(args = process.argv.slice(2), env = process.env) {
  const opts = parseArgs(args), target = endpoint(opts.database || env.TURSO_DATABASE_URL, opts['expected-host']);
  const local = target.url.startsWith('file:');
  if (local && (!opts.database || !existsSync(target.url.slice(5)))) throw Error('existing_explicit_local_database_required');
  const token = opts.apply ? env.TURSO_AUTH_TOKEN : env.TURSO_WATCHDOG_READONLY_TOKEN;
  if (!local && !token) throw Error(opts.apply ? 'write_token_required' : 'readonly_token_required');
  const paths = [opts.plan || opts.apply, opts.backup, ...(opts.receipt ? [opts.receipt] : [])].map(path => resolve(path));
  if (new Set(paths).size !== paths.length) throw Error('distinct_output_paths_required');
  if (opts.plan && paths.some(existsSync) || opts.apply && existsSync(resolve(opts.receipt))) throw Error('output_already_exists');
  const db = createClient({ url: target.url, ...(local ? {} : { authToken: token }) });
  try {
    if (opts.plan) {
      const { plan, backup } = await planReplacement(db, { host: target.host, previousVersion: opts['previous-version'],
        previousArtifactHash: opts['previous-artifact-hash'] }, opts.backup);
      save(opts.backup, backup); save(opts.plan, plan);
      console.log(JSON.stringify({ action: 'read_only_plan', planPath: resolve(opts.plan), backupPath: resolve(opts.backup), planHash: researchHash(plan), target: plan.target }));
    } else {
      const plan = read(opts.apply), bytes = readFileSync(opts.backup);
      if (plan.host !== target.host || plan.previousVersion !== opts['previous-version'] || plan.previousArtifactHash !== opts['previous-artifact-hash']
        || plan.backupPath !== resolve(opts.backup) || plan.backupHash !== sha(bytes)) throw Error('plan_endpoint_or_backup_mismatch');
      // Reserve and flush the receipt before starting any database mutation.
      const fd = openSync(opts.receipt, 'wx', 0o600);
      const pending = { format: 'current-c-replacement-receipt-v1', status: 'PENDING', verified: false,
        planHash: opts['expected-plan-hash'], backupHash: plan.backupHash, host: plan.host, deployment: plan.target,
        startedAt: new Date().toISOString(), recovery: 'Inspect the deployment registry before retrying an incomplete replacement.' };
      try {
        writeJournal(fd, pending);
        const receipt = await applyReplacement(db, plan, JSON.parse(bytes.toString('utf8')), opts['expected-plan-hash']);
        writeJournal(fd, { ...receipt, status: 'COMPLETE' });
        console.log(JSON.stringify({ action: 'applied', receiptPath: resolve(opts.receipt), deployment: receipt.deployment, verified: receipt.verified }));
      } catch {
        try { writeJournal(fd, { ...pending, status: 'FAILED_UNKNOWN', verified: false }); } catch { /* Keep the reserved journal for recovery. */ }
        throw Error('replacement_failed_check_pending_receipt');
      } finally { closeSync(fd); }
    }
  } finally { db.close(); }
}
module.exports = { endpoint, deployment, packagedRelease, inspect, planReplacement, applyReplacement, parseArgs, main };
if (require.main === module) main().catch(error => {
  const code = /^[a-z][a-z0-9_]{0,127}$/.test(error.message || '') ? error.message : 'replacement_failed';
  console.error(`Current C replacement failed: ${code}`); process.exitCode = 1;
});
