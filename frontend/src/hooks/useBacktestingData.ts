import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  deleteBacktestResult,
  deleteBacktestResults,
  getBacktestReport,
  getBacktestResult,
  getBacktestResults,
  pruneBacktestResults,
  runBacktest,
  runWalkForwardBacktest,
} from '../utils/api';
import { getErrorMessage } from '../utils/errorUtils';

type BacktestMode = 'classic' | 'walk_forward';
type ConfidenceMode = 'high_only' | 'medium_and_above';

const isWalkForwardResult = (value: any): boolean =>
  Boolean(value && (value.kind === 'walk_forward' || Array.isArray(value.folds)));

interface BacktestReportFilters {
  market?: string;
  source?: string;
  dateFrom?: string;
  dateTo?: string;
}

interface RunBacktestParams {
  mode: BacktestMode;
  competition: string;
  season: string;
  trainRatio: string;
  confidenceLevel: ConfidenceMode;
  initialTrainMatches: string;
  testWindowMatches: string;
  stepMatches: string;
  maxFolds: string;
  expandingWindow: boolean;
}

interface UseBacktestingDataParams {
  confirm: (config: {
    title: string;
    message: string;
    confirmLabel: string;
    tone?: 'danger' | 'warning';
  }) => Promise<boolean>;
  showToast: (toast: { tone: 'error' | 'success' | 'warning'; title?: string; message: string }) => void;
}

