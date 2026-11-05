const test = require('node:test');
const assert = require('node:assert/strict');
const { UnderstatScraper } = require('../dist/services/UnderstatScraper');

function mockResponse(data) {
  const scraper = new UnderstatScraper();
  const paths = [];
  scraper.client.get = async (path) => {
    paths.push(path);
    return { status: 200, data };
  };
  return { scraper, paths };
}

function assertInvalidResponse(error) {
  assert.equal(error.code, 'UNDERSTAT_INVALID_RESPONSE');
  assert.equal(error.message, 'Understat response has an invalid format.');
  assert.equal(error.response, undefined);
  assert.equal(error.data, undefined);
  return true;
}

test('Understat rejects successful non-object responses without retry or raw payload disclosure', async () => {
  const privateMarker = 'private-provider-body-marker';
  const malformed = [
    `<html><body>We will come back soon ${privateMarker}</body></html>`,
    `{"private":"${privateMarker}"`,
    null,
    undefined,
    [],
    [{ private: privateMarker }],
    42,
    true,
    false,
  ];
  for (const payload of malformed) {
    const { scraper, paths } = mockResponse(payload);
    await assert.rejects(scraper.scrapeSeason('Serie A', '2026/2027'), (error) => {
      assertInvalidResponse(error);
      assert.equal(String(error.stack).includes(privateMarker), false);
      assert.equal(JSON.stringify(error).includes(privateMarker), false);
      return true;
    });
    assert.deepEqual(paths, ['/getLeagueData/serie_a/2026']);
  }
});

test('Understat requires the league dates array without retrying malformed objects', async () => {
  for (const dates of [undefined, null, {}, 'unavailable', 0, false]) {
    const { scraper, paths } = mockResponse({ teams: {}, dates });
    await assert.rejects(scraper.scrapeSeason('Serie A', '2026/2027'), assertInvalidResponse);
    assert.equal(paths.length, 1);
  }
});

test('Understat accepts an explicitly empty league season without detail requests', async () => {
  const { scraper, paths } = mockResponse({ teams: {}, players: [], dates: [] });
  assert.deepEqual(await scraper.scrapeSeason('Serie A', '2026/2027', { includeDetails: true }), []);
  assert.deepEqual(paths, ['/getLeagueData/serie_a/2026']);
});

test('Understat keeps valid league match and database mapping unchanged for all five leagues', async () => {
  const leagues = [
    ['Serie A', 'serie_a'],
    ['Premier League', 'epl'],
    ['La Liga', 'la_liga'],
    ['Bundesliga', 'bundesliga'],
    ['Ligue 1', 'ligue_1'],
  ];
  assert.deepEqual(UnderstatScraper.getTop5Competitions(), leagues.map(([name]) => name));
  const completed = {
    id: '12345', datetime: '2026-11-03 20:00:00',
    h: { id: '10', title: 'Home Team' }, a: { id: '20', title: 'Away Team' },
    goals: { h: '2', a: '1' }, xG: { h: '1.75', a: '0.65' },
  };
  const upcoming = { ...completed, id: '12346', goals: { h: null, a: null }, xG: { h: null, a: null } };
  const emptyStats = {
    homeTotalShots: null, awayTotalShots: null, homeShotsOnTarget: null, awayShotsOnTarget: null,
    homePossession: null, awayPossession: null, homeYellowCards: null, awayYellowCards: null,
    homeRedCards: null, awayRedCards: null, homeFouls: null, awayFouls: null,
    homeCorners: null, awayCorners: null, referee: null,
  };
  for (const [competition, slug] of leagues) {
    const { scraper, paths } = mockResponse({ dates: [completed, upcoming] });
    const matches = await scraper.scrapeSeason(competition, '2026/2027');
    const expected = [completed, upcoming].map((entry, index) => ({
      matchId: `understat_${entry.id}`, sourceMatchId: Number(entry.id), date: entry.datetime,
      homeTeamId: '10', awayTeamId: '20', homeTeamName: 'Home Team', awayTeamName: 'Away Team',
      homeGoals: index === 0 ? 2 : null, awayGoals: index === 0 ? 1 : null,
      homeXG: index === 0 ? 1.75 : null, awayXG: index === 0 ? 0.65 : null,
      ...emptyStats, competition, season: '2026/2027', rawJson: JSON.stringify(entry), playerStats: [],
    }));
    assert.deepEqual(matches, expected);
    for (const match of matches) {
      const { playerStats: _playerStats, ...stored } = match;
      assert.deepEqual(scraper.toDbFormat(match), {
        ...stored, date: new Date('2026-11-03T20:00:00Z'), source: 'understat',
      });
    }
    assert.deepEqual(paths, [`/getLeagueData/${slug}/2026`]);
  }
});
