const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { PredictionService } = require('../dist/services/PredictionService');

async function fixture(t) {
  const client = createClient({ url: 'file::memory:' });
  t.after(() => client.close());
  await client.executeMultiple(`
    CREATE TABLE matches(match_id TEXT PRIMARY KEY, home_goals INTEGER, away_goals INTEGER);
    CREATE TABLE predictions(prediction_id TEXT PRIMARY KEY, match_id TEXT, selection TEXT, result TEXT, created_at TEXT);
  `);
  const db = Object.create(DatabaseService.prototype);
  db.all = async (sql, args = []) => (await client.execute({ sql, args })).rows;
  db.getMatchesByIds = async ids => (await client.execute({
    sql: `SELECT * FROM matches WHERE match_id IN (${ids.map(() => '?').join(',')})`, args: ids,
  })).rows;
  db.settlePrediction = async (id, result) => client.execute({
    sql: 'UPDATE predictions SET result=? WHERE prediction_id=? AND result=\'pending\'', args: [result, id],
  });
  // Use the existing fallback in the settlement service; no other app schema is needed.
  db.settlePredictionsBatch = undefined;
  const prediction = async (id, match, selection = 'homeWin', result = 'pending') => client.execute({
    sql: 'INSERT INTO predictions VALUES (?,?,?,?,?)', args: [id, match, selection, result,
      new Date(Date.parse('2026-10-01T00:00:00Z') + (Number(id.replace(/\D/g, '')) || 0) * 60000).toISOString()],
  });
  return { client, db, prediction };
}

test('future, missing and partially scored rows do not consume the completed-match limit', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 25; i++) {
    const id = `open-${i}`;
    if (i !== 0) await f.client.execute({ sql: 'INSERT INTO matches VALUES (?,NULL,?)', args: [id, i === 1 ? 0 : null] });
    await f.prediction(`p${i}`, id);
  }
  await f.client.execute("INSERT INTO matches VALUES ('done',0,0),('next',1,0)");
  await f.prediction('p26', 'done', 'draw');
  await f.prediction('p27', 'done', 'homeWin');
  await f.prediction('p28', 'next');
  await f.prediction('p29', 'done', 'awayWin', 'loss');
  const rows = await f.db.getPendingPredictionsForCompletedMatches();
  assert.deepEqual(rows.map(row => row.prediction_id), ['p26', 'p27', 'p28']);
  const service = new PredictionService(f.db);
  assert.deepEqual(await service.settlePendingPredictionsForCompletedMatches(1), { matches: 1, settled: 2, unresolved: 0 });
  assert.deepEqual(await service.settlePendingPredictionsForCompletedMatches(1), { matches: 1, settled: 1, unresolved: 0 });
  assert.deepEqual(await service.settlePendingPredictionsForCompletedMatches(1), { matches: 0, settled: 0, unresolved: 0 });
  const pending = (await f.client.execute("SELECT count(*) n FROM predictions WHERE result='pending'")).rows[0].n;
  assert.equal(pending, 25);
});

test('missing statistics remain pending instead of settling as observed zeros', async t => {
  const f = await fixture(t);
  await f.client.execute("INSERT INTO matches VALUES ('done',0,0)");
  await f.prediction('p0', 'done', 'shots_total_under_20.5');
  assert.deepEqual(await new PredictionService(f.db).settlePendingPredictionsForCompletedMatches(1), { matches: 1, settled: 0, unresolved: 1 });
  assert.equal((await f.client.execute('SELECT result FROM predictions')).rows[0].result, 'pending');
  await assert.rejects(new PredictionService(f.db).settlePendingPredictionsForCompletedMatches(NaN), /Invalid completed prediction match limit/);
});

test('completed matches with absent market observations cannot starve later goal settlements', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 25; i++) {
    const id = `no-stats-${i}`;
    await f.client.execute({ sql: 'INSERT INTO matches VALUES (?,0,0)', args: [id] });
    await f.prediction(`p${i}`, id, 'shots_total_under_20.5');
  }
  await f.client.execute("INSERT INTO matches VALUES ('ready',1,0)");
  await f.prediction('p26', 'ready');
  const service = new PredictionService(f.db);
  assert.deepEqual(await service.settlePendingPredictionsForCompletedMatches(1), { matches: 26, settled: 1, unresolved: 25 });
  assert.deepEqual(await service.settlePendingPredictionsForCompletedMatches(1), { matches: 25, settled: 0, unresolved: 25 });
});
