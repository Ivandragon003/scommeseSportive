import { ComparisonBet } from '../research/researchComparisonTypes';
import { walletBetFamily, walletBetSelection, walletMarketLabel } from './AppWallets';

export type BetModel = 'all' | 'baseline' | 'A' | 'C';
export const betModel = (bet: any): Exclude<BetModel, 'all'> => {
  const family = walletBetFamily(bet);
  return family || 'baseline';
};
export const betModelLabel = (bet: any): string => {
  const family = betModel(bet);
  return family === 'baseline' ? 'Baseline deterministica' : `Modello ${family}`;
};

// Adapt display fields only. Original ledgers, stakes and outcomes are untouched.
export const unifiedBetRows = (legacy: any[], current: ComparisonBet[]): any[] => [
  ...legacy.map((bet) => ({ ...bet, family: 'A', historical: true, bet_id: `baseline:${bet.bet_id}` })),
  ...current.map((bet) => {
    const [home, away] = (bet.matchLabel || '').split(/\s+[–—-]\s+/);
    return {
      ...bet, bet_id: `wallet:${bet.id}`, home_team_name: home || bet.matchId || 'Partita non disponibile',
      away_team_name: away || '', competition: bet.league, placed_at: bet.createdAt,
      market_name: walletMarketLabel(bet.market), selection: walletBetSelection(bet),
      stake: bet.stakeCents / 100, profit: bet.profitCents == null ? null : bet.profitCents / 100,
      bookmaker_name: bet.quote?.bookmaker || bet.bookmaker || 'Bookmaker non disponibile',
      data_quality: 'post_fix',
    };
  }),
].sort((a, b) => Date.parse(b.placed_at) - Date.parse(a.placed_at));
