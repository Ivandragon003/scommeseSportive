const test = require('node:test');
const assert = require('node:assert/strict');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine.js');

function buildMatches() {
  const strengths = { A: 1.95, B: 1.5, C: 1.12, D: 0.82 };
  const fixtures = [
    ['A', 'B'], ['C', 'D'],
    ['A', 'C'], ['B', 'D'],
    ['A', 'D'], ['B', 'C'],
    ['B', 'A'], ['D', 'C'],
    ['C', 'A'], ['D', 'B'],
    ['D', 'A'], ['C', 'B'],
  ];

  const matches = [];
  let index = 0;
  for (let cycle = 0; cycle < 4; cycle++) {
    for (const [home, away] of fixtures) {
      const homeStrength = strengths[home];
      const awayStrength = strengths[away];
      const homeXG = Math.max(0.5, homeStrength + 0.2 - awayStrength * 0.3 + ((index + cycle) % 3 - 1) * 0.05);
      const awayXG = Math.max(0.25, awayStrength - 0.16 - homeStrength * 0.18 + ((index + cycle) % 2 ? 0.05 : -0.04));
      const homeGoals = Math.max(0, Math.round(homeXG + ((index + cycle) % 2 ? 0.12 : -0.08)));
      const awayGoals = Math.max(0, Math.round(awayXG + ((index + cycle) % 3 === 0 ? 0.1 : -0.1)));

      matches.push({
        matchId: `bt-${cycle}-${index}`,
        homeTeamId: home,
        awayTeamId: away,
        date: new Date(Date.UTC(2025, 1, 1 + index + cycle * fixtures.length)),
        homeGoals,
        awayGoals,
        homeXG: Number(homeXG.toFixed(2)),
        awayXG: Number(awayXG.toFixed(2)),
        homeShotsOnTarget: Math.max(1, Math.round(homeXG * 2.3)),
        awayShotsOnTarget: Math.max(1, Math.round(awayXG * 2.1)),
        homeTotalShots: Math.max(4, Math.round(homeXG * 7.6)),
        awayTotalShots: Math.max(3, Math.round(awayXG * 7.1)),
        homeFouls: 10 + (index % 6),
        awayFouls: 11 + ((index + 2) % 5),
        homeYellowCards: 1 + (index % 4),
        awayYellowCards: 1 + ((index + 1) % 4),
        competition: 'Serie A',
        season: '2025-2026',
      });
      index += 1;
    }
  }

  return matches;
}

function buildHistoricalOdds(matches) {
  const odds = {};
  const context = {};

  for (const [index, match] of matches.entries()) {
    odds[match.matchId] = {
      homeWin: index % 2 === 0 ? 2.3 : 2.0,
      draw: 3.45,
      awayWin: index % 2 === 0 ? 4.1 : 3.75,
      over25: 2.14,
      under25: 1.81,
      btts: 2.08,
      bttsNo: 1.83,
      shotsOver235: 2.04,
      yellowOver45: 2.01,
      foulsOver235: 2.0,
    };
    context[match.matchId] = {
      oddsSource: 'eurobet_scraper',
      snapshotSource: 'eurobet',
      capturedAt: new Date(Date.UTC(2025, 1, 1 + index)).toISOString(),
    };
  }

  return { odds, context };
}

test('BacktestingEngine keeps bet-level outputs and calibration available after model refactor', () => {
  const engine = new BacktestingEngine();
  const matches = buildMatches();
  const { odds, context } = buildHistoricalOdds(matches);

  const result = engine.runBacktest(
    matches,
    odds,
    0.65,
    'medium_and_above',
    0,
    context
  );

  assert.ok(result.totalMatches === matches.length);
  assert.ok(result.trainingMatches > 0);
  assert.ok(result.testMatches > 0);
  assert.ok(Array.isArray(result.calibration));
  assert.ok(Array.isArray(result.detailedBets));
  assert.ok(result.betsPlaced >= 0);
  assert.equal(result.detailedBets.length, result.betsPlaced);
  assert.ok(result.marketBreakdown && typeof result.marketBreakdown === 'object');
});