export function useBacktestingData({ confirm, showToast }: UseBacktestingDataParams) {
  const [loading, setLoading] = useState(false);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [currentResult, setCurrentResult] = useState<any>(null);
  const [currentResultId, setCurrentResultId] = useState<number | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [backtestReport, setBacktestReport] = useState<any>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  const loadResults = useCallback(async (options?: { force?: boolean }) => {
    try {
      const res = await getBacktestResults(undefined, options);
      setResults(res.data ?? []);
    } catch {
      setResults([]);
    }
  }, []);

  const loadReport = useCallback(async (
    runId?: number | null,
    fallbackCompetition?: string,
    filters?: BacktestReportFilters,
    options?: { force?: boolean }
  ) => {
    if (!runId && !fallbackCompetition) return;
    setReportLoading(true);
    setReportError(null);
    try {
      const payload = await getBacktestReport({
        runId: runId ?? undefined,
        competition: !runId ? fallbackCompetition : undefined,
        market: filters?.market || undefined,
        source: filters?.source || undefined,
        dateFrom: filters?.dateFrom || undefined,
        dateTo: filters?.dateTo || undefined,
      }, options);
      setBacktestReport(payload.data?.report ?? null);
    } catch (error) {
      setBacktestReport(null);
      setReportError(getErrorMessage(error, 'Errore caricamento report'));
    } finally {
      setReportLoading(false);
    }
  }, []);

  const loadHistorical = useCallback(async (id: number, filters?: BacktestReportFilters) => {
    try {
      const res = await getBacktestResult(id, { force: true });
      const result = res.data?.result ?? null;
      if (!result) return null;

      setCurrentResult(result);
      setCurrentResultId(id);
      setBacktestReport(result.reportSnapshot ?? null);
      setReportError(null);
      await loadReport(id, undefined, filters, { force: true });
      return result;
    } catch (error) {
      showToast({
        tone: 'error',
        title: 'Run non caricato',
        message: getErrorMessage(error, 'Errore caricamento run'),
      });
      return null;
    }
  }, [loadReport, showToast]);

  const runValidation = useCallback(async (params: RunBacktestParams, filters?: BacktestReportFilters) => {
    setLoading(true);
    try {
      const payload =
        params.mode === 'classic'
          ? await runBacktest({
              competition: params.competition,
              season: params.season || undefined,
              trainRatio: Number(params.trainRatio),
              confidenceLevel: params.confidenceLevel,
            })
          : await runWalkForwardBacktest({
              competition: params.competition,
              season: params.season || undefined,
              initialTrainMatches: params.initialTrainMatches ? Number(params.initialTrainMatches) : undefined,
              testWindowMatches: params.testWindowMatches ? Number(params.testWindowMatches) : undefined,
              stepMatches: params.stepMatches ? Number(params.stepMatches) : undefined,
              maxFolds: params.maxFolds ? Number(params.maxFolds) : undefined,
              confidenceLevel: params.confidenceLevel,
              expandingWindow: params.expandingWindow,
            });

      if (!payload.data) return null;

      const nextResultId = Number(payload.data.resultId ?? 0) || null;
      setCurrentResult(payload.data);
      setCurrentResultId(nextResultId);
      setBacktestReport(payload.data.reportSnapshot ?? null);
      setReportError(null);
      if (nextResultId) {
        await loadReport(nextResultId, undefined, filters, { force: true });
      }
      await loadResults({ force: true });
      return payload.data;
    } catch (error) {
      showToast({
        tone: 'error',
        title: 'Backtest non completato',
        message: getErrorMessage(error, 'Errore esecuzione backtest'),
      });
      return null;
    } finally {
      setLoading(false);
    }
  }, [loadReport, loadResults, showToast]);

  const handleDeleteRun = useCallback(async (id: number) => {
    const confirmed = await confirm({
      title: 'Eliminare questo run?',
      message: `Eliminare il run #${id}?`,
      confirmLabel: 'Elimina run',
      tone: 'danger',
    });
    if (!confirmed) return;

    setMaintenanceLoading(true);
    try {
      await deleteBacktestResult(id);
      if (currentResultId === id) {
        setCurrentResult(null);
        setCurrentResultId(null);
        setBacktestReport(null);
      }
      await loadResults({ force: true });
    } catch (error) {
      showToast({
        tone: 'error',
        title: 'Eliminazione fallita',
        message: getErrorMessage(error, 'Errore eliminazione run'),
      });
    } finally {
      setMaintenanceLoading(false);
    }
  }, [confirm, currentResultId, loadResults, showToast]);

  const handleDeleteAllRuns = useCallback(async (competition: string) => {
    const scope = competition.trim();
    const confirmMsg = scope
      ? `Eliminare tutti i run di backtest per ${scope}?`
      : 'Eliminare tutti i run di backtest salvati?';
    const confirmed = await confirm({
      title: 'Eliminare tutti i run?',
      message: confirmMsg,
      confirmLabel: 'Elimina tutti',
      tone: 'danger',
    });
    if (!confirmed) return;

    setMaintenanceLoading(true);
    try {
      const res = await deleteBacktestResults(scope || undefined);
      showToast({
        tone: 'success',
        title: 'Run eliminati',
        message: `Run eliminati: ${res.data?.deletedCount ?? 0}`,
      });
      setCurrentResult(null);
      setCurrentResultId(null);
      setBacktestReport(null);
      await loadResults({ force: true });
    } catch (error) {
      showToast({
        tone: 'error',
        title: 'Eliminazione fallita',
        message: getErrorMessage(error, 'Errore eliminazione backtest'),
      });
    } finally {
      setMaintenanceLoading(false);
    }
  }, [confirm, loadResults, showToast]);

  const handlePruneRuns = useCallback(async (keepLatestRaw: string, competition: string) => {
    const keepLatest = Number(keepLatestRaw);
    if (!Number.isFinite(keepLatest) || keepLatest < 0) {
      showToast({
        tone: 'warning',
        title: 'Valore non valido',
        message: 'Inserisci un numero valido (>= 0).',
      });
      return;
    }

    const scope = competition.trim();
    const confirmMsg = scope
      ? `Mantieni solo gli ultimi ${Math.floor(keepLatest)} run per ${scope}?`
      : `Mantieni solo gli ultimi ${Math.floor(keepLatest)} run globali?`;
    const confirmed = await confirm({
      title: 'Applicare prune ai run?',
      message: confirmMsg,
      confirmLabel: 'Applica prune',
      tone: 'warning',
    });
    if (!confirmed) return;

    setMaintenanceLoading(true);
    try {
      const res = await pruneBacktestResults(Math.floor(keepLatest), scope || undefined);
      showToast({
        tone: 'success',
        title: 'Prune completato',
        message: `Run eliminati: ${res.data?.deletedCount ?? 0}`,
      });
      await loadResults({ force: true });
    } catch (error) {
      showToast({
        tone: 'error',
        title: 'Prune fallito',
        message: getErrorMessage(error, 'Errore prune backtest'),
      });
    } finally {
      setMaintenanceLoading(false);
    }
  }, [confirm, loadResults, showToast]);

  useEffect(() => {
    void loadResults();
  }, [loadResults]);

  const currentIsWalkForward = useMemo(() => isWalkForwardResult(currentResult), [currentResult]);

  return {
    loading,
    maintenanceLoading,
    results,
    currentResult,
    currentResultId,
    reportLoading,
    backtestReport,
    reportError,
    setReportError,
    setBacktestReport,
    currentIsWalkForward,
    loadResults,
    loadReport,
    loadHistorical,
    runValidation,
    handleDeleteRun,
    handleDeleteAllRuns,
    handlePruneRuns,
  };
}
