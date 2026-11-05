import type { Client, InValue } from '@libsql/client';
import { createHash } from 'node:crypto';

// The same pure policy is consumed by the local operator CLI and Node 20 runner.
const { evaluate, parseCollectionPerformance, measureCollectionRecorderOutcomes } = require('../../scripts/model-a-prospective-alerts');
const { measureResults } = require('../../scripts/model-a-prospective-result-monitoring');
const HOUR = 3600000;
const TOP_FIVE = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
type Row = Record<string, any>;
export type ModelAMonitoringOptions = { protocolId: string; manifestSha256: string; cutoff?: string;
  competition?: string; season?: string; maxLivenessAgeHours?: number; maxPendingAgeHours?: number;
  resultGraceHours?: number; resultHorizonDays?: number; requireRigorousInputs?: boolean };
type QueryClient = Pick<Client, 'execute'>;
const utc = (value: unknown): number | null => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const pair = (id: unknown, at: unknown) => JSON.stringify([String(id), at]);
const marks = (values: unknown[]) => values.map(() => '?').join(',');

/** Raw libSQL reads only. No application DB bootstrap, schema writes or provider calls. */
export async function readModelAProspectiveMonitoring(client: QueryClient, options: ModelAMonitoringOptions) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.protocolId ?? '') || !/^[a-f0-9]{64}$/.test(options.manifestSha256 ?? '')) throw new Error('monitoring_scope_invalid');
  const cutoff = options.cutoff ?? new Date().toISOString(), at = utc(cutoff);
  if (at === null) throw new Error('monitoring_cutoff_invalid');
  const query = async (sql: string, args: InValue[] = []): Promise<Row[]> => {
    // Keep this invariant even if future query helpers are added to this module.
    if (!/^SELECT\s/i.test(sql)) throw new Error('monitoring_select_only');
    try { return (await client.execute({ sql, args })).rows as Row[]; }
    catch { throw new Error('monitoring_query_failed'); }
  };
  const objects = await query("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE tbl_name LIKE 'model_a_%' OR name='matches'");
  const columns: Record<string, string[]> = {
    matches: ['match_id', 'competition', 'season', 'date'],
    model_a_prospective_forecasts: ['id', 'match_id', 'forecast_at', 'kickoff_at', 'payload_json'],
    model_a_prospective_results: ['evidence_id', 'match_id', 'source', 'kickoff_at', 'observed_at', 'recorded_at', 'home_goals', 'away_goals'],
    model_a_collection_protocols: ['protocol_id', 'scope_json', 'created_at'],
    model_a_collection_ledger: ['protocol_id', 'match_id', 'kickoff_at', 'competition', 'season', 'state', 'reason', 'claim_at', 'forecast_id', 'claim_id', 'updated_at'],
    model_a_collection_runs: ['run_id', 'protocol_id', 'started_at', 'completed_at', 'status'],
    model_a_prospective_result_observations: ['match_id', 'kickoff_at', 'observed_at', 'recorded_at', 'status', 'reason'],
    model_a_prospective_result_refresh_state: ['refresh_id', 'last_started_at', 'last_completed_at', 'last_success_at', 'last_status', 'last_error_code'],
  };
  const tables: Record<string, { status: string; readable: boolean; performanceReadable?: boolean; recorderStatusReadable?: boolean }> = {}, issues: string[] = [];
  const primaryKeys: Record<string, string[]> = {
    matches: ['match_id'], model_a_prospective_forecasts: ['id'], model_a_prospective_results: ['evidence_id'],
    model_a_collection_protocols: ['protocol_id'], model_a_collection_ledger: ['protocol_id', 'match_id', 'kickoff_at'],
    model_a_collection_runs: ['run_id'], model_a_prospective_result_observations: ['evidence_id'],
    model_a_prospective_result_refresh_state: ['refresh_id'],
  };
  for (const [table, fields] of Object.entries(columns)) {
    let status = 'missing';
    if (objects.some(row => row.type === 'table' && row.name === table)) {
      try { await query(`SELECT ${fields.join(',')} FROM ${table} WHERE 0`); status = 'available'; }
      catch { status = 'incompatible'; }
    }
    tables[table] = { status, readable: status === 'available' };
    if (status !== 'available') issues.push(`${status}_table:${table}`);
    else {
      const metadata = await query('SELECT name,pk FROM pragma_table_info(?)', [table]);
      const actualKey = metadata.filter(row => Number(row.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map(row => String(row.name));
      if (actualKey.join(',') !== primaryKeys[table].join(',')) issues.push(`missing_or_incompatible_primary_key:${table}`);
      if (table === 'model_a_collection_runs') {
        tables[table].performanceReadable = metadata.some(row => row.name === 'performance_json');
        if (!tables[table].performanceReadable) {
          tables[table].status = 'incompatible';
          issues.push('missing_column:model_a_collection_runs.performance_json');
        }
      }
      if (table === 'model_a_collection_ledger') {
        const missing = ['recorder_status', 'recorder_reason'].filter(name => !metadata.some(row => row.name === name));
        tables[table].recorderStatusReadable = missing.length === 0;
        if (missing.length) {
          tables[table].status = 'incompatible';
          for (const name of missing) issues.push(`missing_column:model_a_collection_ledger.${name}`);
        }
      }
    }
  }
  for (const [table, index, last] of [['model_a_prospective_forecasts', 'idx_model_a_prospective_match', 'forecast_at'], ['model_a_prospective_results', 'idx_model_a_prospective_results_match', 'observed_at']]) {
    const indexSql = String(objects.find(row => row.type === 'index' && row.name === index && row.tbl_name === table)?.sql ?? '').replace(/\s+/g, ' ').trim();
    if (!new RegExp(`^CREATE INDEX (?:IF NOT EXISTS )?${index} ON ${table}\\s*\\(\\s*match_id\\s*,\\s*${last}\\s*\\)$`, 'i').test(indexSql)) issues.push(`missing_or_incompatible_index:${index}`);
    for (const operation of ['update', 'delete']) {
      const name = table === 'model_a_prospective_forecasts' ? `model_a_prospective_no_${operation}` : `model_a_prospective_results_no_${operation}`;
      const trigger = objects.find(row => row.type === 'trigger' && row.name === name && row.tbl_name === table);
      const sql = String(trigger?.sql ?? '').replace(/\s+/g, ' ').trim();
      const pattern = new RegExp(`^CREATE TRIGGER (?:IF NOT EXISTS )?${name} BEFORE ${operation} ON ${table} BEGIN SELECT RAISE\\(ABORT, '[^']+'\\); END$`, 'i');
      if (!pattern.test(sql)) issues.push(`missing_or_unverified_trigger:${name}`);
    }
  }
  const collector: Row = { requested: true, storageStatus: { ledger: tables.model_a_collection_ledger.status, runs: tables.model_a_collection_runs.status, protocols: tables.model_a_collection_protocols.status },
    registeredScopeMatches: false, analyzedFixtures: null, predictionStartedFixtures: null, eligibleFixtures: null, pendingFixtures: null,
    failedFixtures: null, storedFixtures: null, missedWindows: null, ledgerMissingFixtures: null, invalidKickoffObservations: null,
    kickoffChangedObservations: null, missingCalendarObservations: null, reasonCounts: null, lastRunStartedAt: null, lastSuccessfulRunAt: null,
    latestRunStatus: null, failedRuns: null, incompleteRuns: null, oldestPendingAt: null,
    performance: { status: 'no_completed_run', verified: false, reason: 'no_completed_run', metrics: null, runStartedAt: null, runCompletedAt: null, runStatus: null },
    ...measureCollectionRecorderOutcomes([], false) };
  const coverage: Row = { scope: { cutoff, origin: 'prospective_a' }, calendarEvaluable: false, coverageEvaluable: false,
    fixtureMatches: null, overdueFixtures: null, openWindowFixtures: null, futureWindowFixtures: null, overdueMissing: null,
    openWindowMissing: null, recordedForecasts: null, recordedMatchesInWindow: null, pendingUnconfirmedForecasts: null,
    nonEvaluableProvenance: null, temporalClassificationCounts: null, provenanceReasons: null, invalidFixtureTimesInCompetitionSeason: null };
  const results: Row = { evaluable: false, linkedForecasts: null, pendingForecasts: null, pendingKickoffs: [], oldestPendingKickoffAt: null,
    unassociatedResults: null, orphanForecasts: null, invalidResultRows: null, lifecycle: null, lifecycleReasons: null,
    lastLifecycleObservedAt: null, refreshRunLivenessVerified: false, lastRefreshStartedAt: null, lastRefreshCompletedAt: null,
    lastSuccessfulRefreshAt: null, latestRefreshStatus: null, refreshStateStorage: tables.model_a_prospective_result_refresh_state.status,
    lifecycleStorage: tables.model_a_prospective_result_observations.status };
  const report: Row = { schemaVersion: 'model-a-prospective-monitoring-v1', mode: 'configured_read_only', measuredAt: new Date().toISOString(),
    schema: { compatible: issues.length === 0, issues, tables, verification: 'select_only_structure_no_mutation_probe' }, collector, coverage, results,
    spool: { configured: false, readable: false },
    timeSemantics: { historicalSnapshot: false, observation: 'sequential_current_database_reads', databaseInsertionAsOfCutoffVerified: false },
    limitations: ['Database reads are sequential observations, not an atomic historical snapshot.',
      'SELECT-only metadata checks do not test write permissions, filesystem ACLs or storage durability.',
      'No spool filesystem is inspected in configured database mode; unavailable filesystem metrics are not zero backlog.',
      'Projected provenance classification does not verify a complete snapshot hash or source genealogy. Strict temporal eligibility remains unverified.',
      'Result pairing describes stored evidence, not official competition certification. Lifecycle timestamps alone do not prove refresh cycle liveness.'] };
  const finish = () => ({ report, monitoring: evaluate(report, options) });
  if (!tables.model_a_collection_protocols.readable) return finish();
  const registered = (await query('SELECT scope_json FROM model_a_collection_protocols WHERE protocol_id=?', [options.protocolId]))[0];
  let scope: Row;
  try {
    const manifest = JSON.parse(registered?.scope_json ?? 'null'); scope = manifest?.snapshot;
    const hash = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    if (manifest.sha256 !== hash || hash !== options.manifestSha256 || scope.protocolId !== options.protocolId || scope.origin !== 'prospective_a'
      || !Array.isArray(scope.competitions) || scope.competitions.length !== TOP_FIVE.length || !TOP_FIVE.every(name => scope.competitions.includes(name))
      || !Array.isArray(scope.seasons) || !scope.seasons.length || scope.seasons.some(value => typeof value !== 'string' || !value.trim())
      || utc(scope.from) === null || utc(scope.to) === null || utc(scope.from) >= utc(scope.to)) return finish();
  } catch { return finish(); }
  if ((options.competition && !scope.competitions.includes(options.competition)) || (options.season && !scope.seasons.includes(options.season))) throw new Error('monitoring_scope_mismatch');
  collector.registeredScopeMatches = true;
  const competitions: string[] = options.competition ? [options.competition] : scope.competitions;
  const seasons: string[] = options.season ? [options.season] : scope.seasons;
  Object.assign(coverage.scope, { kickoffFromInclusive: scope.from, kickoffToExclusive: scope.to, competitions, seasons, forecastWindowHoursBeforeKickoff: [24, 1] });
  if (tables.model_a_prospective_result_refresh_state.readable) {
    const state = (await query('SELECT last_started_at,last_completed_at,last_success_at,last_status FROM model_a_prospective_result_refresh_state WHERE refresh_id=?', ['understat-results-v1']))[0];
    if (state) Object.assign(results, { refreshRunLivenessVerified: true, lastRefreshStartedAt: utc(state.last_started_at) !== null && utc(state.last_started_at) <= at ? state.last_started_at : null,
      lastRefreshCompletedAt: utc(state.last_completed_at) !== null && utc(state.last_completed_at) <= at ? state.last_completed_at : null,
      lastSuccessfulRefreshAt: utc(state.last_success_at) !== null && utc(state.last_success_at) <= at ? state.last_success_at : null,
      latestRefreshStatus: state.last_status });
  }
  const filter = `competition IN (${marks(competitions)}) AND season IN (${marks(seasons)})`;
  const args = [...competitions, ...seasons];
  if (tables.model_a_collection_runs.readable) {
    const runs = await query('SELECT started_at,completed_at,status FROM model_a_collection_runs WHERE protocol_id=? AND julianday(started_at)<=julianday(?) ORDER BY julianday(started_at) DESC LIMIT 1000', [options.protocolId, cutoff]);
    collector.lastRunStartedAt = runs[0]?.started_at ?? null; collector.latestRunStatus = runs[0]?.status ?? null;
    collector.lastSuccessfulRunAt = runs.filter(row => row.status === 'success' && utc(row.completed_at) !== null && utc(row.completed_at) <= at)
      .map(row => row.completed_at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const totals = (await query(`SELECT SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,SUM(CASE WHEN status='started' OR completed_at IS NULL THEN 1 ELSE 0 END) AS incomplete FROM model_a_collection_runs WHERE protocol_id=? AND julianday(started_at)<=julianday(?)`, [options.protocolId, cutoff]))[0];
    collector.failedRuns = Number(totals?.failed ?? 0); collector.incompleteRuns = Number(totals?.incomplete ?? 0);
    if (tables.model_a_collection_runs.performanceReadable) {
      const completed = (await query(`SELECT started_at,completed_at,status,performance_json FROM model_a_collection_runs WHERE protocol_id=? AND status IN ('success','failed','interrupted') AND julianday(started_at)<=julianday(?) AND julianday(completed_at)<=julianday(?) ORDER BY julianday(completed_at) DESC,julianday(started_at) DESC,run_id DESC LIMIT 1`, [options.protocolId, cutoff, cutoff]))[0];
      if (completed && utc(completed.started_at) !== null && utc(completed.completed_at) !== null) collector.performance = {
        ...parseCollectionPerformance(completed.performance_json), runStartedAt: completed.started_at, runCompletedAt: completed.completed_at, runStatus: completed.status };
    } else collector.performance = { ...collector.performance, status: 'schema_unavailable', reason: 'performance_column_missing' };
  }
  if (!tables.matches.readable) return finish();
  const validKickoff = `(julianday(date) IS NOT NULL AND (UPPER(SUBSTR(date,-1))='Z' OR SUBSTR(date,-6) GLOB '[+-][0-9][0-9]:[0-9][0-9]'))`;
  const fixtures = await query(`SELECT match_id,date FROM matches WHERE ${filter} AND ${validKickoff} AND julianday(date)>=julianday(?) AND julianday(date)<julianday(?)`, [...args, scope.from, scope.to]);
  const invalid = (await query(`SELECT COUNT(*) AS n FROM matches WHERE ${filter} AND NOT COALESCE(${validKickoff},0)`, args))[0];
  const calendar = new Map<string, number>(fixtures.filter(row => utc(row.date) !== null).map(row => [String(row.match_id), utc(row.date)]));
  Object.assign(coverage, { calendarEvaluable: true, coverageEvaluable: tables.model_a_prospective_forecasts.readable && tables.model_a_collection_ledger.readable, fixtureMatches: calendar.size,
    invalidFixtureTimesInCompetitionSeason: Number(invalid?.n ?? 0), overdueFixtures: [...calendar.values()].filter(kickoff => at >= kickoff - HOUR).length,
    openWindowFixtures: [...calendar.values()].filter(kickoff => at >= kickoff - 24 * HOUR && at < kickoff - HOUR).length,
    futureWindowFixtures: [...calendar.values()].filter(kickoff => at < kickoff - 24 * HOUR).length });
  const ledgerExclusions: string[] = [];
  if (tables.model_a_collection_ledger.readable) {
    const receiptProjection = tables.model_a_collection_ledger.recorderStatusReadable ? ',recorder_status,recorder_reason' : '';
    const ledger = await query(`SELECT match_id,kickoff_at,state,reason,claim_at,updated_at${receiptProjection} FROM model_a_collection_ledger WHERE protocol_id=? AND ${filter} AND julianday(updated_at)<=julianday(?) AND julianday(kickoff_at)>=julianday(?) AND julianday(kickoff_at)<julianday(?)`, [options.protocolId, ...args, cutoff, scope.from, scope.to]);
    const current = ledger.filter(row => calendar.get(String(row.match_id)) === utc(row.kickoff_at));
    Object.assign(collector, measureCollectionRecorderOutcomes(current, tables.model_a_collection_ledger.recorderStatusReadable));
    for (const row of current) if (row.reason === 'cancelled_or_postponed') ledgerExclusions.push(pair(row.match_id, utc(row.kickoff_at)));
    const observed = new Set(current.map(row => String(row.match_id))), pending = current.filter(row => ['claimed', 'unconfirmed'].includes(row.state));
    const reasons: Row = {}; for (const row of current) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
    const pendingTimes = pending.map(row => utc(row.claim_at) ?? utc(row.updated_at)).filter(value => value !== null);
    Object.assign(collector, { analyzedFixtures: observed.size, predictionStartedFixtures: current.filter(row => utc(row.claim_at) !== null).length,
      eligibleFixtures: current.filter(row => utc(row.claim_at) !== null || row.reason === 'eligible').length, storedFixtures: current.filter(row => row.state === 'stored').length,
      pendingFixtures: pending.length, failedFixtures: current.filter(row => row.state === 'unconfirmed').length,
      missedWindows: current.filter(row => row.reason === 'window_expired').length,
      ledgerMissingFixtures: [...calendar].filter(([id, kickoff]) => at >= kickoff - 24 * HOUR && !observed.has(id)).length,
      invalidKickoffObservations: coverage.invalidFixtureTimesInCompetitionSeason, kickoffChangedObservations: ledger.filter(row => row.reason === 'kickoff_changed').length,
      missingCalendarObservations: ledger.filter(row => row.reason === 'fixture_missing_from_calendar').length,
      reasonCounts: reasons, oldestPendingAt: pendingTimes.length ? new Date(Math.min(...pendingTimes)).toISOString() : null });
  }
  if (!tables.model_a_prospective_forecasts.readable) return finish();
  if (!tables.model_a_collection_ledger.readable) return finish();
  const json = (field: string) => `CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.${field}') ELSE NULL END`;
  const forecasts = (await query(`SELECT id,match_id,forecast_at,kickoff_at,${json('id')} AS payload_id,${json('matchId')} AS payload_match_id,${json('forecastAt')} AS payload_at,${json('kickoffAt')} AS payload_kickoff,${json('schema')} AS payload_schema,${json('family')} AS family,${json('provenance.classification')} AS classification FROM model_a_prospective_forecasts WHERE ${json('origin')}='prospective_a' AND ${json('competition')} IN (${marks(competitions)}) AND ${json('season')} IN (${marks(seasons)}) AND julianday(forecast_at)<=julianday(?) AND julianday(kickoff_at)>=julianday(?) AND julianday(kickoff_at)<julianday(?) AND ${json('collection.protocolId')}=? AND ${json('collection.manifestSha256')}=? AND EXISTS (SELECT 1 FROM model_a_collection_ledger AS ledger WHERE ledger.protocol_id=? AND ledger.match_id=model_a_prospective_forecasts.match_id AND julianday(ledger.kickoff_at)=julianday(model_a_prospective_forecasts.kickoff_at) AND ledger.claim_id=${json('collection.claimId')} AND ledger.claim_id IS NOT NULL AND julianday(ledger.claim_at)<=julianday(model_a_prospective_forecasts.forecast_at))`, [...args, cutoff, scope.from, scope.to, options.protocolId, options.manifestSha256, options.protocolId]))
    .filter(row => row.payload_schema === 'model-a-operational-prospective-v1' && row.family === 'A' && row.id === row.payload_id && row.match_id === row.payload_match_id
      && row.forecast_at === row.payload_at && row.kickoff_at === row.payload_kickoff && utc(row.forecast_at) !== null && utc(row.kickoff_at) !== null && utc(row.forecast_at) < utc(row.kickoff_at));
  const selected = new Map<string, Row>();
  for (const row of forecasts) {
    const kickoff = utc(row.kickoff_at), forecastAt = utc(row.forecast_at), id = String(row.match_id);
    if (calendar.get(id) !== kickoff || forecastAt < kickoff - 24 * HOUR || forecastAt > kickoff - HOUR) continue;
    const previous = selected.get(id);
    if (!previous || forecastAt < utc(previous.forecast_at) || (forecastAt === utc(previous.forecast_at) && row.id < previous.id)) selected.set(id, row);
  }
  const classifications: Row = {}, provenanceReasons: Row = {};
  for (const row of selected.values()) {
    const classification = row.classification === 'technical_only' ? 'technical_only' : 'unclassified';
    classifications[classification] = (classifications[classification] ?? 0) + 1;
    const reason = classification === 'technical_only' ? 'technical_only' : 'projected_provenance_unverified';
    provenanceReasons[reason] = (provenanceReasons[reason] ?? 0) + 1;
  }
  Object.assign(coverage, { recordedForecasts: forecasts.length, recordedMatchesInWindow: selected.size,
    overdueMissing: [...calendar].filter(([id, kickoff]) => at >= kickoff - HOUR && !selected.has(id)).length,
    openWindowMissing: [...calendar].filter(([id, kickoff]) => at >= kickoff - 24 * HOUR && at < kickoff - HOUR && !selected.has(id)).length,
    nonEvaluableProvenance: selected.size, temporalClassificationCounts: classifications, provenanceReasons });
  if (!tables.model_a_prospective_results.readable) return finish();
  const matchQuery = `SELECT match_id FROM matches WHERE ${filter}` + (tables.model_a_collection_ledger.readable ? ' UNION SELECT match_id FROM model_a_collection_ledger WHERE protocol_id=?' : '');
  const matchArgs = [...args, ...(tables.model_a_collection_ledger.readable ? [options.protocolId] : [])];
  const storedResults = await query(`SELECT evidence_id,match_id,kickoff_at,observed_at,recorded_at,home_goals,away_goals FROM model_a_prospective_results WHERE ((julianday(kickoff_at)>=julianday(?) AND julianday(kickoff_at)<julianday(?)) OR julianday(kickoff_at) IS NULL) AND (julianday(observed_at)<=julianday(?) OR julianday(observed_at) IS NULL) AND (julianday(recorded_at)<=julianday(?) OR julianday(recorded_at) IS NULL) AND match_id IN (${matchQuery})`, [scope.from, scope.to, cutoff, cutoff, ...matchArgs]);
  const validResults = storedResults.filter(row => utc(row.kickoff_at) !== null && utc(row.observed_at) !== null && utc(row.recorded_at) !== null
    && utc(row.observed_at) > utc(row.kickoff_at) && utc(row.recorded_at) >= utc(row.observed_at)
    && [row.home_goals, row.away_goals].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0));
  let observations: Row[] | null = null;
  if (tables.model_a_prospective_result_observations.readable) {
    observations = await query(`SELECT evidence_id,match_id,kickoff_at,observed_at,recorded_at,status,reason,CASE WHEN json_valid(evidence_json) THEN json_extract(evidence_json,'$.resultRow.home_goals') ELSE NULL END AS home_goals,CASE WHEN json_valid(evidence_json) THEN json_extract(evidence_json,'$.resultRow.away_goals') ELSE NULL END AS away_goals FROM model_a_prospective_result_observations WHERE julianday(kickoff_at)>=julianday(?) AND julianday(kickoff_at)<julianday(?) AND julianday(observed_at)<=julianday(?) AND julianday(recorded_at)<=julianday(?) AND match_id IN (${matchQuery})`, [scope.from, scope.to, cutoff, cutoff, ...matchArgs]);
  }
  const normalize = (row: Row) => ({ evidenceId: String(row.evidence_id), matchId: String(row.match_id), kickoff: utc(row.kickoff_at), observed: utc(row.observed_at), recorded: utc(row.recorded_at), homeGoals: row.home_goals, awayGoals: row.away_goals, status: row.status, reason: row.reason });
  const { excludedKeys, ...measured } = measureResults(forecasts.map(row => ({ matchId: String(row.match_id), kickoff: utc(row.kickoff_at) })),
    validResults.map(normalize), observations?.filter(row => utc(row.kickoff_at) !== null && utc(row.observed_at) !== null && utc(row.recorded_at) !== null).map(normalize) ?? null, calendar, at, ledgerExclusions);
  Object.assign(results, measured, { invalidResultRows: storedResults.length - validResults.length });
  const eligible = [...calendar].filter(([id, kickoff]) => !excludedKeys.has(pair(id, kickoff)));
  Object.assign(coverage, { eligibleFixtureMatches: eligible.length, excludedLifecycleFixtures: calendar.size - eligible.length,
    recordedEligibleMatchesInWindow: [...selected].filter(([id]) => !excludedKeys.has(pair(id, calendar.get(id)))).length,
    overdueMissing: eligible.filter(([id, kickoff]) => at >= kickoff - HOUR && !selected.has(id)).length,
    openWindowMissing: eligible.filter(([id, kickoff]) => at >= kickoff - 24 * HOUR && at < kickoff - HOUR && !selected.has(id)).length });
  return finish();
}
