const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createClient } = require('@libsql/client');
const { pruneOldSeasons } = require('../dist/services/FootballDataService');

const migration = readFileSync(join(__dirname, '../migrations/022_lineup_batch_read_index.sql'), 'utf8');
const tables = ['player_lineup_snapshot_batches', 'player_lineup_snapshots', 'player_injury_refresh_batches'];
async function setup(t, indexed) {
  const client = createClient({ url: 'file::memory:' });
  t.after(() => client.close());
  await client.execute('PRAGMA foreign_keys=ON');
  for (const filename of ['009_lineup_snapshots.sql', '011_injury_refresh_batches.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', filename), 'utf8'));
  }
  for (const id of ['orphan', 'only-snapshot', 'only-injury', 'both']) {
    await client.execute({ sql: 'INSERT INTO player_lineup_snapshot_batches(batch_id,captured_at) VALUES (?,?)',
      args: [id, '2026-10-29T18:00:00Z'] });
  }
  for (const batch of ['only-snapshot', 'both']) {
    await client.execute({ sql: `INSERT INTO player_lineup_snapshots
      (snapshot_id,match_id,player_id,team_id,status,source,batch_id)
      VALUES (?,'match','player','team','predicted_starter','fixture',?)`, args: [batch, batch] });
  }
  for (const batch of ['only-injury', 'both']) {
    await client.execute({ sql: `INSERT INTO player_injury_refresh_batches(batch_id,match_id,team_id,captured_at)
      VALUES (?,'match','team','2026-10-29T18:00:00Z')`, args: [batch] });
  }
  if (indexed) await client.executeMultiple(migration);
  return client;
}
async function contents(client) {
  return Promise.all(tables.map(async (table) => (await client.execute(`SELECT * FROM ${table} ORDER BY rowid`)).rows));
}
async function cleanup(client) {
  let sql, plan;
  // No seasonal deletion is requested; execute the production housekeeping SQL unchanged.
  const result = await pruneOldSeasons({ execute: async (statement) => {
    if (!/^DELETE FROM player_lineup_snapshot_batches/.test(statement.sql)) return { rows: [] };
    sql = statement.sql;
    plan = (await client.execute(`EXPLAIN QUERY PLAN ${sql}`)).rows.map((row) => String(row.detail));
    return client.execute(statement);
  } }, 5, new Date('2026-10-29T18:00:00Z'));
  assert.ok(sql, 'the real orphan cleanup must execute even without expired seasons');
  return { sql, plan, result };
}

test('lineup batch migration is additive, idempotent and preserves every stored value', async (t) => {
  const client = await setup(t, false);
  const before = await contents(client);
  await client.executeMultiple(migration);
  await client.executeMultiple(migration);
  assert.deepEqual(await contents(client), before);
  const indexes = (await client.execute('PRAGMA index_list(player_lineup_snapshots)')).rows;
  assert.equal(indexes.filter((row) => row.name === 'idx_lineup_snapshots_batch').length, 1);
  assert.deepEqual((await client.execute('PRAGMA index_info(idx_lineup_snapshots_batch)')).rows.map((row) => row.name), ['batch_id']);
  assert.equal((await client.execute('PRAGMA foreign_key_check')).rows.length, 0);
});

test('unchanged cleanup uses a covering batch lookup and deletes only unreferenced containers', async (t) => {
  const unindexed = await setup(t, false);
  const indexed = await setup(t, true);
  const before = await cleanup(unindexed), after = await cleanup(indexed);
  assert.equal(after.sql, before.sql);
  assert.ok(before.plan.some((line) => /SCAN snapshot/.test(line)), before.plan.join('\n'));
  assert.ok(after.plan.some((line) => /SEARCH snapshot USING COVERING INDEX idx_lineup_snapshots_batch \(batch_id=\?\)/.test(line)), after.plan.join('\n'));
  assert.ok(!after.plan.some((line) => /SCAN snapshot/.test(line)));
  assert.ok(after.plan.some((line) => /SEARCH injury USING COVERING INDEX sqlite_autoindex_player_injury_refresh_batches_1/.test(line)));
  assert.equal(before.result.linkedRowsDeleted, 1);
  assert.equal(after.result.linkedRowsDeleted, 1);
  assert.deepEqual(await contents(indexed), await contents(unindexed));
  const remaining = (await indexed.execute('SELECT batch_id FROM player_lineup_snapshot_batches ORDER BY batch_id')).rows;
  assert.deepEqual(remaining.map((row) => row.batch_id), ['both', 'only-injury', 'only-snapshot']);
  assert.equal((await cleanup(indexed)).result.linkedRowsDeleted, 0);
  assert.equal((await indexed.execute('PRAGMA foreign_key_check')).rows.length, 0);
});
