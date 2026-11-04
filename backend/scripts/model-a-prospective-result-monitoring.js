'use strict';

// Pure pairing semantics shared by local SQLite and configured libSQL inspection.
const pair = (id, kickoff) => JSON.stringify([String(id), kickoff]);
const later = (a, b) => !b || a.observed > b.observed || (a.observed === b.observed
  && (a.recorded > b.recorded || (a.recorded === b.recorded && a.evidenceId > b.evidenceId)));
function measureResults(forecasts, results, observations, calendar, cutoff, ledgerExclusions = []) {
  const forecastKeys = new Set(forecasts.map(row => pair(row.matchId, row.kickoff)));
  const latestResults = new Map(), latestLifecycle = new Map();
  for (const row of results) { const key = pair(row.matchId, row.kickoff); if (later(row, latestResults.get(key))) latestResults.set(key, row); }
  for (const row of observations ?? []) {
    const key = pair(row.matchId, row.kickoff);
    if (forecastKeys.has(key) && later(row, latestLifecycle.get(key))) latestLifecycle.set(key, row);
  }
  const excludedKeys = new Set(ledgerExclusions);
  for (const [key, row] of latestLifecycle) if (['canceled', 'postponed'].includes(row.status)) excludedKeys.add(key);
  const pairable = row => {
    const key = pair(row.matchId, row.kickoff), result = latestResults.get(key), lifecycle = latestLifecycle.get(key);
    if (!result || excludedKeys.has(key)) return false;
    // Legacy evidence without lifecycle remains distinguishable from a newer invalidation.
    return !lifecycle || (lifecycle.status === 'final' && lifecycle.observed <= result.observed
      && lifecycle.homeGoals === result.homeGoals && lifecycle.awayGoals === result.awayGoals);
  };
  const pending = forecasts.filter(row => row.kickoff <= cutoff && !pairable(row) && !excludedKeys.has(pair(row.matchId, row.kickoff)));
  const lifecycle = observations ? {} : null, lifecycleReasons = observations ? {} : null;
  let lastLifecycleObservedAt = null, invalidatedStoredFinals = 0;
  const invalidationReasons = {};
  for (const [key, row] of latestLifecycle) {
    lifecycle[row.status] = (lifecycle[row.status] ?? 0) + 1;
    lifecycleReasons[row.reason] = (lifecycleReasons[row.reason] ?? 0) + 1;
    if (lastLifecycleObservedAt === null || row.observed > Date.parse(lastLifecycleObservedAt)) lastLifecycleObservedAt = new Date(row.observed).toISOString();
    const result = latestResults.get(key);
    if (result && !pairable({ matchId: row.matchId, kickoff: row.kickoff })) {
      invalidatedStoredFinals++; invalidationReasons[row.status] = (invalidationReasons[row.status] ?? 0) + 1;
    }
  }
  const linked = forecasts.filter(pairable).length;
  return { evaluable: true, preservedFinalEvidence: results.length, currentlyPairableForecasts: linked, linkedForecasts: linked,
    invalidatedStoredFinals, invalidationReasons, excludedLifecycleFixtures: calendar ? [...calendar].filter(([id, at]) => excludedKeys.has(pair(id, at))).length : null,
    pendingForecasts: pending.length, pendingKickoffs: pending.map(row => new Date(row.kickoff).toISOString()),
    oldestPendingKickoffAt: pending.length ? new Date(Math.min(...pending.map(row => row.kickoff))).toISOString() : null,
    unassociatedResults: calendar ? results.filter(row => calendar.get(row.matchId) === row.kickoff && !forecastKeys.has(pair(row.matchId, row.kickoff))).length : null,
    orphanForecasts: calendar ? forecasts.filter(row => calendar.get(row.matchId) !== row.kickoff).length : null,
    lifecycle, lifecycleReasons, lastLifecycleObservedAt, excludedKeys };
}
module.exports = { measureResults, pair };
