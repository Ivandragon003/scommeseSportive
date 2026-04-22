import { BacktestBetDetail } from '../models/backtesting/BacktestingEngine';

export type BacktestReportFilters = {
  market?: string;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
};

type SummaryMetrics = {
  totalBets: number;
  settledBets: number;
  totalStaked: number;
  totalReturn: number;
  netProfit: number;
  roiPct: number;
  yieldPct: number;
  hitRatePct: number;
  brierScore: number;
  logLoss: number;
  expectedProfit: number;
  expectedEvPct: number;
  realizedEvPct: number;
  evDeltaPct: number;
  evCapturePct: number | null;
  avgOdds: number;
  avgProbabilityPct: number;
  avgEdgePct: number;
};

type SegmentSummary = SummaryMetrics & {
  key: string;
  label: string;
};

type ProbabilityBucketSummary = SummaryMetrics & {
  key: string;
  label: string;
  predictedProbabilityPct: number;
  actualFrequencyPct: number;
  calibrationGapPct: number;
  count: number;
};

type CalibrationAlert = {
  severity: 'warning' | 'critical';
  type: 'probability_bucket' | 'ev_bucket' | 'edge_bucket' | 'confidence_bucket' | 'legacy_data';
  bucketKey: string;
  message: string;
};

type SummaryAccumulator = {
  totalBets: number;
  totalStaked: number;
  totalReturn: number;
  netProfit: number;
  wins: number;
  brierLossSum: number;
  logLossSum: number;
  expectedProfit: number;
  oddsSum: number;
  probabilitySum: number;
  edgeSum: number;
};

type BucketDefinition = { key: string; label: string; min: number; max: number };

type GroupAccumulator = {
  label: string;
  summary: SummaryAccumulator;
};

type ProbabilityBucketAccumulator = {
  bucket: BucketDefinition;
  summary: SummaryAccumulator;
  probabilitySum: number;
};

type RawBacktestBetDetail = BacktestBetDetail & {
  predictionId?: unknown;
};

type NormalizedBacktestBet = {
  raw: BacktestBetDetail;
  matchId: string;
  predictionId: string | null;
  competitionKey: string;
  competitionLabel: string;
  marketCategoryKey: string;
  marketCategoryLabel: string;
  marketFilterKeys: string[];
  sourceKey: string;
  confidenceKey: string;
  confidenceLabel: string;
  timestampMs: number | null;
  dateBucketKey: string | null;
  stake: number;
  profit: number;
  probabilityRaw: number;
  probabilityClamped: number;
  expectedValue: number;
  odds: number;
  edge: number;
  won: boolean;
  probabilityBucketIndex: number;
  evBucketIndex: number;
  edgeBucketIndex: number;
};

type DatasetQualityStats = {
  invalidMatchDates: number;
  invalidProbabilities: number;
  invalidOdds: number;
  missingMatchIds: number;
  missingPredictionIds: number;
};

type BacktestDatasetIndex = {
  bets: NormalizedBacktestBet[];
  allIndices: number[];
  byMatchId: Map<string, number[]>;
  byPredictionId: Map<string, number[]>;
  byCompetition: Map<string, number[]>;
  byMarket: Map<string, number[]>;
  bySource: Map<string, number[]>;
  byDateBucket: Map<string, number[]>;
  timestampEntries: Array<{ timestampMs: number; index: number }>;
  availableMarkets: string[];
  availableSources: string[];
  minDateValue: number | null;
  maxDateValue: number | null;
  quality: DatasetQualityStats;
  aggregationCache: Map<string, { filteredIndices: number[]; sections: AggregatedReportSections }>;
};

type AggregatedReportSections = {
  summary: SummaryMetrics;
  byCompetition: SegmentSummary[];
  byMarket: SegmentSummary[];
  bySource: SegmentSummary[];
  byConfidence: SegmentSummary[];
  byEvBucket: SegmentSummary[];
  byEdgeBucket: SegmentSummary[];
  probabilityBuckets: ProbabilityBucketSummary[];
};

