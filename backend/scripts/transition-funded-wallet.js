#!/usr/bin/env node
// Explicit, bounded transition: no application bootstrap, providers or old bet deletion.
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { fileURLToPath } = require('node:url');
const { romeDayWindow } = require('./recover-recommendation-technical');

const PROTOCOL = 'funded-wallet-transition-v1';
const MIGRATION = '029_funded_model_bets.sql';
const MIGRATION_PATH = join(__dirname, '../migrations', MIGRATION);
const MAX_BETS = 200, MAX_ROWS = 50000, MAX_BYTES = 100 * 1024 * 1024;
const MIGRATION_TABLES = ['paper_model_bet_cancellations', 'funded_model_bets', 'funded_model_settlements'];
const OPTIONAL_TABLES = [...MIGRATION_TABLES, 'dynamic_model_bets', 'dynamic_model_settlements', 'funded_model_bet_cancellations'];
const TABLES = ['schema_migrations', 'matches', 'research_portfolios', 'research_ledger',
  'research_bets', 'research_settlements', 'research_bet_cancellations',
  'manual_model_bets', 'manual_model_settlements', 'manual_model_archives',
  'paper_model_bets', 'paper_model_settlements', 'research_execution_policies',
  'research_execution_jobs', 'research_execution_inputs', 'research_execution_decisions',
  'research_jobs', 'research_inputs', 'research_decisions', ...OPTIONAL_TABLES];
const fail = code => { throw new Error(`wallet_transition_${code}`); };
const hash = value => createHash('sha256').update(value).digest('hex');
const targetFingerprint = url => hash(String(url).trim());
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const objectHash = value => hash(canonical(value));
const identifiers = values => values.map(value => `'${value}'`).join(',');
const quoteIdentifier = value => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) fail('schema_identifier_invalid');
  return `"${value}"`;
};
const nowAt = clock => {
  const now = new Date(clock());
  if (!Number.isFinite(now.getTime())) fail('time_invalid');
  return now;
};

