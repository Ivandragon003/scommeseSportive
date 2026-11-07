import { CURRENT_CHALLENGER_RELEASE } from './CurrentChallengerRelease';

/** Operational composition only: the frozen goal model and calibration stay unchanged. */
export const CHALLENGER_TEAM_MARKET_POLICY = 'c-team-markets-v1';
export const CHALLENGER_MARKET_ELIGIBILITY = 'code-supported-markets-v1';
export const CHALLENGER_TEAM_MARKETS = [
  '1x2', 'double_chance', 'dnb', 'btts', 'totals', 'team_totals',
  'european_handicap', 'asian_handicap', 'shots', 'shots_on_target', 'yellow_cards', 'cards_total',
] as const;

export function usesChallengerTeamMarkets(deployment: { modelVersion: string; selectorPolicy: string;
  baselineVersion?: string; probabilityConfigurationHash?: string | null; artifactHash?: string | null } | undefined): boolean {
  return deployment?.modelVersion === CURRENT_CHALLENGER_RELEASE.modelVersion
    && deployment.selectorPolicy === 'canonical-binary-v1'
    && deployment.baselineVersion === CURRENT_CHALLENGER_RELEASE.baselineVersion
    && deployment.probabilityConfigurationHash === CURRENT_CHALLENGER_RELEASE.probabilityConfigurationHash
    && deployment.artifactHash === CURRENT_CHALLENGER_RELEASE.artifactHash;
}

export function isChallengerStatMarket(market: string): boolean {
  return ['shots', 'shots_on_target', 'yellow_cards', 'cards_total'].includes(market);
}

/** Current coverage is a code contract, independent of scientific registry labels. */
export function challengerAllowedMarkets(deployment: Parameters<typeof usesChallengerTeamMarkets>[0],
  registered: Array<{ market: string; state: string }> = []): string[] {
  return usesChallengerTeamMarkets(deployment) ? [...CHALLENGER_TEAM_MARKETS]
    : registered.filter(row => ['EXPERIMENTAL', 'SHADOW', 'ACTIVE'].includes(row.state)).map(row => row.market);
}

export function usesCodeMarketEligibility(deployment: (NonNullable<Parameters<typeof usesChallengerTeamMarkets>[0]>
  & { marketEligibilityVersion?: string }) | undefined): boolean {
  return usesChallengerTeamMarkets(deployment) && deployment?.marketEligibilityVersion === CHALLENGER_MARKET_ELIGIBILITY;
}

export function challengerMarketAllowed(deployment: Parameters<typeof usesCodeMarketEligibility>[0],
  market: string, registeredState?: string): boolean {
  return usesCodeMarketEligibility(deployment) ? CHALLENGER_TEAM_MARKETS.includes(market as typeof CHALLENGER_TEAM_MARKETS[number])
    : ['EXPERIMENTAL', 'SHADOW', 'ACTIVE'].includes(registeredState ?? '');
}
