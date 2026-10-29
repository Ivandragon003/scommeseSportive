import type { Client, Transaction } from '@libsql/client';
import { createHash, randomUUID } from 'node:crypto';

export type ResearchFamily = 'A' | 'C';
export type ResearchMarketState = 'EXPERIMENTAL' | 'SHADOW' | 'ACTIVE' | 'SUSPENDED';
export type ResearchDecision = {
  family: ResearchFamily; modelVersion: string; market: string; selection?: string;
  quote?: { odds: number; source: string; bookmaker?: string; bookmakerName?: string; capturedAt?: string; captured_at?: string; updatedAt?: string; [key: string]: any };
  probability?: number; ev?: number; prudentialEv?: number; reason?: string; score?: number;
  action?: 'BET' | 'ABSTAIN'; portfolioId?: string; [key: string]: any;
};
export type ResearchCommit = {
  jobId: string; leaseToken: string; now?: string | Date;
  inputSnapshot: Record<string, any>; decisions: ResearchDecision[];
};
type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
const TOLERANCE_MS = 60_000;
const QUOTE_MAX_AGE_MS = 5 * 60_000;
const immutableTables = ['research_models', 'research_benchmarks', 'research_model_events',
  'research_market_events', 'research_portfolios', 'research_inputs', 'research_decisions',
  'research_bets', 'research_settlements', 'research_ledger'];
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' && !(value instanceof Date)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const researchJson = (value: unknown): string => JSON.stringify(canonical(value));
export const researchHash = (value: unknown): string => createHash('sha256').update(researchJson(value)).digest('hex');
const iso = (value: string | Date | number): string => {
  if (typeof value === 'string' && !/(?:z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Research timestamp requires an explicit timezone');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid research timestamp');
  return date.toISOString();
};
const family = (value: string): ResearchFamily => {
  if (value !== 'A' && value !== 'C') throw new Error('Invalid research family');
  return value;
};
const rowObject = (row: any): any => {
  if (!row) return null;
  const output: any = {};
  for (const [key, value] of Object.entries(row)) {
    const name = key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase());
    output[name] = typeof value === 'bigint' ? Number(value) : value;
    if (key.endsWith('_json') && typeof value === 'string') output[name.slice(0, -4)] = JSON.parse(value);
  }
  return output;
};
async function rows(db: Executor, sql: string, args: any[] = []): Promise<any[]> {
  const result = await db.execute({ sql, args });
  return result.rows.map(rowObject);
}
async function first(db: Executor, sql: string, args: any[] = []): Promise<any> {
  return (await rows(db, sql, args))[0] ?? null;
}

/** Research uses separate tables and integer cents; legacy balances are never read or written. */
export class ResearchStore {
  private guards: Promise<void> | undefined;
  private writeQueue: Promise<unknown> = Promise.resolve();
  private readonly clock: () => Date;

  constructor(private readonly client: Client, private readonly ready: () => Promise<void> = async () => {},
    options: { now?: () => Date } = {}) {
    this.clock = options.now ?? (() => new Date());
  }

