const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService } = require('../dist/db/DatabaseService.js');

const buildHarness = (rows) => {
  const calls = [];
  const db = Object.create(DatabaseService.prototype);
  db.all = async (sql, params) => {
    calls.push({ sql, params });
    return rows;
  };
  return { db, calls };
};

test('getUpcomingMatches filtra da nowIso, scarta passate/invalide e ordina in modo stabile', async () => {
  const { db, calls } = buildHarness([
    {
      match_id: 'past_april',
      home_team_name: 'Juventus',
      away_team_name: 'Roma',
      date: '2026-04-20T18:45:00.000Z',
      home_goals: null,
      away_goals: null,
    },
    {
      match_id: 'future_late',
      home_team_name: 'Bologna',
      away_team_name: 'Inter',
      date: '2026-05-23T18:30:00.000Z',
      home_goals: null,
      away_goals: null,
    },
    {
      match_id: 'invalid_date',
      home_team_name: 'Milan',
      away_team_name: 'Lazio',
      date: 'not-a-date',
      home_goals: null,
      away_goals: null,
    },
    {
      match_id: 'future_early',
      home_team_name: 'Fiorentina',
      away_team_name: 'Atalanta',
      date: '2026-05-23T16:00:00.000Z',
      home_goals: null,
      away_goals: null,
    },
  ]);

  const rows = await db.getUpcomingMatches({
    competition: 'Serie A',
    season: '2025/2026',
    limit: 2,
    nowIso: '2026-05-23T08:00:00.000Z',
  });

  assert.match(calls[0].sql, /datetime\(date\) >= datetime\(\?\)/);
  assert.match(calls[0].sql, /home_goals IS NULL/);
  assert.match(calls[0].sql, /away_goals IS NULL/);
  assert.equal(calls[0].params[0], '2026-05-23T08:00:00.000Z');
  assert.deepEqual(rows.map((row) => row.match_id), ['future_early', 'future_late']);
});

test('getUpcomingMatches non include match gia completati anche se futuri nella query SQL', async () => {
  const { db } = buildHarness([
    {
      match_id: 'completed_future',
      date: '2026-05-23T16:00:00.000Z',
      home_goals: 1,
      away_goals: 0,
    },
    {
      match_id: 'valid_future',
      date: '2026-05-23T18:00:00.000Z',
      home_goals: null,
      away_goals: null,
    },
  ]);

  const rows = await db.getUpcomingMatches({
    limit: 10,
    nowIso: '2026-05-23T08:00:00.000Z',
  });

  assert.deepEqual(rows.map((row) => row.match_id), ['valid_future']);
});
