import { ValueBettingEngine } from '../models/value/ValueBettingEngine';
import { GoalMarket, MarketQuote, evaluateGoalQuote, normalizeScoreMatrix, scoreMatrixMarkets, settleGoalQuote } from './GoalSettlement';
import { applyResearchProbabilityPipeline, fitResearchCalibration, goalCalibrationObservation } from './ResearchProbabilityPipeline';

export type ResearchQuote = MarketQuote & { priceType?: 't15' | 'prematch' | 'opening' | 'closing' | 'unknown' };
export type EvaluationRow = {
  matchId: string; competition: string; season: string; kickoffAt: string; forecastAt: string;
  homeGoals: number; awayGoals: number; matrixA: number[][]; matrixC: number[][];
  probabilitiesA?: Record<string, number>; probabilitiesC?: Record<string, number>;
  quotes: ResearchQuote[]; closingQuotes?: MarketQuote[]; phase?: 'validation' | 'test';
  modelVersionA: string; modelVersionC: string;
};
export type CalibrationSample = {
  matchId: string; market: GoalMarket; probability: number; odds: number; expectedValue: number;
  returnMultiplier: number; outcomeAvailableAt: string; phase: 'validation';
};
export type ResearchDecision = {
  quote: ResearchQuote; probability: number; ev: number; prudentialEv: number; score: number;
  uncertainty: number; calibrationN: number; prudentialMethod: 'validation_payout_residual_hoeffding';
  priceType: 't15' | 'prematch' | 'opening'; kellyFraction: number;
};
export type ResearchDecisionInput = {
  matrix: number[][]; probabilities?: Record<string, number>; quotes: ResearchQuote[];
  calibrationSamples?: CalibrationSample[]; allowedMarkets?: string[]; now?: string | Date; historical?: boolean;
};
export type ResearchEvaluationOptions = { seed?: number; bootstrapSamples?: number; initialBankroll?: number; allowedMarkets?: string[] };

const RESULT_DELAY = 2 * 60 * 60 * 1000;
const MIN_VALIDATION_MATCHES = 50;
const MIN_EV = 0.04;
const MIN_PRUDENTIAL_EV = 0.01;
const engine = new ValueBettingEngine();
const finiteProbability = (p: unknown): p is number => typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1;
const at = (value: string | Date | undefined): number => value instanceof Date ? value.getTime() : Date.parse(value ?? '');
const mean = (values: number[]): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const eventKey = (q: MarketQuote): string => [q.market, q.side, q.team ?? '', q.line ?? ''].join(':');
const weekKey = (date: string): string => {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
};

function priceReason(quote: ResearchQuote, now: number, historical: boolean): string | null {
  if (settleGoalQuote(quote, 0, 0).status === 'UNRESOLVED') return 'invalid_or_non_real_quote';
  if (historical && !Number.isFinite(now)) return 'forecast_time_required';
  if (quote.timestampEvidence === 'observed_snapshot') {
    if (!historical || quote.priceType !== 'prematch') return 'observed_snapshot_is_historical_prematch_only';
    if (at(quote.capturedAt) !== now) return 'quote_observation_forecast_mismatch';
  }
  if (Number.isFinite(now) && (at(quote.capturedAt) > now || at(quote.updatedAt) > now)) return 'future_quote';
  if (quote.priceType === 'closing') return 'closing_is_not_entry';
  if ((quote.priceType && !['t15', 'prematch', 'opening', 'closing'].includes(quote.priceType))
    || /aggregate|unknown|fallback/i.test(quote.source)) return 'unknown_price_semantics';
  if (!quote.priceType && !/odds_api|theoddsapi/i.test(quote.source)) return 'unknown_price_semantics';
  if (quote.priceType === 't15' && Number.isFinite(now)
    && (now - at(quote.capturedAt) > 5 * 60 * 1000 || now - at(quote.updatedAt) > 5 * 60 * 1000)) return 'stale_t15_quote';
  return null;
}

function canonicalKey(quote: MarketQuote): string | null {
  if (quote.market === '1x2') return quote.side === 'home' ? 'homeWin' : quote.side === 'away' ? 'awayWin' : 'draw';
  if (quote.market === 'double_chance') return `double_chance_${quote.side}`;
  if (quote.market === 'dnb') return `dnb_${quote.side}`;
  if (quote.market === 'btts') return quote.side === 'yes' ? 'btts' : 'bttsNo';
  if (quote.market === 'totals' && Number.isFinite(quote.line)) return `${quote.side}${String(quote.line).replace('.', '')}`;
  if (quote.market === 'team_totals') return `team_${quote.team}_${quote.side}_${quote.line}`;
  if (quote.market === 'asian_handicap') return quote.side === 'away' ? `ahcp_away_${quote.line}` : `ahcp_${quote.line}`;
  if (quote.market === 'european_handicap' && quote.side !== 'draw') {
    const line = quote.side === 'home' ? quote.line! : -quote.line!;
    return `hcp_${quote.side}${line > 0 ? '+' : ''}${line}`;
  }
  return null;
}

