const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, writeFileSync, mkdtempSync, rmSync } = require('node:fs');
const { resolve, join, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');
const { endpoint, packagedRelease, deployment, planReplacement, applyReplacement, parseArgs, main } = require('../scripts/replace-current-challenger');
const compiled = process.env.RESEARCH_TEST_DIST || '../dist';
const { researchHash } = require(resolve(__dirname, compiled, 'research/ResearchStore'));
const HOST = 'footpredictor-selloneciompi.aws-eu-west-1.turso.io';
const base = ['--expected-host', HOST, '--previous-version', 'C-previous', '--previous-artifact-hash', 'a'.repeat(64)];

async function fixture() {
  const directory = mkdtempSync(join(process.env.C_REPLACEMENT_TEST_DIRECTORY || tmpdir(), 'c-replacement-'));
  const db = createClient({ url: `file:${join(directory, 'test.db')}` });
  for (const migration of ['015_research_platform.sql', '025_challenger_adoption.sql']) {
    await db.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
  }
  const { artifact, target } = packagedRelease();
  const previousArtifact = { ...artifact, version: 'C-previous' };
  const previous = deployment(previousArtifact);
  await db.execute({ sql: "INSERT INTO research_models(family,version,artifact_json,artifact_hash,created_at) VALUES ('C',?,?,?,'2026-01-01')",
    args: [previousArtifact.version, JSON.stringify(previousArtifact), previous.artifactHash] });
  await db.executeMultiple("CREATE TABLE protected_account(id TEXT PRIMARY KEY,balance REAL); INSERT INTO protected_account VALUES ('A',1000),('C',1000)");
  const options = { host: `file:${join(directory, 'test.db')}`, previousVersion: previous.modelVersion, previousArtifactHash: previous.artifactHash };
  const planned = await planReplacement(db, options, join(directory, 'backup.json'));
  return { db, directory, target, previous, options, ...planned, close: () => db.close() };
}
async function expectUnchanged(fixture, operation, pattern) {
  await assert.rejects(operation, pattern);
  assert.equal(Number((await fixture.db.execute('SELECT COUNT(*) AS n FROM challenger_adoption_events')).rows[0].n), 0);
  assert.equal(Number((await fixture.db.execute('SELECT COUNT(*) AS n FROM research_models')).rows[0].n), 1);
}

if (process.platform === 'win32' && !process.env.C_REPLACEMENT_TEST_DIRECTORY) {
  test('current C replacement isolated SQLite suite', () => {
    const directory = mkdtempSync(join(tmpdir(), 'c-replacement-suite-'));
    try {
      const env = { ...process.env, C_REPLACEMENT_TEST_DIRECTORY: directory };
      delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', __filename], { encoding: 'utf8', env, timeout: 120000 });
      process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
      assert.equal(result.status, 0, result.error?.message || 'replacement suite failed');
      assert.match(result.stdout, /# fail 0\b/);
    } finally {
      const target = resolve(directory);
      assert.ok(target.startsWith(resolve(tmpdir()) + sep));
      rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
} else {
test('replacement requires pinned host, separate modes and explicit incumbent identity', () => {
  assert.throws(() => endpoint('libsql://example.com', HOST), /mismatch/);
  assert.throws(() => endpoint(`libsql://${HOST}`, ''), /expected_host/);
  assert.throws(() => endpoint(`https://${HOST}:123`, HOST), /mismatch/);
  assert.equal(endpoint(`libsql://${HOST}`, HOST).host, HOST);
  assert.throws(() => parseArgs([...base, '--plan', 'p', '--apply', 'p', '--backup', 'b']), /explicit_plan/);
  assert.throws(() => parseArgs(['--plan', 'p', '--backup', 'b']), /explicit_plan/);
  assert.throws(() => parseArgs([...base, '--plan', 'p', '--backup', 'b', '--plan', 'p']), /arguments/);
});
test('plan reads a consistent scoped snapshot using only SELECTs', async () => {
  const f = await fixture();
  try {
    const queries = [];
    const spy = { transaction: async mode => {
      assert.equal(mode, 'read');
      const tx = await f.db.transaction(mode);
      return { execute: input => { queries.push(typeof input === 'string' ? input : input.sql); return tx.execute(input); },
        rollback: () => tx.rollback(), close: () => tx.close() };
    } };
    const { plan, backup } = await planReplacement(spy, f.options, join(f.directory, 'other-backup.json'));
    assert.ok(queries.length > 0 && queries.every(sql => /^SELECT /.test(sql)));
    assert.equal(backup.format, 'scoped-current-c-backup-v1');
    assert.equal(backup.snapshot.latestEvent, null);
    assert.deepEqual(backup.snapshot.previous, f.previous);
    assert.equal(plan.independentEvidence, false);
    assert.equal(plan.productionValidated, false);
    assert.equal(plan.retirePrevious, true);
    assert.ok(!JSON.stringify(backup).includes('"balance":'));
  } finally { f.close(); }
});
test('apply inserts C registry records and preserves history and account values', async () => {
  const f = await fixture();
  try {
    const account = JSON.stringify((await f.db.execute('SELECT * FROM protected_account ORDER BY id')).rows);
    const previousModel = (await f.db.execute({ sql: "SELECT artifact_json FROM research_models WHERE version=?", args: [f.previous.modelVersion] })).rows[0].artifact_json;
    const receipt = await applyReplacement(f.db, f.plan, f.backup, researchHash(f.plan));
    assert.equal(receipt.verified, true);
    assert.deepEqual(receipt.deployment, f.target);
    assert.equal(receipt.adoptionEvent.candidate_id, null);
    assert.equal(receipt.adoptionEvent.action, 'ADOPT');
    const evidence = JSON.parse(receipt.adoptionEvent.evidence_json);
    assert.equal(evidence.manualReplacement, true);
    assert.equal(evidence.independentEvidence, false);
    assert.equal(evidence.retirePrevious, true);
    assert.equal(evidence.productionValidated, false);
    assert.equal(evidence.planHash, researchHash(f.plan));
    assert.equal(JSON.stringify((await f.db.execute('SELECT * FROM protected_account ORDER BY id')).rows), account);
    assert.equal((await f.db.execute({ sql: 'SELECT artifact_json FROM research_models WHERE version=?', args: [f.previous.modelVersion] })).rows[0].artifact_json, previousModel);
    await assert.rejects(() => applyReplacement(f.db, f.plan, f.backup, researchHash(f.plan)), /current_deployment_mismatch/);
  } finally { f.close(); }
});
test('stale plan, altered snapshot and altered schema are rejected before mutation', async () => {
  const f = await fixture();
  try {
    await expectUnchanged(f, () => applyReplacement(f.db, f.plan, f.backup, '0'.repeat(64)), /plan_or_backup/);
    await expectUnchanged(f, () => applyReplacement(f.db, f.plan, { ...f.backup, snapshot: {} }, researchHash(f.plan)), /plan_or_backup/);
    await f.db.execute('CREATE TABLE schema_drift(id TEXT)');
    await expectUnchanged(f, () => applyReplacement(f.db, f.plan, f.backup, researchHash(f.plan)), /planned_state_changed/);
  } finally { f.close(); }
});
test('incumbent hash mismatch and adoption state drift fail closed', async () => {
  const f = await fixture();
  try {
    await assert.rejects(() => planReplacement(f.db, { ...f.options, previousArtifactHash: 'a'.repeat(64) }, 'unused'), /previous_artifact/);
    await f.db.execute({ sql: "INSERT INTO challenger_adoption_events(id,action,deployment_json,previous_json,evidence_json,evidence_hash,created_at) VALUES ('drift','SUSPEND',?,?,'{}','hash','2026-01-01')",
      args: [JSON.stringify(f.previous), JSON.stringify(f.previous)] });
    await assert.rejects(() => applyReplacement(f.db, f.plan, f.backup, researchHash(f.plan)), /current_deployment_mismatch/);
    assert.equal(Number((await f.db.execute('SELECT COUNT(*) AS n FROM research_models')).rows[0].n), 1);
  } finally { f.close(); }
});
test('adoption failure rolls back new artifact, markets and market events together', async () => {
  const f = await fixture();
  try {
    await f.db.execute("CREATE TRIGGER deny_adoption BEFORE INSERT ON challenger_adoption_events BEGIN SELECT RAISE(ABORT,'forced rollback'); END");
    const { plan, backup } = await planReplacement(f.db, f.options, join(f.directory, 'rollback-backup.json'));
    await expectUnchanged(f, () => applyReplacement(f.db, plan, backup, researchHash(plan)), /forced rollback/);
    assert.equal(Number((await f.db.execute('SELECT COUNT(*) AS n FROM research_markets')).rows[0].n), 0);
    assert.equal(Number((await f.db.execute('SELECT COUNT(*) AS n FROM research_market_events')).rows[0].n), 0);
  } finally { f.close(); }
});
test('CLI writes exclusive backup and plan, rejects tampered backup and emits verified receipt', async () => {
  const f = await fixture();
  try {
    const plan = join(f.directory, 'plan.json'), backup = join(f.directory, 'backup.json'), receipt = join(f.directory, 'receipt.json');
    const args = ['--database', f.options.host, '--expected-host', HOST, '--previous-version', f.options.previousVersion,
      '--previous-artifact-hash', f.options.previousArtifactHash, '--backup', backup];
    await main([...args, '--plan', plan], {});
    await assert.rejects(() => main([...args, '--plan', plan], {}), /output_already_exists/);
    const hash = researchHash(JSON.parse(readFileSync(plan, 'utf8')));
    writeFileSync(receipt, 'existing receipt');
    await assert.rejects(() => main([...args, '--apply', plan, '--expected-plan-hash', hash, '--receipt', receipt], {}), /output_already_exists/);
    assert.equal(readFileSync(receipt, 'utf8'), 'existing receipt');
    rmSync(receipt);
    await assert.rejects(() => main([...args, '--apply', plan, '--expected-plan-hash', hash,
      '--receipt', join(f.directory, 'missing-parent', 'receipt.json')], {}), /ENOENT/);
    assert.equal(Number((await f.db.execute('SELECT COUNT(*) AS n FROM challenger_adoption_events')).rows[0].n), 0);
    assert.equal(Number((await f.db.execute('SELECT COUNT(*) AS n FROM research_models')).rows[0].n), 1);
    const content = readFileSync(backup);
    writeFileSync(backup, content.toString() + ' ');
    await assert.rejects(() => main([...args, '--apply', plan, '--expected-plan-hash', hash, '--receipt', receipt], {}), /backup_mismatch/);
    writeFileSync(backup, content);
    await main([...args, '--apply', plan, '--expected-plan-hash', hash, '--receipt', receipt], {});
    assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).verified, true);
    assert.equal(JSON.parse(readFileSync(receipt, 'utf8')).status, 'COMPLETE');
  } finally { f.close(); }
});
test('CLI preserves an explicitly unverified recovery journal after an apply failure', async () => {
  const f = await fixture();
  try {
    await f.db.execute("CREATE TRIGGER deny_cli_adoption BEFORE INSERT ON challenger_adoption_events BEGIN SELECT RAISE(ABORT,'driver details must remain private'); END");
    const plan = join(f.directory, 'plan.json'), backup = join(f.directory, 'backup.json'), receipt = join(f.directory, 'receipt.json');
    const args = ['--database', f.options.host, '--expected-host', HOST, '--previous-version', f.options.previousVersion,
      '--previous-artifact-hash', f.options.previousArtifactHash, '--backup', backup];
    await main([...args, '--plan', plan], {});
    const hash = researchHash(JSON.parse(readFileSync(plan, 'utf8')));
    await assert.rejects(() => main([...args, '--apply', plan, '--expected-plan-hash', hash, '--receipt', receipt], {}),
      error => error.message === 'replacement_failed_check_pending_receipt');
    const journal = JSON.parse(readFileSync(receipt, 'utf8'));
    assert.equal(journal.status, 'FAILED_UNKNOWN');
    assert.equal(journal.verified, false);
    assert.equal(journal.planHash, hash);
    assert.equal(journal.deployment.modelVersion, f.target.modelVersion);
    assert.match(journal.recovery, /Inspect the deployment registry/);
    assert.ok(!JSON.stringify(journal).includes('driver details'));
    assert.equal(Number((await f.db.execute('SELECT COUNT(*) AS n FROM research_models')).rows[0].n), 1);
    assert.equal(Number((await f.db.execute('SELECT COUNT(*) AS n FROM challenger_adoption_events')).rows[0].n), 0);
  } finally { f.close(); }
});
}
