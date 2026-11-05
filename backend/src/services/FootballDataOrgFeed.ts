import { createHash } from 'node:crypto';
import { fetchFootballDataCalendar, FOOTBALL_DATA_COMPETITIONS, FootballDataCompetition } from './modelAResearchCalendar';
import type { SourceFeedStore, SourceFeedState } from './SourceFeedStore';

export const SOURCE_FEED_VERSION = 1;
export const SOURCE_FEED_PROVIDER = 'football-data.org';
export const SOURCE_FEED_COOLDOWN_MS = 15 * 60 * 1000;
export const SOURCE_FEED_MIN_REQUEST_INTERVAL_MS = 7000;
export const SOURCE_FEED_TRANSIENT_FAILURE_BACKOFF_MS = 60 * 1000;
export const SOURCE_FEED_RETRY_POLICY_VERSION = 2;
export const SOURCE_FEED_TRANSIENT_FAILURE_REASONS = [
  'source_feed_invalid_fixture', 'calendar_network_error', 'calendar_timeout', 'calendar_invalid_json',
] as const;
// Retry policy v2 permits a later invocation after one minute for bounded
// transient failures. Successful/pending/auth/scope attempts retain 15 minutes.
// The shared-cache seven-second reservation respects the provider's 10/minute
// allowance; it cannot coordinate other caches or clients using the account.
export function sourceFeedAttemptBackoffMs(attempt: { status?: string; reason?: string | null } | null): number {
  const transient = attempt?.status === 'failure' && (SOURCE_FEED_TRANSIENT_FAILURE_REASONS.includes(attempt.reason as any)
    || /^calendar_http_5\d{2}$/.test(attempt.reason ?? ''));
  return transient ? SOURCE_FEED_TRANSIENT_FAILURE_BACKOFF_MS : SOURCE_FEED_COOLDOWN_MS;
}
const STATUSES = new Set(['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED', 'SUSPENDED', 'POSTPONED', 'CANCELLED', 'AWARDED']);
const UNSUPPORTED = ['xg', 'shots', 'shotsOnTarget', 'yellowCards', 'redCards', 'playerStats', 'odds'] as const;

export interface SourceFeedFixture {
  id: string;
  providerMatchId: string;
  homeTeamId: string;
  awayTeamId: string;
  providerHomeTeamId: string;
  providerAwayTeamId: string;
  homeTeamName: string | null;
  awayTeamName: string | null;
  kickoffUtc: string | null;
  status: string;
  homeGoals: number | null;
  awayGoals: number | null;
  resultAvailable: boolean;
  resultUnavailableReason: string | null;
  providerUpdatedAt: string | null;
  providerPublishedAt: null;
}

export interface FootballDataOrgSnapshot {
  schemaVersion: number;
  provider: string;
  competition: FootballDataCompetition;
  providerCompetitionId: string;
  competitionId: string;
  season: number;
  seasonId: string;
  providerSeasonId: string | null;
  /** Acquisition evidence for this fetch; cache hits preserve it. */
  acquiredAt: string;
  providerUpdatedAt: string | null;
  providerPublishedAt: null;
  sourceUrl: string;
  /** Hash of the full parsed payload serialized as JSON, including ignored fields. */
  payloadSha256: string;
  /** Deduplicated normalized content identity, excluding acquisition evidence. */
  contentSha256: string;
  fixtures: SourceFeedFixture[];
  coverage: {
    expectedTeams: number; teams: number; expectedFixtures: number; fixtures: number;
    calendarComplete: boolean; knownKickoffs: number; finished: number; results: number;
    missingFinishedResults: number;
  };
  fieldAvailability: Record<string, { supported: boolean; available: boolean; reason: string | null }>;
}

export class SourceFeedValidationError extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = 'SourceFeedValidationError'; }
}

