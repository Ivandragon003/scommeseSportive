import { EurobetOddsProvider } from './EurobetOddsProvider';
import { OddsApiProvider } from './OddsApiProvider';
import { OddsProviderCoordinator } from './OddsProviderCoordinator';

export const getConfiguredOddsApiKey = (): string =>
  String(process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY ?? '').trim();

export const isEurobetScraperSkipped = (): boolean =>
  String(process.env.SKIP_EUROBET_SCRAPER ?? 'false').trim().toLowerCase() === 'true';

export const getConfiguredPrimaryProviderName = (): 'eurobet' | 'odds_api' =>
  isEurobetScraperSkipped() ? 'odds_api' : 'eurobet';

export const getConfiguredFallbackProviderName = (): 'odds_api' | null =>
  !isEurobetScraperSkipped() && Boolean(getConfiguredOddsApiKey()) ? 'odds_api' : null;

export type OddsProviderCoordinatorBundle = {
  coordinator: OddsProviderCoordinator;
  primaryProviderName: 'eurobet' | 'odds_api';
  fallbackProviderName: 'odds_api' | null;
  apiKey: string;
  skipEurobet: boolean;
};

export const createOddsProviderCoordinatorBundle = (): OddsProviderCoordinatorBundle => {
  const apiKey = getConfiguredOddsApiKey();
  const skipEurobet = isEurobetScraperSkipped();
  const primaryProvider = skipEurobet
    ? new OddsApiProvider(apiKey)
    : new EurobetOddsProvider();
  const fallbackProvider = !skipEurobet && apiKey
    ? new OddsApiProvider(apiKey)
    : null;

  return {
    coordinator: new OddsProviderCoordinator(primaryProvider, fallbackProvider),
    primaryProviderName: skipEurobet ? 'odds_api' : 'eurobet',
    fallbackProviderName: fallbackProvider ? 'odds_api' : null,
    apiKey,
    skipEurobet,
  };
};
