import { Router, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { PredictionService } from '../services/PredictionService';
import { DatabaseService, MatchBatchCommitError } from '../db/DatabaseService';
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
import { buildBacktestReport } from '../services/BacktestReportService';
import { SystemObservabilityService } from '../services/SystemObservabilityService';
import { UnderstatScraper, hasValidUnderstatMatchDetails } from '../services/UnderstatScraper';
import { HeavyJobBusyError, HeavyJobService } from '../services/HeavyJobService';
import { formatPrediction, poissonOver } from './predictionPayloadFormatter';
import { clamp } from '../models/utils/MathUtils';
import { rebuildRefereeDerivedStats } from '../services/RefereeDerivedStatsService';
import { rebuildPlayerDerivedStats } from '../services/PlayerDerivedStatsService';
import { ApiFootballService } from '../services/ApiFootballService';
import {
  assessPlayerLineup,
  buildPredictedLineup,
  completeOfficialTeamIds,
  extractOfficialLineupHistory,
  retainCompleteOfficialLineupRows,
} from '../services/PlayerLineupProbabilityService';
import { normalizePlayerNameForProp } from '../services/playerProps';
import {
  automatedSavedDecisionId,
  planAutomatedBetOpportunities,
} from '../services/AutomatedBetPlanningService';
import { buildCoherentBookmakerOddsBundle } from '../services/BookmakerOddsSelectionService';
import { hasCurrentMatchMarketCoverage, MATCH_EVENT_ADDITIONAL_MARKETS } from '../services/OddsMarketPolicy';
import {
  syncFootballData,
  createLibsqlFootballDataDb,
  pruneOldSeasons,
  buildSeasonWindow,
  DEFAULT_SEASON_RETENTION_COUNT,
  FOOTBALL_DATA_LEAGUE_CODES,
  FOOTBALL_DATA_TRANSITION_LEAGUE_CODES,
  syncTransitionSeasonReferences,
} from '../services/FootballDataService';

const UNDERSTAT_DETAIL_CONCURRENCY = Math.max(
  2,
  Math.min(Number(process.env.UNDERSTAT_DETAIL_CONCURRENCY ?? 10), 24)
);

class AutomationAuditError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AutomationAuditError';
    (this as any).cause = cause;
  }
}

class AutomationPlacementUnknownError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'AutomationPlacementUnknownError';
    (this as any).cause = cause;
  }
}

function isAlreadyPlacedBetError(error: unknown): boolean {
  return String((error as any)?.message ?? error)
    .trim()
    .toLocaleLowerCase('it-IT') === 'scommessa gia fatta';
}

export type ApiRouterDependencies = {
  db: DatabaseService;
  svc?: PredictionService;
  observability?: SystemObservabilityService;
  sharedDataUserId?: string;
  internalAccessToken?: string;
  getInternalApiBaseUrl?: () => string;
  createOddsProviderCoordinatorBundle?: () => OddsProviderCoordinatorBundle;
  createOddsApiKickoffSyncService?: (db: DatabaseService) => Pick<
    OddsApiKickoffSyncService,
    'syncUpcomingKickoffsFromOddsApi' | 'syncSingleMatchKickoffFromOddsApi'
  >;
  heavyJobService?: Pick<HeavyJobService, 'runWalkForwardBacktest'>;
  apiFootballService?: Pick<
    ApiFootballService,
    'enabled' | 'getConfirmedLineups' | 'getFixturesByDate' | 'getSquad' | 'getInjuries'
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

const UNDERSTAT_UPSERT_COMPARISON_FIELDS: Array<[string, string]> = [
  ['homeTeamId', 'home_team_id'], ['awayTeamId', 'away_team_id'],
  ['homeTeamName', 'home_team_name'], ['awayTeamName', 'away_team_name'],
  ['date', 'date'], ['homeGoals', 'home_goals'], ['awayGoals', 'away_goals'],
  ['homeXG', 'home_xg'], ['awayXG', 'away_xg'],
  ['homeTotalShots', 'home_shots'], ['awayTotalShots', 'away_shots'],
  ['homeShotsOnTarget', 'home_shots_on_target'], ['awayShotsOnTarget', 'away_shots_on_target'],
  ['homePossession', 'home_possession'], ['awayPossession', 'away_possession'],
  ['homeFouls', 'home_fouls'], ['awayFouls', 'away_fouls'],
  ['homeYellowCards', 'home_yellow_cards'], ['awayYellowCards', 'away_yellow_cards'],
  ['homeRedCards', 'home_red_cards'], ['awayRedCards', 'away_red_cards'],
  ['homeCorners', 'home_corners'], ['awayCorners', 'away_corners'],
  ['referee', 'referee'], ['competition', 'competition'], ['season', 'season'],
  ['source', 'source'], ['sourceMatchId', 'source_match_id'], ['rawJson', 'raw_json'],
];

const normalizeUnderstatUpsertValue = (field: string, value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (field === 'date') {
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value));
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : String(value);
  }
  if (typeof value === 'number') return Number(value);
  return String(value);
};

/** A detailed Understat payload is the only raw JSON allowed to replace another detailed payload. */
export const hasUnderstatRawJsonDetails = (value: unknown): boolean => {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = JSON.parse(value);
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && hasValidUnderstatMatchDetails((parsed as Record<string, unknown>).details));
  } catch {
    return false;
  }
};

/**
 * Preserve an already persisted detailed payload when the import only has a
 * base match payload (or malformed JSON). Null keeps MATCH_UPSERT_SQL's
 * COALESCE semantics and also keeps this downgrade out of change detection.
 */
export const preserveUnderstatRichRawJson = (
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>
): Record<string, unknown> => {
  if (!hasUnderstatRawJsonDetails(existing?.raw_json) || hasUnderstatRawJsonDetails(incoming.rawJson)) {
    return incoming;
  }
  return { ...incoming, rawJson: null };
};

/**
 * Mirrors the match UPSERT's COALESCE semantics: a null incoming value never
 * changes the database, while any effective value difference deserves a write.
 */
export const hasUnderstatMatchUpsertChange = (
  existing: Record<string, unknown> | null | undefined,
  incoming: Record<string, unknown>
): boolean => {
  if (!existing) return true;
  return UNDERSTAT_UPSERT_COMPARISON_FIELDS.some(([incomingField, existingField]) => {
    const next = normalizeUnderstatUpsertValue(incomingField, incoming[incomingField]);
    if (next === null) return false;
    return next !== normalizeUnderstatUpsertValue(incomingField, existing[existingField]);
  });
};

export const shouldRebuildUnderstatPlayers = (
  committedWrites: Array<{ isPlayed: boolean }>,
  batchError?: unknown
): boolean => !batchError && committedWrites.some((write) => write.isPlayed);

export const resolveInternalApiBaseUrl = (configuredValue?: string): string => {
  const candidate = String(
    configuredValue ?? `http://127.0.0.1:${process.env.PORT ?? 3001}/api`,
  ).replace(/\/$/, '');
  const parsed = new URL(candidate);
  const loopbackHost = parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'http:' || !loopbackHost || parsed.username || parsed.password) {
    throw new Error('Internal API base URL must use loopback HTTP.');
  }
  return parsed.toString().replace(/\/$/, '');
};

