const test = require('node:test');
const assert = require('node:assert/strict');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');
const { PoissonXgModel } = require('../dist/models/core/PoissonXgModel');
const { PredictionService } = require('../dist/services/PredictionService');
const { ValueBettingEngine } = require('../dist/models/value/ValueBettingEngine');
const start = Date.parse('2025-01-01T12:00:00.000Z');
const fixtures = (shots, sot = 3) => Array.from({ length: 31 }, (_, i) => ({
  matchId: `fixture-${i}`, homeTeamId: i % 2 ? 'B' : 'A', awayTeamId: i % 2 ? 'A' : 'B',
  date: new Date(start + i * 86400000), competition: 'Serie A', season: '2024/25',
  homeGoals: 1, awayGoals: 0, homeXG: 1.2, awayXG: 0.8,
  homeTotalShots: shots, awayTotalShots: shots, homeShotsOnTarget: sot, awayShotsOnTarget: sot,
  homeYellowCards: 2, awayYellowCards: 2, homeRedCards: 0, awayRedCards: 0,
}));
function stubFits(t) {
  t.mock.method(DixonColesModel.prototype, 'fitModel', function () { return this.getParams(); });
  t.mock.method(PoissonXgModel.prototype, 'fit', function () { return null; });
  t.mock.method(ValueBettingEngine.prototype, 'fitIsotonicCalibration', function () {
    return { calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
  });
}
function backtest(rows) {
  const result = new BacktestingEngine().simulateBacktestScenario(rows.slice(0, 30), [rows[30]], {}, 'high_only', {},
    { includeProbabilityObservations: true });
  return Object.fromEntries(result.probabilityObservations.filter((r) => r.stage === 'raw').map((r) => [r.selection, r.probability]));
}

test('chronological backtest requires total-shot and SOT samples; complete zero observations remain eligible', (t) => {
  stubFits(t);
  const incomplete = backtest(fixtures(null));
  const complete = backtest(fixtures(10));
  const realZero = backtest(fixtures(0, 0));
  assert.equal(incomplete.shotsOTOver55, undefined);
  assert.ok(Number.isFinite(complete.shotsOTOver55));
  assert.ok(Number.isFinite(realZero.shotsOTOver55));
  assert.equal(incomplete.homeWin, complete.homeWin);
});

test('chronological calibration receives no SOT samples without total-shot coverage', async (t) => {
  stubFits(t);
  t.mock.method(DixonColesModel.prototype, 'computeFullProbabilitiesWithMatrix', () => ({
    full: { flatProbabilities: { homeWin: .51, draw: .25, awayWin: .24, shotsOTOver55: .37 } },
    matrix: { probabilities: [] },
  }));
  const run = async (shots) => {
    const input = fixtures(shots).map((m) => ({ match_id: m.matchId, home_team_id: m.homeTeamId, away_team_id: m.awayTeamId,
      date: m.date.toISOString(), competition: m.competition, season: m.season, home_goals: m.homeGoals, away_goals: m.awayGoals,
      home_xg: m.homeXG, away_xg: m.awayXG, home_shots: m.homeTotalShots, away_shots: m.awayTotalShots,
      home_shots_on_target: m.homeShotsOnTarget, away_shots_on_target: m.awayShotsOnTarget,
      home_yellow_cards: 2, away_yellow_cards: 2, home_red_cards: 0, away_red_cards: 0 }));
    const service = new PredictionService({ getMatches: async () => input, getHistoricalOddsDetailMap: async () => ({}) },
      { getMatchDetails: async () => { throw new Error('unexpected provider'); } });
    const captured = [];
    service.engine.fitIsotonicCalibration = (probabilities) => {
      captured.push(...probabilities);
      return { calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    };
    await service.getCalibrationProfile('Serie A', true, new Date(start + 32 * 86400000));
    return captured;
  };
  const incomplete = await run(null);
  const complete = await run(10);
  assert.ok(incomplete.includes(.51));
  assert.ok(!incomplete.includes(.37));
  assert.ok(complete.includes(.37));
});
