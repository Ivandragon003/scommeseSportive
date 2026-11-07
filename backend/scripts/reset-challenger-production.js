'use strict';
// Explicit maintenance only. Importing this module never opens a database.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { inspectOperational, resetOperational, sha } = require('./reset-challenger-history');
const { planSharedArchives, applySharedArchives } = require('./lib/challenger-archive-reset');

const HOST = 'footpredictor-selloneciompi.aws-eu-west-1.turso.io';
async function fileHash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}
function argumentsOf(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--plan', '--apply', '--database', '--expected-host', '--backup-manifest', '--expected-plan-hash', '--receipt'].includes(key)
      || Object.hasOwn(options, key) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('invalid_arguments');
    options[key] = args[++i];
  }
  if (Boolean(options['--plan']) === Boolean(options['--apply'])) throw Error('select_plan_or_apply');
  return options;
}
function targetFor(options, env = process.env) {
  if (options['--database']) {
    const file = path.resolve(options['--database']);
    if (!fs.statSync(file).isFile()) throw Error('local_database_missing');
    return { url: `file:${file}`, identity: { kind: 'local', file } };
  }
  const url = new URL(env.TURSO_DATABASE_URL);
  if (!['libsql:', 'https:'].includes(url.protocol) || url.hostname !== HOST || options['--expected-host'] !== HOST
    || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw Error('unexpected_production_target');
  return { url: env.TURSO_DATABASE_URL, identity: { kind: 'production', host: HOST }, authToken: env.TURSO_AUTH_TOKEN };
}
async function verifiedBackup(manifestPath, target) {
  const absolute = path.resolve(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const directory = path.dirname(absolute);
  if (!manifest.complete || !manifest.verification?.readable || manifest.verification.foreignKeyViolations !== 0
    || manifest.verification.integrity?.join(',') !== 'ok'
    || target.kind === 'production' && manifest.databaseHost !== HOST) throw Error('verified_backup_required');
  const database = path.join(directory, 'restore.db'), dump = path.join(directory, 'database.sql');
  if (await fileHash(database) !== manifest.verification.databaseSha256 || await fileHash(dump) !== manifest.dump.sha256) {
    throw Error('backup_hash_mismatch');
  }
  if (target.kind === 'local' && path.resolve(database) === target.file) throw Error('cannot_mutate_backup');
  return { manifestSha256: await fileHash(absolute), databaseSha256: manifest.verification.databaseSha256,
    dumpSha256: manifest.dump.sha256, startedAt: manifest.startedAt, databaseHost: manifest.databaseHost };
}
async function buildPlan(db, target, cutoff) {
  if (!Number.isFinite(Date.parse(cutoff)) || new Date(cutoff).toISOString() !== cutoff) throw Error('invalid_cutoff');
  const marker = await db.execute("SELECT last_tick_json FROM research_worker_state WHERE scheduler='challenger_history_reset'");
  if (marker.rows.length) throw Error('challenger_reset_already_applied');
  const adoption = await db.execute('SELECT COUNT(*) AS n FROM challenger_adoption_events');
  const paired = await db.execute('SELECT COUNT(*) AS n FROM challenger_paired_forecasts');
  const operational = await inspectOperational(db), shared = await planSharedArchives(db);
  const content = { format: 'challenger-history-reset-plan-v1', target, cutoff, openingCents: 100000,
    operational, shared, adoptionEvents: Number(adoption.rows[0].n), pairedForecastsToRemove: Number(paired.rows[0].n) };
  return { ...content, planHash: sha(content) };
}
async function applyPlan(db, plan, backup) {
  const tx = await db.transaction('write');
  try {
    const current = await buildPlan(tx, plan.target, plan.cutoff);
    if (current.planHash !== plan.planHash) throw Error('reset_plan_changed');
    await resetOperational(tx, current.operational, plan.cutoff);
    const archives = await applySharedArchives(tx, current.shared);
    await tx.execute({ sql: `INSERT INTO research_worker_state(scheduler,last_tick_json,updated_at)
      VALUES('challenger_history_reset',?,?)`, args: [JSON.stringify({ cutoff: plan.cutoff,
      protocol: 'challenger-history-reset-v1', planHash: plan.planHash, backupSha256: backup.databaseSha256 }), plan.cutoff] });
    const foreignKeys = await tx.execute('PRAGMA foreign_key_check');
    if (foreignKeys.rows.length) throw Error('foreign_key_violation_after_reset');
    const balance = await tx.execute("SELECT SUM(available_delta_cents) AS available,SUM(committed_delta_cents) AS committed FROM research_ledger WHERE portfolio_id='shadow_C'");
    if (Number(balance.rows[0].available) !== 100000 || Number(balance.rows[0].committed) !== 0) throw Error('c_opening_balance_mismatch');
    await tx.commit();
    return { action: 'challenger_history_reset', planHash: plan.planHash, cutoff: plan.cutoff,
      openingCents: 100000, committedCents: 0, archives, backup, foreignKeyViolations: 0 };
  } catch (error) { await tx.rollback(); throw error; }
}
async function main(args = process.argv.slice(2)) {
  const options = argumentsOf(args), target = targetFor(options);
  const client = createClient({ url: target.url, authToken: target.authToken });
  try {
    if (options['--plan']) {
      if (fs.existsSync(options['--plan'])) throw Error('plan_output_exists');
      const plan = await buildPlan(client, target.identity, new Date().toISOString());
      fs.writeFileSync(options['--plan'], JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ action: 'plan_only', planHash: plan.planHash, cutoff: plan.cutoff,
        operationalTables: Object.keys(plan.operational.targets), pairedForecastsToRemove: plan.pairedForecastsToRemove }));
      return;
    }
    if (!options['--backup-manifest'] || !options['--receipt'] || !/^[a-f0-9]{64}$/.test(options['--expected-plan-hash'] || '')) throw Error('apply_requires_reviewed_plan_and_backup');
    if (fs.existsSync(options['--receipt'])) throw Error('receipt_output_exists');
    const plan = JSON.parse(fs.readFileSync(options['--apply'], 'utf8'));
    const { planHash, ...content } = plan;
    if (planHash !== options['--expected-plan-hash'] || sha(content) !== planHash || sha(plan.target) !== sha(target.identity)) throw Error('plan_identity_mismatch');
    const backup = await verifiedBackup(options['--backup-manifest'], target.identity);
    const receipt = await applyPlan(client, plan, backup);
    fs.writeFileSync(options['--receipt'], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(receipt));
  } finally { client.close(); }
}
module.exports = { HOST, argumentsOf, targetFor, verifiedBackup, buildPlan, applyPlan, fileHash };
if (require.main === module) main().catch(error => { console.error(/^[a-z_]+$/.test(error.message) ? error.message : 'challenger_reset_failed'); process.exitCode = 1; });
