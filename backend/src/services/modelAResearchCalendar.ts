import * as https from 'https';

/** The alternative calendar is research-only; importing this module does not make requests. */
export const FOOTBALL_DATA_COMPETITIONS = {
  PL: 2021, BL1: 2002, FL1: 2015, SA: 2019, PD: 2014,
} as const;
export type FootballDataCompetition = keyof typeof FOOTBALL_DATA_COMPETITIONS;

const MAX_BYTES = 4 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const STATUSES = new Set(['SCHEDULED', 'TIMED', 'IN_PLAY', 'PAUSED', 'FINISHED', 'SUSPENDED', 'POSTPONED', 'CANCELLED', 'AWARDED']);

export interface ResearchCalendarFixture {
  providerMatchId: string;
  providerHomeTeamId: string;
  providerAwayTeamId: string;
  localMatchId: string | null;
  kickoffUtc: string | null;
  status: string;
  providerRevisionAt: string | null;
  providerPublishedAt: null;
  acquiredAt: string;
  issue: string | null;
}
export interface ResearchCalendarCoverage {
  providerFixtures: number;
  providerTeams: number;
  expectedTeams: number;
  expectedFixtures: number;
  mappedFixtures: number;
  unmappedFixtures: number;
  conflictingFixtures: number;
  calendarComplete: boolean;
  mappingComplete: boolean;
  errors: string[];
}

