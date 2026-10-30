import type { Client, Transaction } from '@libsql/client';
import { randomUUID } from 'node:crypto';
import { ResearchStore, researchHash, researchJson, ResearchFamily } from './ResearchStore';
import { settleGoalQuote } from './GoalSettlement';

export type RecommendationPolicyDescriptor = { version: string; [key: string]: any };
export const VIRTUAL_RECOMMENDATION_POLICY: RecommendationPolicyDescriptor = {
  version: 'virtual-recommendation-v1', virtualOnly: true, stakeModeA: 'RECOMMENDED_PERCENT',
  stakeModeC: 'FIXED_ONE_PERCENT', maxExposureFraction: .05, quoteMaxAgeMs: 300000,
  independentCalibrationRequired: false, maxBetsPerMatchPerFamily: 1,
};
export type RecommendationClaim = {
  policyHash: string; runId: string; windowStartAt: string; windowEndAt: string;
  fixtures: Array<{ matchId: string; kickoffAt: string }>; leaseMs?: number;
};
export type RecommendationJob = {
  id: string; matchId: string; kickoffAt: string; policyHash: string; runId: string;
  leaseToken: string; leaseExpiresAt: string; windowStartAt: string; windowEndAt: string;
  originInputId: string; originDecisionIds: { A: string; C: string }; [key: string]: any;
};
export type RecommendationDecision = {
  family: ResearchFamily; modelVersion: string; originDecisionId: string;
  action: 'BET' | 'ABSTAIN'; reason?: string; market?: string; selection?: string;
  quote?: Record<string, any>; probability?: number; ev?: number; recommended?: boolean;
  suggestedStakePercent?: number; confidence?: string; validated?: boolean;
  probabilityConfiguration?: Record<string, any>; probabilityConfigurationHash?: string;
  portfolioId?: string; [key: string]: any;
};
export type RecommendationCommit = {
  jobId: string; leaseToken: string; originInputId: string;
  inputSnapshot: Record<string, any>; decisions: RecommendationDecision[];
};

