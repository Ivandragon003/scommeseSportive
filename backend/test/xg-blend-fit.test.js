const test = require('node:test');
const assert = require('node:assert/strict');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');

// A domina sempre per xG (2.4 vs 0.6) ma i goal finiscono sempre 1-1:
// senza blend il fit non vede differenze, con il blend l'attacco di A emerge.
function buildMatches({ withXg }) {
  const matches = [];
  for (let i = 0; i < 30; i++) {
    const homeIsA = i % 2 === 0;
    matches.push({
      matchId: `xg-${i}`,
      homeTeamId: homeIsA ? 'A' : 'B',
      awayTeamId: homeIsA ? 'B' : 'A',
      date: new Date(Date.UTC(2026, 0, 1 + i)),
      homeGoals: 1,
      awayGoals: 1,
      ...(withXg
        ? {
          homeXG: homeIsA ? 2.4 : 0.6,
          awayXG: homeIsA ? 0.6 : 2.4,
        }
        : {}),
      season: '2025-2026',
    });
  }
  return matches;
}

test('xG blend: con goal piatti il segnale xG differenzia gli attacchi', () => {
  const noBlend = new DixonColesModel();
  const blended = new DixonColesModel();

  const paramsNoBlend = noBlend.fitModel(buildMatches({ withXg: true }), ['A', 'B'], 160, 0.04, { xgBlendWeight: 0 });
  const paramsBlended = blended.fitModel(buildMatches({ withXg: true }), ['A', 'B'], 160, 0.04, { xgBlendWeight: 0.6 });

  const gapNoBlend = paramsNoBlend.attackParams['A'] - paramsNoBlend.attackParams['B'];
  const gapBlended = paramsBlended.attackParams['A'] - paramsBlended.attackParams['B'];

  assert.ok(Math.abs(gapNoBlend) < 0.10, `senza blend il gap attacchi dovrebbe essere ~0, trovato ${gapNoBlend}`);
  assert.ok(gapBlended > 0.15, `con blend l'attacco di A deve emergere, trovato ${gapBlended}`);
  assert.ok(gapBlended > gapNoBlend + 0.10, `blend deve aumentare il gap: ${gapNoBlend} -> ${gapBlended}`);
});

test('xG blend: senza dati xG il fit e identico a prescindere dal peso', () => {
  const a = new DixonColesModel();
  const b = new DixonColesModel();

  const paramsA = a.fitModel(buildMatches({ withXg: false }), ['A', 'B'], 120, 0.04, { xgBlendWeight: 0 });
  const paramsB = b.fitModel(buildMatches({ withXg: false }), ['A', 'B'], 120, 0.04, { xgBlendWeight: 0.6 });

  for (const team of ['A', 'B']) {
    assert.ok(Math.abs(paramsA.attackParams[team] - paramsB.attackParams[team]) < 1e-12);
    assert.ok(Math.abs(paramsA.defenceParams[team] - paramsB.defenceParams[team]) < 1e-12);
  }
  assert.ok(Math.abs(paramsA.homeAdvantage - paramsB.homeAdvantage) < 1e-12);
});

test('xG blend: xG non finiti o negativi ricadono sui goal reali', () => {
  const matches = buildMatches({ withXg: false }).map((m, i) => ({
    ...m,
    homeXG: i % 2 === 0 ? Number.NaN : -1,
    awayXG: i % 2 === 0 ? undefined : -0.5,
  }));

  const clean = new DixonColesModel();
  const dirty = new DixonColesModel();
  const paramsClean = clean.fitModel(buildMatches({ withXg: false }), ['A', 'B'], 120, 0.04, { xgBlendWeight: 0.6 });
  const paramsDirty = dirty.fitModel(matches, ['A', 'B'], 120, 0.04, { xgBlendWeight: 0.6 });

  for (const team of ['A', 'B']) {
    assert.ok(Math.abs(paramsClean.attackParams[team] - paramsDirty.attackParams[team]) < 1e-12);
  }
});
