import type { Client, InValue, InStatement } from '@libsql/client';
import { createHash, randomUUID } from 'node:crypto';
import { CollectionScope } from './ModelAProspectiveCollection';
import { fetchFootballDataCalendar, FootballDataCompetition, resolveFootballDataCalendar } from '../services/modelAResearchCalendar';

const COMPETITIONS: Array<{ name: string; code: FootballDataCompetition }> = [
  { name: 'Serie A', code: 'SA' }, { name: 'Premier League', code: 'PL' },
  { name: 'La Liga', code: 'PD' }, { name: 'Bundesliga', code: 'BL1' }, { name: 'Ligue 1', code: 'FL1' },
];
export type CalendarTeamMapping = Record<string, Record<string, string>>;
export function calendarMappingHash(mapping: CalendarTeamMapping): string {
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping) || Object.keys(mapping).length !== COMPETITIONS.length) throw new Error('calendar_mapping_invalid');
  const normalized: Record<string, Array<[string, string]>> = {};
  for (const { name } of COMPETITIONS) {
    const teams = mapping[name];
    if (!teams || typeof teams !== 'object' || Array.isArray(teams)) throw new Error('calendar_mapping_invalid');
    const entries = Object.entries(teams).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (entries.some(([id, local]) => !/^[1-9]\d*$/.test(id) || typeof local !== 'string' || !local.trim() || local !== local.trim()) || new Set(entries.map(([, local]) => local)).size !== entries.length) throw new Error('calendar_mapping_invalid');
    normalized[name] = entries;
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
export type CalendarEvidence = {
  source: 'football-data.org'; attemptId: string; observationId: string; providerMatchId: string; matchId: string;
  homeTeamId: string; awayTeamId: string; competition: string; season: string; kickoffAt: string;
  acquiredAt: string; providerLastUpdated: string | null; publicationAt: null; mappingSha256: string; maxAgeSeconds: number;
};
export type CalendarProjection = { matchId: string; homeTeamId: string; awayTeamId: string; competition: string; season: string; date: string; status: string; evidence: CalendarEvidence };
type Fetch = typeof fetchFootballDataCalendar;

/** Research-only append-only observations. No calls occur until refresh is explicitly invoked. */
export class ModelAResearchCalendarStore {
  private readonly clock: () => Date;
  private readonly fetch: Fetch;
  private scope: CollectionScope | null = null;
  constructor(private readonly client: Client, private readonly options: { mapping: CalendarTeamMapping; apiKey: string; fetch?: Fetch; clock?: () => Date }) {
    this.clock = options.clock ?? (() => new Date());
    this.fetch = options.fetch ?? fetchFootballDataCalendar;
  }
  private now(): string { const time = this.clock(); if (!(time instanceof Date) || !Number.isFinite(time.getTime())) throw new Error('calendar_clock_invalid'); return time.toISOString(); }
  async refresh(scope: CollectionScope): Promise<{ fixtures: CalendarProjection[]; invalidKickoffCount: number; unavailableCompetitions: string[] }> {
    if (!scope.calendar || scope.calendar.source !== 'football-data.org' || calendarMappingHash(this.options.mapping) !== scope.calendar.mappingSha256 || scope.seasons.length !== 1 || !/^\d{4}\/(?:\d{2}|\d{4})$/.test(scope.seasons[0])) throw new Error('calendar_scope_invalid');
    const season = scope.seasons[0], year = Number(season.slice(0, 4));
    if (Number(season.slice(5)) !== (season.length === 7 ? (year + 1) % 100 : year + 1)) throw new Error('calendar_scope_invalid');
    this.scope = scope;
    const projections: CalendarProjection[] = [];
    let invalidKickoffCount = 0;
    const unavailableCompetitions: string[] = [];
    for (const { name, code } of COMPETITIONS) {
      const local = (await this.client.execute({ sql: 'SELECT match_id,home_team_id,away_team_id,source,source_match_id FROM matches WHERE competition=? AND season=?', args: [name, season] })).rows;
      const localMatches = local.map(row => ({ id: String(row.match_id), homeTeamId: String(row.home_team_id ?? ''), awayTeamId: String(row.away_team_id ?? ''), source: String(row.source ?? ''), sourceMatchId: String(row.source_match_id ?? '') }));
      let result: ReturnType<typeof resolveFootballDataCalendar>;
      let acquiredAt: string;
      try {
        const response = await this.fetch({ competition: code, season: year, apiKey: this.options.apiKey });
        acquiredAt = this.now();
        result = resolveFootballDataCalendar({ payload: response.payload, competition: code, season: year, acquiredAt,
          expectedTeamCount: scope.calendar.expectedTeamCounts[name], teamMapping: this.options.mapping[name], localMatches });
      } catch (error) {
        unavailableCompetitions.push(name);
        const attemptId = randomUUID(), at = this.now();
        const raw = error instanceof Error ? error.message : '';
        const safeCode = /^calendar_http_(?:401|403|429|5\d\d)$/.test(raw) ? raw : 'calendar_fetch_or_payload_error';
        await this.client.execute({ sql: 'INSERT INTO model_a_calendar_attempts(attempt_id,protocol_id,competition,season,acquired_at,status,coverage_json,fixture_attempt_id) VALUES(?,?,?,?,?,?,?,NULL)', args: [attemptId, scope.protocolId, name, season, at, 'failed', JSON.stringify({ complete: false, providerFixtures: null, unmapped: null, conflicts: null, duplicates: null, error: safeCode })] });
        continue;
      }
      const attemptId = randomUUID();
      const duplicates = result.coverage.errors.filter(e => e === 'duplicate_provider_match_id' || e === 'duplicate_ordered_pair').length;
      const entries = result.fixtures.map(f => ({ f, observationId: String(randomUUID()),
        homeTeamId: this.options.mapping[name][f.providerHomeTeamId] ?? null,
        awayTeamId: this.options.mapping[name][f.providerAwayTeamId] ?? null }));
      // Bind provider team identity as well as persisted fixture fields; never hash raw responses or secrets.
      const normalized = entries.map(({ f, homeTeamId, awayTeamId }) => [f.providerMatchId, f.localMatchId, f.kickoffUtc, f.status, f.providerRevisionAt, f.issue, homeTeamId, awayTeamId])
        .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
      const providerTeams = entries.map(({ f }) => [f.providerMatchId, f.providerHomeTeamId, f.providerAwayTeamId])
        .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
      const snapshotHash = createHash('sha256').update(JSON.stringify({ mappingSha256: scope.calendar.mappingSha256, competition: name, season, fixtures: normalized, providerTeams })).digest('hex');
      if (!result.coverage.calendarComplete || !result.coverage.mappingComplete) unavailableCompetitions.push(name);
      const coverage = { complete: result.coverage.calendarComplete && result.coverage.mappingComplete,
        providerFixtures: result.coverage.providerFixtures, unmapped: result.coverage.unmappedFixtures,
        conflicts: result.coverage.conflictingFixtures, duplicates, errors: result.coverage.errors, snapshotHash };
      let fixtureAttemptId: string = attemptId;
      {
        const previous = (await this.client.execute({ sql: `SELECT status,coverage_json,fixture_attempt_id FROM model_a_calendar_attempts
          WHERE protocol_id=? AND competition=? AND season=? ORDER BY julianday(acquired_at) DESC,attempt_id DESC LIMIT 1`, args: [scope.protocolId, name, season] })).rows[0];
        let previousCoverage: any = null;
        try { previousCoverage = previous && JSON.parse(String(previous.coverage_json)); } catch { /* Do not reuse malformed evidence. */ }
        if (previous?.status === 'success' && previousCoverage?.snapshotHash === snapshotHash && previous.fixture_attempt_id) {
          const oldRows = (await this.client.execute({ sql: 'SELECT * FROM model_a_calendar_fixtures WHERE attempt_id=?', args: [previous.fixture_attempt_id] })).rows;
          const oldNormalized = oldRows.map(row => [row.provider_match_id, row.match_id, row.kickoff_at, row.status, row.provider_last_updated, row.issue, row.home_team_id, row.away_team_id])
            .sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
          if (JSON.stringify(oldNormalized) === JSON.stringify(normalized) && oldRows.length === entries.length) {
            const ids = new Map(oldRows.map(row => [String(row.provider_match_id), String(row.observation_id)]));
            if (ids.size === entries.length && entries.every(entry => ids.has(entry.f.providerMatchId))) {
              fixtureAttemptId = String(previous.fixture_attempt_id);
              for (const entry of entries) entry.observationId = ids.get(entry.f.providerMatchId)!;
            }
          }
        }
      }
      const statements: InStatement[] = [{ sql: 'INSERT INTO model_a_calendar_attempts(attempt_id,protocol_id,competition,season,acquired_at,status,coverage_json,fixture_attempt_id) VALUES(?,?,?,?,?,?,?,?)',
        args: [attemptId, scope.protocolId, name, season, acquiredAt, 'success', JSON.stringify(coverage), fixtureAttemptId] }];
      const produced: CalendarProjection[] = [];
      for (const { f, observationId, homeTeamId, awayTeamId } of entries) {
        if (fixtureAttemptId === attemptId) statements.push({ sql: 'INSERT INTO model_a_calendar_fixtures(observation_id,attempt_id,provider_match_id,match_id,kickoff_at,status,provider_last_updated,issue,home_team_id,away_team_id) VALUES(?,?,?,?,?,?,?,?,?,?)',
          args: [observationId, attemptId, f.providerMatchId, f.localMatchId, f.kickoffUtc, f.status, f.providerRevisionAt, f.issue, homeTeamId, awayTeamId] as InValue[] });
        if (f.status === 'TIMED' && !f.kickoffUtc) invalidKickoffCount++;
        if (coverage.complete && f.localMatchId && f.kickoffUtc && homeTeamId && awayTeamId) {
          const evidence: CalendarEvidence = { source: 'football-data.org', attemptId, observationId, providerMatchId: f.providerMatchId, matchId: f.localMatchId,
            homeTeamId, awayTeamId, competition: name, season, kickoffAt: f.kickoffUtc, acquiredAt, providerLastUpdated: f.providerRevisionAt, publicationAt: null, mappingSha256: scope.calendar.mappingSha256, maxAgeSeconds: scope.calendar.maxAgeSeconds };
          produced.push({ matchId: f.localMatchId, homeTeamId, awayTeamId, competition: name, season, date: f.kickoffUtc, status: f.status, evidence });
        }
      }
      await this.client.batch(statements, 'write');
      projections.push(...produced);
    }
    const completedAt = Date.parse(this.now());
    for (const fixture of projections) {
      const age = completedAt - Date.parse(fixture.evidence.acquiredAt);
      if ((!Number.isFinite(age) || age < 0 || age > scope.calendar.maxAgeSeconds * 1000) && !unavailableCompetitions.includes(fixture.competition)) unavailableCompetitions.push(fixture.competition);
    }
    return { fixtures: projections.filter(fixture => !unavailableCompetitions.includes(fixture.competition)), invalidKickoffCount, unavailableCompetitions };
  }
  async current(matchId: string, observationId: string, attemptId: string): Promise<CalendarEvidence | null> {
    if (!this.scope?.calendar) return null;
    const rows = (await this.client.execute({ sql: `SELECT f.*,a.protocol_id,a.competition,a.season,a.acquired_at,a.status AS attempt_status,a.coverage_json,a.attempt_id AS current_attempt_id
      FROM model_a_calendar_fixtures f JOIN model_a_calendar_attempts a ON a.fixture_attempt_id=f.attempt_id
      WHERE f.observation_id=? AND f.match_id=? AND a.protocol_id=? AND a.attempt_id=?`, args: [observationId, matchId, this.scope.protocolId, attemptId] })).rows;
    if (rows.length !== 1) return null;
    const row = rows[0];
    const latest = (await this.client.execute({ sql: `SELECT attempt_id,acquired_at,status FROM model_a_calendar_attempts WHERE protocol_id=? AND competition=? AND season=? ORDER BY julianday(acquired_at) DESC,attempt_id DESC LIMIT 2`, args: [this.scope.protocolId, row.competition, row.season] })).rows;
    if (!latest.length || latest[0].attempt_id !== row.current_attempt_id || (latest.length > 1 && latest[1].acquired_at === latest[0].acquired_at)) return null;
    const age = Date.parse(this.now()) - Date.parse(String(row.acquired_at));
    if (!Number.isFinite(age) || age < 0 || age > this.scope.calendar.maxAgeSeconds * 1000 || row.attempt_status !== 'success' || row.status !== 'TIMED' || row.issue != null || !row.kickoff_at || !row.home_team_id || !row.away_team_id) return null;
    try { const counts = JSON.parse(String(row.coverage_json)); if (counts.complete !== true || counts.unmapped !== 0 || counts.conflicts !== 0 || counts.duplicates !== 0) return null; } catch { return null; }
    return { source: 'football-data.org', attemptId, observationId, providerMatchId: String(row.provider_match_id), matchId,
      homeTeamId: String(row.home_team_id), awayTeamId: String(row.away_team_id), competition: String(row.competition), season: String(row.season), kickoffAt: String(row.kickoff_at),
      acquiredAt: String(row.acquired_at), providerLastUpdated: row.provider_last_updated == null ? null : String(row.provider_last_updated), publicationAt: null, mappingSha256: this.scope.calendar.mappingSha256, maxAgeSeconds: this.scope.calendar.maxAgeSeconds };
  }
}
