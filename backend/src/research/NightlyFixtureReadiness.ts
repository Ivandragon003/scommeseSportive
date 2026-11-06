import { PredictionContextBuilder } from '../services/PredictionContextBuilder';
import { predictionEngineConfig } from '../config/PredictionEngineConfig';
import type { SourceFeedStore } from '../services/SourceFeedStore';
import type { FootballDataCompetition } from '../services/modelAResearchCalendar';
import { createHash } from 'node:crypto';
import { HISTORICAL_RESULT_DELAY_MS } from '../services/ChronologicalForecastService';
import { buildForecastInput, baselineManifest } from './ForecastCore';
import { researchMatchFromRow } from './ResearchRuntime';
import { filterChallengerHistory, CHALLENGER_DATA_QUALITY_POLICY_HASH } from './ChallengerDataQuality';
import { CHALLENGER_FEATURE_SCHEMA_VERSION, withChallengerFeatures } from './ChallengerFeatures';
import { predictHybrid, validateArtifact } from './CatBoostModel';
import { applyCoherentProbabilityPipeline, coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } from './CoherentProbabilityPipeline';
import { buildProbabilityConfiguration } from './ProbabilityConfiguration';
import { researchHash } from './ResearchStore';
import { evaluateFixtureAdmission, FixtureAdmissionInput, AdmissionEvidence, AdmissionMarket } from './FixtureAdmission';
import type { ChallengerExecutionState } from './ResearchRecommendationPolicy';

type CalendarEntry = { providerMatchId: string; localMatchId: string | null; relatedLocalMatchIds?: string[]; action: string; reason: string | null;
  providerStatus: string; homeTeamId: string; awayTeamId: string; kickoffUtc: string };
type Feed = { source: string | null; status: string; reason: string | null; mappingSha256: string | null;
  attemptedAt: string | null; acquiredAt: string | null; payloadSha256: string | null; fixtures: CalendarEntry[] };
export type NightlySourceManifest = { competitions: Array<{ competition: FootballDataCompetition; local: string; feed: Feed }> };
export type NightlySourceMapping = { version: string; reference: string; reviewedAt: string; teams: Record<string, Record<string, string>> };
type Db = { getMatchById(id: string): Promise<any>; getMatches(filters?: any): Promise<any[]>;
  getTeamsByIds(ids: string[]): Promise<any[]>; getLatestModelParams(competition: string): Promise<any>;
  research: { getModelByVersion(family: string, version: string): Promise<any>; getLatestBenchmark(family: string, version: string): Promise<any> } };
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const stringTime = (value: unknown) => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) && Number.isFinite(Date.parse(value));
const utc = (value: unknown) => stringTime(value) ? Date.parse(value as string) : NaN;
// model_params.fitted_at uses SQLite datetime('now'), which is UTC without a suffix.
const fitTime = (value: unknown) => typeof value === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value)
  ? Date.parse(value.replace(' ', 'T') + 'Z') : utc(value);
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

