import { UnderstatScraper, UnderstatMatch } from './UnderstatScraper';

export const RESULTS_REFRESH_WINDOW_MS = 72 * 60 * 60 * 1000;
export const RESULTS_REFRESH_MAX_MATCHES = 200;
const TOP5 = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];

export interface MatchResultRow {
  match_id: string; home_team_id: string; away_team_id: string; date: string;
  competition: string; season: string; source?: string | null; source_match_id?: number | string | null;
  home_goals?: number | null; away_goals?: number | null;
}

export interface VerifiedFinalMatchResult {
  matchId: string; sourceMatchId: number;
  expectedHomeTeamId: string; expectedAwayTeamId: string; expectedCompetition: string;
  expectedSeason: string; expectedKickoffAt: string;
  homeGoals: number; awayGoals: number; homeXg?: number; awayXg?: number;
  source: 'understat'; observedAt: string; rawSource: Record<string, unknown>;
}

export interface MatchResultsRefreshDb {
  getRecentUnfinishedMatches(filters: { from: string; to: string; competitions: string[]; limit: number }): Promise<MatchResultRow[]>;
  getMatchById(matchId: string): Promise<MatchResultRow | null>;
  getTeam(teamId: string): Promise<Record<string, unknown> | null>;
  applyVerifiedFinalResult(input: VerifiedFinalMatchResult): Promise<{ updated: boolean; reason?: string }>;
}

export interface MatchResultsRefreshSummary {
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED'; startedAt: string; completedAt: string;
  from: string; to: string; checked: number; updated: number; unchanged: number; rejected: number;
  limitReached: boolean; reasonCounts: Record<string, number>;
  errors: Array<{ competition?: string; matchId?: string; reason: string }>;
  updates: Array<{ matchId: string; homeGoals: number; awayGoals: number; source: 'understat'; observedAt: string }>;
}

