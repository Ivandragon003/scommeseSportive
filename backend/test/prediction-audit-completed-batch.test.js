const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const build = process.env.PREDICTION_TEST_BUILD ?? '../dist';
const { DatabaseService } = require(`${build}/db/DatabaseService`);
const { PredictionService } = require(`${build}/services/PredictionService`);

async function fixture(t) {
  const client = createClient({ url: 'file::memory:' });
  t.after(() => client.close());
  await client.executeMultiple(`
    CREATE TABLE matches(match_id TEXT PRIMARY KEY, home_goals INTEGER, away_goals INTEGER);
    CREATE TABLE predictions(prediction_id TEXT PRIMARY KEY, match_id TEXT, selection TEXT, result TEXT, created_at TEXT);
  `);
  const reads = [], matchBatches = [];
  const db = Object.create(DatabaseService.prototype);
  db.all = async (sql, args = []) => {
    const rows = (await client.execute({ sql, args })).rows;
    reads.push({ sql, args, rows });
    return rows;
  };
  db.getMatchesByIds = async ids => {
    matchBatches.push([...ids]);
    return (await client.execute({
      sql: `SELECT * FROM matches WHERE match_id IN (${ids.map(() => '?').join(',')})`, args: ids,
    })).rows;
  };
  db.settlePrediction = async (id, result) => client.execute({
    sql: 'UPDATE predictions SET result=? WHERE prediction_id=? AND result=\'pending\'', args: [result, id],
  });
  // Use the existing fallback in the settlement service; no other app schema is needed.
  db.settlePredictionsBatch = undefined;
  const prediction = async (id, match, selection = 'homeWin', result = 'pending') => client.execute({
    sql: 'INSERT INTO predictions(prediction_id,match_id,selection,result,created_at) VALUES (?,?,?,?,?)', args: [id, match, selection, result,
      new Date(Date.parse('2026-10-01T00:00:00Z') + (Number(id.replace(/\D/g, '')) || 0) * 60000).toISOString()],
  });
  return { client, db, prediction, reads, matchBatches };
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

test('technical audit downloads bounded match batches and compact predictions beyond unresolved batches', async t => {
  const f = await fixture(t);
  await f.client.executeMultiple('ALTER TABLE predictions ADD COLUMN audit_payload TEXT; ALTER TABLE matches ADD COLUMN raw_json TEXT;');
  const raw = JSON.stringify({ padding: 'x'.repeat(128 * 1024), playerStats: [{ sourcePlayerId: '77', shots: 0 }] });
  for (let index = 0; index < 58; index++) {
    const matchId = `archive-${index}`;
    await f.client.execute({ sql: 'INSERT INTO matches VALUES (?,1,0,?)', args: [matchId, raw] });
    const selection = index < 30 ? 'shots_total_under_20.5'
      : index === 55 ? 'player_understat_player_77_shots_under_0_5' : 'homeWin';
    await f.prediction(`p${index}`, matchId, selection);
  }
  // The limit counts settled matches, never the number of predictions in a match.
  await f.prediction('p100', 'archive-30', 'awayWin');
  await f.client.execute({ sql: 'UPDATE predictions SET audit_payload=?', args: ['y'.repeat(128 * 1024)] });

  const result = await new PredictionService(f.db).settlePendingPredictionsForCompletedMatches(26);
  assert.deepEqual(result, { matches: 56, settled: 27, unresolved: 30 });
  assert.deepEqual(f.matchBatches.map(ids => ids.length), [25, 25, 8]);
  assert.deepEqual(f.matchBatches.flat(), Array.from({ length: 58 }, (_, index) => `archive-${index}`));
  const predictions = f.reads.filter(read => /SELECT p\.prediction_id, p\.match_id, p\.selection/.test(read.sql));
  assert.equal(predictions.length, 3);
  for (const read of predictions) {
    assert.ok(read.args.length > 0 && read.args.length <= 25);
    assert.match(read.sql, /p\.match_id IN/);
    for (const row of read.rows) assert.deepEqual(Object.keys(row), ['prediction_id', 'match_id', 'selection']);
    assert.ok(Buffer.byteLength(JSON.stringify(read.rows)) < 10_000, 'Heavy audit payload must not be downloaded');
  }
  const queue = f.reads.find(read => /WITH pending_matches/.test(read.sql));
  assert.ok(queue.rows.every(row => Object.keys(row).join() === 'match_id'));
  const outcomes = (await f.client.execute('SELECT prediction_id,result FROM predictions')).rows;
  assert.equal(outcomes.find(row => row.prediction_id === 'p55').result, 'win', 'Player observations in raw_json must survive batching');
  assert.equal(outcomes.find(row => row.prediction_id === 'p56').result, 'pending', 'Next settled match must wait for the next invocation');
  assert.equal(outcomes.find(row => row.prediction_id === 'p57').result, 'pending');
});

test('compact match queue preserves the earliest pending prediction tie-break across matches', async t => {
  const f = await fixture(t);
  await f.client.execute("INSERT INTO matches VALUES ('first',1,0),('second',0,0),('third',0,1)");
  const insert = (id, matchId, createdAt) => f.client.execute({
    sql: "INSERT INTO predictions VALUES (?,?,'homeWin','pending',?)", args: [id, matchId, createdAt],
  });
  await insert('z-early', 'first', '2026-10-01T00:00:00Z');
  await insert('a-later', 'first', '2026-10-02T00:00:00Z');
  await insert('b-early', 'second', '2026-10-01T00:00:00Z');
  await insert('c-early', 'third', '2026-10-01T00:00:00Z');
  assert.deepEqual(await f.db.getPendingPredictionMatchIdsForCompletedMatches(), ['second', 'third', 'first']);
  assert.deepEqual(await f.db.getPendingPredictionsForCompletedMatches([]), []);
  assert.deepEqual((await f.db.getPendingPredictionsForCompletedMatches(['first'])).map(row => row.prediction_id), ['z-early', 'a-later']);
});
