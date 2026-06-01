import { DatabaseService } from '../db/DatabaseService';
import { OddsApiService } from './OddsApiService';
import { scoreFixtureCandidate } from './odds-provider/oddsProviderUtils';
import type { OddsMatch } from './OddsApiService';

type UpcomingMatchRow = {
  match_id: string;
  home_team_name?: string | null;
  away_team_name?: string | null;
  date?: string | null;
  competition?: string | null;
};

export type OddsApiKickoffCorrection = {
  matchId: string;
  oldDate: string;
  newDate: string;
  homeTeam: string;
  awayTeam: string;
  providerMatchId: string;
};

export type OddsApiKickoffSyncResult = {
  competition: string;
  checked: number;
  providerEvents: number;
  corrected: number;
  skippedAmbiguous: number;
  skippedNoMatch: number;
  skippedInverted: number;
  skippedSmallDiff: number;
  corrections: OddsApiKickoffCorrection[];
  warnings: string[];
};

export type OddsApiKickoffSyncOptions = {
  competition: string;
  season?: string;
  limit?: number;
};

export type OddsApiSingleKickoffSyncResult = {
  checked: number;
  corrected: boolean;
  skippedReason: 'invalid_match' | 'ambiguous' | 'no_match' | 'home_away_inverted' | 'small_diff' | null;
  correction: OddsApiKickoffCorrection | null;
  warnings: string[];
};

type KickoffSyncDb = Pick<DatabaseService, 'getUpcomingMatches' | 'updateMatchKickoff'>;
type OddsApiKickoffProvider = Pick<OddsApiService, 'getOdds'> & Partial<Pick<OddsApiService, 'getScores'>>;

const MIN_MATCH_SCORE = 1.8;
const AMBIGUOUS_SCORE_DELTA = 0.15;
const MIN_KICKOFF_UPDATE_DIFF_MS = 5 * 60 * 1000;

