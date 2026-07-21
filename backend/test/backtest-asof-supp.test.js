const test = require('node:test');
const assert = require('node:assert/strict');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine.js');

// I1: dati supplementari as-of-date nel backtest.
// Questi test bloccano le proprieta' critiche di buildAsOfSupp:
//  - anti-leakage (nessun dato della partita stessa ne' futuro)
//  - split per venue (casa usa medie casa, trasferta usa medie trasferta)
//  - medie combinate cross-venue per gialli/falli (come recomputeTeamAverages)
//  - sampleSize per venue
//  - toggle off => comportamento legacy (nessun supp)

const DAY = 24 * 60 * 60 * 1000;
const BASE = Date.UTC(2025, 0, 1);

function mk(id, home, away, date, stats = {}) {
  return {
    matchId: id,
    homeTeamId: home,
    awayTeamId: away,
    date: new Date(date),
    homeGoals: stats.homeGoals ?? 1,
    awayGoals: stats.awayGoals ?? 1,
    homeXG: stats.homeXG ?? 1.2,
    awayXG: stats.awayXG ?? 1.0,
    homeTotalShots: stats.homeTotalShots,
    awayTotalShots: stats.awayTotalShots,
    homeShotsOnTarget: stats.homeShotsOnTarget,
    awayShotsOnTarget: stats.awayShotsOnTarget,
    homeYellowCards: stats.homeYellowCards,
    awayYellowCards: stats.awayYellowCards,
    homeRedCards: stats.homeRedCards ?? 0,
    awayRedCards: stats.awayRedCards ?? 0,
    homeFouls: stats.homeFouls,
    awayFouls: stats.awayFouls,
    homeCorners: stats.homeCorners,
    awayCorners: stats.awayCorners,
    competition: 'Test League',
    season: '2024/2025',
  };
}

test('buildAsOfSupp ignora la partita stessa e quelle future (anti-leakage)', () => {
  const engine = new BacktestingEngine();
  // A gioca in casa 2 volte prima del match sotto test, con 10 e 20 tiri.
  // Nella partita sotto test (e in una futura) i tiri sono assurdi: non devono entrare.
  const history = [
    mk('h1', 'A', 'B', BASE + 0 * DAY, { homeTotalShots: 10, homeCorners: 4, homeYellowCards: 1, homeFouls: 10 }),
    mk('h2', 'A', 'C', BASE + 10 * DAY, { homeTotalShots: 20, homeCorners: 6, homeYellowCards: 3, homeFouls: 14 }),
    mk('target', 'A', 'D', BASE + 20 * DAY, { homeTotalShots: 999, homeCorners: 999, homeYellowCards: 99, homeFouls: 99 }),
    mk('future', 'A', 'B', BASE + 30 * DAY, { homeTotalShots: 999, homeCorners: 999, homeYellowCards: 99, homeFouls: 99 }),
  ];
  const target = history.find((m) => m.matchId === 'target');
  const supp = engine.buildAsOfSupp(target, history);

  assert.ok(supp, 'supp deve essere costruito');
  assert.ok(supp.homeTeamStats, 'homeTeamStats deve esistere');
  // La media deve stare dentro il range dei soli valori passati [10, 20].
  assert.ok(supp.homeTeamStats.avgShots >= 10 && supp.homeTeamStats.avgShots <= 20,
    `avgShots ${supp.homeTeamStats.avgShots} deve stare in [10,20]: i 999 non devono entrare`);
  assert.ok(supp.homeTeamStats.avgHomeCorners >= 4 && supp.homeTeamStats.avgHomeCorners <= 6,
    'avgHomeCorners deve usare solo i corner passati');
  // sampleSize: solo le 2 partite casalinghe precedenti.
  assert.equal(supp.homeTeamStats.sampleSize, 2);
});

test('buildAsOfSupp restituisce undefined se non esiste storico precedente', () => {
  const engine = new BacktestingEngine();
  const history = [
    mk('first', 'A', 'B', BASE, { homeTotalShots: 12 }),
    mk('later', 'A', 'C', BASE + 5 * DAY, { homeTotalShots: 15 }),
  ];
  const supp = engine.buildAsOfSupp(history[0], history);
  assert.equal(supp, undefined, 'senza partite precedenti non ci sono dati as-of');
});