function sameTeamName(left: string, right: string): boolean {
  const a = normalizePlayerNameForProp(left);
  const b = normalizePlayerNameForProp(right);
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

export function matchUniquePlayerByName<T extends { name?: unknown }>(players: T[], providerName: string): T | null {
  const target = normalizePlayerNameForProp(providerName);
  if (!target) return null;
  const exact = players.filter((player) => normalizePlayerNameForProp(String(player.name ?? '')) === target);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return null;
  const partial = players.filter((player) => {
    const candidate = normalizePlayerNameForProp(String(player.name ?? ''));
    return Boolean(candidate && (candidate.includes(target) || target.includes(candidate)));
  });
  return partial.length === 1 ? partial[0] : null;
}

export function fixedFiveSeasonPolicy(now: Date = new Date()): {
  seasonLabels: string[];
  seasonStartYears: number[];
  keepSeasons: number;
  prune: true;
} {
  const seasonLabels = buildSeasonWindow(now, DEFAULT_SEASON_RETENTION_COUNT);
  return {
    seasonLabels,
    seasonStartYears: seasonLabels.map((label) => Number(label.slice(0, 4))),
    keepSeasons: DEFAULT_SEASON_RETENTION_COUNT,
    prune: true,
  };
}

export function isCompleteUnderstatSeasonDetail(detail: Record<string, unknown> | null | undefined): boolean {
  if (!detail || detail.error) return false;
  const source = Number(detail.totalOnSource ?? 0);
  const persisted = Number(detail.persistedSourceMatches ?? 0);
  const missing = Number(detail.missingSourceMatches ?? Number.POSITIVE_INFINITY);
  return source > 0 && persisted >= source && missing === 0;
}

// Eccezioni fail-closed e specifiche per stagione. Una coppia non presente qui
// non puo essere dichiarata pending con sorgente vuota. Per il 2026/27 la DFL
// ha fissato l'avvio della Bundesliga al 28 agosto 2026.
const UNDERSTAT_COMPETITION_START_DATES: Record<string, string> = {
  'Bundesliga 2026/2027': '2026-08-28',
};

export function isExpectedPendingCurrentSeasonDetail(
  detail: Record<string, unknown> | null | undefined,
  competition: string,
  season: string,
  now: Date = new Date(),
): boolean {
  if (!detail || detail.error) return false;
  const policy = fixedFiveSeasonPolicy(now);
  const currentSeason = policy.seasonLabels[policy.seasonLabels.length - 1];
  if (season !== currentSeason) return false;

  const officialStartDate = UNDERSTAT_COMPETITION_START_DATES[`${competition} ${season}`];
  if (!officialStartDate) return false;
  if (!Number.isFinite(now.getTime())) return false;
  const romeDateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    romeDateParts.find((entry) => entry.type === type)?.value ?? '';
  const romeDate = `${part('year')}-${part('month')}-${part('day')}`;
  if (romeDate >= officialStartDate) return false;

  return Number(detail.totalOnSource ?? 0) === 0
    && Number(detail.persistedSourceMatches ?? 0) === 0
    && Number(detail.missingSourceMatches ?? Number.POSITIVE_INFINITY) === 0;
}

export function summarizeUnderstatSeasonReadiness(params: {
  competitions: string[];
  seasons: string[];
  seasonSummary: Record<string, any>;
  now?: Date;
}): {
  expectedSeasonPairs: number;
  completedSeasonPairs: number;
  pendingSeasonPairs: Array<{ key: string; reason: string }>;
  failedSeasonPairs: Array<{ key: string; error: string }>;
  allExpectedSeasonsComplete: boolean;
  allExpectedSeasonsReady: boolean;
} {
  const expectedEntries = params.competitions.flatMap((competition) =>
    params.seasons.map((season) => ({
      competition,
      season,
      key: `${competition} ${season}`,
      detail: params.seasonSummary[`${competition} ${season}`],
    }))
  );
  const expectedSeasonPairs = expectedEntries.length;
  const completedSeasonPairs = expectedEntries.filter(({ detail }) =>
    isCompleteUnderstatSeasonDetail(detail)
  ).length;
  const currentSeasonLabel = params.seasons[params.seasons.length - 1] ?? '';
  const previousSeasonLabels = params.seasons.slice(0, -1);
  const pendingSeasonPairs = expectedEntries
    .filter(({ competition, season, detail }) =>
      season === currentSeasonLabel
      && isExpectedPendingCurrentSeasonDetail(detail, competition, season, params.now)
      && previousSeasonLabels.every((previousSeason) =>
        isCompleteUnderstatSeasonDetail(params.seasonSummary[`${competition} ${previousSeason}`])
      )
    )
    .map(({ key }) => ({ key, reason: 'stagione corrente non ancora pubblicata dalla fonte' }));
  const pendingKeys = new Set(pendingSeasonPairs.map((pair) => pair.key));
  const failedSeasonPairs = expectedEntries
    .filter(({ key, detail }) =>
      !isCompleteUnderstatSeasonDetail(detail) && !pendingKeys.has(key)
    )
    .map(({ key, detail }) => ({ key, error: detail?.error ?? 'dati mancanti o incompleti' }));
  const allExpectedSeasonsComplete = completedSeasonPairs === expectedSeasonPairs
    && failedSeasonPairs.length === 0;
  const allExpectedSeasonsReady = completedSeasonPairs + pendingSeasonPairs.length === expectedSeasonPairs
    && failedSeasonPairs.length === 0;
  return {
    expectedSeasonPairs,
    completedSeasonPairs,
    pendingSeasonPairs,
    failedSeasonPairs,
    allExpectedSeasonsComplete,
    allExpectedSeasonsReady,
  };
}

export function buildConfirmedStatusRows(params: {
  matchId: string;
  teamPlayers: any[];
  lineup: { formation?: string | null; players: Array<{ name: string; starter: boolean; position?: string | null }> };
  providerFixtureId: string;
  kickoffAt?: string | null;
}): any[] {
  const usedPlayerIds = new Set<string>();
  return params.lineup.players.flatMap((entry) => {
    const player = matchUniquePlayerByName(params.teamPlayers, entry.name) as any;
    if (!player) return [];
    const playerId = String(player.player_id);
    if (usedPlayerIds.has(playerId)) return [];
    usedPlayerIds.add(playerId);
    return [{
      matchId: params.matchId, playerId, teamId: String(player.team_id),
      status: entry?.starter ? 'confirmed_starter' : 'confirmed_bench',
      probability: entry?.starter ? 1 : 0,
      source: 'api_football_confirmed', providerFixtureId: params.providerFixtureId,
      kickoffAt: params.kickoffAt ?? null, formation: params.lineup.formation ?? null,
      positionCode: entry?.position ?? player.position_code ?? null,
      rawJson: JSON.stringify({ lineup: params.lineup, player: entry ?? null }),
    }];
  });
}

export const officialFormationFromRows = (rows: any[], teamId: string): string | null => {
  const official = rows.find((row: any) =>
    String(row.team_id) === teamId && String(row.status).startsWith('confirmed_'));
  try {
    const raw = typeof official?.raw_json === 'string' ? JSON.parse(official.raw_json) : official?.raw_json;
    const formation = String(raw?.lineup?.formation ?? '').trim();
    return formation || null;
  } catch {
    return null;
  }
};

type ProviderSquadMember = { id: number | null; name: string; position?: string | null };

export function buildProviderSquadReconciliationPlan(params: {
  teamId: string;
  currentPlayers: any[];
  allPlayers: any[];
  squad: ProviderSquadMember[];
}): {
  safeToApply: boolean;
  coverage: number;
  resolved: Array<{ playerId: string; positionCode: string | null; isNew: boolean; name: string; providerId: number | null }>;
} {
  const chooseCanonicalExact = (players: any[], name: string): any | null => {
    const target = normalizePlayerNameForProp(name);
    const exact = players.filter((player) => normalizePlayerNameForProp(String(player?.name ?? '')) === target);
    if (exact.length === 1) return exact[0];
    const understat = exact.filter((player) => player?.source_player_id != null || String(player?.player_id ?? '').startsWith('understat_player_'));
    return understat.length === 1 ? understat[0] : null;
  };
  const knownById = new Map(params.allPlayers.map((player) => [String(player?.player_id ?? ''), player]));
  const resolvedByPlayerId = new Map<string, {
    playerId: string; positionCode: string | null; isNew: boolean; name: string; providerId: number | null;
  }>();
  for (const member of params.squad) {
    const current = chooseCanonicalExact(params.currentPlayers, member.name)
      ?? matchUniquePlayerByName(params.currentPlayers, member.name);
    const global = current ?? chooseCanonicalExact(params.allPlayers, member.name);
    const providerPlayerId = member.id === null ? null : `api_football_player_${member.id}`;
    const knownProviderPlayer = providerPlayerId ? knownById.get(providerPlayerId) : null;
    const matched = global ?? knownProviderPlayer;
    const playerId = matched ? String(matched.player_id) : providerPlayerId;
    if (!playerId || resolvedByPlayerId.has(playerId)) continue;
    resolvedByPlayerId.set(playerId, {
      playerId,
      positionCode: String(member.position ?? matched?.position_code ?? '').trim() || null,
      isNew: !matched,
      name: member.name,
      providerId: member.id,
    });
  }
  const resolved = [...resolvedByPlayerId.values()];
  const coverage = params.squad.length > 0 ? resolved.length / params.squad.length : 0;
  return {
    safeToApply: params.squad.length >= 11 && resolved.length >= 11 && coverage >= 0.70,
    coverage,
    resolved,
  };
}

export function createApiRouter(deps: ApiRouterDependencies): Router {
const router = Router();
const db = deps.db;
const svc = deps.svc ?? new PredictionService(db);
const observability = deps.observability;
const createOddsBundle = deps.createOddsProviderCoordinatorBundle ?? createOddsProviderCoordinatorBundle;
const createKickoffSyncService = deps.createOddsApiKickoffSyncService
  ?? ((database: DatabaseService) => new OddsApiKickoffSyncService(database));
const heavyJobService = deps.heavyJobService ?? new HeavyJobService();
const sharedDataUserId = String(deps.sharedDataUserId ?? process.env.SHARED_DATA_USER_ID ?? 'user1').trim() || 'user1';

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

const apiFootball = deps.apiFootballService ?? new ApiFootballService();
const lineupRefreshReservations = new Map<string, number>();
const LINEUP_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;

const reserveLineupRefresh = (matchId: string, now = Date.now()): boolean => {
  const previous = lineupRefreshReservations.get(matchId) ?? 0;
  if (now - previous < LINEUP_REFRESH_COOLDOWN_MS) return false;
  lineupRefreshReservations.set(matchId, now);
  if (lineupRefreshReservations.size > 1000) {
    for (const [key, timestamp] of lineupRefreshReservations) {
      if (now - timestamp >= LINEUP_REFRESH_COOLDOWN_MS) lineupRefreshReservations.delete(key);
    }
  }
  return true;
};

const saveLocalPredictedLineups = async (match: any): Promise<{
  saved: number; incompletePredictions: number;
}> => {
  const matchId = String(match.match_id);
  const kickoffAt = String(match.date);
  const [homePlayers, awayPlayers, existingStatuses, homeHistoryMatches, awayHistoryMatches] = await Promise.all([
    db.getPlayersByTeam(String(match.home_team_id)),
    db.getPlayersByTeam(String(match.away_team_id)),
    db.getPlayerLineupStatuses(matchId, kickoffAt),
    db.getRecentCompletedMatchesForTeam(String(match.home_team_id), kickoffAt, 20),
    db.getRecentCompletedMatchesForTeam(String(match.away_team_id), kickoffAt, 20),
  ]);
  const confirmedTeams = completeOfficialTeamIds(existingStatuses);
  const rows: any[] = [];
  let incompletePredictions = 0;
  for (const side of [
    { teamId: String(match.home_team_id), players: homePlayers, historyMatches: homeHistoryMatches },
    { teamId: String(match.away_team_id), players: awayPlayers, historyMatches: awayHistoryMatches },
  ]) {
    if (confirmedTeams.has(side.teamId)) continue;
    const unavailableIds = new Set<string>(existingStatuses
      .filter((row: any) => String(row.team_id) === side.teamId && String(row.status) === 'unavailable')
      .map((row: any) => String(row.player_id)));
    const history = extractOfficialLineupHistory(side.historyMatches, side.teamId, kickoffAt, 5);
    const predicted = buildPredictedLineup(side.players, history, unavailableIds);
    if (predicted.incomplete) incompletePredictions++;
    for (const player of [...predicted.starters, ...predicted.bench]) {
      rows.push({
        matchId, playerId: player.playerId, teamId: side.teamId,
        status: player.status, probability: player.probability, source: 'last_five_lineup_model',
        providerFixtureId: null, kickoffAt, formation: predicted.formation,
        positionCode: player.positionGroup, historyMatchesUsed: predicted.historyMatchesUsed,
        rawJson: JSON.stringify({
          historyMatchesUsed: predicted.historyMatchesUsed,
          recentStarts: player.recentStarts,
          warnings: predicted.warnings,
        }),
      });
    }
  }
  await db.savePlayerLineupStatuses(rows);
  return { saved: rows.length, incompletePredictions };
};

router.get('/player-availability/:matchId', async (req: Request, res: Response) => {
  try {
    const matchId = String(req.params.matchId ?? '').trim();
    const match = await db.getMatchById(matchId);
    if (!match) return res.status(404).json({ error: 'Partita non trovata' });
    const [homePlayers, awayPlayers, statusRows, homeHistoryMatches, awayHistoryMatches] = await Promise.all([
      db.getPlayersByTeam(String(match.home_team_id)),
      db.getPlayersByTeam(String(match.away_team_id)),
      db.getPlayerLineupStatuses(matchId, String(match.date)),
      db.getRecentCompletedMatchesForTeam(String(match.home_team_id), String(match.date), 20),
      db.getRecentCompletedMatchesForTeam(String(match.away_team_id), String(match.date), 20),
    ]);
    const statuses = new Map(statusRows.map((row: any) => [String(row.player_id), row]));
    const buildTeam = (players: any[], teamId: string, teamName: string, historyMatches: any[]) => {
      const unavailableIds = new Set<string>(statusRows
        .filter((row: any) => String(row.team_id) === teamId && String(row.status) === 'unavailable')
        .map((row: any) => String(row.player_id)));
      const history = extractOfficialLineupHistory(historyMatches, teamId, String(match.date), 5);
      const predicted = buildPredictedLineup(players, history, unavailableIds);
      const predictedByPlayer = new Map([
        ...predicted.starters,
        ...predicted.bench,
      ].map((row) => [row.playerId, row]));
      const hasOfficialTeamLineup = completeOfficialTeamIds(statusRows).has(teamId);
      const officialFormation = hasOfficialTeamLineup ? officialFormationFromRows(statusRows, teamId) : null;
      const mapped = players.map((player: any) => {
        const external = statuses.get(String(player.player_id)) ?? predictedByPlayer.get(String(player.player_id));
        const assessment = assessPlayerLineup(player, external ? {
          status: String(external.status) as any,
          probability: external.probability === null ? undefined : Number(external.probability),
        } : undefined);
        return {
          playerId: String(player.player_id),
          name: player.name,
          teamId,
          teamName,
          probability: assessment.probability,
          tier: assessment.tier,
          status: assessment.status,
          warnings: assessment.warnings,
          source: (external as any)?.source ?? 'last_five_lineup_model',
          fetchedAt: (external as any)?.fetched_at ?? null,
        };
      }).filter((player: any) => hasOfficialTeamLineup
        ? player.status === 'confirmed_starter'
        : player.status === 'predicted_starter')
        .sort((left: any, right: any) => right.probability - left.probability);
      return {
        players: mapped,
        formation: hasOfficialTeamLineup ? officialFormation : predicted.formation,
        historyMatchesUsed: predicted.historyMatchesUsed,
        incomplete: hasOfficialTeamLineup ? mapped.length !== 11 : predicted.incomplete,
        warnings: predicted.warnings,
        unavailableCount: unavailableIds.size,
      };
    };
    const home = buildTeam(homePlayers, String(match.home_team_id), String(match.home_team_name ?? 'Casa'), homeHistoryMatches);
    const away = buildTeam(awayPlayers, String(match.away_team_id), String(match.away_team_name ?? 'Trasferta'), awayHistoryMatches);
    res.json({
      success: true,
      data: {
        matchId,
        kickoff: match.date,
        home: home.players,
        away: away.players,
        homeFormation: home.formation,
        awayFormation: away.formation,
        homeHistoryMatchesUsed: home.historyMatchesUsed,
        awayHistoryMatchesUsed: away.historyMatchesUsed,
        homeIncomplete: home.incomplete,
        awayIncomplete: away.incomplete,
        homeUnavailableCount: home.unavailableCount,
        awayUnavailableCount: away.unavailableCount,
        warnings: Array.from(new Set([...home.warnings, ...away.warnings])),
        hasConfirmedLineup: completeOfficialTeamIds(statusRows).size > 0,
        hasProviderData: statusRows.some((row: any) => String(row.source).startsWith('api_football_')),
        note: 'La formazione probabile e una stima; la formazione ufficiale prevale quando disponibile.',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error?.message ?? 'Impossibile recuperare le formazioni' });
  }
});

/**
 * Stores confirmed API-Football lineups against our internal match/player IDs.
 * It is deliberately separate from the prediction call: a provider response
 * must be timestamped before it can influence a later prediction.
 */
router.post('/player-availability/sync', async (req: Request, res: Response) => {
  try {
    const matchId = String(req.body?.matchId ?? '').trim();
    const fixtureId = String(req.body?.apiFootballFixtureId ?? req.body?.fixtureId ?? '').trim();
    if (!matchId || !fixtureId) return res.status(400).json({ error: 'matchId e fixtureId sono obbligatori' });
    if (!apiFootball.enabled) return res.status(503).json({ error: 'API-Football disabilitata o API_FOOTBALL_KEY mancante' });
    const match = await db.getMatchById(matchId);
    if (!match) return res.status(404).json({ error: 'Partita non trovata' });
    if (!reserveLineupRefresh(matchId)) {
      return res.json({ success: true, enabled: true, skipped: 'refresh_cooldown', saved: 0 });
    }
    const [homePlayers, awayPlayers, lineups] = await Promise.all([
      db.getPlayersByTeam(String(match.home_team_id)),
      db.getPlayersByTeam(String(match.away_team_id)),
      apiFootball.getConfirmedLineups(fixtureId),
    ]);
    const candidateRows: any[] = [];
    for (const lineup of lineups) {
      const teamPlayers = sameTeamName(lineup.teamName, String(match.home_team_name ?? '')) ? homePlayers
        : sameTeamName(lineup.teamName, String(match.away_team_name ?? '')) ? awayPlayers : [];
      candidateRows.push(...buildConfirmedStatusRows({
        matchId, teamPlayers, lineup, providerFixtureId: fixtureId,
        kickoffAt: match.date ?? null,
      }));
    }
    const rows = retainCompleteOfficialLineupRows(candidateRows);
    await db.savePlayerLineupStatuses(rows, { replaceTeamOperational: true });
    res.json({
      success: true, matchId, fixtureId, saved: rows.length,
      discardedPartial: candidateRows.length - rows.length,
      source: 'api_football_confirmed',
    });
  } catch (error: any) {
    console.error('[api-football-lineup-sync] failed:', error?.stack ?? error?.message ?? error);
    res.status(502).json({ error: error?.message ?? 'Sincronizzazione formazione fallita' });
  }
});

// Refresh on demand when the user opens a fixture close to kickoff. The
// nightly can prepare the prediction, but official XI usually arrive later.
router.post('/player-availability/refresh/:matchId', async (req: Request, res: Response) => {
  try {
    const matchId = String(req.params.matchId ?? '').trim();
    const match = await db.getMatchById(matchId);
    if (!match) return res.status(404).json({ error: 'Partita non trovata' });
    const kickoff = Date.parse(String(match.date ?? ''));
    const deltaMinutes = (kickoff - Date.now()) / 60000;
    if (!Number.isFinite(deltaMinutes) || deltaMinutes < 0) {
      return res.json({ success: true, enabled: apiFootball.enabled, skipped: 'outside_official_lineup_window', saved: 0 });
    }
    const existingStatuses = await db.getPlayerLineupStatuses(matchId, String(match.date));
    const confirmedTeams = completeOfficialTeamIds(existingStatuses);
    if (confirmedTeams.has(String(match.home_team_id))
      && confirmedTeams.has(String(match.away_team_id))) {
      return res.json({ success: true, enabled: true, skipped: 'official_lineups_already_saved', saved: 0 });
    }
    if (!reserveLineupRefresh(matchId)) {
      return res.json({ success: true, enabled: apiFootball.enabled, skipped: 'refresh_cooldown', saved: 0 });
    }
    if (!apiFootball.enabled || deltaMinutes > 150) {
      const local = await saveLocalPredictedLineups(match);
      return res.json({
        success: true, enabled: apiFootball.enabled,
        skipped: apiFootball.enabled ? 'provider_window_not_open' : undefined,
        source: 'last_five_lineup_model', ...local,
      });
    }
    let fixtures: Awaited<ReturnType<ApiFootballService['getFixturesByDate']>> = [];
    try {
      fixtures = await apiFootball.getFixturesByDate(String(match.date).slice(0, 10));
    } catch (providerError: any) {
      const local = await saveLocalPredictedLineups(match);
      return res.json({
        success: true, enabled: true, skipped: 'provider_unavailable',
        source: 'last_five_lineup_model', providerError: String(providerError?.message ?? providerError), ...local,
      });
    }
    const fixture = fixtures.find((candidate) =>
      sameTeamName(candidate.homeName, String(match.home_team_name ?? ''))
      && sameTeamName(candidate.awayName, String(match.away_team_name ?? '')));
    if (!fixture) {
      const local = await saveLocalPredictedLineups(match);
      return res.json({
        success: true, enabled: true, skipped: 'fixture_not_matched',
        source: 'last_five_lineup_model', ...local,
      });
    }
    if (fixture.referee) await db.fillMatchReferee(matchId, fixture.referee);
    const providerWarnings: string[] = [];
    const [homePlayers, awayPlayers, injuryFetch, lineups] = await Promise.all([
      db.getPlayersByTeam(String(match.home_team_id)),
      db.getPlayersByTeam(String(match.away_team_id)),
      apiFootball.getInjuries({ fixture: fixture.id })
        .then((rows) => ({ fetched: true as const, rows }))
        .catch((providerError: any) => {
          providerWarnings.push(`injuries:${String(providerError?.message ?? providerError)}`);
          return { fetched: false as const, rows: [] };
        }),
      apiFootball.getConfirmedLineups(fixture.id).catch((providerError: any) => {
        providerWarnings.push(`lineups:${String(providerError?.message ?? providerError)}`);
        return [];
      }),
    ]);
    const injuryRows: any[] = [];
    for (const injury of injuryFetch.rows) {
      const teamPlayers = sameTeamName(String(injury?.team?.name ?? ''), String(match.home_team_name ?? '')) ? homePlayers
        : sameTeamName(String(injury?.team?.name ?? ''), String(match.away_team_name ?? '')) ? awayPlayers : [];
      const player = matchUniquePlayerByName(teamPlayers, String(injury?.player?.name ?? '')) as any;
      if (!player) continue;
      injuryRows.push({
        matchId, playerId: String(player.player_id), teamId: String(player.team_id),
        status: 'unavailable', probability: 0, source: 'api_football_injury',
        providerFixtureId: String(fixture.id), kickoffAt: match.date,
        rawJson: JSON.stringify(injury),
      });
    }
    const operationalInjuryRows = injuryRows.filter((row) => !confirmedTeams.has(String(row.teamId)));
    if (injuryFetch.fetched) {
      await db.replacePlayerInjuryStatuses({
        matchId,
        teamIds: [String(match.home_team_id), String(match.away_team_id)],
        rows: operationalInjuryRows,
        providerFixtureId: String(fixture.id),
        kickoffAt: match.date,
      });
    }
    // La previsione viene rigenerata dopo il refresh infortuni: una risposta
    // valida e vuota rende subito rieleggibile un giocatore recuperato.
    const local = await saveLocalPredictedLineups(match);
    const confirmedCandidates: any[] = [];
    for (const lineup of lineups) {
      const teamPlayers = sameTeamName(lineup.teamName, String(match.home_team_name ?? '')) ? homePlayers
        : sameTeamName(lineup.teamName, String(match.away_team_name ?? '')) ? awayPlayers : [];
      confirmedCandidates.push(...buildConfirmedStatusRows({
        matchId, teamPlayers, lineup,
        providerFixtureId: String(fixture.id), kickoffAt: match.date,
      }));
    }
    const confirmedRows = retainCompleteOfficialLineupRows(confirmedCandidates);
    await db.savePlayerLineupStatuses(confirmedRows, { replaceTeamOperational: true });
    return res.json({
      success: true, enabled: true, fixtureId: String(fixture.id),
      source: confirmedRows.length > 0 ? 'api_football_confirmed' : 'last_five_lineup_model',
      officialLineups: lineups.length,
      saved: local.saved + operationalInjuryRows.length + confirmedRows.length,
      predictedSaved: local.saved,
      incompletePredictions: local.incompletePredictions,
      discardedPartial: confirmedCandidates.length - confirmedRows.length,
      refereeUpdated: Boolean(fixture.referee),
      providerWarnings,
    });
  } catch (error: any) {
    console.error('[api-football-lineup-refresh] failed:', error?.stack ?? error?.message ?? error);
    return res.status(502).json({ error: error?.message ?? 'Aggiornamento formazione fallito' });
  }
});

// Nightly-safe collector. API-Football's free lineup endpoint is checked only
// close to kickoff; 24h predictions remain handled by the local predictor.
router.post('/player-availability/sync-upcoming', async (req: Request, res: Response) => {
  try {
    const hours = Math.max(1, Math.min(Number(req.body?.windowHours ?? 24), 48));
    const now = Date.now();
    const untilIso = new Date(now + hours * 60 * 60 * 1000).toISOString();
    const matches = await db.getUpcomingMatches({ untilIso, limit: 200 });
    // Il modello locale deve funzionare anche senza API-Football. Il provider
    // arricchisce rosa/assenze/XI ufficiale, ma non e un prerequisito.
    const reservedMatchIds = new Set<string>();
    for (const match of matches) {
      const matchId = String(match.match_id ?? '');
      if (matchId && reserveLineupRefresh(matchId, now)) reservedMatchIds.add(matchId);
    }
    const providerDates = [...new Set(matches
      .filter((match: any) => reservedMatchIds.has(String(match.match_id ?? '')))
      .map((match: any) => String(match.date ?? '').slice(0, 10))
      .filter(Boolean))];
    let providerFixtures: Awaited<ReturnType<ApiFootballService['getFixturesByDate']>> = [];
    const providerWarnings: string[] = [];
    if (apiFootball.enabled) {
      try {
        providerFixtures = (await Promise.all(providerDates.map((date) => apiFootball.getFixturesByDate(date)))).flat();
      } catch (providerError: any) {
        providerWarnings.push(`fixtures:${String(providerError?.message ?? providerError)}`);
      }
    }
    const teamsReconciled = new Set<string>();
    let checked = 0;
    let saved = 0;
    let predictedSaved = 0;
    let incompletePredictions = 0;
    for (const match of matches) {
      const kickoff = Date.parse(String(match.date ?? ''));
      if (!Number.isFinite(kickoff)) continue;
      const matchId = String(match.match_id);
      if (!reservedMatchIds.has(matchId)) continue;
      const providerAllowed = apiFootball.enabled;
      const fixture = providerAllowed ? providerFixtures.find((candidate) =>
        sameTeamName(candidate.homeName, String(match.home_team_name ?? '')) &&
        sameTeamName(candidate.awayName, String(match.away_team_name ?? ''))
      ) : undefined;
      if (fixture) {
        if (fixture.referee) await db.fillMatchReferee(matchId, fixture.referee);
        for (const side of [
          { internalId: String(match.home_team_id), providerId: fixture.homeProviderTeamId },
          { internalId: String(match.away_team_id), providerId: fixture.awayProviderTeamId },
        ]) {
          if (!side.providerId || teamsReconciled.has(side.internalId)) continue;
          const squad = await apiFootball.getSquad(side.providerId).catch((providerError: any) => {
            providerWarnings.push(`squad:${side.internalId}:${String(providerError?.message ?? providerError)}`);
            return [];
          });
          if (squad.length === 0) continue;
          // Include players currently marked unavailable: a player can return
          // to the squad after an earlier reconciliation and must be eligible
          // to be reactivated by the next authoritative squad response.
          const [currentPlayers, allPlayers] = await Promise.all([
            db.getAllPlayersByTeam(side.internalId),
            db.getAllPlayers(),
          ]);
          const plan = buildProviderSquadReconciliationPlan({
            teamId: side.internalId, currentPlayers, allPlayers, squad,
          });
          if (!plan.safeToApply) {
            providerWarnings.push(`squad_coverage:${side.internalId}:${plan.resolved.length}/${squad.length}`);
            teamsReconciled.add(side.internalId);
            continue;
          }
          // Creazioni identity-only, trasferimenti e disattivazione degli
          // esclusi avvengono in un unico batch Turso transazionale.
          await db.applyProviderSquadReconciliation(side.internalId, plan.resolved);
          teamsReconciled.add(side.internalId);
        }
      }
      checked++;
      const [homePlayers, awayPlayers, injuryFetch, statusesBeforeRefresh] = await Promise.all([
        db.getPlayersByTeam(String(match.home_team_id)),
        db.getPlayersByTeam(String(match.away_team_id)),
        fixture ? apiFootball.getInjuries({ fixture: fixture.id })
          .then((rows) => ({ fetched: true as const, rows }))
          .catch((providerError: any) => {
            providerWarnings.push(`injuries:${matchId}:${String(providerError?.message ?? providerError)}`);
            return { fetched: false as const, rows: [] };
          }) : Promise.resolve({ fetched: false as const, rows: [] }),
        db.getPlayerLineupStatuses(matchId, String(match.date)),
      ]);
      const injuryRows: any[] = [];
      for (const injury of injuryFetch.rows) {
        const providerTeamName = String(injury?.team?.name ?? '').trim();
        const teamPlayers = sameTeamName(providerTeamName, String(match.home_team_name ?? '')) ? homePlayers
          : sameTeamName(providerTeamName, String(match.away_team_name ?? '')) ? awayPlayers : [];
        const providerPlayerName = String(injury?.player?.name ?? '').trim();
        const player = matchUniquePlayerByName(teamPlayers, providerPlayerName) as any;
        if (!player) continue;
        injuryRows.push({
          matchId, playerId: String(player.player_id), teamId: String(player.team_id),
          status: 'unavailable', probability: 0, source: 'api_football_injury',
          providerFixtureId: fixture ? String(fixture.id) : null, kickoffAt: match.date,
          rawJson: JSON.stringify(injury),
        });
      }
      const confirmedBeforeRefresh = completeOfficialTeamIds(statusesBeforeRefresh);
      const operationalInjuryRows = injuryRows.filter((row) => !confirmedBeforeRefresh.has(String(row.teamId)));
      if (injuryFetch.fetched) {
        await db.replacePlayerInjuryStatuses({
          matchId,
          teamIds: [String(match.home_team_id), String(match.away_team_id)],
          rows: operationalInjuryRows,
          providerFixtureId: fixture ? String(fixture.id) : null,
          kickoffAt: match.date,
        });
      }
      const existingStatuses = await db.getPlayerLineupStatuses(matchId, String(match.date));
      const confirmedTeamIds = completeOfficialTeamIds(existingStatuses);
      const unavailableByTeam = new Map<string, Set<string>>();
      for (const row of existingStatuses.filter((entry: any) => String(entry.status) === 'unavailable')) {
        const teamId = String(row.team_id);
        if (!unavailableByTeam.has(teamId)) unavailableByTeam.set(teamId, new Set());
        unavailableByTeam.get(teamId)!.add(String(row.player_id));
      }
      const predictedRows: any[] = [];
      for (const side of [
        { teamId: String(match.home_team_id), players: homePlayers },
        { teamId: String(match.away_team_id), players: awayPlayers },
      ]) {
        if (confirmedTeamIds.has(side.teamId)) continue;
        const historyMatches = await db.getRecentCompletedMatchesForTeam(side.teamId, String(match.date), 20);
        const history = extractOfficialLineupHistory(historyMatches, side.teamId, String(match.date), 5);
        const predicted = buildPredictedLineup(side.players, history, unavailableByTeam.get(side.teamId) ?? new Set());
        if (predicted.incomplete) incompletePredictions++;
        for (const player of [...predicted.starters, ...predicted.bench]) {
          predictedRows.push({
            matchId, playerId: player.playerId, teamId: side.teamId,
            status: player.status, probability: player.probability, source: 'last_five_lineup_model',
            providerFixtureId: fixture ? String(fixture.id) : null, kickoffAt: match.date,
            formation: predicted.formation, positionCode: player.positionGroup,
            historyMatchesUsed: predicted.historyMatchesUsed,
            rawJson: JSON.stringify({
              historyMatchesUsed: predicted.historyMatchesUsed,
              recentStarts: player.recentStarts,
              warnings: predicted.warnings,
            }),
          });
        }
      }
      await db.savePlayerLineupStatuses(predictedRows);
      predictedSaved += predictedRows.length;
      saved += operationalInjuryRows.length;
      // Official lineups are not expected 24h before kickoff. Avoid wasting
      // the free quota until the normal publication window.
      if (!fixture || kickoff - now > 120 * 60 * 1000) continue;
      const [confirmedHomePlayers, confirmedAwayPlayers, lineups] = await Promise.all([
        Promise.resolve(homePlayers),
        Promise.resolve(awayPlayers),
        apiFootball.getConfirmedLineups(fixture.id).catch((providerError: any) => {
          providerWarnings.push(`lineups:${matchId}:${String(providerError?.message ?? providerError)}`);
          return [];
        }),
      ]);
      const candidateRows: any[] = [];
      for (const lineup of lineups) {
        const teamPlayers = sameTeamName(lineup.teamName, String(match.home_team_name ?? '')) ? confirmedHomePlayers
          : sameTeamName(lineup.teamName, String(match.away_team_name ?? '')) ? confirmedAwayPlayers : [];
        candidateRows.push(...buildConfirmedStatusRows({
          matchId, teamPlayers, lineup,
          providerFixtureId: String(fixture.id), kickoffAt: match.date,
        }));
      }
      const rows = retainCompleteOfficialLineupRows(candidateRows);
      await db.savePlayerLineupStatuses(rows, { replaceTeamOperational: true });
      saved += rows.length;
    }
    res.json({
      success: true, enabled: apiFootball.enabled, windowHours: hours, checked, saved,
      predictedSaved, incompletePredictions, teamsReconciled: teamsReconciled.size,
      source: apiFootball.enabled ? 'local_model_plus_api_football' : 'last_five_lineup_model',
      providerWarnings,
    });
  } catch (error: any) {
    console.error('[api-football-upcoming-lineup-sync] failed:', error?.stack ?? error?.message ?? error);
    res.status(502).json({ error: error?.message ?? 'Sincronizzazione formazioni imminenti fallita' });
  }
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
      untilIso: req.query.untilIso as string | undefined,
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

// ====== FOOTBALL-DATA.CO.UK (stats supplementari: falli, corner, tiri, cartellini, arbitro) ======
// Fonte HTTP/CSV stabile che completa i campi non coperti da Understat. Scrittura
// non distruttiva (COALESCE: riempie solo i NULL). Understat resta primaria.
router.post('/scraper/football-data', async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    // Policy non aggirabile: stagione corrente + quattro precedenti. I campi
    // legacy seasonStartYears/keepSeasons/prune sono ignorati intenzionalmente.
    const policy = fixedFiveSeasonPolicy();
    const competitions: string[] = Array.isArray(body.competitions) && body.competitions.length > 0
      ? body.competitions
      : Object.keys(FOOTBALL_DATA_LEAGUE_CODES);

    const client = (db as any).db;
    const fdDb = createLibsqlFootballDataDb(client);
    // La retention viene applicata prima della rete: anche un outage della
    // fonte supplementare non puo lasciare una sesta stagione nel DB.
    const prune = await pruneOldSeasons(client, policy.keepSeasons);
    const sync = await syncFootballData(fdDb, { competitions, seasonStartYears: policy.seasonStartYears });

    if (!sync.allExpectedSeasonsReady) {
      return res.status(502).json({
        success: false,
        error: `Sync football-data non pronta: ${sync.completed} complete, ${sync.pending} pending, ${sync.requested} richieste.`,
        sync,
        prune,
        retentionPolicy: policy,
      });
    }

    // Ricalcolo medie (ora che i dati supplementari ci sono).
    let teamsUpdated = 0;
    if (body.recomputeAverages !== false) {
      const teams = await db.getTeams(undefined as any);
      for (const t of teams) { await db.recomputeTeamAverages(t.team_id); teamsUpdated++; }
    }

    res.json({ success: true, sync, prune, teamsUpdated, retentionPolicy: policy });
  } catch (e: any) {
    console.error('[football-data-sync] failed:', e?.stack ?? e?.message ?? e);
    res.status(500).json({ success: false, error: e.message });
  }
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
      oddsSource: replaySource,
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
    res.json({ success: true, data: await svc.getBudget(sharedDataUserId) });
  }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/budget/:userId/init', async (req: Request, res: Response) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'Importo non valido' });
    return res.json({ success: true, data: await svc.initBudget(sharedDataUserId, amount) });
  } catch (e: any) { return res.status(400).json({ success: false, error: e.message }); }
});

router.get('/budget/:userId/sessions', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await svc.getBudgetSessions(sharedDataUserId) });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/bets/place', async (req: Request, res: Response) => {
  try {
    const {
      userId: _requestedUserId,
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
      predictionId,
    } = req.body;

    const result = await svc.placeBet(
      sharedDataUserId,
      matchId,
      marketName,
      selection,
      odds,
      stake,
      ourProbability,
      expectedValue,
      { homeTeamName, awayTeamName, competition, matchDate, predictionId }
    );
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/bets/:betId/settle', async (req: Request, res: Response) => {
  try {
    const bet = await db.getBet(req.params.betId);
    if (!bet || String(bet.user_id ?? '') !== sharedDataUserId) {
      return res.status(404).json({ success: false, error: 'Giocata non trovata.' });
    }
    const result = await svc.settleBet(req.params.betId, req.body.won, req.body.returnAmount);
    return res.json({ success: true, data: result });
  } catch (e: any) { return res.status(400).json({ success: false, error: e.message }); }
});

