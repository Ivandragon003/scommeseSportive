const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const dbPath = join(tmpdir(), `shared-bankroll-concurrency-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
process.env.TURSO_AUTH_TOKEN = 'test-token';

const { DatabaseService } = require('../dist/db/DatabaseService.js');
const { PredictionService } = require('../dist/services/PredictionService.js');

const makeBet = (betId, overrides = {}) => ({
  betId,
  userId: 'user1',
  matchId: 'match-1',
  marketName: '1X2',
  selection: 'home',
  odds: 2,
  stake: 60,
  ourProbability: 0.55,
  expectedValue: 0.1,
  status: 'PENDING',
  placedAt: new Date('2026-08-24T10:00:00.000Z'),
  dataQuality: 'post_fix',
  source: 'manual',
  ...overrides,
});

test('concurrent shared-bankroll writes cannot overspend or create duplicate bets', async () => {
  const db = new DatabaseService();
  try {
    await db.createOrResetBudget('user1', 100);

    const overspendResults = await Promise.all([
      db.placeBetAtomically(makeBet('bet-a', { matchId: 'match-a', selection: 'home' })),
      db.placeBetAtomically(makeBet('bet-b', { matchId: 'match-b', selection: 'away' })),
    ]);

    assert.equal(overspendResults.filter((result) => result.placed).length, 1);
    assert.equal(overspendResults.filter((result) => !result.placed && result.reason === 'budget').length, 1);
    assert.equal((await db.getBets('user1')).length, 1);
    assert.equal(Number((await db.getBudget('user1')).available_budget), 40);

    await db.createOrResetBudget('user1', 100);
    const duplicateResults = await Promise.all([
      db.placeBetAtomically(makeBet('bet-c', { stake: 10 })),
      db.placeBetAtomically(makeBet('bet-d', { stake: 10 })),
    ]);

    assert.equal(duplicateResults.filter((result) => result.placed).length, 1);
    assert.equal(duplicateResults.filter((result) => !result.placed && result.reason === 'duplicate').length, 1);
    assert.equal((await db.getBets('user1')).length, 1);
    assert.equal(Number((await db.getBudget('user1')).available_budget), 90);
  } finally {
    await db.close();
  }
});

test('PredictionService concurrent placements keep the atomic bankroll result', async () => {
  const db = new DatabaseService();
  try {
    await db.createOrResetBudget('user1', 100);
    db.updateBudget = async () => {
      throw new Error('service must not use a read-then-write budget recomputation');
    };
    const service = new PredictionService(db);

    const placements = await Promise.all([
      service.placeBet('user1', 'service-match-a', '1X2', 'home', 2, 40, 0.55, 0.1),
      service.placeBet('user1', 'service-match-b', '1X2', 'away', 2, 40, 0.55, 0.1),
    ]);

    assert.equal(placements.length, 2);
    assert.equal((await db.getBets('user1')).length, 2);
    const budget = await db.getBudget('user1');
    assert.equal(Number(budget.available_budget), 20);
    assert.equal(Number(budget.total_bets), 2);
    assert.equal(Number(budget.total_staked), 80);
  } finally {
    await db.close();
  }
});

test('settlement sync interleaved with placement applies one return and preserves the new debit', async () => {
  const db = new DatabaseService();
  try {
    await db.createOrResetBudget('user1', 100);
    await db.placeBetAtomically(makeBet('pending-winner', {
      matchId: 'played-match',
      homeTeamName: 'Home',
      awayTeamName: 'Away',
      stake: 40,
      odds: 2,
    }));

    const service = new PredictionService(db);
    let resolvers = 0;
    let releaseResolvers;
    const bothResolversEntered = new Promise((resolve) => { releaseResolvers = resolve; });
    service.resolvePlayedMatchForBet = async () => {
      resolvers += 1;
      if (resolvers === 2) releaseResolvers();
      await bothResolversEntered;
      return { match_id: 'played-match' };
    };
    service.settlePendingPredictionsForMatch = async () => {};
    service.evaluateSelectionForMatch = () => ({ status: 'WON', reason: 'test' });

    await Promise.all([
      service.syncPendingBets('user1'),
      service.placeBet('user1', 'new-match', '1X2', 'away', 2, 30, 0.55, 0.1),
    ]);

    const bets = await db.getBets('user1');
    assert.equal(bets.length, 2);
    assert.equal(bets.filter((bet) => bet.status === 'WON').length, 1);
    assert.equal(bets.filter((bet) => bet.status === 'PENDING').length, 1);

    const budget = await db.getBudget('user1');
    assert.equal(Number(budget.available_budget), 110);
    assert.equal(Number(budget.total_bets), 2);
    assert.equal(Number(budget.total_staked), 70);
    assert.equal(Number(budget.total_won), 80);
    assert.equal(Number(budget.total_lost), 0);
    assert.equal(Number(budget.roi), 100);
    assert.equal(Number(budget.win_rate), 100);
  } finally {
    await db.close();
  }
});