function quoteForecast(matrix: number[][], quote: MarketQuote, probabilities?: Record<string, number>) {
  const evaluated = evaluateGoalQuote(matrix, quote);
  const canonical = canonicalKey(quote);
  const supplied = probabilities?.[quote.selection] ?? (canonical ? probabilities?.[canonical] : undefined);
  if (supplied !== undefined && !finiteProbability(supplied)) throw new Error('Invalid supplied probability');
  const probability = supplied ?? evaluated.probability;
  let activeStake = evaluated.win + evaluated.loss + (evaluated.halfWin + evaluated.halfLoss) / 2;
  if (quote.market === 'dnb' && finiteProbability(probabilities?.draw)) activeStake = 1 - probabilities!.draw;
  // Pushes are refunded. The live binary EV helper is valid only when the whole stake is at risk.
  const binaryEv = probability > 0 && probability < 1
    ? engine.computeExpectedValue(probability, quote.odds) : probability * quote.odds - 1;
  return { probability, expectedValue: activeStake * binaryEv, activeStake };
}

/** Explainable abstention is separate from the public nullable selection API. */
export function explainResearchDecision(input: ResearchDecisionInput): { decision: ResearchDecision | null; reasons: Record<string, number> } {
  const reasons: Record<string, number> = {};
  const exclude = (reason: string) => { reasons[reason] = (reasons[reason] ?? 0) + 1; };
  const now = at(input.now);
  const historical = input.historical !== false;
  if (!Number.isFinite(now)) return { decision: null, reasons: { forecast_time_required: 1 } };
  let matrix: number[][];
  try { matrix = normalizeScoreMatrix(input.matrix); } catch { return { decision: null, reasons: { invalid_matrix: 1 } }; }
  const candidates: ResearchDecision[] = [];
  for (const quote of input.quotes ?? []) {
    if (input.allowedMarkets && !input.allowedMarkets.includes(quote.market)) { exclude('market_not_allowed'); continue; }
    const invalidPrice = priceReason(quote, now, historical);
    if (invalidPrice) { exclude(invalidPrice); continue; }
    let forecast: ReturnType<typeof quoteForecast>;
    try { forecast = quoteForecast(matrix, quote, input.probabilities); } catch { exclude('invalid_probability'); continue; }
    if (forecast.expectedValue + 1e-12 < MIN_EV) { exclude('central_ev_below_threshold'); continue; }
    // Freeze outcome knowledge at the forecast time and use one label per match in each bucket.
    const bucket = Math.min(4, Math.floor(forecast.probability * 5));
    const unique = new Map<string, CalibrationSample>();
    const orderedSamples = [...(input.calibrationSamples ?? [])].sort((a, b) => a.matchId.localeCompare(b.matchId)
      || a.probability - b.probability || a.odds - b.odds || a.expectedValue - b.expectedValue || a.returnMultiplier - b.returnMultiplier);
    for (const sample of orderedSamples) {
      if (sample.phase !== 'validation' || sample.market !== quote.market || !sample.matchId
        || !finiteProbability(sample.probability) || Math.min(4, Math.floor(sample.probability * 5)) !== bucket
        || !Number.isFinite(sample.expectedValue) || !Number.isFinite(sample.odds) || sample.odds <= 1
        || sample.expectedValue < -1 || sample.expectedValue > sample.odds - 1 + 1e-8
        || !Number.isFinite(sample.returnMultiplier) || sample.returnMultiplier < 0 || sample.returnMultiplier > sample.odds
        || !Number.isFinite(at(sample.outcomeAvailableAt)) || at(sample.outcomeAvailableAt) > now) continue;
      if (!unique.has(sample.matchId)) unique.set(sample.matchId, sample);
    }
    const samples = [...unique.values()];
    if (samples.length < MIN_VALIDATION_MATCHES) { exclude('insufficient_validation_calibration'); continue; }
    const residual = mean(samples.map((sample) => sample.returnMultiplier - 1 - sample.expectedValue));
    // Independent match clusters; each unit payout has known range [0, odds]. One-sided 95% Hoeffding bound.
    const uncertainty = Math.sqrt(Math.log(20) * samples.reduce((sum, sample) => sum + sample.odds ** 2, 0)
      / (2 * samples.length ** 2));
    const prudentialEv = Math.min(forecast.expectedValue, forecast.expectedValue + residual - uncertainty);
    if (prudentialEv + 1e-12 < MIN_PRUDENTIAL_EV) { exclude('prudential_ev_below_threshold'); continue; }
    candidates.push({ quote, probability: forecast.probability, ev: forecast.expectedValue, prudentialEv,
      score: prudentialEv, uncertainty, calibrationN: samples.length,
      prudentialMethod: 'validation_payout_residual_hoeffding',
      priceType: quote.priceType === 'opening' ? 'opening' : quote.priceType === 't15' ? 't15' : 'prematch',
      kellyFraction: engine.kellyFraction(forecast.probability, quote.odds),
    });
  }
  candidates.sort((a, b) => b.score - a.score || b.ev - a.ev || eventKey(a.quote).localeCompare(eventKey(b.quote))
    || a.quote.bookmaker.localeCompare(b.quote.bookmaker));
  if (!(input.quotes ?? []).length) exclude('quotes_missing');
  return { decision: candidates[0] ?? null, reasons };
}

