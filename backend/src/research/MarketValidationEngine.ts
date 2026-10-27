import { createHash } from 'node:crypto';
import { GoalMarket, MarketQuote, evaluateGoalQuote, normalizeScoreMatrix, settleGoalQuote } from './GoalSettlement';

/** Experimental, pre-registered eligibility rules; these are safeguards, not optimal betting thresholds. */
export const MARKET_VALIDATION_RULE = Object.freeze({
  version: 'research-market-eligibility-v1', minimumMatches: 200, minimumLeagues: 4, minimumWeeks: 4,
  minimumCoverage: .95, maximumEce: .08, maximumCalibrationBiasUpper: .1,
  maximumBrierRegressionUpper: .02, maximumLogLossRegressionUpper: .05,
  maximumWeekBrierRegression: .05, minimumStableWeekShare: .75,
  quoteMaxAgeMs: 300000, t15ToleranceMs: 60000, bootstrapReplicates: 1000, confidence: .95,
});

type Family = 'A' | 'C';
type State = 'EXPERIMENTAL' | 'SHADOW' | 'ACTIVE' | 'SUSPENDED';
type Phase = 'holdout' | 'prospective';
export type MarketValidationObservation = {
  matchId: string; competition: string; modelVersion: string; probabilityConfigurationHash: string; phase: Phase;
  kickoffAt: string; forecastAt: string; referenceForecastAt: string; modelFitThrough: string;
  /** Same frozen features and prices must be supplied to candidate and reference. */
  snapshot: { observedAt: string; featureAvailableThrough: string; quotes: MarketQuote[]; [key: string]: unknown };
  referenceSnapshotHash: string;
  matrix: number[][]; referenceMatrix: number[][]; quote: MarketQuote;
  priceType: 't15' | 'prematch' | 'opening' | 'closing' | 'unknown';
  result: { homeGoals: number; awayGoals: number; availableAt: string; source: string };
  /** Independently recorded settlement is checked against the shared settlement implementation. */
  settlement: { returnMultiplier: number; recordedAt: string };
};
export type MarketValidationPlan = {
  family: Family; modelVersion: string; referenceVersion: string; market: GoalMarket;
  probabilityConfiguration: Record<string, unknown>; probabilityConfigurationHash: string;
  baselineHash: string; featureSchema: string[];
  trainedThrough: string; calibratedThrough: string; selectedThrough: string;
  holdoutFrom: string; holdoutTo: string;
  trainingMatchIds: string[]; calibrationMatchIds: string[]; selectionMatchIds: string[];
};
export type MarketRegistryApproval = {
  model: { family: Family; version: string; artifact: unknown; artifactHash: string };
  benchmark: { id: string; family: Family | 'PAIR'; modelVersion: string; report: any; reportHash: string };
  event: { family: Family; version: string; action: 'PROMOTE' | 'ROLLBACK'; benchmarkId: string; createdAt: string };
};
export type MarketValidationInput = {
  plan: MarketValidationPlan; observations: MarketValidationObservation[]; now: string;
  previousState?: State;
  /** Pass persisted registry records, never a caller-supplied "approved" flag. */
  registryApproval?: MarketRegistryApproval;
};
export type MarketValidationReason = { code: string; count: number; phase?: Phase; matchIds?: string[] };

