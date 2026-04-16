import { BacktestBetDetail } from '../models/BacktestingEngine';

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
];

const EDGE_BUCKETS = [
  { key: 'lt_0', label: '< 0 pp', min: Number.NEGATIVE_INFINITY, max: 0 },
  { key: '0_2', label: '0 - 2 pp', min: 0, max: 0.02 },
  { key: '2_5', label: '2 - 5 pp', min: 0.02, max: 0.05 },
  { key: '5_8', label: '5 - 8 pp', min: 0.05, max: 0.08 },
  { key: 'gte_8', label: '>= 8 pp', min: 0.08, max: Number.POSITIVE_INFINITY },
];

const PROBABILITY_BUCKETS = Array.from({ length: 10 }, (_, index) => ({
  key: `${index * 10}_${(index + 1) * 10}`,
  label: `${index * 10}% - ${(index + 1) * 10}%`,
  min: index / 10,
  max: (index + 1) / 10,
}));

const normalizeSource = (value: unknown): string => {
  const source = String(value ?? '').trim().toLowerCase();
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

const summarizeBets = (bets: BacktestBetDetail[], openingBankroll: number): SummaryMetrics => {
  const totalBets = bets.length;
  const totalStaked = bets.reduce((sum, bet) => sum + toFinite(bet.stake), 0);
  const totalReturn = bets.reduce((sum, bet) => sum + (toFinite(bet.profit) + toFinite(bet.stake)), 0);
  const netProfit = bets.reduce((sum, bet) => sum + toFinite(bet.profit), 0);
  const wins = bets.filter((bet) => bet.won).length;
  const brierScore = totalBets > 0
    ? bets.reduce((sum, bet) => sum + ((toFinite(bet.ourProbability) - (bet.won ? 1 : 0)) ** 2), 0) / totalBets
    : 0;
  const logLoss = totalBets > 0
    ? -bets.reduce((sum, bet) => {
      const probability = Math.min(0.999999, Math.max(0.000001, toFinite(bet.ourProbability)));
      return sum + (bet.won ? Math.log(probability) : Math.log(1 - probability));
    }, 0) / totalBets
    : 0;
  const expectedProfit = bets.reduce((sum, bet) => sum + (toFinite(bet.stake) * toFinite(bet.expectedValue)), 0);
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
    avgOdds: totalBets > 0 ? Number((bets.reduce((sum, bet) => sum + toFinite(bet.odds), 0) / totalBets).toFixed(2)) : 0,
    avgProbabilityPct: totalBets > 0 ? Number((bets.reduce((sum, bet) => sum + toFinite(bet.ourProbability), 0) / totalBets * 100).toFixed(2)) : 0,
    avgEdgePct: totalBets > 0 ? Number((bets.reduce((sum, bet) => sum + toFinite(bet.edge), 0) / totalBets * 100).toFixed(2)) : 0,
  };
};

const groupBets = (
  bets: BacktestBetDetail[],
  getKey: (bet: BacktestBetDetail) => { key: string; label: string } | null,
  openingBankroll: number
): SegmentSummary[] => {
  const groups = new Map<string, { label: string; bets: BacktestBetDetail[] }>();
  for (const bet of bets) {
    const resolved = getKey(bet);
    if (!resolved) continue;
    const bucket = groups.get(resolved.key) ?? { label: resolved.label, bets: [] };
    bucket.bets.push(bet);
    groups.set(resolved.key, bucket);
  }

  return Array.from(groups.entries())
    .map(([key, bucket]) => ({
      key,
      label: bucket.label,
      ...summarizeBets(bucket.bets, openingBankroll),
    }))
    .sort((left, right) => right.totalBets - left.totalBets);
};

const buildProbabilityBuckets = (bets: BacktestBetDetail[], openingBankroll: number): ProbabilityBucketSummary[] =>
  PROBABILITY_BUCKETS.map((bucket, index) => {
    const bucketBets = bets.filter((bet) => {
      const probability = toFinite(bet.ourProbability);
      if (index === PROBABILITY_BUCKETS.length - 1) {
        return probability >= bucket.min && probability <= bucket.max;
      }
      return probability >= bucket.min && probability < bucket.max;
    });
    const summary = summarizeBets(bucketBets, openingBankroll);
    const predictedProbabilityPct = bucketBets.length > 0
      ? Number((bucketBets.reduce((sum, bet) => sum + toFinite(bet.ourProbability), 0) / bucketBets.length * 100).toFixed(2))
      : 0;
    const actualFrequencyPct = summary.hitRatePct;
    return {
      key: bucket.key,
      label: bucket.label,
      predictedProbabilityPct,
      actualFrequencyPct,
      calibrationGapPct: Number((actualFrequencyPct - predictedProbabilityPct).toFixed(2)),
      count: bucketBets.length,
      ...summary,
    };
  }).filter((bucket) => bucket.count > 0);

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

