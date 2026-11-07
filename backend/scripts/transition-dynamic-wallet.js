#!/usr/bin/env node
// Cancel approved pending fixed-policy wagers and refund their original stakes. No app bootstrap or providers.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { romeDayWindow } = require('./recover-recommendation-technical');
const { TABLES, MAX_BETS, MAX_ROWS, MAX_BYTES, targetFingerprint, validateTarget, readSnapshot, snapshotInTransaction,
  walletBalances, fingerprints, objectHash, assertIdle, writePrivateJson } = require('./transition-funded-wallet');

const PROTOCOL = 'funded-to-dynamic-wallet-transition-v1';
const MIGRATIONS = ['030_dynamic_model_bets.sql', '031_dynamic_funded_cancellations.sql'];
const CANCELLATIONS = 'funded_model_bet_cancellations';
const fail = code => { throw new Error(`dynamic_wallet_transition_${code}`); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const atNow = clock => { const at = new Date(clock()); if (!Number.isFinite(at.getTime())) fail('time_invalid'); return at; };
const normalizeSql = sql => sql.replace(/^\s*--[^\r\n]*$/gm, '').replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/;\s*$/, '').replace(/\s+/g, ' ').trim();

function readMigrations() {
  return MIGRATIONS.map(filename => {
    let sql;
    try { sql = readFileSync(join(__dirname, '../migrations', filename), 'utf8'); } catch { fail('migration_unavailable'); }
    const statements = sql.replace(/^\s*--[^\r\n]*$/gm, '').split(/(?=^CREATE\s)/m).map(value => value.trim()).filter(Boolean);
    const objects = statements.map(statement => {
      const match = /^CREATE\s+(TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+(\w+)\b/i.exec(statement);
      if (!match) fail('migration_not_additive');
      return { type: match[1].toLowerCase(), name: match[2], sql: normalizeSql(statement) };
    });
    if (!objects.length || new Set(objects.map(object => object.name)).size !== objects.length) fail('migration_invalid');
    return { filename, sha256: hash(sql), sql, objects };
  });
}

function assertMigrationObjects(snapshot, migrations, requireAll = false) {
  for (const migration of migrations) {
    const applied = snapshot.tables.schema_migrations.some(row => row.version === migration.filename);
    for (const expected of migration.objects) {
      const actual = snapshot.schema.find(row => row.type === expected.type && row.name === expected.name);
      if (!actual && (applied || requireAll)) fail('migration_schema_incomplete');
      if (actual && normalizeSql(actual.sql) !== expected.sql) fail('migration_schema_mismatch');
    }
    if (requireAll && !applied) fail('migration_version_missing');
  }
}

function eligibleSources(snapshot, now) {
  const matches = new Map(snapshot.tables.matches.map(row => [row.match_id, row]));
  const settlements = new Set(snapshot.tables.funded_model_settlements.map(row => row.bet_id));
  const cancelled = new Set(snapshot.tables[CANCELLATIONS].map(row => row.bet_id));
  const policies = new Map(snapshot.tables.research_execution_policies.map(row => [row.hash, row]));
  const sources = [];
  for (const bet of snapshot.tables.funded_model_bets) {
    const fixture = matches.get(bet.match_id), kickoff = Date.parse(fixture?.date);
    if (!['A', 'C'].includes(bet.family) || settlements.has(bet.id) || cancelled.has(bet.id)
      || !Number.isFinite(kickoff) || kickoff <= now.getTime() || kickoff < Date.parse(snapshot.dayStartAt) || kickoff >= Date.parse(snapshot.dayEndAt)
      || fixture.home_goals !== null || fixture.away_goals !== null) continue;
    let evidence;
    try { evidence = JSON.parse(bet.snapshot_json); } catch { fail('source_snapshot_invalid'); }
    if (bet.portfolio_id !== `shadow_${bet.family}` || typeof bet.id !== 'string' || !bet.id.startsWith('funded:')
      || !Number.isSafeInteger(bet.stake_cents) || bet.stake_cents <= 0 || policies.get(bet.policy_hash)?.version !== 'funded-confidence-v1'
      || Date.parse(evidence.kickoffAt) !== kickoff || evidence.stakeCents !== bet.stake_cents) fail('source_identity_invalid');
    const stake = snapshot.tables.research_ledger.filter(row => row.id === `stake:${bet.id}`);
    if (stake.length !== 1 || stake[0].portfolio_id !== bet.portfolio_id || stake[0].bet_id !== null || stake[0].event !== 'STAKE'
      || stake[0].available_delta_cents !== -bet.stake_cents || stake[0].committed_delta_cents !== bet.stake_cents
      || snapshot.tables.research_ledger.some(row => row.id === `cancel:${bet.id}`)) fail('source_stake_ledger_invalid');
    sources.push({ betId: bet.id, family: bet.family, portfolioId: bet.portfolio_id, matchId: bet.match_id,
      kickoffAt: fixture.date, stakeCents: bet.stake_cents, rowSha256: objectHash(bet), stakeLedgerSha256: objectHash(stake[0]) });
  }
  if (sources.length > MAX_BETS || new Set(sources.map(source => source.betId)).size !== sources.length) fail('source_limit');
  return sources.sort((left, right) => left.betId < right.betId ? -1 : left.betId > right.betId ? 1 : 0);
}

function expectedWallets(wallets, sources) {
  return wallets.map(wallet => {
    const refundCents = sources.filter(source => source.portfolioId === wallet.portfolioId).reduce((sum, source) => sum + source.stakeCents, 0);
    if (!Number.isSafeInteger(refundCents) || refundCents > wallet.committedCents || !Number.isSafeInteger(wallet.availableCents + refundCents)) fail('refund_amount_invalid');
    return { ...wallet, availableCents: wallet.availableCents + refundCents, committedCents: wallet.committedCents - refundCents };
  });
}

function makePlan(snapshot, { targetSha256, expectedCount, now }, migrations) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > MAX_BETS) fail('expected_count_invalid');
  assertMigrationObjects(snapshot, migrations);
  const sources = eligibleSources(snapshot, now);
  if (sources.length !== expectedCount) fail('expected_count_mismatch');
  assertIdle(snapshot, sources, now);
  const wallets = walletBalances(snapshot);
  return { protocol: PROTOCOL, mode: 'read-only-plan', targetSha256, createdAt: now.toISOString(), day: snapshot.day,
    dayStartAt: snapshot.dayStartAt, dayEndAt: snapshot.dayEndAt, expectedCount, sources, wallets,
    expectedWallets: expectedWallets(wallets, sources), ...fingerprints(snapshot),
    migrations: migrations.map(({ filename, sha256 }) => ({ filename, sha256 })),
    limits: { maxBets: MAX_BETS, maxRows: MAX_ROWS, maxBytes: MAX_BYTES }, databaseWrites: 0, providerRequests: 0 };
}

