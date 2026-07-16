const test = require('node:test');
const assert = require('node:assert/strict');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');
const { PoissonXgModel, POISSON_XG_GOAL_KEYS } = require('../dist/models/core/PoissonXgModel.js');
const {
  blendGoalProbabilities,
  goalMarketFamilyOf,
  weightForFamily,
} = require('../dist/services/ProbabilityEnsembleService.js');

// Campionato sintetico: A forte (xG alti), B debole (xG bassi), C medio.
function buildMatches() {
  const teams = ['A', 'B', 'C', 'D'];
  const xgProfile = { A: 2.1, B: 0.8, C: 1.4, D: 1.2 };
  const matches = [];
  let i = 0;
  for (const h of teams) {
    for (const a of teams) {
      if (h === a) continue;
      for (let rep = 0; rep < 5; rep++) {
        const hx = xgProfile[h], ax = xgProfile[a];
        matches.push({
          matchId: `m-${i++}`,
          homeTeamId: h, awayTeamId: a,
          date: new Date(Date.UTC(2026, 0, 1 + i)),
          homeGoals: Math.round(hx), awayGoals: Math.round(ax),
          homeXG: hx, awayXG: ax,
          season: '2025-2026',
        });
      }
    }
  }
  return { matches, teams };
}

const COHERENCE = (flat, label) => {
  const s1x2 = flat.homeWin + flat.draw + flat.awayWin;
  assert.ok(Math.abs(s1x2 - 1) < 1e-9, `${label}: 1X2 deve sommare a 1, trovato ${s1x2}`);
  assert.ok(Math.abs(flat.btts + flat.bttsNo - 1) < 1e-9, `${label}: BTTS+No deve fare 1`);
  for (const line of ['05', '15', '25', '35', '45']) {
    const o = flat['over' + line], u = flat['under' + line];
    if (o === undefined) continue;
    assert.ok(Math.abs(o + u - 1) < 1e-9, `${label}: over${line}+under${line} deve fare 1, trovato ${o + u}`);
    assert.ok(o >= 0 && o <= 1, `${label}: over${line} in [0,1]`);
  }
};

test('PoissonXgModel: fit produce rate coerenti e probabilità goal valide', () => {
  const { matches } = buildMatches();
  const model = new PoissonXgModel();
  const params = model.fit(matches);
  assert.ok(params.leagueXG > 0 && params.homeAdv > 0 && params.levelScale > 0);
  // A (forte) deve avere attackRate > B (debole)
  assert.ok(params.attackRate['A'] > params.attackRate['B'], 'A deve attaccare piu di B');

  const probs = model.computeGoalProbabilities('A', 'B');
  assert.ok(probs, 'deve restituire probabilità');
  for (const k of POISSON_XG_GOAL_KEYS) assert.ok(Number.isFinite(probs[k]), `manca ${k}`);
  COHERENCE(probs, 'PoissonXg A vs B');
  // A forte in casa contro B debole: homeWin > awayWin
  assert.ok(probs.homeWin > probs.awayWin, 'A in casa deve essere favorita su B');
});

test('PoissonXgModel: senza params computeGoalProbabilities e null (retrocompat)', () => {
  const empty = new PoissonXgModel();
  assert.equal(empty.hasParams(), false);
  assert.equal(empty.computeGoalProbabilities('A', 'B'), null);
});

