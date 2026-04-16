import { OddsMatch } from '../OddsApiService';
import {
  OddsProviderAdapter,
  OddsProviderFixture,
  OddsProviderHealth,
  OddsProviderHealthStatus,
  OddsProviderRequest,
} from './OddsProvider';
import { collectMarketSources, findBestMatchIndex, matchFixturesToMatches, mergeOddsMatchMarkets } from './oddsProviderUtils';

type CoordinatorOptions = {
  mergeMarkets?: boolean;
  useFallback?: boolean;
};

export type CoordinatedOddsMatch = {
  match: OddsMatch;
  providerMatches: Partial<Record<string, OddsMatch>>;
  oddsSource: string;
  fallbackReason: string | null;
  providerHealth: Record<string, OddsProviderHealth>;
  fetchedAt: string;
  isMerged: boolean;
  marketSources: Record<string, string[]>;
  bestOddsByProvider: Record<string, Record<string, number>>;
  bookmakerComparisonByProvider: Record<string, Record<string, Record<string, number>>>;
  marginsByProvider: Record<string, Record<string, string>>;
};

export type CoordinatedOddsResponse = {
  primaryProvider: string;
  fetchedAt: string;
  fallbackReason: string | null;
  providerHealth: Record<string, OddsProviderHealth>;
  providerRuntime: Record<string, Record<string, unknown>>;
  isMerged: boolean;
  matches: CoordinatedOddsMatch[];
  warnings: string[];
};

type ProviderFetchState = {
  matches: OddsMatch[];
  fallbackReason: string | null;
  warnings: string[];
  fetchedAt: string;
  runtime: Record<string, unknown>;
};

export class OddsProviderCoordinator {
  constructor(
    private readonly primaryProvider: OddsProviderAdapter,
    private readonly fallbackProvider?: OddsProviderAdapter | null
  ) {}

  async getCompetitionOdds(
    request: OddsProviderRequest,
    options: CoordinatorOptions = {}
  ): Promise<CoordinatedOddsResponse> {
    return this.execute(request, options, false);
  }

  async getOddsForFixtures(
    request: OddsProviderRequest,
    options: CoordinatorOptions = {}
  ): Promise<CoordinatedOddsResponse> {
    return this.execute(request, options, true);
  }

