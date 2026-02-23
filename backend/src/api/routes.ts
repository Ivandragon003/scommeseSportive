import { Router, Request, Response } from 'express';
import { PredictionService } from '../services/PredictionService';
import { DatabaseService } from '../db/DatabaseService';

const router = Router();
const db = new DatabaseService();
const svc = new PredictionService(db);

// ====== TEAMS ======
router.get('/teams', (req: Request, res: Response) => {
  try { res.json({ success: true, data: db.getTeams(req.query.competition as string) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/teams', (req: Request, res: Response) => {
  try { db.upsertTeam(req.body); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

// ====== PLAYERS ======
router.get('/players/:teamId', (req: Request, res: Response) => {
  try { res.json({ success: true, data: db.getPlayersByTeam(req.params.teamId) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/players', (req: Request, res: Response) => {
  try { db.upsertPlayer(req.body); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/players/bulk', (req: Request, res: Response) => {
  try {
    const { players } = req.body;
    if (!Array.isArray(players)) return res.status(400).json({ success: false, error: 'Array richiesto' });
    let ok = 0;
    for (const p of players) { try { db.upsertPlayer(p); ok++; } catch {} }
    return res.json({ success: true, imported: ok });
  } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
});

// ====== MATCHES ======
router.get('/matches', (req: Request, res: Response) => {
  try {
    const matches = db.getMatches({
      competition: req.query.competition as string,
      season: req.query.season as string,
      fromDate: req.query.fromDate as string,
      toDate: req.query.toDate as string,
    });
    res.json({ success: true, data: matches, count: matches.length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/matches', (req: Request, res: Response) => {
  try { db.upsertMatch({ ...req.body, date: new Date(req.body.date) }); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/matches/bulk', (req: Request, res: Response) => {
  try {
    const { matches } = req.body;
    if (!Array.isArray(matches)) return res.status(400).json({ success: false, error: 'Array richiesto' });
    let imported = 0;
    let errors = 0;
    for (const m of matches) {
      try {
        const normalized = {
          matchId:          m.matchId ?? m.match_id ?? m.id ?? `auto_${Date.now()}_${Math.random()}`,
          homeTeamId:       m.homeTeamId ?? m.home_team_id ?? m.HomeTeam ?? m.home_team,
          awayTeamId:       m.awayTeamId ?? m.away_team_id ?? m.AwayTeam ?? m.away_team,
          homeTeamName:     m.homeTeamName ?? m.home_team_name ?? m.HomeTeam ?? undefined,
          awayTeamName:     m.awayTeamName ?? m.away_team_name ?? m.AwayTeam ?? undefined,
          date:             new Date(m.date ?? m.Date ?? m.datetime),
          homeGoals:        m.homeGoals ?? m.home_goals ?? m.FTHG ?? m.score?.home,
          awayGoals:        m.awayGoals ?? m.away_goals ?? m.FTAG ?? m.score?.away,
          homeXG:           m.homeXG ?? m.home_xg ?? m.xg_home ?? m.xG_home,
          awayXG:           m.awayXG ?? m.away_xg ?? m.xg_away ?? m.xG_away,
          homeTotalShots:   m.homeTotalShots ?? m.home_shots ?? m.home_total_shots ?? m.HS,
          awayTotalShots:   m.awayTotalShots ?? m.away_shots ?? m.away_total_shots ?? m.AS,
          homeShotsOnTarget:m.homeShotsOnTarget ?? m.home_shots_on_target ?? m.HST,
          awayShotsOnTarget:m.awayShotsOnTarget ?? m.away_shots_on_target ?? m.AST,
          homePossession:   m.homePossession ?? m.home_possession ?? m.Poss_home,
          awayPossession:   m.awayPossession ?? m.away_possession ?? m.Poss_away,
          homeFouls:        m.homeFouls ?? m.home_fouls ?? m.HF,
          awayFouls:        m.awayFouls ?? m.away_fouls ?? m.AF,
          homeYellowCards:  m.homeYellowCards ?? m.home_yellow_cards ?? m.HY,
          awayYellowCards:  m.awayYellowCards ?? m.away_yellow_cards ?? m.AY,
          homeRedCards:     m.homeRedCards ?? m.home_red_cards ?? m.HR,
          awayRedCards:     m.awayRedCards ?? m.away_red_cards ?? m.AR,
          referee:          m.referee ?? m.Referee,
          competition:      m.competition ?? m.league ?? m.Division,
          season:           m.season ?? m.Season,
        };
        db.upsertMatch(normalized);
        imported++;
      } catch (err) {
        errors++;
      }
    }
    return res.json({ success: true, imported, errors, total: matches.length });
  } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
});

// ====== REFEREES ======
router.post('/referees', (req: Request, res: Response) => {
  try { db.upsertReferee(req.body); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.get('/referees/:name', (req: Request, res: Response) => {
  try { res.json({ success: true, data: db.getRefereeByName(decodeURIComponent(req.params.name)) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== MODEL ======
router.post('/model/fit', async (req: Request, res: Response) => {
  try {
    const result = await svc.fitModelForCompetition(req.body.competition, req.body.season, req.body.fromDate, req.body.toDate);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/model/recompute-averages', (req: Request, res: Response) => {
  try {
    const { competition } = req.body;
    const teams = db.getTeams(competition);
    let updated = 0;
    for (const t of teams) {
      db.recomputeTeamAverages(t.team_id);
      updated++;
    }
    res.json({ success: true, teamsUpdated: updated });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== PREDICT ======
router.post('/predict', (req: Request, res: Response) => {
  try {
    const pred = svc.predict(req.body);
    res.json({ success: true, data: formatPrediction(pred) });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

function pct(v: number): string { return (v * 100).toFixed(2) + '%'; }
function roundN(v: number, n = 3): number { return parseFloat(v.toFixed(n)); }

function formatPrediction(pred: any): any {
  const probs = pred.probabilities;
  return {
    ...pred,
    modelConfidence: (pred.modelConfidence * 100).toFixed(1) + '%',
    probabilities: {
      resultMarkets: {
        homeWin: pct(probs.homeWin), draw: pct(probs.draw), awayWin: pct(probs.awayWin),
        expectedGoalsHome: roundN(probs.lambdaHome), expectedGoalsAway: roundN(probs.lambdaAway),
      },
      goalMarkets: {
        btts: pct(probs.btts), bttsNo: pct(1 - probs.btts),
        over05: pct(probs.over05), over15: pct(probs.over15),
        over25: pct(probs.over25), over35: pct(probs.over35), over45: pct(probs.over45),
        under15: pct(probs.under15), under25: pct(probs.under25),
        under35: pct(probs.under35), under45: pct(probs.under45),
      },
      exactScores: Object.fromEntries(
        Object.entries(probs.exactScore)
          .sort(([,a],[,b]) => (b as number) - (a as number))
          .slice(0, 12)
          .map(([k,v]) => [k, pct(v as number)])
      ),
      handicap: Object.fromEntries(Object.entries(probs.handicap).map(([k,v]) => [k, pct(v as number)])),
      shotsMarkets: {
        homeExpected: roundN(probs.shotsHome.expected, 1),
        awayExpected: roundN(probs.shotsAway.expected, 1),
        homeSOTExpected: roundN(probs.shotsOnTargetHome.expected, 1),
        awaySOTExpected: roundN(probs.shotsOnTargetAway.expected, 1),
        totalOverUnder: Object.fromEntries(
          Object.entries(probs.shotsTotal).map(([k,v]: any) => [k, { over: pct(v.over), under: pct(v.under) }])
        ),
        homeOverUnder: Object.fromEntries(
          Object.entries(probs.shotsHome.overUnder as Record<string,any>).slice(0,6)
            .map(([k,v]: any) => [k, { over: pct(v.over), under: pct(v.under) }])
        ),
        awayOverUnder: Object.fromEntries(
          Object.entries(probs.shotsAway.overUnder as Record<string,any>).slice(0,6)
            .map(([k,v]: any) => [k, { over: pct(v.over), under: pct(v.under) }])
        ),
      },
      cardsMarkets: {
        expectedHomeYellow: roundN(probs.cards.expectedHomeYellow, 2),
        expectedAwayYellow: roundN(probs.cards.expectedAwayYellow, 2),
        expectedTotalYellow: roundN(probs.cards.expectedTotalYellow, 2),
        expectedTotalCardPoints: roundN(probs.cards.expectedTotalCards, 2),
        overUnderYellow: Object.fromEntries(
          Object.entries(probs.cards.overUnderYellow).map(([k,v]: any) => [k, { over: pct(v.over), under: pct(v.under) }])
        ),
        overUnderCardPoints: Object.fromEntries(
          Object.entries(probs.cards.overUnderTotal).map(([k,v]: any) => [k, { over: pct(v.over), under: pct(v.under) }])
        ),
      },
      foulsMarkets: {
        expectedHomeFouls: roundN(probs.fouls.expectedHomeFouls, 1),
        expectedAwayFouls: roundN(probs.fouls.expectedAwayFouls, 1),
        expectedTotalFouls: roundN(probs.fouls.expectedTotalFouls, 1),
        overUnder: Object.fromEntries(
          Object.entries(probs.fouls.overUnder).map(([k,v]: any) => [k, { over: pct(v.over), under: pct(v.under) }])
        ),
      },
      playerShots: {
        home: probs.playerShots.home.map((p: any) => ({
          name: p.playerName,
          expectedShots: roundN(p.expectedShots, 2),
          expectedSOT: roundN(p.expectedShotsOnTarget, 2),
          prob1Plus: pct(p.prob1PlusShots),
          prob2Plus: pct(p.prob2PlusShots),
          prob3Plus: pct(p.prob3PlusShots),
          prob1PlusSOT: pct(p.prob1PlusShotsOT),
          shareOfTeam: pct(p.shotShareOfTeam),
        })),
        away: probs.playerShots.away.map((p: any) => ({
          name: p.playerName,
          expectedShots: roundN(p.expectedShots, 2),
          expectedSOT: roundN(p.expectedShotsOnTarget, 2),
          prob1Plus: pct(p.prob1PlusShots),
          prob2Plus: pct(p.prob2PlusShots),
          prob3Plus: pct(p.prob3PlusShots),
          prob1PlusSOT: pct(p.prob1PlusShotsOT),
          shareOfTeam: pct(p.shotShareOfTeam),
        })),
      },
    },
    valueOpportunities: pred.valueOpportunities.map((o: any) => ({
      ...o,
      ourProbability: o.ourProbability.toFixed(2) + '%',
      impliedProbability: o.impliedProbability.toFixed(2) + '%',
      expectedValue: '+' + o.expectedValue.toFixed(2) + '%',
      edge: '+' + o.edge.toFixed(2) + '%',
    })),
  };
}

// ====== BUDGET & BETS ======
router.get('/budget/:userId', (req: Request, res: Response) => {
  try { res.json({ success: true, data: svc.getBudget(req.params.userId) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/budget/:userId/init', (req: Request, res: Response) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'Importo non valido' });
    return res.json({ success: true, data: svc.initBudget(req.params.userId, amount) });
  } catch (e: any) { return res.status(400).json({ success: false, error: e.message }); }
});

router.post('/bets/place', (req: Request, res: Response) => {
  try {
    const { userId, matchId, marketName, selection, odds, stake, ourProbability, expectedValue } = req.body;
    const result = svc.placeBet(userId, matchId, marketName, selection, odds, stake, ourProbability, expectedValue);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/bets/:betId/settle', (req: Request, res: Response) => {
  try {
    const result = svc.settleBet(req.params.betId, req.body.won, req.body.returnAmount);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.get('/bets/:userId', (req: Request, res: Response) => {
  try { res.json({ success: true, data: db.getBets(req.params.userId, req.query.status as string) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== BACKTEST ======
router.post('/backtest', async (req: Request, res: Response) => {
  try {
    const result = await svc.runBacktest(req.body.competition, req.body.season, req.body.historicalOdds);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.get('/backtest/results', (req: Request, res: Response) => {
  try { res.json({ success: true, data: db.getBacktestResults(req.query.competition as string) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/backtest/results/:id', (req: Request, res: Response) => {
  try {
    const r = db.getBacktestResult(parseInt(req.params.id));
    if (!r) return res.status(404).json({ success: false, error: 'Non trovato' });
    return res.json({ success: true, data: r });
  } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
});

router.get('/health', (_req, res) => res.json({ success: true, status: 'ok', version: '2.0' }));

// ====== FOTMOB SCRAPER (IMPORT INCREMENTALE) ======
import { FotmobScraper } from '../services/FotmobScraper';
const fotmob = new FotmobScraper();

async function runFotmobImport(req: Request, res: Response) {
  try {
    req.setTimeout(15 * 60 * 1000);
    res.setTimeout(15 * 60 * 1000);

    const {
      mode = 'single',
      competition = 'Serie A',
      competitions,
      seasons,
      yearsBack = 2,
      importPlayers = true,
      forceRefresh = false,
    } = req.body ?? {};

    const competitionsToRun: string[] = mode === 'top5'
      ? FotmobScraper.getTop5Competitions()
      : Array.isArray(competitions) && competitions.length > 0
        ? competitions
        : [competition];

    const seasonsToScrape: string[] = Array.isArray(seasons) && seasons.length > 0
      ? seasons
      : FotmobScraper.generateSeasons(yearsBack);

    let totalImported = 0;
    let totalSkipped = 0;
    let totalNew = 0;
    let teamsCreated = 0;
    let playersUpdated = 0;
    const seasonSummary: Record<string, any> = {};

    for (const competitionName of competitionsToRun) {
      for (const season of seasonsToScrape) {
        const lastDateInDb = db.getLastMatchDate(competitionName, season);
        const allMatches = await fotmob.scrapeSeason(competitionName, season);

        const newMatches = allMatches.filter(m => {
          if (m.homeGoals === null || m.awayGoals === null) return false;
          if (forceRefresh) return true;
          if (lastDateInDb && m.date.substring(0, 10) <= lastDateInDb) return false;
          return true;
        });

        const playersAgg = new Map<string, {
          playerId: string;
          sourcePlayerId: number | null;
          name: string;
          teamId: string;
          games: Set<string>;
          shots: number;
          shotsOnTarget: number;
          goals: number;
          xg: number;
          xgot: number;
          rawSamples: Record<string, unknown>[];
        }>();

        let imported = 0;
        let skipped = 0;

        for (const m of newMatches) {
          for (const team of [
            { teamId: m.homeTeamId, name: m.homeTeamName },
            { teamId: m.awayTeamId, name: m.awayTeamName },
          ]) {
            const existingTeam = db.getTeam(team.teamId);
            if (!existingTeam) {
              db.upsertTeam({
                teamId: team.teamId,
                name: team.name,
                competition: competitionName,
                sourceTeamId: null,
                teamStatsJson: JSON.stringify({ source: 'fotmob', competition: competitionName, season }),
              });
              teamsCreated++;
            }
          }

          try {
            db.upsertMatch(fotmob.toDbFormat(m));
            imported++;

            if (importPlayers) {
              for (const p of m.playerStats) {
                const agg = playersAgg.get(p.playerId) ?? {
                  playerId: p.playerId,
                  sourcePlayerId: p.sourcePlayerId,
                  name: p.playerName,
                  teamId: p.teamId,
                  games: new Set<string>(),
                  shots: 0,
                  shotsOnTarget: 0,
                  goals: 0,
                  xg: 0,
                  xgot: 0,
                  rawSamples: [],
                };
                agg.games.add(m.matchId);
                agg.shots += p.shots;
                agg.shotsOnTarget += p.shotsOnTarget;
                agg.goals += p.goals;
                agg.xg += p.xg;
                agg.xgot += p.xgot;
                agg.rawSamples.push(p.raw);
                playersAgg.set(p.playerId, agg);
              }
            }
          } catch {
            skipped++;
          }
        }

        for (const [, p] of playersAgg) {
          const games = Math.max(1, p.games.size);
          db.upsertPlayer({
            playerId: p.playerId,
            sourcePlayerId: p.sourcePlayerId,
            name: p.name,
            teamId: p.teamId,
            positionCode: 'MF',
            avgShotsPerGame: p.shots / games,
            avgShotsOnTargetPerGame: p.shotsOnTarget / games,
            avgXGPerGame: p.xg / games,
            avgXGOTPerGame: p.xgot / games,
            totalGoals: p.goals,
            totalShots: p.shots,
            totalShotsOnTarget: p.shotsOnTarget,
            shotShareOfTeam: 0,
            gamesPlayed: games,
            statsJson: JSON.stringify({
              source: 'fotmob',
              season,
              competition: competitionName,
              totalXG: p.xg,
              totalXGOT: p.xgot,
              rawSamples: p.rawSamples.slice(0, 8),
            }),
          });
          playersUpdated++;
        }

        totalImported += imported;
        totalSkipped += skipped;
        totalNew += newMatches.length;

        seasonSummary[`${competitionName} ${season}`] = {
          lastDateBefore: lastDateInDb ?? 'nessuna',
          totalOnSource: allMatches.length,
          newImported: imported,
          skipped,
          playersUpserted: playersAgg.size,
        };
      }
    }

    let teamsRecomputed = 0;
    for (const comp of competitionsToRun) {
      const teams = db.getTeams(comp);
      for (const t of teams) {
        db.recomputeTeamAverages(t.team_id);
        teamsRecomputed++;
      }
    }

    const lastSeason = seasonsToScrape[seasonsToScrape.length - 1];
    const lastDatesAfter = Object.fromEntries(
      competitionsToRun.map(comp => [comp, db.getLastMatchDate(comp, lastSeason) ?? 'nessuna'])
    );

    res.json({
      success: true,
      data: {
        source: 'fotmob',
        mode,
        competitions: competitionsToRun,
        seasons: seasonsToScrape,
        newMatchesImported: totalImported,
        skipped: totalSkipped,
        teamsCreated,
        playersUpdated,
        teamsRecomputed,
        dbLastDateAfter: lastDatesAfter,
        isUpToDate: totalNew === 0,
        forceRefresh,
        message: totalNew === 0
          ? 'DB già aggiornato, nessuna nuova partita trovata.'
          : `Importate ${totalImported} nuove partite, aggiornati ${playersUpdated} giocatori.`,
        seasonDetail: seasonSummary,
      }
    });
  } catch (e: any) {
    console.error('[fotmob] Errore:', e.message);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    await fotmob.close().catch(() => undefined);
  }
}

router.post('/scraper/fotmob', runFotmobImport);

/**
 * Info sulle competizioni e stagioni disponibili + stato del DB.
 * Utile per il frontend per sapere quando è stato fatto l'ultimo import.
 */
router.get('/scraper/fotmob/info', (_req, res) => {
  const competitions = FotmobScraper.getSupportedCompetitions();
  const top5 = FotmobScraper.getTop5Competitions();
  const seasons = FotmobScraper.generateSeasons(4);

  // Mostra l'ultima data importata per ogni competizione
  const dbStatus: Record<string, string> = {};
  for (const comp of competitions) {
    const lastSeason = seasons[seasons.length - 1];
    const lastDate = db.getLastMatchDate(comp, lastSeason);
    dbStatus[comp] = lastDate ?? 'nessun dato';
  }

  res.json({
    success: true,
    data: {
      competitions,
      top5Competitions: top5,
      suggestedSeasons: seasons,
      dbLastImport: dbStatus,
      note: 'Import FotMob via Playwright. Puoi lanciare import singolo o top-5 insieme.',
    }
  });
});

// ====== THE ODDS API ======
import { OddsApiService } from '../services/OddsApiService';

router.post('/scraper/odds', async (req: Request, res: Response) => {
  try {
    const { apiKey, competition = 'Serie A', markets = ['h2h', 'totals'] } = req.body;
    if (!apiKey) return res.status(400).json({ success: false, error: 'apiKey mancante. Registrati su https://the-odds-api.com' });

    const oddsService = new OddsApiService(apiKey);
    const matches = await oddsService.getOdds(competition, markets);

    const enriched = matches.map(m => ({
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      commenceTime: m.commenceTime,
      eurobetOdds: oddsService.extractBestOdds(m, 'eurobet'),
      bestOdds: oddsService.extractBestOdds(m),
      bookmakerComparison: oddsService.compareBookmakers(m),
      margins: m.bookmakers.reduce((acc, bm) => {
        const margin = oddsService.calculateMargin(m, bm.bookmakerKey);
        if (margin !== null) acc[bm.bookmakerName] = `${margin}%`;
        return acc;
      }, {} as Record<string, string>),
      remainingRequests: oddsService.getRemainingRequests(),
    }));

    res.json({
      success: true,
      data: {
        competition,
        matchesFound: matches.length,
        matches: enriched,
        remainingRequests: oddsService.getRemainingRequests(),
      }
    });
  } catch (e: any) {
    console.error('[OddsApi] Errore:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/scraper/odds/info', (_req, res) => {
  res.json({
    success: true,
    data: {
      competitions: OddsApiService.getSupportedCompetitions(),
      bookmakers: OddsApiService.getSupportedBookmakers(),
      freePlanLimit: 500,
      registrationUrl: 'https://the-odds-api.com',
      note: 'Piano gratuito: 500 richieste/mese. Per la Serie A bastano ~4 richieste/settimana.',
    }
  });
});

export default router;
