import type { DatabaseService } from '../db/DatabaseService';
import { OddsApiService } from '../services/OddsApiService';
import { getConfiguredOddsApiKey } from '../services/odds-provider/providerRuntimeConfig';
import { ResearchRuntime } from './ResearchRuntime';
import { TOP5_COMPETITIONS } from './ForecastCore';
import { buildChallengerRecommendation, challengerTechnicalReason } from './ChallengerRecommendation';
import { readEffectiveResearchDecisions } from './ResearchRecommendationView';
import { ChallengerExecutionState, recommendationQuoteReason } from './ResearchRecommendationPolicy';
import { RecommendationQuote } from './AppRecommendationQuotes';
import { PreparedT15Job, safeOddsFailureCode } from './T15Scheduler';
import type { ResearchQuote } from './ResearchEvaluation';
import { researchHash } from './ResearchStore';

const QUOTE_MAX_AGE_MS = 300_000;
const PREVIEW_CACHE_MS = 30_000;
const MAX_CACHED_PREVIEWS = 100;
const MAX_ACTIVE_PREVIEWS = 2;
type MatchRow = Record<string, any>;
type PreviewRuntime = Pick<ResearchRuntime, 'preparePreviewC'>;
type RuntimeOptions = ConstructorParameters<typeof ResearchRuntime>[1];
type PreviewOptions = {
  clock?: () => Date;
  odds?: Pick<OddsApiService, 'getOdds' | 'getQuotaStatus'>;
  runtimeFactory?: (db: DatabaseService, options: RuntimeOptions) => PreviewRuntime;
};
type PreviewSelection = {
  selection: string; selectionLabel?: string; bookmakerOdds: number; bookmakerName: string;
  marketName?: string; ourProbability?: number; suggestedStakePercent: 1;
};
export type ChallengerPreview = {
  kind: 'C_PREVIEW'; family: 'C'; matchId: string; asOf: string; kickoffAt: string | null;
  expiresAt: string | null; modelVersion: string | null; deploymentRevision: string | null;
  status: 'RECOMMENDED' | 'NO_BET' | 'UNAVAILABLE' | 'NOT_ELIGIBLE' | 'ARCHIVED';
  reason: string | null;
  recommendationPacket: { selected: PreviewSelection | null; decisionStatus: 'RECOMMENDED' | 'NO_BET' } | null;
  quote: RecommendationQuote | null; suggestedStakePercent: 1; registered: false;
};

const timestamp = (value: unknown): number => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  ? Date.parse(value) : Number.NaN;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const safeReason = (value: unknown, fallback: string): string => typeof value === 'string' && /^[a-z][a-z0-9_]{1,100}$/.test(value)
  ? value : fallback;
const fixtureIdentity = (row: MatchRow): string => researchHash({ matchId: row.match_id, kickoffAt: row.date,
  homeTeamId: row.home_team_id, awayTeamId: row.away_team_id, competition: row.competition, season: row.season });

/** On-demand C inference. Only the quote manager may update its technical cache/accounting. */
export class ChallengerPreviewService {
  private readonly clock: () => Date;
  private readonly odds: Pick<OddsApiService, 'getOdds' | 'getQuotaStatus'>;
  private readonly runtimeFactory: NonNullable<PreviewOptions['runtimeFactory']>;
  private readonly cache = new Map<string, ChallengerPreview>();
  private readonly pending = new Map<string, Promise<ChallengerPreview>>();

  constructor(private readonly db: DatabaseService, options: PreviewOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.odds = options.odds ?? new OddsApiService(getConfiguredOddsApiKey('default'), {
      store: db.oddsRequests, operation: 'challenger_preview', priority: 'informational',
      cacheMaxAgeMs: QUOTE_MAX_AGE_MS,
      // C preview is an explicit user request; the dashboard/A network policy is unchanged.
      allowNetwork: process.env.CHALLENGER_PREVIEW_NETWORK_ENABLED !== 'false',
    });
    this.runtimeFactory = options.runtimeFactory ?? ((database, runtimeOptions) => new ResearchRuntime(database, runtimeOptions));
  }

