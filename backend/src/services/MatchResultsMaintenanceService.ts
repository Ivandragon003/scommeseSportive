import type { DatabaseService } from '../db/DatabaseService';
import type { MatchResultsRefreshService, MatchResultsRefreshSummary } from './MatchResultsRefreshService';

type Settlement = { checked: number; settled: number; unresolved: number };
export type ResultsMaintenanceSummary = MatchResultsRefreshSummary & { settlement: Settlement | null };

/** Only completed-source updates and settlement of existing bets; no recommendation engine is called. */
export class MatchResultsMaintenanceService {
  private pending: Promise<ResultsMaintenanceSummary> | null = null;
  constructor(private readonly refreshService: Pick<MatchResultsRefreshService, 'refresh'>,
    private readonly settleExisting: () => Promise<Settlement>,
    private readonly db: Pick<DatabaseService, 'saveSchedulerRun'>) {}

  refresh(): Promise<ResultsMaintenanceSummary> {
    if (this.pending) return this.pending;
    const work = this.run();
    this.pending = work;
    void work.finally(() => { if (this.pending === work) this.pending = null; }).catch(() => undefined);
    return work;
  }

  private async run(): Promise<ResultsMaintenanceSummary> {
    const report = await this.refreshService.refresh();
    const result: ResultsMaintenanceSummary = { ...report, errors: [...report.errors], settlement: null };
    if (report.status !== 'FAILED') {
      try { result.settlement = await this.settleExisting(); }
      catch { result.status = 'PARTIAL'; result.errors.push({ reason: 'existing_bet_settlement_unavailable' }); }
    }
    const completedAt = new Date().toISOString();
    result.completedAt = completedAt;
    try {
      await this.db.saveSchedulerRun({ schedulerName: 'results_refresh', trigger: 'manual',
        startedAt: report.startedAt, endedAt: completedAt, success: result.status === 'SUCCESS',
        durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(report.startedAt)),
        summary: { source: 'understat', createsNewBets: false, resultsOnly: true, status: result.status,
          checked: result.checked, updated: result.updated, settlement: result.settlement,
          errors: result.errors.map((error) => error.reason) } });
    } catch { result.status = result.status === 'FAILED' ? 'FAILED' : 'PARTIAL'; result.errors.push({ reason: 'refresh_status_record_unavailable' }); }
    return result;
  }
}
