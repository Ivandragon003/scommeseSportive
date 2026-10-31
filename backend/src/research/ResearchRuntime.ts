import { DatabaseService } from '../db/DatabaseService';
import { OddsApiService, OddsMatch } from '../services/OddsApiService';
import { getConfiguredOddsApiKey } from '../services/odds-provider/providerRuntimeConfig';
import { scoreFixtureCandidate } from '../services/odds-provider/oddsProviderUtils';
import { baselineManifest, buildForecastInput, ForecastInput, ResearchMatch, TOP5_COMPETITIONS } from './ForecastCore';
import { HybridArtifact, predictHybrid, validateArtifact } from './CatBoostModel';
import { CalibrationSample, explainResearchDecision, ResearchQuote } from './ResearchEvaluation';
import { normalizeScoreMatrix, scoreMatrixMarkets, settleGoalQuote } from './GoalSettlement';
import { settleAppRecommendationQuote } from './AppRecommendationQuotes';
import { CoherentCalibrationMode, CoherentCalibrationProfile, COHERENT_PROBABILITY_PROTOCOL, applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash } from './CoherentProbabilityPipeline';
import { researchHash } from './ResearchStore';
import { buildProbabilityConfiguration } from './ProbabilityConfiguration';
import { PreparedT15Job, quoteFreshnessReason, safeOddsFailureCode, T15Decision, T15Job, T15Scheduler, T15TickSummary } from './T15Scheduler';
import { reconcileResearchMonitoring } from './ResearchMonitoring';
import { rollbackUnhealthyChampion } from './ResearchLifecycle';
import { randomUUID } from 'node:crypto';
import { ResearchWorkerCoordinator, WorkerLease, WORKER_RENEWAL_MS } from './ResearchWorkerCoordinator';
import { buildFrozenProspectiveObservations, FrozenProspectiveObservation } from './ResearchProspectiveEvidence';
import { CHALLENGER_FEATURE_SCHEMA_VERSION, withChallengerFeatures, ChallengerFeatureBlock } from './ChallengerFeatures';
import type { ChallengerExecutionDeployment } from './ResearchRecommendationPolicy';

type RuntimeDb = Pick<DatabaseService, 'research' | 'getUpcomingMatches' | 'getMatchById' | 'getMatches'
  | 'updateMatchKickoff' | 'saveSchedulerRun'> & Partial<Pick<DatabaseService, 'researchMonitoring' | 'listRecentSchedulerRuns' | 'listRecentSchedulerRunsByName' | 'oddsRequests' | 'challengerAdoption'>>;
type OddsFeed = Pick<OddsApiService, 'getOdds'> & Partial<Pick<OddsApiService, 'getQuotaStatus'>>;
type LiveResearchQuote = ResearchQuote & { updatedAt: string };
type RuntimeModelContext = { championC: any; latestCandidate: any; candidateC: any; cacheable: boolean;
  benchmarks?: { A: any; C: any } };

export function researchMatchFromRow(row: Record<string, any>): ResearchMatch {
  const result: any = { matchId: row.match_id, homeTeamId: row.home_team_id, awayTeamId: row.away_team_id,
    date: row.date, competition: row.competition, season: row.season };
  for (const [field, column] of Object.entries({ homeGoals: 'home_goals', awayGoals: 'away_goals', homeXG: 'home_xg', awayXG: 'away_xg',
    homeTotalShots: 'home_shots', awayTotalShots: 'away_shots', homeShotsOnTarget: 'home_shots_on_target', awayShotsOnTarget: 'away_shots_on_target',
    homeYellowCards: 'home_yellow_cards', awayYellowCards: 'away_yellow_cards', homeRedCards: 'home_red_cards', awayRedCards: 'away_red_cards',
    homeFouls: 'home_fouls', awayFouls: 'away_fouls' })) result[field] = row[column] ?? null;
  return result;
}

/** Preserve provider update times. A successful HTTP fetch does not make an old price fresh. */
export function researchQuotesFromEvent(event: OddsMatch, capturedAt: string): LiveResearchQuote[] {
  const preferred = [...event.bookmakers].sort((a, b) => {
    const priority = (key: string) => /eurobet/i.test(key) ? 0 : /(?:_it$|ital)/i.test(key) ? 1 : 2;
    return priority(a.bookmakerKey) - priority(b.bookmakerKey) || a.bookmakerKey.localeCompare(b.bookmakerKey);
  });
  const groups = new Map<string, { quotes: LiveResearchQuote[]; fresh: boolean; complete: boolean }>();
  for (const bookmaker of preferred) for (const market of bookmaker.markets) {
    const quotes: LiveResearchQuote[] = [];
    for (const outcome of market.outcomes) {
      const base = { odds: outcome.price, bookmaker: bookmaker.bookmakerName, source: event.provider ?? 'odds_api',
        capturedAt: event.capturedAt ?? capturedAt,
        updatedAt: market.updatedAt ?? bookmaker.updatedAt ?? '', priceType: 't15' as const };
      if (market.marketKey === 'h2h') {
        const side = outcome.name === event.homeTeam ? 'home' : outcome.name === event.awayTeam ? 'away'
          : outcome.name.toLowerCase() === 'draw' ? 'draw' : null;
        if (side) quotes.push({ ...base, selection: side === 'home' ? 'homeWin' : side === 'away' ? 'awayWin' : 'draw', market: '1x2', side });
      } else if (market.marketKey === 'totals' && ['Over', 'Under'].includes(outcome.name) && Number.isFinite(outcome.point)) {
        const side = outcome.name.toLowerCase() as 'over' | 'under';
        quotes.push({ ...base, selection: `${side}${String(outcome.point).replace('.', '')}`, market: 'totals', side, line: outcome.point });
      } else if (market.marketKey === 'spreads' && Number.isFinite(outcome.point)) {
        const side = outcome.name === event.homeTeam ? 'home' : outcome.name === event.awayTeam ? 'away' : null;
        if (side) quotes.push({ ...base, selection: `ahcp_${side === 'away' ? 'away_' : ''}${outcome.point}`, market: 'asian_handicap', side, line: outcome.point });
      }
    }
    // A market's mutually exclusive outcomes come from one actual price sheet.
    const priceSheets = new Map<string, LiveResearchQuote[]>();
    for (const quote of quotes) {
      const group = `${quote.market}:${quote.market === 'asian_handicap' && quote.side === 'away' ? -quote.line! : quote.line ?? ''}`;
      const sheet = priceSheets.get(group) ?? []; sheet.push(quote); priceSheets.set(group, sheet);
    }
    for (const [group, sheet] of priceSheets) {
      const fresh = sheet.every((quote) => !quoteFreshnessReason(quote, Date.parse(capturedAt)));
      const complete = sheet.length === (sheet[0].market === '1x2' ? 3 : 2);
      const existing = groups.get(group);
      if (!existing || (fresh && !existing.fresh) || (fresh === existing.fresh && complete && !existing.complete)) {
        groups.set(group, { quotes: sheet, fresh, complete });
      }
    }
  }
  return [...groups.values()].flatMap((sheet) => sheet.quotes);
}

