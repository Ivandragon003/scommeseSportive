import type { Client } from '@libsql/client';
import type { DatabaseService } from '../db/DatabaseService';

type Row = Record<string, any>;
export type ResearchIncident = { key: string; title: string; message: string; details?: Row };
export type MonitoringDb = Pick<DatabaseService, 'research' | 'researchMonitoring' | 'listRecentSchedulerRuns'>
  & Partial<Pick<DatabaseService, 'listRecentSchedulerRunsByName'>>;

const iso = (value: string | Date): string => {
  if (typeof value === 'string' && !/(?:z|[+-]\d{2}:\d{2})$/i.test(value)) throw new Error('Monitoring timestamp requires timezone');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid monitoring timestamp');
  return date.toISOString();
};
const romeDay = (at: string | Date): string => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(at));
const previousDay = (day: string): string => new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
const onDay = (at: string | undefined, day: string): boolean => !!at && Number.isFinite(Date.parse(at)) && romeDay(at) === day;
const summaryHour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' });

/** One persistent notification per incident generation; polling/restarts do not resend it. */
export class ResearchMonitoringStore {
  constructor(private readonly client: Client, private readonly ready: () => Promise<void> = async () => {}) {}

  async reconcile(incidents: ResearchIncident[], now: string | Date): Promise<void> {
    await this.ready();
    const timestamp = iso(now);
    let tx;
    for (let attempt = 0; ; attempt++) {
      try { tx = await this.client.transaction('write'); break; }
      catch (error: any) {
        if (attempt >= 5 || !/SQLITE_BUSY|database is locked/i.test(String(error?.code) + String(error?.message))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
    try {
      const keys = new Set(incidents.map((incident) => incident.key));
      const existing = await tx.execute('SELECT * FROM research_monitor_incidents');
      for (const incident of incidents) {
        const prior = existing.rows.find((row) => row.incident_key === incident.key);
        const generation = Number(prior?.generation ?? 0) + (prior?.state === 'OPEN' ? 0 : 1);
        const payload = JSON.stringify({ title: incident.title, message: incident.message, details: incident.details ?? {}, level: 'error' });
        await tx.execute({ sql: `INSERT INTO research_monitor_incidents
          (incident_key,state,generation,opened_at,last_seen_at,resolved_at,details_json)
          VALUES (?,'OPEN',?,?,?,NULL,?) ON CONFLICT(incident_key) DO UPDATE SET
          state='OPEN',generation=excluded.generation,opened_at=CASE WHEN state='OPEN' THEN opened_at ELSE excluded.opened_at END,
          last_seen_at=excluded.last_seen_at,resolved_at=NULL,details_json=excluded.details_json`,
        args: [incident.key, generation, timestamp, timestamp, payload] });
        await tx.execute({ sql: `INSERT OR IGNORE INTO research_notifications(id,kind,incident_key,payload_json,created_at)
          VALUES (?,'technical_error',?,?,?)`, args: [`incident:${incident.key}:${generation}`, incident.key, payload, timestamp] });
      }
      for (const prior of existing.rows) if (prior.state === 'OPEN' && !keys.has(String(prior.incident_key))) {
        await tx.execute({ sql: `UPDATE research_monitor_incidents SET state='RESOLVED',resolved_at=? WHERE incident_key=? AND state='OPEN'`,
          args: [timestamp, prior.incident_key] });
      }
      await tx.commit();
    } catch (error) { await tx.rollback().catch(() => undefined); throw error; }
    finally { tx.close(); }
  }

  async saveDailySummary(day: string, summary: Row, now: string | Date): Promise<void> {
    await this.ready();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('Invalid summary day');
    await this.client.execute({ sql: `INSERT OR IGNORE INTO research_notifications(id,kind,incident_key,payload_json,created_at)
      VALUES (?,'daily_summary',NULL,?,?)`, args: [`daily:${day}`, JSON.stringify({ title: `Riepilogo virtuale ${day}`,
      message: 'Portafogli A e C indipendenti; importi esclusivamente virtuali.', day, ...summary }), iso(now)] });
  }

  async read(): Promise<{ notifications: Row[]; incidents: Row[] }> {
    await this.ready();
    const [notifications, incidents] = await Promise.all([
      this.client.execute('SELECT * FROM research_notifications ORDER BY created_at DESC,id DESC LIMIT 100'),
      this.client.execute("SELECT * FROM research_monitor_incidents WHERE state='OPEN' ORDER BY opened_at"),
    ]);
    return { notifications: notifications.rows.map((row) => ({ id: row.id, kind: row.kind, createdAt: row.created_at,
      ...JSON.parse(String(row.payload_json)) })), incidents: incidents.rows.map((row) => ({ key: row.incident_key,
      openedAt: row.opened_at, lastSeenAt: row.last_seen_at, ...JSON.parse(String(row.details_json)) })) };
  }
}

/** Accounting is derived independently for each portfolio; opening capital is not profit. */
export function researchDailySummary(day: string, portfolios: Row[], bets: Row[], ledger: Row[]): Row {
  return { timezone: 'Europe/Rome', portfolios: portfolios.filter((portfolio) => ['shadow_A', 'shadow_C'].includes(portfolio.id)).map((portfolio) => {
    const own = ledger.filter((row) => row.portfolioId === portfolio.id);
    const before = own.filter((row) => romeDay(row.createdAt) < day);
    const during = own.filter((row) => onDay(row.createdAt, day));
    const sum = (rows: Row[], field: string) => rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
    const equity = (rows: Row[]) => sum(rows, 'availableDeltaCents') + sum(rows, 'committedDeltaCents');
    const settlements = during.filter((row) => row.event === 'SETTLE');
    const initialCapitalCents = equity(during.filter((row) => row.event === 'OPEN'));
    return { portfolioId: portfolio.id, family: portfolio.family,
      registeredBets: bets.filter((bet) => bet.portfolioId === portfolio.id && onDay(bet.placedAt, day)).length,
      settledBets: bets.filter((bet) => bet.portfolioId === portfolio.id && onDay(bet.settledAt, day)).length,
      profitCents: equity(settlements), portfolioDeltaCents: equity(during) - initialCapitalCents,
      openingCapitalCents: initialCapitalCents, startEquityCents: equity(before), endEquityCents: equity([...before, ...during]),
      endAvailableCents: sum([...before, ...during], 'availableDeltaCents'),
      endCommittedCents: sum([...before, ...during], 'committedDeltaCents') };
  }) };
}

export function researchCriticalIncidents(input: { now: string; schedulerEnabled: boolean; runs: Row[]; models: Row[];
  markets: Row[]; jobs: Row[]; portfolios: Row[]; bets: Row[]; ledger: Row[] }): ResearchIncident[] {
  const incidents: ResearchIncident[] = [];
  const now = Date.parse(input.now);
  if (input.schedulerEnabled) {
    const heartbeat = input.runs.find((run) => run.schedulerName === 'research_t15' && run.endedAt);
    if (!heartbeat || !Number.isFinite(Date.parse(heartbeat.endedAt)) || Date.parse(heartbeat.endedAt) > now
      || now - Date.parse(heartbeat.endedAt) > 180000) incidents.push({ key: 'scheduler_heartbeat_missing',
      title: 'Scheduler T−15 non raggiungibile', message: 'Heartbeat assente da oltre tre minuti o mai registrato. Nessuna garanzia sulle decisioni imminenti.' });
    const validated = input.markets.some((market) => ['SHADOW', 'ACTIVE'].includes(market.state)
      && input.models.some((model) => model.family === market.family && model.version === market.modelVersion));
    if (!validated) incidents.push({ key: 'no_validated_model', title: 'Nessun modello validato utilizzabile',
      message: 'Nessun mercato con modello registrato è ammesso alle puntate prospettiche.' });
    const missed = input.jobs.filter((job) => job.status === 'MISSED' && now - Date.parse(job.targetAt) <= 3600000);
    if (missed.length) incidents.push({ key: 'scheduler_missed_decisions', title: 'Decisioni T−15 mancate',
      message: 'Una o più finestre decisionali sono trascorse senza una registrazione ammessa.', details: { count: missed.length } });
  }
  for (const [component, label] of [['research_t15', 'Scheduler T−15'], ['research_settlement', 'Liquidazione virtuale'],
    ['research_model_check', 'Inferenza del modello'], ['research_provider', 'Fonte essenziale']] as const) {
    const groups = new Map<string, Row[]>();
    const observed = input.runs.filter((run) => run.schedulerName === component && run.endedAt
      && Date.parse(run.endedAt) <= now && now - Date.parse(run.endedAt) <= 3600000)
      .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
    for (const run of observed) {
      // An A success or a different candidate/provider cannot clear the failing
      // model version or competition's incident.
      const scope = component === 'research_model_check' && run.summary?.family && run.summary?.modelVersion
        ? `${run.summary.family}:${run.summary.modelVersion}`
        : component === 'research_provider' && run.summary?.provider && run.summary?.competition
          ? `${run.summary.provider}:${run.summary.competition}` : '';
      const group = groups.get(scope) ?? []; group.push(run); groups.set(scope, group);
    }
    for (const [scope, group] of groups) {
      const recent = group.slice(0, 3);
      if (recent.length === 3 && recent.every((run) => run.success === false)) incidents.push({ key: `${component}_repeated_failure${scope ? `:${scope}` : ''}`,
        title: `${label}${scope ? ` (${scope})` : ''}: errori ripetuti`,
        message: 'Le ultime tre esecuzioni osservate nell’ultima ora sono fallite.', details: { failures: 3, ...(scope ? { scope } : {}) } });
    }
  }
  const failures: string[] = [];
  for (const portfolio of input.portfolios) {
    const own = input.ledger.filter((row) => row.portfolioId === portfolio.id);
    const available = own.reduce((sum, row) => sum + Number(row.availableDeltaCents), 0);
    const committed = own.reduce((sum, row) => sum + Number(row.committedDeltaCents), 0);
    if (available < 0 || committed < 0 || available !== portfolio.availableCents || committed !== portfolio.committedCents
      || available + committed !== portfolio.equityCents || own.filter((row) => row.event === 'OPEN').length !== 1) failures.push(portfolio.id);
    const ownBets = input.bets.filter((bet) => bet.portfolioId === portfolio.id);
    if (new Set(ownBets.map((bet) => bet.matchId)).size !== ownBets.length) failures.push(`${portfolio.id}:duplicate_match`);
    const openStakes = ownBets.filter((bet) => bet.status === 'PENDING').reduce((sum, bet) => sum + bet.stakeCents, 0);
    if (openStakes !== committed) failures.push(`${portfolio.id}:committed`);
    for (const bet of ownBets) {
      const stake = own.filter((row) => row.betId === bet.id && row.event === 'STAKE');
      if (stake.length !== 1 || stake[0].availableDeltaCents !== -bet.stakeCents || stake[0].committedDeltaCents !== bet.stakeCents) failures.push(`${portfolio.id}:stake`);
      const settlement = own.filter((row) => row.betId === bet.id && row.event === 'SETTLE');
      if (bet.status === 'SETTLED' && (settlement.length !== 1 || settlement[0].availableDeltaCents !== bet.returnCents
        || settlement[0].committedDeltaCents !== -bet.stakeCents)) failures.push(`${portfolio.id}:settlement`);
      if (bet.status === 'PENDING' && settlement.length) failures.push(`${portfolio.id}:pending_settled`);
    }
  }
  if (failures.length) incidents.push({ key: 'virtual_accounting_integrity', title: 'Integrità del registro virtuale da verificare',
    message: 'La ricostruzione dei movimenti ha rilevato un’incoerenza contabile.', details: { failures: [...new Set(failures)] } });
  return incidents;
}

export async function reconcileResearchMonitoring(db: MonitoringDb, now: string | Date = new Date(),
  options: { schedulerEnabled?: boolean } = {}): Promise<void> {
  const timestamp = iso(now);
  const namedRuns = db.listRecentSchedulerRunsByName
    ? Promise.all(['research_t15', 'research_settlement', 'research_model_check', 'research_provider']
      .map((name) => db.listRecentSchedulerRunsByName!(name, 10))).then((groups) => groups.flat())
    : db.listRecentSchedulerRuns(50);
  const [runs, models, markets, jobs, portfolios, bets, ledger] = await Promise.all([
    namedRuns, db.research.getModels(), db.research.listMarkets(), db.research.listJobs(),
    db.research.listPortfolios(), db.research.listBets(), db.research.listLedger(),
  ]);
  // The ledger is append-only. A changed second read means the independent
  // accounting reads straddled a commit; defer that integrity check until stable.
  const afterLedger = await db.research.listLedger();
  const stableAccounting = JSON.stringify(ledger) === JSON.stringify(afterLedger);
  const incidents = researchCriticalIncidents({ now: timestamp,
    schedulerEnabled: options.schedulerEnabled ?? process.env.RESEARCH_T15_SCHEDULER_ENABLED === 'true',
    runs, models, markets, jobs, portfolios: stableAccounting ? portfolios : [], bets, ledger });
  if (!stableAccounting) {
    const prior = (await db.researchMonitoring.read()).incidents.find((incident) => incident.key === 'virtual_accounting_integrity');
    if (prior) incidents.push({ key: prior.key, title: prior.title, message: prior.message, details: prior.details });
  }
  await db.researchMonitoring.reconcile(incidents, timestamp);
  const day = previousDay(romeDay(timestamp));
  const summary = researchDailySummary(day, portfolios, bets, ledger);
  // Publish yesterday's summary on the first stable reconciliation at or after 09:00 Rome.
  if (stableAccounting && summary.portfolios.length && Number(summaryHour.format(new Date(timestamp))) >= 9) {
    await db.researchMonitoring.saveDailySummary(day, summary, timestamp);
  }
}

/** Safe for GET: no alerts, summaries, bankrolls or jobs are created by reading. */
export async function readResearchMonitoring(db: Pick<DatabaseService, 'researchMonitoring'>): Promise<Row> {
  const stored = await db.researchMonitoring.read();
  return { ...stored, dailySummary: stored.notifications.find((row) => row.kind === 'daily_summary') ?? null,
    delivery: { channel: 'in_app', externalConfigured: false,
      blocker: 'Notifiche esterne non configurate: un processo remoto fermo richiede un controllo indipendente per avvisare fuori dall’app.' } };
}
