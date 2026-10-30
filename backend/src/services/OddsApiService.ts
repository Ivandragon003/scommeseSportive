/**
 * THE ODDS API SERVICE
 * ====================
 * Integrazione con https://the-odds-api.com
 *
 * Il piano Starter verificato offre 500 crediti/mese. Il costo del feed odds
 * è mercati x regioni: h2h,totals,spreads in EU possono costare 3 crediti,
 * non una sola richiesta. Il residuo misurato proviene soltanto dagli header.
 *
 * Nota: The Odds API non elenca attualmente Eurobet tra i bookmaker EU supportati.
 * Per il feed live usiamo quindi un ordine di preferenza su bookmaker realmente disponibili
 * nel provider (prima opzione italiana: Codere IT).
 *
 * MERCATI SUPPORTATI:
 * - h2h  1X2 (home win / draw / away win)
 * - totals  Over/Under goal
 * - spreads  Handicap
 * (BTTS non disponibile in The Odds API  calcolato dal modello)
 *
 * SPORT KEY per la Serie A: "soccer_italy_serie_a"
 * Altri: "soccer_epl", "soccer_spain_la_liga", "soccer_germany_bundesliga"
 */

import axios from 'axios';
import { createHash } from 'node:crypto';
import type { SmartOddsRequestStore } from './odds-provider/SmartOddsRequestStore';

export type OddsApiRequestOptions = {
  store?: Pick<SmartOddsRequestStore, 'execute'>;
  operation?: string;
  priority?: 'essential' | 'informational';
  allowNetwork?: boolean;
  cacheMaxAgeMs?: number;
};

export interface OddsMatch {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;       // ISO datetime UTC
  bookmakers: BookmakerOdds[];
  completed?: boolean;
  live?: boolean;
  scores?: Array<{ name: string; score: string | null }>;
  source?: 'odds' | 'scores' | 'events';
  provider?: string;
  capturedAt?: string;
  cacheHit?: boolean;
}

export interface BookmakerOdds {
  bookmakerKey: string;       // es. "codere_it"
  bookmakerName: string;
  updatedAt?: string;          // Provider observation time, never replaced with fetch time.
  markets: MarketOdds[];
}

export type SelectedBookmaker = {
  bookmakerKey: string;
  bookmakerName: string;
};

export interface MarketOdds {
  marketKey: string;          // "h2h", "totals", "spreads"
  updatedAt?: string;
  outcomes: OutcomeOdds[];
}

export interface OutcomeOdds {
  name: string;               // "Home", "Draw", "Away", "Over", "Under"
  price: number;              // quota decimale
  point?: number;             // linea per totals/spreads (es. 2.5)
  description?: string;       // contesto outcome (es. nome squadra nei team totals)
}

export interface OddsQuotaStatus {
  remaining: number | null;
  used: number | null;
  lastCost: number | null;
  observedAt: string | null;
  source: 'provider_headers' | null;
}

export class OddsApiService {
  private static readonly SPORT_KEYS: Record<string, string> = {
    'Serie A':        'soccer_italy_serie_a',
    'Premier League': 'soccer_epl',
    'La Liga':        'soccer_spain_la_liga',
    'Bundesliga':     'soccer_germany_bundesliga',
    'Ligue 1':        'soccer_france_ligue_one',
    'Champions League': 'soccer_uefa_champs_league',
  };

  private static readonly PREFERRED_BOOKMAKERS = [
    'codere_it',
    'pinnacle',
    'betfair_ex_eu',
    'marathonbet',
    'williamhill',
    'betsson',
    'nordicbet',
    'unibet_fr',
    'unibet_nl',
    'unibet_se',
    'tipico_de',
    'winamax_fr',
    'winamax_de',
  ];

  private readonly BASE_URL = 'https://api.the-odds-api.com/v4';
  private apiKey: string;
  private remainingRequests: number = 500;
  private quotaStatus: OddsQuotaStatus = { remaining: null, used: null, lastCost: null, observedAt: null, source: null };

  constructor(apiKey: string, private readonly requestOptions: OddsApiRequestOptions = {}) {
    if (!apiKey || apiKey.trim() === '') {
      throw new Error('The Odds API key mancante. Registrati su https://the-odds-api.com per ottenerne una gratuita.');
    }
    this.apiKey = apiKey.trim();
  }

