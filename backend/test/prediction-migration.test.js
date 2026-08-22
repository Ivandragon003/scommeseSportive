const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('prediction migration is additive and preserves an existing archive', async () => {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`
    CREATE TABLE predictions (
      prediction_id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      market TEXT NOT NULL,
      selection TEXT NOT NULL,
      raw_probability REAL NOT NULL,
      result TEXT NOT NULL DEFAULT 'pending'
    )
  `);
  await db.execute({
    sql: `INSERT INTO predictions (prediction_id, match_id, market, selection, raw_probability)
          VALUES (?, ?, ?, ?, ?)`,
    args: ['old-prediction', 'old-match', 'dnb', 'away', 0.52],
  });

  const migration = readFileSync(
    join(__dirname, '..', 'migrations', '001_create_predictions_archive.sql'),
    'utf8',
  );
  await db.execute(migration);

  const rows = await db.execute(`SELECT prediction_id, raw_probability FROM predictions`);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].prediction_id, 'old-prediction');
  assert.equal(Number(rows.rows[0].raw_probability), 0.52);
});

test('bet provenance migration preserves legacy rows and marks them pre-fix', async () => {
  const db = createClient({ url: 'file::memory:' });
  await db.execute('CREATE TABLE users (user_id TEXT PRIMARY KEY)');
  await db.execute(`
    CREATE TABLE bets (
      bet_id TEXT PRIMARY KEY, user_id TEXT, match_id TEXT, market_name TEXT,
      selection TEXT, odds REAL, stake REAL, our_probability REAL,
      expected_value REAL, placed_at TEXT
    )
  `);
  await db.execute({
    sql: 'INSERT INTO bets (bet_id, user_id, match_id, market_name, selection, odds, stake, our_probability, expected_value, placed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: ['legacy-bet', 'user1', 'match1', 'DNB', 'away', 5.4, 1, 0.23, 0.25, '2026-08-21T21:22:43Z'],
  });

  const migration = readFileSync(join(__dirname, '..', 'migrations', '002_add_bet_provenance.sql'), 'utf8');
  await db.executeMultiple(migration);

  const rows = await db.execute('SELECT bet_id, data_quality, source FROM bets');
  assert.deepEqual(rows.rows, [{ bet_id: 'legacy-bet', data_quality: 'pre_fix', source: 'unknown' }]);
});