export function matchingResearchEvent(row: Record<string, any>, events: OddsMatch[]): OddsMatch | null {
  const ranked = events.map((event) => ({ event, evidence: scoreFixtureCandidate(event, row.home_team_name, row.away_team_name, row.date) }))
    .filter(({ evidence }) => evidence.straightTeamScore >= 1.8 && !evidence.warnings.includes('home_away_inverted_candidate') && evidence.score > 0)
    .sort((a, b) => b.evidence.score - a.evidence.score);
  if (!ranked.length || (ranked[1] && ranked[0].evidence.score - ranked[1].evidence.score < .15)) return null;
  return ranked[0].event;
}

export function researchBookmakerProbabilities(quotes: ResearchQuote[]): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const quote of quotes) {
    const line = quote.market === 'asian_handicap' && quote.side === 'away' ? -quote.line! : quote.line;
    const companions = quotes.filter((other) => other.bookmaker === quote.bookmaker && other.market === quote.market
      && other.capturedAt === quote.capturedAt && (other.market === 'asian_handicap' && other.side === 'away' ? -other.line! : other.line) === line);
    const complete = quote.market === '1x2' ? companions.length === 3 : companions.length === 2;
    output[quote.selection] = { bookmaker: quote.bookmaker, source: quote.source, raw: 1 / quote.odds,
      noVig: complete ? (1 / quote.odds) / companions.reduce((sum, companion) => sum + 1 / companion.odds, 0) : null };
  }
  return output;
}

/** This performs no registration; completed results settle only existing research bets. */
export async function settleResearchBets(db: RuntimeDb): Promise<{ checked: number; settled: number; unresolved: number }> {
  const bets = await db.research.listBets({ status: 'PENDING' });
  const summary = { checked: bets.length, settled: 0, unresolved: 0 };
  for (const bet of bets) {
    const match = await db.getMatchById(bet.matchId);
    if (!match || match.home_goals == null || match.away_goals == null) continue;
    const quote = bet.snapshot?.quote;
    const appExecution = bet.family === 'A' && !!bet.executionDecisionId;
    const outcome = appExecution ? settleAppRecommendationQuote(quote, match)
      : settleGoalQuote(quote, Number(match.home_goals), Number(match.away_goals));
    if (outcome.returnMultiplier == null) { summary.unresolved++; continue; }
    const result = await db.research.settleBet(bet.id, outcome.returnMultiplier, { matchId: bet.matchId,
      homeGoals: Number(match.home_goals), awayGoals: Number(match.away_goals), source: match.source,
      resultKickoffAt: match.date, status: outcome.status,
      ...(appExecution && ['cards_total', 'yellow_cards', 'shots', 'shots_on_target'].includes(quote?.market)
        ? { market: quote.market, selection: quote.selection, statistics: Object.fromEntries([
          'home_shots', 'away_shots', 'home_shots_on_target', 'away_shots_on_target',
          'home_yellow_cards', 'away_yellow_cards', 'home_red_cards', 'away_red_cards',
        ].filter((field) => match[field] !== undefined).map((field) => [field, match[field]])) } : {}) });
    if (result.settled) summary.settled++;
  }
  return summary;
}

/** Final decision marginals must describe the exact joint distribution used for EV. */
function coherentMatrixProbabilities(matrix: number[][], probabilities: Record<string, number>): boolean {
  try {
    const normalized = normalizeScoreMatrix(matrix);
    const mass = matrix.flat().reduce((sum, value) => sum + value, 0);
    if (Math.abs(mass - 1) > 1e-8) return false;
    return Object.entries(scoreMatrixMarkets(normalized)).every(([key, value]) =>
      Number.isFinite(probabilities[key]) && Math.abs(probabilities[key] - value) <= 1e-8);
  } catch { return false; }
}

export class ResearchRuntime {
  readonly scheduler: T15Scheduler;
  private readonly clock: () => Date;
  private readonly odds: OddsFeed;
  private lastFixtureSync = 0;
  private lastSettlement = 0;
  private historyCache: { at: number; rows: ResearchMatch[] } | undefined;
  private readonly competitionRequests = new Map<string, { at: number; value: Promise<{ events: OddsMatch[]; capturedAt: string }> }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private heartbeatAt = 0;
  private readonly errorRecordedAt = new Map<string, number>();
  private tickRunning = false;
  private lease: WorkerLease | null = null;
  private readonly ownerId: string;
  private readonly coordinator?: ResearchWorkerCoordinator;
  private readonly onTick?: (summary: T15TickSummary) => void;
  private claimedJobs: T15Job[] = [];
  private readonly nightly?: { quoteMaxAgeMs: number; minEv: number; minPrudentialEv: number };
  private readonly candidateVersionC?: string;
  private deploymentC?: ChallengerExecutionDeployment;
  private collectingCandidates: ReturnType<NonNullable<RuntimeDb['challengerAdoption']>['listCollectingCandidates']> | undefined;
  private readonly pairedForecastMatches = new Set<string>();
  private readonly pairedForecastReports = new Map<string, Record<string, unknown>>();
  private readonly prospectiveSamples = new Map<string, { asOf: string; samples: CalibrationSample[] }>();
  private nightlyCohortId: string | undefined;
  private nightlyModelContext: Promise<RuntimeModelContext> | undefined;
  private readonly state: { enabled: boolean; lastTick: T15TickSummary | null; lastError: string | null;
    targetLeadMinutes: number; toleranceSeconds: number; quoteMaxAgeSeconds: number } = {
      enabled: false, lastTick: null, lastError: null, targetLeadMinutes: 15, toleranceSeconds: 60, quoteMaxAgeSeconds: 300,
    };