router.post('/bets/sync', async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await svc.syncPendingBets(sharedDataUserId) });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/bets/:userId', async (req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await svc.getBets(sharedDataUserId, req.query.status as string) });
  }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/predictions/archive', async (req: Request, res: Response) => {
  try {
    const data = await db.getPredictionArchive({
      status: req.query.status as string,
      matchId: req.query.matchId as string,
      userId: sharedDataUserId,
      limit: Number(req.query.limit ?? 200),
    });
    return res.json({ success: true, data });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/bet-opportunities/archive', async (req: Request, res: Response) => {
  try {
    const classifications = String(req.query.classifications ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const options = {
      category: req.query.category as string,
      type: req.query.type as string,
      classification: req.query.classification as string,
      classifications,
      result: req.query.result as string,
      matchId: req.query.matchId as string,
      from: req.query.from as string,
      to: req.query.to as string,
      userId: sharedDataUserId,
      limit: Number(req.query.limit ?? 200),
    };
    const data = await db.getBetOpportunityArchive(options);
    const summary = typeof db.getBetOpportunityArchiveSummary === 'function'
      ? await db.getBetOpportunityArchiveSummary(options)
      : undefined;
    const counts = typeof db.getBetOpportunityArchiveCategoryCounts === 'function'
      ? await db.getBetOpportunityArchiveCategoryCounts(options)
      : undefined;
    return res.json({ success: true, data, summary, counts });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Saves a manually reviewed LOW/SPECULATIVE opportunity without creating a
// budget bet. The server rechecks the latest real bookmaker snapshot, so a
// browser payload can never archive synthetic/model-completed odds as real.
router.post('/bet-opportunities/archive/manual', async (req: Request, res: Response) => {
  try {
    const matchId = String(req.body?.matchId ?? '').trim();
    const marketName = String(req.body?.marketName ?? '').trim();
    const selection = String(req.body?.selection ?? '').trim();
    const classification = String(req.body?.classification ?? '').trim().toUpperCase();
    const requestedOdds = Number(req.body?.bookmakerOdds);
    const requestedBookmaker = String(req.body?.bookmakerName ?? '').trim();

    if (!matchId || !marketName || !selection) {
      return res.status(400).json({ success: false, error: 'Partita, mercato e selezione sono obbligatori.' });
    }
    if (!['LOW', 'SPECULATIVE'].includes(classification)) {
      return res.status(400).json({ success: false, error: 'Si possono archiviare manualmente solo opportunita LOW o SPECULATIVE.' });
    }
    if (!Number.isFinite(requestedOdds) || requestedOdds <= 1) {
      return res.status(400).json({ success: false, error: 'Quota bookmaker non valida.' });
    }

    const match = await db.getMatchById(matchId);
    const kickoffAt = Date.parse(String(match?.date ?? ''));
    if (!match || match.home_goals !== null || match.away_goals !== null || !Number.isFinite(kickoffAt) || kickoffAt <= Date.now()) {
      return res.status(400).json({ success: false, error: 'Puoi archiviare solo una partita futura non ancora conclusa.' });
    }

    const snapshot = await db.getLatestOddsSnapshotForMatch(matchId);
    const snapshotBundle = buildCoherentBookmakerOddsBundle(snapshot?.allBookmakerOdds);
    const snapshotOdds = sanitizeOddsMap(snapshotBundle.odds);
    const snapshotOdd = Number(
      snapshotOdds[selection]
      ?? snapshot?.liveSelectedOdds?.[selection]
      ?? snapshot?.selectedOdds?.[selection]
    );
    const snapshotBookmaker = String(
      snapshotBundle.bookmakerBySelection[selection]
      ?? snapshot?.selectedBookmakerName
      ?? ''
    ).trim();
    const hasRealBookmakerSnapshot = snapshot
      && String(snapshot.source ?? '').trim() === 'odds_api'
      && snapshot.usedSyntheticOdds !== true;
    if (!hasRealBookmakerSnapshot || !Number.isFinite(snapshotOdd) || snapshotOdd <= 1 || !snapshotBookmaker) {
      return res.status(409).json({ success: false, error: 'La quota bookmaker reale per questa selezione non e piu disponibile. Aggiorna la partita e riprova.' });
    }
    if (Math.abs(snapshotOdd - requestedOdds) > 0.011 || (requestedBookmaker && requestedBookmaker !== snapshotBookmaker)) {
      return res.status(409).json({ success: false, error: 'La quota e cambiata. Aggiorna la partita prima di archiviarla.' });
    }

    const decisionId = automatedSavedDecisionId(sharedDataUserId, matchId, marketName, selection);
    await db.appendAutomatedBetDecision({
      decisionId,
      userId: sharedDataUserId,
      matchId,
      marketName,
      selection,
      confidence: classification,
      bookmakerOdds: snapshotOdd,
      bookmakerName: snapshotBookmaker,
      theoreticalStakePercent: Number.isFinite(Number(req.body?.suggestedStakePercent))
        ? Number(req.body.suggestedStakePercent)
        : null,
      theoreticalStakeAmount: null,
      rankingPosition: 1,
      operationalSlot: null,
      decisionStatus: 'saved_only',
      exclusionReason: classification === 'SPECULATIVE' ? 'speculative_saved_only' : 'manual_saved_only',
      betId: null,
    });
    return res.json({ success: true, data: { decisionId, archiveType: 'simulated' } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message ?? 'Archiviazione opportunita non riuscita.' });
  }
});

// ====== AUTOMATED INTERNAL BET CARD ======
// This endpoint is intended for the nightly GitHub Actions runner. It deliberately
// reuses the public odds/prediction/bet paths so the automation behaves exactly like
// the UI button, while querying the DB first and never scanning an entire league.
router.post('/automation/place-valid-bets', async (req: Request, res: Response) => {
  const configuredToken = String(process.env.AUTO_BET_AUTOMATION_TOKEN ?? '').trim();
  const suppliedToken = String(req.header('x-automation-token') ?? '').trim();
  const remoteAddress = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  const isLoopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1';
  const isProduction = String(process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  if (
    (configuredToken && suppliedToken !== configuredToken)
    || (!configuredToken && (isProduction || !isLoopback))
  ) {
    return res.status(401).json({ success: false, error: 'Automazione non autorizzata.' });
  }

  try {
  const enabled = String(process.env.AUTO_BET_ENABLED ?? 'false').trim().toLowerCase() === 'true';
  const dryRun = req.body?.dryRun === true || String(process.env.AUTO_BET_DRY_RUN ?? 'false').trim().toLowerCase() === 'true';
  if (!enabled && !dryRun) {
    return res.status(409).json({ success: false, error: 'AUTO_BET_ENABLED=false: automazione disattivata.' });
  }

  const userId = sharedDataUserId;
  const windowHoursRaw = Number(req.body?.windowHours ?? process.env.AUTO_BET_WINDOW_HOURS ?? 24);
  const windowHours = Number.isFinite(windowHoursRaw) ? Math.max(1, Math.min(windowHoursRaw, 48)) : 24;
  const maxMatchesRaw = Number(req.body?.maxMatches ?? process.env.AUTO_BET_MAX_MATCHES ?? 100);
  const maxMatches = Number.isFinite(maxMatchesRaw) ? Math.max(1, Math.min(Math.trunc(maxMatchesRaw), 200)) : 100;
  const maxOperationalBetsPerMatchRaw = Number(
    req.body?.maxOperationalBetsPerMatch
      ?? process.env.AUTO_BET_MAX_OPERATIONAL_BETS_PER_MATCH
      ?? req.body?.maxOperationalBets
      ?? process.env.AUTO_BET_MAX_OPERATIONAL_BETS
      ?? 3
  );
  const maxOperationalBetsPerMatch = Number.isFinite(maxOperationalBetsPerMatchRaw)
    ? Math.max(1, Math.min(Math.trunc(maxOperationalBetsPerMatchRaw), 3))
    : 3;
  const maxSnapshotAgeHoursRaw = Number(process.env.AUTO_BET_MAX_SNAPSHOT_AGE_HOURS ?? 36);
  const maxSnapshotAgeHours = Number.isFinite(maxSnapshotAgeHoursRaw) ? Math.max(1, Math.min(maxSnapshotAgeHoursRaw, 168)) : 36;
  const apiBase = resolveInternalApiBaseUrl(deps.getInternalApiBaseUrl?.());
  const now = new Date();
  const until = new Date(now.getTime() + windowHours * 60 * 60 * 1000);
  const matches = await db.getUpcomingMatches({ nowIso: now.toISOString(), untilIso: until.toISOString(), limit: maxMatches });
  const results: any[] = [];
  let simulatedAvailableBudget: number | null = null;
  let operationalBetCount = 0;

  const callApi = async (path: string, body: any) => {
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(deps.internalAccessToken ? { 'x-internal-admin-token': deps.internalAccessToken } : {}),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      throw new Error(String(payload?.error ?? `HTTP ${response.status}`));
    }
    return payload?.data ?? payload;
  };

  for (const match of matches) {
    const matchId = String(match.match_id ?? '').trim();
    const homeTeam = String(match.home_team_name ?? '').trim();
    const awayTeam = String(match.away_team_name ?? '').trim();
    const competition = String(match.competition ?? '').trim();
    const matchDate = String(match.date ?? '').trim();
    const base = { matchId, homeTeam, awayTeam, competition, matchDate };
    if (!matchId || !homeTeam || !awayTeam) {
      results.push({ ...base, status: 'skipped', reason: 'fixture_incompleta' });
      continue;
    }

    try {
      let oddsData: any = await db.getLatestOddsSnapshotForMatch(matchId);
      const snapshotAgeMs = oddsData?.captured_at ? Date.now() - Date.parse(String(oddsData.captured_at)) : Infinity;
      const snapshotMarkets = Array.isArray(oddsData?.marketsRequested) ? oddsData.marketsRequested : [];
      const snapshotUsable = oddsData
        && String(oddsData.source ?? '').trim() === 'odds_api'
        && !oddsData.usedSyntheticOdds
        && Boolean(String(oddsData.selectedBookmakerName ?? '').trim())
        && Object.keys(oddsData.liveSelectedOdds ?? oddsData.selectedOdds ?? {}).length > 0
        && (snapshotMarkets.length === 0 || hasCurrentMatchMarketCoverage(snapshotMarkets))
        && Number.isFinite(snapshotAgeMs)
        && snapshotAgeMs <= maxSnapshotAgeHours * 60 * 60 * 1000;

      if (!snapshotUsable) {
        oddsData = await callApi('/scraper/odds/match', {
          matchId,
          competition,
          homeTeam,
          awayTeam,
          commenceTime: matchDate,
        });
      }

      const fallbackSelectedOdds = sanitizeOddsMap(oddsData?.liveSelectedOdds ?? oddsData?.selectedOdds ?? {});
      const automatedAnalysisBundle = buildCoherentBookmakerOddsBundle(
        Object.keys(oddsData?.allBookmakerOdds ?? {}).length > 0
          ? oddsData.allBookmakerOdds
          : (oddsData?.selectedBookmakerName
              ? { [String(oddsData.selectedBookmakerName)]: fallbackSelectedOdds }
              : {})
      );
      const odds = sanitizeOddsMap(oddsData?.analysisOdds ?? automatedAnalysisBundle.odds ?? fallbackSelectedOdds);
      const bookmakerBySelection = oddsData?.bookmakerBySelection ?? automatedAnalysisBundle.bookmakerBySelection;
      const realOdds = String(oddsData?.source ?? '').trim() === 'odds_api'
        && oddsData?.usedSyntheticOdds !== true
        && Object.keys(odds).length > 0;
      if (!realOdds) {
        results.push({ ...base, status: 'skipped', reason: 'quota_reale_non_disponibile' });
        continue;
      }

      const prediction = await callApi('/predict', {
        homeTeamId: String(match.home_team_id),
        awayTeamId: String(match.away_team_id),
        matchId,
        competition,
        oddsSource: String(oddsData?.source ?? '').trim() || 'unknown',
        bookmakerOdds: odds,
        bookmakerBySelection,
      });
      const valueOpportunities = Array.isArray(prediction?.valueOpportunities)
        ? prediction.valueOpportunities
        : [];
      const speculativeOpportunities = Array.isArray(prediction?.speculativeOpportunities)
        ? prediction.speculativeOpportunities
        : [];
      const opportunities = [...valueOpportunities, ...speculativeOpportunities];
      if (opportunities.length === 0 && prediction?.bestValueOpportunity) {
        opportunities.push(prediction.bestValueOpportunity);
      }
      if (opportunities.length === 0) {
        results.push({ ...base, status: 'skipped', reason: 'nessuna_giocata_valida' });
        continue;
      }

      const plannedDecisions = planAutomatedBetOpportunities(
        opportunities.map((opportunity: any) => ({
          ...opportunity,
          matchId: opportunity?.matchId ?? matchId,
          realBookmakerOdds: realOdds,
        })),
        maxOperationalBetsPerMatch,
      );

      for (const decision of plannedDecisions) {
        const opportunity = decision.opportunity as any;
        const betStatus = String(opportunity?.bestBetStatus ?? 'VALUE').toUpperCase();
        let budgetLookupError: string | null = null;
        let availableBudget = Number.NaN;
        try {
          const currentBudget = await svc.getBudget(userId);
          availableBudget = dryRun
            ? (simulatedAvailableBudget ?? Number(currentBudget?.available_budget ?? 0))
            : Number(currentBudget?.available_budget ?? 0);
        } catch (error: any) {
          budgetLookupError = String(error?.message ?? error);
        }
        if (simulatedAvailableBudget === null && Number.isFinite(availableBudget)) {
          simulatedAvailableBudget = availableBudget;
        }
        const suggestedStakePercent = Number(opportunity?.suggestedStakePercent ?? 0);
        const theoreticalStakeAmount = Number.isFinite(availableBudget)
          && availableBudget > 0
          && Number.isFinite(suggestedStakePercent)
          && suggestedStakePercent > 0
          ? Math.max(1, Number((availableBudget * suggestedStakePercent / 100).toFixed(2)))
          : null;
        const decisionRecord = (decisionId: string = randomUUID()) => ({
          decisionId,
          userId,
          matchId,
          marketName: String(opportunity?.marketName ?? ''),
          selection: String(opportunity?.selection ?? ''),
          confidence: String(opportunity?.confidence ?? '').toUpperCase() || null,
          bookmakerOdds: Number.isFinite(Number(opportunity?.bookmakerOdds)) ? Number(opportunity.bookmakerOdds) : null,
          bookmakerName: String(
            opportunity?.bookmakerName
            ?? bookmakerBySelection?.[String(opportunity?.selection ?? '')]
            ?? oddsData?.selectedBookmakerName
            ?? ''
          ).trim() || null,
          theoreticalStakePercent: Number.isFinite(suggestedStakePercent) ? suggestedStakePercent : null,
          theoreticalStakeAmount,
          rankingPosition: decision.rankingPosition,
        });
        const archiveSavedOnly = async (exclusionReason: string | null) => {
          try {
            await db.appendAutomatedBetDecision({
              ...decisionRecord(automatedSavedDecisionId(
                userId,
                matchId,
                opportunity?.marketName,
                opportunity?.selection,
              )),
              operationalSlot: null,
              decisionStatus: 'saved_only',
              exclusionReason,
              betId: null,
            });
          } catch (error: any) {
            throw new AutomationAuditError(`Audit decision persistence failed: ${String(error?.message ?? error)}`, error);
          }
        };
        const finalizeReservedDecision = async (
          decisionId: string,
          decisionStatus: 'placed' | 'dry_run' | 'saved_only',
          options: { betId?: string | null; exclusionReason?: string | null } = {},
        ) => {
          try {
            await db.finalizeAutomatedBetDecision(decisionId, decisionStatus, options);
          } catch (error: any) {
            throw new AutomationAuditError(`Audit decision finalization failed: ${String(error?.message ?? error)}`, error);
          }
        };
        const markPlacementUnknown = async (decisionId: string, reason: string) => {
          try {
            await db.markAutomatedBetDecisionPlacementUnknown(decisionId, reason);
          } catch (error: any) {
            throw new AutomationAuditError(`Audit ambiguous placement persistence failed: ${String(error?.message ?? error)}`, error);
          }
        };

        if (decision.action === 'saved_only') {
          await archiveSavedOnly(decision.reason);
          results.push({
            ...base,
            status: 'skipped',
            reason: decision.reason,
            selection: opportunity?.selection ?? null,
            confidence: opportunity?.confidence ?? null,
            rankingPosition: decision.rankingPosition,
            suggestedStakePercent: Number.isFinite(suggestedStakePercent) ? suggestedStakePercent : null,
            theoreticalStake: theoreticalStakeAmount,
          });
          continue;
        }

        if (budgetLookupError) {
          const reason = `budget_lookup_failed: ${budgetLookupError}`;
          await archiveSavedOnly(reason);
          results.push({ ...base, status: 'skipped', reason, selection: opportunity.selection });
          continue;
        }

        const bookmakerOdds = Number(opportunity?.bookmakerOdds);
        if (!opportunity || !Number.isFinite(bookmakerOdds) || bookmakerOdds <= 1) {
          await archiveSavedOnly('quota_reale_non_valida');
          results.push({ ...base, status: 'skipped', reason: 'quota_reale_non_valida', selection: opportunity?.selection ?? null });
          continue;
        }

        if (!Number.isFinite(availableBudget) || availableBudget <= 0) {
          await archiveSavedOnly('budget_non_disponibile');
          results.push({ ...base, status: 'skipped', reason: 'budget_non_disponibile', selection: opportunity.selection });
          continue;
        }
        if (!Number.isFinite(suggestedStakePercent) || suggestedStakePercent <= 0) {
          await archiveSavedOnly('percentuale_stake_non_valida');
          results.push({ ...base, status: 'skipped', reason: 'percentuale_stake_non_valida', selection: opportunity.selection });
          continue;
        }
        const calculatedStake = theoreticalStakeAmount as number;
        const reservationId = randomUUID();
        let reservation: { reserved: boolean; decisionId: string; operationalSlot: number | null };
        try {
          reservation = await db.reserveAutomatedBetDecision({
            ...decisionRecord(reservationId),
            operationalSlot: decision.operationalSlot,
          }, maxOperationalBetsPerMatch);
        } catch (error: any) {
          throw new AutomationAuditError(`Audit decision reservation failed: ${String(error?.message ?? error)}`, error);
        }
        if (!reservation.reserved) {
          await archiveSavedOnly('operational_slot_or_opportunity_already_reserved');
          results.push({
            ...base,
            status: 'skipped',
            reason: 'operational_slot_or_opportunity_already_reserved',
            selection: opportunity.selection,
            rankingPosition: decision.rankingPosition,
          });
          continue;
        }

        const betPayload = {
          userId,
          matchId,
          marketName: String(opportunity.marketName ?? ''),
          selection: String(opportunity.selection ?? ''),
          odds: bookmakerOdds,
          stake: calculatedStake,
          ourProbability: Number(opportunity.ourProbability ?? 0) / 100,
          expectedValue: Number(opportunity.expectedValue ?? 0) / 100,
          homeTeamName: homeTeam,
          awayTeamName: awayTeam,
          competition,
          matchDate,
        };
        if (dryRun) {
          simulatedAvailableBudget = Number((availableBudget - calculatedStake).toFixed(2));
          operationalBetCount++;
          await finalizeReservedDecision(reservation.decisionId, 'dry_run');
          results.push({ ...base, status: 'dry_run', betStatus, selection: betPayload.selection, marketName: betPayload.marketName, odds: bookmakerOdds, suggestedStakePercent, stake: calculatedStake, rankingPosition: decision.rankingPosition, operationalSlot: reservation.operationalSlot });
          continue;
        }

        let placed: any;
        try {
          placed = await svc.placeBet(
            betPayload.userId,
            betPayload.matchId,
            betPayload.marketName,
            betPayload.selection,
            betPayload.odds,
            betPayload.stake,
            betPayload.ourProbability,
            betPayload.expectedValue,
            { homeTeamName: homeTeam, awayTeamName: awayTeam, competition, matchDate, source: 'automation' }
          );
        } catch (error: any) {
          if (isAlreadyPlacedBetError(error)) {
            const reason = 'scommessa_gia_registrata';
            await finalizeReservedDecision(reservation.decisionId, 'saved_only', { exclusionReason: reason });
            results.push({
              ...base,
              status: 'skipped',
              reason,
              selection: betPayload.selection,
              marketName: betPayload.marketName,
              rankingPosition: decision.rankingPosition,
            });
            continue;
          }
          const reason = `esito_piazzamento_incerto: ${String(error?.message ?? error)}`;
          await markPlacementUnknown(reservation.decisionId, reason);
          throw new AutomationPlacementUnknownError(reason, error);
        }
        const betId = placed?.bet?.betId ?? null;
        operationalBetCount++;
        await finalizeReservedDecision(reservation.decisionId, 'placed', { betId });
        results.push({ ...base, status: 'placed', betStatus, selection: betPayload.selection, marketName: betPayload.marketName, odds: bookmakerOdds, suggestedStakePercent, stake: calculatedStake, betId, rankingPosition: decision.rankingPosition, operationalSlot: reservation.operationalSlot });
      }
    } catch (error: any) {
      if (error instanceof AutomationAuditError || error instanceof AutomationPlacementUnknownError) throw error;
      results.push({ ...base, status: 'skipped', reason: String(error?.message ?? error) });
    }
  }

  return res.json({
    success: true,
    data: {
      enabled,
      dryRun,
      userId,
      windowHours,
      maxOperationalBets: maxOperationalBetsPerMatch,
      maxOperationalBetsPerMatch,
      from: now.toISOString(),
      until: until.toISOString(),
      candidates: matches.length,
      placed: results.filter((item) => item.status === 'placed').length,
      dryRunCount: results.filter((item) => item.status === 'dry_run').length,
      operationalBetCount,
      skipped: results.filter((item) => item.status === 'skipped').length,
      results,
    },
  });
  } catch (error: any) {
    console.error('[Automation] Errore creazione giocate:', error?.message ?? error);
    return res.status(500).json({ success: false, error: error?.message ?? 'Errore automazione giocate.' });
  }
});

// ====== BACKTEST ======
router.post('/backtest', async (req: Request, res: Response) => {
  applyBacktestRouteTimeout(req, res);
  try {
    const result = await heavyJobService.runWalkForwardBacktest({
      competition: req.body.competition,
      season: req.body.season,
      historicalOdds: req.body.historicalOdds,
      options: {
        initialTrainMatches: req.body.initialTrainMatches,
        testWindowMatches: req.body.testWindowMatches,
        stepMatches: req.body.stepMatches,
        confidenceLevel: req.body.confidenceLevel,
        expandingWindow: req.body.expandingWindow,
        maxFolds: req.body.maxFolds,
        saveIndividualRuns: req.body.saveIndividualRuns === true,
        compareBaseline: req.body.compareBaseline !== false,
        optimizeRankingWeights: req.body.optimizeRankingWeights === true,
      },
    });
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
  } catch (e: any) { res.status(e instanceof HeavyJobBusyError ? 429 : 400).json({ success: false, error: e.message }); }
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

router.post('/predictions/settle-completed', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.body?.limit ?? 500);
    const result = await svc.settlePendingPredictionsForCompletedMatches(limit);
    res.json({ success: true, data: result });
  } catch (e: any) {
    console.error('[prediction-settlement] failed:', e?.stack ?? e?.message ?? e);
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/backtest/walk-forward', async (req: Request, res: Response) => {
  applyBacktestRouteTimeout(req, res);
  try {
    const result = await heavyJobService.runWalkForwardBacktest({
      competition: req.body.competition,
      season: req.body.season,
      historicalOdds: req.body.historicalOdds,
      options: {
        initialTrainMatches: req.body.initialTrainMatches,
        testWindowMatches: req.body.testWindowMatches,
        stepMatches: req.body.stepMatches,
        confidenceLevel: req.body.confidenceLevel,
        expandingWindow: req.body.expandingWindow,
        maxFolds: req.body.maxFolds,
        saveIndividualRuns: req.body.saveIndividualRuns === true,
        compareBaseline: req.body.compareBaseline !== false,
        optimizeRankingWeights: req.body.optimizeRankingWeights === true,
      },
    });
    res.json({ success: true, data: result });
  } catch (e: any) {
    res.status(e instanceof HeavyJobBusyError ? 429 : 400).json({ success: false, error: e.message });
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

// Audit-only endpoints. Transition metadata is intentionally not consumed by
// prediction scoring until its coverage and cluster backtests are validated.
router.get('/competition-transitions/audit', async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await db.getCompetitionTransitionAudit() });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

// Downloads final-result CSVs for the configured second divisions and upserts
// only seasonal reference statistics. It never enables model adjustments.
router.post('/competition-transitions/sync-references', async (_req: Request, res: Response) => {
  try {
    // Stessa policy non aggirabile degli import principali: l'input legacy
    // seasonStartYears e ignorato per non reinserire stagioni gia potate.
    const policy = fixedFiveSeasonPolicy();
    const prune = await pruneOldSeasons((db as any).db, policy.keepSeasons);
    const result = await syncTransitionSeasonReferences(db, {
      competitions: FOOTBALL_DATA_TRANSITION_LEAGUE_CODES,
      seasonStartYears: policy.seasonStartYears,
    });
    if (result.errors.length > 0 || result.persisted + result.skipped !== result.requested) {
      return res.status(502).json({
        success: false,
        error: `Sync serie inferiori incompleta: ${result.persisted + result.skipped}/${result.requested} campionati-stagioni completati.`,
        data: result,
        prune,
        modelAdjustmentEnabled: false,
        retentionPolicy: policy,
      });
    }
    return res.json({ success: true, data: result, prune, modelAdjustmentEnabled: false, retentionPolicy: policy });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/competition-transitions/competitions', async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await db.getSecondaryCompetitions() });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/competition-transitions/references', async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await db.getSourceSeasonReferences() });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/competition-transitions', async (_req: Request, res: Response) => {
  try {
    return res.json({ success: true, data: await db.getTeamCompetitionTransitions() });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/analytics/system', async (req: Request, res: Response) => {
  try {
    const competition = String(req.query.competition ?? '').trim() || undefined;
    const userId = sharedDataUserId;
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
} | null = null;

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
  const seasons = fixedFiveSeasonPolicy().seasonLabels;
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
      note: 'Understat resta la fonte primaria per squadre, partite e giocatori. football-data.co.uk completa falli, corner, tiri, cartellini e arbitro (vedi /scraper/football-data).',
    },
  });
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
      importPlayers = true,
      includeMatchDetails = true,
      forceRefresh = false,
    } = req.body ?? {};

    const competitionsToRun: string[] = mode === 'top5'
      ? UnderstatScraper.getTop5Competitions()
      : Array.isArray(competitions) && competitions.length > 0
        ? competitions
        : [competition];

    // Anche l'import manuale rispetta la medesima finestra mobile esatta.
    // seasons/yearsBack restano campi accettati dal client legacy ma non
    // possono estendere o restringere la retention tecnica.
    const retentionPolicy = fixedFiveSeasonPolicy();
    const seasonsToScrape = retentionPolicy.seasonLabels;
    // Non dipendere dal successo di football-data.co.uk: ogni entry point di
    // ingest applica autonomamente la finestra tecnica esatta.
    const retentionPrune = await pruneOldSeasons((db as any).db, retentionPolicy.keepSeasons);

    understatActiveImportMeta = {
      startedAt: new Date().toISOString(),
      mode: String(mode),
      competitions: competitionsToRun,
      seasons: seasonsToScrape,
      includeMatchDetails: Boolean(includeMatchDetails),
      forceRefresh: Boolean(forceRefresh),
      importPlayers: Boolean(importPlayers),
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
            persistedSourceMatches: 0,
            missingSourceMatches: null,
            complete: false,
            error: seasonError?.message ?? 'errore scraping stagione',
          };
          continue;
        }

        // One scoped read replaces one getMatchById round-trip per Understat item.
        // raw_json participates in the same comparison as the UPSERT, therefore
        // it is deliberately included only for this import prefetch.
        const existingMatchCache = new Map<string, any>(
          (await db.getMatches({ competition: competitionName, season, includeRawJson: true }))
            .map((row: any) => [String(row.match_id), row])
        );
        const matchesToImport = allMatches.map((match) =>
          isFutureMatch(match.date) ? toFixtureOnly(match) : match
        );

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
        const matchWrites: Record<string, unknown>[] = [];
        const pendingWriteMeta: Array<{ existedBefore: boolean; isPlayed: boolean }> = [];
        const internalizedPlayedMatches: any[] = [];

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

          const rawDbFormat = understat.toDbFormat(futureFixture ? toFixtureOnly(internalizedMatch) : internalizedMatch);
          const existingRow = existingMatchCache.get(internalizedMatch.matchId);
          const dbFormat = preserveUnderstatRichRawJson(existingRow, rawDbFormat);
          const changed = forceRefresh || !existingRow || hasUnderstatMatchUpsertChange(existingRow, dbFormat);
          // If any match changes, rebuild player aggregates from the full
          // scraped played season rather than from the changed subset only.
          if (importPlayers && isPlayed && !futureFixture) internalizedPlayedMatches.push(internalizedMatch);
          if (!changed) {
            skipped++;
            continue;
          }

          matchWrites.push(dbFormat);
          pendingWriteMeta.push({ existedBefore: Boolean(existingRow), isPlayed });
        }

        let committedCount = 0;
        let batchError: string | null = null;
        try {
          committedCount = (await db.upsertMatches(matchWrites)).committedCount;
        } catch (error) {
          committedCount = error instanceof MatchBatchCommitError ? error.committedCount : 0;
          batchError = error instanceof Error ? error.message : String(error);
          skipped += Math.max(0, matchWrites.length - committedCount);
        }
        const committedWrites = pendingWriteMeta.slice(0, committedCount);

        for (const write of committedWrites) {
          if (write.existedBefore) {
            updatedExisting++;
            if (write.isPlayed) updatedExistingPlayed++;
            else updatedExistingUpcoming++;
          } else {
            imported++;
            if (write.isPlayed) importedPlayed++;
            else importedUpcoming++;
          }
        }

        const playersRebuildSkippedReason = batchError
          ? 'match_batch_partial_failure'
          : null;
        if (shouldRebuildUnderstatPlayers(committedWrites, batchError)) {
          for (const internalizedMatch of internalizedPlayedMatches) {
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

        const persistedAfter = await db.getMatches({ competition: competitionName, season });
        const persistedIds = new Set(persistedAfter.map((row: any) => String(row.match_id)));
        const sourceIds = [...new Set(matchesToImport.map((match: any) => String(match.matchId)))];
        const missingSourceMatches = sourceIds.filter((matchId) => !persistedIds.has(matchId)).length;
        const detail = {
          lastDateBefore: lastDateInDb ?? 'nessuna',
          totalOnSource: allMatches.length,
          newImported: imported,
          updatedExisting,
          newImportedPlayed: importedPlayed,
          updatedExistingPlayed,
          newImportedUpcoming: importedUpcoming,
          updatedExistingUpcoming,
          touchedTotal: committedCount,
          skipped,
          playersUpserted: playersAgg.size,
          playersRebuildSkippedReason,
          persistedSourceMatches: sourceIds.length - missingSourceMatches,
          missingSourceMatches,
          error: batchError,
        };
        seasonSummary[`${competitionName} ${season}`] = {
          ...detail,
          complete: isCompleteUnderstatSeasonDetail(detail),
        };
      }
    }

    const competitionsNeedingPostProcessing = Array.from(
      new Set(
        competitionsToRun.filter((comp) =>
          (competitionActivity[comp]?.playedTouched ?? 0) > 0
        )
      )
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

    const predictionSettlement = await svc.settlePendingBetOpportunityPredictionsForCompletedMatches(500)
      .then((settlement) => ({ success: true, ...settlement, error: null }))
      .catch((error: any) => {
        const message = String(error?.message ?? error);
        console.warn('[understat] Chiusura prediction non completata:', message);
        return { success: false, matches: 0, settled: 0, unresolved: 0, error: message };
      });

    const lastSeason = seasonsToScrape[seasonsToScrape.length - 1];
    const lastDatesAfter: Record<string, string> = {};
    for (const comp of competitionsToRun) {
      lastDatesAfter[comp] = (await db.getLastMatchDate(comp, lastSeason)) ?? 'nessuna';
    }

    const {
      expectedSeasonPairs,
      completedSeasonPairs,
      pendingSeasonPairs,
      failedSeasonPairs,
      allExpectedSeasonsComplete,
      allExpectedSeasonsReady,
    } = summarizeUnderstatSeasonReadiness({
      competitions: competitionsToRun,
      seasons: seasonsToScrape,
      seasonSummary,
    });
    const responsePayload = {
      success: allExpectedSeasonsReady,
      data: {
        source: 'understat',
        mode,
        competitions: competitionsToRun,
        seasons: seasonsToScrape,
        retentionPolicy,
        retentionPrune,
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
        deletedMatchesByCompetition,
        autoModelFit,
        predictionSettlement,
        postProcessingCompetitions: competitionsNeedingPostProcessing,
        skippedPostProcessingCompetitions: competitionsToRun.filter((comp) => !competitionsNeedingPostProcessing.includes(comp)),
        dbLastDateAfter: lastDatesAfter,
        expectedSeasonPairs,
        completedSeasonPairs,
        pendingSeasonPairs,
        failedSeasonPairs,
        allExpectedSeasonsComplete,
        allExpectedSeasonsReady,
        isUpToDate: allExpectedSeasonsComplete && totalNew === 0,
        forceRefresh,
        message: !allExpectedSeasonsReady
          ? `Import Understat incompleto: ${completedSeasonPairs}/${expectedSeasonPairs} campionati-stagioni completi.`
          : pendingSeasonPairs.length > 0
          ? `Import Understat pronto: ${completedSeasonPairs}/${expectedSeasonPairs} stagioni complete e ${pendingSeasonPairs.length} in attesa del calendario corrente.`
          : totalNew === 0
          ? 'DB gia aggiornato da Understat.'
          : `Importate ${totalImported} partite Understat (${totalUpcomingImported} future), aggiornati ${playersUpdated} giocatori.`,
        seasonDetail: seasonSummary,
      },
    };
    if (!allExpectedSeasonsReady) {
      await persistExternalSchedulerRun(externalRun, false, responsePayload.data, responsePayload.data.message);
      return res.status(502).json(responsePayload);
    }
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
const MATCH_ODDS_CACHE_MAX_ENTRIES = 200;

const parsePositiveIntEnv = (name: string, fallback: number): number => {
  const raw = Number.parseInt(String(process.env[name] ?? '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
};

const getMatchOddsCacheTtlMs = (): number =>
  parsePositiveIntEnv('ODDS_MATCH_CACHE_TTL_SECONDS', Math.floor(DEFAULT_MATCH_ODDS_CACHE_TTL_MS / 1000)) * 1000;

const getReusableOddsSnapshotMaxAgeMs = (): number =>
  parsePositiveIntEnv('ODDS_SNAPSHOT_REUSE_HOURS', 48) * 60 * 60 * 1000;

const pruneMatchOddsCache = (now = Date.now()): void => {
  const ttlMs = getMatchOddsCacheTtlMs();
  for (const [key, cached] of matchOddsCache) {
    if (now - cached.cachedAt >= ttlMs) matchOddsCache.delete(key);
  }
};

const ensureMatchOddsCacheCapacityForInsert = (cacheKey: string): void => {
  if (matchOddsCache.has(cacheKey)) return;
  // FIFO eviction, deliberately independent from the in-flight map.
  while (matchOddsCache.size >= MATCH_ODDS_CACHE_MAX_ENTRIES) {
    const oldestKey = matchOddsCache.keys().next().value;
    if (!oldestKey) break;
    matchOddsCache.delete(oldestKey);
  }
};

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
  pruneMatchOddsCache();
  const cached = matchOddsCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt >= getMatchOddsCacheTtlMs()) {
    matchOddsCache.delete(cacheKey);
    return null;
  }
  return cached.data;
};

const setCachedMatchOddsPayload = (cacheKey: string, data: any): void => {
  pruneMatchOddsCache();
  ensureMatchOddsCacheCapacityForInsert(cacheKey);
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
  selectedBookmakerKey?: string | null;
  selectedBookmakerName?: string | null;
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
    selectedBookmakerKey: input.selectedBookmakerKey ?? null,
    selectedBookmakerName: input.selectedBookmakerName ?? null,
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

/**
 * Mercati richiesti di default dalla rotta bulk `/scraper/odds`.
 * Contiene SOLO chiavi valide di the-odds-api (verificate live 2026-07).
 * Escluse perche' inesistenti sul provider: 'shots', 'shots_on_target',
 * 'cards', 'corners', 'fouls' — restituivano "Invalid markets" a ogni giro.
 * NB: i mercati "additional" (alternate_*, player_*, btts, ecc.) sono serviti
 * dall'endpoint per-evento; sull'endpoint di competizione il provider degrada
 * automaticamente sul set featured (h2h/totals/spreads).
 */
const DEFAULT_BULK_ODDS_MARKETS: string[] = [
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
  'alternate_team_totals_corners',
  'corners_1x2',
  'alternate_totals_cards',
  'alternate_spreads_cards',
  'player_shots',
  'player_shots_on_target',
  'player_goal_scorer_anytime',
];

router.post('/scraper/odds', async (req: Request, res: Response) => {
  try {
    const startedAtMs = Date.now();
    const startedAtIso = new Date(startedAtMs).toISOString();
    const requestId = String(res.locals?.requestId ?? '');
    const runId = observability?.createRunId('odds_bulk') ?? `odds_bulk_${startedAtMs}`;

    // NB: 'shots', 'shots_on_target', 'corners', 'cards', 'fouls' NON sono
    // chiavi valide di the-odds-api (verificato live 2026-07: "Invalid
    // markets") e sono state rimosse: generavano solo richieste destinate a
    // fallire. Le equivalenti valide sono alternate_totals_cards,
    // alternate_*_corners, player_shots, player_shots_on_target.
    // I falli non esistono come mercato sul provider (vedi AGENTS.md §5).
    const {
      competition = 'Serie A',
      markets = [...DEFAULT_BULK_ODDS_MARKETS],
    } = req.body;

    const normalizedMarkets =
      Array.isArray(markets) && markets.length > 0
        ? markets.map((m: unknown) => String(m)).filter(Boolean)
        : [...DEFAULT_BULK_ODDS_MARKETS];
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
              'alternate_totals_cards',
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
        const selectedBookmakerKey = selectedProvider === 'odds_api'
          ? String(entry.selectedBookmakerKey ?? '').trim() || null
          : null;
        const selectedBookmakerName = selectedProvider === 'odds_api'
          ? String(entry.selectedBookmakerName ?? '').trim() || null
          : null;
        const snapshot = await persistOddsSnapshot({
          oddsProviderMatchId,
          competition: String(competition),
          homeTeamName: entry.match.homeTeam,
          awayTeamName: entry.match.awayTeam,
          commenceTime: entry.match.commenceTime,
          source: selectedProvider === 'odds_api' && selectedBookmakerName ? 'odds_api' : 'unavailable',
          selectedOdds: selectedBookmakerName ? liveSelectedOdds : {},
          liveSelectedOdds: selectedBookmakerName ? liveSelectedOdds : {},
          legacyOdds: {},
          estimatedOdds: {},
          fallbackOdds: usedFallbackBookmaker ? liveSelectedOdds : {},
          allBookmakerOdds: flattenProviderComparisons(entry.bookmakerComparisonByProvider),
          selectedBookmakerKey,
          selectedBookmakerName,
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

    // Once an event has started, Odds API legitimately removes it from the
    // live endpoint. The page must still use its most recent real, traced
    // bookmaker snapshot instead of showing a false "quote non trovate".
    const snapshotMatchId = String(matchId ?? '').trim();
    const latestSnapshot = snapshotMatchId
      ? await db.getLatestRealOddsSnapshotForMatch(snapshotMatchId)
      : null;
    const snapshotOdds = sanitizeOddsMap(latestSnapshot?.liveSelectedOdds ?? latestSnapshot?.selectedOdds ?? {});
    const snapshotAllBookmakerOdds = latestSnapshot?.allBookmakerOdds ?? {};
    const snapshotAnalysisBundle = buildCoherentBookmakerOddsBundle(
      Object.keys(snapshotAllBookmakerOdds).length > 0
        ? snapshotAllBookmakerOdds
        : (latestSnapshot?.selectedBookmakerName
            ? { [String(latestSnapshot.selectedBookmakerName)]: snapshotOdds }
            : {})
    );
    const snapshotCapturedAt = Date.parse(String(latestSnapshot?.captured_at ?? ''));
    const snapshotUsable = latestSnapshot
      && String(latestSnapshot.source ?? '').trim() === 'odds_api'
      && latestSnapshot.usedSyntheticOdds !== true
      && latestSnapshot.usedFallbackBookmaker !== true
      && Boolean(String(latestSnapshot.selectedBookmakerName ?? '').trim())
      && Object.keys(snapshotOdds).length > 0
      && Object.keys(snapshotAnalysisBundle.odds).length > 0
      && hasCurrentMatchMarketCoverage(latestSnapshot.marketsRequested)
      && Number.isFinite(snapshotCapturedAt)
      && Date.now() - snapshotCapturedAt <= getReusableOddsSnapshotMaxAgeMs();
    if (snapshotUsable) {
      const snapshotPayload = {
        found: true,
        message: 'Quote bookmaker reali caricate dallo snapshot salvato.',
        source: 'odds_api',
        oddsSource: 'odds_api',
        primaryProvider: 'odds_api',
        fallbackProvider: null,
        activeProvider: 'odds_api',
        selectedProvider: 'odds_api',
        selectedBookmakerKey: String(latestSnapshot.selectedBookmakerKey ?? '').trim() || null,
        selectedBookmakerName: String(latestSnapshot.selectedBookmakerName ?? '').trim(),
        fetchedAt: latestSnapshot.captured_at,
        commenceTime: latestSnapshot.commence_time ?? commenceTime ?? null,
        selectedOdds: snapshotOdds,
        oddsApiOdds: snapshotOdds,
        analysisOdds: snapshotAnalysisBundle.odds,
        bookmakerBySelection: snapshotAnalysisBundle.bookmakerBySelection,
        analysisBookmakers: snapshotAnalysisBundle.bookmakers,
        analysisBookmakerCount: snapshotAnalysisBundle.bookmakers.length,
        fallbackOdds: {},
        allBookmakerOdds: snapshotAllBookmakerOdds,
        marketCount: Object.keys(snapshotOdds).length,
        analysisOddsCount: Object.keys(snapshotAnalysisBundle.odds).length,
        selectedOddsCount: Object.keys(snapshotOdds).length,
        marketsRequested: Array.isArray(latestSnapshot.marketsRequested) ? latestSnapshot.marketsRequested : [],
        usedFallbackBookmaker: false,
        usedSyntheticOdds: false,
        snapshotReused: true,
        warnings: [],
      };
      setCachedMatchOddsPayload(cacheKey, snapshotPayload);
      return res.json({ success: true, data: snapshotPayload });
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
        'totals',
      ];
      // This is the provider-verified competition-level set. Requesting even
      // h2h_3_way/spreads here can produce a predictable 422; enrich only the
      // matched event with those markets below.
      const fallbackMarkets = [...preferredMarkets];
      const eventAdditionalMarkets = [
        ...MATCH_EVENT_ADDITIONAL_MARKETS,
        // Rimosse 'shots', 'shots_on_target', 'cards': NON sono chiavi valide di
        // the-odds-api (verificato live 2026-07, "Invalid markets") e ogni giro
        // produceva richieste destinate a fallire. Gli equivalenti validi sono
        // player_shots / player_shots_on_target e alternate_*_cards, gia' qui.
        //
        // Corner: mercato realmente giocato ma finora mai ottenuto perche' il
        // codice chiedeva la chiave 'corners', anch'essa inesistente. Le chiavi
        // valide sono le quattro qui sotto. Il fetch per-evento degrada
        // singolarmente, quindi aggiungerle e' sicuro.
        // NOTA: i FALLI non sono ottenibili da the-odds-api in nessuna forma
        // (verificato live: 'fouls', 'totals_fouls', 'alternate_totals_fouls'
        // restituiscono "Invalid markets"; confermato dalla doc ufficiale dei
        // mercati, che per il calcio elenca corner e cartellini ma NON i falli).
        // Ricerca alternative 2026-07: nessun provider con free tier reale
        // documenta i falli sul calcio; le opzioni che li potrebbero avere sono
        // a pagamento con prezzo su richiesta (vietate da AGENTS.md §2).
        // Il mercato falli resta quindi non attivabile per assenza di quote.
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
      const selectedBookmakerKey = selectedProvider === 'odds_api'
        ? String(coordinatedMatch.selectedBookmakerKey ?? '').trim() || null
        : null;
      const selectedBookmakerName = selectedProvider === 'odds_api'
        ? String(coordinatedMatch.selectedBookmakerName ?? '').trim() || null
        : null;
      const selectedOdds = selectedProvider
        && selectedBookmakerName
        ? sanitizeOddsMap(coordinatedMatch.bestOddsByProvider[selectedProvider] ?? {})
        : {};
      const liveSelectedOdds = selectedOdds;
      const estimatedOdds: Record<string, number> = {};
      const usedFallbackBookmaker = Boolean(selectedProvider && selectedProvider !== primaryProviderName);
      const usedSyntheticOdds = false;
      const source = selectedProvider === 'odds_api' && selectedBookmakerName ? 'odds_api' : 'unavailable';
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
      const analysisBundle = buildCoherentBookmakerOddsBundle(
        Object.keys(allBookmakerOdds).length > 0
          ? allBookmakerOdds
          : (selectedBookmakerName ? { [selectedBookmakerName]: selectedOdds } : {})
      );
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
          selectedBookmakerKey,
          selectedBookmakerName,
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
      const analysisOddsCount = Object.keys(analysisBundle.odds).length;

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
        success: analysisOddsCount > 0,
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
          selectedBookmakerKey,
          selectedBookmakerName,
          candidateCount,
          timeoutMs: matchTimeoutMs,
        },
        startedAt: startedAtIso,
        endedAt: new Date().toISOString(),
      });

      return {
        found: analysisOddsCount > 0,
        message: analysisOddsCount > 0
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
        selectedBookmakerKey,
        selectedBookmakerName,
        timeoutMs: matchTimeoutMs,
        fallbackReason: coordinatedMatch.fallbackReason ?? coordination.fallbackReason,
        providerHealth,
        fetchedAt: coordinatedMatch.fetchedAt,
        isMerged: coordinatedMatch.isMerged,
        freshnessMinutes: minutesSince(coordinatedMatch.fetchedAt),
        selectedOdds,
        oddsApiOdds: sanitizeOddsMap(oddsApiOdds),
        analysisOdds: analysisBundle.odds,
        bookmakerBySelection: analysisBundle.bookmakerBySelection,
        analysisBookmakers: analysisBundle.bookmakers,
        analysisBookmakerCount: analysisBundle.bookmakers.length,
        fallbackOdds,
        allBookmakerOdds,
        marketCount,
        analysisOddsCount,
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


