/**
 * THE ODDS API SERVICE
 * ====================
 * Integrazione con https://the-odds-api.com
 *
 * Piano gratuito: 500 richieste/mese
 * Ogni richiesta = 1 sport Ã— 1 regione Ã— 1 mercato
 *
 * STIMA CONSUMO per uso personale Serie A:
 * - 1 richiesta/giorno per le quote aggiornate = ~30/mese
 * - Abbondante margine con il piano gratuito
 *
 * BOOKMAKER CODE per Eurobet: "eurobet"
 * Altri disponibili: "bet365", "snai", "sisal", "betfair"
 *
 * MERCATI SUPPORTATI:
 * - h2h â†’ 1X2 (home win / draw / away win)
 * - totals â†’ Over/Under goal
 * - spreads â†’ Handicap
 * (BTTS non disponibile in The Odds API â€” calcolato dal modello)
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
  bookmakerKey: string;       // es. "eurobet"
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
}

// Mappa sport key â†’ nome leggibile
const SPORT_KEYS: Record<string, string> = {
  'Serie A':        'soccer_italy_serie_a',
  'Premier League': 'soccer_epl',
  'La Liga':        'soccer_spain_la_liga',
  'Bundesliga':     'soccer_germany_bundesliga',
  'Ligue 1':        'soccer_france_ligue_1',
  'Champions League': 'soccer_uefa_champs_league',
};

// Bookmaker preferiti in ordine di prioritÃ 
const PREFERRED_BOOKMAKERS = ['eurobet', 'bet365', 'snai', 'sisal', 'unibet', 'betfair_ex_eu'];

export class OddsApiService {
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
    const sportKey = SPORT_KEYS[competition];
    if (!sportKey) {
      throw new Error(`Competizione non supportata: ${competition}. Disponibili: ${Object.keys(SPORT_KEYS).join(', ')}`);
    }

    const params: Record<string, string> = {
      apiKey: this.apiKey,
      regions: 'eu',               // bookmaker europei (include Eurobet)
      markets: markets.join(','),
      oddsFormat: 'decimal',        // quote decimali (1.85, 3.40, ecc.)
      dateFormat: 'iso',
    };
    if (bookmakers.length > 0) params.bookmakers = bookmakers.join(',');

    console.log(
      `[OddsApi] Scaricando quote ${competition} â€” mercati: ${markets.join(', ')}${
        bookmakers.length > 0 ? ` â€” bookmakers: ${bookmakers.join(', ')}` : ' â€” bookmakers: all'
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

    return this.parseOddsResponse(response.data, competition);
  }

  private parseOddsResponse(data: any[], competition: string): OddsMatch[] {
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
          })),
        })),
      })),
    }));
  }

  /**
   * Estrae le quote di Eurobet (o il miglior bookmaker disponibile)
   * per un match specifico, in formato flat per il ValueBettingEngine.
   *
   * Formato output:
   * { homeWin: 1.85, draw: 3.40, awayWin: 4.20, over25: 1.70, under25: 2.10 }
   */
  extractBestOdds(match: OddsMatch, preferredBookmaker: string = 'eurobet'): Record<string, number> {
    const odds: Record<string, number> = {};

    // Trova il bookmaker preferito, altrimenti prendi il primo disponibile
    const primary = match.bookmakers.find((b) => b.bookmakerKey === preferredBookmaker)
      ?? match.bookmakers[0];

    if (!primary) return odds;

    const orderedBookmakers = [
      primary.bookmakerKey,
      ...PREFERRED_BOOKMAKERS,
      ...match.bookmakers.map((b) => b.bookmakerKey),
    ].filter(Boolean);

    const seen = new Set<string>();
    for (const bookmakerKey of orderedBookmakers) {
      if (seen.has(bookmakerKey)) continue;
      seen.add(bookmakerKey);

      const bookmaker = match.bookmakers.find((b) => b.bookmakerKey === bookmakerKey);
      if (!bookmaker) continue;

      for (const market of bookmaker.markets) {
        if (market.marketKey === 'h2h') {
          // 1X2
          for (const outcome of market.outcomes) {
            if (outcome.name === match.homeTeam || outcome.name === 'Home') {
              if (odds['homeWin'] === undefined) odds['homeWin'] = outcome.price;
            } else if (outcome.name === 'Draw') {
              if (odds['draw'] === undefined) odds['draw'] = outcome.price;
            } else if (outcome.name === match.awayTeam || outcome.name === 'Away') {
              if (odds['awayWin'] === undefined) odds['awayWin'] = outcome.price;
            }
          }
        } else if (market.marketKey === 'totals') {
          // Over/Under goal
          for (const outcome of market.outcomes) {
            const name = String(outcome.name ?? '').toLowerCase();
            if (name !== 'over' && name !== 'under') continue;
            const line = outcome.point ?? 2.5;
            const normalKey = name === 'over'
              ? `over${String(line).replace('.', '')}`
              : `under${String(line).replace('.', '')}`;
            if (odds[normalKey] === undefined && Number.isFinite(outcome.price) && outcome.price > 1) {
              odds[normalKey] = outcome.price;
            }
          }
        } else if (market.marketKey === 'spreads') {
          // Handicap
          for (const outcome of market.outcomes) {
            const line = outcome.point ?? 0;
            if (outcome.name === match.homeTeam || outcome.name === 'Home') {
              const key = `handicapHome${line > 0 ? '+' : ''}${line}`;
              if (odds[key] === undefined) odds[key] = outcome.price;
            } else {
              const key = `handicapAway${line > 0 ? '+' : ''}${line}`;
              if (odds[key] === undefined) odds[key] = outcome.price;
            }
          }
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
      const bmOdds: Record<string, number> = {};
      for (const market of bm.markets) {
        if (market.marketKey === 'h2h') {
          for (const outcome of market.outcomes) {
            const key = outcome.name === match.homeTeam ? '1'
              : outcome.name === 'Draw' ? 'X'
              : '2';
            bmOdds[key] = outcome.price;
          }
        }
      }
      if (Object.keys(bmOdds).length > 0) {
        comparison[bm.bookmakerName] = bmOdds;
      }
    }

    return comparison;
  }

  /**
   * Calcola il margine (vig/vigorish) implicito del bookmaker.
   * Margine = somma probabilitÃ  implicite - 1
   * Esempio: 1/1.85 + 1/3.40 + 1/4.20 = 0.541 + 0.294 + 0.238 = 1.073 â†’ margine 7.3%
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
    return Object.keys(SPORT_KEYS);
  }

  static getSupportedBookmakers(): string[] {
    return PREFERRED_BOOKMAKERS;
  }
}
