'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { FOOTBALL_DATA_COMPETITIONS, resolveFootballDataCalendar, fetchFootballDataCalendar } = require('../dist/services/modelAResearchCalendar');

function example(competition = 'PL') {
  const matches = [];
  for (const home of [1, 2, 3]) for (const away of [1, 2, 3]) if (home !== away) {
    matches.push({ id: home * 10 + away, utcDate: '2026-11-06T14:30:00Z', status: 'TIMED', lastUpdated: '2026-11-01T10:00:00Z', homeTeam: { id: home }, awayTeam: { id: away } });
  }
  return { payload: { competition: { id: FOOTBALL_DATA_COMPETITIONS[competition] }, season: { startDate: '2026-08-01' }, matches }, competition, season: 2026, acquiredAt: '2026-11-05T10:00:00Z', expectedTeamCount: 3, teamMapping: { 1: 'a', 2: 'b', 3: 'c' }, localMatches: matches.map(m => ({ id: `understat_${m.id}`, source: 'understat', sourceMatchId: m.id, homeTeamId: ['','a','b','c'][m.homeTeam.id], awayTeamId: ['','a','b','c'][m.awayTeam.id] })) };
}

test('all five competition IDs resolve ordered teams and preserve UTC and status provenance', () => {
  for (const code of Object.keys(FOOTBALL_DATA_COMPETITIONS)) {
    const x = example(code);
    x.payload.matches[0].utcDate = '2026-11-06T15:30:00+01:00';
    x.payload.matches[1].status = 'SCHEDULED';
    x.payload.matches[2].status = 'POSTPONED';
    x.payload.matches[3].status = 'CANCELLED';
    const result = resolveFootballDataCalendar(x);
    assert.equal(result.coverage.calendarComplete, true);
    assert.equal(result.coverage.mappingComplete, true);
    assert.equal(result.fixtures[0].kickoffUtc, '2026-11-06T14:30:00.000Z');
    assert.equal(result.fixtures[0].providerPublishedAt, null);
    assert.equal(result.fixtures[0].providerRevisionAt, '2026-11-01T10:00:00.000Z');
    assert.deepEqual(result.fixtures.slice(1, 4).map(x => x.status), ['SCHEDULED', 'POSTPONED', 'CANCELLED']);
  }
});

test('truncation, duplicate IDs and ordered pairs, ambiguous and unmapped local teams fail coverage', () => {
  const short = example(); short.payload.matches.pop();
  assert.equal(resolveFootballDataCalendar(short).coverage.calendarComplete, false);
  const duplicate = example(); duplicate.payload.matches[1] = { ...duplicate.payload.matches[0] };
  assert.deepEqual(resolveFootballDataCalendar(duplicate).coverage.errors.slice(0, 2), ['duplicate_provider_match_id', 'duplicate_ordered_pair']);
  const ambiguous = example(); ambiguous.localMatches.push({ ...ambiguous.localMatches[0], id: 'understat_999', sourceMatchId: 999 });
  const a = resolveFootballDataCalendar(ambiguous);
  assert.equal(a.fixtures[0].issue, 'ambiguous_local_match'); assert.equal(a.coverage.mappingComplete, false);
  const unmapped = example(); delete unmapped.teamMapping[1];
  assert.equal(resolveFootballDataCalendar(unmapped).coverage.unmappedFixtures, 4);
  const collision = example(); collision.teamMapping[2] = 'a';
  assert.equal(resolveFootballDataCalendar(collision).coverage.mappingComplete, false);
});

test('rejects incompatible competition/season and invalid kickoff; does not trust provider ID alone', () => {
  const wrong = example(); wrong.payload.competition.id = 2019;
  assert.throws(() => resolveFootballDataCalendar(wrong), /calendar_invalid_payload/);
  const malformed = example(); malformed.payload.matches[0].utcDate = '2026-02-30T00:00:00Z';
  assert.equal(resolveFootballDataCalendar(malformed).fixtures[0].issue, 'invalid_kickoff');
  const overlap = example(); overlap.localMatches[0].id = 'understat_998'; overlap.localMatches[0].sourceMatchId = 998;
  assert.equal(resolveFootballDataCalendar(overlap).fixtures[0].localMatchId, 'understat_998');
  assert.equal(resolveFootballDataCalendar(overlap).fixtures[1].localMatchId, 'understat_13');
});