export function selectResearchDecision(input: ResearchDecisionInput): ResearchDecision | null {
  return explainResearchDecision(input).decision;
}

type Observation = {
  matchId: string; competition: string; season: string; week: string;
  logLossA: number; logLossC: number; brierA: number; brierC: number;
  calibrationA: number; calibrationC: number; observedA: number; observedC: number;
};
const logProbability = (p: number) => -Math.log(Math.max(1e-15, Math.min(1 - 1e-15, p)));

function oneXTwo(row: EvaluationRow, family: 'A' | 'C'): number[] {
  const flat = scoreMatrixMarkets(family === 'A' ? row.matrixA : row.matrixC);
  const supplied = family === 'A' ? row.probabilitiesA : row.probabilitiesC;
  const probabilities = ['homeWin', 'draw', 'awayWin'].map((key) => supplied?.[key] ?? flat[key]);
  if (probabilities.some((p) => !finiteProbability(p)) || mean(probabilities) <= 0) throw new Error('Invalid 1X2 probabilities');
  const sum = probabilities.reduce((total, value) => total + value, 0);
  return probabilities.map((p) => p / sum);
}

function primaryObservation(row: EvaluationRow): Observation {
  const A = oneXTwo(row, 'A'), C = oneXTwo(row, 'C');
  const outcome = row.homeGoals > row.awayGoals ? 0 : row.homeGoals === row.awayGoals ? 1 : 2;
  const maximum = (p: number[]) => p.indexOf(Math.max(...p));
  return { matchId: row.matchId, competition: row.competition, season: row.season, week: weekKey(row.kickoffAt),
    logLossA: logProbability(A[outcome]), logLossC: logProbability(C[outcome]),
    brierA: A.reduce((sum, p, index) => sum + (p - Number(index === outcome)) ** 2, 0),
    brierC: C.reduce((sum, p, index) => sum + (p - Number(index === outcome)) ** 2, 0),
    calibrationA: Math.max(...A), calibrationC: Math.max(...C),
    observedA: Number(maximum(A) === outcome), observedC: Number(maximum(C) === outcome) };
}

function bookmakerProbabilities(row: EvaluationRow): number[] | null {
  const groups = new Map<string, ResearchQuote[]>();
  for (const quote of row.quotes ?? []) {
    if (quote.market !== '1x2' || priceReason(quote, at(row.forecastAt), true)) continue;
    const key = [quote.bookmaker, quote.source, quote.capturedAt].join(':');
    const group = groups.get(key) ?? []; group.push(quote); groups.set(key, group);
  }
  const complete = [...groups.values()].filter((group) => ['home', 'draw', 'away'].every((side) => group.some((q) => q.side === side)))
    .sort((a, b) => Number(!/eurobet/i.test(a[0].bookmaker)) - Number(!/eurobet/i.test(b[0].bookmaker))
      || a[0].bookmaker.localeCompare(b[0].bookmaker));
  if (!complete.length) return null;
  const implied = ['home', 'draw', 'away'].map((side) => 1 / complete[0].find((quote) => quote.side === side)!.odds);
  const total = implied.reduce((sum, p) => sum + p, 0);
  return implied.map((p) => p / total);
}

function metrics(observations: Observation[], family: 'A' | 'C') {
  const n = observations.length;
  if (!n) return { logLoss: null, brier: null, ece: null, n: 0, calibration: [] };
  let ece = 0;
  const calibration: Array<{ lower: number; upper: number; n: number; predicted: number; observed: number }> = [];
  for (let bin = 0; bin < 10; bin++) {
    const bucket = observations.filter((row) => Math.min(9, Math.floor(row[`calibration${family}`] * 10)) === bin);
    if (bucket.length) {
      const predicted = mean(bucket.map((row) => row[`calibration${family}`]));
      const observed = mean(bucket.map((row) => row[`observed${family}`]));
      ece += bucket.length / n * Math.abs(predicted - observed);
      calibration.push({ lower: bin / 10, upper: (bin + 1) / 10, n: bucket.length, predicted, observed });
    }
  }
  return { logLoss: mean(observations.map((row) => row[`logLoss${family}`])),
    brier: mean(observations.map((row) => row[`brier${family}`])), ece, n, calibration };
}

