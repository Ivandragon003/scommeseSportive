import type { Client, Transaction } from '@libsql/client';
import { ResearchStore, researchHash, researchJson } from './ResearchStore';

type Executor = Pick<Client, 'execute'> | Pick<Transaction, 'execute'>;
type Row = Record<string, any>;
export type BetCancellationRequest = {
  betIds: string[]; policyHash: string; runId: string; reason: string; authorizedBy: string; authorizedAt: string;
};
export type BetCancellationPlan = BetCancellationRequest & {
  version: 'research-bet-cancellation-v1'; createdAt: string; planHash: string;
  bets: Array<{ betId: string; matchId: string; family: 'A' | 'C'; stakeCents: number; kickoffAt: string; fingerprint: string }>;
};
const betFields = ['id', 'decision_id', 'portfolio_id', 'match_id', 'family', 'model_version', 'market', 'selection',
  'odds', 'stake_cents', 'snapshot_json', 'placed_at', 'execution_decision_id'];
const ledgerFields = ['id', 'portfolio_id', 'bet_id', 'event', 'available_delta_cents', 'committed_delta_cents', 'created_at'];
const normalize = (row: Row): Row => Object.fromEntries(Object.entries(row).map(([key, value]) =>
  [key, typeof value === 'bigint' ? Number(value) : value]));
async function rows(db: Executor, sql: string, args: any[] = []): Promise<Row[]> {
  return (await db.execute({ sql, args })).rows.map(normalize);
}
async function one(db: Executor, sql: string, args: any[] = []): Promise<Row | null> {
  return (await rows(db, sql, args))[0] ?? null;
}
const timestamp = (value: unknown): number => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  ? Date.parse(value) : NaN;
const schema = `CREATE TABLE IF NOT EXISTS research_bet_cancellations (
  bet_id TEXT PRIMARY KEY, plan_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
  policy_hash TEXT NOT NULL, policy_version TEXT NOT NULL CHECK(policy_version='virtual-recommendation-v1'),
  run_id TEXT NOT NULL, reason TEXT NOT NULL, authorized_by TEXT NOT NULL, authorized_at TEXT NOT NULL, cancelled_at TEXT NOT NULL,
  bet_json TEXT NOT NULL, stake_ledger_json TEXT NOT NULL, provenance_json TEXT NOT NULL
)`;
const exact = (fields: string[], json: string, row: string): string => fields.map((field) =>
  `json_extract(${json},'$.${field}') IS ${row}.${field}`).join(' AND ');

