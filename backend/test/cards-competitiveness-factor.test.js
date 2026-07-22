const test = require('node:test');
const assert = require('node:assert/strict');
const { SpecializedModels } = require('../dist/models/markets/SpecializedModels.js');

// Input neutro: arbitro e falli allineati alla media di lega => refYellowFactor=1
// e foulsBonus=1, cosi' l'UNICO fattore attivo e' compFactor. E' anche lo scenario
// reale di produzione: arbitro/falli sono presenti solo nell'1-2% dei match.
function neutralCards(competitiveness, teamAvgYellow = 1.9) {
  return {
    homeTeamAvgYellow: teamAvgYellow,
    awayTeamAvgYellow: teamAvgYellow,
    homeTeamAvgRed: 0.11,
    awayTeamAvgRed: 0.11,
    refereeAvgYellow: 3.8,
    refereeAvgRed: 0.22,
    leagueAvgYellow: 3.8,
    competitiveness,
    homeTeamSampleSize: 40,
    awayTeamSampleSize: 40,
    refereeSampleSize: 0,
    refereeAvgFouls: 22.4,
    leagueAvgFouls: 22.4,
  };
}

test('competitiveness: fattore NEUTRO su una partita media (no bias sistematico)', () => {
  const sm = new SpecializedModels();
  const base = 3.8; // 1.9 + 1.9, gia' allineato alla media di lega
  const out = sm.computeCardsDistribution(neutralCards(0.5));
  // A competitiveness=0.5 il fattore deve essere ~1.0: i gialli attesi non devono
  // discostarsi dalla media delle squadre. Il refuso `- 0` dava qui +22%.
  const ratio = out.expectedTotalYellow / base;
  assert.ok(
    Math.abs(ratio - 1) < 0.02,
    `partita media: atteso ~${base} gialli, trovato ${out.expectedTotalYellow} (ratio ${ratio.toFixed(3)})`
  );
});

test('competitiveness: boost massimo ~+22% sui derby, non il doppio', () => {
  const sm = new SpecializedModels();
  const base = 3.8;
  const derby = sm.computeCardsDistribution(neutralCards(1.0));
  const ratio = derby.expectedTotalYellow / base;
  assert.ok(ratio > 1.15, `derby deve alzare i gialli, ratio=${ratio.toFixed(3)}`);
  assert.ok(ratio < 1.25, `il boost non deve superare ~+22% (era +43% col refuso), ratio=${ratio.toFixed(3)}`);
});

test('competitiveness: match sbilanciato riduce i gialli (curva simmetrica)', () => {
  const sm = new SpecializedModels();
  const base = 3.8;
  const lopsided = sm.computeCardsDistribution(neutralCards(0.0));
  const ratio = lopsided.expectedTotalYellow / base;
  assert.ok(ratio < 0.9, `match sbilanciato deve ridurre i gialli, ratio=${ratio.toFixed(3)}`);
  assert.ok(ratio > 0.75, `la riduzione non deve superare ~-22%, ratio=${ratio.toFixed(3)}`);
});

test('competitiveness: monotona crescente e centrata', () => {
  const sm = new SpecializedModels();
  const values = [0, 0.25, 0.5, 0.75, 1].map(
    (c) => sm.computeCardsDistribution(neutralCards(c)).expectedTotalYellow
  );
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1], `deve crescere con la competitivita: ${values}`);
  }
  // simmetria attorno alla partita media
  const mid = values[2];
  const spanUp = values[4] - mid;
  const spanDown = mid - values[0];
  assert.ok(
    Math.abs(spanUp - spanDown) < 0.05,
    `la curva deve essere simmetrica attorno al centro: +${spanUp.toFixed(3)} / -${spanDown.toFixed(3)}`
  );
});
