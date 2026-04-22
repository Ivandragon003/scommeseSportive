const test = require('node:test');
const assert = require('node:assert/strict');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');

function buildMatches() {
  const strengths = { A: 1.95, B: 1.45, C: 1.1, D: 0.8 };
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

  for (let cycle = 0; cycle < 3; cycle++) {
    for (const [home, away] of fixtures) {
      const homeStrength = strengths[home];
      const awayStrength = strengths[away];
      const homeXG = Math.max(0.45, homeStrength + 0.18 - awayStrength * 0.32 + ((index % 3) - 1) * 0.06);
      const awayXG = Math.max(0.25, awayStrength - 0.18 - homeStrength * 0.18 + ((index % 2) ? 0.04 : -0.03));
      const homeGoals = Math.max(0, Math.round(homeXG + ((index + cycle) % 2 ? 0.12 : -0.08)));
      const awayGoals = Math.max(0, Math.round(awayXG + ((index + cycle) % 3 === 0 ? 0.1 : -0.1)));

      matches.push({
        matchId: `m-${cycle}-${index}`,
        homeTeamId: home,
        awayTeamId: away,
        date: new Date(Date.UTC(2025, 0, 1 + index + cycle * fixtures.length)),
        homeGoals,
        awayGoals,
        homeXG: Number(homeXG.toFixed(2)),
        awayXG: Number(awayXG.toFixed(2)),
        homeShotsOnTarget: Math.max(1, Math.round(homeXG * 2.2)),
        awayShotsOnTarget: Math.max(1, Math.round(awayXG * 2.1)),
        homeTotalShots: Math.max(4, Math.round(homeXG * 7.4)),
        awayTotalShots: Math.max(3, Math.round(awayXG * 7.2)),
        homeFouls: 10 + (index % 5),
        awayFouls: 11 + ((index + 2) % 4),
        homeYellowCards: 1 + (index % 3),
        awayYellowCards: 1 + ((index + 1) % 3),
        competition: 'Serie A',
        season: '2025-2026',
      });
      index += 1;
    }
  }

  return matches;
}

test('Dixon-Coles keeps core probabilities coherent after model-layer refactor', () => {
  const model = new DixonColesModel();
  const matches = buildMatches();
  const teams = ['A', 'B', 'C', 'D'];

  model.fitModel(matches, teams);

  const result = model.computeFullProbabilities('A', 'B', 1.75, 1.05, {
    homeTeamStats: {
      avgShots: 14.2,
      avgShotsOT: 5.3,
      avgYellowCards: 2.1,
      avgRedCards: 0.12,
      avgFouls: 12.8,
      avgHomeCorners: 5.8,
      sampleSize: 18,
      varShots: 20.2,
      varShotsOT: 5.5,
      varYellowCards: 3.1,
      varFouls: 18.4,
    },
    awayTeamStats: {
      avgShots: 11.6,
      avgShotsOT: 4.1,
      avgYellowCards: 2.3,
      avgRedCards: 0.15,
      avgFouls: 13.4,
      avgAwayCorners: 4.7,
      sampleSize: 18,
      varShots: 18.7,
      varShotsOT: 4.7,
      varYellowCards: 3.4,
      varFouls: 19.1,
    },
    refereeStats: {
      avgYellow: 4.7,
      avgRed: 0.21,
      avgFouls: 24.1,
      sampleSize: 16,
    },
  });

  const outcomeSum = result.homeWin + result.draw + result.awayWin;

  assert.ok(Math.abs(outcomeSum - 1) < 1e-6, `1X2 incoerente: ${outcomeSum}`);
  assert.ok(result.over25 >= 0 && result.over25 <= 1);
  assert.ok(result.cards.expectedTotalYellow > 0);
  assert.ok(result.fouls.expectedTotalFouls > 0);
  assert.ok(result.shotsHome.expected > 0);
  assert.ok(result.flatProbabilities.homeWin > 0);
  assert.ok(result.flatProbabilities.draw > 0);
  assert.ok(result.flatProbabilities.awayWin > 0);
  assert.ok(result.flatProbabilities.over25 > 0);
  assert.ok(result.flatProbabilities.shotsOver235 > 0);
  assert.ok(result.flatProbabilities.yellowOver45 > 0);
  assert.ok(result.flatProbabilities.foulsOver235 > 0);
});
