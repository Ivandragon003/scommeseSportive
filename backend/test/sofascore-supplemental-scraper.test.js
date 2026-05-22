const test = require('node:test');
const assert = require('node:assert/strict');
const { SofaScoreSupplementalScraper } = require('../dist/services/SofaScoreSupplementalScraper.js');

const buildRow = (overrides = {}) => ({
  match_id: overrides.match_id ?? 'match_1',
  home_team_id: overrides.home_team_id ?? 'fiorentina',
  away_team_id: overrides.away_team_id ?? 'atalanta',
  home_team_name: overrides.home_team_name ?? 'Fiorentina',
  away_team_name: overrides.away_team_name ?? 'Atalanta',
  date: overrides.date ?? '2026-05-23T13:00:00.000Z',
  home_goals: null,
  away_goals: null,
  referee: null,
  competition: overrides.competition ?? 'Serie A',
  season: '2025/2026',
});

const createScraperWithEvents = (eventsByDate) => {
  const scraper = new SofaScoreSupplementalScraper();
  scraper.getScheduledEvents = async (dateIso) => {
    const key = String(dateIso).slice(0, 10);
    return eventsByDate[key] ?? [];
  };
  scraper.fetchJson = async (path) => {
    if (/\/api\/v1\/event\/\d+$/.test(path)) {
      return { event: { referee: null } };
    }
    return { statistics: [] };
  };
  return scraper;
};

const buildEvent = (overrides = {}) => ({
  id: overrides.id ?? 100,
  startTimestamp: Math.floor(new Date(overrides.kickoff ?? '2026-05-22T18:45:00.000Z').getTime() / 1000),
  competition: overrides.competition ?? 'Serie A',
  homeTeamName: overrides.homeTeamName ?? 'Fiorentina',
  awayTeamName: overrides.awayTeamName ?? 'Atalanta',
});

test('SofaScore corregge una partita con data salvata sul giorno successivo usando startTimestamp canonico', async () => {
  const scraper = createScraperWithEvents({
    '2026-05-22': [buildEvent({ id: 101, kickoff: '2026-05-22T18:45:00.000Z' })],
  });
  const upserts = [];

  const summary = await scraper.applyToDatabase({
    upsertMatch: async (match) => {
      upserts.push(match);
    },
    upsertReferee: async () => undefined,
  }, [buildRow()]);

  assert.equal(summary.correctedKickoffs, 1);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].date, '2026-05-22T18:45:00.000Z');
});

test('SofaScore non corregge kickoff quando lo stesso match non e univoco nella finestra di ricerca', async () => {
  const scraper = createScraperWithEvents({
    '2026-05-22': [buildEvent({ id: 201, kickoff: '2026-05-22T18:45:00.000Z' })],
    '2026-05-23': [buildEvent({ id: 202, kickoff: '2026-05-23T13:00:00.000Z' })],
  });
  const upserts = [];

  const summary = await scraper.applyToDatabase({
    upsertMatch: async (match) => {
      upserts.push(match);
    },
    upsertReferee: async () => undefined,
  }, [buildRow()]);

  assert.equal(summary.correctedKickoffs, 0);
  assert.equal(summary.skippedNoEvent, 1);
  assert.equal(upserts.length, 0);
});

test('SofaScore non aggiorna il match se il kickoff canonico differisce meno di cinque minuti', async () => {
  const row = buildRow({ date: '2026-05-22T18:45:00.000Z' });
  const scraper = createScraperWithEvents({
    '2026-05-22': [buildEvent({ id: 301, kickoff: '2026-05-22T18:48:00.000Z' })],
  });
  const upserts = [];

  const summary = await scraper.applyToDatabase({
    upsertMatch: async (match) => {
      upserts.push(match);
    },
    upsertReferee: async () => undefined,
  }, [row]);

  assert.equal(summary.correctedKickoffs, 0);
  assert.equal(summary.skippedNoStats, 1);
  assert.equal(upserts.length, 0);
});
