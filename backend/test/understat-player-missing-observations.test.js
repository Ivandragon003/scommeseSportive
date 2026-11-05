const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUnderstatSeasonPlayerWrites } = require('../dist/api/routes');

const player = (id, fields = {}) => ({
  playerId: id, sourcePlayerId: 1, playerName: id, teamId: 'home', positionCode: 'MF', minutes: 90,
  shots: 0, shotsOnTarget: 0, goals: 0, xg: 0, xgot: 0,
  raw: { yellow_card: '0', red_card: '0' }, ...fields,
});
const match = (id, players, totalShots) => ({
  matchId: id, homeTeamId: 'home', awayTeamId: 'away', homeTotalShots: totalShots,
  awayTotalShots: null, playerStats: players,
});
const aggregate = (matches) => buildUnderstatSeasonPlayerWrites(matches, '2026-2027', 'Serie A');
const coverage = (row) => JSON.parse(row.statsJson).coverage;

test('a measured zero is kept with one observation per field', () => {
  const [row] = aggregate([match('zero', [player('p')], 0)]);
  for (const field of ['avgShotsPerGame', 'avgShotsOnTargetPerGame', 'avgXGPerGame', 'avgXGOTPerGame',
    'totalGoals', 'totalShots', 'totalShotsOnTarget', 'yellowCardsTotal', 'redCardsTotal', 'shotShareOfTeam']) {
    assert.equal(row[field], 0, field);
  }
  assert.deepEqual(coverage(row), { shots: 1, shotsOnTarget: 1, goals: 1, xg: 1, xgot: 1, yellowCards: 1, redCards: 1, shotShare: 1 });
});

test('missing fields use independent denominators without losing valid roster rows', () => {
  const [row] = aggregate([
    match('observed', [player('p', { shots: 4, shotsOnTarget: null, goals: 1, xg: 0.5, xgot: null, raw: { yellow_card: '1' } })], 4),
    match('partial', [player('p', { shots: null, shotsOnTarget: 0, goals: null, xg: null, xgot: 0, raw: { yellow_card: '', red_card: null } })], null),
  ]);
  assert.equal(row.gamesPlayed, 2);
  assert.equal(row.avgShotsPerGame, 4);
  assert.equal(row.totalShots, 4);
  assert.equal(row.avgShotsOnTargetPerGame, 0);
  assert.equal(row.avgXGPerGame, 0.5);
  assert.equal(row.avgXGOTPerGame, 0);
  assert.equal(row.totalGoals, 1);
  assert.equal(row.yellowCardsTotal, 1);
  assert.equal(row.redCardsTotal, null);
  assert.equal(row.shotShareOfTeam, null);
  assert.deepEqual(coverage(row), { shots: 1, shotsOnTarget: 1, goals: 1, xg: 1, xgot: 1, yellowCards: 1, redCards: 0, shotShare: 0 });
});

test('an entirely unobserved field remains null, including invalid card tokens', () => {
  const [row] = aggregate([match('missing', [player('p', {
    shots: null, shotsOnTarget: null, goals: null, xg: null, xgot: null, raw: { yellow_card: false, red_card: '-1' },
  })], null)]);
  assert.equal(row.gamesPlayed, 1);
  for (const field of ['avgShotsPerGame', 'avgShotsOnTargetPerGame', 'avgXGPerGame', 'avgXGOTPerGame',
    'totalGoals', 'totalShots', 'totalShotsOnTarget', 'yellowCardsTotal', 'redCardsTotal', 'shotShareOfTeam']) {
    assert.equal(row[field], null, field);
  }
  assert.equal(JSON.parse(row.statsJson).totalXG, null);
  assert.equal(JSON.parse(row.statsJson).totalXGOT, null);
});

test('partial team evidence never creates a share from only known roster shots', () => {
  const rows = aggregate([match('partial-team', [player('p', { shots: 2 }), player('other', { shots: null })], null)]);
  const row = rows.find((item) => item.playerId === 'p');
  assert.equal(row.avgShotsPerGame, 2);
  assert.equal(row.shotShareOfTeam, null);
  assert.equal(coverage(row).shotShare, 0);
});

test('complete observations preserve the original season-team share and averages', () => {
  const rows = aggregate([
    match('first', [player('p', { shots: 2, shotsOnTarget: 1 }), player('other', { shots: 3 })], 5),
    match('second', [player('other', { shots: 5 })], 5),
  ]);
  const row = rows.find((item) => item.playerId === 'p');
  assert.equal(row.avgShotsPerGame, 2);
  assert.equal(row.avgShotsOnTargetPerGame, 1);
  assert.equal(row.shotShareOfTeam, 2 / 10);
  assert.equal(coverage(row).shots, 1);
  assert.equal(coverage(row).shotShare, 1);
});

test('yellow-card minute metadata pairs only observed cards and positive observed minutes', () => {
  const [row] = aggregate([
    match('eligible', [player('p', { minutes: 60, raw: { yellow_card: 1 } })], 0),
    match('no-cards', [player('p', { minutes: 90, raw: {} })], 0),
    match('no-minutes', [player('p', { minutes: null, raw: { yellow_card: 2 } })], 0),
    match('zero-minutes', [player('p', { minutes: 0, raw: { yellow_card: 0 } })], 0),
  ]);
  const metadata = JSON.parse(row.statsJson);
  assert.equal(row.yellowCardsTotal, 3);
  assert.equal(metadata.coverage.yellowCards, 3);
  assert.deepEqual(metadata.observedMinutes, { yellowCards: 60 });
  assert.deepEqual(metadata.observedTotals, { yellowCards: 1 });
});
