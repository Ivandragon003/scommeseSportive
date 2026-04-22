import { Router, Request, Response } from 'express';
import { PredictionService } from '../services/PredictionService';
import { DatabaseService } from '../db/DatabaseService';
import { EurobetOddsMatch, EurobetOddsService } from '../services/EurobetOddsService';
import { EurobetSmokeRunSummary, readLastEurobetSmokeRun } from '../services/EurobetSmokeArtifactsService';
import { OddsApiService, OddsMatch } from '../services/OddsApiService';
import { CoordinatedOddsMatch } from '../services/odds-provider/OddsProviderCoordinator';
import { createOddsProviderCoordinatorBundle, getConfiguredOddsApiKey, getConfiguredPrimaryProviderName } from '../services/odds-provider/providerRuntimeConfig';
import { SofaScoreSupplementalScraper } from '../services/SofaScoreSupplementalScraper';
import { buildBacktestReport } from '../services/BacktestReportService';
import { SystemObservabilityService } from '../services/SystemObservabilityService';
import { UnderstatScraper } from '../services/UnderstatScraper';

const UNDERSTAT_DETAIL_CONCURRENCY = Math.max(
  2,
  Math.min(Number(process.env.UNDERSTAT_DETAIL_CONCURRENCY ?? 10), 24)
);

export type ApiRouterDependencies = {
  db: DatabaseService;
  svc?: PredictionService;
  observability?: SystemObservabilityService;
};

export type EurobetCompetitionFixtureScope = {
  homeTeam: string;
  awayTeam: string;
  commenceTime?: string | null;
};

const normalizeEurobetCompetitionCachePart = (value: string): string =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const normalizeEurobetFixtureCommenceTime = (value?: string | null): string => {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const timestamp = Date.parse(raw);
  if (Number.isFinite(timestamp)) {
    return new Date(timestamp).toISOString();
  }
  return raw;
};

const buildEurobetFixtureSignature = (fixtures?: EurobetCompetitionFixtureScope[]): string => {
  if (!Array.isArray(fixtures) || fixtures.length === 0) return 'all';

  return fixtures
    .map((fixture) => [
      normalizeEurobetCompetitionCachePart(String(fixture.homeTeam ?? '')),
      normalizeEurobetCompetitionCachePart(String(fixture.awayTeam ?? '')),
      normalizeEurobetCompetitionCachePart(normalizeEurobetFixtureCommenceTime(fixture.commenceTime)),
    ].join('__'))
    .sort()
    .join('|');
};

export const buildEurobetCompetitionCacheKey = (input: {
  competition: string;
  includeExtendedGroups?: boolean;
  fixtures?: EurobetCompetitionFixtureScope[];
}): string => {
  const fixtureScoped = Array.isArray(input.fixtures) && input.fixtures.length > 0;
  return [
    normalizeEurobetCompetitionCachePart(String(input.competition ?? '')),
    input.includeExtendedGroups ? 'extended' : 'base',
    fixtureScoped ? 'fixtures' : 'bulk',
    buildEurobetFixtureSignature(input.fixtures),
  ].join('::');
};

export const shouldUseEurobetCompetitionCache = (
  fixtures?: EurobetCompetitionFixtureScope[]
): boolean => !Array.isArray(fixtures) || fixtures.length === 0;

