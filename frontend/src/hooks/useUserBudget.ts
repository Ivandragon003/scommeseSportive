import { useCallback, useEffect, useMemo, useState } from 'react';
import { getBets, getBudget, syncSharedBets } from '../utils/api';
import { buildBetKey } from '../components/predictions/predictionWorkbenchUtils';

export function useUserBudget(activeUser: string) {
  const [budget, setBudget] = useState<any>(null);
  const [userBets, setUserBets] = useState<any[]>([]);

  const loadUserContext = useCallback(async () => {
    try {
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
    } catch {
      setBudget(null);
      setUserBets([]);
    }
  }, [activeUser]);

  useEffect(() => {
    void loadUserContext();
  }, [loadUserContext]);

  const bankroll = Number(budget?.available_budget ?? 0);
  const placedBetKeySet = useMemo(
    () =>
      new Set(
        (userBets ?? []).map((bet: any) =>
          buildBetKey(String(bet.match_id ?? ''), String(bet.selection ?? ''), String(bet.market_name ?? ''))
        )
      ),
    [userBets]
  );

  return {
    budget,
    userBets,
    bankroll,
    placedBetKeySet,
    setBudget,
    setUserBets,
    loadUserContext,
  };
}