test('Ensemble: blend convesso preserva la coerenza e sta tra i due modelli', () => {
  const { matches, teams } = buildMatches();
  const dc = new DixonColesModel();
  dc.fitModel(matches, teams, 200, 0.04);
  const poisson = new PoissonXgModel();
  poisson.fit(matches);

  const dcFlat = dc.computeFullProbabilities('A', 'B').flatProbabilities;
  const poFlat = poisson.computeGoalProbabilities('A', 'B');
  const cfg = { enabled: true, weights: { default: 0.5 } };
  const ens = blendGoalProbabilities(dcFlat, poFlat, cfg);

  COHERENCE(dcFlat, 'DC');
  COHERENCE(poFlat, 'Poisson');
  COHERENCE(ens, 'Ensemble');

  // Ogni mercato goal blendato deve stare fra DC e Poisson (media convessa).
  for (const k of ['homeWin', 'draw', 'awayWin', 'over25', 'under25', 'btts', 'bttsNo']) {
    const lo = Math.min(dcFlat[k], poFlat[k]), hi = Math.max(dcFlat[k], poFlat[k]);
    assert.ok(ens[k] >= lo - 1e-9 && ens[k] <= hi + 1e-9, `${k}: ${ens[k]} non tra ${lo} e ${hi}`);
    // con w=0.5 deve essere la media esatta
    assert.ok(Math.abs(ens[k] - 0.5 * (dcFlat[k] + poFlat[k])) < 1e-9, `${k}: media 0.5 errata`);
  }
});

test('Ensemble: disabilitato o senza Poisson => flat invariato (no-op)', () => {
  const { matches, teams } = buildMatches();
  const dc = new DixonColesModel();
  dc.fitModel(matches, teams, 120, 0.04);
  const dcFlat = dc.computeFullProbabilities('A', 'B').flatProbabilities;

  const off = blendGoalProbabilities(dcFlat, { homeWin: 0.9 }, { enabled: false, weights: { default: 0.5 } });
  assert.deepEqual(off, dcFlat);
  const noPartner = blendGoalProbabilities(dcFlat, null, { enabled: true, weights: { default: 0.5 } });
  assert.deepEqual(noPartner, dcFlat);
});

test('Ensemble: non tocca i mercati non-goal (tiri, gialli, handicap)', () => {
  const dcFlat = { homeWin: 0.5, draw: 0.3, awayWin: 0.2, shotsOver235: 0.6, yellowOver45: 0.4, 'hcp_home-1': 0.33 };
  const poFlat = { homeWin: 0.7, draw: 0.2, awayWin: 0.1 };
  const ens = blendGoalProbabilities(dcFlat, poFlat, { enabled: true, weights: { default: 0.5 } });
  assert.equal(ens.shotsOver235, 0.6, 'tiri invariati');
  assert.equal(ens.yellowOver45, 0.4, 'gialli invariati');
  assert.equal(ens['hcp_home-1'], 0.33, 'handicap invariato');
  assert.ok(Math.abs(ens.homeWin - 0.6) < 1e-9, 'homeWin blendato');
});

test('Ensemble: pesi per-famiglia distinti', () => {
  assert.equal(goalMarketFamilyOf('homeWin'), 'oneXTwo');
  assert.equal(goalMarketFamilyOf('over25'), 'overUnder');
  assert.equal(goalMarketFamilyOf('bttsNo'), 'btts');
  assert.equal(goalMarketFamilyOf('shotsOver235'), null);

  const weights = { default: 0.5, oneXTwo: 0.2, overUnder: 0.8 };
  assert.equal(weightForFamily(weights, 'oneXTwo'), 0.2);
  assert.equal(weightForFamily(weights, 'overUnder'), 0.8);
  assert.equal(weightForFamily(weights, 'btts'), 0.5); // fallback default

  const dcFlat = { homeWin: 0.4, draw: 0.3, awayWin: 0.3, over25: 0.5, under25: 0.5, btts: 0.5, bttsNo: 0.5 };
  const poFlat = { homeWin: 0.8, draw: 0.1, awayWin: 0.1, over25: 0.9, under25: 0.1, btts: 0.9, bttsNo: 0.1 };
  const ens = blendGoalProbabilities(dcFlat, poFlat, { enabled: true, weights });
  assert.ok(Math.abs(ens.homeWin - (0.8 * 0.4 + 0.2 * 0.8)) < 1e-9, '1X2 usa peso 0.2');
  assert.ok(Math.abs(ens.over25 - (0.2 * 0.5 + 0.8 * 0.9)) < 1e-9, 'O/U usa peso 0.8');
  assert.ok(Math.abs(ens.btts - (0.5 * 0.5 + 0.5 * 0.9)) < 1e-9, 'BTTS usa default 0.5');
});
