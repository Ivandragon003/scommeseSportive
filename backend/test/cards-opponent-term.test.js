'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');

function buildMatches() {
  const teams = ['A', 'B', 'C', 'D'];
  const matches = [];
  let day = 0;
  for (let r = 0; r < 6; r++) {
    for (const [h, a] of [['A','B'],['C','D'],['A','C'],['B','D'],['A','D'],['B','C']]) {
      day += 3;
      matches.push({
        matchId: `m${day}`, homeTeamId: h, awayTeamId: a,
        homeGoals: 1 + (day % 3), awayGoals: day % 2,
        date: new Date(2025, 0, day),
      });
    }
  }
  return { teams, matches };
}

// D1: i gialli della squadra di casa crescono se l'avversario (away) SUBISCE
// molti falli (fouls_drawn alto = "provoca" di piu'). Con away foul-drawing la
// distribuzione gialli attesi deve spostarsi verso l'alto rispetto a un away neutro.
test('D1: away che subisce piu falli alza i gialli attesi di casa', () => {
  const model = new DixonColesModel();
  const { teams, matches } = buildMatches();
  model.fitModel(matches, teams);

  const baseHome = {
    avgShots: 13, avgShotsOT: 4.6, avgYellowCards: 2.0, avgRedCards: 0.11,
    avgFouls: 12, shotsSuppression: 1.0, sampleSize: 18,
  };
  const baseAway = {
    avgShots: 11, avgShotsOT: 4.0, avgYellowCards: 2.0, avgRedCards: 0.11,
    avgFouls: 12, shotsSuppression: 1.0, sampleSize: 18,
  };
  const leagueAvgFouls = 22.4; // fouls_drawn medio per squadra = 11.2

  const neutral = model.computeFullProbabilities('A', 'B', 1.6, 1.1, {
    homeTeamStats: { ...baseHome, avgFoulsDrawn: 11.2 },
    awayTeamStats: { ...baseAway, avgFoulsDrawn: 11.2 },
    leagueAvgFouls,
  });
  const foulDrawingAway = model.computeFullProbabilities('A', 'B', 1.6, 1.1, {
    homeTeamStats: { ...baseHome, avgFoulsDrawn: 11.2 },
    awayTeamStats: { ...baseAway, avgFoulsDrawn: 15.0 }, // away subisce molti falli
    leagueAvgFouls,
  });

  assert.ok(
    foulDrawingAway.cards.expectedHomeYellow > neutral.cards.expectedHomeYellow,
    `attesi gialli casa maggiori con away foul-drawing: ${foulDrawingAway.cards.expectedHomeYellow} <= ${neutral.cards.expectedHomeYellow}`,
  );
  // e la probabilita' Over sui booking points totali sale
  const kNeutral = neutral.flatProbabilities.cardsTotalOver45;
  const kBoost = foulDrawingAway.flatProbabilities.cardsTotalOver45;
  assert.ok(kBoost > kNeutral, `Over 4.5 cartellini deve salire: ${kBoost} <= ${kNeutral}`);
});

test('D1: induzione neutra (fouls_drawn = media lega) non altera i gialli', () => {
  const model = new DixonColesModel();
  const { teams, matches } = buildMatches();
  model.fitModel(matches, teams);
  const stats = (fd) => ({
    home: { avgShots: 13, avgShotsOT: 4.6, avgYellowCards: 2.0, avgRedCards: 0.11, avgFouls: 12, shotsSuppression: 1.0, sampleSize: 18, avgFoulsDrawn: fd },
    away: { avgShots: 11, avgShotsOT: 4.0, avgYellowCards: 2.0, avgRedCards: 0.11, avgFouls: 12, shotsSuppression: 1.0, sampleSize: 18, avgFoulsDrawn: fd },
  });
  const s = stats(11.2);
  const withFd = model.computeFullProbabilities('A', 'B', 1.6, 1.1, { homeTeamStats: s.home, awayTeamStats: s.away, leagueAvgFouls: 22.4 });
  const withoutFd = model.computeFullProbabilities('A', 'B', 1.6, 1.1, {
    homeTeamStats: { ...s.home, avgFoulsDrawn: undefined },
    awayTeamStats: { ...s.away, avgFoulsDrawn: undefined },
    leagueAvgFouls: 22.4,
  });
  assert.ok(Math.abs(withFd.cards.expectedTotalYellow - withoutFd.cards.expectedTotalYellow) < 1e-6);
});
