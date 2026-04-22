import { useCallback, useEffect, useMemo, useState } from 'react';
import { getBets, getBudget } from '../utils/api';

export function useBudgetManagerData(activeUser: string) {
  const [budget, setBudget] = useState<any>(null);
  const [bets, setBets] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [loadingBudget, setLoadingBudget] = useState(true);
  const [loadingBets, setLoadingBets] = useState(true);

  const loadBudget = useCallback(async (options?: { force?: boolean }) => {
    setLoadingBudget(true);
    try {
      const budgetRes = await getBudget(activeUser, options);
      setBudget(budgetRes.data ?? null);
    } catch {
      setBudget(null);
    } finally {
      setLoadingBudget(false);
    }
  }, [activeUser]);

  const loadBets = useCallback(async (options?: { force?: boolean }) => {
    setLoadingBets(true);
    try {
      const betsRes = await getBets(activeUser, filter || undefined, options);
      setBets(betsRes.data ?? []);
    } catch {
      setBets([]);
    } finally {
      setLoadingBets(false);
    }
  }, [activeUser, filter]);

  const loadAll = useCallback(async (options?: { force?: boolean }) => {
    await Promise.all([loadBudget(options), loadBets(options)]);
  }, [loadBets, loadBudget]);

  useEffect(() => {
    void loadBudget();
  }, [loadBudget]);

  useEffect(() => {
    void loadBets();
  }, [loadBets]);

  const derived = useMemo(() => {
    const pending: any[] = [];
    const settled: any[] = [];
    let netProfit = 0;
    let winsCount = 0;
    let lossesCount = 0;
    let voidCount = 0;

    for (const bet of bets) {
      const status = String(bet?.status ?? '');
      if (status === 'PENDING') {
        pending.push(bet);
        continue;
      }

      if (status === 'WON') winsCount += 1;
      if (status === 'LOST') lossesCount += 1;
      if (status === 'VOID') voidCount += 1;
      if (status === 'WON' || status === 'LOST' || status === 'VOID') {
        settled.push(bet);
        netProfit += Number(bet?.profit ?? 0);
      }
    }

    return {
      pendingBets: pending,
      settledBets: settled,
      netProfit,
      winsCount,
      lossesCount,
      voidCount,
    };
  }, [bets]);

  return {
    budget,
    bets,
    filter,
    loading: loadingBudget || loadingBets,
    setBudget,
    setFilter,
    loadBudget,
    loadBets,
    loadAll,
    ...derived,
  };
}