test('buildAsOfSupp separa le medie per venue (casa vs trasferta)', () => {
  const engine = new BacktestingEngine();
  // A: in casa tira molto (30), in trasferta poco (5). B: opposto.
  const history = [
    mk('a-home', 'A', 'C', BASE + 0 * DAY, { homeTotalShots: 30 }),
    mk('a-away', 'C', 'A', BASE + 1 * DAY, { awayTotalShots: 5 }),
    mk('b-home', 'B', 'C', BASE + 2 * DAY, { homeTotalShots: 6 }),
    mk('b-away', 'C', 'B', BASE + 3 * DAY, { awayTotalShots: 28 }),
    mk('target', 'A', 'B', BASE + 10 * DAY, {}),
  ];
  const target = history.find((m) => m.matchId === 'target');
  const supp = engine.buildAsOfSupp(target, history);

  // A e' in casa nella partita target => deve usare la media CASA di A (30).
  assert.ok(Math.abs(supp.homeTeamStats.avgShots - 30) < 0.001,
    `home usa media casa: atteso ~30, ottenuto ${supp.homeTeamStats.avgShots}`);
  // B e' in trasferta => deve usare la media TRASFERTA di B (28).
  assert.ok(Math.abs(supp.awayTeamStats.avgShots - 28) < 0.001,
    `away usa media trasferta: atteso ~28, ottenuto ${supp.awayTeamStats.avgShots}`);
});

test('buildAsOfSupp combina gialli e falli sui due venue (come recomputeTeamAverages)', () => {
  const engine = new BacktestingEngine();
  // A prende 1 giallo in casa e 5 in trasferta: la media combinata deve stare in mezzo.
  const history = [
    mk('a-home', 'A', 'C', BASE + 0 * DAY, { homeYellowCards: 1, homeFouls: 8 }),
    mk('a-away', 'C', 'A', BASE + 1 * DAY, { awayYellowCards: 5, awayFouls: 18 }),
    mk('target', 'A', 'B', BASE + 10 * DAY, {}),
  ];
  const target = history.find((m) => m.matchId === 'target');
  const supp = engine.buildAsOfSupp(target, history);

  const y = supp.homeTeamStats.avgYellowCards;
  const f = supp.homeTeamStats.avgFouls;
  assert.ok(y > 1 && y < 5, `avgYellowCards combinato deve stare in (1,5), ottenuto ${y}`);
  assert.ok(f > 8 && f < 18, `avgFouls combinato deve stare in (8,18), ottenuto ${f}`);
});

test('buildAsOfSupp popola le statistiche arbitro solo dai match passati con lo stesso arbitro', () => {
  const engine = new BacktestingEngine();
  const withRef = (id, h, a, date, ref, y) => {
    const m = mk(id, h, a, date, { homeYellowCards: y, awayYellowCards: y, homeFouls: 10, awayFouls: 10 });
    m.referee = ref;
    return m;
  };
  const history = [
    withRef('r1', 'A', 'B', BASE + 0 * DAY, 'Rossi', 2),
    withRef('r2', 'C', 'D', BASE + 1 * DAY, 'Rossi', 4),
    withRef('r3', 'A', 'C', BASE + 2 * DAY, 'Bianchi', 0),
    withRef('target', 'A', 'D', BASE + 10 * DAY, 'Rossi', 0),
  ];
  const target = history.find((m) => m.matchId === 'target');
  const supp = engine.buildAsOfSupp(target, history);

  assert.ok(supp.refereeStats, 'refereeStats deve esistere per un arbitro con storico');
  assert.equal(supp.refereeStats.sampleSize, 2, 'solo le 2 partite passate di Rossi');
  // media gialli totali di Rossi = (2+2 + 4+4)/2 = 6
  assert.ok(Math.abs(supp.refereeStats.avgYellow - 6) < 0.001,
    `avgYellow atteso 6, ottenuto ${supp.refereeStats.avgYellow}`);
});

test('buildAsOfSupp lascia volutamente null i campi non ricavabili dallo storico', () => {
  const engine = new BacktestingEngine();
  const history = [
    mk('h1', 'A', 'B', BASE + 0 * DAY, { homeTotalShots: 12 }),
    mk('target', 'A', 'C', BASE + 10 * DAY, {}),
  ];
  const supp = engine.buildAsOfSupp(history[1], history);
  // Per design (vedi I1): questi dipendono da input di request non presenti nello storico.
  assert.equal(supp.competitiveness, undefined);
  assert.equal(supp.contextAdjustments, undefined);
  assert.equal(supp.leagueAvgYellow, undefined);
  assert.equal(supp.homeAdvantageShots, undefined);
  assert.equal(supp.homePlayers, undefined);
});
