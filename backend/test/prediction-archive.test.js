const test = require('node:test');
const assert = require('node:assert/strict');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const dbPath = join(tmpdir(), `prediction-archive-${process.pid}-${Date.now()}.db`);
process.env.TURSO_DATABASE_URL = `file:${dbPath}`;
process.env.TURSO_AUTH_TOKEN = 'test-token';

const { DatabaseService } = require('../dist/db/DatabaseService.js');

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
