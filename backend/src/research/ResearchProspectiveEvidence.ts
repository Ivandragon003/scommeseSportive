import { createHash } from 'node:crypto';
import { normalizeScoreMatrix, scoreMatrixMarkets, settleGoalQuote, GoalMarket } from './GoalSettlement';
import { quoteForecast, ResearchQuote } from './ResearchEvaluation';
import { ORIGINAL_HOLDOUT_POLICY } from './ResearchHoldoutPolicy';
import type { ResearchStore } from './ResearchStore';

export const PROSPECTIVE_RESIDUAL_PROTOCOL = 'prospective-residual-v1' as const;
export type FrozenProspectiveObservation = {
  protocol: typeof PROSPECTIVE_RESIDUAL_PROTOCOL; partition: 'CALIBRATION' | 'FUTURE_TEST';
  family: 'A' | 'C'; modelVersion: string; probabilityConfigurationHash: string;
  market: GoalMarket; bucket: number; selection: string; quote: ResearchQuote;
  probability: number; expectedValue: number;
};

/** Match identity alone fixes the partition for both models before its result. */
export function prospectivePartition(matchId: string): FrozenProspectiveObservation['partition'] {
  if (!matchId.trim()) throw new Error('Prospective match identity required');
  const value = createHash('sha256').update(`${PROSPECTIVE_RESIDUAL_PROTOCOL}:${matchId}`).digest().readUInt32BE(0);
  return value % 100 < 80 ? 'CALIBRATION' : 'FUTURE_TEST';
}
export function prospectiveBucket(probability: number): number {
  if (!Number.isFinite(probability) || probability <= 0 || probability >= 1) throw new Error('Invalid prospective probability');
  return Math.min(4, Math.floor(probability * 5));
}

/** Freeze one deterministic price per market/bucket, without access to any result. */
export function buildFrozenProspectiveObservations(input: {
  matchId: string; family: 'A' | 'C'; modelVersion: string; probabilityConfigurationHash: string;
  matrix: number[][]; probabilities: Record<string, number>; quotes: ResearchQuote[]; allowedMarkets: string[];
  forecastAt: string; kickoffAt: string; quoteMaxAgeMs: number;
}): FrozenProspectiveObservation[] {
  const at = Date.parse(input.forecastAt), kickoff = Date.parse(input.kickoffAt);
  if (!Number.isFinite(at) || !Number.isFinite(kickoff) || at >= kickoff
    || at <= Date.parse(ORIGINAL_HOLDOUT_POLICY.newIndependentForecastsAfter)
    || ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds.includes(input.matchId)) return [];
  const matrix = normalizeScoreMatrix(input.matrix);
  const marginals = scoreMatrixMarkets(matrix);
  if (Object.entries(input.probabilities).some(([key, value]) => !Number.isFinite(value) || value < 0 || value > 1
    || (marginals[key] !== undefined && Math.abs(marginals[key] - value) > 1e-8))) return [];
  const candidates: FrozenProspectiveObservation[] = [];
  for (const quote of input.quotes) {
    if (quote.priceType !== 'prematch' || !input.allowedMarkets.includes(quote.market) || quote.source !== 'odds_api'
      || (quote as ResearchQuote & { usedSyntheticOdds?: boolean }).usedSyntheticOdds === true || !quote.bookmaker?.trim()
      || quote.timestampEvidence === 'observed_snapshot' || settleGoalQuote(quote, 0, 0).status === 'UNRESOLVED') continue;
    if ([quote.capturedAt, quote.updatedAt].some((value) => {
      const observed = typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
      return !Number.isFinite(observed) || observed > at || at - observed > input.quoteMaxAgeMs;
    })) continue;
    try {
      const forecast = quoteForecast(matrix, quote, input.probabilities);
      if (!Number.isFinite(forecast.expectedValue) || forecast.expectedValue < -1 || forecast.expectedValue > quote.odds - 1 + 1e-9) continue;
      candidates.push({ protocol: PROSPECTIVE_RESIDUAL_PROTOCOL, partition: prospectivePartition(input.matchId),
        family: input.family, modelVersion: input.modelVersion, probabilityConfigurationHash: input.probabilityConfigurationHash,
        market: quote.market, bucket: prospectiveBucket(forecast.probability), selection: quote.selection,
        quote: { ...quote }, probability: forecast.probability, expectedValue: forecast.expectedValue });
    } catch { /* Unsupported or incoherent inputs cannot become residual evidence. */ }
  }
  const priceKey = (quote: ResearchQuote) => JSON.stringify([quote.market, quote.selection, quote.side, quote.line ?? null,
    quote.team ?? null, quote.bookmaker, quote.source, quote.capturedAt, quote.updatedAt, quote.odds]);
  candidates.sort((a, b) => b.expectedValue - a.expectedValue
    || a.market.localeCompare(b.market) || a.bucket - b.bucket
    || a.selection.localeCompare(b.selection) || a.quote.bookmaker.localeCompare(b.quote.bookmaker)
    || priceKey(a.quote).localeCompare(priceKey(b.quote)));
  const chosen = new Map<string, FrozenProspectiveObservation>();
  for (const row of candidates) if (!chosen.has(`${row.market}:${row.bucket}`)) chosen.set(`${row.market}:${row.bucket}`, row);
  return [...chosen.values()].sort((a, b) => a.market.localeCompare(b.market) || a.bucket - b.bucket);
}

type EvidenceDb = { research: Pick<ResearchStore, 'listPendingProspectiveObservations' | 'settleProspectiveObservation'>
    & Partial<Pick<ResearchStore, 'reconcileProspectiveEvidence'>>;
  getMatchById: (matchId: string) => Promise<any> };

/** Settlement never recalculates a forecast, registers a bet or touches a wallet. */
export async function settleProspectiveEvidence(db: EvidenceDb, clock: () => Date = () => new Date()) {
  // Detect official corrections before the next forecast timestamp. Quarantine
  // is append-only and never rewrites the first observed result or its payout.
  await db.research.reconcileProspectiveEvidence?.();
  const pending = await db.research.listPendingProspectiveObservations();
  const summary = { checked: pending.length, settled: 0, unresolved: 0 };
  const matches = new Map<string, any>();
  for (const observation of pending) {
    if (!matches.has(observation.matchId)) matches.set(observation.matchId, await db.getMatchById(observation.matchId));
    const match = matches.get(observation.matchId);
    if (!match || match.home_goals == null || match.away_goals == null || !String(match.source ?? '').trim()
      || clock().getTime() < Date.parse(observation.kickoffAt)) continue;
    const outcome = settleGoalQuote(observation.snapshot?.quote ?? observation.quote, Number(match.home_goals), Number(match.away_goals));
    if (outcome.returnMultiplier == null) { summary.unresolved++; continue; }
    const result = await db.research.settleProspectiveObservation(observation.id, outcome.returnMultiplier, {
      homeGoals: Number(match.home_goals), awayGoals: Number(match.away_goals), source: match.source,
      resultKickoffAt: match.date, status: outcome.status,
    });
    if (result.settled) summary.settled++;
  }
  return summary;
}