  /** Every network edge is governed by the same persistent budget and cache. */
  private async managedGet(endpoint: string, params: Record<string, string>, expectedCredits: number, cacheMaxAgeMs?: number) {
    if (!this.requestOptions.store) {
      throw Object.assign(new Error('odds_persistent_manager_required'), { code: 'odds_persistent_manager_required' });
    }
    const list = (value?: string) => Array.from(new Set((value ?? '').split(',').filter(Boolean))).sort();
    const safeParams = Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'apiKey').sort(([a], [b]) => a.localeCompare(b)));
    for (const key of ['markets', 'regions', 'bookmakers']) if (safeParams[key]) safeParams[key] = list(safeParams[key]).join(',');
    const request = {
      provider: 'odds_api', accountScope: process.env.ODDS_API_ACCOUNT_SCOPE?.trim() || 'primary', endpoint,
      operation: this.requestOptions.operation ?? 'unattributed', markets: list(params.markets),
      regions: list(params.regions), bookmakers: list(params.bookmakers),
      requestKey: createHash('sha256').update(JSON.stringify({ endpoint, params: safeParams })).digest('hex'),
      expectedCredits, priority: this.requestOptions.priority ?? 'informational' as const,
      allowNetwork: this.requestOptions.allowNetwork !== false,
      cacheMaxAgeMs: cacheMaxAgeMs ?? this.requestOptions.cacheMaxAgeMs ?? 30 * 60_000,
    };
    const fetcher = async () => {
      try {
        const response = await axios.get(`${this.BASE_URL}${endpoint}`, { params, timeout: 15000 });
        return { data: response.data, headers: response.headers };
      } catch (error: any) {
        // Axios errors may contain the API key in their authenticated request URL.
        const status = Number(error?.response?.status) || 0;
        const headers = Object.fromEntries(['x-requests-used', 'x-requests-remaining', 'x-requests-last'].flatMap((name) => {
          const value = this.readQuotaHeader(error?.response?.headers, name);
          return value === null ? [] : [[name, String(value)]];
        }));
        // Rejected HTTP responses also carry authoritative quota observations.
        this.observeQuota(headers);
        const rawCode = error?.response?.data?.error_code;
        const providerErrorCode = rawCode === 'OUT_OF_USAGE_CREDITS' || rawCode === 'INVALID_KEY' ? rawCode : undefined;
        throw Object.assign(new Error(status ? `odds_provider_http_${status}` : 'odds_provider_unavailable'),
          { response: { status, headers }, ...(providerErrorCode ? { providerErrorCode } : {}) });
      }
    };
    let result;
    try { result = await this.requestOptions.store.execute<any>(request, fetcher); }
    catch (error: any) {
      const sport = /^\/sports\/([^/]+)/.exec(endpoint)?.[1];
      if (error?.code !== 'odds_reset_unconfirmed' || expectedCredits === 0 || !sport) throw error;
      // A free fresh event response may confirm a reset; rotating a key never does.
      await this.managedGet(`/sports/${sport}/events`, { apiKey: this.apiKey, dateFormat: 'iso' }, 0, 0);
      result = await this.requestOptions.store.execute<any>(request, fetcher);
    }
    // Cached headers retain their original observation time, not this read time.
    if (!result.cacheHit) this.observeQuota(result.headers);
    return result;
  }

  private requestCost(markets: string[], bookmakers: string[]): number {
    return new Set(markets).size * (bookmakers.length ? Math.ceil(new Set(bookmakers).size / 10) : 1);
  }

  private readHeaderValue(headers: unknown, name: string): string | undefined {
    if (!headers) return undefined;
    const key = name.toLowerCase();

    const maybeAxiosHeaders = headers as { get?: (n: string) => unknown; toJSON?: () => Record<string, unknown> };
    if (typeof maybeAxiosHeaders.get === 'function') {
      const direct = maybeAxiosHeaders.get(name) ?? maybeAxiosHeaders.get(key);
      if (direct !== undefined && direct !== null) return Array.isArray(direct) ? String(direct[0]) : String(direct);
    }

    const record = (
      typeof maybeAxiosHeaders.toJSON === 'function'
        ? maybeAxiosHeaders.toJSON()
        : (headers as Record<string, unknown>)
    ) ?? {};

    for (const [headerName, value] of Object.entries(record)) {
      if (headerName.toLowerCase() !== key || value === undefined || value === null) continue;
      return Array.isArray(value) ? String(value[0]) : String(value);
    }

    return undefined;
  }

  private readQuotaHeader(headers: unknown, name: string): number | null {
    const raw = this.readHeaderValue(headers, name)?.trim();
    if (!raw || !/^\d+$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  private observeQuota(headers: unknown): OddsQuotaStatus {
    const observed = { remaining: this.readQuotaHeader(headers, 'x-requests-remaining'),
      used: this.readQuotaHeader(headers, 'x-requests-used'), lastCost: this.readQuotaHeader(headers, 'x-requests-last') };
    if (Object.values(observed).some((value) => value !== null)) {
      this.quotaStatus = { ...observed, observedAt: new Date().toISOString(), source: 'provider_headers' };
      if (observed.remaining !== null) this.remainingRequests = observed.remaining;
    }
    return this.getQuotaStatus();
  }

  /**
   * Scarica le quote per una competizione.
   *
   * @param competition  Nome competizione (es. "Serie A")
   * @param markets      Mercati da scaricare (default: h2h + totals)
   * @param bookmakers   Bookmaker specifici (default: tutti i preferiti)
   */
  async getOdds(
    competition: string,
    markets: string[] = ['h2h', 'totals'],
    bookmakers: string[] = []
  ): Promise<OddsMatch[]> {
    markets = Array.from(new Set(markets.map((market) => market.trim()).filter(Boolean))).sort();
    bookmakers = Array.from(new Set(bookmakers.map((bookmaker) => bookmaker.trim()).filter(Boolean))).sort();
    if (!markets.length || markets.some((market) => !['h2h', 'totals', 'spreads'].includes(market))) {
      throw Object.assign(new Error('odds_unsupported_market'), { code: 'odds_unsupported_market' });
    }
    const sportKey = OddsApiService.SPORT_KEYS[competition];
    if (!sportKey) {
      throw new Error(`Competizione non supportata: ${competition}. Disponibili: ${Object.keys(OddsApiService.SPORT_KEYS).join(', ')}`);
    }

    const params: Record<string, string> = {
      apiKey: this.apiKey,
      regions: 'eu',               // bookmaker europei supportati dal provider
      markets: markets.join(','),
      oddsFormat: 'decimal',        // quote decimali (1.85, 3.40, ecc.)
      dateFormat: 'iso',
    };
    if (bookmakers.length > 0) params.bookmakers = bookmakers.join(',');

    console.log(
      `[OddsApi] Scaricando quote ${competition}  mercati: ${markets.join(', ')}${
        bookmakers.length > 0 ? `  bookmakers: ${bookmakers.join(', ')}` : '  bookmakers: all'
      }`
    );

    const response = await this.managedGet(`/sports/${sportKey}/odds`, params, this.requestCost(markets, bookmakers));
    const quota = this.getQuotaStatus();

    console.log(
      `[OddsApi] Crediti usati: ${quota.used ?? '?'} | Rimanenti: ${quota.remaining ?? '?'}`
    );

    return this.parseOddsResponse(response.data).map((event) => ({ ...event,
      provider: 'odds_api', capturedAt: response.fetchedAt, cacheHit: response.cacheHit }));
  }

  async getEventOdds(
    competition: string,
    eventId: string,
    markets: string[] = [],
    bookmakers: string[] = []
  ): Promise<OddsMatch | null> {
    markets = Array.from(new Set(markets.map((market) => market.trim()).filter(Boolean))).sort();
    bookmakers = Array.from(new Set(bookmakers.map((bookmaker) => bookmaker.trim()).filter(Boolean))).sort();
    if (markets.some((market) => !/^[a-z0-9_]+$/.test(market) || market === 'correct_score')) {
      throw Object.assign(new Error('odds_unsupported_market'), { code: 'odds_unsupported_market' });
    }
    const sportKey = OddsApiService.SPORT_KEYS[competition];
    if (!sportKey) {
      throw new Error(`Competizione non supportata: ${competition}. Disponibili: ${Object.keys(OddsApiService.SPORT_KEYS).join(', ')}`);
    }
    if (!eventId || String(eventId).trim() === '') return null;
    if (!Array.isArray(markets) || markets.length === 0) return null;

    const params: Record<string, string> = {
      apiKey: this.apiKey,
      regions: 'eu',
      markets: markets.join(','),
      oddsFormat: 'decimal',
      dateFormat: 'iso',
    };
    if (bookmakers.length > 0) params.bookmakers = bookmakers.join(',');

    if (!/^[a-zA-Z0-9_-]+$/.test(eventId)) throw new Error('Invalid odds event identifier');
    const response = await this.managedGet(`/sports/${sportKey}/events/${eventId}/odds`, params, this.requestCost(markets, bookmakers));
    const event = this.parseSingleEventResponse(response.data);
    return event ? { ...event, provider: 'odds_api', capturedAt: response.fetchedAt, cacheHit: response.cacheHit } : null;
  }

  async getScores(competition: string, daysFrom = 3): Promise<OddsMatch[]> {
    const sportKey = OddsApiService.SPORT_KEYS[competition];
    if (!sportKey) {
      throw new Error(`Competizione non supportata: ${competition}. Disponibili: ${Object.keys(OddsApiService.SPORT_KEYS).join(', ')}`);
    }

    const safeDaysFrom = Math.max(1, Math.min(Math.trunc(Number(daysFrom) || 3), 3));
    const response = await this.managedGet(`/sports/${sportKey}/scores/`, {
        apiKey: this.apiKey,
        daysFrom: String(safeDaysFrom),
        dateFormat: 'iso',
    }, 2);
    return this.parseScoresResponse(response.data).map((event) => ({ ...event,
      provider: 'odds_api', capturedAt: response.fetchedAt, cacheHit: response.cacheHit }));
  }

  /** Upcoming event metadata is a documented zero-credit calendar endpoint. */
  async getEvents(competition: string): Promise<OddsMatch[]> {
    const sportKey = OddsApiService.SPORT_KEYS[competition];
    if (!sportKey) throw new Error(`Competizione non supportata: ${competition}`);
    const response = await this.managedGet(`/sports/${sportKey}/events`, { apiKey: this.apiKey, dateFormat: 'iso' }, 0);
    if (!Array.isArray(response.data)) return [];
    return response.data.filter((event: any) => event?.id && event?.commence_time && event?.home_team && event?.away_team)
      .map((event: any) => ({ matchId: `odds_${event.id}`, homeTeam: event.home_team, awayTeam: event.away_team,
        commenceTime: event.commence_time, bookmakers: [], source: 'events' as const,
        provider: 'odds_api', capturedAt: response.fetchedAt, cacheHit: response.cacheHit }));
  }

  private parseOddsResponse(data: any[]): OddsMatch[] {
    if (!Array.isArray(data)) return [];

    return data.map(event => ({
      matchId: `odds_${event.id}`,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      commenceTime: event.commence_time,
      source: 'odds',
      bookmakers: (event.bookmakers ?? []).map((bm: any) => ({
        bookmakerKey: bm.key,
        bookmakerName: bm.title,
        updatedAt: bm.last_update,
        markets: (bm.markets ?? []).map((m: any) => ({
          marketKey: m.key,
          updatedAt: m.last_update,
          outcomes: (m.outcomes ?? []).map((o: any) => ({
            name: o.name,
            price: o.price,
            point: o.point,
            description: o.description,
          })),
        })),
      })),
    }));
  }

  private parseSingleEventResponse(event: any): OddsMatch | null {
    if (!event || typeof event !== 'object') return null;
    if (!Array.isArray(event.bookmakers)) return null;

    return {
      matchId: `odds_${event.id}`,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      commenceTime: event.commence_time,
      source: 'odds',
      bookmakers: (event.bookmakers ?? []).map((bm: any) => ({
        bookmakerKey: bm.key,
        bookmakerName: bm.title,
        updatedAt: bm.last_update,
        markets: (bm.markets ?? []).map((m: any) => ({
          marketKey: m.key,
          updatedAt: m.last_update,
          outcomes: (m.outcomes ?? []).map((o: any) => ({
            name: o.name,
            price: o.price,
            point: o.point,
            description: o.description,
          })),
        })),
      })),
    };
  }

  private parseScoresResponse(data: any[]): OddsMatch[] {
    if (!Array.isArray(data)) return [];

    return data
      .filter((event) => event && typeof event === 'object')
      .map((event) => {
        const scores = Array.isArray(event.scores)
          ? event.scores.map((score: any) => ({
            name: String(score?.name ?? ''),
            score: score?.score === null || score?.score === undefined ? null : String(score.score),
          }))
          : [];
        const completed = Boolean(event.completed);

        return {
          matchId: `scores_${event.id}`,
          homeTeam: String(event.home_team ?? ''),
          awayTeam: String(event.away_team ?? ''),
          commenceTime: String(event.commence_time ?? ''),
          completed,
          live: Boolean(event.live ?? (!completed && scores.length > 0)),
          scores,
          source: 'scores' as const,
          bookmakers: [],
        };
      })
      .filter((event) => event.homeTeam && event.awayTeam && event.commenceTime);
  }

  private formatLineKey(point: unknown): string {
    const n = Number(point);
    if (!Number.isFinite(n)) return '0';
    return Number.isInteger(n) ? String(n) : String(n);
  }

  private extractBookmakerOdds(match: OddsMatch, bookmaker: BookmakerOdds): Record<string, number> {
    const odds: Record<string, number> = {};

    for (const market of bookmaker.markets ?? []) {
      for (const outcome of market.outcomes ?? []) {
        const key = this.toSelectionKey(match, market.marketKey, outcome);
        if (!key) continue;
        if (odds[key] === undefined && Number.isFinite(outcome.price) && outcome.price > 1) {
          odds[key] = outcome.price;
        }
      }
    }

    return odds;
  }

  private toSelectionKey(match: OddsMatch, marketKey: string, outcome: OutcomeOdds): string | null {
    const normalize = (v: string): string =>
      String(v ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '')
        .trim();

    const name = String(outcome.name ?? '').trim();
    const desc = String(outcome.description ?? '').trim();
    const nameLower = name.toLowerCase();
    const market = String(marketKey ?? '').toLowerCase();

    const homeNorm = normalize(match.homeTeam);
    const awayNorm = normalize(match.awayTeam);
    const nameNorm = normalize(name);
    const descNorm = normalize(desc);
    const combinedNorm = `${nameNorm}${descNorm}`;
    const slug = (value: string): string =>
      String(value ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);

    const isHome = name === match.homeTeam || nameLower === 'home'
      || nameNorm === homeNorm
      || combinedNorm.includes(homeNorm);
    const isAway = name === match.awayTeam || nameLower === 'away'
      || nameNorm === awayNorm
      || combinedNorm.includes(awayNorm);
    const contextProbe = `${market} ${nameLower} ${desc.toLowerCase()}`.replace(/[^a-z0-9\s]/g, ' ');
    const hasHomeContext = isHome || /\b(home|casa)\b/.test(contextProbe);
    const hasAwayContext = isAway || /\b(away|ospite|trasferta)\b/.test(contextProbe);

    const lineRaw = this.formatLineKey(outcome.point ?? 2.5);
    const compactLine = lineRaw.replace('.', '');

    const domainFromContext = (): 'shots_total' | 'sot_total' | 'corners' | 'fouls' | 'yellow' | 'cards_total' | null => {
      const probe = `${market} ${nameLower} ${desc.toLowerCase()}`.replace(/[^a-z0-9\s]/g, ' ');
      if (/\bshots?\s+on\s+target\b|\bon\s+target\b|\bsot\b/.test(probe)) return 'sot_total';
      if (/\bshots?\b/.test(probe)) return 'shots_total';
      if (/\bcorners?\b|\bcorner\s+kicks?\b/.test(probe)) return 'corners';
      if (/\bfouls?\b/.test(probe)) return 'fouls';
      // Mercato "yellow cards" esplicito -> gialli; "cards"/"bookings"/totali ->
      // booking points (giallo=1, rosso=2). the-odds-api espone solo il totale
      // (`alternate_totals_cards`, "Total Cards / Bookings"), quindi in pratica
      // ricade su cards_total.
      if (/\byellow\b/.test(probe)) return 'yellow';
      if (/\bcards?\b|\bbookings?\b/.test(probe)) return 'cards_total';
      return null;
    };

    const scopeStatDomain = (domain: 'shots_total' | 'sot_total' | 'corners' | 'fouls' | 'yellow' | 'cards_total'): string => {
      if (domain === 'shots_total') {
        if (hasHomeContext) return 'shots_home';
        if (hasAwayContext) return 'shots_away';
      }
      if (domain === 'sot_total') {
        if (hasHomeContext) return 'sot_home';
        if (hasAwayContext) return 'sot_away';
      }
      if (hasHomeContext && (domain === 'corners' || domain === 'fouls' || domain === 'yellow')) return `${domain}_home`;
      if (hasAwayContext && (domain === 'corners' || domain === 'fouls' || domain === 'yellow')) return `${domain}_away`;
      return domain;
    };

    if (market === 'h2h' || market === 'h2h_3_way') {
      if (isHome) return 'homeWin';
      if (isAway) return 'awayWin';
      if (nameLower === 'draw') return 'draw';
      return null;
    }

    if (market === 'btts') {
      if (nameLower === 'yes' || nameLower === 'si') return 'btts';
      if (nameLower === 'no') return 'bttsNo';
      return null;
    }

    if (market === 'draw_no_bet') {
      if (isHome) return 'dnb_home';
      if (isAway) return 'dnb_away';
      return null;
    }

    // Marcatore anytime (Yes/No): il giocatore e' nel name, oppure name=Yes/No
    // con il giocatore nella description. "Yes" = segna (over 0.5 goal).
    if (market === 'player_goal_scorer_anytime') {
      const isYesNo = nameLower === 'yes' || nameLower === 'no';
      const player = isYesNo ? (outcome.description || desc) : (name || outcome.description);
      const playerKey = slug(player);
      if (!playerKey) return null;
      const side = nameLower === 'no' ? 'under' : 'over';
      return `player_goals_${playerKey}_${side}_0.5`;
    }

    if (market.startsWith('player_') && (nameLower === 'over' || nameLower === 'under')) {
      const playerKey = slug(desc || outcome.description || name);
      if (!playerKey) return null;
      const domain = market.includes('shots_on_target') || market.includes('shot_on_target') || market.includes('sot')
        ? 'player_sot'
        : 'player_shots';
      return `${domain}_${playerKey}_${nameLower}_${lineRaw}`;
    }

    if (market === 'totals' || market === 'alternate_totals') {
      if (nameLower !== 'over' && nameLower !== 'under') return null;
      const contextualDomain = domainFromContext();
      if (contextualDomain) return `${scopeStatDomain(contextualDomain)}_${nameLower}_${lineRaw}`;
      const numericLine = Number(outcome.point);
      // Guardrail: linee alte (es. 27.5) non sono goal totals.
      if (Number.isFinite(numericLine) && numericLine >= 8) {
        return `${scopeStatDomain('shots_total')}_${nameLower}_${lineRaw}`;
      }
      return `${nameLower}${compactLine}`;
    }

    if (market === 'team_totals' || market === 'alternate_team_totals') {
      if (nameLower !== 'over' && nameLower !== 'under') return null;
      if (isHome || descNorm.includes(homeNorm)) return `team_home_${nameLower}_${compactLine}`;
      if (isAway || descNorm.includes(awayNorm)) return `team_away_${nameLower}_${compactLine}`;
      return null;
    }

    if (market === 'spreads' || market === 'alternate_spreads') {
      const point = Number(outcome.point ?? 0);
      if (!Number.isFinite(point)) return null;

      const homeLine = isHome ? -point : isAway ? point : NaN;
      if (!Number.isFinite(homeLine)) return null;
      const normalizedHomeLine = Object.is(homeLine, -0) ? 0 : homeLine;
      const line = Number.isInteger(normalizedHomeLine)
        ? String(normalizedHomeLine)
        : String(normalizedHomeLine);
      if (isHome) return `ahcp_${line}`;
      if (isAway) return `ahcp_away_${line}`;
      return null;
    }

    if (market.includes('double_chance')) {
      const token = normalize(name);
      if (token.includes('1x') || (token.includes('home') && token.includes('draw'))) return 'double_chance_1x';
      if (token.includes('x2') || (token.includes('draw') && token.includes('away'))) return 'double_chance_x2';
      if (token.includes('12') || (token.includes('home') && token.includes('away'))) return 'double_chance_12';
      return null;
    }

    if ((market.includes('shots') || market.includes('corners') || market.includes('cards') || market.includes('fouls')) && (nameLower === 'over' || nameLower === 'under')) {
      const contextualDomain = domainFromContext();
      const domain = contextualDomain
        ?? (market.includes('shots_on_target') || market.includes('shot_on_target') || market.includes('sot')
        ? 'sot_total'
        : market.includes('corners')
          ? 'corners'
        : market.includes('shots')
          ? 'shots_total'
          : market.includes('cards')
            ? 'cards_total'
          : market.includes('yellow')
            ? 'yellow'
            : 'fouls');
      return `${scopeStatDomain(domain)}_${nameLower}_${lineRaw}`;
    }

    return null;
  }

  /**
   * Estrae le quote del bookmaker preferito (o il miglior bookmaker disponibile)
   * per un match specifico, in formato flat per il ValueBettingEngine.
   *
   * Formato output:
   * { homeWin: 1.85, draw: 3.40, awayWin: 4.20, over25: 1.70, under25: 2.10 }
   */
  getSelectedBookmaker(match: OddsMatch, preferredBookmaker?: string): SelectedBookmaker | null {
    const preferredKeys = [
      preferredBookmaker,
      ...match.bookmakers.filter((bookmaker) => /eurobet/i.test(bookmaker.bookmakerKey)).map((bookmaker) => bookmaker.bookmakerKey),
      ...match.bookmakers.filter((bookmaker) => /_it$/.test(bookmaker.bookmakerKey)).map((bookmaker) => bookmaker.bookmakerKey),
      ...OddsApiService.PREFERRED_BOOKMAKERS,
      ...match.bookmakers.map((bookmaker) => bookmaker.bookmakerKey),
    ].filter((key): key is string => Boolean(key));
    const selected = preferredKeys
      .map((key) => match.bookmakers.find((bookmaker) => bookmaker.bookmakerKey === key))
      .filter((bookmaker, index, bookmakers): bookmaker is BookmakerOdds =>
        Boolean(bookmaker) && bookmakers.findIndex((candidate) => candidate?.bookmakerKey === bookmaker.bookmakerKey) === index
      )
      // A bookmaker may be present in the API response but expose only
      // markets that this application cannot translate. Selecting it made
      // extractBestOdds() return {}, even though another bookmaker had valid
      // odds for the same event.
      .find((bookmaker) => Object.keys(this.extractBookmakerOdds(match, bookmaker)).length > 0);
    return selected?.bookmakerKey && selected.bookmakerName
      ? { bookmakerKey: selected.bookmakerKey, bookmakerName: selected.bookmakerName }
      : null;
  }

  extractBestOdds(match: OddsMatch, preferredBookmaker?: string): Record<string, number> {
    const selected = this.getSelectedBookmaker(match, preferredBookmaker);
    if (!selected) return {};
    const bookmaker = match.bookmakers.find((entry) => entry.bookmakerKey === selected.bookmakerKey);
    return bookmaker ? this.extractBookmakerOdds(match, bookmaker) : {};
  }

  /**
   * Confronta le quote di tutti i bookmaker disponibili per un match.
   * Utile per trovare il miglior prezzo sul mercato.
   */
  compareBookmakers(match: OddsMatch): Record<string, Record<string, number>> {
    const comparison: Record<string, Record<string, number>> = {};

    for (const bm of match.bookmakers) {
      const bmOdds = this.extractBookmakerOdds(match, bm);
      if (Object.keys(bmOdds).length > 0) {
        comparison[bm.bookmakerName] = bmOdds;
      }
    }

    return comparison;
  }

  /**
   * Calcola il margine (vig/vigorish) implicito del bookmaker.
   * Margine = somma probabilit implicite - 1
   * Esempio: 1/1.85 + 1/3.40 + 1/4.20 = 0.541 + 0.294 + 0.238 = 1.073  margine 7.3%
   * Media Serie A bookmaker italiani: ~5-8%
   */
  calculateMargin(match: OddsMatch, bookmakerKey: string): number | null {
    const bm = match.bookmakers.find(b => b.bookmakerKey === bookmakerKey);
    if (!bm) return null;

    const h2h = bm.markets.find(m => m.marketKey === 'h2h');
    if (!h2h || h2h.outcomes.length < 2) return null;

    const impliedProbSum = h2h.outcomes.reduce((sum, o) => sum + (1 / o.price), 0);
    return parseFloat(((impliedProbSum - 1) * 100).toFixed(2));
  }

  getRemainingRequests(): number {
    return this.remainingRequests;
  }

  /** Unknown is distinct from the legacy fallback/cached counter. */
  getQuotaStatus(): OddsQuotaStatus {
    return { ...this.quotaStatus };
  }

  setRemainingRequests(value: number): void {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      this.remainingRequests = Math.trunc(parsed);
    }
  }

  static getSupportedCompetitions(): string[] {
    return Object.keys(OddsApiService.SPORT_KEYS);
  }

  static getSupportedBookmakers(): string[] {
    return OddsApiService.PREFERRED_BOOKMAKERS;
  }
}
