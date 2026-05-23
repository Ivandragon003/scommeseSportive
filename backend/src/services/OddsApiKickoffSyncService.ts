import { DatabaseService } from '../db/DatabaseService';
import { OddsApiService } from './OddsApiService';
import { scoreFixtureCandidate } from './odds-provider/oddsProviderUtils';

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

type KickoffSyncDb = Pick<DatabaseService, 'getUpcomingMatches' | 'updateMatchKickoff'>;

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
    private readonly oddsApiService: Pick<OddsApiService, 'getOdds'> | null = null
  ) {}

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
    const providerMatches = await service.getOdds(competition, ['h2h']);

    result.checked = upcoming.length;
    result.providerEvents = providerMatches.length;

    for (const row of upcoming) {
      const matchId = String(row.match_id ?? '').trim();
      const homeTeam = String(row.home_team_name ?? '').trim();
      const awayTeam = String(row.away_team_name ?? '').trim();
      const oldDate = toIsoOrNull(row.date);
      if (!matchId || !homeTeam || !awayTeam || !oldDate) {
        result.skippedNoMatch += 1;
        continue;
      }

      const scored = providerMatches
        .map((candidate) => ({
          candidate,
          score: scoreFixtureCandidate(candidate, homeTeam, awayTeam, oldDate),
        }))
        .filter((entry) => entry.score.reason !== 'kickoff_outside_36h_window')
        .sort((left, right) => right.score.score - left.score.score);

      const best = scored[0] ?? null;
      if (best?.score.warnings.includes('home_away_inverted_candidate')) {
        result.skippedInverted += 1;
        result.warnings.push(`home_away_inverted_candidate:${matchId}`);
        continue;
      }

      if (!best || best.score.score < MIN_MATCH_SCORE) {
        result.skippedNoMatch += 1;
        continue;
      }

      const second = scored[1] ?? null;
      if (second && best.score.score - second.score.score <= AMBIGUOUS_SCORE_DELTA) {
        result.skippedAmbiguous += 1;
        result.warnings.push(`ambiguous_odds_api_kickoff_match:${matchId}`);
        continue;
      }

      const newDate = toIsoOrNull(best.candidate.commenceTime);
      if (!newDate) {
        result.skippedNoMatch += 1;
        continue;
      }

      const diffMs = Math.abs(Date.parse(newDate) - Date.parse(oldDate));
      if (!Number.isFinite(diffMs) || diffMs <= MIN_KICKOFF_UPDATE_DIFF_MS) {
        result.skippedSmallDiff += 1;
        continue;
      }

      await this.db.updateMatchKickoff(matchId, newDate);
      result.corrected += 1;
      result.corrections.push({
        matchId,
        oldDate,
        newDate,
        homeTeam,
        awayTeam,
        providerMatchId: String(best.candidate.matchId ?? ''),
      });
      console.info('[OddsApi] kickoff_corrected_from_odds_api', {
        matchId,
        homeTeam,
        awayTeam,
        oldDate,
        newDate,
        providerMatchId: best.candidate.matchId,
      });
    }

    return result;
  }
}

export const buildOddsApiKickoffSyncService = (db: KickoffSyncDb): OddsApiKickoffSyncService =>
  new OddsApiKickoffSyncService(db);
