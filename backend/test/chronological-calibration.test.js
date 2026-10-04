const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { buildChronologicalForecasts, buildChronologicalForecastsAsync, HISTORICAL_RESULT_DELAY_MS } = require('../dist/services/ChronologicalForecastService.js');
const { PredictionService } = require('../dist/services/PredictionService.js');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');
const blendLearning = require('../dist/services/MarketBlendLearningService.js');

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse('2023-08-01T12:00:00Z');
const PREMATCH_KEYS = ['awayTeamId', 'competition', 'date', 'homeTeamId', 'matchId', 'referee', 'season'];

function match(index, timestamp = START + index * DAY) {
  return {
    matchId: `fixture-${index}`, homeTeamId: 'A', awayTeamId: 'B',
    date: new Date(timestamp), competition: 'Serie A', season: '2023', referee: 'Ref',
    homeGoals: index % 4, awayGoals: index % 3, homeXG: 0.8 + (index % 5) / 5,
    awayXG: 0.6 + (index % 4) / 5, homeTotalShots: 12, awayTotalShots: 8,
    homeShotsOnTarget: 5, awayShotsOnTarget: 3,
    homeYellowCards: 2, awayYellowCards: 1,
    homePossession: 60, awayPossession: 40,
    homePlayers: [{ name: 'Post-match player', goals: 3 }],
  };
}

function row(fixture) {
  return {
    match_id: fixture.matchId, home_team_id: fixture.homeTeamId,
    away_team_id: fixture.awayTeamId, date: fixture.date.toISOString(),
    competition: fixture.competition, season: fixture.season, referee: fixture.referee,
    home_goals: fixture.homeGoals, away_goals: fixture.awayGoals,
    home_xg: fixture.homeXG, away_xg: fixture.awayXG,
    home_shots: fixture.homeTotalShots, away_shots: fixture.awayTotalShots,
    home_shots_on_target: fixture.homeShotsOnTarget,
    away_shots_on_target: fixture.awayShotsOnTarget,
    team_stats_json: JSON.stringify({ future: 'post-match payload' }),
  };
}

function stubHistoricalModels(t) {
  const fitted = [];
  const params = new DixonColesModel().getParams();
  t.mock.method(DixonColesModel.prototype, 'fitModel', (past, _teams, _iterations, _rate, options) => {
    fitted.push({ past, referenceDate: options.referenceDate });
    assert.ok(options.referenceDate instanceof Date);
    assert.ok(past.every((fixture) => fixture.date.getTime() + HISTORICAL_RESULT_DELAY_MS <= options.referenceDate.getTime()));
    return structuredClone(params);
  });
  t.mock.method(DixonColesModel.prototype, 'computeFullProbabilities', (_home, _away, homeXG) => ({
    flatProbabilities: { homeWin: 0.3 + homeXG / 10, draw: 0.25, awayWin: 0.45 - homeXG / 10 },
  }));
  return fitted;
}

function isolatedService(db) {
  const service = new PredictionService(db, { getMatchDetails: async () => { throw new Error('Unexpected provider call'); } });
  const targets = [];
  service.backtester.buildAsOfPredictionContext = (target, past) => {
    assert.deepEqual(Object.keys(target).sort(), PREMATCH_KEYS);
    assert.ok(past.every((fixture) => fixture.date.getTime() + HISTORICAL_RESULT_DELAY_MS <= target.date.getTime()));
    targets.push(target);
    return { homeXG: past.reduce((sum, fixture) => sum + fixture.homeXG, 0) / past.length, awayXG: 1, supplementaryData: {} };
  };
  // Isolate chronology and calibration from the independently tested ensemble.
  service.applyEnsembleBlend = (flat) => ({ ...flat });
  service.enrichFlatProbabilities = () => {};
  return { service, targets };
}