const resolveBucket = (
  value: number,
  buckets: Array<{ key: string; label: string; min: number; max: number }>
): { key: string; label: string } => {
  const bucket = buckets.find((candidate) => value >= candidate.min && value < candidate.max)
    ?? buckets[buckets.length - 1];
  return { key: bucket.key, label: bucket.label };
};

const filterBets = (bets: BacktestBetDetail[], filters: BacktestReportFilters): BacktestBetDetail[] => {
  const marketFilter = String(filters.market ?? '').trim().toLowerCase();
  const sourceFilter = normalizeSource(filters.source);
  const dateFromValue = filters.dateFrom ? new Date(filters.dateFrom).getTime() : null;
  const dateToValue = filters.dateTo ? new Date(filters.dateTo).getTime() : null;

  return bets.filter((bet) => {
    const matchDateValue = new Date(bet.matchDate).getTime();
    const normalizedSource = normalizeSource(bet.oddsSource);
    const marketMatches = !marketFilter || String(bet.marketCategory ?? '').toLowerCase() === marketFilter || String(bet.marketName ?? '').toLowerCase() === marketFilter;
    const sourceMatches = !String(filters.source ?? '').trim() || normalizedSource === sourceFilter;
    const fromMatches = dateFromValue === null || (!Number.isNaN(matchDateValue) && matchDateValue >= dateFromValue);
    const toMatches = dateToValue === null || (!Number.isNaN(matchDateValue) && matchDateValue <= dateToValue);
    return marketMatches && sourceMatches && fromMatches && toMatches;
  });
};

const buildLegacySummary = (result: Record<string, any>, openingBankroll: number): SummaryMetrics => {
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
  result: Record<string, any>,
  filters: BacktestReportFilters = {}
): BacktestReport => {
  const allDetailedBets = Array.isArray(result?.detailedBets)
    ? result.detailedBets.filter((bet) => bet && typeof bet === 'object') as BacktestBetDetail[]
    : [];
  const legacyData = allDetailedBets.length === 0;
  const openingBankroll = DEFAULT_OPENING_BANKROLL;
  const filteredBets = filterBets(allDetailedBets, filters);
  const availableMarkets = Array.from(new Set(allDetailedBets.map((bet) => String(bet.marketCategory ?? '').trim()).filter(Boolean))).sort();
  const availableSources = Array.from(new Set(allDetailedBets.map((bet) => normalizeSource(bet.oddsSource)).filter(Boolean))).sort();
  const dateValues = allDetailedBets
    .map((bet) => {
      const date = new Date(bet.matchDate).getTime();
      return Number.isNaN(date) ? null : date;
    })
    .filter((value): value is number => value !== null)
    .sort((left, right) => left - right);

  const summary = legacyData
    ? buildLegacySummary(result, openingBankroll)
    : summarizeBets(filteredBets, openingBankroll);

  const byCompetition = legacyData
    ? []
    : groupBets(filteredBets, (bet) => ({ key: String(bet.competition ?? 'unknown'), label: String(bet.competition ?? 'unknown') }), openingBankroll);
  const byMarket = legacyData
    ? []
    : groupBets(filteredBets, (bet) => ({ key: String(bet.marketCategory), label: String(bet.marketCategory) }), openingBankroll);
  const bySource = legacyData
    ? []
    : groupBets(filteredBets, (bet) => {
      const normalized = normalizeSource(bet.oddsSource);
      return { key: normalized, label: normalized };
    }, openingBankroll);
  const byConfidence = legacyData
    ? []
    : groupBets(filteredBets, (bet) => ({ key: String(bet.confidence).toLowerCase(), label: String(bet.confidence) }), openingBankroll);
  const byEvBucket = legacyData
    ? []
    : groupBets(filteredBets, (bet) => resolveBucket(toFinite(bet.expectedValue), EV_BUCKETS), openingBankroll);
  const byEdgeBucket = legacyData
    ? []
    : groupBets(filteredBets, (bet) => resolveBucket(toFinite(bet.edge), EDGE_BUCKETS), openingBankroll);
  const probabilityBuckets = legacyData ? [] : buildProbabilityBuckets(filteredBets, openingBankroll);
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
      filteredBets: legacyData ? 0 : filteredBets.length,
      availableMarkets,
      availableSources,
      dateRange: {
        min: dateValues.length > 0 ? new Date(dateValues[0]).toISOString() : null,
        max: dateValues.length > 0 ? new Date(dateValues[dateValues.length - 1]).toISOString() : null,
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
    alerts,
    clv: {
      status: 'todo',
      available: false,
      reason: 'Il backtest usa oggi l’ultimo snapshot archiviato per match. Senza una quota salvata al timestamp della raccomandazione la CLV sarebbe metodologicamente fuorviante.',
    },
  };
};