function canonical(value: any): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
}
export function marketEvidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
const time = (value: unknown): number => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  ? Date.parse(value) : Number.NaN;
const mean = (values: number[]): number => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clip = (p: number) => Math.max(1e-12, Math.min(1 - 1e-12, p));
const logLoss = (p: number, y: number) => -y * Math.log(clip(p)) - (1 - y) * Math.log(1 - clip(p));
function week(value: string): string {
  const date = new Date(time(value));
  date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
  return date.toISOString().slice(0, 10);
}
const negativeCI = (ci: unknown): boolean => Array.isArray(ci) && ci.length === 2 && ci.every(Number.isFinite) && ci[0] <= ci[1] && ci[1] < 0;
function registryApproved(approval: MarketRegistryApproval | undefined, plan: MarketValidationPlan, now: number): boolean {
  if (!approval) return false;
  const { model, benchmark, event } = approval;
  const v = benchmark?.report?.validation;
  const warnings = [...(benchmark?.report?.warnings ?? []), ...(v?.warnings ?? [])];
  return model?.family === plan.family && model.version === plan.modelVersion && model.artifactHash === marketEvidenceHash(model.artifact)
    && benchmark?.modelVersion === plan.modelVersion && [plan.family, 'PAIR'].includes(benchmark.family)
    && benchmark.reportHash === marketEvidenceHash(benchmark.report) && event?.family === plan.family && event.version === plan.modelVersion
    && ['PROMOTE', 'ROLLBACK'].includes(event.action) && event.benchmarkId === benchmark.id && time(event.createdAt) <= now
    && v?.finalHoldout === true && v.passed === true && v.operationalChecksPassed === true && v.pairedCI === true
    && v.minSamplesSatisfied === true && v.nPaired >= 500 && v.leagueCount >= 4 && v.periodCount >= 4
    && negativeCI(v.deltaLogLossCI) && negativeCI(v.deltaBrierCI) && v.preRegisteredRule === 'research-promotion-v1'
    && typeof v.dataHash === 'string' && v.dataHash.length > 0 && v.baselineHash === plan.baselineHash
    && JSON.stringify(v.featureSchema) === JSON.stringify(plan.featureSchema)
    && ((plan.family === 'A' && v.comparisonReference === 'bookmaker_no_vig')
      || (plan.family === 'C' && v.comparisonReference === 'model_A' && Boolean(v.referenceModelVersion))
      || (v.comparisonReference === 'incumbent' && v.referenceModelVersion && v.referenceModelVersion !== plan.modelVersion))
    && warnings.every((entry: any) => entry && entry.invalidating === false);
}

function quoteReason(q: MarketQuote, forecast: number, t15: boolean): string | null {
  if (settleGoalQuote(q, 0, 0).status === 'UNRESOLVED') return 'invalid_quote';
  if (/aggregate|unknown|fallback|synthetic|estimated|model/i.test(q.source)) return 'unverified_quote_source';
  if (!['odds_api', 'football-data.co.uk', 'football_data_co_uk'].includes(q.source)
    || (t15 && q.source !== 'odds_api')) return 'unauthorized_or_unverified_quote_source';
  for (const observed of [time(q.capturedAt), time(q.updatedAt)]) {
    if (!Number.isFinite(observed) || observed > forecast) return 'future_or_ambiguous_quote';
    if (t15 && forecast - observed > MARKET_VALIDATION_RULE.quoteMaxAgeMs) return 'stale_t15_quote';
  }
  return null;
}

/** Only mutually exclusive, exhaustive selections from the same bookmaker/snapshot are normalized. */
function noVigProbability(row: MarketValidationObservation): number | null {
  const chosen = row.quote;
  const bundle = row.snapshot.quotes.filter((q) => q.bookmaker === chosen.bookmaker && q.source === chosen.source
    && q.capturedAt === chosen.capturedAt && !quoteReason(q, time(row.forecastAt), row.priceType === 't15'));
  const partition = (market: GoalMarket, sides: string[], match: (q: MarketQuote) => boolean, selected: string): number | null => {
    const entries = sides.map((side) => bundle.filter((q) => q.market === market && q.side === side && match(q)));
    if (entries.some((items) => items.length !== 1)) return null;
    const inverse = entries.map(([q]) => 1 / q.odds);
    return inverse[sides.indexOf(selected)] / inverse.reduce((sum, p) => sum + p, 0);
  };
  if (chosen.market === 'double_chance') {
    const p = ['home', 'draw', 'away'].map((side) => partition('1x2', ['home', 'draw', 'away'], () => true, side));
    if (p.some((value) => value === null)) return null;
    return chosen.side === '1x' ? p[0]! + p[1]! : chosen.side === 'x2' ? p[1]! + p[2]! : p[0]! + p[2]!;
  }
  if (chosen.market === '1x2' || chosen.market === 'european_handicap') return partition(chosen.market,
    ['home', 'draw', 'away'], (q) => q.line === chosen.line, chosen.side);
  if (chosen.market === 'btts') return partition('btts', ['yes', 'no'], () => true, chosen.side);
  if (chosen.market === 'dnb') return partition('dnb', ['home', 'away'], () => true, chosen.side);
  if (chosen.market === 'asian_handicap') return partition('asian_handicap', ['home', 'away'],
    (q) => q.line === (q.side === chosen.side ? chosen.line : -chosen.line!), chosen.side);
  return partition(chosen.market, ['over', 'under'], (q) => q.line === chosen.line && q.team === chosen.team, chosen.side);
}