test('HTTP errors and network errors are redacted, no retries or redirects', async () => {
  const original = https.get;
  try {
    for (const status of [401, 429, 302]) {
      let calls = 0;
      https.get = (options, callback) => {
        calls++;
        assert.equal(options.hostname, 'api.football-data.org');
        assert.equal(options.path, '/v4/competitions/PL/matches?season=2026');
        const request = new EventEmitter(); request.destroy = () => {};
        process.nextTick(() => { const response = new EventEmitter(); response.statusCode = status; response.destroy = () => {}; callback(response); });
        return request;
      };
      await assert.rejects(fetchFootballDataCalendar({ competition: 'PL', season: 2026, apiKey: 'secret-token' }), error => error.message === `calendar_http_${status}` && !error.message.includes('secret-token'));
      assert.equal(calls, 1);
    }
    https.get = () => { const request = new EventEmitter(); request.destroy = () => {}; process.nextTick(() => request.emit('error', new Error('secret-token'))); return request; };
    await assert.rejects(fetchFootballDataCalendar({ competition: 'PL', season: 2026, apiKey: 'secret-token' }), error => error.message === 'calendar_network_error');
  } finally { https.get = original; }
});

test('oversized responses and aborted transfers fail closed without exposing token', async () => {
  const original = https.get;
  try {
    for (const mode of ['large', 'aborted']) {
      https.get = (_options, callback) => {
        const request = new EventEmitter(); request.destroy = () => {};
        process.nextTick(() => {
          const response = new EventEmitter(); response.statusCode = 200; response.resume = () => {};
          callback(response);
          if (mode === 'large') response.emit('data', Buffer.alloc(4 * 1024 * 1024 + 1));
          else response.emit('aborted');
        });
        return request;
      };
      await assert.rejects(fetchFootballDataCalendar({ competition: 'PL', season: 2026, apiKey: 'secret-token' }), error =>
        error.message === (mode === 'large' ? 'calendar_response_too_large' : 'calendar_network_error'));
    }
  } finally { https.get = original; }
});

test('future revisions, nested scope conflicts, and unverified local identity are excluded', () => {
  for (const change of [
    x => { x.payload.matches[0].lastUpdated = '2026-11-05T11:00:00Z'; },
    x => { x.payload.matches[0].competition = { id: 2019 }; },
    x => { x.payload.matches[0].season = { startDate: '2025-08-01' }; },
    x => { x.localMatches[0].source = 'manual'; },
    x => { x.localMatches[0].sourceMatchId = 999; },
    x => { x.localMatches[0].homeTeamId = ''; },
  ]) {
    const x = example(); change(x);
    const result = resolveFootballDataCalendar(x);
    assert.equal(result.coverage.mappingComplete, false);
    assert.equal(result.fixtures[0].localMatchId, null);
  }
});


test('realistic v4 filtered response validates season on every match', () => {
  const x = example();
  x.payload.filters = { season: 2026 };
  delete x.payload.season;
  for (const match of x.payload.matches) {
    match.competition = { id: 2021, code: 'PL' };
    match.season = { id: 2502, startDate: '2026-08-21', endDate: '2027-05-30' };
  }
  assert.equal(resolveFootballDataCalendar(x).coverage.mappingComplete, true);
  const incorrectFilter = structuredClone(x); incorrectFilter.payload.filters.season = 2025;
  assert.throws(() => resolveFootballDataCalendar(incorrectFilter), /calendar_invalid_payload/);
  for (const change of [
    y => { y.payload.matches[0].season.startDate = '2025-08-21'; },
    y => { y.payload.matches[0].season.id = 100; },
    y => { delete y.payload.matches[0].season; },
    y => { y.payload.matches[0].competition.id = 2019; },
    y => { delete y.payload.matches[0].competition; },
  ]) {
    const changed = structuredClone(x); change(changed);
    assert.equal(resolveFootballDataCalendar(changed).coverage.mappingComplete, false);
  }
  const noScope = structuredClone(x); delete noScope.payload.filters; noScope.payload.matches.forEach(m => { delete m.season; });
  assert.throws(() => resolveFootballDataCalendar(noScope), /calendar_invalid_payload/);
});
