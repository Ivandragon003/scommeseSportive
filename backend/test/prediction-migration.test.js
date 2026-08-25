const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');

process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_AUTH_TOKEN = 'test-token';
const { DatabaseService, isPredictionReportEligible } = require('../dist/db/DatabaseService.js');
const { mergeSnapshotRoster } = require('../dist/services/PredictionService.js');

const uniqueDbPath = (label) => `${label}-${process.pid}-${randomUUID()}.db`;
const removeDbFile = (path) => {
  try { unlinkSync(path); }
  catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EBUSY') throw error; }
};

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

test('DatabaseService upgrades an already-migrated legacy automated decision table before creating dependent indexes', async () => {
  const isolatedDbPath = uniqueDbPath('legacy-automated-decisions');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const legacy = createClient({ url: `file:${isolatedDbPath}` });
  await legacy.execute(`
    CREATE TABLE automated_bet_decisions (
      decision_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      match_id TEXT NOT NULL,
      market_name TEXT NOT NULL,
      selection TEXT NOT NULL,
      confidence TEXT,
      bookmaker_odds REAL,
      theoretical_stake_percent REAL,
      theoretical_stake_amount REAL,
      ranking_position INTEGER,
      created_at TEXT
    )
  `);
  await legacy.execute({
    sql: `INSERT INTO automated_bet_decisions (
      decision_id, user_id, match_id, market_name, selection, confidence,
      bookmaker_odds, theoretical_stake_percent, theoretical_stake_amount,
      ranking_position, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      'legacy-decision', 'user1', 'match1', '1X2', 'home', 'high',
      2.15, 2, 20, 1, '2026-08-24T00:00:00Z',
    ],
  });
  await legacy.execute('CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT)');
  await legacy.execute({
    sql: 'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
    args: ['007_automated_bet_decisions.sql', '2026-08-24T00:00:00Z'],
  });

  const db = new DatabaseService();
  await db.getAutomatedBetDecisions({ userId: 'user1' });
  const columns = await db.getTableColumns('automated_bet_decisions');
  for (const column of [
    'opportunity_key', 'operational_slot', 'decision_status', 'exclusion_reason', 'bet_id',
  ]) {
    assert.ok(columns.includes(column), `expected compatibility column ${column}`);
  }

  const rows = await legacy.execute(`
    SELECT decision_id, confidence, bookmaker_odds, decision_status, opportunity_key
    FROM automated_bet_decisions
  `);
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].decision_id, 'legacy-decision');
  assert.equal(rows.rows[0].confidence, 'high');
  assert.equal(Number(rows.rows[0].bookmaker_odds), 2.15);
  assert.equal(rows.rows[0].decision_status, 'saved_only');
  assert.match(String(rows.rows[0].opportunity_key), /^legacy:/);

  const indexes = await legacy.execute(`
    SELECT name FROM sqlite_master
    WHERE type = 'index'
      AND name IN ('idx_automated_bet_decisions_active_slot', 'idx_automated_bet_decisions_active_opportunity')
  `);
  assert.deepEqual(
    indexes.rows.map((row) => row.name).sort(),
    ['idx_automated_bet_decisions_active_opportunity', 'idx_automated_bet_decisions_active_slot'],
  );

  await db.close();
  await legacy.close();
  removeDbFile(isolatedDbPath);
});

test('prediction archive preserves the real bookmaker source', async () => {
  // Keep this service-backed migration test isolated from the direct migration
  // fixtures above: libSQL's plain file::memory: URL can be shared by clients.
  const isolatedDbPath = uniqueDbPath('prediction-source-test');
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
  await db.close();
  removeDbFile(isolatedDbPath);
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

test('lineup snapshot migration preserves predicted and official versions for the same player and match', async () => {
  const db = createClient({ url: 'file::memory:' });
  const migration = readFileSync(join(__dirname, '..', 'migrations', '009_lineup_snapshots.sql'), 'utf8');
  await db.executeMultiple(migration);
  await db.execute("INSERT INTO player_lineup_snapshot_batches (batch_id, captured_at) VALUES ('pred-batch', '2026-08-25T09:00:00.000Z')");
  await db.execute("INSERT INTO player_lineup_snapshot_batches (batch_id, captured_at) VALUES ('official-batch', '2026-08-25T10:00:00.000Z')");
  const insert = `INSERT INTO player_lineup_snapshots
    (snapshot_id, match_id, player_id, team_id, status, probability, source, batch_id, is_official)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.execute({ sql: insert, args: ['pred:m1:p1', 'm1', 'p1', 't1', 'predicted_starter', 0.82, 'last_five_model', 'pred-batch', 0] });
  await db.execute({ sql: insert, args: ['official:m1:p1', 'm1', 'p1', 't1', 'confirmed_bench', 0, 'api_football_confirmed', 'official-batch', 1] });
  const rows = await db.execute('SELECT status, is_official FROM player_lineup_snapshots ORDER BY is_official');
  assert.deepEqual(rows.rows, [
    { status: 'predicted_starter', is_official: 0 },
    { status: 'confirmed_bench', is_official: 1 },
  ]);
});

test('lower-division history migration stores only factual team evidence without xG fields', async () => {
  const db = createClient({ url: 'file::memory:' });
  await db.execute('CREATE TABLE teams (team_id TEXT PRIMARY KEY, name TEXT NOT NULL)');
  await db.executeMultiple(readFileSync(join(__dirname, '..', 'migrations', '004_competition_transitions.sql'), 'utf8'));
  await db.executeMultiple(readFileSync(join(__dirname, '..', 'migrations', '010_lower_division_team_history.sql'), 'utf8'));
  const tables = await db.execute(`SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lower_division_team_%' ORDER BY name`);
  assert.deepEqual(tables.rows.map((row) => row.name), ['lower_division_team_matches', 'lower_division_team_seasons']);
  const columns = await db.execute('PRAGMA table_info(lower_division_team_matches)');
  assert.equal(columns.rows.some((row) => String(row.name).includes('xg')), false);
});

test('lineup as-of esclude snapshot post-cutoff e fa prevalere la formazione ufficiale', async () => {
  const isolatedDbPath = uniqueDbPath('lineup-asof');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();
  const base = {
    matchId: 'lineup-asof-match', playerId: 'lineup-asof-player', teamId: 'lineup-asof-team',
    providerFixtureId: 'fixture-asof', kickoffAt: '2999-01-01T20:00:00Z',
  };
  await db.savePlayerLineupStatuses([
    { ...base, status: 'predicted_starter', probability: 0.9, source: 'last_five_lineup_model' },
    { ...base, playerId: 'lineup-asof-stale-player', status: 'predicted_starter', probability: 0.8, source: 'last_five_lineup_model' },
  ]);
  await db.savePlayerLineupStatuses([{
    ...base, status: 'unavailable', probability: 0, source: 'api_football_injury',
  }]);
  await db.savePlayerLineupStatuses([{
    ...base, status: 'confirmed_starter', probability: 1, source: 'api_football_confirmed',
    formation: '4-3-3', rawJson: JSON.stringify({ lineup: { formation: '4-3-3' } }),
  }], { replaceTeamOperational: true });
  await db.savePlayerLineupStatuses([{
    ...base, status: 'predicted_bench', probability: 0.2, source: 'last_five_lineup_model',
  }]);
  // Forza tutti i batch nello stesso secondo: la scelta del piu recente deve
  // dipendere dal batch_order transazionale, non dal timestamp o dall'UUID.
  await db.execute(`UPDATE player_lineup_snapshots
    SET captured_at = '2026-08-25T10:00:00.000Z'
    WHERE match_id = 'lineup-asof-match'`);

  const beforeCapture = await db.getPlayerLineupStatuses('lineup-asof-match', '2000-01-01T00:00:00Z');
  const afterCapture = await db.getPlayerLineupStatuses('lineup-asof-match', '2999-01-01T20:00:00Z');
  const operational = await db.getPlayerLineupStatuses('lineup-asof-match');
  assert.equal(beforeCapture.length, 0);
  assert.equal(afterCapture.find((row) => row.player_id === base.playerId).status, 'confirmed_starter');
  assert.match(afterCapture.find((row) => row.player_id === base.playerId).raw_json, /4-3-3/);
  assert.equal(afterCapture.some((row) => row.player_id === 'lineup-asof-stale-player'), false, 'un batch rosa superato non entra nel replay');
  const archivedStale = await db.execute(
    "SELECT COUNT(*) AS total FROM player_lineup_snapshots WHERE player_id = 'lineup-asof-stale-player'",
  );
  assert.equal(Number(archivedStale.rows[0].total), 1, 'il batch superato resta archiviato per audit');
  assert.deepEqual(operational.map((row) => row.player_id), [base.playerId], 'lo stato operativo del team viene sostituito');
  await db.close();
  removeDbFile(isolatedDbPath);
});

test('replay recupera globalmente un giocatore dopo il cambio reale di team_id', async () => {
  const isolatedDbPath = uniqueDbPath('lineup-transfer-replay');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();
  await db.upsertTeam({ teamId: 'historical-team', name: 'Historical Team', competition: 'Serie A' });
  await db.upsertTeam({ teamId: 'current-team', name: 'Current Team', competition: 'Serie A' });
  const player = {
    playerId: 'transferred-player', name: 'Transferred Player', teamId: 'historical-team',
    positionCode: 'FW', avgMinutes: 82, gamesPlayed: 12,
  };
  await db.upsertPlayer(player);
  await db.savePlayerLineupStatuses([{
    matchId: 'historical-fixture', playerId: player.playerId, teamId: 'historical-team',
    status: 'predicted_starter', probability: 0.9, source: 'last_five_lineup_model',
    kickoffAt: '2999-01-01T20:00:00Z',
  }]);
  await db.upsertPlayer({ ...player, teamId: 'current-team' });

  const activeHistorical = await db.getPlayersByTeam('historical-team');
  const snapshots = await db.getPlayerLineupStatuses('historical-fixture', '2999-01-01T20:00:00Z');
  const globalPlayers = await db.getPlayersByIds([player.playerId]);
  assert.equal(activeHistorical.length, 0);
  assert.equal(globalPlayers[0].team_id, 'current-team');

  const replayRoster = mergeSnapshotRoster(activeHistorical, globalPlayers, snapshots, 'historical-team');
  assert.equal(replayRoster.length, 1);
  assert.equal(replayRoster[0].player_id, player.playerId);
  assert.equal(replayRoster[0].team_id, 'historical-team');
  await db.close();
  removeDbFile(isolatedDbPath);
});

test('un refresh infortuni riuscito e vuoto rende il recuperato nuovamente eleggibile senza perdere lo storico', async () => {
  const isolatedDbPath = uniqueDbPath('injury-recovery');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();
  const matchId = 'injury-recovery-match';
  const teamId = 'injury-recovery-team';
  const base = {
    matchId, playerId: 'recovered-player', teamId,
    status: 'unavailable', probability: 0, source: 'api_football_injury',
    providerFixtureId: 'injury-fixture', kickoffAt: '2999-01-01T20:00:00Z',
  };
  await db.replacePlayerInjuryStatuses({
    matchId, teamIds: [teamId], rows: [base],
    providerFixtureId: base.providerFixtureId, kickoffAt: base.kickoffAt,
  });
  assert.equal((await db.getPlayerLineupStatuses(matchId))[0].status, 'unavailable');

  await db.replacePlayerInjuryStatuses({
    matchId, teamIds: [teamId], rows: [],
    providerFixtureId: base.providerFixtureId, kickoffAt: base.kickoffAt,
  });

  assert.equal((await db.getPlayerLineupStatuses(matchId)).length, 0);
  assert.equal((await db.getPlayerLineupStatuses(matchId, base.kickoffAt)).length, 0);
  const archived = await db.execute({
    sql: `SELECT COUNT(*) AS total FROM player_lineup_snapshots
          WHERE match_id = ? AND player_id = ? AND status = 'unavailable'`,
    args: [matchId, base.playerId],
  });
  assert.equal(Number(archived.rows[0].total), 1);
  await db.close();
  removeDbFile(isolatedDbPath);
});

test('la riconciliazione rosa e atomica se una creazione provider fallisce a meta batch', async () => {
  const isolatedDbPath = uniqueDbPath('atomic-squad');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();
  await db.upsertTeam({ teamId: 'atomic-old-team', name: 'Atomic Old', competition: 'Serie A' });
  await db.upsertTeam({ teamId: 'atomic-new-team', name: 'Atomic New', competition: 'Serie A' });
  await db.upsertPlayer({
    playerId: 'atomic-existing-player', name: 'Existing', teamId: 'atomic-old-team',
    positionCode: 'MF', gamesPlayed: 10,
  });

  await assert.rejects(db.applyProviderSquadReconciliation('atomic-new-team', [
    { playerId: 'atomic-existing-player', name: 'Existing', positionCode: 'FW', isNew: false },
    { playerId: 'atomic-invalid-new', name: null, positionCode: 'DF', isNew: true, providerId: 77 },
  ]));

  const existing = await db.getPlayersByIds(['atomic-existing-player']);
  const invalid = await db.getPlayersByIds(['atomic-invalid-new']);
  assert.equal(existing[0].team_id, 'atomic-old-team');
  assert.equal(existing[0].position_code, 'MF');
  assert.equal(invalid.length, 0);
  await db.close();
  removeDbFile(isolatedDbPath);
});

test('lo storico di serie inferiore usa batch idempotenti e un marker finale verificabile', async () => {
  const isolatedDbPath = uniqueDbPath('lower-division-batch');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();
  await db.upsertTeam({ teamId: 'lower-team', name: 'Lower Team', competition: 'Serie A' });
  const reference = {
    sourceCompetitionId: 'serie_b', sourceSeason: '2024/2025', teamsCount: 2,
    meanPpg: 1.5, stdevPpg: 0.2, meanGoalDifferencePerMatch: 0,
    stdevGoalDifferencePerMatch: 0.1, matchesPerTeam: 2, matchesObserved: 2,
    matchesExpected: 2, coveragePercent: 100, identityCoveragePercent: 50,
    coverageStatus: 'complete', sourceProvider: 'football-data.co.uk',
    sourceReference: 'https://example.test/2425/I2.csv',
  };
  const season = {
    teamId: 'lower-team', sourceCompetitionId: 'serie_b', sourceSeason: '2024/2025',
    finalRank: 1, matchesPlayed: 2, points: 6, ppg: 3, goalDifference: 2,
    goalDifferencePerMatch: 1, sourceProvider: reference.sourceProvider,
    sourceReference: reference.sourceReference, coverageStatus: 'complete',
  };
  const match = {
    historyId: 'lower-history-1', teamId: 'lower-team', sourceCompetitionId: 'serie_b',
    sourceSeason: '2024/2025', playedAt: '2024-08-01', venue: 'home', opponentName: 'Other',
    goalsFor: 2, goalsAgainst: 0, shotsFor: 10, shotsAgainst: 4,
    shotsOnTargetFor: 5, shotsOnTargetAgainst: 1, foulsFor: 8, foulsAgainst: 10,
    cornersFor: 6, cornersAgainst: 2, yellowCardsFor: 1, yellowCardsAgainst: 2,
    redCardsFor: 0, redCardsAgainst: 0, referee: 'Rossi',
    sourceProvider: reference.sourceProvider, sourceReference: reference.sourceReference,
    rawJson: '{}',
  };
  await db.upsertLowerDivisionHistoryBatch({ reference, teamSeasons: [season], teamMatches: [match], transitions: [] });
  await db.upsertLowerDivisionHistoryBatch({ reference, teamSeasons: [season], teamMatches: [match], transitions: [] });

  assert.equal(await db.hasCompleteTransitionSeasonReference('serie_b', '2024/2025'), true);
  assert.equal(await db.hasCompleteLowerDivisionTeamHistory('serie_b', '2024/2025', ['lower-team'], 1), true);
  const counts = await db.execute(`SELECT
    (SELECT COUNT(*) FROM lower_division_team_seasons) AS seasons,
    (SELECT COUNT(*) FROM lower_division_team_matches) AS matches`);
  assert.deepEqual(counts.rows, [{ seasons: 1, matches: 1 }]);
  await db.close();
  removeDbFile(isolatedDbPath);
});

test('lo storico di serie inferiore resta idempotente se cambia la normalizzazione dell avversario', async () => {
  const isolatedDbPath = uniqueDbPath('lower-division-natural-key');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();
  await db.upsertTeam({ teamId: 'lower-team', name: 'Lower Team', competition: 'La Liga' });
  const reference = {
    sourceCompetitionId: 'segunda_division', sourceSeason: '2024/2025', teamsCount: 2,
    meanPpg: 1.5, stdevPpg: 0.2, meanGoalDifferencePerMatch: 0,
    stdevGoalDifferencePerMatch: 0.1, matchesPerTeam: 2, matchesObserved: 2,
    matchesExpected: 2, coveragePercent: 100, identityCoveragePercent: 50,
    coverageStatus: 'complete', sourceProvider: 'football-data.co.uk',
    sourceReference: 'https://example.test/2425/SP2.csv',
  };
  const baseMatch = {
    teamId: 'lower-team', sourceCompetitionId: 'segunda_division', sourceSeason: '2024/2025',
    playedAt: '2024-08-01', venue: 'home', opponentName: 'Santander',
    goalsFor: 2, goalsAgainst: 0, shotsFor: 10, shotsAgainst: 4,
    shotsOnTargetFor: 5, shotsOnTargetAgainst: 1, foulsFor: 8, foulsAgainst: 10,
    cornersFor: 6, cornersAgainst: 2, yellowCardsFor: 1, yellowCardsAgainst: 2,
    redCardsFor: 0, redCardsAgainst: 0, referee: 'Rossi',
    sourceProvider: reference.sourceProvider, sourceReference: reference.sourceReference,
    rawJson: '{}',
  };

  await db.upsertLowerDivisionHistoryBatch({
    reference, teamSeasons: [], transitions: [],
    teamMatches: [{ ...baseMatch, historyId: 'fd:old-santander-alias' }],
  });
  await db.upsertLowerDivisionHistoryBatch({
    reference, teamSeasons: [], transitions: [],
    teamMatches: [{ ...baseMatch, historyId: 'fd:new-racing-santander-alias', goalsFor: 3 }],
  });

  const rows = await db.execute(`SELECT history_id, goals_for
    FROM lower_division_team_matches
    WHERE team_id = 'lower-team' AND source_season = '2024/2025'`);
  assert.deepEqual(rows.rows, [{ history_id: 'fd:old-santander-alias', goals_for: 3 }]);
  await db.close();
  removeDbFile(isolatedDbPath);
});