  private response(matchId: string, status: ChallengerPreview['status'], reason: string | null,
    row?: MatchRow | null, state?: ChallengerExecutionState): ChallengerPreview {
    return { kind: 'C_PREVIEW', family: 'C', matchId, asOf: this.clock().toISOString(),
      kickoffAt: Number.isFinite(timestamp(row?.date)) ? row!.date : null, expiresAt: null,
      modelVersion: state?.deployment.modelVersion ?? null, deploymentRevision: state?.revision ?? null,
      status, reason, recommendationPacket: null, quote: null, suggestedStakePercent: 1, registered: false };
  }

  private eligibility(row: MatchRow | null | undefined): string | null {
    if (!row) return 'match_not_found';
    if (!(TOP5_COMPETITIONS as readonly string[]).includes(row.competition)) return 'unsupported_competition';
    if (!Number.isFinite(timestamp(row.date))) return 'match_kickoff_unverified';
    if (!row.home_team_id || !row.away_team_id) return 'match_teams_unavailable';
    if (row.home_goals != null || row.away_goals != null) return 'match_finished';
    if (timestamp(row.date) <= this.clock().getTime()) return 'match_started';
    return null;
  }

  private async hasArchivedC(matchId: string): Promise<boolean> {
    const view = await readEffectiveResearchDecisions(this.db.research, this.db.recommendations,
      { matchId, family: 'C', limit: 20 });
    return view.effective.some((decision) => decision.matchId === matchId && decision.family === 'C' && decision.authority === 'execution');
  }

  private async deployment(): Promise<ChallengerExecutionState> {
    const state = await this.db.challengerAdoption.getState();
    if (!state || !state.deployment || !state.revision) throw new Error('adoption_state_unavailable');
    return clone(state);
  }

  private prune(): void {
    const now = this.clock().getTime();
    for (const [key, result] of this.cache) {
      if (timestamp(result.expiresAt) <= now || timestamp(result.asOf) > now) this.cache.delete(key);
    }
  }

  /** Every caller, including cache hits and coalesced waiters, validates its own final read. */
  private async finalizeResult(result: ChallengerPreview, initialRow: MatchRow,
    initialState: ChallengerExecutionState): Promise<ChallengerPreview> {
    let row: MatchRow | null | undefined;
    try {
      row = await this.db.getMatchById(result.matchId);
      let state: ChallengerExecutionState | undefined;
      try { state = await this.deployment(); } catch { /* The archive still has priority when the registry is unavailable. */ }
      // Keep this as the final asynchronous read. A deployment read may itself overlap a Nightly commit.
      const archived = await this.hasArchivedC(result.matchId);
      if (archived) return this.response(result.matchId, 'ARCHIVED', 'nightly_decision_available', row, state ?? initialState);
      const ineligible = this.eligibility(row);
      if (ineligible) return this.response(result.matchId, 'NOT_ELIGIBLE', ineligible, row, state ?? initialState);
      if (fixtureIdentity(row!) !== fixtureIdentity(initialRow)) return this.response(result.matchId, 'UNAVAILABLE', 'fixture_changed', row, state ?? initialState);
      if (!state) return this.response(result.matchId, 'UNAVAILABLE', 'adoption_state_unavailable', row, initialState);
      if (state.source === 'suspended' || state.resolutionUnavailable) {
        return this.response(result.matchId, 'UNAVAILABLE', 'challenger_deployment_suspended', row, state);
      }
      if (researchHash(state) !== researchHash(initialState)) return this.response(result.matchId, 'UNAVAILABLE', 'deployment_changed', row, state);
      const now = this.clock().getTime();
      if (['RECOMMENDED', 'NO_BET'].includes(result.status)) {
        if (!Number.isFinite(timestamp(result.expiresAt)) || timestamp(result.expiresAt) <= now
          || !Number.isFinite(timestamp(result.asOf)) || timestamp(result.asOf) > now) {
          return this.response(result.matchId, 'UNAVAILABLE', 'challenger_preview_expired', row, state);
        }
        if (result.status === 'RECOMMENDED' && (!result.quote || recommendationQuoteReason(result.quote, new Date(now), 'C'))) {
          return this.response(result.matchId, 'UNAVAILABLE', 'real_fresh_quotes_unavailable', row, state);
        }
      }
      return clone(result);
    } catch { return this.response(result.matchId, 'UNAVAILABLE', 'challenger_preview_unavailable', row, initialState); }
  }