  constructor(private readonly db: RuntimeDb, options: { clock?: () => Date; odds?: OddsFeed;
    coordinator?: ResearchWorkerCoordinator; ownerId?: string; onTick?: (summary: T15TickSummary) => void;
    nightly?: { quoteMaxAgeMs: number; minEv: number; minPrudentialEv: number }; candidateVersionC?: string;
    deploymentC?: ChallengerExecutionDeployment } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.coordinator = options.coordinator;
    this.ownerId = options.ownerId ?? randomUUID();
    this.onTick = options.onTick;
    this.nightly = options.nightly;
    if (options.candidateVersionC !== undefined && !/^C-[a-zA-Z0-9._-]{1,128}$/.test(options.candidateVersionC)) {
      throw new Error('Invalid pinned C model version');
    }
    this.candidateVersionC = options.candidateVersionC;
    if (options.deploymentC) this.pinChallengerDeployment(options.deploymentC);
    this.odds = options.odds ?? new OddsApiService(getConfiguredOddsApiKey(options.nightly ? 'default' : 't15'), {
      store: this.db.oddsRequests, operation: options.nightly ? 'nightly' : 't15', priority: 'essential',
      cacheMaxAgeMs: options.nightly?.quoteMaxAgeMs ?? 300_000,
    });
    this.scheduler = new T15Scheduler({ clock: this.clock,
      synchronize: (now) => this.synchronize(now),
      claimDueJobs: async (now) => {
        await this.assertWorkerLease();
        this.claimedJobs = await this.db.research.claimDueJobs(now);
        return this.claimedJobs;
      },
      prepare: (job, now) => this.prepare(job, now),
      commitBatch: async (jobs, now, order) => { await this.assertWorkerLease(); return this.db.research.commitBatch(jobs.map((prepared) => ({ jobId: prepared.job.id,
        leaseToken: prepared.job.leaseToken, inputSnapshot: prepared.inputSnapshot as Record<string, any>,
        decisions: prepared.decisions.map((decision) => ({ ...decision, market: String(decision.market ?? '') })) })), now, order); },
      finishJob: async (job, outcome) => {
        try { await this.db.research.finishJob(job.id, job.leaseToken, outcome); }
        catch (error) {
          // Persisting an official kickoff change deliberately revokes the old
          // lease. Verify that exact transition rather than reporting a spurious
          // failure or changing the newly scheduled job with the old token.
          if (outcome.reason !== 'kickoff_changed' || !/Research job lease lost/.test(String((error as Error)?.message ?? error))) throw error;
          const current = (await this.db.research.listJobs()).find((entry) => entry.id === job.id);
          const changed = current && Date.parse(current.kickoffAt) !== Date.parse(job.kickoffAt);
          const replacedClaim = current?.status === 'CLAIMED' && current.leaseToken !== job.leaseToken;
          if (!changed || (!['PENDING', 'MISSED', 'CANCELLED'].includes(current.status) && !replacedClaim)) throw error;
        }
      },
      recordError: async ({ operation, at }) => {
        // Provider exceptions may contain authenticated request URLs; persist a safe error category.
        this.state.lastError = `t15_${operation}_failed`;
        const lastRecorded = this.errorRecordedAt.get(operation);
        if (lastRecorded !== undefined && Date.parse(at) - lastRecorded < 10 * 60_000) return;
        this.errorRecordedAt.set(operation, Date.parse(at));
        await this.db.saveSchedulerRun({ schedulerName: 'research_t15', trigger: 'remote', startedAt: at,
          endedAt: at, success: false, error: this.state.lastError });
      },
    });
  }

  status() { return { ...this.state }; }

  /** One approved C tuple is held for the entire batch; A's input and engine are untouched. */
  pinChallengerDeployment(deployment: ChallengerExecutionDeployment): void {
    if (!/^C-[a-zA-Z0-9._-]{1,128}$/.test(deployment.modelVersion) || !deployment.baselineVersion?.trim()
      || !['canonical-binary-v1', 'payout-aware-v1'].includes(deployment.selectorPolicy)
      || [deployment.probabilityConfigurationHash, deployment.artifactHash]
        .some((hash) => hash !== null && !/^[a-f0-9]{64}$/i.test(hash))) throw new Error('Invalid pinned C deployment');
    this.deploymentC = Object.freeze({ ...deployment });
    this.nightlyModelContext = undefined;
  }

  private async assertWorkerLease(): Promise<void> {
    if (!this.coordinator) return;
    if (!this.lease) throw new Error('Research worker lease lost');
    await this.coordinator.assertOwned(this.lease);
  }

