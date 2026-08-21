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