  async preview(matchId: string): Promise<ChallengerPreview> {
    if (typeof matchId !== 'string' || !matchId.trim() || matchId.length > 200) {
      return this.response('', 'NOT_ELIGIBLE', 'match_id_invalid');
    }
    matchId = matchId.trim();
    let row: MatchRow | null | undefined;
    try {
      row = await this.db.getMatchById(matchId);
      const ineligible = this.eligibility(row);
      if (ineligible) return this.response(matchId, 'NOT_ELIGIBLE', ineligible, row);
      if (await this.hasArchivedC(matchId)) return this.response(matchId, 'ARCHIVED', 'nightly_decision_available', row);
      let state: ChallengerExecutionState;
      try { state = await this.deployment(); }
      catch { return this.response(matchId, 'UNAVAILABLE', 'adoption_state_unavailable', row); }
      if (state.source === 'suspended' || state.resolutionUnavailable) {
        return this.response(matchId, 'UNAVAILABLE', 'challenger_deployment_suspended', row, state);
      }
      const key = researchHash({ fixture: fixtureIdentity(row!), state });
      this.prune();
      const cached = this.cache.get(key);
      if (cached) return this.finalizeResult(cached, row!, state);
      const running = this.pending.get(key);
      if (running) return this.finalizeResult(await running, row!, state);
      if (this.pending.size >= MAX_ACTIVE_PREVIEWS) return this.response(matchId, 'UNAVAILABLE', 'challenger_preview_busy', row, state);
      const work = this.compute(matchId, row!, state).catch((error) => this.response(matchId, 'UNAVAILABLE',
        safeOddsFailureCode(error) ?? 'challenger_preview_unavailable', row, state));
      this.pending.set(key, work);
      try {
        const result = await this.finalizeResult(await work, row!, state);
        if (['RECOMMENDED', 'NO_BET'].includes(result.status) && timestamp(result.expiresAt) > this.clock().getTime()) {
          while (this.cache.size >= MAX_CACHED_PREVIEWS) this.cache.delete(this.cache.keys().next().value!);
          this.cache.set(key, clone(result));
        }
        return clone(result);
      } finally { if (this.pending.get(key) === work) this.pending.delete(key); }
    } catch { return this.response(matchId, 'UNAVAILABLE', 'challenger_preview_unavailable', row); }
  }