function assertCurrent(plan, snapshot, now, afterMigration = false) {
  const sources = eligibleSources(snapshot, now);
  assertIdle(snapshot, sources, now);
  if (objectHash(sources) !== objectHash(plan.sources)) fail('source_set_changed');
  if (objectHash(walletBalances(snapshot)) !== objectHash(plan.wallets)) fail('wallet_changed');
  const current = fingerprints(snapshot);
  if (current.sourceRowsSha256 !== plan.sourceRowsSha256 || current.sourceSchemaSha256 !== plan.sourceSchemaSha256) fail('source_evidence_changed');
  if (!afterMigration && (current.schemaSha256 !== plan.schemaSha256 || objectHash(current.tableRows) !== objectHash(plan.tableRows))) fail('schema_or_migrations_changed');
  if (now.getTime() < Date.parse(plan.createdAt)) fail('plan_time_invalid');
}

function readApprovedPlan(options, migrations) {
  let bytes, plan;
  try { bytes = readFileSync(options.planFile); } catch { fail('plan_unavailable'); }
  if (bytes.length > MAX_BYTES || hash(bytes) !== options.expectedPlanSha256) fail('plan_hash_mismatch');
  try { plan = JSON.parse(bytes.toString('utf8')); } catch { fail('plan_invalid'); }
  if (plan.protocol !== PROTOCOL || plan.mode !== 'read-only-plan' || plan.targetSha256 !== options.targetSha256
    || !Number.isSafeInteger(plan.expectedCount) || plan.expectedCount < 1 || plan.expectedCount > MAX_BETS
    || !Array.isArray(plan.sources) || plan.sources.length !== plan.expectedCount || !Number.isFinite(Date.parse(plan.createdAt))) fail('plan_identity_invalid');
  const window = romeDayWindow(plan.day);
  if (window.dayStartAt !== plan.dayStartAt || window.dayEndAt !== plan.dayEndAt || options.day && options.day !== plan.day
    || options.expectedCount !== undefined && options.expectedCount !== plan.expectedCount) fail('plan_scope_mismatch');
  if (objectHash(plan.migrations) !== objectHash(migrations.map(({ filename, sha256 }) => ({ filename, sha256 })))) fail('migration_changed');
  return plan;
}

