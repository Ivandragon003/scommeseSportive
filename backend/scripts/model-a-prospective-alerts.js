'use strict';

// Pure shared alert policy: no filesystem, credentials, database or provider imports.
const HOUR = 3600000;

function thresholds(options = {}) {
  const defaults = { maxLivenessAgeHours: 2, maxPendingAgeHours: 1, resultGraceHours: 6, resultHorizonDays: 30 };
  for (const name of Object.keys(defaults)) {
    const value = options[name] === undefined ? defaults[name] : Number(options[name]);
    if (!Number.isFinite(value) || value <= 0 || value > 365 * 24) throw new Error('invalid_threshold');
    defaults[name] = value;
  }
  if (defaults.resultGraceHours >= defaults.resultHorizonDays * 24) throw new Error('invalid_threshold');
  return defaults;
}
function rigorousRequirement(value) {
  if (value === undefined) return false;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error('invalid_rigorous_requirement');
}

/** Validate persisted aggregates without converting missing or damaged evidence to zero. */
function parseCollectionPerformance(raw) {
  const unknown = (status, reason) => ({ status, verified: false, reason, metrics: null });
  if (raw === null || raw === undefined) return unknown('missing', 'performance_not_recorded');
  if (typeof raw !== 'string' || raw.length > 32768) return unknown('invalid', 'performance_json_invalid');
  let value;
  try { value = JSON.parse(raw); } catch { return unknown('invalid', 'performance_json_invalid'); }
  const object = item => item && typeof item === 'object' && !Array.isArray(item);
  const count = item => Number.isSafeInteger(item) && item >= 0;
  const budget = item => Number.isSafeInteger(item) && item >= 1 && item <= 3600000;
  const duration = item => typeof item === 'number' && Number.isFinite(item) && item >= 0;
  if (!object(value) || value.version !== 1 || !object(value.budgets) || !budget(value.budgets.predictMs) || !budget(value.budgets.confirmationMs)
    || !object(value.timingSemantics) || value.timingSemantics.predict !== 'predict start to response or error'
    || value.timingSemantics.confirmation !== 'predict start to recorder completion; stored or unconfirmed') return unknown('invalid', 'performance_contract_invalid');
  for (const [name, budget] of [['predict', value.budgets.predictMs], ['confirmation', value.budgets.confirmationMs]]) {
    const item = value[name];
    if (!object(item) || !count(item.count) || !count(item.overBudget) || item.overBudget > item.count
      || (item.count === 0 ? item.maxMs !== null && item.maxMs !== 0 : !duration(item.maxMs))
      || (item.count > 0 && ((item.overBudget > 0) !== (item.maxMs > budget)))) return unknown('invalid', 'performance_aggregate_invalid');
  }
  if (!count(value.confirmation.stored) || !count(value.confirmation.unconfirmed)
    || value.confirmation.stored + value.confirmation.unconfirmed !== value.confirmation.count
    || value.confirmation.count > value.predict.count || typeof value.alert !== 'boolean'
    || value.alert !== (value.predict.overBudget > 0 || value.confirmation.overBudget > 0)) return unknown('invalid', 'performance_aggregate_invalid');
  return { status: 'available', verified: true, reason: null, metrics: {
    version: 1, budgets: { predictMs: value.budgets.predictMs, confirmationMs: value.budgets.confirmationMs },
    timingSemantics: { predict: value.timingSemantics.predict, confirmation: value.timingSemantics.confirmation },
    predict: { count: value.predict.count, maxMs: value.predict.maxMs, overBudget: value.predict.overBudget },
    confirmation: { count: value.confirmation.count, maxMs: value.confirmation.maxMs, overBudget: value.confirmation.overBudget,
      stored: value.confirmation.stored, unconfirmed: value.confirmation.unconfirmed }, alert: value.alert } };
}