test('chronological forecasts exclude simultaneous and unfinished results and pass only prematch fields', () => {
  const kickoff = START + 5 * DAY;
  const fixtures = [match(0), match(1, kickoff - HISTORICAL_RESULT_DELAY_MS),
    match(2, kickoff - HISTORICAL_RESULT_DELAY_MS + 1), match(3, kickoff - 60 * 60 * 1000),
    match(4, kickoff), match(5, kickoff)];
  const forecasts = buildChronologicalForecasts(fixtures, {
    asOf: new Date(kickoff + HISTORICAL_RESULT_DELAY_MS), minTrainingMatches: 1, refitIntervalMs: 0,
    createPredictor: (training, referenceDate) => {
      assert.ok(training.every((fixture) => fixture.date.getTime() + HISTORICAL_RESULT_DELAY_MS <= referenceDate.getTime()));
      return (target, availablePast) => {
        assert.deepEqual(Object.keys(target).sort(), PREMATCH_KEYS);
        if (target.date.getTime() === kickoff) {
          assert.deepEqual(availablePast.map((fixture) => fixture.matchId), ['fixture-0', 'fixture-1']);
        }
        return { homeWin: availablePast.length / 10 };
      };
    },
  });
  assert.equal(forecasts.filter((forecast) => forecast.match.date.getTime() === kickoff).length, 2);
  assert.ok(forecasts.every((forecast) => forecast.availableAt === forecast.match.date.getTime() + HISTORICAL_RESULT_DELAY_MS));
});

test('tampering target outcomes, realized xG and future rows does not alter earlier out-of-sample forecasts', () => {
  const fixtures = Array.from({ length: 45 }, (_, index) => match(index));
  function replay(input) {
    return buildChronologicalForecasts(input, {
      asOf: new Date(START + 44 * DAY + HISTORICAL_RESULT_DELAY_MS), minTrainingMatches: 30,
      createPredictor: (past) => {
        const fittedMean = past.reduce((sum, fixture) => sum + fixture.homeGoals + fixture.homeXG, 0) / past.length;
        return (target, availablePast) => {
          assert.deepEqual(Object.keys(target).sort(), PREMATCH_KEYS);
          return { homeWin: fittedMean / 10, over25: availablePast.reduce((sum, fixture) => sum + fixture.homeGoals, 0) / (10 * availablePast.length) };
        };
      },
    }).filter((forecast) => forecast.match.date.getTime() <= fixtures[35].date.getTime())
      .map((forecast) => [forecast.match.matchId, forecast.probabilities]);
  }
  const poisoned = fixtures.map((fixture, index) => index < 35 ? fixture : {
    ...fixture, homeGoals: 90, awayGoals: 80, homeXG: 999, homeTotalShots: 999,
    homePlayers: [{ goals: 999 }],
  });
  poisoned.push(match(999, START + 1000 * DAY));
  assert.deepEqual(replay(poisoned), replay(fixtures));
});

test('global historical exports keep training cohorts and cached predictors separate by league', () => {
  const fixtures = Array.from({ length: 40 }, (_, index) => match(index));
  const otherLeague = fixtures.map((fixture) => ({
    ...fixture, matchId: `other-${fixture.matchId}`, competition: 'La Liga', homeGoals: 7,
  }));
  const fits = new Map();
  const forecasts = buildChronologicalForecasts([...otherLeague, ...fixtures], {
    asOf: new Date(START + 41 * DAY),
    createPredictor: (past) => {
      const league = past[0].competition;
      assert.ok(past.every((fixture) => fixture.competition === league));
      fits.set(league, (fits.get(league) ?? 0) + 1);
      return (target, availablePast) => {
        assert.equal(target.competition, league);
        assert.ok(availablePast.every((fixture) => fixture.competition === league));
        return { homeWin: league === 'Serie A' ? 0.4 : 0.7 };
      };
    },
  });
  assert.equal(forecasts.length, 20);
  assert.deepEqual([...fits.keys()].sort(), ['La Liga', 'Serie A']);
  assert.ok(forecasts.every((forecast) => forecast.probabilities.homeWin === (forecast.match.competition === 'Serie A' ? 0.4 : 0.7)));
});

test('async chronological replay yields before completion and preserves synchronous forecast results', async () => {
  const fixtures = Array.from({ length: 26 }, (_, index) => match(index));
  let fits = 0;
  const options = {
    asOf: new Date(START + 27 * DAY), minTrainingMatches: 1, refitIntervalMs: 0,
    createPredictor: (past) => {
      fits++;
      return () => ({ homeWin: past.length / 30 });
    },
  };
  const duringReplay = new Promise((resolve) => setImmediate(() => resolve(fits)));
  const pendingForecasts = buildChronologicalForecastsAsync(fixtures, options);
  const observedFits = await duringReplay;
  assert.ok(observedFits > 0 && observedFits < 25, 'another event-loop callback must run before all 25 fits finish');
  const forecasts = await pendingForecasts;
  assert.equal(fits, 25);
  assert.equal(forecasts.length, 25);
  assert.deepEqual(forecasts, buildChronologicalForecasts(fixtures, options));
});

