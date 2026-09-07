const test = require('node:test');
const assert = require('node:assert/strict');
const { mapApiFootballFixture, ApiFootballService } = require('../dist/services/ApiFootballService.js');

test('API-Football fixture mapping keeps the assigned referee', () => {
  const fixture = mapApiFootballFixture({
    fixture: { id: 42, date: '2026-08-25T20:00:00Z', referee: 'Marco Rossi, Italy' },
    teams: { home: { id: 1, name: 'Home' }, away: { id: 2, name: 'Away' } },
  });
  assert.equal(fixture.referee, 'Marco Rossi');
});

test('account suspended blocks all endpoints and instances until expiry, without blocking a new key', async () => {
  const oldFetch = global.fetch;
  const oldNow = Date.now;
  const previous = { key: process.env.API_FOOTBALL_KEY, enabled: process.env.API_FOOTBALL_ENABLED };
  let now = oldNow();
  let calls = 0;
  try {
    Date.now = () => now;
    process.env.API_FOOTBALL_ENABLED = 'true';
    process.env.API_FOOTBALL_KEY = 'suspended-test-account';
    global.fetch = async () => {
      calls++;
      return new Response(JSON.stringify(calls === 1
        ? { errors: { account: 'Your account is suspended' }, response: [] }
        : { errors: {}, response: [] }), { status: 200 });
    };
    const first = new ApiFootballService();
    await assert.rejects(first.getFixturesByDate('2026-09-07'), /suspended/);
    await assert.rejects(new ApiFootballService().getConfirmedLineups(10), /retry paused/);
    await assert.rejects(first.getSquad(1), /retry paused/);
    assert.equal(calls, 1);
    process.env.API_FOOTBALL_KEY = 'new-working-test-account';
    await new ApiFootballService().getFixturesByDate('2026-09-07');
    assert.equal(calls, 2);
    now += 3601 * 1000;
    await first.getFixturesByDate('2026-09-07');
    assert.equal(calls, 3);
  } finally {
    global.fetch = oldFetch;
    Date.now = oldNow;
    if (previous.key === undefined) delete process.env.API_FOOTBALL_KEY;
    else process.env.API_FOOTBALL_KEY = previous.key;
    if (previous.enabled === undefined) delete process.env.API_FOOTBALL_ENABLED;
    else process.env.API_FOOTBALL_ENABLED = previous.enabled;
  }
});
