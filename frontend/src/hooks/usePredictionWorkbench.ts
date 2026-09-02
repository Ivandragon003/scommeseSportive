import { useCallback, useEffect, useMemo, useState } from 'react';
import { BestValueOpportunity as BestValueOpportunityModel } from '../components/predictions/predictionTypes';
import {
  buildBetKey,
  buildOddsReliabilityBadge,
  currentSeason,
  formatMarketKey,
  isWorthwhileLowConfidenceOpportunity,
  oddsCategoryLabel,
  rankOpportunity,
} from '../components/predictions/predictionWorkbenchUtils';
import { fmtSelection } from '../components/predictions/predictionFormatting';
import { useToastState } from './useToastState';
import { useConfirmDialog } from './useConfirmDialog';
import { useUserBudget } from './useUserBudget';
import { useMatchSelection } from './useMatchSelection';
import { usePredictionAnalysis } from './usePredictionAnalysis';
import { useBetPlacement } from './useBetPlacement';
import { archiveManualBetOpportunity } from '../utils/api';

export interface PredictionWorkbenchViewModel {
  activeUser: string;
  toastState: ReturnType<typeof useToastState>;
  confirmDialog: ReturnType<typeof useConfirmDialog>;
  userBudget: ReturnType<typeof useUserBudget>;
  matchSelection: ReturnType<typeof useMatchSelection>;
  predictionAnalysis: ReturnType<typeof usePredictionAnalysis>;
  handleBet: (opportunity: BestValueOpportunityModel) => Promise<void>;
  handleArchiveOpportunity: (opportunity: BestValueOpportunityModel) => Promise<void>;
  gp: any;
  cp: any;
  fp: any;
  sp: any;
  pp: any[];
  vb: BestValueOpportunityModel[];
  matchValueOpportunities: BestValueOpportunityModel[];
  playerValueOpportunities: BestValueOpportunityModel[];
  bestValueOpp: BestValueOpportunityModel | null;
  analysisFactors: any;
  methodology: any;
  vbRanked: BestValueOpportunityModel[];
  manualArchiveOpportunities: BestValueOpportunityModel[];
  manuallyArchivedOpportunityKeys: Set<string>;
  allOddsEntries: Array<{ selection: string; odd: number; bookmaker: string; category: string }>;
  allOddsGroups: Array<{ category: string; entries: Array<{ selection: string; odd: number; bookmaker: string; category: string }> }>;
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
  const [manuallyArchivedOpportunityKeys, setManuallyArchivedOpportunityKeys] = useState<Set<string>>(new Set());
  const userBudget = useUserBudget(activeUser);
  const matchSelection = useMatchSelection();
  const predictionAnalysis = usePredictionAnalysis({
    budget: userBudget.budget,
    competition: matchSelection.competition,
    matchMode: matchSelection.matchMode,
    teams: matchSelection.teams,
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
  const isPlayerPropOpportunity = useCallback((opportunity: BestValueOpportunityModel): boolean => {
    const category = String(opportunity.marketCategory ?? opportunity.marketType ?? '').toLowerCase();
    const selection = String(opportunity.selection ?? '').toLowerCase();
    return category.startsWith('player_') || /^player_.+_(shots|sot|yellow)_(over|under)_/.test(selection);
  }, []);
  const playerValueOpportunities = useMemo<BestValueOpportunityModel[]>(
    () => vb.filter(isPlayerPropOpportunity),
    [isPlayerPropOpportunity, vb]
  );
  const matchValueOpportunities = useMemo<BestValueOpportunityModel[]>(
    () => vb.filter((opportunity) => !isPlayerPropOpportunity(opportunity)),
    [isPlayerPropOpportunity, vb]
  );
  const bestValueOpp = (predictionAnalysis.pred?.bestValueOpportunity ?? null) as BestValueOpportunityModel | null;
  const analysisFactors = predictionAnalysis.pred?.analysisFactors ?? predictionAnalysis.pred?.methodology?.contextualFactors ?? null;
  const methodology = predictionAnalysis.pred?.methodology ?? {};

  const vbRanked = useMemo<BestValueOpportunityModel[]>(
    () => {
      const isVisibleTeamBet = (opportunity: BestValueOpportunityModel): boolean => {
        const confidence = String(opportunity.confidence ?? '').toUpperCase();
        const status = String(opportunity.bestBetStatus ?? '').toUpperCase();
        const tier = String(opportunity.marketTier ?? '').toUpperCase();
        const bookmakerOdds = Number(opportunity.bookmakerOdds);
        return (
          !isPlayerPropOpportunity(opportunity) &&
          status !== 'SPECULATIVE' &&
          tier !== 'SPECULATIVE' &&
          (
            confidence === 'MEDIUM' ||
            confidence === 'HIGH' ||
            isWorthwhileLowConfidenceOpportunity(opportunity)
          ) &&
          Number.isFinite(bookmakerOdds) &&
          bookmakerOdds > 1
        );
      };
      const opportunityKey = (opportunity: BestValueOpportunityModel): string =>
        `${String(opportunity.selection ?? '')}::${String(opportunity.marketName ?? '')}`;
      const recommendedOpportunity = bestValueOpp && isVisibleTeamBet(bestValueOpp)
        ? bestValueOpp
        : null;
      const candidatesByKey = new Map<string, BestValueOpportunityModel>();
      if (recommendedOpportunity) {
        candidatesByKey.set(opportunityKey(recommendedOpportunity), recommendedOpportunity);
      }
      for (const opportunity of matchValueOpportunities) {
        if (!isVisibleTeamBet(opportunity)) continue;
        const key = opportunityKey(opportunity);
        if (candidatesByKey.has(key)) continue;
        candidatesByKey.set(key, opportunity);
      }
      return Array.from(candidatesByKey.values())
        .sort((left, right) => {
          const confidenceBand = (opportunity: BestValueOpportunityModel) =>
            ['HIGH', 'MEDIUM'].includes(String(opportunity.confidence ?? '').toUpperCase()) ? 1 : 0;
          return confidenceBand(right) - confidenceBand(left)
            || rankOpportunity(right) - rankOpportunity(left);
        })
        .slice(0, 3);
    },
    [bestValueOpp, isPlayerPropOpportunity, matchValueOpportunities]
  );

  const allOddsEntries = useMemo(
    () => Object.entries(predictionAnalysis.odds)
      .map(([selection, odd]) => ({
        selection,
        odd: Number(odd),
        bookmaker: String(predictionAnalysis.bookmakerBySelection[selection] ?? '').trim(),
        category: oddsCategoryLabel(selection),
      }))
      .filter((entry) => Number.isFinite(entry.odd) && entry.odd > 1)
      .sort((left, right) => left.category.localeCompare(right.category, 'it')
        || fmtSelection(left.selection).localeCompare(fmtSelection(right.selection), 'it')),
    [predictionAnalysis.bookmakerBySelection, predictionAnalysis.odds]
  );
  const allOddsGroups = useMemo(() => {
    const grouped = new Map<string, typeof allOddsEntries>();
    for (const entry of allOddsEntries) {
      const entries = grouped.get(entry.category) ?? [];
      entries.push(entry);
      grouped.set(entry.category, entries);
    }
    return Array.from(grouped.entries()).map(([category, entries]) => ({ category, entries }));
  }, [allOddsEntries]);

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
          ? 'Replay costruito su snapshot Eurobet storico.'
          : 'Quota Eurobet storica non disponibile: il replay non espone prezzi stimati o di altri provider.')
      : predictionAnalysis.pred?.oddsSource !== 'odds_api' || !String(predictionAnalysis.pred?.oddsBookmaker ?? '').trim()
        ? 'Quota bookmaker non disponibile: nessuna quota fallback viene mostrata e non è possibile registrare la giocata.'
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
    const match = vbRanked[0] ?? null;
    if (!match) return null;
    const suggestedStakeAmount = userBudget.bankroll > 0
      ? (Number(match.suggestedStakePercent ?? 0) / 100) * userBudget.bankroll
      : 0;
    return {
      ...match,
      suggestedStakeAmount,
    };
  }, [userBudget.bankroll, vbRanked]);

  const suggestedTotalStake = Number(finalRecommendedChoice?.suggestedStakeAmount ?? 0);
  const exposureRatio = maxExposureAmount > 0 ? Math.min(1, suggestedTotalStake / maxExposureAmount) : 0;

  const oppStakeKey = useCallback((opportunity: BestValueOpportunityModel) =>
    buildBetKey(currentMatchId, String(opportunity.selection ?? ''), String(opportunity.marketName ?? '')),
  [currentMatchId]);

  const oppStakeValue = useCallback((opportunity: BestValueOpportunityModel) =>
    Number(predictionAnalysis.stakes[oppStakeKey(opportunity)] ?? 0),
  [oppStakeKey, predictionAnalysis.stakes]);

  const manualArchiveClassification = useCallback((opportunity: BestValueOpportunityModel): 'LOW' | 'SPECULATIVE' | null => {
    const status = String(opportunity.bestBetStatus ?? opportunity.bestBetDecision?.status ?? '').toUpperCase();
    const tier = String(opportunity.marketTier ?? '').toUpperCase();
    if (status === 'SPECULATIVE' || tier === 'SPECULATIVE') return 'SPECULATIVE';
    return String(opportunity.confidence ?? '').toUpperCase() === 'LOW' ? 'LOW' : null;
  }, []);

  const manualArchiveOpportunities = useMemo<BestValueOpportunityModel[]>(() => {
    if (!bestValueOpp || !manualArchiveClassification(bestValueOpp)) return [];
    return [bestValueOpp];
  }, [bestValueOpp, manualArchiveClassification]);

  const handleArchiveOpportunity = useCallback(async (opportunity: BestValueOpportunityModel) => {
    if (isReplayAnalysis) {
      toastState.showToast({ tone: 'warning', title: 'Replay retrospettivo', message: 'Una partita gia giocata non puo essere archiviata come opportunita futura.' });
      return;
    }
    const classification = manualArchiveClassification(opportunity);
    const bookmakerOdds = Number(opportunity.bookmakerOdds);
    const bookmakerName = String(opportunity.bookmakerName ?? predictionAnalysis.bookmakerBySelection[opportunity.selection] ?? '').trim();
    if (!classification || !currentMatchId || !Number.isFinite(bookmakerOdds) || bookmakerOdds <= 1 || !bookmakerName) {
      toastState.showToast({ tone: 'warning', title: 'Archiviazione non disponibile', message: 'Servono una LOW/SPECULATIVE e una quota bookmaker reale verificata.' });
      return;
    }

    try {
      await archiveManualBetOpportunity({
        matchId: currentMatchId,
        marketName: String(opportunity.marketName),
        selection: String(opportunity.selection),
        classification,
        bookmakerOdds,
        bookmakerName,
        suggestedStakePercent: Number(opportunity.suggestedStakePercent),
      });
      setManuallyArchivedOpportunityKeys((previous) => {
        const next = new Set(previous);
        next.add(oppStakeKey(opportunity));
        return next;
      });
      toastState.showToast({ tone: 'success', title: 'Opportunita archiviata', message: 'Salvata come simulata: il budget non e stato modificato.' });
    } catch (error) {
      toastState.showToast({ tone: 'error', title: 'Archiviazione non riuscita', message: error instanceof Error ? error.message : 'Riprova aggiornando la partita.' });
    }
  }, [currentMatchId, isReplayAnalysis, manualArchiveClassification, oppStakeKey, predictionAnalysis.bookmakerBySelection, toastState]);

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
    { id: 'playerProps', label: 'Mercati giocatore', count: playerValueOpportunities.length },
    { id: 'strategy', label: 'Pronostico Finale' },
    { id: 'method', label: 'Algoritmo' },
    { id: 'value', label: 'Scommesse', count: vbRanked.length },
  ], [allOddsEntries.length, playerValueOpportunities.length, pp.length, vbRanked.length]);

  return {
    activeUser,
    toastState,
    confirmDialog,
    userBudget,
    matchSelection,
    predictionAnalysis,
    handleBet,
    handleArchiveOpportunity,
    gp,
    cp,
    fp,
    sp,
    pp,
    vb,
    matchValueOpportunities,
    playerValueOpportunities,
    bestValueOpp,
    analysisFactors,
    methodology,
    vbRanked,
    manualArchiveOpportunities,
    manuallyArchivedOpportunityKeys,
    allOddsEntries,
    allOddsGroups,
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
