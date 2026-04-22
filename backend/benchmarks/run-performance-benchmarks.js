const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const { buildBacktestReport } = require('../dist/services/BacktestReportService.js');
const { EurobetOddsService } = require('../dist/services/EurobetOddsService.js');
const { PredictionService, summarizeBudgetBetsInternal } = require('../dist/services/PredictionService.js');
const { BacktestingEngine } = require('../dist/models/backtesting/BacktestingEngine.js');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');
const { mergeOddsMatchMarkets } = require('../dist/services/odds-provider/oddsProviderUtils.js');

const DEFAULT_OPENING_BANKROLL = 1000;
const LEGACY_EV_BUCKETS = [
  { key: 'lt_0', label: '< 0%', min: Number.NEGATIVE_INFINITY, max: 0 },
  { key: '0_2', label: '0% - 2%', min: 0, max: 0.02 },
  { key: '2_5', label: '2% - 5%', min: 0.02, max: 0.05 },
  { key: '5_8', label: '5% - 8%', min: 0.05, max: 0.08 },
  { key: '8_12', label: '8% - 12%', min: 0.08, max: 0.12 },
  { key: 'gte_12', label: '>= 12%', min: 0.12, max: Number.POSITIVE_INFINITY },
];
const LEGACY_EDGE_BUCKETS = [
  { key: 'lt_0', label: '< 0 pp', min: Number.NEGATIVE_INFINITY, max: 0 },
  { key: '0_2', label: '0 - 2 pp', min: 0, max: 0.02 },
  { key: '2_5', label: '2 - 5 pp', min: 0.02, max: 0.05 },
  { key: '5_8', label: '5 - 8 pp', min: 0.05, max: 0.08 },
  { key: 'gte_8', label: '>= 8 pp', min: 0.08, max: Number.POSITIVE_INFINITY },
];
const LEGACY_PROBABILITY_BUCKETS = Array.from({ length: 10 }, (_, index) => ({
  key: `${index * 10}_${(index + 1) * 10}`,
  label: `${index * 10}% - ${(index + 1) * 10}%`,
  min: index / 10,
  max: (index + 1) / 10,
}));

function legacyNormalizeSource(value) {
  const source = String(value ?? '').trim().toLowerCase();
  if (!source) return 'unknown';
  if (source.includes('eurobet')) return 'eurobet_scraper';
  if (source.includes('fallback') || source.includes('odds_api')) return 'fallback';
  if (source.includes('synthetic') || source.includes('model_estimated')) return 'synthetic';
  return source;
}

function legacySafePercent(numerator, denominator) {
  return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? (numerator / denominator) * 100
    : 0;
}

function legacyToFinite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function createLegacySummaryAccumulator() {
  return {
    totalBets: 0,
    totalStaked: 0,
    totalReturn: 0,
    netProfit: 0,
    wins: 0,
    brierLossSum: 0,
    logLossSum: 0,
    expectedProfit: 0,
    oddsSum: 0,
    probabilitySum: 0,
    edgeSum: 0,
  };
}

function accumulateLegacySummary(summary, bet) {
  const stake = legacyToFinite(bet.stake);
  const profit = legacyToFinite(bet.profit);
  const probability = Math.min(0.999999, Math.max(0.000001, legacyToFinite(bet.ourProbability)));
  const won = Boolean(bet.won);

  summary.totalBets += 1;
  summary.totalStaked += stake;
  summary.totalReturn += profit + stake;
  summary.netProfit += profit;
  summary.wins += won ? 1 : 0;
  summary.brierLossSum += (legacyToFinite(bet.ourProbability) - (won ? 1 : 0)) ** 2;
  summary.logLossSum += won ? Math.log(probability) : Math.log(1 - probability);
  summary.expectedProfit += stake * legacyToFinite(bet.expectedValue);
  summary.oddsSum += legacyToFinite(bet.odds);
  summary.probabilitySum += legacyToFinite(bet.ourProbability);
  summary.edgeSum += legacyToFinite(bet.edge);
}

