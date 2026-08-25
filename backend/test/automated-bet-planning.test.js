const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync, unlinkSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const express = require('express');
const { createClient } = require('@libsql/client');

process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_AUTH_TOKEN = 'test-token';

const {
  automatedBetOpportunityKey,
  planAutomatedBetOpportunities,
} = require('../dist/services/AutomatedBetPlanningService.js');
const { DatabaseService } = require('../dist/db/DatabaseService.js');
const { createApiRouter, resolveInternalApiBaseUrl } = require('../dist/api/routes.js');

test('internal automation API base is loopback-only', () => {
  assert.equal(resolveInternalApiBaseUrl('http://127.0.0.1:3001/api'), 'http://127.0.0.1:3001/api');
  assert.throws(() => resolveInternalApiBaseUrl('https://attacker.example/api'), /loopback/i);
  assert.throws(() => resolveInternalApiBaseUrl('http://10.0.0.5:3001/api'), /loopback/i);
});

const isolatedDatabasePath = (prefix) => join(tmpdir(), `${prefix}-${process.pid}-${randomUUID()}.db`);

const opportunity = ({
  matchId,
  selection,
  confidence,
  rankingScore,
  bestBetStatus = 'PLAYABLE',
  marketTier = 'CORE',
}) => ({
  matchId,
  marketName: 'Test market',
  selection,
  confidence,
  rankingScore,
  bestBetStatus,
  marketTier,
  bookmakerOdds: 2,
  suggestedStakePercent: 1.5,
  ourProbability: 55,
  expectedValue: 10,
});

test('plans at most three operational HIGH/MEDIUM bets for each match, not globally', () => {
  const decisions = planAutomatedBetOpportunities([
    opportunity({ matchId: 'match-1', selection: 'm1-fourth', confidence: 'MEDIUM', rankingScore: 10 }),
    opportunity({ matchId: 'match-1', selection: 'm1-first', confidence: 'HIGH', rankingScore: 40 }),
    opportunity({ matchId: 'match-1', selection: 'm1-third', confidence: 'MEDIUM', rankingScore: 20 }),
    opportunity({ matchId: 'match-1', selection: 'm1-second', confidence: 'HIGH', rankingScore: 30 }),
    opportunity({ matchId: 'match-2', selection: 'm2-fourth', confidence: 'MEDIUM', rankingScore: 11 }),
    opportunity({ matchId: 'match-2', selection: 'm2-first', confidence: 'HIGH', rankingScore: 41 }),
    opportunity({ matchId: 'match-2', selection: 'm2-third', confidence: 'MEDIUM', rankingScore: 21 }),
    opportunity({ matchId: 'match-2', selection: 'm2-second', confidence: 'HIGH', rankingScore: 31 }),
  ], 3);

  const operational = decisions.filter((decision) => decision.action === 'operational');
  assert.deepEqual(
    operational.map((decision) => decision.opportunity.selection),
    ['m1-first', 'm1-second', 'm1-third', 'm2-first', 'm2-second', 'm2-third'],
  );
  assert.deepEqual(
    decisions
      .filter((decision) => decision.reason === 'per_match_limit_reached')
      .map((decision) => decision.opportunity.selection),
    ['m1-fourth', 'm2-fourth'],
  );
});