type BacktestReportSource = {
  detailedBets?: unknown;
  kind?: unknown;
  competition?: unknown;
  season?: unknown;
  usedSyntheticOddsOnly?: unknown;
  totalStaked?: unknown;
  netProfit?: unknown;
  averageEV?: unknown;
  betsPlaced?: unknown;
  totalReturn?: unknown;
  winRate?: unknown;
  brierScore?: unknown;
  logLoss?: unknown;
  averageOdds?: unknown;
};

type BacktestReport = {
  run: {
    kind: 'classic' | 'walk_forward';
    competition: string;
    season: string;
    openingBankroll: number;
    totalDetailedBets: number;
    usedSyntheticOddsOnly: boolean;
  };
  filtersApplied: {
    market: string | null;
    source: string | null;
    dateFrom: string | null;
    dateTo: string | null;
  };
  dataset: {
    legacyData: boolean;
    totalDetailedBets: number;
    filteredBets: number;
    availableMarkets: string[];
    availableSources: string[];
    dateRange: {
      min: string | null;
      max: string | null;
    };
    quality: DatasetQualityStats;
  };
  summary: SummaryMetrics;
  segments: {
    byCompetition: SegmentSummary[];
    byMarket: SegmentSummary[];
    bySource: SegmentSummary[];
    byConfidence: SegmentSummary[];
    byEvBucket: SegmentSummary[];
    byEdgeBucket: SegmentSummary[];
  };
  calibration: {
    probabilityBuckets: ProbabilityBucketSummary[];
  };
  alerts: CalibrationAlert[];
  clv: {
    status: 'todo';
    available: false;
    reason: string;
  };
};

const DEFAULT_OPENING_BANKROLL = 1000;

const EV_BUCKETS = [
  { key: 'lt_0', label: '< 0%', min: Number.NEGATIVE_INFINITY, max: 0 },
  { key: '0_2', label: '0% - 2%', min: 0, max: 0.02 },
  { key: '2_5', label: '2% - 5%', min: 0.02, max: 0.05 },
  { key: '5_8', label: '5% - 8%', min: 0.05, max: 0.08 },
  { key: '8_12', label: '8% - 12%', min: 0.08, max: 0.12 },
  { key: 'gte_12', label: '>= 12%', min: 0.12, max: Number.POSITIVE_INFINITY },
] as const;

const EDGE_BUCKETS = [
  { key: 'lt_0', label: '< 0 pp', min: Number.NEGATIVE_INFINITY, max: 0 },
  { key: '0_2', label: '0 - 2 pp', min: 0, max: 0.02 },
  { key: '2_5', label: '2 - 5 pp', min: 0.02, max: 0.05 },
  { key: '5_8', label: '5 - 8 pp', min: 0.05, max: 0.08 },
  { key: 'gte_8', label: '>= 8 pp', min: 0.08, max: Number.POSITIVE_INFINITY },
] as const;

const PROBABILITY_BUCKETS = Array.from({ length: 10 }, (_, index) => ({
  key: `${index * 10}_${(index + 1) * 10}`,
  label: `${index * 10}% - ${(index + 1) * 10}%`,
  min: index / 10,
  max: (index + 1) / 10,
}));

const datasetIndexCache = new WeakMap<BacktestBetDetail[], BacktestDatasetIndex>();

const normalizeToken = (value: unknown): string => String(value ?? '').trim().toLowerCase();

const normalizeSource = (value: unknown): string => {
  const source = normalizeToken(value);
  if (!source) return 'unknown';
  if (source.includes('eurobet')) return 'eurobet_scraper';
  if (source.includes('fallback') || source.includes('odds_api')) return 'fallback';
  if (source.includes('synthetic') || source.includes('model_estimated')) return 'synthetic';
  return source;
};

const safePercent = (numerator: number, denominator: number): number =>
  Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0
    ? (numerator / denominator) * 100
    : 0;