function finalizeLegacySummary(summary, openingBankroll) {
  const totalBets = summary.totalBets;
  const totalStaked = summary.totalStaked;
  const totalReturn = summary.totalReturn;
  const netProfit = summary.netProfit;
  const wins = summary.wins;
  const brierScore = totalBets > 0 ? summary.brierLossSum / totalBets : 0;
  const logLoss = totalBets > 0 ? -summary.logLossSum / totalBets : 0;
  const expectedProfit = summary.expectedProfit;
  const expectedEvPct = legacySafePercent(expectedProfit, totalStaked);
  const yieldPct = legacySafePercent(netProfit, totalStaked);
  const roiPct = legacySafePercent(netProfit, openingBankroll);

  return {
    totalBets,
    settledBets: totalBets,
    totalStaked: Number(totalStaked.toFixed(2)),
    totalReturn: Number(totalReturn.toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),
    roiPct: Number(roiPct.toFixed(2)),
    yieldPct: Number(yieldPct.toFixed(2)),
    hitRatePct: Number(legacySafePercent(wins, totalBets).toFixed(2)),
    brierScore: Number(brierScore.toFixed(4)),
    logLoss: Number(logLoss.toFixed(4)),
    expectedProfit: Number(expectedProfit.toFixed(2)),
    expectedEvPct: Number(expectedEvPct.toFixed(2)),
    realizedEvPct: Number(yieldPct.toFixed(2)),
    evDeltaPct: Number((yieldPct - expectedEvPct).toFixed(2)),
    evCapturePct: Math.abs(expectedProfit) > 0.000001 ? Number(((netProfit / expectedProfit) * 100).toFixed(2)) : null,
    avgOdds: totalBets > 0 ? Number((summary.oddsSum / totalBets).toFixed(2)) : 0,
    avgProbabilityPct: totalBets > 0 ? Number(((summary.probabilitySum / totalBets) * 100).toFixed(2)) : 0,
    avgEdgePct: totalBets > 0 ? Number(((summary.edgeSum / totalBets) * 100).toFixed(2)) : 0,
  };
}

function summarizeLegacyBets(bets, openingBankroll) {
  const summary = createLegacySummaryAccumulator();
  for (const bet of bets) {
    accumulateLegacySummary(summary, bet);
  }
  return finalizeLegacySummary(summary, openingBankroll);
}

function resolveLegacyBucketIndex(value, buckets) {
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    const isLast = index === buckets.length - 1;
    if (value >= bucket.min && (value < bucket.max || (isLast && value <= bucket.max))) {
      return index;
    }
  }
  return buckets.length - 1;
}

function resolveLegacyBucket(value, buckets) {
  const bucket = buckets[resolveLegacyBucketIndex(value, buckets)] ?? buckets[buckets.length - 1];
  return { key: bucket.key, label: bucket.label };
}

function groupLegacyBets(bets, getKey, openingBankroll) {
  const groups = new Map();
  for (const bet of bets) {
    const resolved = getKey(bet);
    if (!resolved) continue;
    const bucket = groups.get(resolved.key) ?? { label: resolved.label, summary: createLegacySummaryAccumulator() };
    accumulateLegacySummary(bucket.summary, bet);
    groups.set(resolved.key, bucket);
  }

  return Array.from(groups.entries())
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      ...finalizeLegacySummary(bucket.summary, openingBankroll),
    }))
    .sort((left, right) => right.totalBets - left.totalBets);
}

function buildLegacyProbabilityBuckets(bets, openingBankroll) {
  const buckets = LEGACY_PROBABILITY_BUCKETS.map((bucket) => ({
    bucket,
    summary: createLegacySummaryAccumulator(),
    probabilitySum: 0,
  }));

  for (const bet of bets) {
    const probability = legacyToFinite(bet.ourProbability);
    const bucketIndex = resolveLegacyBucketIndex(probability, LEGACY_PROBABILITY_BUCKETS);
    const bucket = buckets[bucketIndex];
    accumulateLegacySummary(bucket.summary, bet);
    bucket.probabilitySum += probability;
  }

  return buckets
    .map(({ bucket, summary, probabilitySum }) => {
      const finalized = finalizeLegacySummary(summary, openingBankroll);
      const predictedProbabilityPct = summary.totalBets > 0
        ? Number(((probabilitySum / summary.totalBets) * 100).toFixed(2))
        : 0;
      const actualFrequencyPct = finalized.hitRatePct;

      return {
        key: bucket.key,
        label: bucket.label,
        predictedProbabilityPct,
        actualFrequencyPct,
        calibrationGapPct: Number((actualFrequencyPct - predictedProbabilityPct).toFixed(2)),
        count: summary.totalBets,
        ...finalized,
      };
    })
    .filter((bucket) => bucket.count > 0);
}