type Scored = {
  matchId: string; competition: string; week: string; weight: number; probability: number; outcome: number;
  logLoss: number; brier: number; deltaLogLoss: number; deltaBrier: number;
  bookmakerDeltaLogLoss: number; bookmakerDeltaBrier: number;
};
const weighted = (rows: Scored[], key: keyof Scored): number => {
  const mass = rows.reduce((sum, row) => sum + row.weight, 0);
  return mass ? rows.reduce((sum, row) => sum + Number(row[key]) * row.weight, 0) / mass : 0;
};
function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
}
function interval(rows: Scored[], key: keyof Scored): [number, number] | null {
  const groups = new Map<string, Scored[]>();
  for (const row of rows) groups.set(row.week, [...(groups.get(row.week) ?? []), row]);
  const weeks = [...groups.keys()].sort(); if (weeks.length < 4) return null;
  const random = randomGenerator(0x4d564531), estimates: number[] = [];
  for (let i = 0; i < MARKET_VALIDATION_RULE.bootstrapReplicates; i++) {
    const sample = Array.from({ length: weeks.length }, () => groups.get(weeks[Math.floor(random() * weeks.length)])!).flat();
    estimates.push(weighted(sample, key));
  }
  estimates.sort((a, b) => a - b);
  return [estimates[Math.floor(estimates.length * .025)], estimates[Math.floor(estimates.length * .975)]];
}
function phaseMetrics(rows: Scored[]) {
  const bins = Array.from({ length: 10 }, () => [] as Scored[]);
  for (const row of rows) bins[Math.min(9, Math.floor(row.probability * 10))].push(row);
  const mass = rows.reduce((sum, row) => sum + row.weight, 0);
  const ece = mass ? bins.reduce((sum, bin) => sum + bin.reduce((n, row) => n + row.weight, 0)
    * Math.abs(weighted(bin, 'probability') - weighted(bin, 'outcome')), 0) / mass : null;
  const residuals = rows.map((row) => ({ ...row, residual: row.probability - row.outcome }));
  const biasCI = interval(residuals, 'residual' as keyof Scored);
  const byWeek = Object.fromEntries([...new Set(rows.map((row) => row.week))].sort().map((key) => {
    const entries = rows.filter((row) => row.week === key);
    return [key, { n: entries.length, deltaBrier: weighted(entries, 'deltaBrier') }];
  }));
  const stableWeekShare = Object.values(byWeek).length ? mean(Object.values(byWeek).map((group) =>
    Number(group.deltaBrier <= MARKET_VALIDATION_RULE.maximumWeekBrierRegression))) : 0;
  const byLeague = Object.fromEntries([...new Set(rows.map((row) => row.competition))].sort().map((key) => {
    const entries = rows.filter((row) => row.competition === key);
    return [key, { n: entries.length, logLoss: weighted(entries, 'logLoss'), brier: weighted(entries, 'brier'),
      deltaBrier: weighted(entries, 'deltaBrier'), deltaLogLoss: weighted(entries, 'deltaLogLoss') }];
  }));
  const stableLeagueCount = Object.values(byLeague).filter((group) => group.deltaBrier <= MARKET_VALIDATION_RULE.maximumWeekBrierRegression).length;
  return { n: rows.length, effectiveStakeSamples: mass, leagueCount: new Set(rows.map((row) => row.competition)).size,
    periodCount: Object.keys(byWeek).length, logLoss: rows.length ? weighted(rows, 'logLoss') : null,
    brier: rows.length ? weighted(rows, 'brier') : null, ece, calibrationBiasCI: biasCI,
    deltaLogLossCI: interval(rows, 'deltaLogLoss'), deltaBrierCI: interval(rows, 'deltaBrier'),
    bookmakerDeltaLogLossCI: interval(rows, 'bookmakerDeltaLogLoss'), bookmakerDeltaBrierCI: interval(rows, 'bookmakerDeltaBrier'),
    stableWeekShare, stableLeagueCount, byWeek, byLeague };
}