function measureCollectionRecorderOutcomes(rows, evaluable) {
  const result = { recorderStatusEvaluable: evaluable, rejectedFixtures: null, recordingErrorFixtures: null, ineligibleFixtures: null,
    initiallyPendingRecorderFixtures: null, pendingRecorderFixtures: null, recordedReceiptFixtures: null, recorderStatusMissingFixtures: null, recorderStatusUnknownFixtures: null,
    recorderStatusCounts: null, recorderReasonCounts: null };
  if (!evaluable) return result;
  const statuses = new Set(['disabled', 'ineligible', 'rejected', 'accepted', 'pending', 'error']);
  const reasons = new Set(['disabled', 'shutdown', 'fixture_or_observation_time', 'spool_required', 'queue_full', 'spool_full', 'redacted']);
  const statusCounts = {}, reasonCounts = {}; let missing = 0, unknown = 0, recorded = 0;
  for (const row of rows) {
    if (row.recorder_status === null || row.recorder_status === undefined) { if (row.claim_at) missing++; continue; }
    if (!statuses.has(row.recorder_status)) { unknown++; continue; }
    recorded++; statusCounts[row.recorder_status] = (statusCounts[row.recorder_status] ?? 0) + 1;
    if (row.recorder_reason !== null && row.recorder_reason !== undefined) {
      const reason = reasons.has(row.recorder_reason) ? row.recorder_reason : 'redacted';
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    }
  }
  return { ...result, rejectedFixtures: statusCounts.rejected ?? 0, recordingErrorFixtures: statusCounts.error ?? 0,
    ineligibleFixtures: statusCounts.ineligible ?? 0, initiallyPendingRecorderFixtures: statusCounts.pending ?? 0,
    pendingRecorderFixtures: rows.filter(row => row.recorder_status === 'pending' && row.state !== 'stored').length,
    recordedReceiptFixtures: recorded, recorderStatusMissingFixtures: missing, recorderStatusUnknownFixtures: unknown,
    recorderStatusCounts: statusCounts, recorderReasonCounts: reasonCounts };
}

