import type { Client } from '@libsql/client';
import type { DatabaseService } from '../db/DatabaseService';
import { researchHash } from './ResearchStore';
import { paperSelectionKey } from './PaperBetSelections';
import { isFundedPolicy } from './ResearchRecommendationPolicy';

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

export const NIGHTLY_GRACE_SECONDS = 4 * 60 * 60;

export const inspectPaperAccounting = (client: Pick<Client, 'execute'>) => inspectAutomaticAccounting(client, false);
export const inspectFundedAccounting = (client: Pick<Client, 'execute'>) => inspectAutomaticAccounting(client, true);

/** Independent SELECT-only audit of immutable automatic placements and their authorization. */
async function inspectAutomaticAccounting(client: Pick<Client, 'execute'>, funded: boolean): Promise<{
  schemaPresent: boolean; required: boolean; stable: boolean; checked: boolean;
  errors: number | null; failures: string[]; pendingSettlements: number;
}> {
  const prefix = funded ? 'funded' : 'paper', betsTable = `${prefix}_model_bets`, settlementsTable = `${prefix}_model_settlements`;
  const policyVersion = funded ? 'funded-confidence-v1' : 'paper-fixed-unit-v1';
  const inventory = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('paper_model_bets','paper_model_settlements','paper_model_bet_cancellations','funded_model_bets','funded_model_settlements','research_execution_policies','research_execution_decisions','research_execution_inputs','research_execution_jobs','research_decisions','research_ledger','matches')");
  const tables = new Set(inventory.rows.map(row => String(row.name)));
  const policies = tables.has('research_execution_policies')
    ? await client.execute({ sql: 'SELECT COUNT(*) AS count FROM research_execution_policies WHERE version=?', args: [policyVersion] }) : null;
  const required = Number(policies?.rows[0]?.count ?? 0) > 0 || tables.has(betsTable) || tables.has(settlementsTable);
  const schemaPresent = [betsTable, settlementsTable, ...(funded ? ['paper_model_bet_cancellations'] : [])].every(table => tables.has(table));
  if (!schemaPresent) return { schemaPresent, required, stable: true, checked: required, errors: required ? 1 : 0,
    failures: required ? [`${prefix}_schema_required`] : [], pendingSettlements: 0 };
  if (!['research_execution_policies', 'research_execution_decisions', 'research_execution_inputs', 'research_execution_jobs', 'research_decisions', ...(funded ? ['research_ledger'] : [])].every(table => tables.has(table))) {
    return { schemaPresent, required: true, stable: true, checked: true, errors: 1, failures: [`${prefix}_authorization_schema_missing`], pendingSettlements: 0 };
  }
  const fingerprint = () => client.execute(`SELECT
    (SELECT COUNT(*) FROM ${betsTable}) AS bets,(SELECT MAX(rowid) FROM ${betsTable}) AS last_bet,
    (SELECT COUNT(*) FROM ${settlementsTable}) AS settlements,(SELECT MAX(rowid) FROM ${settlementsTable}) AS last_settlement
    ${funded ? ',(SELECT COUNT(*) FROM research_ledger) AS ledger,(SELECT MAX(rowid) FROM research_ledger) AS last_ledger' : ''}
    ${!funded && tables.has('paper_model_bet_cancellations') ? ',(SELECT COUNT(*) FROM paper_model_bet_cancellations) AS cancellations' : ''}`);
  const before = await fingerprint();
  const [bets, authorizations, settlements, pending, ledger] = await Promise.all([
    client.execute(`SELECT * FROM ${betsTable}`),
    client.execute(`SELECT d.id AS authorized_id,d.family AS authorized_family,d.model_version AS authorized_version,
      d.action AS authorized_action,d.snapshot_json AS authorized_snapshot,d.origin_decision_id AS authorized_origin,
      d.input_id AS authorized_input,d.portfolio_id AS authorized_portfolio,i.id AS execution_input_id,
      i.origin_input_id AS execution_origin,i.input_hash AS execution_input_hash,i.snapshot_json AS execution_snapshot,
      j.match_id AS authorized_match,j.policy_hash AS authorized_policy,p.version AS policy_version,p.descriptor_json AS policy_descriptor,
      origin.id AS scientific_origin,origin.input_id AS scientific_input,origin.family AS scientific_family,origin.portfolio_id AS scientific_portfolio
      FROM research_execution_decisions d LEFT JOIN research_execution_inputs i ON i.id=d.input_id
      LEFT JOIN research_execution_jobs j ON j.id=i.job_id LEFT JOIN research_execution_policies p ON p.hash=j.policy_hash
      LEFT JOIN research_decisions origin ON origin.id=d.origin_decision_id
      WHERE EXISTS(SELECT 1 FROM ${betsTable} b WHERE b.execution_decision_id=d.id)`),
    client.execute(`SELECT s.*,b.id AS existing_bet,b.odds AS bet_odds,b.stake_cents AS bet_stake FROM ${settlementsTable} s LEFT JOIN ${betsTable} b ON b.id=s.bet_id`),
    tables.has('matches') ? client.execute(`SELECT COUNT(DISTINCT b.id) AS count FROM ${betsTable} b
      LEFT JOIN ${settlementsTable} s ON s.bet_id=b.id JOIN matches m ON m.match_id=b.match_id
      WHERE s.bet_id IS NULL AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
      ${!funded && tables.has('paper_model_bet_cancellations') ? 'AND NOT EXISTS(SELECT 1 FROM paper_model_bet_cancellations c WHERE c.bet_id=b.id)' : ''}`) : Promise.resolve({ rows: [] }),
    funded ? client.execute(`SELECT * FROM research_ledger WHERE id LIKE 'stake:funded:%' OR id LIKE 'settle:funded:%'
      OR bet_id IN (SELECT id FROM funded_model_bets)`) : Promise.resolve({ rows: [] }),
  ]);
  const failures: string[] = [], identities = new Set<string>(), settledIds = new Set<string>();
  const parse = (value: unknown): Row | null => {
    try { const parsed = JSON.parse(String(value)); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
    catch { return null; }
  };
  const authorizationById = new Map(authorizations.rows.map(row => {
    const parent = parse(row.authorized_snapshot), input = parse(row.execution_snapshot), policy = parse(row.policy_descriptor);
    return [String(row.authorized_id), { row, parent, input, policy,
      approved: new Map((Array.isArray(parent?.selections) ? parent.selections : []).filter((child: any) => child && typeof child === 'object')
        .map((child: Row) => [child.selectionKey, child])),
      quoteHashes: new Set((Array.isArray(input?.quotes) ? input.quotes : []).map((quote: any) => researchHash(quote))),
      inputHashValid: !!input && researchHash(input) === row.execution_input_hash,
      policyHash: policy ? researchHash(policy) : null }];
  }));
  for (const raw of bets.rows) {
    const authorization = authorizationById.get(String(raw.execution_decision_id)), row = { ...raw, ...authorization?.row };
    const id = String(row.id), snapshot = parse(row.snapshot_json), parent = authorization?.parent, input = authorization?.input, policy = authorization?.policy;
    const quote = snapshot?.quote, key = JSON.stringify([row.family, row.match_id, row.selection_key]);
    if (identities.has(key)) failures.push(`${id}:duplicate_selection`); identities.add(key);
    const stake = Number(row.stake_cents), percent = Number(row.stake_percent), base = Number(row.base_available_cents);
    const confidencePercent = { LOW: 1, MEDIUM: 3, HIGH: 5 }[String(row.confidence) as 'LOW' | 'MEDIUM' | 'HIGH'];
    if (!Number.isSafeInteger(stake) || (funded ? !id.startsWith('funded:') || stake <= 0 || !Number.isSafeInteger(base)
      || base <= 0 || percent !== confidencePercent || stake !== Math.floor(base * percent / 100) : stake !== 100)) failures.push(`${id}:stake`);
    if (!row.authorized_id || !row.execution_input_id || !row.scientific_origin || row.authorized_action !== 'BET'
      || row.authorized_family !== row.family || row.authorized_version !== row.model_version
      || row.authorized_origin !== row.origin_decision_id || row.authorized_input !== row.input_id
      || row.authorized_match !== row.match_id || row.authorized_policy !== row.policy_hash
      || row.scientific_family !== row.family || row.authorized_portfolio !== `shadow_${row.family}`
      || row.scientific_portfolio !== `shadow_${row.family}` || row.scientific_input !== row.execution_origin
      || row.policy_version !== policyVersion || funded && row.portfolio_id !== `shadow_${row.family}`) failures.push(`${id}:authorization`);
    const approved: Row = authorization?.approved.get(row.selection_key) as Row;
    const validQuote = quote && quote.source === 'odds_api' && quote.usedSyntheticOdds !== true
      && quote.priceType === 'prematch' && quote.timestampEvidence !== 'observed_snapshot'
      && typeof quote.bookmaker === 'string' && !!quote.bookmaker.trim() && Number.isFinite(quote.odds) && quote.odds > 1;
    if (!snapshot || !parent || !input || !policy || !validQuote || !approved
      || !approved.quote || typeof approved.quote !== 'object'
      || policy.virtualOnly !== true || (funded ? !isFundedPolicy(policy)
        : policy.fixedStakeUnits !== 1 || policy.stakeModeA !== 'PAPER_FIXED_UNIT' || policy.stakeModeC !== 'PAPER_FIXED_UNIT')
      || Number(row.odds) !== quote.odds || row.market !== snapshot.market || row.selection !== snapshot.selection
      || row.market !== quote.market || row.selection !== quote.selection || row.selection_key !== paperSelectionKey(quote)
      || (funded ? snapshot.stakeMode !== 'CONFIDENCE_PERCENT_AVAILABLE' || parent.stakeMode !== 'CONFIDENCE_PERCENT_AVAILABLE'
        || snapshot.stakeCents !== stake || approved.stakeCents !== stake || snapshot.stakePercent !== percent || approved.stakePercent !== percent
        || snapshot.baseAvailableCents !== base || approved.baseAvailableCents !== base || snapshot.confidence !== row.confidence
        || approved.confidence !== row.confidence : snapshot.stakeMode !== 'PAPER_FIXED_UNIT' || snapshot.stakeCents !== 100 || snapshot.stakeUnits !== 1
        || parent.stakeMode !== 'PAPER_FIXED_UNIT') || snapshot.effectiveExecutionDecisionId !== row.execution_decision_id
      || snapshot.originDecisionId !== row.origin_decision_id || snapshot.inputId !== row.input_id || snapshot.matchId !== row.match_id
      || snapshot.family !== row.family || snapshot.modelVersion !== row.model_version || snapshot.policyHash !== row.policy_hash
      || approved.market !== row.market || approved.selection !== row.selection || researchHash(approved.quote) !== researchHash(quote)
      || authorization.policyHash !== row.policy_hash || !authorization.inputHashValid
      || !Number.isFinite(snapshot.probability) || snapshot.probability <= 0 || snapshot.probability >= 1
      || !Number.isFinite(snapshot.ev) || snapshot.ev <= 0 || snapshot.probability !== approved.probability || snapshot.ev !== approved.ev
      || !snapshot.probabilityConfiguration || snapshot.probabilityConfiguration.family !== row.family
      || researchHash(snapshot.probabilityConfiguration) !== snapshot.probabilityConfigurationHash
      || snapshot.probabilityConfigurationHash !== parent.probabilityConfigurationHash) failures.push(`${id}:evidence`);
    const placed = Date.parse(String(row.placed_at)), observed = Date.parse(String(input?.observedAt)), kickoff = Date.parse(String(snapshot?.kickoffAt));
    if (![placed, observed, kickoff].every(Number.isFinite) || observed > placed || placed >= kickoff
      || ![quote?.capturedAt, quote?.updatedAt].every(value => {
        const at = typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;
        return Number.isFinite(at) && at <= observed && at < kickoff && placed - at <= 300000;
      }) || !authorization?.quoteHashes.has(quote ? researchHash(quote) : '')) failures.push(`${id}:quote_evidence`);
  }
  for (const row of settlements.rows) {
    const id = String(row.bet_id), multiplier = Number(row.multiplier), odds = Number(row.bet_odds), evidence = parse(row.evidence_json);
    if (settledIds.has(id)) failures.push(`${id}:duplicate_settlement`); settledIds.add(id);
    if (!row.existing_bet) failures.push(`${id}:orphan_settlement`);
    if (!Number.isFinite(multiplier) || ![0, .5, 1, (odds + 1) / 2, odds].some(value => Math.abs(value - multiplier) < 1e-9)
      || !Number.isSafeInteger(Number(row.return_cents)) || Number(row.return_cents) !== Math.round(Number(row.bet_stake) * multiplier)
      || !evidence || !Object.keys(evidence).length || !Number.isFinite(Date.parse(String(row.settled_at)))) failures.push(`${id}:settlement`);
  }
  if (funded) {
    const betById = new Map(bets.rows.map(row => [String(row.id), row]));
    const settlementById = new Map(settlements.rows.map(row => [String(row.bet_id), row]));
    const linked = (movement: Row, id: string) => movement.bet_id === id
      || movement.id === `stake:${id}` || movement.id === `settle:${id}`;
    for (const bet of bets.rows) {
      const id = String(bet.id), movements = ledger.rows.filter(row => linked(row, id));
      const stakes = movements.filter(row => row.event === 'STAKE'), settled = movements.filter(row => row.event === 'SETTLE');
      const validMovement = (row: Row, event: string, available: number, committed: number) => row.id === `${event.toLowerCase()}:${id}`
        && row.bet_id == null && row.portfolio_id === bet.portfolio_id && Number(row.available_delta_cents) === available
        && Number(row.committed_delta_cents) === committed;
      if (stakes.length !== 1 || !validMovement(stakes[0], 'STAKE', -Number(bet.stake_cents), Number(bet.stake_cents))) failures.push(`${id}:stake_ledger`);
      const settlement = settlementById.get(id);
      if (settlement ? settled.length !== 1 || !validMovement(settled[0], 'SETTLE', Number(settlement.return_cents), -Number(bet.stake_cents))
        : settled.length > 0) failures.push(`${id}:settlement_ledger`);
      if (movements.some(row => !['STAKE', 'SETTLE'].includes(String(row.event)))) failures.push(`${id}:ledger_event`);
    }
    for (const movement of ledger.rows) {
      const id = String(movement.id).replace(/^(?:stake|settle):/, '');
      if (!betById.has(id) || !linked(movement, id)) failures.push(`${String(movement.id)}:orphan_ledger`);
    }
  }
  const after = await fingerprint(), stable = JSON.stringify(before.rows) === JSON.stringify(after.rows);
  return { schemaPresent, required, stable, checked: stable, errors: stable ? failures.length : null,
    failures: stable ? failures : [], pendingSettlements: Number(pending.rows[0]?.count ?? 0) };
}

/** Europe/Rome 03:00 exists once even on DST transition days. */
export function nightlySchedule(now: string | Date, graceSeconds = NIGHTLY_GRACE_SECONDS): Row {
  const at = new Date(iso(now));
  const day = romeDay(at);
  const minute = Number(process.env.RESEARCH_NIGHTLY_MINUTE || 0);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Invalid RESEARCH_NIGHTLY_MINUTE');
  const minuteText = String(minute).padStart(2, '0');
  const onDayAtThree = (date: string): Date => {
    for (const hour of [1, 2]) {
      const candidate = new Date(`${date}T0${hour}:${minuteText}:00Z`);
      if (romeDay(candidate) === date && summaryHour.format(candidate) === '03') return candidate;
    }
    throw new Error('Nightly Rome schedule could not be resolved');
  };
  const today = onDayAtThree(day);
  const expected = at >= today ? today : onDayAtThree(previousDay(day));
  const nextDay = new Date(Date.parse(`${day}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const next = at < today ? today : onDayAtThree(nextDay);
  return { timezone: 'Europe/Rome', scheduledHour: `03:${minuteText}`, expectedAt: expected.toISOString(),
    nextAt: next.toISOString(), graceSeconds, overdue: at.getTime() > expected.getTime() + graceSeconds * 1000 };
}

export function researchNightlyStatus(runs: Row[], now: string | Date, enabled: boolean,
  graceSeconds = NIGHTLY_GRACE_SECONDS): Row {
  const schedule = nightlySchedule(now, graceSeconds);
  const timestamp = Date.parse(iso(now));
  const recent = runs.filter((run) => run.schedulerName === 'research_nightly'
    && Number.isFinite(Date.parse(run.startedAt)) && Date.parse(run.startedAt) <= timestamp)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const last = recent[0] ?? null;
  const current = recent.find((run) => Date.parse(run.startedAt) >= Date.parse(schedule.expectedAt));
  const overdue = enabled && schedule.overdue && !current;
  const state = !enabled ? 'DISABLED' : overdue ? 'MISSED' : current && !current.endedAt ? 'RUNNING'
    : current?.summary?.enabled === false ? 'DISABLED'
    : current ? current.success ? 'SUCCESS' : 'FAILED' : last ? 'PENDING' : 'NOT_OBSERVED';
  const summary = last?.summary ?? {};
  const measured = (key: string): number | null => Number.isFinite(summary[key]) ? summary[key] : null;
  return { ...schedule, overdue, state, executionEnabled: typeof summary.enabled === 'boolean' ? summary.enabled : null, lastRun: last ? { startedAt: last.startedAt, endedAt: last.endedAt ?? null,
    success: last.success, error: last.error ? 'nightly_failed' : null, summary } : null,
    metrics: { analyzedMatches: measured('analyzedMatches'), registeredBets: measured('registeredBets'),
      skippedMatches: measured('skippedMatches'), missedMatches: measured('missedMatches'), errors: measured('errors'),
      apiErrors: measured('apiErrors'), reasonCounts: summary.reasonCounts ?? null,
      settlement: summary.settlement ?? null, quota: summary.quota ?? null } };
}

/** One persistent notification per incident generation; polling/restarts do not resend it. */
export class ResearchMonitoringStore {
  constructor(private readonly client: Client, private readonly ready: () => Promise<void> = async () => {}) {}

  async auditPaperAccounting() { await this.ready(); return inspectPaperAccounting(this.client); }
  async auditFundedAccounting() { await this.ready(); return inspectFundedAccounting(this.client); }

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
  const nightly = researchNightlyStatus(input.runs, input.now, input.schedulerEnabled);
  if (nightly.overdue) incidents.push({ key: 'nightly_execution_missing', title: 'Nightly non osservata',
    message: `Non risulta una decisione notturna dopo le ${nightly.scheduledHour} Europe/Rome e il margine di quattro ore.`,
    details: { expectedAt: nightly.expectedAt, graceSeconds: nightly.graceSeconds } });
  if (input.schedulerEnabled && nightly.lastRun && nightly.lastRun.success === false
    && now - Date.parse(nightly.lastRun.startedAt) <= 36 * 3600000) incidents.push({ key: 'nightly_execution_failed',
    title: 'Elaborazione notturna fallita', message: 'L’ultima elaborazione A/C ha segnalato un errore tecnico. Consultare il run GitHub.' });
  if (input.schedulerEnabled && nightly.lastRun && nightly.state === 'DISABLED') incidents.push({ key: 'nightly_registration_disabled',
    title: 'Registrazione notturna non abilitata nel run', message: 'La configurazione attesa richiede puntate virtuali, ma il run osservato dichiara la registrazione disabilitata.' });
  if (input.schedulerEnabled && nightly.metrics.apiErrors >= 3) incidents.push({ key: 'nightly_api_errors',
    title: 'Errori ripetuti delle fonti', message: 'L’elaborazione notturna ha osservato almeno tre errori API.' });
  const quota = nightly.metrics.quota;
  const remaining = quota?.availableCredits ?? quota?.remaining ?? quota?.requestsRemaining;
  if (input.schedulerEnabled && typeof remaining === 'number' && remaining <= 0) incidents.push({ key: 'nightly_odds_credits_exhausted',
    title: 'Crediti quote esauriti', message: 'La disponibilità misurata non consente nuove acquisizioni: le partite prive di quote saranno saltate.' });
  for (const [component, label] of [['research_settlement', 'Liquidazione virtuale'],
    ['research_model_check', 'Inferenza del modello'], ['research_provider', 'Fonte essenziale']] as const) {
    if (component !== 'research_settlement' && !input.schedulerEnabled) continue;
    const groups = new Map<string, Row[]>();
    const observed = input.runs.filter((run) => run.schedulerName === component && run.endedAt
      && Date.parse(run.endedAt) <= now && now - Date.parse(run.endedAt) <= 36 * 3600000)
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
        message: 'Le ultime tre esecuzioni osservate nelle ultime 36 ore sono fallite.', details: { failures: 3, ...(scope ? { scope } : {}) } });
    }
  }
  const failures: string[] = [];
  for (const portfolio of input.portfolios) {
    const own = input.ledger.filter((row) => row.portfolioId === portfolio.id);
    const ownBets = input.bets.filter((bet) => bet.portfolioId === portfolio.id);
    if (!own.length && !ownBets.length) continue;
    const available = own.reduce((sum, row) => sum + Number(row.availableDeltaCents), 0);
    const committed = own.reduce((sum, row) => sum + Number(row.committedDeltaCents), 0);
    if (available < 0 || committed < 0 || available !== portfolio.availableCents || committed !== portfolio.committedCents
      || available + committed !== portfolio.equityCents || own.filter((row) => row.event === 'OPEN').length !== 1) failures.push(portfolio.id);
    const legacyBets = ownBets.filter(bet => !String(bet.id).startsWith('funded:'));
    if (new Set(legacyBets.map((bet) => bet.matchId)).size !== legacyBets.length) failures.push(`${portfolio.id}:duplicate_match`);
    const openStakes = ownBets.filter((bet) => bet.status === 'PENDING').reduce((sum, bet) => sum + bet.stakeCents, 0);
    if (openStakes !== committed) failures.push(`${portfolio.id}:committed`);
    for (const bet of ownBets) {
      const linked = (row: Row, event: string) => row.betId === bet.id || ['manual:', 'funded:'].some(prefix => String(bet.id).startsWith(prefix))
        && row.betId == null && row.id === `${event.toLowerCase()}:${bet.id}`;
      const stake = own.filter((row) => linked(row, 'STAKE') && row.event === 'STAKE');
      if (stake.length !== 1 || stake[0].availableDeltaCents !== -bet.stakeCents || stake[0].committedDeltaCents !== bet.stakeCents) failures.push(`${portfolio.id}:stake`);
      const settlement = own.filter((row) => linked(row, 'SETTLE') && row.event === 'SETTLE');
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
    ? Promise.all(['research_nightly', 'research_settlement', 'research_model_check', 'research_provider']
      .map((name) => db.listRecentSchedulerRunsByName!(name, 10))).then((groups) => groups.flat())
    : db.listRecentSchedulerRuns(50);
  const [runs, portfolios, bets, ledger, paper, funded] = await Promise.all([
    namedRuns, db.research.listPortfolios(), db.research.listBets(), db.research.listLedger(),
    db.researchMonitoring.auditPaperAccounting(), db.researchMonitoring.auditFundedAccounting(),
  ]);
  // The ledger is append-only. A changed second read means the independent
  // accounting reads straddled a commit; defer that integrity check until stable.
  const afterLedger = await db.research.listLedger();
  const stableAccounting = JSON.stringify(ledger) === JSON.stringify(afterLedger);
  const incidents = researchCriticalIncidents({ now: timestamp,
    schedulerEnabled: options.schedulerEnabled ?? process.env.RESEARCH_NIGHTLY_ENABLED === 'true',
    runs, models: [], markets: [], jobs: [], portfolios: stableAccounting ? portfolios : [], bets, ledger });
  if (!stableAccounting) {
    const prior = (await db.researchMonitoring.read()).incidents.find((incident) => incident.key === 'virtual_accounting_integrity');
    if (prior) incidents.push({ key: prior.key, title: prior.title, message: prior.message, details: prior.details });
  }
  if (paper.stable && paper.errors) incidents.push({
    key: paper.failures.includes('paper_schema_required') ? 'paper_schema_required' : 'paper_accounting_integrity',
    title: 'Integrità delle giocate paper da verificare',
    message: 'Le giocate a unità fissa hanno evidenza o contabilità incoerente.', details: { failures: paper.failures },
  });
  if (!paper.stable) {
    const prior = (await db.researchMonitoring.read()).incidents.filter(incident => ['paper_schema_required', 'paper_accounting_integrity'].includes(incident.key));
    for (const incident of prior) incidents.push({ key: incident.key, title: incident.title, message: incident.message, details: incident.details });
  }
  if (funded.stable && funded.errors) incidents.push({
    key: funded.failures.includes('funded_schema_required') ? 'funded_schema_required' : 'funded_accounting_integrity',
    title: 'Integrità delle giocate virtuali da verificare',
    message: 'Le giocate con stake da confidenza hanno evidenza o movimenti incoerenti.', details: { failures: funded.failures },
  });
  if (!funded.stable) {
    const prior = (await db.researchMonitoring.read()).incidents.filter(incident => ['funded_schema_required', 'funded_accounting_integrity'].includes(incident.key));
    for (const incident of prior) incidents.push({ key: incident.key, title: incident.title, message: incident.message, details: incident.details });
  }
  await db.researchMonitoring.reconcile(incidents, timestamp);
  const day = previousDay(romeDay(timestamp));
  const fundedPortfolios = portfolios.filter(portfolio => ledger.some(row => row.portfolioId === portfolio.id)
    || bets.some(bet => bet.portfolioId === portfolio.id));
  const summary: Row = { ...researchDailySummary(day, fundedPortfolios, bets, ledger),
    nightly: researchNightlyStatus(runs, timestamp, options.schedulerEnabled ?? process.env.RESEARCH_NIGHTLY_ENABLED === 'true') };
  // Prepare at 03:00, expose only after 09:00 Rome; this is not external delivery.
  const today = romeDay(timestamp);
  const publishAfter = [7, 8].map((hour) => new Date(`${today}T0${hour}:00:00Z`))
    .find((at) => romeDay(at) === today && summaryHour.format(at) === '09')!.toISOString();
  const futureEvidence = ledger.some((row) => Date.parse(row.createdAt) > Date.parse(timestamp))
    || bets.some((row) => Date.parse(row.placedAt) > Date.parse(timestamp) || Date.parse(row.settledAt) > Date.parse(timestamp));
  if (stableAccounting && summary.portfolios.length && !futureEvidence) {
    await db.researchMonitoring.saveDailySummary(day, { ...summary, publishAfter }, timestamp);
  }
}

/** Safe for GET: no alerts, summaries, bankrolls or jobs are created by reading. */
export async function readResearchMonitoring(db: Pick<DatabaseService, 'researchMonitoring'>, now: string | Date = new Date()): Promise<Row> {
  const stored = await db.researchMonitoring.read();
  const notifications = stored.notifications.filter((row) => row.kind !== 'daily_summary' || !row.publishAfter
    || Number.isFinite(Date.parse(row.publishAfter)) && Date.parse(row.publishAfter) <= Date.parse(iso(now)));
  return { ...stored, notifications, dailySummary: notifications.find((row) => row.kind === 'daily_summary') ?? null,
    delivery: { channel: 'in_app', externalConfigured: false,
      blocker: 'Notifiche esterne non configurate: la mancata nightly richiede un controllo indipendente; nessun invio esterno è confermato.' } };
}