const toFinite = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const createSummaryAccumulator = (): SummaryAccumulator => ({
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
});

const appendIndex = (indexMap: Map<string, number[]>, key: string | null, value: number): void => {
  if (!key) return;
  const bucket = indexMap.get(key);
  if (bucket) {
    bucket.push(value);
    return;
  }
  indexMap.set(key, [value]);
};

const resolveBucketIndex = (value: number, buckets: readonly BucketDefinition[]): number => {
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    const isLast = index === buckets.length - 1;
    if (value >= bucket.min && (value < bucket.max || (isLast && value <= bucket.max))) {
      return index;
    }
  }

  return buckets.length - 1;
};

const lowerBoundTimestamp = (entries: Array<{ timestampMs: number; index: number }>, target: number): number => {
  let left = 0;
  let right = entries.length;

  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (entries[middle].timestampMs < target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
};

const upperBoundTimestamp = (entries: Array<{ timestampMs: number; index: number }>, target: number): number => {
  let left = 0;
  let right = entries.length;

  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (entries[middle].timestampMs <= target) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
};

const intersectSortedIndices = (left: number[], right: number[]): number[] => {
  const results: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];

    if (leftValue === rightValue) {
      results.push(leftValue);
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if (leftValue < rightValue) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }

  return results;
};

