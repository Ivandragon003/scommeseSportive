const test = require('node:test');
const assert = require('node:assert/strict');
const { OddsApiKickoffSyncService } = require('../dist/services/OddsApiKickoffSyncService.js');

const buildDbMatch = (overrides = {}) => ({
  match_id: overrides.match_id ?? 'match_bologna_inter',
  home_team_name: overrides.home_team_name ?? 'Bologna',
  away_team_name: overrides.away_team_name ?? 'Inter',
  date: overrides.date ?? '2026-05-24T13:00:00.000Z',
  competition: overrides.competition ?? 'Serie A',
});

const buildOddsMatch = (overrides = {}) => ({
  matchId: overrides.matchId ?? 'odds_bologna_inter',
  homeTeam: overrides.homeTeam ?? 'Bologna',
  awayTeam: overrides.awayTeam ?? 'Internazionale',
  commenceTime: overrides.commenceTime ?? '2026-05-23T16:00:00.000Z',
  bookmakers: [],
});

const createHarness = ({ dbMatches, providerMatches }) => {
  const updates = [];
  const db = {
    async getUpcomingMatches() {
      return dbMatches;
    },
    async updateMatchKickoff(matchId, kickoffIso) {
      updates.push({ matchId, kickoffIso });
    },
  };
  const oddsApi = {
    async getOdds() {
      return providerMatches;
    },
  };
  return {
    updates,
    service: new OddsApiKickoffSyncService(db, oddsApi),
  };
};

test('OddsApiKickoffSyncService corregge Bologna-Inter se Odds API espone kickoff canonico', async () => {
  const { service, updates } = createHarness({
    dbMatches: [buildDbMatch()],
    providerMatches: [buildOddsMatch()],
  });

  const result = await service.syncUpcomingKickoffsFromOddsApi({ competition: 'Serie A' });

  assert.equal(result.checked, 1);
  assert.equal(result.providerEvents, 1);
  assert.equal(result.corrected, 1);
  assert.deepEqual(updates, [{ matchId: 'match_bologna_inter', kickoffIso: '2026-05-23T16:00:00.000Z' }]);
  assert.equal(result.corrections[0].oldDate, '2026-05-24T13:00:00.000Z');
  assert.equal(result.corrections[0].newDate, '2026-05-23T16:00:00.000Z');
});

test('OddsApiKickoffSyncService non corregge un match ambiguo', async () => {
  const { service, updates } = createHarness({
    dbMatches: [buildDbMatch()],
    providerMatches: [
      buildOddsMatch({ matchId: 'odds_1', commenceTime: '2026-05-23T16:00:00.000Z' }),
      buildOddsMatch({ matchId: 'odds_2', commenceTime: '2026-05-23T16:30:00.000Z' }),
    ],
  });

  const result = await service.syncUpcomingKickoffsFromOddsApi({ competition: 'Serie A' });

  assert.equal(result.corrected, 0);
  assert.equal(result.skippedAmbiguous, 1);
  assert.equal(updates.length, 0);
});

test('OddsApiKickoffSyncService non aggiorna se la differenza e sotto cinque minuti', async () => {
  const { service, updates } = createHarness({
    dbMatches: [buildDbMatch({ date: '2026-05-23T16:00:00.000Z' })],
    providerMatches: [buildOddsMatch({ commenceTime: '2026-05-23T16:03:00.000Z' })],
  });

  const result = await service.syncUpcomingKickoffsFromOddsApi({ competition: 'Serie A' });

  assert.equal(result.corrected, 0);
  assert.equal(result.skippedSmallDiff, 1);
  assert.equal(updates.length, 0);
});

test('OddsApiKickoffSyncService non corregge home-away invertite', async () => {
  const { service, updates } = createHarness({
    dbMatches: [buildDbMatch()],
    providerMatches: [buildOddsMatch({ homeTeam: 'Inter', awayTeam: 'Bologna' })],
  });

  const result = await service.syncUpcomingKickoffsFromOddsApi({ competition: 'Serie A' });

  assert.equal(result.corrected, 0);
  assert.equal(result.skippedInverted, 1);
  assert.equal(updates.length, 0);
});