function filterLegacyBets(bets, filters) {
  const marketFilter = String(filters.market ?? '').trim().toLowerCase();
  const sourceFilter = legacyNormalizeSource(filters.source);
  const dateFromValue = filters.dateFrom ? new Date(filters.dateFrom).getTime() : null;
  const dateToValue = filters.dateTo ? new Date(filters.dateTo).getTime() : null;

  return bets.filter((bet) => {
    const matchDateValue = new Date(bet.matchDate).getTime();
    const normalizedSource = legacyNormalizeSource(bet.oddsSource);
    const marketMatches = !marketFilter || String(bet.marketCategory ?? '').toLowerCase() === marketFilter || String(bet.marketName ?? '').toLowerCase() === marketFilter;
    const sourceMatches = !String(filters.source ?? '').trim() || normalizedSource === sourceFilter;
    const fromMatches = dateFromValue === null || (!Number.isNaN(matchDateValue) && matchDateValue >= dateFromValue);
    const toMatches = dateToValue === null || (!Number.isNaN(matchDateValue) && matchDateValue <= dateToValue);
    return marketMatches && sourceMatches && fromMatches && toMatches;
  });
}

function buildBacktestReportLegacyReference(result, filters = {}) {
  const allDetailedBets = Array.isArray(result?.detailedBets)
    ? result.detailedBets.filter((bet) => bet && typeof bet === 'object')
    : [];
  const legacyData = allDetailedBets.length === 0;
  const filteredBets = filterLegacyBets(allDetailedBets, filters);
  const availableMarkets = new Set();
  const availableSources = new Set();
  let minDateValue = Number.POSITIVE_INFINITY;
  let maxDateValue = Number.NEGATIVE_INFINITY;

  for (const bet of allDetailedBets) {
    const market = String(bet.marketCategory ?? '').trim();
    if (market) availableMarkets.add(market);

    const source = legacyNormalizeSource(bet.oddsSource);
    if (source) availableSources.add(source);

    const dateValue = new Date(bet.matchDate).getTime();
    if (!Number.isNaN(dateValue)) {
      if (dateValue < minDateValue) minDateValue = dateValue;
      if (dateValue > maxDateValue) maxDateValue = dateValue;
    }
  }

  const summary = legacyData
    ? finalizeLegacySummary(createLegacySummaryAccumulator(), DEFAULT_OPENING_BANKROLL)
    : summarizeLegacyBets(filteredBets, DEFAULT_OPENING_BANKROLL);

  const byCompetition = legacyData
    ? []
    : groupLegacyBets(filteredBets, (bet) => ({ key: String(bet.competition ?? 'unknown'), label: String(bet.competition ?? 'unknown') }), DEFAULT_OPENING_BANKROLL);
  const byMarket = legacyData
    ? []
    : groupLegacyBets(filteredBets, (bet) => ({ key: String(bet.marketCategory), label: String(bet.marketCategory) }), DEFAULT_OPENING_BANKROLL);
  const bySource = legacyData
    ? []
    : groupLegacyBets(filteredBets, (bet) => {
      const normalized = legacyNormalizeSource(bet.oddsSource);
      return { key: normalized, label: normalized };
    }, DEFAULT_OPENING_BANKROLL);
  const byConfidence = legacyData
    ? []
    : groupLegacyBets(filteredBets, (bet) => ({ key: String(bet.confidence).toLowerCase(), label: String(bet.confidence) }), DEFAULT_OPENING_BANKROLL);
  const byEvBucket = legacyData
    ? []
    : groupLegacyBets(filteredBets, (bet) => resolveLegacyBucket(legacyToFinite(bet.expectedValue), LEGACY_EV_BUCKETS), DEFAULT_OPENING_BANKROLL);
  const byEdgeBucket = legacyData
    ? []
    : groupLegacyBets(filteredBets, (bet) => resolveLegacyBucket(legacyToFinite(bet.edge), LEGACY_EDGE_BUCKETS), DEFAULT_OPENING_BANKROLL);
  const probabilityBuckets = legacyData ? [] : buildLegacyProbabilityBuckets(filteredBets, DEFAULT_OPENING_BANKROLL);

  return {
    dataset: {
      totalDetailedBets: allDetailedBets.length,
      filteredBets: legacyData ? 0 : filteredBets.length,
      availableMarkets: Array.from(availableMarkets).sort(),
      availableSources: Array.from(availableSources).sort(),
      dateRange: {
        min: Number.isFinite(minDateValue) ? new Date(minDateValue).toISOString() : null,
        max: Number.isFinite(maxDateValue) ? new Date(maxDateValue).toISOString() : null,
      },
    },
    summary,
    segments: {
      byCompetition,
      byMarket,
      bySource,
      byConfidence,
      byEvBucket,
      byEdgeBucket,
    },
    calibration: {
      probabilityBuckets,
    },
  };
}

