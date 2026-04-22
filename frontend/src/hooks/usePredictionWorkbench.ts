import { useCallback, useEffect, useMemo } from 'react';
import { BestValueOpportunity as BestValueOpportunityModel } from '../components/predictions/predictionTypes';
import {
  buildBetKey,
  buildOddsReliabilityBadge,
  currentSeason,
  formatMarketKey,
  rankOpportunity,
} from '../components/predictions/predictionWorkbenchUtils';
import { fmtSelection } from '../components/predictions/predictionFormatting';
import { useToastState } from './useToastState';
import { useConfirmDialog } from './useConfirmDialog';
import { useUserBudget } from './useUserBudget';
import { useMatchSelection } from './useMatchSelection';
import { usePredictionAnalysis } from './usePredictionAnalysis';
import { useBetPlacement } from './useBetPlacement';

export interface PredictionWorkbenchViewModel {
  activeUser: string;
  toastState: ReturnType<typeof useToastState>;
  confirmDialog: ReturnType<typeof useConfirmDialog>;
  userBudget: ReturnType<typeof useUserBudget>;
  matchSelection: ReturnType<typeof useMatchSelection>;
  predictionAnalysis: ReturnType<typeof usePredictionAnalysis>;
  handleBet: (opportunity: BestValueOpportunityModel) => Promise<void>;
  gp: any;
  cp: any;
  fp: any;
  sp: any;
  pp: any[];
  vb: BestValueOpportunityModel[];
  bestValueOpp: BestValueOpportunityModel | null;
  analysisFactors: any;
  methodology: any;
  vbRanked: BestValueOpportunityModel[];
  allOddsEntries: Array<{ selection: string; odd: number }>;
  valueSelectionSet: Set<string>;
  currentMatchId: string;
  isReplayAnalysis: boolean;
  actualMatch: any;
  recommendedBetResult: any;
  oddsReliabilityBadge: any;
  oddsSourceWarning: string | null;
  replayOutcomeTone: 'info' | 'success' | 'warning' | 'danger';
  replayOutcomeLabel: string;
  leftPanelTitle: string;
  bankroll: number;
  maxExposurePct: number;
  maxExposureAmount: number;
  finalRecommendedChoice: (BestValueOpportunityModel & { suggestedStakeAmount: number }) | null;
  suggestedTotalStake: number;
  exposureRatio: number;
  oppStakeKey: (opportunity: BestValueOpportunityModel) => string;
  oppStakeValue: (opportunity: BestValueOpportunityModel) => number;
  tabs: Array<{ id: string; label: string; count?: number }>;
  handleRefresh: () => void;
  formatMarketKey: (market: string) => string;
  currentSeason: () => string;
}

