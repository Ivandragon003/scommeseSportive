const assert = require('node:assert/strict');

function loadDefaultOperationalModules() {
  const defaults = { MODEL_HOME_ADVANTAGE_SCALE: '.5', MODEL_WEIGHT_FORM: '.12',
    MODEL_WEIGHT_MOTIVATION: '.06', MODEL_WEIGHT_ABSENCES: '.05', MODEL_WEIGHT_DISCIPLINE: '.03',
    MODEL_MARKET_MIN_SAMPLE: '8', MODEL_MARKET_MIN_COMBINED_SAMPLE: '20', PLAYER_GOALS_XG_SHRINK: '.88' };
  const previous = Object.fromEntries(Object.keys(defaults).map((key) => [key, process.env[key]]));
  Object.assign(process.env, defaults);
  try {
    return { ...require('../../../dist/services/PredictionService'),
      ...require('../../../dist/models/core/DixonColesModel') };
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}
const { PredictionService, alignOddsKeysInternal, DixonColesModel } = loadDefaultOperationalModules();

const AS_OF = '2026-10-30T10:00:00.000Z';
const BOOKMAKER = '[TEST ONLY] fixed price sheet; no bookmaker observation';
const baseOdds = {
  homeWin: 2.7, draw: 3.9, awayWin: 3.5, over25: 2.2, under25: 1.9,
  over15: 1.5, under15: 3.4, btts: 2.1, bttsNo: 1.9,
  double_chance_1x: 1.55, double_chance_x2: 1.65, double_chance_12: 1.4,
  dnb_home: 2.05, dnb_away: 2.05,
  'cards_total_over_2.5': 1.65, 'cards_total_under_2.5': 2.3,
  'cards_total_over_4.5': 2.15, 'cards_total_under_4.5': 1.95,
  'yellow_over_3.5': 2, 'yellow_under_3.5': 2,
  'shots_total_over_19.5': 2, 'shots_total_under_19.5': 2,
  'shots_home_over_10.5': 1.9, 'shots_home_under_10.5': 2.1,
  'shots_away_over_8.5': 1.9, 'shots_away_under_8.5': 2.1,
  'sot_total_over_6.5': 2.1, 'sot_total_under_6.5': 1.9,
  'ahcp_0.5': 2, 'ahcp_away_0.5': 2,
  'corners_over_8.5': 3, 'corners_under_8.5': 3,
  'fouls_over_20.5': 3, 'fouls_under_20.5': 3,
};
const scenarios = [
  { id: 'balanced-full-market', attack: [.15, -.05], coverage: 100, samples: 28 },
  { id: 'cards-and-shots-only', attack: [.32, -.24], coverage: 100, samples: 32, statsOnly: true,
    request: { isDerby: true, competitiveness: .8, homeFormIndex: .7, awayFormIndex: .4 } },
  { id: 'cards-main-recommendation', attack: [.15, -.05], coverage: 100, samples: 28, cardsOnly: true },
  { id: 'weak-history-and-calibration', attack: [-.3, .45], coverage: 42, samples: 5, calibrationN: 12 },
  { id: 'dc-without-poisson-partner', attack: [.5, -.45], coverage: 95, samples: 30, noPoisson: true },
  { id: 'no-real-price-available', attack: [.15, -.05], coverage: 100, samples: 28, noOdds: true },
];

function teamRow(teamId, sample, away = false) {
  const venue = { sampleSize: sample, avgPossession: away ? 47 : 54,
    varShots: away ? 17 : 23, varShotsOT: away ? 6 : 8, varYellowCards: 3.5,
    varFouls: 17, avgCornersConceded: away ? 5.8 : 4.8 };
  return { team_id: teamId, name: `[TEST ONLY] ${teamId}`, competition: 'Regression Test League',
    avg_home_shots: away ? 12.4 : 14.1, avg_away_shots: away ? 10.9 : 12.8,
    avg_home_shots_ot: away ? 4.4 : 5.1, avg_away_shots_ot: away ? 3.8 : 4.6,
    avg_home_xg: away ? 1.15 : 1.7, avg_away_xg: away ? 1.05 : 1.45,
    avg_yellow_cards: away ? 2.35 : 1.9, avg_red_cards: away ? .13 : .08,
    avg_fouls: away ? 13 : 11.6, shots_suppression: away ? 1.12 : .92,
    matches_played: sample * 2, avg_home_corners: 5.5, avg_away_corners: 4.5,
    team_stats_json: JSON.stringify({ computed: { home: venue, away: venue,
      rates: { foulsDrawnPerMatch: away ? 11.8 : 13.2 } } }) };
}

function calibrationProfile(n = 420) {
  const points = [{ x: .05, y: .08 }, { x: .25, y: .28 }, { x: .5, y: .47 },
    { x: .75, y: .71 }, { x: .95, y: .91 }];
  return { calibrationPoints: points, nObservations: n, byFamily: {
    goal_1x2: { points, nObservations: n },
    yellow_cards: { points: [{ x: .05, y: .04 }, { x: .35, y: .31 }, { x: .7, y: .64 }, { x: .95, y: .9 }], nObservations: n },
    shots: { points: [{ x: .05, y: .09 }, { x: .4, y: .45 }, { x: .8, y: .77 }, { x: .95, y: .92 }], nObservations: n },
  }, learnedBlendWeights: {} };
}

function stable(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(10)) : String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => entry !== undefined && !['predictionId', 'codeHash', 'stateHash', 'version'].includes(key))
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stable(entry)]));
  return value;
}

