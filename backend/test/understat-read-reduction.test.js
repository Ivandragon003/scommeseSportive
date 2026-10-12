const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const footballData = require('../dist/services/FootballDataService.js');
const { UnderstatScraper } = require('../dist/services/UnderstatScraper.js');
const { createApiRouter } = require('../dist/api/routes.js');

test('nightly verifies five seasons with one scoped read each, skips player rebuild and recomputes only changed teams', async () => {
  const originalPrune = footballData.pruneOldSeasons;
  const originalScrape = UnderstatScraper.prototype.scrapeSeason;
  const originalFormat = UnderstatScraper.prototype.toDbFormat;
  const rows = new Map();
  const reads = [];
  const recomputed = [];
  let fits = 0;
  const year = new Date().getUTCFullYear();
  const sourceMatch = (season) => ({
    matchId: `source-${season}`, homeTeamId: '1', awayTeamId: '2',
    homeTeamName: 'Home', awayTeamName: 'Away', date: `${season.slice(0, 4)}-08-01T12:00:00Z`,
    homeGoals: Number(season.startsWith(String(year))), awayGoals: 0,
    competition: 'Serie A', season, playerStats: [],
  });
  const format = (match) => ({
    matchId: match.matchId, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
    date: match.date, homeGoals: match.homeGoals, awayGoals: match.awayGoals,
    competition: match.competition, season: match.season,
  });
  footballData.pruneOldSeasons = async () => ({ matchesDeleted: 0 });
  UnderstatScraper.prototype.scrapeSeason = async (_competition, season) => [sourceMatch(season)];
  UnderstatScraper.prototype.toDbFormat = format;
  const unexpectedPlayerRead = () => assert.fail('player work during paused nightly');
  const teams = ['1', '2', '3'].map((id, index) => ({
    team_id: `team-${id}`, source_team_id: Number(id), name: ['Home', 'Away', 'Idle'][index], short_name: id,
  }));
  const db = {
    db: {}, getTeams: async () => teams,
    getLastMatchDate: async () => null, getLastMatchDates: async () => ({}),
    async getMatches(filters) {
      reads.push(filters);
      if (!filters.season) return [...rows.values()];
      if (!rows.has(filters.season)) {
        const match = sourceMatch(filters.season);
        rows.set(filters.season, {
          match_id: match.matchId, home_team_id: 'team-1', away_team_id: 'team-2',
          date: match.date, home_goals: 0, away_goals: 0, competition: match.competition, season: match.season,
        });
      }
      return [rows.get(filters.season)];
    },
    async upsertMatches(writes) {
      for (const write of writes) rows.set(write.season, {
        match_id: write.matchId, home_team_id: write.homeTeamId, away_team_id: write.awayTeamId,
        date: write.date, home_goals: write.homeGoals, away_goals: write.awayGoals,
        competition: write.competition, season: write.season,
      });
      return { committedCount: writes.length };
    },
    recomputeTeamAveragesBatch: async (ids) => recomputed.push(ids),
    countCompletedMatches: async () => 1,
    upsertPlayers: unexpectedPlayerRead, markPlayersUnavailable: unexpectedPlayerRead,
    upsertReferees: async () => undefined,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ db, svc: {
    fitModelForCompetition: async () => { fits++; return { matchesUsed: 1, teams: 2 }; },
    settlePendingBetOpportunityPredictionsForCompletedMatches: async () => ({ matches: 0, settled: 0, unresolved: 0 }),
  } }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const sync = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scraper/understat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competition: 'Serie A', importPlayers: true }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload.data;
  };
  try {
    const first = await sync();
    assert.equal(first.allExpectedSeasonsComplete, true);
    assert.equal(first.importPlayers, false);
    assert.equal(first.playersDerivedMatches, 0);
    assert.equal(reads.filter((query) => query.season).length, 5);
    assert.deepEqual(recomputed, [['team-1', 'team-2']]);
    assert.equal(fits, 1);
    const repeat = await sync();
    assert.equal(repeat.allExpectedSeasonsComplete, true);
    assert.equal(repeat.teamsRecomputed, 0);
    assert.equal(reads.filter((query) => query.season).length, 10);
    assert.equal(recomputed.length, 1);
    assert.equal(fits, 1);
  } finally {
    footballData.pruneOldSeasons = originalPrune;
    UnderstatScraper.prototype.scrapeSeason = originalScrape;
    UnderstatScraper.prototype.toDbFormat = originalFormat;
    await new Promise((resolve) => server.close(resolve));
  }
});
