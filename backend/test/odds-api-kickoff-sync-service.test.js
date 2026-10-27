const test = require('node:test');
const assert = require('node:assert/strict');
const { OddsApiKickoffSyncService } = require('../dist/services/OddsApiKickoffSyncService.js');

const buildDbMatch = (overrides = {}) => ({
  match_id: overrides.match_id ?? 'match_bologna_inter',
  home_team_name: overrides.home_team_name ?? 'Bologna',
  away_team_name: overrides.away_team_name ?? 'Inter',
  date: overrides.date ?? '2026-05-24T13:00:00.000Z',
  competition: overrides.competition ?? 'Serie A',
  home_goals: overrides.home_goals ?? null,
  away_goals: overrides.away_goals ?? null,
});

const buildOddsMatch = (overrides = {}) => ({
  matchId: overrides.matchId ?? 'odds_bologna_inter',
  homeTeam: overrides.homeTeam ?? 'Bologna',
  awayTeam: overrides.awayTeam ?? 'Internazionale',
  commenceTime: overrides.commenceTime ?? '2026-05-23T16:00:00.000Z',
  bookmakers: [],
});

const createHarness = ({ dbMatches, providerMatches, providerScores }) => {
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
    async getScores() {
      return providerScores ?? [];
    },
  };
  return {
    updates,
    service: new OddsApiKickoffSyncService(db, oddsApi),
  };
};

test('calendar sync uses the free events endpoint exclusively when available', async () => {
  const updates = [], calls = [];
  const service = new OddsApiKickoffSyncService({
    getUpcomingMatches: async () => [buildDbMatch()],
    updateMatchKickoff: async (...args) => updates.push(args),
  }, {
    getEvents: async (competition) => { calls.push(competition); return [buildOddsMatch()]; },
    getOdds: async () => { throw new Error('paid odds must not run'); },
    getScores: async () => { throw new Error('paid scores must not run'); },
  });
  assert.equal((await service.syncUpcomingKickoffsFromOddsApi({ competition: 'Serie A' })).corrected, 1);
  assert.deepEqual(calls, ['Serie A']);
  assert.equal(updates.length, 1);
});

test('free calendar failure cannot silently fall back to credit-consuming odds or scores', async () => {
  const service = new OddsApiKickoffSyncService({ getUpcomingMatches: async () => [buildDbMatch()], updateMatchKickoff: async () => {} }, {
    getEvents: async () => { throw new Error('provider unavailable'); },
    getOdds: async () => assert.fail('paid odds fallback'), getScores: async () => assert.fail('paid scores fallback'),
  });
  await assert.rejects(service.syncUpcomingKickoffsFromOddsApi({ competition: 'Serie A' }), /odds_calendar_events_unavailable/);
});

test('the production calendar client uses shared persistent zero-credit requests', async (t) => {
  const previousKey = process.env.ODDS_API_KEY; process.env.ODDS_API_KEY = 'unit-test-only';
  t.after(() => { if (previousKey === undefined) delete process.env.ODDS_API_KEY; else process.env.ODDS_API_KEY = previousKey; });
  const requests = [];
  const service = new OddsApiKickoffSyncService({ getUpcomingMatches: async () => [buildDbMatch()], updateMatchKickoff: async () => {},
    oddsRequests: { execute: async (request) => {
      requests.push(request);
      return { cacheHit: true, fetchedAt: '2026-05-23T12:00:00Z', headers: {}, data: [{ id: 'id', home_team: 'Bologna',
        away_team: 'Internazionale', commence_time: '2026-05-23T16:00:00Z' }] };
    } },
  });
  assert.equal((await service.syncUpcomingKickoffsFromOddsApi({ competition: 'Serie A' })).corrected, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].operation, 'calendar');
  assert.equal(requests[0].priority, 'essential');
  assert.equal(requests[0].expectedCredits, 0);
  assert.equal(requests[0].cacheMaxAgeMs, 1800000);
  assert.match(requests[0].endpoint, /\/events$/);
});

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

test('OddsApiKickoffSyncService corregge anche se la data DB e fuori dalla finestra 36h', async () => {
  const { service, updates } = createHarness({
    dbMatches: [buildDbMatch({ date: '2026-04-20T13:00:00.000Z' })],
    providerMatches: [buildOddsMatch({ commenceTime: '2026-05-23T16:00:00.000Z' })],
  });

  const result = await service.syncUpcomingKickoffsFromOddsApi({ competition: 'Serie A' });

  assert.equal(result.corrected, 1);
  assert.deepEqual(updates, [{ matchId: 'match_bologna_inter', kickoffIso: '2026-05-23T16:00:00.000Z' }]);
  assert.ok(result.warnings.some((warning) => warning.includes('kickoff_outside_36h_window_corrected')));
});

test('OddsApiKickoffSyncService usa scores se odds non contiene una partita gia iniziata o conclusa', async () => {
  const { service, updates } = createHarness({
    dbMatches: [buildDbMatch({ date: '2026-05-24T13:00:00.000Z' })],
    providerMatches: [],
    providerScores: [
      buildOddsMatch({
        matchId: 'scores_bologna_inter',
        commenceTime: '2026-05-23T16:00:00.000Z',
      }),
    ],
  });

  const result = await service.syncUpcomingKickoffsFromOddsApi({ competition: 'Serie A' });

  assert.equal(result.providerEvents, 1);
  assert.equal(result.corrected, 1);
  assert.deepEqual(updates, [{ matchId: 'match_bologna_inter', kickoffIso: '2026-05-23T16:00:00.000Z' }]);
  assert.equal(result.corrections[0].providerMatchId, 'scores_bologna_inter');
});

test('getUpcomingMatches non mostrerebbe piu una partita corretta a kickoff gia passato', async () => {
  const { DatabaseService } = require('../dist/db/DatabaseService.js');
  const db = Object.create(DatabaseService.prototype);
  db.all = async () => [
    buildDbMatch({ date: '2026-05-23T16:00:00.000Z' }),
  ];

  const rows = await db.getUpcomingMatches({
    nowIso: '2026-05-23T16:05:01.000Z',
    limit: 10,
  });

  assert.deepEqual(rows, []);
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