async function executeTransition(client, options) {
  if (options.authorized !== true) fail('authorization_required');
  const migrations = readMigrations(), plan = readApprovedPlan(options, migrations);
  const before = await readSnapshot(client, plan.day);
  assertCurrent(plan, before, atNow(options.clock)); assertMigrationObjects(before, migrations);
  if (objectHash(expectedWallets(plan.wallets, plan.sources)) !== objectHash(plan.expectedWallets)) fail('plan_wallet_expectation_invalid');
  const backupDocument = { protocol: PROTOCOL, kind: 'PARTIAL_WALLET_EXECUTION_BACKUP_NOT_FULL_DATABASE', createdAt: atNow(options.clock).toISOString(),
    targetSha256: options.targetSha256, planSha256: options.expectedPlanSha256, ...fingerprints(before), snapshot: before };
  const backup = writePrivateJson(options.backupFile, backupDocument);
  const verified = JSON.parse(readFileSync(backup.path, 'utf8'));
  if (objectHash(verified) !== objectHash(backupDocument) || objectHash(fingerprints(verified.snapshot)) !== objectHash(fingerprints(before))) fail('backup_verification_failed');
  const missing = migrations.filter(migration => !before.tables.schema_migrations.some(row => row.version === migration.filename));
  if (missing.length) {
    try {
      await client.executeMultiple(`BEGIN;\n${missing.map(migration => `${migration.sql}\nINSERT INTO schema_migrations(version) VALUES ('${migration.filename}');`).join('\n')}\nCOMMIT;`);
    } catch {
      try { await client.execute('ROLLBACK'); } catch { /* HTTP stream closure already rolls back remote failures. */ }
      fail('migration_apply_failed');
    }
  }
  const tx = await client.transaction('write');
  try {
    const current = await snapshotInTransaction(tx, plan.day), now = atNow(options.clock);
    assertCurrent(plan, current, now, true); assertMigrationObjects(current, migrations, true);
    const allowedObjects = new Set(migrations.flatMap(migration => migration.objects.map(object => object.name)));
    if (objectHash(current.schema.filter(row => !allowedObjects.has(row.name))) !== objectHash(before.schema.filter(row => !allowedObjects.has(row.name)))
      || objectHash(current.tables.schema_migrations.filter(row => !MIGRATIONS.includes(row.version)))
      !== objectHash(before.tables.schema_migrations.filter(row => !MIGRATIONS.includes(row.version)))) fail('unexpected_schema_change');
    const reason = `explicit_dynamic_staking_transition:${options.expectedPlanSha256}`;
    // Migration 031's verified AFTER trigger performs the exact refund. Never write the ledger here.
    const inserted = await tx.batch(plan.sources.map(source => ({
      sql: `INSERT INTO funded_model_bet_cancellations(bet_id,cancelled_at,reason)
        SELECT b.id,?,? FROM funded_model_bets b JOIN matches m ON m.match_id=b.match_id
        WHERE b.id=? AND b.family=? AND b.portfolio_id=? AND b.match_id=? AND b.stake_cents=?
        AND julianday(m.date)>julianday(?) AND julianday(m.date)>=julianday(?) AND julianday(m.date)<julianday(?)
        AND m.home_goals IS NULL AND m.away_goals IS NULL
        AND NOT EXISTS(SELECT 1 FROM funded_model_settlements s WHERE s.bet_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM funded_model_bet_cancellations c WHERE c.bet_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM research_execution_jobs j WHERE j.match_id=b.match_id AND j.status='CLAIMED'
          AND (j.lease_expires_at IS NULL OR julianday(j.lease_expires_at)>julianday(?)))
        AND NOT EXISTS(SELECT 1 FROM research_jobs j WHERE j.match_id=b.match_id AND j.status='CLAIMED'
          AND (j.lease_expires_at IS NULL OR julianday(j.lease_expires_at)>julianday(?)))`,
      args: [now.toISOString(), reason, source.betId, source.family, source.portfolioId, source.matchId, source.stakeCents,
        now.toISOString(), plan.dayStartAt, plan.dayEndAt, now.toISOString(), now.toISOString()],
    })));
    if (inserted.some(result => result.rowsAffected !== 1)) fail('cancellation_race');
    const after = await snapshotInTransaction(tx, plan.day), priorHashes = fingerprints(current).tableRows, afterHashes = fingerprints(after).tableRows;
    if (TABLES.filter(table => ![CANCELLATIONS, 'research_ledger'].includes(table)).some(table => objectHash(priorHashes[table]) !== objectHash(afterHashes[table]))) fail('unrelated_evidence_changed');
    const oldCancellations = new Set(current.tables[CANCELLATIONS].map(row => row.bet_id));
    const added = after.tables[CANCELLATIONS].filter(row => !oldCancellations.has(row.bet_id));
    if (objectHash(added.map(row => row.bet_id).sort()) !== objectHash(plan.sources.map(source => source.betId).sort())
      || added.some(row => row.reason !== reason || row.cancelled_at !== now.toISOString())) fail('cancellation_verification_failed');
    const oldLedger = new Map(current.tables.research_ledger.map(row => [row.id, row]));
    if (current.tables.research_ledger.some(row => objectHash(after.tables.research_ledger.find(candidate => candidate.id === row.id)) !== objectHash(row))) fail('old_ledger_changed');
    const refunds = after.tables.research_ledger.filter(row => !oldLedger.has(row.id));
    if (refunds.length !== plan.sources.length) fail('refund_count_mismatch');
    for (const source of plan.sources) {
      const refund = refunds.find(row => row.id === `cancel:${source.betId}`);
      if (!refund || refund.portfolio_id !== source.portfolioId || refund.bet_id !== null || refund.event !== 'SETTLE'
        || refund.available_delta_cents !== source.stakeCents || refund.committed_delta_cents !== -source.stakeCents
        || refund.created_at !== now.toISOString()) fail('refund_verification_failed');
    }
    const wallets = walletBalances(after);
    if (objectHash(wallets) !== objectHash(plan.expectedWallets)) fail('wallet_refund_mismatch');
    if (atNow(options.clock).getTime() >= Math.min(...plan.sources.map(source => Date.parse(source.kickoffAt)))) fail('kickoff_crossed');
    await tx.commit();
    return { mode: 'execute', ok: true, day: plan.day, cancelledBets: added.length, preservedSourceBets: plan.sources.length,
      refundCents: plan.sources.reduce((sum, source) => sum + source.stakeCents, 0), walletsBefore: plan.wallets, walletsAfter: wallets,
      targetSha256: options.targetSha256, planSha256: options.expectedPlanSha256, backupFile: backup.path, backupSha256: backup.sha256,
      backupKind: backupDocument.kind, migrationsApplied: missing.map(migration => migration.filename), providerRequests: 0 };
  } catch (error) {
    try { await tx.rollback(); } catch { /* No refund or cancellation is accepted without the complete commit. */ }
    throw error;
  } finally { tx.close(); }
}

