const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve, basename, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { main, parseArgs, readMigrations, MIGRATIONS } = require('../scripts/transition-dynamic-wallet');
const { targetFingerprint, TABLES } = require('../scripts/transition-funded-wallet');
const NOW = '2026-11-07T08:00:00.000Z', KICKOFF = '2026-11-07T18:00:00.000Z';
const fileHash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const migration = filename => readFileSync(join(__dirname, '../migrations', filename), 'utf8');

async function fixture(count = 20, applied = false) {
  const directory = mkdtempSync(join(tmpdir(), 'dynamic-wallet-transition-'));
  const url = pathToFileURL(join(directory, 'fixture.db')).href, client = createClient({ url });
  await client.executeMultiple(`CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER);
    CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT(datetime('now')));
    ${['015_research_platform.sql', '023_research_recommendation_execution.sql', '024_research_bet_cancellations.sql',
    '026_manual_model_bets.sql', '028_paper_model_bets.sql', '029_funded_model_bets.sql'].map(migration).join('\n')}`);
  await client.batch([
    { sql: 'INSERT INTO schema_migrations(version) VALUES (?)', args: ['029_funded_model_bets.sql'] },
    ...['A', 'C'].flatMap(family => [
      { sql: 'INSERT INTO research_portfolios VALUES (?,?,?)', args: [`shadow_${family}`, family, NOW] },
      { sql: "INSERT INTO research_ledger VALUES (?,?,NULL,'OPEN',?,0,?)", args: [`open-${family}`, `shadow_${family}`, family === 'A' ? 105129 : 96602, NOW] },
    ]),
    { sql: 'INSERT INTO matches VALUES (?,?,NULL,NULL)', args: ['fixture', KICKOFF] },
    { sql: 'INSERT INTO research_execution_policies VALUES (?,?,?,?)', args: ['fixed-policy', 'funded-confidence-v1', '{}', NOW] },
    { sql: 'INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      args: ['origin-job', 'fixture', KICKOFF, NOW, 'COMPLETED', NOW, NOW] },
    { sql: 'INSERT INTO research_inputs VALUES (?,?,?,?,?,?)', args: ['origin-input', 'origin-job', 'hash', '{}', NOW, KICKOFF] },
    { sql: 'INSERT INTO research_execution_jobs(id,match_id,policy_hash,run_id,kickoff_at,window_start_at,window_end_at,status,claimed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      args: ['execution-job', 'fixture', 'fixed-policy', 'parent-run', KICKOFF, NOW, KICKOFF, 'COMPLETED', NOW, NOW, NOW] },
    { sql: 'INSERT INTO research_execution_inputs VALUES (?,?,?,?,?,?,?,?)', args: ['execution-input', 'execution-job', 'origin-input', 'hash', 'hash', '{}', NOW, KICKOFF] },
  ], 'write');
  const selections = Array.from({ length: count }, (_, index) => ({ selectionKey: `selection-${index}`, market: 'totals', selection: `over-${index}`,
    quote: { odds: 2, selection: `over-${index}` }, confidence: 'HIGH', stakeCents: 4830, stakePercent: 5, baseAvailableCents: 96602 }));
  for (const family of ['A', 'C']) await client.batch([
    { sql: 'INSERT INTO research_decisions(id,job_id,input_id,family,model_version,market,selection,portfolio_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      args: [`origin-${family}`, 'origin-job', 'origin-input', family, `${family}-fixture`, 'totals', 'selection', `shadow_${family}`, family === 'A' ? 'ABSTAIN' : 'BET', '{}', NOW] },
    { sql: 'INSERT INTO research_execution_decisions(id,input_id,origin_decision_id,family,model_version,portfolio_id,action,market,selection,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      args: [`execution-${family}`, 'execution-input', `origin-${family}`, family, `${family}-fixture`, `shadow_${family}`, family === 'A' ? 'ABSTAIN' : 'BET', 'totals', 'selection',
        JSON.stringify({ stakeMode: 'CONFIDENCE_PERCENT_AVAILABLE', selections: family === 'C' ? selections : [] }), NOW] },
  ], 'write');
  for (const [index, selection] of selections.entries()) {
    const betId = `funded:${String(index).padStart(3, '0')}`;
    const snapshot = { quote: selection.quote, stakeMode: 'CONFIDENCE_PERCENT_AVAILABLE', effectiveExecutionDecisionId: 'execution-C', kickoffAt: KICKOFF,
      stakeCents: 4830, stakePercent: 5, baseAvailableCents: 96602, confidence: 'HIGH' };
    await client.batch([
      { sql: 'INSERT INTO funded_model_bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [betId, 'execution-C', 'origin-C', 'execution-input', 'fixed-policy', 'shadow_C',
        'C', 'fixture', 'C-fixture', selection.market, selection.selection, selection.selectionKey, 2, 4830, 5, 96602, 'HIGH', JSON.stringify(snapshot), NOW] },
      { sql: "INSERT INTO research_ledger VALUES (?,?,NULL,'STAKE',?,?,?)", args: [`stake:${betId}`, 'shadow_C', -4830, 4830, NOW] },
    ], 'write');
  }
  // Unrelated manual history remains outside cancellation and refund scope.
  await client.batch([
    { sql: 'INSERT INTO manual_model_bets VALUES (?,?,?,?,?,?,?,?,?,?,?)', args: ['manual-history', 'shadow_A', 'past-fixture', 'A', 'A-old', '1x2', 'home', 2, 100, '{}', NOW] },
    { sql: 'INSERT INTO manual_model_settlements VALUES (?,?,?,?,?)', args: ['manual-history', 1, 100, '{}', NOW] },
    { sql: "INSERT INTO research_ledger VALUES ('manual-stake','shadow_A',NULL,'STAKE',-100,100,?)", args: [NOW] },
    { sql: "INSERT INTO research_ledger VALUES ('manual-return','shadow_A',NULL,'SETTLE',100,-100,?)", args: [NOW] },
  ], 'write');
  if (applied) for (const filename of MIGRATIONS) {
    await client.executeMultiple(migration(filename));
    await client.execute({ sql: 'INSERT INTO schema_migrations(version) VALUES (?)', args: [filename] });
  }
  const target = targetFingerprint(url), out = join(directory, 'plan.json'), backupFile = join(directory, 'backup.json');
  const env = { TURSO_DATABASE_URL: url, TURSO_WATCHDOG_READONLY_TOKEN: 'synthetic-ro', TURSO_AUTH_TOKEN: 'synthetic-write' };
  const dependencies = { env, clock: () => new Date(NOW), log: () => {} };
  const planArgs = ['--target-sha256', target, '--day', '2026-11-07', '--expected-count', String(count), '--out', out];
  const executeArgs = () => ['--execute', '--authorize-dynamic-wallet-transition', '--target-sha256', target, '--plan-file', out,
    '--expected-plan-sha256', fileHash(out), '--backup-file', backupFile];
  return { client, directory, target, out, backupFile, env, dependencies, planArgs, executeArgs,
    plan: overrides => main(planArgs, { ...dependencies, ...overrides }), execute: overrides => main(executeArgs(), { ...dependencies, ...overrides }),
    cleanup() { client.close(); const location = resolve(directory), root = resolve(tmpdir());
      assert.ok(location.startsWith(`${root}${sep}`) && basename(location).startsWith('dynamic-wallet-transition-'));
      try { rmSync(location, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }); }
      catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; } } };
}