function invalid(reason: string): never { throw new SourceFeedValidationError(reason); }
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
const goal = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function sourceFeedUtc(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, , offsetHour, offsetMinute] = parts;
  if (+month < 1 || +month > 12 || +day < 1 || +day > new Date(Date.UTC(+year, +month, 0)).getUTCDate()
    || +hour > 23 || +minute > 59 || +second > 59 || +(offsetHour ?? 0) > 23 || +(offsetMinute ?? 0) > 59) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function validateSourceFeedScope(competition: unknown, season: unknown): asserts competition is FootballDataCompetition {
  if (typeof competition !== 'string' || !Object.prototype.hasOwnProperty.call(FOOTBALL_DATA_COMPETITIONS, competition)
    || !Number.isInteger(season) || Number(season) < 1900 || Number(season) > 2100) invalid('source_feed_invalid_scope');
}

/** Strict source-only snapshot. It never resolves or replaces an operational ID. */
export function normalizeFootballDataOrgFeed(options: {
  payload: unknown; competition: FootballDataCompetition; season: number; acquiredAt: string;
}): FootballDataOrgSnapshot {
  const { payload, competition, season } = options;
  validateSourceFeedScope(competition, season);
  const acquiredAt = sourceFeedUtc(options.acquiredAt) ?? invalid('source_feed_invalid_acquisition_time');
  const validSeason = (value: unknown): value is Record<string, any> => {
    if (!record(value) || typeof value.startDate !== 'string' || !value.startDate.startsWith(`${season}-`)
      || !sourceFeedUtc(`${value.startDate}T00:00:00Z`)) return false;
    return value.id == null || id(value.id) !== null;
  };
  if (!record(payload) || !record(payload.competition) || payload.competition.id !== FOOTBALL_DATA_COMPETITIONS[competition]
    || (payload.competition.code != null && payload.competition.code !== competition) || !Array.isArray(payload.matches)
    || (payload.filters?.season != null && payload.filters.season !== season && payload.filters.season !== String(season))) invalid('source_feed_scope_mismatch');
  if (payload.season != null && !validSeason(payload.season)) invalid('source_feed_season_mismatch');
  const referenceSeason = payload.season ?? payload.matches.find((match: any) => validSeason(match?.season))?.season;
  if (!validSeason(referenceSeason)) invalid('source_feed_season_missing');
  const providerSeasonId = referenceSeason.id == null ? null : id(referenceSeason.id);
  const teams = new Set<string>(), identities = new Set<string>(), pairs = new Set<string>();
  const fixtures: SourceFeedFixture[] = [];
  for (const match of payload.matches) {
    if (!record(match)) invalid('source_feed_invalid_fixture');
    const providerMatchId = id(match.id), home = id(match.homeTeam?.id), away = id(match.awayTeam?.id);
    if (!providerMatchId || !home || !away || home === away || !STATUSES.has(match.status)) invalid('source_feed_invalid_fixture');
    if (identities.has(providerMatchId)) invalid('source_feed_duplicate_fixture');
    const pair = `${home}|${away}`;
    if (pairs.has(pair)) invalid('source_feed_duplicate_pair');
    identities.add(providerMatchId); pairs.add(pair); teams.add(home); teams.add(away);
    if (match.competition != null && (!record(match.competition) || match.competition.id !== FOOTBALL_DATA_COMPETITIONS[competition]
      || (match.competition.code != null && match.competition.code !== competition))) invalid('source_feed_nested_competition_mismatch');
    if (match.season == null && payload.season == null) invalid('source_feed_nested_season_missing');
    if (match.season != null && (!validSeason(match.season) || match.season.startDate !== referenceSeason.startDate
      || (providerSeasonId !== null && id(match.season.id) !== providerSeasonId))) invalid('source_feed_nested_season_mismatch');
    const kickoffUtc = match.utcDate == null ? null : sourceFeedUtc(match.utcDate);
    if (match.utcDate != null && !kickoffUtc) invalid('source_feed_invalid_kickoff');
    if (kickoffUtc && (Date.parse(kickoffUtc) < Date.parse(`${season}-07-01T00:00:00Z`)
      || Date.parse(kickoffUtc) >= Date.parse(`${season + 1}-07-01T00:00:00Z`))) invalid('source_feed_kickoff_outside_season');
    if (['TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED'].includes(match.status) && !kickoffUtc) invalid('source_feed_missing_kickoff');
    if (match.status === 'FINISHED' && Date.parse(kickoffUtc!) > Date.parse(acquiredAt)) invalid('source_feed_future_finished_fixture');
    const providerUpdatedAt = match.lastUpdated == null ? null : sourceFeedUtc(match.lastUpdated);
    if (match.lastUpdated != null && (!providerUpdatedAt || Date.parse(providerUpdatedAt) > Date.parse(acquiredAt))) invalid('source_feed_invalid_provider_update');
    const finished = match.status === 'FINISHED';
    const homeGoals = finished ? goal(match.score?.fullTime?.home) : null;
    const awayGoals = finished ? goal(match.score?.fullTime?.away) : null;
    if (finished && [match.score?.fullTime?.home, match.score?.fullTime?.away].some((value) => value != null && goal(value) === null)) invalid('source_feed_invalid_final_score');
    const resultAvailable = finished && homeGoals !== null && awayGoals !== null;
    const name = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;
    fixtures.push({
      id: `${SOURCE_FEED_PROVIDER}:match:${providerMatchId}`, providerMatchId,
      homeTeamId: `${SOURCE_FEED_PROVIDER}:team:${home}`, awayTeamId: `${SOURCE_FEED_PROVIDER}:team:${away}`,
      providerHomeTeamId: home, providerAwayTeamId: away,
      homeTeamName: name(match.homeTeam?.name), awayTeamName: name(match.awayTeam?.name),
      kickoffUtc, status: match.status, homeGoals, awayGoals, resultAvailable,
      resultUnavailableReason: resultAvailable ? null : finished ? 'finished_score_unavailable' : 'fixture_not_finished',
      providerUpdatedAt, providerPublishedAt: null,
    });
  }
  const expectedTeams = competition === 'BL1' || (competition === 'FL1' && season >= 2023) ? 18 : 20;
  const expectedFixtures = expectedTeams * (expectedTeams - 1);
  if (teams.size !== expectedTeams || fixtures.length !== expectedFixtures || pairs.size !== expectedFixtures) invalid('source_feed_calendar_incomplete');
  fixtures.sort((left, right) => Number(left.providerMatchId) - Number(right.providerMatchId));
  const finished = fixtures.filter((fixture) => fixture.status === 'FINISHED').length;
  const results = fixtures.filter((fixture) => fixture.resultAvailable).length;
  const knownKickoffs = fixtures.filter((fixture) => fixture.kickoffUtc !== null).length;
  const updates = fixtures.flatMap((fixture) => fixture.providerUpdatedAt ? [fixture.providerUpdatedAt] : []).sort();
  const providerUpdatedAt = updates.at(-1) ?? null;
  const fieldAvailability: FootballDataOrgSnapshot['fieldAvailability'] = {
    calendar: { supported: true, available: true, reason: null },
    kickoff: { supported: true, available: knownKickoffs === expectedFixtures, reason: knownKickoffs === expectedFixtures ? null : 'kickoff_incomplete' },
    results: { supported: true, available: finished > 0 && results === finished, reason: finished === 0 ? 'no_finished_fixtures' : results !== finished ? 'finished_score_unavailable' : null },
  };
  for (const field of UNSUPPORTED) fieldAvailability[field] = { supported: false, available: false, reason: 'not_provided_by_this_feed' };
  const content = {
    schemaVersion: SOURCE_FEED_VERSION, provider: SOURCE_FEED_PROVIDER, competition,
    providerCompetitionId: String(FOOTBALL_DATA_COMPETITIONS[competition]),
    competitionId: `${SOURCE_FEED_PROVIDER}:competition:${FOOTBALL_DATA_COMPETITIONS[competition]}`,
    season, seasonId: `${SOURCE_FEED_PROVIDER}:competition:${FOOTBALL_DATA_COMPETITIONS[competition]}:season:${season}`,
    providerSeasonId, providerUpdatedAt, providerPublishedAt: null as null,
    sourceUrl: `https://api.football-data.org/v4/competitions/${competition}/matches?season=${season}`,
    fixtures, coverage: { expectedTeams, teams: teams.size, expectedFixtures, fixtures: fixtures.length,
      calendarComplete: true, knownKickoffs, finished, results, missingFinishedResults: finished - results }, fieldAvailability,
  };
  return { ...content, acquiredAt, payloadSha256: hash(payload), contentSha256: hash(content) };
}

