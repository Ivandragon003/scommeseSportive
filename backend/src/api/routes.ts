import { Router, Request, Response } from 'express';
import { PredictionService } from '../services/PredictionService';
import { DatabaseService } from '../db/DatabaseService';
import { OddsApiService, OddsMatch } from '../services/OddsApiService';
import { CoordinatedOddsMatch } from '../services/odds-provider/OddsProviderCoordinator';
import {
  createOddsProviderCoordinatorBundle,
  getConfiguredOddsApiKey,
  getConfiguredFallbackProviderName,
  getConfiguredPrimaryProviderName,
  OddsProviderCoordinatorBundle,
} from '../services/odds-provider/providerRuntimeConfig';
import { getProviderTimeoutMs } from '../services/odds-provider/OddsProviderCoordinator';
import { OddsApiKickoffSyncService } from '../services/OddsApiKickoffSyncService';
import { SofaScoreSupplementalScraper } from '../services/SofaScoreSupplementalScraper';
import { buildBacktestReport } from '../services/BacktestReportService';
import { SystemObservabilityService } from '../services/SystemObservabilityService';
import { UnderstatScraper } from '../services/UnderstatScraper';
import { formatPrediction, poissonOver } from './predictionPayloadFormatter';
import { rebuildRefereeDerivedStats } from '../services/RefereeDerivedStatsService';
import { recomputeTeamAveragesForMatchRows } from '../services/TeamAveragesService';
import { rebuildPlayerDerivedStats } from '../services/PlayerDerivedStatsService';

const UNDERSTAT_DETAIL_CONCURRENCY = Math.max(
  2,
  Math.min(Number(process.env.UNDERSTAT_DETAIL_CONCURRENCY ?? 10), 24)
);

export type ApiRouterDependencies = {
  db: DatabaseService;
  svc?: PredictionService;
  observability?: SystemObservabilityService;
  createOddsProviderCoordinatorBundle?: () => OddsProviderCoordinatorBundle;
  createOddsApiKickoffSyncService?: (db: DatabaseService) => Pick<
    OddsApiKickoffSyncService,
    'syncUpcomingKickoffsFromOddsApi' | 'syncSingleMatchKickoffFromOddsApi'
  >;
};

export type OddsCompetitionFixtureScope = {
  homeTeam: string;
  awayTeam: string;
  commenceTime?: string | null;
};

const normalizeOddsCompetitionCachePart = (value: string): string =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeOddsFixtureCommenceTime = (value?: string | null): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const timestamp = Date.parse(raw);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return raw;
};

const buildOddsFixtureSignature = (fixtures?: OddsCompetitionFixtureScope[]): string => {
  if (!Array.isArray(fixtures) || fixtures.length === 0) return 'all';

  return fixtures
    .map((fixture) => [
      normalizeOddsCompetitionCachePart(String(fixture.homeTeam ?? '')),
      normalizeOddsCompetitionCachePart(String(fixture.awayTeam ?? '')),
      normalizeOddsCompetitionCachePart(normalizeOddsFixtureCommenceTime(fixture.commenceTime)),
    ].join('__'))
    .sort()
    .join('|');
};

export const buildOddsCompetitionCacheKey = (input: {
  competition: string;
  includeExtendedGroups?: boolean;
  fixtures?: OddsCompetitionFixtureScope[];
}): string => {
  const fixtureScoped = Array.isArray(input.fixtures) && input.fixtures.length > 0;
  return [
    normalizeOddsCompetitionCachePart(String(input.competition ?? '')),
    input.includeExtendedGroups ? 'extended' : 'base',
    fixtureScoped ? 'fixtures' : 'bulk',
    buildOddsFixtureSignature(input.fixtures),
  ].join('::');
};

export const shouldUseOddsCompetitionCache = (
  fixtures?: OddsCompetitionFixtureScope[]
): boolean => !Array.isArray(fixtures) || fixtures.length === 0;

const DEFAULT_BULK_ODDS_ROUTE_TIMEOUT_MS = 120_000;
const DEFAULT_BULK_ODDS_FALLBACK_GRACE_MS = 15_000;
const DEFAULT_MATCH_ODDS_ROUTE_TIMEOUT_MS = 60_000;
const DEFAULT_MATCH_ODDS_FALLBACK_GRACE_MS = 15_000;
const DEFAULT_BACKTEST_ROUTE_TIMEOUT_MS = 10 * 60 * 1000;

