import { OddsApiService, OddsMatch } from '../OddsApiService';
import {
  OddsProviderAdapter,
  OddsProviderFetchResult,
  OddsProviderFixture,
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

    const { matchedMatches, missingFixtures } = matchFixturesToMatches(fixtures, baseResult.matches);
    const warnings = [...baseResult.warnings];
    let fallbackReason = baseResult.fallbackReason;

    if (missingFixtures.length > 0) {
      warnings.push(`Fixture non trovate nel provider secondario: ${missingFixtures.length}/${fixtures.length}`);
      fallbackReason = fallbackReason ?? 'Copertura parziale del provider secondario sulle fixture richieste';
    }

    const matches = await Promise.all(
      matchedMatches.map(async (match) => this.enrichEventMarkets(request, match, warnings))
    );

    return {
      ...baseResult,
      matches,
      warnings,
      fallbackReason,
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
      message: 'Provider secondario configurato',
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

    try {
      const matches = await this.service!.getOdds(request.competition, markets);
      return {
        matches,
        fetchedAt: new Date().toISOString(),
        fallbackReason: null,
        warnings: [],
        details: {
          marketsUsed: markets,
          remainingRequests: this.service!.getRemainingRequests(),
        },
      };
    } catch (error) {
      if (fallbackMarkets.length === 0) {
        throw error;
      }

      const matches = await this.service!.getOdds(request.competition, fallbackMarkets);
      return {
        matches,
        fetchedAt: new Date().toISOString(),
        fallbackReason: 'Mercati primari non disponibili sul provider secondario, uso fallback mercati estesi',
        warnings: [
          error instanceof Error ? error.message : String(error),
        ],
        details: {
          marketsUsed: fallbackMarkets,
          remainingRequests: this.service!.getRemainingRequests(),
        },
      };
    }
  }

  private async enrichEventMarkets(
    request: OddsProviderRequest,
    match: OddsMatch,
    warnings: string[]
  ): Promise<OddsMatch> {
    const eventMarkets = request.extraEventMarkets ?? [];
    if (eventMarkets.length === 0) return match;

    const eventId = String(match.matchId ?? '').startsWith('odds_')
      ? String(match.matchId).replace(/^odds_/, '')
      : '';
    if (!eventId) return match;

    try {
      const extra = await this.service!.getEventOdds(request.competition, eventId, eventMarkets);
      return extra ? mergeOddsMatchMarkets(match, extra) : match;
    } catch (error) {
      warnings.push(
        `Mercati evento extra non disponibili per ${match.homeTeam} vs ${match.awayTeam}: ${error instanceof Error ? error.message : String(error)}`
      );
      return match;
    }
  }
}