test('calibration profile cutoff excludes future results and rejects incomplete or malformed labels', async (t) => {
  stubHistoricalModels(t);
  const fixtures = Array.from({ length: 70 }, (_, index) => match(index));
  const cutoff = new Date(fixtures[55].date.getTime() + HISTORICAL_RESULT_DELAY_MS);
  const validRows = fixtures.map(row);
  const poisonedRows = validRows.map((entry, index) => index <= 55 ? entry : {
    ...entry, home_goals: 90, away_goals: 80, home_xg: 999, home_shots: 999,
  });
  poisonedRows.push({ ...row(match(100)), date: fixtures[20].date.toISOString(), home_goals: null });
  poisonedRows.push({ ...row(match(101)), date: fixtures[20].date.toISOString(), home_goals: 'NaN' });
  poisonedRows.push({ ...row(match(102)), date: 'invalid' });
  const baseline = isolatedService({ getMatches: async () => validRows });
  const poisoned = isolatedService({ getMatches: async () => poisonedRows });
  const first = await baseline.service.getCalibrationProfile('Serie A', false, cutoff);
  const second = await poisoned.service.getCalibrationProfile('Serie A', false, cutoff);
  assert.deepEqual(second, first);
  assert.equal(first.nObservations, 26 * 3);
  assert.equal(baseline.targets.length, 26);
});

test('one historical DB load serves concurrent calibration requests and cached fixtures; sparse data keeps identity', async (t) => {
  const fitted = stubHistoricalModels(t);
  const fixtures = Array.from({ length: 100 }, (_, index) => match(index));
  let reads = 0;
  let oddsReads = 0;
  let resolveRows;
  const pendingRows = new Promise((resolve) => { resolveRows = resolve; });
  const { service, targets } = isolatedService({
    getMatches: async () => { reads++; return pendingRows; },
    getHistoricalOddsDetailMap: async () => { oddsReads++; return {}; },
  });
  const cutoff = new Date(START + 100 * DAY);
  const earlierCutoff = new Date(START + 35 * DAY);
  const requests = Array.from({ length: 3 }, () => service.getCalibrationProfile('Serie A', false, cutoff));
  const pendingEarlier = service.getCalibrationProfile('Serie A', false, earlierCutoff);
  assert.equal(reads, 1);
  resolveRows(fixtures.map(row));
  const profiles = await Promise.all(requests);
  assert.strictEqual(profiles[0], profiles[1]);
  assert.strictEqual(profiles[1], profiles[2]);
  assert.deepEqual(await service.getCalibrationProfile('Serie A', false, cutoff), profiles[0]);
  assert.equal(reads, 1);
  assert.equal(oddsReads, 1);
  const concurrentEarlier = await pendingEarlier;
  assert.equal(targets.length, 75, '70 forecasts at the later cutoff plus five at the earlier cutoff');
  assert.ok(fitted.length > 1 && fitted.length < targets.length);
  const earlier = await service.getCalibrationProfile('Serie A', false, earlierCutoff);
  assert.equal(reads, 1, 'different historical cutoffs share the same single-flight historical input load');
  assert.deepEqual(earlier, concurrentEarlier);
  assert.ok(earlier.nObservations < profiles[0].nObservations);
  assert.equal(service.calibrationCache.size, 2, 'historical cutoffs retain separate calculated profiles');
  await service.getCalibrationProfile('Serie A');
  assert.equal(reads, 1, 'live calibration shares the historical inputs without another DB scan');
  assert.equal(oddsReads, 1);
  assert.equal(service.calibrationCache.size, 3, 'live calibration retains its own calculated profile');
  const sparse = isolatedService({ getMatches: async () => fixtures.slice(0, 30).map(row) });
  const identity = await sparse.service.getCalibrationProfile('Serie A', false, cutoff);
  assert.deepEqual(identity, { calibrationPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }], nObservations: 0, byFamily: {}, learnedBlendWeights: {} });
});

