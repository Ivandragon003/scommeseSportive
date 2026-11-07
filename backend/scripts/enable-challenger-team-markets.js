/* Explicit registry opt-in. Planning uses a read-only token and never bootstraps the application. */
const { createClient } = require('@libsql/client');
const { createHash, randomUUID } = require('node:crypto');
const { readFileSync, createReadStream } = require('node:fs');
const { resolve, dirname, join } = require('node:path');
const { CURRENT_CHALLENGER_RELEASE } = require('../dist/research/CurrentChallengerRelease');
const { CHALLENGER_TEAM_MARKETS, CHALLENGER_TEAM_MARKET_POLICY } = require('../dist/research/ChallengerMarketCoverage');
const { preflight } = require('./backup-turso');
const sha = value => createHash('sha256').update(value).digest('hex');
async function fileHash(path) { const h = createHash('sha256'); for await (const chunk of createReadStream(path)) h.update(chunk); return h.digest('hex'); }
function endpoint(value) {
  const u = new URL(String(value).replace(/^libsql:/, 'https:'));
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('canonical_endpoint_required');
  return u;
}
async function inspect(client, host) {
  const schema = await preflight(client);
  const models = (await client.execute({ sql: 'SELECT version,artifact_hash FROM research_models WHERE family=? AND version=?', args: ['C', CURRENT_CHALLENGER_RELEASE.modelVersion] })).rows;
  if (models.length !== 1 || models[0].artifact_hash !== CURRENT_CHALLENGER_RELEASE.artifactHash) throw Error('model_identity_mismatch');
  const records = (await client.execute({ sql: 'SELECT market,state,evidence_json,updated_at FROM research_markets WHERE family=? AND model_version=? ORDER BY market', args: ['C', CURRENT_CHALLENGER_RELEASE.modelVersion] })).rows.map(r => ({ market: r.market, state: r.state, evidence: r.evidence_json, updatedAt: r.updated_at }));
  const missing = CHALLENGER_TEAM_MARKETS.filter(m => !records.some(r => r.market === m));
  return { version: 'challenger-team-market-registration-v1', host, modelVersion: CURRENT_CHALLENGER_RELEASE.modelVersion,
    modelHash: CURRENT_CHALLENGER_RELEASE.artifactHash, schemaHash: schema.schemaSha256, records, missing };
}
async function apply(client, plan) {
  const tx = await client.transaction('write');
  try {
    const current = await inspect(tx, plan.host);
    if (sha(JSON.stringify(current)) !== sha(JSON.stringify(plan))) throw Error('plan_changed');
    const now = new Date().toISOString(), evidence = JSON.stringify({ marketPolicyVersion: CHALLENGER_TEAM_MARKET_POLICY, registration: plan.version });
    for (const market of plan.missing) {
      await tx.execute({ sql: "INSERT INTO research_markets(family,model_version,market,state,evidence_json,updated_at) VALUES ('C',?,?,'EXPERIMENTAL',?,?)", args: [plan.modelVersion, market, evidence, now] });
      await tx.execute({ sql: "INSERT INTO research_market_events(id,family,model_version,market,previous_state,state,evidence_json,reason,created_at) VALUES (?,'C',?,?,NULL,'EXPERIMENTAL',?,'explicit team market registration',?)", args: [randomUUID(), plan.modelVersion, market, evidence, now] });
    }
    await tx.commit();
  } catch (error) { await tx.rollback(); throw error; } finally { tx.close(); }
}
async function main(args = process.argv.slice(2), env = process.env) {
  const opts = {}; for (let i = 0; i < args.length; i++) { const key = args[i]; if (key === '--apply') opts.apply = true; else if (['--expected-plan-hash','--backup-manifest'].includes(key) && args[i+1]) opts[key.slice(2)] = args[++i]; else throw Error('invalid_arguments'); }
  const target = endpoint(env.TURSO_DATABASE_URL), token = opts.apply ? env.TURSO_AUTH_TOKEN : env.TURSO_WATCHDOG_READONLY_TOKEN;
  if (!token) throw Error('database_token_required');
  const client = createClient({ url: target.href, authToken: token });
  try {
    const plan = await inspect(client, target.hostname), planHash = sha(JSON.stringify(plan));
    if (opts.apply) {
      if (opts['expected-plan-hash'] !== planHash || !opts['backup-manifest']) throw Error('reviewed_plan_and_backup_required');
      const path = resolve(opts['backup-manifest']), manifest = JSON.parse(readFileSync(path, 'utf8'));
      if (manifest.format !== 'turso-sql-dump-v1' || manifest.complete !== true || manifest.databaseHost !== target.hostname
        || manifest.preflight?.schemaSha256 !== plan.schemaHash || manifest.verification?.readable !== true
        || JSON.stringify(manifest.verification?.integrity) !== '["ok"]'
        || manifest.verification?.foreignKeyViolations !== 0 || manifest.dump?.sha256 !== await fileHash(join(dirname(path), 'database.sql'))
        || manifest.verification?.databaseSha256 !== await fileHash(join(dirname(path), 'restore.db'))) throw Error('backup_invalid');
      const backup = createClient({ url: 'file:' + join(dirname(path), 'restore.db') });
      try { if (sha(JSON.stringify(await inspect(backup, target.hostname))) !== planHash) throw Error('backup_snapshot_mismatch'); } finally { backup.close(); }
      await apply(client, plan);
    }
    console.log(JSON.stringify({ action: opts.apply ? 'applied' : 'read_only_plan', plan, planHash }));
  } finally { client.close(); }
}
module.exports = { inspect, apply, main };
if (require.main === module) main().catch(() => { console.error('Registration failed; check plan, model identity, credentials and verified backup.'); process.exitCode = 1; });