function positiveId(value: unknown): string | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}
function utc(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
  if (!parts) return null;
  const [, y, m, d, hour, minute, second] = parts.map(Number);
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** No redirects, automatic retries, response bodies or provider errors are exposed. */
export function fetchFootballDataCalendar(options: {
  competition: FootballDataCompetition; season: number; apiKey: string;
}): Promise<{ payload: unknown; acquiredAt: string }> {
  const { competition, season, apiKey } = options;
  if (!Object.prototype.hasOwnProperty.call(FOOTBALL_DATA_COMPETITIONS, competition) || !Number.isInteger(season) || season < 1900 || season > 2100 || typeof apiKey !== 'string' || !/^[\x21-\x7e]+$/.test(apiKey)) {
    return Promise.reject(new Error('calendar_invalid_configuration'));
  }
  const path = `/v4/competitions/${competition}/matches?season=${season}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: ReturnType<typeof https.get>;
    const timer = setTimeout(() => { fail('calendar_timeout'); request?.destroy(); }, TIMEOUT_MS);
    const fail = (reason: string) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(reason)); } };
    try { request = https.get({ hostname: 'api.football-data.org', protocol: 'https:', path,
      headers: { 'X-Auth-Token': apiKey, Accept: 'application/json' }, timeout: TIMEOUT_MS }, (response) => {
      if (response.statusCode !== 200) {
        fail(`calendar_http_${Number(response.statusCode) || 0}`);
        response.destroy();
        request.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BYTES) { fail('calendar_response_too_large'); request.destroy(); return; }
        chunks.push(chunk);
      });
      response.on('error', () => fail('calendar_network_error'));
      response.on('aborted', () => fail('calendar_network_error'));
      response.on('end', () => {
        if (settled) return;
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          settled = true;
          clearTimeout(timer);
          resolve({ payload, acquiredAt: new Date().toISOString() });
        } catch { fail('calendar_invalid_json'); }
      });
    }); } catch { fail('calendar_network_error'); return; }
    request.on('timeout', () => { fail('calendar_timeout'); request.destroy(); });
    request.on('error', () => fail('calendar_network_error'));
  });
}

/** Resolve ordered provider teams only through the reviewed mapping and an unambiguous local pair. */
export function resolveFootballDataCalendar(options: {
  payload: any; competition: FootballDataCompetition; season: number; acquiredAt: string;
  expectedTeamCount: number; teamMapping: Record<string, string>;
  localMatches: Array<{ id: string | number; homeTeamId: string | number; awayTeamId: string | number; source: string; sourceMatchId: string | number }>;
}): { fixtures: ResearchCalendarFixture[]; coverage: ResearchCalendarCoverage } {
  const { payload, competition, season, teamMapping, localMatches, expectedTeamCount } = options;
  const acquiredAt = utc(options.acquiredAt);
  if (!Object.prototype.hasOwnProperty.call(FOOTBALL_DATA_COMPETITIONS, competition) || !Number.isInteger(season) || !acquiredAt ||
      !Number.isInteger(expectedTeamCount) || expectedTeamCount < 2 || expectedTeamCount > 30 ||
      !teamMapping || typeof teamMapping !== 'object' || !Array.isArray(localMatches)) throw new Error('calendar_invalid_configuration');
  const errors: string[] = [];
  const seasonStart = (value: unknown): value is string => {
    if (typeof value !== 'string' || !new RegExp(`^${season}-\\d{2}-\\d{2}$`).test(value)) return false;
    return utc(`${value}T00:00:00Z`) !== null;
  };
  if (!payload || typeof payload !== 'object' || payload.competition?.id !== FOOTBALL_DATA_COMPETITIONS[competition] || !Array.isArray(payload.matches)
    || (payload.season != null && !seasonStart(payload.season?.startDate))
    || (payload.filters?.season != null && payload.filters.season !== season)) throw new Error('calendar_invalid_payload');
  const hasTopSeason = payload.season != null;
  const hasFilterSeason = payload.filters?.season === season;
  if (!hasTopSeason && !hasFilterSeason && (!payload.matches.length || payload.matches.some((m: any) => !seasonStart(m?.season?.startDate))))
    throw new Error('calendar_invalid_payload');
  const referenceSeason = hasTopSeason ? payload.season : payload.matches.find((m: any) => seasonStart(m?.season?.startDate))?.season;
  const localPairs = new Map<string, string[]>();
  const localIdCounts = new Map<string, number>();
  for (const match of localMatches) {
    const key = `${String(match.homeTeamId)}\u0000${String(match.awayTeamId)}`;
    const matches = localPairs.get(key) || [];
    const sourceId = String(match.sourceMatchId ?? '');
    if (match.source === 'understat' && /^[1-9]\d*$/.test(sourceId) && String(match.id) === `understat_${sourceId}` &&
        String(match.homeTeamId ?? '').trim() && String(match.awayTeamId ?? '').trim()) matches.push(String(match.id));
    localPairs.set(key, matches);
    const id = String(match.id);
    localIdCounts.set(id, (localIdCounts.get(id) || 0) + 1);
  }
  const mappedLocalTeams = new Set<string>();
  let mappingValid = true;
  for (const [providerId, localId] of Object.entries(teamMapping)) {
    if (!/^[1-9]\d*$/.test(providerId) || typeof localId !== 'string' || !localId.trim() || mappedLocalTeams.has(localId)) mappingValid = false;
    mappedLocalTeams.add(localId);
  }
  if (!mappingValid) errors.push('invalid_or_non_unique_mapping');
  const teams = new Set<string>();
  const ids = new Set<string>();
  const pairs = new Set<string>();
  let invalidEntries = false;
  let duplicateIds = false;
  let duplicatePairs = false;
  const fixtures: ResearchCalendarFixture[] = [];
  for (const match of payload.matches) {
    const providerMatchId = positiveId(match?.id);
    const home = positiveId(match?.homeTeam?.id);
    const away = positiveId(match?.awayTeam?.id);
    const status = match?.status;
    if (!providerMatchId || !home || !away || home === away || !STATUSES.has(status)) { invalidEntries = true; continue; }
    if (ids.has(providerMatchId)) duplicateIds = true;
    ids.add(providerMatchId);
    const pair = `${home}\u0000${away}`;
    if (pairs.has(pair)) duplicatePairs = true;
    pairs.add(pair);
    teams.add(home); teams.add(away);
    const homeLocal = Object.prototype.hasOwnProperty.call(teamMapping, home) ? teamMapping[home] : undefined;
    const awayLocal = Object.prototype.hasOwnProperty.call(teamMapping, away) ? teamMapping[away] : undefined;
    const found = homeLocal && awayLocal ? (localPairs.get(`${homeLocal}\u0000${awayLocal}`) || []) : [];
    const kickoffUtc = utc(match.utcDate);
    const providerRevisionAt = utc(match.lastUpdated);
    const nestedCompetitionMismatch = (!hasTopSeason && match.competition == null) || (match.competition != null && match.competition?.id !== FOOTBALL_DATA_COMPETITIONS[competition]);
    const nestedSeasonMismatch = (!hasTopSeason && match.season == null) || (match.season != null &&
      (!seasonStart(match.season.startDate) || (referenceSeason?.startDate != null && match.season.startDate !== referenceSeason.startDate) ||
      (match.season.id != null && referenceSeason?.id != null && match.season.id !== referenceSeason.id)));
    let issue: string | null = null;
    if (!mappingValid) issue = 'invalid_mapping';
    else if (!homeLocal || !awayLocal) issue = 'unmapped_team';
    else if (found.length !== 1) issue = found.length ? 'ambiguous_local_match' : 'missing_local_match';
    else if (localIdCounts.get(found[0]) !== 1) issue = 'ambiguous_local_match';
    else if (nestedCompetitionMismatch || nestedSeasonMismatch) issue = 'provider_scope_conflict';
    else if (match.lastUpdated != null && !providerRevisionAt) issue = 'invalid_provider_revision';
    else if (providerRevisionAt && Date.parse(providerRevisionAt) > Date.parse(acquiredAt)) issue = 'future_provider_revision';
    else if (status === 'TIMED' && !kickoffUtc) issue = 'invalid_kickoff';
    fixtures.push({ providerMatchId, providerHomeTeamId: home, providerAwayTeamId: away,
      localMatchId: issue ? null : found[0], kickoffUtc, status,
      providerRevisionAt, providerPublishedAt: null, acquiredAt, issue });
  }
  if (invalidEntries) errors.push('invalid_fixture');
  if (duplicateIds) errors.push('duplicate_provider_match_id');
  if (duplicatePairs) errors.push('duplicate_ordered_pair');
  const expectedFixtures = expectedTeamCount * (expectedTeamCount - 1);
  if (teams.size !== expectedTeamCount) errors.push('team_count_mismatch');
  if (payload.matches.length !== expectedFixtures || pairs.size !== expectedFixtures) errors.push('fixture_count_mismatch');
  const calendarComplete = !invalidEntries && !duplicateIds && !duplicatePairs && teams.size === expectedTeamCount &&
    payload.matches.length === expectedFixtures && pairs.size === expectedFixtures;
  const mappedFixtures = fixtures.filter((fixture) => fixture.localMatchId !== null).length;
  return { fixtures, coverage: { providerFixtures: payload.matches.length, providerTeams: teams.size,
    expectedTeams: expectedTeamCount, expectedFixtures, mappedFixtures,
    unmappedFixtures: fixtures.filter((fixture) => fixture.issue === 'unmapped_team' || fixture.issue === 'missing_local_match').length,
    conflictingFixtures: fixtures.filter((fixture) => fixture.issue !== null && fixture.issue !== 'unmapped_team' && fixture.issue !== 'missing_local_match').length,
    calendarComplete, mappingComplete: calendarComplete && mappingValid && mappedFixtures === expectedFixtures, errors } };
}
