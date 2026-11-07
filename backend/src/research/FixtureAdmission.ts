import { predictionConfig } from '../config/predictionConfig';
import { challengerDataQualityReason } from './ChallengerDataQuality';
import { SOURCE_FEED_COOLDOWN_MS } from '../services/FootballDataOrgFeed';

/** A positive attestation must be produced by the component that actually checked the input. */
export type AdmissionEvidence = { verified: boolean; checkedAt: string; reason?: string };
export type AdmissionMarket = 'goal' | 'shots' | 'shots_on_target' | 'yellow_cards' | 'booking_points' | 'player_props';
export type AdmissionSamples = { home: number; away: number };
export type FixtureAdmissionInput = {
  asOf: string;
  fixture: { matchId: string; competition: string; season: number; homeTeamId: string; awayTeamId: string;
    kickoffAt: string; status: string; homeGoals: number | null; awayGoals: number | null };
  calendar: AdmissionEvidence & { source: string; acquiredAt: string; matchId: string; kickoffAt: string;
    homeTeamId: string; awayTeamId: string; mappingHash: string };
  identity: AdmissionEvidence;
  /** Actual, as-of input validation and fit/configuration checks, not source availability. */
  modelA: { inputs: AdmissionEvidence; fittedState: AdmissionEvidence; calibration: AdmissionEvidence };
  modelC: { inputs: AdmissionEvidence; fittedBaseline: AdmissionEvidence; artifact: AdmissionEvidence;
    calibration: AdmissionEvidence; cleanBaseline: AdmissionEvidence; teamMarketParity?: boolean };
  samples: Partial<Record<'general' | 'shots' | 'shots_on_target' | 'yellow_cards' | 'red_cards', AdmissionSamples>>;
  playerProps: AdmissionEvidence;
  marketCalibration: Partial<Record<AdmissionMarket, AdmissionEvidence>>;
  /** Individual selection, player/line and bookmaker validation belongs to the quote/selection engine. */
  quotes: Partial<Record<AdmissionMarket, AdmissionEvidence>>;
};
export type AdmissionResult = { eligible: boolean; reasons: string[] };
export type FixtureAdmissionResult = { asOf: string; matchId: string; common: AdmissionResult;
  families: Record<'A' | 'C', AdmissionResult>;
  markets: Record<AdmissionMarket, { A: AdmissionResult; C: AdmissionResult; quote: AdmissionResult }> };

const time = (value: unknown): number => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value)
  ? Date.parse(value) : NaN;
const result = (reasons: string[]): AdmissionResult => ({ eligible: reasons.length === 0, reasons: [...new Set(reasons)] });

/** Ordinary operational admission only; it neither runs inference nor attests scientific validation. */
export function evaluateFixtureAdmission(input: FixtureAdmissionInput): FixtureAdmissionResult {
  const now = time(input.asOf), fixture = input.fixture, kickoff = time(fixture.kickoffAt);
  const evidence = (item: AdmissionEvidence | undefined, code: string): string[] => {
    const checked = time(item?.checkedAt);
    if (!item || item.verified !== true || !Number.isFinite(checked) || !Number.isFinite(now) || checked > now) {
      return [item?.reason || code];
    }
    return [];
  };
  const common: string[] = [];
  if (!Number.isFinite(now) || !Number.isFinite(kickoff) || kickoff <= now) common.push('fixture_not_future');
  if (!fixture.matchId || !fixture.homeTeamId || !fixture.awayTeamId || fixture.homeTeamId === fixture.awayTeamId) common.push('fixture_identity_incomplete');
  // football-data.org: SCHEDULED has a rough date; only TIMED confirms kickoff.
  if (fixture.status === 'SCHEDULED') common.push('kickoff_not_confirmed');
  else if (fixture.status !== 'TIMED') common.push('fixture_status_not_upcoming');
  if (fixture.homeGoals !== null || fixture.awayGoals !== null) common.push('fixture_status_not_upcoming');
  common.push(...evidence(input.identity, 'fixture_identity_unverified'));
  const calendar = input.calendar, acquired = time(calendar?.acquiredAt);
  common.push(...evidence(calendar, 'calendar_unverified'));
  if (!calendar || calendar.source !== 'football-data.org' || calendar.matchId !== fixture.matchId
    || calendar.homeTeamId !== fixture.homeTeamId || calendar.awayTeamId !== fixture.awayTeamId
    || time(calendar.kickoffAt) !== kickoff || !/^[a-f0-9]{64}$/i.test(calendar.mappingHash ?? '')) common.push('calendar_fixture_mismatch');
  // Reuse the collector's documented fifteen-minute freshness policy.
  if (!Number.isFinite(acquired) || !Number.isFinite(now) || acquired > now || now - acquired >= SOURCE_FEED_COOLDOWN_MS) common.push('calendar_stale_or_unavailable');
  const a = [...common, ...evidence(input.modelA?.inputs, 'a_inputs_unverified'),
    ...evidence(input.modelA?.fittedState, 'a_fitted_state_unverified'), ...evidence(input.modelA?.calibration, 'a_calibration_unverified')];
  const c = [...common, ...evidence(input.modelC?.inputs, 'c_inputs_unverified'),
    ...evidence(input.modelC?.fittedBaseline, 'c_fitted_baseline_unverified'), ...evidence(input.modelC?.artifact, 'c_artifact_unverified'),
    ...evidence(input.modelC?.calibration, 'c_calibration_unverified'), ...evidence(input.modelC?.cleanBaseline, 'c_baseline_not_clean')];
  if (challengerDataQualityReason(fixture.matchId)) c.push('challenger_target_data_quality_quarantined');
  const validSample = (sample?: AdmissionSamples) => !!sample && Number.isSafeInteger(sample.home) && Number.isSafeInteger(sample.away)
    && sample.home >= predictionConfig.markets.minSampleSizePerTeam && sample.away >= predictionConfig.markets.minSampleSizePerTeam
    && sample.home + sample.away >= predictionConfig.markets.minCombinedSampleSize;
  const fields: Record<AdmissionMarket, Array<keyof FixtureAdmissionInput['samples']>> = {
    goal: [], shots: ['general', 'shots'], shots_on_target: ['general', 'shots', 'shots_on_target'],
    yellow_cards: ['general', 'yellow_cards'], booking_points: ['general', 'yellow_cards', 'red_cards'], player_props: [],
  };
  const markets = {} as FixtureAdmissionResult['markets'];
  for (const market of Object.keys(fields) as AdmissionMarket[]) {
    const failures = fields[market].filter(field => !validSample(input.samples?.[field])).map(field => `market_sample_insufficient:${field}`);
    if (market === 'player_props') failures.push(...evidence(input.playerProps, 'player_props_unverified'));
    failures.push(...evidence(input.marketCalibration?.[market], 'market_calibration_sample_unverified'));
    const parity = input.modelC?.teamMarketParity === true && market !== 'goal' && market !== 'player_props';
    markets[market] = { A: result([...a, ...failures]), C: result([...c, ...(market === 'goal' ? [] : parity ? [...a, ...failures] : ['c_market_unsupported'])]),
      quote: result(evidence(input.quotes?.[market], 'real_fresh_quote_unavailable')) };
  }
  return { asOf: input.asOf, matchId: fixture.matchId, common: result(common), families: { A: result(a), C: result(c) }, markets };
}