function randomGenerator(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state += 0x6D2B79F5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
const quantile = (sorted: number[], fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];

function pairedIntervals(rows: Observation[], samples: number, seed: number, weekly: boolean) {
  if (!rows.length) return { logLoss: null, brier: null, clusters: 0 };
  const clusters = new Map<string, Observation[]>();
  for (const row of rows) { const key = weekly ? row.week : row.matchId; const group = clusters.get(key) ?? []; group.push(row); clusters.set(key, group); }
  const groups = [...clusters.values()];
  const random = randomGenerator(seed);
  const logLoss: number[] = [], brier: number[] = [];
  for (let iteration = 0; iteration < samples; iteration++) {
    let n = 0, log = 0, score = 0;
    for (let index = 0; index < groups.length; index++) for (const row of groups[Math.floor(random() * groups.length)]) {
      n++; log += row.logLossC - row.logLossA; score += row.brierC - row.brierA;
    }
    logLoss.push(log / n); brier.push(score / n);
  }
  logLoss.sort((a, b) => a - b); brier.sort((a, b) => a - b);
  return { logLoss: [quantile(logLoss, 0.025), quantile(logLoss, 0.975)] as [number, number],
    brier: [quantile(brier, 0.025), quantile(brier, 0.975)] as [number, number], clusters: groups.length };
}

function pairedSummary(rows: Observation[], samples: number, seed: number) {
  const fixture = pairedIntervals(rows, samples, seed, false), weekly = pairedIntervals(rows, samples, seed + 1, true);
  return { n: rows.length, deltaLogLoss: rows.length ? mean(rows.map((row) => row.logLossC - row.logLossA)) : null,
    deltaBrier: rows.length ? mean(rows.map((row) => row.brierC - row.brierA)) : null,
    logLossCI: fixture.logLoss, brierCI: fixture.brier,
    weekLogLossCI: weekly.logLoss, weekBrierCI: weekly.brier,
    matchClusters: fixture.clusters, weekClusters: weekly.clusters };
}

function groupMetrics(rows: Observation[], keyOf: (row: Observation) => string) {
  const groups = new Map<string, Observation[]>();
  for (const row of rows) { const key = keyOf(row), bucket = groups.get(key) ?? []; bucket.push(row); groups.set(key, bucket); }
  return Object.fromEntries([...groups].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, bucket]) => [key, { A: metrics(bucket, 'A'), C: metrics(bucket, 'C'), n: bucket.length }]));
}

function validationSamples(rows: EvaluationRow[], family: 'A' | 'C'): CalibrationSample[] {
  const samples: CalibrationSample[] = [];
  for (const row of rows) for (const quote of row.quotes ?? []) {
    if (priceReason(quote, at(row.forecastAt), true)) continue;
    try {
      const forecast = quoteForecast(family === 'A' ? row.matrixA : row.matrixC, quote,
        family === 'A' ? row.probabilitiesA : row.probabilitiesC);
      const settlement = settleGoalQuote(quote, row.homeGoals, row.awayGoals);
      if (settlement.returnMultiplier === null) continue;
      samples.push({ matchId: row.matchId, market: quote.market, probability: forecast.probability,
        odds: quote.odds, expectedValue: forecast.expectedValue, returnMultiplier: settlement.returnMultiplier,
        outcomeAvailableAt: new Date(at(row.kickoffAt) + RESULT_DELAY).toISOString(), phase: 'validation' });
    } catch { /* Invalid validation inputs cannot become evidence. */ }
  }
  return samples;
}

function closingClv(row: EvaluationRow, decision: ResearchDecision): number | null {
  const closing = (row.closingQuotes ?? []).filter((quote) => eventKey(quote) === eventKey(decision.quote)
    && quote.bookmaker === decision.quote.bookmaker && settleGoalQuote(quote, 0, 0).status !== 'UNRESOLVED'
    && at(quote.capturedAt) > at(row.forecastAt) && at(quote.capturedAt) < at(row.kickoffAt)
    && at(quote.updatedAt) > at(row.forecastAt) && at(quote.updatedAt) < at(row.kickoffAt))
    .sort((a, b) => at(b.updatedAt) - at(a.updatedAt))[0];
  return closing ? decision.quote.odds / closing.odds - 1 : null;
}

