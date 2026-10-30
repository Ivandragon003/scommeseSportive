import type { Client, Transaction } from '@libsql/client';
import { createHash, randomUUID } from 'node:crypto';
import { settleGoalQuote } from './GoalSettlement';
import { prospectiveBucket, prospectivePartition, FrozenProspectiveObservation, buildFrozenProspectiveObservations } from './ResearchProspectiveEvidence';
import { ORIGINAL_HOLDOUT_POLICY } from './ResearchHoldoutPolicy';

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
  observations?: FrozenProspectiveObservation[];
};
export type NightlyBatchClaim = {
  startedAt: string; windowEndAt: string; fixtures: Array<{ matchId: string; kickoffAt: string }>;
  runId?: string; leaseMs?: number; quoteMaxAgeMs?: number; minEv?: number; minPrudentialEv?: number;
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
  private nightlySchema: boolean | undefined;
  private prospectiveSchema: boolean | undefined;
  private executionDecisionColumn: boolean | undefined;

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
          this.nightlySchema = Boolean(await first(this.client,
            "SELECT name FROM sqlite_master WHERE type='table' AND name='research_nightly_jobs'"));
          this.prospectiveSchema = Boolean(await first(this.client,
            "SELECT name FROM sqlite_master WHERE type='table' AND name='research_prospective_observations'"));
          if (this.prospectiveSchema) {
            const guards = ['research_prospective_observations', 'research_prospective_results', 'research_prospective_invalidations'].flatMap((table) =>
              ['UPDATE', 'DELETE'].map((operation) => `CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
                BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT, 'prospective evidence is immutable'); END;`));
            await this.client.executeMultiple(guards.join('\n'));
          }
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

  /** Share one financial write queue with additive virtual-execution policies. */
  async runResearchTransaction<T>(work: (tx: Transaction) => Promise<T>, beforeCommit?: () => void): Promise<T> {
    return this.write(work, beforeCommit);
  }

  private async hasExecutionDecisionColumn(refreshMissing = false): Promise<boolean> {
    await this.ready();
    if (this.executionDecisionColumn === undefined || refreshMissing && !this.executionDecisionColumn) {
      const columns = await rows(this.client, 'PRAGMA table_info(research_bets)');
      this.executionDecisionColumn = columns.some((column) => column.name === 'execution_decision_id');
    }
    return this.executionDecisionColumn;
  }

  /** Refresh a previously missing additive column after migration in the same process. */
  async refreshExecutionSchema(): Promise<boolean> { return this.hasExecutionDecisionColumn(true); }

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
    const executionIdentity = await this.hasExecutionDecisionColumn(true) ? 'COALESCE(b.execution_decision_id,b.decision_id)' : 'b.decision_id';
    return rows(this.client, `SELECT b.*,b.decision_id AS origin_decision_id,${executionIdentity} AS effective_execution_decision_id,
      s.multiplier,s.return_cents,s.settled_at,s.evidence_json,
      CASE WHEN s.bet_id IS NULL THEN 'PENDING' ELSE 'SETTLED' END AS status,
      CASE WHEN s.bet_id IS NULL THEN NULL ELSE s.return_cents-b.stake_cents END AS profit_cents
      FROM research_bets b LEFT JOIN research_settlements s ON s.bet_id=b.id
      ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY b.placed_at,b.match_id,b.portfolio_id`, args);
  }

  /** Complete accounting rows with a compact evidence projection, never truncated by a row limit. */
  async listBetViews(options: { portfolioId?: string; status?: string; from?: string; until?: string } = {}): Promise<any[]> {
    await this.ready(); const hasExecution = await this.hasExecutionDecisionColumn(true);
    const filters: string[] = [], args: any[] = [];
    if (options.portfolioId) { filters.push('b.portfolio_id=?'); args.push(options.portfolioId); }
    if (options.status === 'PENDING') filters.push('s.bet_id IS NULL');
    else if (options.status === 'SETTLED') filters.push('s.bet_id IS NOT NULL');
    if (options.from) { filters.push('julianday(b.placed_at)>=julianday(?)'); args.push(iso(options.from)); }
    if (options.until) { filters.push('julianday(b.placed_at)<julianday(?)'); args.push(iso(options.until)); }
    const fields = ['quote','matchId','competition','league','matchLabel','homeTeamName','awayTeamName','kickoffAt','forecastAt','probability','ev','confidence',
      'stakeCents','stakePercent','suggestedStakePercent','stakeMode','decisionMode','experimental','policyHash','policyVersion','reason','originDecisionId','effectiveExecutionDecisionId'];
    const snapshot = fields.flatMap((key) => [`'${key}'`, `json_extract(b.snapshot_json,'$.${key}')`]).join(',');
    const result = await rows(this.client, `SELECT b.id,b.decision_id,b.decision_id AS origin_decision_id,
      ${hasExecution ? 'b.execution_decision_id' : 'NULL'} AS execution_decision_id,
      ${hasExecution ? 'COALESCE(b.execution_decision_id,b.decision_id)' : 'b.decision_id'} AS effective_execution_decision_id,
      b.portfolio_id,b.match_id,b.family,b.model_version,b.market,b.selection,b.odds,b.stake_cents,b.placed_at,
      json_object(${snapshot}) AS snapshot_json,s.multiplier,s.return_cents,s.settled_at,
      CASE WHEN s.bet_id IS NULL THEN 'PENDING' ELSE 'SETTLED' END AS status,
      CASE WHEN s.bet_id IS NULL THEN NULL ELSE s.return_cents-b.stake_cents END AS profit_cents
      FROM research_bets b LEFT JOIN research_settlements s ON s.bet_id=b.id
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY b.placed_at,b.match_id,b.portfolio_id`, args);
    return result.map((row) => { delete row.snapshotJson; return row; });
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

  /** Compact historical provenance for effective-policy views, including before migration 023. */
  async listLegacyDecisionViews(options: { matchId?: string; family?: ResearchFamily; limit?: number; includeProbabilityStages?: boolean } = {}): Promise<any[]> {
    await this.ready();
    const limit = options.limit ?? 200;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Invalid research decision read limit');
    const hasExecution = await this.hasExecutionDecisionColumn(true), filters: string[] = [], args: any[] = [];
    if (options.matchId) { filters.push('j.match_id=?'); args.push(options.matchId); }
    if (options.family) { filters.push('d.family=?'); args.push(options.family); }
    const fields = ['probability', 'ev', 'prudentialEv', 'confidence', 'stakeCents', 'inputHash', 'quote', 'decisionMode', 'experimental',
      'matchId', 'competition', 'league', 'matchLabel', 'homeTeamName', 'awayTeamName', 'kickoffAt',
      'probabilityConfigurationHash', 'forecastAt'];
    if (options.includeProbabilityStages) fields.push('probabilityStages');
    const snapshot = fields.flatMap((key) => [`'${key}'`, `json_extract(d.snapshot_json,'$.${key}')`]).join(',');
    const result = await rows(this.client, `SELECT d.id,d.job_id,d.input_id,d.family,d.model_version,d.market,d.selection,d.portfolio_id,d.action,d.reason,d.created_at,
      j.match_id,j.kickoff_at,json_object(${snapshot}) AS snapshot_json,b.id AS bet_id,b.stake_cents AS bet_stake_cents,b.placed_at AS bet_placed_at,
      CASE WHEN b.id IS NULL THEN NULL WHEN s.bet_id IS NULL THEN 'PENDING' ELSE 'SETTLED' END AS bet_status,
      xb.id AS existing_bet_id,${hasExecution ? 'xb.execution_decision_id' : 'NULL'} AS existing_bet_execution_decision_id,
      xb.decision_id AS existing_bet_origin_decision_id
      FROM research_decisions d JOIN research_jobs j ON j.id=d.job_id
      LEFT JOIN research_bets b ON b.decision_id=d.id${hasExecution ? ' AND b.execution_decision_id IS NULL' : ''}
      LEFT JOIN research_settlements s ON s.bet_id=b.id LEFT JOIN research_bets xb ON xb.match_id=j.match_id AND xb.portfolio_id=d.portfolio_id
      ${filters.length ? 'WHERE ' + filters.join(' AND ') : ''} ORDER BY julianday(d.created_at) DESC,d.id DESC LIMIT ?`, [...args, limit]);
    return result.map((row) => { delete row.snapshotJson; return row; });
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

  /** Load one explicitly selected artifact without reading every historical candidate. */
  async getModelByVersion(modelFamily: ResearchFamily, version: string): Promise<any> {
    await this.ensureGuards();
    return first(this.client, `SELECT m.*,CASE WHEN c.version=m.version THEN 1 ELSE 0 END AS is_champion
      FROM research_models m LEFT JOIN research_champions c ON c.family=m.family
      WHERE m.family=? AND m.version=?`, [family(modelFamily), version]);
  }

  /** Dashboard metadata excludes immutable trees and calibration samples. */
  async getOverviewModels(): Promise<any[]> {
    await this.ensureGuards();
    const models = await rows(this.client, `SELECT m.family,m.version,m.created_at,
      CASE WHEN c.version=m.version THEN 1 ELSE 0 END AS is_champion,
      CASE WHEN json_valid(m.artifact_json) THEN m.artifact_json -> '$.trainedThrough' ELSE m.artifact_json END AS trained_through_json,
      CASE WHEN json_valid(m.artifact_json) THEN m.artifact_json -> '$.metrics' ELSE m.artifact_json END AS metrics_json
      FROM research_models m LEFT JOIN research_champions c ON c.family=m.family
      ORDER BY m.created_at,m.version`);
    // JSON text extraction preserves missing keys, explicit null, booleans and scalars.
    // Invalid documents still reach rowObject's JSON.parse and fail like full reads.
    return models.map((model) => ({ ...model, artifact: { trainedThrough: model.trainedThrough, metrics: model.metrics } }));
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

  /** Latest validation selection matches listBenchmarks({ limit: 1 }) exactly. */
  async getLatestValidationSummary(): Promise<any> {
    await this.ensureGuards();
    const record = await first(this.client, `SELECT model_version,created_at,
      CASE WHEN json_valid(report_json) THEN report_json -> '$.warnings' ELSE report_json END AS warnings_json
      FROM research_benchmarks ORDER BY created_at DESC,rowid DESC LIMIT 1`);
    return record ? { ...record, report: { warnings: record.warnings } } : null;
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
        // Retired T15 synchronization must never rewrite a nightly allocation.
        if (existing && this.nightlySchema && await first(tx, 'SELECT job_id FROM research_nightly_jobs WHERE job_id=?', [existing.id])) continue;
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
    if (this.nightlySchema) return rows(this.client, `SELECT j.*,CASE WHEN n.job_id IS NULL THEN 'T15' ELSE 'NIGHTLY' END AS mode,
      n.run_id,n.window_start_at,n.window_end_at FROM research_jobs j LEFT JOIN research_nightly_jobs n ON n.job_id=j.id
      ORDER BY j.target_at,j.score DESC,j.match_id`);
    return rows(this.client, 'SELECT * FROM research_jobs ORDER BY target_at,score DESC,match_id');
  }

  /** A single persistent lease covers the whole nightly allocation, including retries. */
  async claimNightlyBatch(input: NightlyBatchClaim): Promise<any> {
    await this.ensureGuards();
    if (!this.nightlySchema) throw new Error('Research nightly migration 020 is required');
    const startedAt = iso(input.startedAt); const windowEndAt = iso(input.windowEndAt);
    if (Date.parse(startedAt) > this.clock().getTime() || Date.parse(windowEndAt) <= Date.parse(startedAt)) {
      throw new Error('Invalid nightly decision window');
    }
    const runId = input.runId ?? `nightly:${windowEndAt}`;
    const quoteMaxAgeMs = input.quoteMaxAgeMs ?? QUOTE_MAX_AGE_MS;
    const minEv = input.minEv ?? .04; const minPrudentialEv = input.minPrudentialEv ?? .01;
    if (!runId.trim() || !Number.isSafeInteger(quoteMaxAgeMs) || quoteMaxAgeMs < 1
      || !Number.isFinite(minEv) || minEv < 0 || !Number.isFinite(minPrudentialEv) || minPrudentialEv < 0) {
      throw new Error('Invalid nightly admission policy');
    }
    return this.write(async (tx) => {
      const timestamp = iso(this.clock());
      const existing = await first(tx, 'SELECT * FROM research_nightly_runs WHERE id=?', [runId]);
      if (existing && (existing.windowEndAt !== windowEndAt || existing.quoteMaxAgeMs !== quoteMaxAgeMs
        || existing.minEv !== minEv || existing.minPrudentialEv !== minPrudentialEv)) throw new Error('Nightly run policy is immutable');
      if (existing?.status === 'COMPLETED') return { run: existing, jobs: [], skipped: [], busy: false, alreadyCompleted: true };
      const active = await first(tx, "SELECT * FROM research_nightly_runs WHERE status='RUNNING' AND lease_expires_at>? LIMIT 1", [timestamp]);
      if (active) return { run: active, jobs: [], skipped: [], busy: true, alreadyCompleted: false };
      if (Date.parse(windowEndAt) <= Date.parse(timestamp)) throw new Error('Nightly decision window closed');
      const token = randomUUID(); const expires = this.nightlyLeaseExpiry(timestamp, windowEndAt, input.leaseMs);
      const effectiveStart = existing?.startedAt ?? startedAt;
      if (existing) await tx.execute({ sql: `UPDATE research_nightly_runs SET status='RUNNING',lease_token=?,lease_expires_at=?,
        ended_at=NULL,updated_at=? WHERE id=?`, args: [token, expires, timestamp, runId] });
      else await tx.execute({ sql: `INSERT INTO research_nightly_runs
        (id,started_at,window_end_at,status,lease_token,lease_expires_at,quote_max_age_ms,min_ev,min_prudential_ev,updated_at)
        VALUES (?,?,?,'RUNNING',?,?,?,?,?,?)`, args: [runId, effectiveStart, windowEndAt, token, expires, quoteMaxAgeMs, minEv, minPrudentialEv, timestamp] });
      const claimed: any[] = []; const skipped: any[] = [];
      const seen = new Set<string>();
      for (const fixture of input.fixtures) {
        if (!fixture.matchId?.trim() || seen.has(fixture.matchId)) throw new Error('Unique nightly fixture identity required');
        seen.add(fixture.matchId);
        const kickoff = iso(fixture.kickoffAt);
        if (kickoff < effectiveStart || kickoff > windowEndAt || kickoff <= timestamp) {
          skipped.push({ matchId: fixture.matchId, reason: kickoff <= timestamp ? 'match_started' : 'outside_nightly_window' });
          continue;
        }
        let job = await first(tx, 'SELECT * FROM research_jobs WHERE match_id=?', [fixture.matchId]);
        if (job && await first(tx, 'SELECT id FROM research_inputs WHERE job_id=?', [job.id])) {
          skipped.push({ matchId: fixture.matchId, reason: 'decision_already_recorded' });
          continue;
        }
        if (await first(tx, 'SELECT id FROM research_bets WHERE match_id=? LIMIT 1', [fixture.matchId])) {
          skipped.push({ matchId: fixture.matchId, reason: 'bet_already_recorded' });
          continue;
        }
        if (job?.status === 'CLAIMED' && job.leaseExpiresAt > timestamp) {
          skipped.push({ matchId: fixture.matchId, reason: 'fixture_lease_active' });
          continue;
        }
        const jobId = job?.id ?? randomUUID();
        const jobExpires = expires < kickoff ? expires : kickoff;
        if (job) await tx.execute({ sql: `UPDATE research_jobs SET kickoff_at=?,target_at=?,status='CLAIMED',
          lease_token=?,lease_expires_at=?,reason=NULL,updated_at=? WHERE id=?`,
        args: [kickoff, effectiveStart, token, jobExpires, timestamp, jobId] });
        else await tx.execute({ sql: `INSERT INTO research_jobs
          (id,match_id,kickoff_at,target_at,status,lease_token,lease_expires_at,created_at,updated_at)
          VALUES (?,?,?,?,'CLAIMED',?,?,?,?)`, args: [jobId, fixture.matchId, kickoff, effectiveStart, token, jobExpires, timestamp, timestamp] });
        await tx.execute({ sql: `INSERT INTO research_nightly_jobs(job_id,run_id,window_start_at,window_end_at) VALUES (?,?,?,?)
          ON CONFLICT(job_id) DO UPDATE SET run_id=excluded.run_id,window_start_at=excluded.window_start_at,window_end_at=excluded.window_end_at`,
        args: [jobId, runId, effectiveStart, windowEndAt] });
        job = await first(tx, 'SELECT * FROM research_jobs WHERE id=?', [jobId]);
        claimed.push({ ...job, mode: 'NIGHTLY', runId, windowStartAt: effectiveStart, windowEndAt });
      }
      return { run: await first(tx, 'SELECT * FROM research_nightly_runs WHERE id=?', [runId]), jobs: claimed, skipped, busy: false, alreadyCompleted: false };
    });
  }

  private nightlyLeaseExpiry(now: string, windowEndAt: string, leaseMs = 180_000): string {
    if (!Number.isFinite(leaseMs)) throw new Error('Invalid nightly lease duration');
    return iso(Math.min(Date.parse(windowEndAt), Date.parse(now) + Math.max(1000, Math.min(leaseMs, 900_000))));
  }

  async renewNightlyLease(runId: string, leaseToken: string, leaseMs?: number): Promise<any> {
    return this.write(async (tx) => {
      const run = await first(tx, 'SELECT * FROM research_nightly_runs WHERE id=?', [runId]);
      const now = iso(this.clock());
      this.assertNightlyRunLease(run, leaseToken, Date.parse(now));
      const expires = this.nightlyLeaseExpiry(now, run.windowEndAt, leaseMs);
      await tx.execute({ sql: 'UPDATE research_nightly_runs SET lease_expires_at=?,updated_at=? WHERE id=? AND lease_token=?',
        args: [expires, now, runId, leaseToken] });
      await tx.execute({ sql: `UPDATE research_jobs SET lease_expires_at=MIN(kickoff_at,?),updated_at=?
        WHERE status='CLAIMED' AND lease_token=? AND id IN (SELECT job_id FROM research_nightly_jobs WHERE run_id=?)`,
      args: [expires, now, leaseToken, runId] });
      return { ...run, leaseExpiresAt: expires, updatedAt: now };
    });
  }

  async finishNightlyRun(runId: string, leaseToken: string, outcome: { status: 'COMPLETED' | 'ERROR'; summary: Record<string, unknown> }): Promise<any> {
    return this.write(async (tx) => {
      const run = await first(tx, 'SELECT * FROM research_nightly_runs WHERE id=?', [runId]);
      if (!run || run.leaseToken !== leaseToken) throw new Error('Research nightly lease lost');
      if (run.status === 'COMPLETED') return run;
      if (!['COMPLETED', 'ERROR'].includes(outcome.status)) throw new Error('Invalid nightly outcome');
      const now = iso(this.clock());
      await tx.execute({ sql: `UPDATE research_nightly_runs SET status=?,summary_json=?,ended_at=?,lease_expires_at=?,updated_at=?
        WHERE id=? AND lease_token=?`, args: [outcome.status, researchJson(outcome.summary), now, now, now, runId, leaseToken] });
      if (outcome.status === 'ERROR') await tx.execute({ sql: `UPDATE research_jobs SET status='PENDING',lease_expires_at=?,updated_at=?
        WHERE status='CLAIMED' AND lease_token=? AND id IN (SELECT job_id FROM research_nightly_jobs WHERE run_id=?)`,
      args: [now, now, leaseToken, runId] });
      return first(tx, 'SELECT * FROM research_nightly_runs WHERE id=?', [runId]);
    });
  }

  async listNightlyRuns(limit = 30): Promise<any[]> {
    if (!await this.hasNightlySchema()) return [];
    return rows(this.client, 'SELECT * FROM research_nightly_runs ORDER BY started_at DESC,id DESC LIMIT ?',
      [Math.max(1, Math.min(365, Math.floor(Number(limit) || 30)))]);
  }

  async getNightlyRun(runId: string): Promise<any> {
    if (!await this.hasNightlySchema()) return null;
    return first(this.client, 'SELECT * FROM research_nightly_runs WHERE id=?', [runId]);
  }

  /** Count persisted results, including a committed transaction whose response was lost. */
  async getNightlyRunMetrics(runId: string): Promise<{
    analyzedMatches: number; registeredBets: number; abstainedMatches: number; reasonCounts: Record<string, number>;
  }> {
    if (!await this.hasNightlySchema()) return { analyzedMatches: 0, registeredBets: 0, abstainedMatches: 0, reasonCounts: {} };
    const originOnly = await this.hasExecutionDecisionColumn() ? ' AND b.execution_decision_id IS NULL' : '';
    const records = await rows(this.client, `WITH per_job AS (
      SELECT j.id,j.status,CASE WHEN i.id IS NULL THEN 0 ELSE 1 END AS analyzed,COUNT(DISTINCT b.id) AS bet_count
      FROM research_nightly_jobs n JOIN research_jobs j ON j.id=n.job_id
      LEFT JOIN research_inputs i ON i.job_id=j.id
      LEFT JOIN research_decisions d ON d.job_id=j.id
      LEFT JOIN research_bets b ON b.decision_id=d.id${originOnly}
      WHERE n.run_id=? GROUP BY j.id,j.status,i.id
    ), totals AS (SELECT COALESCE(SUM(analyzed),0) AS analyzed_matches,COALESCE(SUM(bet_count),0) AS registered_bets,
      COALESCE(SUM(CASE WHEN status='COMPLETED' AND analyzed=1 AND bet_count=0 THEN 1 ELSE 0 END),0) AS abstained_matches
      FROM per_job), reasons AS (SELECT COALESCE(d.reason,'model_abstained') AS reason,COUNT(*) AS count
      FROM research_nightly_jobs n JOIN research_decisions d ON d.job_id=n.job_id
      WHERE n.run_id=? AND d.action='ABSTAIN' GROUP BY COALESCE(d.reason,'model_abstained'))
      SELECT totals.*,reasons.reason,reasons.count FROM totals LEFT JOIN reasons ON 1=1 ORDER BY reasons.reason`, [runId, runId]);
    // A reason count describes decisions: A and C may independently abstain on one match.
    const result = records[0];
    return { analyzedMatches: Number(result.analyzedMatches), registeredBets: Number(result.registeredBets),
      abstainedMatches: Number(result.abstainedMatches),
      reasonCounts: Object.fromEntries(records.filter((entry) => entry.reason !== null).map((entry) => [entry.reason, Number(entry.count)])) };
  }

  private async hasNightlySchema(): Promise<boolean> {
    await this.ready();
    // Monitoring reads must not initialize write guards or modify the journal.
    if (this.nightlySchema === undefined) {
      const schema = await first(this.client, `SELECT
        EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_nightly_jobs') AS nightly_exists,
        EXISTS(SELECT 1 FROM pragma_table_info('research_bets') WHERE name='execution_decision_id') AS execution_exists`);
      this.nightlySchema = Boolean(schema.nightlyExists);
      this.executionDecisionColumn = Boolean(schema.executionExists);
    }
    return this.nightlySchema;
  }

  private async hasProspectiveSchema(): Promise<boolean> {
    await this.ready();
    this.prospectiveSchema ??= Boolean(await first(this.client,
      "SELECT name FROM sqlite_master WHERE type='table' AND name='research_prospective_observations'"));
    return this.prospectiveSchema;
  }

  private assertNightlyRunLease(run: any, token: string, now: number): void {
    if (run?.status !== 'RUNNING' || run.leaseToken !== token || now >= Date.parse(run.leaseExpiresAt)) throw new Error('Research nightly lease lost');
    if (now < Date.parse(run.startedAt) || now >= Date.parse(run.windowEndAt)) throw new Error('Research nightly decision window closed');
  }

  private async attachNightlyJob(db: Executor, job: any): Promise<any> {
    if (!job || !this.nightlySchema) return job;
    const metadata = await first(db, `SELECT n.*,r.quote_max_age_ms,r.min_ev,r.min_prudential_ev
      FROM research_nightly_jobs n JOIN research_nightly_runs r ON r.id=n.run_id WHERE n.job_id=?`, [job.id]);
    return metadata ? { ...job, ...metadata, mode: 'NIGHTLY' } : job;
  }

  async claimDueJobs(now: string | Date, leaseMs = 30_000): Promise<any[]> {
    iso(now);
    return this.write(async (tx) => {
      // The process clock is authoritative. A caller cannot move a job into its window.
      const timestamp = iso(this.clock());
      const due = await rows(tx, `SELECT * FROM research_jobs WHERE target_at<=?
        ${this.nightlySchema ? 'AND id NOT IN (SELECT job_id FROM research_nightly_jobs)' : ''}
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
      const job = await this.attachNightlyJob(tx, await first(tx, 'SELECT * FROM research_jobs WHERE id=?', [jobId]));
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
    if (job.mode === 'NIGHTLY') return now >= Date.parse(job.windowStartAt) && now < Date.parse(job.windowEndAt) && now < Date.parse(job.kickoffAt);
    return now >= Date.parse(job.targetAt) && now <= Date.parse(job.targetAt) + TOLERANCE_MS && now < Date.parse(job.kickoffAt);
  }

  private assertCommitWindow(job: any, token: string, now: number): void {
    if (job?.status !== 'CLAIMED' || job.leaseToken !== token || now >= Date.parse(job.leaseExpiresAt)) throw new Error('Research job lease lost');
    if (!this.inWindow(job, now)) throw new Error(`Research ${job.mode === 'NIGHTLY' ? 'nightly' : 'T15'} commit window closed`);
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
    const originOnly = await this.hasExecutionDecisionColumn(true) ? ' AND execution_decision_id IS NULL' : '';
    return this.write(async (tx) => {
      const committedDecisions: any[] = []; const bets: any[] = []; const completedJobs: any[] = []; const observations: any[] = [];
      const plans: Array<{ input: ResearchCommit; job: any; inputId: string; decision: ResearchDecision }> = [];
      const hasFixtures = await first(tx, "SELECT name FROM sqlite_master WHERE type='table' AND name='matches'");
      for (const input of preparedJobs) {
        if (input.observations !== undefined && (!Array.isArray(input.observations)
          || researchHash(input.observations) !== researchHash(input.inputSnapshot.prospectiveObservations))) {
          throw new Error('Prospective observations must be frozen in the shared input');
        }
        if (input.observations?.length && !this.prospectiveSchema) throw new Error('Research prospective migration 021 is required');
        const job = await this.attachNightlyJob(tx, await first(tx, 'SELECT * FROM research_jobs WHERE id=?', [input.jobId]));
        if (!job) throw new Error('Research job not found');
        if (job.status === 'COMPLETED') {
          const storedInput = await first(tx, 'SELECT * FROM research_inputs WHERE job_id=?', [job.id]);
          if (!storedInput || storedInput.inputHash !== researchHash(input.inputSnapshot)) throw new Error('Completed job input is immutable');
          committedDecisions.push(...await rows(tx, 'SELECT * FROM research_decisions WHERE job_id=?', [job.id]));
          bets.push(...await rows(tx, `SELECT * FROM research_bets WHERE match_id=?${originOnly}`, [job.matchId]));
          if (input.observations?.length) observations.push(...await rows(tx, 'SELECT * FROM research_prospective_observations WHERE job_id=?', [job.id]));
          completedJobs.push(job);
          continue;
        }
        this.assertCommitWindow(job, input.leaseToken, at());
        if (job.mode === 'NIGHTLY') {
          const run = await first(tx, 'SELECT * FROM research_nightly_runs WHERE id=?', [job.runId]);
          this.assertNightlyRunLease(run, input.leaseToken, at());
          if (input.inputSnapshot.mode !== 'NIGHTLY' || input.inputSnapshot.runId !== job.runId
            || input.inputSnapshot.windowStartAt !== job.windowStartAt) throw new Error('Shared nightly input identity mismatch');
        }
        // Nightly may change the official fixture after model preparation. This
        // read shares the write transaction, so that update cannot race admission.
        if (hasFixtures) {
          const fixture = await first(tx, 'SELECT date,home_goals,away_goals FROM matches WHERE match_id=?', [job.matchId]);
          if (!fixture || Date.parse(fixture.date) !== Date.parse(job.kickoffAt)
            || fixture.homeGoals != null || fixture.awayGoals != null) throw new Error('Research fixture changed before commit');
        }
        const observedAt = Date.parse(iso(input.inputSnapshot?.observedAt));
        if (observedAt > at() || observedAt >= Date.parse(job.kickoffAt)) throw new Error('Shared input must be observed before decision and kickoff');
        if (job.mode === 'NIGHTLY' && observedAt < Date.parse(job.windowStartAt)) throw new Error('Shared nightly input predates execution');
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
        if (input.observations?.length) observations.push(...await this.freezeProspectiveObservations(tx, input, job, inputId, at));
        for (const decision of input.decisions) plans.push({ input, job, inputId, decision });
      }
      // All candidates are prepared first. This order determines allocation for simultaneous targets.
      plans.sort((a, b) => (a.job.mode === 'NIGHTLY' && b.job.mode === 'NIGHTLY'
        ? a.decision.family.localeCompare(b.decision.family)
          || Number(b.decision.prudentialEv ?? -Infinity) - Number(a.decision.prudentialEv ?? -Infinity)
          || Number(b.decision.ev ?? -Infinity) - Number(a.decision.ev ?? -Infinity)
        : a.job.targetAt.localeCompare(b.job.targetAt))
        || Number(b.decision.score ?? b.job.score ?? 0) - Number(a.decision.score ?? a.job.score ?? 0)
        || a.job.matchId.localeCompare(b.job.matchId) || a.decision.family.localeCompare(b.decision.family));
      for (const plan of plans) {
        const decision = plan.decision; family(decision.family);
        const nightly = plan.job.mode === 'NIGHTLY';
        const portfolioId = decision.portfolioId ?? `shadow_${decision.family}`;
        if (nightly && portfolioId !== `shadow_${decision.family}`) throw new Error('Nightly uses only independent virtual A/C portfolios');
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
        if (!market || !(nightly ? ['EXPERIMENTAL', 'SHADOW', 'ACTIVE'] : ['SHADOW', 'ACTIVE']).includes(market.state)) abstain('market_not_validated');
        const configuration = decision.probabilityConfiguration;
        if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)
          || configuration.family !== decision.family || configuration.version !== 'probability-configuration-v1'
          || configuration.probabilityProtocol !== 'joint-goal-coherent-v2'
          || !/^[a-f0-9]{64}$/.test(decision.probabilityConfigurationHash ?? '')
          || researchHash(configuration) !== decision.probabilityConfigurationHash
          || (!nightly && decision.probabilityConfigurationHash !== market?.evidence?.approvedProbabilityConfigurationHash)) {
          abstain('probability_configuration_not_validated');
        }
        const calibrationAt = typeof decision.calibrationAvailableAt === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(decision.calibrationAvailableAt)
          ? Date.parse(decision.calibrationAvailableAt) : Number.NaN;
        if (nightly && (decision.validated !== true || !configuration?.baselineVersion
          || !/^[a-f0-9]{64}$/.test(configuration?.pipelineHashV2 ?? '')
          || !/^[a-f0-9]{64}$/.test(configuration?.calibratorHash ?? '')
          || !['identity', 'isotonic_1x2', 'temperature'].includes(configuration?.mode)
          || !Number.isFinite(configuration?.temperature) || configuration.temperature <= 0
          || (plan.input.inputSnapshot.forecast?.baselineVersion && configuration.baselineVersion !== plan.input.inputSnapshot.forecast.baselineVersion)
          || (decision.calibrationPipelineHash && configuration.pipelineHashV2 !== decision.calibrationPipelineHash)
          || !Number.isFinite(calibrationAt) || calibrationAt > Date.parse(plan.input.inputSnapshot.observedAt)
          || (model && Date.parse(model.createdAt) > Date.parse(plan.input.inputSnapshot.observedAt))
          || calibrationAt >= Date.parse(plan.job.kickoffAt))) abstain('probability_configuration_not_technically_eligible');
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
        const maxQuoteAge = nightly ? plan.job.quoteMaxAgeMs : QUOTE_MAX_AGE_MS;
        const validTime = (time: number) => Number.isFinite(time) && time <= at() && at() - time <= maxQuoteAge
          && (!nightly || time <= Date.parse(plan.input.inputSnapshot.observedAt)) && time < Date.parse(plan.job.kickoffAt);
        if (!quote || !Number.isFinite(odds) || odds <= 1 || !String(quote.bookmaker ?? quote.bookmakerName ?? '').trim()
          || quote.source !== 'odds_api' || quote.usedSyntheticOdds === true
          || !validTime(captured) || !validTime(updated)) abstain('real_fresh_quote_required');
        if (quote && !plan.input.inputSnapshot.quotes.some((shared: unknown) => researchHash(shared) === researchHash(quote))) abstain('quote_not_in_shared_snapshot');
        if (nightly && (quote?.market !== decision.market || quote?.selection !== decision.selection
          || settleGoalQuote(quote as any, 0, 0).status === 'UNRESOLVED')) abstain('market_settlement_not_supported');
        const probability = Number(decision.probability);
        if (!Number.isFinite(probability) || probability <= 0 || probability >= 1
          || !Number.isFinite(Number(decision.ev)) || Number(decision.ev) < (nightly ? plan.job.minEv : .04)
          || !Number.isFinite(Number(decision.prudentialEv)) || Number(decision.prudentialEv) < (nightly ? plan.job.minPrudentialEv : .01)) abstain('prudential_value_threshold_required');
        if (!decision.selection?.trim()) abstain('selection_required');
        const stakeCents = Math.floor(Number(portfolio.equityCents) * .01);
        if (stakeCents <= 0 || stakeCents > Number(portfolio.availableCents)) abstain('insufficient_virtual_capital');
        if (Number(portfolio.committedCents) + stakeCents > Math.floor(Number(portfolio.equityCents) * .05)) abstain('virtual_exposure_limit');
        const duplicate = await first(tx, 'SELECT id FROM research_bets WHERE portfolio_id=? AND match_id=?', [portfolioId, plan.job.matchId]);
        if (duplicate) abstain('one_bet_per_portfolio_match');
        const id = randomUUID(); const createdAt = iso(at()); const action = reason ? 'ABSTAIN' : 'BET';
        const evidence = { ...decision, ...(nightly ? { ...plan.input.inputSnapshot.match,
          matchId: plan.job.matchId, kickoffAt: plan.job.kickoffAt, decisionMode: 'NIGHTLY', runId: plan.job.runId,
          experimental: market?.state === 'EXPERIMENTAL', quoteLeadTimeMs: Number.isFinite(captured) ? Date.parse(plan.job.kickoffAt) - captured : null,
          decisionLeadTimeMs: Date.parse(plan.job.kickoffAt) - at() } : {}),
        quote: quote ?? null, inputId: plan.inputId, inputHash: researchHash(plan.input.inputSnapshot), stakeCents: action === 'BET' ? stakeCents : 0 };
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
      return { decisions: committedDecisions, bets, jobs: completedJobs, observations };
    }, () => { for (const { job, token } of guardedJobs) this.assertCommitWindow(job, token, at()); });
  }

  private async freezeProspectiveObservations(tx: Transaction, input: ResearchCommit, job: any, inputId: string,
    at: () => number): Promise<any[]> {
    if (job.mode !== 'NIGHTLY') throw new Error('Prospective observations require a nightly job');
    const observedAt = iso(input.inputSnapshot.observedAt), observed = Date.parse(observedAt);
    if (observed <= Date.parse(ORIGINAL_HOLDOUT_POLICY.newIndependentForecastsAfter)
      || ORIGINAL_HOLDOUT_POLICY.protectedOriginalFinalMatchIds.includes(job.matchId)) throw new Error('Protected historical evidence cannot become prospective');
    const allowedByFamily = new Map<string, Set<string>>(), models = new Map<string, any>();
    for (const modelFamily of new Set((input.observations ?? []).map((entry) => entry.family))) {
      const decision = input.decisions.find((entry) => entry.family === modelFamily);
      const markets = await rows(tx, `SELECT market FROM research_markets WHERE family=? AND model_version=?
        AND state IN ('EXPERIMENTAL','SHADOW','ACTIVE')`, [modelFamily, decision?.modelVersion ?? '']);
      if (!decision?.prospectiveMatrix || !decision.probabilityStages?.decision) throw new Error('Frozen prospective probability stages are required');
      const expected = buildFrozenProspectiveObservations({ matchId: job.matchId, family: modelFamily,
        modelVersion: decision.modelVersion, probabilityConfigurationHash: decision.probabilityConfigurationHash,
        matrix: decision.prospectiveMatrix, probabilities: decision.probabilityStages.decision,
        quotes: input.inputSnapshot.quotes, allowedMarkets: markets.map((market) => market.market),
        forecastAt: observedAt, kickoffAt: job.kickoffAt, quoteMaxAgeMs: job.quoteMaxAgeMs });
      if (researchHash(expected) !== researchHash(input.observations!.filter((entry) => entry.family === modelFamily))) {
        throw new Error('Prospective selection must match the frozen probability pipeline');
      }
      allowedByFamily.set(modelFamily, new Set(markets.map((market) => market.market)));
    }
    const selected: any[] = [], identities = new Set<string>();
    for (const observation of input.observations ?? []) {
      const decision = input.decisions.find((entry) => entry.family === observation.family);
      const configuration = decision?.probabilityConfiguration;
      const modelKey = `${observation.family}:${observation.modelVersion}`;
      if (!models.has(modelKey)) models.set(modelKey,
        await first(tx, 'SELECT * FROM research_models WHERE family=? AND version=?', [observation.family, observation.modelVersion]));
      const model = models.get(modelKey);
      const calibrationAt = decision?.calibrationAvailableAt;
      if (!decision || decision.validated !== true || decision.modelVersion !== observation.modelVersion
        || decision.probabilityConfigurationHash !== observation.probabilityConfigurationHash
        || !configuration || configuration.family !== observation.family || configuration.version !== 'probability-configuration-v1'
        || configuration.probabilityProtocol !== 'joint-goal-coherent-v2'
        || !configuration.baselineVersion || !/^[a-f0-9]{64}$/.test(configuration.pipelineHashV2 ?? '')
        || !/^[a-f0-9]{64}$/.test(configuration.calibratorHash ?? '')
        || !['identity', 'isotonic_1x2', 'temperature'].includes(configuration.mode)
        || !Number.isFinite(configuration.temperature) || configuration.temperature <= 0
        || (input.inputSnapshot.forecast?.baselineVersion && input.inputSnapshot.forecast.baselineVersion !== configuration.baselineVersion)
        || (decision.calibrationPipelineHash && decision.calibrationPipelineHash !== configuration.pipelineHashV2)
        || researchHash(configuration) !== observation.probabilityConfigurationHash
        || !model || Date.parse(model.createdAt) > observed || !allowedByFamily.get(observation.family)?.has(observation.market)
        || typeof calibrationAt !== 'string' || !/(?:z|[+-]\d{2}:\d{2})$/i.test(calibrationAt)
        || !Number.isFinite(Date.parse(calibrationAt)) || Date.parse(calibrationAt) > observed) {
        throw new Error('Prospective model configuration is not technically eligible');
      }
      const quote = observation.quote;
      const quoteTime = (value: unknown) => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
      if (observation.protocol !== 'prospective-residual-v1' || observation.partition !== prospectivePartition(job.matchId)
        || observation.bucket !== prospectiveBucket(observation.probability) || !Number.isFinite(observation.probability)
        || observation.probability <= 0 || observation.probability >= 1 || !quote || quote.source !== 'odds_api'
        || (quote as any).usedSyntheticOdds === true || !quote.bookmaker?.trim() || quote.market !== observation.market
        || quote.selection !== observation.selection || settleGoalQuote(quote, 0, 0).status === 'UNRESOLVED'
        || !Number.isFinite(observation.expectedValue) || observation.expectedValue < -1 || observation.expectedValue > quote.odds - 1 + 1e-8
        || ![quoteTime(quote.capturedAt), quoteTime(quote.updatedAt)].every((time) => Number.isFinite(time)
          && time <= observed && observed - time <= job.quoteMaxAgeMs)
        || !input.inputSnapshot.quotes.some((entry: unknown) => researchHash(entry) === researchHash(quote))) {
        throw new Error('Invalid frozen prospective observation');
      }
      const identity = `${observation.family}:${observation.market}:${observation.bucket}`;
      if (identities.has(identity)) throw new Error('One prospective observation per match, market and bucket required');
      identities.add(identity);
      const id = researchHash({ protocol: observation.protocol, matchId: job.matchId, family: observation.family,
        modelVersion: observation.modelVersion, configurationHash: observation.probabilityConfigurationHash,
        market: observation.market, bucket: observation.bucket });
      const snapshot = { ...observation, matchId: job.matchId, inputId, inputHash: researchHash(input.inputSnapshot),
        modelArtifactHash: model.artifactHash, observedAt, frozenAt: iso(at()), kickoffAt: job.kickoffAt };
      await tx.execute({ sql: `INSERT INTO research_prospective_observations
        (id,job_id,input_id,match_id,family,model_version,model_artifact_hash,configuration_hash,market,bucket,partition,protocol,
        probability,expected_value,odds,observed_at,frozen_at,kickoff_at,snapshot_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, job.id, inputId, job.matchId, observation.family, observation.modelVersion, model.artifactHash,
        observation.probabilityConfigurationHash, observation.market, observation.bucket, observation.partition, observation.protocol,
        observation.probability, observation.expectedValue, quote.odds, observedAt, snapshot.frozenAt, job.kickoffAt, researchJson(snapshot)] });
      selected.push({ id, ...snapshot });
    }
    return selected;
  }

  async listPendingProspectiveObservations(): Promise<any[]> {
    if (!await this.hasProspectiveSchema()) return [];
    return rows(this.client, `SELECT o.* FROM research_prospective_observations o
      LEFT JOIN research_prospective_results r ON r.observation_id=o.id WHERE r.observation_id IS NULL
      ORDER BY o.kickoff_at,o.match_id,o.family,o.market,o.bucket`);
  }

  async countNightlyProspectiveObservations(runId: string): Promise<number> {
    if (!await this.hasProspectiveSchema()) return 0;
    const result = await first(this.client, `SELECT COUNT(*) AS count FROM research_prospective_observations o
      JOIN research_nightly_jobs n ON n.job_id=o.job_id WHERE n.run_id=?`, [runId]);
    return Number(result?.count ?? 0);
  }

  async settleProspectiveObservation(id: string, multiplier: number, evidence: any): Promise<any> {
    return this.write(async (tx) => {
      if (!this.prospectiveSchema) throw new Error('Research prospective migration 021 is required');
      const observation = await first(tx, 'SELECT * FROM research_prospective_observations WHERE id=?', [id]);
      if (!observation) throw new Error('Prospective observation not found');
      const observedAvailableAt = iso(this.clock());
      const kickoffAt = evidence?.resultKickoffAt ?? observation.kickoffAt;
      if (!evidence || !Number.isInteger(evidence.homeGoals) || !Number.isInteger(evidence.awayGoals)
        || evidence.homeGoals < 0 || evidence.awayGoals < 0 || !String(evidence.source ?? '').trim()
        || Date.parse(observedAvailableAt) < Date.parse(observation.kickoffAt)
        || Date.parse(iso(kickoffAt)) > Date.parse(observedAvailableAt)) throw new Error('Official prospective result is unavailable');
      const fixtureTable = await first(tx, "SELECT name FROM sqlite_master WHERE type='table' AND name='matches'");
      if (fixtureTable) {
        const match = await first(tx, 'SELECT date,home_goals,away_goals,source FROM matches WHERE match_id=?', [observation.matchId]);
        if (!match || match.homeGoals !== evidence.homeGoals || match.awayGoals !== evidence.awayGoals
          || Date.parse(match.date) !== Date.parse(kickoffAt) || (match.source && match.source !== evidence.source)) {
          throw new Error('Official prospective result does not match the stored fixture');
        }
      }
      const outcome = settleGoalQuote(observation.snapshot.quote, evidence.homeGoals, evidence.awayGoals);
      if (outcome.returnMultiplier === null || !Number.isFinite(multiplier)
        || Math.abs(multiplier - outcome.returnMultiplier) > 1e-9) throw new Error('Prospective payout must match the frozen quote');
      const official = { matchId: observation.matchId, homeGoals: evidence.homeGoals, awayGoals: evidence.awayGoals,
        source: evidence.source, resultKickoffAt: iso(kickoffAt), status: outcome.status };
      const existing = await first(tx, 'SELECT * FROM research_prospective_results WHERE observation_id=?', [id]);
      if (existing) {
        if (existing.returnMultiplier !== multiplier || existing.evidenceHash !== researchHash(official)) throw new Error('Prospective result evidence is immutable');
        return { ...existing, settled: false };
      }
      await tx.execute({ sql: `INSERT INTO research_prospective_results
        (observation_id,return_multiplier,evidence_hash,evidence_json,available_at) VALUES (?,?,?,?,?)`,
      args: [id, multiplier, researchHash(official), researchJson(official), observedAvailableAt] });
      return { observationId: id, returnMultiplier: multiplier, evidence: official, availableAt: observedAvailableAt, settled: true };
    });
  }

  async listProspectiveCalibrationSamples(input: { family: ResearchFamily; modelVersion: string;
    probabilityConfigurationHash: string; asOf: string | Date }): Promise<any[]> {
    if (!await this.hasProspectiveSchema()) return [];
    const asOf = iso(input.asOf);
    if (Date.parse(asOf) > this.clock().getTime()) throw new Error('Prospective evidence cannot be read from the future');
    await this.reconcileProspectiveEvidence();
    const samples = await rows(this.client, `SELECT o.match_id,o.market,o.probability,o.odds,o.expected_value,r.return_multiplier,r.available_at
      FROM research_prospective_observations o JOIN research_prospective_results r ON r.observation_id=o.id
      WHERE o.family=? AND o.model_version=? AND o.configuration_hash=? AND o.partition='CALIBRATION'
        AND o.protocol='prospective-residual-v1' AND r.available_at<=? AND o.observed_at<r.available_at AND o.frozen_at<r.available_at
        AND NOT EXISTS (SELECT 1 FROM research_prospective_invalidations v WHERE v.observation_id=o.id AND v.detected_at<=?)
      ORDER BY o.match_id,o.market,o.bucket,o.id`, [family(input.family), input.modelVersion, input.probabilityConfigurationHash, asOf, asOf]);
    return samples.map((sample) => ({ matchId: sample.matchId, market: sample.market, probability: sample.probability,
      odds: sample.odds, expectedValue: sample.expectedValue, returnMultiplier: sample.returnMultiplier,
      outcomeAvailableAt: sample.availableAt, phase: 'validation' }));
  }

  /** Quarantine newly contradicted labels without changing the original forecast or payout. */
  async reconcileProspectiveEvidence(): Promise<{ checked: number; invalidated: number }> {
    if (!await this.hasProspectiveSchema()) return { checked: 0, invalidated: 0 };
    await this.ready();
    if (!await first(this.client, "SELECT name FROM sqlite_master WHERE type='table' AND name='matches'")) {
      return { checked: 0, invalidated: 0 };
    }
    return this.write(async (tx) => {
      const detectedAt = iso(this.clock());
      const records = await rows(tx, `SELECT r.observation_id,r.evidence_json,r.available_at,
        m.date AS current_kickoff_at,m.home_goals AS current_home_goals,m.away_goals AS current_away_goals
        FROM research_prospective_results r JOIN research_prospective_observations o ON o.id=r.observation_id
        JOIN matches m ON m.match_id=o.match_id
        LEFT JOIN research_prospective_invalidations v ON v.observation_id=r.observation_id
        WHERE v.observation_id IS NULL AND r.available_at<=?`, [detectedAt]);
      let invalidated = 0;
      for (const row of records) {
        const official = row.evidence;
        const complete = Number.isInteger(row.currentHomeGoals) && Number.isInteger(row.currentAwayGoals);
        const kickoffChanged = Number.isFinite(Date.parse(row.currentKickoffAt))
          && Date.parse(row.currentKickoffAt) !== Date.parse(official.resultKickoffAt);
        const scoreChanged = complete && (row.currentHomeGoals !== official.homeGoals || row.currentAwayGoals !== official.awayGoals);
        if (!kickoffChanged && !scoreChanged) continue;
        await tx.execute({ sql: `INSERT OR IGNORE INTO research_prospective_invalidations(observation_id,detected_at,reason)
          VALUES (?,?,?)`, args: [row.observationId, detectedAt, scoreChanged ? 'official_result_corrected' : 'official_kickoff_changed'] });
        invalidated++;
      }
      return { checked: records.length, invalidated };
    });
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
