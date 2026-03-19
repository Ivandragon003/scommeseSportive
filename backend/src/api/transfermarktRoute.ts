import { Request, Response } from 'express';
import { normalizeTeamName, scrapeTransfermarktShots } from '../services/TransfermarktScraper';

type TransfermarktDb = {
  getTeamsByCompetition: (competition: string) => Promise<any[]>;
  getMatches: (filters?: { competition?: string; season?: string }) => Promise<any[]>;
  getTeam: (teamId: string) => Promise<any | null>;
  upsertTeam: (team: any) => Promise<void>;
};

type TransfermarktSyncResponse = {
  competition: string;
  season: string;
  scrapedAt: Date;
  totalScraped: number;
  updatedTeams: number;
  notMatched: string[];
  teams: any[];
  leagueAvgShotsOT: number;
  leagueAvgShotsTotal: number;
  source: string;
};

/**
 * ROUTE HANDLER — POST /api/scraper/transfermarkt
 * ================================================
 * 1. Scrapa Transfermarkt per tiri in porta + accuratezza
 * 2. Deriva tiri totali: shotsOT / (accuracy/100)
 * 3. Recupera dal DB le partite giocate per squadra
 * 4. Aggiorna avg_home_shots, avg_away_shots, avg_home_shots_ot, avg_away_shots_ot
 * 5. Ritorna risultato con squadre aggiornate, non matchate e medie di lega
 */