async function runScenario(scenario) {
  const originalDate = global.Date, originalRandom = Math.random;
  const previousEnv = Object.fromEntries(['PLAYER_DATA_ENABLED', 'PLAYER_AVAILABILITY_ENABLED',
    'PREDICTION_MIN_CALIBRATION_SAMPLE', 'PREDICTION_ANOMALOUS_EV_PERCENT'].map((key) => [key, process.env[key]]));
  let seed = 0x3a5e91;
  global.Date = class extends originalDate {
    constructor(...args) { super(...(args.length ? args : [AS_OF])); }
    static now() { return originalDate.parse(AS_OF); }
  };
  Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + .5) / 4294967296; };
  process.env.PLAYER_DATA_ENABLED = 'false';
  process.env.PLAYER_AVAILABILITY_ENABLED = 'false';
  process.env.PREDICTION_MIN_CALIBRATION_SAMPLE = '30';
  process.env.PREDICTION_ANOMALOUS_EV_PERCENT = '15';
  try {
    const params = new DixonColesModel().getParams();
    params.attackParams = { home: scenario.attack[0], away: scenario.attack[1] };
    params.defenceParams = { home: .05, away: -.03 };
    params.levelCorrection = { home: 1.08, away: 1.03 };
    if (!scenario.noPoisson) params.poissonXg = { leagueXG: 1.4, homeAdv: 1.12, levelScale: 1.03,
      attackRate: { home: 1.2, away: .9 }, defRate: { home: .92, away: 1.08 } };
    const fixture = { match_id: `test-only-${scenario.id}`, home_team_id: 'home', away_team_id: 'away',
      home_team_name: '[TEST ONLY] home', away_team_name: '[TEST ONLY] away',
      date: '2026-10-31T19:00:00.000Z', home_goals: null, away_goals: null,
      competition: 'Regression Test League', season: 'TEST-ONLY', referee: 'TEST ONLY REFEREE' };
    const readCalls = [];
    const db = {
      getLatestModelParams: async () => { readCalls.push('model'); return { params }; },
      getTeamsByIds: async (ids) => ids.map((id) => teamRow(id, scenario.samples, id === 'away')),
      getMatchById: async () => fixture,
      getTeamHistoricalCoverageBatch: async () => ({
        home: { coveragePercent: scenario.coverage }, away: { coveragePercent: scenario.coverage },
      }),
      getTeamScheduleInsightsBatch: async () => ({ home: { restDays: 6, matchesInLast14Days: 2 },
        away: { restDays: 4, matchesInLast14Days: 3 } }),
      getRefereeByName: async () => ({ name: 'TEST ONLY REFEREE', avg_yellow_cards_per_game: 4.6,
        avg_red_cards_per_game: .19, avg_fouls_per_game: 24, total_games: 40, sample_size: 40 }),
      getLearningReviews: async () => [{ reviewType: 'model_confirmed', review: {
        reviewSource: 'historical_bookmaker_snapshot', learningWeight: 1,
        recommendedSelection: { selection: 'shots_total_over_19.5', result: 'WON' } } }],
      appendPredictions: async () => assert.fail('Golden inference must not write prediction audit'),
    };
    const service = new PredictionService(db, { getMatchDetails: async () => assert.fail('No provider calls in regression fixture') });
    // Supply frozen historical calibration evidence, while preserving its real application,
    // the DC/Poisson/count models, context, adaptive tuning, market blend, filters and picker.
    const profile = calibrationProfile(scenario.calibrationN);
    service.getCalibrationProfile = async () => { readCalls.push('frozen-calibration'); return profile; };
    const odds = Object.fromEntries(Object.entries(baseOdds).filter(([selection]) => scenario.cardsOnly
      ? /^(cards_total_|yellow_)/.test(selection)
      : !scenario.statsOnly || /^(cards_total_|yellow_|shots_|sot_|corners_|fouls_)/.test(selection)));
    if (scenario.noOdds) for (const key of Object.keys(odds)) delete odds[key];
    const request = { homeTeamId: 'home', awayTeamId: 'away', matchId: fixture.match_id,
      competition: fixture.competition, season: fixture.season, ...scenario.request };
    const result = await service.predict(request, { asOf: AS_OF, recordAudit: false,
      sharedOdds: { odds, bookmakerBySelection: Object.fromEntries(Object.keys(odds).map((key) => [key, BOOKMAKER])),
        source: 'odds_api', capturedAt: '2026-10-30T09:59:30.000Z' } });
    const packet = result.canonicalRecommendation;
    const diagnosticSelections = ['homeWin', 'cardsTotalOver25', 'shotsOver195', 'shotsOTOver65',
      'corners_over_8.5', 'fouls_over_20.5'];
    const diagnostics = Object.fromEntries(diagnosticSelections.map((selection) => [selection,
      service.engine.diagnoseSelection(result.probabilities.flatProbabilities, alignOddsKeysInternal(odds), selection)]));
    return stable({ scenario: scenario.id, raw: result.probabilities.flatProbabilities,
      calibrationEvidence: profile, tuning: service.engine.getAdaptiveTuning(),
      valueOpportunities: result.valueOpportunities, speculativeOpportunities: result.speculativeOpportunities,
      bestValueOpportunity: result.bestValueOpportunity, bestBetDecision: result.bestBetDecision,
      packet, analysisFactors: result.analysisFactors, modelConfidence: result.modelConfidence,
      modelUncertainty: result.modelUncertainty, historicalCoverage: result.historicalCoverage,
      diagnostics, readCalls });
  } finally {
    global.Date = originalDate; Math.random = originalRandom;
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

module.exports = { scenarios, runScenario, BOOKMAKER };
