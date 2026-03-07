/**
 * TRANSFERMARKT SCRAPER — Tiri & Accuracy
 * ========================================
 * Scrapa la pagina "chancenverwertung" di Transfermarkt per ottenere:
 *  - Tiri in porta (shots on target) per squadra
 *  - % accuratezza (accuracy)
 *  - Tiri totali derivati: shotsOT / accuracy
 *
 * URL pattern:
 *  https://www.transfermarkt.it/serie-a/chancenverwertung/pokalwettbewerb/IT1
 *  https://www.transfermarkt.it/serie-a/chancenverwertung/pokalwettbewerb/IT1/saison_id/2024
 *
 * Dati estratti per partita dividendo i totali stagionali per le partite
 * giocate (recuperate dal DB).
 */
import axios from 'axios';
import * as cheerio from 'cheerio';

export interface TransfermarktTeamShots {
  teamName: string;
  shotsOnTargetTotal: number;
  accuracyPct: number;
  shotsTotalDerived: number;
  matchesPlayed?: number;
  avgShotsOT?: number;
  avgShotsTotal?: number;
}

export interface TransfermarktScrapeResult {
  competition: string;
  season: string;
  scrapedAt: Date;
  teams: TransfermarktTeamShots[];
  leagueAvgShotsOT: number;
  leagueAvgShotsTotal: number;
  source: string;
}

const COMPETITION_URLS: Record<string, { slug: string; code: string }> = {
  'Serie A': { slug: 'serie-a', code: 'IT1' },
  'Premier League': { slug: 'premier-league', code: 'GB1' },
  'La Liga': { slug: 'laliga', code: 'ES1' },
  Bundesliga: { slug: 'bundesliga', code: 'L1' },
  'Ligue 1': { slug: 'ligue-1', code: 'FR1' },
};

/**
 * Converte stagione "2024/2025" o "2024/25" in saison_id Transfermarkt (es. 2024).
 */
function seasonToSaisonId(season: string): string {
  const m = String(season ?? '').trim().match(/^(\d{4})/);
  return m ? m[1] : String(new Date().getFullYear() - 1);
}

/**
 * Normalizza nome squadra per matching fuzzy con il DB.
 * Rimuove accenti, lowercasa, rimuove suffissi comuni (FC, AC, US, SS, ecc.).
 */
export function normalizeTeamName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(fc|ac|us|ss|asc|asd|ssc|calcio|sporting|club|cfc|1907|1909|1913|1892)\b/gi, '')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scrapa Transfermarkt per ottenere tiri in porta, accuracy e tiri totali derivati.
 */
export async function scrapeTransfermarktShots(
  competition: string = 'Serie A',
  season: string = '',
): Promise<TransfermarktScrapeResult> {
  const cfg = COMPETITION_URLS[competition];
  if (!cfg) {
    throw new Error(
      `Competizione non supportata: ${competition}. Disponibili: ${Object.keys(COMPETITION_URLS).join(', ')}`,
    );
  }

  const saisonId = season ? seasonToSaisonId(season) : '';
  const baseUrl = `https://www.transfermarkt.it/${cfg.slug}/chancenverwertung/pokalwettbewerb/${cfg.code}`;
  const url = saisonId ? `${baseUrl}/saison_id/${saisonId}` : baseUrl;

  const response = await axios.get(url, {
    timeout: 20000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: 'https://www.transfermarkt.it/',
    },
  });

  const $ = cheerio.load(response.data);
  const teams: TransfermarktTeamShots[] = [];

  $('table.items tbody tr').each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;

    const teamName = $(cells[1]).find('a').last().text().trim();
    if (!teamName || teamName.toLowerCase().includes('media')) return;

    const shotsRaw = $(cells[2]).text().trim();
    const shotsMatch = shotsRaw.match(/([\d.]+)\s*\(?([\d,]+)\s*%?\)?/);
    if (!shotsMatch) return;

    const shotsOT = parseFloat(shotsMatch[1].replace(/\./g, '').replace(',', '.'));
    const accuracyPct = parseFloat(shotsMatch[2].replace(',', '.'));
    if (!isFinite(shotsOT) || !isFinite(accuracyPct) || accuracyPct <= 0) return;

    const shotsTotalDerived = shotsOT / (accuracyPct / 100);
    teams.push({
      teamName,
      shotsOnTargetTotal: shotsOT,
      accuracyPct,
      shotsTotalDerived,
    });
  });

  if (teams.length === 0) {
    throw new Error(
      `Nessun dato trovato su Transfermarkt per ${competition}${season ? ` stagione ${season}` : ''}. ` +
        'La pagina potrebbe aver cambiato struttura o la stagione non e disponibile.',
    );
  }

  const leagueAvgShotsOT = teams.reduce((s, t) => s + t.shotsOnTargetTotal, 0) / teams.length;
  const leagueAvgShotsTotal = teams.reduce((s, t) => s + t.shotsTotalDerived, 0) / teams.length;
  const resolvedSeason = season || `${new Date().getFullYear() - 1}/${new Date().getFullYear()}`;

  return {
    competition,
    season: resolvedSeason,
    scrapedAt: new Date(),
    teams,
    leagueAvgShotsOT,
    leagueAvgShotsTotal,
    source: url,
  };
}
