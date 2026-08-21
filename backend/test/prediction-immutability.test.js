const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { PREDICTION_IMMUTABILITY_STATEMENTS } = require('../dist/db/DatabaseService.js');

const predictionColumns = `
  prediction_id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  raw_probability REAL NOT NULL,
  calibrated_probability REAL,
  model_version TEXT,
  source TEXT,
  odds_at_prediction REAL,
  implied_probability REAL,
  novig_probability REAL,
  has_complementary_odds INTEGER NOT NULL DEFAULT 0,
  ev REAL,
  ev_reason TEXT,
  kelly REAL,
  confidence_computed TEXT,
  snapshot_type TEXT NOT NULL DEFAULT 'update',
  sample_size_at_time INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_promoted_to_bet INTEGER NOT NULL DEFAULT 0,
  result TEXT NOT NULL DEFAULT 'pending',
  settled_at TEXT,
  supersedes_prediction_id TEXT,
  has_full_market_logging INTEGER NOT NULL DEFAULT 0,
  has_immutability_enforced INTEGER NOT NULL DEFAULT 0,
  has_generic_void_handling INTEGER NOT NULL DEFAULT 0,
  has_configurable_thresholds INTEGER NOT NULL DEFAULT 0
`;

async function createPredictionDatabase() {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`CREATE TABLE predictions (${predictionColumns})`);
  for (const statement of PREDICTION_IMMUTABILITY_STATEMENTS) await db.execute(statement);
  await db.execute({
    sql: `INSERT INTO predictions (prediction_id, match_id, market, selection, raw_probability)
          VALUES (?, ?, ?, ?, ?)`,
    args: ['prediction-1', 'match-1', 'dnb', 'away', 0.55],
  });
  return db;
}

test('prediction records reject field mutation and deletion at database level', async () => {
  const db = await createPredictionDatabase();

  await assert.rejects(
    db.execute(`UPDATE predictions SET market = '1x2' WHERE prediction_id = 'prediction-1'`),
    /immutable/i,
  );
  await assert.rejects(
    db.execute(`DELETE FROM predictions WHERE prediction_id = 'prediction-1'`),
    /append-only|delete/i,
  );
});

test('prediction records allow exactly one pending to settled result transition', async () => {
  const db = await createPredictionDatabase();

  await db.execute(`
    UPDATE predictions
    SET result = 'void', settled_at = '2026-08-21T12:00:00Z'
    WHERE prediction_id = 'prediction-1'
  `);

  await assert.rejects(
    db.execute(`UPDATE predictions SET result = 'win' WHERE prediction_id = 'prediction-1'`),
    /immutable/i,
  );
  await assert.rejects(
    db.execute(`UPDATE predictions SET settled_at = '2026-08-21T13:00:00Z' WHERE prediction_id = 'prediction-1'`),
    /immutable/i,
  );
});
