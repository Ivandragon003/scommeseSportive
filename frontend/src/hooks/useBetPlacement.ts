import { useCallback } from 'react';
import { placeBet } from '../utils/api';
import { getErrorMessage } from '../utils/errorUtils';
import { buildBetKey } from '../components/predictions/predictionWorkbenchUtils';
import type { ToastTone } from './useToastState';

interface UseBetPlacementParams {
  activeUser: string;
  budget: any;
  pred: any;
  activeMatchRow: any;
  competition: string;
  bankroll: number;
  stakes: Record<string, string>;
  setStakes: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  loadUserContext: () => Promise<void>;
  confirm: (options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: 'danger' | 'warning' | 'info';
  }) => Promise<boolean>;
  showToast: (input: { tone?: ToastTone; title?: string; message: string; durationMs?: number }) => string;
}

export function useBetPlacement({
  activeUser,
  budget,
  pred,
  activeMatchRow,
  competition,
  bankroll,
  stakes,
  setStakes,
  loadUserContext,
  confirm,
  showToast,
}: UseBetPlacementParams) {
  const handleBet = useCallback(async (opportunity: any) => {
    if (pred?.analysisMode === 'played_match_replay') {
      showToast({
        tone: 'warning',
        title: 'Replay retrospettivo',
        message: 'Partita gia giocata: questa schermata serve solo a verificare il consiglio finale.',
      });
      return;
    }

    if (!budget) {
      showToast({
        tone: 'warning',
        title: 'Bankroll mancante',
        message: 'Inizializza il bankroll nella sezione Budget prima di registrare una giocata.',
      });
      return;
    }

    const key = buildBetKey(
      String(pred?.matchId ?? ''),
      String(opportunity.selection ?? ''),
      String(opportunity.marketName ?? '')
    );
    const manualStake = parseFloat(stakes[key] ?? '0');
    const suggestedStake = bankroll > 0
      ? (Number(opportunity.suggestedStakePercent ?? 0) / 100) * bankroll
      : 0;
    const fallbackStake = Math.max(1, Number(suggestedStake.toFixed(2)));
    const stake = manualStake > 0 ? manualStake : fallbackStake;

    if (manualStake <= 0 && stake > 0) {
      const confirmed = await confirm({
        title: 'Usare lo stake suggerito?',
        message: `Nessuna puntata inserita. Vuoi usare lo stake suggerito di EUR ${stake.toFixed(2)}?`,
        confirmLabel: 'Usa stake suggerito',
        cancelLabel: 'Annulla',
        tone: 'info',
      });
      if (!confirmed) return;
      setStakes((previous) => ({ ...previous, [key]: stake.toFixed(2) }));
    }

    if (stake < 1) {
      showToast({
        tone: 'warning',
        title: 'Stake non valido',
        message: 'Puntata minima Eurobet: 1 EUR.',
      });
      return;
    }

    try {
      await placeBet({
        userId: activeUser,
        matchId: String(pred.matchId),
        marketName: String(opportunity.marketName),
        selection: String(opportunity.selection),
        odds: Number(opportunity.bookmakerOdds),
        stake,
        ourProbability: Number(opportunity.ourProbability) / 100,
        expectedValue: Number(opportunity.expectedValue) / 100,
        homeTeamName: String(pred.homeTeam ?? ''),
        awayTeamName: String(pred.awayTeam ?? ''),
        competition: String(pred.competition ?? competition ?? ''),
        matchDate: String(activeMatchRow?.date ?? ''),
      });
      await loadUserContext();
      showToast({
        tone: 'success',
        title: 'Bet registrata',
        message: `Registrata ${opportunity.selectionLabel ?? opportunity.selection} a quota ${Number(opportunity.bookmakerOdds ?? 0).toFixed(2)}.`,
      });
    } catch (error) {
      showToast({
        tone: 'error',
        title: 'Registrazione non riuscita',
        message: getErrorMessage(error),
      });
    }
  }, [
    activeMatchRow?.date,
    activeUser,
    bankroll,
    budget,
    competition,
    confirm,
    loadUserContext,
    pred,
    setStakes,
    showToast,
    stakes,
  ]);

  return {
    handleBet,
  };
}