  async tick(): Promise<T15TickSummary> {
    if (this.tickRunning) return { at: this.clock().toISOString(), busy: true, claimed: 0, completed: 0,
      missed: 0, skipped: 0, retried: 0, errors: 0, allocationOrder: [] };
    this.tickRunning = true;
    let renewal: ReturnType<typeof setInterval> | undefined;
    let renewing = false;
    try {
      if (this.coordinator) {
        this.lease = await this.coordinator.acquire(this.ownerId, this.lease);
        if (!this.lease) return { at: this.clock().toISOString(), busy: true, claimed: 0, completed: 0,
          missed: 0, skipped: 0, retried: 0, errors: 0, allocationOrder: [] };
        const lease = this.lease;
        renewal = setInterval(() => {
          if (renewing) return;
          renewing = true;
          void this.coordinator!.renew(lease).then(async (owned) => {
            if (!owned && this.lease?.token === lease.token) this.lease = null;
            if (owned) await this.db.research.renewJobLeases(this.claimedJobs);
          }).catch(() => { if (this.lease?.token === lease.token) this.lease = null; }).finally(() => { renewing = false; });
        }, WORKER_RENEWAL_MS);
        renewal.unref?.();
      }
      const summary = await this.scheduler.tick();
      this.state.lastTick = summary;
      if (!summary.errors) this.state.lastError = null;
      const now = this.clock().getTime();
      if (now - this.heartbeatAt >= 60_000 || summary.claimed || summary.errors) {
        this.heartbeatAt = now;
        await this.db.saveSchedulerRun({ schedulerName: 'research_t15', trigger: 'remote', startedAt: summary.at,
          endedAt: this.clock().toISOString(), success: summary.errors === 0, summary });
      }
      if (now - this.lastSettlement >= 60_000) {
        this.lastSettlement = now;
        const startedAt = this.clock().toISOString();
        try {
          const settlement = await settleResearchBets(this.db);
          await this.db.saveSchedulerRun({ schedulerName: 'research_settlement', trigger: 'remote', startedAt,
            endedAt: this.clock().toISOString(), success: true, summary: settlement });
        } catch {
          await this.db.saveSchedulerRun({ schedulerName: 'research_settlement', trigger: 'remote', startedAt,
            endedAt: this.clock().toISOString(), success: false, error: 'research_settlement_failed' });
          this.state.lastError = 'research_settlement_failed';
        }
        if (this.db.researchMonitoring && this.db.listRecentSchedulerRuns) {
          await reconcileResearchMonitoring({ research: this.db.research, researchMonitoring: this.db.researchMonitoring,
            listRecentSchedulerRuns: this.db.listRecentSchedulerRuns.bind(this.db),
            listRecentSchedulerRunsByName: this.db.listRecentSchedulerRunsByName?.bind(this.db) }, this.clock(), { schedulerEnabled: true });
        }
      }
      if (this.coordinator && this.lease) await this.coordinator.complete(this.lease, summary, this.state.lastError);
      this.onTick?.(summary);
      return summary;
    } catch (error) {
      this.state.lastError = 'research_runtime_failed';
      if (this.coordinator && this.lease) await this.coordinator.complete(this.lease, this.state.lastTick, this.state.lastError).catch(() => undefined);
      throw error;
    } finally { if (renewal) clearInterval(renewal); this.claimedJobs = []; this.tickRunning = false; }
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.db.research.initializePortfolios();
    const baseline = baselineManifest();
    await this.db.research.saveModel({ family: 'A', version: baseline.version, artifact: baseline });
    this.state.enabled = true;
    const run = () => { void this.tick().catch(() => { this.state.lastError = 'research_runtime_failed'; }); };
    this.timer = setInterval(run, 15_000); this.timer.unref?.(); run();
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.state.enabled = false; }

  /** Drain an in-flight transaction before releasing ownership and closing libSQL. */
  async shutdown(): Promise<void> {
    this.stop();
    while (this.tickRunning) await new Promise((resolve) => setTimeout(resolve, 25));
    if (this.coordinator && this.lease) await this.coordinator.release(this.lease);
    this.lease = null;
  }

  private async synchronize(nowIso: string): Promise<void> {
    const now = Date.parse(nowIso);
    if (now - this.lastFixtureSync < 60_000) return;
    const fixtures = await this.db.getUpcomingMatches({ nowIso, untilIso: new Date(now + 48 * 3600_000).toISOString(), limit: 1000 });
    await this.db.research.syncJobs(fixtures.filter((row) => TOP5_COMPETITIONS.includes(row.competition)).map((row) => ({
      matchId: row.match_id, kickoffAt: row.date,
    })));
    this.lastFixtureSync = now;
  }

  private sharedOdds(competition: string): Promise<{ events: OddsMatch[]; capturedAt: string }> {
    const now = this.clock().getTime(); const cached = this.competitionRequests.get(competition);
    if (cached && now - cached.at < (this.nightly?.quoteMaxAgeMs ?? 30_000)) return cached.value;
    const startedAt = this.clock().toISOString();
    const markets = ['h2h', 'totals', 'spreads'];
    const record = async (success: boolean, eventCount?: number, failureCode?: string | null) => {
      try {
        await this.db.saveSchedulerRun({ schedulerName: 'research_provider', trigger: 'remote', startedAt,
          endedAt: this.clock().toISOString(), success,
          summary: { provider: 'odds_api', competition, markets, regions: ['eu'], eventCount,
            quota: this.odds.getQuotaStatus?.() ?? null },
          ...(success ? {} : { error: failureCode ?? 'research_odds_provider_unavailable' }) });
      } catch {
        // Provider observability cannot replace usable prices with an apparent fetch failure.
      }
    };
    const value: Promise<{ events: OddsMatch[]; capturedAt: string }> = this.odds.getOdds(competition, markets).then(async (events) => {
      const observedTimes = events.map((event) => Date.parse(event.capturedAt ?? '')).filter(Number.isFinite);
      const capturedAt = observedTimes.length ? new Date(Math.min(...observedTimes)).toISOString() : this.clock().toISOString();
      await record(true, events.length);
      return { events, capturedAt };
    }).catch(async (error) => {
      // A transient error is not a reusable price snapshot: the next scheduled
      // retry gets a real recovery attempt instead of the same rejected promise.
      if (this.competitionRequests.get(competition)?.value === value) this.competitionRequests.delete(competition);
      await record(false, undefined, safeOddsFailureCode(error));
      throw error;
    });
    this.competitionRequests.set(competition, { at: now, value });
    return value;
  }