/** Install only a narrow, archived-row exception. Every other evidence deletion stays forbidden. */
async function installCancellationGuards(tx: Transaction): Promise<void> {
  await tx.execute(schema);
  // A standalone maintenance client may run before the web execution store initializes its guards.
  for (const table of ['research_execution_policies', 'research_execution_inputs', 'research_execution_decisions']) {
    for (const operation of ['UPDATE', 'DELETE']) await tx.execute(`CREATE TRIGGER IF NOT EXISTS ${table}_immutable_${operation.toLowerCase()}
      BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(ABORT,'execution evidence is immutable'); END`);
  }
  for (const operation of ['UPDATE', 'DELETE']) await tx.execute(`CREATE TRIGGER IF NOT EXISTS research_bet_cancellations_immutable_${operation.toLowerCase()}
    BEFORE ${operation} ON research_bet_cancellations BEGIN SELECT RAISE(ABORT,'cancellation archive is immutable'); END`);
  await tx.execute(`CREATE TRIGGER IF NOT EXISTS research_bet_cancellation_archive_source
    BEFORE INSERT ON research_bet_cancellations BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM research_bets b JOIN research_execution_decisions d ON d.id=b.execution_decision_id
        JOIN research_execution_inputs i ON i.id=d.input_id JOIN research_execution_jobs j ON j.id=i.job_id
        JOIN research_execution_policies p ON p.hash=j.policy_hash JOIN research_ledger l ON l.bet_id=b.id
        WHERE b.id=NEW.bet_id AND p.hash=NEW.policy_hash AND p.version=NEW.policy_version
          AND p.version='virtual-recommendation-v1' AND j.run_id=NEW.run_id
          AND json_extract(p.descriptor_json,'$.virtualOnly')=1
          AND d.action='BET' AND b.decision_id=d.origin_decision_id AND b.portfolio_id=d.portfolio_id
          AND l.event='STAKE' AND l.portfolio_id=b.portfolio_id
          AND l.available_delta_cents=-b.stake_cents AND l.committed_delta_cents=b.stake_cents
          AND ${exact(betFields, 'NEW.bet_json', 'b')}
          AND ${exact(ledgerFields, 'NEW.stake_ledger_json', 'l')}
          AND NOT EXISTS(SELECT 1 FROM research_settlements s WHERE s.bet_id=b.id)
          AND (SELECT COUNT(*) FROM research_ledger x WHERE x.bet_id=b.id)=1
      ) THEN RAISE(ABORT,'cancellation archive source mismatch') END;
    END`);
  for (const [table, fields, json] of [
    ['research_bets', betFields, 'a.bet_json'], ['research_ledger', ledgerFields, 'a.stake_ledger_json'],
  ] as const) {
    await tx.execute(`DROP TRIGGER IF EXISTS ${table}_immutable_delete`);
    await tx.execute(`CREATE TRIGGER ${table}_immutable_delete BEFORE DELETE ON ${table}
      WHEN NOT EXISTS(SELECT 1 FROM research_bet_cancellations a WHERE
        a.bet_id=OLD.${table === 'research_bets' ? 'id' : 'bet_id'} AND ${exact([...fields], json, 'OLD')})
      BEGIN SELECT RAISE(ABORT,'research evidence is immutable'); END`);
  }
  await tx.execute(`CREATE TRIGGER IF NOT EXISTS research_cancelled_bet_identity
    BEFORE INSERT ON research_bets WHEN EXISTS(SELECT 1 FROM research_bet_cancellations WHERE bet_id=NEW.id)
    BEGIN SELECT RAISE(ABORT,'cancelled bet identity cannot be reused'); END`);
}

/** Explicit maintenance for named wrong v1 virtual executions; never runs during ordinary prediction or settlement. */
export class ResearchBetCancellation {
  private readonly research: ResearchStore;
  private readonly clock: () => Date;
  constructor(private readonly client: Client, options: { research?: ResearchStore; clock?: () => Date } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.research = options.research ?? new ResearchStore(client);
  }

  private request(input: BetCancellationRequest, now: number): void {
    if (!Array.isArray(input.betIds) || !input.betIds.length || input.betIds.length > 50
      || input.betIds.some((id) => typeof id !== 'string' || !id.trim()) || new Set(input.betIds).size !== input.betIds.length
      || !/^[a-f0-9]{64}$/.test(input.policyHash) || !input.runId?.trim()
      || !input.reason?.trim() || input.reason.length > 1000 || !input.authorizedBy?.trim() || input.authorizedBy.length > 200
      || !Number.isFinite(timestamp(input.authorizedAt))
      || timestamp(input.authorizedAt) > now) throw new Error('Invalid explicit cancellation request');
  }