function parseArgs(argv) {
  const options = { execute: false }, seen = new Set();
  const values = { '--target-sha256': 'targetSha256', '--day': 'day', '--expected-count': 'expectedCount', '--out': 'out',
    '--plan-file': 'planFile', '--expected-plan-sha256': 'expectedPlanSha256', '--backup-file': 'backupFile' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]; if (seen.has(arg)) fail('argument_duplicate'); seen.add(arg);
    if (arg === '--plan') options.plan = true;
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--authorize-dynamic-wallet-transition') options.authorized = true;
    else if (values[arg] && typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--')) options[values[arg]] = argv[++index];
    else fail('argument_invalid');
  }
  if (options.expectedCount !== undefined) options.expectedCount = Number(options.expectedCount);
  if (!validHash(options.targetSha256)) fail('target_hash_required');
  if (options.day !== undefined) { try { romeDayWindow(options.day); } catch { fail('day_invalid'); } }
  if (options.expectedCount !== undefined && (!Number.isSafeInteger(options.expectedCount) || options.expectedCount < 1 || options.expectedCount > MAX_BETS)) fail('expected_count_invalid');
  if (options.execute) {
    if (options.plan || options.out || !options.authorized || !options.planFile || !options.backupFile || !validHash(options.expectedPlanSha256)) fail('execute_arguments_required');
  } else if (!options.day || !options.out || options.expectedCount === undefined || options.authorized || options.planFile || options.backupFile || options.expectedPlanSha256) fail('plan_arguments_required');
  return options;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv), env = dependencies.env ?? process.env;
  if (targetFingerprint(env.TURSO_DATABASE_URL ?? '') !== options.targetSha256) fail('target_mismatch');
  let target;
  try { target = validateTarget(env, options.targetSha256); } catch { fail('target_invalid'); }
  const token = String((options.execute ? env.TURSO_AUTH_TOKEN : env.TURSO_WATCHDOG_READONLY_TOKEN) ?? '').trim();
  if (target.remote && !token) fail(options.execute ? 'write_token_required' : 'readonly_token_required');
  let client;
  try {
    client = (dependencies.createClient ?? require('@libsql/client').createClient)({ url: target.url, ...(token ? { authToken: token } : {}) });
    const runOptions = { ...options, clock: dependencies.clock ?? (() => new Date()) };
    let result;
    if (options.execute) result = await executeTransition(client, runOptions);
    else {
      const migrations = readMigrations(), snapshot = await readSnapshot(client, options.day);
      const plan = makePlan(snapshot, { ...options, now: atNow(runOptions.clock) }, migrations), file = writePrivateJson(options.out, plan);
      result = { mode: 'read-only-plan', ok: true, day: plan.day, bets: plan.sources.length, wallets: plan.wallets, expectedWallets: plan.expectedWallets,
        refundCents: plan.sources.reduce((sum, source) => sum + source.stakeCents, 0), targetSha256: plan.targetSha256,
        planFile: file.path, planSha256: file.sha256, migrations: plan.migrations, tableRows: plan.tableRows, databaseWrites: 0, providerRequests: 0 };
    }
    (dependencies.log ?? (value => console.log(JSON.stringify(value))))(result);
    return result;
  } catch (error) {
    if (typeof error.message === 'string' && /^dynamic_wallet_transition_[a-z_]+$/.test(error.message)) throw error;
    fail('operation_failed');
  } finally { if (client) client.close(); }
}

module.exports = { PROTOCOL, MIGRATIONS, readMigrations, eligibleSources, makePlan, assertCurrent, readApprovedPlan, executeTransition, parseArgs, main };
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: /^dynamic_wallet_transition_[a-z_]+$/.test(error.message) ? error.message : 'dynamic_wallet_transition_failed', providerRequests: 0 }));
  process.exitCode = 1;
});
