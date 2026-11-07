const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join, basename, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const { createClient } = require('@libsql/client');
const { main, parseArgs, targetFingerprint, MIGRATION, TABLES, readSnapshot } = require('../scripts/transition-funded-wallet');

const NOW = '2026-11-07T08:00:00.000Z', KICKOFF = '2026-11-07T18:00:00.000Z';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = path => sha256(readFileSync(path));
const migration = name => readFileSync(join(__dirname, '../migrations', name), 'utf8');

async function fixture(count = 2, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'funded-transition-'));
  const url = pathToFileURL(join(directory, 'fixture.db')).href;
  const client = createClient({ url });
  await client.executeMultiple(`CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER);
    CREATE TABLE schema_migrations(version TEXT PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT(datetime('now')));
    ${migration('015_research_platform.sql')}
    ${migration('023_research_recommendation_execution.sql')}
    ${migration('024_research_bet_cancellations.sql')}
    ${migration('026_manual_model_bets.sql')}
    ${migration('028_paper_model_bets.sql')}`);
  await client.batch([
    { sql: 'INSERT INTO schema_migrations(version) VALUES (?)', args: ['028_paper_model_bets.sql'] },
    ...['A', 'C'].flatMap(family => [
      { sql: 'INSERT INTO research_portfolios VALUES (?,?,?)', args: [`shadow_${family}`, family, NOW] },
      { sql: "INSERT INTO research_ledger VALUES (?,?,NULL,'OPEN',10000,0,?)", args: [`open-${family}`, `shadow_${family}`, NOW] },
    ]),
    { sql: 'INSERT INTO research_execution_policies VALUES (?,?,?,?)', args: ['paper-policy', 'paper-fixed-unit-v1', '{}', NOW] },
  ], 'write');
  for (let index = 0; index < Math.ceil(count / 2); index++) {
    const matchId = `match-${index}`, originJob = `origin-job-${index}`, originInput = `origin-input-${index}`;
    const executionJob = `execution-job-${index}`, executionInput = `execution-input-${index}`;
    await client.batch([
      { sql: 'INSERT INTO matches VALUES (?,?,NULL,NULL)', args: [matchId, KICKOFF] },
      { sql: 'INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        args: [originJob, matchId, KICKOFF, NOW, 'COMPLETED', NOW, NOW] },
      { sql: 'INSERT INTO research_inputs VALUES (?,?,?,?,?,?)', args: [originInput, originJob, 'input-hash', '{}', NOW, KICKOFF] },
      { sql: 'INSERT INTO research_execution_jobs(id,match_id,policy_hash,run_id,kickoff_at,window_start_at,window_end_at,status,claimed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        args: [executionJob, matchId, 'paper-policy', 'run', KICKOFF, NOW, KICKOFF, 'COMPLETED', NOW, NOW, NOW] },
      { sql: 'INSERT INTO research_execution_inputs VALUES (?,?,?,?,?,?,?,?)', args: [executionInput, executionJob, originInput, 'input-hash', 'decisions-hash', '{}', NOW, KICKOFF] },
    ], 'write');
    for (const [familyIndex, family] of ['A', 'C'].entries()) {
      if (index * 2 + familyIndex >= count) break;
      const id = `paper-${index}-${family}`, originDecision = `origin-decision-${index}-${family}`;
      const executionDecision = `execution-decision-${index}-${family}`, selection = 'over25';
      const quote = { selection, odds: 2, source: 'odds_api' };
      const selected = { selectionKey: 'totals-over-2.5', market: 'totals', selection, quote };
      const snapshot = { stakeMode: 'PAPER_FIXED_UNIT', stakeCents: 100, effectiveExecutionDecisionId: executionDecision, quote };
      await client.batch([
        { sql: 'INSERT INTO research_decisions(id,job_id,input_id,family,model_version,market,selection,portfolio_id,action,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          args: [originDecision, originJob, originInput, family, `${family}-fixture`, 'totals', selection, `shadow_${family}`, 'BET', '{}', NOW] },
        { sql: 'INSERT INTO research_execution_decisions(id,input_id,origin_decision_id,family,model_version,portfolio_id,action,market,selection,snapshot_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
          args: [executionDecision, executionInput, originDecision, family, `${family}-fixture`, `shadow_${family}`, 'BET', 'totals', selection,
            JSON.stringify({ stakeMode: 'PAPER_FIXED_UNIT', selections: [selected] }), NOW] },
        { sql: 'INSERT INTO paper_model_bets VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', args: [id, executionDecision, originDecision, executionInput,
          'paper-policy', family, matchId, `${family}-fixture`, 'totals', selection, selected.selectionKey, 2, 100, JSON.stringify(snapshot), NOW] },
      ], 'write');
    }
  }
  if (options.applied) {
    await client.executeMultiple(migration(MIGRATION));
    await client.execute({ sql: 'INSERT INTO schema_migrations(version) VALUES (?)', args: [MIGRATION] });
  }
  const env = { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'synthetic-write-token', TURSO_WATCHDOG_READONLY_TOKEN: 'synthetic-read-token' };
  const target = targetFingerprint(url), planFile = join(directory, 'plan.json'), backupFile = join(directory, 'backup.json');
  const planArgs = ['--target-sha256', target, '--day', '2026-11-07', '--out', planFile, '--expected-count', String(count)];
  const dependencies = { env, clock: () => NOW, log: () => {} };
  const executeArgs = () => ['--execute', '--authorize-wallet-transition', '--target-sha256', target, '--plan-file', planFile,
    '--expected-plan-sha256', fileHash(planFile), '--backup-file', backupFile];
  return { client, directory, env, target, planFile, backupFile, planArgs, dependencies, executeArgs,
    async plan(extra = {}) { return main(planArgs, { ...dependencies, ...extra }); },
    async execute(extra = {}) { return main(executeArgs(), { ...dependencies, ...extra }); },
    cleanup() {
      client.close();
      const location = resolve(directory), root = resolve(tmpdir());
      assert.ok(location.startsWith(`${root}${sep}`) && basename(location).startsWith('funded-transition-'));
      try { rmSync(location, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 }); }
      catch (error) { if (!['EPERM', 'EBUSY'].includes(error.code)) throw error; }
    } };
}

function observedClient(config, statements, hooks = {}) {
  const raw = createClient(config);
  return {
    async transaction(mode) {
      statements.push({ mode });
      const tx = await raw.transaction(mode);
      return {
        execute(statement) { statements.push(statement); return tx.execute(statement); },
        batch(batch) { statements.push(...batch); return tx.batch(batch); },
        commit: () => tx.commit(), rollback: () => tx.rollback(), close: () => tx.close(),
      };
    },
    async executeMultiple(sql) {
      statements.push({ ddl: sql });
      if (hooks.ddl) return hooks.ddl(raw, sql);
      await raw.executeMultiple(sql);
      if (hooks.afterDdl) await hooks.afterDdl(raw);
    },
    execute: statement => raw.execute(statement), close: () => raw.close(),
  };
}

test('default plan performs only bounded SELECTs in a read snapshot and creates a private exclusive plan', async () => {
  const f = await fixture(), statements = [], configs = [];
  try {
    const result = await f.plan({ createClient: config => { configs.push(config); return observedClient(config, statements); } });
    assert.equal(result.mode, 'read-only-plan'); assert.equal(result.databaseWrites, 0); assert.equal(result.providerRequests, 0);
    assert.equal(result.bets, 2); assert.equal(result.planSha256, fileHash(f.planFile));
    assert.deepEqual(result.wallets.map(wallet => wallet.availableCents), [10000, 10000]);
    assert.deepEqual(statements.filter(statement => statement.mode).map(statement => statement.mode), ['read']);
    for (const statement of statements.filter(statement => !statement.mode)) {
      assert.match(statement.sql ?? statement, /^SELECT\b/);
      assert.doesNotMatch(statement.sql ?? statement, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA)\b/);
    }
    assert.equal(configs[0].authToken, 'synthetic-read-token');
    const document = readFileSync(f.planFile, 'utf8');
    for (const secret of [f.env.TURSO_AUTH_TOKEN, f.env.TURSO_WATCHDOG_READONLY_TOKEN, f.env.TURSO_DATABASE_URL]) assert.ok(!document.includes(secret));
    assert.ok(!document.includes('snapshot_json')); assert.ok(!document.includes('lease_token'));
    if (process.platform !== 'win32') assert.equal(statSync(f.planFile).mode & 0o777, 0o600);
    await assert.rejects(f.plan(), /private_output_create_failed/);
    assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='funded_model_bets'")).rows[0].n), 0);
  } finally { f.cleanup(); }
});