function assertBacktestReportEquivalence(expected, actual) {
  assert.deepEqual(actual.summary, expected.summary);
  assert.deepEqual(actual.segments.byCompetition, expected.segments.byCompetition);
  assert.deepEqual(actual.segments.byMarket, expected.segments.byMarket);
  assert.deepEqual(actual.segments.bySource, expected.segments.bySource);
  assert.deepEqual(actual.segments.byConfidence, expected.segments.byConfidence);
  assert.deepEqual(actual.segments.byEvBucket, expected.segments.byEvBucket);
  assert.deepEqual(actual.segments.byEdgeBucket, expected.segments.byEdgeBucket);
  assert.deepEqual(actual.calibration.probabilityBuckets, expected.calibration.probabilityBuckets);
  assert.equal(actual.dataset.totalDetailedBets, expected.dataset.totalDetailedBets);
  assert.equal(actual.dataset.filteredBets, expected.dataset.filteredBets);
  assert.deepEqual(actual.dataset.availableMarkets, expected.dataset.availableMarkets);
  assert.deepEqual(actual.dataset.availableSources, expected.dataset.availableSources);
  assert.deepEqual(actual.dataset.dateRange, expected.dataset.dateRange);
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function capitalize(value) {
  if (!value) return value;
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

async function runBenchmark(name, inputCount, iterations, task) {
  const durations = [];
  const memoryDeltasMb = [];
  const numericStats = new Map();

  for (let index = 0; index < iterations; index += 1) {
    global.gc?.();
    const startHeap = process.memoryUsage().heapUsed;
    const startedAt = performance.now();
    const taskResult = await task(index);
    const durationMs = performance.now() - startedAt;
    const endHeap = process.memoryUsage().heapUsed;
    durations.push(durationMs);
    memoryDeltasMb.push((endHeap - startHeap) / (1024 * 1024));

    if (taskResult && typeof taskResult === 'object' && !Array.isArray(taskResult)) {
      for (const [key, value] of Object.entries(taskResult)) {
        if (typeof value !== 'number' || !Number.isFinite(value)) continue;
        const bucket = numericStats.get(key) ?? [];
        bucket.push(value);
        numericStats.set(key, bucket);
      }
    }
  }

  const averageMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const averageHeapDeltaMb = memoryDeltasMb.reduce((sum, value) => sum + value, 0) / memoryDeltasMb.length;

  const aggregatedStats = Object.fromEntries(
    Array.from(numericStats.entries()).map(([key, values]) => [
      `avg${capitalize(key)}`,
      Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)),
    ])
  );

  return {
    name,
    inputCount,
    iterations,
    averageMs: Number(averageMs.toFixed(2)),
    p95Ms: Number(percentile(durations, 95).toFixed(2)),
    minMs: Number(Math.min(...durations).toFixed(2)),
    maxMs: Number(Math.max(...durations).toFixed(2)),
    avgHeapDeltaMb: Number(averageHeapDeltaMb.toFixed(3)),
    ...aggregatedStats,
  };
}