  private async execute(
    request: OddsProviderRequest,
    options: CoordinatorOptions,
    fixtureScoped: boolean
  ): Promise<CoordinatedOddsResponse> {
    const fetchedAt = new Date().toISOString();
    const providerHealth: Record<string, OddsProviderHealth> = {
      [this.primaryProvider.getProviderName()]: this.buildHealth(this.primaryProvider.getProviderName(), 'not_checked'),
    };
    const providerRuntime: Record<string, Record<string, unknown>> = {
      [this.primaryProvider.getProviderName()]: this.primaryProvider.getRuntimeMetadata(),
    };

    if (this.fallbackProvider) {
      providerHealth[this.fallbackProvider.getProviderName()] = this.buildHealth(this.fallbackProvider.getProviderName(), 'not_checked');
      providerRuntime[this.fallbackProvider.getProviderName()] = this.fallbackProvider.getRuntimeMetadata();
    }

    const warnings: string[] = [];
    let primaryState: ProviderFetchState | null = null;
    let fallbackState: ProviderFetchState | null = null;
    let fallbackReason: string | null = null;

    try {
      primaryState = await this.fetchFromProvider(this.primaryProvider, request, fixtureScoped);
      providerHealth[this.primaryProvider.getProviderName()] = this.buildHealth(
        this.primaryProvider.getProviderName(),
        primaryState.matches.length > 0 ? 'healthy' : 'degraded',
        primaryState.matches.length > 0 ? undefined : 'Provider primario senza match utili'
      );
      providerRuntime[this.primaryProvider.getProviderName()] = this.primaryProvider.getRuntimeMetadata();
      warnings.push(...primaryState.warnings);
    } catch (error) {
      providerHealth[this.primaryProvider.getProviderName()] = this.buildHealthFromError(
        this.primaryProvider.getProviderName(),
        error
      );
      warnings.push(`${this.primaryProvider.getProviderName()}: ${error instanceof Error ? error.message : String(error)}`);
      fallbackReason = `Provider primario ${this.primaryProvider.getProviderName()} non disponibile`;
    }

    const needFallback = Boolean(this.fallbackProvider)
      && options.useFallback !== false
      && (
        !primaryState
        || primaryState.matches.length === 0
        || (fixtureScoped && (primaryState.matches.length < (request.fixtures?.length ?? 0)))
        || options.mergeMarkets === true
      );

    if (needFallback && this.fallbackProvider) {
      try {
        fallbackState = await this.fetchFromProvider(this.fallbackProvider, request, fixtureScoped);
        providerHealth[this.fallbackProvider.getProviderName()] = this.buildHealth(
          this.fallbackProvider.getProviderName(),
          fallbackState.matches.length > 0 ? 'healthy' : 'degraded',
          fallbackState.matches.length > 0 ? undefined : 'Provider fallback senza match utili'
        );
        providerRuntime[this.fallbackProvider.getProviderName()] = this.fallbackProvider.getRuntimeMetadata();
        warnings.push(...fallbackState.warnings);
        fallbackReason = fallbackReason ?? fallbackState.fallbackReason;
      } catch (error) {
        providerHealth[this.fallbackProvider.getProviderName()] = this.buildHealthFromError(
          this.fallbackProvider.getProviderName(),
          error
        );
        warnings.push(`${this.fallbackProvider.getProviderName()}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const matches = this.composeMatches(
      request.fixtures ?? [],
      primaryState,
      fallbackState,
      providerHealth,
      fetchedAt,
      Boolean(options.mergeMarkets)
    );

    const response: CoordinatedOddsResponse = {
      primaryProvider: this.primaryProvider.getProviderName(),
      fetchedAt,
      fallbackReason: fallbackReason ?? this.deriveFallbackReason(matches),
      providerHealth,
      providerRuntime,
      isMerged: matches.some((entry) => entry.isMerged),
      matches,
      warnings: Array.from(new Set(warnings.filter(Boolean))),
    };

    await Promise.all([
      this.primaryProvider.close?.(),
      this.fallbackProvider?.close?.(),
    ]);

    return response;
  }

  private async fetchFromProvider(
    provider: OddsProviderAdapter,
    request: OddsProviderRequest,
    fixtureScoped: boolean
  ): Promise<ProviderFetchState> {
    const result = fixtureScoped
      ? await provider.getOddsForFixtures(request)
      : await provider.getCompetitionOdds(request);

    return {
      matches: result.matches,
      fallbackReason: result.fallbackReason,
      warnings: result.warnings,
      fetchedAt: result.fetchedAt,
      runtime: provider.getRuntimeMetadata(),
    };
  }

  private composeMatches(
    fixtures: OddsProviderFixture[],
    primaryState: ProviderFetchState | null,
    fallbackState: ProviderFetchState | null,
    providerHealth: Record<string, OddsProviderHealth>,
    fetchedAt: string,
    mergeMarkets: boolean
  ): CoordinatedOddsMatch[] {
    const primaryName = this.primaryProvider.getProviderName();
    const fallbackName = this.fallbackProvider?.getProviderName() ?? null;

    const primaryMatches = primaryState?.matches ?? [];
    const fallbackMatches = fallbackState?.matches ?? [];

    if (fixtures.length > 0) {
      const primaryPool = [...primaryMatches];
      const fallbackPool = [...fallbackMatches];
      const composed: CoordinatedOddsMatch[] = [];

      for (const fixture of fixtures) {
        const primaryIndex = findBestMatchIndex(primaryPool, fixture);
        const fallbackIndex = findBestMatchIndex(fallbackPool, fixture);
        const primaryMatch = primaryIndex >= 0 ? primaryPool.splice(primaryIndex, 1)[0] : null;
        const fallbackMatch = fallbackIndex >= 0 ? fallbackPool.splice(fallbackIndex, 1)[0] : null;
        const entry = this.composeSingleMatch(
          primaryName,
          fallbackName,
          primaryMatch,
          fallbackMatch,
          providerHealth,
          fetchedAt,
          mergeMarkets
        );
        if (entry) {
          composed.push(entry);
        }
      }

      return composed;
    }

    if (primaryMatches.length === 0 && fallbackMatches.length === 0) {
      return [];
    }

    if (primaryMatches.length === 0) {
      return fallbackMatches
        .map((match) => this.composeSingleMatch(primaryName, fallbackName, null, match, providerHealth, fetchedAt, false))
        .filter((entry): entry is CoordinatedOddsMatch => Boolean(entry));
    }

    const fallbackPool = [...fallbackMatches];
    return primaryMatches
      .map((match) => {
        let fallbackMatch: OddsMatch | null = null;
        if (mergeMarkets && fallbackPool.length > 0) {
          const index = findBestMatchIndex(fallbackPool, {
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            commenceTime: match.commenceTime,
          });
          fallbackMatch = index >= 0 ? fallbackPool.splice(index, 1)[0] : null;
        }

        return this.composeSingleMatch(
          primaryName,
          fallbackName,
          match,
          fallbackMatch,
          providerHealth,
          fetchedAt,
          mergeMarkets
        );
      })
      .filter((entry): entry is CoordinatedOddsMatch => Boolean(entry));
  }

  private composeSingleMatch(
    primaryName: string,
    fallbackName: string | null,
    primaryMatch: OddsMatch | null,
    fallbackMatch: OddsMatch | null,
    providerHealth: Record<string, OddsProviderHealth>,
    fetchedAt: string,
    mergeMarkets: boolean
  ): CoordinatedOddsMatch | null {
    if (!primaryMatch && !fallbackMatch) return null;

    const isMerged = Boolean(primaryMatch && fallbackMatch && mergeMarkets);
    const baseMatch = primaryMatch ?? fallbackMatch!;
    const mergedMatch = isMerged ? mergeOddsMatchMarkets(primaryMatch!, fallbackMatch!) : baseMatch;
    const providerMatches: Partial<Record<string, OddsMatch>> = {
      [primaryName]: primaryMatch ?? undefined,
      ...(fallbackName ? { [fallbackName]: fallbackMatch ?? undefined } : {}),
    };
    const oddsSource = isMerged
      ? `${primaryName}+${fallbackName}`
      : primaryMatch
        ? primaryName
        : (fallbackName ?? primaryName);
    const fallbackReason = primaryMatch
      ? null
      : `Provider primario ${primaryName} non disponibile per questo match`;
    const marketSources = collectMarketSources(providerMatches);

    const bestOddsByProvider = Object.fromEntries(
      Object.entries(providerMatches)
        .filter(([, match]) => Boolean(match))
        .map(([providerName, match]) => [
          providerName,
          this.getProvider(providerName)?.extractBestOdds(match as OddsMatch, providerName === 'eurobet' ? 'eurobet' : undefined) ?? {},
        ])
    );

    const bookmakerComparisonByProvider = Object.fromEntries(
      Object.entries(providerMatches)
        .filter(([, match]) => Boolean(match))
        .map(([providerName, match]) => [
          providerName,
          this.getProvider(providerName)?.compareBookmakers(match as OddsMatch) ?? {},
        ])
    );

    const marginsByProvider = Object.fromEntries(
      Object.entries(providerMatches)
        .filter(([, match]) => Boolean(match))
        .map(([providerName, match]) => {
          const provider = this.getProvider(providerName);
          const margins = (match?.bookmakers ?? []).reduce((acc, bookmaker) => {
            const margin = provider?.calculateMargin(match as OddsMatch, bookmaker.bookmakerKey) ?? null;
            if (margin !== null) {
              acc[bookmaker.bookmakerName] = `${margin}%`;
            }
            return acc;
          }, {} as Record<string, string>);

          return [providerName, margins];
        })
    );

    return {
      match: mergedMatch,
      providerMatches,
      oddsSource,
      fallbackReason,
      providerHealth,
      fetchedAt,
      isMerged,
      marketSources,
      bestOddsByProvider,
      bookmakerComparisonByProvider,
      marginsByProvider,
    };
  }

  private getProvider(providerName: string): OddsProviderAdapter | null {
    if (this.primaryProvider.getProviderName() === providerName) return this.primaryProvider;
    if (this.fallbackProvider?.getProviderName() === providerName) return this.fallbackProvider;
    return null;
  }

  private deriveFallbackReason(matches: CoordinatedOddsMatch[]): string | null {
    return matches.find((match) => match.fallbackReason)?.fallbackReason ?? null;
  }

  private buildHealth(
    provider: string,
    status: OddsProviderHealthStatus,
    message?: string,
    details?: Record<string, unknown>
  ): OddsProviderHealth {
    return {
      provider,
      status,
      checkedAt: new Date().toISOString(),
      message,
      details,
    };
  }

  private buildHealthFromError(provider: string, error: unknown): OddsProviderHealth {
    const message = error instanceof Error ? error.message : String(error);
    const status: OddsProviderHealthStatus = /missing|disabled/i.test(message) ? 'disabled' : 'unhealthy';
    return this.buildHealth(provider, status, message);
  }
}