  private async compute(matchId: string, initialRow: MatchRow, state: ChallengerExecutionState): Promise<ChallengerPreview> {
    const runtime = this.runtimeFactory(this.db, { clock: this.clock, odds: this.odds,
      nightly: { quoteMaxAgeMs: QUOTE_MAX_AGE_MS, minEv: .04, minPrudentialEv: .01 },
      candidateVersionC: state.deployment.modelVersion, deploymentC: state.deployment });
    const requestedAt = this.clock().toISOString();
    const prepared: PreparedT15Job = await runtime.preparePreviewC({ id: `preview:${matchId}`, leaseToken: '', matchId,
      kickoffAt: initialRow.date, targetAt: requestedAt, preview: true });
    const row = initialRow;
    const elapsedEligibility = this.eligibility(row);
    if (elapsedEligibility) return this.response(matchId, 'NOT_ELIGIBLE', elapsedEligibility, row, state);
    if (timestamp(prepared.kickoffAt) !== timestamp(row.date)) return this.response(matchId, 'UNAVAILABLE', 'fixture_changed', row, state);
    if (['started', 'finished'].includes(prepared.status)) {
      return this.response(matchId, 'NOT_ELIGIBLE', prepared.status === 'started' ? 'match_started' : 'match_finished', row, state);
    }
    if (prepared.status !== 'upcoming') return this.response(matchId, 'UNAVAILABLE', 'challenger_fixture_unavailable', row, state);
    const observedAt = this.clock().toISOString();
    const quotes = (prepared.quotes as ResearchQuote[]).filter((quote) => !recommendationQuoteReason(quote, new Date(observedAt), 'C'));
    if (!quotes.length) return this.response(matchId, 'UNAVAILABLE', 'real_fresh_quotes_unavailable', row, state);
    const decisions = prepared.decisions.filter((decision) => decision.family === 'C');
    if (decisions.length !== 1) return this.response(matchId, 'UNAVAILABLE', 'challenger_technical_validation_failed', row, state);
    const decision = decisions[0];
    const forecastAt = typeof decision.forecastAt === 'string' ? decision.forecastAt : '';
    if (!Number.isFinite(timestamp(forecastAt)) || timestamp(forecastAt) > this.clock().getTime()) {
      return this.response(matchId, 'UNAVAILABLE', 'challenger_forecast_time_unavailable', row, state);
    }
    const technical = challengerTechnicalReason(decision, forecastAt, state.deployment);
    if (technical) return this.response(matchId, 'UNAVAILABLE', safeReason(decision.reason, technical), row, state);
    const markets = await this.db.research.listMarkets({ family: 'C', modelVersion: state.deployment.modelVersion });
    const packet = buildChallengerRecommendation({ decision, quotes, observedAt, competition: row!.competition,
      expectedIdentity: state.deployment,
      ...(state.deployment.selectorPolicy === 'payout-aware-v1' ? { selectionPolicy: 'payout-aware-v1' as const } : {}),
      allowedMarkets: markets.filter((market) => ['EXPERIMENTAL', 'SHADOW', 'ACTIVE'].includes(market.state)).map((market) => market.market) });
    const finalAt = this.clock().getTime();
    if (finalAt >= timestamp(row!.date)) return this.response(matchId, 'NOT_ELIGIBLE', 'match_started', row, state);
    if (quotes.some((quote) => recommendationQuoteReason(quote, new Date(finalAt), 'C'))) {
      return this.response(matchId, 'UNAVAILABLE', 'real_fresh_quotes_unavailable', row, state);
    }
    const expiresAt = Math.min(timestamp(forecastAt) + PREVIEW_CACHE_MS, timestamp(row!.date),
      ...quotes.flatMap((quote) => [timestamp(quote.capturedAt) + QUOTE_MAX_AGE_MS, timestamp(quote.updatedAt) + QUOTE_MAX_AGE_MS]));
    if (expiresAt <= finalAt) return this.response(matchId, 'UNAVAILABLE', 'challenger_preview_expired', row, state);
    const noBetReason = 'abstentionReason' in packet && packet.abstentionReason
      ? safeReason(packet.abstentionReason, 'challenger_no_recommendation')
      : packet.exclusions.non_binary_payout_not_supported_by_canonical_engine
        ? 'non_binary_payout_not_supported_by_canonical_engine' : 'challenger_no_recommendation';
    const result = this.response(matchId, packet.selected ? 'RECOMMENDED' : 'NO_BET', packet.selected ? null : noBetReason, row, state);
    result.asOf = forecastAt; result.expiresAt = new Date(expiresAt).toISOString();
    result.recommendationPacket = { selected: null, decisionStatus: 'NO_BET' };
    if (!packet.selected) return result;
    const selected = packet.selected;
    const bookmakerName = 'bookmakerName' in selected && typeof selected.bookmakerName === 'string' ? selected.bookmakerName : null;
    const selectionLabel = 'selectionLabel' in selected && typeof selected.selectionLabel === 'string' ? selected.selectionLabel : null;
    const quote = quotes.find((entry) => entry.selection === selected.selection && entry.odds === selected.bookmakerOdds
      && (!bookmakerName || entry.bookmaker === bookmakerName));
    if (!quote) return this.response(matchId, 'UNAVAILABLE', 'challenger_recommendation_quote_mismatch', row, state);
    result.quote = clone(quote);
    result.recommendationPacket = { decisionStatus: 'RECOMMENDED', selected: { selection: selected.selection,
      ...(selectionLabel ? { selectionLabel } : {}), bookmakerOdds: quote.odds,
      bookmakerName: quote.bookmaker, ...(selected.marketName ? { marketName: selected.marketName } : {}),
      ...(typeof selected.ourProbability === 'number' ? { ourProbability: selected.ourProbability } : {}), suggestedStakePercent: 1 } };
    return result;
  }
}