function createBacktestDetailedBets(count) {
  const competitions = ['Serie A', 'Premier League', 'La Liga'];
  const markets = ['goal_1x2', 'goal_ou', 'shots', 'cards'];
  const sources = ['eurobet_scraper', 'fallback', 'synthetic'];
  const confidences = ['HIGH', 'MEDIUM', 'LOW'];
  const bets = [];

  for (let index = 0; index < count; index += 1) {
    const probability = 0.28 + ((index % 45) / 100);
    const odds = 1.55 + ((index % 20) * 0.11);
    const stake = 5 + (index % 7);
    const won = index % 3 !== 0;
    const expectedValue = ((probability * odds) - 1);
    bets.push({
      matchId: `match_${index}`,
      matchDate: new Date(Date.UTC(2026, 0, 1 + (index % 180), 18, 45)).toISOString(),
      competition: competitions[index % competitions.length],
      season: '2025-26',
      marketName: `Market ${index % markets.length}`,
      marketCategory: markets[index % markets.length],
      selection: `selection_${index % 8}`,
      odds,
      impliedProbability: 1 / odds,
      ourProbability: probability,
      expectedValue,
      edge: probability - (1 / odds),
      edgeNoVig: probability - (1 / odds),
      confidence: confidences[index % confidences.length],
      stake,
      profit: won ? stake * (odds - 1) : -stake,
      outcome: won ? 'WON' : 'LOST',
      won,
      isSynthetic: sources[index % sources.length] === 'synthetic',
      oddsSource: sources[index % sources.length],
      snapshotSource: `snapshot_${index % 4}`,
      oddsCapturedAt: new Date(Date.UTC(2026, 0, 1 + (index % 180), 12, 0)).toISOString(),
    });
  }

  return bets;
}

function createBacktestReportFilterCycle() {
  return [
    {},
    { source: 'fallback' },
    { market: 'goal_1x2' },
    { market: 'shots', source: 'fallback' },
    { dateFrom: '2026-03-01T00:00:00.000Z', dateTo: '2026-04-30T23:59:59.000Z' },
    { market: 'goal_ou', source: 'synthetic', dateFrom: '2026-02-01T00:00:00.000Z', dateTo: '2026-05-30T23:59:59.000Z' },
  ];
}

function createEurobetMatch(index) {
  const day = 10 + (index % 15);
  const hour = 12 + (index % 8);
  const minute = index % 2 === 0 ? '00' : '30';
  return {
    matchId: `eurobet_${index}`,
    meetingAlias: 'it-serie-a',
    eventAlias: `team-${index}-team-${index + 1}-202604${String(day).padStart(2, '0')}${String(hour).padStart(2, '0')}${minute}`,
    homeTeam: index % 5 === 0 ? `Internazionale ${index}` : `Team ${index}`,
    awayTeam: index % 7 === 0 ? `AC Milan ${index + 1}` : `Team ${index + 1}`,
    commenceTime: new Date(Date.UTC(2026, 3, day, hour, minute === '00' ? 0 : 30)).toISOString(),
    bookmakers: [],
    availableGroupAliases: [],
    loadedGroupAliases: ['base'],
    unavailableGroupAliases: [],
  };
}

function createEurobetFixture(index, match) {
  return {
    homeTeam: match.homeTeam.replace('Internazionale', 'Inter').replace('AC Milan', 'Milan'),
    awayTeam: match.awayTeam.replace('Internazionale', 'Inter').replace('AC Milan', 'Milan'),
    commenceTime: new Date(new Date(match.commenceTime).getTime() + ((index % 5) - 2) * 60 * 60 * 1000).toISOString(),
  };
}

function createEurobetBenchmarkDataset(fixtureCount) {
  const matchCount = Math.max(fixtureCount * 6, fixtureCount + 20);
  const matches = Array.from({ length: matchCount }, (_, index) => createEurobetMatch(index));
  const fixtures = Array.from({ length: fixtureCount }, (_, index) => createEurobetFixture(index, matches[index * 3]));
  return {
    competitionKey: 'it-serie-a',
    matches,
    fixtures,
  };
}

function createBacktestMatches(count) {
  const teams = Array.from({ length: 24 }, (_, index) => `team_${index + 1}`);
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const homeTeamId = teams[index % teams.length];
    const awayTeamId = teams[(index + 7) % teams.length];
    const date = new Date(Date.UTC(2024, 0, 1 + index, 18, 45));
    matches.push({
      matchId: `match_${index}`,
      homeTeamId,
      awayTeamId,
      date,
      homeGoals: index % 4,
      awayGoals: (index + 1) % 3,
      homeXG: 0.9 + ((index % 6) * 0.22),
      awayXG: 0.7 + (((index + 2) % 6) * 0.19),
      homeShotsOnTarget: 2 + (index % 5),
      awayShotsOnTarget: 1 + ((index + 3) % 5),
      homeTotalShots: 7 + (index % 9),
      awayTotalShots: 6 + ((index + 4) % 8),
      homePossession: 44 + (index % 12),
      awayPossession: 56 - (index % 12),
      homeYellowCards: 1 + (index % 3),
      awayYellowCards: 1 + ((index + 1) % 3),
      competition: 'Serie A',
      season: '2025-26',
    });
  }
  return matches;
}

