const test = require('node:test');
const assert = require('node:assert/strict');
const { understatCommitState } = require('../dist/services/UnderstatCommitState.js');

test('only committed chunks prove coverage and contribute affected teams; zero goals are played', () => {
  const pending = [
    { matchId: 'changed', homeTeamId: 'home', awayTeamId: 'away', homeGoals: 0, awayGoals: 0 },
    { matchId: 'fixture', homeTeamId: 'other', awayTeamId: 'future', homeGoals: null, awayGoals: null },
    { matchId: 'failed', homeTeamId: 'failed-team', awayTeamId: 'away', homeGoals: 1, awayGoals: 0 },
  ];
  const state = understatCommitState(['existing'], pending, 2);
  assert.deepEqual([...state.persistedIds], ['existing', 'changed', 'fixture']);
  assert.deepEqual([...state.affectedTeamIds], ['home', 'away']);
  assert.equal(state.persistedIds.has('failed'), false);
});

test('unchanged season reuses existing IDs without scheduling aggregate work', () => {
  const state = understatCommitState(['historical-a', 'historical-b'], [], 0);
  assert.equal(state.persistedIds.size, 2);
  assert.equal(state.affectedTeamIds.size, 0);
});
