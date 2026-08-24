import { OddsApiService, OddsMatch, SelectedBookmaker } from '../OddsApiService';
import { createHash } from 'node:crypto';
import {
  OddsProviderAdapter,
  OddsProviderFetchResult,
  OddsProviderHealth,
  OddsProviderRequest,
} from './OddsProvider';
import { matchFixturesToMatches, mergeOddsMatchMarkets } from './oddsProviderUtils';

export class OddsApiProvider implements OddsProviderAdapter<OddsMatch> {
  private readonly service: OddsApiService | null;
  private readonly cooldownScope: string;
  private static readonly authCooldowns = new Map<string, { until: number; message: string }>();
  private static readonly AUTH_COOLDOWN_CACHE_MAX_ENTRIES = 100;

  constructor(apiKey?: string | null) {
    const normalizedApiKey = apiKey?.trim() ?? '';
    this.service = normalizedApiKey ? new OddsApiService(normalizedApiKey) : null;
    // Keep a process-local, non-reversible key scope so a 401 for one account
    // never suppresses a newly configured account in the same Node process.
    this.cooldownScope = normalizedApiKey
      ? createHash('sha256').update(normalizedApiKey).digest('hex').slice(0, 16)
      : 'unconfigured';
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

    const cooldown = this.getActiveAuthCooldown(_request.competition);
    if (cooldown) {
      return {
        provider: this.getProviderName(),
        status: 'degraded',
        checkedAt: new Date().toISOString(),
        message: cooldown.message,
        details: { remainingRequests: this.service.getRemainingRequests(), cooldownUntil: new Date(cooldown.until).toISOString() },
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

  getSelectedBookmaker(match: OddsMatch, preferredBookmaker?: string): SelectedBookmaker | null {
    return this.service?.getSelectedBookmaker(match, preferredBookmaker) ?? null;
  }

  compareBookmakers(match: OddsMatch): Record<string, Record<string, number>> {
    return this.service?.compareBookmakers(match) ?? {};
  }

  calculateMargin(match: OddsMatch, bookmakerKey: string): number | null {
    return this.service?.calculateMargin(match, bookmakerKey) ?? null;
  }

  getRuntimeMetadata(): Record<string, unknown> {
    const cooldown = this.getActiveAuthCooldown();
    return {
      remainingRequests: this.service?.getRemainingRequests() ?? null,
      authCooldownUntil: cooldown ? new Date(cooldown.until).toISOString() : null,
    };
  }

  private ensureConfigured(): void {
    if (!this.service) {
      throw new Error('OddsApiProvider disabled: missing ODDS_API_KEY');
    }
  }

  private async loadCompetitionOdds(request: OddsProviderRequest): Promise<OddsProviderFetchResult<OddsMatch>> {
    const cooldown = this.getActiveAuthCooldown(request.competition);
    if (cooldown) throw new Error(cooldown.message);
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
        if (this.isAuthenticationFailure(error)) {
          const message = this.startAuthCooldown(request.competition, error);
          // Retrying a known-invalid credential only consumes provider quota and
          // obscures the original diagnostic, so do not attempt market fallbacks.
          throw new Error(message);
        }
        warnings.push(`Odds API ${attempt.label} markets failed (${attempt.markets.join(', ')}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(warnings.join(' | ') || 'Odds API non ha restituito quote per i mercati richiesti');
  }

  private getCooldownKey(competition?: string): string {
    return `${this.cooldownScope}:${String(competition ?? '').trim().toLowerCase() || 'default'}`;
  }

  private getActiveAuthCooldown(competition?: string): { until: number; message: string } | null {
    OddsApiProvider.pruneAuthCooldowns();
    if (competition === undefined) {
      const scopePrefix = `${this.cooldownScope}:`;
      for (const [key, cooldown] of OddsApiProvider.authCooldowns) {
        if (!key.startsWith(scopePrefix)) continue;
        if (cooldown.until <= Date.now()) {
          OddsApiProvider.authCooldowns.delete(key);
          continue;
        }
        return cooldown;
      }
      return null;
    }
    const key = this.getCooldownKey(competition);
    const cooldown = OddsApiProvider.authCooldowns.get(key);
    if (!cooldown) return null;
    if (cooldown.until <= Date.now()) {
      OddsApiProvider.authCooldowns.delete(key);
      return null;
    }
    return cooldown;
  }

  private isAuthenticationFailure(error: unknown): boolean {
    const status = this.getErrorStatus(error);
    return status === 401 || status === 403;
  }

  private startAuthCooldown(competition: string, error: unknown): string {
    const status = this.getErrorStatus(error);
    const seconds = Math.max(5, Math.min(300, Number(process.env.ODDS_API_AUTH_COOLDOWN_SECONDS ?? 30) || 30));
    const until = Date.now() + seconds * 1000;
    const message = `Odds API ${status} authentication failure; retry paused until ${new Date(until).toISOString()}.`;
    OddsApiProvider.pruneAuthCooldowns();
    while (OddsApiProvider.authCooldowns.size >= OddsApiProvider.AUTH_COOLDOWN_CACHE_MAX_ENTRIES) {
      const oldestKey = OddsApiProvider.authCooldowns.keys().next().value;
      if (!oldestKey) break;
      OddsApiProvider.authCooldowns.delete(oldestKey);
    }
    OddsApiProvider.authCooldowns.set(this.getCooldownKey(competition), { until, message });
    return message;
  }

  private static pruneAuthCooldowns(now = Date.now()): void {
    for (const [key, cooldown] of OddsApiProvider.authCooldowns) {
      if (cooldown.until <= now) OddsApiProvider.authCooldowns.delete(key);
    }
  }

  private getErrorStatus(error: unknown): number {
    if (!error || typeof error !== 'object') return 0;
    const candidate = error as { response?: { status?: unknown }; status?: unknown };
    return Number(candidate.response?.status ?? candidate.status ?? 0);
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
      if (this.isAuthenticationFailure(error)) {
        warnings.push(this.startAuthCooldown(request.competition, error));
        return match;
      }
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
        if (this.isAuthenticationFailure(marketError)) {
          warnings.push(this.startAuthCooldown(request.competition, marketError));
          break;
        }
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
