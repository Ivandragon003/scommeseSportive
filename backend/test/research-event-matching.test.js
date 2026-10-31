const test = require('node:test');
const assert = require('node:assert/strict');
const { matchingResearchEvent } = require('../dist/research/ResearchRuntime');
const { scoreFixtureCandidate } = require('../dist/services/odds-provider/oddsProviderUtils');

// Names, identifiers and kickoff times from existing 2026-10-31 provider-cache evidence; no odds are invented.
const fixtures = [
  { matchId: 'understat_32307', home: 'Borussia M.Gladbach', away: 'Paderborn',
    providerHome: 'Borussia Monchengladbach', providerAway: 'SC Paderborn',
    eventId: 'odds_aecb9d8c01176616c87d893bee4bc0de', kickoffAt: '2026-10-31T14:30:00Z', capturedAt: '2026-10-31T11:46:21.485Z' },
  { matchId: 'understat_31262', home: 'Hull', away: 'Ipswich', providerHome: 'Hull City', providerAway: 'Ipswich Town',
    eventId: 'odds_1ec76c009147b63859f68c6b5a1dd77b', kickoffAt: '2026-10-31T15:00:00Z', capturedAt: '2026-10-31T11:45:38.890Z' },
  { matchId: 'understat_32304', home: 'Schalke 04', away: 'RasenBallsport Leipzig',
    providerHome: 'FC Schalke 04', providerAway: 'RB Leipzig',
    eventId: 'odds_3966f2fe1c2f73bfa12e61db83bd0bf9', kickoffAt: '2026-10-31T14:30:00Z', capturedAt: '2026-10-31T11:46:21.485Z' },
].map(value => ({ row: Object.freeze({ match_id: value.matchId, home_team_name: value.home,
  away_team_name: value.away, date: new Date(value.kickoffAt).toISOString() }),
event: Object.freeze({ matchId: value.eventId, homeTeam: value.providerHome, awayTeam: value.providerAway,
  commenceTime: value.kickoffAt, source: 'odds', provider: 'odds_api', capturedAt: value.capturedAt,
  bookmakers: Object.freeze([]) }) }));

for (const { row, event } of fixtures) test(`C matches verified provider aliases for ${row.match_id} and preserves the original event`, () => {
  const before = JSON.stringify({ row, event });
  assert.equal(Date.parse(row.date), Date.parse(event.commenceTime));
  assert.equal(matchingResearchEvent(row, [event]), event);
  assert.equal(JSON.stringify({ row, event }), before);
  assert.ok(scoreFixtureCandidate(event, row.home_team_name, row.away_team_name, row.date).straightTeamScore < 1.8,
    'The shared app matcher has not acquired the C-only aliases');
});

test('C preserves ambiguity rejection even when one duplicate already uses Understat names', () => {
  for (const { row, event } of fixtures) {
    const duplicate = { ...event, matchId: `${event.matchId}-synthetic-duplicate`, homeTeam: row.home_team_name, awayTeam: row.away_team_name };
    assert.equal(matchingResearchEvent(row, [event, duplicate]), null);
    assert.equal(matchingResearchEvent(row, [duplicate, event]), null);
  }
});

test('C rejects home/away inversion and returns only the original correctly oriented event', () => {
  for (const { row, event } of fixtures) {
    const inverted = { ...event, matchId: `${event.matchId}-synthetic-inverted`, homeTeam: event.awayTeam, awayTeam: event.homeTeam };
    assert.equal(matchingResearchEvent(row, [inverted]), null);
    assert.equal(matchingResearchEvent(row, [inverted, event]), event);
  }
});

test('C preserves the existing 36-hour matching window and prefers an exact kickoff', () => {
  for (const { row, event } of fixtures) {
    const shifted = hours => ({ ...event, matchId: `${event.matchId}-synthetic-${hours}h`,
      commenceTime: new Date(Date.parse(event.commenceTime) + hours * 3600000).toISOString() });
    const boundary = shifted(36);
    assert.equal(matchingResearchEvent(row, [boundary]), boundary);
    assert.equal(matchingResearchEvent(row, [shifted(36.001)]), null);
    assert.equal(matchingResearchEvent(row, [shifted(-36.001)]), null);
    assert.equal(matchingResearchEvent(row, [boundary, event]), event);
  }
});

test('C does not invent an event or extend its closed aliases to unverified compact names', () => {
  for (const { row } of fixtures) assert.equal(matchingResearchEvent(row, []), null);
  const { row, event } = fixtures[1];
  assert.equal(matchingResearchEvent(row, [{ ...event, homeTeam: 'HullCity', awayTeam: 'IpswichTown' }]), null);
  assert.equal(matchingResearchEvent(row, [{ ...event, homeTeam: 'Synthetic unrelated team', awayTeam: 'Synthetic other team' }]), null);
});