  private async ensureGuards(): Promise<void> {
    await this.ready();
    this.guards ??= (async () => {
      // Keep trigger bodies away from the legacy migration statement splitter.
      const statements: string[] = [];
      for (const table of immutableTables) for (const operation of ['UPDATE', 'DELETE']) {
        statements.push(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
          BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'research evidence is immutable'); END;`);
      }
      for (let attempt = 0; ; attempt++) {
        try {
          // Remote Turso manages its journal. Local multi-process clients need WAL.
          if (this.client.protocol === 'file') await this.client.execute('PRAGMA journal_mode=WAL');
          await this.client.executeMultiple(statements.join('\n'));
          break;
        } catch (error: any) {
          if (!/SQLITE_BUSY|database is locked/i.test(String(error?.code) + String(error?.message))) throw error;
          await this.releaseFailedLocalConnection();
          if (attempt >= 6) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
        }
      }
    })().catch((error) => {
      // A temporary startup lock must not disable this store until process restart.
      this.guards = undefined;
      throw error;
    });
    await this.guards;
  }

  private async releaseFailedLocalConnection(): Promise<void> {
    if (this.client.protocol !== 'file') return;
    // A failed native startup statement can remain unfinished on its connection.
    // A deferred, empty transaction detaches that idle connection from the client.
    // Other transactions own separate connections; never close the shared client.
    const abandoned = await this.client.transaction('deferred');
    try { await abandoned.rollback(); } finally { abandoned.close(); }
  }

  private async write<T>(work: (tx: Transaction) => Promise<T>, beforeCommit?: () => void): Promise<T> {
    await this.ensureGuards();
    const run = async () => {
      let tx: Transaction;
      for (let attempt = 0; ; attempt++) {
        try { tx = await this.client.transaction('write'); break; }
        catch (error: any) {
          if (!/SQLITE_BUSY|database is locked/i.test(String(error?.code) + String(error?.message))) throw error;
          await this.releaseFailedLocalConnection();
          if (attempt >= 5) throw error;
          await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
        }
      }
      try {
        const result = await work(tx);
        beforeCommit?.();
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      } finally { tx.close(); }
    };
    const pending = this.writeQueue.then(run, run);
    this.writeQueue = pending.catch(() => undefined);
    return pending;
  }

  async initializePortfolios(options: { includeMain?: boolean } = {}): Promise<any[]> {
    await this.write(async (tx) => {
      for (const id of ['shadow_A', 'shadow_C', ...(options.includeMain ? ['main'] : [])]) {
        const now = iso(this.clock());
        await tx.execute({ sql: 'INSERT OR IGNORE INTO research_portfolios(id,family,created_at) VALUES (?,?,?)',
          args: [id, id === 'main' ? null : id.slice(-1), now] });
        await tx.execute({ sql: `INSERT OR IGNORE INTO research_ledger
          (id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at) VALUES (?,?,NULL,'OPEN',100000,0,?)`,
        args: [`open:${id}`, id, now] });
      }
    });
    return this.listPortfolios();
  }

  private portfolioSql = `SELECT p.id,p.family,p.created_at,
    COALESCE(SUM(l.available_delta_cents),0) AS available_cents,
    COALESCE(SUM(l.committed_delta_cents),0) AS committed_cents,
    COALESCE(SUM(l.available_delta_cents+l.committed_delta_cents),0) AS equity_cents
    FROM research_portfolios p LEFT JOIN research_ledger l ON l.portfolio_id=p.id`;

  async listPortfolios(): Promise<any[]> {
    await this.ensureGuards();
    return rows(this.client, `${this.portfolioSql} GROUP BY p.id ORDER BY p.id`);
  }

  async listBets(options: { portfolioId?: string; status?: string } = {}): Promise<any[]> {
    await this.ensureGuards();
    const filters = []; const args: any[] = [];
    if (options.portfolioId) { filters.push('b.portfolio_id=?'); args.push(options.portfolioId); }
    if (options.status === 'PENDING') filters.push('s.bet_id IS NULL');
    else if (options.status === 'SETTLED') filters.push('s.bet_id IS NOT NULL');
    return rows(this.client, `SELECT b.*,s.multiplier,s.return_cents,s.settled_at,s.evidence_json,
      CASE WHEN s.bet_id IS NULL THEN 'PENDING' ELSE 'SETTLED' END AS status,
      CASE WHEN s.bet_id IS NULL THEN NULL ELSE s.return_cents-b.stake_cents END AS profit_cents
      FROM research_bets b LEFT JOIN research_settlements s ON s.bet_id=b.id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY b.placed_at,b.match_id,b.portfolio_id`, args);
  }

  async listLedger(portfolioId?: string): Promise<any[]> {
    await this.ensureGuards();
    return rows(this.client, `SELECT * FROM research_ledger ${portfolioId ? 'WHERE portfolio_id=?' : ''}
      ORDER BY created_at,rowid`, portfolioId ? [portfolioId] : []);
  }

  async listDecisions(options: { jobId?: string; family?: ResearchFamily } = {}): Promise<any[]> {
    await this.ensureGuards();
    const filters = []; const args = [];
    if (options.jobId) { filters.push('job_id=?'); args.push(options.jobId); }
    if (options.family) { filters.push('family=?'); args.push(options.family); }
    return rows(this.client, `SELECT * FROM research_decisions ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY created_at,id`, args);
  }

  async saveModel(input: { family: ResearchFamily; version: string; artifact: any; status?: string }): Promise<any> {
    family(input.family);
    if (!input.version?.trim() || !input.artifact || typeof input.artifact !== 'object') throw new Error('Model artifact and version required');
    return this.write(async (tx) => {
      const existing = await first(tx, 'SELECT * FROM research_models WHERE family=? AND version=?', [input.family, input.version]);
      const hash = researchHash(input.artifact);
      if (existing) {
        if (existing.artifactHash !== hash) throw new Error('Model version is immutable');
        return existing;
      }
      await tx.execute({ sql: 'INSERT INTO research_models(family,version,artifact_json,artifact_hash,created_at) VALUES (?,?,?,?,?)',
        args: [input.family, input.version, researchJson(input.artifact), hash, iso(this.clock())] });
      return first(tx, 'SELECT * FROM research_models WHERE family=? AND version=?', [input.family, input.version]);
    });
  }

  async getModels(modelFamily?: ResearchFamily): Promise<any[]> {
    await this.ensureGuards();
    return rows(this.client, `SELECT m.*,CASE WHEN c.version=m.version THEN 1 ELSE 0 END AS is_champion
      FROM research_models m LEFT JOIN research_champions c ON c.family=m.family
      ${modelFamily ? 'WHERE m.family=?' : ''} ORDER BY m.created_at,m.version`, modelFamily ? [modelFamily] : []);
  }

  async getChampion(modelFamily: ResearchFamily): Promise<any> {
    await this.ensureGuards();
    return first(this.client, `SELECT m.*,c.benchmark_id FROM research_models m JOIN research_champions c
      ON c.family=m.family AND c.version=m.version WHERE m.family=?`, [family(modelFamily)]);
  }

  private independentEvidence(report: any): boolean {
    const v = report?.validation;
    const warnings = [...(Array.isArray(report?.warnings) ? report.warnings : []), ...(Array.isArray(v?.warnings) ? v.warnings : [])];
    return v?.finalHoldout === true && v.operationalChecksPassed === true
      && Boolean(v.dataHash) && Boolean(v.baselineHash) && Array.isArray(v.featureSchema) && v.featureSchema.length > 0
      && warnings.every((warning: any) => warning && typeof warning === 'object' && warning.invalidating === false);
  }

  private benchmarkPasses(report: any, modelFamily?: ResearchFamily | 'PAIR', version?: string): boolean {
    const v = report?.validation;
    const ci = (value: any) => Array.isArray(value) && value.length === 2
      && value.every((n: any) => typeof n === 'number' && Number.isFinite(n)) && value[0] <= value[1] && value[1] < 0;
    const reference = v?.comparisonReference;
    const referenceVersion = typeof v?.referenceModelVersion === 'string' && v.referenceModelVersion.trim().length > 0;
    const independentReference = (reference === 'bookmaker_no_vig' && modelFamily === 'A')
      || (reference === 'model_A' && modelFamily !== 'A' && referenceVersion)
      || (reference === 'incumbent' && referenceVersion && v.referenceModelVersion !== version);
    return this.independentEvidence(report) && independentReference && v?.passed === true && v.pairedCI === true && v.minSamplesSatisfied === true
      && v.nPaired >= 500 && v.leagueCount >= 4 && v.periodCount >= 4
      && ci(v.deltaLogLossCI) && ci(v.deltaBrierCI) && v.operationalChecksPassed === true
      && v.preRegisteredRule === 'research-promotion-v1';
  }

  async saveBenchmark(input: { family?: ResearchFamily | 'PAIR'; modelVersion?: string; report: any; validated?: boolean }): Promise<any> {
    const reportFamily = input.family ?? 'PAIR';
    if (!['A', 'C', 'PAIR'].includes(reportFamily)) throw new Error('Invalid benchmark family');
    return this.write(async (tx) => {
      const id = randomUUID();
      await tx.execute({ sql: `INSERT INTO research_benchmarks(id,family,model_version,report_json,report_hash,validated,created_at)
        VALUES (?,?,?,?,?,?,?)`, args: [id, reportFamily, input.modelVersion ?? null, researchJson(input.report), researchHash(input.report),
        this.benchmarkPasses(input.report, reportFamily, input.modelVersion) ? 1 : 0, iso(this.clock())] });
      return first(tx, 'SELECT * FROM research_benchmarks WHERE id=?', [id]);
    });
  }

  async getLatestBenchmark(modelFamily?: ResearchFamily | 'PAIR', version?: string): Promise<any> {
    await this.ensureGuards();
    const filters = []; const args = [];
    if (modelFamily) { filters.push('family=?'); args.push(modelFamily); }
    if (version) { filters.push('model_version=?'); args.push(version); }
    return first(this.client, `SELECT * FROM research_benchmarks ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY created_at DESC,rowid DESC LIMIT 1`, args);
  }

  async listBenchmarks(options: { family?: ResearchFamily | 'PAIR'; modelVersion?: string; limit?: number } = {}): Promise<any[]> {
    await this.ensureGuards();
    const filters: string[] = []; const args: any[] = [];
    if (options.family) { filters.push('family=?'); args.push(options.family); }
    if (options.modelVersion) { filters.push('model_version=?'); args.push(options.modelVersion); }
    const limit = Math.max(1, Math.min(10000, Math.floor(options.limit ?? 1000)));
    args.push(limit);
    return rows(this.client, `SELECT * FROM research_benchmarks ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY created_at DESC,rowid DESC LIMIT ?`, args);
  }

  async listModelEvents(modelFamily?: ResearchFamily): Promise<any[]> {
    await this.ensureGuards();
    return rows(this.client, `SELECT * FROM research_model_events ${modelFamily ? 'WHERE family=?' : ''}
      ORDER BY created_at,rowid`, modelFamily ? [family(modelFamily)] : []);
  }

  private async approvedBenchmark(tx: Executor, id: string | undefined, modelFamily: ResearchFamily, version: string): Promise<any> {
    const record = id
      ? await first(tx, 'SELECT * FROM research_benchmarks WHERE id=?', [id])
      : await first(tx, `SELECT * FROM research_benchmarks WHERE model_version=? AND family IN (?,'PAIR')
          ORDER BY created_at DESC,rowid DESC LIMIT 1`, [version, modelFamily]);
    if (!record || record.modelVersion !== version || ![modelFamily, 'PAIR'].includes(record.family)
      || record.validated !== 1 || !this.benchmarkPasses(record.report, modelFamily, version)) throw new Error('Independent validated benchmark required');
    return record;
  }

  async promoteModel(input: { family: ResearchFamily; version: string; benchmarkId?: string; reason: string }): Promise<any> {
    return this.changeChampion(input, 'PROMOTE');
  }

  async rollbackModel(input: { family: ResearchFamily; version: string; reason: string }): Promise<any> {
    return this.changeChampion(input, 'ROLLBACK');
  }

  private async changeChampion(input: { family: ResearchFamily; version: string; benchmarkId?: string; reason: string }, action: 'PROMOTE' | 'ROLLBACK'): Promise<any> {
    family(input.family);
    if (!input.reason?.trim()) throw new Error('Model transition reason required');
    return this.write(async (tx) => {
      const model = await first(tx, 'SELECT * FROM research_models WHERE family=? AND version=?', [input.family, input.version]);
      if (!model) throw new Error('Unknown model version');
      const previous = await first(tx, 'SELECT * FROM research_champions WHERE family=?', [input.family]);
      let benchmarkId = input.benchmarkId;
      if (action === 'ROLLBACK') {
        const promoted = await first(tx, `SELECT * FROM research_model_events WHERE family=? AND version=? AND action='PROMOTE'
          ORDER BY created_at DESC,rowid DESC LIMIT 1`, [input.family, input.version]);
        if (!promoted) throw new Error('Rollback requires a previously approved champion');
        benchmarkId = promoted.benchmarkId;
      }
      const benchmark = await this.approvedBenchmark(tx, benchmarkId, input.family, input.version);
      if (previous?.version === input.version) return { ...model, benchmarkId: previous.benchmarkId, previousVersion: previous.version, changed: false };
      if (action === 'PROMOTE' && previous && (benchmark.report.validation.comparisonReference !== 'incumbent'
        || benchmark.report.validation.referenceModelVersion !== previous.version)) throw new Error('Promotion must compare the current incumbent');
      const now = iso(this.clock());
      await tx.execute({ sql: `INSERT INTO research_champions(family,version,benchmark_id,updated_at) VALUES (?,?,?,?)
        ON CONFLICT(family) DO UPDATE SET version=excluded.version,benchmark_id=excluded.benchmark_id,updated_at=excluded.updated_at`,
      args: [input.family, input.version, benchmark.id, now] });
      await tx.execute({ sql: `INSERT INTO research_model_events(id,family,version,previous_version,action,benchmark_id,reason,created_at)
        VALUES (?,?,?,?,?,?,?,?)`, args: [randomUUID(), input.family, input.version, previous?.version ?? null, action, benchmark.id, input.reason, now] });
      return { ...model, benchmarkId: benchmark.id, previousVersion: previous?.version ?? null, changed: true };
    });
  }

  async listMarkets(options: { family?: ResearchFamily; modelVersion?: string } = {}): Promise<any[]> {
    await this.ensureGuards();
    const filters = []; const args = [];
    if (options.family) { filters.push('family=?'); args.push(options.family); }
    if (options.modelVersion) { filters.push('model_version=?'); args.push(options.modelVersion); }
    return rows(this.client, `SELECT * FROM research_markets ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ORDER BY family,model_version,market`, args);
  }

  async setMarketState(input: { family: ResearchFamily; modelVersion: string; market: string; state: ResearchMarketState; evidence?: any; reason?: string }): Promise<any> {
    family(input.family);
    if (!input.market?.trim() || !['EXPERIMENTAL', 'SHADOW', 'ACTIVE', 'SUSPENDED'].includes(input.state)) throw new Error('Invalid market transition');
    return this.write(async (tx) => {
      const evidence = input.evidence ?? {};
      let storedEvidence = evidence;
      if (input.state === 'SHADOW' || input.state === 'ACTIVE') {
        const benchmark = typeof evidence.benchmarkId === 'string'
          ? await first(tx, 'SELECT * FROM research_benchmarks WHERE id=?', [evidence.benchmarkId]) : null;
        const evaluated = benchmark?.report?.marketValidation?.[input.market];
        const configuration = evaluated?.probabilityConfiguration;
        const configurationHash = evaluated?.approvedProbabilityConfigurationHash;
        if (!benchmark || ![input.family, 'PAIR'].includes(benchmark.family) || benchmark.modelVersion !== input.modelVersion
          || !this.independentEvidence(benchmark.report) || evaluated?.family !== input.family || evaluated?.modelVersion !== input.modelVersion
          || evaluated?.rule !== 'research-market-eligibility-v1' || evaluated.independentEvaluationPassed !== true
          || evaluated.dataCoverage !== true || evaluated.quoteCoverage !== true || evaluated.settlementVerified !== true
          || !(evaluated.probabilisticSamples >= 200) || !(evaluated.leagueCount >= 4) || !(evaluated.periodCount >= 4)
          || evaluated.calibrationPassed !== true
          || !configuration || typeof configuration !== 'object' || Array.isArray(configuration)
          || configuration.family !== input.family || configuration.version !== 'probability-configuration-v1'
          || configuration.probabilityProtocol !== 'joint-goal-coherent-v2'
          || typeof configurationHash !== 'string' || !/^[a-f0-9]{64}$/.test(configurationHash)
          || researchHash(configuration) !== configurationHash
          || benchmark.report.validation?.probabilityConfigurationHash !== configurationHash) throw new Error('Persisted independent market validation evidence required');
        storedEvidence = { benchmarkId: benchmark.id, ...evaluated };
      }
      if (input.state === 'ACTIVE') {
        if (!(storedEvidence.prospectiveSamples >= 200) || storedEvidence.prospectivePassed !== true) throw new Error('Prospective market validation required');
        const modelBenchmark = await this.approvedBenchmark(tx, evidence.modelBenchmarkId ?? evidence.benchmarkId, input.family, input.modelVersion);
        const champion = await first(tx, 'SELECT * FROM research_champions WHERE family=? AND version=?', [input.family, input.modelVersion]);
        if (!champion || champion.benchmarkId !== modelBenchmark.id) throw new Error('Active market requires the current approved champion');
        storedEvidence = { ...storedEvidence, modelBenchmarkId: modelBenchmark.id };
      }
      const previous = await first(tx, 'SELECT * FROM research_markets WHERE family=? AND model_version=? AND market=?',
        [input.family, input.modelVersion, input.market]);
      const now = iso(this.clock());
      await tx.execute({ sql: `INSERT INTO research_markets(family,model_version,market,state,evidence_json,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(family,model_version,market) DO UPDATE SET state=excluded.state,evidence_json=excluded.evidence_json,updated_at=excluded.updated_at`,
      args: [input.family, input.modelVersion, input.market, input.state, researchJson(storedEvidence), now] });
      await tx.execute({ sql: `INSERT INTO research_market_events(id,family,model_version,market,previous_state,state,evidence_json,reason,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, args: [randomUUID(), input.family, input.modelVersion, input.market, previous?.state ?? null,
        input.state, researchJson(storedEvidence), input.reason ?? '', now] });
      return { ...input, previousState: previous?.state ?? null };
    });
  }

  async syncJobs(fixtures: Array<{ matchId: string; kickoffAt: string; score?: number; status?: 'upcoming' | 'postponed' | 'cancelled' | 'started' | 'finished' | 'unknown' }>): Promise<any[]> {
    await this.write(async (tx) => {
      for (const fixture of fixtures) {
        if (!fixture.matchId?.trim()) throw new Error('Fixture identity required');
        const kickoff = iso(fixture.kickoffAt); const target = iso(Date.parse(kickoff) - 15 * 60_000); const now = iso(this.clock());
        const existing = await first(tx, 'SELECT * FROM research_jobs WHERE match_id=?', [fixture.matchId]);
        const blocked = fixture.status && fixture.status !== 'upcoming';
        if (!existing) {
          await tx.execute({ sql: `INSERT INTO research_jobs(id,match_id,kickoff_at,target_at,score,status,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?)`, args: [randomUUID(), fixture.matchId, kickoff, target, Number(fixture.score) || 0, blocked ? 'CANCELLED' : 'PENDING', now, now] });
        } else if (blocked) {
          if (!await first(tx, 'SELECT id FROM research_inputs WHERE job_id=?', [existing.id])) {
            await tx.execute({ sql: `UPDATE research_jobs SET status='CANCELLED',lease_token=NULL,lease_expires_at=NULL,reason=?,updated_at=? WHERE id=?`,
              args: [`fixture_${fixture.status}`, now, existing.id] });
          }
        } else if (existing.kickoffAt !== kickoff) {
          const evidence = await first(tx, 'SELECT id FROM research_inputs WHERE job_id=?', [existing.id]);
          const bet = await first(tx, 'SELECT id FROM research_bets WHERE match_id=? LIMIT 1', [fixture.matchId]);
          const missed = Date.parse(now) > Date.parse(target) + TOLERANCE_MS || Date.parse(now) >= Date.parse(kickoff);
          if (!bet && !evidence) await tx.execute({ sql: `UPDATE research_jobs SET kickoff_at=?,target_at=?,score=?,status=?,
            lease_token=NULL,lease_expires_at=NULL,reason=?,updated_at=? WHERE id=?`,
          args: [kickoff, target, Number(fixture.score) || 0, missed ? 'MISSED' : 'PENDING',
            missed ? 'kickoff_changed_window_missed' : 'kickoff_changed', now, existing.id] });
        } else if (existing.status === 'CANCELLED' && fixture.status === 'upcoming') {
          const missed = Date.parse(now) > Date.parse(target) + TOLERANCE_MS;
          await tx.execute({ sql: 'UPDATE research_jobs SET status=?,reason=?,updated_at=? WHERE id=?',
            args: [missed ? 'MISSED' : 'PENDING', missed ? 'resumed_window_missed' : 'fixture_resumed', now, existing.id] });
        } else if (existing.status === 'PENDING') {
          await tx.execute({ sql: 'UPDATE research_jobs SET score=?,updated_at=? WHERE id=?', args: [Number(fixture.score) || 0, now, existing.id] });
        }
      }
    });
    return this.listJobs();
  }

  async listJobs(): Promise<any[]> {
    await this.ensureGuards();
    return rows(this.client, 'SELECT * FROM research_jobs ORDER BY target_at,score DESC,match_id');
  }

  async claimDueJobs(now: string | Date, leaseMs = 30_000): Promise<any[]> {
    iso(now);
    return this.write(async (tx) => {
      // The process clock is authoritative. A caller cannot move a job into its window.
      const timestamp = iso(this.clock());
      const due = await rows(tx, `SELECT * FROM research_jobs WHERE target_at<=?
        AND (status='PENDING' OR (status='CLAIMED' AND lease_expires_at<=?)) ORDER BY target_at,score DESC,match_id`, [timestamp, timestamp]);
      const claimed = [];
      for (const job of due) {
        const missed = Date.parse(timestamp) > Date.parse(job.targetAt) + TOLERANCE_MS || Date.parse(timestamp) >= Date.parse(job.kickoffAt);
        const token = randomUUID();
        // A crashed worker must release its cohort while the 60-second admission window is still open.
        const expires = iso(Math.min(Date.parse(timestamp) + Math.max(1000, Math.min(leaseMs, 30_000)),
          Date.parse(job.targetAt) + TOLERANCE_MS + 1));
        await tx.execute({ sql: `UPDATE research_jobs SET status=?,lease_token=?,lease_expires_at=?,reason=?,updated_at=? WHERE id=?`,
          args: [missed ? 'MISSED' : 'CLAIMED', token, expires, missed ? 't15_window_missed' : null, timestamp, job.id] });
        claimed.push({ ...job, status: missed ? 'MISSED' : 'CLAIMED', leaseToken: token, leaseExpiresAt: expires });
      }
      return claimed;
    });
  }

  async finishJob(jobId: string, leaseToken: string, outcome: { status?: string; reason?: string } = {}): Promise<any> {
    return this.write(async (tx) => {
      const job = await first(tx, 'SELECT * FROM research_jobs WHERE id=?', [jobId]);
      if (!job || job.leaseToken !== leaseToken) throw new Error('Research job lease lost');
      if (job.status === 'COMPLETED' || job.status === 'MISSED') return job;
      let status = outcome.status ?? 'COMPLETED';
      if (status === 'RETRY') status = this.inWindow(job, this.clock().getTime()) ? 'PENDING' : 'MISSED';
      if (!['COMPLETED', 'MISSED', 'SKIPPED', 'ERROR'].includes(status) && status !== 'PENDING') throw new Error('Invalid research job status');
      await tx.execute({ sql: 'UPDATE research_jobs SET status=?,reason=?,updated_at=? WHERE id=? AND lease_token=?',
        args: [status, outcome.reason ?? null, iso(this.clock()), jobId, leaseToken] });
      return { ...job, status, reason: outcome.reason ?? null };
    });
  }

  /** A healthy worker can finish slow preparation inside the original 60s window. */
  async renewJobLeases(jobs: Array<{ id: string; leaseToken: string }>): Promise<void> {
    if (!jobs.length) return;
    await this.write(async (tx) => {
      const now = iso(this.clock());
      for (const { id, leaseToken } of jobs) {
        const job = await first(tx, 'SELECT * FROM research_jobs WHERE id=?', [id]);
        if (job?.status !== 'CLAIMED' || job.leaseToken !== leaseToken
          || now >= job.leaseExpiresAt || !this.inWindow(job, Date.parse(now))) continue;
        const expires = iso(Math.min(Date.parse(now) + 30_000, Date.parse(job.targetAt) + TOLERANCE_MS + 1));
        await tx.execute({ sql: 'UPDATE research_jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND lease_token=?',
          args: [expires, now, id, leaseToken] });
      }
    });
  }

  private inWindow(job: any, now: number): boolean {
    return now >= Date.parse(job.targetAt) && now <= Date.parse(job.targetAt) + TOLERANCE_MS && now < Date.parse(job.kickoffAt);
  }

  private assertCommitWindow(job: any, token: string, now: number): void {
    if (job?.status !== 'CLAIMED' || job.leaseToken !== token || now >= Date.parse(job.leaseExpiresAt)) throw new Error('Research job lease lost');
    if (!this.inWindow(job, now)) throw new Error('Research T15 commit window closed');
  }

  async commitDecisions(input: ResearchCommit): Promise<any> {
    const result = await this.commitBatch([input], input.now ?? this.clock());
    return { ...result, job: result.jobs[0] ?? null };
  }

  async commitBatch(preparedJobs: ResearchCommit[], now: string | Date = this.clock(), _allocationOrder?: any): Promise<any> {
    if (!preparedJobs.length) return { decisions: [], bets: [], jobs: [] };
    iso(now);
    const at = () => this.clock().getTime();
    const guardedJobs: Array<{ job: any; token: string }> = [];
    return this.write(async (tx) => {
      const committedDecisions: any[] = []; const bets: any[] = []; const completedJobs: any[] = [];
      const plans: Array<{ input: ResearchCommit; job: any; inputId: string; decision: ResearchDecision }> = [];
      const hasFixtures = await first(tx, "SELECT name FROM sqlite_master WHERE type='table' AND name='matches'");
      for (const input of preparedJobs) {
        const job = await first(tx, 'SELECT * FROM research_jobs WHERE id=?', [input.jobId]);
        if (!job) throw new Error('Research job not found');
        if (job.status === 'COMPLETED') {
          const storedInput = await first(tx, 'SELECT * FROM research_inputs WHERE job_id=?', [job.id]);
          if (!storedInput || storedInput.inputHash !== researchHash(input.inputSnapshot)) throw new Error('Completed job input is immutable');
          committedDecisions.push(...await rows(tx, 'SELECT * FROM research_decisions WHERE job_id=?', [job.id]));
          bets.push(...await rows(tx, 'SELECT * FROM research_bets WHERE match_id=?', [job.matchId]));
          completedJobs.push(job);
          continue;
        }
        this.assertCommitWindow(job, input.leaseToken, at());
        // Nightly may change the official fixture after model preparation. This
        // read shares the write transaction, so that update cannot race admission.
        if (hasFixtures) {
          const fixture = await first(tx, 'SELECT date,home_goals,away_goals FROM matches WHERE match_id=?', [job.matchId]);
          if (!fixture || Date.parse(fixture.date) !== Date.parse(job.kickoffAt)
            || fixture.homeGoals != null || fixture.awayGoals != null) throw new Error('Research fixture changed before commit');
        }
        const observedAt = Date.parse(iso(input.inputSnapshot?.observedAt));
        if (observedAt > at() || observedAt >= Date.parse(job.kickoffAt)) throw new Error('Shared input must be observed before decision and kickoff');
        if (!Array.isArray(input.inputSnapshot.quotes)) throw new Error('Shared quote snapshot required');
        if (guardedJobs.some((entry) => entry.job.id === job.id)) throw new Error('Duplicate research job in batch');
        const identities = input.decisions.map((decision) => `${decision.family}:${decision.portfolioId ?? `shadow_${decision.family}`}`);
        if (new Set(identities).size !== identities.length) throw new Error('One decision per family and portfolio required');
        const shadowFamilies = new Set(input.decisions.filter((decision) => !decision.portfolioId || decision.portfolioId.startsWith('shadow_')).map((decision) => decision.family));
        if (!shadowFamilies.has('A') || !shadowFamilies.has('C')) throw new Error('Fair shared input requires both A and C decisions');
        guardedJobs.push({ job, token: input.leaseToken });
        const inputId = randomUUID();
        await tx.execute({ sql: `INSERT INTO research_inputs(id,job_id,input_hash,snapshot_json,captured_at,kickoff_at) VALUES (?,?,?,?,?,?)`,
          args: [inputId, job.id, researchHash(input.inputSnapshot), researchJson(input.inputSnapshot), iso(at()), job.kickoffAt] });
        for (const decision of input.decisions) plans.push({ input, job, inputId, decision });
      }
      // All candidates are prepared first. This order determines allocation for simultaneous targets.
      plans.sort((a, b) => a.job.targetAt.localeCompare(b.job.targetAt)
        || Number(b.decision.score ?? b.job.score ?? 0) - Number(a.decision.score ?? a.job.score ?? 0)
        || a.job.matchId.localeCompare(b.job.matchId) || a.decision.family.localeCompare(b.decision.family));
      for (const plan of plans) {
        const decision = plan.decision; family(decision.family);
        const portfolioId = decision.portfolioId ?? `shadow_${decision.family}`;
        if (portfolioId !== 'main' && portfolioId !== `shadow_${decision.family}`) throw new Error('Research portfolio family mismatch');
        const portfolio = await first(tx, `${this.portfolioSql} WHERE p.id=? GROUP BY p.id`, [portfolioId]);
        if (!portfolio) throw new Error('Research portfolio is not initialized');
        const model = await first(tx, 'SELECT * FROM research_models WHERE family=? AND version=?', [decision.family, decision.modelVersion]);
        const market = await first(tx, 'SELECT * FROM research_markets WHERE family=? AND model_version=? AND market=?',
          [decision.family, decision.modelVersion, decision.market ?? '']);
        let reason = decision.reason ?? null;
        const abstain = (message: string) => { reason ??= message; };
        if (decision.action === 'ABSTAIN') abstain('model_abstained');
        if (!model) abstain('model_not_registered');
        if (!market || !['SHADOW', 'ACTIVE'].includes(market.state)) abstain('market_not_validated');
        const configuration = decision.probabilityConfiguration;
        if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
          || configuration.family !== decision.family || configuration.version !== 'probability-configuration-v1'
          || configuration.probabilityProtocol !== 'joint-goal-coherent-v2'
          || !/^[a-f0-9]{64}$/.test(decision.probabilityConfigurationHash ?? '')
          || researchHash(configuration) !== decision.probabilityConfigurationHash
          || decision.probabilityConfigurationHash !== market?.evidence?.approvedProbabilityConfigurationHash) {
          abstain('probability_configuration_not_validated');
        }
        if (portfolioId === 'main') {
          const champion = await first(tx, 'SELECT * FROM research_champions WHERE family=? AND version=?', [decision.family, decision.modelVersion]);
          if (!champion || market?.state !== 'ACTIVE') abstain('main_requires_active_champion');
        }
        const quote = decision.quote;
        const odds = Number(quote?.odds);
        const quoteTime = (value: unknown) => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
          ? Date.parse(value) : Number.NaN;
        const captured = quoteTime(quote?.capturedAt ?? quote?.captured_at);
        const updated = quoteTime(quote?.updatedAt);
        const validTime = (time: number) => Number.isFinite(time) && time <= at() && at() - time <= QUOTE_MAX_AGE_MS && time < Date.parse(plan.job.kickoffAt);
        if (!quote || !Number.isFinite(odds) || odds <= 1 || !String(quote.bookmaker ?? quote.bookmakerName ?? '').trim()
          || quote.source !== 'odds_api' || quote.usedSyntheticOdds === true
          || !validTime(captured) || !validTime(updated)) abstain('real_fresh_quote_required');
        if (quote && !plan.input.inputSnapshot.quotes.some((shared: unknown) => researchHash(shared) === researchHash(quote))) abstain('quote_not_in_shared_snapshot');
        const probability = Number(decision.probability);
        if (!Number.isFinite(probability) || probability <= 0 || probability >= 1
          || !Number.isFinite(Number(decision.ev)) || Number(decision.ev) < .04
          || !Number.isFinite(Number(decision.prudentialEv)) || Number(decision.prudentialEv) < .01) abstain('prudential_value_threshold_required');
        if (!decision.selection?.trim()) abstain('selection_required');
        const stakeCents = Math.floor(Number(portfolio.equityCents) * .01);
        if (stakeCents <= 0 || stakeCents > Number(portfolio.availableCents)) abstain('insufficient_virtual_capital');
        if (Number(portfolio.committedCents) + stakeCents > Math.floor(Number(portfolio.equityCents) * .05)) abstain('virtual_exposure_limit');
        const duplicate = await first(tx, 'SELECT id FROM research_bets WHERE portfolio_id=? AND match_id=?', [portfolioId, plan.job.matchId]);
        if (duplicate) abstain('one_bet_per_portfolio_match');
        const id = randomUUID(); const createdAt = iso(at()); const action = reason ? 'ABSTAIN' : 'BET';
        const evidence = { ...decision, quote: quote ?? null, inputId: plan.inputId, inputHash: researchHash(plan.input.inputSnapshot), stakeCents: action === 'BET' ? stakeCents : 0 };
        await tx.execute({ sql: `INSERT INTO research_decisions(id,job_id,input_id,family,model_version,market,selection,portfolio_id,action,reason,snapshot_json,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [id, plan.job.id, plan.inputId, decision.family, decision.modelVersion, decision.market ?? '',
          decision.selection ?? null, portfolioId, action, reason, researchJson(evidence), createdAt] });
        committedDecisions.push({ id, ...evidence, action, reason, portfolioId, createdAt });
        if (action === 'BET') {
          const betId = randomUUID();
          await tx.execute({ sql: `INSERT INTO research_bets(id,decision_id,portfolio_id,match_id,family,model_version,market,selection,odds,stake_cents,snapshot_json,placed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, args: [betId, id, portfolioId, plan.job.matchId, decision.family, decision.modelVersion,
            decision.market, decision.selection, odds, stakeCents, researchJson(evidence), createdAt] });
          await tx.execute({ sql: `INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at)
            VALUES (?,?,?,'STAKE',?,?,?)`, args: [`stake:${betId}`, portfolioId, betId, -stakeCents, stakeCents, createdAt] });
          bets.push({ id: betId, decisionId: id, portfolioId, matchId: plan.job.matchId, family: decision.family,
            modelVersion: decision.modelVersion, market: decision.market, selection: decision.selection, odds, stakeCents, snapshot: evidence, placedAt: createdAt, status: 'PENDING' });
        }
      }
      for (const { job, token } of guardedJobs) {
        this.assertCommitWindow(job, token, at());
        await tx.execute({ sql: `UPDATE research_jobs SET status='COMPLETED',updated_at=? WHERE id=? AND lease_token=?`, args: [iso(at()), job.id, token] });
        completedJobs.push({ ...job, status: 'COMPLETED' });
      }
      return { decisions: committedDecisions, bets, jobs: completedJobs };
    }, () => { for (const { job, token } of guardedJobs) this.assertCommitWindow(job, token, at()); });
  }

