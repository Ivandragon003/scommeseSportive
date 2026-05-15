import { EurobetOddsProvider } from './EurobetOddsProvider';
import { OddsApiProvider } from './OddsApiProvider';
import { OddsProviderCoordinator } from './OddsProviderCoordinator';

export type RuntimeOddsProviderName = 'eurobet' | 'odds_api';

export const getConfiguredOddsApiKey = (): string =>
  String(process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY ?? '').trim();

export const isEurobetScraperSkipped = (): boolean =>
  String(process.env.SKIP_EUROBET_SCRAPER ?? 'false').trim().toLowerCase() === 'true';

const getExplicitPrimaryProviderName = (): RuntimeOddsProviderName | null => {
  const value = String(process.env.ODDS_PRIMARY_PROVIDER ?? '').trim().toLowerCase();
  if (value === 'eurobet' || value === 'eurobet_scraper') return 'eurobet';
  if (value === 'odds_api' || value === 'the_odds_api' || value === 'the-odds-api') return 'odds_api';
  return null;
};

export const getConfiguredPrimaryProviderName = (): RuntimeOddsProviderName => {
  const explicit = getExplicitPrimaryProviderName();
  const skipEurobet = isEurobetScraperSkipped();
  const hasOddsApiKey = Boolean(getConfiguredOddsApiKey());

  if (explicit === 'eurobet' && !skipEurobet) return 'eurobet';
  if (explicit === 'odds_api') return 'odds_api';
  if (hasOddsApiKey) return 'odds_api';
  return 'odds_api';
};

export const getConfiguredFallbackProviderName = (): RuntimeOddsProviderName | null => {
  const primary = getConfiguredPrimaryProviderName();
  const skipEurobet = isEurobetScraperSkipped();
  const hasOddsApiKey = Boolean(getConfiguredOddsApiKey());

  if (primary === 'odds_api' && !skipEurobet) return 'eurobet';
  if (primary === 'eurobet' && hasOddsApiKey) return 'odds_api';
  return null;
};

export type OddsProviderCoordinatorBundle = {
  coordinator: OddsProviderCoordinator;
  primaryProviderName: RuntimeOddsProviderName;
  fallbackProviderName: RuntimeOddsProviderName | null;
  apiKey: string;
  skipEurobet: boolean;
};

export const createOddsProviderCoordinatorBundle = (): OddsProviderCoordinatorBundle => {
  const apiKey = getConfiguredOddsApiKey();
  const skipEurobet = isEurobetScraperSkipped();
  const primaryProviderName = getConfiguredPrimaryProviderName();
  const fallbackProviderName = getConfiguredFallbackProviderName();
  const primaryProvider = primaryProviderName === 'odds_api'
    ? new OddsApiProvider(apiKey)
    : new EurobetOddsProvider();
  const fallbackProvider = fallbackProviderName === 'odds_api'
    ? new OddsApiProvider(apiKey)
    : fallbackProviderName === 'eurobet'
      ? new EurobetOddsProvider()
      : null;

  return {
    coordinator: new OddsProviderCoordinator(primaryProvider, fallbackProvider),
    primaryProviderName,
    fallbackProviderName,
    apiKey,
    skipEurobet,
  };
};
