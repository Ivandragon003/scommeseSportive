const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');

process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_AUTH_TOKEN = 'test-token';
const { DatabaseService, isPredictionReportEligible } = require('../dist/db/DatabaseService.js');

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

test('bet prediction link migration is additive and keeps legacy bets unlinked', async () => {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`
    CREATE TABLE bets (
      bet_id TEXT PRIMARY KEY, user_id TEXT, match_id TEXT, market_name TEXT,
      selection TEXT, odds REAL, stake REAL, our_probability REAL,
      expected_value REAL, placed_at TEXT
    )
  `);
  await db.execute({
    sql: 'INSERT INTO bets (bet_id, match_id, market_name, selection, odds, stake, our_probability, expected_value, placed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: ['legacy-bet', 'match1', 'DNB', 'away', 2, 1, 0.55, 0.1, '2026-08-21T00:00:00Z'],
  });
  const migration = readFileSync(join(__dirname, '..', 'migrations', '006_add_bet_prediction_link.sql'), 'utf8');
  await db.executeMultiple(migration);
  const rows = await db.execute('SELECT bet_id, prediction_id FROM bets');
  assert.deepEqual(rows.rows, [{ bet_id: 'legacy-bet', prediction_id: null }]);
});

test('prediction archive preserves the real bookmaker source', async () => {
  // Keep this service-backed migration test isolated from the direct migration
  // fixtures above: libSQL's plain file::memory: URL can be shared by clients.
  const isolatedDbPath = `prediction-source-test-${process.pid}.db`;
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();
  await db.appendPredictions([{
    predictionId: 'source-prediction',
    matchId: 'source-match',
    market: '1x2',
    selection: 'homeWin',
    rawProbability: 0.55,
    source: 'odds_api',
    oddsAtPrediction: 2.1,
    ev: 0.155,
    evReason: 'computed',
    snapshotType: 'update',
    loggingFlags: {
      hasFullMarketLogging: true,
      hasImmutabilityEnforced: true,
      hasGenericVoidHandling: true,
      hasConfigurableThresholds: true,
    },
  }]);

  const rows = await db.getPendingPredictions('source-match');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'odds_api');
  try {
    unlinkSync(isolatedDbPath);
  } catch (error) {
    // Windows may keep the libSQL handle open until the test process exits.
    if (error.code !== 'EBUSY') throw error;
  }
});

test('prediction report eligibility is fail-closed on every guarantee flag', () => {
  const eligible = {
    has_full_market_logging: 1,
    has_immutability_enforced: 1,
    has_generic_void_handling: 1,
    has_configurable_thresholds: 1,
  };
  assert.equal(isPredictionReportEligible(eligible), true);
  assert.equal(isPredictionReportEligible({ ...eligible, has_immutability_enforced: null }), false);
  assert.equal(isPredictionReportEligible({ ...eligible, has_generic_void_handling: 0 }), false);
  assert.equal(isPredictionReportEligible(null), false);
});

test('budget session migration preserves legacy bets for the active session', async () => {
  const db = createClient({ url: 'file::memory:' });
  await db.execute('CREATE TABLE users (user_id TEXT PRIMARY KEY)');
  await db.execute('INSERT INTO users (user_id) VALUES (?)', ['user1']);
  await db.execute(`
    CREATE TABLE bets (
      bet_id TEXT PRIMARY KEY, user_id TEXT, match_id TEXT, market_name TEXT,
      selection TEXT, odds REAL, stake REAL, our_probability REAL,
      expected_value REAL, status TEXT, placed_at TEXT,
      data_quality TEXT, source TEXT
    )
  `);
  await db.execute(`
    CREATE TABLE budgets (
      user_id TEXT PRIMARY KEY, total_budget REAL, available_budget REAL,
      total_bets INTEGER, total_staked REAL, total_won REAL, total_lost REAL,
      roi REAL, win_rate REAL, created_at TEXT, updated_at TEXT
    )
  `);
  await db.execute('INSERT INTO budgets (user_id, total_budget, available_budget, created_at) VALUES (?, ?, ?, ?)', ['user1', 1000, 900, '2026-08-21T00:00:00Z']);
  await db.execute('INSERT INTO bets (bet_id, user_id, match_id, market_name, selection, odds, stake, our_probability, expected_value, status, placed_at, data_quality, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ['legacy-bet', 'user1', 'match1', 'DNB', 'away', 2, 10, 0.55, 0.1, 'PENDING', '2026-08-21T00:00:00Z', 'pre_fix', 'unknown']);

  const migration = readFileSync(join(__dirname, '..', 'migrations', '003_budget_sessions.sql'), 'utf8');
  await db.executeMultiple(migration);

  const rows = await db.execute(`
    SELECT b.active_session_id, s.status, bets.budget_session_id
    FROM budgets b
    JOIN budget_sessions s ON s.session_id = b.active_session_id
    JOIN bets ON bets.user_id = b.user_id
  `);
  assert.deepEqual(rows.rows, [{ active_session_id: 'legacy-user1', status: 'active', budget_session_id: 'legacy-user1' }]);
});

test('competition transition migration creates audit-only normalized tables', async () => {
  const db = createClient({ url: 'file::memory:' });
  await db.execute('CREATE TABLE teams (team_id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  const migration = readFileSync(join(__dirname, '..', 'migrations', '004_competition_transitions.sql'), 'utf8');
  await db.executeMultiple(migration);
  await db.execute({
    sql: 'INSERT INTO secondary_competitions (competition_id, name, country, tier, cluster_key) VALUES (?, ?, ?, ?, ?)',
    args: ['serie_b', 'Serie B', 'Italy', 2, 'big5_second_to_big5_first'],
  });
  await db.execute({
    sql: `INSERT INTO source_season_reference
      (source_competition_id, source_season, teams_count, mean_ppg, stdev_ppg, coverage_status)
      VALUES (?, ?, ?, ?, ?, ?)`,
    args: ['serie_b', '2024/2025', 20, 1.42, 0.22, 'complete'],
  });
  const tables = await db.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('secondary_competitions', 'source_season_reference', 'team_competition_transitions') ORDER BY name`);
  assert.deepEqual(tables.rows.map((row) => row.name), ['secondary_competitions', 'source_season_reference', 'team_competition_transitions']);
});