export interface SourceFeedCollectionResult {
  provider: string;
  season: number;
  requested: number;
  networkRequests: number;
  successful: number;
  cached: number;
  failed: number;
  available: number;
  feeds: SourceFeedState[];
}

/** Explicit collector; all network, time and persistence effects are injectable. */
export async function collectFootballDataOrgFeeds(options: {
  store: SourceFeedStore; season: number; apiKey: string; competitions?: FootballDataCompetition[];
  fetcher?: typeof fetchFootballDataCalendar; now?: () => Date; sleep?: (ms: number) => Promise<void>;
}): Promise<SourceFeedCollectionResult> {
  const competitions = options.competitions ?? Object.keys(FOOTBALL_DATA_COMPETITIONS) as FootballDataCompetition[];
  if (!competitions.length || competitions.length > 5 || new Set(competitions).size !== competitions.length
    || typeof options.apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(options.apiKey)) invalid('source_feed_invalid_configuration');
  competitions.forEach((competition) => validateSourceFeedScope(competition, options.season));
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetcher = options.fetcher ?? fetchFootballDataCalendar;
  const result: SourceFeedCollectionResult = { provider: SOURCE_FEED_PROVIDER, season: options.season, requested: competitions.length,
    networkRequests: 0, successful: 0, cached: 0, failed: 0, available: 0, feeds: [] };
  let previousRequestAt: number | null = null;
  for (const competition of competitions) {
    const previousState = await options.store.read(competition, options.season, now().toISOString());
    const lastAttemptAt = previousState.latestAttempt?.finishedAt ?? previousState.latestAttempt?.requestedAt;
    if (lastAttemptAt && now().getTime() - Date.parse(lastAttemptAt) < sourceFeedAttemptBackoffMs(previousState.latestAttempt)) {
      result.cached++;
      if (previousState.available) result.available++;
      result.feeds.push(previousState);
      continue;
    }
    const reservedDelay = await options.store.nextRequestDelay(now().toISOString());
    if (reservedDelay > 0) await sleep(reservedDelay);
    const attemptedAt = now().toISOString();
    const attempt = await options.store.beginAttempt(competition, options.season, attemptedAt);
    if (attempt === null) result.cached++;
    else {
      if (previousRequestAt !== null) {
        const remaining = SOURCE_FEED_MIN_REQUEST_INTERVAL_MS - (now().getTime() - previousRequestAt);
        if (remaining > 0) await sleep(remaining);
      }
      previousRequestAt = now().getTime();
      result.networkRequests++;
      try {
        const response = await fetcher({ competition, season: options.season, apiKey: options.apiKey });
        const snapshot = normalizeFootballDataOrgFeed({ ...response, competition, season: options.season });
        await options.store.succeed(attempt, snapshot, now().toISOString());
        result.successful++;
      } catch (error) {
        const reason = error instanceof SourceFeedValidationError ? error.reason
          : /^calendar_(?:http_\d{3}|timeout|network_error|invalid_json|response_too_large|invalid_configuration)$/.test(String((error as Error)?.message))
            ? String((error as Error).message) : 'source_feed_fetch_failed';
        await options.store.fail(attempt, reason, now().toISOString());
        result.failed++;
      }
    }
    const state = await options.store.read(competition, options.season, now().toISOString());
    if (state.available) result.available++;
    result.feeds.push(state);
  }
  return result;
}
