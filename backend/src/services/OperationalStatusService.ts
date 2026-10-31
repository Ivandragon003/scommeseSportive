import type { DatabaseService } from '../db/DatabaseService';

type StatusDb = Pick<DatabaseService, 'listRecentSchedulerRunsByName'>;
const measured = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const verifiedTime = (value: unknown): string | null => typeof value === 'string'
  && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value)) ? value : null;

/** Stored observations only; the web process's disabled schedulers do not describe the GitHub job. */
export async function buildOperationalStatus(db: StatusDb, now = new Date()) {
  const [nightlyRuns, dataRuns, resultRuns, executionRuns] = await Promise.all([
    db.listRecentSchedulerRunsByName('nightly', 5), db.listRecentSchedulerRunsByName('understat', 5),
    db.listRecentSchedulerRunsByName('results_refresh', 5), db.listRecentSchedulerRunsByName('research_nightly', 5),
  ]);
  const completedRun = nightlyRuns[0];
  const execution = executionRuns[0];
  const observedAt = (item: any): number => Date.parse(verifiedTime(item?.endedAt) || verifiedTime(item?.startedAt) || '') || 0;
  const newerExecution = observedAt(execution) > observedAt(completedRun);
  const run = newerExecution ? execution : completedRun;
  const associatedExecution = newerExecution ? execution : executionRuns.find((item) => {
    const start = verifiedTime(item.startedAt); const end = verifiedTime(item.endedAt);
    return start && end && verifiedTime(run?.startedAt) && verifiedTime(run?.endedAt)
      && Date.parse(start) >= Date.parse(run.startedAt) && Date.parse(end) <= Date.parse(run.endedAt);
  });
  const latestSuccess = (runs: any[]) => runs.find((item) => item.success && verifiedTime(item.endedAt));
  const state: 'SUCCESS' | 'FAILED' | 'RUNNING' | 'NOT_OBSERVED' = !run ? 'NOT_OBSERVED'
    : !verifiedTime(run.endedAt) ? 'RUNNING' : run.success === false ? 'FAILED'
      : newerExecution ? 'NOT_OBSERVED' : run.success === true ? 'SUCCESS' : 'NOT_OBSERVED';
  return { checkedAt: now.toISOString(), lastDataUpdateAt: verifiedTime(latestSuccess(dataRuns)?.endedAt),
    lastResultsRefreshAt: verifiedTime(latestSuccess(resultRuns)?.endedAt),
    nightly: { state, lastStartedAt: verifiedTime(run?.startedAt), lastCompletedAt: verifiedTime(run?.endedAt),
      analyzedMatches: measured(associatedExecution?.summary?.analyzedMatches),
      registeredBets: measured(associatedExecution?.summary?.registeredBets) } };
}