type PlannedDecision = { row: EvaluationRow; A: ResearchDecision | null; C: ResearchDecision | null };
function economicSimulation(plans: PlannedDecision[], family: 'A' | 'C', fraction: number, initial: number) {
  const initialCents = Math.round(initial * 100);
  if (!Number.isSafeInteger(initialCents) || initialCents <= 0) throw new Error('Invalid virtual capital');
  let cashCents = initialCents, stakedCents = 0, profitCents = 0, peakCents = initialCents, maxDrawdown = 0;
  const pending: Array<{ settleAt: number; stakeCents: number; returnCents: number }> = [];
  const bets: Array<Record<string, unknown>> = [];
  const reasons: Record<string, number> = {};
  const equityCurve: Array<{ at: string; equityCents: number }> = [];
  const committedCents = () => pending.reduce((sum, item) => sum + item.stakeCents, 0);
  const settle = (now: number) => {
    pending.sort((a, b) => a.settleAt - b.settleAt);
    while (pending.length && pending[0].settleAt <= now) {
      const eventTime = pending[0].settleAt;
      while (pending.length && pending[0].settleAt === eventTime) cashCents += pending.shift()!.returnCents;
      const equityCents = cashCents + committedCents();
      peakCents = Math.max(peakCents, equityCents);
      maxDrawdown = Math.max(maxDrawdown, (peakCents - equityCents) / peakCents);
      equityCurve.push({ at: new Date(eventTime).toISOString(), equityCents });
    }
  };
  let currentTime = NaN, stakeBasisCents = initialCents;
  const orderedPlans = [...plans].sort((a, b) => at(a.row.forecastAt) - at(b.row.forecastAt)
    || (b[family]?.score ?? -Infinity) - (a[family]?.score ?? -Infinity)
    || a.row.matchId.localeCompare(b.row.matchId));
  for (const plan of orderedPlans) {
    const now = at(plan.row.forecastAt);
    if (now !== currentTime) { settle(now); stakeBasisCents = cashCents + committedCents(); currentTime = now; }
    const decision = plan[family];
    if (!decision) continue;
    // Identical cent rounding to ResearchStore: floor the stake and round the payout.
    const stakeCents = Math.floor(stakeBasisCents * fraction);
    if (stakeCents <= 0 || stakeCents > cashCents) { reasons.insufficient_available_capital = (reasons.insufficient_available_capital ?? 0) + 1; continue; }
    const committed = committedCents();
    if (committed + stakeCents > Math.floor((cashCents + committed) * 0.05)) {
      reasons.max_exposure_exceeded = (reasons.max_exposure_exceeded ?? 0) + 1; continue;
    }
    const outcome = settleGoalQuote(decision.quote, plan.row.homeGoals, plan.row.awayGoals);
    if (outcome.returnMultiplier === null) { reasons.unresolved_outcome = (reasons.unresolved_outcome ?? 0) + 1; continue; }
    const returnCents = Math.round(stakeCents * outcome.returnMultiplier);
    cashCents -= stakeCents; stakedCents += stakeCents; profitCents += returnCents - stakeCents;
    pending.push({ settleAt: at(plan.row.kickoffAt) + RESULT_DELAY, stakeCents, returnCents });
    const isT15 = decision.priceType !== 'opening' && decision.quote.timestampEvidence !== 'observed_snapshot'
      && Math.abs(at(plan.row.kickoffAt) - now - 15 * 60 * 1000) <= 60 * 1000
      && now - at(decision.quote.capturedAt) <= 5 * 60 * 1000 && now - at(decision.quote.updatedAt) <= 5 * 60 * 1000;
    bets.push({ matchId: plan.row.matchId, competition: plan.row.competition, season: plan.row.season,
      modelVersion: family === 'A' ? plan.row.modelVersionA : plan.row.modelVersionC,
      selection: decision.quote.selection, market: decision.quote.market,
      bookmaker: decision.quote.bookmaker, odds: decision.quote.odds, stake: stakeCents / 100,
      stakeCents, returnCents, status: outcome.status, profit: (returnCents - stakeCents) / 100,
      forecastAt: plan.row.forecastAt, timestampEvidence: decision.quote.timestampEvidence ?? 'provider_update',
      priceType: isT15 ? 't15' : decision.priceType === 't15' ? 'prematch' : decision.priceType,
      clv: closingClv(plan.row, decision) });
  }
  settle(Infinity);
  const clvs = bets.map((bet) => bet.clv).filter((value): value is number => typeof value === 'number');
  const economicGroups = (key: (bet: Record<string, unknown>) => string) => {
    const groups: Record<string, { bets: number; totalStaked: number; netProfit: number; roi: number | null }> = {};
    for (const bet of bets) {
      const group = groups[key(bet)] ??= { bets: 0, totalStaked: 0, netProfit: 0, roi: null };
      group.bets++; group.totalStaked = Math.round(group.totalStaked * 100 + Number(bet.stakeCents)) / 100;
      group.netProfit = Math.round(group.netProfit * 100 + Number(bet.returnCents) - Number(bet.stakeCents)) / 100;
      group.roi = group.netProfit / group.totalStaked;
    }
    return groups;
  };
  const weeks = new Map<string, Array<Record<string, unknown>>>();
  for (const bet of bets) { const key = weekKey(String(bet.forecastAt)); const bucket = weeks.get(key) ?? []; bucket.push(bet); weeks.set(key, bucket); }
  const profitSamples: number[] = [], roiSamples: number[] = [];
  if (weeks.size >= 2) {
    const clusters = [...weeks.values()], random = randomGenerator(20261027);
    for (let repeat = 0; repeat < 1000; repeat++) {
      let pnl = 0, stake = 0;
      for (let index = 0; index < clusters.length; index++) for (const bet of clusters[Math.floor(random() * clusters.length)]) {
        pnl += Number(bet.returnCents) - Number(bet.stakeCents); stake += Number(bet.stakeCents);
      }
      profitSamples.push(pnl / 100); roiSamples.push(pnl / stake);
    }
  }
  profitSamples.sort((a, b) => a - b); roiSamples.sort((a, b) => a - b);
  return { initialBankroll: initialCents / 100, stakeFraction: fraction, maxExposureFraction: 0.05,
    accountingProtocol: 'integer_cents_floor_stake_round_payout_v2',
    bets: bets.length, totalStaked: stakedCents / 100,
    winRate: bets.length ? bets.filter((bet) => bet.status === 'WON' || bet.status === 'HALF_WON').length / bets.length : null,
    netProfit: profitCents / 100, finalBankroll: cashCents / 100, roi: stakedCents > 0 ? profitCents / stakedCents : null, maxDrawdown,
    uncertainty: { method: 'weekly_cluster_bootstrap_fixed_stakes', weekClusters: weeks.size,
      profitCI: profitSamples.length ? [quantile(profitSamples, .025), quantile(profitSamples, .975)] : null,
      roiCI: roiSamples.length ? [quantile(roiSamples, .025), quantile(roiSamples, .975)] : null,
      note: 'Conditional on recorded stakes; does not refit decisions or establish future profitability.' },
    verifiedT15Bets: bets.filter((bet) => bet.priceType === 't15').length,
    openingBets: bets.filter((bet) => bet.priceType === 'opening').length,
    clvN: clvs.length, averageClv: clvs.length ? mean(clvs) : null, exclusions: reasons, records: bets,
    equityCurve, byLeague: economicGroups((bet) => String(bet.competition)), byMarket: economicGroups((bet) => String(bet.market)),
    bySeason: economicGroups((bet) => String(bet.season)),
    byOddsBand: economicGroups((bet) => Number(bet.odds) < 1.5 ? '1.00-1.49' : Number(bet.odds) < 2 ? '1.50-1.99' : Number(bet.odds) < 3 ? '2.00-2.99' : '3.00+') };
}

