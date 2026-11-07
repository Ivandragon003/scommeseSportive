'use strict';
// Targeted, explicit migration and source-backed observation freeze. No bootstrap.
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { argumentsOf, targetFor, verifiedBackup, fileHash } = require('./reset-challenger-production');
const { sha } = require('./reset-challenger-history');
const { preflight } = require('./backup-turso');
const { buildObservationPlan, applyObservationPlan } = require('./final-observations');
const names = ['034_final_observations.sql', '035_odds_market_mapping.sql'];
async function buildIntegrityPlan(db, target, seasons) {
  const objects = await db.execute("SELECT name FROM sqlite_master WHERE name IN ('final_observations','final_observation_sources','final_observation_conflicts')");
  const columns = await db.execute('PRAGMA table_info(odds_snapshots)');
  if (objects.rows.length || columns.rows.some(row => row.name === 'market_mapping_version')) throw Error('integrity_migration_already_present');
  const migrations = [];
  for (const name of names) {
    const file = path.join(__dirname, '../migrations', name);
    migrations.push({ name, sha256: await fileHash(file), sql: fs.readFileSync(file, 'utf8') });
  }
  const observations = [];
  for (const season of seasons) observations.push(await buildObservationPlan(db, season));
  const content = { format: 'source-backed-data-integrity-plan-v1', target, seasons,
    schemaHash: (await preflight(db)).schemaSha256, migrations, observations };
  return { ...content, planHash: sha(content) };
}
async function applyIntegrityPlan(db, plan, backup) {
  const tx = await db.transaction('write');
  try {
    if ((await buildIntegrityPlan(tx, plan.target, plan.seasons)).planHash !== plan.planHash) throw Error('integrity_plan_changed');
    for (const migration of plan.migrations) {
      await tx.executeMultiple(migration.sql);
      await tx.execute({ sql: 'INSERT INTO schema_migrations(version) VALUES(?)', args: [migration.name] });
    }
    let inserted = 0;
    for (const observation of plan.observations) inserted += (await applyObservationPlan(tx, observation)).inserted;
    if ((await tx.execute('PRAGMA foreign_key_check')).rows.length) throw Error('foreign_key_violation_after_integrity_migration');
    const coverage = (await tx.execute('SELECT field,source,COUNT(*) AS observations FROM final_observations GROUP BY field,source ORDER BY field,source')).rows;
    await tx.commit();
    return { action: 'source_backed_data_integrity_applied', planHash: plan.planHash, inserted, coverage,
      migrations: names, backup, foreignKeyViolations: 0 };
  } catch (error) { await tx.rollback(); throw error; }
}
async function main(args = process.argv.slice(2)) {
  const options = argumentsOf(args), target = targetFor(options);
  const db = createClient({ url: target.url, authToken: target.authToken });
  try {
    if (options['--plan']) {
      if (fs.existsSync(options['--plan'])) throw Error('plan_output_exists');
      const now = new Date(), start = now.getUTCFullYear() - (now.getUTCMonth() < 6 ? 1 : 0);
      const seasons = Array.from({ length: 5 }, (_, i) => `${start - i}/${start - i + 1}`);
      const plan = await buildIntegrityPlan(db, target.identity, seasons);
      fs.writeFileSync(options['--plan'], JSON.stringify(plan) + '\n', { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ action: 'integrity_plan_only', planHash: plan.planHash,
        seasons: plan.observations.map(p => ({ season: p.season, matches: p.matches, observations: p.observations.length, reasons: p.reasons })) }));
      return;
    }
    if (!options['--backup-manifest'] || !options['--receipt'] || !/^[a-f0-9]{64}$/.test(options['--expected-plan-hash'] || '')) throw Error('apply_requires_reviewed_plan_and_backup');
    if (fs.existsSync(options['--receipt'])) throw Error('receipt_output_exists');
    const plan = JSON.parse(fs.readFileSync(options['--apply'], 'utf8'));
    const { planHash, ...content } = plan;
    if (planHash !== options['--expected-plan-hash'] || sha(content) !== planHash || sha(plan.target) !== sha(target.identity)) throw Error('plan_identity_mismatch');
    const backup = await verifiedBackup(options['--backup-manifest'], target.identity);
    const receipt = await applyIntegrityPlan(db, plan, backup);
    fs.writeFileSync(options['--receipt'], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify(receipt));
  } finally { db.close(); }
}
module.exports = { buildIntegrityPlan, applyIntegrityPlan };
if (require.main === module) main().catch(error => { console.error(/^[a-z_]+$/.test(error.message) ? error.message : 'data_integrity_maintenance_failed'); process.exitCode = 1; });