test('explicit execution cancels exactly 26 paper rows while preserving evidence, wallet ledger and balances', async () => {
  const f = await fixture(26);
  try {
    const ledger = JSON.stringify((await f.client.execute('SELECT * FROM research_ledger ORDER BY id')).rows);
    await f.plan();
    const result = await f.execute();
    assert.equal(result.cancelledBets, 26); assert.equal(result.preservedPaperBets, 26); assert.equal(result.ledgerChanged, false);
    assert.equal(result.backupSha256, fileHash(f.backupFile)); assert.equal(result.migration, MIGRATION);
    assert.equal(result.backupKind, 'PARTIAL_WALLET_EXECUTION_BACKUP_NOT_FULL_DATABASE');
    const backup = JSON.parse(readFileSync(f.backupFile, 'utf8'));
    assert.deepEqual(Object.keys(backup.snapshot.tables).sort(), [...TABLES].sort());
    assert.equal(backup.snapshot.tables.paper_model_bets.length, 26);
    assert.ok(!JSON.stringify(backup).includes('synthetic-write-token'));
    assert.ok(!Object.keys(backup.snapshot.tables).some(table => /smart_odds|sessions|users/.test(table)));
    if (process.platform !== 'win32') assert.equal(statSync(f.backupFile).mode & 0o777, 0o600);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM paper_model_bets')).rows[0].n), 26);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM paper_model_bet_cancellations')).rows[0].n), 26);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM funded_model_bets')).rows[0].n), 0);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM paper_model_bets b LEFT JOIN paper_model_bet_cancellations c ON c.bet_id=b.id WHERE c.bet_id IS NULL')).rows[0].n), 0);
    assert.equal(JSON.stringify((await f.client.execute('SELECT * FROM research_ledger ORDER BY id')).rows), ledger);
    const versions = (await f.client.execute('SELECT version FROM schema_migrations')).rows.map(row => row.version);
    assert.ok(versions.includes(MIGRATION)); assert.ok(!versions.includes('29'));
    await assert.rejects(f.client.execute("DELETE FROM paper_model_bet_cancellations WHERE bet_id='paper-0-A'"), /immutable/);
    await assert.rejects(f.execute(), /source_bets_changed/);
  } finally { f.cleanup(); }
});

