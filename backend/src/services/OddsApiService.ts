/**
 * THE ODDS API SERVICE
 * ====================
 * Integrazione con https://the-odds-api.com
 *
 * Piano gratuito: 500 richieste/mese
 * Ogni richiesta = 1 sport × 1 regione × 1 mercato
 *
 * STIMA CONSUMO per uso personale Serie A:
 * - 1 richiesta/giorno per le quote aggiornate = ~30/mese
 * - Abbondante margine con il piano gratuito
 *
 * BOOKMAKER CODE per Eurobet: "eurobet"
 * Altri disponibili: "bet365", "snai", "sisal", "betfair"
 *
 * MERCATI SUPPORTATI:
 * - h2h → 1X2 (home win / draw / away win)
 * - totals → Over/Under goal
 * - spreads → Handicap
 * (BTTS non disponibile in The Odds API — calcolato dal modello)
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

// Mappa sport key → nome leggibile
const SPORT_KEYS: Record<string, string> = {
  'Serie A':        'soccer_italy_serie_a',
  'Premier League': 'soccer_epl',
  'La Liga':        'soccer_spain_la_liga',
  'Bundesliga':     'soccer_germany_bundesliga',
  'Ligue 1':        'soccer_france_ligue_1',
  'Champions League': 'soccer_uefa_champs_league',
};

// Bookmaker preferiti in ordine di priorità
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
    bookmakers: string[] = PREFERRED_BOOKMAKERS
  ): Promise<OddsMatch[]> {
    const sportKey = SPORT_KEYS[competition];
    if (!sportKey) {
      throw new Error(`Competizione non supportata: ${competition}. Disponibili: ${Object.keys(SPORT_KEYS).join(', ')}`);
    }

    const params = {
      apiKey: this.apiKey,
      regions: 'eu',               // bookmaker europei (include Eurobet)
      markets: markets.join(','),
      oddsFormat: 'decimal',        // quote decimali (1.85, 3.40, ecc.)
      bookmakers: bookmakers.join(','),
      dateFormat: 'iso',
    };

    console.log(`[OddsApi] Scaricando quote ${competition} — mercati: ${markets.join(', ')}`);

    const response = await axios.get(`${this.BASE_URL}/sports/${sportKey}/odds`, {
      params,
      timeout: 15000,
    });

    // Leggi header con richieste rimanenti
    const remaining = response.headers['x-requests-remaining'];
    const used = response.headers['x-requests-used'];
    if (remaining) this.remainingRequests = parseInt(remaining);
    console.log(`[OddsApi] Richieste usate: ${used ?? '?'} | Rimanenti: ${remaining ?? '?'}/500`);

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
    const bookmaker = match.bookmakers.find(b => b.bookmakerKey === preferredBookmaker)
      ?? match.bookmakers[0];

    if (!bookmaker) return odds;

    for (const market of bookmaker.markets) {
      if (market.marketKey === 'h2h') {
        // 1X2
        for (const outcome of market.outcomes) {
          if (outcome.name === match.homeTeam || outcome.name === 'Home') {
            odds['homeWin'] = outcome.price;
          } else if (outcome.name === 'Draw') {
            odds['draw'] = outcome.price;
          } else if (outcome.name === match.awayTeam || outcome.name === 'Away') {
            odds['awayWin'] = outcome.price;
          }
        }
      } else if (market.marketKey === 'totals') {
        // Over/Under goal
        for (const outcome of market.outcomes) {
          const line = outcome.point ?? 2.5;
          const key = `${outcome.name.toLowerCase()}${line}`.replace('.', '');
          // Normalizza: "over2.5" → "over25"
          const normalKey = outcome.name === 'Over'
            ? `over${String(line).replace('.', '')}`
            : `under${String(line).replace('.', '')}`;
          odds[normalKey] = outcome.price;
        }
      } else if (market.marketKey === 'spreads') {
        // Handicap
        for (const outcome of market.outcomes) {
          const line = outcome.point ?? 0;
          if (outcome.name === match.homeTeam || outcome.name === 'Home') {
            odds[`handicapHome${line > 0 ? '+' : ''}${line}`] = outcome.price;
          } else {
            odds[`handicapAway${line > 0 ? '+' : ''}${line}`] = outcome.price;
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
   * Margine = somma probabilità implicite - 1
   * Esempio: 1/1.85 + 1/3.40 + 1/4.20 = 0.541 + 0.294 + 0.238 = 1.073 → margine 7.3%
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

  static getSupportedCompetitions(): string[] {
    return Object.keys(SPORT_KEYS);
  }

  static getSupportedBookmakers(): string[] {
    return PREFERRED_BOOKMAKERS;
  }
}