test('calibration profile cache is bounded, evicts the least recently used cutoff and prunes expired inputs', async (t) => {
  const liveTimestamp = Date.parse('2026-10-04T12:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: liveTimestamp });
  let reads = 0;
  let oddsReads = 0;
  const { service } = isolatedService({
    getMatches: async () => { reads++; return []; },
    getHistoricalOddsDetailMap: async () => { oddsReads++; return {}; },
  });
  for (let index = 0; index < 32; index++) {
    await service.getCalibrationProfile('Serie A', false, new Date(START + index * DAY));
  }
  const originalKeys = [...service.calibrationCache.keys()];
  assert.equal(originalKeys.length, 32);
  await service.getCalibrationProfile('Serie A', false, new Date(START));
  await service.getCalibrationProfile('Serie A', false, new Date(START + 32 * DAY));
  assert.equal(service.calibrationCache.size, 32);
  assert.ok(service.calibrationCache.has(originalKeys[0]), 'the recently touched cutoff must survive eviction');
  assert.ok(!service.calibrationCache.has(originalKeys[1]), 'the least recently used cutoff must be evicted');
  assert.equal(reads, 1, 'eviction of derived profiles must not reload shared inputs');
  assert.equal(oddsReads, 1);
  t.mock.timers.setTime(liveTimestamp + 6 * 60 * 60 * 1000);
  await service.getCalibrationProfile('Serie A', false, new Date(START));
  assert.equal(reads, 2, 'expired shared inputs must be refreshed at the TTL boundary');
  assert.equal(oddsReads, 2);
  assert.equal(service.calibrationCache.size, 1, 'all expired derived profiles must be pruned');
  assert.equal(service.calibrationInputs.size, 1);
});

test('historical input cache stays bounded across competitions', async () => {
  let reads = 0;
  const { service } = isolatedService({ getMatches: async () => { reads++; return []; } });
  await service.getCalibrationProfile('League 0', false, new Date(START));
  const firstKey = [...service.calibrationInputs.keys()][0];
  for (let index = 1; index < 9; index++) {
    await service.getCalibrationProfile(`League ${index}`, false, new Date(START));
  }
  assert.equal(reads, 9);
  assert.equal(service.calibrationInputs.size, 8);
  assert.ok(!service.calibrationInputs.has(firstKey));
});

for (const competition of ['Serie A', undefined]) {
  test(`a completed fit invalidates pending ${competition ?? 'global'} calibration loads without recaching stale results`, async () => {
    let resolveOld;
    let resolveNew;
    const oldRows = new Promise((resolve) => { resolveOld = resolve; });
    const newRows = new Promise((resolve) => { resolveNew = resolve; });
    const fixtures = Array.from({ length: 35 }, (_, index) => match(index));
    let reads = 0;
    const { service } = isolatedService({
      getMatches: async (options) => {
        if (options.competition === 'La Liga') return [];
        if (options.season === 'fit-run') return fixtures.slice(0, 20).map(row);
        reads++;
        if (reads === 1) return oldRows;
        if (reads === 2) return newRows;
        throw new Error('Unexpected duplicate historical input load');
      },
      getHistoricalOddsDetailMap: async () => ({}),
      updateTeamModelStrengthsBatch: async () => {},
      saveModelParams: async () => {},
    });
    const cutoff = new Date(START + 40 * DAY);
    await service.getCalibrationProfile('La Liga', false, cutoff);
    const leagueKey = service.getCalibrationCacheKey('La Liga');
    const unaffectedProfileKey = `${leagueKey}:${cutoff.toISOString()}`;
    const unaffectedProfile = service.calibrationCache.get(unaffectedProfileKey);
    const unaffectedInputs = service.calibrationInputs.get(leagueKey);
    const staleRequest = service.getCalibrationProfile(competition, false, cutoff);
    assert.equal(reads, 1);
    await service.fitModelForCompetition('Serie A', 'fit-run', undefined, undefined, { recomputeTeamAverages: false });
    const freshRequest = service.getCalibrationProfile(competition, false, cutoff);
    assert.equal(reads, 2, 'requests after a fit must not join the previous generation');
    const key = service.getCalibrationCacheKey(competition);
    const profileKey = `${key}:${cutoff.toISOString()}`;
    const pendingInputs = service.calibrationInputLoads.get(key);
    const pendingProfile = service.calibrationLoads.get(`${profileKey}:cached`);
    resolveOld([]);
    const stale = await staleRequest;
    assert.equal(stale.nObservations, 0);
    assert.ok(!service.calibrationInputs.has(key), 'the completed stale input load must not populate the cache');
    assert.ok(!service.calibrationCache.has(profileKey), 'the completed stale profile must not populate the cache');
    assert.strictEqual(service.calibrationInputLoads.get(key), pendingInputs, 'old finally must preserve the newer input load');
    assert.strictEqual(service.calibrationLoads.get(`${profileKey}:cached`), pendingProfile, 'old finally must preserve the newer profile load');
    assert.strictEqual(service.calibrationCache.get(unaffectedProfileKey), unaffectedProfile);
    assert.strictEqual(service.calibrationInputs.get(leagueKey), unaffectedInputs);
    const joinedFreshRequest = service.getCalibrationProfile(competition, false, cutoff);
    assert.equal(reads, 2, 'later callers still join the current generation');
    resolveNew(fixtures.map(row));
    const [fresh, joined] = await Promise.all([freshRequest, joinedFreshRequest]);
    assert.strictEqual(fresh, joined);
    assert.ok(fresh.nObservations > 0);
    assert.equal(service.calibrationInputs.get(key).rows.length, 35);
    assert.equal(service.calibrationCache.get(profileKey).observations, fresh.nObservations);
    assert.deepEqual(await service.getCalibrationProfile(competition, false, cutoff), fresh);
    assert.equal(reads, 2);
  });
}

test('learned blending calibrates each forecast with prior finished samples and entry odds, never closing odds', async (t) => {
  stubHistoricalModels(t);
  const fixtures = Array.from({ length: 70 }, (_, index) => match(index));
  const kickoff = START + 31 * DAY;
  fixtures[30].date = new Date(kickoff);
  fixtures[31].date = new Date(kickoff);
  fixtures[32].date = new Date(kickoff + 60 * 60 * 1000);
  fixtures[33].date = new Date(kickoff + HISTORICAL_RESULT_DELAY_MS);
  const entryOdds = { homeWin: 1.9, draw: 3.3, awayWin: 4.1 };
  const closingOdds = { homeWin: 9, draw: 9, awayWin: 9 };
  const odds = Object.fromEntries(fixtures.map((fixture) => [fixture.matchId, { odds: entryOdds, closingOdds }]));
  const { service } = isolatedService({
    getMatches: async () => fixtures.map(row), getHistoricalOddsDetailMap: async () => odds,
  });
  const counts = [];
  const marketInputs = [];
  let learnedSamples;
  const originalCalibrate = service.engine.calibrate.bind(service.engine);
  t.mock.method(service.engine, 'calibrate', (raw, points, count) => {
    counts.push(count); return originalCalibrate(raw, points, count);
  });
  const originalGroups = service.engine.buildMarketGroups.bind(service.engine);
  t.mock.method(service.engine, 'buildMarketGroups', (input) => {
    marketInputs.push(input); return originalGroups(input);
  });
  const originalLearn = blendLearning.learnBlendWeights;
  t.mock.method(blendLearning, 'learnBlendWeights', (samples) => {
    learnedSamples = samples; return originalLearn(samples);
  });
  const profile = await service.getCalibrationProfile('Serie A', false, new Date(START + 71 * DAY));
  assert.deepEqual(counts.slice(0, 12), [0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 6, 6]);
  assert.equal(marketInputs.length, 40);
  assert.ok(marketInputs.every((input) => input === entryOdds));
  assert.equal(learnedSamples.length, 40 * 3);
  const expectedHome = blendLearning.noVigProbability(entryOdds.homeWin, [entryOdds.draw, entryOdds.awayWin]);
  assert.ok(Math.abs(learnedSamples[0].marketProbNoVig - expectedHome) < 1e-12);
  assert.ok(profile.learnedBlendWeights.goal_1x2.sampleSize >= 80);
});

test('bounded replay produces 450 forecasts with weekly refits and a single DB scan', async (t) => {
  const fitted = stubHistoricalModels(t);
  let reads = 0;
  const fixtures = Array.from({ length: 600 }, (_, index) => match(index));
  const { service, targets } = isolatedService({ getMatches: async () => { reads++; return fixtures.map(row); } });
  const started = performance.now();
  const profile = await service.getCalibrationProfile('Serie A', false, new Date(START + 600 * DAY));
  const elapsed = performance.now() - started;
  assert.equal(targets.length, 450);
  assert.equal(profile.nObservations, 450 * 3);
  assert.equal(reads, 1);
  assert.ok(fitted.length > 1 && fitted.length < 100);
  t.diagnostic(`Synthetic replay: 450 forecasts, ${fitted.length} stubbed DC refits, one DB scan, ${elapsed.toFixed(1)} ms. This measures orchestration, not production DC fitting.`);
});