/** Compute eligibility from immutable observations; never infer validation from elapsed time or profit. */
export function evaluateMarketValidation(input: MarketValidationInput) {
  const { plan } = input; const now = time(input.now);
  const reasons: MarketValidationReason[] = [];
  const add = (code: string, phase?: Phase, matchId?: string) => {
    const previous = reasons.find((reason) => reason.code === code && reason.phase === phase);
    if (previous) { previous.count++; if (matchId && previous.matchIds!.length < 20) previous.matchIds!.push(matchId); }
    else reasons.push({ code, count: 1, ...(phase ? { phase } : {}), matchIds: matchId ? [matchId] : [] });
  };
  const chronology = Number.isFinite(now) && ['A', 'C'].includes(plan.family) && Boolean(plan.modelVersion)
    && Boolean(plan.referenceVersion) && plan.referenceVersion !== plan.modelVersion
    && plan.featureSchema?.length > 0 && Boolean(plan.baselineHash)
    && time(plan.trainedThrough) <= time(plan.calibratedThrough) && time(plan.calibratedThrough) <= time(plan.selectedThrough)
    && time(plan.selectedThrough) < time(plan.holdoutFrom) && time(plan.holdoutFrom) < time(plan.holdoutTo) && time(plan.holdoutTo) < now;
  if (!chronology) add('invalid_preregistered_chronology');
  const configurationValid = Boolean(plan.probabilityConfiguration && typeof plan.probabilityConfiguration === 'object'
    && !Array.isArray(plan.probabilityConfiguration) && /^[a-f0-9]{64}$/.test(plan.probabilityConfigurationHash)
    && plan.probabilityConfiguration.family === plan.family
    && plan.probabilityConfiguration.version === 'probability-configuration-v1'
    && plan.probabilityConfiguration.probabilityProtocol === 'joint-goal-coherent-v2'
    && marketEvidenceHash(plan.probabilityConfiguration) === plan.probabilityConfigurationHash);
  if (!configurationValid) add('invalid_probability_configuration');
  const fittedIds = new Set([...plan.trainingMatchIds, ...plan.calibrationMatchIds, ...plan.selectionMatchIds]);
  const seen = new Set<string>(), scored: Record<Phase, Scored[]> = { holdout: [], prospective: [] };
  const totals = { holdout: 0, prospective: 0 }, validData = { holdout: 0, prospective: 0 }, validQuote = { holdout: 0, prospective: 0 };
  let settled = 0, settlementMismatches = 0;
  const ordered = [...input.observations].sort((a, b) => time(a.forecastAt) - time(b.forecastAt) || a.matchId.localeCompare(b.matchId));
  for (const row of ordered) {
    if (!['holdout', 'prospective'].includes(row.phase)) { add('unknown_phase'); continue; }
    const phase = row.phase; totals[phase]++;
    const reject = (code: string) => add(code, phase, row.matchId);
    if (!configurationValid || row.probabilityConfigurationHash !== plan.probabilityConfigurationHash) {
      reject('probability_configuration_mismatch'); continue;
    }
    if (!row.matchId || seen.has(row.matchId)) { reject('duplicate_or_missing_match'); continue; }
    seen.add(row.matchId);
    if (fittedIds.has(row.matchId)) { reject('holdout_contaminated_by_fitting'); continue; }
    const forecast = time(row.forecastAt), kickoff = time(row.kickoffAt);
    if (!chronology || row.modelVersion !== plan.modelVersion || row.quote?.market !== plan.market
      || !row.competition?.trim() || !Number.isFinite(forecast) || !Number.isFinite(kickoff)
      || forecast >= kickoff || forecast !== time(row.referenceForecastAt)
      || time(row.modelFitThrough) > forecast || time(row.modelFitThrough) > time(plan.selectedThrough)
      || !Number.isFinite(time(row.modelFitThrough)) || time(row.snapshot?.observedAt) > forecast
      || !Number.isFinite(time(row.snapshot?.observedAt)) || time(row.snapshot?.featureAvailableThrough) > forecast
      || time(row.snapshot?.featureAvailableThrough) > time(row.snapshot?.observedAt)
      || !Number.isFinite(time(row.snapshot?.featureAvailableThrough))
      || marketEvidenceHash(row.snapshot) !== row.referenceSnapshotHash) { reject('non_equivalent_or_future_inputs'); continue; }
    if ((phase === 'holdout' && (forecast < time(plan.holdoutFrom) || forecast > time(plan.holdoutTo)))
      || (phase === 'prospective' && forecast <= time(plan.holdoutTo))) { reject('phase_interval_overlap'); continue; }
    if (phase === 'prospective' && (row.priceType !== 't15' || forecast < kickoff - 900000
      || forecast > kickoff - 900000 + MARKET_VALIDATION_RULE.t15ToleranceMs)) { reject('not_prospective_t15'); continue; }
    if (time(row.result?.availableAt) < kickoff || time(row.result?.availableAt) > now
      || !Number.isFinite(time(row.result?.availableAt)) || !['understat', 'football-data.co.uk', 'football_data_co_uk'].includes(row.result?.source)) {
      reject('unconfirmed_result'); continue;
    }
    let forecastValue: ReturnType<typeof evaluateGoalQuote>, reference: ReturnType<typeof evaluateGoalQuote>;
    try {
      for (const matrix of [row.matrix, row.referenceMatrix]) {
        normalizeScoreMatrix(matrix);
        const total = matrix.flat().reduce((sum, p) => sum + p, 0);
        if (Math.abs(total - 1) > 1e-8) throw new Error('unnormalized');
      }
      forecastValue = evaluateGoalQuote(row.matrix, row.quote); reference = evaluateGoalQuote(row.referenceMatrix, row.quote);
    } catch { reject('incoherent_probability_or_market'); continue; }
    validData[phase]++;
    if (!['t15', 'prematch', 'opening'].includes(row.priceType)) { reject('unknown_or_closing_entry_price'); continue; }
    const invalidQuote = quoteReason(row.quote, forecast, row.priceType === 't15');
    if (invalidQuote) { reject(invalidQuote); continue; }
    if (time(row.quote.capturedAt) > time(row.snapshot.observedAt) || time(row.quote.updatedAt) > time(row.snapshot.observedAt)) {
      reject('quote_observed_after_snapshot'); continue;
    }
    if (!row.snapshot.quotes.some((q) => marketEvidenceHash(q) === marketEvidenceHash(row.quote))) { reject('quote_outside_shared_snapshot'); continue; }
    const bookmakerProbability = noVigProbability(row);
    if (bookmakerProbability === null) { reject('complete_bookmaker_partition_missing'); continue; }
    validQuote[phase]++;
    const settlement = settleGoalQuote(row.quote, row.result.homeGoals, row.result.awayGoals);
    if (settlement.returnMultiplier === null || time(row.settlement?.recordedAt) < time(row.result.availableAt)
      || time(row.settlement?.recordedAt) > now || !Number.isFinite(time(row.settlement?.recordedAt))
      || !Number.isFinite(row.settlement?.returnMultiplier)
      || Math.abs(row.settlement.returnMultiplier - settlement.returnMultiplier) > 1e-9) {
      settlementMismatches++; reject('settlement_mismatch_or_missing'); continue;
    }
    settled++;
    if (settlement.status === 'VOID') { reject('void_excluded_from_conditional_scoring'); continue; }
    const weight = settlement.status.startsWith('HALF_') ? .5 : 1;
    const y = Number(settlement.status === 'WON' || settlement.status === 'HALF_WON');
    const p = forecastValue.probability, ref = reference.probability;
    scored[phase].push({ matchId: row.matchId, competition: row.competition, week: week(row.kickoffAt), weight,
      probability: p, outcome: y, logLoss: logLoss(p, y), brier: (p - y) ** 2,
      deltaLogLoss: logLoss(p, y) - logLoss(ref, y), deltaBrier: (p - y) ** 2 - (ref - y) ** 2,
      bookmakerDeltaLogLoss: logLoss(p, y) - logLoss(bookmakerProbability, y),
      bookmakerDeltaBrier: (p - y) ** 2 - (bookmakerProbability - y) ** 2 });
  }
  const historical = phaseMetrics(scored.holdout), prospective = phaseMetrics(scored.prospective);
  const coverage = (phase: Phase, values: Record<Phase, number>) => totals[phase] ? values[phase] / totals[phase] : 0;
  const calibration = (metrics: ReturnType<typeof phaseMetrics>) => metrics.ece !== null
    && metrics.ece <= MARKET_VALIDATION_RULE.maximumEce && metrics.calibrationBiasCI !== null
    && Math.max(...metrics.calibrationBiasCI.map(Math.abs)) <= MARKET_VALIDATION_RULE.maximumCalibrationBiasUpper;
  const quality = (metrics: ReturnType<typeof phaseMetrics>) => metrics.n >= MARKET_VALIDATION_RULE.minimumMatches
    && metrics.leagueCount >= MARKET_VALIDATION_RULE.minimumLeagues && metrics.periodCount >= MARKET_VALIDATION_RULE.minimumWeeks
    && metrics.deltaBrierCI !== null && metrics.deltaBrierCI[1] <= MARKET_VALIDATION_RULE.maximumBrierRegressionUpper
    && metrics.deltaLogLossCI !== null && metrics.deltaLogLossCI[1] <= MARKET_VALIDATION_RULE.maximumLogLossRegressionUpper
    && metrics.bookmakerDeltaBrierCI !== null && metrics.bookmakerDeltaBrierCI[1] <= MARKET_VALIDATION_RULE.maximumBrierRegressionUpper
    && metrics.bookmakerDeltaLogLossCI !== null && metrics.bookmakerDeltaLogLossCI[1] <= MARKET_VALIDATION_RULE.maximumLogLossRegressionUpper
    && metrics.stableLeagueCount >= MARKET_VALIDATION_RULE.minimumLeagues
    && metrics.stableWeekShare >= MARKET_VALIDATION_RULE.minimumStableWeekShare && calibration(metrics);
  const contamination = reasons.some((reason) => ['holdout_contaminated_by_fitting', 'duplicate_or_missing_match', 'phase_interval_overlap',
    'non_equivalent_or_future_inputs', 'invalid_preregistered_chronology', 'invalid_probability_configuration',
    'probability_configuration_mismatch'].includes(reason.code));
  const dataCoverage = coverage('holdout', validData) >= MARKET_VALIDATION_RULE.minimumCoverage;
  const quoteCoverage = coverage('holdout', validQuote) >= MARKET_VALIDATION_RULE.minimumCoverage;
  const settlementVerified = settlementMismatches === 0 && settled >= MARKET_VALIDATION_RULE.minimumMatches;
  const eligible = chronology && !contamination && dataCoverage && quoteCoverage && settlementVerified && quality(historical);
  const prospectivePassed = eligible && coverage('prospective', validData) >= MARKET_VALIDATION_RULE.minimumCoverage
    && coverage('prospective', validQuote) >= MARKET_VALIDATION_RULE.minimumCoverage && quality(prospective);
  const approvedModel = registryApproved(input.registryApproval, plan, now);
  if (!eligible) add('independent_market_evidence_insufficient');
  if (!prospectivePassed) add('prospective_evidence_insufficient');
  if (!approvedModel) add('approved_champion_evidence_missing');
  const configurationMismatch = reasons.some((reason) => ['invalid_probability_configuration', 'probability_configuration_mismatch'].includes(reason.code));
  const state: State = configurationMismatch ? 'EXPERIMENTAL' : prospectivePassed && approvedModel ? 'ACTIVE' : eligible ? 'SHADOW'
    : ['ACTIVE', 'SHADOW'].includes(input.previousState ?? '') ? 'SUSPENDED' : 'EXPERIMENTAL';
  const operationalChecksPassed = chronology && !contamination && settlementMismatches === 0 && historical.n > 0;
  const evidence = { family: plan.family, modelVersion: plan.modelVersion, rule: MARKET_VALIDATION_RULE.version,
    probabilityConfiguration: plan.probabilityConfiguration,
    approvedProbabilityConfigurationHash: configurationValid && !configurationMismatch ? plan.probabilityConfigurationHash : null,
    independentEvaluationPassed: eligible, dataCoverage, quoteCoverage, settlementVerified,
    probabilisticSamples: historical.n, calibrationPassed: calibration(historical), leagueCount: historical.leagueCount,
    periodCount: historical.periodCount, prospectiveSamples: prospective.n, prospectivePassed,
    coverage: { holdout: { data: coverage('holdout', validData), quote: coverage('holdout', validQuote), total: totals.holdout },
      prospective: { data: coverage('prospective', validData), quote: coverage('prospective', validQuote), total: totals.prospective } },
    historical, prospective, approvedModel, reasons };
  return { state, reasons, rules: MARKET_VALIDATION_RULE, marketValidation: { [plan.market]: evidence },
    ...(approvedModel ? { modelBenchmarkId: input.registryApproval!.benchmark.id } : {}),
    validation: { passed: false, finalHoldout: chronology && !contamination, operationalChecksPassed,
      probabilityConfigurationHash: configurationValid && !configurationMismatch ? plan.probabilityConfigurationHash : null,
      dataHash: marketEvidenceHash({ plan, observations: ordered }), baselineHash: plan.baselineHash, featureSchema: [...plan.featureSchema],
      holdoutMatchIds: scored.holdout.map((row) => row.matchId).sort() },
    warnings: [], limitations: ['Eligibility thresholds are experimental and require independent review.',
      'Weekly cluster bootstrap assumes exchangeability between observed weeks; it is not a guarantee of future returns.',
      'Pushes are excluded and quarter stakes use half weight in conditional proper scores.',
      'A market eligibility report alone never approves or promotes a model.'] };
}