test('saves LOW, SPECULATIVE and unclassified opportunities without making them operational', () => {
  const decisions = planAutomatedBetOpportunities([
    opportunity({ matchId: 'match-1', selection: 'high', confidence: 'HIGH', rankingScore: 50 }),
    opportunity({ matchId: 'match-1', selection: 'medium', confidence: 'MEDIUM', rankingScore: 40 }),
    opportunity({ matchId: 'match-1', selection: 'low', confidence: 'LOW', rankingScore: 30 }),
    opportunity({ matchId: 'match-1', selection: 'speculative', confidence: 'MEDIUM', rankingScore: 20, bestBetStatus: 'SPECULATIVE' }),
    opportunity({ matchId: 'match-1', selection: 'speculative-tier', confidence: 'MEDIUM', rankingScore: 15, marketTier: 'SPECULATIVE' }),
    opportunity({ matchId: 'match-1', selection: 'unknown', confidence: undefined, rankingScore: 10 }),
  ], 3);

  assert.deepEqual(
    decisions.filter((decision) => decision.action === 'operational').map((decision) => decision.opportunity.selection),
    ['high', 'medium'],
  );
  assert.deepEqual(
    decisions.filter((decision) => decision.action === 'saved_only').map((decision) => [decision.opportunity.selection, decision.reason]),
    [
      ['low', 'low_confidence_saved_only'],
      ['speculative', 'speculative_saved_only'],
      ['speculative-tier', 'speculative_saved_only'],
      ['unknown', 'unsupported_confidence_saved_only'],
    ],
  );
});

test('LOW/SPECULATIVE do not consume the three operational HIGH/MEDIUM slots', () => {
  const decisions = planAutomatedBetOpportunities([
    opportunity({ matchId: 'match-1', selection: 'low-first', confidence: 'LOW', rankingScore: 100 }),
    opportunity({ matchId: 'match-1', selection: 'high-first', confidence: 'HIGH', rankingScore: 90 }),
    opportunity({ matchId: 'match-1', selection: 'medium-second', confidence: 'MEDIUM', rankingScore: 80 }),
    opportunity({ matchId: 'match-1', selection: 'high-third', confidence: 'HIGH', rankingScore: 70 }),
    opportunity({ matchId: 'match-1', selection: 'medium-fourth', confidence: 'MEDIUM', rankingScore: 60 }),
  ], 3);

  assert.deepEqual(
    decisions.filter((decision) => decision.action === 'operational').map((decision) => [decision.opportunity.selection, decision.operationalSlot]),
    [['high-first', 1], ['medium-second', 2], ['high-third', 3]],
  );
  assert.equal(
    decisions.find((decision) => decision.opportunity.selection === 'medium-fourth').reason,
    'per_match_limit_reached',
  );
});