export function usePredictionWorkbench(activeUser: string): PredictionWorkbenchViewModel {
  const toastState = useToastState();
  const confirmDialog = useConfirmDialog();
  const userBudget = useUserBudget(activeUser);
  const matchSelection = useMatchSelection();
  const predictionAnalysis = usePredictionAnalysis({
    budget: userBudget.budget,
    competition: matchSelection.competition,
    matchMode: matchSelection.matchMode,
    teams: matchSelection.teams,
    setCompetition: matchSelection.setCompetition,
    setActiveMatchId: matchSelection.setActiveMatchId,
    setTab: matchSelection.setTab,
  });
  const clearAnalysisState = predictionAnalysis.clearAnalysisState;
  const clearAnalysisCache = predictionAnalysis.clearAnalysisCache;
  const refreshAnalysis = predictionAnalysis.handleRefresh;
  const setAutoSyncMsg = matchSelection.setAutoSyncMsg;
  const refreshVisibleMatches = matchSelection.refreshVisibleMatches;
  const loadMatchdays = matchSelection.loadMatchdays;
  const loadUserContext = userBudget.loadUserContext;

  useEffect(() => {
    clearAnalysisState();
  }, [clearAnalysisState, matchSelection.matchMode]);

  useEffect(() => {
    const onSyncDone = () => {
      setAutoSyncMsg('Dati aggiornati. Lista partite e modelli ricaricati.');
      clearAnalysisCache();
      void refreshVisibleMatches();
      void loadMatchdays();
      void loadUserContext();
    };
    const onSyncError = () => {
      setAutoSyncMsg('Aggiornamento automatico non completato. Uso ultimi dati disponibili.');
    };

    window.addEventListener('data-sync-complete', onSyncDone);
    window.addEventListener('data-sync-error', onSyncError);
    return () => {
      window.removeEventListener('data-sync-complete', onSyncDone);
      window.removeEventListener('data-sync-error', onSyncError);
    };
  }, [
    clearAnalysisCache,
    loadMatchdays,
    loadUserContext,
    refreshVisibleMatches,
    setAutoSyncMsg,
  ]);

  const { handleBet } = useBetPlacement({
    activeUser,
    budget: userBudget.budget,
    pred: predictionAnalysis.pred,
    activeMatchRow: matchSelection.activeMatchRow,
    competition: matchSelection.competition,
    bankroll: userBudget.bankroll,
    stakes: predictionAnalysis.stakes,
    setStakes: predictionAnalysis.setStakes,
    loadUserContext: userBudget.loadUserContext,
    confirm: confirmDialog.confirm,
    showToast: toastState.showToast,
  });

  const gp = predictionAnalysis.pred?.goalProbabilities;
  const cp = predictionAnalysis.pred?.cardsPrediction;
  const fp = predictionAnalysis.pred?.foulsPrediction;
  const sp = predictionAnalysis.pred?.shotsPrediction;
  const pp: any[] = predictionAnalysis.pred?.playerShotsPredictions ?? [];
  const vb = useMemo<BestValueOpportunityModel[]>(
    () => predictionAnalysis.pred?.valueOpportunities ?? [],
    [predictionAnalysis.pred?.valueOpportunities]
  );
  const bestValueOpp = (predictionAnalysis.pred?.bestValueOpportunity ?? null) as BestValueOpportunityModel | null;
  const analysisFactors = predictionAnalysis.pred?.analysisFactors ?? predictionAnalysis.pred?.methodology?.contextualFactors ?? null;
  const methodology = predictionAnalysis.pred?.methodology ?? {};

  const vbRanked = useMemo<BestValueOpportunityModel[]>(
    () => [...vb].sort((left, right) => rankOpportunity(right) - rankOpportunity(left)),
    [vb]
  );

  const allOddsEntries = useMemo(
    () => Object.entries(predictionAnalysis.odds)
      .map(([selection, odd]) => ({ selection, odd: Number(odd) }))
      .filter((entry) => Number.isFinite(entry.odd) && entry.odd > 1)
      .sort((left, right) => fmtSelection(left.selection).localeCompare(fmtSelection(right.selection), 'it')),
    [predictionAnalysis.odds]
  );

  const valueSelectionSet = useMemo(
    () => new Set((vb ?? []).map((opportunity: any) => String(opportunity.selection))),
    [vb]
  );

  const currentMatchId = String(predictionAnalysis.pred?.matchId ?? matchSelection.activeMatchId ?? '');
  const isReplayAnalysis = predictionAnalysis.pred?.analysisMode === 'played_match_replay';
  const actualMatch = predictionAnalysis.pred?.actualMatch ?? null;
  const recommendedBetResult = predictionAnalysis.pred?.recommendedBetResult ?? null;
  const oddsReliabilityBadge = buildOddsReliabilityBadge(predictionAnalysis.pred, isReplayAnalysis);
  const oddsSourceWarning =
    isReplayAnalysis
      ? (predictionAnalysis.pred?.oddsReplaySource === 'historical_bookmaker_snapshot'
          ? 'Replay costruito su snapshot bookmaker storico.'
          : 'Replay costruito su quote modello: utile per analisi, non come riferimento operativo.')
      : predictionAnalysis.pred?.usedSyntheticOdds
        ? 'Quote stimate dal modello: trattale come supporto analitico, non come prezzo bookmaker verificato.'
        : predictionAnalysis.pred?.oddsSource === 'fallback_provider'
          ? 'Provider secondario attivo: confronta la giocata con Eurobet prima di eseguirla.'
          : predictionAnalysis.pred?.oddsSource === 'eurobet_unavailable'
            ? 'Eurobet non ha esposto quote operative per questo match.'
            : null;

  const replayOutcomeTone =
    recommendedBetResult?.status === 'WON'
      ? 'success'
      : recommendedBetResult?.status === 'LOST'
        ? 'danger'
        : recommendedBetResult?.status === 'VOID'
          ? 'warning'
          : 'info';
  const replayOutcomeLabel =
    recommendedBetResult?.status === 'WON'
      ? 'Pronostico verificato: esito vincente'
      : recommendedBetResult?.status === 'LOST'
        ? 'Pronostico verificato: esito perdente'
        : recommendedBetResult?.status === 'VOID'
          ? 'Pronostico verificato: esito void'
          : '';

  const leftPanelTitle = matchSelection.matchMode === 'recent' ? 'Partite recenti giocate' : 'Partite in programma';
  const maxExposurePct = 8;
  const maxExposureAmount = userBudget.bankroll > 0 ? (userBudget.bankroll * maxExposurePct) / 100 : 0;

  const finalRecommendedChoice = useMemo(() => {
    if (!bestValueOpp) return null;
    const match =
      vbRanked.find((opportunity) =>
        String(opportunity.selection ?? '') === String(bestValueOpp.selection ?? '') &&
        String(opportunity.marketName ?? '') === String(bestValueOpp.marketName ?? '')
      ) ?? null;
    if (!match) return null;
    const suggestedStakeAmount = userBudget.bankroll > 0
      ? (Number(match.suggestedStakePercent ?? 0) / 100) * userBudget.bankroll
      : 0;
    return {
      ...match,
      suggestedStakeAmount,
    };
  }, [bestValueOpp, userBudget.bankroll, vbRanked]);

  const suggestedTotalStake = Number(finalRecommendedChoice?.suggestedStakeAmount ?? 0);
  const exposureRatio = maxExposureAmount > 0 ? Math.min(1, suggestedTotalStake / maxExposureAmount) : 0;

  const oppStakeKey = useCallback((opportunity: BestValueOpportunityModel) =>
    buildBetKey(currentMatchId, String(opportunity.selection ?? ''), String(opportunity.marketName ?? '')),
  [currentMatchId]);

  const oppStakeValue = useCallback((opportunity: BestValueOpportunityModel) =>
    Number(predictionAnalysis.stakes[oppStakeKey(opportunity)] ?? 0),
  [oppStakeKey, predictionAnalysis.stakes]);

  const handleRefresh = useCallback(() => {
    refreshAnalysis(matchSelection.activeMatchRow);
  }, [matchSelection.activeMatchRow, refreshAnalysis]);

  const tabs = useMemo(() => [
    { id: '1x2', label: '1X2 & Goal' },
    { id: 'handicap', label: 'Handicap' },
    { id: 'odds', label: 'Quote Complete', count: allOddsEntries.length },
    { id: 'scores', label: 'Risultati' },
    { id: 'cards', label: 'Cartellini' },
    { id: 'fouls', label: 'Falli' },
    { id: 'shots', label: 'Tiri' },
    { id: 'players', label: 'Giocatori', count: pp.length },
    { id: 'strategy', label: 'Pronostico Finale' },
    { id: 'method', label: 'Algoritmo' },
    { id: 'value', label: 'Scommesse', count: vb.length },
  ], [allOddsEntries.length, pp.length, vb.length]);

  return {
    activeUser,
    toastState,
    confirmDialog,
    userBudget,
    matchSelection,
    predictionAnalysis,
    handleBet,
    gp,
    cp,
    fp,
    sp,
    pp,
    vb,
    bestValueOpp,
    analysisFactors,
    methodology,
    vbRanked,
    allOddsEntries,
    valueSelectionSet,
    currentMatchId,
    isReplayAnalysis,
    actualMatch,
    recommendedBetResult,
    oddsReliabilityBadge,
    oddsSourceWarning,
    replayOutcomeTone,
    replayOutcomeLabel,
    leftPanelTitle,
    bankroll: userBudget.bankroll,
    maxExposurePct,
    maxExposureAmount,
    finalRecommendedChoice,
    suggestedTotalStake,
    exposureRatio,
    oppStakeKey,
    oppStakeValue,
    tabs,
    handleRefresh,
    formatMarketKey,
    currentSeason,
  };
}