function evaluate(report, options = {}) {
  const limits = thresholds(options), requireRigorousInputs = rigorousRequirement(options.requireRigorousInputs), alerts = [], notices = [], cutoff = Date.parse(report.coverage.scope.cutoff);
  const add = (code, severity, count, action) => alerts.push({ code, severity, count, action });
  const age = value => value ? Math.max(0, (cutoff - Date.parse(value)) / HOUR) : null;
  if (!report.schema.compatible) add('schema_unverified', 'critical', report.schema.issues.length, 'Inspect schema issues; apply the approved manual schema to the named database.');
  if (!report.coverage.calendarEvaluable || report.coverage.fixtureMatches === 0) add('calendar_unverifiable', 'critical', null, 'Verify fixture import, explicit competition/season and registered interval; zero fixtures does not establish coverage.');
  if (report.coverage.invalidFixtureTimesInCompetitionSeason > 0) add('invalid_fixture_times', 'critical', report.coverage.invalidFixtureTimesInCompetitionSeason, 'Repair or explicitly classify calendar timestamps before measuring coverage.');
  if (report.coverage.overdueMissing > 0) add('missing_forecast_windows', 'critical', report.coverage.overdueMissing, 'Preserve missed fixtures and inspect collector runs; never backfill a pre-match forecast after its window.');
  if (report.coverage.nonEvaluableProvenance > 0) {
    const item = { code: 'temporal_provenance_unknown', severity: requireRigorousInputs ? 'critical' : 'info', count: report.coverage.nonEvaluableProvenance,
      action: 'Keep these forecasts excluded from strict temporal validation until provenance is verified.' };
    if (requireRigorousInputs) alerts.push(item); else notices.push(item);
  }
  const collector = report.collector;
  const performance = collector.performance;
  if (performance?.status === 'invalid') add('collector_performance_invalid', 'critical', null, 'Inspect damaged or inconsistent performance aggregates; no latency budget was verified.');
  else if (performance?.status === 'available' && performance.metrics.alert) add('collector_performance_budget_exceeded', 'critical',
    performance.metrics.predict.overBudget + performance.metrics.confirmation.overBudget, 'Inspect prediction and end-to-end confirmation durations against the persisted run budgets; the same request can exceed both budgets.');
  else if (performance?.status !== 'available') notices.push({ code: 'collector_performance_unknown', severity: 'info', count: null,
    action: 'Performance measurements are unavailable; absent aggregates can reflect historical data or an interrupted write, and do not establish zero latency or a healthy budget.' });
  const unmeasuredConfirmations = performance?.status === 'available' ? performance.metrics.predict.count - performance.metrics.confirmation.count : null;
  if (unmeasuredConfirmations > 0) notices.push({ code: 'collector_confirmation_unmeasured', severity: 'info', count: unmeasuredConfirmations,
    action: 'Some prediction calls have no end-to-end confirmation measurement; the measured durations do not verify the complete confirmation budget.' });
  if (collector.rejectedFixtures > 0) add('collector_recording_rejected', 'critical', collector.rejectedFixtures, 'Inspect recorder rejection reason counts for fixtures in this collection scope.');
  if (collector.recordingErrorFixtures > 0) add('collector_recording_error', 'critical', collector.recordingErrorFixtures, 'Inspect recorder errors for fixtures in this collection scope; raw errors remain redacted.');
  if (collector.ineligibleFixtures > 0) notices.push({ code: 'collector_recording_ineligible', severity: 'info', count: collector.ineligibleFixtures,
    action: 'Review explicit recorder exclusions separately from errors and pending delivery.' });
  if (collector.recorderStatusEvaluable !== true || collector.recorderStatusMissingFixtures > 0 || collector.recorderStatusUnknownFixtures > 0) notices.push({
    code: 'collector_recorder_status_unknown', severity: 'info', count: collector.recorderStatusEvaluable ? collector.recorderStatusMissingFixtures + collector.recorderStatusUnknownFixtures : null,
    action: 'Recorder receipt evidence is missing or unavailable for some scoped fixtures; these counts do not cover unrelated API calls.' });
  if (!collector.requested || collector.registeredScopeMatches !== true) add('collector_scope_unverified', 'critical', null, 'Pass --protocol-id and verify its frozen manifest includes this scope and origin.');
  if (collector.analyzedFixtures === null || collector.ledgerMissingFixtures > 0) add('unanalyzed_fixtures', 'critical', collector.ledgerMissingFixtures, 'Inspect independent collector ledger and missing due fixtures.');
  if (collector.missingCalendarObservations > 0) add('collector_fixture_missing_from_calendar', 'critical', collector.missingCalendarObservations, 'Inspect fixtures previously observed by this protocol that disappeared from the current calendar.');
  if (!collector.lastSuccessfulRunAt || age(collector.lastSuccessfulRunAt) > limits.maxLivenessAgeHours) add('collector_stale', 'critical', null, 'Inspect the existing scheduled collector process and its most recent successful run.');
  if (collector.latestRunStatus === 'failed') add('collector_run_failed', 'critical', 1, 'Inspect the latest failed run and its redacted error code.');
  if (collector.latestRunStatus === 'started' && age(collector.lastRunStartedAt) > limits.maxLivenessAgeHours) add('collector_run_incomplete', 'critical', 1, 'Inspect a stopped or stuck collector run before authorizing a replacement.');
  if (collector.failedFixtures > 0) add('forecast_delivery_unconfirmed', 'critical', collector.failedFixtures, 'Inspect recorder delivery receipts and database confirmation; do not regenerate the claimed prediction.');
  if (collector.oldestPendingAt && age(collector.oldestPendingAt) > limits.maxPendingAgeHours) add('pending_forecasts_old', 'critical', collector.pendingFixtures, 'Restore the existing delivery path and retain pending evidence.');
  if (report.spool.configured) {
    const errors = report.spool.invalidFiles + report.spool.partialFiles + report.spool.unsafeEntries + report.spool.audit.invalidLines + report.spool.audit.unknownTypes;
    if (errors > 0) add('spool_or_audit_errors', 'critical', errors, 'Preserve spool/audit evidence and diagnose invalid, partial or unsupported entries.');
    if (report.coverage.pendingUnconfirmedForecasts > 0 && age(report.spool.oldestForecastAt) > limits.maxPendingAgeHours) add('spool_backlog_old', 'critical', report.coverage.pendingUnconfirmedForecasts, 'Verify database availability and recovery; retain unconfirmed files.');
    const failed = report.spool.audit.reconciliationErrors + report.spool.audit.reconciliationFailedItems;
    if (failed > 0) add('result_reconciliation_errors', 'critical', failed, 'Inspect reconciliation logs; audit counts are events, including retries, rather than unique forecasts.');
  }
  const results = report.results;
  if (results.refreshRunLivenessVerified !== true || !results.lastSuccessfulRefreshAt || age(results.lastSuccessfulRefreshAt) > limits.maxLivenessAgeHours) add('result_refresh_stale', 'critical', null, 'Inspect the existing result refresh worker and its persisted last successful cycle, including zero-candidate cycles.');
  if (['failed', 'partial'].includes(results.latestRefreshStatus)) add('result_refresh_failed', 'critical', 1, 'Inspect the persisted refresh status and reason before trusting result availability.');
  const exclusions = (results.lifecycle?.canceled ?? 0) + (results.lifecycle?.postponed ?? 0);
  if (exclusions) notices.push({ code: 'result_lifecycle_exclusion', severity: 'info', count: exclusions,
    action: 'Keep canceled/postponed fixtures in the calendar total and report their explicit exclusion from the eligible denominator.' });
  if (!results.evaluable || results.lifecycleStorage !== 'available') add('results_unverifiable', 'critical', null, 'Verify result and lifecycle observation tables without treating missing observations as zero pending results.');
  if (results.evaluable) {
    const overdue = (results.pendingKickoffs ?? []).filter(value => age(value) > limits.resultGraceHours);
    const withinHorizon = overdue.filter(value => age(value) <= limits.resultHorizonDays * 24).length;
    const outsideHorizon = overdue.length - withinHorizon;
    if (withinHorizon) add('results_pending_within_horizon', 'warning', withinHorizon, 'Inspect bounded refresh observations and provider availability; keep pending results distinct from losses.');
    if (outsideHorizon) add('results_outside_refresh_horizon', 'critical', outsideHorizon, 'Classify older unresolved fixtures explicitly; the bounded refresh will not recover them automatically.');
    if (results.orphanForecasts > 0) add('forecast_calendar_association_missing', 'critical', results.orphanForecasts, 'Inspect missing fixtures or kickoff changes; preserve original forecasts.');
    if (results.unassociatedResults > 0) add('unassociated_results', 'warning', results.unassociatedResults, 'Inspect exact match and kickoff association for result evidence in the configured scope.');
    if (results.invalidResultRows > 0) add('invalid_result_evidence', 'critical', results.invalidResultRows, 'Inspect invalid result timestamps/scores before pairing.');
    for (const status of ['provider_error', 'conflict', 'unverified']) if (results.lifecycle?.[status] > 0) add(`result_${status}`, status === 'unverified' ? 'warning' : 'critical', results.lifecycle[status], 'Inspect the latest lifecycle reason; these observations are not verified final scores.');
  }
  return { enabled: true, status: alerts.some(alert => alert.severity === 'critical') ? 'critical' : alerts.length ? 'warning' : 'ok',
    scientificStatus: 'unverified', rigorousEligible: false, requireRigorousInputs,
    performanceStatus: performance?.status === 'available' ? (performance.metrics.alert ? 'exceeded' : performance.metrics.predict.count === 0 ? 'no_samples' : unmeasuredConfirmations > 0 ? 'partial' : 'within_budget') : 'unverified',
    thresholds: limits, agesHours: { lastSuccessfulRun: age(collector.lastSuccessfulRunAt), lastSuccessfulRefresh: age(results.lastSuccessfulRefreshAt), oldestPending: age(collector.oldestPendingAt) }, alerts, notices,
    countSemantics: 'Ledger metrics count fixture/kickoff records; recorder receipt counts cover only matched current fixtures in the selected protocol, not unrelated API calls. Audit counters count events, including retries. No event count is a forecast denominator.' };
}

module.exports = { evaluate, thresholds, rigorousRequirement, parseCollectionPerformance, measureCollectionRecorderOutcomes };
