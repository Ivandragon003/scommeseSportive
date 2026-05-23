import { OddsApiProvider } from './OddsApiProvider';
import { OddsProviderCoordinator } from './OddsProviderCoordinator';

export type RuntimeOddsProviderName = 'odds_api';

export const getConfiguredOddsApiKey = (): string =>
  String(process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY ?? '').trim();

const getExplicitPrimaryProviderName = (): RuntimeOddsProviderName | null => {
  const value = String(process.env.ODDS_PRIMARY_PROVIDER ?? '').trim().toLowerCase();
  if (value === 'odds_api' || value === 'the_odds_api' || value === 'the-odds-api') return 'odds_api';
  return null;
};

export const getConfiguredPrimaryProviderName = (): RuntimeOddsProviderName => {
  const explicit = getExplicitPrimaryProviderName();
  if (explicit === 'odds_api') return 'odds_api';
  return 'odds_api';
};

export const getConfiguredFallbackProviderName = (): RuntimeOddsProviderName | null => null;

export type OddsProviderCoordinatorBundle = {
  coordinator: OddsProviderCoordinator;
  primaryProviderName: RuntimeOddsProviderName;
  fallbackProviderName: RuntimeOddsProviderName | null;
  apiKey: string;
};

export const createOddsProviderCoordinatorBundle = (): OddsProviderCoordinatorBundle => {
  const apiKey = getConfiguredOddsApiKey();
  const primaryProviderName = getConfiguredPrimaryProviderName();
  const fallbackProviderName = getConfiguredFallbackProviderName();
  const primaryProvider = new OddsApiProvider(apiKey);
  const fallbackProvider = null;

  return {
    coordinator: new OddsProviderCoordinator(primaryProvider, fallbackProvider),
    primaryProviderName,
    fallbackProviderName,
    apiKey,
  };
};
