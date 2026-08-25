const test = require('node:test');
const assert = require('node:assert/strict');
const { mapApiFootballFixture } = require('../dist/services/ApiFootballService.js');

test('API-Football fixture mapping keeps the assigned referee', () => {
  const fixture = mapApiFootballFixture({
    fixture: { id: 42, date: '2026-08-25T20:00:00Z', referee: 'Marco Rossi, Italy' },
    teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
  });
  assert.equal(fixture.referee, 'Marco Rossi');
});
