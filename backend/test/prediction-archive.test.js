const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const express = require('express');

const dbPath = join(tmpdir(), `prediction-archive-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
process.env.TURSO_AUTH_TOKEN = 'test-token';

const { DatabaseService } = require('../dist/db/DatabaseService.js');
const { createApiRouter } = require('../dist/api/routes.js');

test('getPredictionArchive arricchisce ogni prediction con la partita senza alterare i dati originali', async () => {
  const db = new DatabaseService();
  await db.upsertMatch({
    matchId: 'understat_30780',
    homeTeamId: 'espanyol',
    awayTeamId: 'real_madrid',
    homeTeamName: 'Espanyol',
    awayTeamName: 'Real Madrid',
    competition: 'La Liga',
    season: '2026/2027',
    date: '2026-08-22T19:30:00.000Z',
    source: 'understat',
  });
  await db.appendPredictions([{
    predictionId: 'archive-prediction',
    matchId: 'understat_30780',
    market: '1x2',
    selection: 'awayWin',
    rawProbability: 0.61,
    oddsAtPrediction: 2.15,
    source: 'odds_api',
    confidenceComputed: 'HIGH',
  }]);

  const rows = await db.getPredictionArchive({ matchId: 'understat_30780', limit: 1 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].prediction_id, 'archive-prediction');
  assert.equal(rows[0].odds_at_prediction, 2.15);
  assert.equal(rows[0].confidence_computed, 'HIGH');
  assert.equal(rows[0].home_team_name, 'Espanyol');
  assert.equal(rows[0].away_team_name, 'Real Madrid');
  assert.equal(rows[0].competition, 'La Liga');
  assert.equal(rows[0].match_date, '2026-08-22T19:30:00.000Z');
});

test('getBetOpportunityArchive mostra solo opportunita classificate e distingue operative e simulate', async () => {
  const db = new DatabaseService();
  await db.upsertMatch({
    matchId: 'understat_31000',
    homeTeamId: 'napoli',
    awayTeamId: 'roma',
    homeTeamName: 'Napoli',
    awayTeamName: 'Roma',
    competition: 'Serie A',
    season: '2026/2027',
    date: '2026-08-24T19:45:00.000Z',
    source: 'understat',
  });

  const createdAt = '2026-08-24T10:00:00.000Z';
  await db.appendPredictions([
    {
      predictionId: 'raw-noise', matchId: 'understat_31000', market: 'exact_score', selection: 'exact_0-5',
      rawProbability: 0.01, createdAt, result: 'loss', source: 'model',
    },
    {
      predictionId: 'prediction-high', matchId: 'understat_31000', market: '1x2', selection: 'homeWin',
      rawProbability: 0.61, calibratedProbability: 0.59, oddsAtPrediction: 1.95, ev: 0.15,
      confidenceComputed: 'HIGH', createdAt, result: 'win', settledAt: '2026-08-24T22:00:00.000Z', source: 'odds_api',
    },
    {
      predictionId: 'prediction-medium', matchId: 'understat_31000', market: 'goals', selection: 'over2_5',
      rawProbability: 0.56, oddsAtPrediction: 2.05, ev: 0.12, confidenceComputed: 'MEDIUM',
      createdAt, result: 'loss', settledAt: '2026-08-24T22:00:00.000Z', source: 'odds_api',
    },
    {
      predictionId: 'prediction-low', matchId: 'understat_31000', market: 'btts', selection: 'btts',
      rawProbability: 0.52, oddsAtPrediction: 2.1, ev: 0.09, confidenceComputed: 'LOW',
      createdAt, result: 'void', settledAt: '2026-08-24T22:00:00.000Z', source: 'odds_api',
    },
    {
      predictionId: 'prediction-speculative', matchId: 'understat_31000', market: 'exact_score', selection: 'exact_2-1',
      rawProbability: 0.18, oddsAtPrediction: 7.5, ev: 0.07, confidenceComputed: 'MEDIUM',
      createdAt, result: 'pending', source: 'odds_api',
    },
  ]);
  await db.settlePrediction('raw-noise', 'loss', '2026-08-24T22:00:00.000Z');
  await db.settlePrediction('prediction-high', 'win', '2026-08-24T22:00:00.000Z');
  await db.settlePrediction('prediction-medium', 'loss', '2026-08-24T22:00:00.000Z');
  await db.settlePrediction('prediction-low', 'void', '2026-08-24T22:00:00.000Z');

  await db.saveBet({
    betId: 'bet-high', userId: 'user1', matchId: 'understat_31000', marketName: '1X2', selection: 'homeWin',
    odds: 1.93, stake: 20, ourProbability: 59, expectedValue: 15, status: 'WON',
    placedAt: createdAt, settledAt: '2026-08-24T22:00:00.000Z', predictionId: 'prediction-high', source: 'automation',
  });

  const decisions = [
    ['decision-high', '1X2', 'homeWin', 'HIGH', 1.95, 1, 'placed', null, 'bet-high'],
    ['decision-medium', 'Over/Under', 'over2_5', 'MEDIUM', 2.05, null, 'saved_only', 'per_match_limit_reached', null],
    ['decision-low', 'Goal/Goal', 'btts', 'LOW', 2.1, null, 'saved_only', 'low_confidence_saved_only', null],
    ['decision-speculative', 'Risultato esatto', 'exact_2-1', 'MEDIUM', 7.5, null, 'saved_only', 'speculative_saved_only', null],
    ['decision-unsupported', 'Internal', 'unknown', null, 2, null, 'saved_only', 'unsupported_confidence_saved_only', null],
  ];
  for (const [decisionId, marketName, selection, confidence, bookmakerOdds, operationalSlot, decisionStatus, exclusionReason, betId] of decisions) {
    await db.appendAutomatedBetDecision({
      decisionId, userId: 'user1', matchId: 'understat_31000', marketName, selection, confidence,
      bookmakerOdds, bookmakerName: 'Pinnacle', theoreticalStakePercent: 1.5, theoreticalStakeAmount: 15,
      rankingPosition: decisions.findIndex((row) => row[0] === decisionId) + 1,
      operationalSlot, decisionStatus, exclusionReason, betId, createdAt,
    });
  }

  const rows = await db.getBetOpportunityArchive({ limit: 20 });

  assert.deepEqual(rows.map((row) => row.decision_id), [
    'decision-high', 'decision-medium', 'decision-low', 'decision-speculative',
  ]);
  assert.deepEqual(rows.map((row) => row.classification), ['HIGH', 'MEDIUM', 'LOW', 'SPECULATIVE']);
  assert.deepEqual(rows.map((row) => row.archive_type), ['operative', 'simulated', 'simulated', 'simulated']);
  assert.deepEqual(rows.map((row) => row.result), ['win', 'loss', 'void', 'pending']);
  assert.equal(Number(rows[0].display_odds), 1.93);
  assert.equal(Number(rows[1].display_odds), 2.05);
  assert.equal(rows[1].bookmaker_name, 'Pinnacle');
  assert.equal(rows.some((row) => row.selection === 'exact_0-5'), false);

  await db.saveBet({
    betId: 'bet-other-user', userId: 'user2', matchId: 'understat_31000', marketName: '1X2', selection: 'homeWin',
    odds: 1.9, stake: 10, ourProbability: 59, expectedValue: 12, status: 'WON',
    placedAt: createdAt, settledAt: '2026-08-24T22:00:00.000Z', predictionId: 'prediction-high', source: 'manual',
  });
  await db.appendAutomatedBetDecision({
    decisionId: 'decision-other-user', userId: 'user2', matchId: 'understat_31000', marketName: '1X2',
    selection: 'homeWin', confidence: 'HIGH', bookmakerOdds: 1.9, bookmakerName: 'Pinnacle',
    theoreticalStakePercent: 1, theoreticalStakeAmount: 10, rankingPosition: 1,
    decisionStatus: 'placed', betId: 'bet-other-user', createdAt,
  });

  const sharedPredictions = await db.getPredictionArchive({ matchId: 'understat_31000', userId: 'user1' });
  assert.equal(sharedPredictions.filter((row) => row.prediction_id === 'prediction-high').length, 1);
  assert.equal(sharedPredictions.find((row) => row.prediction_id === 'prediction-high').bet_user_id, 'user1');

  const sharedOpportunities = await db.getBetOpportunityArchive({ userId: 'user1', limit: 20 });
  assert.equal(sharedOpportunities.some((row) => row.decision_id === 'decision-other-user'), false);

  const pendingOpportunityPredictions = await db.getPendingBetOpportunityPredictions();
  assert.deepEqual(pendingOpportunityPredictions.map((row) => row.prediction_id), ['prediction-speculative']);
});

test('getBetOpportunityArchive filtra classificazione tipo ed esito', async () => {
  const db = new DatabaseService();

  const speculative = await db.getBetOpportunityArchive({ classification: 'speculative', limit: 20 });
  assert.deepEqual(speculative.map((row) => row.decision_id), ['decision-speculative']);

  const simulatedLosses = await db.getBetOpportunityArchive({ type: 'simulated', result: 'loss', limit: 20 });
  assert.deepEqual(simulatedLosses.map((row) => row.decision_id), ['decision-medium']);
});

test('GET /bet-opportunities/archive inoltra i filtri e restituisce il nuovo contratto', async () => {
  let receivedOptions = null;
  const db = {
    async getBetOpportunityArchive(options) {
      receivedOptions = options;
      return [{ decision_id: 'decision-api', classification: 'LOW', archive_type: 'simulated', result: 'pending' }];
    },
  };
  const app = express();
  app.use('/api', createApiRouter({ db, svc: {} }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/bet-opportunities/archive?type=simulated&classification=low&result=pending&limit=50`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.success, true);
    assert.equal(payload.data[0].decision_id, 'decision-api');
    assert.deepEqual(receivedOptions, {
      type: 'simulated', classification: 'low', result: 'pending', matchId: undefined, userId: 'user1', limit: 50,
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