const parsePositiveIntEnvValue = (name: string, fallback: number): number => {
  const raw = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

export const getBulkOddsRouteTimeoutMs = (): number => {
  const configuredRouteTimeout = parsePositiveIntEnvValue(
    'ODDS_BULK_ROUTE_TIMEOUT_MS',
    DEFAULT_BULK_ODDS_ROUTE_TIMEOUT_MS
  );
  const providerTimeout = getProviderTimeoutMs('runtime', false);
  const fallbackGraceMs = parsePositiveIntEnvValue(
    'ODDS_BULK_FALLBACK_GRACE_MS',
    DEFAULT_BULK_ODDS_FALLBACK_GRACE_MS
  );

  return Math.max(configuredRouteTimeout, providerTimeout + fallbackGraceMs);
};

export const getMatchOddsRouteTimeoutMs = (): number => {
  const configuredRouteTimeout = parsePositiveIntEnvValue(
    'ODDS_MATCH_ROUTE_TIMEOUT_MS',
    DEFAULT_MATCH_ODDS_ROUTE_TIMEOUT_MS
  );
  const providerTimeout = getProviderTimeoutMs('runtime', true);
  const fallbackGraceMs = parsePositiveIntEnvValue(
    'ODDS_MATCH_FALLBACK_GRACE_MS',
    DEFAULT_MATCH_ODDS_FALLBACK_GRACE_MS
  );

  return Math.max(configuredRouteTimeout, providerTimeout + fallbackGraceMs);
};

export const getBacktestRouteTimeoutMs = (): number =>
  parsePositiveIntEnvValue('BACKTEST_ROUTE_TIMEOUT_MS', DEFAULT_BACKTEST_ROUTE_TIMEOUT_MS);

export function createApiRouter(deps: ApiRouterDependencies): Router {
const router = Router();
const db = deps.db;
const svc = deps.svc ?? new PredictionService(db);
const observability = deps.observability;
const createOddsBundle = deps.createOddsProviderCoordinatorBundle ?? createOddsProviderCoordinatorBundle;
const createKickoffSyncService = deps.createOddsApiKickoffSyncService
  ?? ((database: DatabaseService) => new OddsApiKickoffSyncService(database));

const applyBacktestRouteTimeout = (req: Request, res: Response): void => {
  const timeoutMs = getBacktestRouteTimeoutMs();
  req.setTimeout(timeoutMs);
  res.setTimeout(timeoutMs);
};

async function buildStatsOverviewPayload() {
  const top5 = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
  const [coverage, leagues, playersByLeague] = await Promise.all([
    db.getMatchesCoverageStats(),
    db.getLeagueSummaries(top5),
    db.getPlayerCoverageByLeague(top5),
  ]);

  const leaguesWithPlayers = leagues.map((league) => ({
    ...league,
    players: playersByLeague[league.competition] ?? { players: 0, teamsWithPlayers: 0, avgGamesPlayed: 0 },
  }));

  return {
    generatedAt: new Date().toISOString(),
    checks: {
      allCoreStatsLoaded:
        coverage.fields.xg.pct >= 60 &&
        coverage.fields.shots.pct >= 70 &&
        coverage.fields.shotsOnTarget.pct >= 70 &&
        coverage.fields.yellowCards.pct >= 60,
      recommendedThresholds: {
        xgPct: 60,
        shotsPct: 70,
        shotsOnTargetPct: 70,
        yellowCardsPct: 60,
      },
    },
    coverage,
    leagues: leaguesWithPlayers,
  };
}

// ====== TEAMS ======
router.get('/teams', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await db.getTeams(req.query.competition as string) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/teams', async (req: Request, res: Response) => {
  try { await db.upsertTeam(req.body); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

// ====== PLAYERS ======
router.get('/players/:teamId', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await db.getPlayersByTeam(req.params.teamId) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/players', async (req: Request, res: Response) => {
  try { await db.upsertPlayer(req.body); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/players/bulk', async (req: Request, res: Response) => {
  try {
    const { players } = req.body;
    if (!Array.isArray(players)) return res.status(400).json({ success: false, error: 'Array richiesto' });
    let ok = 0;
    for (const p of players) { try { await db.upsertPlayer(p); ok++; } catch { /* skip invalid player payloads */ } }
    return res.json({ success: true, imported: ok });
  } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
});

// ====== MATCHES ======
router.get('/matches', async (req: Request, res: Response) => {
  try {
    const matches = await db.getMatches({
      competition: req.query.competition as string,
      season: req.query.season as string,
      fromDate: req.query.fromDate as string,
      toDate: req.query.toDate as string,
    });
    res.json({ success: true, data: matches, count: matches.length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/matches/count', async (req: Request, res: Response) => {
  try {
    const count = await db.countMatches({
      competition: req.query.competition as string,
      season: req.query.season as string,
      fromDate: req.query.fromDate as string,
      toDate: req.query.toDate as string,
    });
    res.json({ success: true, count });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/matches/matchdays', async (req: Request, res: Response) => {
  try {
    const competition = String(req.query.competition ?? 'Serie A');
    const season = req.query.season ? String(req.query.season) : undefined;
    const matchesPerMatchdayRaw = parseInt(String(req.query.matchesPerMatchday ?? 10), 10);
    const matchesPerMatchday = Number.isFinite(matchesPerMatchdayRaw)
      ? Math.max(1, Math.min(matchesPerMatchdayRaw, 30))
      : 10;

    const rows = await db.getMatchdayRows({ competition, season });
    const matchdayMap: Record<string, number> = {};

    rows.forEach((row: any, idx: number) => {
      const matchId = String(row?.match_id ?? '').trim();
      if (!matchId) return;
      matchdayMap[matchId] = Math.floor(idx / matchesPerMatchday) + 1;
    });

    res.json({ success: true, data: matchdayMap, count: Object.keys(matchdayMap).length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/matches/upcoming', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const matches = await db.getUpcomingMatches({
      competition: req.query.competition as string | undefined,
      season: req.query.season as string | undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    res.json({ success: true, data: matches, count: matches.length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/matches/recent', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const matches = await db.getRecentCompletedMatches({
      competition: req.query.competition as string | undefined,
      season: req.query.season as string | undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    res.json({ success: true, data: matches, count: matches.length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/matches', async (req: Request, res: Response) => {
  try { await db.upsertMatch({ ...req.body, date: new Date(req.body.date) }); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/matches/bulk', async (req: Request, res: Response) => {
  try {
    const { matches } = req.body;
    if (!Array.isArray(matches)) return res.status(400).json({ success: false, error: 'Array richiesto' });
    let imported = 0;
    let errors = 0;
    for (const m of matches) {
      try {
        const normalized = {
          matchId: m.matchId ?? m.match_id ?? m.id ?? `auto_${Date.now()}_${Math.random()}`,
          homeTeamId: m.homeTeamId ?? m.home_team_id ?? m.HomeTeam ?? m.home_team,
          awayTeamId: m.awayTeamId ?? m.away_team_id ?? m.AwayTeam ?? m.away_team,
          homeTeamName: m.homeTeamName ?? m.home_team_name ?? m.HomeTeam ?? undefined,
          awayTeamName: m.awayTeamName ?? m.away_team_name ?? m.AwayTeam ?? undefined,
          date: new Date(m.date ?? m.Date ?? m.datetime),
          homeGoals: m.homeGoals ?? m.home_goals ?? m.FTHG ?? m.score?.home,
          awayGoals: m.awayGoals ?? m.away_goals ?? m.FTAG ?? m.score?.away,
          homeXG: m.homeXG ?? m.home_xg ?? m.xg_home ?? m.xG_home,
          awayXG: m.awayXG ?? m.away_xg ?? m.xg_away ?? m.xG_away,
          homeTotalShots: m.homeTotalShots ?? m.home_shots ?? m.home_total_shots ?? m.HS,
          awayTotalShots: m.awayTotalShots ?? m.away_shots ?? m.away_total_shots ?? m.AS,
          homeShotsOnTarget: m.homeShotsOnTarget ?? m.home_shots_on_target ?? m.HST,
          awayShotsOnTarget: m.awayShotsOnTarget ?? m.away_shots_on_target ?? m.AST,
          homePossession: m.homePossession ?? m.home_possession ?? m.Poss_home,
          awayPossession: m.awayPossession ?? m.away_possession ?? m.Poss_away,
          homeFouls: m.homeFouls ?? m.home_fouls ?? m.HF,
          awayFouls: m.awayFouls ?? m.away_fouls ?? m.AF,
          homeYellowCards: m.homeYellowCards ?? m.home_yellow_cards ?? m.HY,
          awayYellowCards: m.awayYellowCards ?? m.away_yellow_cards ?? m.AY,
          homeRedCards: m.homeRedCards ?? m.home_red_cards ?? m.HR,
          awayRedCards: m.awayRedCards ?? m.away_red_cards ?? m.AR,
          homeCorners: m.homeCorners ?? m.home_corners ?? m.HC,
          awayCorners: m.awayCorners ?? m.away_corners ?? m.AC,
          referee: m.referee ?? m.Referee,
          competition: m.competition ?? m.league ?? m.Division,
          season: m.season ?? m.Season,
        };
        await db.upsertMatch(normalized);
        imported++;
      } catch (_err) {
        errors++;
      }
    }
    return res.json({ success: true, imported, errors, total: matches.length });
  } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
});

// ====== REFEREES ======
router.post('/referees', async (req: Request, res: Response) => {
  try { await db.upsertReferee(req.body); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.get('/referees/:name', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await db.getRefereeByName(decodeURIComponent(req.params.name)) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== MODEL ======
router.post('/model/fit', async (req: Request, res: Response) => {
  try {
    const result = await svc.fitModelForCompetition(req.body.competition, req.body.season, req.body.fromDate, req.body.toDate);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/model/recompute-averages', async (req: Request, res: Response) => {
  try {
    const {
      competition,
      season,
      fromDate,
      toDate,
      recomputePlayers = true,
      recomputeReferees = true,
    } = req.body ?? {};

    const normalizedCompetition = String(competition ?? '').trim();
    const teams = await db.getTeams(competition);
    let teamsUpdated = 0;
    for (const t of teams) {
      await db.recomputeTeamAverages(t.team_id);
      teamsUpdated++;
    }

    const playerStats = recomputePlayers
      ? await rebuildPlayerDerivedStats(db, {
        competition: normalizedCompetition || undefined,
        season: String(season ?? '').trim() || undefined,
        fromDate: String(fromDate ?? '').trim() || undefined,
        toDate: String(toDate ?? '').trim() || undefined,
      })
      : {
        playersMarkedUnavailable: 0,
        playersDetected: 0,
        playersUpdated: 0,
        playedMatchesConsidered: 0,
        matchesWithShotmap: 0,
      };

    const refereeStats = recomputeReferees
      ? await rebuildRefereeDerivedStats(db, {
        competition: normalizedCompetition || undefined,
        season: String(season ?? '').trim() || undefined,
        fromDate: String(fromDate ?? '').trim() || undefined,
        toDate: String(toDate ?? '').trim() || undefined,
      })
      : {
        refereesDetected: 0,
        refereesUpdated: 0,
        matchesConsidered: 0,
      };

    res.json({
      success: true,
      teamsUpdated,
      playersRecomputeEnabled: Boolean(recomputePlayers),
      refereesRecomputeEnabled: Boolean(recomputeReferees),
      ...playerStats,
      ...refereeStats,
    });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== PREDICT ======
router.post('/predict', async (req: Request, res: Response) => {
  try {
    const pred = await svc.predict(req.body);
    res.json({ success: true, data: formatPrediction(pred) });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/predict/replay', async (req: Request, res: Response) => {
  try {
    const matchId = String(req.body?.matchId ?? '').trim();
    if (!matchId) return res.status(400).json({ success: false, error: 'matchId obbligatorio.' });

    const match = await db.getMatchById(matchId);
    if (!match) return res.status(404).json({ success: false, error: 'Partita non trovata.' });
    if (match.home_goals === null || match.away_goals === null) {
      return res.status(400).json({ success: false, error: 'La partita non e ancora conclusa.' });
    }

    const historicalSnapshot =
      await db.getLatestOddsSnapshotForMatch(String(match.match_id))
      ?? await db.findLatestOddsSnapshotByTeams(
        String(match.home_team_name ?? ''),
        String(match.away_team_name ?? ''),
        String(match.competition ?? ''),
        String(match.date ?? '')
      );

    const historicalReplayOdds = sanitizeOddsMap(
      historicalSnapshot?.liveSelectedOdds ?? historicalSnapshot?.eurobetOdds ?? {}
    );

    let replayEstimatedOdds: Record<string, number> = {};
    let replayOddsUsed: Record<string, number> = historicalReplayOdds;
    let replaySource = 'historical_bookmaker_snapshot';
    let analysisDisclaimer =
      `Replay su quote bookmaker archiviate il ${String(historicalSnapshot?.captured_at ?? '').trim() || 'data non disponibile'}: ` +
      `mercati valutati solo sulle quote reali salvate per questa partita.`;
    let marketsRequested = Array.isArray(historicalSnapshot?.marketsRequested) && historicalSnapshot.marketsRequested.length > 0
      ? historicalSnapshot.marketsRequested
      : ['historical_bookmaker_snapshot'];

    if (Object.keys(replayOddsUsed).length === 0) {
      const basePred = await svc.predict({
        homeTeamId: String(match.home_team_id),
        awayTeamId: String(match.away_team_id),
        matchId: String(match.match_id),
        competition: String(match.competition ?? ''),
      });

      replayEstimatedOdds = sanitizeOddsMap(
        Object.entries(collectModelProbabilitiesForOdds(basePred)).reduce((acc, [selection, prob]) => {
          acc[selection] = probabilityToOdds(prob, marketOverround(selection));
          return acc;
        }, {} as Record<string, number>)
      );
      replayOddsUsed = replayEstimatedOdds;
      replaySource = 'model_estimated_replay';
      analysisDisclaimer = 'Replay statistico su partita gia giocata: quota finale stimata dal modello, non archivio bookmaker storico.';
      marketsRequested = ['model_estimated_replay'];
    }

    const replayPred = await svc.predict({
      homeTeamId: String(match.home_team_id),
      awayTeamId: String(match.away_team_id),
      matchId: String(match.match_id),
      competition: String(match.competition ?? ''),
      bookmakerOdds: replayOddsUsed,
    });

    const formatted = formatPrediction(replayPred);
    const recommended = replayPred.bestValueOpportunity ?? null;
    const recommendedBetResult = recommended
      ? svc.evaluateSelectionAgainstMatch(String(recommended.selection ?? ''), match)
      : null;
    const learningReview = svc.buildCompletedMatchLearningReview(replayPred, match, replayOddsUsed, {
      source: replaySource === 'historical_bookmaker_snapshot'
        ? 'historical_bookmaker_snapshot'
        : 'model_estimated_replay',
      learningWeight: replaySource === 'historical_bookmaker_snapshot' ? 1 : 0.35,
    });
    await db.saveLearningReview(
      String(match.match_id),
      String(match.competition ?? ''),
      learningReview
    );

    res.json({
      success: true,
      data: {
        ...formatted,
        analysisMode: 'played_match_replay',
        analysisDisclaimer,
        oddsReplaySource: replaySource,
        replayOddsUsed,
        replayEstimatedOdds,
        historicalSnapshot: historicalSnapshot
          ? {
              capturedAt: historicalSnapshot.captured_at,
              source: historicalSnapshot.source,
              usedFallbackBookmaker: historicalSnapshot.usedFallbackBookmaker,
              usedSyntheticOdds: historicalSnapshot.usedSyntheticOdds,
            }
          : null,
        marketsRequested,
        actualMatch: {
          homeGoals: Number(match.home_goals ?? 0),
          awayGoals: Number(match.away_goals ?? 0),
          actualScore: `${match.home_goals}-${match.away_goals}`,
          date: match.date,
        },
        recommendedBetResult: recommendedBetResult
          ? {
              ...recommendedBetResult,
              selection: recommended.selection,
              selectionLabel: recommended.selectionLabel ?? recommended.marketName,
            }
          : null,
      },
    });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message });
  }
});

// ====== BUDGET & BETS ======
router.get('/budget/:userId', async (req: Request, res: Response) => {
  try {
    await svc.syncPendingBets(req.params.userId);
    res.json({ success: true, data: await svc.getBudget(req.params.userId) });
  }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/budget/:userId/init', async (req: Request, res: Response) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'Importo non valido' });
    return res.json({ success: true, data: await svc.initBudget(req.params.userId, amount) });
  } catch (e: any) { return res.status(400).json({ success: false, error: e.message }); }
});

router.post('/bets/place', async (req: Request, res: Response) => {
  try {
    const {
      userId,
      matchId,
      marketName,
      selection,
      odds,
      stake,
      ourProbability,
      expectedValue,
      homeTeamName,
      awayTeamName,
      competition,
      matchDate,
    } = req.body;

    const result = await svc.placeBet(
      userId,
      matchId,
      marketName,
      selection,
      odds,
      stake,
      ourProbability,
      expectedValue,
      { homeTeamName, awayTeamName, competition, matchDate }
    );
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/bets/:betId/settle', async (req: Request, res: Response) => {
  try {
    const result = await svc.settleBet(req.params.betId, req.body.won, req.body.returnAmount);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.get('/bets/:userId', async (req: Request, res: Response) => {
  try {
    await svc.syncPendingBets(req.params.userId);
    res.json({ success: true, data: await svc.getBets(req.params.userId, req.query.status as string) });
  }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== BACKTEST ======
router.post('/backtest', async (req: Request, res: Response) => {
  applyBacktestRouteTimeout(req, res);
  try {
    const result = await svc.runWalkForwardBacktest(
      req.body.competition,
      req.body.season,
      req.body.historicalOdds,
      {
        initialTrainMatches: req.body.initialTrainMatches,
        testWindowMatches: req.body.testWindowMatches,
        stepMatches: req.body.stepMatches,
        confidenceLevel: req.body.confidenceLevel,
        expandingWindow: req.body.expandingWindow,
        maxFolds: req.body.maxFolds,
        saveIndividualRuns: req.body.saveIndividualRuns === true,
        compareBaseline: req.body.compareBaseline !== false,
        optimizeRankingWeights: req.body.optimizeRankingWeights === true,
      }
    );
    res.setHeader('Deprecation', 'true');
    res.setHeader('Link', '</api/backtest/walk-forward>; rel="successor-version"');
    res.json({
      success: true,
      data: {
        ...result,
        deprecatedEndpoint: '/backtest',
        replacementEndpoint: '/backtest/walk-forward',
        deprecationMessage: 'POST /backtest e deprecated: usa POST /backtest/walk-forward. Il risultato e walk-forward.',
      },
    });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

type ExternalSchedulerRunMeta = {
  enabled: boolean;
  schedulerName: string;
  trigger: string;
  startedAt: string;
};

function getExternalSchedulerRunMeta(req: Request, expectedSchedulerName: string): ExternalSchedulerRunMeta | null {
  const candidate = req.body?._schedulerRun;
  if (!candidate || candidate.enabled !== true) return null;

  const schedulerName = String(candidate.schedulerName ?? '').trim();
  if (schedulerName !== expectedSchedulerName) return null;

  const startedAtRaw = String(candidate.startedAt ?? '').trim();
  const startedAt = startedAtRaw && !Number.isNaN(new Date(startedAtRaw).getTime())
    ? startedAtRaw
    : new Date().toISOString();

  return {
    enabled: true,
    schedulerName,
    trigger: String(candidate.trigger ?? 'external').trim() || 'external',
    startedAt,
  };
}

async function persistExternalSchedulerRun(
  meta: ExternalSchedulerRunMeta | null,
  success: boolean,
  summary?: Record<string, any> | null,
  error?: string | null
): Promise<void> {
  if (!meta) return;
  await db.saveSchedulerRun({
    schedulerName: meta.schedulerName,
    trigger: meta.trigger,
    startedAt: meta.startedAt,
    endedAt: new Date().toISOString(),
    success,
    durationMs: Math.max(0, Date.now() - new Date(meta.startedAt).getTime()),
    summary: summary ?? null,
    error: error ?? null,
  });
}

router.post('/learning/reviews/sync', async (req: Request, res: Response) => {
  const externalRun = getExternalSchedulerRunMeta(req, 'learning');
  try {
    const result = await svc.syncCompletedMatchLearningReviews({
      competition: req.body?.competition,
      season: req.body?.season,
      limit: req.body?.limit,
      forceRefresh: Boolean(req.body?.forceRefresh),
    });
    await persistExternalSchedulerRun(externalRun, true, result, null);
    res.json({ success: true, data: result });
  } catch (e: any) {
    await persistExternalSchedulerRun(externalRun, false, null, e.message);
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/backtest/walk-forward', async (req: Request, res: Response) => {
  applyBacktestRouteTimeout(req, res);
  try {
    const result = await svc.runWalkForwardBacktest(
      req.body.competition,
      req.body.season,
      req.body.historicalOdds,
      {
        initialTrainMatches: req.body.initialTrainMatches,
        testWindowMatches: req.body.testWindowMatches,
        stepMatches: req.body.stepMatches,
        confidenceLevel: req.body.confidenceLevel,
        expandingWindow: req.body.expandingWindow,
        maxFolds: req.body.maxFolds,
        saveIndividualRuns: req.body.saveIndividualRuns === true,
        compareBaseline: req.body.compareBaseline !== false,
        optimizeRankingWeights: req.body.optimizeRankingWeights === true,
      }
    );
    res.json({ success: true, data: result });
  } catch (e: any) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.get('/backtest/results', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await db.getBacktestResults(req.query.competition as string) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/backtest/results/:id', async (req: Request, res: Response) => {
  try {
    const id = Number.parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'ID run non valido' });
    const r = await db.getBacktestResult(id);
    if (!r) return res.status(404).json({ success: false, error: 'Non trovato' });
    return res.json({ success: true, data: r });
  } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
});

router.get('/backtest/report', async (req: Request, res: Response) => {
  try {
    const runIdRaw = Number.parseInt(String(req.query.runId ?? ''), 10);
    const competition = String(req.query.competition ?? '').trim();
    let runRecord: any | null = null;

    if (Number.isFinite(runIdRaw)) {
      runRecord = await db.getBacktestResult(runIdRaw);
    } else {
      const latest = await db.getBacktestResults(competition || undefined);
      const latestId = Number(latest[0]?.id ?? 0);
      if (Number.isFinite(latestId) && latestId > 0) {
        runRecord = await db.getBacktestResult(latestId);
      }
    }

    if (!runRecord?.result) {
      return res.status(404).json({ success: false, error: 'Nessun run di backtest disponibile per il report richiesto' });
    }

    const report = buildBacktestReport(runRecord.result, {
      market: String(req.query.market ?? '').trim() || undefined,
      source: String(req.query.source ?? '').trim() || undefined,
      dateFrom: String(req.query.dateFrom ?? '').trim() || undefined,
      dateTo: String(req.query.dateTo ?? '').trim() || undefined,
    });

    return res.json({
      success: true,
      data: {
        runId: runRecord.id,
        runAt: runRecord.run_at,
        report,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/backtest/results/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'ID run non valido' });
    const deleted = await db.deleteBacktestResult(id);
    if (!deleted) return res.status(404).json({ success: false, error: 'Run non trovato' });
    return res.json({ success: true, data: { deleted: true } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.delete('/backtest/results', async (req: Request, res: Response) => {
  try {
    const competition = String(req.query.competition ?? '').trim();
    const deletedCount = await db.deleteBacktestResults(competition || undefined);
    return res.json({ success: true, data: { deletedCount } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/backtest/results/prune', async (req: Request, res: Response) => {
  try {
    const keepLatestRaw = Number(req.body?.keepLatest);
    if (!Number.isFinite(keepLatestRaw) || keepLatestRaw < 0) {
      return res.status(400).json({ success: false, error: 'keepLatest deve essere un numero >= 0' });
    }
    const competition = String(req.body?.competition ?? '').trim();
    const deletedCount = await db.pruneBacktestResults(Math.floor(keepLatestRaw), competition || undefined);
    return res.json({ success: true, data: { deletedCount } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/stats/overview', async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await buildStatsOverviewPayload() });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/analytics/system', async (req: Request, res: Response) => {
  try {
    const competition = String(req.query.competition ?? '').trim() || undefined;
    const userId = String(req.query.userId ?? '').trim() || 'default';
    const [overview, oddsArchive, userClv, learningLoop, adaptiveTuning] = await Promise.all([
      buildStatsOverviewPayload(),
      db.getOddsArchiveStats({ competition }),
      db.getUserBetClvReport(userId),
      db.getLearningReviewStats({ competition }),
      svc.getAdaptiveTuningSummary(competition),
    ]);

    return res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        competition: competition ?? 'all',
        overview,
        oddsArchive,
        userClv,
        learningLoop,
        adaptiveTuning,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/health', (_req, res) => res.json({ success: true, status: 'ok', version: '2.0' }));

// ====== UNDERSTAT SCRAPER (FONTE PRIMARIA) ======
const understat = new UnderstatScraper();
let understatImportInProgress = false;
let understatActiveImportMeta: {
  startedAt: string;
  mode: string;
  competitions: string[];
  seasons: string[];
  includeMatchDetails: boolean;
  forceRefresh: boolean;
  importPlayers: boolean;
  includeSofaScoreSupplemental?: boolean;
  sofaScoreSupplementalLimit?: number;
} | null = null;
const SOFASCORE_SUPPLEMENTAL_ENABLED =
  String(process.env.SOFASCORE_SUPPLEMENTAL_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
const SOFASCORE_SUPPLEMENTAL_MAX_MATCHES_PER_RUN = Math.max(
  0,
  Math.min(Number(process.env.SOFASCORE_SUPPLEMENTAL_MAX_MATCHES_PER_RUN ?? 80) || 80, 500)
);

const canonicalUnderstatTeamName = (name: string): string =>
  ({
    newcastle_united: 'newcastle',
    manchester_united: 'manchester_united',
    manchester_city: 'manchester_city',
    psg: 'psg',
    paris_saint_germain: 'psg',
    inter_milan: 'inter',
    internazionale: 'inter',
    athletic_club: 'athletic_bilbao',
    borussia_monchengladbach: 'monchengladbach',
    gladbach: 'monchengladbach',
    olympique_marseille: 'marseille',
    olympique_lyonnais: 'lyon',
  } as Record<string, string>)[UnderstatScraper.normalizeTeamName(name)] ?? UnderstatScraper.normalizeTeamName(name);

const isCompletedMatchRow = (row: any): boolean =>
  row?.home_goals !== null && row?.home_goals !== undefined
  && row?.away_goals !== null && row?.away_goals !== undefined;

const needsSofaScoreSupplemental = (row: any): boolean => {
  if (!row) return true;
  const hasReferee = typeof row?.referee === 'string' && row.referee.trim().length > 0;
  if (!isCompletedMatchRow(row)) return !hasReferee;
  return !hasReferee
    || row?.home_possession === null || row?.home_possession === undefined
    || row?.away_possession === null || row?.away_possession === undefined
    || row?.home_fouls === null || row?.home_fouls === undefined
    || row?.away_fouls === null || row?.away_fouls === undefined
    || row?.home_corners === null || row?.home_corners === undefined
    || row?.away_corners === null || row?.away_corners === undefined;
};

const rankSofaScoreCandidates = (rows: any[]): any[] => {
  const completed = rows
    .filter((row) => isCompletedMatchRow(row))
    .sort((a, b) => new Date(String(b?.date ?? '')).getTime() - new Date(String(a?.date ?? '')).getTime());
  const upcoming = rows
    .filter((row) => !isCompletedMatchRow(row))
    .sort((a, b) => new Date(String(a?.date ?? '')).getTime() - new Date(String(b?.date ?? '')).getTime());
  return [...completed, ...upcoming];
};

router.get('/stats/understat/team-season', async (req: Request, res: Response) => {
  try {
    const competition = String(req.query.competition ?? '').trim();
    const season = String(req.query.season ?? '').trim();
    const teamId = String(req.query.teamId ?? '').trim();

    if (!competition || !season || !teamId) {
      return res.status(400).json({
        success: false,
        error: 'Parametri richiesti: competition, season, teamId',
      });
    }

    const team = await db.getTeam(teamId);
    if (!team) {
      return res.status(404).json({
        success: false,
        error: `Squadra non trovata: ${teamId}`,
      });
    }

    const data = await understat.getTeamSeasonStats(competition, season, String(team.name ?? teamId));
    if (!data) {
      return res.status(404).json({
        success: false,
        error: `Stats stagionali Understat non trovate per ${team.name ?? teamId} (${competition} ${season})`,
      });
    }

    return res.json({ success: true, data });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/scraper/understat/info', async (_req, res) => {
  const competitions = UnderstatScraper.getSupportedCompetitions();
  const top5 = UnderstatScraper.getTop5Competitions();
  const seasons = UnderstatScraper.generateSeasons(4);
  const dbStatus: Record<string, string> = {};
  for (const comp of competitions) {
    const lastSeason = seasons[seasons.length - 1];
    const lastDate = await db.getLastMatchDate(comp, lastSeason);
    dbStatus[comp] = lastDate ?? 'nessun dato';
  }

  res.json({
    success: true,
    data: {
      competitions,
      top5Competitions: top5,
      suggestedSeasons: seasons,
      dbLastImport: dbStatus,
      importInProgress: understatImportInProgress,
      activeImport: understatActiveImportMeta,
      note: 'Understat resta la fonte primaria per squadre, partite e giocatori. SofaScore completa possesso, falli, corner e arbitro sui match che ne sono privi.',
    },
  });
});

router.post('/scraper/sofascore/supplemental', async (req: Request, res: Response) => {
  req.setTimeout(60 * 60 * 1000);
  res.setTimeout(60 * 60 * 1000);

  const enabled = req.body?.enabled === undefined
    ? SOFASCORE_SUPPLEMENTAL_ENABLED
    : Boolean(req.body?.enabled);
  if (!enabled) {
    return res.status(503).json({
      success: false,
      error: 'Sync supplementare SofaScore disabilitata.',
    });
  }

  const competition = String(req.body?.competition ?? '').trim() || undefined;
  const season = String(req.body?.season ?? '').trim() || undefined;
  const limit = Math.max(
    1,
    Math.min(Number(req.body?.limit ?? SOFASCORE_SUPPLEMENTAL_MAX_MATCHES_PER_RUN) || SOFASCORE_SUPPLEMENTAL_MAX_MATCHES_PER_RUN, 500)
  );
  const onlyMissing = req.body?.onlyMissing === undefined ? true : Boolean(req.body.onlyMissing);

  try {
    const pool = await db.getMatches({ competition, season });
    const filtered = onlyMissing ? pool.filter((row) => needsSofaScoreSupplemental(row)) : pool;
    const selected = rankSofaScoreCandidates(filtered).slice(0, limit);

    if (selected.length === 0) {
      return res.json({
        success: true,
        data: {
          source: 'sofascore_supplemental',
          enabled: true,
          poolMatches: pool.length,
          selectedMatches: 0,
          message: 'Nessun match da completare con SofaScore.',
        },
      });
    }

    const scraper = new SofaScoreSupplementalScraper();
    try {
      const syncSummary = await scraper.applyToDatabase(db, selected);
      const updatedRows = selected.filter((row) => syncSummary.updatedMatchIds.includes(String(row.match_id)));
      const updatedCompletedRows = updatedRows.filter((row) => isCompletedMatchRow(row));
      const teamsRecomputed = updatedCompletedRows.length > 0
        ? await recomputeTeamAveragesForMatchRows(db, updatedCompletedRows)
        : 0;

      return res.json({
        success: true,
        data: {
          source: 'sofascore_supplemental',
          enabled: true,
          competition: competition ?? 'all',
          season: season ?? 'all',
          poolMatches: pool.length,
          selectedMatches: selected.length,
          deferredMatches: Math.max(0, filtered.length - selected.length),
          updatedCompletedMatches: updatedCompletedRows.length,
          teamsRecomputed,
          ...syncSummary,
        },
      });
    } finally {
      await scraper.close().catch(() => undefined);
    }
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

async function runUnderstatImport(req: Request, res: Response) {
  const externalRun = getExternalSchedulerRunMeta(req, 'understat');
  if (understatImportInProgress) {
    await persistExternalSchedulerRun(externalRun, true, {
      alreadyRunning: true,
      inProgress: true,
      message: 'Import Understat gia in corso.',
    }, null);
    return res.status(202).json({
      success: true,
      data: {
        source: 'understat',
        alreadyRunning: true,
        inProgress: true,
        message: 'Import Understat gia in corso. Attendi il completamento prima di lanciare un altro campionato.',
        activeImport: understatActiveImportMeta,
      },
    });
  }

  understatImportInProgress = true;
  try {
    req.setTimeout(60 * 60 * 1000);
    res.setTimeout(60 * 60 * 1000);

    const {
      mode = 'single',
      competition = 'Serie A',
      competitions,
      seasons,
      yearsBack = 1,
      importPlayers = true,
      includeMatchDetails = true,
      forceRefresh = false,
      includeSofaScoreSupplemental: includeSofaScoreSupplementalRaw,
      sofaScoreSupplementalLimit: sofaScoreSupplementalLimitRaw,
    } = req.body ?? {};

    const includeSofaScoreSupplemental = includeSofaScoreSupplementalRaw === undefined
      ? SOFASCORE_SUPPLEMENTAL_ENABLED
      : Boolean(includeSofaScoreSupplementalRaw);
    const sofaScoreSupplementalLimit = Math.max(
      0,
      Math.min(
        Number(
          sofaScoreSupplementalLimitRaw
          ?? SOFASCORE_SUPPLEMENTAL_MAX_MATCHES_PER_RUN
        ) || SOFASCORE_SUPPLEMENTAL_MAX_MATCHES_PER_RUN,
        500
      )
    );

    const competitionsToRun: string[] = mode === 'top5'
      ? UnderstatScraper.getTop5Competitions()
      : Array.isArray(competitions) && competitions.length > 0
        ? competitions
        : [competition];

    const seasonsToScrape: string[] = Array.isArray(seasons) && seasons.length > 0
      ? seasons
      : UnderstatScraper.generateSeasons(yearsBack);

    understatActiveImportMeta = {
      startedAt: new Date().toISOString(),
      mode: String(mode),
      competitions: competitionsToRun,
      seasons: seasonsToScrape,
      includeMatchDetails: Boolean(includeMatchDetails),
      forceRefresh: Boolean(forceRefresh),
      importPlayers: Boolean(importPlayers),
      includeSofaScoreSupplemental,
      sofaScoreSupplementalLimit,
    };

    const hasMissingAdvancedStats = (matchRow: any): boolean => {
      if (!matchRow) return true;
      const fields = [
        'home_xg', 'away_xg',
        'home_shots', 'away_shots',
        'home_shots_on_target', 'away_shots_on_target',
        'home_yellow_cards', 'away_yellow_cards',
      ];
      return fields.some((field) => matchRow[field] === null || matchRow[field] === undefined || matchRow[field] === '');
    };

    const nowTs = Date.now();
    const isFutureMatch = (isoDate: string): boolean => {
      const ts = new Date(String(isoDate ?? '')).getTime();
      return Number.isFinite(ts) && ts > nowTs;
    };

    const toFixtureOnly = (match: any): any => ({
      ...match,
      homeGoals: null,
      awayGoals: null,
      homeXG: null,
      awayXG: null,
      homeTotalShots: null,
      awayTotalShots: null,
      homeShotsOnTarget: null,
      awayShotsOnTarget: null,
      homePossession: null,
      awayPossession: null,
      homeYellowCards: null,
      awayYellowCards: null,
      homeRedCards: null,
      awayRedCards: null,
      homeFouls: null,
      awayFouls: null,
      homeCorners: null,
      awayCorners: null,
      referee: null,
      playerStats: [],
    });

    let totalImported = 0;
    let totalUpdatedExisting = 0;
    let totalSkipped = 0;
    let totalNew = 0;
    let totalUpcomingImported = 0;
    const sofaScoreCandidateMap = new Map<string, any>();
    const competitionActivity: Record<string, {
      playedTouched: number;
      fixturesTouched: number;
      newPlayed: number;
      updatedPlayed: number;
    }> = {};
    const deletedMatchesByCompetition: Record<string, number> = {};

    if (forceRefresh) {
      for (const comp of competitionsToRun) {
        const deleted = await db.deleteMatchesByCompetitionAndSeasons(comp, seasonsToScrape);
        deletedMatchesByCompetition[comp] = deleted;
      }
    }

    let teamsCreated = 0;
    let playersUpdated = 0;
    const seasonSummary: Record<string, any> = {};

    for (const competitionName of competitionsToRun) {
      competitionActivity[competitionName] = competitionActivity[competitionName] ?? {
        playedTouched: 0,
        fixturesTouched: 0,
        newPlayed: 0,
        updatedPlayed: 0,
      };

      const existingTeams = await db.getTeams(competitionName);
      const teamLookup = new Map<string, any>();
      const resolvedTeamCache = new Map<string, any>();
      for (const team of existingTeams) {
        teamLookup.set(canonicalUnderstatTeamName(String(team.name ?? team.team_id)), team);
      }

      const resolveInternalTeam = async (sourceTeamId: string, teamName: string, shortName?: string | null): Promise<any> => {
        const canonical = canonicalUnderstatTeamName(teamName);
        const cacheKey = `${sourceTeamId}:${canonical}`;
        const cached = resolvedTeamCache.get(cacheKey);
        if (cached) return cached;
        let existingTeam = teamLookup.get(canonical);
        if (!existingTeam) {
          const partialMatches = Array.from(teamLookup.entries()).filter(([key]) =>
            canonical.length >= 6 && (key.includes(canonical) || canonical.includes(key))
          );
          if (partialMatches.length === 1) existingTeam = partialMatches[0][1];
        }

        if (existingTeam) {
          const needsRefresh =
            Number(existingTeam.source_team_id ?? existingTeam.sourceTeamId ?? 0) !== Number(sourceTeamId)
            || !existingTeam.short_name;
          if (needsRefresh) {
            await db.upsertTeam({
              teamId: existingTeam.team_id,
              name: existingTeam.name ?? teamName,
              shortName: existingTeam.short_name ?? shortName ?? null,
              competition: competitionName,
              sourceTeamId: Number(sourceTeamId),
              teamStatsJson: existingTeam.team_stats_json ?? JSON.stringify({ source: 'understat', competition: competitionName }),
            });
            existingTeam = (await db.getTeam(String(existingTeam.team_id))) ?? existingTeam;
          }
          resolvedTeamCache.set(cacheKey, existingTeam);
          teamLookup.set(canonical, existingTeam);
          return existingTeam;
        }

        const createdTeamId = `understat_team_${sourceTeamId}`;
        await db.upsertTeam({
          teamId: createdTeamId,
          name: teamName,
          shortName: shortName ?? null,
          competition: competitionName,
          sourceTeamId: Number(sourceTeamId),
          teamStatsJson: JSON.stringify({ source: 'understat', competition: competitionName }),
        });
        const created = await db.getTeam(createdTeamId);
        if (created) {
          teamLookup.set(canonical, created);
          resolvedTeamCache.set(cacheKey, created);
          teamsCreated++;
        }
        return created;
      };

      for (const season of seasonsToScrape) {
        const lastDateInDb = await db.getLastMatchDate(competitionName, season);
        let allMatches: any[] = [];
        try {
          allMatches = await understat.scrapeSeason(competitionName, season, {
            includeDetails: Boolean(importPlayers) || includeMatchDetails !== false,
            detailConcurrency: UNDERSTAT_DETAIL_CONCURRENCY,
          });
        } catch (seasonError: any) {
          seasonSummary[`${competitionName} ${season}`] = {
            lastDateBefore: lastDateInDb ?? 'nessuna',
            totalOnSource: 0,
            newImported: 0,
            updatedExisting: 0,
            newImportedPlayed: 0,
            newImportedUpcoming: 0,
            touchedTotal: 0,
            skipped: 0,
            playersUpserted: 0,
            error: seasonError?.message ?? 'errore scraping stagione',
          };
          continue;
        }

        const matchesToImport: typeof allMatches = [];
        const existingMatchCache = new Map<string, any>();
        for (const m of allMatches) {
          const futureFixture = isFutureMatch(m.date);
          const isPlayed = m.homeGoals !== null && m.awayGoals !== null;
          const normalizedMatch = futureFixture ? toFixtureOnly(m) : m;
          const existing = await db.getMatchById(m.matchId);
          existingMatchCache.set(m.matchId, existing ?? null);
          if (forceRefresh || !existing) {
            matchesToImport.push(normalizedMatch);
            continue;
          }
          if (futureFixture || !isPlayed) {
            matchesToImport.push(normalizedMatch);
            continue;
          }
          if (includeMatchDetails !== false && hasMissingAdvancedStats(existing)) {
            matchesToImport.push(normalizedMatch);
            continue;
          }
          if (lastDateInDb && m.date.substring(0, 10) <= lastDateInDb) continue;
          matchesToImport.push(normalizedMatch);
        }

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
        const teamShotTotals = new Map<string, number>();

        let imported = 0;
        let updatedExisting = 0;
        let updatedExistingPlayed = 0;
        let updatedExistingUpcoming = 0;
        let importedPlayed = 0;
        let importedUpcoming = 0;
        let skipped = 0;

        for (const match of matchesToImport) {
          const homeTeam = await resolveInternalTeam(String(match.homeTeamId), String(match.homeTeamName), null);
          const awayTeam = await resolveInternalTeam(String(match.awayTeamId), String(match.awayTeamName), null);
          if (!homeTeam || !awayTeam) {
            skipped++;
            continue;
          }

          const futureFixture = isFutureMatch(match.date);
          const isPlayed = match.homeGoals !== null && match.awayGoals !== null;
          const internalizedMatch = {
            ...match,
            homeTeamId: String(homeTeam.team_id),
            awayTeamId: String(awayTeam.team_id),
            playerStats: Array.isArray(match.playerStats)
              ? match.playerStats.map((player: any) => ({
                  ...player,
                  teamId: String(player.teamId) === String(match.homeTeamId)
                    ? String(homeTeam.team_id)
                    : String(awayTeam.team_id),
                }))
              : [],
          };

          try {
            const existingRow = existingMatchCache.get(internalizedMatch.matchId);
            const existedBefore = Boolean(existingRow);
            await db.upsertMatch(understat.toDbFormat(futureFixture ? toFixtureOnly(internalizedMatch) : internalizedMatch));
            if (existedBefore) {
              updatedExisting++;
              if (isPlayed) updatedExistingPlayed++;
              else updatedExistingUpcoming++;
            } else {
              imported++;
              if (isPlayed) importedPlayed++;
              else importedUpcoming++;
            }

            if (includeSofaScoreSupplemental && sofaScoreSupplementalLimit > 0) {
              const sofaScoreCandidate = {
                match_id: String(internalizedMatch.matchId),
                home_team_id: String(homeTeam.team_id),
                away_team_id: String(awayTeam.team_id),
                home_team_name: String(internalizedMatch.homeTeamName ?? homeTeam.name ?? ''),
                away_team_name: String(internalizedMatch.awayTeamName ?? awayTeam.name ?? ''),
                date: String(internalizedMatch.date),
                home_goals: futureFixture ? null : internalizedMatch.homeGoals ?? null,
                away_goals: futureFixture ? null : internalizedMatch.awayGoals ?? null,
                home_possession: existingRow?.home_possession ?? null,
                away_possession: existingRow?.away_possession ?? null,
                home_fouls: existingRow?.home_fouls ?? null,
                away_fouls: existingRow?.away_fouls ?? null,
                home_corners: existingRow?.home_corners ?? null,
                away_corners: existingRow?.away_corners ?? null,
                referee: existingRow?.referee ?? null,
                competition: competitionName,
                season,
                source: 'understat',
                source_match_id: internalizedMatch.sourceMatchId ?? existingRow?.source_match_id ?? null,
              };
              if (needsSofaScoreSupplemental(sofaScoreCandidate)) {
                sofaScoreCandidateMap.set(String(sofaScoreCandidate.match_id), sofaScoreCandidate);
              }
            }

            if (importPlayers && isPlayed && !futureFixture) {
              for (const player of internalizedMatch.playerStats) {
                const agg = playersAgg.get(player.playerId) ?? {
                  playerId: player.playerId,
                  sourcePlayerId: player.sourcePlayerId,
                  name: player.playerName,
                  teamId: player.teamId,
                  games: new Set<string>(),
                  shots: 0,
                  shotsOnTarget: 0,
                  goals: 0,
                  xg: 0,
                  xgot: 0,
                  rawSamples: [],
                };
                agg.games.add(internalizedMatch.matchId);
                agg.shots += player.shots;
                agg.shotsOnTarget += player.shotsOnTarget;
                agg.goals += player.goals;
                agg.xg += player.xg;
                agg.xgot += player.xgot;
                agg.rawSamples.push(player.raw);
                playersAgg.set(player.playerId, agg);
                teamShotTotals.set(player.teamId, Number(teamShotTotals.get(player.teamId) ?? 0) + Number(player.shots ?? 0));
              }
            }
          } catch {
            skipped++;
          }
        }

        for (const [, player] of playersAgg) {
          const games = Math.max(1, player.games.size);
          const teamShots = Math.max(1, Number(teamShotTotals.get(player.teamId) ?? 0));
          await db.upsertPlayer({
            playerId: player.playerId,
            sourcePlayerId: player.sourcePlayerId,
            name: player.name,
            teamId: player.teamId,
            positionCode: 'MF',
            avgShotsPerGame: player.shots / games,
            avgShotsOnTargetPerGame: player.shotsOnTarget / games,
            avgXGPerGame: player.xg / games,
            avgXGOTPerGame: player.xgot / games,
            totalGoals: player.goals,
            totalShots: player.shots,
            totalShotsOnTarget: player.shotsOnTarget,
            shotShareOfTeam: player.shots / teamShots,
            gamesPlayed: games,
            statsJson: JSON.stringify({
              source: 'understat',
              season,
              competition: competitionName,
              totalXG: player.xg,
              totalXGOT: player.xgot,
              rawSamples: player.rawSamples.slice(0, 8),
            }),
          });
          playersUpdated++;
        }

        totalImported += imported;
        totalUpdatedExisting += updatedExisting;
        totalSkipped += skipped;
        totalNew += imported;
        totalUpcomingImported += importedUpcoming;
        competitionActivity[competitionName].playedTouched += importedPlayed + updatedExistingPlayed;
        competitionActivity[competitionName].fixturesTouched += importedUpcoming + updatedExistingUpcoming;
        competitionActivity[competitionName].newPlayed += importedPlayed;
        competitionActivity[competitionName].updatedPlayed += updatedExistingPlayed;

        seasonSummary[`${competitionName} ${season}`] = {
          lastDateBefore: lastDateInDb ?? 'nessuna',
          totalOnSource: allMatches.length,
          newImported: imported,
          updatedExisting,
          newImportedPlayed: importedPlayed,
          updatedExistingPlayed,
          newImportedUpcoming: importedUpcoming,
          updatedExistingUpcoming,
          touchedTotal: matchesToImport.length,
          skipped,
          playersUpserted: playersAgg.size,
        };
      }
    }

    const sofaScoreCandidatePool = includeSofaScoreSupplemental
      ? rankSofaScoreCandidates(Array.from(sofaScoreCandidateMap.values()))
      : [];
    let sofaScoreSupplemental: {
      enabled: boolean;
      candidateMatches: number;
      selectedMatches: number;
      deferredMatches: number;
      considered: number;
      matchedEvents: number;
      updatedMatches: number;
      updatedCompletedMatches: number;
      updatedReferees: number;
      skippedNoEvent: number;
      skippedNoStats: number;
      errors: number;
      errorSamples: string[];
      message: string;
    } = {
      enabled: includeSofaScoreSupplemental,
      candidateMatches: sofaScoreCandidatePool.length,
      selectedMatches: 0,
      deferredMatches: 0,
      considered: 0,
      matchedEvents: 0,
      updatedMatches: 0,
      updatedCompletedMatches: 0,
      updatedReferees: 0,
      skippedNoEvent: 0,
      skippedNoStats: 0,
      errors: 0,
      errorSamples: [],
      message: includeSofaScoreSupplemental
        ? 'Supplementazione SofaScore in attesa.'
        : 'Supplementazione SofaScore disabilitata.',
    };
    let sofaScoreUpdatedCompletedRows: any[] = [];

    if (includeSofaScoreSupplemental && sofaScoreSupplementalLimit > 0 && sofaScoreCandidatePool.length > 0) {
      const selectedSofaScoreRows = sofaScoreCandidatePool.slice(0, sofaScoreSupplementalLimit);
      const sofaScoreScraper = new SofaScoreSupplementalScraper();
      sofaScoreSupplemental.selectedMatches = selectedSofaScoreRows.length;
      sofaScoreSupplemental.deferredMatches = Math.max(0, sofaScoreCandidatePool.length - selectedSofaScoreRows.length);
      try {
        const syncSummary = await sofaScoreScraper.applyToDatabase(db, selectedSofaScoreRows);
        const updatedRows = selectedSofaScoreRows.filter((row) => syncSummary.updatedMatchIds.includes(String(row.match_id)));
        sofaScoreUpdatedCompletedRows = updatedRows.filter((row) => isCompletedMatchRow(row));
        sofaScoreSupplemental = {
          ...sofaScoreSupplemental,
          considered: syncSummary.considered,
          matchedEvents: syncSummary.matchedEvents,
          updatedMatches: syncSummary.updatedMatches,
          updatedCompletedMatches: sofaScoreUpdatedCompletedRows.length,
          updatedReferees: syncSummary.updatedReferees,
          skippedNoEvent: syncSummary.skippedNoEvent,
          skippedNoStats: syncSummary.skippedNoStats,
          errors: syncSummary.errors,
          errorSamples: syncSummary.errorSamples,
          message: syncSummary.updatedMatches > 0
            ? `SofaScore ha completato ${syncSummary.updatedMatches} match e aggiornato ${syncSummary.updatedReferees} arbitri.`
            : 'SofaScore non ha trovato nuovi campi da completare nei match selezionati.',
        };
      } catch (sofaScoreError: any) {
        console.warn('[sofascore] Supplementazione post-Understat non riuscita:', sofaScoreError?.message ?? sofaScoreError);
        sofaScoreSupplemental = {
          ...sofaScoreSupplemental,
          errors: 1,
          errorSamples: [sofaScoreError?.message ?? 'errore sconosciuto'],
          message: 'Import Understat completato, ma la supplementazione SofaScore non e riuscita.',
        };
      } finally {
        await sofaScoreScraper.close().catch(() => undefined);
      }
    } else if (includeSofaScoreSupplemental && sofaScoreCandidatePool.length === 0) {
      sofaScoreSupplemental.message = 'Nessun match della sessione richiede completamento da SofaScore.';
    }

    const competitionsNeedingPostProcessing = Array.from(
      new Set([
        ...competitionsToRun.filter((comp) =>
          forceRefresh || (competitionActivity[comp]?.playedTouched ?? 0) > 0
        ),
        ...sofaScoreUpdatedCompletedRows
          .map((row) => String(row?.competition ?? '').trim())
          .filter(Boolean),
      ])
    );

    let teamsRecomputed = 0;
    let playersMarkedUnavailable = 0;
    let playersDerivedDetected = 0;
    let playersDerivedUpdated = 0;
    let playersDerivedMatches = 0;
    let playerMatchesWithShotmap = 0;
    let refereesDerivedDetected = 0;
    let refereesDerivedUpdated = 0;
    let refereeMatchesConsidered = 0;
    for (const comp of competitionsNeedingPostProcessing) {
      const teams = await db.getTeams(comp);
      for (const team of teams) {
        await db.recomputeTeamAverages(team.team_id);
        teamsRecomputed++;
      }
      const playerStats = await rebuildPlayerDerivedStats(db, { competition: comp });
      playersMarkedUnavailable += playerStats.playersMarkedUnavailable;
      playersDerivedDetected += playerStats.playersDetected;
      playersDerivedUpdated += playerStats.playersUpdated;
      playersDerivedMatches += playerStats.playedMatchesConsidered;
      playerMatchesWithShotmap += playerStats.matchesWithShotmap;

      const refereeStats = await rebuildRefereeDerivedStats(db, { competition: comp });
      refereesDerivedDetected += refereeStats.refereesDetected;
      refereesDerivedUpdated += refereeStats.refereesUpdated;
      refereeMatchesConsidered += refereeStats.matchesConsidered;
    }

    const now = new Date();
    const currentSeasonStartYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    const currentSeason = `${currentSeasonStartYear}/${currentSeasonStartYear + 1}`;
    const trainingWindowFor = (completedCurrentSeasonMatches: number): {
      bucket: '<8' | '8-15' | '>15';
      fromDate: string;
      reason: string;
      label: string;
    } => {
      if (completedCurrentSeasonMatches < 8) {
        return {
          bucket: '<8',
          fromDate: `${currentSeasonStartYear - 1}-07-01`,
          label: 'Stagione corrente + intera stagione precedente',
          reason: 'Troppo pochi dati, serve stabilita massima',
        };
      }
      if (completedCurrentSeasonMatches <= 15) {
        return {
          bucket: '8-15',
          fromDate: `${currentSeasonStartYear}-01-01`,
          label: 'Stagione corrente + ultimi 6 mesi stagione precedente',
          reason: 'Segnale parziale, si bilancia con passato recente',
        };
      }
      return {
        bucket: '>15',
        fromDate: `${currentSeasonStartYear}-07-01`,
        label: 'Solo stagione corrente',
        reason: 'Massa critica raggiunta, passato e rumore',
      };
    };

    const autoModelFit: Record<string, {
      ok: boolean;
      thresholdBucket?: '<8' | '8-15' | '>15';
      completedCurrentSeasonMatches?: number;
      trainingWindow?: string;
      reason?: string;
      fromDate?: string;
      toDate?: string;
      matchesUsed?: number;
      teams?: number;
      skipped?: boolean;
      error?: string;
    }> = {};

    for (const comp of competitionsToRun) {
      if (!competitionsNeedingPostProcessing.includes(comp)) {
        autoModelFit[comp] = {
          ok: true,
          skipped: true,
          reason: 'Nessuna nuova partita giocata importata o aggiornata: refit modello saltato.',
        };
        continue;
      }
      try {
        const currentSeasonRows = await db.getMatches({ competition: comp, season: currentSeason });
        const completedCurrentSeasonMatches = currentSeasonRows.filter(
          (m: any) => m.home_goals !== null && m.away_goals !== null
        ).length;
        const tw = trainingWindowFor(completedCurrentSeasonMatches);
        const toDate = now.toISOString();
        const fit = await svc.fitModelForCompetition(comp, undefined, tw.fromDate, toDate);
        autoModelFit[comp] = {
          ok: true,
          thresholdBucket: tw.bucket,
          completedCurrentSeasonMatches,
          trainingWindow: tw.label,
          reason: tw.reason,
          fromDate: tw.fromDate,
          toDate,
          matchesUsed: fit.matchesUsed,
          teams: fit.teams,
        };
      } catch (e: any) {
        autoModelFit[comp] = { ok: false, error: e?.message ?? 'fit non disponibile' };
      }
    }

    const lastSeason = seasonsToScrape[seasonsToScrape.length - 1];
    const lastDatesAfter: Record<string, string> = {};
    for (const comp of competitionsToRun) {
      lastDatesAfter[comp] = (await db.getLastMatchDate(comp, lastSeason)) ?? 'nessuna';
    }

    const responsePayload = {
      success: true,
      data: {
        source: 'understat',
        mode,
        competitions: competitionsToRun,
        seasons: seasonsToScrape,
        newMatchesImported: totalImported,
        existingMatchesUpdated: totalUpdatedExisting,
        upcomingMatchesImported: totalUpcomingImported,
        skipped: totalSkipped,
        teamsCreated,
        playersUpdated,
        teamsRecomputed,
        playersMarkedUnavailable,
        playersDerivedDetected,
        playersDerivedUpdated,
        playersDerivedMatches,
        playerMatchesWithShotmap,
        refereesDerivedDetected,
        refereesDerivedUpdated,
        refereeMatchesConsidered,
        sofaScoreSupplemental,
        deletedMatchesByCompetition,
        autoModelFit,
        postProcessingCompetitions: competitionsNeedingPostProcessing,
        skippedPostProcessingCompetitions: competitionsToRun.filter((comp) => !competitionsNeedingPostProcessing.includes(comp)),
        dbLastDateAfter: lastDatesAfter,
        isUpToDate: totalNew === 0,
        forceRefresh,
        message: totalNew === 0
          ? `DB gia aggiornato da Understat. ${sofaScoreSupplemental.message}`
          : `Importate ${totalImported} partite Understat (${totalUpcomingImported} future), aggiornati ${playersUpdated} giocatori. ${sofaScoreSupplemental.message}`,
        seasonDetail: seasonSummary,
      },
    };
    await persistExternalSchedulerRun(externalRun, true, responsePayload.data, null);
    return res.json(responsePayload);
  } catch (e: any) {
    console.error('[understat] Errore:', e.message);
    await persistExternalSchedulerRun(externalRun, false, null, e.message);
    return res.status(500).json({ success: false, error: e.message });
  } finally {
    understatImportInProgress = false;
    understatActiveImportMeta = null;
    await understat.close().catch(() => undefined);
  }
}

router.post('/scraper/understat', runUnderstatImport);

type OddsMatchSummary = {
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
};

type OddsRuntimeState = {
  competition: string;
  markets: string[];
  matchesFound: number;
  matches: OddsMatchSummary[];
  primaryProvider: string;
  activeProvider: string | null;
  remainingRequests: number | null;
  lastUpdatedAt: string | null;
  fetchedAt: string | null;
  oddsSource: string | null;
  fallbackReason: string | null;
  providerHealth: Record<string, any>;
  isMerged: boolean;
  freshnessMinutes: number | null;
  warningCount: number;
  errorCategory: string | null;
  lastDurationMs: number | null;
};

const matchOddsCache = new Map<string, { cachedAt: number; data: any }>();
const matchOddsInFlight = new Map<string, Promise<any>>();
const DEFAULT_MATCH_ODDS_CACHE_TTL_MS = 3 * 60 * 1000;

const parsePositiveIntEnv = (name: string, fallback: number): number => {
  const raw = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

const getMatchOddsCacheTtlMs = (): number =>
  parsePositiveIntEnv('ODDS_MATCH_CACHE_TTL_SECONDS', Math.floor(DEFAULT_MATCH_ODDS_CACHE_TTL_MS / 1000)) * 1000;

const normalizeMatchOddsCachePart = (value: string): string =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const buildMatchOddsCacheKey = (input: {
  matchId?: string | null;
  competition?: string | null;
  homeTeam: string;
  awayTeam: string;
  commenceTime?: string | null;
}): string => [
  normalizeMatchOddsCachePart(String(input.matchId ?? '')),
  normalizeMatchOddsCachePart(String(input.competition ?? '')),
  normalizeMatchOddsCachePart(input.homeTeam),
  normalizeMatchOddsCachePart(input.awayTeam),
  normalizeMatchOddsCachePart(String(input.commenceTime ?? '')),
].join('::');

const getCachedMatchOddsPayload = (cacheKey: string): any | null => {
  const cached = matchOddsCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt >= getMatchOddsCacheTtlMs()) {
    matchOddsCache.delete(cacheKey);
    return null;
  }
  return cached.data;
};

const setCachedMatchOddsPayload = (cacheKey: string, data: any): void => {
  matchOddsCache.set(cacheKey, {
    cachedAt: Date.now(),
    data,
  });
};

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

let oddsRuntimeState: OddsRuntimeState = {
  competition: 'Serie A',
  markets: ['h2h', 'totals', 'spreads', 'alternate_totals', 'btts', 'double_chance', 'draw_no_bet'],
  matchesFound: 0,
  matches: [],
  primaryProvider: getConfiguredPrimaryProviderName(),
  activeProvider: null,
  remainingRequests: null,
  lastUpdatedAt: null,
  fetchedAt: null,
  oddsSource: null,
  fallbackReason: null,
  providerHealth: {},
  isMerged: false,
  freshnessMinutes: null,
  warningCount: 0,
  errorCategory: null,
  lastDurationMs: null,
};

const toOddsSummary = (matches: OddsMatch[]): OddsMatchSummary[] =>
  matches.map((m) => ({
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    commenceTime: m.commenceTime,
  }));

const minutesSince = (value?: string | null): number | null => {
  if (!value) return null;
  const timestamp = Date.parse(String(value));
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.round((Date.now() - timestamp) / 60000));
};

const countMatchMarkets = (match: OddsMatch | null | undefined): number => {
  if (!match) return 0;
  return (match.bookmakers ?? []).reduce((total, bookmaker) => total + (bookmaker.markets ?? []).length, 0);
};

const detectProviderErrorCategory = (
  providerHealth: Record<string, any>,
  warnings: string[],
  fallbackReason?: string | null
): string | null => {
  const haystack = [
    ...warnings,
    String(fallbackReason ?? ''),
    ...Object.values(providerHealth).map((provider: any) => String(provider?.message ?? '')),
  ]
    .join(' | ')
    .toLowerCase();

  if (!haystack) return null;
  if (haystack.includes('resolve_meeting_alias_failed')) return 'resolve_meeting_alias_failed';
  if (haystack.includes('meeting_json_failed')) return 'meeting_json_failed';
  if (haystack.includes('non_json_response')) return 'non_json_response';
  if (haystack.includes('html_or_captcha') || haystack.includes('captcha') || haystack.includes('cloudflare')) return 'html_or_captcha';
  if (haystack.includes('cookie_or_spa_dom_issue')) return 'cookie_or_spa_dom_issue';
  if (haystack.includes('parsing_zero_markets')) return 'parsing_zero_markets';
  if (haystack.includes('fixture_matching_failed')) return 'fixture_matching_failed';
  if (haystack.includes('extended_groups_failed')) return 'extended_groups_failed';
  if (haystack.includes('timeout')) return 'timeout';
  return null;
};

const countMatchesWithBaseOdds = (matches: CoordinatedOddsMatch[]): number =>
  matches.filter((entry) =>
    Object.values(entry.bestOddsByProvider ?? {}).some((odds) => Object.keys(odds ?? {}).length > 0)
  ).length;

const countMatchesWithExtendedGroups = (_matches: CoordinatedOddsMatch[]): number => 0;

const normalizeTeamForOdds = (name: string): string => {
  const aliases: Record<string, string> = {
    'inter milan': 'inter',
    'ac milan': 'milan',
    'hellas verona': 'verona',
    'ssc napoli': 'napoli',
    'ss lazio': 'lazio',
  };

  const cleaned = String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(fc|ac|as|ss|ssc|calcio|club)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return aliases[cleaned] ?? cleaned;
};

const teamSimilarity = (a: string, b: string): number => {
  const na = normalizeTeamForOdds(a);
  const nb = normalizeTeamForOdds(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.86;

  const at = new Set(na.split(' ').filter(Boolean));
  const bt = new Set(nb.split(' ').filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;

  let inter = 0;
  for (const t of at) if (bt.has(t)) inter++;
  return inter / Math.max(at.size, bt.size);
};

const matchScore = (candidate: OddsMatch, homeTeam: string, awayTeam: string, commenceTime?: string): number => {
  const straight = teamSimilarity(homeTeam, candidate.homeTeam) + teamSimilarity(awayTeam, candidate.awayTeam);
  const swapped = teamSimilarity(homeTeam, candidate.awayTeam) + teamSimilarity(awayTeam, candidate.homeTeam);
  let score = Math.max(straight, swapped);

  if (commenceTime) {
    const targetTs = new Date(commenceTime).getTime();
    const candTs = new Date(candidate.commenceTime).getTime();
    if (!Number.isNaN(targetTs) && !Number.isNaN(candTs)) {
      const diffHours = Math.abs(targetTs - candTs) / (1000 * 60 * 60);
      if (diffHours <= 1.5) score += 0.5;
      else if (diffHours <= 4) score += 0.25;
      else if (diffHours <= 12) score += 0.1;
    }
  }

  return score;
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

const probabilityToOdds = (probability: number, overround = 0.06): number => {
  const p = clamp(Number(probability) || 0, 0.02, 0.96);
  const implied = clamp(p * (1 + overround), 0.02, 0.985);
  return Number((1 / implied).toFixed(2));
};

const sanitizeOddsMap = (input: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!Number.isFinite(v) || v <= 1.01 || v > 100) continue;
    out[k] = Number(v.toFixed(2));
  }
  return out;
};

const shouldCacheMatchOddsPayload = (payload: any): boolean => {
  if (payload?.found !== true) return false;
  if (payload?.source === 'unavailable' || payload?.oddsSource === 'unavailable') return false;
  return Object.keys(sanitizeOddsMap(payload?.selectedOdds ?? {})).length > 0;
};

const hasKickoffMismatchDiagnostic = (coordination: any): boolean => {
  const runtimeDetails = coordination?.providerRuntime?.odds_api?.fetchDetails ?? {};
  const fixtureDiagnostics = Array.isArray(runtimeDetails.fixtureDiagnostics)
    ? runtimeDetails.fixtureDiagnostics
    : [];
  const warnings = [
    ...(Array.isArray(coordination?.warnings) ? coordination.warnings : []),
    ...fixtureDiagnostics.flatMap((diagnostic: any) => Array.isArray(diagnostic?.warnings) ? diagnostic.warnings : []),
  ].map((warning: unknown) => String(warning));
  if (warnings.some((warning) => warning.includes('missing_commence_time_for_fixture_matching'))) return false;

  return fixtureDiagnostics.some((diagnostic: any) => {
    const candidates = Array.isArray(diagnostic?.candidates) ? diagnostic.candidates : [];
    return candidates.some((candidate: any) => {
      const reason = String(candidate?.reason ?? '');
      const straightTeamScore = Number(candidate?.straightTeamScore ?? 0);
      const timeDiffHours = Number(candidate?.timeDiffHours ?? 0);
      return reason === 'kickoff_outside_36h_window'
        || (straightTeamScore >= 1.75 && Number.isFinite(timeDiffHours) && timeDiffHours > 36);
    });
  });
};

const flattenProviderComparisons = (
  input: Record<string, Record<string, Record<string, number>>>
): Record<string, Record<string, number>> =>
  Object.values(input ?? {}).reduce((acc, comparison) => ({ ...acc, ...comparison }), {});

const flattenProviderMargins = (
  input: Record<string, Record<string, string>>
): Record<string, string> =>
  Object.values(input ?? {}).reduce((acc, margins) => ({ ...acc, ...margins }), {});

const summarizeOddsCoverage = (
  liveSelectedOdds: Record<string, number>,
  providerOdds: Record<string, number>,
  estimatedOdds: Record<string, number>
): {
  providerOddsPresent: boolean;
  liveDomains: Record<string, number>;
  providerDomains: Record<string, number>;
  syntheticDomains: Record<string, number>;
  providerNotes: string[];
} => {
  const domainMatchers: Array<{ key: string; test: (selection: string) => boolean }> = [
    { key: 'h2h', test: (selection) => ['homeWin', 'draw', 'awayWin'].includes(selection) },
    { key: 'goals', test: (selection) => /^(over|under)\d+/.test(selection) || /^(team_(home|away)_(over|under)_|btts|bttsNo|dnb_|double_chance_)/.test(selection) },
    { key: 'corners', test: (selection) => /^corners_/.test(selection) },
    { key: 'cards', test: (selection) => /^(yellow_|cards_total_)/.test(selection) },
    { key: 'shots', test: (selection) => /^(shots_total_|shots_home_|shots_away_|sot_total_)/.test(selection) },
    { key: 'fouls', test: (selection) => /^fouls_/.test(selection) },
  ];

  const countDomains = (oddsMap: Record<string, number>): Record<string, number> =>
    domainMatchers.reduce((acc, domain) => {
      acc[domain.key] = Object.keys(oddsMap ?? {}).filter((selection) => domain.test(selection)).length;
      return acc;
    }, {} as Record<string, number>);

  return {
    providerOddsPresent: Object.keys(providerOdds ?? {}).length > 0,
    liveDomains: countDomains(liveSelectedOdds),
    providerDomains: countDomains(providerOdds),
    syntheticDomains: countDomains(estimatedOdds),
    providerNotes: [
      'La copertura dei mercati dipende dal provider configurato e dal singolo evento.',
      'I mercati extra possono non essere disponibili per tutte le competizioni o tutti i bookmaker.',
    ],
  };
};

const buildOddsSnapshotId = (matchId?: string | null, oddsProviderMatchId?: string | null): string => {
  const seed = String(matchId ?? oddsProviderMatchId ?? 'match')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .slice(0, 48);
  return `odds_snapshot_${seed}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const persistOddsSnapshot = async (input: {
  matchId?: string | null;
  oddsProviderMatchId?: string | null;
  competition?: string | null;
  homeTeamName: string;
  awayTeamName: string;
  commenceTime?: string | null;
  source: string;
  selectedOdds?: Record<string, number>;
  liveSelectedOdds?: Record<string, number>;
  legacyOdds?: Record<string, number>;
  estimatedOdds?: Record<string, number>;
  fallbackOdds?: Record<string, number>;
  allBookmakerOdds?: Record<string, Record<string, number>>;
  marketsRequested?: string[];
  usedFallbackBookmaker?: boolean;
  usedSyntheticOdds?: boolean;
  confidenceScore?: number;
}): Promise<{ saved: boolean; matchId: string | null }> => {
  const liveSelectedOdds = sanitizeOddsMap(input.liveSelectedOdds ?? {});
  const legacyOdds = sanitizeOddsMap(input.legacyOdds ?? {});
  if (Object.keys(liveSelectedOdds).length === 0 && Object.keys(legacyOdds).length === 0) {
    return { saved: false, matchId: null };
  }

  let resolvedMatchId = String(input.matchId ?? '').trim() || null;
  if (!resolvedMatchId) {
    const match = await db.findMatchByTeams(
      input.homeTeamName,
      input.awayTeamName,
      input.competition ?? undefined,
      input.commenceTime ?? undefined
    );
    resolvedMatchId = match?.match_id ? String(match.match_id) : null;
  }

  await db.saveOddsSnapshot({
    snapshotId: buildOddsSnapshotId(resolvedMatchId, input.oddsProviderMatchId),
    matchId: resolvedMatchId,
    oddsProviderMatchId: input.oddsProviderMatchId ?? null,
    competition: input.competition ?? null,
    homeTeamName: input.homeTeamName,
    awayTeamName: input.awayTeamName,
    commenceTime: input.commenceTime ?? null,
    source: input.source,
    selectedOdds: sanitizeOddsMap(input.selectedOdds ?? {}),
    liveSelectedOdds,
    eurobetOdds: legacyOdds,
    estimatedOdds: sanitizeOddsMap(input.estimatedOdds ?? {}),
    fallbackOdds: sanitizeOddsMap(input.fallbackOdds ?? {}),
    allBookmakerOdds: input.allBookmakerOdds ?? {},
    marketsRequested: Array.isArray(input.marketsRequested) ? input.marketsRequested : [],
    usedFallbackBookmaker: Boolean(input.usedFallbackBookmaker),
    usedSyntheticOdds: Boolean(input.usedSyntheticOdds),
    confidenceScore: Number.isFinite(Number(input.confidenceScore)) ? Number(input.confidenceScore) : null,
  });

  return { saved: true, matchId: resolvedMatchId };
};

const collectModelProbabilitiesForOdds = (prediction: any): Record<string, number> => {
  const probs: any = prediction?.probabilities ?? {};
  const out: Record<string, number> = {};

  const push = (key: string, value: unknown) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && n < 1) out[key] = n;
  };

  // Goal mercati principali
  push('homeWin', probs.homeWin);
  push('draw', probs.draw);
  push('awayWin', probs.awayWin);
  push('btts', probs.btts);
  push('bttsNo', 1 - Number(probs.btts ?? 0));
  push('double_chance_1x', Number(probs.homeWin ?? 0) + Number(probs.draw ?? 0));
  push('double_chance_x2', Number(probs.draw ?? 0) + Number(probs.awayWin ?? 0));
  push('double_chance_12', Number(probs.homeWin ?? 0) + Number(probs.awayWin ?? 0));
  const dnbDen = Math.max(1e-6, Number(probs.homeWin ?? 0) + Number(probs.awayWin ?? 0));
  push('dnb_home', Number(probs.homeWin ?? 0) / dnbDen);
  push('dnb_away', Number(probs.awayWin ?? 0) / dnbDen);

  const goalLines = [0.5, 1.5, 2.5, 3.5, 4.5];
  for (const line of goalLines) {
    const k = String(line).replace('.', '');
    push(`over${k}`, (probs as any)[`over${k}`]);
    push(`under${k}`, (probs as any)[`under${k}`]);
  }
  const lambdaHomeGoals = Math.max(0.1, Number(probs.lambdaHome ?? 0));
  const lambdaAwayGoals = Math.max(0.1, Number(probs.lambdaAway ?? 0));
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
    const k = line.toFixed(1).replace('.', '');
    const overHome = poissonOver(line, lambdaHomeGoals);
    const overAway = poissonOver(line, lambdaAwayGoals);
    push(`team_home_over_${k}`, overHome);
    push(`team_home_under_${k}`, 1 - overHome);
    push(`team_away_over_${k}`, overAway);
    push(`team_away_under_${k}`, 1 - overAway);
  }

  // Tiri totali/squadra
  for (const [line, pair] of Object.entries(probs.shotsTotal ?? {})) {
    push(`shots_total_over_${line}`, (pair as any)?.over);
    push(`shots_total_under_${line}`, (pair as any)?.under);
  }
  for (const [line, pair] of Object.entries(probs.shotsHome?.overUnder ?? {})) {
    push(`shots_home_over_${line}`, (pair as any)?.over);
    push(`shots_home_under_${line}`, (pair as any)?.under);
  }
  for (const [line, pair] of Object.entries(probs.shotsAway?.overUnder ?? {})) {
    push(`shots_away_over_${line}`, (pair as any)?.over);
    push(`shots_away_under_${line}`, (pair as any)?.under);
  }
  for (const [line, pair] of Object.entries(probs.corners?.overUnder ?? {})) {
    push(`corners_over_${line}`, (pair as any)?.over);
    push(`corners_under_${line}`, (pair as any)?.under);
  }

  // Cartellini e falli
  for (const [line, pair] of Object.entries(probs.cards?.overUnderYellow ?? {})) {
    push(`yellow_over_${line}`, (pair as any)?.over);
    push(`yellow_under_${line}`, (pair as any)?.under);
  }
  for (const [line, pair] of Object.entries(probs.cards?.overUnderTotal ?? {})) {
    push(`cards_total_over_${line}`, (pair as any)?.over);
    push(`cards_total_under_${line}`, (pair as any)?.under);
  }
  for (const [line, pair] of Object.entries(probs.fouls?.overUnder ?? {})) {
    push(`fouls_over_${line}`, (pair as any)?.over);
    push(`fouls_under_${line}`, (pair as any)?.under);
  }

  // Tiri in porta combinati (Poisson sui lambda in porta)
  const combinedSOTExp = Number(probs.shotsOnTargetHome?.expected ?? 0) + Number(probs.shotsOnTargetAway?.expected ?? 0);
  for (const line of [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5]) {
    const key = line.toFixed(1);
    const over = poissonOver(line, combinedSOTExp);
    push(`sot_total_over_${key}`, over);
    push(`sot_total_under_${key}`, 1 - over);
  }

  return out;
};

const marketOverround = (selectionKey: string): number => {
  if (selectionKey === 'homeWin' || selectionKey === 'draw' || selectionKey === 'awayWin') return 0.06;
  if (selectionKey.startsWith('exact_')) return 0.09;
  if (selectionKey.startsWith('hcp_') || selectionKey.startsWith('ahcp_') || selectionKey.startsWith('handicap')) return 0.055;
  return 0.045;
};

router.post('/scraper/odds', async (req: Request, res: Response) => {
  try {
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    const requestId = String(res.locals?.requestId ?? '');
    const runId = observability?.createRunId('odds_bulk') ?? `odds_bulk_${startedAtMs}`;

    const {
      competition = 'Serie A',
      markets = [
        'h2h',
        'h2h_3_way',
        'totals',
        'alternate_totals',
        'spreads',
        'alternate_spreads',
        'btts',
        'double_chance',
        'draw_no_bet',
        'team_totals',
        'alternate_team_totals',
        'alternate_totals_corners',
        'alternate_spreads_corners',
        'alternate_totals_cards',
        'alternate_spreads_cards',
        'player_shots',
        'player_shots_on_target',
        'shots',
        'shots_on_target',
        'corners',
        'cards',
        'fouls',
      ],
    } = req.body;

    const normalizedMarkets =
      Array.isArray(markets) && markets.length > 0
        ? markets.map((m: unknown) => String(m)).filter(Boolean)
        : [
          'h2h',
          'h2h_3_way',
          'totals',
          'alternate_totals',
          'spreads',
          'alternate_spreads',
          'btts',
          'double_chance',
          'draw_no_bet',
          'team_totals',
          'alternate_team_totals',
          'alternate_totals_corners',
          'alternate_spreads_corners',
          'alternate_totals_cards',
          'alternate_spreads_cards',
          'player_shots',
          'player_shots_on_target',
          'shots',
          'shots_on_target',
          'corners',
          'cards',
          'fouls',
        ];
    const {
      coordinator,
      primaryProviderName,
      fallbackProviderName,
      apiKey,
    } = createOddsBundle();
    if (primaryProviderName === 'odds_api' && !apiKey) {
      return res.status(503).json({
        success: false,
        error: 'ODDS_API_KEY non configurata sul server.',
      });
    }

    const coordination = await withTimeout(
      coordinator.getCompetitionOdds(
        {
          competition: String(competition),
          fixtures: [],
          markets: normalizedMarkets,
          fallbackMarkets: Array.from(
            new Set([
              ...normalizedMarkets,
              'alternate_totals',
              'alternate_spreads',
              'btts',
              'double_chance',
              'draw_no_bet',
              'alternate_totals_corners',
              'alternate_spreads_corners',
              'corners',
              'cards',
              'fouls',
            ])
          ),
          includeExtendedGroups: true,
        },
        { mergeMarkets: true, useFallback: true }
      ),
      getBulkOddsRouteTimeoutMs(),
      'Coordinated bulk odds lookup'
    );

    const matchesWithBaseOdds = countMatchesWithBaseOdds(coordination.matches);
    const matchesWithExtendedGroups = countMatchesWithExtendedGroups(coordination.matches);
    const errorCategory = detectProviderErrorCategory(
      coordination.providerHealth,
      coordination.warnings,
      coordination.fallbackReason
    );
    const durationMs = Date.now() - startedAtMs;
    const fallbackUsed = coordination.matches.some((entry) => !entry.oddsSource.split('+').includes(primaryProviderName))
      || Boolean(coordination.fallbackReason);
    const sourceUsed = coordination.matches.length > 0
      ? coordination.matches[0].oddsSource
      : primaryProviderName;
    const marketCount = coordination.matches.reduce((sum, entry) => sum + countMatchMarkets(entry.match), 0);

    if (coordination.matches.length === 0 && !apiKey) {
      await observability?.recordProviderRun({
        requestId,
        runId,
        provider: primaryProviderName,
        competition: String(competition),
        meetingAlias: null,
        sourceUsed,
        matchCount: 0,
        marketCount,
        fixtureCount: 0,
        matchesWithBaseOdds,
        matchesWithExtendedGroups,
        durationMs,
        success: false,
        fallbackUsed,
        fallbackReason: coordination.fallbackReason ?? 'Provider quote non disponibile e fallback non configurato',
        warningCount: coordination.warnings.length,
        warnings: coordination.warnings,
        errorCategory: errorCategory ?? 'provider_unavailable',
        providerHealth: coordination.providerHealth,
        metadata: {
          remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
          requestedMarkets: normalizedMarkets,
        },
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
      });
      return res.status(503).json({
        success: false,
        error: 'Provider quote non disponibile e ODDS_API_KEY non configurata sul server.',
        providerHealth: coordination.providerHealth,
        fetchedAt: coordination.fetchedAt,
        warnings: coordination.warnings,
      });
    }

    const enriched = coordination.matches.map((entry: CoordinatedOddsMatch) => {
      const primaryOdds = sanitizeOddsMap(entry.bestOddsByProvider[primaryProviderName] ?? {});
      const fallbackBestOdds = fallbackProviderName
        ? sanitizeOddsMap(entry.bestOddsByProvider[fallbackProviderName] ?? {})
        : {};
      const bestOdds = Object.keys(primaryOdds).length > 0 ? primaryOdds : fallbackBestOdds;
      const selectedProvider = Object.keys(primaryOdds).length > 0
        ? primaryProviderName
        : Object.keys(fallbackBestOdds).length > 0
          ? fallbackProviderName
          : null;
      const source = selectedProvider ?? entry.oddsSource;

      return {
        homeTeam: entry.match.homeTeam,
        awayTeam: entry.match.awayTeam,
        commenceTime: entry.match.commenceTime,
        oddsApiOdds: sanitizeOddsMap(entry.bestOddsByProvider.odds_api ?? {}),
        bestOdds,
        bookmakerComparison: flattenProviderComparisons(entry.bookmakerComparisonByProvider),
        margins: flattenProviderMargins(entry.marginsByProvider),
        remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
        source,
        oddsSource: entry.oddsSource,
        fallbackReason: entry.fallbackReason ?? coordination.fallbackReason,
        providerHealth: entry.providerHealth,
        fetchedAt: entry.fetchedAt,
        isMerged: entry.isMerged,
      };
    });

    const updatedAt = coordination.fetchedAt;
    let savedSnapshots = 0;
    for (const entry of coordination.matches) {
      try {
        const primaryOdds = sanitizeOddsMap(entry.bestOddsByProvider[primaryProviderName] ?? {});
        const fallbackBestOdds = fallbackProviderName
          ? sanitizeOddsMap(entry.bestOddsByProvider[fallbackProviderName] ?? {})
          : {};
        const selectedProvider = Object.keys(primaryOdds).length > 0
          ? primaryProviderName
          : Object.keys(fallbackBestOdds).length > 0
            ? fallbackProviderName
            : null;
        const liveSelectedOdds = selectedProvider === primaryProviderName ? primaryOdds : fallbackBestOdds;
        const oddsProviderMatchId = String(entry.match.matchId ?? '').replace(/^odds_/, '');
        const usedFallbackBookmaker = Boolean(selectedProvider && selectedProvider !== primaryProviderName);
        const snapshot = await persistOddsSnapshot({
          oddsProviderMatchId,
          competition: String(competition),
          homeTeamName: entry.match.homeTeam,
          awayTeamName: entry.match.awayTeam,
          commenceTime: entry.match.commenceTime,
          source: selectedProvider ?? entry.oddsSource,
          selectedOdds: liveSelectedOdds,
          liveSelectedOdds,
          legacyOdds: {},
          estimatedOdds: {},
          fallbackOdds: usedFallbackBookmaker ? liveSelectedOdds : {},
          allBookmakerOdds: flattenProviderComparisons(entry.bookmakerComparisonByProvider),
          marketsRequested: normalizedMarkets,
          usedFallbackBookmaker,
          usedSyntheticOdds: false,
        });
        if (snapshot.saved) savedSnapshots++;
      } catch (snapshotErr: any) {
        console.warn('[OddsApi] Snapshot bulk non salvato:', snapshotErr?.message ?? snapshotErr);
      }
    }

    oddsRuntimeState = {
      competition: String(competition),
      markets: normalizedMarkets,
      matchesFound: coordination.matches.length,
      matches: toOddsSummary(coordination.matches.map((entry) => entry.match)),
      remainingRequests: Number.isFinite(Number(coordination.providerRuntime.odds_api?.remainingRequests))
        ? Number(coordination.providerRuntime.odds_api?.remainingRequests)
        : null,
      lastUpdatedAt: updatedAt,
      fetchedAt: coordination.fetchedAt,
      primaryProvider: primaryProviderName,
      activeProvider: coordination.matches.length > 0
        ? coordination.matches[0].oddsSource.includes('+')
          ? primaryProviderName
          : coordination.matches[0].oddsSource
        : fallbackUsed && fallbackProviderName
          ? fallbackProviderName
          : primaryProviderName,
      oddsSource: coordination.matches.length > 0 ? coordination.matches[0].oddsSource : sourceUsed,
      fallbackReason: coordination.fallbackReason,
      providerHealth: coordination.providerHealth,
      isMerged: coordination.isMerged,
      freshnessMinutes: minutesSince(coordination.fetchedAt),
      warningCount: coordination.warnings.length,
      errorCategory,
      lastDurationMs: durationMs,
    };

    const topLevelSource = coordination.matches.length > 0
      ? coordination.matches[0].oddsSource
      : primaryProviderName;

    await observability?.recordProviderRun({
      requestId,
      runId,
      provider: primaryProviderName,
      competition: String(competition),
      meetingAlias: null,
      sourceUsed,
      matchCount: coordination.matches.length,
      marketCount,
      fixtureCount: 0,
      matchesWithBaseOdds,
      matchesWithExtendedGroups,
      durationMs,
      success: coordination.matches.length > 0,
      fallbackUsed,
      fallbackReason: coordination.fallbackReason,
      warningCount: coordination.warnings.length,
      warnings: coordination.warnings,
      errorCategory,
      providerHealth: coordination.providerHealth,
      metadata: {
        remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
        requestedMarkets: normalizedMarkets,
        savedSnapshots,
        topLevelSource,
      },
      startedAt: startedAtIso,
      endedAt: new Date().toISOString(),
    });

    res.json({
      success: true,
      data: {
        competition,
        markets: normalizedMarkets,
        matchesFound: coordination.matches.length,
        matches: enriched,
        savedSnapshots,
        remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
        lastUpdatedAt: updatedAt,
        source: topLevelSource,
        primaryProvider: primaryProviderName,
        activeProvider: oddsRuntimeState.activeProvider,
        oddsSource: coordination.matches.length > 0 ? coordination.matches[0].oddsSource : primaryProviderName,
        fallbackReason: coordination.fallbackReason,
        providerHealth: coordination.providerHealth,
        fetchedAt: coordination.fetchedAt,
        isMerged: coordination.isMerged,
        freshnessMinutes: oddsRuntimeState.freshnessMinutes,
        warnings: coordination.warnings,
      },
    });
  } catch (e: any) {
    const caughtAt = new Date().toISOString();
    await observability?.recordProviderRun({
      requestId: String(res.locals?.requestId ?? ''),
      runId: observability?.createRunId('odds_bulk_error') ?? `odds_bulk_error_${Date.now()}`,
      provider: getConfiguredPrimaryProviderName(),
      competition: String(req.body?.competition ?? 'Serie A'),
      meetingAlias: null,
      sourceUsed: null,
      matchCount: 0,
      marketCount: 0,
      fixtureCount: 0,
      matchesWithBaseOdds: 0,
      matchesWithExtendedGroups: 0,
      durationMs: null,
      success: false,
      fallbackUsed: false,
      fallbackReason: e?.message ?? 'Unknown bulk odds error',
      warningCount: 0,
      warnings: [],
      errorCategory: detectProviderErrorCategory({}, [String(e?.message ?? '')], null) ?? 'bulk_odds_failed',
      providerHealth: {},
      metadata: null,
      startedAt: caughtAt,
      endedAt: caughtAt,
    });
    console.error('[OddsApi] Errore:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});



router.post('/scraper/odds/match', async (req: Request, res: Response) => {
  const routeStartedAtMs = Date.now();
  try {
    const startedAtMs = routeStartedAtMs;
    const startedAtIso = new Date(startedAtMs).toISOString();
    const requestId = String(res.locals?.requestId ?? '');
    const runId = observability?.createRunId('odds_match') ?? `odds_match_${startedAtMs}`;
    const {
      matchId,
      competition = 'Serie A',
      homeTeam,
      awayTeam,
      commenceTime,
    } = req.body ?? {};

    if (!homeTeam || !awayTeam) {
      return res.status(400).json({ success: false, error: 'homeTeam e awayTeam sono obbligatori.' });
    }

    const cacheKey = buildMatchOddsCacheKey({
      matchId: String(matchId ?? '').trim() || null,
      competition: String(competition),
      homeTeam: String(homeTeam),
      awayTeam: String(awayTeam),
      commenceTime: commenceTime ? String(commenceTime) : null,
    });
    const cachedPayload = getCachedMatchOddsPayload(cacheKey);
    if (cachedPayload) {
      observability?.log('info', 'odds_match_cache_hit', {
        requestId,
        runId,
        provider: 'cache',
        competition: String(competition),
        meetingAlias: null,
        matchCount: 1,
        durationMs: Date.now() - startedAtMs,
        errorCategory: null,
      });
      return res.json({ success: true, data: cachedPayload });
    }

    const inFlight = matchOddsInFlight.get(cacheKey);
    if (inFlight) {
      const sharedPayload = await inFlight;
      observability?.log('info', 'odds_match_inflight_reuse', {
        requestId,
        runId,
        provider: 'cache',
        competition: String(competition),
        meetingAlias: null,
        matchCount: 1,
        durationMs: Date.now() - startedAtMs,
        errorCategory: null,
      });
      return res.json({ success: true, data: sharedPayload });
    }

    const oddsBundle = createOddsBundle();
    const matchTimeoutMs = getMatchOddsRouteTimeoutMs();
    if (oddsBundle.primaryProviderName === 'odds_api' && !oddsBundle.apiKey) {
      return res.status(503).json({
        success: false,
        error: 'ODDS_API_KEY non configurata sul server.',
        data: {
          found: false,
          source: 'odds_api',
          oddsSource: 'unavailable',
          primaryProvider: oddsBundle.primaryProviderName,
          fallbackProvider: oddsBundle.fallbackProviderName,
          activeProvider: null,
          selectedProvider: null,
          timeoutMs: matchTimeoutMs,
          marketCount: 0,
          selectedOddsCount: 0,
          fallbackReason: 'ODDS_API_KEY non configurata',
          providerHealth: {
            odds_api: {
              provider: 'odds_api',
              status: 'disabled',
              checkedAt: new Date().toISOString(),
              message: 'ODDS_API_KEY non configurata',
            },
          },
          warnings: ['ODDS_API_KEY non configurata'],
          candidateCount: 0,
          requestedFixture: {
            competition: String(competition),
            homeTeam: String(homeTeam),
            awayTeam: String(awayTeam),
            commenceTime: commenceTime ? String(commenceTime) : null,
          },
          message: 'ODDS_API_KEY non configurata: impossibile caricare quote bookmaker.',
        },
      });
    }

    const work = (async () => {
      const {
        coordinator,
        primaryProviderName,
        fallbackProviderName,
      } = oddsBundle;
      let requestedFixture = {
        competition: String(competition),
        homeTeam: String(homeTeam),
        awayTeam: String(awayTeam),
        commenceTime: commenceTime ? String(commenceTime) : null,
      };

      const preferredMarkets = [
        'h2h',
        'h2h_3_way',
        'totals',
        'alternate_totals',
        'spreads',
        'alternate_spreads',
        'btts',
        'double_chance',
        'draw_no_bet',
        'team_totals',
        'alternate_team_totals',
      ];
      const fallbackMarkets = [
        'h2h',
        'totals',
        'alternate_totals',
        'btts',
        'double_chance',
        'draw_no_bet',
      ];
      const eventAdditionalMarkets = [
        'alternate_totals',
        'alternate_spreads',
        'alternate_totals_cards',
        'alternate_spreads_cards',
        'team_totals',
        'alternate_team_totals',
        'btts',
        'double_chance',
        'draw_no_bet',
        'player_shots',
        'player_shots_on_target',
        'shots',
        'shots_on_target',
        'cards',
      ];
      const requestedMarkets = Array.from(new Set([...preferredMarkets, ...fallbackMarkets, ...eventAdditionalMarkets]));
      console.info('[Odds/match] Starting lookup', {
        requestId,
        runId,
        fixture: requestedFixture,
        primaryProvider: primaryProviderName,
        fallbackProvider: fallbackProviderName,
        timeoutMs: matchTimeoutMs,
        includeExtendedGroups: false,
        marketsRequested: requestedMarkets,
      });
      const runFixtureLookup = (fixtureCommenceTime: string | null) => withTimeout(
        coordinator.getOddsForFixtures(
          {
            competition: String(competition),
            fixtures: [{
              homeTeam: String(homeTeam),
              awayTeam: String(awayTeam),
              commenceTime: fixtureCommenceTime,
            }],
            markets: preferredMarkets,
            fallbackMarkets,
            extraEventMarkets: eventAdditionalMarkets,
            includeExtendedGroups: false,
          },
          { mergeMarkets: false, useFallback: false }
        ),
        matchTimeoutMs,
        'Coordinated match odds lookup'
      );

      let coordination = await runFixtureLookup(requestedFixture.commenceTime);
      const retryWarnings: string[] = [];

      if (
        !coordination.matches?.[0]
        && String(matchId ?? '').trim()
        && hasKickoffMismatchDiagnostic(coordination)
      ) {
        const dbMatch = await db.getMatchById(String(matchId).trim());
        if (dbMatch) {
          const syncService = createKickoffSyncService(db);
          const syncResult = await syncService.syncSingleMatchKickoffFromOddsApi(dbMatch, {
            competition: String(competition),
          });

          if (syncResult.corrected && syncResult.correction?.newDate) {
            const reloadedMatch = await db.getMatchById(String(matchId).trim());
            const reloadedTimestamp = Date.parse(String(reloadedMatch?.date ?? ''));
            const correctedCommenceTime = Number.isFinite(reloadedTimestamp)
              ? new Date(reloadedTimestamp).toISOString()
              : syncResult.correction.newDate;
            requestedFixture = {
              ...requestedFixture,
              commenceTime: correctedCommenceTime,
            };
            retryWarnings.push('retry_after_kickoff_sync', 'kickoff_corrected_before_odds_lookup');
            coordination = await runFixtureLookup(requestedFixture.commenceTime);
          } else if (syncResult.skippedReason) {
            retryWarnings.push(`kickoff_sync_skipped:${syncResult.skippedReason}`);
          }
        }
      }

      const coordinatedMatch = coordination.matches[0] ?? null;
      const primaryRuntime = coordination.providerRuntime[primaryProviderName] ?? {};
      const primaryFetchDetails = (primaryRuntime.fetchDetails ?? {}) as Record<string, any>;
      const fixtureDiagnostics = Array.isArray(primaryFetchDetails.fixtureDiagnostics)
        ? primaryFetchDetails.fixtureDiagnostics
        : [];
      const firstFixtureDiagnostic = fixtureDiagnostics[0] ?? null;
      const candidateCount = Number(
        primaryFetchDetails.candidateCount
        ?? primaryFetchDetails.matchesReceived
        ?? firstFixtureDiagnostic?.candidateCount
        ?? 0
      );
      const matchesWithBaseOdds = countMatchesWithBaseOdds(coordination.matches);
      const matchesWithExtendedGroups = countMatchesWithExtendedGroups(coordination.matches);
      const errorCategory = detectProviderErrorCategory(
        coordination.providerHealth,
        coordination.warnings,
        coordination.fallbackReason
      );
      const durationMs = Date.now() - startedAtMs;
      const providerHealth = coordination.providerHealth;
      const marketCount = coordinatedMatch ? countMatchMarkets(coordinatedMatch.match) : 0;
      const responseMatch = coordinatedMatch?.match ?? null;
      const resolvedCommenceTime = responseMatch?.commenceTime ?? requestedFixture.commenceTime ?? null;
      const confidenceScore = responseMatch
        ? Number(matchScore(responseMatch, String(homeTeam), String(awayTeam), commenceTime ? String(commenceTime) : undefined).toFixed(3))
        : 0;

      if (!coordinatedMatch) {
        const diagnosticWarnings = Array.from(new Set([
          ...coordination.warnings,
          ...retryWarnings,
          ...((firstFixtureDiagnostic?.warnings ?? []) as string[]),
        ].filter(Boolean)));
        await observability?.recordProviderRun({
          requestId,
          runId,
          provider: primaryProviderName,
          competition: String(competition),
          meetingAlias: null,
          sourceUsed: primaryProviderName,
          matchCount: 0,
          marketCount,
          fixtureCount: 1,
          matchesWithBaseOdds,
          matchesWithExtendedGroups,
          durationMs,
          success: false,
          fallbackUsed: false,
          fallbackReason: coordination.fallbackReason ?? 'Nessun match trovato per la fixture richiesta',
          warningCount: diagnosticWarnings.length,
          warnings: diagnosticWarnings,
          errorCategory: errorCategory ?? 'fixture_matching_failed',
          providerHealth,
          metadata: {
            ...requestedFixture,
            candidateCount,
            candidates: firstFixtureDiagnostic?.candidates ?? [],
            remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
            timeoutMs: matchTimeoutMs,
          },
          startedAt: startedAtIso,
          endedAt: new Date().toISOString(),
        });
        return {
          found: false,
          message: diagnosticWarnings.some((warning) => String(warning).includes('kickoff_outside_36h_window'))
            ? 'Quote non trovate: kickoff calendario non allineato o fixture non disponibile su Odds API.'
            : 'Quote non trovate: Odds API non espone ancora questa partita oppure la fixture non e disponibile.',
          source: primaryProviderName,
          oddsSource: 'unavailable',
          primaryProvider: primaryProviderName,
          fallbackProvider: fallbackProviderName,
          activeProvider: null,
          selectedProvider: null,
          timeoutMs: matchTimeoutMs,
          fallbackReason: coordination.fallbackReason,
          providerHealth,
          fetchedAt: coordination.fetchedAt,
          isMerged: coordination.isMerged,
          freshnessMinutes: minutesSince(coordination.fetchedAt),
          selectedOdds: {},
          oddsApiOdds: {},
          fallbackOdds: {},
          allBookmakerOdds: {},
          marketCount,
          selectedOddsCount: 0,
          oddsCoverage: summarizeOddsCoverage({}, {}, {}),
          usedFallbackBookmaker: false,
          usedSyntheticOdds: false,
          bestScore: confidenceScore,
          marketsRequested: requestedMarkets,
          remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
          warnings: diagnosticWarnings,
          candidateCount,
          requestedFixture,
          candidates: firstFixtureDiagnostic?.candidates ?? [],
          diagnostics: {
            providerRuntime: coordination.providerRuntime,
            fixtureDiagnostics,
            fallbackProvider: fallbackProviderName,
          },
        };
      }

      const oddsApiOdds = coordinatedMatch.bestOddsByProvider.odds_api ?? {};
      const providerPriority = Array.from(new Set([
        primaryProviderName,
        ...String(coordinatedMatch.oddsSource ?? '').split('+').filter(Boolean),
        'odds_api',
      ]));
      const selectedProvider = providerPriority.find((providerName) =>
        Object.keys(sanitizeOddsMap(coordinatedMatch.bestOddsByProvider[providerName] ?? {})).length > 0
      ) ?? null;
      const selectedOdds = selectedProvider
        ? sanitizeOddsMap(coordinatedMatch.bestOddsByProvider[selectedProvider] ?? {})
        : {};
      const liveSelectedOdds = selectedOdds;
      const estimatedOdds: Record<string, number> = {};
      const usedFallbackBookmaker = Boolean(selectedProvider && selectedProvider !== primaryProviderName);
      const usedSyntheticOdds = false;
      const source = selectedProvider === 'odds_api' ? 'odds_api' : 'unavailable';
      const fallbackOdds: Record<string, number> = usedFallbackBookmaker ? selectedOdds : {};
      const oddsCoverage = summarizeOddsCoverage(
        selectedOdds,
        {},
        estimatedOdds
      );
      const finalMarketsRequested = Array.from(new Set([
        ...preferredMarkets,
        ...fallbackMarkets,
        ...eventAdditionalMarkets,
        ...((primaryFetchDetails.marketsUsed ?? []) as string[]),
        ...((primaryFetchDetails.extraEventMarketsRequested ?? []) as string[]),
        ...((primaryFetchDetails.extraEventMarketsLoaded ?? []) as string[]),
        ...Object.keys(coordinatedMatch.marketSources),
      ]));

      const allBookmakerOdds = flattenProviderComparisons(coordinatedMatch.bookmakerComparisonByProvider);
      const selectedProviderMatch = selectedProvider
        ? coordinatedMatch.providerMatches[selectedProvider] as OddsMatch | undefined
        : undefined;
      const oddsProviderMatchId = String(selectedProviderMatch?.matchId ?? '').replace(/^odds_/, '') || null;

      let historicalSnapshotSaved = false;
      let snapshotMatchId: string | null = null;
      try {
        const snapshot = await persistOddsSnapshot({
          matchId: String(matchId ?? '').trim() || null,
          oddsProviderMatchId,
          competition: String(competition),
          homeTeamName: responseMatch.homeTeam,
          awayTeamName: responseMatch.awayTeam,
          commenceTime: resolvedCommenceTime,
          source,
          selectedOdds,
          liveSelectedOdds,
          legacyOdds: {},
          estimatedOdds,
          fallbackOdds,
          allBookmakerOdds,
          marketsRequested: finalMarketsRequested,
          usedFallbackBookmaker,
          usedSyntheticOdds,
          confidenceScore,
        });
        historicalSnapshotSaved = snapshot.saved;
        snapshotMatchId = snapshot.matchId;
      } catch (snapshotErr: any) {
        console.warn('[OddsApi/match] Snapshot non salvato:', snapshotErr?.message ?? snapshotErr);
      }

      const providerNotes = [...oddsCoverage.providerNotes];
      if (usedFallbackBookmaker && selectedProvider) {
        providerNotes.push(`Quote caricate da provider secondario (${selectedProvider}) per indisponibilita del primario.`);
      }
      const sourceUsed = source;
      const fallbackUsed = usedFallbackBookmaker || Boolean(coordinatedMatch.fallbackReason ?? coordination.fallbackReason);
      const selectedOddsCount = Object.keys(selectedOdds).length;

      await observability?.recordProviderRun({
        requestId,
        runId,
        provider: primaryProviderName,
        competition: String(competition),
        meetingAlias: null,
        sourceUsed,
        matchCount: 1,
        marketCount,
        fixtureCount: 1,
        matchesWithBaseOdds,
        matchesWithExtendedGroups,
        durationMs,
        success: Object.keys(selectedOdds).length > 0,
        fallbackUsed,
        fallbackReason: coordinatedMatch.fallbackReason ?? coordination.fallbackReason,
        warningCount: Array.from(new Set([...coordination.warnings, ...retryWarnings])).length,
        warnings: Array.from(new Set([...coordination.warnings, ...retryWarnings])),
        errorCategory,
        providerHealth,
        metadata: {
          homeTeam: responseMatch.homeTeam,
          awayTeam: responseMatch.awayTeam,
          commenceTime: resolvedCommenceTime,
          remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
          requestedMarkets: finalMarketsRequested,
          historicalSnapshotSaved,
          snapshotMatchId,
          confidenceScore,
          selectedProvider,
          candidateCount,
          timeoutMs: matchTimeoutMs,
        },
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
      });

      return {
        found: Object.keys(selectedOdds).length > 0,
        message: Object.keys(selectedOdds).length > 0
          ? (usedFallbackBookmaker ? 'Quote bookmaker caricate da provider secondario.' : 'Quote bookmaker caricate correttamente.')
          : 'Quote bookmaker non trovate per questa partita.',
        usedFallbackBookmaker,
        usedSyntheticOdds,
        source,
        oddsSource: source,
        primaryProvider: primaryProviderName,
        fallbackProvider: fallbackProviderName,
        activeProvider: selectedProvider,
        selectedProvider,
        timeoutMs: matchTimeoutMs,
        fallbackReason: coordinatedMatch.fallbackReason ?? coordination.fallbackReason,
        providerHealth,
        fetchedAt: coordinatedMatch.fetchedAt,
        isMerged: coordinatedMatch.isMerged,
        freshnessMinutes: minutesSince(coordinatedMatch.fetchedAt),
        selectedOdds,
        oddsApiOdds: sanitizeOddsMap(oddsApiOdds),
        fallbackOdds,
        allBookmakerOdds,
        marketCount,
        selectedOddsCount,
        oddsCoverage: {
          ...oddsCoverage,
          providerNotes,
        },
        marketsRequested: finalMarketsRequested,
        match: {
          homeTeam: responseMatch.homeTeam,
          awayTeam: responseMatch.awayTeam,
          commenceTime: resolvedCommenceTime,
        },
        providerMatchId: oddsProviderMatchId,
        matchedHomeTeam: responseMatch.homeTeam,
        matchedAwayTeam: responseMatch.awayTeam,
        commenceTime: resolvedCommenceTime,
        historicalSnapshotSaved,
        snapshotMatchId,
        confidenceScore,
        remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
        warnings: Array.from(new Set([...coordination.warnings, ...retryWarnings])),
        marketSources: coordinatedMatch.marketSources,
        candidateCount,
        requestedFixture,
        diagnostics: {
          providerRuntime: coordination.providerRuntime,
          fixtureDiagnostics,
          fallbackProvider: fallbackProviderName,
        },
      };
    })();

    matchOddsInFlight.set(cacheKey, work);
    const payload = await work;
    if (shouldCacheMatchOddsPayload(payload)) {
      setCachedMatchOddsPayload(cacheKey, payload);
    }
    console.info('[Odds/match] Completed lookup', {
      requestId,
      runId,
      fixture: {
        competition: String(competition),
        homeTeam: String(homeTeam),
        awayTeam: String(awayTeam),
        commenceTime: commenceTime ? String(commenceTime) : null,
      },
      found: Boolean(payload?.found),
      source: payload?.source ?? payload?.oddsSource ?? 'unavailable',
      selectedOddsCount: Object.keys(sanitizeOddsMap(payload?.selectedOdds ?? {})).length,
      warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
      durationMs: Date.now() - routeStartedAtMs,
    });
    return res.json({ success: true, data: payload });
  } catch (e: any) {
    const caughtAt = new Date().toISOString();
    const errorMessage = e?.message ?? String(e);
    const errorWarnings = [errorMessage].filter(Boolean);
    console.warn('[Odds/match] Failed lookup', {
      requestId: String(res.locals?.requestId ?? ''),
      fixture: {
        competition: String(req.body?.competition ?? 'Serie A'),
        homeTeam: String(req.body?.homeTeam ?? ''),
        awayTeam: String(req.body?.awayTeam ?? ''),
        commenceTime: req.body?.commenceTime ? String(req.body.commenceTime) : null,
      },
      primaryProvider: getConfiguredPrimaryProviderName(),
      fallbackProvider: getConfiguredFallbackProviderName(),
      timeoutMs: getMatchOddsRouteTimeoutMs(),
      found: false,
      source: 'unavailable',
      selectedOddsCount: 0,
      warnings: errorWarnings,
      durationMs: Date.now() - routeStartedAtMs,
      error: errorMessage,
    });
    await observability?.recordProviderRun({
      requestId: String(res.locals?.requestId ?? ''),
      runId: observability?.createRunId('odds_match_error') ?? `odds_match_error_${Date.now()}`,
      provider: getConfiguredPrimaryProviderName(),
      competition: String(req.body?.competition ?? 'Serie A'),
      meetingAlias: null,
      sourceUsed: null,
      matchCount: 0,
      marketCount: 0,
      fixtureCount: 1,
      matchesWithBaseOdds: 0,
      matchesWithExtendedGroups: 0,
      durationMs: null,
      success: false,
      fallbackUsed: false,
      fallbackReason: errorMessage || 'Unknown match odds error',
      warningCount: 0,
      warnings: [],
      errorCategory: detectProviderErrorCategory({}, errorWarnings, null) ?? 'match_odds_failed',
      providerHealth: {},
      metadata: {
        homeTeam: String(req.body?.homeTeam ?? ''),
        awayTeam: String(req.body?.awayTeam ?? ''),
        commenceTime: req.body?.commenceTime ? String(req.body.commenceTime) : null,
      },
      startedAt: caughtAt,
      endedAt: caughtAt,
    });
    console.error('[Odds/match] Errore:', errorMessage);
    return res.status(503).json({
      success: false,
      error: errorMessage,
      data: {
        found: false,
        source: 'unavailable',
        oddsSource: 'unavailable',
        primaryProvider: getConfiguredPrimaryProviderName(),
        fallbackProvider: getConfiguredFallbackProviderName(),
        activeProvider: null,
        selectedProvider: null,
        timeoutMs: getMatchOddsRouteTimeoutMs(),
        providerHealth: {},
        warnings: errorWarnings,
        marketCount: 0,
        selectedOddsCount: 0,
        message: `Errore quote: ${errorMessage}`,
      },
    });
  } finally {
    const cacheKey = buildMatchOddsCacheKey({
      matchId: String(req.body?.matchId ?? '').trim() || null,
      competition: String(req.body?.competition ?? 'Serie A'),
      homeTeam: String(req.body?.homeTeam ?? ''),
      awayTeam: String(req.body?.awayTeam ?? ''),
      commenceTime: req.body?.commenceTime ? String(req.body.commenceTime) : null,
    });
    matchOddsInFlight.delete(cacheKey);
  }
});

router.post('/system/sync-upcoming-kickoffs', async (req: Request, res: Response) => {
  try {
    if (!getConfiguredOddsApiKey()) {
      return res.status(503).json({
        success: false,
        error: 'ODDS_API_KEY non configurata: impossibile correggere i kickoff da Odds API.',
      });
    }

    const mode = String(req.body?.mode ?? req.query?.mode ?? 'single').trim().toLowerCase();
    const rawCompetition = String(req.body?.competition ?? req.query?.competition ?? 'Serie A').trim() || 'Serie A';
    const competitions = (mode === 'top5' || rawCompetition === 'TOP_5')
      ? UnderstatScraper.getTop5Competitions()
      : [rawCompetition];
    const season = String(req.body?.season ?? req.query?.season ?? '').trim() || undefined;
    const limitRaw = Number(req.body?.limit ?? req.query?.limit ?? 160);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(Math.trunc(limitRaw), 500)) : 160;
    const syncService = createKickoffSyncService(db);
    const results = [];
    for (const competition of competitions) {
      results.push(await syncService.syncUpcomingKickoffsFromOddsApi({ competition, season, limit }));
    }
    const data = {
      mode: competitions.length > 1 ? 'top5' : 'single',
      competition: competitions.length === 1 ? competitions[0] : 'TOP_5',
      checked: results.reduce((sum, item) => sum + Number(item.checked ?? 0), 0),
      providerEvents: results.reduce((sum, item) => sum + Number(item.providerEvents ?? 0), 0),
      corrected: results.reduce((sum, item) => sum + Number(item.corrected ?? 0), 0),
      skippedAmbiguous: results.reduce((sum, item) => sum + Number(item.skippedAmbiguous ?? 0), 0),
      skippedNoMatch: results.reduce((sum, item) => sum + Number(item.skippedNoMatch ?? 0), 0),
      skippedInverted: results.reduce((sum, item) => sum + Number(item.skippedInverted ?? 0), 0),
      skippedSmallDiff: results.reduce((sum, item) => sum + Number(item.skippedSmallDiff ?? 0), 0),
      corrections: results.flatMap((item) => item.corrections ?? []),
      warnings: results.flatMap((item) => item.warnings ?? []),
      byCompetition: results,
    };

    res.json({ success: true, data });
  } catch (error: any) {
    console.error('[OddsApi] Errore sync kickoff upcoming:', error?.message ?? error);
    res.status(500).json({
      success: false,
      error: error?.message ?? 'Errore sync kickoff upcoming',
    });
  }
});

router.get('/scraper/odds/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      ...oddsRuntimeState,
      primaryProvider: oddsRuntimeState.primaryProvider || getConfiguredPrimaryProviderName(),
      freshnessMinutes: oddsRuntimeState.fetchedAt ? minutesSince(oddsRuntimeState.fetchedAt) : oddsRuntimeState.freshnessMinutes,
    },
  });
});

router.get('/scraper/odds/info', (_req, res) => {
  res.json({
    success: true,
    data: {
      competitions: OddsApiService.getSupportedCompetitions(),
      bookmakers: OddsApiService.getSupportedBookmakers(),
      freePlanLimit: 500,
      registrationUrl: 'https://the-odds-api.com',
      primaryProvider: getConfiguredPrimaryProviderName(),
      fallbackProvider: getConfiguredFallbackProviderName(),
      note: 'Il progetto usa Odds API come unico provider quote runtime.',
    }
  });
});

router.get('/scraper/odds/debug-config', (_req, res) => {
  res.json({
    success: true,
    data: {
      ODDS_PRIMARY_PROVIDER: String(process.env.ODDS_PRIMARY_PROVIDER ?? '').trim() || null,
      hasOddsApiKey: Boolean(getConfiguredOddsApiKey()),
      primaryProvider: getConfiguredPrimaryProviderName(),
      fallbackProvider: getConfiguredFallbackProviderName(),
      routeMatchTimeoutMs: getMatchOddsRouteTimeoutMs(),
      ODDS_PROVIDER_MATCH_TIMEOUT_MS: getProviderTimeoutMs('runtime', true),
      ODDS_MATCH_ROUTE_TIMEOUT_MS: getMatchOddsRouteTimeoutMs(),
      ODDS_EVENT_TIMEOUT_MS: parsePositiveIntEnvValue('ODDS_EVENT_TIMEOUT_MS', 60 * 1000),
      ODDS_PROVIDER_COMPETITION_TIMEOUT_MS: getProviderTimeoutMs('runtime', false),
      ODDS_BULK_ROUTE_TIMEOUT_MS: getBulkOddsRouteTimeoutMs(),
      NODE_ENV: process.env.NODE_ENV ?? null,
    },
  });
});


return router;
}

export default createApiRouter;