/** All probability metrics and simulated economics use only the explicit final test phase. */
export function evaluateResearchBenchmark(rows: EvaluationRow[], options: ResearchEvaluationOptions = {}) {
  const seed = Number.isSafeInteger(options.seed) ? options.seed! : 20261027;
  const requestedSamples = Number.isFinite(options.bootstrapSamples) ? options.bootstrapSamples! : 500;
  const bootstrapSamples = Math.max(100, Math.min(5000, Math.trunc(requestedSamples)));
  const initial = Number.isFinite(options.initialBankroll) && options.initialBankroll! > 0 ? options.initialBankroll! : 1000;
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const seen = new Set<string>(), valid: EvaluationRow[] = [];
  for (const row of [...rows].sort((a, b) => at(a.forecastAt) - at(b.forecastAt) || a.matchId.localeCompare(b.matchId))) {
    if (!row.matchId || seen.has(row.matchId)) { exclude('duplicate_or_missing_match_id'); continue; }
    seen.add(row.matchId);
    if (row.phase !== 'test' && row.phase !== 'validation') { exclude('phase_missing'); continue; }
    if (!Number.isFinite(at(row.forecastAt)) || !Number.isFinite(at(row.kickoffAt)) || at(row.forecastAt) >= at(row.kickoffAt)) { exclude('invalid_forecast_chronology'); continue; }
    if (!Number.isSafeInteger(row.homeGoals) || !Number.isSafeInteger(row.awayGoals) || row.homeGoals < 0 || row.awayGoals < 0) { exclude('outcome_missing'); continue; }
    try { primaryObservation(row); } catch { exclude('invalid_matrix_or_probabilities'); continue; }
    valid.push(row);
  }
  const tests = valid.filter((row) => row.phase === 'test');
  // Invalid test labels or matrices must not move the already declared holdout boundary.
  const declaredTestTimes = rows.filter((row) => row.phase === 'test' && Number.isFinite(at(row.forecastAt)))
    .map((row) => at(row.forecastAt));
  const firstTest = declaredTestTimes.length ? Math.min(...declaredTestTimes) : Infinity;
  const validation = valid.filter((row) => row.phase === 'validation' && at(row.kickoffAt) + RESULT_DELAY <= firstTest);
  for (const row of valid) if (row.phase === 'validation' && at(row.kickoffAt) + RESULT_DELAY > firstTest) exclude('validation_overlaps_holdout');
  const observations = tests.map(primaryObservation);
  const bookmakerRows = tests.flatMap((row) => {
    const probabilities = bookmakerProbabilities(row);
    if (!probabilities) return [];
    const flat = { homeWin: probabilities[0], draw: probabilities[1], awayWin: probabilities[2] };
    return [{ original: primaryObservation(row), bookmaker: primaryObservation({ ...row, probabilitiesA: flat, probabilitiesC: flat }) }];
  });
  const paired = pairedSummary(observations, bootstrapSamples, seed);
  const samples = { A: validationSamples(validation, 'A'), C: validationSamples(validation, 'C') };
  const decisionExclusions = { A: {} as Record<string, number>, C: {} as Record<string, number> };
  const differences = { same: 0, different: 0, onlyA: 0, onlyC: 0, neither: 0 };
  const plans: PlannedDecision[] = [];
  for (const row of tests) {
    const decisions: { A: ResearchDecision | null; C: ResearchDecision | null } = { A: null, C: null };
    for (const family of ['A', 'C'] as const) {
      const result = explainResearchDecision({ matrix: family === 'A' ? row.matrixA : row.matrixC,
        probabilities: family === 'A' ? row.probabilitiesA : row.probabilitiesC, quotes: row.quotes,
        calibrationSamples: samples[family], allowedMarkets: options.allowedMarkets, now: row.forecastAt, historical: true });
      decisions[family] = result.decision;
      for (const [reason, count] of Object.entries(result.reasons)) decisionExclusions[family][reason] = (decisionExclusions[family][reason] ?? 0) + count;
    }
    if (decisions.A && decisions.C) differences[eventKey(decisions.A.quote) === eventKey(decisions.C.quote) ? 'same' : 'different']++;
    else if (decisions.A) differences.onlyA++;
    else if (decisions.C) differences.onlyC++;
    else differences.neither++;
    plans.push({ row, ...decisions });
  }
  const marketObservations: Record<string, Observation[]> = { '1x2': observations };
  for (const row of tests) {
    const processed = new Set<string>();
    for (const quote of row.quotes ?? []) {
      const key = eventKey(quote);
      if (processed.has(key)) continue;
      processed.add(key);
      if (priceReason(quote, at(row.forecastAt), true)) continue;
      const outcome = settleGoalQuote(quote, row.homeGoals, row.awayGoals);
      if (outcome.status !== 'WON' && outcome.status !== 'LOST') { exclude('non_binary_market_score_excluded'); continue; }
      try {
        const A = quoteForecast(row.matrixA, quote, row.probabilitiesA).probability;
        const C = quoteForecast(row.matrixC, quote, row.probabilitiesC).probability;
        const label = Number(outcome.status === 'WON');
        (marketObservations[key] ??= []).push({ ...primaryObservation(row),
          logLossA: logProbability(label ? A : 1 - A), logLossC: logProbability(label ? C : 1 - C),
          brierA: (A - label) ** 2, brierC: (C - label) ** 2,
          calibrationA: A, calibrationC: C, observedA: label, observedC: label });
      } catch { exclude('invalid_market_probability'); }
    }
  }
  const robustC = observations.length >= 30 && paired.weekClusters >= 4 && paired.logLossCI![1] < 0
    && paired.weekLogLossCI![1] < 0 && paired.brierCI![1] <= 0 && paired.weekBrierCI![1] <= 0;
  const robustA = observations.length >= 30 && paired.weekClusters >= 4 && paired.logLossCI![0] > 0
    && paired.weekLogLossCI![0] > 0 && paired.brierCI![0] >= 0 && paired.weekBrierCI![0] >= 0;
  return {
    protocol: { version: 'research-paired-v1', phase: 'test', seed, bootstrapSamples, confidence: 0.95,
      primary: '1x2_multiclass', brierDefinition: 'sum_of_three_squared_errors', eceBins: 10,
      deltaDirection: 'C_minus_A', validationMatches: validation.length, validationFrozenBefore: Number.isFinite(firstTest) ? new Date(firstTest).toISOString() : null,
      prudentialMethod: 'validation_payout_residual_hoeffding', minValidationMatches: MIN_VALIDATION_MATCHES,
      minEv: MIN_EV, minPrudentialEv: MIN_PRUDENTIAL_EV, resultDelayMs: RESULT_DELAY,
      note: 'Research simulation; no production activation. Uncertainty assumes independent match clusters; weekly block intervals are also reported.' },
    A: metrics(observations, 'A'), C: metrics(observations, 'C'), paired,
    bookmakerBenchmark: { method: 'same_operator_complete_1x2_proportional_no_vig', n: bookmakerRows.length,
      bookmaker: metrics(bookmakerRows.map((entry) => entry.bookmaker), 'A'),
      AOnSameMatches: metrics(bookmakerRows.map((entry) => entry.original), 'A'),
      COnSameMatches: metrics(bookmakerRows.map((entry) => entry.original), 'C'),
      deltaLogLossA: bookmakerRows.length ? mean(bookmakerRows.map((entry) => entry.original.logLossA - entry.bookmaker.logLossA)) : null,
      deltaLogLossC: bookmakerRows.length ? mean(bookmakerRows.map((entry) => entry.original.logLossC - entry.bookmaker.logLossA)) : null },
    byLeague: groupMetrics(observations, (row) => row.competition),
    bySeason: groupMetrics(observations, (row) => row.season), byPeriod: groupMetrics(observations, (row) => row.week),
    byLeagueSeason: groupMetrics(observations, (row) => `${row.competition}:${row.season}`),
    byMarket: Object.fromEntries(Object.entries(marketObservations).map(([key, bucket]) => [key,
      { A: metrics(bucket, 'A'), C: metrics(bucket, 'C'), paired: pairedSummary(bucket, bootstrapSamples, seed) }])),
    economics: { onePercent: { A: economicSimulation(plans, 'A', 0.01, initial), C: economicSimulation(plans, 'C', 0.01, initial) } },
    decisionDifferences: differences, decisionExclusions, exclusions,
    modelVersions: { A: [...new Set(tests.map((row) => row.modelVersionA))].sort(), C: [...new Set(tests.map((row) => row.modelVersionC))].sort() },
    conclusion: robustC ? 'C_supported_on_primary_holdout' : robustA ? 'A_supported_on_primary_holdout' : 'inconclusive',
  };
}

