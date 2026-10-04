const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService } = require('../dist/db/DatabaseService.js');

function snapshot(id, capturedAt, overrides = {}) {
  return {
    snapshot_id: id, match_id: 'match', source: 'odds_api',
    selected_bookmaker_key: 'pinnacle', selected_bookmaker_name: 'Pinnacle',
    live_selected_odds_json: JSON.stringify({ homeWin: 2.2, draw: 3.2 }),
    selected_odds_json: '{}', eurobet_odds_json: '{}', fallback_odds_json: '{}',
    all_bookmaker_odds_json: '{}', markets_requested_json: '[]',
    used_fallback_bookmaker: 0, used_synthetic_odds: 0,
    captured_at: capturedAt, match_date: '2026-01-02T20:00:00Z',
    home_goals: 1, away_goals: 0, ...overrides,
  };
}

async function details(rows) {
  const db = Object.create(DatabaseService.prototype);
  db.all = async () => rows;
  return db.getHistoricalOddsDetailMap();
}

test('historical entry uses latest nonempty real snapshot strictly before kickoff', async () => {
  const result = await details([
    snapshot('after', '2026-01-02T20:01:00Z', { live_selected_odds_json: '{"homeWin":9}' }),
    snapshot('at', '2026-01-02T20:00:00Z', { live_selected_odds_json: '{"homeWin":2.0}' }),
    snapshot('empty', '2026-01-02T19:59:00Z', { live_selected_odds_json: '{}' }),
    snapshot('entry', '2026-01-02T19:58:00Z', { live_selected_odds_json: '{"homeWin":2.1}' }),
    snapshot('earlier', '2026-01-02T18:00:00Z'),
  ]);
  assert.equal(result.match.odds.homeWin, 2.1);
  assert.equal(result.match.capturedAt, '2026-01-02T19:58:00Z');
  assert.equal(result.match.closingOdds.homeWin, 2.0);
  assert.equal(result.match.closingCapturedAt, '2026-01-02T20:00:00Z');
  assert.equal(result.match.closingSource, 'odds_api');
  assert.equal(result.match.closingBookmakerKey, 'pinnacle');
});

test('after-kickoff-only or at-kickoff-only snapshots cannot become entry odds', async () => {
  assert.deepEqual(await details([snapshot('after', '2026-01-02T20:01:00Z')]), {});
  assert.deepEqual(await details([snapshot('at', '2026-01-02T20:00:00Z')]), {});
});

test('invalid snapshot timestamps and unknown kickoff fail closed', async () => {
  const result = await details([
    snapshot('invalid', 'not-a-timestamp'),
    snapshot('normalized-invalid-day', '2026-02-30T12:00:00Z'),
    snapshot('date-only', '2026-01-02'),
    snapshot('real', '2026-01-02T18:00:00Z'),
  ]);
  assert.equal(result.match.capturedAt, '2026-01-02T18:00:00Z');
  for (const invalid of ['', 'invalid', '2026-02-30T20:00:00Z', '2026-01-02']) {
    assert.deepEqual(await details([snapshot('bad-kickoff', '2026-01-02T18:00:00Z', {
      match_date: invalid, commence_time: '2026-01-02T20:00:00Z',
    })]), {});
  }
});

test('SQLite UTC timestamps compare correctly with ISO offsets', async () => {
  const result = await details([
    snapshot('after', '2026-01-02 20:01:00'),
    snapshot('equivalent-earlier', '2026-01-02T20:30:00+01:00'),
    snapshot('entry', '2026-01-02 19:45:00'),
  ]);
  assert.equal(result.match.capturedAt, '2026-01-02 19:45:00');
});

test('closing never mixes bookmakers or conflicting key/name provenance', async () => {
  const result = await details([
    snapshot('eurobet-closing', '2026-01-02T20:00:00Z', {
      source: 'eurobet_scraper', selected_bookmaker_key: 'eurobet', selected_bookmaker_name: 'Eurobet',
      live_selected_odds_json: '{"homeWin":3.0}',
    }),
    snapshot('same-name-different-key', '2026-01-02T20:00:00Z', {
      selected_bookmaker_key: 'pinnacle-other', live_selected_odds_json: '{"homeWin":4.0}',
    }),
    snapshot('same-key-different-name', '2026-01-02T20:00:00Z', {
      selected_bookmaker_name: 'Other Bookmaker', live_selected_odds_json: '{"homeWin":5.0}',
    }),
    snapshot('entry', '2026-01-02T19:58:00Z'),
  ]);
  assert.equal(result.match.selectedBookmakerName, 'Pinnacle');
  assert.equal(result.match.closingOdds.homeWin, 2.2);
  assert.equal(result.match.closingCapturedAt, '2026-01-02T19:58:00Z');
  assert.equal(result.match.closingBookmakerName, 'Pinnacle');
});

test('synthetic fallback unknown and unprovenanced snapshots are excluded as entry and closing', async () => {
  for (const overrides of [
    { source: 'unknown' }, { source: 'unavailable' }, { source: 'model_estimated' },
    { source: 'odds_api_plus_model_completion' }, { used_fallback_bookmaker: 1 },
    { used_synthetic_odds: 1 }, { selected_bookmaker_name: null },
    { source: 'eurobet_scraper', selected_bookmaker_name: 'Pinnacle' },
  ]) {
    assert.deepEqual(await details([snapshot('rejected', '2026-01-02T19:00:00Z', overrides)]), {});
    const result = await details([
      snapshot('rejected-closing', '2026-01-02T20:00:00Z', overrides),
      snapshot('entry', '2026-01-02T19:00:00Z'),
    ]);
    assert.equal(result.match.closingCapturedAt, '2026-01-02T19:00:00Z');
  }
});

test('legacy Eurobet source supplies provenance and real eurobet map without mixing selected estimates', async () => {
  const result = await details([
    snapshot('legacy', '2026-01-02T19:00:00Z', {
      source: 'eurobet_scraper_bulk', selected_bookmaker_key: null, selected_bookmaker_name: null,
      live_selected_odds_json: '{}', eurobet_odds_json: '{"homeWin":2.8}', selected_odds_json: '{"homeWin":6.0}',
    }),
    snapshot('closing', '2026-01-02T20:00:00Z', {
      source: 'odds_api', selected_bookmaker_key: 'eurobet_it', selected_bookmaker_name: 'Eurobet.it',
      live_selected_odds_json: '{"homeWin":2.6}',
    }),
  ]);
  assert.equal(result.match.odds.homeWin, 2.8);
  assert.equal(result.match.oddsSource, 'eurobet_scraper');
  assert.equal(result.match.closingOdds.homeWin, 2.6);
});

test('football-data aggregate opening and closing retain unknown capture timestamps', async () => {
  const db = Object.create(DatabaseService.prototype);
  db.all = async () => [{ match_id: 'csv', fd_odds_json: JSON.stringify({
    opening: {homeWin:2.1}, closing:{homeWin:1.9},
  }) }];
  const result = await db.getFootballDataHistoricalOddsMap();
  assert.equal(result.csv.odds.homeWin, 2.1);
  assert.equal(result.csv.closingOdds.homeWin, 1.9);
  assert.equal(result.csv.snapshotSource, 'football_data');
  assert.equal(result.csv.capturedAt, null);
  assert.equal(result.csv.closingCapturedAt, null);
});