function createHistoricalOdds(matches) {
  return Object.fromEntries(
    matches.map((match, index) => ([
      match.matchId,
      {
        homeWin: Number((1.7 + ((index % 12) * 0.09)).toFixed(2)),
        draw: Number((3.0 + ((index % 6) * 0.12)).toFixed(2)),
        awayWin: Number((2.2 + ((index % 10) * 0.13)).toFixed(2)),
        over25: Number((1.8 + ((index % 5) * 0.08)).toFixed(2)),
        under25: Number((1.9 + ((index % 5) * 0.07)).toFixed(2)),
        btts: Number((1.75 + ((index % 5) * 0.05)).toFixed(2)),
      },
    ]))
  );
}

function createOddsMatch(label) {
  const bookmakers = [
    {
      bookmakerKey: 'primary',
      bookmakerName: 'Primary',
      markets: Array.from({ length: 18 }, (_, marketIndex) => ({
        marketKey: `market_${marketIndex}`,
        outcomes: Array.from({ length: 3 }, (_, outcomeIndex) => ({
          name: `${label}_outcome_${marketIndex}_${outcomeIndex}`,
          price: 1.5 + marketIndex * 0.05 + outcomeIndex * 0.03,
          point: outcomeIndex === 0 ? 2.5 + marketIndex : undefined,
        })),
      })),
    },
  ];

  return {
    matchId: `${label}_match`,
    homeTeam: 'Inter',
    awayTeam: 'Milan',
    commenceTime: '2026-04-12T18:45:00.000Z',
    bookmakers,
  };
}

function createBudgetBets(count) {
  return Array.from({ length: count }, (_, index) => {
    const status = index % 7 === 0 ? 'VOID' : (index % 3 === 0 ? 'LOST' : 'WON');
    const stake = 5 + (index % 6);
    const odds = 1.6 + ((index % 9) * 0.1);
    const returnAmount = status === 'WON' ? stake * odds : status === 'VOID' ? stake : 0;
    const profit = returnAmount - stake;
    return {
      stake,
      odds,
      status,
      return_amount: returnAmount,
      profit,
    };
  });
}

