import { OddsApiService, OddsMatch } from '../OddsApiService';
import {
  OddsProviderAdapter,
  OddsProviderFetchResult,
  OddsProviderHealth,
  OddsProviderRequest,
} from './OddsProvider';
import { matchFixturesToMatches, mergeOddsMatchMarkets } from './oddsProviderUtils';

export class OddsApiProvider implements OddsProviderAdapter<OddsMatch> {
  private readonly service: OddsApiService | null;

  constructor(apiKey?: string | null) {
    this.service = apiKey && apiKey.trim() ? new OddsApiService(apiKey.trim()) : null;
  }

  getProviderName(): string {
    return 'odds_api';
  }

  async getCompetitionOdds(request: OddsProviderRequest): Promise<OddsProviderFetchResult<OddsMatch>> {
    this.ensureConfigured();
    return this.loadCompetitionOdds(request);
  }

  async getOddsForFixtures(request: OddsProviderRequest): Promise<OddsProviderFetchResult<OddsMatch>> {
    this.ensureConfigured();
    const baseResult = await this.loadCompetitionOdds(request);
    const fixtures = request.fixtures ?? [];

    if (fixtures.length === 0) {
      return baseResult;
    }

    const { matchedMatches, missingFixtures, diagnostics } = matchFixturesToMatches(fixtures, baseResult.matches);
    const warnings = [...baseResult.warnings];
    let fallbackReason = baseResult.fallbackReason;

    if (missingFixtures.length > 0) {
      warnings.push(`Fixture non trovate in Odds API: ${missingFixtures.length}/${fixtures.length}`);
      fallbackReason = fallbackReason ?? 'Copertura parziale Odds API sulle fixture richieste';
    }

    const loadedEventMarkets = new Set<string>();
    const matches = await Promise.all(
      matchedMatches.map(async (match) => this.enrichEventMarkets(request, match, warnings, loadedEventMarkets))
    );

    return {
      ...baseResult,
      matches,
      warnings,
      fallbackReason,
      details: {
        ...(baseResult.details ?? {}),
        matchesReceived: baseResult.matches.length,
        candidateCount: baseResult.matches.length,
        matchedFixtureCount: matchedMatches.length,
        missingFixtureCount: missingFixtures.length,
        fixtureDiagnostics: diagnostics,
        extraEventMarketsRequested: request.extraEventMarkets ?? [],
        extraEventMarketsLoaded: Array.from(loadedEventMarkets),
      },
    };
  }

  async healthCheck(_request: OddsProviderRequest): Promise<OddsProviderHealth> {
    if (!this.service) {
      return {
        provider: this.getProviderName(),
        status: 'disabled',
        checkedAt: new Date().toISOString(),
        message: 'ODDS_API_KEY non configurata',
      };
    }

    return {
      provider: this.getProviderName(),
      status: 'healthy',
      checkedAt: new Date().toISOString(),
      message: 'Odds API configurata',
      details: {
        remainingRequests: this.service.getRemainingRequests(),
      },
    };
  }

  extractBestOdds(match: OddsMatch, preferredBookmaker?: string): Record<string, number> {
    return this.service?.extractBestOdds(match, preferredBookmaker) ?? {};
  }

  compareBookmakers(match: OddsMatch): Record<string, Record<string, number>> {
    return this.service?.compareBookmakers(match) ?? {};
  }

  calculateMargin(match: OddsMatch, bookmakerKey: string): number | null {
    return this.service?.calculateMargin(match, bookmakerKey) ?? null;
  }

  getRuntimeMetadata(): Record<string, unknown> {
    return {
      remainingRequests: this.service?.getRemainingRequests() ?? null,
    };
  }

  private ensureConfigured(): void {
    if (!this.service) {
      throw new Error('OddsApiProvider disabled: missing ODDS_API_KEY');
    }
  }

  private async loadCompetitionOdds(request: OddsProviderRequest): Promise<OddsProviderFetchResult<OddsMatch>> {
    const markets = request.markets && request.markets.length > 0
      ? request.markets
      : ['h2h', 'totals', 'spreads'];
    const fallbackMarkets = request.fallbackMarkets && request.fallbackMarkets.length > 0
      ? request.fallbackMarkets
      : [];
    const attempts = [
      { label: 'primary', markets },
      { label: 'fallback', markets: fallbackMarkets },
      { label: 'minimal', markets: ['h2h', 'totals'] },
    ].filter((attempt, index, all) =>
      attempt.markets.length > 0
      && all.findIndex((entry) => entry.markets.join('|') === attempt.markets.join('|')) === index
    );
    const warnings: string[] = [];

    for (const attempt of attempts) {
      try {
        const matches = await this.service!.getOdds(request.competition, attempt.markets);
        const usedFallbackAttempt = attempt.label !== 'primary';
        if (usedFallbackAttempt) {
          warnings.push(`Odds API: caricamento mercati ${attempt.label} dopo errore sui mercati piu estesi.`);
        }
      return {
        matches,
        fetchedAt: new Date().toISOString(),
          fallbackReason: usedFallbackAttempt
            ? `Mercati primari Odds API non disponibili, uso set ${attempt.label}: ${attempt.markets.join(', ')}`
            : null,
          warnings,
        details: {
            marketsUsed: attempt.markets,
            marketsRequested: markets,
            fallbackMarketsRequested: fallbackMarkets,
          remainingRequests: this.service!.getRemainingRequests(),
          matchesReceived: matches.length,
          candidateCount: matches.length,
        },
      };
      } catch (error) {
        warnings.push(`Odds API ${attempt.label} markets failed (${attempt.markets.join(', ')}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(warnings.join(' | ') || 'Odds API non ha restituito quote per i mercati richiesti');
  }

  private async enrichEventMarkets(
    request: OddsProviderRequest,
    match: OddsMatch,
    warnings: string[],
    loadedEventMarkets?: Set<string>
  ): Promise<OddsMatch> {
    const eventMarkets = request.extraEventMarkets ?? [];
    if (eventMarkets.length === 0) return match;

    const eventId = String(match.matchId ?? '').startsWith('odds_')
      ? String(match.matchId).replace(/^odds_/, '')
      : '';
    if (!eventId) return match;

    try {
      const extra = await this.service!.getEventOdds(request.competition, eventId, eventMarkets);
      for (const market of eventMarkets) {
        loadedEventMarkets?.add(market);
      }
      return extra ? mergeOddsMatchMarkets(match, extra) : match;
    } catch (error) {
      warnings.push(
        `Mercati evento extra in batch non disponibili per ${match.homeTeam} vs ${match.awayTeam}: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    let enriched = match;
    const loadedMarkets: string[] = [];
    const uniqueMarkets = Array.from(new Set(eventMarkets.map((market) => String(market).trim()).filter(Boolean)));
    for (const market of uniqueMarkets) {
      try {
        const extra = await this.service!.getEventOdds(request.competition, eventId, [market]);
        if (!extra) continue;
        enriched = mergeOddsMatchMarkets(enriched, extra);
        loadedMarkets.push(market);
        loadedEventMarkets?.add(market);
      } catch (marketError) {
        warnings.push(
          `Mercato evento Odds API non disponibile (${market}) per ${match.homeTeam} vs ${match.awayTeam}: ${marketError instanceof Error ? marketError.message : String(marketError)}`
        );
      }
    }

    if (loadedMarkets.length > 0) {
      warnings.push(`Mercati evento Odds API caricati singolarmente: ${loadedMarkets.join(', ')}`);
    }
    return enriched;
  }
}