  private async evidence(db: Executor, betId: string, input: BetCancellationRequest, now: number) {
    const bet = await one(db, 'SELECT * FROM research_bets WHERE id=?', [betId]);
    if (!bet?.execution_decision_id || !['A', 'C'].includes(bet.family) || bet.portfolio_id !== `shadow_${bet.family}`) {
      throw new Error('Named virtual execution bet not found');
    }
    const provenance = await one(db, `SELECT d.id AS execution_decision_id,d.origin_decision_id,d.portfolio_id,d.family,d.action,
      j.id AS execution_job_id,j.match_id,j.kickoff_at,j.policy_hash,j.run_id,p.version AS policy_version,p.descriptor_json
      FROM research_execution_decisions d JOIN research_execution_inputs i ON i.id=d.input_id
      JOIN research_execution_jobs j ON j.id=i.job_id JOIN research_execution_policies p ON p.hash=j.policy_hash WHERE d.id=?`, [bet.execution_decision_id]);
    if (!provenance || provenance.policy_version !== 'virtual-recommendation-v1' || provenance.policy_hash !== input.policyHash
      || provenance.run_id !== input.runId || provenance.action !== 'BET' || provenance.origin_decision_id !== bet.decision_id
      || provenance.family !== bet.family || provenance.portfolio_id !== bet.portfolio_id || provenance.match_id !== bet.match_id) {
      throw new Error('Cancellation policy or execution provenance mismatch');
    }
    const descriptor = JSON.parse(provenance.descriptor_json);
    if (descriptor.virtualOnly !== true || researchHash(descriptor) !== input.policyHash) throw new Error('Cancellation policy identity mismatch');
    const match = await one(db, 'SELECT match_id,date,home_goals,away_goals FROM matches WHERE match_id=?', [bet.match_id]);
    if (!match || match.home_goals != null || match.away_goals != null || !Number.isFinite(timestamp(match.date))
      || timestamp(match.date) !== timestamp(provenance.kickoff_at) || timestamp(match.date) <= now) {
      throw new Error('Cancellation requires the unchanged upcoming fixture');
    }
    if (await one(db, 'SELECT bet_id FROM research_settlements WHERE bet_id=?', [bet.id])) throw new Error('Settled bets cannot be cancelled');
    const ledger = await rows(db, 'SELECT * FROM research_ledger WHERE bet_id=?', [bet.id]);
    if (ledger.length !== 1 || ledger[0].event !== 'STAKE' || ledger[0].portfolio_id !== bet.portfolio_id
      || ledger[0].available_delta_cents !== -bet.stake_cents || ledger[0].committed_delta_cents !== bet.stake_cents) {
      throw new Error('Cancellation stake movement mismatch');
    }
    const active = await one(db, `SELECT id FROM research_execution_jobs WHERE match_id=? AND status='CLAIMED'
      AND julianday(lease_expires_at)>julianday(?) UNION ALL SELECT id FROM research_jobs WHERE match_id=? AND status='CLAIMED'
      AND julianday(lease_expires_at)>julianday(?) LIMIT 1`, [bet.match_id, new Date(now).toISOString(), bet.match_id, new Date(now).toISOString()]);
    if (active) throw new Error('Cancellation cannot race an active execution lease');
    const running = await one(db, `SELECT id FROM research_nightly_runs WHERE status='RUNNING'
      AND julianday(lease_expires_at)>julianday(?) LIMIT 1`, [new Date(now).toISOString()]);
    if (running) throw new Error('Cancellation cannot race an active nightly run');
    return { bet, ledger: ledger[0], provenance, fingerprint: researchHash({ bet, ledger: ledger[0], provenance }) };
  }

  /** Read-only: even schema creation and guard installation are deferred until explicit apply. */
  async plan(input: BetCancellationRequest): Promise<BetCancellationPlan> {
    const now = this.clock().getTime(); this.request(input, now);
    const bets: BetCancellationPlan['bets'] = [];
    for (const betId of [...input.betIds].sort()) {
      const item = await this.evidence(this.client, betId, input, now);
      bets.push({ betId, matchId: item.bet.match_id, family: item.bet.family, stakeCents: item.bet.stake_cents,
        kickoffAt: item.provenance.kickoff_at, fingerprint: item.fingerprint });
    }
    const plan = { ...input, betIds: [...input.betIds].sort(), version: 'research-bet-cancellation-v1' as const,
      createdAt: new Date(now).toISOString(), bets };
    return { ...plan, planHash: researchHash(plan) };
  }

