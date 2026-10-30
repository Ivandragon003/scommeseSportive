import { useCallback, useEffect, useMemo, useState } from 'react';
import { getBets, getBudget, syncSharedBets } from '../utils/api';
import { buildBetKey } from '../components/predictions/predictionWorkbenchUtils';
import { getAppWallets } from '../utils/walletApi';

type WalletFamily = 'A' | 'C';
type BudgetContext = { mode: 'automatic'; family: WalletFamily } | { mode: 'legacy' };

export const walletMatchKey = (family: WalletFamily, matchId: string): string => `${family}:${matchId}`;

export function useUserBudget(activeUser: string, context: BudgetContext = { mode: 'automatic', family: 'A' }) {
  const [budget, setBudget] = useState<any>(null);
  const [userBets, setUserBets] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const family = context.mode === 'automatic' ? context.family : null;

  const loadUserContext = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (family) {
        const data = await getAppWallets({ period: 'all' });
        const wallet = data.portfolios.find((row) => row.family === family);
        const values = [wallet?.initialCents, wallet?.currentEquityCents, wallet?.currentAvailableCents, wallet?.currentCommittedCents];
        if (!wallet || wallet.initialized === false || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
          throw new Error(`I dati del portafoglio ${family} non sono disponibili.`);
        }
        setBudget({
          portfolio_id: wallet.portfolioId, model_family: family, source: 'app_wallet',
          initial_budget: wallet.initialCents! / 100,
          total_budget: wallet.currentEquityCents! / 100,
          available_budget: wallet.currentAvailableCents! / 100,
          committed_budget: wallet.currentCommittedCents! / 100,
          stake_base_budget: wallet.currentEquityCents! / 100,
        });
        setUserBets(data.bets.rows.filter((bet) => bet.portfolioId === wallet.portfolioId && (!bet.family || bet.family === family))
          .map((bet) => ({ ...bet, model_family: family, match_id: bet.matchId,
            market_name: bet.market, stake: bet.stakeCents / 100 })));
        return;
      }
      // Keep the active-bet state current when a prediction is opened, without
      // changing the semantics of the read-only budget/bets endpoints.
      const syncResult = syncSharedBets();
      if (syncResult && typeof (syncResult as Promise<unknown>).then === 'function') {
        await syncResult.catch(() => undefined);
      }
      const [budgetRes, betsRes] = await Promise.all([
        getBudget(activeUser, { force: true }),
        getBets(activeUser, undefined, { force: true }),
      ]);
      setBudget(budgetRes.data ?? null);
      setUserBets(betsRes.data ?? []);
    } catch (failure) {
      setBudget(null);
      setUserBets([]);
      setError(failure instanceof Error ? failure.message : 'Portafoglio non disponibile.');
    } finally {
      setLoading(false);
    }
  }, [activeUser, family]);

  useEffect(() => {
    void loadUserContext();
  }, [loadUserContext]);

  const bankroll = Number((family ? budget?.total_budget : budget?.available_budget) ?? 0);
  const placedBetKeySet = useMemo(
    () =>
      new Set(
        (userBets ?? []).map((bet: any) =>
          buildBetKey(String(bet.match_id ?? ''), String(bet.selection ?? ''), String(bet.market_name ?? ''))
        )
      ),
    [userBets]
  );
  const placedMatchKeySet = useMemo(() => new Set<string>(family ? userBets.map((bet) =>
    walletMatchKey(family, String(bet.match_id ?? ''))) : []), [family, userBets]);

  return {
    budget,
    userBets,
    bankroll,
    placedBetKeySet,
    placedMatchKeySet,
    automaticFamily: family,
    error,
    loading,
    setBudget,
    setUserBets,
    loadUserContext,
  };
}