test('existing cancellations and settlements are excluded, and an applied migration needs no DDL', async () => {
  const f = await fixture(4, { applied: true }), statements = [];
  try {
    await f.client.execute({ sql: 'INSERT INTO paper_model_bet_cancellations VALUES (?,?,?)', args: ['paper-0-A', NOW, 'already cancelled'] });
    await f.client.execute({ sql: 'INSERT INTO paper_model_settlements VALUES (?,?,?,?,?)', args: ['paper-0-C', 0, 0, '{}', NOW] });
    f.planArgs[f.planArgs.length - 1] = '2';
    assert.equal((await f.plan()).bets, 2);
    const result = await f.execute({ createClient: config => observedClient(config, statements) });
    assert.equal(result.cancelledBets, 2); assert.equal(result.migrationApplied, false);
    assert.ok(!statements.some(statement => statement.ddl));
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM paper_model_bet_cancellations')).rows[0].n), 3);
  } finally { f.cleanup(); }
});

test('target, plan hash, authorization and migration guards run before any database write', async () => {
  const f = await fixture();
  try {
    await f.plan();
    let clients = 0;
    await assert.rejects(main(['--target-sha256', 'a'.repeat(64), '--day', '2026-11-07', '--out', f.planFile], {
      ...f.dependencies, createClient: () => { clients++; throw Error('credential-must-not-leak'); },
    }), /target_mismatch/);
    assert.equal(clients, 0);
    assert.throws(() => parseArgs(f.executeArgs().filter(arg => arg !== '--authorize-wallet-transition')), /execute_arguments_required/);
    const badHash = f.executeArgs(), hashIndex = badHash.indexOf('--expected-plan-sha256') + 1;
    badHash[hashIndex] = 'a'.repeat(64);
    await assert.rejects(main(badHash, f.dependencies), /plan_hash_mismatch/);
    const document = JSON.parse(readFileSync(f.planFile, 'utf8'));
    document.migration.sha256 = 'a'.repeat(64);
    writeFileSync(f.planFile, JSON.stringify(document));
    await assert.rejects(f.execute(), /migration_changed/);
    assert.equal(existsSync(f.backupFile), false);
    assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='paper_model_bet_cancellations'")).rows[0].n), 0);
  } finally { f.cleanup(); }
});