  async apply(plan: BetCancellationPlan): Promise<{ cancelled: number; alreadyCancelled: number; releasedCents: number; planHash: string }> {
    const { planHash, ...body } = plan;
    const now = this.clock().getTime(); this.request(plan, now);
    if (plan.version !== 'research-bet-cancellation-v1' || researchHash(body) !== planHash
      || !Array.isArray(plan.bets) || plan.bets.length !== plan.betIds.length
      || plan.bets.some((bet, index) => bet.betId !== plan.betIds[index])
      || !Number.isFinite(timestamp(plan.createdAt)) || timestamp(plan.createdAt) > now
      || timestamp(plan.createdAt) < timestamp(plan.authorizedAt)) throw new Error('Cancellation plan identity mismatch');
    const pendingKickoffs: string[] = [];
    return this.research.runResearchTransaction(async (tx) => {
      await installCancellationGuards(tx);
      let alreadyCancelled = 0;
      const pending: Array<{ planned: BetCancellationPlan['bets'][number]; item: Awaited<ReturnType<ResearchBetCancellation['evidence']>> }> = [];
      for (const planned of plan.bets) {
        const archived = await one(tx, 'SELECT * FROM research_bet_cancellations WHERE bet_id=?', [planned.betId]);
        if (archived) {
          if (archived.plan_hash !== planHash || archived.fingerprint !== planned.fingerprint
            || await one(tx, 'SELECT id FROM research_bets WHERE id=?', [planned.betId])
            || await one(tx, 'SELECT id FROM research_ledger WHERE bet_id=?', [planned.betId])) throw new Error('Cancellation replay mismatch');
          alreadyCancelled++; continue;
        }
        const item = await this.evidence(tx, planned.betId, plan, this.clock().getTime());
        if (item.fingerprint !== planned.fingerprint || item.bet.stake_cents !== planned.stakeCents
          || item.bet.match_id !== planned.matchId || item.bet.family !== planned.family
          || item.provenance.kickoff_at !== planned.kickoffAt) throw new Error('Cancellation plan no longer matches the exact original rows');
        pending.push({ planned, item });
        pendingKickoffs.push(planned.kickoffAt);
      }
      const before = await rows(tx, `SELECT portfolio_id,COALESCE(SUM(available_delta_cents),0) AS available,
        COALESCE(SUM(committed_delta_cents),0) AS committed FROM research_ledger GROUP BY portfolio_id`);
      for (const { planned, item } of pending) {
        if (this.clock().getTime() >= timestamp(planned.kickoffAt)) throw new Error('Cancellation crossed kickoff');
        await tx.execute({ sql: `INSERT INTO research_bet_cancellations
          (bet_id,plan_hash,fingerprint,policy_hash,policy_version,run_id,reason,authorized_by,authorized_at,cancelled_at,bet_json,stake_ledger_json,provenance_json)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [planned.betId, planHash, planned.fingerprint, plan.policyHash,
          'virtual-recommendation-v1', plan.runId, plan.reason, plan.authorizedBy, plan.authorizedAt, this.clock().toISOString(),
          researchJson(item.bet), researchJson(item.ledger), researchJson(item.provenance)] });
        const ledgerDelete = await tx.execute({ sql: "DELETE FROM research_ledger WHERE id=? AND bet_id=? AND event='STAKE'", args: [item.ledger.id, planned.betId] });
        const betDelete = await tx.execute({ sql: 'DELETE FROM research_bets WHERE id=?', args: [planned.betId] });
        if (ledgerDelete.rowsAffected !== 1 || betDelete.rowsAffected !== 1) throw new Error('Cancellation did not withdraw exactly one bet and stake');
      }
      const after = await rows(tx, `SELECT portfolio_id,COALESCE(SUM(available_delta_cents),0) AS available,
        COALESCE(SUM(committed_delta_cents),0) AS committed FROM research_ledger GROUP BY portfolio_id`);
      for (const previous of before) {
        const current = after.find((row) => row.portfolio_id === previous.portfolio_id);
        const released = pending.filter(({ item }) => item.bet.portfolio_id === previous.portfolio_id)
          .reduce((sum, { item }) => sum + item.bet.stake_cents, 0);
        if (!current || current.available !== previous.available + released || current.committed !== previous.committed - released) {
          throw new Error('Cancellation accounting reconciliation failed');
        }
      }
      return { cancelled: pending.length, alreadyCancelled, releasedCents: pending.reduce((sum, { item }) => sum + item.bet.stake_cents, 0), planHash };
    }, () => {
      if (pendingKickoffs.some((kickoff) => timestamp(kickoff) <= this.clock().getTime())) throw new Error('Cancellation crossed kickoff before commit');
    });
  }
}
