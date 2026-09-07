const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createFootballDataHistoryStore, loadFootballDataCsv } = require('../dist/services/FootballDataHistoryCache');
const { syncFootballData, syncTransitionSeasonReferences, parseFootballDataCsv } = require('../dist/services/FootballDataService');

const now = new Date('2026-09-07T12:00:00Z');
const seasonCsv = (year = 2024) => ['Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HF,AF',
  ...Array.from({ length: 20 }, (_, home) => Array.from({ length: 20 }, (_, away) =>
    home === away ? null : `I1,01/05/${year + 1},Team${home},Team${away},1,0,10,11`).filter(Boolean)).flat(),
].join('\n');
const memoryStore = () => {
  const entries = new Map();
  return { entries, get: async (league, year) => entries.get(`${league}:${year}`) ?? null,
    put: async (league, year, entry) => { entries.set(`${league}:${year}`, entry); } };
};

test('historical cache replaces HTTP but still repairs fields and rejects missing DB matches', async () => {
  const csv = seasonCsv();
  let matches = parseFootballDataCsv(csv).map((row, i) => ({ match_id: String(i), date: row.date, home_team_name: row.homeTeam, away_team_name: row.awayTeam }));
  const fields = new Set();
  const db = { getMatchesForCompetition: async () => matches,
    fillSupplementalStats: async (id) => { const missing = !fields.has(id); fields.add(id); return missing; },
    saveMarketOdds: async () => false };
  const historyStore = memoryStore();
  let downloads = 0;
  const options = { competitions: ['Serie A'], seasonStartYears: [2024], now, historyStore,
    fetcher: async () => { downloads++; return csv; } };
  assert.equal((await syncFootballData(db, options)).completed, 1);
  assert.equal(historyStore.entries.size, 1);
  fields.delete('0');
  const repaired = await syncFootballData(db, options);
  assert.equal(repaired.reusedHistorical, 1);
  assert.equal(repaired.updated, 1);
  assert.equal(downloads, 1);
  matches = matches.slice(1);
  const incomplete = await syncFootballData(db, options);
  assert.equal(incomplete.allExpectedSeasonsReady, false);
  assert.equal(incomplete.errors.length, 1);
  assert.equal(downloads, 1);
});

test('a truncated historical CSV is never marked reusable even when its rows all match', async () => {
  const csv = seasonCsv().split('\n').slice(0, 2).join('\n');
  const [row] = parseFootballDataCsv(csv);
  const historyStore = memoryStore();
  await syncFootballData({
    getMatchesForCompetition: async () => [{ match_id: '1', date: row.date, home_team_name: row.homeTeam, away_team_name: row.awayTeam }],
    fillSupplementalStats: async () => false, saveMarketOdds: async () => false,
  }, { competitions: ['Serie A'], seasonStartYears: [2024], now, historyStore, fetcher: async () => csv });
  assert.equal(historyStore.entries.size, 0);
});

test('persistent libSQL cache honours force refresh, expiry, version and digest; current season always fetches', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute(readFileSync(join(__dirname, '../migrations/012_football_data_verified_csv.sql'), 'utf8'));
    const store = createFootballDataHistoryStore(client);
    let calls = 0;
    const params = { leagueCode: 'I1', seasonStart: 2024, currentSeasonStart: 2026, seasonCode: '2425', now,
      store, fetcher: async () => { calls++; return seasonCsv(); } };
    let loaded = await loadFootballDataCsv(params);
    assert.equal(await store.get('I1', 2024), null);
    await loaded.markVerified();
    assert.equal((await loadFootballDataCsv({ ...params, store: createFootballDataHistoryStore(client) })).reused, true);
    assert.equal(calls, 1);
    loaded = await loadFootballDataCsv({ ...params, forceRefresh: true });
    assert.equal(loaded.reused, false);
    await loadFootballDataCsv({ ...params, now: new Date('2026-10-08T12:00:00Z') });
    await client.execute('UPDATE football_data_verified_csv SET version = 0');
    await loadFootballDataCsv(params);
    await client.execute("UPDATE football_data_verified_csv SET version = 1, sha256 = 'corrupt'");
    await loadFootballDataCsv(params);
    await loadFootballDataCsv({ ...params, seasonStart: 2026, seasonCode: '2627' });
    assert.equal(calls, 6);
  } finally { client.close(); }
});

test('lower division cache skips verified history but repairs newly known teams and force refresh rewrites', async () => {
  let downloads = 0;
  const batches = [];
  const teams = [{ team_id: 't0', name: 'Team0' }];
  let complete = false;
  const db = {
    getTransitionTeams: async () => teams,
    hasCompleteTransitionSeasonReference: async () => complete,
    hasTransitionForSourceSeason: async () => complete,
    hasCompleteLowerDivisionTeamHistory: async (_id, _season, expected) => complete && expected.length === 1,
    upsertLowerDivisionHistoryBatch: async (batch) => { batches.push(batch); complete = true; },
  };
  const options = { competitions: { 'Serie B': 'I2' }, seasonStartYears: [2024], now,
    historyStore: memoryStore(), fetcher: async () => { downloads++; return seasonCsv(); } };
  assert.equal((await syncTransitionSeasonReferences(db, options)).persisted, 1);
  assert.equal((await syncTransitionSeasonReferences(db, options)).skipped, 1);
  teams.push({ team_id: 't1', name: 'Team1' });
  assert.equal((await syncTransitionSeasonReferences(db, options)).persisted, 1);
  assert.equal(batches[1].teamSeasons.length, 2);
  assert.equal(downloads, 1);
  assert.equal((await syncTransitionSeasonReferences(db, { ...options, forceRefresh: true })).persisted, 1);
  assert.equal(downloads, 2);
});
