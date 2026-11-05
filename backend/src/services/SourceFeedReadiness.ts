import type { SourceFeedState } from './SourceFeedStore';
import { parseFootballDataCsv } from './FootballDataService';
import { createHash } from 'node:crypto';

/** Data dependencies, not replacement models or new statistical thresholds. */
export const SOURCE_MARKET_REQUIREMENTS = {
  A_goal: ['results', 'fitted_goal_parameters', 'compatible_calibration'],
  A_shots: ['results', 'shots', 'shots_conceded', 'goal_intensity', 'observed_field_samples', 'compatible_calibration'],
  A_shots_on_target: ['results', 'shots', 'shotsOnTarget', 'goal_intensity', 'observed_field_samples', 'compatible_calibration'],
  A_yellow_cards: ['results', 'yellowCards', 'goal_intensity', 'observed_field_samples', 'compatible_calibration'],
  A_booking_points: ['results', 'yellowCards', 'redCards', 'goal_intensity', 'observed_field_samples', 'compatible_calibration'],
  A_player_props: ['results', 'playerStats', 'minutes', 'player_identity', 'lineup_eligibility', 'observed_field_samples', 'compatible_calibration'],
  C_goal: ['results', 'xg', 'shots', 'past_team_history', 'compatible_frozen_artifact', 'compatible_calibration'],
} as const;

/** A source snapshot cannot attest fit, calibration or admissibility of model inputs. */
export function buildSourceFeedReadiness(feeds: readonly SourceFeedState[]) {
  return {
    scope: 'source_collection_only' as const,
    operationalDatabaseUpdated: false,
    prospectiveEligibility: 'not_attested' as const,
    competitions: feeds.map(feed => {
      const usable = feed.available && feed.status === 'available' && feed.snapshot !== null;
      const observed = usable ? feed.snapshot!.fieldAvailability : {};
      const has = (field: string) => observed[field]?.available === true;
      const markets = Object.entries(SOURCE_MARKET_REQUIREMENTS).map(([market, required]) => {
        const missingSourceFields = required.filter(field => ['results', 'xg', 'shots', 'shotsOnTarget', 'yellowCards', 'redCards', 'playerStats'].includes(field) && !has(field));
        return { market, action: 'ABSTAIN' as const, probabilities: null, computed: false,
          sourceRequirements: [...required], missingSourceFields,
          reason: !usable ? feed.reason ?? 'source_feed_unavailable' : missingSourceFields.length
            ? 'required_source_fields_unavailable' : 'model_input_adequacy_not_verified',
          ...(market === 'A_goal' && usable ? { limitation: 'results_only_path_requires_validation_and_fitted_state' } : {}),
        };
      });
      return { competition: feed.competition, season: feed.season, sourceAvailable: usable,
        sourceStatus: feed.status, acquiredAt: feed.snapshot?.acquiredAt ?? null,
        retainedSnapshotForInspectionOnly: !usable && feed.snapshot !== null,
        operations: { inspectCalendar: usable && has('calendar'), inspectResults: usable && has('results'),
          automaticSettlement: false, operationalImport: false },
        markets,
      };
    }),
  };
}

/** Offline audit of authentic downloaded CSVs, without importing or substituting xG. */
export function summarizeFootballDataEvidence(csv: string) {
  const rows = parseFootballDataCsv(csv);
  const paired = (home: keyof (typeof rows)[number], away: keyof (typeof rows)[number]) => rows.filter(row =>
    typeof row[home] === 'number' && Number.isSafeInteger(row[home]) && Number(row[home]) >= 0
    && typeof row[away] === 'number' && Number.isSafeInteger(row[away]) && Number(row[away]) >= 0).length;
  return { provider: 'football-data.co.uk', sha256: createHash('sha256').update(csv).digest('hex'), rows: rows.length,
    observedPairs: { results: paired('homeGoals', 'awayGoals'), shots: paired('homeShots', 'awayShots'),
      shotsOnTarget: paired('homeShotsOnTarget', 'awayShotsOnTarget'), yellowCards: paired('homeYellow', 'awayYellow'),
      redCards: paired('homeRed', 'awayRed'),
      xgCandidates: rows.filter(row => row.unverifiedXg?.home !== null && row.unverifiedXg?.home !== undefined
        && row.unverifiedXg?.away !== null && row.unverifiedXg?.away !== undefined).length },
    xgStatus: 'provider_semantics_unverified', xgAdmissibleAsUnderstat: false,
    automaticImportPerformed: false, probabilities: null };
}