export function createApiRouter(deps: ApiRouterDependencies): Router {
const router = Router();
const db = deps.db;
const svc = deps.svc ?? new PredictionService(db);
const observability = deps.observability;

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
      ? await rebuildPlayerDerivedStats({
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
      ? await rebuildRefereeDerivedStats({
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

function roundN(v: number, n = 3): number {
  const x = Number(v);
  if (!isFinite(x)) return 0;
  return parseFloat(x.toFixed(n));
}

function poissonPMF(k: number, lambda: number): number {
  if (!isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return isFinite(p) ? p : 0;
}

function poissonOver(line: number, lambda: number): number {
  let cdf = 0;
  const maxK = Math.max(12, Math.ceil(lambda + 8 * Math.sqrt(Math.max(0.1, lambda))));
  for (let k = 0; k <= Math.floor(line) && k <= maxK; k++) cdf += poissonPMF(k, lambda);
  return Math.max(0, Math.min(1, 1 - cdf));
}

function poissonDistribution(lambda: number, maxK: number): Record<number, number> {
  const out: Record<number, number> = {};
  let sum = 0;
  for (let k = 0; k <= maxK; k++) {
    const p = poissonPMF(k, lambda);
    out[k] = p;
    sum += p;
  }
  if (sum <= 0) return { 0: 1 };
  for (let k = 0; k <= maxK; k++) out[k] = out[k] / sum;
  return out;
}

function negBinPMF(k: number, mu: number, r: number): number {
  if (!isFinite(mu) || !isFinite(r) || mu <= 0 || r <= 0) return k === 0 ? 1 : 0;
  const p = r / (r + mu);
  let combLog = 0;
  for (let i = 0; i < k; i++) combLog += Math.log(r + i) - Math.log(i + 1);
  const logP = combLog + r * Math.log(p) + k * Math.log(1 - p);
  const val = Math.exp(logP);
  return isFinite(val) ? val : 0;
}

function negBinDistribution(mu: number, r: number, maxK: number): Record<number, number> {
  const out: Record<number, number> = {};
  let sum = 0;
  for (let k = 0; k <= maxK; k++) {
    const p = negBinPMF(k, mu, r);
    out[k] = p;
    sum += p;
  }
  if (sum <= 0) return { 0: 1 };
  for (let k = 0; k <= maxK; k++) out[k] = out[k] / sum;
  return out;
}

function overFromDist(dist: Record<number, number>, line: number): number {
  let over = 0;
  for (const [k, v] of Object.entries(dist)) {
    if (Number(k) > line) over += Number(v);
  }
  return Math.max(0, Math.min(1, over));
}

function lineToKey(prefix: string, line: string): string {
  return `${prefix}${line.replace('.', '')}`;
}

function mapOverUnder(ou: Record<string, { over: number; under: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [line, v] of Object.entries(ou ?? {})) {
    out[lineToKey('over', line)] = roundN(v.over, 4);
    out[lineToKey('under', line)] = roundN(v.under, 4);
  }
  return out;
}

function formatPrediction(pred: any): any {
  const probs: any = pred.probabilities ?? {};
  const cards = probs.cards ?? {};
  const fouls = probs.fouls ?? {};
  const corners = probs.corners ?? {};
  const homeShotsModel = probs.shotsHome ?? {};
  const awayShotsModel = probs.shotsAway ?? {};
  const homeShotTotals = homeShotsModel.totalShots ?? {};
  const awayShotTotals = awayShotsModel.totalShots ?? {};
  const homeShotTarget = homeShotsModel.shotsOnTarget ?? probs.shotsOnTargetHome ?? {};
  const awayShotTarget = awayShotsModel.shotsOnTarget ?? probs.shotsOnTargetAway ?? {};

  const lambdaHome = Number(probs.lambdaHome ?? 0);
  const lambdaAway = Number(probs.lambdaAway ?? 0);

  const homeShotsExp = Number(homeShotsModel.expected ?? homeShotTotals.expected ?? 0);
  const awayShotsExp = Number(awayShotsModel.expected ?? awayShotTotals.expected ?? 0);
  const homeSOTExp = Number(homeShotTarget.expected ?? 0);
  const awaySOTExp = Number(awayShotTarget.expected ?? 0);

  const cardsR = Math.max(1, Number(cards.negBinParams?.r ?? 12));
  const foulsR = Math.max(1, Number(fouls.negBinParams?.r ?? 13));

  const totalYellowExp = Number(cards.expectedTotalYellow ?? 0);
  const homeYellowExp = Number(cards.expectedHomeYellow ?? 0);
  const awayYellowExp = Number(cards.expectedAwayYellow ?? 0);
  const redExp = Number(cards.expectedHomeRed ?? 0) + Number(cards.expectedAwayRed ?? 0);

  const totalFoulsExp = Number(fouls.expectedTotalFouls ?? 0);
  const homeFoulsExp = Number(fouls.expectedHomeFouls ?? 0);
  const awayFoulsExp = Number(fouls.expectedAwayFouls ?? 0);

  const yellowDist = negBinDistribution(totalYellowExp, cardsR, 14);
  const foulsDist = negBinDistribution(totalFoulsExp, foulsR, 50);
  const redDist = poissonDistribution(redExp, 4);

  const shotsHomeDist = Object.keys(homeShotTotals.distribution ?? {}).length > 0
    ? homeShotTotals.distribution
    : poissonDistribution(homeShotsExp, 25);
  const shotsAwayDist = Object.keys(awayShotTotals.distribution ?? {}).length > 0
    ? awayShotTotals.distribution
    : poissonDistribution(awayShotsExp, 25);
  const shotsHomeSOTDist = Object.keys(homeShotTarget.distribution ?? {}).length > 0
    ? homeShotTarget.distribution
    : poissonDistribution(homeSOTExp, 15);
  const shotsAwaySOTDist = Object.keys(awayShotTarget.distribution ?? {}).length > 0
    ? awayShotTarget.distribution
    : poissonDistribution(awaySOTExp, 15);

  const combinedShotsExp = homeShotsExp + awayShotsExp;
  const combinedSOTExp = homeSOTExp + awaySOTExp;
  const totalCornersExp = Number(corners.expectedTotalCorners ?? 0);

  const overUnderYellow = mapOverUnder(cards.overUnderYellow ?? {});
  const overUnderFouls = mapOverUnder(fouls.overUnder ?? {});
  const overUnderShots = mapOverUnder(probs.shotsTotal ?? {});
  const overUnderCorners = mapOverUnder(corners.overUnder ?? {});

  const asPlayer = (p: any, side: string, idx: number) => {
    const expShots = Number(p.expectedShots ?? 0);
    const expSOT = Number(p.expectedShotsOnTarget ?? 0);
    return {
      playerId: p.playerId ?? `${side}_${idx}`,
      playerName: p.playerName ?? p.name ?? `Player ${idx + 1}`,
      teamId: p.teamId ?? side,
      position: p.positionCode ?? p.position ?? 'UNK',
      expectedShots: roundN(expShots, 3),
      expectedOnTarget: roundN(expSOT, 3),
      shotDistribution: poissonDistribution(expShots, 8),
      onTargetDistribution: poissonDistribution(expSOT, 6),
      markets: {
        over05shots: roundN(Number(p.prob1PlusShots ?? 0), 4),
        over15shots: roundN(Number(p.prob2PlusShots ?? 0), 4),
        over25shots: roundN(Number(p.prob3PlusShots ?? 0), 4),
        over35shots: roundN(poissonOver(3.5, expShots), 4),
        over05onTarget: roundN(Number(p.prob1PlusShotsOT ?? 0), 4),
        over15onTarget: roundN(poissonOver(1.5, expSOT), 4),
        over25onTarget: roundN(poissonOver(2.5, expSOT), 4),
        zeroShots: roundN(Math.max(0, 1 - Number(p.prob1PlusShots ?? 0)), 4),
      },
      confidenceLevel: roundN(Number(pred.modelConfidence ?? 0.75), 3),
      sampleSize: Number(p.sampleSize ?? 0),
    };
  };

  const playerShotsPredictions = [
    ...(probs.playerShots?.home ?? []).map((p: any, i: number) => asPlayer(p, 'home', i)),
    ...(probs.playerShots?.away ?? []).map((p: any, i: number) => asPlayer(p, 'away', i)),
  ];

  const valueOpportunities = (pred.valueOpportunities ?? [])
    .filter((o: any) => isFinite(Number(o.bookmakerOdds)) && isFinite(Number(o.ourProbability)))
    .map((o: any) => ({
      ...o,
      ourProbability: roundN(Number(o.ourProbability), 2),
      impliedProbability: roundN(Number(o.impliedProbability), 2),
      expectedValue: roundN(Number(o.expectedValue), 2),
      edge: roundN(Number(o.edge), 2),
      kellyFraction: roundN(Number(o.kellyFraction), 2),
      suggestedStakePercent: roundN(Number(o.suggestedStakePercent), 2),
    }));

  const speculativeOpportunities = (pred.speculativeOpportunities ?? [])
    .filter((o: any) => isFinite(Number(o.bookmakerOdds)) && isFinite(Number(o.ourProbability)))
    .map((o: any) => ({
      ...o,
      ourProbability: roundN(Number(o.ourProbability), 2),
      impliedProbability: roundN(Number(o.impliedProbability), 2),
      expectedValue: roundN(Number(o.expectedValue), 2),
      edge: roundN(Number(o.edge), 2),
      kellyFraction: roundN(Number(o.kellyFraction), 2),
      suggestedStakePercent: roundN(Number(o.suggestedStakePercent), 2),
    }));

  const comboBets = (pred.comboBets ?? [])
    .filter((c: any) => Array.isArray(c?.legs) && c.legs.length >= 2)
    .map((c: any) => ({
      ...c,
      combinedOdds: roundN(Number(c.combinedOdds), 2),
      combinedProbability: roundN(Number(c.combinedProbability), 3),
      combinedEV: roundN(Number(c.combinedEV), 2),
      kellyFraction: roundN(Number(c.kellyFraction), 3),
      suggestedStakePercent: roundN(Number(c.suggestedStakePercent), 2),
      legs: (c.legs ?? []).map((leg: any) => ({
        ...leg,
        ourProbability: roundN(Number(leg.ourProbability), 2),
        impliedProbability: roundN(Number(leg.impliedProbability), 2),
        expectedValue: roundN(Number(leg.expectedValue), 2),
        kellyFraction: roundN(Number(leg.kellyFraction), 2),
        suggestedStakePercent: roundN(Number(leg.suggestedStakePercent), 2),
      })),
    }));

  const bestValueOpportunity = pred.bestValueOpportunity
    ? {
      ...pred.bestValueOpportunity,
      expectedValue: roundN(Number(pred.bestValueOpportunity.expectedValue ?? 0), 2),
      edge: roundN(Number(pred.bestValueOpportunity.edge ?? 0), 2),
      score: roundN(Number(pred.bestValueOpportunity.score ?? 0), 3),
      factorBreakdown: {
        baseModelScore: roundN(Number(pred.bestValueOpportunity.factorBreakdown?.baseModelScore ?? 0), 3),
        contextualScore: roundN(Number(pred.bestValueOpportunity.factorBreakdown?.contextualScore ?? 0), 3),
        totalScore: roundN(Number(pred.bestValueOpportunity.factorBreakdown?.totalScore ?? 0), 3),
      },
      reasons: Array.isArray(pred.bestValueOpportunity.reasons) ? pred.bestValueOpportunity.reasons : [],
    }
    : null;

  return {
    matchId: pred.matchId,
    competition: pred.competition ?? null,
    homeTeam: pred.homeTeam,
    awayTeam: pred.awayTeam,
    lambdaHome: roundN(lambdaHome, 3),
    lambdaAway: roundN(lambdaAway, 3),
    modelConfidence: Number(pred.modelConfidence ?? 0),
    richnessScore: Number(pred.richnessScore ?? pred.modelConfidence ?? 0),
    computedAt: pred.computedAt,

    goalProbabilities: {
      homeWin: Number(probs.homeWin ?? 0),
      draw: Number(probs.draw ?? 0),
      awayWin: Number(probs.awayWin ?? 0),
      btts: Number(probs.btts ?? 0),
      over05: Number(probs.over05 ?? 0),
      over15: Number(probs.over15 ?? 0),
      over25: Number(probs.over25 ?? 0),
      over35: Number(probs.over35 ?? 0),
      over45: Number(probs.over45 ?? 0),
      under15: Number(probs.under15 ?? 0),
      under25: Number(probs.under25 ?? 0),
      under35: Number(probs.under35 ?? 0),
      under45: Number(probs.under45 ?? 0),
      exactScore: probs.exactScore ?? {},
      handicap: probs.handicap ?? {},
      asianHandicap: probs.asianHandicap ?? {},
    },

    cardsPrediction: {
      totalYellow: {
        expected: roundN(totalYellowExp, 3),
        variance: roundN(totalYellowExp + (totalYellowExp * totalYellowExp) / cardsR, 3),
        distribution: yellowDist,
      },
      totalRed: {
        expected: roundN(redExp, 3),
        probAtLeastOne: roundN(1 - Math.exp(-redExp), 4),
        distribution: redDist,
      },
      overUnder: overUnderYellow,
      homeYellow: {
        expected: roundN(homeYellowExp, 3),
        over15: roundN(overFromDist(negBinDistribution(homeYellowExp, cardsR, 10), 1.5), 4),
        over25: roundN(overFromDist(negBinDistribution(homeYellowExp, cardsR, 10), 2.5), 4),
        over35: roundN(overFromDist(negBinDistribution(homeYellowExp, cardsR, 10), 3.5), 4),
      },
      awayYellow: {
        expected: roundN(awayYellowExp, 3),
        over15: roundN(overFromDist(negBinDistribution(awayYellowExp, cardsR, 10), 1.5), 4),
        over25: roundN(overFromDist(negBinDistribution(awayYellowExp, cardsR, 10), 2.5), 4),
        over35: roundN(overFromDist(negBinDistribution(awayYellowExp, cardsR, 10), 3.5), 4),
      },
      totalCardsWeighted: {
        expected: roundN(Number(cards.expectedTotalCards ?? 0), 3),
        over35: roundN(cards.overUnderTotal?.['3.5']?.over ?? 0, 4),
        over45: roundN(cards.overUnderTotal?.['4.5']?.over ?? 0, 4),
        over55: roundN(cards.overUnderTotal?.['5.5']?.over ?? 0, 4),
        over65: roundN(cards.overUnderTotal?.['6.5']?.over ?? 0, 4),
      },
      confidenceLevel: roundN(Number(pred.modelConfidence ?? 0.75), 3),
    },

    foulsPrediction: {
      totalFouls: {
        expected: roundN(totalFoulsExp, 3),
        variance: roundN(totalFoulsExp + (totalFoulsExp * totalFoulsExp) / foulsR, 3),
        distribution: foulsDist,
      },
      overUnder: overUnderFouls,
      homeFouls: { expected: roundN(homeFoulsExp, 3) },
      awayFouls: { expected: roundN(awayFoulsExp, 3) },
    },

    shotsPrediction: {
      home: {
        totalShots: {
          expected: roundN(homeShotsExp, 2),
          variance: roundN(Number(homeShotTotals.variance ?? 0), 2),
          distribution: shotsHomeDist,
        },
        shotsOnTarget: {
          expected: roundN(homeSOTExp, 2),
          variance: roundN(Number(homeShotTarget.variance ?? 0), 2),
          distribution: shotsHomeSOTDist,
        },
      },
      away: {
        totalShots: {
          expected: roundN(awayShotsExp, 2),
          variance: roundN(Number(awayShotTotals.variance ?? 0), 2),
          distribution: shotsAwayDist,
        },
        shotsOnTarget: {
          expected: roundN(awaySOTExp, 2),
          variance: roundN(Number(awayShotTarget.variance ?? 0), 2),
          distribution: shotsAwaySOTDist,
        },
      },
      combined: {
        totalShots: {
          expected: roundN(combinedShotsExp, 2),
          variance: roundN(Number(probs.shotsHome?.totalShots?.variance ?? 0) + Number(probs.shotsAway?.totalShots?.variance ?? 0), 2),
        },
        overUnder: overUnderShots,
        totalOnTarget: {
          expected: roundN(combinedSOTExp, 2),
          variance: roundN(Number(homeShotTarget.variance ?? 0) + Number(awayShotTarget.variance ?? 0), 2),
        },
        onTargetOverUnder: {
          over75: roundN(poissonOver(7.5, combinedSOTExp), 4),
          over95: roundN(poissonOver(9.5, combinedSOTExp), 4),
          over115: roundN(poissonOver(11.5, combinedSOTExp), 4),
          under75: roundN(1 - poissonOver(7.5, combinedSOTExp), 4),
          under95: roundN(1 - poissonOver(9.5, combinedSOTExp), 4),
          under115: roundN(1 - poissonOver(11.5, combinedSOTExp), 4),
        },
      },
    },

    cornersPrediction: {
      totalCorners: {
        expected: roundN(totalCornersExp, 3),
      },
      homeCorners: { expected: roundN(Number(corners.expectedHomeCorners ?? 0), 3) },
      awayCorners: { expected: roundN(Number(corners.expectedAwayCorners ?? 0), 3) },
      overUnder: overUnderCorners,
    },

    playerShotsPredictions,
    valueOpportunities,
    comboBets,
    speculativeOpportunities,
    bestValueOpportunity,
    analysisFactors: pred.analysisFactors ?? null,

    probabilities: probs,
    methodology: {
      models: {
        goals: 'Dixon-Coles (Poisson bivariata con correzione rho)',
        shots: 'Binomiale Negativa',
        cards: 'Binomiale Negativa + fattore arbitro',
        fouls: 'Binomiale Negativa + correzione possesso',
        players: 'Gerarchico (quota giocatore su tiri squadra)',
        valueBetting: 'Expected Value + Kelly frazionale',
      },
      formulas: {
        impliedProbability: 'p_imp = 1 / quota_decimale',
        expectedValue: 'EV = p_nostra * quota_decimale - 1',
        edge: 'edge = p_nostra - p_imp',
        kelly: 'f* = (b*p - q)/b, stake = 0.25 * f* (limiti min/max)',
      },
      thresholds: {
        minEvPercent: 2,
        minOdds: 1.3,
        maxOdds: 15,
        maxStakePercent: 5,
      },
      runtime: {
        lambdaHome: roundN(lambdaHome, 3),
        lambdaAway: roundN(lambdaAway, 3),
        totalShotsExpected: roundN(combinedShotsExp, 2),
        totalOnTargetExpected: roundN(combinedSOTExp, 2),
        totalYellowExpected: roundN(totalYellowExp, 2),
        totalFoulsExpected: roundN(totalFoulsExp, 2),
        cardsDispersionR: roundN(cardsR, 2),
        foulsDispersionR: roundN(foulsR, 2),
      },
      contextualFactors: pred.analysisFactors ?? null,
    },
  };
}
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
  try {
    const result = await svc.runBacktest(
      req.body.competition,
      req.body.season,
      req.body.historicalOdds,
      {
        trainRatio: req.body.trainRatio,
        confidenceLevel: req.body.confidenceLevel,
      }
    );
    res.json({ success: true, data: result });
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

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRawJson(value: unknown): any | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeShotResult(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/\s+/g, '');
}

function safePct(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

async function rebuildPlayerDerivedStats(options?: {
  competition?: string;
  season?: string;
  fromDate?: string;
  toDate?: string;
}): Promise<{
  playersMarkedUnavailable: number;
  playersDetected: number;
  playersUpdated: number;
  playedMatchesConsidered: number;
  matchesWithShotmap: number;
}> {
  const normalizedCompetition = String(options?.competition ?? '').trim();
  const matches = await db.getMatches({
    competition: normalizedCompetition || undefined,
    season: String(options?.season ?? '').trim() || undefined,
    fromDate: String(options?.fromDate ?? '').trim() || undefined,
    toDate: String(options?.toDate ?? '').trim() || undefined,
    includeRawJson: true,
  });

  type PlayerAgg = {
    playerId: string;
    sourcePlayerId: number | null;
    name: string;
    teamId: string;
    positionCode: string;
    games: Set<string>;
    minutesTotal: number;
    shots: number;
    shotsOnTarget: number;
    goals: number;
    xg: number;
    xgot: number;
    yellowCards: number;
    redCards: number;
    rawSamples: Record<string, unknown>[];
  };

  const teamShotsTotals = new Map<string, number>();
  const playersAgg = new Map<string, PlayerAgg>();
  const playedMatches = matches.filter((m: any) => m.home_goals !== null && m.away_goals !== null);
  const playersMarkedUnavailable = await db.markPlayersUnavailable(normalizedCompetition || undefined);
  let matchesWithShotmap = 0;

  const buildOnTargetMap = (shots: any[]): Map<string, { count: number; xgot: number; samples: Record<string, unknown>[] }> => {
    const out = new Map<string, { count: number; xgot: number; samples: Record<string, unknown>[] }>();
    for (const shot of shots) {
      const playerId = String(shot?.player_id ?? shot?.playerId ?? '').trim();
      if (!playerId) continue;
      const result = normalizeShotResult(shot?.result ?? shot?.eventType);
      const isOnTarget = result === 'goal' || result === 'savedshot' || result.includes('ontarget');
      if (!isOnTarget) continue;
      const current = out.get(playerId) ?? { count: 0, xgot: 0, samples: [] };
      current.count += 1;
      current.xgot += Number(numOrNull(shot?.xG ?? shot?.expectedGoals) ?? 0);
      if (current.samples.length < 5) {
        current.samples.push({
          result: shot?.result ?? shot?.eventType ?? null,
          situation: shot?.situation ?? null,
          shotType: shot?.shotType ?? shot?.bodyPart ?? null,
        });
      }
      out.set(playerId, current);
    }
    return out;
  };

  const ingestRoster = (
    rosterEntries: Record<string, any>,
    shots: any[],
    teamId: string,
    matchId: string
  ) => {
    const onTargetByPlayer = buildOnTargetMap(shots);
    for (const entry of Object.values(rosterEntries ?? {})) {
      const playerName = String((entry as any)?.player ?? (entry as any)?.playerName ?? '').trim();
      if (!playerName) continue;
      const sourcePlayerId = numOrNull((entry as any)?.player_id ?? (entry as any)?.id);
      const playerId = sourcePlayerId !== null
        ? `understat_player_${Math.trunc(sourcePlayerId)}`
        : `understat_player_${playerName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;
      const onTarget = onTargetByPlayer.get(String((entry as any)?.player_id ?? '')) ?? { count: 0, xgot: 0, samples: [] };
      const current = playersAgg.get(playerId) ?? {
        playerId,
        sourcePlayerId: sourcePlayerId === null ? null : Math.trunc(sourcePlayerId),
        name: playerName,
        teamId,
        positionCode: String((entry as any)?.position ?? 'MF').trim().split(/\s+/)[0] || 'MF',
        games: new Set<string>(),
        minutesTotal: 0,
        shots: 0,
        shotsOnTarget: 0,
        goals: 0,
        xg: 0,
        xgot: 0,
        yellowCards: 0,
        redCards: 0,
        rawSamples: [],
      };
      current.teamId = teamId;
      current.games.add(matchId);
      current.minutesTotal += Number(numOrNull((entry as any)?.time) ?? 0);
      current.shots += Number(numOrNull((entry as any)?.shots) ?? 0);
      current.shotsOnTarget += Number(onTarget.count ?? 0);
      current.goals += Number(numOrNull((entry as any)?.goals) ?? 0);
      current.xg += Number(numOrNull((entry as any)?.xG) ?? 0);
      current.xgot += Number(onTarget.xgot ?? 0);
      current.yellowCards += Number(numOrNull((entry as any)?.yellow_card) ?? 0);
      current.redCards += Number(numOrNull((entry as any)?.red_card) ?? 0);
      if (current.rawSamples.length < 8) {
        current.rawSamples.push({
          minutes: numOrNull((entry as any)?.time),
          position: (entry as any)?.position ?? null,
          yellowCard: numOrNull((entry as any)?.yellow_card),
          redCard: numOrNull((entry as any)?.red_card),
          onTargetSamples: onTarget.samples,
        });
      }
      playersAgg.set(playerId, current);
    }
  };

  for (const match of playedMatches) {
    const homeTeamId = String(match.home_team_id ?? '').trim();
    const awayTeamId = String(match.away_team_id ?? '').trim();
    if (!homeTeamId || !awayTeamId) continue;

    const homeShots = numOrNull(match.home_shots);
    const awayShots = numOrNull(match.away_shots);
    if (homeShots !== null) teamShotsTotals.set(homeTeamId, (teamShotsTotals.get(homeTeamId) ?? 0) + homeShots);
    if (awayShots !== null) teamShotsTotals.set(awayTeamId, (teamShotsTotals.get(awayTeamId) ?? 0) + awayShots);

    const raw = parseRawJson(match.raw_json);
    const homeRosters = raw?.details?.rosters?.h ?? {};
    const awayRosters = raw?.details?.rosters?.a ?? {};
    const homeShotsDetail = Array.isArray(raw?.details?.shots?.h) ? raw.details.shots.h : [];
    const awayShotsDetail = Array.isArray(raw?.details?.shots?.a) ? raw.details.shots.a : [];
    if (homeShotsDetail.length > 0 || awayShotsDetail.length > 0) matchesWithShotmap++;

    ingestRoster(homeRosters, homeShotsDetail, homeTeamId, String(match.match_id));
    ingestRoster(awayRosters, awayShotsDetail, awayTeamId, String(match.match_id));
  }

  let playersUpdated = 0;
  for (const [, player] of playersAgg) {
    const games = Math.max(1, player.games.size);
    const minutesBase = player.minutesTotal > 0 ? player.minutesTotal : games * 90;
    const teamShotsTotal = Math.max(1, Number(teamShotsTotals.get(player.teamId) ?? 0));

    await db.upsertPlayer({
      playerId: player.playerId,
      sourcePlayerId: player.sourcePlayerId,
      name: player.name,
      teamId: player.teamId,
      positionCode: player.positionCode,
      avgShotsPerGame: player.shots / games,
      avgShotsOnTargetPerGame: player.shotsOnTarget / games,
      avgXGPerGame: player.xg / games,
      avgXGOTPerGame: player.xgot / games,
      totalGoals: player.goals,
      totalShots: player.shots,
      totalShotsOnTarget: player.shotsOnTarget,
      minutesTotal: player.minutesTotal,
      avgMinutes: player.minutesTotal > 0 ? player.minutesTotal / games : 0,
      shotsPer90: minutesBase > 0 ? (player.shots / minutesBase) * 90 : 0,
      shotsOnTargetPer90: minutesBase > 0 ? (player.shotsOnTarget / minutesBase) * 90 : 0,
      xgPer90: minutesBase > 0 ? (player.xg / minutesBase) * 90 : 0,
      shotOnTargetPct: safePct(player.shotsOnTarget, player.shots),
      goalConversion: safePct(player.goals, player.shots),
      yellowCardsTotal: player.yellowCards,
      redCardsTotal: player.redCards,
      cardsPer90: minutesBase > 0 ? ((player.yellowCards + player.redCards) / minutesBase) * 90 : 0,
      shotShareOfTeam: player.shots / teamShotsTotal,
      gamesPlayed: games,
      isAvailable: true,
      statsJson: JSON.stringify({
        source: 'recompute_from_matches_raw',
        filters: {
          competition: normalizedCompetition || null,
          season: String(options?.season ?? '').trim() || null,
          fromDate: String(options?.fromDate ?? '').trim() || null,
          toDate: String(options?.toDate ?? '').trim() || null,
        },
        playedMatchesConsidered: playedMatches.length,
        matchesWithShotmap,
        totalXG: player.xg,
        totalXGOT: player.xgot,
        minutesTotal: player.minutesTotal,
        yellowCardsTotal: player.yellowCards,
        redCardsTotal: player.redCards,
        rawSamples: player.rawSamples.slice(0, 8),
      }),
    });
    playersUpdated++;
  }

  return {
    playersMarkedUnavailable,
    playersDetected: playersAgg.size,
    playersUpdated,
    playedMatchesConsidered: playedMatches.length,
    matchesWithShotmap,
  };
}

async function rebuildRefereeDerivedStats(options?: {
  competition?: string;
  season?: string;
  fromDate?: string;
  toDate?: string;
  names?: string[];
}): Promise<{ refereesDetected: number; refereesUpdated: number; matchesConsidered: number }> {
  const matches = await db.getMatches({
    competition: String(options?.competition ?? '').trim() || undefined,
    season: String(options?.season ?? '').trim() || undefined,
    fromDate: String(options?.fromDate ?? '').trim() || undefined,
    toDate: String(options?.toDate ?? '').trim() || undefined,
  });
  const targetNames = new Set((options?.names ?? []).map((name) => String(name ?? '').trim().toLowerCase()).filter(Boolean));
  const playedMatches = matches.filter((m: any) =>
    m.home_goals !== null
    && m.away_goals !== null
    && String(m.referee ?? '').trim().length > 0
    && (targetNames.size === 0 || targetNames.has(String(m.referee ?? '').trim().toLowerCase()))
  );

  const aggregates = new Map<string, {
    name: string;
    games: number;
    foulsTotal: number;
    foulsGames: number;
    yellowTotal: number;
    yellowGames: number;
    redTotal: number;
    redGames: number;
    yellowSamples: number[];
  }>();

  for (const match of playedMatches) {
    const name = String(match.referee ?? '').trim();
    if (!name) continue;
    const current = aggregates.get(name) ?? {
      name,
      games: 0,
      foulsTotal: 0,
      foulsGames: 0,
      yellowTotal: 0,
      yellowGames: 0,
      redTotal: 0,
      redGames: 0,
      yellowSamples: [],
    };
    current.games += 1;

    const totalFouls =
      numOrNull(match.home_fouls) !== null && numOrNull(match.away_fouls) !== null
        ? Number(match.home_fouls) + Number(match.away_fouls)
        : null;
    if (totalFouls !== null) {
      current.foulsTotal += totalFouls;
      current.foulsGames += 1;
    }

    const totalYellow =
      numOrNull(match.home_yellow_cards) !== null && numOrNull(match.away_yellow_cards) !== null
        ? Number(match.home_yellow_cards) + Number(match.away_yellow_cards)
        : null;
    if (totalYellow !== null) {
      current.yellowTotal += totalYellow;
      current.yellowGames += 1;
      current.yellowSamples.push(totalYellow);
    }

    const totalRed =
      numOrNull(match.home_red_cards) !== null && numOrNull(match.away_red_cards) !== null
        ? Number(match.home_red_cards) + Number(match.away_red_cards)
        : null;
    if (totalRed !== null) {
      current.redTotal += totalRed;
      current.redGames += 1;
    }

    aggregates.set(name, current);
  }

  let refereesUpdated = 0;
  for (const [, referee] of aggregates) {
    const yellowMean = referee.yellowGames > 0 ? referee.yellowTotal / referee.yellowGames : 0;
    const variance = referee.yellowSamples.length > 0
      ? referee.yellowSamples.reduce((sum, sample) => sum + ((sample - yellowMean) ** 2), 0) / referee.yellowSamples.length
      : 0;
    await db.upsertReferee({
      name: referee.name,
      avgFouls: referee.foulsGames > 0 ? referee.foulsTotal / referee.foulsGames : undefined,
      avgYellow: referee.yellowGames > 0 ? yellowMean : undefined,
      avgRed: referee.redGames > 0 ? referee.redTotal / referee.redGames : undefined,
      games: referee.games,
      dispersionYellow: Math.sqrt(Math.max(0, variance)),
    });
    refereesUpdated++;
  }

  return {
    refereesDetected: aggregates.size,
    refereesUpdated,
    matchesConsidered: playedMatches.length,
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

async function recomputeTeamAveragesForMatchRows(rows: Array<{ home_team_id?: string | null; away_team_id?: string | null }>): Promise<number> {
  const teamIds = Array.from(
    new Set(
      rows.flatMap((row) => [
        String(row?.home_team_id ?? '').trim(),
        String(row?.away_team_id ?? '').trim(),
      ]).filter(Boolean)
    )
  );
  let recomputed = 0;
  for (const teamId of teamIds) {
    await db.recomputeTeamAverages(teamId);
    recomputed += 1;
  }
  return recomputed;
}

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
        ? await recomputeTeamAveragesForMatchRows(updatedCompletedRows)
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
      const playerStats = await rebuildPlayerDerivedStats({ competition: comp });
      playersMarkedUnavailable += playerStats.playersMarkedUnavailable;
      playersDerivedDetected += playerStats.playersDetected;
      playersDerivedUpdated += playerStats.playersUpdated;
      playersDerivedMatches += playerStats.playedMatchesConsidered;
      playerMatchesWithShotmap += playerStats.matchesWithShotmap;

      const refereeStats = await rebuildRefereeDerivedStats({ competition: comp });
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
  lastSmokeRun: EurobetSmokeRunSummary | null;
  warningCount: number;
  errorCategory: string | null;
  lastDurationMs: number | null;
};

const matchOddsCache = new Map<string, { cachedAt: number; data: any }>();
const matchOddsInFlight = new Map<string, Promise<any>>();
const DEFAULT_MATCH_ODDS_CACHE_TTL_MS = 3 * 60 * 1000;
const DEFAULT_EUROBET_MATCH_TIMEOUT_MS = 7 * 1000;

const parsePositiveIntEnv = (name: string, fallback: number): number => {
  const raw = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

const getMatchOddsCacheTtlMs = (): number =>
  parsePositiveIntEnv('ODDS_MATCH_CACHE_TTL_SECONDS', Math.floor(DEFAULT_MATCH_ODDS_CACHE_TTL_MS / 1000)) * 1000;

const getEurobetMatchTimeoutMs = (): number =>
  parsePositiveIntEnv('EUROBET_MATCH_TIMEOUT_MS', DEFAULT_EUROBET_MATCH_TIMEOUT_MS);

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
  lastSmokeRun: readLastEurobetSmokeRun(),
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

const getPrimaryEurobetMatch = (matches: CoordinatedOddsMatch[]): EurobetOddsMatch | null => {
  for (const entry of matches) {
    const eurobetMatch = entry.providerMatches.eurobet as EurobetOddsMatch | undefined;
    if (eurobetMatch?.meetingAlias) return eurobetMatch;
  }
  return null;
};

const countMatchesWithBaseOdds = (matches: CoordinatedOddsMatch[]): number =>
  matches.filter((entry) => Object.keys(entry.bestOddsByProvider.eurobet ?? {}).length > 0).length;

const countMatchesWithExtendedGroups = (matches: CoordinatedOddsMatch[]): number =>
  matches.filter((entry) => {
    const eurobetMatch = entry.providerMatches.eurobet as EurobetOddsMatch | undefined;
    return Boolean(eurobetMatch?.loadedGroupAliases?.some((alias) => alias !== 'base'));
  }).length;

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
  eurobetOdds: Record<string, number>,
  estimatedOdds: Record<string, number>
): {
  eurobetPresent: boolean;
  liveDomains: Record<string, number>;
  eurobetDomains: Record<string, number>;
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
    eurobetPresent: Object.keys(eurobetOdds ?? {}).length > 0,
    liveDomains: countDomains(liveSelectedOdds),
    eurobetDomains: countDomains(eurobetOdds),
    syntheticDomains: countDomains(estimatedOdds),
    providerNotes: [
      'The Odds API al momento non espone in modo affidabile mercati squadra live su tiri e falli per bookmaker EU.',
      'Corners e cards vengono richiesti come mercati live dedicati, ma dipendono dalla copertura reale del bookmaker sul singolo evento.',
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
  eurobetOdds?: Record<string, number>;
  estimatedOdds?: Record<string, number>;
  fallbackOdds?: Record<string, number>;
  allBookmakerOdds?: Record<string, Record<string, number>>;
  marketsRequested?: string[];
  usedFallbackBookmaker?: boolean;
  usedSyntheticOdds?: boolean;
  confidenceScore?: number;
}): Promise<{ saved: boolean; matchId: string | null }> => {
  const liveSelectedOdds = sanitizeOddsMap(input.liveSelectedOdds ?? {});
  const eurobetOdds = sanitizeOddsMap(input.eurobetOdds ?? {});
  if (Object.keys(liveSelectedOdds).length === 0 && Object.keys(eurobetOdds).length === 0) {
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
    eurobetOdds,
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

const resolveTeamForModel = async (teamName: string, competition?: string): Promise<{ teamId: string; score: number } | null> => {
  const byCompetition = competition ? await db.getTeams(competition) : [];
  const allTeams = await db.getTeams();
  const pool = byCompetition.length > 0 ? byCompetition : allTeams;

  let best: any = null;
  let bestScore = -1;
  for (const t of pool) {
    const candidateName = String(t.name ?? t.team_id ?? '');
    const score = teamSimilarity(teamName, candidateName);
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }

  if (!best || bestScore < 0.72) return null;
  return { teamId: String(best.team_id), score: Number(bestScore.toFixed(3)) };
};

const buildModelEstimatedOdds = async (
  competition: string,
  homeTeamName: string,
  awayTeamName: string
): Promise<{
  found: boolean;
  message: string;
  selectedOdds: Record<string, number>;
  usedFallbackBookmaker: boolean;
  usedSyntheticOdds: boolean;
  source: string;
  confidenceScore?: number;
  match?: { homeTeam: string; awayTeam: string };
}> => {
  const home = (await resolveTeamForModel(homeTeamName, competition)) ?? (await resolveTeamForModel(homeTeamName));
  const away = (await resolveTeamForModel(awayTeamName, competition)) ?? (await resolveTeamForModel(awayTeamName));

  if (!home || !away) {
    return {
      found: false,
      message: 'Impossibile associare le squadre ai dati interni: quote automatiche non disponibili per questo match.',
      selectedOdds: {},
      usedFallbackBookmaker: true,
      usedSyntheticOdds: true,
      source: 'model_estimated',
    };
  }
  if (home.teamId === away.teamId) {
    return {
      found: false,
      message: 'Associazione squadre ambigua: impossibile stimare quote affidabili.',
      selectedOdds: {},
      usedFallbackBookmaker: true,
      usedSyntheticOdds: true,
      source: 'model_estimated',
    };
  }

  const pred = await svc.predict({
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    competition,
  });

  const modelProbs = collectModelProbabilitiesForOdds(pred);
  const estimatedOdds: Record<string, number> = {};
  for (const [selection, prob] of Object.entries(modelProbs)) {
    estimatedOdds[selection] = probabilityToOdds(prob, marketOverround(selection));
  }
  const baseOdds = sanitizeOddsMap(estimatedOdds);

  if (Object.keys(baseOdds).length === 0) {
    return {
      found: false,
      message: 'Il modello non ha prodotto quote valide per questa partita.',
      selectedOdds: {},
      usedFallbackBookmaker: true,
      usedSyntheticOdds: true,
      source: 'model_estimated',
      confidenceScore: Number(((home.score + away.score) / 2).toFixed(3)),
    };
  }

  return {
    found: true,
    message: 'Quote live non disponibili: caricate quote stimate dal modello interno (non quote live bookmaker).',
    selectedOdds: baseOdds,
    usedFallbackBookmaker: true,
    usedSyntheticOdds: true,
    source: 'model_estimated',
    confidenceScore: Number(((home.score + away.score) / 2).toFixed(3)),
    match: {
      homeTeam: homeTeamName,
      awayTeam: awayTeamName,
    },
  };
};

router.post('/scraper/odds', async (req: Request, res: Response) => {
  try {
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    const requestId = String(res.locals?.requestId ?? '');
    const runId = observability?.createRunId('odds_bulk') ?? `odds_bulk_${startedAtMs}`;

    const {
      competition = 'Serie A',
      markets = ['h2h', 'totals', 'spreads', 'alternate_totals', 'btts', 'double_chance', 'draw_no_bet'],
    } = req.body;

    const normalizedMarkets =
      Array.isArray(markets) && markets.length > 0
        ? markets.map((m: unknown) => String(m)).filter(Boolean)
        : ['h2h', 'totals', 'spreads', 'alternate_totals', 'btts', 'double_chance', 'draw_no_bet'];
    const {
      coordinator,
      primaryProviderName,
      fallbackProviderName,
      apiKey,
      skipEurobet,
    } = createOddsProviderCoordinatorBundle();
    if (!apiKey && skipEurobet) {
      return res.status(503).json({
        success: false,
        error: 'Eurobet disabilitato e ODDS_API_KEY non configurata sul server.',
      });
    }

    const eurobetFixtures = !skipEurobet
      ? (
        await db.getUpcomingMatches({
          competition: String(competition),
          limit: 40,
        })
      )
        .map((match: any) => ({
          homeTeam: String(match.home_team_name ?? ''),
          awayTeam: String(match.away_team_name ?? ''),
          commenceTime: match.date ? String(match.date) : null,
        }))
        .filter((match: any) => match.homeTeam && match.awayTeam)
      : [];

    const coordination = await withTimeout(
      coordinator.getCompetitionOdds(
        {
          competition: String(competition),
          fixtures: eurobetFixtures,
          markets: normalizedMarkets,
          fallbackMarkets: Array.from(
            new Set([
              ...normalizedMarkets,
              'alternate_totals',
              'btts',
              'double_chance',
              'draw_no_bet',
            ])
          ),
          includeExtendedGroups: false,
        },
        { mergeMarkets: false, useFallback: true }
      ),
      60_000,
      'Coordinated bulk odds lookup'
    );

    const primaryEurobetMatch = getPrimaryEurobetMatch(coordination.matches);
    const matchesWithBaseOdds = countMatchesWithBaseOdds(coordination.matches);
    const matchesWithExtendedGroups = countMatchesWithExtendedGroups(coordination.matches);
    const errorCategory = detectProviderErrorCategory(
      coordination.providerHealth,
      coordination.warnings,
      coordination.fallbackReason
    );
    const durationMs = Date.now() - startedAtMs;
    const fallbackUsed = coordination.matches.some((entry) => entry.oddsSource !== 'eurobet')
      || Boolean(coordination.fallbackReason);
    const sourceUsed = coordination.matches.length > 0
      ? coordination.matches[0].oddsSource
      : (skipEurobet ? 'odds_api' : 'eurobet');
    const marketCount = coordination.matches.reduce((sum, entry) => sum + countMatchMarkets(entry.match), 0);

    if (coordination.matches.length === 0 && !apiKey) {
      await observability?.recordProviderRun({
        requestId,
        runId,
        provider: skipEurobet ? 'odds_api' : 'eurobet',
        competition: String(competition),
        meetingAlias: primaryEurobetMatch?.meetingAlias ?? null,
        sourceUsed,
        matchCount: 0,
        marketCount,
        fixtureCount: eurobetFixtures.length,
        matchesWithBaseOdds,
        matchesWithExtendedGroups,
        durationMs,
        success: false,
        fallbackUsed,
        fallbackReason: coordination.fallbackReason ?? 'Eurobet non disponibile e fallback non configurato',
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
        error: 'Eurobet non disponibile e ODDS_API_KEY non configurata sul server.',
        providerHealth: coordination.providerHealth,
        fetchedAt: coordination.fetchedAt,
        warnings: coordination.warnings,
      });
    }

    const enriched = coordination.matches.map((entry: CoordinatedOddsMatch) => {
      const eurobetOdds = entry.bestOddsByProvider.eurobet ?? {};
      const fallbackBestOdds = entry.bestOddsByProvider.odds_api ?? {};
      const bestOdds = Object.keys(eurobetOdds).length > 0 ? eurobetOdds : fallbackBestOdds;
      const source = entry.oddsSource === 'eurobet'
        ? 'eurobet_scraper'
        : entry.oddsSource === 'odds_api'
          ? 'the_odds_api_fallback'
          : 'eurobet_plus_odds_api';

      return {
        homeTeam: entry.match.homeTeam,
        awayTeam: entry.match.awayTeam,
        commenceTime: entry.match.commenceTime,
        eurobetOdds,
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
        const eurobetOdds = entry.bestOddsByProvider.eurobet ?? {};
        const liveSelectedOdds = entry.bestOddsByProvider.odds_api ?? eurobetOdds;
        const eurobetMatch = entry.providerMatches.eurobet as EurobetOddsMatch | undefined;
        const oddsProviderMatchId = eurobetMatch?.eventAlias
          ?? String(entry.match.matchId ?? '').replace(/^odds_/, '');
        const snapshot = await persistOddsSnapshot({
          oddsProviderMatchId,
          competition: String(competition),
          homeTeamName: entry.match.homeTeam,
          awayTeamName: entry.match.awayTeam,
          commenceTime: entry.match.commenceTime,
          source: Object.keys(liveSelectedOdds).some((k) => eurobetOdds[k] === undefined)
            ? 'the_odds_api_bulk_fallback_bookmaker'
            : 'eurobet_scraper_bulk',
          selectedOdds: liveSelectedOdds,
          liveSelectedOdds,
          eurobetOdds,
          estimatedOdds: {},
          fallbackOdds: liveSelectedOdds,
          allBookmakerOdds: flattenProviderComparisons(entry.bookmakerComparisonByProvider),
          marketsRequested: normalizedMarkets,
          usedFallbackBookmaker: Object.keys(liveSelectedOdds).some((k) => eurobetOdds[k] === undefined),
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
      lastSmokeRun: readLastEurobetSmokeRun(),
      warningCount: coordination.warnings.length,
      errorCategory,
      lastDurationMs: durationMs,
    };

    const topLevelSource = coordination.matches.length > 0
      ? coordination.matches[0].oddsSource === 'eurobet'
        ? 'eurobet_scraper'
        : coordination.matches[0].oddsSource === 'odds_api'
          ? 'the_odds_api_fallback'
          : 'eurobet_plus_odds_api'
      : primaryProviderName;

    await observability?.recordProviderRun({
      requestId,
      runId,
      provider: skipEurobet ? 'odds_api' : 'eurobet',
      competition: String(competition),
      meetingAlias: primaryEurobetMatch?.meetingAlias ?? null,
      sourceUsed,
      matchCount: coordination.matches.length,
      marketCount,
      fixtureCount: eurobetFixtures.length,
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
        lastSmokeRun: oddsRuntimeState.lastSmokeRun,
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
  try {
    const startedAtMs = Date.now();
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

    const work = (async () => {
      const {
        coordinator,
        primaryProviderName,
        skipEurobet,
      } = createOddsProviderCoordinatorBundle();
      const estimatedPromise = buildModelEstimatedOdds(String(competition), String(homeTeam), String(awayTeam));

      const preferredMarkets = ['h2h', 'totals', 'spreads'];
      const fallbackMarkets = ['h2h', 'totals', 'spreads', 'alternate_totals', 'btts', 'double_chance', 'draw_no_bet'];
      const eventAdditionalMarkets = [
        'btts',
        'draw_no_bet',
        'h2h_3_way',
        'double_chance',
        'team_totals',
        'alternate_totals',
        'alternate_totals_corners',
        'alternate_totals_cards',
        'alternate_spreads',
        'alternate_spreads_corners',
        'alternate_spreads_cards',
        'alternate_team_totals',
      ];
      const coordination = await withTimeout(
        coordinator.getOddsForFixtures(
          {
            competition: String(competition),
            fixtures: [{
              homeTeam: String(homeTeam),
              awayTeam: String(awayTeam),
              commenceTime: commenceTime ? String(commenceTime) : null,
            }],
            markets: preferredMarkets,
            fallbackMarkets,
            extraEventMarkets: eventAdditionalMarkets,
            includeExtendedGroups: false,
          },
          { mergeMarkets: true, useFallback: true }
        ),
        getEurobetMatchTimeoutMs(),
        'Coordinated match odds lookup'
      );

      const coordinatedMatch = coordination.matches[0] ?? null;
      const primaryEurobetMatch = getPrimaryEurobetMatch(coordination.matches);
      const matchesWithBaseOdds = countMatchesWithBaseOdds(coordination.matches);
      const matchesWithExtendedGroups = countMatchesWithExtendedGroups(coordination.matches);
      const errorCategory = detectProviderErrorCategory(
        coordination.providerHealth,
        coordination.warnings,
        coordination.fallbackReason
      );
      const durationMs = Date.now() - startedAtMs;
      const fallbackUsed = coordination.matches.some((entry) => entry.oddsSource !== 'eurobet')
        || Boolean(coordination.fallbackReason);
      const sourceUsed = coordinatedMatch?.oddsSource ?? (skipEurobet ? 'odds_api' : 'eurobet');
      const marketCount = coordinatedMatch ? countMatchMarkets(coordinatedMatch.match) : 0;
      const responseMatch = coordinatedMatch?.match ?? null;
      const confidenceScore = responseMatch
        ? Number(matchScore(responseMatch, String(homeTeam), String(awayTeam), commenceTime ? String(commenceTime) : undefined).toFixed(3))
        : 0;

      if (!coordinatedMatch) {
        const estimated = await estimatedPromise;
        await observability?.recordProviderRun({
          requestId,
          runId,
          provider: skipEurobet ? 'odds_api' : 'eurobet',
          competition: String(competition),
          meetingAlias: primaryEurobetMatch?.meetingAlias ?? null,
          sourceUsed,
          matchCount: 0,
          marketCount,
          fixtureCount: 1,
          matchesWithBaseOdds,
          matchesWithExtendedGroups,
          durationMs,
          success: false,
          fallbackUsed,
          fallbackReason: coordination.fallbackReason ?? 'Nessun match trovato per la fixture richiesta',
          warningCount: coordination.warnings.length,
          warnings: coordination.warnings,
          errorCategory: errorCategory ?? 'fixture_matching_failed',
          providerHealth: coordination.providerHealth,
          metadata: {
            homeTeam: String(homeTeam),
            awayTeam: String(awayTeam),
            commenceTime: commenceTime ? String(commenceTime) : null,
            remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
          },
          startedAt: startedAtIso,
          endedAt: new Date().toISOString(),
        });
        return {
          found: false,
          message: 'Quote Eurobet non disponibili per questa partita al momento.',
          source: 'eurobet_unavailable',
          oddsSource: 'unavailable',
          primaryProvider: primaryProviderName,
          activeProvider: null,
          fallbackReason: coordination.fallbackReason,
          providerHealth: coordination.providerHealth,
          fetchedAt: coordination.fetchedAt,
          isMerged: coordination.isMerged,
          freshnessMinutes: minutesSince(coordination.fetchedAt),
          lastSmokeRun: readLastEurobetSmokeRun(),
          selectedOdds: {},
          eurobetOdds: {},
          fallbackOdds: {},
          allBookmakerOdds: {},
          oddsCoverage: summarizeOddsCoverage({}, {}, estimated.found ? estimated.selectedOdds : {}),
          usedFallbackBookmaker: false,
          usedSyntheticOdds: false,
          bestScore: confidenceScore,
          marketsRequested: ['eurobet_only'],
          remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
          warnings: coordination.warnings,
        };
      }

      const eurobetMatch = coordinatedMatch.providerMatches.eurobet as EurobetOddsMatch | undefined;
      const eurobetOdds = coordinatedMatch.bestOddsByProvider.eurobet ?? {};
      const providerFallbackOdds = coordinatedMatch.bestOddsByProvider.odds_api ?? {};

      const liveSelectedOdds = sanitizeOddsMap(eurobetOdds);
      const estimated = await estimatedPromise;
      const estimatedOdds = estimated.found ? estimated.selectedOdds : {};
      const selectedOdds = liveSelectedOdds;
      const fallbackOdds = sanitizeOddsMap(providerFallbackOdds);
      const oddsCoverage = summarizeOddsCoverage(
        sanitizeOddsMap({ ...providerFallbackOdds, ...eurobetOdds }),
        eurobetOdds,
        estimatedOdds
      );
      const missingEurobetSelectionsFromFallback = Object.keys(providerFallbackOdds)
        .filter((selection) => eurobetOdds[selection] === undefined);
      const missingEurobetSelectionsFromModel = Object.keys(estimatedOdds)
        .filter((selection) => eurobetOdds[selection] === undefined);
      const usedFallbackBookmaker = false;
      const usedSyntheticOdds = false;
      const source = Object.keys(eurobetOdds).length > 0 ? 'eurobet_scraper' : 'eurobet_unavailable';
      const eurobetRequested = eurobetMatch
        ? ['eurobet_event_base', ...eurobetMatch.loadedGroupAliases.filter((alias) => alias !== 'base').map((alias) => `eurobet:${alias}`)]
        : [];
      const finalMarketsRequested = Array.from(new Set([
        ...eurobetRequested,
        ...preferredMarkets,
        ...fallbackMarkets,
        ...Object.keys(coordinatedMatch.marketSources),
      ]));

      const allBookmakerOdds = flattenProviderComparisons(coordinatedMatch.bookmakerComparisonByProvider);

      let historicalSnapshotSaved = false;
      let snapshotMatchId: string | null = null;
      try {
        const oddsProviderMatchId = eurobetMatch?.eventAlias
          ?? (String(coordinatedMatch.providerMatches.odds_api?.matchId ?? '').replace(/^odds_/, '') || null);
        const snapshot = await persistOddsSnapshot({
          matchId: String(matchId ?? '').trim() || null,
          oddsProviderMatchId,
          competition: String(competition),
          homeTeamName: responseMatch.homeTeam,
          awayTeamName: responseMatch.awayTeam,
          commenceTime: responseMatch.commenceTime,
          source,
          selectedOdds,
          liveSelectedOdds,
          eurobetOdds,
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
      if (missingEurobetSelectionsFromFallback.length > 0) {
        providerNotes.push('Sono disponibili quote da bookmaker alternativi, ma vengono nascoste per mostrare solo quote Eurobet.');
      }
      if (missingEurobetSelectionsFromModel.length > 0) {
        providerNotes.push('Le selezioni senza quota Eurobet non vengono completate dal modello.');
      }
      if (eurobetMatch?.unavailableGroupAliases?.includes('statistiche-partita')) {
        providerNotes.push('Eurobet ha restituito i mercati base, ma il gruppo statistiche partita non era disponibile in questa sessione di scraping.');
      }

      await observability?.recordProviderRun({
        requestId,
        runId,
        provider: skipEurobet ? 'odds_api' : 'eurobet',
        competition: String(competition),
        meetingAlias: primaryEurobetMatch?.meetingAlias ?? null,
        sourceUsed,
        matchCount: 1,
        marketCount,
        fixtureCount: 1,
        matchesWithBaseOdds,
        matchesWithExtendedGroups,
        durationMs,
        success: Object.keys(selectedOdds).length > 0 || Object.keys(eurobetOdds).length > 0,
        fallbackUsed,
        fallbackReason: coordinatedMatch.fallbackReason ?? coordination.fallbackReason,
        warningCount: coordination.warnings.length,
        warnings: coordination.warnings,
        errorCategory,
        providerHealth: coordination.providerHealth,
        metadata: {
          homeTeam: responseMatch.homeTeam,
          awayTeam: responseMatch.awayTeam,
          commenceTime: responseMatch.commenceTime,
          remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
          requestedMarkets: finalMarketsRequested,
          historicalSnapshotSaved,
          snapshotMatchId,
          confidenceScore,
        },
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
      });

      return {
        found: Object.keys(selectedOdds).length > 0,
        message: Object.keys(selectedOdds).length > 0
          ? 'Quote reali Eurobet caricate.'
          : 'Quote Eurobet non disponibili per questa partita al momento.',
        usedFallbackBookmaker,
        usedSyntheticOdds,
        source,
        oddsSource: coordinatedMatch.oddsSource,
        primaryProvider: primaryProviderName,
        activeProvider: coordinatedMatch.oddsSource.includes('+')
          ? primaryProviderName
          : coordinatedMatch.oddsSource,
        fallbackReason: coordinatedMatch.fallbackReason ?? coordination.fallbackReason,
        providerHealth: coordination.providerHealth,
        fetchedAt: coordinatedMatch.fetchedAt,
        isMerged: coordinatedMatch.isMerged,
        freshnessMinutes: minutesSince(coordinatedMatch.fetchedAt),
        lastSmokeRun: readLastEurobetSmokeRun(),
        selectedOdds,
        eurobetOdds,
        fallbackOdds,
        allBookmakerOdds,
        oddsCoverage: {
          ...oddsCoverage,
          providerNotes,
        },
        marketsRequested: finalMarketsRequested,
        match: {
          homeTeam: responseMatch.homeTeam,
          awayTeam: responseMatch.awayTeam,
          commenceTime: responseMatch.commenceTime,
        },
        historicalSnapshotSaved,
        snapshotMatchId,
        confidenceScore,
        remainingRequests: coordination.providerRuntime.odds_api?.remainingRequests ?? null,
        warnings: coordination.warnings,
        marketSources: coordinatedMatch.marketSources,
      };
    })();

    matchOddsInFlight.set(cacheKey, work);
    const payload = await work;
    setCachedMatchOddsPayload(cacheKey, payload);
    console.info(`[OddsApi/match] Completed in ${Date.now() - startedAtMs}ms for ${String(homeTeam)} vs ${String(awayTeam)}`);
    return res.json({ success: true, data: payload });
  } catch (e: any) {
    const caughtAt = new Date().toISOString();
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
      fallbackReason: e?.message ?? 'Unknown match odds error',
      warningCount: 0,
      warnings: [],
      errorCategory: detectProviderErrorCategory({}, [String(e?.message ?? '')], null) ?? 'match_odds_failed',
      providerHealth: {},
      metadata: {
        homeTeam: String(req.body?.homeTeam ?? ''),
        awayTeam: String(req.body?.awayTeam ?? ''),
        commenceTime: req.body?.commenceTime ? String(req.body.commenceTime) : null,
      },
      startedAt: caughtAt,
      endedAt: caughtAt,
    });
    console.error('[OddsApi/match] Errore:', e.message);
    return res.status(500).json({ success: false, error: e.message });
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

router.get('/scraper/odds/status', (_req, res) => {
  const lastSmokeRun = readLastEurobetSmokeRun();
  res.json({
    success: true,
    data: {
      ...oddsRuntimeState,
      primaryProvider: oddsRuntimeState.primaryProvider || getConfiguredPrimaryProviderName(),
      freshnessMinutes: oddsRuntimeState.fetchedAt ? minutesSince(oddsRuntimeState.fetchedAt) : oddsRuntimeState.freshnessMinutes,
      lastSmokeRun,
    },
  });
});

router.get('/scraper/odds/info', (_req, res) => {
  res.json({
    success: true,
    data: {
      competitions: EurobetOddsService.getSupportedCompetitions(),
      bookmakers: ['eurobet', ...OddsApiService.getSupportedBookmakers()],
      freePlanLimit: 500,
      registrationUrl: 'https://the-odds-api.com',
      primaryProvider: getConfiguredPrimaryProviderName(),
      fallbackProvider: getConfiguredOddsApiKey() ? 'odds_api' : null,
      note: 'Eurobet e la sorgente primaria. Il provider secondario resta un fallback tecnico interno per continuita operativa e diagnostica.',
    }
  });
});


return router;
}

export default createApiRouter;