test('remote default plan requires the dedicated read-only token without write-token fallback', async () => {
  const env = { TURSO_DATABASE_URL: 'libsql://synthetic.example', TURSO_AUTH_TOKEN: 'must-not-be-used' };
  const args = ['--day', '2026-11-07', '--out', 'unused.json', '--target-sha256', targetFingerprint(env.TURSO_DATABASE_URL)];
  let calls = 0;
  await assert.rejects(main(args, { env, createClient: () => { calls++; } }), /readonly_token_required/);
  assert.equal(calls, 0);
});

test('backup is exclusive and a stale balance or result blocks all cancellation writes', async () => {
  for (const change of ['backup', 'ledger', 'settlement', 'kickoff', 'result', 'lease']) {
    const f = await fixture();
    try {
      await f.plan();
      if (change === 'backup') writeFileSync(f.backupFile, 'preserve-existing-private-file');
      if (change === 'ledger') await f.client.execute("UPDATE research_ledger SET available_delta_cents=9999 WHERE id='open-A'");
      if (change === 'settlement') await f.client.execute({ sql: 'INSERT INTO paper_model_settlements VALUES (?,?,?,?,?)', args: ['paper-0-A', 0, 0, '{}', NOW] });
      if (change === 'kickoff') await f.client.execute("UPDATE matches SET date='2026-11-07T07:00:00Z'");
      if (change === 'result') await f.client.execute('UPDATE matches SET home_goals=1,away_goals=0');
      if (change === 'lease') await f.client.execute("UPDATE research_execution_jobs SET status='CLAIMED',lease_expires_at='2026-11-07T09:00:00Z'");
      await assert.rejects(f.execute(), /wallet_transition_(?:private_output_create_failed|wallet_changed|source_bets_changed|active_job_lease)/, change);
      if (change === 'backup') assert.equal(readFileSync(f.backupFile, 'utf8'), 'preserve-existing-private-file');
      assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='paper_model_bet_cancellations'")).rows[0].n), 0);
    } finally { f.cleanup(); }
  }
});

test('failed DDL rolls back its partial schema and stops before cancellation', async () => {
  const f = await fixture();
  try {
    await f.plan();
    await assert.rejects(f.execute({ createClient: config => observedClient(config, [], {
      ddl: (client, sql) => client.executeMultiple(sql.replace("INSERT OR IGNORE INTO schema_migrations", 'INSERT INTO missing_transition_table')),
    }) }), /migration_apply_failed/);
    assert.ok(existsSync(f.backupFile));
    assert.equal(Number((await f.client.execute("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='paper_model_bet_cancellations'")).rows[0].n), 0);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=?', [MIGRATION])).rows[0].n), 0);
  } finally { f.cleanup(); }
});

test('a race after additive DDL is detected without accepting cancellations or changing the wallet', async () => {
  const f = await fixture();
  try {
    await f.plan();
    await assert.rejects(f.execute({ createClient: config => observedClient(config, [], {
      afterDdl: client => client.execute({ sql: 'INSERT INTO paper_model_settlements VALUES (?,?,?,?,?)', args: ['paper-0-A', 0, 0, '{}', NOW] }),
    }) }), /source_bets_changed/);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM paper_model_bet_cancellations')).rows[0].n), 0);
    assert.equal(Number((await f.client.execute('SELECT SUM(available_delta_cents) AS n FROM research_ledger')).rows[0].n), 20000);
  } finally { f.cleanup(); }
});

test('a failed guarded insert rolls back every cancellation in the batch', async () => {
  const f = await fixture(2, { applied: true });
  try {
    await f.client.executeMultiple("CREATE TRIGGER reject_second_cancellation BEFORE INSERT ON paper_model_bet_cancellations WHEN NEW.bet_id='paper-0-C' BEGIN SELECT RAISE(ABORT,'synthetic private database error'); END;");
    await f.plan();
    await assert.rejects(f.execute(), error => error.message === 'wallet_transition_database_operation_failed');
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM paper_model_bet_cancellations')).rows[0].n), 0);
  } finally { f.cleanup(); }
});

