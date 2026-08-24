const test = require('node:test');
const assert = require('node:assert/strict');
const { PredictionContextBuilder } = require('../dist/services/PredictionContextBuilder.js');
const { applyHistoricalCoverageGate } = require('../dist/services/PredictionService.js');

test('PredictionContextBuilder uses stored single-source team averages', () => {
  const builder = new PredictionContextBuilder();
  const homeTeam = {
    avg_home_shots: 11.1,
    avg_home_shots_ot: 4.1,
    avg_home_xg: 1.2,
    avg_yellow_cards: 2.2,
    avg_red_cards: 0.2,
    avg_fouls: 13.5,
    avg_home_corners: 5.1,
    shots_per90: 15.4,
    sot_per90: 5.8,
    xg: 27.5,
    xga: 12.6,
    fouls_committed: 210,
    yellow_cards: 48,
    red_cards: 3,
    corners: 92,
    team_stats_json: JSON.stringify({
      computed: {
        home: {
          sampleSize: 18,
        },
      },
    }),
  };
  const awayTeam = {
    avg_away_shots: 10.2,
    avg_away_shots_ot: 3.6,
    avg_away_xg: 1.05,
    team_stats_json: JSON.stringify({
      computed: {
        away: {
          sampleSize: 17,
        },
      },
    }),
  };

  const result = builder.build({
    request: {},
    homeTeam,
    awayTeam,
    referee: null,
    homePlayers: [],
    awayPlayers: [],
  });

  assert.equal(result.supplementaryData.homeTeamStats.avgShots, 11.1);
  assert.equal(result.supplementaryData.homeTeamStats.avgShotsOT, 4.1);
  assert.equal(result.supplementaryData.homeTeamStats.avgFouls, 13.5);
  assert.equal(result.supplementaryData.homeTeamStats.avgYellowCards, 2.2);
  assert.equal(result.supplementaryData.homeTeamStats.avgHomeCorners, 5.1);
  assert.equal(result.supplementaryData.homeTeamStats.sampleSize, 18);
  assert.equal(result.homeXG, 1.2);
});

test('historical coverage is calculated per team and match uses the lower value', () => {
  const builder = new PredictionContextBuilder();
  const result = builder.build({
    request: {},
    homeTeam: { avg_home_xg: 1.2, team_stats_json: JSON.stringify({ computed: { home: { sampleSize: 20 } } }) },
    awayTeam: { avg_away_xg: 1.0, team_stats_json: JSON.stringify({ computed: { away: { sampleSize: 20 } } }) },
    referee: null,
    homePlayers: [],
    awayPlayers: [],
    homeHistoricalCoverage: { teamId: 'venezia', seasonsExpected: 5, seasonsAvailable: 5, coveragePercent: 100 },
    awayHistoricalCoverage: { teamId: 'parma', seasonsExpected: 5, seasonsAvailable: 4, coveragePercent: 80 },
  });

  assert.equal(result.historicalCoverage.home.coveragePercent, 100);
  assert.equal(result.historicalCoverage.away.coveragePercent, 80);
  assert.equal(result.historicalCoverage.matchCoveragePercent, 80);
  assert.ok(result.richnessScore < 0.93);
});

test('full coverage for both teams is not reduced by unrelated missing teams', () => {
  const builder = new PredictionContextBuilder();
  const result = builder.build({
    request: {},
    homeTeam: { avg_home_xg: 1.2, team_stats_json: JSON.stringify({ computed: { home: { sampleSize: 24 } } }) },
    awayTeam: { avg_away_xg: 1.0, team_stats_json: JSON.stringify({ computed: { away: { sampleSize: 24 } } }) },
    referee: null,
    homePlayers: [],
    awayPlayers: [],
    homeHistoricalCoverage: { teamId: 'venezia', seasonsExpected: 5, seasonsAvailable: 5, coveragePercent: 100 },
    awayHistoricalCoverage: { teamId: 'parma', seasonsExpected: 5, seasonsAvailable: 5, coveragePercent: 100 },
  });

  assert.equal(result.historicalCoverage.matchCoveragePercent, 100);
  assert.equal(result.richnessScore, 0.74);
});

test('two available seasons remain usable but cannot be promoted to HIGH', () => {
  const gated = applyHistoricalCoverageGate({ confidence: 'HIGH', expectedValue: 0.12 }, 40);
  assert.equal(gated.confidence, 'MEDIUM');
  assert.ok(gated.dataWarnings.includes('historical_team_coverage_limited'));
});

test('one or zero available seasons is capped at LOW', () => {
  const gated = applyHistoricalCoverageGate({ confidence: 'HIGH', expectedValue: 0.12 }, 20);
  assert.equal(gated.confidence, 'LOW');
});