  async settleBet(id: string, multiplier: number, evidence: any): Promise<any> {
    return this.write(async (tx) => {
      const bet = await first(tx, 'SELECT * FROM research_bets WHERE id=?', [id]);
      if (!bet) throw new Error('Research bet not found');
      const existing = await first(tx, 'SELECT * FROM research_settlements WHERE bet_id=?', [id]);
      if (existing) {
        if (existing.multiplier !== multiplier || researchHash(existing.evidence) !== researchHash(evidence)) throw new Error('Settlement evidence is immutable');
        return { ...existing, settled: false };
      }
      const allowed = [0, .5, 1, (Number(bet.odds) + 1) / 2, Number(bet.odds)];
      if (!Number.isFinite(multiplier) || !allowed.some((value) => Math.abs(value - multiplier) < 1e-9)) throw new Error('Unsupported settlement multiplier');
      if (!evidence || typeof evidence !== 'object' || Object.keys(evidence).length === 0) throw new Error('Settlement evidence required');
      const returnCents = Math.round(Number(bet.stakeCents) * multiplier); const settledAt = iso(this.clock());
      await tx.execute({ sql: `INSERT INTO research_settlements(bet_id,multiplier,return_cents,evidence_json,settled_at) VALUES (?,?,?,?,?)`,
        args: [id, multiplier, returnCents, researchJson(evidence), settledAt] });
      await tx.execute({ sql: `INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at)
        VALUES (?,?,?,'SETTLE',?,?,?)`, args: [`settle:${id}`, bet.portfolioId, id, returnCents, -Number(bet.stakeCents), settledAt] });
      return { betId: id, multiplier, returnCents, profitCents: returnCents - Number(bet.stakeCents), evidence, settledAt, settled: true };
    });
  }
}
