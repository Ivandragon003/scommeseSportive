import type { DatabaseService } from '../db/DatabaseService';
import { appRecommendationQuote, RecommendationQuote } from '../research/AppRecommendationQuotes';
import { quoteFreshnessReason } from '../research/T15Scheduler';
import { buildCoherentBookmakerOddsBundle } from './BookmakerOddsSelectionService';
import type { SharedPredictionOdds } from './CanonicalBetRecommendation';
import type { OddsMatch } from './OddsApiService';
import { enabledMatchEventMarkets } from './OddsMarketPolicy';
import { alignOddsKeysInternal } from './PredictionService';
import { OddsApiProvider } from './odds-provider/OddsApiProvider';
import { scoreFixtureCandidate } from './odds-provider/oddsProviderUtils';
import { getConfiguredOddsApiKey } from './odds-provider/providerRuntimeConfig';

type AppOddsProvider = Pick<OddsApiProvider, 'getOddsForFixtures' | 'compareBookmakers'>
  & Partial<Pick<OddsApiProvider, 'getQuotaStatus'>>;
type FixtureRow = { competition: string; date: string; home_team_name: string; away_team_name: string };
type PriceEvidence = { odds: number; bookmaker: string; source: string; capturedAt: string;
  updatedAt: string; priceType: 'prematch'; timestampEvidence: 'provider_update' };
export type AppPredictionOdds = { quotes: RecommendationQuote[]; sharedOdds: SharedPredictionOdds;
  metadata: Record<string, unknown> };

/** The app keeps its existing markets and bookmaker selection; automation only consumes its prices. */
export class AppPredictionOddsService {
  private provider: AppOddsProvider | undefined;
  private readonly clock: () => Date;
  constructor(private readonly db: Pick<DatabaseService, 'oddsRequests'>,
    options: { clock?: () => Date; provider?: AppOddsProvider } = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.provider = options.provider;
  }

  getQuotaStatus(): unknown { return this.provider?.getQuotaStatus?.() ?? null; }

  async load(row: FixtureRow): Promise<AppPredictionOdds> {
    this.provider ??= new OddsApiProvider(getConfiguredOddsApiKey(), { store: this.db.oddsRequests,
      operation: 'nightly', priority: 'essential', allowNetwork: true, cacheMaxAgeMs: 300_000 });
    const markets = ['h2h', 'totals', 'spreads'];
    const response = await this.provider.getOddsForFixtures({ competition: row.competition,
      fixtures: [{ homeTeam: row.home_team_name, awayTeam: row.away_team_name, commenceTime: row.date }],
      markets, fallbackMarkets: markets, extraEventMarkets: enabledMatchEventMarkets(), includeExtendedGroups: true });
    const now = this.clock();
    const metadata: Record<string, unknown> = { warnings: response.warnings, marketsRequested: markets,
      extraEventMarketsRequested: enabledMatchEventMarkets() };
    const empty = (): AppPredictionOdds => ({ quotes: [], sharedOdds: { odds: {}, bookmakerBySelection: {},
      source: 'odds_api', capturedAt: now.toISOString() }, metadata });
    const ranked = response.matches.map((event) => ({ event,
      score: scoreFixtureCandidate(event, row.home_team_name, row.away_team_name, row.date) }))
      .filter(({ event, score }) => score.straightTeamScore >= 1.8 && score.score > 0
        && !score.warnings.includes('home_away_inverted_candidate')
        && Date.parse(event.commenceTime) === Date.parse(row.date))
      .sort((left, right) => right.score.score - left.score.score);
    if (!ranked.length || (ranked[1] && ranked[0].score.score - ranked[1].score.score < .15)) return empty();
    const event = ranked[0].event;
    if (event.live || event.completed || Date.parse(event.commenceTime) <= now.getTime() || event.provider !== 'odds_api') return empty();
    metadata.providerEventId = event.matchId;
    metadata.providerKickoffAt = event.commenceTime;

    // Treat each provider market/update as a separate sheet. The existing chooser then
    // keeps complementary outcomes together, even when alternate markets overlap.
    const sheets: Record<string, Record<string, number>> = {};
    const evidenceBySheet = new Map<string, Map<string, PriceEvidence>>();
    for (const bookmaker of event.bookmakers) for (const market of bookmaker.markets) {
      const capturedAt = market.capturedAt ?? event.capturedAt ?? '';
      const updatedAt = market.updatedAt ?? bookmaker.updatedAt ?? '';
      const evidence = { bookmaker: bookmaker.bookmakerName, source: 'odds_api', capturedAt, updatedAt,
        priceType: 'prematch' as const, timestampEvidence: 'provider_update' as const };
      const singleMarket: OddsMatch = { ...event, bookmakers: [{ ...bookmaker, markets: [market] }] };
      const mapped = this.provider.compareBookmakers(singleMarket)[bookmaker.bookmakerName] ?? {};
      const sheet = JSON.stringify([bookmaker.bookmakerName, market.marketKey, capturedAt, updatedAt]);
      for (const [selection, odds] of Object.entries(mapped)) {
        const price = { ...evidence, odds };
        if (quoteFreshnessReason(price, now.getTime())) continue;
        sheets[sheet] ??= {};
        sheets[sheet][selection] = odds;
        const prices = evidenceBySheet.get(sheet) ?? new Map<string, PriceEvidence>();
        prices.set(selection, price);
        evidenceBySheet.set(sheet, prices);
      }
    }
    const bundle = buildCoherentBookmakerOddsBundle(sheets);
    const odds: Record<string, number> = {}, bookmakerBySelection: Record<string, string> = {};
    const quotes: RecommendationQuote[] = [];
    let oldestCapture = now.getTime();
    for (const [selection, price] of Object.entries(bundle.odds)) {
      const evidence = evidenceBySheet.get(bundle.bookmakerBySelection[selection])?.get(selection);
      if (!evidence) continue;
      odds[selection] = price;
      bookmakerBySelection[selection] = evidence.bookmaker;
      oldestCapture = Math.min(oldestCapture, Date.parse(evidence.capturedAt));
      for (const alias of Object.keys(alignOddsKeysInternal({ [selection]: price }))) {
        const quote = appRecommendationQuote(alias, evidence);
        if (quote && !quotes.some((existing) => existing.selection === quote.selection)) quotes.push(quote);
      }
    }
    return { quotes, sharedOdds: { odds, bookmakerBySelection, source: 'odds_api',
      capturedAt: new Date(oldestCapture).toISOString() }, metadata };
  }
}