test('persists an auditable saved-only decision with theoretical stake and ranking', async () => {
  const isolatedDbPath = isolatedDatabasePath('automated-bet-decisions');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();

  await db.appendAutomatedBetDecision({
    decisionId: 'decision-1',
    userId: 'user1',
    matchId: 'match-1',
    marketName: '1X2',
    selection: 'homeWin',
    confidence: 'MEDIUM',
    bookmakerOdds: 2.1,
    theoreticalStakePercent: 1.5,
    theoreticalStakeAmount: 15,
    rankingPosition: 4,
    decisionStatus: 'saved_only',
    exclusionReason: 'per_match_limit_reached',
  });

  const rows = await db.getAutomatedBetDecisions({ matchId: 'match-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].confidence, 'MEDIUM');
  assert.equal(Number(rows[0].theoretical_stake_amount), 15);
  assert.equal(Number(rows[0].ranking_position), 4);
  assert.equal(rows[0].decision_status, 'saved_only');
  assert.equal(rows[0].exclusion_reason, 'per_match_limit_reached');

  try {
    unlinkSync(isolatedDbPath);
  } catch (error) {
    if (error.code !== 'EBUSY') throw error;
  }
});

test('nightly route applies the limit independently to every match and archives every candidate', async () => {
  const matches = [
    {
      match_id: 'match-1', home_team_id: 'home-1', away_team_id: 'away-1',
      home_team_name: 'Home 1', away_team_name: 'Away 1', competition: 'Serie A',
      date: '2026-08-25T18:00:00.000Z',
    },
    {
      match_id: 'match-2', home_team_id: 'home-2', away_team_id: 'away-2',
      home_team_name: 'Home 2', away_team_name: 'Away 2', competition: 'Serie A',
      date: '2026-08-25T20:00:00.000Z',
    },
  ];
  const archived = [];
  const db = {
    async getUpcomingMatches() { return matches; },
    async getLatestOddsSnapshotForMatch() {
      return {
        captured_at: new Date().toISOString(),
        source: 'odds_api',
        selectedBookmakerName: 'Pinnacle',
        usedSyntheticOdds: false,
        liveSelectedOdds: { homeWin: 2 },
      };
    },
    async appendAutomatedBetDecision(row) { archived.push(row); },
    async reserveAutomatedBetDecision(row) {
      archived.push({ ...row, decisionStatus: 'reserved' });
      return { reserved: true, decisionId: row.decisionId };
    },
    async finalizeAutomatedBetDecision(decisionId, decisionStatus, options = {}) {
      const row = archived.find((candidate) => candidate.decisionId === decisionId);
      row.decisionStatus = decisionStatus;
      row.exclusionReason = options.exclusionReason ?? null;
      row.betId = options.betId ?? null;
    },
  };
  const svc = {
    async predict(request) {
      const opportunities = [40, 30, 20, 10].map((rankingScore, index) => ({
        matchId: request.matchId,
        marketName: `Market ${index + 1}`,
        selection: `${request.matchId}-selection-${index + 1}`,
        confidence: index % 2 === 0 ? 'HIGH' : 'MEDIUM',
        bestBetStatus: 'PLAYABLE',
        bookmakerOdds: 2,
        suggestedStakePercent: 1,
        ourProbability: 55,
        impliedProbability: 50,
        expectedValue: 10,
        edge: 5,
        kellyFraction: 1,
        rankingScore,
      }));
      return {
        probabilities: {},
        valueOpportunities: opportunities,
        speculativeOpportunities: [{
          matchId: request.matchId,
          marketName: 'Speculative market',
          selection: `${request.matchId}-speculative`,
          confidence: 'LOW',
          bestBetStatus: 'SPECULATIVE',
          marketTier: 'SPECULATIVE',
          bookmakerOdds: 5,
          suggestedStakePercent: 0.25,
          ourProbability: 25,
          impliedProbability: 20,
          expectedValue: 5,
          edge: 5,
          kellyFraction: 0.25,
          rankingScore: 5,
        }],
        comboBets: [],
        bestValueOpportunity: opportunities[0],
      };
    },
    async getBudget() { return { available_budget: 1000 }; },
  };

  const app = express();
  app.use(express.json());
  let apiBase = '';
  app.use('/api', createApiRouter({ db, svc, getInternalApiBaseUrl: () => apiBase }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  apiBase = `http://127.0.0.1:${port}/api`;

  try {
    const response = await fetch(`${apiBase}/automation/place-valid-bets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        dryRun: true,
        userId: 'user1',
        apiBase: 'https://attacker.example/api',
        maxOperationalBetsPerMatch: 3,
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.data.maxOperationalBetsPerMatch, 3);
    assert.equal(payload.data.operationalBetCount, 6);
    assert.equal(payload.data.dryRunCount, 6);
    assert.equal(archived.length, 10);
    assert.equal(archived.filter((row) => row.decisionStatus === 'dry_run').length, 6);
    assert.equal(archived.filter((row) => row.exclusionReason === 'speculative_saved_only').length, 2);
    assert.deepEqual(
      archived
        .filter((row) => row.exclusionReason === 'per_match_limit_reached')
        .map((row) => row.matchId),
      ['match-1', 'match-2'],
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('returns HTTP 500 when a saved-only decision cannot be archived', async () => {
  const db = {
    async getUpcomingMatches() {
      return [{
        match_id: 'match-audit', home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home', away_team_name: 'Away', competition: 'Serie A',
        date: '2026-08-25T18:00:00.000Z',
      }];
    },
    async getLatestOddsSnapshotForMatch() {
      return {
        captured_at: new Date().toISOString(), source: 'odds_api', selectedBookmakerName: 'Pinnacle', usedSyntheticOdds: false,
        liveSelectedOdds: { homeWin: 2 },
      };
    },
    async appendAutomatedBetDecision() { throw new Error('audit unavailable'); },
  };
  const svc = {
    async predict() {
      const low = opportunity({ matchId: 'match-audit', selection: 'low', confidence: 'LOW', rankingScore: 10 });
      return { probabilities: {}, valueOpportunities: [low], speculativeOpportunities: [], comboBets: [] };
    },
    async getBudget() { return { available_budget: 1000 }; },
  };
  const app = express();
  app.use(express.json());
  let apiBase = '';
  app.use('/api', createApiRouter({ db, svc, getInternalApiBaseUrl: () => apiBase }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  apiBase = `http://127.0.0.1:${port}/api`;

  try {
    const response = await fetch(`${apiBase}/automation/place-valid-bets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true, apiBase }),
    });
    const payload = await response.json();
    assert.equal(response.status, 500);
    assert.equal(payload.success, false);
    assert.match(payload.error, /audit unavailable/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('persistent operational slots prevent a retry from exceeding three real bets per match', async () => {
  const isolatedDbPath = isolatedDatabasePath('automated-bet-retry');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const auditDb = new DatabaseService();
  const match = {
    match_id: 'match-retry', home_team_id: 'home', away_team_id: 'away',
    home_team_name: 'Home', away_team_name: 'Away', competition: 'Serie A',
    date: '2026-08-25T18:00:00.000Z',
  };
  const db = {
    async getUpcomingMatches() { return [match]; },
    async getLatestOddsSnapshotForMatch() {
      return {
        captured_at: new Date().toISOString(), source: 'odds_api', selectedBookmakerName: 'Pinnacle', usedSyntheticOdds: false,
        liveSelectedOdds: { homeWin: 2 },
      };
    },
    appendAutomatedBetDecision: (...args) => auditDb.appendAutomatedBetDecision(...args),
    reserveAutomatedBetDecision: (...args) => auditDb.reserveAutomatedBetDecision(...args),
    finalizeAutomatedBetDecision: (...args) => auditDb.finalizeAutomatedBetDecision(...args),
  };
  let placementCalls = 0;
  const svc = {
    async predict(request) {
      const opportunities = [40, 30, 20, 10].map((rankingScore, index) => ({
        ...opportunity({
          matchId: request.matchId,
          selection: `selection-${index + 1}`,
          confidence: index % 2 === 0 ? 'HIGH' : 'MEDIUM',
          rankingScore,
        }),
        marketName: `Market ${index + 1}`,
      }));
      return { probabilities: {}, valueOpportunities: opportunities, speculativeOpportunities: [], comboBets: [] };
    },
    async getBudget() { return { available_budget: 1000 }; },
    async placeBet() {
      placementCalls += 1;
      return { bet: { betId: `bet-${placementCalls}` } };
    },
  };
  const previousEnabled = process.env.AUTO_BET_ENABLED;
  const previousDryRun = process.env.AUTO_BET_DRY_RUN;
  process.env.AUTO_BET_ENABLED = 'true';
  process.env.AUTO_BET_DRY_RUN = 'false';
  const app = express();
  app.use(express.json());
  let apiBase = '';
  app.use('/api', createApiRouter({ db, svc, getInternalApiBaseUrl: () => apiBase }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  apiBase = `http://127.0.0.1:${port}/api`;

  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch(`${apiBase}/automation/place-valid-bets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiBase, maxOperationalBetsPerMatch: 3 }),
      });
      assert.equal(response.status, 200);
    }
    assert.equal(placementCalls, 3);
    const archived = await auditDb.getAutomatedBetDecisions({ matchId: 'match-retry' });
    assert.equal(archived.filter((row) => row.decision_status === 'placed').length, 3);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousEnabled === undefined) delete process.env.AUTO_BET_ENABLED;
    else process.env.AUTO_BET_ENABLED = previousEnabled;
    if (previousDryRun === undefined) delete process.env.AUTO_BET_DRY_RUN;
    else process.env.AUTO_BET_DRY_RUN = previousDryRun;
    try {
      unlinkSync(isolatedDbPath);
    } catch (error) {
      assert.equal(error.code, 'EBUSY');
    }
  }
});

test('concurrent reservations allocate at most three distinct operational slots', async () => {
  const isolatedDbPath = isolatedDatabasePath('automated-bet-concurrency');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();
  const base = {
    userId: 'user1',
    matchId: 'match-concurrent',
    marketName: '1X2',
    confidence: 'HIGH',
    bookmakerOdds: 2,
    theoreticalStakePercent: 1,
    theoreticalStakeAmount: 10,
    rankingPosition: 1,
    operationalSlot: 1,
  };

  const reservations = await Promise.all([
    db.reserveAutomatedBetDecision({ ...base, decisionId: 'concurrent-a', selection: 'homeWin' }),
    db.reserveAutomatedBetDecision({ ...base, decisionId: 'concurrent-b', selection: 'awayWin' }),
    db.reserveAutomatedBetDecision({ ...base, decisionId: 'concurrent-c', selection: 'draw' }),
    db.reserveAutomatedBetDecision({ ...base, decisionId: 'concurrent-d', selection: 'over25' }),
  ]);
  assert.equal(reservations.filter((reservation) => reservation.reserved).length, 3);
  assert.deepEqual(
    reservations.filter((reservation) => reservation.reserved).map((reservation) => reservation.operationalSlot).sort(),
    [1, 2, 3],
  );
  const rows = await db.getAutomatedBetDecisions({ matchId: 'match-concurrent' });
  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.decision_status === 'reserved'));

  try {
    unlinkSync(isolatedDbPath);
  } catch (error) {
    if (error.code !== 'EBUSY') throw error;
  }
});

test('decision migration backfills existing automation bets into persistent match slots', async () => {
  const db = createClient({ url: 'file::memory:' });
  await db.execute(`
    CREATE TABLE bets (
      bet_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, match_id TEXT NOT NULL,
      market_name TEXT NOT NULL, selection TEXT NOT NULL, odds REAL NOT NULL,
      stake REAL NOT NULL, source TEXT, placed_at TEXT NOT NULL
    )
  `);
  await db.execute({
    sql: `INSERT INTO bets
      (bet_id, user_id, match_id, market_name, selection, odds, stake, source, placed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?),
             (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?),
             (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      'auto-1', 'user1', 'match-legacy', '1X2', 'homeWin', 2, 10, 'automation', '2026-08-20T10:00:00Z',
      'auto-2', 'user1', 'match-legacy', 'BTTS', 'bttsYes', 1.9, 9, 'automation', '2026-08-20T10:01:00Z',
      'auto-3', 'user1', 'match-legacy', '1X2', 'homeWin', 2.1, 8, 'automation', '2026-08-20T10:02:00Z',
      'manual-1', 'user1', 'match-legacy', 'O/U', 'over25', 1.8, 8, 'manual', '2026-08-20T10:03:00Z',
      'auto-unicode', 'user1', 'match-unicode', 'Álvaro tiri', 'Over 1.5', 1.9, 7, 'automation', '2026-08-20T10:04:00Z',
    ],
  });
  const migration = readFileSync(join(__dirname, '..', 'migrations', '007_automated_bet_decisions.sql'), 'utf8');
  await db.executeMultiple(migration);

  const rows = await db.execute(`
    SELECT decision_status, bet_id, operational_slot, opportunity_key
    FROM automated_bet_decisions
    WHERE match_id = 'match-legacy'
    ORDER BY operational_slot
  `);
  assert.deepEqual(rows.rows, [
    { decision_status: 'placed', bet_id: 'auto-1', operational_slot: 1, opportunity_key: '1x2\u001fhomewin' },
    { decision_status: 'placed', bet_id: 'auto-2', operational_slot: 2, opportunity_key: 'btts\u001fbttsyes' },
    { decision_status: 'placed', bet_id: 'auto-3', operational_slot: 3, opportunity_key: '1x2\u001fhomewin\u001flegacy-2' },
  ]);

  const unicodeKey = automatedBetOpportunityKey('Álvaro tiri', 'Over 1.5');
  const duplicateReservation = await db.execute({
    sql: `INSERT OR IGNORE INTO automated_bet_decisions (
      decision_id, user_id, match_id, market_name, selection, opportunity_key,
      ranking_position, operational_slot, decision_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?)`,
    args: [
      'unicode-reranked', 'user1', 'match-unicode', 'Álvaro tiri', 'Over 1.5',
      unicodeKey, 2, 2, '2026-08-20T10:05:00Z',
    ],
  });
  assert.equal(Number(duplicateReservation.rowsAffected), 0);
});

test('keeps a durable reservation and returns HTTP 500 if audit finalization fails after placement', async () => {
  const reservations = [];
  const db = {
    async getUpcomingMatches() {
      return [{
        match_id: 'match-finalize', home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home', away_team_name: 'Away', competition: 'Serie A',
        date: '2026-08-25T18:00:00.000Z',
      }];
    },
    async getLatestOddsSnapshotForMatch() {
      return {
        captured_at: new Date().toISOString(), source: 'odds_api', selectedBookmakerName: 'Pinnacle', usedSyntheticOdds: false,
        liveSelectedOdds: { homeWin: 2 },
      };
    },
    async appendAutomatedBetDecision() {},
    async reserveAutomatedBetDecision(row) {
      reservations.push({ ...row, decisionStatus: 'reserved' });
      return { reserved: true, decisionId: row.decisionId };
    },
    async finalizeAutomatedBetDecision() { throw new Error('finalization unavailable'); },
  };
  let placementCalls = 0;
  const svc = {
    async predict() {
      const high = opportunity({ matchId: 'match-finalize', selection: 'high', confidence: 'HIGH', rankingScore: 10 });
      return { probabilities: {}, valueOpportunities: [high], speculativeOpportunities: [], comboBets: [] };
    },
    async getBudget() { return { available_budget: 1000 }; },
    async placeBet() {
      placementCalls += 1;
      return { bet: { betId: 'placed-before-finalization-error' } };
    },
  };
  const previousEnabled = process.env.AUTO_BET_ENABLED;
  const previousDryRun = process.env.AUTO_BET_DRY_RUN;
  process.env.AUTO_BET_ENABLED = 'true';
  process.env.AUTO_BET_DRY_RUN = 'false';
  const app = express();
  app.use(express.json());
  let apiBase = '';
  app.use('/api', createApiRouter({ db, svc, getInternalApiBaseUrl: () => apiBase }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  apiBase = `http://127.0.0.1:${port}/api`;

  try {
    const response = await fetch(`${apiBase}/automation/place-valid-bets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiBase }),
    });
    const payload = await response.json();
    assert.equal(response.status, 500);
    assert.equal(payload.success, false);
    assert.equal(placementCalls, 1);
    assert.equal(reservations.length, 1);
    assert.equal(reservations[0].decisionStatus, 'reserved');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousEnabled === undefined) delete process.env.AUTO_BET_ENABLED;
    else process.env.AUTO_BET_ENABLED = previousEnabled;
    if (previousDryRun === undefined) delete process.env.AUTO_BET_DRY_RUN;
    else process.env.AUTO_BET_DRY_RUN = previousDryRun;
  }
});

test('ambiguous placement failure keeps the slot reserved so a retry cannot place again', async () => {
  const isolatedDbPath = isolatedDatabasePath('automated-bet-ambiguous');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const auditDb = new DatabaseService();
  const match = {
    match_id: 'match-ambiguous', home_team_id: 'home', away_team_id: 'away',
    home_team_name: 'Home', away_team_name: 'Away', competition: 'Serie A',
    date: '2026-08-25T18:00:00.000Z',
  };
  const db = {
    async getUpcomingMatches() { return [match]; },
    async getLatestOddsSnapshotForMatch() {
      return {
        captured_at: new Date().toISOString(), source: 'odds_api', selectedBookmakerName: 'Pinnacle', usedSyntheticOdds: false,
        liveSelectedOdds: { homeWin: 2 },
      };
    },
    appendAutomatedBetDecision: (...args) => auditDb.appendAutomatedBetDecision(...args),
    reserveAutomatedBetDecision: (...args) => auditDb.reserveAutomatedBetDecision(...args),
    finalizeAutomatedBetDecision: (...args) => auditDb.finalizeAutomatedBetDecision(...args),
    markAutomatedBetDecisionPlacementUnknown: (...args) => auditDb.markAutomatedBetDecisionPlacementUnknown(...args),
  };
  let placementCalls = 0;
  const placementSelections = [];
  let predictionCalls = 0;
  const svc = {
    async predict(request) {
      predictionCalls += 1;
      const ambiguous = opportunity({ matchId: request.matchId, selection: 'homeWin', confidence: 'HIGH', rankingScore: 10 });
      const reranked = predictionCalls > 1
        ? [
            opportunity({ matchId: request.matchId, selection: 'awayWin', confidence: 'HIGH', rankingScore: 20 }),
            ambiguous,
          ]
        : [ambiguous];
      return { probabilities: {}, valueOpportunities: reranked, speculativeOpportunities: [], comboBets: [] };
    },
    async getBudget() { return { available_budget: 1000 }; },
    async placeBet(_userId, _matchId, _marketName, selection) {
      placementCalls += 1;
      placementSelections.push(selection);
      if (selection === 'homeWin') throw new Error('connection lost after submit');
      return { bet: { betId: `bet-${selection}` } };
    },
  };
  const previousEnabled = process.env.AUTO_BET_ENABLED;
  const previousDryRun = process.env.AUTO_BET_DRY_RUN;
  process.env.AUTO_BET_ENABLED = 'true';
  process.env.AUTO_BET_DRY_RUN = 'false';
  const app = express();
  app.use(express.json());
  let apiBase = '';
  app.use('/api', createApiRouter({ db, svc, getInternalApiBaseUrl: () => apiBase }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  apiBase = `http://127.0.0.1:${port}/api`;

  try {
    const first = await fetch(`${apiBase}/automation/place-valid-bets`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiBase }),
    });
    const second = await fetch(`${apiBase}/automation/place-valid-bets`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiBase }),
    });
    assert.equal(first.status, 500);
    assert.equal(second.status, 200);
    assert.equal(placementCalls, 2);
    assert.deepEqual(placementSelections, ['homeWin', 'awayWin']);
    const rows = await auditDb.getAutomatedBetDecisions({ matchId: 'match-ambiguous' });
    const held = rows.find((row) => row.decision_status === 'reserved');
    const newlyPlaced = rows.find((row) => row.bet_id === 'bet-awayWin');
    assert.ok(held);
    assert.equal(Number(held.operational_slot), 1);
    assert.match(held.exclusion_reason, /connection lost after submit/i);
    assert.ok(newlyPlaced);
    assert.equal(Number(newlyPlaced.operational_slot), 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousEnabled === undefined) delete process.env.AUTO_BET_ENABLED;
    else process.env.AUTO_BET_ENABLED = previousEnabled;
    if (previousDryRun === undefined) delete process.env.AUTO_BET_DRY_RUN;
    else process.env.AUTO_BET_DRY_RUN = previousDryRun;
    try {
      unlinkSync(isolatedDbPath);
    } catch (error) {
      assert.equal(error.code, 'EBUSY');
    }
  }
});