export async function syncTransfermarktStatsForCompetition(
  db: TransfermarktDb,
  competition: string = 'Serie A',
  season: string = '',
): Promise<TransfermarktSyncResponse> {
  const parseJson = (value: unknown): Record<string, any> => {
    if (typeof value !== 'string' || value.trim().length === 0) return {};
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  // 1. Scrapa Transfermarkt
  const scraped = await scrapeTransfermarktShots(competition, season || undefined);

  // 2. Recupera tutte le squadre dal DB per la competizione
  const dbTeams: any[] = await db.getTeamsByCompetition(competition);

  // 3. Recupera partite per calcolare match giocati per squadra
  const dbMatches: any[] = await db.getMatches({ competition, season: season || undefined });
  const completedMatches = dbMatches.filter(
    (m: any) => m.home_goals !== null && m.away_goals !== null,
  );

  // Costruisce mappa nome_normalizzato -> team_id + partite giocate
  const teamMatchesMap = new Map<string, { teamId: string; home: number; away: number }>();
  for (const t of dbTeams) {
    const key = normalizeTeamName(t.name ?? '');
    const homeMatches = completedMatches.filter((m: any) => m.home_team_id === t.team_id).length;
    const awayMatches = completedMatches.filter((m: any) => m.away_team_id === t.team_id).length;
    if (key) {
      teamMatchesMap.set(key, {
        teamId: t.team_id,
        home: homeMatches,
        away: awayMatches,
      });
    }
  }

  // 4. Matcha squadre Transfermarkt con DB e calcola medie per partita
  const updatedTeams: any[] = [];
  const notMatched: string[] = [];

  for (const tmTeam of scraped.teams) {
    const tmKey = normalizeTeamName(tmTeam.teamName);

    // Cerca match esatto prima, poi fuzzy (partial match)
    let dbEntry = teamMatchesMap.get(tmKey);
    if (!dbEntry) {
      for (const [dbKey, entry] of teamMatchesMap.entries()) {
        if (dbKey.includes(tmKey) || tmKey.includes(dbKey)) {
          dbEntry = entry;
          break;
        }
      }
    }

    if (!dbEntry || dbEntry.home + dbEntry.away === 0) {
      notMatched.push(tmTeam.teamName);
      updatedTeams.push({ ...tmTeam, matched: false });
      continue;
    }

    const totalMatches = dbEntry.home + dbEntry.away;
    const homeMatches = Math.max(1, dbEntry.home);
    const awayMatches = Math.max(1, dbEntry.away);

    // Medie per partita (totali stagionali / partite)
    const avgShotsOTPerGame = tmTeam.shotsOnTargetTotal / totalMatches;
    const avgShotsTotalPerGame = tmTeam.shotsTotalDerived / totalMatches;

    // Home/away split approssimato (casa tira leggermente di piu)
    const HOME_FACTOR = 1.1;
    const AWAY_FACTOR = 0.9;
    const avgHomeShotsOT = avgShotsOTPerGame * HOME_FACTOR;
    const avgAwayShotsOT = avgShotsOTPerGame * AWAY_FACTOR;
    const avgHomeShots = avgShotsTotalPerGame * HOME_FACTOR;
    const avgAwayShots = avgShotsTotalPerGame * AWAY_FACTOR;

    // 5. Aggiorna il DB
    const existingTeam = await db.getTeam(dbEntry.teamId);
    if (existingTeam) {
      const existingStats = parseJson(existingTeam.team_stats_json);
      const transfermarktStats = {
        ...(existingStats.transfermarkt ?? {}),
        preferredForShots: true,
        competition,
        season: scraped.season,
        scrapedAt: scraped.scrapedAt.toISOString(),
        source: scraped.source,
        totals: {
          matchesPlayed: totalMatches,
          homeMatches,
          awayMatches,
          avgShotsOT: parseFloat(avgShotsOTPerGame.toFixed(2)),
          avgShotsTotal: parseFloat(avgShotsTotalPerGame.toFixed(2)),
          accuracyPct: parseFloat(Number(tmTeam.accuracyPct ?? 0).toFixed(2)),
        },
        home: {
          avgShots: parseFloat(avgHomeShots.toFixed(2)),
          avgShotsOT: parseFloat(avgHomeShotsOT.toFixed(2)),
        },
        away: {
          avgShots: parseFloat(avgAwayShots.toFixed(2)),
          avgShotsOT: parseFloat(avgAwayShotsOT.toFixed(2)),
        },
      };

      await db.upsertTeam({
        teamId: dbEntry.teamId,
        name: existingTeam.name,
        shortName: existingTeam.short_name,
        country: existingTeam.country,
        competition: existingTeam.competition,
        attackStrength: existingTeam.attack_strength ?? 0,
        defenceStrength: existingTeam.defence_strength ?? 0,
        avgHomeShots: parseFloat(avgHomeShots.toFixed(2)),
        avgAwayShots: parseFloat(avgAwayShots.toFixed(2)),
        avgHomeShotsOT: parseFloat(avgHomeShotsOT.toFixed(2)),
        avgAwayShotsOT: parseFloat(avgAwayShotsOT.toFixed(2)),
        avgHomeXG: existingTeam.avg_home_xg,
        avgAwayXG: existingTeam.avg_away_xg,
        avgYellowCards: existingTeam.avg_yellow_cards,
        avgRedCards: existingTeam.avg_red_cards,
        avgFouls: existingTeam.avg_fouls,
        shotsSuppression: existingTeam.shots_suppression,
        teamStatsJson: JSON.stringify({
          ...existingStats,
          transfermarkt: transfermarktStats,
        }),
      });
    }

    updatedTeams.push({
      ...tmTeam,
      matched: true,
      teamId: dbEntry.teamId,
      matchesPlayed: totalMatches,
      homeMatches,
      awayMatches,
      avgShotsOT: parseFloat(avgShotsOTPerGame.toFixed(2)),
      avgShotsTotal: parseFloat(avgShotsTotalPerGame.toFixed(2)),
      avgHomeShotsOT: parseFloat(avgHomeShotsOT.toFixed(2)),
      avgAwayShotsOT: parseFloat(avgAwayShotsOT.toFixed(2)),
      avgHomeShots: parseFloat(avgHomeShots.toFixed(2)),
      avgAwayShots: parseFloat(avgAwayShots.toFixed(2)),
    });
  }

  const matchedCount = updatedTeams.filter((t) => t.matched).length;
  const matchedTeams = updatedTeams.filter((t) => t.matched);
  const leagueAvgShotsOT =
    matchedTeams.length > 0
      ? matchedTeams.reduce((s, t) => s + (t.avgShotsOT ?? 0), 0) / matchedTeams.length
      : scraped.leagueAvgShotsOT;
  const leagueAvgShotsTotal =
    matchedTeams.length > 0
      ? matchedTeams.reduce((s, t) => s + (t.avgShotsTotal ?? 0), 0) / matchedTeams.length
      : scraped.leagueAvgShotsTotal;

  return {
    competition,
    season: scraped.season,
    scrapedAt: scraped.scrapedAt,
    totalScraped: scraped.teams.length,
    updatedTeams: matchedCount,
    notMatched,
    teams: updatedTeams,
    leagueAvgShotsOT: parseFloat(leagueAvgShotsOT.toFixed(2)),
    leagueAvgShotsTotal: parseFloat(leagueAvgShotsTotal.toFixed(2)),
    source: scraped.source,
  };
}

async function transfermarktRouteHandler(req: Request, res: Response, db: TransfermarktDb) {
  try {
    const competition = String(req.body?.competition ?? 'Serie A').trim();
    const season = String(req.body?.season ?? '').trim();
    const data = await syncTransfermarktStatsForCompetition(db, competition, season);
    return res.json({ success: true, data });
  } catch (error: any) {
    console.error('[TransfermarktScraper] Errore:', error.message);
    return res.status(500).json({
      success: false,
      error: error.message ?? 'Errore interno durante lo scraping di Transfermarkt',
    });
  }
}

export { transfermarktRouteHandler };