function hookedClient(config, hooks = {}) {
  const raw = createClient(config);
  return { transaction: mode => raw.transaction(mode), execute: statement => raw.execute(statement), close: () => raw.close(),
    async executeMultiple(sql) {
      if (hooks.ddl) return hooks.ddl(raw, sql);
      await raw.executeMultiple(sql);
      if (hooks.afterDdl) await hooks.afterDdl(raw);
    } };
}

test('default plan is read-only, binds the exact twenty original stakes and predicts unchanged equity', async () => {
  const f = await fixture();
  try {
    let config;
    const result = await f.plan({ createClient: value => { config = value; return createClient(value); } });
    assert.equal(config.authToken, 'synthetic-ro'); assert.equal(result.databaseWrites, 0); assert.equal(result.providerRequests, 0);
    assert.equal(result.bets, 20); assert.equal(result.refundCents, 96600); assert.equal(result.planSha256, fileHash(f.out));
    assert.deepEqual(result.wallets.map(row => [row.availableCents, row.committedCents]), [[105129, 0], [2, 96600]]);
    assert.deepEqual(result.expectedWallets.map(row => [row.availableCents, row.committedCents]), [[105129, 0], [96602, 0]]);
    const document = JSON.parse(readFileSync(f.out, 'utf8'));
    assert.equal(document.sources.length, 20); assert.ok(document.sources.every(row => row.rowSha256.length === 64 && row.stakeLedgerSha256.length === 64));
    assert.deepEqual(document.migrations.map(row => row.filename), MIGRATIONS);
    assert.doesNotMatch(readFileSync(f.out, 'utf8'), /synthetic-ro|synthetic-write|file:\//);
    assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='dynamic_model_bets'")).rows[0].n), 0);
    await assert.rejects(f.plan(), /operation_failed/);
  } finally { f.cleanup(); }
});

test('execute preserves all source/history rows and refunds exactly once through migration 031 triggers', async () => {
  const f = await fixture();
  try {
    const sources = JSON.stringify((await f.client.execute('SELECT * FROM funded_model_bets ORDER BY id')).rows);
    const oldLedger = (await f.client.execute('SELECT * FROM research_ledger ORDER BY id')).rows;
    const manual = JSON.stringify((await f.client.execute('SELECT * FROM manual_model_bets')).rows);
    await f.plan(); const result = await f.execute();
    assert.equal(result.cancelledBets, 20); assert.equal(result.refundCents, 96600); assert.equal(result.preservedSourceBets, 20);
    assert.deepEqual(result.walletsAfter.map(row => row.availableCents), [105129, 96602]);
    assert.equal(result.backupSha256, fileHash(f.backupFile));
    const backup = JSON.parse(readFileSync(f.backupFile, 'utf8'));
    assert.deepEqual(Object.keys(backup.snapshot.tables).sort(), [...TABLES].sort()); assert.equal(backup.snapshot.tables.funded_model_bets.length, 20);
    if (process.platform !== 'win32') assert.equal(statSync(f.backupFile).mode & 0o777, 0o600);
    assert.equal(JSON.stringify((await f.client.execute('SELECT * FROM funded_model_bets ORDER BY id')).rows), sources);
    assert.equal(JSON.stringify((await f.client.execute('SELECT * FROM manual_model_bets')).rows), manual);
    const afterLedger = (await f.client.execute('SELECT * FROM research_ledger ORDER BY id')).rows;
    for (const row of oldLedger) assert.deepEqual(afterLedger.find(candidate => candidate.id === row.id), row);
    const refunds = afterLedger.filter(row => row.id.startsWith('cancel:funded:'));
    assert.equal(refunds.length, 20); assert.ok(refunds.every(row => row.event === 'SETTLE' && row.bet_id === null && row.available_delta_cents === 4830 && row.committed_delta_cents === -4830));
    await assert.rejects(f.execute(), /source_set_changed/);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM funded_model_bet_cancellations')).rows[0].n), 20);
    await assert.rejects(f.client.execute("INSERT INTO funded_model_settlements VALUES ('funded:000',0,0,'{}',?)", [NOW]), /cannot be settled/);
  } finally { f.cleanup(); }
});

test('target, authorization, plan hash and migration-file identities guard every write', async () => {
  const f = await fixture(2);
  try {
    await f.plan(); let clients = 0;
    const bad = [...f.planArgs]; bad[1] = 'a'.repeat(64);
    await assert.rejects(main(bad, { ...f.dependencies, createClient: () => { clients++; } }), /target_mismatch/); assert.equal(clients, 0);
    assert.throws(() => parseArgs(f.executeArgs().filter(arg => arg !== '--authorize-dynamic-wallet-transition')), /execute_arguments_required/);
    const badHash = f.executeArgs(); badHash[badHash.indexOf('--expected-plan-sha256') + 1] = 'b'.repeat(64);
    await assert.rejects(main(badHash, f.dependencies), /plan_hash_mismatch/);
    const plan = JSON.parse(readFileSync(f.out, 'utf8')); plan.migrations[0].sha256 = 'c'.repeat(64); writeFileSync(f.out, JSON.stringify(plan));
    await assert.rejects(f.execute(), /migration_changed/); assert.equal(existsSync(f.backupFile), false);
  } finally { f.cleanup(); }
});

test('default remote planning never falls back to write credentials', async () => {
  const env = { TURSO_DATABASE_URL: 'libsql://synthetic.invalid', TURSO_AUTH_TOKEN: 'write-only' };
  let opens = 0;
  await assert.rejects(main(['--target-sha256', targetFingerprint(env.TURSO_DATABASE_URL), '--day', '2026-11-07', '--expected-count', '20', '--out', 'unused.json'],
    { env, createClient: () => { opens++; } }), /readonly_token_required/);
  assert.equal(opens, 0);
});

test('stale results, kickoff, settlements, leases and balances stop before schema or cancellation writes', async () => {
  for (const change of ['result', 'kickoff', 'settlement', 'lease', 'balance']) {
    const f = await fixture(2);
    try {
      await f.plan();
      if (change === 'result') await f.client.execute('UPDATE matches SET home_goals=0,away_goals=0');
      if (change === 'kickoff') await f.client.execute("UPDATE matches SET date='2026-11-07T07:00:00Z'");
      if (change === 'settlement') await f.client.execute("INSERT INTO funded_model_settlements VALUES ('funded:000',0,0,'{\"fixture\":true}',?)", [NOW]);
      if (change === 'lease') await f.client.execute("UPDATE research_execution_jobs SET status='CLAIMED',lease_expires_at='2026-11-07T09:00:00Z'");
      if (change === 'balance') await f.client.execute("UPDATE research_ledger SET available_delta_cents=96601 WHERE id='open-C'");
      await assert.rejects(f.execute(), /source_set_changed|wallet_changed|operation_failed/);
      assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='funded_model_bet_cancellations'")).rows[0].n), 0);
    } finally { f.cleanup(); }
  }
});

test('backup is exclusive and complete before additive schema writes; DDL failure rolls back both migrations', async () => {
  for (const failure of ['backup', 'ddl']) {
    const f = await fixture(2);
    try {
      await f.plan(); if (failure === 'backup') writeFileSync(f.backupFile, 'keep-private-backup');
      await assert.rejects(f.execute({ createClient: config => hookedClient(config, { ddl: (raw, sql) => {
        assert.equal(existsSync(f.backupFile), true);
        return raw.executeMultiple(sql.replace("INSERT INTO schema_migrations(version) VALUES ('031_dynamic_funded_cancellations.sql')",
          "INSERT INTO missing_transition_table(version) VALUES ('031_dynamic_funded_cancellations.sql')"));
      } }) }), /operation_failed|migration_apply_failed/);
      assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('dynamic_model_bets','funded_model_bet_cancellations')")).rows[0].n), 0);
      if (failure === 'backup') assert.equal(readFileSync(f.backupFile, 'utf8'), 'keep-private-backup');
    } finally { f.cleanup(); }
  }
});

test('a post-migration race and a second-insert trigger failure roll back every refund and cancellation', async () => {
  for (const failure of ['race', 'insert']) {
    const f = await fixture(2, failure === 'insert');
    try {
      if (failure === 'insert') await f.client.executeMultiple("CREATE TRIGGER fixture_reject_second BEFORE INSERT ON funded_model_bet_cancellations WHEN NEW.bet_id='funded:001' BEGIN SELECT RAISE(ABORT,'private synthetic failure'); END;");
      await f.plan();
      const options = failure === 'race' ? { createClient: config => hookedClient(config, {
        afterDdl: raw => raw.execute('UPDATE matches SET home_goals=1,away_goals=0'),
      }) } : {};
      await assert.rejects(f.execute(options), /source_set_changed|operation_failed/);
      assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM funded_model_bet_cancellations')).rows[0].n), 0);
      assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM research_ledger WHERE id LIKE 'cancel:%'")).rows[0].n), 0);
      assert.equal(Number((await f.client.execute("SELECT SUM(committed_delta_cents) AS n FROM research_ledger WHERE portfolio_id='shadow_C'")).rows[0].n), 9660);
    } finally { f.cleanup(); }
  }
});

test('already-applied migrations are verified and existing cancellations are excluded without rewriting history', async () => {
  const f = await fixture(2, true);
  try {
    await f.client.execute("INSERT INTO funded_model_bet_cancellations VALUES ('funded:000',?,'earlier-authorized-cancellation')", [NOW]);
    f.planArgs[f.planArgs.indexOf('--expected-count') + 1] = '1';
    await f.plan(); const result = await f.execute();
    assert.equal(result.cancelledBets, 1); assert.deepEqual(result.migrationsApplied, []);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM funded_model_bet_cancellations')).rows[0].n), 2);
    assert.equal(Number((await f.client.execute("SELECT SUM(available_delta_cents) AS n FROM research_ledger WHERE portfolio_id='shadow_C'")).rows[0].n), 96602);
    assert.equal(readMigrations().length, 2);
  } finally { f.cleanup(); }
});
