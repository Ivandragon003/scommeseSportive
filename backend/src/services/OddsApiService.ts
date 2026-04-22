/**
 * THE ODDS API SERVICE
 * ====================
 * Integrazione con https://the-odds-api.com
 *
 * Piano gratuito: 500 richieste/mese
 * Ogni richiesta = 1 sport  1 regione  1 mercato
 *
 * STIMA CONSUMO per uso personale Serie A:
 * - 1 richiesta/giorno per le quote aggiornate = ~30/mese
 * - Abbondante margine con il piano gratuito
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

export interface OddsMatch {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;       // ISO datetime UTC
  bookmakers: BookmakerOdds[];
}

export interface BookmakerOdds {
  bookmakerKey: string;       // es. "codere_it"
  bookmakerName: string;
  markets: MarketOdds[];
}

export interface MarketOdds {
  marketKey: string;          // "h2h", "totals", "spreads"
  outcomes: OutcomeOdds[];
}

export interface OutcomeOdds {
  name: string;               // "Home", "Draw", "Away", "Over", "Under"
  price: number;              // quota decimale
  point?: number;             // linea per totals/spreads (es. 2.5)
  description?: string;       // contesto outcome (es. nome squadra nei team totals)
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

  constructor(apiKey: string) {
    if (!apiKey || apiKey.trim() === '') {
      throw new Error('The Odds API key mancante. Registrati su https://the-odds-api.com per ottenerne una gratuita.');
    }
    this.apiKey = apiKey.trim();
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

    const response = await axios.get(`${this.BASE_URL}/sports/${sportKey}/odds`, {
      params,
      timeout: 15000,
    });

    // Leggi header con richieste rimanenti (robusto su casing/proxy diversi)
    const remainingRaw = this.readHeaderValue(response.headers, 'x-requests-remaining');
    const usedRaw = this.readHeaderValue(response.headers, 'x-requests-used');
    const parsedRemaining = Number.parseInt(String(remainingRaw ?? ''), 10);

    if (Number.isFinite(parsedRemaining) && parsedRemaining >= 0) {
      this.remainingRequests = parsedRemaining;
    }

    console.log(
      `[OddsApi] Richieste usate: ${usedRaw ?? '?'} | Rimanenti: ${
        Number.isFinite(parsedRemaining) ? parsedRemaining : '?'
      }/500`
    );

    return this.parseOddsResponse(response.data);
  }

  async getEventOdds(
    competition: string,
    eventId: string,
    markets: string[] = [],
    bookmakers: string[] = []
  ): Promise<OddsMatch | null> {
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

    const response = await axios.get(`${this.BASE_URL}/sports/${sportKey}/events/${eventId}/odds`, {
      params,
      timeout: 15000,
    });

    const remainingRaw = this.readHeaderValue(response.headers, 'x-requests-remaining');
    const parsedRemaining = Number.parseInt(String(remainingRaw ?? ''), 10);
    if (Number.isFinite(parsedRemaining) && parsedRemaining >= 0) {
      this.remainingRequests = parsedRemaining;
    }

    return this.parseSingleEventResponse(response.data);
  }

  private parseOddsResponse(data: any[]): OddsMatch[] {
    if (!Array.isArray(data)) return [];

    return data.map(event => ({
      matchId: `odds_${event.id}`,
      homeTeam: event.home_team,
      awayTeam: event.away_team,
      commenceTime: event.commence_time,
      bookmakers: (event.bookmakers ?? []).map((bm: any) => ({
        bookmakerKey: bm.key,
        bookmakerName: bm.title,
        markets: (bm.markets ?? []).map((m: any) => ({
          marketKey: m.key,
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
      bookmakers: (event.bookmakers ?? []).map((bm: any) => ({
        bookmakerKey: bm.key,
        bookmakerName: bm.title,
        markets: (bm.markets ?? []).map((m: any) => ({
          marketKey: m.key,
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

    const isHome = name === match.homeTeam || nameLower === 'home'
      || nameNorm === homeNorm
      || combinedNorm.includes(homeNorm);
    const isAway = name === match.awayTeam || nameLower === 'away'
      || nameNorm === awayNorm
      || combinedNorm.includes(awayNorm);

    const lineRaw = this.formatLineKey(outcome.point ?? 2.5);
    const compactLine = lineRaw.replace('.', '');

    const domainFromContext = (): 'shots_total' | 'sot_total' | 'corners' | 'fouls' | 'yellow' | null => {
      const probe = `${market} ${nameLower} ${desc.toLowerCase()}`.replace(/[^a-z0-9\s]/g, ' ');
      if (/\bshots?\s+on\s+target\b|\bon\s+target\b|\bsot\b/.test(probe)) return 'sot_total';
      if (/\bshots?\b/.test(probe)) return 'shots_total';
      if (/\bcorners?\b|\bcorner\s+kicks?\b/.test(probe)) return 'corners';
      if (/\bfouls?\b/.test(probe)) return 'fouls';
      if (/\byellow\b|\bcards?\b|\bbookings?\b/.test(probe)) return 'yellow';
      return null;
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

    if (market === 'totals' || market === 'alternate_totals') {
      if (nameLower !== 'over' && nameLower !== 'under') return null;
      const contextualDomain = domainFromContext();
      if (contextualDomain) return `${contextualDomain}_${nameLower}_${lineRaw}`;
      const numericLine = Number(outcome.point);
      // Guardrail: linee alte (es. 27.5) non sono goal totals.
      if (Number.isFinite(numericLine) && numericLine >= 8) {
        return `shots_total_${nameLower}_${lineRaw}`;
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
          : market.includes('cards') || market.includes('yellow')
            ? 'yellow'
            : 'fouls');
      return `${domain}_${nameLower}_${lineRaw}`;
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
  extractBestOdds(match: OddsMatch, preferredBookmaker: string = OddsApiService.PREFERRED_BOOKMAKERS[0]): Record<string, number> {
    const odds: Record<string, number> = {};

    // Trova il bookmaker preferito, altrimenti prendi il primo disponibile
    const primary = match.bookmakers.find((b) => b.bookmakerKey === preferredBookmaker)
      ?? match.bookmakers[0];

    if (!primary) return odds;

    const orderedBookmakers = [
      primary.bookmakerKey,
      ...OddsApiService.PREFERRED_BOOKMAKERS,
      ...match.bookmakers.map((b) => b.bookmakerKey),
    ].filter(Boolean);

    const seen = new Set<string>();
    for (const bookmakerKey of orderedBookmakers) {
      if (seen.has(bookmakerKey)) continue;
      seen.add(bookmakerKey);

      const bookmaker = match.bookmakers.find((b) => b.bookmakerKey === bookmakerKey);
      if (!bookmaker) continue;

      const bookmakerOdds = this.extractBookmakerOdds(match, bookmaker);
      for (const [key, price] of Object.entries(bookmakerOdds)) {
        if (odds[key] === undefined) {
          odds[key] = price;
        }
      }
    }

    return odds;
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