const parseDateBucketKey = (value: number | null): string | null => {
  if (value === null) return null;
  const date = new Date(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

const buildNormalizedDataset = (bets: BacktestBetDetail[]): BacktestDatasetIndex => {
  const normalizedBets: NormalizedBacktestBet[] = [];
  const byMatchId = new Map<string, number[]>();
  const byPredictionId = new Map<string, number[]>();
  const byCompetition = new Map<string, number[]>();
  const byMarket = new Map<string, number[]>();
  const bySource = new Map<string, number[]>();
  const byDateBucket = new Map<string, number[]>();
  const timestampEntries: Array<{ timestampMs: number; index: number }> = [];
  const availableMarkets = new Set<string>();
  const availableSources = new Set<string>();
  const quality: DatasetQualityStats = {
    invalidMatchDates: 0,
    invalidProbabilities: 0,
    invalidOdds: 0,
    missingMatchIds: 0,
    missingPredictionIds: 0,
  };

  let minDateValue = Number.POSITIVE_INFINITY;
  let maxDateValue = Number.NEGATIVE_INFINITY;

  for (const rawBet of bets) {
    const bet = rawBet as RawBacktestBetDetail;
    const normalizedMarketCategory = normalizeToken(rawBet.marketCategory);
    const normalizedMarketName = normalizeToken(rawBet.marketName);
    const marketFilterKeys = Array.from(new Set([normalizedMarketCategory, normalizedMarketName].filter(Boolean)));
    const sourceKey = normalizeSource(rawBet.oddsSource);
    const confidenceLabel = String(rawBet.confidence);
    const confidenceKey = normalizeToken(rawBet.confidence);
    const competitionValue = rawBet.competition ?? 'unknown';
    const competitionLabel = String(competitionValue);
    const competitionKey = competitionLabel;
    const matchId = String(rawBet.matchId ?? '').trim();
    const predictionId = String(bet.predictionId ?? '').trim() || null;
    const stake = toFinite(rawBet.stake);
    const profit = toFinite(rawBet.profit);
    const probabilityRaw = toFinite(rawBet.ourProbability);
    const probabilityClamped = Math.min(0.999999, Math.max(0.000001, probabilityRaw));
    const expectedValue = toFinite(rawBet.expectedValue);
    const edge = toFinite(rawBet.edge);
    const odds = toFinite(rawBet.odds);
    const timestampCandidate = new Date(rawBet.matchDate).getTime();
    const timestampMs = Number.isNaN(timestampCandidate) ? null : timestampCandidate;
    const dateBucketKey = parseDateBucketKey(timestampMs);

    if (!matchId) quality.missingMatchIds += 1;
    if (!predictionId) quality.missingPredictionIds += 1;
    if (!Number.isFinite(Number(rawBet.ourProbability))) quality.invalidProbabilities += 1;
    if (!Number.isFinite(Number(rawBet.odds))) quality.invalidOdds += 1;
    if (timestampMs === null) {
      quality.invalidMatchDates += 1;
    } else {
      minDateValue = Math.min(minDateValue, timestampMs);
      maxDateValue = Math.max(maxDateValue, timestampMs);
    }

    if (normalizedMarketCategory) availableMarkets.add(String(rawBet.marketCategory ?? '').trim());
    if (sourceKey) availableSources.add(sourceKey);

    const normalizedBet: NormalizedBacktestBet = {
      raw: rawBet,
      matchId,
      predictionId,
      competitionKey,
      competitionLabel,
      marketCategoryKey: String(rawBet.marketCategory),
      marketCategoryLabel: String(rawBet.marketCategory),
      marketFilterKeys,
      sourceKey,
      confidenceKey,
      confidenceLabel,
      timestampMs,
      dateBucketKey,
      stake,
      profit,
      probabilityRaw,
      probabilityClamped,
      expectedValue,
      odds,
      edge,
      won: Boolean(rawBet.won),
      probabilityBucketIndex: resolveBucketIndex(probabilityRaw, PROBABILITY_BUCKETS),
      evBucketIndex: resolveBucketIndex(expectedValue, EV_BUCKETS),
      edgeBucketIndex: resolveBucketIndex(edge, EDGE_BUCKETS),
    };

    const index = normalizedBets.length;
    normalizedBets.push(normalizedBet);

    appendIndex(byMatchId, matchId || null, index);
    appendIndex(byPredictionId, predictionId, index);
    appendIndex(byCompetition, competitionKey, index);
    appendIndex(bySource, sourceKey, index);
    appendIndex(byDateBucket, dateBucketKey, index);

    for (const marketKey of marketFilterKeys) {
      appendIndex(byMarket, marketKey, index);
    }

    if (timestampMs !== null) {
      timestampEntries.push({ timestampMs, index });
    }
  }

  timestampEntries.sort((left, right) => left.timestampMs - right.timestampMs);

  return {
    bets: normalizedBets,
    allIndices: Array.from({ length: normalizedBets.length }, (_, index) => index),
    byMatchId,
    byPredictionId,
    byCompetition,
    byMarket,
    bySource,
    byDateBucket,
    timestampEntries,
    availableMarkets: Array.from(availableMarkets).sort(),
    availableSources: Array.from(availableSources).sort(),
    minDateValue: Number.isFinite(minDateValue) ? minDateValue : null,
    maxDateValue: Number.isFinite(maxDateValue) ? maxDateValue : null,
    quality,
    aggregationCache: new Map(),
  };
};

const accumulateSummary = (summary: SummaryAccumulator, bet: NormalizedBacktestBet): void => {
  summary.totalBets += 1;
  summary.totalStaked += bet.stake;
  summary.totalReturn += bet.profit + bet.stake;
  summary.netProfit += bet.profit;
  summary.wins += bet.won ? 1 : 0;
  summary.brierLossSum += (bet.probabilityRaw - (bet.won ? 1 : 0)) ** 2;
  summary.logLossSum += bet.won ? Math.log(bet.probabilityClamped) : Math.log(1 - bet.probabilityClamped);
  summary.expectedProfit += bet.stake * bet.expectedValue;
  summary.oddsSum += bet.odds;
  summary.probabilitySum += bet.probabilityRaw;
  summary.edgeSum += bet.edge;
};

const finalizeSummary = (summary: SummaryAccumulator, openingBankroll: number): SummaryMetrics => {
  const totalBets = summary.totalBets;
  const totalStaked = summary.totalStaked;
  const totalReturn = summary.totalReturn;
  const netProfit = summary.netProfit;
  const wins = summary.wins;
  const brierScore = totalBets > 0 ? summary.brierLossSum / totalBets : 0;
  const logLoss = totalBets > 0 ? -summary.logLossSum / totalBets : 0;
  const expectedProfit = summary.expectedProfit;
  const expectedEvPct = safePercent(expectedProfit, totalStaked);
  const yieldPct = safePercent(netProfit, totalStaked);
  const roiPct = safePercent(netProfit, openingBankroll);

  return {
    totalBets,
    settledBets: totalBets,
    totalStaked: Number(totalStaked.toFixed(2)),
    totalReturn: Number(totalReturn.toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),
    roiPct: Number(roiPct.toFixed(2)),
    yieldPct: Number(yieldPct.toFixed(2)),
    hitRatePct: Number(safePercent(wins, totalBets).toFixed(2)),
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
};

const accumulateGroup = (
  groups: Map<string, GroupAccumulator>,
  key: string,
  label: string,
  bet: NormalizedBacktestBet
): void => {
  const bucket = groups.get(key) ?? { label, summary: createSummaryAccumulator() };
  accumulateSummary(bucket.summary, bet);
  if (!groups.has(key)) groups.set(key, bucket);
};

const finalizeGroups = (groups: Map<string, GroupAccumulator>, openingBankroll: number): SegmentSummary[] =>
  Array.from(groups.entries())
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      ...finalizeSummary(bucket.summary, openingBankroll),
    }))
    .sort((left, right) => right.totalBets - left.totalBets);

