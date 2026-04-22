import { useCallback, useMemo, useRef, useState } from 'react';
import { replayPlayedMatchPrediction } from '../utils/api';
import { getErrorMessage } from '../utils/errorUtils';
import { buildBetKey } from '../components/predictions/predictionWorkbenchUtils';
import { useOddsForMatch } from './useOddsForMatch';
import type { MatchMode } from './useMatchSelection';

type OddsTone = 'info' | 'success' | 'warning' | 'danger';

interface AnalysisCacheEntry {
  pred: any;
  odds: Record<string, string>;
  marketsRequested: string[];
  oddsMsg: string;
  oddsTone: OddsTone;
  cachedAt: number;
}

interface UsePredictionAnalysisParams {
  budget: any;
  competition: string;
  matchMode: MatchMode;
  teams: any[];
  setCompetition: (value: string) => void;
  setActiveMatchId: (value: string | null) => void;
  setTab: (value: string) => void;
}

export function usePredictionAnalysis({
  budget,
  competition,
  matchMode,
  teams,
  setCompetition,
  setActiveMatchId,
  setTab,
}: UsePredictionAnalysisParams) {
  const [pred, setPred] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMatchId, setLoadingMatchId] = useState<string | null>(null);
  const [odds, setOdds] = useState<Record<string, string>>({});
  const [marketsRequested, setMarketsRequested] = useState<string[]>([]);
  const [oddsMsg, setOddsMsg] = useState('');
  const [oddsTone, setOddsTone] = useState<OddsTone>('info');
  const [analysisCacheKey, setAnalysisCacheKey] = useState<string | null>(null);
  const [stakes, setStakes] = useState<Record<string, string>>({});

  const analyzeReqRef = useRef(0);
  const analysisCacheRef = useRef<Map<string, AnalysisCacheEntry>>(new Map());
  const { fetchPredictionWithOdds } = useOddsForMatch();

  const applyOdds = useCallback((incoming: Record<string, number>) => {
    const nextOdds: Record<string, string> = {};
    for (const [key, value] of Object.entries(incoming)) {
      if (Number.isFinite(value) && value > 1) {
        nextOdds[key] = value.toFixed(2);
      }
    }
    setOdds(nextOdds);
  }, []);

  const recalculateStakes = useCallback((prediction: any, resolvedMatchId: string) => {
    const nextStakes: Record<string, string> = {};
    for (const opportunity of prediction?.valueOpportunities ?? []) {
      if (budget?.available_budget) {
        const key = buildBetKey(
          String(prediction?.matchId ?? resolvedMatchId),
          String(opportunity.selection),
          String(opportunity.marketName)
        );
        nextStakes[key] = ((opportunity.suggestedStakePercent / 100) * budget.available_budget).toFixed(2);
      }
    }
    setStakes(nextStakes);
  }, [budget?.available_budget]);

  const clearAnalysisState = useCallback(() => {
    setPred(null);
    setActiveMatchId(null);
    setAnalysisCacheKey(null);
    setOdds({});
    setOddsMsg('');
    setMarketsRequested([]);
    setStakes({});
  }, [setActiveMatchId]);

  const clearAnalysisCache = useCallback(() => {
    analysisCacheRef.current.clear();
  }, []);

  const handleAnalyze = useCallback(async (match: any) => {
    const homeId = String(match.home_team_id ?? '');
    const awayId = String(match.away_team_id ?? '');
    const matchCompetition = String(match.competition ?? competition);
    const rawMatchId = String(match.match_id ?? '');
    const isPlayedMatch = matchMode === 'recent' || (match.home_goals !== null && match.away_goals !== null);

    if (!homeId || !awayId) return;

    const resolvedMatchId = rawMatchId || `match_${homeId}_${awayId}_${String(match.date ?? '')}`;
    const cacheKey = `${matchMode}|${resolvedMatchId}|${homeId}|${awayId}|${matchCompetition}`;
    const cached = analysisCacheRef.current.get(cacheKey);
    const now = Date.now();

    if (cached && now - cached.cachedAt < 120000) {
      setAnalysisCacheKey(cacheKey);
      setActiveMatchId(resolvedMatchId);
      setPred(cached.pred);
      setOdds(cached.odds);
      setMarketsRequested(cached.marketsRequested);
      setOddsMsg(cached.oddsMsg);
      setOddsTone(cached.oddsTone);
      recalculateStakes(cached.pred, resolvedMatchId);
      setTab(isPlayedMatch ? 'strategy' : 'odds');
      return;
    }

    const requestId = ++analyzeReqRef.current;
    setAnalysisCacheKey(cacheKey);
    setActiveMatchId(resolvedMatchId);
    setLoadingMatchId(rawMatchId || resolvedMatchId);
    setOdds({});
    setOddsMsg('');
    setMarketsRequested([]);

    if (matchCompetition && matchCompetition !== competition) {
      setCompetition(matchCompetition);
    }

    setTab('1x2');
    setLoading(true);

    try {
      if (isPlayedMatch) {
        setOddsMsg('Ricalcolo consiglio sulla partita gia giocata...');
        setOddsTone('info');

        const replayResponse = await replayPlayedMatchPrediction(rawMatchId);
        if (requestId !== analyzeReqRef.current) return;

        const replayData = replayResponse.data ?? null;
        if (!replayData) {
          throw new Error('Replay non disponibile.');
        }

        const replayOdds = replayData.replayOddsUsed ?? replayData.replayEstimatedOdds ?? {};
        const requestedMarkets = Array.isArray(replayData.marketsRequested)
          ? replayData.marketsRequested
          : ['model_estimated_replay'];
        const appliedOdds = Object.entries(replayOdds).reduce((acc, [key, value]) => {
          const nextValue = Number(value);
          if (Number.isFinite(nextValue) && nextValue > 1) {
            acc[key] = nextValue.toFixed(2);
          }
          return acc;
        }, {} as Record<string, string>);

        const replayPrediction = {
          ...replayData,
          oddsSource: replayData.oddsReplaySource ?? 'historical_bookmaker_snapshot',
        };

        setPred(replayPrediction);
        applyOdds(replayOdds);
        setMarketsRequested(requestedMarkets);
        setOddsMsg(replayData.analysisDisclaimer ?? 'Replay statistico su partita gia giocata.');
        setOddsTone('warning');
        setTab('strategy');
        recalculateStakes(replayPrediction, resolvedMatchId);

        analysisCacheRef.current.set(cacheKey, {
          pred: replayPrediction,
          odds: appliedOdds,
          marketsRequested: requestedMarkets,
          oddsMsg: replayData.analysisDisclaimer ?? 'Replay statistico su partita gia giocata.',
          oddsTone: 'warning',
          cachedAt: Date.now(),
        });

        return;
      }

      setOddsMsg('Recupero quote live...');
      setOddsTone('info');

      const result = await fetchPredictionWithOdds({
        competition: matchCompetition,
        homeId,
        awayId,
        match,
        resolvedMatchId,
        teams,
        onBasePrediction: (basePrediction) => {
          if (requestId !== analyzeReqRef.current) return;
          setPred(basePrediction);
        },
      });
      if (requestId !== analyzeReqRef.current) return;

      setPred(result.finalPred);
      setOdds(result.appliedOdds);
      setMarketsRequested(result.marketsRequested);
      setOddsMsg(result.oddsMsg);
      setOddsTone(result.oddsTone);
      if (result.finalPred && Object.keys(result.appliedOdds).length > 0) {
        setTab('odds');
      }
      recalculateStakes(result.finalPred, resolvedMatchId);

      analysisCacheRef.current.set(cacheKey, {
        pred: result.finalPred,
        odds: result.appliedOdds,
        marketsRequested: result.marketsRequested,
        oddsMsg: result.oddsMsg,
        oddsTone: result.oddsTone,
        cachedAt: Date.now(),
      });
    } catch (error) {
      if (requestId !== analyzeReqRef.current) return;
      setOddsMsg(getErrorMessage(error));
      setOddsTone('danger');
    } finally {
      if (requestId === analyzeReqRef.current) {
        setLoading(false);
        setLoadingMatchId(null);
      }
    }
  }, [
    analysisCacheRef,
    applyOdds,
    competition,
    fetchPredictionWithOdds,
    matchMode,
    recalculateStakes,
    setActiveMatchId,
    setCompetition,
    setTab,
    teams,
  ]);

  const parseOdds = useMemo(() => () => {
    const parsed: Record<string, number> = {};
    Object.entries(odds).forEach(([key, value]) => {
      const nextValue = parseFloat(value);
      if (!Number.isNaN(nextValue) && nextValue > 1) {
        parsed[key] = nextValue;
      }
    });
    return parsed;
  }, [odds]);

  const handleRefresh = useCallback((match: any | null) => {
    if (!analysisCacheKey || !match) return;
    analysisCacheRef.current.delete(analysisCacheKey);
    void handleAnalyze(match);
  }, [analysisCacheKey, handleAnalyze]);

  return {
    pred,
    loading,
    loadingMatchId,
    odds,
    marketsRequested,
    oddsMsg,
    oddsTone,
    analysisCacheKey,
    stakes,
    parseOdds,
    setOdds,
    setPred,
    setMarketsRequested,
    setOddsMsg,
    setOddsTone,
    setStakes,
    handleAnalyze,
    handleRefresh,
    clearAnalysisState,
    clearAnalysisCache,
  };
}