/** Final holdout evaluation after the existing shared isotonic and bookmaker blend.
 * Calibration labels fit probability transforms, never prudential payout evidence.
 * Without a further independent quote-labelled cohort, economic selection abstains.
 */
export function evaluateResearchPipelineBenchmark(rows: EvaluationRow[], options: ResearchEvaluationOptions = {}) {
  const tests = rows.filter((row) => row.phase === 'test');
  const firstTest = Math.min(...tests.map((row) => at(row.forecastAt)).filter(Number.isFinite));
  if (!Number.isFinite(firstTest)) return { ...evaluateResearchBenchmark(rows, options), probabilityPipeline: 'not_evaluated_without_test' };
  const cutoff = new Date(firstTest).toISOString();
  const calibration = rows.filter((row) => row.phase === 'validation' && at(row.kickoffAt) + RESULT_DELAY < firstTest);
  const profiles = Object.fromEntries((['A', 'C'] as const).map((family) => [family,
    fitResearchCalibration(calibration.map((row) => goalCalibrationObservation(row.matchId,
      new Date(at(row.kickoffAt) + RESULT_DELAY).toISOString(),
      family === 'A' ? row.probabilitiesA ?? scoreMatrixMarkets(row.matrixA) : row.probabilitiesC ?? scoreMatrixMarkets(row.matrixC),
      row.homeGoals, row.awayGoals)), cutoff)]));
  const prepared = tests.map((row) => {
    const A = applyResearchProbabilityPipeline(row.probabilitiesA ?? scoreMatrixMarkets(row.matrixA), profiles.A, row.quotes, row.forecastAt);
    const C = applyResearchProbabilityPipeline(row.probabilitiesC ?? scoreMatrixMarkets(row.matrixC), profiles.C, row.quotes, row.forecastAt);
    return { ...row, probabilitiesA: A.decision, probabilitiesC: C.decision };
  });
  return { ...evaluateResearchBenchmark(prepared, options), probabilityPipeline: 'existing_isotonic_and_bookmaker_blend_v1',
    calibrationProfiles: profiles, rawProbabilityMetrics: { A: metrics(tests.map(primaryObservation), 'A'), C: metrics(tests.map(primaryObservation), 'C') },
    probabilityPipelineLimitations: ['As-of historical context, not an assertion of equality with mutable current live context.',
      'No new learned bookmaker-blend weights are fitted from these calibration labels.',
      'Economic decisions require independent payout calibration evidence; the probability calibration cohort is excluded.'] };
}