const toIsoOrNull = (value?: string | null): string | null => {
  const timestamp = Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

export class OddsApiKickoffSyncService {
  constructor(
    private readonly db: KickoffSyncDb,
    private readonly oddsApiService: OddsApiKickoffProvider | null = null
  ) {}

  private eventKey(event: OddsMatch): string {
    const home = String(event.homeTeam ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const away = String(event.awayTeam ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const timestamp = Date.parse(String(event.commenceTime ?? ''));
    const kickoff = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : String(event.commenceTime ?? '');
    return `${home}__${away}__${kickoff}`;
  }

  private mergeProviderEvents(oddsEvents: OddsMatch[], scoreEvents: OddsMatch[]): OddsMatch[] {
    const byId = new Map<string, OddsMatch>();
    const byKey = new Map<string, string>();

    const add = (event: OddsMatch, preferred: boolean) => {
      const id = String(event.matchId ?? '').trim();
      const key = this.eventKey(event);
      const existingId = (id && byId.has(id)) ? id : byKey.get(key);
      if (existingId) {
        const existing = byId.get(existingId);
        if (existing && (preferred || existing.source !== 'odds')) {
          byId.set(existingId, event);
          byKey.set(key, existingId);
        }
        return;
      }

      const resolvedId = id || key;
      byId.set(resolvedId, event);
      byKey.set(key, resolvedId);
    };

    for (const event of scoreEvents) add(event, false);
    for (const event of oddsEvents) add(event, true);
    return Array.from(byId.values());
  }

  private async loadProviderKickoffEvents(
    service: OddsApiKickoffProvider,
    competition: string
  ): Promise<{ events: OddsMatch[]; warnings: string[] }> {
    const warnings: string[] = [];
    let oddsEvents: OddsMatch[] = [];
    let scoreEvents: OddsMatch[] = [];

    try {
      oddsEvents = await service.getOdds(competition, ['h2h']);
    } catch (error: any) {
      warnings.push(`odds_events_failed:${error?.message ?? String(error)}`);
    }

    if (typeof service.getScores === 'function') {
      try {
        scoreEvents = await service.getScores(competition, 3);
      } catch (error: any) {
        warnings.push(`scores_events_failed:${error?.message ?? String(error)}`);
      }
    }

    if (oddsEvents.length === 0 && scoreEvents.length === 0 && warnings.length > 0) {
      throw new Error(warnings.join(' | '));
    }

    return {
      events: this.mergeProviderEvents(oddsEvents, scoreEvents),
      warnings,
    };
  }

  private buildCorrectionDecision(
    row: UpcomingMatchRow,
    providerMatches: OddsMatch[]
  ): OddsApiSingleKickoffSyncResult {
    const matchId = String(row.match_id ?? '').trim();
    const homeTeam = String(row.home_team_name ?? '').trim();
    const awayTeam = String(row.away_team_name ?? '').trim();
    const oldDate = toIsoOrNull(row.date);
    const warnings: string[] = [];

    if (!matchId || !homeTeam || !awayTeam || !oldDate) {
      return { checked: 1, corrected: false, skippedReason: 'invalid_match', correction: null, warnings };
    }

    const scored = providerMatches
      .map((candidate) => ({
        candidate,
        // Per correggere una data sbagliata il kickoff DB non puo essere un filtro forte:
        // prima identifichiamo la partita per home/away, poi usiamo Odds API come kickoff canonico.
        nameScore: scoreFixtureCandidate(candidate, homeTeam, awayTeam, null),
        timedScore: scoreFixtureCandidate(candidate, homeTeam, awayTeam, oldDate),
      }))
      .sort((left, right) => right.nameScore.score - left.nameScore.score);

    const best = scored[0] ?? null;
    if (best?.nameScore.warnings.includes('home_away_inverted_candidate')) {
      warnings.push(`home_away_inverted_candidate:${matchId}`);
      return { checked: 1, corrected: false, skippedReason: 'home_away_inverted', correction: null, warnings };
    }

    if (!best || best.nameScore.score < MIN_MATCH_SCORE) {
      return { checked: 1, corrected: false, skippedReason: 'no_match', correction: null, warnings };
    }

    const second = scored[1] ?? null;
    if (second && best.nameScore.score - second.nameScore.score <= AMBIGUOUS_SCORE_DELTA) {
      warnings.push(`ambiguous_odds_api_kickoff_match:${matchId}`);
      return { checked: 1, corrected: false, skippedReason: 'ambiguous', correction: null, warnings };
    }

    const newDate = toIsoOrNull(best.candidate.commenceTime);
    if (!newDate) {
      return { checked: 1, corrected: false, skippedReason: 'no_match', correction: null, warnings };
    }

    const diffMs = Math.abs(Date.parse(newDate) - Date.parse(oldDate));
    if (!Number.isFinite(diffMs) || diffMs <= MIN_KICKOFF_UPDATE_DIFF_MS) {
      return { checked: 1, corrected: false, skippedReason: 'small_diff', correction: null, warnings };
    }

    if (best.timedScore.reason === 'kickoff_outside_36h_window') {
      warnings.push(`kickoff_outside_36h_window_corrected:${matchId}`);
    }

    return {
      checked: 1,
      corrected: true,
      skippedReason: null,
      correction: {
        matchId,
        oldDate,
        newDate,
        homeTeam,
        awayTeam,
        providerMatchId: String(best.candidate.matchId ?? ''),
      },
      warnings,
    };
  }

  async syncSingleMatchKickoffFromOddsApi(
    match: UpcomingMatchRow,
    options: Pick<OddsApiKickoffSyncOptions, 'competition'>
  ): Promise<OddsApiSingleKickoffSyncResult> {
    const competition = String(options.competition ?? match?.competition ?? '').trim() || 'Serie A';
    const service = this.oddsApiService ?? new OddsApiService(String(process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY ?? ''));
    const { events: providerMatches, warnings } = await this.loadProviderKickoffEvents(service, competition);
    const decision = this.buildCorrectionDecision(match, providerMatches);
    decision.warnings.push(...warnings);

    if (decision.corrected && decision.correction) {
      await this.db.updateMatchKickoff(decision.correction.matchId, decision.correction.newDate);
      console.info('[OddsApi] kickoff_corrected_from_odds_api', {
        matchId: decision.correction.matchId,
        homeTeam: decision.correction.homeTeam,
        awayTeam: decision.correction.awayTeam,
        oldDate: decision.correction.oldDate,
        newDate: decision.correction.newDate,
        providerMatchId: decision.correction.providerMatchId,
      });
    }

    return decision;
  }

  async syncUpcomingKickoffsFromOddsApi(options: OddsApiKickoffSyncOptions): Promise<OddsApiKickoffSyncResult> {
    const competition = String(options.competition ?? '').trim() || 'Serie A';
    const result: OddsApiKickoffSyncResult = {
      competition,
      checked: 0,
      providerEvents: 0,
      corrected: 0,
      skippedAmbiguous: 0,
      skippedNoMatch: 0,
      skippedInverted: 0,
      skippedSmallDiff: 0,
      corrections: [],
      warnings: [],
    };

    const service = this.oddsApiService ?? new OddsApiService(String(process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY ?? ''));
    const upcoming = await this.db.getUpcomingMatches({
      competition,
      season: options.season,
      limit: options.limit ?? 160,
    }) as UpcomingMatchRow[];
    const { events: providerMatches, warnings: providerWarnings } = await this.loadProviderKickoffEvents(service, competition);
    result.warnings.push(...providerWarnings);

    result.checked = upcoming.length;
    result.providerEvents = providerMatches.length;

    for (const row of upcoming) {
      const decision = this.buildCorrectionDecision(row, providerMatches);
      result.warnings.push(...decision.warnings);

      if (!decision.corrected || !decision.correction) {
        if (decision.skippedReason === 'ambiguous') result.skippedAmbiguous += 1;
        else if (decision.skippedReason === 'home_away_inverted') result.skippedInverted += 1;
        else if (decision.skippedReason === 'small_diff') result.skippedSmallDiff += 1;
        else result.skippedNoMatch += 1;
        continue;
      }

      await this.db.updateMatchKickoff(decision.correction.matchId, decision.correction.newDate);
      result.corrected += 1;
      result.corrections.push(decision.correction);
      console.info('[OddsApi] kickoff_corrected_from_odds_api', {
        matchId: decision.correction.matchId,
        homeTeam: decision.correction.homeTeam,
        awayTeam: decision.correction.awayTeam,
        oldDate: decision.correction.oldDate,
        newDate: decision.correction.newDate,
        providerMatchId: decision.correction.providerMatchId,
      });
    }

    return result;
  }
}
