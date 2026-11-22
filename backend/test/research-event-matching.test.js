const test = require('node:test');
const assert = require('node:assert/strict');
const { matchingResearchEvent } = require('../dist/research/ResearchRuntime');
const { scoreFixtureCandidate } = require('../dist/services/odds-provider/oddsProviderUtils');
const { AppPredictionOddsService } = require('../dist/services/AppPredictionOddsService');
const { loadResearchFixtureOdds, researchProviderTeamNames } = require('../dist/research/ResearchFixtureOdds');
const { OddsApiService } = require('../dist/services/OddsApiService');

const sharedAliases = [
  { competition: 'La Liga', home: 'Racing Santander', away: 'Real Sociedad', providerHome: 'Real Racing Club de Santander',
    providerAway: 'Real Sociedad', kickoff: '2026-11-22T15:15:00Z', eventId: 'odds_9718f9ea901236855faf57f77a0bd5b3' },
  { competition: 'Premier League', home: 'Hull', away: 'Brighton', providerHome: 'Hull City',
    providerAway: 'Brighton and Hove Albion', kickoff: '2026-11-22T14:00:00Z', eventId: 'odds_230a356290e1a358e9dd2f7fa23de3b9' },
];

for (const entry of sharedAliases) test(`A and C identify the same verified event for ${entry.home}–${entry.away}`, async () => {
  const row = Object.freeze({ competition: entry.competition, home_team_name: entry.home, away_team_name: entry.away, date: entry.kickoff });
  const now = '2026-11-22T10:00:00Z';
  const event = { matchId: entry.eventId, homeTeam: entry.providerHome, awayTeam: entry.providerAway,
    commenceTime: row.date, provider: 'odds_api', capturedAt: now, bookmakers: [{
      bookmakerKey: 'test', bookmakerName: 'Test Book', markets: [{ marketKey: 'h2h', updatedAt: now,
        outcomes: [{ name: entry.providerHome, price: 2.2 }, { name: 'Draw', price: 3 }, { name: entry.providerAway, price: 3.5 }] }]
    }] };
  const duplicate = { ...event, matchId: 'synthetic-duplicate', homeTeam: row.home_team_name, awayTeam: row.away_team_name };
  const inverted = { ...event, homeTeam: event.awayTeam, awayTeam: event.homeTeam };
  assert.equal(matchingResearchEvent(row, [event, duplicate]), null);
  assert.equal(matchingResearchEvent(row, [inverted]), null);
  const primary = matchingResearchEvent(row, [event]);
  assert.equal(primary, event);
  const mapper = new OddsApiService('unit-test-no-network');
  const provider = { getOddsForFixtures: async () => ({ matches: [primary], warnings: [] }),
    compareBookmakers: match => mapper.compareBookmakers(match) };
  const service = new AppPredictionOddsService({}, { provider, clock: () => new Date(now) });
  const snapshot = { providerEventId: primary.matchId, providerKickoffAt: primary.commenceTime,
    providerTeamNames: researchProviderTeamNames(entry.home, entry.away, primary.homeTeam, primary.awayTeam) };
  const selected = await loadResearchFixtureOdds(service, row, snapshot);
  assert.equal(selected.metadata.providerEventId, primary.matchId);
  assert.ok(selected.quotes.some(q => q.bookmaker === 'Test Book' && q.odds === 3.5));
  await assert.rejects(loadResearchFixtureOdds(service, row, { ...snapshot, providerEventId: 'different' }), /event_mismatch/);
  assert.equal(researchProviderTeamNames(entry.home, entry.away, 'Unknown Home', 'Unknown Away'), undefined);
});

// Team names and kickoff times from saved provider responses; the November fixture reproduces the reported UI failure.
const fixtures = [
  { matchId: 'understat_31651', home: 'Atalanta', away: 'Parma Calcio 1913',
    providerHome: 'Atalanta BC', providerAway: 'Parma', eventId: 'test-provider-atalanta-parma',
    kickoffAt: '2026-11-02T19:45:00Z', capturedAt: '2026-11-02T18:16:34.028Z' },
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