type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
const iso = (value: string | Date | number): string => {
  if (typeof value === 'string' && !/(?:z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Execution timestamp requires timezone');
  const date = new Date(value); if (!Number.isFinite(date.getTime())) throw new Error('Invalid execution timestamp'); return date.toISOString();
};
const object = (row: any): any => row ? Object.fromEntries(Object.entries(row).flatMap(([key, value]) => {
  const name = key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
  const result: Array<[string, any]> = [[name, typeof value === 'bigint' ? Number(value) : value]];
  if (key.endsWith('_json') && typeof value === 'string') result.push([name.slice(0, -4), JSON.parse(value)]);
  return result;
})) : null;
async function rows(db: Executor, sql: string, args: any[] = []): Promise<any[]> { return (await db.execute({ sql, args })).rows.map(object); }
async function first(db: Executor, sql: string, args: any[] = []): Promise<any> { return (await rows(db, sql, args))[0] ?? null; }

/** Versioned virtual execution preserves the original immutable research decisions. */
export class ResearchRecommendationStore {
  private readonly clock: () => Date;
  private readonly research: ResearchStore;
  private guards: Promise<void> | undefined;
  private schemaPresent: boolean | undefined;
  constructor(private readonly client: Client, private readonly ready: () => Promise<void> = async () => {},
    options: { now?: () => Date; research?: ResearchStore } = {}) {
    this.clock = options.now ?? (() => new Date()); this.research = options.research ?? new ResearchStore(client, ready, { now: this.clock });
  }

  private async ensureGuards(): Promise<void> {
    await this.ready();
    this.guards ??= this.research.runResearchTransaction(async (tx) => {
      if (!await first(tx, "SELECT name FROM sqlite_master WHERE type='table' AND name='research_execution_decisions'")) {
        throw new Error('Recommendation execution migration 023 is required');
      }
      const columns = await rows(tx, 'PRAGMA table_info(research_bets)');
      if (!columns.some((column) => column.name === 'execution_decision_id')) throw new Error('Execution bet identity migration is required');
      for (const table of ['research_execution_policies', 'research_execution_inputs', 'research_execution_decisions']) {
        for (const operation of ['UPDATE', 'DELETE']) await tx.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
          BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'execution evidence is immutable'); END;`);
      }
      await tx.execute(`CREATE TRIGGER IF NOT EXISTS research_execution_bet_authorization
        BEFORE INSERT ON research_bets WHEN NEW.execution_decision_id IS NOT NULL BEGIN
          SELECT CASE WHEN NOT EXISTS (
            SELECT 1 FROM research_execution_decisions d JOIN research_execution_inputs i ON i.id=d.input_id
            JOIN research_execution_jobs j ON j.id=i.job_id
            WHERE d.id=NEW.execution_decision_id AND d.origin_decision_id=NEW.decision_id AND d.action='BET'
              AND d.portfolio_id=NEW.portfolio_id AND d.family=NEW.family AND d.model_version=NEW.model_version
              AND j.match_id=NEW.match_id AND d.market=NEW.market AND d.selection=NEW.selection
              AND json_extract(d.snapshot_json,'$.stakeCents')=NEW.stake_cents
              AND json_extract(d.snapshot_json,'$.quote.odds')=NEW.odds
              AND json_extract(NEW.snapshot_json,'$.originDecisionId')=NEW.decision_id
              AND json_extract(NEW.snapshot_json,'$.effectiveExecutionDecisionId')=NEW.execution_decision_id
          ) THEN RAISE(ABORT,'execution bet authorization mismatch') END;
        END;`);
    }).then(async () => { await this.research.refreshExecutionSchema(); }).catch((error) => { this.guards = undefined; throw error; });
    await this.guards;
  }

  async registerPolicy(descriptor: RecommendationPolicyDescriptor = VIRTUAL_RECOMMENDATION_POLICY): Promise<any> {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) || !descriptor.version?.trim()) throw new Error('Policy descriptor required');
    if (descriptor.virtualOnly !== true || descriptor.stakeModeA !== 'RECOMMENDED_PERCENT' || descriptor.stakeModeC !== 'FIXED_ONE_PERCENT'
      || descriptor.maxExposureFraction !== .05 || descriptor.quoteMaxAgeMs !== 300000 || descriptor.independentCalibrationRequired !== false) {
      throw new Error('Unsupported virtual execution policy');
    }
    if (descriptor.maxBetsPerMatchPerFamily !== undefined && descriptor.maxBetsPerMatchPerFamily !== 1) throw new Error('One virtual bet per match and family is required');
    const hash = researchHash(descriptor), serialized = researchJson(descriptor);
    await this.ensureGuards();
    return this.research.runResearchTransaction(async (tx) => {
      const previous = await first(tx, 'SELECT * FROM research_execution_policies WHERE hash=?', [hash]);
      if (previous && researchJson(previous.descriptor) !== serialized) throw new Error('Policy descriptor is immutable');
      if (!previous) await tx.execute({ sql: 'INSERT INTO research_execution_policies(hash,version,descriptor_json,created_at) VALUES (?,?,?,?)',
        args: [hash, descriptor.version, serialized, iso(this.clock())] });
      return first(tx, 'SELECT * FROM research_execution_policies WHERE hash=?', [hash]);
    });
  }

  async getPolicy(hash: string): Promise<any> {
    if (!await this.hasSchema()) return null;
    return first(this.client, 'SELECT * FROM research_execution_policies WHERE hash=?', [hash]);
  }

  /** Read-only detection never creates guards and rechecks a previously absent schema. */
  async hasSchema(): Promise<boolean> {
    await this.ready();
    if (this.schemaPresent === true) return true;
    const tables = await first(this.client, `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'
      AND name IN ('research_execution_policies','research_execution_jobs','research_execution_inputs','research_execution_decisions')`);
    const columns = await rows(this.client, 'PRAGMA table_info(research_bets)');
    this.schemaPresent = Number(tables.count) === 4 && columns.some((column) => column.name === 'execution_decision_id');
    return this.schemaPresent;
  }

  async claimBatch(input: RecommendationClaim): Promise<{ jobs: RecommendationJob[]; skipped: any[]; busy: boolean }> {
    const start = iso(input.windowStartAt), end = iso(input.windowEndAt), now = iso(this.clock());
    if (!input.runId?.trim() || !/^[a-f0-9]{64}$/.test(input.policyHash) || Date.parse(start) > Date.parse(now)
      || Date.parse(end) <= Date.parse(now) || !Array.isArray(input.fixtures) || input.fixtures.length > 10000) throw new Error('Invalid execution claim');
    const identities = input.fixtures.map((fixture) => fixture.matchId);
    if (identities.some((id) => !id?.trim()) || new Set(identities).size !== identities.length) throw new Error('Unique execution fixture identity required');
    await this.ensureGuards();
    return this.research.runResearchTransaction(async (tx) => {
      const policy = await first(tx, 'SELECT * FROM research_execution_policies WHERE hash=?', [input.policyHash]);
      if (!policy || researchHash(policy.descriptor) !== input.policyHash) throw new Error('Registered execution policy required');
      const jobs: RecommendationJob[] = [], skipped: any[] = [];
      let active = false;
      for (const fixture of input.fixtures) {
        const kickoff = iso(fixture.kickoffAt), at = iso(this.clock());
        const skip = (reason: string) => { skipped.push({ matchId: fixture.matchId, reason }); };
        if (Date.parse(kickoff) <= Date.parse(at) || Date.parse(kickoff) > Date.parse(end)) { skip('outside_execution_window'); continue; }
        const previous = await first(tx, 'SELECT * FROM research_execution_jobs WHERE match_id=? AND policy_hash=?', [fixture.matchId, input.policyHash]);
        if (previous && (['COMPLETED', 'SKIPPED'].includes(previous.status)
          || await first(tx, 'SELECT id FROM research_execution_inputs WHERE job_id=?', [previous.id]))) { skip('policy_decision_already_recorded'); continue; }
        if (previous?.status === 'CLAIMED' && Date.parse(previous.leaseExpiresAt) > Date.parse(at)) { active = true; skip('execution_lease_active'); continue; }
        const origin = await first(tx, `SELECT i.id FROM research_inputs i JOIN research_jobs j ON j.id=i.job_id WHERE j.match_id=?`, [fixture.matchId]);
        if (!origin) { skip('origin_input_missing'); continue; }
        const origins = await rows(tx, "SELECT id,family FROM research_decisions WHERE input_id=? AND portfolio_id IN ('shadow_A','shadow_C')", [origin.id]);
        const originIds = Object.fromEntries(origins.map((decision) => [decision.family, decision.id]));
        if (!originIds.A || !originIds.C || origins.length !== 2) { skip('paired_origin_decisions_required'); continue; }
        const existingBets = await first(tx, "SELECT COUNT(DISTINCT portfolio_id) AS count FROM research_bets WHERE match_id=? AND portfolio_id IN ('shadow_A','shadow_C')", [fixture.matchId]);
        if (Number(existingBets.count) === 2) { skip('both_portfolios_already_bet'); continue; }
        const id = previous?.id ?? randomUUID(), token = randomUUID();
        const expires = iso(Math.min(Date.parse(at) + Math.max(1000, Math.min(input.leaseMs ?? 180000, 900000)), Date.parse(end), Date.parse(kickoff)));
        if (previous) await tx.execute({ sql: `UPDATE research_execution_jobs SET run_id=?,kickoff_at=?,window_start_at=?,window_end_at=?,status='CLAIMED',
          lease_token=?,lease_expires_at=?,reason=NULL,claimed_at=?,updated_at=? WHERE id=?`, args: [input.runId, kickoff, start, end, token, expires, at, at, id] });
        else await tx.execute({ sql: `INSERT INTO research_execution_jobs(id,match_id,policy_hash,run_id,kickoff_at,window_start_at,window_end_at,status,
          lease_token,lease_expires_at,claimed_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'CLAIMED',?,?,?,?,?)`,
        args: [id, fixture.matchId, input.policyHash, input.runId, kickoff, start, end, token, expires, at, at, at] });
        jobs.push({ ...await first(tx, 'SELECT * FROM research_execution_jobs WHERE id=?', [id]), originInputId: origin.id,
          originDecisionIds: originIds as { A: string; C: string } });
      }
      return { jobs, skipped, busy: jobs.length === 0 && active };
    });
  }

  private assertLease(job: any, token: string, now: number): void {
    if (!job || job.status !== 'CLAIMED' || job.leaseToken !== token || now >= Date.parse(job.leaseExpiresAt)) throw new Error('Execution job lease lost');
    if (now < Date.parse(job.windowStartAt) || now >= Date.parse(job.windowEndAt) || now >= Date.parse(job.kickoffAt)) throw new Error('Execution commit window closed');
  }

  private quoteReason(quote: any, observed: number, now: number, kickoff: number): string | null {
    if (!quote || quote.source !== 'odds_api' || quote.usedSyntheticOdds === true || quote.timestampEvidence === 'observed_snapshot'
      || quote.priceType !== 'prematch' || !String(quote.bookmaker ?? '').trim() || !Number.isFinite(quote.odds) || quote.odds <= 1) return 'real_fresh_quote_required';
    if (settleGoalQuote(quote, 0, 0).status === 'UNRESOLVED') return 'market_settlement_not_supported';
    for (const value of [quote.capturedAt, quote.updatedAt]) {
      const time = typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
      if (!Number.isFinite(time) || time > observed || time > now || time >= kickoff || now - time > 300000 || observed - time > 300000) return 'real_fresh_quote_required';
    }
    return null;
  }

  async renewLeases(jobs: Array<{ id: string; leaseToken: string }>, leaseMs = 180000): Promise<boolean> {
    await this.ensureGuards();
    return this.research.runResearchTransaction(async (tx) => {
      let allOwned = true;
      for (const requested of jobs) {
        const job = await first(tx, 'SELECT * FROM research_execution_jobs WHERE id=?', [requested.id]), now = this.clock().getTime();
        try { this.assertLease(job, requested.leaseToken, now); } catch { allOwned = false; continue; }
        const expires = iso(Math.min(now + Math.max(1000, Math.min(leaseMs, 900000)), Date.parse(job.windowEndAt), Date.parse(job.kickoffAt)));
        await tx.execute({ sql: 'UPDATE research_execution_jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND lease_token=?',
          args: [expires, iso(now), job.id, requested.leaseToken] });
      }
      return allOwned;
    });
  }

  async finishJob(jobId: string, leaseToken: string, outcome: { status: 'SKIPPED' | 'ERROR'; reason: string }): Promise<any> {
    if (!['SKIPPED', 'ERROR'].includes(outcome.status) || !outcome.reason?.trim()) throw new Error('Execution finish outcome required');
    await this.ensureGuards();
    return this.research.runResearchTransaction(async (tx) => {
      const job = await first(tx, 'SELECT * FROM research_execution_jobs WHERE id=?', [jobId]);
      if (job?.status === 'COMPLETED') return job;
      this.assertLease(job, leaseToken, this.clock().getTime());
      await tx.execute({ sql: 'UPDATE research_execution_jobs SET status=?,reason=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=?',
        args: [outcome.status, outcome.reason, iso(this.clock()), jobId, leaseToken] });
      return first(tx, 'SELECT * FROM research_execution_jobs WHERE id=?', [jobId]);
    });
  }

  async commitBatch(prepared: RecommendationCommit[], now: string | Date = this.clock()): Promise<any> {
    iso(now); if (!prepared.length) return { decisions: [], bets: [], jobs: [] };
    if (new Set(prepared.map((item) => item.jobId)).size !== prepared.length) throw new Error('Duplicate execution job in batch');
    await this.ensureGuards();
    const finalChecks: Array<{ job: any; token: string; quote?: any; observed: number }> = [];
    return this.research.runResearchTransaction(async (tx) => {
      const decisions: any[] = [], bets: any[] = [], completedJobs: any[] = [];
      const plans: Array<{ item: RecommendationCommit; job: any; inputId: string; decision: RecommendationDecision; policy: any }> = [];
      const hasFixtures = await first(tx, "SELECT name FROM sqlite_master WHERE type='table' AND name='matches'");
      for (const item of prepared) {
        const job = await first(tx, 'SELECT * FROM research_execution_jobs WHERE id=?', [item.jobId]);
        if (!job) throw new Error('Execution job not found');
        const ordered = [...item.decisions].sort((a, b) => a.family.localeCompare(b.family));
        const decisionsHash = researchHash(ordered), inputHash = researchHash(item.inputSnapshot);
        if (job.status === 'COMPLETED') {
          const stored = await first(tx, 'SELECT id,input_hash,decisions_hash,origin_input_id FROM research_execution_inputs WHERE job_id=?', [job.id]);
          if (!stored || stored.inputHash !== inputHash || stored.decisionsHash !== decisionsHash || stored.originInputId !== item.originInputId) throw new Error('Completed execution evidence is immutable');
          decisions.push(...await rows(tx, 'SELECT * FROM research_execution_decisions WHERE input_id=?', [stored.id]));
          bets.push(...await rows(tx, 'SELECT b.* FROM research_bets b JOIN research_execution_decisions d ON d.id=b.execution_decision_id WHERE d.input_id=?', [stored.id]));
          completedJobs.push(job); continue;
        }
        const at = this.clock().getTime(); this.assertLease(job, item.leaseToken, at);
        const policy = await first(tx, 'SELECT * FROM research_execution_policies WHERE hash=?', [job.policyHash]);
        if (!policy || researchHash(policy.descriptor) !== job.policyHash) throw new Error('Execution policy identity mismatch');
        const origin = await first(tx, `SELECT i.id,j.match_id FROM research_inputs i JOIN research_jobs j ON j.id=i.job_id WHERE i.id=?`, [item.originInputId]);
        if (!origin || origin.matchId !== job.matchId) throw new Error('Execution origin input mismatch');
        if (hasFixtures) {
          const fixture = await first(tx, 'SELECT date,home_goals,away_goals FROM matches WHERE match_id=?', [job.matchId]);
          if (!fixture || Date.parse(fixture.date) !== Date.parse(job.kickoffAt) || fixture.homeGoals != null || fixture.awayGoals != null) throw new Error('Execution fixture changed before commit');
        }
        const observed = Date.parse(iso(item.inputSnapshot?.observedAt));
        if (observed > at || observed < Date.parse(job.claimedAt) || observed >= Date.parse(job.kickoffAt)) throw new Error('Execution snapshot must follow claim and precede kickoff');
        if (!Array.isArray(item.inputSnapshot.quotes)) throw new Error('Shared execution quotes required');
        if (item.inputSnapshot.match?.matchId && item.inputSnapshot.match.matchId !== job.matchId) throw new Error('Execution snapshot fixture mismatch');
        if (item.inputSnapshot.metadata?.policy && researchHash(item.inputSnapshot.metadata.policy) !== job.policyHash) throw new Error('Execution snapshot policy mismatch');
        if (item.decisions.length !== 2 || ordered.map((d) => d.family).join(',') !== 'A,C') throw new Error('Paired execution A/C decisions required');
        const inputId = randomUUID();
        await tx.execute({ sql: `INSERT INTO research_execution_inputs(id,job_id,origin_input_id,input_hash,decisions_hash,snapshot_json,captured_at,kickoff_at) VALUES (?,?,?,?,?,?,?,?)`,
          args: [inputId, job.id, item.originInputId, inputHash, decisionsHash, researchJson(item.inputSnapshot), iso(at), job.kickoffAt] });
        for (const decision of ordered) plans.push({ item, job, inputId, decision, policy });
        finalChecks.push({ job, token: item.leaseToken, observed });
      }
      plans.sort((a, b) => a.decision.family.localeCompare(b.decision.family)
        || Number(b.decision.score ?? b.decision.ev ?? 0) - Number(a.decision.score ?? a.decision.ev ?? 0) || a.job.matchId.localeCompare(b.job.matchId));
      const equityBasis = new Map<string, number>();
      for (const plan of plans) {
        const { item, job, decision } = plan, at = this.clock().getTime(); this.assertLease(job, item.leaseToken, at);
        const portfolioId = `shadow_${decision.family}`;
        if (decision.portfolioId && decision.portfolioId !== portfolioId) throw new Error('Execution uses only independent shadow portfolios');
        const origin = await first(tx, 'SELECT id,input_id,family,portfolio_id FROM research_decisions WHERE id=?', [decision.originDecisionId]);
        if (!origin || origin.inputId !== item.originInputId || origin.family !== decision.family || origin.portfolioId !== portfolioId) throw new Error('Execution origin decision mismatch');
        const portfolio = await first(tx, `SELECT p.id,COALESCE(SUM(l.available_delta_cents),0) AS available_cents,
          COALESCE(SUM(l.committed_delta_cents),0) AS committed_cents,
          COALESCE(SUM(l.available_delta_cents+l.committed_delta_cents),0) AS equity_cents
          FROM research_portfolios p LEFT JOIN research_ledger l ON l.portfolio_id=p.id WHERE p.id=? GROUP BY p.id`, [portfolioId]);
        if (!portfolio) throw new Error('Execution portfolio not initialized');
        if (!equityBasis.has(portfolioId)) equityBasis.set(portfolioId, Number(portfolio.equityCents));
        let reason: string | null = decision.action === 'ABSTAIN' ? decision.reason ?? 'model_abstained' : decision.reason ?? null;
        const abstain = (code: string) => { reason ??= code; };
        const model = await first(tx, 'SELECT family,version,created_at FROM research_models WHERE family=? AND version=?', [decision.family, decision.modelVersion]);
        const market = await first(tx, 'SELECT market,state FROM research_markets WHERE family=? AND model_version=? AND market=?', [decision.family, decision.modelVersion, decision.market ?? '']);
        if (!model) abstain('model_not_registered');
        else if (!Number.isFinite(Date.parse(model.createdAt)) || Date.parse(model.createdAt) > Date.parse(item.inputSnapshot.observedAt)) abstain('model_not_available_at_forecast');
        if (decision.family === 'C' && plan.policy.descriptor.familyC?.modelVersion
          && decision.modelVersion !== plan.policy.descriptor.familyC.modelVersion) abstain('policy_model_version_mismatch');
        if (!market || !['EXPERIMENTAL','SHADOW','ACTIVE'].includes(market.state)) abstain('market_not_allowed_for_virtual_execution');
        if (decision.recommended !== true || decision.validated !== true || decision.action !== 'BET') abstain('positive_valid_recommendation_required');
        if (decision.family === 'A' && !['HIGH', 'MEDIUM', 'LOW'].includes(decision.confidence ?? '')) abstain('recommendation_confidence_required');
        if (!Number.isFinite(decision.probability) || decision.probability <= 0 || decision.probability >= 1
          || !Number.isFinite(decision.ev) || decision.ev <= 0) abstain('positive_finite_recommendation_required');
        const configuration = decision.probabilityConfiguration;
        if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration) || configuration.family !== decision.family
          || !/^[a-f0-9]{64}$/.test(decision.probabilityConfigurationHash ?? '') || researchHash(configuration) !== decision.probabilityConfigurationHash) {
          abstain('probability_configuration_identity_required');
        }
        const observed = Date.parse(item.inputSnapshot.observedAt), quote = decision.quote;
        const quoteReason = this.quoteReason(quote, observed, at, Date.parse(job.kickoffAt)); if (quoteReason) abstain(quoteReason);
        if (quote && !item.inputSnapshot.quotes.some((shared: any) => researchHash(shared) === researchHash(quote))) abstain('quote_not_in_shared_snapshot');
        if (!decision.selection?.trim() || quote?.selection !== decision.selection || quote?.market !== decision.market) abstain('selection_quote_mismatch');
        const percent = decision.family === 'C' ? 1 : decision.suggestedStakePercent;
        const basisPoints = Number.isFinite(percent) ? Math.round(percent * 100) : 0;
        if (!Number.isFinite(percent) || percent <= 0 || percent > 5 || Math.abs(percent * 100 - basisPoints) > 1e-7) abstain('invalid_recommended_stake');
        const stakeCents = Math.floor(equityBasis.get(portfolioId)! * basisPoints / 10000);
        if (stakeCents <= 0 || !Number.isSafeInteger(stakeCents) || stakeCents > Number(portfolio.availableCents)) abstain('insufficient_virtual_capital');
        if (Number(portfolio.committedCents) + stakeCents > Math.floor(Number(portfolio.equityCents) * .05)) abstain('virtual_exposure_limit');
        if (await first(tx, 'SELECT id FROM research_bets WHERE portfolio_id=? AND match_id=?', [portfolioId, job.matchId])) abstain('one_bet_per_portfolio_match');
        const id = randomUUID(), createdAt = iso(at), action = reason ? 'ABSTAIN' : 'BET';
        const evidence = { ...item.inputSnapshot.match, ...decision, action, reason, decisionMode: 'VIRTUAL_RECOMMENDATION', policyHash: job.policyHash,
          policyVersion: plan.policy.version,
          runId: job.runId, matchId: job.matchId, kickoffAt: job.kickoffAt, portfolioId,
          originDecisionId: decision.originDecisionId, effectiveExecutionDecisionId: id, originInputId: item.originInputId,
          inputId: plan.inputId, inputHash: researchHash(item.inputSnapshot), quote: quote ?? null,
          equityBasisCents: equityBasis.get(portfolioId), stakeMode: decision.family === 'A' ? 'RECOMMENDED_PERCENT' : 'FIXED_ONE_PERCENT',
          stakePercent: percent ?? null, stakeCents: action === 'BET' ? stakeCents : 0,
          experimental: market?.state === 'EXPERIMENTAL' };
        await tx.execute({ sql: `INSERT INTO research_execution_decisions(id,input_id,origin_decision_id,family,model_version,portfolio_id,action,market,selection,reason,snapshot_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [id, plan.inputId, decision.originDecisionId, decision.family, decision.modelVersion, portfolioId,
          action, decision.market ?? '', decision.selection ?? null, reason, researchJson(evidence), createdAt] });
        decisions.push({ id, ...evidence, createdAt });
        if (action === 'BET') {
          const betId = randomUUID();
          await tx.execute({ sql: `INSERT INTO research_bets(id,decision_id,execution_decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [betId, decision.originDecisionId, id, portfolioId, job.matchId, decision.family,
            decision.modelVersion, decision.market, decision.selection, quote.odds, stakeCents, researchJson(evidence), createdAt] });
          await tx.execute({ sql: `INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at)
            VALUES (?,?,?,'STAKE',?,?,?)`, args: [`stake:${betId}`, portfolioId, betId, -stakeCents, stakeCents, createdAt] });
          bets.push({ id: betId, decisionId: decision.originDecisionId, originDecisionId: decision.originDecisionId, executionDecisionId: id,
            effectiveExecutionDecisionId: id, portfolioId, matchId: job.matchId, family: decision.family, modelVersion: decision.modelVersion,
            market: decision.market, selection: decision.selection, odds: quote.odds, stakeCents, snapshot: evidence, placedAt: createdAt, status: 'PENDING' });
          finalChecks.push({ job, token: item.leaseToken, quote, observed });
        }
      }
      for (const entry of finalChecks) this.assertLease(entry.job, entry.token, this.clock().getTime());
      for (const jobId of new Set(plans.map((plan) => plan.job.id))) {
        await tx.execute({ sql: "UPDATE research_execution_jobs SET status='COMPLETED',updated_at=? WHERE id=?", args: [iso(this.clock()), jobId] });
        completedJobs.push(await first(tx, 'SELECT * FROM research_execution_jobs WHERE id=?', [jobId]));
      }
      return { decisions, bets, jobs: completedJobs };
    }, () => {
      for (const entry of finalChecks) {
        const at = this.clock().getTime(); this.assertLease(entry.job, entry.token, at);
        if (entry.quote && this.quoteReason(entry.quote, entry.observed, at, Date.parse(entry.job.kickoffAt))) throw new Error('Execution quote expired before commit');
      }
    });
  }

  async listJobs(options: { policyHash?: string; runId?: string; matchId?: string; limit?: number } = {}): Promise<any[]> {
    if (!await this.hasSchema()) return [];
    const filters: string[] = [], args: any[] = [], limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid execution read limit');
    if (options.policyHash) { filters.push('policy_hash=?'); args.push(options.policyHash); }
    if (options.runId) { filters.push('run_id=?'); args.push(options.runId); }
    if (options.matchId) { filters.push('match_id=?'); args.push(options.matchId); }
    return rows(this.client, `SELECT id,match_id,policy_hash,run_id,kickoff_at,window_start_at,window_end_at,status,reason,claimed_at,created_at,updated_at
      FROM research_execution_jobs ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY created_at DESC,id LIMIT ?`, [...args, limit]);
  }

  async listDecisions(options: { policyHash?: string; runId?: string; matchId?: string; limit?: number; fullSnapshot?: boolean } = {}): Promise<any[]> {
    if (!options.fullSnapshot) return this.listDecisionViews(options);
    if (!await this.hasSchema()) return [];
    const filters: string[] = [], args: any[] = [], limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid execution read limit');
    if (options.policyHash) { filters.push('j.policy_hash=?'); args.push(options.policyHash); }
    if (options.runId) { filters.push('j.run_id=?'); args.push(options.runId); }
    if (options.matchId) { filters.push('j.match_id=?'); args.push(options.matchId); }
    return rows(this.client, `SELECT d.*,j.policy_hash,j.run_id,j.match_id FROM research_execution_decisions d
      JOIN research_execution_inputs i ON i.id=d.input_id JOIN research_execution_jobs j ON j.id=i.job_id
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY d.created_at DESC,d.id LIMIT ?`, [...args, limit]);
  }

  async listDecisionViews(options: { policyHash?: string; runId?: string; matchId?: string; family?: ResearchFamily;
    limit?: number; includeForecasts?: boolean; includeProbabilityStages?: boolean } = {}): Promise<any[]> {
    if (!await this.hasSchema()) return [];
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || options.includeForecasts && !options.matchId) throw new Error('Invalid execution view scope');
    const filters: string[] = [], args: any[] = [];
    for (const [key, column] of [['policyHash', 'j.policy_hash'], ['runId', 'j.run_id'], ['matchId', 'j.match_id'], ['family', 'd.family']] as const) {
      if (options[key]) { filters.push(`${column}=?`); args.push(options[key]); }
    }
    const fields = ['probability', 'ev', 'confidence', 'suggestedStakePercent', 'stakePercent', 'stakeMode', 'stakeCents', 'equityBasisCents', 'inputHash',
      'originDecisionId', 'effectiveExecutionDecisionId', 'policyHash', 'runId', 'quote', 'decisionMode', 'experimental', 'probabilityConfigurationHash'];
    if (options.includeProbabilityStages) fields.push('probabilityStages');
    const snapshot = fields.flatMap((key) => [`'${key}'`, `json_extract(d.snapshot_json,'$.${key}')`]).join(',');
    const forecast = options.includeForecasts ? `CASE WHEN d.family='A' THEN json_extract(i.snapshot_json,'$.forecasts.A')
      ELSE json_extract(i.snapshot_json,'$.forecasts.C.recommendation') END` : 'NULL';
    const result = await rows(this.client, `WITH effective_ids AS (
      SELECT d.id,ROW_NUMBER() OVER (PARTITION BY j.match_id,d.family,d.portfolio_id ORDER BY
        CASE WHEN EXISTS(SELECT 1 FROM research_bets funded WHERE funded.execution_decision_id=d.id) THEN 1 ELSE 0 END DESC,
        julianday(d.created_at) DESC,d.id DESC) AS rank
      FROM research_execution_decisions d JOIN research_execution_inputs i ON i.id=d.input_id JOIN research_execution_jobs j ON j.id=i.job_id
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''}
    ) SELECT d.id,d.input_id,d.origin_decision_id,d.family,d.model_version,d.portfolio_id,d.action,d.market,d.selection,
      d.reason,d.created_at,j.policy_hash,p.version AS policy_version,j.run_id,j.match_id,j.kickoff_at,
      json_extract(i.snapshot_json,'$.observedAt') AS forecast_at,json_object(${snapshot}) AS snapshot_json,
      ${forecast} AS recommendation_packet_json,b.id AS bet_id,b.stake_cents AS bet_stake_cents,b.placed_at AS bet_placed_at,
      CASE WHEN b.id IS NULL THEN NULL WHEN s.bet_id IS NULL THEN 'PENDING' ELSE 'SETTLED' END AS bet_status,
      xb.id AS existing_bet_id,xb.execution_decision_id AS existing_bet_execution_decision_id,xb.decision_id AS existing_bet_origin_decision_id
      FROM research_execution_decisions d JOIN research_execution_inputs i ON i.id=d.input_id JOIN research_execution_jobs j ON j.id=i.job_id
      JOIN effective_ids effective ON effective.id=d.id AND effective.rank=1
      JOIN research_execution_policies p ON p.hash=j.policy_hash LEFT JOIN research_bets b ON b.execution_decision_id=d.id
      LEFT JOIN research_settlements s ON s.bet_id=b.id LEFT JOIN research_bets xb ON xb.match_id=j.match_id AND xb.portfolio_id=d.portfolio_id
      ORDER BY julianday(d.created_at) DESC,d.id DESC LIMIT ?`, [...args, limit]);
    return result.map((row) => { delete row.snapshotJson; delete row.recommendationPacketJson; return row; });
  }

  /** Exact paired aggregates are independent from the bounded difference detail rows. */
  async getComparisonDecisionPairs(options: { from: string; to: string; limit?: number }): Promise<{
    pairs: Array<{ A: any; C: any }>; comparedCount: number; differentCount: number; incompleteCount: number;
    truncated: boolean; earliestCreatedAt: string | null;
  }> {
    await this.ready();
    const from = iso(options.from), to = iso(options.to), limit = options.limit ?? 500;
    if (Date.parse(to) <= Date.parse(from) || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid comparison decision scope');
    const hasExecution = await this.hasSchema();
    const fields = ['quote','probability','ev','confidence','suggestedStakePercent','stakePercent','stakeCents','decisionMode','policyHash','policyVersion',
      'matchId','competition','league','matchLabel','homeTeamName','awayTeamName','kickoffAt'];
    const compact = (alias: string) => fields.flatMap((key) => [`'${key}'`, `json_extract(${alias}.snapshot_json,'$.${key}')`]).join(',');
    const legacy = `SELECT d.id,d.job_id,d.input_id,d.id AS origin_decision_id,d.family,d.model_version,d.portfolio_id,d.action,d.market,d.selection,d.reason,d.created_at,
      j.match_id,j.kickoff_at,'legacy' AS authority,0 AS authority_rank,NULL AS policy_hash,NULL AS policy_version,
      CASE WHEN b.id IS NOT NULL THEN 1 ELSE 0 END AS funded,b.id AS bet_id,b.stake_cents AS bet_stake_cents,b.placed_at AS bet_placed_at,
      CASE WHEN b.id IS NULL THEN NULL WHEN s.bet_id IS NULL THEN 'PENDING' ELSE 'SETTLED' END AS bet_status,
      json_extract(d.snapshot_json,'$.quote') AS quote_json,json_object(${compact('d')}) AS snapshot_json
      FROM research_decisions d JOIN research_jobs j ON j.id=d.job_id
      LEFT JOIN research_bets b ON b.decision_id=d.id${hasExecution ? ' AND b.execution_decision_id IS NULL' : ''}
      LEFT JOIN research_settlements s ON s.bet_id=b.id
      WHERE d.family IN ('A','C') AND d.portfolio_id='shadow_'||d.family`;
    const execution = hasExecution ? ` UNION ALL SELECT d.id,j.id AS job_id,d.input_id,d.origin_decision_id,d.family,d.model_version,d.portfolio_id,
      d.action,d.market,d.selection,d.reason,d.created_at,j.match_id,j.kickoff_at,'execution' AS authority,1 AS authority_rank,j.policy_hash,p.version AS policy_version,
      CASE WHEN b.id IS NOT NULL THEN 1 ELSE 0 END AS funded,b.id AS bet_id,b.stake_cents AS bet_stake_cents,b.placed_at AS bet_placed_at,
      CASE WHEN b.id IS NULL THEN NULL WHEN s.bet_id IS NULL THEN 'PENDING' ELSE 'SETTLED' END AS bet_status,
      json_extract(d.snapshot_json,'$.quote') AS quote_json,json_object(${compact('d')}) AS snapshot_json
      FROM research_execution_decisions d JOIN research_execution_inputs i ON i.id=d.input_id JOIN research_execution_jobs j ON j.id=i.job_id
      JOIN research_execution_policies p ON p.hash=j.policy_hash LEFT JOIN research_bets b ON b.execution_decision_id=d.id
      LEFT JOIN research_settlements s ON s.bet_id=b.id
      WHERE d.family IN ('A','C') AND d.portfolio_id='shadow_'||d.family` : '';
    const quoteDifferences = ['odds','bookmaker','source','line','side','team'].map((key) =>
      `json_extract(a.quote_json,'$.${key}') IS NOT json_extract(c.quote_json,'$.${key}')`).join(' OR ');
    const cte = `WITH candidates AS (${legacy}${execution}), ranked AS (
      SELECT *,ROW_NUMBER() OVER (PARTITION BY match_id,family,portfolio_id
        ORDER BY funded DESC,authority_rank DESC,julianday(created_at) DESC,id DESC) AS decision_rank FROM candidates
    ), effective AS (
      SELECT * FROM ranked WHERE decision_rank=1 AND julianday(created_at)>=julianday(?) AND julianday(created_at)<julianday(?)
    ), identities AS (
      SELECT match_id,MAX(CASE WHEN family='A' THEN id END) AS a_id,MAX(CASE WHEN family='C' THEN id END) AS c_id,
        MAX(julianday(created_at)) AS pair_at FROM effective GROUP BY match_id
    ), paired AS (
      SELECT p.*,CASE WHEN a.id IS NOT NULL AND c.id IS NOT NULL THEN 1 ELSE 0 END AS complete,
        CASE WHEN a.id IS NULL OR c.id IS NULL THEN 0 WHEN a.action IS NOT c.action THEN 1
          WHEN a.action<>'BET' THEN 0 WHEN a.market IS NOT c.market OR a.selection IS NOT c.selection OR ${quoteDifferences}
          THEN 1 ELSE 0 END AS different
      FROM identities p LEFT JOIN effective a ON a.id=p.a_id LEFT JOIN effective c ON c.id=p.c_id
    )`;
    const results = await this.client.batch([
      { sql: `${cte} SELECT COALESCE(SUM(complete),0) AS compared_count,COALESCE(SUM(different),0) AS different_count,
        COALESCE(SUM(1-complete),0) AS incomplete_count,
        (SELECT created_at FROM ranked WHERE decision_rank=1 ORDER BY julianday(created_at),id LIMIT 1) AS earliest_created_at FROM paired`, args: [from, to] },
      { sql: `${cte}, limited_pairs AS (
        SELECT match_id,pair_at FROM paired WHERE different=1 ORDER BY pair_at DESC,match_id LIMIT ?
      ) SELECT e.* FROM effective e JOIN limited_pairs p ON p.match_id=e.match_id ORDER BY p.pair_at DESC,p.match_id,e.family`, args: [from, to, limit] },
    ], 'read');
    const totals = object(results[0].rows[0]), grouped = new Map<string, { A?: any; C?: any }>();
    for (const raw of results[1].rows) {
      const row = object(raw); delete row.quoteJson; delete row.snapshotJson; delete row.decisionRank; delete row.funded; delete row.authorityRank;
      const pair = grouped.get(row.matchId) ?? {}; pair[row.family as 'A' | 'C'] = row; grouped.set(row.matchId, pair);
    }
    const pairs = [...grouped.values()].map((pair) => {
      if (!pair.A || !pair.C) throw new Error('Incomplete comparison detail pair');
      return { A: pair.A, C: pair.C };
    });
    return { pairs, comparedCount: Number(totals.comparedCount), differentCount: Number(totals.differentCount),
      incompleteCount: Number(totals.incompleteCount), truncated: Number(totals.differentCount) > pairs.length,
      earliestCreatedAt: totals.earliestCreatedAt ?? null };
  }

  async getRunMetrics(runId: string, policyHash?: string): Promise<any> {
    if (!await this.hasSchema()) return { analyzedMatches: 0, registeredBets: 0, abstainedMatches: 0, decisionCount: 0, reasonCounts: {} };
    const filter = 'j.run_id=?' + (policyHash ? ' AND j.policy_hash=?' : ''), args = policyHash ? [runId, policyHash] : [runId];
    const jobs = await rows(this.client, `SELECT j.id,j.match_id,j.status,COUNT(DISTINCT i.id) AS input_count,
      COUNT(DISTINCT d.id) AS decision_count,COUNT(DISTINCT b.id) AS bet_count
      FROM research_execution_jobs j LEFT JOIN research_execution_inputs i ON i.job_id=j.id
      LEFT JOIN research_execution_decisions d ON d.input_id=i.id LEFT JOIN research_bets b ON b.execution_decision_id=d.id
      WHERE ${filter} GROUP BY j.id,j.match_id,j.status`, args);
    const reasons = await rows(this.client, `SELECT d.reason,COUNT(*) AS count FROM research_execution_decisions d
      JOIN research_execution_inputs i ON i.id=d.input_id JOIN research_execution_jobs j ON j.id=i.job_id
      WHERE ${filter} AND d.action='ABSTAIN' GROUP BY d.reason`, args);
    return { analyzedMatches: jobs.filter((job) => job.inputCount > 0).length,
      registeredBets: jobs.reduce((sum, job) => sum + Number(job.betCount), 0),
      abstainedMatches: jobs.filter((job) => job.inputCount > 0 && job.betCount === 0).length,
      decisionCount: jobs.reduce((sum, job) => sum + Number(job.decisionCount), 0),
      reasonCounts: Object.fromEntries(reasons.map((reason) => [reason.reason ?? 'model_abstained', Number(reason.count)])) };
  }
}