function validateTarget(env, targetSha256) {
  const url = String(env.TURSO_DATABASE_URL ?? '').trim();
  if (!url || !validHash(targetSha256) || targetFingerprint(url) !== targetSha256) fail('target_mismatch');
  let parsed;
  try { parsed = new URL(url); } catch { fail('target_invalid'); }
  if (!['file:', 'libsql:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) fail('target_invalid');
  if (parsed.protocol === 'file:') {
    let local;
    try { local = fileURLToPath(parsed); } catch { fail('local_target_invalid'); }
    if (!existsSync(local)) fail('local_target_missing');
  }
  return { url, remote: parsed.protocol !== 'file:' };
}

function readMigration() {
  let sql;
  try { sql = readFileSync(MIGRATION_PATH, 'utf8'); } catch { fail('migration_unavailable'); }
  const objects = [...sql.matchAll(/CREATE\s+(TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)]
    .map(match => ({ type: match[1].toLowerCase(), name: match[2] }));
  if (!objects.length || MIGRATION_TABLES.some(name => !objects.some(object => object.name === name && object.type === 'table'))) fail('migration_invalid');
  return { sql, sha256: hash(sql), objects };
}

function scopeFor(table, window) {
  const wallets = "('shadow_A','shadow_C')";
  const dayMatches = 'SELECT match_id FROM matches WHERE julianday(date)>=julianday(?) AND julianday(date)<julianday(?)';
  const dayArgs = [window.dayStartAt, window.dayEndAt];
  if (table === 'matches') return { where: `t.match_id IN (${dayMatches})`, args: dayArgs };
  if (table === 'research_portfolios') return { where: `t.id IN ${wallets}`, args: [] };
  if (['research_ledger', 'research_bets', 'manual_model_bets', 'funded_model_bets', 'dynamic_model_bets', 'research_decisions', 'research_execution_decisions'].includes(table)) {
    return { where: `t.portfolio_id IN ${wallets}`, args: [] };
  }
  if (['research_settlements', 'manual_model_settlements', 'funded_model_settlements', 'dynamic_model_settlements'].includes(table)) {
    const bets = { research_settlements: 'research_bets', manual_model_settlements: 'manual_model_bets', funded_model_settlements: 'funded_model_bets',
      dynamic_model_settlements: 'dynamic_model_bets' }[table];
    return { where: `t.bet_id IN (SELECT id FROM ${bets} WHERE portfolio_id IN ${wallets})`, args: [] };
  }
  if (table === 'funded_model_bet_cancellations') return { where: `t.bet_id IN (SELECT id FROM funded_model_bets WHERE portfolio_id IN ${wallets})`, args: [] };
  if (table === 'paper_model_bets') return { where: `t.family IN ('A','C') AND t.match_id IN (${dayMatches})`, args: dayArgs };
  if (['paper_model_settlements', 'paper_model_bet_cancellations'].includes(table)) {
    return { where: `t.bet_id IN (SELECT id FROM paper_model_bets WHERE family IN ('A','C') AND match_id IN (${dayMatches}))`, args: dayArgs };
  }
  if (table === 'manual_model_archives') return { where: "t.family IN ('A','C')", args: [] };
  if (table === 'research_inputs') return { where: `t.id IN (SELECT input_id FROM research_decisions WHERE portfolio_id IN ${wallets})`, args: [] };
  if (table === 'research_jobs') return { where: `t.id IN (SELECT job_id FROM research_decisions WHERE portfolio_id IN ${wallets}) OR t.match_id IN (${dayMatches})`, args: dayArgs };
  if (table === 'research_execution_inputs') return { where: `t.id IN (SELECT input_id FROM research_execution_decisions WHERE portfolio_id IN ${wallets})
    OR t.job_id IN (SELECT id FROM research_execution_jobs WHERE match_id IN (${dayMatches}))`, args: dayArgs };
  if (table === 'research_execution_jobs') return { where: `t.id IN (SELECT i.job_id FROM research_execution_inputs i
    JOIN research_execution_decisions d ON d.input_id=i.id WHERE d.portfolio_id IN ${wallets}) OR t.match_id IN (${dayMatches})`, args: dayArgs };
  return { where: '1=1', args: [] };
}

async function select(db, statement) {
  const sql = typeof statement === 'string' ? statement : statement.sql;
  if (!/^\s*SELECT\b/i.test(sql) || /;|--|\/\*/.test(sql)) fail('select_only');
  return db.execute(statement);
}

/** All counts and rows belong to the same transaction; counts bound reads before fetching evidence. */
async function snapshotInTransaction(tx, day) {
  const window = romeDayWindow(day), names = identifiers(TABLES);
  const schema = (await select(tx, `SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name IN (${names})
    AND sql IS NOT NULL ORDER BY type,name LIMIT 1001`)).rows.map(row => ({ type: row.type, name: row.name, table: row.tbl_name, sql: row.sql }));
  if (schema.length > 1000) fail('schema_limit');
  const present = new Set(schema.filter(row => row.type === 'table').map(row => row.name));
  if (TABLES.some(table => !OPTIONAL_TABLES.includes(table) && !present.has(table))) fail('required_table_missing');
  const columnRows = (await select(tx, `SELECT m.name AS table_name,p.name AS column_name,p.type AS column_type,p.pk
    FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type='table' AND m.name IN (${names})
    ORDER BY m.name,p.cid LIMIT 2001`)).rows;
  if (columnRows.length > 2000) fail('schema_limit');
  const migrationColumn = columnRows.find(row => row.table_name === 'schema_migrations' && row.column_name === 'version');
  if (!migrationColumn || String(migrationColumn.column_type).toUpperCase() !== 'TEXT' || Number(migrationColumn.pk) !== 1) fail('migration_version_schema_mismatch');
  const queries = TABLES.filter(table => present.has(table)).map(table => {
    // Lease ownership tokens are deliberately not copied into operational files.
    const columns = columnRows.filter(row => row.table_name === table && row.column_name !== 'lease_token').map(row => row.column_name);
    if (!columns.length) fail('table_columns_missing');
    const expression = `json_object(${columns.flatMap(column => [`'${column}'`, `t.${quoteIdentifier(column)}`]).join(',')})`;
    const scope = scopeFor(table, window), from = `FROM ${quoteIdentifier(table)} t WHERE ${scope.where}`;
    return { table, expression, from, args: scope.args };
  });
  const counts = await tx.batch(queries.map(query => ({
    sql: `SELECT COUNT(*) AS row_count,COALESCE(SUM(length(CAST(${query.expression} AS BLOB))),0) AS byte_count ${query.from}`,
    args: query.args,
  })));
  const rowCount = counts.reduce((sum, result) => sum + Number(result.rows[0].row_count), 0);
  const byteCount = counts.reduce((sum, result) => sum + Number(result.rows[0].byte_count), 0);
  if (!Number.isSafeInteger(rowCount) || rowCount > MAX_ROWS) fail('row_limit');
  if (!Number.isSafeInteger(byteCount) || byteCount > MAX_BYTES) fail('byte_limit');
  const results = await tx.batch(queries.map(query => ({
    sql: `SELECT ${query.expression} AS row_json ${query.from} ORDER BY row_json COLLATE BINARY LIMIT ${MAX_ROWS + 1}`,
    args: query.args,
  })));
  const tables = Object.fromEntries(TABLES.map(table => [table, []]));
  for (let index = 0; index < queries.length; index++) {
    const rows = results[index].rows.map(row => JSON.parse(row.row_json));
    if (rows.length !== Number(counts[index].rows[0].row_count)) fail('snapshot_count_mismatch');
    tables[queries[index].table] = rows;
  }
  return { day, ...window, schema, tables, rowCount, byteCount, omittedColumns: ['lease_token'] };
}

async function readSnapshot(client, day) {
  const tx = await client.transaction('read');
  try {
    const snapshot = await snapshotInTransaction(tx, day);
    await tx.commit();
    return snapshot;
  } catch (error) {
    try { await tx.rollback(); } catch { /* Closing the transaction also releases its read snapshot. */ }
    throw error;
  } finally { tx.close(); }
}

function walletBalances(snapshot) {
  return ['A', 'C'].map(family => {
    const portfolioId = `shadow_${family}`;
    const portfolios = snapshot.tables.research_portfolios.filter(row => row.id === portfolioId);
    if (portfolios.length !== 1 || portfolios[0].family !== family) fail('wallet_identity_invalid');
    const ledger = snapshot.tables.research_ledger.filter(row => row.portfolio_id === portfolioId);
    let availableCents = 0, committedCents = 0;
    for (const row of ledger) {
      if (!Number.isSafeInteger(row.available_delta_cents) || !Number.isSafeInteger(row.committed_delta_cents)) fail('wallet_amount_invalid');
      availableCents += row.available_delta_cents; committedCents += row.committed_delta_cents;
      if (!Number.isSafeInteger(availableCents) || !Number.isSafeInteger(committedCents)) fail('wallet_amount_invalid');
    }
    if (availableCents < 0 || committedCents < 0 || !Number.isSafeInteger(availableCents + committedCents)) fail('wallet_balance_invalid');
    let pendingCents = 0;
    for (const [bets, settlements] of [['research_bets', 'research_settlements'], ['manual_model_bets', 'manual_model_settlements'],
      ['funded_model_bets', 'funded_model_settlements'], ['dynamic_model_bets', 'dynamic_model_settlements']]) {
      const settled = new Set(snapshot.tables[settlements].map(row => row.bet_id));
      if (bets === 'funded_model_bets') for (const cancellation of snapshot.tables.funded_model_bet_cancellations) settled.add(cancellation.bet_id);
      for (const bet of snapshot.tables[bets]) if (bet.portfolio_id === portfolioId && !settled.has(bet.id)) {
        if (!Number.isSafeInteger(bet.stake_cents) || bet.stake_cents <= 0) fail('wallet_amount_invalid');
        pendingCents += bet.stake_cents;
      }
    }
    if (!Number.isSafeInteger(pendingCents) || pendingCents !== committedCents) fail('wallet_commitment_mismatch');
    return { family, portfolioId, availableCents, committedCents, equityCents: availableCents + committedCents };
  });
}

function eligibleBets(snapshot, now) {
  const matches = new Map(snapshot.tables.matches.map(row => [row.match_id, row]));
  const settled = new Set(snapshot.tables.paper_model_settlements.map(row => row.bet_id));
  const cancelled = new Set(snapshot.tables.paper_model_bet_cancellations.map(row => row.bet_id));
  const bets = snapshot.tables.paper_model_bets.filter(bet => {
    const match = matches.get(bet.match_id), kickoff = Date.parse(match?.date);
    return ['A', 'C'].includes(bet.family) && !settled.has(bet.id) && !cancelled.has(bet.id)
      && Number.isFinite(kickoff) && kickoff > now.getTime()
      && kickoff >= Date.parse(snapshot.dayStartAt) && kickoff < Date.parse(snapshot.dayEndAt)
      && match.home_goals === null && match.away_goals === null;
  }).map(bet => {
    if (typeof bet.id !== 'string' || !bet.id || bet.stake_cents !== 100) fail('paper_source_invalid');
    return { betId: bet.id, family: bet.family, matchId: bet.match_id, kickoffAt: matches.get(bet.match_id).date, rowSha256: objectHash(bet) };
  }).sort((left, right) => compareText(left.betId, right.betId));
  if (bets.length > MAX_BETS || new Set(bets.map(bet => bet.betId)).size !== bets.length) fail('bet_limit');
  return bets;
}

function assertIdle(snapshot, bets, now) {
  const matches = new Set(bets.map(bet => bet.matchId));
  for (const table of ['research_jobs', 'research_execution_jobs']) for (const job of snapshot.tables[table]) {
    if (!matches.has(job.match_id) || job.status !== 'CLAIMED') continue;
    const expires = Date.parse(job.lease_expires_at);
    if (!Number.isFinite(expires) || expires > now.getTime()) fail('active_job_lease');
  }
}

function fingerprints(snapshot) {
  const tableRows = Object.fromEntries(TABLES.map(table => [table, { count: snapshot.tables[table].length, sha256: objectHash(snapshot.tables[table]) }]));
  const sourceRows = Object.fromEntries(TABLES.filter(table => table !== 'schema_migrations').map(table => [table, tableRows[table]]));
  return { tableRows, sourceRowsSha256: objectHash(sourceRows), schemaSha256: objectHash(snapshot.schema),
    sourceSchemaSha256: objectHash(snapshot.schema.filter(row => !OPTIONAL_TABLES.includes(row.table))) };
}

function buildPlan(snapshot, { targetSha256, expectedCount, now, migration }) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > MAX_BETS) fail('expected_count_invalid');
  const bets = eligibleBets(snapshot, now);
  if (bets.length !== expectedCount) fail('expected_count_mismatch');
  assertIdle(snapshot, bets, now);
  return { protocol: PROTOCOL, mode: 'read-only-plan', createdAt: now.toISOString(), targetSha256, day: snapshot.day,
    dayStartAt: snapshot.dayStartAt, dayEndAt: snapshot.dayEndAt, expectedCount,
    migration: { filename: MIGRATION, sha256: migration.sha256 }, bets, wallets: walletBalances(snapshot), ...fingerprints(snapshot),
    limits: { maxBets: MAX_BETS, maxRows: MAX_ROWS, maxBytes: MAX_BYTES }, databaseWrites: 0, providerRequests: 0 };
}

function writePrivateJson(path, document) {
  if (typeof path !== 'string' || !path.trim()) fail('output_path_required');
  const absolute = resolve(path), bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  if (bytes.length > MAX_BYTES) fail('byte_limit');
  try { writeFileSync(absolute, bytes, { flag: 'wx', mode: 0o600 }); } catch { fail('private_output_create_failed'); }
  let reopened;
  try { reopened = readFileSync(absolute); } catch { fail('private_output_reopen_failed'); }
  if (hash(reopened) !== hash(bytes)) fail('private_output_hash_mismatch');
  return { path: absolute, sha256: hash(reopened), bytes: reopened.length };
}

function validatePlan(plan, options, migration) {
  if (!plan || plan.protocol !== PROTOCOL || plan.mode !== 'read-only-plan' || plan.targetSha256 !== options.targetSha256
    || !validHash(plan.sourceRowsSha256) || !validHash(plan.schemaSha256) || !validHash(plan.sourceSchemaSha256) || !Array.isArray(plan.bets)
    || !Number.isSafeInteger(plan.expectedCount) || plan.expectedCount < 1 || plan.expectedCount > MAX_BETS
    || plan.bets.length !== plan.expectedCount || !Number.isFinite(Date.parse(plan.createdAt))) fail('plan_identity_invalid');
  if (plan.migration?.filename !== MIGRATION || plan.migration.sha256 !== migration.sha256) fail('migration_changed');
  if (options.day && options.day !== plan.day) fail('plan_day_mismatch');
  const window = romeDayWindow(plan.day);
  if (window.dayStartAt !== plan.dayStartAt || window.dayEndAt !== plan.dayEndAt) fail('plan_identity_invalid');
}

function assertPlanCurrent(plan, snapshot, now, afterMigration = false) {
  const bets = eligibleBets(snapshot, now);
  assertIdle(snapshot, bets, now);
  if (objectHash(bets) !== objectHash(plan.bets)) fail('source_bets_changed');
  if (objectHash(walletBalances(snapshot)) !== objectHash(plan.wallets)) fail('wallet_changed');
  const current = fingerprints(snapshot);
  if (current.sourceRowsSha256 !== plan.sourceRowsSha256) fail('source_rows_changed');
  if (current.sourceSchemaSha256 !== plan.sourceSchemaSha256) fail('source_schema_changed');
  if (!afterMigration && (current.schemaSha256 !== plan.schemaSha256 || objectHash(current.tableRows) !== objectHash(plan.tableRows))) fail('schema_or_migrations_changed');
  if (now.getTime() < Date.parse(plan.createdAt)) fail('plan_time_invalid');
}

async function planTransition(client, options) {
  const now = nowAt(options.clock), migration = readMigration();
  const snapshot = await readSnapshot(client, options.day);
  const plan = buildPlan(snapshot, { ...options, now, migration });
  const file = writePrivateJson(options.out, plan);
  return { mode: 'read-only-plan', ok: true, day: plan.day, bets: plan.bets.length, wallets: plan.wallets,
    targetSha256: plan.targetSha256, planSha256: file.sha256, planFile: file.path,
    migrationSha256: migration.sha256, tableRows: plan.tableRows, databaseWrites: 0, providerRequests: 0 };
}

async function executeTransition(client, options) {
  if (options.authorizeWalletTransition !== true) fail('authorization_required');
  if (!validHash(options.expectedPlanSha256)) fail('plan_hash_required');
  let bytes, plan;
  try { bytes = readFileSync(options.planFile); } catch { fail('plan_unavailable'); }
  if (bytes.length > MAX_BYTES || hash(bytes) !== options.expectedPlanSha256) fail('plan_hash_mismatch');
  try { plan = JSON.parse(bytes.toString('utf8')); } catch { fail('plan_invalid'); }
  const migration = readMigration();
  validatePlan(plan, options, migration);
  const before = await readSnapshot(client, plan.day);
  assertPlanCurrent(plan, before, nowAt(options.clock));
  const backup = { protocol: PROTOCOL, kind: 'PARTIAL_WALLET_EXECUTION_BACKUP_NOT_FULL_DATABASE', createdAt: nowAt(options.clock).toISOString(),
    targetSha256: options.targetSha256, planSha256: options.expectedPlanSha256,
    scope: { day: plan.day, portfolios: ['shadow_A', 'shadow_C'], tables: TABLES, omittedColumns: before.omittedColumns },
    ...fingerprints(before), snapshot: before };
  const backupFile = writePrivateJson(options.backupFile, backup);
  let verifiedBackup;
  try { verifiedBackup = JSON.parse(readFileSync(backupFile.path, 'utf8')); } catch { fail('backup_verification_failed'); }
  if (objectHash(verifiedBackup) !== objectHash(backup)
    || objectHash(fingerprints(verifiedBackup.snapshot)) !== objectHash(fingerprints(before))) fail('backup_verification_failed');
  // No DB write has occurred before the checked, exclusive backup above.
  const versions = before.tables.schema_migrations.map(row => row.version);
  const migrationApplied = versions.includes(MIGRATION);
  if (migrationApplied && migration.objects.some(object => !before.schema.some(row => row.name === object.name && row.type === object.type))) fail('migration_schema_incomplete');
  if (!migrationApplied) {
    try {
      await client.executeMultiple(`BEGIN;\n${migration.sql}\nINSERT OR IGNORE INTO schema_migrations(version) VALUES ('${MIGRATION}');\nCOMMIT;`);
    } catch {
      // Local SQLite keeps an errored explicit transaction open; HTTP stream closure rolls it back remotely.
      try { await client.execute('ROLLBACK'); } catch { /* The HTTP stream may already be closed and rolled back. */ }
      fail('migration_apply_failed');
    }
  }
  const tx = await client.transaction('write');
  try {
    const current = await snapshotInTransaction(tx, plan.day), at = nowAt(options.clock);
    assertPlanCurrent(plan, current, at, true);
    if (objectHash(current.tables.schema_migrations.filter(row => row.version !== MIGRATION))
      !== objectHash(before.tables.schema_migrations.filter(row => row.version !== MIGRATION))) fail('migrations_changed');
    if (!current.tables.schema_migrations.some(row => row.version === MIGRATION)
      || migration.objects.some(object => !current.schema.some(row => row.name === object.name && row.type === object.type))) fail('migration_schema_incomplete');
    const reason = `explicit_funded_wallet_transition:${options.expectedPlanSha256}`;
    const results = await tx.batch(plan.bets.map(bet => ({
      sql: `INSERT INTO paper_model_bet_cancellations(bet_id,cancelled_at,reason)
        SELECT b.id,?,? FROM paper_model_bets b JOIN matches m ON m.match_id=b.match_id
        WHERE b.id=? AND b.family=? AND b.match_id=? AND b.stake_cents=100
        AND julianday(m.date)>julianday(?) AND julianday(m.date)>=julianday(?) AND julianday(m.date)<julianday(?)
        AND m.home_goals IS NULL AND m.away_goals IS NULL
        AND NOT EXISTS(SELECT 1 FROM paper_model_settlements s WHERE s.bet_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM paper_model_bet_cancellations c WHERE c.bet_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM research_execution_jobs j WHERE j.match_id=b.match_id AND j.status='CLAIMED'
          AND (j.lease_expires_at IS NULL OR julianday(j.lease_expires_at)>julianday(?)))
        AND NOT EXISTS(SELECT 1 FROM research_jobs j WHERE j.match_id=b.match_id AND j.status='CLAIMED'
          AND (j.lease_expires_at IS NULL OR julianday(j.lease_expires_at)>julianday(?)))`,
      args: [at.toISOString(), reason, bet.betId, bet.family, bet.matchId, at.toISOString(), plan.dayStartAt, plan.dayEndAt, at.toISOString(), at.toISOString()],
    })));
    if (results.some(result => result.rowsAffected !== 1)) fail('cancellation_race');
    const after = await snapshotInTransaction(tx, plan.day);
    const beforeRows = fingerprints(current).tableRows, afterRows = fingerprints(after).tableRows;
    if (TABLES.filter(table => table !== 'paper_model_bet_cancellations').some(table => objectHash(beforeRows[table]) !== objectHash(afterRows[table]))) fail('unexpected_table_change');
    const old = new Set(current.tables.paper_model_bet_cancellations.map(row => row.bet_id));
    const inserted = after.tables.paper_model_bet_cancellations.filter(row => !old.has(row.bet_id));
    if (objectHash(inserted.map(row => row.bet_id).sort()) !== objectHash(plan.bets.map(bet => bet.betId).sort())
      || inserted.some(row => row.reason !== reason || row.cancelled_at !== at.toISOString())) fail('cancellation_verification_failed');
    if (objectHash(walletBalances(after)) !== objectHash(plan.wallets)) fail('wallet_changed');
    if (nowAt(options.clock).getTime() >= Math.min(...plan.bets.map(bet => Date.parse(bet.kickoffAt)))) fail('kickoff_crossed');
    await tx.commit();
    return { mode: 'execute', ok: true, day: plan.day, cancelledBets: inserted.length, preservedPaperBets: plan.bets.length,
      targetSha256: options.targetSha256, planSha256: options.expectedPlanSha256, backupFile: backupFile.path, backupSha256: backupFile.sha256,
      backupKind: backup.kind, wallets: plan.wallets, migration: MIGRATION, migrationApplied: !migrationApplied,
      ledgerChanged: false, providerRequests: 0 };
  } catch (error) {
    try { await tx.rollback(); } catch { /* No cancellation is accepted without commit. */ }
    throw error;
  } finally { tx.close(); }
}

function parseArgs(argv) {
  const options = { execute: false, expectedCount: 26 };
  const values = { '--target-sha256': 'targetSha256', '--day': 'day', '--out': 'out', '--expected-count': 'expectedCount',
    '--plan-file': 'planFile', '--expected-plan-sha256': 'expectedPlanSha256', '--backup-file': 'backupFile' };
  const seen = new Set();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (seen.has(arg)) fail('argument_duplicate');
    seen.add(arg);
    if (arg === '--plan') options.plan = true;
    else if (arg === '--execute') options.execute = true;
    else if (arg === '--authorize-wallet-transition') options.authorizeWalletTransition = true;
    else if (values[arg] && typeof argv[index + 1] === 'string' && !argv[index + 1].startsWith('--')) options[values[arg]] = argv[++index];
    else fail('argument_invalid');
  }
  options.expectedCount = Number(options.expectedCount);
  if (!validHash(options.targetSha256)) fail('target_hash_required');
  if (options.execute) {
    if (options.plan || options.out || !options.authorizeWalletTransition || !options.planFile || !options.backupFile || !validHash(options.expectedPlanSha256)) fail('execute_arguments_required');
  } else if (!options.day || !options.out || options.authorizeWalletTransition || options.planFile || options.backupFile || options.expectedPlanSha256) fail('plan_arguments_required');
  return options;
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv), env = dependencies.env ?? process.env;
  const { url, remote } = validateTarget(env, options.targetSha256);
  const token = String((options.execute ? env.TURSO_AUTH_TOKEN : env.TURSO_WATCHDOG_READONLY_TOKEN) ?? '').trim();
  if (remote && !token) fail(options.execute ? 'write_token_required' : 'readonly_token_required');
  const createClient = dependencies.createClient ?? require('@libsql/client').createClient;
  let client;
  try { client = createClient({ url, ...(token ? { authToken: token } : {}) }); } catch { fail('client_create_failed'); }
  try {
    const runOptions = { ...options, clock: dependencies.clock ?? (() => new Date()) };
    const summary = options.execute ? await executeTransition(client, runOptions) : await planTransition(client, runOptions);
    (dependencies.log ?? (value => console.log(JSON.stringify(value))))(summary);
    return summary;
  } catch (error) {
    if (typeof error.message === 'string' && /^wallet_transition_[a-z_]+$/.test(error.message)) throw error;
    fail('database_operation_failed');
  } finally { client.close(); }
}

module.exports = { PROTOCOL, MIGRATION, TABLES, MAX_BETS, MAX_ROWS, MAX_BYTES, targetFingerprint, validateTarget,
  readMigration, readSnapshot, snapshotInTransaction, walletBalances, fingerprints, objectHash, assertIdle,
  buildPlan, writePrivateJson, parseArgs, planTransition, executeTransition, main };
if (require.main === module) main().catch(error => {
  console.error(JSON.stringify({ ok: false, code: /^wallet_transition_[a-z_]+$/.test(error.message) ? error.message : 'wallet_transition_failed', providerRequests: 0 }));
  process.exitCode = 1;
});