  private async prepare(job: T15Job, _nowIso: string): Promise<PreparedT15Job> {
    const row = await this.db.getMatchById(job.matchId);
    const base = { job, kickoffAt: row?.date ?? job.kickoffAt, quotes: [], inputSnapshot: {}, decisions: [] };
    if (!row) return { ...base, status: 'unknown' };
    if (row.home_goals != null || row.away_goals != null) return { ...base, status: 'finished' };
    if (Date.parse(row.date) !== Date.parse(job.kickoffAt)) {
      if (!this.nightly) await this.db.research.syncJobs([{ matchId: job.matchId, kickoffAt: row.date }]);
      return { ...base, status: 'upcoming' };
    }
    const feed = await this.sharedOdds(row.competition);
    const event = matchingResearchEvent(row, feed.events);
    if (!event) return { ...base, status: 'unknown' };
    if (Date.parse(event.commenceTime) !== Date.parse(row.date)) {
      await this.db.updateMatchKickoff(job.matchId, event.commenceTime);
      if (!this.nightly) await this.db.research.syncJobs([{ matchId: job.matchId, kickoffAt: event.commenceTime }]);
      return { ...base, kickoffAt: event.commenceTime, status: 'upcoming' };
    }
    if (event.completed || event.live || Date.parse(event.commenceTime) <= this.clock().getTime()) return { ...base, status: 'started' };
    if (!this.historyCache || this.clock().getTime() - this.historyCache.at >= 60_000) {
      this.historyCache = { at: this.clock().getTime(), rows: (await this.db.getMatches()).map(researchMatchFromRow) };
    }
    const snapshotAt = this.clock().toISOString();
    const input = buildForecastInput(this.historyCache.rows, researchMatchFromRow(row), snapshotAt);
    const quotes = researchQuotesFromEvent(event, feed.capturedAt).map((quote) => this.nightly
      ? { ...quote, priceType: 'prematch' as const } : quote);
    const context = this.nightly ? await this.modelsForNightlyCohort(input.baselineVersion) : await this.loadModelContext();
    const { championC, latestCandidate, candidateC } = context;
    const decisions: T15Decision[] = [];
    const prospectiveObservations: FrozenProspectiveObservation[] = [];
    let challengerInput: ForecastInput | undefined;
    for (const family of ['A', 'C'] as const) {
      const modelVersion = family === 'A' ? input.baselineVersion : candidateC?.version ?? 'C-unavailable';
      const artifact = candidateC?.artifact as HybridArtifact | undefined;
      let familyInput = input;
      let matrix = input.baselineMatrix; let probabilities = input.baselineProbabilities;
      let failure: string | undefined;
      if (family === 'C') {
        if (artifact?.diagnosticOnly === true || artifact?.runtimeCompatible === false) failure = 'diagnostic_model_not_operational';
        else try {
          validateArtifact(artifact);
          if (artifact!.version !== modelVersion) throw new Error('registry_model_version_mismatch');
          if (this.deploymentC?.artifactHash && researchHash(artifact) !== this.deploymentC.artifactHash) throw new Error('deployment_artifact_mismatch');
          if (artifact!.featureSchema === CHALLENGER_FEATURE_SCHEMA_VERSION) {
            familyInput = withChallengerFeatures(input, this.historyCache.rows, artifact!.featureBlocks as ChallengerFeatureBlock[]);
            challengerInput = familyInput;
          }
          const predicted = predictHybrid(familyInput, artifact!);
          matrix = predicted.matrix; probabilities = predicted.probabilities;
        } catch { failure = 'hybrid_model_unavailable_or_incompatible'; }
      }
      const inferenceSucceeded = !failure;
      const rawProbabilities = inferenceSucceeded ? { ...probabilities } : {};
      const stages: { raw: Record<string, number>; calibrated: Record<string, number> | null; decision: Record<string, number> | null } = {
        raw: rawProbabilities, calibrated: null, decision: null,
      };
      const markets = await this.db.research.listMarkets({ family, modelVersion });
      const evidence = context.benchmarks ? context.benchmarks[family] : await this.db.research.getLatestBenchmark(family, modelVersion);
      const calibrationEvidence = family === 'C' && this.deploymentC?.probabilityConfigurationHash ? artifact
        : evidence?.report?.probabilityProtocol === COHERENT_PROBABILITY_PROTOCOL
        ? evidence.report : artifact;
      // Historical/T15 protocols retain their frozen inputs. The nightly must
      // never recycle labels used to fit an artifact's calibration profile.
      let samples = this.nightly ? undefined : calibrationEvidence?.calibrationSamples?.[family] as CalibrationSample[] | undefined;
      let prudentialEvidenceAsOf: string | null = null;
      const profile = calibrationEvidence?.calibrationProfilesV2?.[family] as CoherentCalibrationProfile | undefined;
      const mode = (calibrationEvidence?.probabilityCalibrationMode ?? 'isotonic_1x2') as CoherentCalibrationMode;
      if (!failure && (calibrationEvidence?.diagnosticOnly === true || calibrationEvidence?.runtimeCompatible === false)) failure = 'diagnostic_model_not_operational';
      if (!failure && calibrationEvidence?.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL) failure = 'coherent_probability_protocol_required';
      if (!failure && calibrationEvidence?.pipelineHashV2 !== coherentProbabilityPipelineHash()) failure = 'calibration_pipeline_version_mismatch';
      if (!failure && calibrationEvidence?.baselineVersion !== input.baselineVersion
        && calibrationEvidence?.validation?.baselineHash !== baselineManifest().fingerprint) failure = 'calibration_baseline_version_mismatch';
      const configurationTimes = calibrationEvidence === artifact
        ? [artifact?.createdAt, artifact?.validationThrough, ...(candidateC?.createdAt ? [candidateC.createdAt] : [])]
        : [evidence?.createdAt];
      const configurationAvailable = configurationTimes.every((value) => typeof value === 'string'
        && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) && Date.parse(value) <= Date.parse(snapshotAt));
      if (!failure && !configurationAvailable) failure = 'calibration_configuration_not_available_at_forecast';
      if (!failure && mode === 'isotonic_1x2' && !profile) failure = 'validated_calibration_unavailable';
      if (!failure) {
        try {
          const pipeline = applyCoherentProbabilityPipeline({ matrix, rawProbabilities: probabilities, profile,
            quotes, forecastAt: snapshotAt, mode, temperature: calibrationEvidence?.probabilityTemperature });
          stages.calibrated = pipeline.calibrated; stages.decision = pipeline.decision;
          probabilities = pipeline.decision; matrix = pipeline.matrix;
        } catch { failure = 'validated_calibration_unavailable'; }
      }
      let probabilityConfiguration: ReturnType<typeof buildProbabilityConfiguration> | null = null;
      if (!failure) {
        try {
          probabilityConfiguration = buildProbabilityConfiguration({ family, baselineVersion: input.baselineVersion,
            pipelineHashV2: calibrationEvidence.pipelineHashV2, mode,
            temperature: calibrationEvidence.probabilityTemperature, profile });
          if (family === 'C' && this.deploymentC && (this.deploymentC.baselineVersion !== input.baselineVersion
            || this.deploymentC.probabilityConfigurationHash !== null
              && this.deploymentC.probabilityConfigurationHash !== probabilityConfiguration.hash)) {
            failure = 'deployment_probability_configuration_mismatch';
          }
        } catch { failure = 'invalid_probability_configuration'; }
      }
      if (family === 'A' || candidateC) {
        const checks = { inference: inferenceSucceeded,
          calibrationCompatible: !failure && stages.decision !== null,
          finiteProbabilities: !failure && Object.values(probabilities).every((value) => Number.isFinite(value) && value >= 0 && value <= 1),
          coherentProbabilities: !failure && coherentMatrixProbabilities(matrix, probabilities),
          preKickoff: Date.parse(snapshotAt) < Date.parse(row.date), sharedSnapshot: true };
        await this.db.saveSchedulerRun({ schedulerName: 'research_model_check', trigger: 'remote', startedAt: snapshotAt,
          endedAt: this.clock().toISOString(), success: Object.values(checks).every(Boolean),
          summary: { family, modelVersion, matchId: input.matchId, snapshotHash: researchHash({ forecast: familyInput, quotes, observedAt: snapshotAt }),
            baselineVersion: input.baselineVersion, featureSchema: familyInput.featureSchema,
            ...(family === 'C' && this.deploymentC ? { selectorPolicy: this.deploymentC.selectorPolicy,
              expectedProbabilityConfigurationHash: this.deploymentC.probabilityConfigurationHash,
              artifactHash: candidateC?.artifactHash ?? researchHash(artifact ?? null) } : {}),
            probabilityProtocol: calibrationEvidence?.probabilityProtocol ?? null,
            pipelineHashV2: calibrationEvidence?.pipelineHashV2 ?? null,
            probabilityConfigurationHash: family === 'C' && this.deploymentC?.probabilityConfigurationHash
              ? this.deploymentC.probabilityConfigurationHash : probabilityConfiguration?.hash ?? null,
            ...(family === 'C' && this.deploymentC?.probabilityConfigurationHash
              ? { observedProbabilityConfigurationHash: probabilityConfiguration?.hash ?? null } : {}), checks,
            ...(failure ? { errorCode: failure } : {}) } });
        if (family === 'C' && failure && !this.deploymentC?.probabilityConfigurationHash && this.db.listRecentSchedulerRuns) {
          await rollbackUnhealthyChampion({ research: this.db.research,
            listRecentSchedulerRuns: this.db.listRecentSchedulerRuns.bind(this.db),
            listRecentSchedulerRunsByName: this.db.listRecentSchedulerRunsByName?.bind(this.db),
            saveSchedulerRun: this.db.saveSchedulerRun.bind(this.db) }, this.clock());
        }
      }
      const advertisedMarkets = markets.filter((market) => (this.nightly
        ? ['EXPERIMENTAL', 'SHADOW', 'ACTIVE'] : ['SHADOW', 'ACTIVE']).includes(market.state));
      const matchingConfiguration = (market: { evidence?: { approvedProbabilityConfigurationHash?: string } }) =>
        probabilityConfiguration !== null && market.evidence?.approvedProbabilityConfigurationHash === probabilityConfiguration.hash;
      // Economic validation remains unchanged in the registry. The nightly virtual
      // comparison needs technical calibration coherence, not a prior ROI result.
      const allowed = advertisedMarkets.filter((market) => this.nightly ? probabilityConfiguration !== null
        : matchingConfiguration(market)).map((market) => market.market);
      if (this.nightly && !failure && probabilityConfiguration) {
        if (!coherentMatrixProbabilities(matrix, probabilities)) failure = 'incoherent_probability_distribution';
        else {
          const key = `${job.runId ?? job.id}:${family}:${modelVersion}:${probabilityConfiguration.hash}`;
          const cached = this.prospectiveSamples.get(key);
          if (cached && Date.parse(cached.asOf) <= Date.parse(snapshotAt)) {
            samples = cached.samples; prudentialEvidenceAsOf = cached.asOf;
          } else {
            samples = await this.db.research.listProspectiveCalibrationSamples({ family, modelVersion,
              probabilityConfigurationHash: probabilityConfiguration.hash, asOf: snapshotAt });
            if (this.prospectiveSamples.size >= 8) this.prospectiveSamples.delete(this.prospectiveSamples.keys().next().value!);
            this.prospectiveSamples.set(key, { asOf: snapshotAt, samples }); prudentialEvidenceAsOf = snapshotAt;
          }
          prospectiveObservations.push(...buildFrozenProspectiveObservations({ matchId: row.match_id, family, modelVersion,
            probabilityConfigurationHash: probabilityConfiguration.hash, matrix, probabilities, quotes, allowedMarkets: allowed,
            forecastAt: snapshotAt, kickoffAt: row.date, quoteMaxAgeMs: this.nightly.quoteMaxAgeMs }));
        }
      }
      const result = failure ? null : explainResearchDecision({ matrix, probabilities, quotes, calibrationSamples: samples,
        allowedMarkets: allowed, now: snapshotAt, historical: false,
        ...(this.nightly ? { minEv: this.nightly.minEv, minPrudentialEv: this.nightly.minPrudentialEv } : {}) });
      const selected = result?.decision;
      decisions.push({ family, modelVersion, validated: !failure, action: selected ? 'BET' : 'ABSTAIN',
        ...(family === 'C' && this.deploymentC?.selectorPolicy === 'payout-aware-v1' ? { challengerQuality: {
          homeHistorySample: input.features[input.featureNames.indexOf('home_sample')] ?? null,
          awayHistorySample: input.features[input.featureNames.indexOf('away_sample')] ?? null,
          homeXgCoverage: input.features[input.featureNames.indexOf('home_xg_coverage')] ?? null,
          awayXgCoverage: input.features[input.featureNames.indexOf('away_xg_coverage')] ?? null,
          historyAvailableThrough: input.maxTrainingAvailableAt, modelFitAt: input.modelFitAt,
        } } : {}),
        market: selected?.quote.market ?? '', selection: selected?.quote.selection,
        quote: selected?.quote, quoteIndex: selected ? quotes.findIndex((quote) => quote === selected.quote) : undefined,
        marketState: selected ? markets.find((market) => market.market === selected.quote.market)?.state : undefined,
        probability: selected?.probability, ev: selected?.ev, prudentialEv: selected?.prudentialEv,
        probabilityProtocol: calibrationEvidence?.probabilityProtocol ?? null,
        probabilityConfiguration: probabilityConfiguration?.descriptor ?? null,
        probabilityConfigurationHash: probabilityConfiguration?.hash ?? null,
        calibrationPipelineHash: calibrationEvidence?.pipelineHashV2 ?? null,
        calibrationArtifactVersion: calibrationEvidence?.version ?? evidence?.modelVersion ?? null,
        calibrationAvailableAt: configurationAvailable ? new Date(Math.max(...configurationTimes.map((value) => Date.parse(value)))).toISOString() : null,
        ...(this.nightly && !failure ? { prospectiveMatrix: matrix, prudentialEvidenceAsOf,
          prudentialEvidenceProtocol: 'prospective-residual-v1', prudentialSamplesAvailable: samples?.length ?? 0 } : {}),
        probabilityStages: stages, bookmakerProbabilities: researchBookmakerProbabilities(quotes), forecastAt: snapshotAt,
        score: selected?.score ?? 0, reason: failure ?? (selected ? undefined
          : !this.nightly && advertisedMarkets.some((market) => !matchingConfiguration(market)) ? 'probability_configuration_not_validated'
            : JSON.stringify(result?.reasons ?? { model_unavailable: 1 })),
      });
    }
    if (championC && latestCandidate && latestCandidate.version !== championC.version
      && latestCandidate.artifact?.diagnosticOnly !== true && latestCandidate.artifact?.runtimeCompatible !== false) {
      await this.probeChallenger(input, latestCandidate.version, latestCandidate.artifact, quotes, snapshotAt);
    }
    const challengerCollection = await this.recordCollectingChallengers(input, quotes);
    return { job, kickoffAt: row.date, status: 'upcoming', quotes, decisions,
      ...(this.nightly ? { prospectiveObservations } : {}),
      inputSnapshot: { observedAt: snapshotAt, forecast: input, quotes, providerEventId: event.matchId, providerKickoffAt: event.commenceTime,
        ...(challengerInput ? { challengerForecast: challengerInput } : {}),
        ...(challengerCollection ? { challengerCollection } : {}),
        ...(this.nightly ? { mode: 'NIGHTLY', match: { matchId: row.match_id, competition: row.competition,
          kickoffAt: row.date, homeTeamName: row.home_team_name, awayTeamName: row.away_team_name,
          matchLabel: [row.home_team_name, row.away_team_name].filter(Boolean).join(' – ') } } : {}) } };
  }

  /** One finite nightly preparation: does not start polling, train or register bets. */
  async prepareNightly(job: T15Job): Promise<PreparedT15Job> {
    if (!this.nightly) throw new Error('Nightly preparation requires the nightly policy');
    const cohortId = String(job.runId ?? job.id);
    if (this.nightlyCohortId !== cohortId) this.beginNightlyCohort(cohortId);
    return this.prepare(job, this.clock().toISOString());
  }

  /** New attempts may explicitly reset the same run; ordinary fixture calls share one snapshot. */
  beginNightlyCohort(cohortId: string): void {
    if (!this.nightly || !cohortId.trim()) throw new Error('A nightly cohort identity is required');
    this.nightlyCohortId = cohortId;
    this.nightlyModelContext = undefined;
    this.prospectiveSamples.clear();
    this.collectingCandidates = undefined;
  }

  private async loadModelContext(): Promise<RuntimeModelContext> {
    const pinnedVersion = this.deploymentC?.modelVersion ?? this.candidateVersionC;
    if (pinnedVersion) {
      const candidateC = await this.db.research.getModelByVersion('C', pinnedVersion);
      // A fixed execution policy never follows a champion change, a weekly candidate or an optional probe.
      return { championC: null, latestCandidate: candidateC, candidateC, cacheable: true };
    }
    const championC = await this.db.research.getChampion('C');
    let cacheable = true;
    const candidatesC = await this.db.research.getModels('C').catch((error) => {
      if (!championC) throw error;
      cacheable = false;
      return [];
    });
    const latestCandidate = candidatesC[candidatesC.length - 1];
    return { championC, latestCandidate, candidateC: championC ?? latestCandidate, cacheable };
  }

  private modelsForNightlyCohort(baselineVersion: string): Promise<RuntimeModelContext> {
    if (this.nightlyModelContext) return this.nightlyModelContext;
    const pending = (async () => {
      const context = await this.loadModelContext();
      const [A, C] = await Promise.all([
        this.db.research.getLatestBenchmark('A', baselineVersion),
        this.deploymentC?.probabilityConfigurationHash ? Promise.resolve(null)
          : this.db.research.getLatestBenchmark('C', context.candidateC?.version ?? 'C-unavailable'),
      ]);
      return { ...context, benchmarks: { A, C } };
    })();
    this.nightlyModelContext = pending;
    // Rejected reads and a degraded optional-candidate read remain retryable.
    // Never let an older request clear the snapshot of a newer cohort.
    void pending.then((context) => {
      if (!context.cacheable && this.nightlyModelContext === pending) this.nightlyModelContext = undefined;
    }, () => { if (this.nightlyModelContext === pending) this.nightlyModelContext = undefined; });
    return pending;
  }

  getQuotaStatus(): unknown { return this.odds.getQuotaStatus?.() ?? null; }

  /** Candidate evidence never selects a bet or changes either operational model. */
  private async recordCollectingChallengers(input: ForecastInput, quotes: ResearchQuote[]): Promise<Record<string, unknown> | null> {
    const adoption = this.db.challengerAdoption;
    if (!this.nightly || !adoption) return null;
    const previous = this.pairedForecastReports.get(input.matchId);
    if (previous) return previous;
    const failures: Array<{ candidateId?: string; reason: string }> = [], results: unknown[] = [];
    try {
      this.collectingCandidates ??= adoption.listCollectingCandidates();
      for (const dossier of await this.collectingCandidates) {
        const key = `${dossier.id}:${input.matchId}`;
        if (this.pairedForecastMatches.has(key)) continue;
        this.pairedForecastMatches.add(key);
        try {
          results.push(await adoption.recordPairedChallengerForecast({ candidateId: dossier.id, input, quotes,
            history: this.historyCache?.rows ?? [] }));
        } catch { failures.push({ candidateId: dossier.id, reason: 'paired_challenger_forecast_failed' }); }
      }
    } catch { failures.push({ reason: 'collecting_challengers_unavailable' }); }
    if (failures.length) {
      this.state.lastError = 'challenger_collection_failed';
      try {
        await this.db.saveSchedulerRun({ schedulerName: 'research_challenger_collection', trigger: 'remote',
          startedAt: input.forecastAt, endedAt: this.clock().toISOString(), success: false,
          error: 'challenger_collection_failed', summary: { matchId: input.matchId, failures } });
      } catch { failures.push({ reason: 'challenger_collection_error_recording_failed' }); }
    }
    const report = results.length || failures.length ? { results, failures } : null;
    if (report) this.pairedForecastReports.set(input.matchId, report);
    return report;
  }

  /** One bounded compatibility probe; challenger output never enters a portfolio or replaces the champion here. */
  private async probeChallenger(input: ForecastInput, modelVersion: string, artifact: HybridArtifact, quotes: ResearchQuote[], snapshotAt: string): Promise<void> {
    const checks = { inference: false, calibrationCompatible: false, finiteProbabilities: false, coherentProbabilities: false,
      preKickoff: Date.parse(snapshotAt) < Date.parse(input.kickoffAt), sharedSnapshot: true };
    let errorCode: string | undefined;
    let probabilityConfigurationHash: string | null = null;
    try {
      validateArtifact(artifact);
      if (artifact.version !== modelVersion) throw new Error('registry_model_version_mismatch');
      if (artifact.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL
        || artifact.pipelineHashV2 !== coherentProbabilityPipelineHash()) throw new Error('pipeline_mismatch');
      if (artifact.baselineVersion !== input.baselineVersion) throw new Error('calibration_baseline_version_mismatch');
      if (!Number.isFinite(Date.parse(artifact.createdAt)) || Date.parse(artifact.createdAt) > Date.parse(snapshotAt)) throw new Error('future_model_configuration');
      const profile = (artifact.calibrationProfilesV2 as { C?: CoherentCalibrationProfile } | undefined)?.C;
      const mode = (artifact.probabilityCalibrationMode ?? 'isotonic_1x2') as CoherentCalibrationMode;
      if (mode === 'isotonic_1x2' && !profile) throw new Error('calibration_missing');
      const challengerInput = artifact.featureSchema === CHALLENGER_FEATURE_SCHEMA_VERSION
        ? withChallengerFeatures(input, this.historyCache?.rows ?? [], artifact.featureBlocks as ChallengerFeatureBlock[]) : input;
      const predicted = predictHybrid(challengerInput, artifact);
      const pipeline = applyCoherentProbabilityPipeline({ matrix: predicted.matrix, rawProbabilities: predicted.probabilities,
        profile, quotes, forecastAt: snapshotAt, mode, temperature: artifact.probabilityTemperature as number | undefined });
      probabilityConfigurationHash = buildProbabilityConfiguration({ family: 'C', baselineVersion: input.baselineVersion,
        pipelineHashV2: artifact.pipelineHashV2 as string, mode, profile,
        temperature: artifact.probabilityTemperature as number | undefined }).hash;
      checks.inference = true;
      checks.calibrationCompatible = true;
      checks.finiteProbabilities = Object.values(pipeline.decision).every((value) => Number.isFinite(value) && value >= 0 && value <= 1);
      checks.coherentProbabilities = coherentMatrixProbabilities(pipeline.matrix, pipeline.decision);
    } catch { errorCode = 'challenger_compatibility_probe_failed'; }
    try {
      await this.db.saveSchedulerRun({ schedulerName: 'research_model_check', trigger: 'remote', startedAt: snapshotAt,
        endedAt: this.clock().toISOString(), success: Object.values(checks).every(Boolean), summary: {
          family: 'C', role: 'CHALLENGER', modelVersion, matchId: input.matchId,
          snapshotHash: researchHash({ forecast: input, quotes, observedAt: snapshotAt }),
          probabilityProtocol: artifact?.probabilityProtocol ?? null, pipelineHashV2: artifact?.pipelineHashV2 ?? null,
          probabilityConfigurationHash,
          baselineVersion: input.baselineVersion,
          featureSchema: input.featureSchema, checks, ...(errorCode ? { errorCode } : {}),
        } });
    } catch {
      // Failure to record a candidate probe cannot alter an already prepared champion decision.
    }
  }
}
