const test = require('node:test');
const assert = require('node:assert/strict');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');

// Costruisce un campionato in cui il livello reale dei goal è deliberatamente
// più alto di quanto il fit strutturale tende a restituire, così il fattore
// levelCorrection deve risultare > 1 e ri-livellare E[goal] verso il reale.
function buildLeague(goalsPerSide) {
  const teams = ['A', 'B', 'C', 'D'];
  const matches = [];
  let i = 0;
  for (const h of teams) {
    for (const a of teams) {
      if (h === a) continue;
      for (let rep = 0; rep < 6; rep++) {
        matches.push({
          matchId: `m-${i++}`,
          homeTeamId: h,
          awayTeamId: a,
          date: new Date(Date.UTC(2026, 0, 1 + i)),
          homeGoals: goalsPerSide,
          awayGoals: goalsPerSide,
          season: '2025-2026',
        });
      }
    }
  }
  return { matches, teams };
}

test('levelCorrection: viene stimata a fit-time e ri-livella E[goal] verso il reale', () => {
  const { matches, teams } = buildLeague(2);
  const model = new DixonColesModel();
  const params = model.fitModel(matches, teams, 200, 0.04, { xgBlendWeight: 0 });

  assert.ok(params.levelCorrection, 'levelCorrection deve essere valorizzata dopo il fit');
  assert.ok(params.levelCorrection.home >= 0.85 && params.levelCorrection.home <= 1.35, 'home in range clamp');
  assert.ok(params.levelCorrection.away >= 0.85 && params.levelCorrection.away <= 1.35, 'away in range clamp');

  // Con correzione ON, E[tot] deve avvicinarsi al reale (4.0) più che con OFF.
  const onH = model.computeExpectedGoals('A', 'B');
  const savedLc = model.getParams().levelCorrection;
  model.setParams({ levelCorrection: undefined });
  const offH = model.computeExpectedGoals('A', 'B');
  model.setParams({ levelCorrection: savedLc });

  const realTot = 4.0;
  const errOn = Math.abs((onH.lambdaHome + onH.lambdaAway) - realTot);
  const errOff = Math.abs((offH.lambdaHome + offH.lambdaAway) - realTot);
  assert.ok(errOn <= errOff + 1e-9, `la correzione deve avvicinare al reale: off=${errOff} on=${errOn}`);
});

test('levelCorrection: il fattore scala λ esattamente di c (home/away)', () => {
  const { matches, teams } = buildLeague(2);
  const model = new DixonColesModel();
  const params = model.fitModel(matches, teams, 200, 0.04, { xgBlendWeight: 0 });
  const c = params.levelCorrection;

  const on = model.computeExpectedGoals('A', 'B');
  model.setParams({ levelCorrection: undefined });
  const off = model.computeExpectedGoals('A', 'B');

  // Fuori dai clamp LAMBDA il rapporto on/off deve coincidere con i fattori c.
  assert.ok(Math.abs(on.lambdaHome / off.lambdaHome - c.home) < 1e-6, `home: ${on.lambdaHome / off.lambdaHome} vs ${c.home}`);
  assert.ok(Math.abs(on.lambdaAway / off.lambdaAway - c.away) < 1e-6, `away: ${on.lambdaAway / off.lambdaAway} vs ${c.away}`);
});