/** Read-only adapter; all positive evidence is derived from the supplied current DB and source manifest. */
export async function loadNightlyFixtureReadiness(db: Db, manifest: NightlySourceManifest, matchId: string,
  asOf: string, deployment: ChallengerExecutionState, options: { sourceStore?: Pick<SourceFeedStore, 'read'>; mapping?: NightlySourceMapping } = {}) {
  if (!stringTime(asOf)) throw new Error('fixture_readiness_invalid_asof');
  const checkedAt = new Date(Date.parse(asOf)).toISOString(), now = Date.parse(checkedAt);
  const ev = (verified: boolean, reason: string): AdmissionEvidence => ({ verified, checkedAt, ...(verified ? {} : { reason }) });
  const row = await db.getMatchById(matchId);
  if (!row) throw new Error('fixture_readiness_match_missing');
  const section = manifest?.competitions?.find(item => item.local === row.competition);
  const feed = section?.feed;
  const season = Number(String(row.season ?? '').match(/^\d{4}/)?.[0]);
  let state: Awaited<ReturnType<SourceFeedStore['read']>> | undefined;
  try { if (options.sourceStore && section) state = await options.sourceStore.read(section.competition, season, checkedAt); } catch { /* Fail closed. */ }
  const candidates = (feed?.fixtures ?? []).filter(item => item.localMatchId === matchId || item.relatedLocalMatchIds?.includes(matchId));
  const entry = candidates.length === 1 ? candidates[0] : undefined;
  const raw = state?.snapshot?.fixtures.find(item => item.providerMatchId === entry?.providerMatchId);
  const mapping = options.mapping, mappedTeams = mapping?.teams?.[row.competition];
  const mappingDescriptor = mapping && section && mappedTeams ? { version: mapping.version, reference: mapping.reference,
    reviewedAt: mapping.reviewedAt, competition: section.competition, season, teams: mappedTeams } : null;
  const mappingDigest = mappingDescriptor ? createHash('sha256').update(JSON.stringify(canonical(mappingDescriptor))).digest('hex') : null;
  const mappingGood = !!mappingDescriptor && !!mapping?.version?.trim() && !!mapping.reference?.trim()
    && stringTime(mapping.reviewedAt) && utc(mapping.reviewedAt) <= now && mappingDigest === feed?.mappingSha256
    && !!raw && mappedTeams[raw.providerHomeTeamId] === row.home_team_id && mappedTeams[raw.providerAwayTeamId] === row.away_team_id;
  const currentSource = !!state?.available && state.status === 'available' && state.latestAttempt?.status === 'success'
    && !!state.snapshot && state.latestAttempt.requestedAt === feed?.attemptedAt
    && state.snapshot.acquiredAt === feed?.acquiredAt && state.snapshot.payloadSha256 === feed?.payloadSha256
    && state.latestAttempt.payloadSha256 === feed?.payloadSha256
    && !!raw && raw.status === entry?.providerStatus && raw.kickoffUtc === entry?.kickoffUtc;
  const calendarGood = !!entry && entry.action !== 'BLOCK' && feed?.source === 'football-data.org'
    && hash(feed.payloadSha256) && hash(feed.mappingSha256) && stringTime(feed.attemptedAt)
    && stringTime(feed.acquiredAt) && utc(feed.acquiredAt) <= now && utc(feed.attemptedAt) <= now && currentSource && mappingGood;
  const calendarReason = (entry?.action === 'BLOCK' ? entry.reason : null) ?? state?.reason ?? (feed?.status === 'unavailable' ? feed.reason : null)
    ?? (!currentSource ? 'calendar_current_source_mismatch' : !mappingGood ? 'calendar_mapping_mismatch' : 'calendar_unavailable');
  const teams = await db.getTeamsByIds([row.home_team_id, row.away_team_id]);
  const home = teams.find(team => team.team_id === row.home_team_id), away = teams.find(team => team.team_id === row.away_team_id);
  const saved = await db.getLatestModelParams(row.competition);
  const params = saved?.params;
  const poisson = params?.poissonXg;
  const poissonReady = !predictionEngineConfig.ensemble.enabled || !!poisson
    && [poisson.leagueXG, poisson.homeAdv, poisson.levelScale].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)
    && [row.home_team_id, row.away_team_id].every(id => [poisson.attackRate?.[id], poisson.defRate?.[id]]
      .every(value => typeof value === 'number' && Number.isFinite(value) && value > 0));
  const fitted = !!saved && !!params && Number.isFinite(fitTime(saved.fitted_at)) && fitTime(saved.fitted_at) <= now
    && Number.isSafeInteger(saved.training_matches) && saved.training_matches >= 20 && poissonReady
    && [row.home_team_id, row.away_team_id].every(id => Number.isFinite(params.attackParams?.[id]) && Number.isFinite(params.defenceParams?.[id]))
    && Number.isFinite(params.homeAdvantage) && Number.isFinite(params.rho) && Number.isFinite(params.tau);
  let aInputs = !!home && !!away && finite(home.avg_home_xg) && finite(away.avg_away_xg);
  const context = new PredictionContextBuilder().build({ request: {}, homeTeam: home, awayTeam: away,
    referee: null, homePlayers: [], awayPlayers: [] });
  const h = context.supplementaryData.homeTeamStats, a = context.supplementaryData.awayTeamStats;
  const pair = (key: string) => ({ home: Number((h as any)?.[key] ?? (h as any)?.sampleSize ?? 0),
    away: Number((a as any)?.[key] ?? (a as any)?.sampleSize ?? 0) });
  const samples = { general: pair('sampleSize'), shots: pair('sampleSizeShots'), shots_on_target: pair('sampleSizeShotsOT'),
    yellow_cards: pair('sampleSizeYellow'), red_cards: pair('sampleSizeRed') };
  const preflight = require('../../scripts/calibration-preflight') as { preflightCalibration: (db: Db, competitions: string[], options: any) => Promise<any> };
  const calibration = (await preflight.preflightCalibration(db, [row.competition], { asOf: checkedAt })).competitions[0];
  const calibrationGood = calibration?.status === 'HIT' && calibration.ready === true;
  // The engine applies its existing family curve/global fallback and sample gate to each actual selection.
  const marketNames: AdmissionMarket[] = ['goal', 'shots', 'shots_on_target', 'yellow_cards', 'booking_points', 'player_props'];
  const marketCalibration = Object.fromEntries(marketNames.map(market => [market, ev(calibrationGood, 'a_calibration_preflight_miss')]));

  const allRows = await db.getMatches({ includeRawJson: true });
  const availableRows = allRows.filter(m => m.match_id !== row.match_id && m.competition === row.competition
    && Number.isFinite(Date.parse(m.date)) && Date.parse(m.date) + HISTORICAL_RESULT_DELAY_MS <= now
    && Number.isSafeInteger(m.home_goals) && m.home_goals >= 0 && Number.isSafeInteger(m.away_goals) && m.away_goals >= 0);
  const teamCoverage = (team: string) => {
    const rows = availableRows.filter(m => m.home_team_id === team || m.away_team_id === team);
    return { results: rows.length, xg: rows.filter(m => finite(m.home_xg) && finite(m.away_xg) && m.source === 'understat').length,
      shots: rows.filter(m => finite(m.home_shots) && finite(m.away_shots)).length };
  };
  const coverage = { home: teamCoverage(row.home_team_id), away: teamCoverage(row.away_team_id), leagueResults: availableRows.length };
  // Current team aggregates include every completed row, so reject them if a
  // result has not yet crossed the runtime's existing availability boundary.
  const aggregateHasFutureResult = allRows.some(m => (m.home_team_id === row.home_team_id || m.away_team_id === row.home_team_id
    || m.home_team_id === row.away_team_id || m.away_team_id === row.away_team_id)
    && m.home_goals != null && m.away_goals != null
    && (!Number.isFinite(Date.parse(m.date)) || Date.parse(m.date) + HISTORICAL_RESULT_DELAY_MS > now));
  aInputs = aInputs && coverage.home.xg > 0 && coverage.away.xg > 0 && !aggregateHasFutureResult;
  const cInputs = [coverage.home, coverage.away].every(side => side.results > 0 && side.xg > 0 && side.shots > 0);
  let cReady = false, cReason = 'c_deployment_unavailable';
  if (deployment && !deployment.resolutionUnavailable && deployment.source !== 'suspended') {
    try {
      const record = await db.research.getModelByVersion('C', deployment.deployment.modelVersion);
      const artifact = record?.artifact;
      validateArtifact(artifact);
      if (artifact.version !== deployment.deployment.modelVersion || artifact.diagnosticOnly === true || artifact.runtimeCompatible === false
        || deployment.deployment.artifactHash && researchHash(artifact) !== deployment.deployment.artifactHash
        || !stringTime(artifact.createdAt) || utc(artifact.createdAt) > now || !stringTime(record?.createdAt) || utc(record.createdAt) > now) throw Error('c_artifact_unavailable');
      const history = allRows.map(researchMatchFromRow);
      const clean = artifact.dataQualityPolicyHash === CHALLENGER_DATA_QUALITY_POLICY_HASH;
      let input = buildForecastInput(clean ? filterChallengerHistory(history) : history, researchMatchFromRow(row), checkedAt);
      if (input.baselineVersion !== deployment.deployment.baselineVersion || artifact.baselineVersion && artifact.baselineVersion !== input.baselineVersion) throw Error('c_baseline_mismatch');
      if (clean) input = { ...input, dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true } as typeof input;
      if (artifact.featureSchema === CHALLENGER_FEATURE_SCHEMA_VERSION) input = withChallengerFeatures(input, history, artifact.featureBlocks as any);
      const prediction = predictHybrid(input, artifact);
      const benchmark = deployment.deployment.probabilityConfigurationHash ? null : await db.research.getLatestBenchmark('C', record.version);
      const config = deployment.deployment.probabilityConfigurationHash ? artifact
        : benchmark?.report?.probabilityProtocol === COHERENT_PROBABILITY_PROTOCOL ? benchmark.report : artifact;
      const times = config === artifact ? [artifact.createdAt, artifact.validationThrough, record.createdAt] : [benchmark?.createdAt];
      if (config.diagnosticOnly === true || config.runtimeCompatible === false || config.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL
        || config.pipelineHashV2 !== coherentProbabilityPipelineHash() || config.baselineVersion !== input.baselineVersion
          && config.validation?.baselineHash !== baselineManifest().fingerprint
        || times.some(value => !stringTime(value) || utc(value) > now)) throw Error('c_calibration_incompatible');
      const mode = config.probabilityCalibrationMode ?? 'isotonic_1x2', profile = config.calibrationProfilesV2?.C;
      applyCoherentProbabilityPipeline({ matrix: prediction.matrix, rawProbabilities: prediction.probabilities, profile,
        quotes: [], forecastAt: checkedAt, mode, temperature: config.probabilityTemperature });
      const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: input.baselineVersion,
        pipelineHashV2: config.pipelineHashV2, mode, profile, temperature: config.probabilityTemperature });
      if (deployment.deployment.probabilityConfigurationHash && deployment.deployment.probabilityConfigurationHash !== configuration.hash) throw Error('c_calibration_configuration_mismatch');
      cReady = true;
    } catch (error) { cReason = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'c_input_or_artifact_invalid'; }
  }
  const input: FixtureAdmissionInput = { asOf: checkedAt,
    fixture: { matchId, competition: row.competition, season, homeTeamId: row.home_team_id, awayTeamId: row.away_team_id,
      kickoffAt: row.date, status: entry?.providerStatus ?? 'UNKNOWN', homeGoals: row.home_goals, awayGoals: row.away_goals },
    calendar: { ...ev(calendarGood, calendarReason), source: feed?.source ?? '',
      acquiredAt: feed?.acquiredAt ?? '', matchId: entry?.localMatchId ?? '', kickoffAt: entry?.kickoffUtc ?? '',
      homeTeamId: entry?.homeTeamId ?? '', awayTeamId: entry?.awayTeamId ?? '', mappingHash: feed?.mappingSha256 ?? '' },
    identity: ev(calendarGood, calendarReason),
    modelA: { inputs: ev(aInputs, 'a_team_xg_or_stats_missing'), fittedState: ev(fitted, 'a_fitted_state_missing_or_incompatible'),
      calibration: ev(calibrationGood, `a_calibration_${String(calibration?.status ?? 'error').toLowerCase()}`) },
    modelC: { inputs: ev(cInputs, 'c_team_history_xg_or_shots_missing'), fittedBaseline: ev(cReady, cReason), artifact: ev(cReady, cReason),
      calibration: ev(cReady, cReason), cleanBaseline: ev(cReady, cReason) },
    samples, playerProps: ev(false, 'player_props_require_selection_specific_evidence'), marketCalibration, quotes: {} };
  return { admission: evaluateFixtureAdmission(input), evidence: { calendar: { attempt: feed?.attemptedAt, acquisition: feed?.acquiredAt,
    payloadSha256: feed?.payloadSha256, mappingSha256: feed?.mappingSha256, action: entry?.action, reason: entry?.reason },
  coverage, samples, calibration, cReason: cReady ? null : cReason } };
}