function legacyMatchFixturesToCompetitionMatches(service, fixtures, matches) {
  const available = [...matches];
  const matchedMatches = [];
  const missingFixtures = [];

  for (const fixture of fixtures) {
    let bestIndex = -1;
    let bestScore = -1;

    available.forEach((match, index) => {
      const score = service.scoreFixtureMatch(fixture, match);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    if (bestIndex === -1) {
      missingFixtures.push(fixture);
      continue;
    }

    matchedMatches.push(available[bestIndex]);
    available.splice(bestIndex, 1);
  }

  return { matchedMatches, missingFixtures };
}

function runEurobetMatchingWithComparisonCount(service, matcher) {
  const originalScoreFixtureMatch = service.scoreFixtureMatch;
  let comparisons = 0;

  service.scoreFixtureMatch = function scoreFixtureMatchProxy(...args) {
    comparisons += 1;
    return originalScoreFixtureMatch.apply(this, args);
  };

  try {
    const result = matcher();
    return {
      matched: result.matchedMatches.length,
      missing: result.missingFixtures.length,
      comparisons,
    };
  } finally {
    service.scoreFixtureMatch = originalScoreFixtureMatch;
  }
}

function legacySummarizeBudgetBets(allBets) {
  const totalBets = allBets.length;
  const totalStaked = allBets.reduce((sum, bet) => sum + Number(bet.stake ?? 0), 0);
  const totalWon = allBets
    .filter((bet) => bet.status === 'WON')
    .reduce((sum, bet) => sum + Number(bet.return_amount ?? 0), 0);
  const totalLost = allBets
    .filter((bet) => bet.status === 'LOST')
    .reduce((sum, bet) => sum + Number(bet.stake ?? 0), 0);
  const totalReturned = allBets
    .filter((bet) => bet.status === 'WON' || bet.status === 'VOID')
    .reduce((sum, bet) => sum + Number(bet.return_amount ?? 0), 0);
  const settled = allBets.filter((bet) => bet.status === 'WON' || bet.status === 'LOST');
  const wonCount = settled.filter((bet) => bet.status === 'WON').length;
  const settledForRoi = allBets.filter((bet) => bet.status === 'WON' || bet.status === 'LOST' || bet.status === 'VOID');
  const totalProfit = settledForRoi.reduce((sum, bet) => sum + Number(bet.profit ?? 0), 0);
  const settledStaked = settledForRoi.reduce((sum, bet) => sum + Number(bet.stake ?? 0), 0);

  return {
    totalBets,
    totalStaked,
    totalWon,
    totalLost,
    totalReturned,
    totalProfit,
    settledStaked,
    settledCount: settled.length,
    wonCount,
    winRate: settled.length > 0 ? (wonCount / settled.length) * 100 : 0,
    roi: settledStaked > 0 ? (totalProfit / settledStaked) * 100 : 0,
  };
}

function createPredictionModel() {
  const matches = createBacktestMatches(180);
  const teams = Array.from(new Set(matches.flatMap((match) => [match.homeTeamId, match.awayTeamId])));
  const model = new DixonColesModel();
  model.fitModel(matches, teams);
  return model;
}

function createFakePredictionService(model) {
  const fakeDb = {
    getTeam: async (id) => ({
      team_id: id,
      name: id === 'team_1' ? 'Inter' : 'Milan',
      competition: 'Serie A',
      team_stats_json: JSON.stringify({
        homeAdvantageIndex: 0.61,
        rolling_form_5: { xg_for: 1.7, xg_against: 0.9 },
      }),
    }),
    getRefereeByName: async () => null,
    getMatchById: async () => ({ match_id: 'm1', date: '2026-04-12T18:45:00.000Z' }),
    getTeamScheduleInsights: async () => ({ restDays: 6, matchesInLast14Days: 3 }),
    getPlayersByTeam: async (id) => Array.from({ length: 11 }, (_, index) => ({
      id: `${id}_player_${index}`,
      player_name: `Player ${index}`,
      shots_per90: 2.1 + (index * 0.07),
      shots_on_target_per90: 0.9 + (index * 0.04),
      xg_per90: 0.21 + (index * 0.01),
    })),
  };

  const service = new PredictionService(fakeDb);
  service.getModel = async () => model;
  service.applyAdaptiveTuning = async () => null;
  service.getCalibrationProfile = async () => ({ calibrationPoints: [], nObservations: 180 });
  service.contextBuilder = {
    build: () => ({
      supplementaryData: {
        homeTeamStats: { sampleSize: 24, shots: { total: 13.2, onTarget: 5.1 }, cards: { yellow: 2.3 } },
        awayTeamStats: { sampleSize: 24, shots: { total: 11.1, onTarget: 4.2 }, cards: { yellow: 2.6 } },
      },
      competitiveness: 0.57,
      homeXG: 1.62,
      awayXG: 1.18,
      richnessScore: 0.74,
    }),
  };
  return service;
}

async function main() {
  const benchmarks = [];
  const backtestReportPlans = [
    { count: 100, iterations: 16 },
    { count: 1000, iterations: 12 },
    { count: 10000, iterations: 6 },
    { count: 100000, iterations: 3 },
  ];

  for (const plan of backtestReportPlans) {
    const reportInput = { kind: 'classic', competition: 'Serie A', season: '2025-26', detailedBets: createBacktestDetailedBets(plan.count) };
    const legacyReference = buildBacktestReportLegacyReference(reportInput, {});
    const optimizedReference = buildBacktestReport(reportInput, {});
    assertBacktestReportEquivalence(legacyReference, optimizedReference);

    benchmarks.push(await runBenchmark(`backtest-report-legacy-${plan.count}`, plan.count, plan.iterations, async () => {
      buildBacktestReportLegacyReference(reportInput, {});
    }));
    benchmarks.push(await runBenchmark(`backtest-report-cold-${plan.count}`, plan.count, plan.iterations, async () => {
      const freshInput = {
        kind: 'classic',
        competition: 'Serie A',
        season: '2025-26',
        detailedBets: createBacktestDetailedBets(plan.count),
      };
      buildBacktestReport(freshInput, {});
    }));
    benchmarks.push(await runBenchmark(`backtest-report-warm-${plan.count}`, plan.count, plan.iterations, async () => {
      buildBacktestReport(reportInput, {});
    }));
  }

  const backtestFilterCyclePlans = [
    { count: 10000, iterations: 4 },
    { count: 100000, iterations: 2 },
  ];

  for (const plan of backtestFilterCyclePlans) {
    const reportInput = { kind: 'classic', competition: 'Serie A', season: '2025-26', detailedBets: createBacktestDetailedBets(plan.count) };
    const filtersCycle = createBacktestReportFilterCycle();

    for (const filters of filtersCycle) {
      const legacyReport = buildBacktestReportLegacyReference(reportInput, filters);
      const optimizedReport = buildBacktestReport(reportInput, filters);
      assertBacktestReportEquivalence(legacyReport, optimizedReport);
    }

    benchmarks.push(await runBenchmark(`backtest-report-filter-cycle-legacy-${plan.count}`, plan.count, plan.iterations, async () => {
      for (const filters of filtersCycle) {
        buildBacktestReportLegacyReference(reportInput, filters);
      }
    }));
    benchmarks.push(await runBenchmark(`backtest-report-filter-cycle-${plan.count}`, plan.count, plan.iterations, async () => {
      for (const filters of filtersCycle) {
        buildBacktestReport(reportInput, filters);
      }
    }));
  }

  const eurobetService = new EurobetOddsService();
  const eurobetPlans = [
    { fixtures: 10, iterations: 16 },
    { fixtures: 100, iterations: 8 },
    { fixtures: 1000, iterations: 3 },
  ];

  for (const plan of eurobetPlans) {
    const dataset = createEurobetBenchmarkDataset(plan.fixtures);
    benchmarks.push(await runBenchmark(`eurobet-fixture-matching-legacy-${plan.fixtures}`, plan.fixtures, plan.iterations, async () =>
      runEurobetMatchingWithComparisonCount(
        eurobetService,
        () => legacyMatchFixturesToCompetitionMatches(eurobetService, dataset.fixtures, dataset.matches)
      )
    ));
    benchmarks.push(await runBenchmark(`eurobet-fixture-matching-${plan.fixtures}`, plan.fixtures, plan.iterations, async () =>
      runEurobetMatchingWithComparisonCount(
        eurobetService,
        () => eurobetService.matchFixturesToCompetitionMatches(dataset.fixtures, dataset.matches, dataset.competitionKey)
      )
    ));
  }

  const backtester = new BacktestingEngine();
  const backtestMatches = createBacktestMatches(180);
  const historicalOdds = createHistoricalOdds(backtestMatches);
  benchmarks.push(await runBenchmark('backtesting-engine', backtestMatches.length, 2, async () => {
    backtester.runBacktest(backtestMatches, historicalOdds, 0.7, 'medium_and_above', 0, {});
  }));

  const predictionModel = createPredictionModel();
  const predictionService = createFakePredictionService(predictionModel);
  benchmarks.push(await runBenchmark('prediction-service', 60, 4, async () => {
    for (let index = 0; index < 60; index += 1) {
      await predictionService.predict({
        homeTeamId: 'team_1',
        awayTeamId: 'team_8',
        matchId: `match_${index}`,
        competition: 'Serie A',
        bookmakerOdds: {
          homeWin: 2.1,
          draw: 3.3,
          awayWin: 3.7,
          over25: 1.87,
          under25: 1.95,
        },
      });
    }
  }));

  const baseMatch = createOddsMatch('base');
  const extraMatch = createOddsMatch('extra');
  benchmarks.push(await runBenchmark('provider-merge', 180, 8, async () => {
    for (let index = 0; index < 180; index += 1) {
      mergeOddsMatchMarkets(baseMatch, extraMatch);
    }
  }));

  const budgetBets = createBudgetBets(18000);
  benchmarks.push(await runBenchmark('budget-recompute-legacy', budgetBets.length, 4, async () => {
    legacySummarizeBudgetBets(budgetBets);
  }));
  benchmarks.push(await runBenchmark('budget-recompute', budgetBets.length, 8, async () => {
    summarizeBudgetBetsInternal(budgetBets);
  }));

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    node: process.version,
    benchmarks,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