const finalizeProbabilityBuckets = (
  buckets: ProbabilityBucketAccumulator[],
  openingBankroll: number
): ProbabilityBucketSummary[] =>
  buckets
    .map(({ bucket, summary, probabilitySum }) => {
      const finalized = finalizeSummary(summary, openingBankroll);
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

const resolveDateRangeIndices = (
  dataset: BacktestDatasetIndex,
  dateFromValue: number | null,
  dateToValue: number | null
): number[] => {
  const startIndex = dateFromValue === null ? 0 : lowerBoundTimestamp(dataset.timestampEntries, dateFromValue);
  const endIndex = dateToValue === null ? dataset.timestampEntries.length : upperBoundTimestamp(dataset.timestampEntries, dateToValue);

  if (startIndex >= endIndex) return [];

  return dataset.timestampEntries
    .slice(startIndex, endIndex)
    .map((entry) => entry.index)
    .sort((left, right) => left - right);
};

const resolveFilteredIndices = (dataset: BacktestDatasetIndex, filters: BacktestReportFilters): number[] => {
  const candidates: number[][] = [];
  const marketFilter = normalizeToken(filters.market);
  const sourceFilterRaw = normalizeToken(filters.source);
  const hasDateFrom = Boolean(String(filters.dateFrom ?? '').trim());
  const hasDateTo = Boolean(String(filters.dateTo ?? '').trim());
  const dateFromValue = hasDateFrom ? new Date(String(filters.dateFrom)).getTime() : null;
  const dateToValue = hasDateTo ? new Date(String(filters.dateTo)).getTime() : null;

  if (marketFilter) {
    candidates.push(dataset.byMarket.get(marketFilter) ?? []);
  }

  if (sourceFilterRaw) {
    candidates.push(dataset.bySource.get(normalizeSource(sourceFilterRaw)) ?? []);
  }

  if (hasDateFrom && Number.isNaN(dateFromValue)) {
    return [];
  }

  if (hasDateTo && Number.isNaN(dateToValue)) {
    return [];
  }

  if (hasDateFrom || hasDateTo) {
    candidates.push(resolveDateRangeIndices(dataset, dateFromValue, dateToValue));
  }

  if (candidates.length === 0) {
    return dataset.allIndices;
  }

  candidates.sort((left, right) => left.length - right.length);

  return candidates.reduce((current, candidate) => {
    if (current === null) return [...candidate];
    if (current.length === 0 || candidate.length === 0) return [];
    return intersectSortedIndices(current, candidate);
  }, null as number[] | null) ?? [];
};

const buildFilterCacheKey = (filters: BacktestReportFilters): string =>
  JSON.stringify({
    market: normalizeToken(filters.market),
    source: normalizeToken(filters.source),
    dateFrom: String(filters.dateFrom ?? '').trim(),
    dateTo: String(filters.dateTo ?? '').trim(),
  });

const aggregateFilteredBets = (
  dataset: BacktestDatasetIndex,
  filteredIndices: number[],
  openingBankroll: number
): AggregatedReportSections => {
  const summaryAccumulator = createSummaryAccumulator();
  const byCompetition = new Map<string, GroupAccumulator>();
  const byMarket = new Map<string, GroupAccumulator>();
  const bySource = new Map<string, GroupAccumulator>();
  const byConfidence = new Map<string, GroupAccumulator>();
  const byEvBucket = new Map<string, GroupAccumulator>();
  const byEdgeBucket = new Map<string, GroupAccumulator>();
  const probabilityBuckets: ProbabilityBucketAccumulator[] = PROBABILITY_BUCKETS.map((bucket) => ({
    bucket,
    summary: createSummaryAccumulator(),
    probabilitySum: 0,
  }));

  for (const index of filteredIndices) {
    const bet = dataset.bets[index];
    accumulateSummary(summaryAccumulator, bet);
    accumulateGroup(byCompetition, bet.competitionKey, bet.competitionLabel, bet);
    accumulateGroup(byMarket, bet.marketCategoryKey, bet.marketCategoryLabel, bet);
    accumulateGroup(bySource, bet.sourceKey, bet.sourceKey, bet);
    accumulateGroup(byConfidence, bet.confidenceKey, bet.confidenceLabel, bet);

    const evBucket = EV_BUCKETS[bet.evBucketIndex] ?? EV_BUCKETS[EV_BUCKETS.length - 1];
    const edgeBucket = EDGE_BUCKETS[bet.edgeBucketIndex] ?? EDGE_BUCKETS[EDGE_BUCKETS.length - 1];
    const probabilityBucket = probabilityBuckets[bet.probabilityBucketIndex] ?? probabilityBuckets[probabilityBuckets.length - 1];

    accumulateGroup(byEvBucket, evBucket.key, evBucket.label, bet);
    accumulateGroup(byEdgeBucket, edgeBucket.key, edgeBucket.label, bet);
    accumulateSummary(probabilityBucket.summary, bet);
    probabilityBucket.probabilitySum += bet.probabilityRaw;
  }

  return {
    summary: finalizeSummary(summaryAccumulator, openingBankroll),
    byCompetition: finalizeGroups(byCompetition, openingBankroll),
    byMarket: finalizeGroups(byMarket, openingBankroll),
    bySource: finalizeGroups(bySource, openingBankroll),
    byConfidence: finalizeGroups(byConfidence, openingBankroll),
    byEvBucket: finalizeGroups(byEvBucket, openingBankroll),
    byEdgeBucket: finalizeGroups(byEdgeBucket, openingBankroll),
    probabilityBuckets: finalizeProbabilityBuckets(probabilityBuckets, openingBankroll),
  };
};

const buildAlerts = (
  probabilityBuckets: ProbabilityBucketSummary[],
  evSegments: SegmentSummary[],
  edgeSegments: SegmentSummary[],
  confidenceSegments: SegmentSummary[],
  legacyData: boolean
): CalibrationAlert[] => {
  const alerts: CalibrationAlert[] = [];

  if (legacyData) {
    alerts.push({
      severity: 'warning',
      type: 'legacy_data',
      bucketKey: 'legacy_run',
      message: 'Questo run è legacy: mancano i dettagli bet-level. Il report avanzato richiede un rerun del backtest.',
    });
  }

  for (const bucket of probabilityBuckets) {
    if (bucket.count < 15) continue;
    const gap = Math.abs(bucket.calibrationGapPct);
    if (gap >= 15) {
      alerts.push({
        severity: 'critical',
        type: 'probability_bucket',
        bucketKey: bucket.key,
        message: `Bucket probabilità ${bucket.label}: previsto ${bucket.predictedProbabilityPct.toFixed(1)}%, realizzato ${bucket.actualFrequencyPct.toFixed(1)}% su ${bucket.count} bet.`,
      });
    } else if (gap >= 8) {
      alerts.push({
        severity: 'warning',
        type: 'probability_bucket',
        bucketKey: bucket.key,
        message: `Bucket probabilità ${bucket.label} poco calibrato: gap ${bucket.calibrationGapPct.toFixed(1)} pp su ${bucket.count} bet.`,
      });
    }
  }

  for (const bucket of evSegments) {
    if (bucket.totalBets < 12) continue;
    if (bucket.expectedEvPct >= 5 && bucket.yieldPct < 0) {
      alerts.push({
        severity: 'critical',
        type: 'ev_bucket',
        bucketKey: bucket.key,
        message: `Bucket EV ${bucket.label}: EV atteso ${bucket.expectedEvPct.toFixed(2)}% ma yield realizzato ${bucket.yieldPct.toFixed(2)}%.`,
      });
    }
  }

  for (const bucket of edgeSegments) {
    if (bucket.totalBets < 12) continue;
    if (bucket.avgEdgePct >= 5 && bucket.yieldPct < 0) {
      alerts.push({
        severity: 'warning',
        type: 'edge_bucket',
        bucketKey: bucket.key,
        message: `Bucket edge ${bucket.label}: edge medio ${bucket.avgEdgePct.toFixed(2)} pp ma performance negativa.`,
      });
    }
  }

  for (const bucket of confidenceSegments) {
    if (bucket.totalBets < 10) continue;
    if (bucket.key === 'high' && bucket.yieldPct < 0) {
      alerts.push({
        severity: 'critical',
        type: 'confidence_bucket',
        bucketKey: bucket.key,
        message: `Le raccomandazioni HIGH sono negative (${bucket.yieldPct.toFixed(2)}% di yield).`,
      });
    }
  }

  return alerts.slice(0, 8);
};

const buildLegacySummary = (result: BacktestReportSource, openingBankroll: number): SummaryMetrics => {
  const totalStaked = toFinite(result.totalStaked);
  const netProfit = toFinite(result.netProfit);
  const expectedEvPct = toFinite(result.averageEV);
  const expectedProfit = (expectedEvPct / 100) * totalStaked;
  const yieldPct = safePercent(netProfit, totalStaked);
  return {
    totalBets: Math.max(0, Math.trunc(toFinite(result.betsPlaced))),
    settledBets: Math.max(0, Math.trunc(toFinite(result.betsPlaced))),
    totalStaked: Number(totalStaked.toFixed(2)),
    totalReturn: Number(toFinite(result.totalReturn).toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),
    roiPct: Number(safePercent(netProfit, openingBankroll).toFixed(2)),
    yieldPct: Number(yieldPct.toFixed(2)),
    hitRatePct: Number(toFinite(result.winRate).toFixed(2)),
    brierScore: Number(toFinite(result.brierScore).toFixed(4)),
    logLoss: Number(toFinite(result.logLoss).toFixed(4)),
    expectedProfit: Number(expectedProfit.toFixed(2)),
    expectedEvPct: Number(expectedEvPct.toFixed(2)),
    realizedEvPct: Number(yieldPct.toFixed(2)),
    evDeltaPct: Number((yieldPct - expectedEvPct).toFixed(2)),
    evCapturePct: Math.abs(expectedProfit) > 0.000001 ? Number(((netProfit / expectedProfit) * 100).toFixed(2)) : null,
    avgOdds: Number(toFinite(result.averageOdds).toFixed(2)),
    avgProbabilityPct: 0,
    avgEdgePct: 0,
  };
};

export const buildBacktestReport = (
  result: BacktestReportSource,
  filters: BacktestReportFilters = {}
): BacktestReport => {
  const rawDetailedBets = Array.isArray(result?.detailedBets) ? result.detailedBets : [];
  const allDetailedBets = rawDetailedBets.every((bet) => Boolean(bet && typeof bet === 'object'))
    ? rawDetailedBets as BacktestBetDetail[]
    : rawDetailedBets.filter((bet): bet is BacktestBetDetail => Boolean(bet && typeof bet === 'object'));
  const cachedDataset = datasetIndexCache.get(allDetailedBets);
  const datasetIndex = cachedDataset ?? buildNormalizedDataset(allDetailedBets);
  if (!cachedDataset) {
    datasetIndexCache.set(allDetailedBets, datasetIndex);
  }
  const legacyData = allDetailedBets.length === 0;
  const openingBankroll = DEFAULT_OPENING_BANKROLL;
  const filterCacheKey = buildFilterCacheKey(filters);
  const cachedAggregation = legacyData ? null : datasetIndex.aggregationCache.get(filterCacheKey);
  const filteredIndices = legacyData
    ? []
    : cachedAggregation?.filteredIndices ?? resolveFilteredIndices(datasetIndex, filters);
  const aggregatedSections = legacyData
    ? null
    : cachedAggregation?.sections ?? aggregateFilteredBets(datasetIndex, filteredIndices, openingBankroll);
  if (!legacyData && !cachedAggregation) {
    datasetIndex.aggregationCache.set(filterCacheKey, {
      filteredIndices,
      sections: aggregatedSections,
    });
  }
  const summary = legacyData
    ? buildLegacySummary(result, openingBankroll)
    : aggregatedSections?.summary ?? finalizeSummary(createSummaryAccumulator(), openingBankroll);
  const byCompetition = legacyData ? [] : aggregatedSections?.byCompetition ?? [];
  const byMarket = legacyData ? [] : aggregatedSections?.byMarket ?? [];
  const bySource = legacyData ? [] : aggregatedSections?.bySource ?? [];
  const byConfidence = legacyData ? [] : aggregatedSections?.byConfidence ?? [];
  const byEvBucket = legacyData ? [] : aggregatedSections?.byEvBucket ?? [];
  const byEdgeBucket = legacyData ? [] : aggregatedSections?.byEdgeBucket ?? [];
  const probabilityBuckets = legacyData ? [] : aggregatedSections?.probabilityBuckets ?? [];
  const alerts = buildAlerts(probabilityBuckets, byEvBucket, byEdgeBucket, byConfidence, legacyData);

  return {
    run: {
      kind: result?.kind === 'walk_forward' ? 'walk_forward' : 'classic',
      competition: String(result?.competition ?? 'all'),
      season: String(result?.season ?? 'all'),
      openingBankroll,
      totalDetailedBets: allDetailedBets.length,
      usedSyntheticOddsOnly: Boolean(result?.usedSyntheticOddsOnly),
    },
    filtersApplied: {
      market: String(filters.market ?? '').trim() || null,
      source: String(filters.source ?? '').trim() || null,
      dateFrom: String(filters.dateFrom ?? '').trim() || null,
      dateTo: String(filters.dateTo ?? '').trim() || null,
    },
    dataset: {
      legacyData,
      totalDetailedBets: allDetailedBets.length,
      filteredBets: legacyData ? 0 : filteredIndices.length,
      availableMarkets: datasetIndex.availableMarkets,
      availableSources: datasetIndex.availableSources,
      dateRange: {
        min: datasetIndex.minDateValue === null ? null : new Date(datasetIndex.minDateValue).toISOString(),
        max: datasetIndex.maxDateValue === null ? null : new Date(datasetIndex.maxDateValue).toISOString(),
      },
      quality: datasetIndex.quality,
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
    alerts,
    clv: {
      status: 'todo',
      available: false,
      reason: 'Il backtest usa oggi l’ultimo snapshot archiviato per match. Senza una quota salvata al timestamp della raccomandazione la CLV sarebbe metodologicamente fuorviante.',
    },
  };
};