test('source schema changes, exact-count mismatches and altered migration-version schema fail closed', async () => {
  const f = await fixture();
  try {
    const args = [...f.planArgs]; args[args.length - 1] = '26';
    await assert.rejects(main(args, f.dependencies), /expected_count_mismatch/);
    await f.plan();
    await f.client.execute('ALTER TABLE research_execution_inputs ADD COLUMN unrelated_change TEXT');
    await assert.rejects(f.execute(), /source_rows_changed|source_schema_changed/);
    await f.client.executeMultiple('ALTER TABLE schema_migrations RENAME TO old_migrations; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);');
    await assert.rejects(main([...f.planArgs.slice(0, -2), '--expected-count', '2'], f.dependencies), /migration_version_schema_mismatch/);
  } finally { f.cleanup(); }
});

test('row and byte limits are checked before evidence rows are fetched', async () => {
  for (const [column, limit, code] of [['row_count', 50000, 'row_limit'], ['byte_count', 100 * 1024 * 1024, 'byte_limit']]) {
    const f = await fixture();
    let evidenceReads = 0;
    try {
      await assert.rejects(f.plan({ createClient: config => {
        const client = observedClient(config, []), transaction = client.transaction;
        client.transaction = async mode => {
          const tx = await transaction(mode), batch = tx.batch;
          tx.batch = async statements => {
            if (statements[0].sql.startsWith('SELECT COUNT(*)')) {
              const results = await batch(statements);
              results[0] = { rows: [{ row_count: 0, byte_count: 0, [column]: limit + 1 }] };
              return results;
            }
            evidenceReads++;
            return batch(statements);
          };
          return tx;
        };
        return client;
      } }), new RegExp(`wallet_transition_${code}`));
      assert.equal(evidenceReads, 0); assert.equal(existsSync(f.planFile), false);
    } finally { f.cleanup(); }
  }
});

test('new qualified paper rows invalidate the exact planned cancellation set', async () => {
  const f = await fixture(2, { applied: true });
  try {
    await f.plan();
    const quote = { selection: 'over35', odds: 2, source: 'odds_api' };
    const decision = (await f.client.execute("SELECT snapshot_json FROM research_execution_decisions WHERE id='execution-decision-0-A'")).rows[0];
    const snapshot = JSON.parse(decision.snapshot_json);
    snapshot.selections.push({ selectionKey: 'totals-over-3.5', market: 'totals', selection: 'over35', quote });
    await f.client.execute({ sql: 'UPDATE research_execution_decisions SET snapshot_json=? WHERE id=?', args: [JSON.stringify(snapshot), 'execution-decision-0-A'] });
    await f.client.execute({ sql: `INSERT INTO paper_model_bets SELECT 'new-paper',execution_decision_id,origin_decision_id,input_id,policy_hash,family,
      match_id,model_version,market,'over35','totals-over-3.5',odds,stake_cents,?,placed_at FROM paper_model_bets WHERE id='paper-0-A'`,
    args: [JSON.stringify({ stakeMode: 'PAPER_FIXED_UNIT', stakeCents: 100, effectiveExecutionDecisionId: 'execution-decision-0-A', quote })] });
    await assert.rejects(f.execute(), /source_bets_changed/);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM paper_model_bet_cancellations')).rows[0].n), 0);
  } finally { f.cleanup(); }
});

test('partial wallet snapshots include additive dynamic wagers and settlements without requiring migration 030', async () => {
  const f = await fixture();
  try {
    const before = await readSnapshot(f.client, '2026-11-07');
    assert.deepEqual(before.tables.dynamic_model_bets, []); assert.deepEqual(before.tables.dynamic_model_settlements, []);
    await f.client.executeMultiple(`CREATE TABLE dynamic_model_bets(id TEXT PRIMARY KEY,portfolio_id TEXT,stake_cents INTEGER);
      CREATE TABLE dynamic_model_settlements(bet_id TEXT PRIMARY KEY,return_cents INTEGER);
      INSERT INTO dynamic_model_bets VALUES ('dynamic:A','shadow_A',117),('dynamic:C','shadow_C',218),('unrelated','main',999);
      INSERT INTO dynamic_model_settlements VALUES ('dynamic:C',436),('unrelated',1998);`);
    const after = await readSnapshot(f.client, '2026-11-07');
    assert.deepEqual(after.tables.dynamic_model_bets.map(row => row.id), ['dynamic:A', 'dynamic:C']);
    assert.deepEqual(after.tables.dynamic_model_settlements.map(row => row.bet_id), ['dynamic:C']);
    assert.equal(Number((await f.client.execute('SELECT COUNT(*) AS n FROM schema_migrations WHERE version=?', ['030_dynamic_model_bets.sql'])).rows[0].n), 0);
  } finally { f.cleanup(); }
});