type Source = Pick<UnderstatScraper, 'scrapeSeason'>;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const positiveId = (value: unknown): number | null => {
  if (!/^[1-9]\d*$/.test(String(value ?? ''))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
};
const seasonYear = (value: unknown): number | null => {
  const match = /^(\d{4})[/-](\d{2}|\d{4})$/.exec(String(value ?? ''));
  if (!match) return null;
  const year = Number(match[1]), next = match[2].length === 2 ? Number(match[1].slice(0, 2) + match[2]) : Number(match[2]);
  return next === year + 1 ? year : null;
};
const utcTimestamp = (value: unknown, allowUnderstatNaive = false): number => {
  const raw = String(value ?? '').trim();
  const calendar = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw);
  if (!calendar) return Number.NaN;
  const [, year, month, day, hour, minute, second] = calendar.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return Number.NaN;
  const explicit = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw);
  // Understat's own datetime convention is UTC; this is not a publication timestamp.
  const normalized = allowUnderstatNaive && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z` : raw;
  return explicit || normalized !== raw ? Date.parse(normalized) : Number.NaN;
};
const score = (value: unknown): number | null => {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  return /^(0|[1-9]\d?)$/.test(text) ? Number(text) : null;
};
const xg = (value: unknown): number | undefined | null => {
  if (value == null || value === '') return undefined;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(value))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed <= 100 ? parsed : null;
};

/** Refreshes verified final scores only; it never predicts, registers bets, or settles portfolios. */
export class MatchResultsRefreshService {
  private readonly source: Source;
  private readonly clock: () => Date;
  private readonly limit: number;
  private readonly sourceTimeoutMs: number;
  private inFlight: Promise<MatchResultsRefreshSummary> | undefined;

  constructor(private readonly db: MatchResultsRefreshDb,
    options: { source?: Source; clock?: () => Date; limit?: number; sourceTimeoutMs?: number } = {}) {
    this.source = options.source ?? new UnderstatScraper();
    this.clock = options.clock ?? (() => new Date());
    this.limit = Math.min(RESULTS_REFRESH_MAX_MATCHES, Math.max(1, Math.floor(options.limit ?? RESULTS_REFRESH_MAX_MATCHES)));
    this.sourceTimeoutMs = Math.min(30000, Math.max(1, Math.floor(options.sourceTimeoutMs ?? 15000)));
    if (!Number.isFinite(this.limit) || !Number.isFinite(this.sourceTimeoutMs)) throw new Error('Invalid results refresh bounds');
  }

  refresh(): Promise<MatchResultsRefreshSummary> {
    if (this.inFlight) return this.inFlight;
    const pending = this.run();
    this.inFlight = pending;
    void pending.then(() => { if (this.inFlight === pending) this.inFlight = undefined; },
      () => { if (this.inFlight === pending) this.inFlight = undefined; });
    return pending;
  }

  private async fetch(competition: string, season: string): Promise<UnderstatMatch[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const data = await Promise.race([this.source.scrapeSeason(competition, season, { includeDetails: false }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('source_timeout')), this.sourceTimeoutMs); })]);
      if (!Array.isArray(data) || data.length > 1000) throw new Error('source_payload_invalid');
      return data;
    } finally { if (timer) clearTimeout(timer); }
  }

  private async run(): Promise<MatchResultsRefreshSummary> {
    const startedAt = this.clock().toISOString(), now = Date.parse(startedAt);
    const start = new Date(startedAt);
    const year = start.getUTCMonth() >= 6 ? start.getUTCFullYear() : start.getUTCFullYear() - 1;
    const season = `${year}/${year + 1}`;
    const from = new Date(now - RESULTS_REFRESH_WINDOW_MS).toISOString();
    const summary: MatchResultsRefreshSummary = { status: 'SUCCESS', startedAt, completedAt: startedAt,
      from, to: startedAt, checked: 0, updated: 0, unchanged: 0, rejected: 0, limitReached: false,
      reasonCounts: {}, errors: [], updates: [] };
    const reject = (reason: string) => { summary.rejected++; summary.reasonCounts[reason] = (summary.reasonCounts[reason] ?? 0) + 1; };
    const candidates = await this.db.getRecentUnfinishedMatches({ from, to: startedAt, competitions: [...TOP5], limit: this.limit });
    if (!Array.isArray(candidates)) throw new Error('Results refresh candidates unavailable');
    summary.limitReached = candidates.length >= this.limit;
    const bounded = candidates.slice(0, this.limit);
    const identities = new Map<string, number>();
    bounded.forEach((row) => identities.set(row?.match_id, (identities.get(row?.match_id) ?? 0) + 1));
    const eligible = bounded.filter((row) => {
      summary.checked++;
      if (!row || identities.get(row.match_id) !== 1) { reject('duplicate_or_invalid_candidate'); return false; }
      const date = utcTimestamp(row.date);
      if (!Number.isFinite(date) || date < Date.parse(from) || date > now) { reject('candidate_outside_time_window'); return false; }
      if (!TOP5.includes(row.competition) || seasonYear(row.season) !== year) { reject('candidate_outside_current_top5_season'); return false; }
      if (row.source !== 'understat' || !/^understat_[1-9]\d*$/.test(row.match_id)
        || positiveId(row.source_match_id) !== positiveId(row.match_id.slice(10))) { reject('candidate_source_identity_unverified'); return false; }
      return true;
    });
    const leagues = [...new Set(eligible.map((row) => row.competition))];
    const feeds = new Map<string, { matches: UnderstatMatch[]; observedAt: string }>();
    await Promise.all(leagues.map(async (competition) => {
      try { feeds.set(competition, { matches: await this.fetch(competition, season), observedAt: this.clock().toISOString() }); }
      catch (error) {
        const reason = error instanceof Error && ['source_timeout', 'source_payload_invalid'].includes(error.message)
          ? error.message : 'source_fetch_failed';
        summary.errors.push({ competition, reason });
      }
    }));
    const teams = new Map<string, Promise<Record<string, unknown> | null>>();
    const sourceTeamId = async (internalId: string): Promise<number | null> => {
      if (!internalId) return null;
      if (!teams.has(internalId)) teams.set(internalId, this.db.getTeam(internalId));
      const team = await teams.get(internalId);
      if (!team || team.team_id !== internalId) return null;
      const stored = positiveId(team?.source_team_id), prefixed = /^understat_team_([1-9]\d*)$/.exec(internalId);
      const encoded = prefixed ? positiveId(prefixed[1]) : null;
      return stored && encoded && stored !== encoded ? null : stored ?? encoded;
    };
    for (const candidate of eligible) {
      const feed = feeds.get(candidate.competition);
      if (!feed) { reject('source_feed_unavailable'); continue; }
      try {
        const matches = feed.matches.filter((row) => row?.matchId === candidate.match_id);
        if (matches.length !== 1) { reject(matches.length ? 'source_duplicate_match' : 'source_match_missing'); continue; }
        const found = matches[0];
        let raw: unknown;
        if (typeof found.rawJson !== 'string' || found.rawJson.length > 65536) { reject('source_payload_invalid'); continue; }
        try { raw = JSON.parse(found.rawJson); } catch { reject('source_payload_invalid'); continue; }
        if (!record(raw) || raw.isResult !== true) { reject('source_not_final'); continue; }
        const rawId = positiveId(raw.id), homeId = positiveId(raw.h?.id), awayId = positiveId(raw.a?.id);
        const date = utcTimestamp(raw.datetime, true), sourceDate = utcTimestamp(found.date, true);
        if (!rawId || !homeId || !awayId || homeId === awayId
          || rawId !== positiveId(candidate.source_match_id) || found.sourceMatchId !== rawId
          || homeId !== positiveId(found.homeTeamId) || awayId !== positiveId(found.awayTeamId)
          || found.competition !== candidate.competition || seasonYear(found.season) !== year) {
          reject('source_identity_mismatch'); continue;
        }
        if (!Number.isFinite(date) || date !== sourceDate || date !== utcTimestamp(candidate.date)
          || date > Date.parse(feed.observedAt) || date > now) { reject('source_kickoff_mismatch_or_future'); continue; }
        const homeGoals = score(raw.goals?.h), awayGoals = score(raw.goals?.a);
        const homeXg = xg(raw.xG?.h), awayXg = xg(raw.xG?.a);
        if (homeGoals === null || awayGoals === null || found.homeGoals !== homeGoals || found.awayGoals !== awayGoals) {
          reject('source_score_invalid'); continue;
        }
        if (homeXg === null || awayXg === null) { reject('source_xg_invalid'); continue; }
        const current = await this.db.getMatchById(candidate.match_id);
        if (!current || current.match_id !== candidate.match_id || current.home_team_id !== candidate.home_team_id
          || current.away_team_id !== candidate.away_team_id || current.competition !== candidate.competition
          || current.season !== candidate.season || current.date !== candidate.date
          || current.source !== 'understat' || positiveId(current.source_match_id) !== rawId) { reject('match_changed'); continue; }
        if (await sourceTeamId(current.home_team_id) !== homeId || await sourceTeamId(current.away_team_id) !== awayId) {
          reject('team_identity_mismatch'); continue;
        }
        if ((current.home_goals != null && current.home_goals !== homeGoals)
          || (current.away_goals != null && current.away_goals !== awayGoals)) { reject('existing_result_conflict'); continue; }
        if (current.home_goals === homeGoals && current.away_goals === awayGoals) { summary.unchanged++; continue; }
        const result = await this.db.applyVerifiedFinalResult({ matchId: candidate.match_id, sourceMatchId: rawId!,
          expectedHomeTeamId: current.home_team_id, expectedAwayTeamId: current.away_team_id,
          expectedCompetition: current.competition, expectedSeason: current.season, expectedKickoffAt: current.date,
          homeGoals, awayGoals, ...(homeXg !== undefined ? { homeXg } : {}), ...(awayXg !== undefined ? { awayXg } : {}),
          source: 'understat', observedAt: feed.observedAt, rawSource: raw });
        if (!result.updated) {
          if (!result.reason || result.reason === 'unchanged') summary.unchanged++;
          else reject(result.reason);
          continue;
        }
        summary.updated++;
        summary.updates.push({ matchId: candidate.match_id, homeGoals, awayGoals, source: 'understat', observedAt: feed.observedAt });
      } catch {
        summary.errors.push({ matchId: candidate.match_id, reason: 'result_refresh_failed' });
      }
    }
    summary.completedAt = this.clock().toISOString();
    summary.errors.sort((a, b) => `${a.competition ?? ''}:${a.matchId ?? ''}:${a.reason}`
      .localeCompare(`${b.competition ?? ''}:${b.matchId ?? ''}:${b.reason}`));
    if (summary.errors.length) summary.status = summary.updated || summary.unchanged ? 'PARTIAL' : 'FAILED';
    else if (summary.rejected) summary.status = 'PARTIAL';
    return summary;
  }
}
