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
  automatedSavedDecisionId,
  isExceptionalLowConfidenceOpportunity,
  planAutomatedBetOpportunities,
} = require('../dist/services/AutomatedBetPlanningService.js');
const { DatabaseService } = require('../dist/db/DatabaseService.js');
const { createApiRouter } = require('../dist/api/routes.js');

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
      ['speculative', 'speculative_saved_only'],
      ['speculative-tier', 'speculative_saved_only'],
      ['low', 'low_confidence_saved_only'],
      ['unknown', 'unsupported_confidence_saved_only'],
    ],
  );
});

test('ammette una LOW verificata solo dopo HIGH/MEDIUM e solo con EV, edge e Kelly positivi', () => {
  const strongLow = {
    ...opportunity({ matchId: 'match-1', selection: 'low-strong', confidence: 'LOW', rankingScore: 100 }),
    realBookmakerOdds: true,
    edgeNoVig: 4,
    kellyFraction: 1.2,
  };
  assert.equal(isExceptionalLowConfidenceOpportunity(strongLow), true);

  const decisions = planAutomatedBetOpportunities([
    strongLow,
    opportunity({ matchId: 'match-1', selection: 'high', confidence: 'HIGH', rankingScore: 30 }),
    opportunity({ matchId: 'match-1', selection: 'medium', confidence: 'MEDIUM', rankingScore: 20 }),
    { ...strongLow, selection: 'low-no-edge', edgeNoVig: 0 },
  ], 3);

  assert.deepEqual(
    decisions.filter((decision) => decision.action === 'operational').map((decision) => decision.opportunity.selection),
    ['high', 'medium', 'low-strong'],
  );
  assert.equal(decisions.find((decision) => decision.opportunity.selection === 'low-no-edge').reason, 'low_confidence_saved_only');
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

test('saved-only audit usa un id stabile e aggiorna lo stesso record ai retry', async () => {
  const isolatedDbPath = isolatedDatabasePath('automated-bet-saved-idempotent');
  process.env.TURSO_DATABASE_URL = `file:${isolatedDbPath}`;
  const db = new DatabaseService();
  const decisionId = automatedSavedDecisionId('user1', 'match-1', '1X2', 'awayWin');
  const base = {
    decisionId,
    userId: 'user1',
    matchId: 'match-1',
    marketName: '1X2',
    selection: 'awayWin',
    confidence: 'LOW',
    bookmakerName: 'Pinnacle',
    theoreticalStakePercent: 1,
    theoreticalStakeAmount: 10,
    rankingPosition: 1,
    decisionStatus: 'saved_only',
    exclusionReason: 'low_confidence_saved_only',
  };

  await db.appendAutomatedBetDecision({ ...base, bookmakerOdds: 4.2, createdAt: '2026-08-26T01:00:00Z' });
  await db.appendAutomatedBetDecision({ ...base, bookmakerOdds: 4.4, createdAt: '2026-08-26T02:00:00Z' });
  const rows = await db.getAutomatedBetDecisions({ matchId: 'match-1' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].decision_id, decisionId);
  assert.equal(Number(rows[0].bookmaker_odds), 4.4);
  assert.equal(rows[0].created_at, '2026-08-26T02:00:00Z');

  try {
    unlinkSync(isolatedDbPath);
  } catch (error) {
    if (error.code !== 'EBUSY') throw error;
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



test('retired nightly placement rejects legacy flags, retries and concurrent calls without any provider, DB or betting side effect', async () => {
  const previousEnabled = process.env.AUTO_BET_ENABLED;
  const previousDryRun = process.env.AUTO_BET_DRY_RUN;
  process.env.AUTO_BET_ENABLED = 'true'; process.env.AUTO_BET_DRY_RUN = 'false';
  const effects = [];
  const db = new Proxy({}, { get: (_target, property) => {
    if (property === 'getDb') return () => null;
    return async () => { effects.push(String(property)); throw new Error('Legacy automation must not touch DB'); };
  } });
  const app = express(); app.use(express.json());
  app.use('/api', createApiRouter({ db, svc: {} }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/automation/place-valid-bets`;
    const responses = await Promise.all([{}, { dryRun: false, limit: 100 }, { enabled: true, force: true }].map((body) =>
      fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })));
    for (const response of responses) {
      assert.equal(response.status, 410);
      const payload = await response.json();
      assert.equal(payload.success, false); assert.match(payload.error, /retired|T-15/i);
    }
    assert.deepEqual(effects, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousEnabled === undefined) delete process.env.AUTO_BET_ENABLED; else process.env.AUTO_BET_ENABLED = previousEnabled;
    if (previousDryRun === undefined) delete process.env.AUTO_BET_DRY_RUN; else process.env.AUTO_BET_DRY_RUN = previousDryRun;
  }
});
