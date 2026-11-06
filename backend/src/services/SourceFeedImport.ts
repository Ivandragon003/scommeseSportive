import { createHash } from 'node:crypto';
import {
  FootballDataOrgSnapshot, SourceFeedFixture, SOURCE_FEED_COOLDOWN_MS, SOURCE_FEED_PROVIDER,
  SOURCE_FEED_VERSION, sourceFeedUtc, validateSourceFeedScope,
} from './FootballDataOrgFeed';
import type { SourceFeedState, SourceFeedStore } from './SourceFeedStore';
import type { FootballDataCompetition } from './modelAResearchCalendar';
import { sourceIdentityQuarantined } from './SourceIdentityQuarantine';

type Statement = { sql: string; args?: Array<string | number | null> };
interface ReadClient { execute(statement: Statement | string): Promise<{ rows: any[]; rowsAffected?: number }> }
export interface SourceFeedImportTransaction extends ReadClient {
  commit(): Promise<void>; rollback(): Promise<void>; close?(): void;
}
export interface SourceFeedImportClient extends ReadClient {
  transaction(mode: 'write'): Promise<SourceFeedImportTransaction>;
}
export interface ReviewedSourceTeamMapping {
  version: string;
  competition: FootballDataCompetition;
  season: number;
  reviewedAt: string;
  reference: string;
  teams: Record<string, string>;
}
export interface SourceImportMatch {
  match_id: string; home_team_id: string; away_team_id: string;
  home_team_name: string | null; away_team_name: string | null;
  competition: string; season: string; date: string | null;
  home_goals: number | null; away_goals: number | null;
  source: string | null; source_match_id: string | number | null; raw_json: string | null;
}
type ImportField = 'home_goals' | 'away_goals' | 'date';
export interface SourceFeedImportEntry {
  providerMatchId: string;
  sourceFixtureId: string;
  localMatchId: string | null;
  relatedLocalMatchIds?: string[];
  action: 'FILL_RESULTS' | 'UPDATE_KICKOFF' | 'CREATE_FIXTURE' | 'NO_CHANGE' | 'SKIP' | 'BLOCK';
  reason: string | null;
  fields: ImportField[];
}
interface SourceImportEvidence {
  provider: string; competition: FootballDataCompetition; season: number;
  acquiredAt: string; providerUpdatedAt: string | null; sourceUrl: string;
  contentSha256: string; payloadSha256: string; attemptId: number;
}
export interface SourceFeedImportPlan {
  version: 1;
  plannedAt: string;
  status: 'ready' | 'blocked' | 'unavailable';
  reason: string | null;
  mapping: ReviewedSourceTeamMapping;
  mappingSha256: string;
  allowCreateFixtures: boolean;
  createNullColumns: string[];
  source: SourceImportEvidence | null;
  entries: SourceFeedImportEntry[];
  updates: Array<{ providerMatchId: string; fields: ImportField[]; before: SourceImportMatch; after: SourceImportMatch }>;
  creates: Array<{ providerMatchId: string; after: Record<string, string | number | null> }>;
  counts: { fixtures: number; updates: number; creates: number; skipped: number; blocked: number; unchanged: number };
  planHash: string;
}
export interface SourceFeedImportResult {
  applied: number; created: number; alreadyApplied: number; fieldsFilled: number; kickoffUpdates: number; planHash: string;
  partial: boolean; blockedSkipped: number; planStatus: 'ready' | 'blocked';
}

const LOCAL_COMPETITIONS: Record<FootballDataCompetition, string> = {
  PL: 'Premier League', SA: 'Serie A', PD: 'La Liga', BL1: 'Bundesliga', FL1: 'Ligue 1',
};
const COLUMNS = ['match_id', 'home_team_id', 'away_team_id', 'home_team_name', 'away_team_name', 'competition', 'season', 'date',
  'home_goals', 'away_goals', 'source', 'source_match_id', 'raw_json'] as const;
const NULL_STAT_COLUMNS = new Set(['home_xg', 'away_xg', 'home_xgot', 'away_xgot', 'home_shots', 'away_shots', 'home_shots_on_target',
  'away_shots_on_target', 'home_possession', 'away_possession', 'home_fouls', 'away_fouls', 'home_yellow_cards', 'away_yellow_cards',
  'home_red_cards', 'away_red_cards', 'home_corners', 'away_corners', 'referee']);
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const equal = (left: unknown, right: unknown): boolean => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const utc = (value: string): string => sourceFeedUtc(value) ?? (() => { throw Error('source_import_invalid_time'); })();
const localUtc = (value: string | null): string | null => value === null ? null
  : sourceFeedUtc(value) ?? (/^\d{4}-\d{2}-\d{2}$/.test(value) ? sourceFeedUtc(`${value}T00:00:00Z`) : null);
const seasons = (season: number) => [`${season}/${season + 1}`, `${season}-${season + 1}`];

export function quarantinedIdentity(mapping: Pick<ReviewedSourceTeamMapping, 'competition' | 'season'>, home: string | undefined, away: string | undefined): boolean {
  // Incident FL1/2026: understat_team_172 is labelled Troyes, while the
  // disputed external association was treated as Le Havre. Official Toulouse
  // programme/results distinguish these clubs (archived in
  // artifacts/nightly-alternative-readiness/conflicts). Names cannot clear the
  // quarantine: remove it only after a separate review resolves the identity.
  // Official programme published 23 October 2026:
  // https://www.toulousefc.com/play/blog/2026/10/le-programme-du-week-end-24-et-25-octobre-2026
  return sourceIdentityQuarantined(mapping.competition, mapping.season, home, away);
}

function validateMapping(mapping: ReviewedSourceTeamMapping, asOf: string): void {
  if (!object(mapping)) throw Error('source_import_mapping_required');
  validateSourceFeedScope(mapping.competition, mapping.season);
  if (typeof mapping.version !== 'string' || !mapping.version.trim() || mapping.version.length > 100
    || typeof mapping.reference !== 'string' || !mapping.reference.trim() || mapping.reference.length > 2000
    || !sourceFeedUtc(mapping.reviewedAt) || Date.parse(mapping.reviewedAt) > Date.parse(asOf) || !object(mapping.teams)) throw Error('source_import_mapping_unreviewed');
  const localIds = Object.values(mapping.teams);
  if (Object.keys(mapping.teams).some((key) => !/^[1-9]\d*$/.test(key))
    || localIds.some((value) => typeof value !== 'string' || !value.trim() || value.length > 200)
    || new Set(localIds).size !== localIds.length) throw Error('source_import_mapping_invalid');
}

function sourceReason(feed: SourceFeedState, mapping: ReviewedSourceTeamMapping, asOf: string): string | null {
  const snapshot = feed?.snapshot;
  if (!feed?.available || feed.status !== 'available' || !snapshot || feed.latestAttempt?.status !== 'success') return 'source_import_latest_source_unavailable';
  if (snapshot.provider !== SOURCE_FEED_PROVIDER || snapshot.schemaVersion !== SOURCE_FEED_VERSION || snapshot.competition !== mapping.competition
    || snapshot.season !== mapping.season || feed.competition !== mapping.competition || feed.season !== mapping.season) return 'source_import_source_scope_mismatch';
  const acquiredAt = sourceFeedUtc(snapshot.acquiredAt), finishedAt = sourceFeedUtc(feed.latestAttempt.finishedAt);
  const age = acquiredAt ? Date.parse(asOf) - Date.parse(acquiredAt) : NaN;
  if (!Number.isFinite(age) || age < 0 || age >= SOURCE_FEED_COOLDOWN_MS || !finishedAt
    || Date.parse(finishedAt) > Date.parse(asOf) || Date.parse(finishedAt) < Date.parse(acquiredAt)) return 'source_import_source_stale';
  if (feed.latestAttempt.snapshotHash !== snapshot.contentSha256 || feed.latestAttempt.acquiredAt !== snapshot.acquiredAt
    || feed.latestAttempt.payloadSha256 !== snapshot.payloadSha256 || !/^[a-f0-9]{64}$/.test(snapshot.payloadSha256)) return 'source_import_source_evidence_mismatch';
  const { acquiredAt: _acquired, payloadSha256: _payload, contentSha256, ...content } = snapshot;
  if (createHash('sha256').update(JSON.stringify(content)).digest('hex') !== contentSha256) return 'source_import_source_hash_mismatch';
  if (!snapshot.coverage.calendarComplete || snapshot.fieldAvailability.calendar?.available !== true) return 'source_import_calendar_incomplete';
  return null;
}

function evidence(feed: SourceFeedState): SourceImportEvidence {
  const snapshot = feed.snapshot!;
  return { provider: snapshot.provider, competition: snapshot.competition, season: snapshot.season,
    acquiredAt: snapshot.acquiredAt, providerUpdatedAt: snapshot.providerUpdatedAt, sourceUrl: snapshot.sourceUrl,
    contentSha256: snapshot.contentSha256, payloadSha256: snapshot.payloadSha256, attemptId: feed.latestAttempt!.id };
}

function matchRow(row: any): SourceImportMatch {
  return Object.fromEntries(COLUMNS.map((column) => [column, row[column] === undefined ? null : row[column]])) as unknown as SourceImportMatch;
}
async function localMatches(client: ReadClient, mapping: ReviewedSourceTeamMapping): Promise<SourceImportMatch[]> {
  const result = await client.execute({
    sql: `SELECT ${COLUMNS.join(',')} FROM matches WHERE competition=? AND season IN (?,?) ORDER BY match_id`,
    args: [LOCAL_COMPETITIONS[mapping.competition], ...seasons(mapping.season)],
  });
  return result.rows.map(matchRow);
}

function observation(snapshot: FootballDataOrgSnapshot, fixture: SourceFeedFixture) {
  return { source: 'football_data_org', providerId: fixture.providerMatchId, sourceUrl: snapshot.sourceUrl,
    observedAt: snapshot.acquiredAt, providerUpdatedAt: fixture.providerUpdatedAt, providerPublishedAt: null,
    snapshotSha256: snapshot.contentSha256, payloadSha256: snapshot.payloadSha256,
    competition: snapshot.competition, season: snapshot.season };
}
async function updatedRaw(client: ReadClient, before: SourceImportMatch, snapshot: FootballDataOrgSnapshot, fixture: SourceFeedFixture, fields: ImportField[]): Promise<string | null> {
  const original = before.raw_json ?? '{}';
  if (Number((await client.execute({ sql: 'SELECT json_valid(?) AS valid', args: [original] })).rows[0]?.valid) !== 1) return null;
  const types = (await client.execute({ sql: `SELECT json_type(?) AS root_type,json_type(?,'$.fieldProvenance') AS provenance_type,
    json_type(?,'$.resultObservation') AS observation_type`, args: [original, original, original] })).rows[0];
  if (types.root_type !== 'object' || (types.provenance_type != null && !['object', 'null'].includes(types.provenance_type))
    || (types.observation_type != null && !['object', 'null'].includes(types.observation_type))) return null;
  const changes: string[] = [], args: Array<string | number | null> = [original];
  const set = (jsonPath: string, value: unknown) => { changes.push('?,json(?)'); args.push(jsonPath, JSON.stringify(value)); };
  const provenance = observation(snapshot, fixture);
  if (types.provenance_type !== 'object') set('$.fieldProvenance', {});
  for (const field of fields) set(`$.fieldProvenance.${field}`, provenance);
  if (fields.some((field) => field === 'home_goals' || field === 'away_goals')) {
    if (types.observation_type !== 'object') set('$.resultObservation', {});
    for (const [key, value] of Object.entries({ ...provenance, fields: fields.filter((field) => field !== 'date'), homeGoals: fixture.homeGoals, awayGoals: fixture.awayGoals })) set(`$.resultObservation.${key}`, value);
  }
  return String((await client.execute({ sql: `SELECT json_set(?,${changes.join(',')}) AS raw_json`, args })).rows[0].raw_json);
}

async function nullableStats(client: ReadClient): Promise<string[]> {
  return (await client.execute("SELECT name FROM pragma_table_info('matches') ORDER BY cid")).rows
    .map((row) => String(row.name)).filter((name) => NULL_STAT_COLUMNS.has(name));
}
function futureFixture(snapshot: FootballDataOrgSnapshot, fixture: SourceFeedFixture, mapping: ReviewedSourceTeamMapping,
  homeName: string, awayName: string, nullColumns: string[]): Record<string, string | number | null> {
  const provenance = observation(snapshot, fixture);
  return { match_id: `football_data_org_${fixture.providerMatchId}`, home_team_id: mapping.teams[fixture.providerHomeTeamId],
    away_team_id: mapping.teams[fixture.providerAwayTeamId], home_team_name: homeName, away_team_name: awayName,
    competition: LOCAL_COMPETITIONS[mapping.competition], season: seasons(mapping.season)[0], date: fixture.kickoffUtc,
    home_goals: null, away_goals: null, ...Object.fromEntries(nullColumns.map((column) => [column, null])),
    source: 'football_data_org', source_match_id: Number(fixture.providerMatchId),
    raw_json: JSON.stringify({ fieldProvenance: { date: provenance, home_team_id: provenance, away_team_id: provenance,
      source_match_id: provenance }, sourceFixtureObservation: { ...provenance, status: fixture.status } }) };
}

function finishPlan(plan: Omit<SourceFeedImportPlan, 'planHash'>): SourceFeedImportPlan {
  return { ...plan, planHash: digest(plan) };
}

/** Plans only: no target mutation, provider call or operational bootstrap. */
export async function planSourceFeedImport(options: {
  client: ReadClient; feed: SourceFeedState; mapping: ReviewedSourceTeamMapping; asOf: string; allowCreateFixtures?: boolean;
}): Promise<SourceFeedImportPlan> {
  const asOf = utc(options.asOf);
  validateMapping(options.mapping, asOf);
  const mapping = JSON.parse(JSON.stringify(options.mapping)) as ReviewedSourceTeamMapping;
  const reason = sourceReason(options.feed, mapping, asOf);
  const base = { version: 1 as const, plannedAt: asOf, mapping, mappingSha256: digest(mapping), source: reason ? null : evidence(options.feed),
    allowCreateFixtures: options.allowCreateFixtures === true, createNullColumns: [] as string[], creates: [] as SourceFeedImportPlan['creates'],
    entries: [] as SourceFeedImportEntry[], updates: [] as SourceFeedImportPlan['updates'],
    counts: { fixtures: 0, updates: 0, creates: 0, skipped: 0, blocked: 0, unchanged: 0 } };
  if (reason) return finishPlan({ ...base, status: 'unavailable', reason });
  const snapshot = options.feed.snapshot!;
  const matches = await localMatches(options.client, mapping);
  const teamIds = Object.values(mapping.teams);
  const knownTeams = new Map<string, string | null>(teamIds.length ? (await options.client.execute({
    sql: `SELECT team_id,name FROM teams WHERE team_id IN (${teamIds.map(() => '?').join(',')})`, args: teamIds,
  })).rows.map((row) => [String(row.team_id), typeof row.name === 'string' && row.name.trim() ? row.name : null]) : []);
  if (base.allowCreateFixtures) base.createNullColumns = await nullableStats(options.client);
  for (const fixture of snapshot.fixtures) {
    const entry: SourceFeedImportEntry = { providerMatchId: fixture.providerMatchId, sourceFixtureId: fixture.id,
      localMatchId: null, action: 'SKIP', reason: null, fields: [] };
    base.entries.push(entry);
    const home = mapping.teams[fixture.providerHomeTeamId], away = mapping.teams[fixture.providerAwayTeamId];
    if (quarantinedIdentity(mapping, home, away)) {
      const related = matches.filter((match) => match.home_team_id === home && match.away_team_id === away).map((match) => match.match_id).sort();
      entry.action = 'BLOCK'; entry.reason = 'source_import_team_identity_quarantined';
      entry.localMatchId = related.length === 1 ? related[0] : null;
      entry.relatedLocalMatchIds = related;
      continue;
    }
    if (!home || !away) { entry.reason = 'unmapped_provider_team'; continue; }
    if (!knownTeams.has(home) || !knownTeams.has(away)) { entry.action = 'BLOCK'; entry.reason = 'mapped_local_team_missing'; continue; }
    const candidates = matches.filter((match) => match.home_team_id === home && match.away_team_id === away);
    if (!candidates.length) {
      entry.reason = 'local_fixture_missing';
      if (!base.allowCreateFixtures) continue;
      if (!['TIMED', 'SCHEDULED'].includes(fixture.status) || !fixture.kickoffUtc || Date.parse(fixture.kickoffUtc) <= Date.parse(asOf)) { entry.reason = 'new_fixture_not_future'; continue; }
      if (!knownTeams.get(home) || !knownTeams.get(away)) { entry.action = 'BLOCK'; entry.reason = 'mapped_local_team_name_missing'; continue; }
      const after = futureFixture(snapshot, fixture, mapping, knownTeams.get(home)!, knownTeams.get(away)!, base.createNullColumns);
      if ((await options.client.execute({ sql: 'SELECT match_id FROM matches WHERE match_id=?', args: [String(after.match_id)] })).rows.length) { entry.action = 'BLOCK'; entry.reason = 'new_fixture_id_conflict'; continue; }
      base.creates.push({ providerMatchId: fixture.providerMatchId, after });
      entry.action = 'CREATE_FIXTURE'; entry.localMatchId = String(after.match_id); entry.reason = 'explicit_future_fixture_creation'; entry.fields = ['date'];
      continue;
    }
    if (candidates.length !== 1) {
      entry.action = 'BLOCK'; entry.reason = 'local_fixture_ambiguous';
      entry.relatedLocalMatchIds = candidates.map((candidate) => candidate.match_id).sort();
      continue;
    }
    const before = candidates[0]; entry.localMatchId = before.match_id;
    const after = { ...before };
    const kickoff = localUtc(before.date);
    if (fixture.status === 'FINISHED') {
      if (!fixture.resultAvailable || !count(fixture.homeGoals) || !count(fixture.awayGoals)) { entry.reason = 'finished_score_unavailable'; continue; }
      if (before.date !== null && (!kickoff || kickoff.slice(0, 10) !== fixture.kickoffUtc?.slice(0, 10))) {
        entry.action = 'BLOCK'; entry.reason = 'finished_fixture_date_requires_review'; continue;
      }
      if ((before.home_goals !== null && (!count(before.home_goals) || before.home_goals !== fixture.homeGoals))
        || (before.away_goals !== null && (!count(before.away_goals) || before.away_goals !== fixture.awayGoals))) {
        entry.action = 'BLOCK'; entry.reason = 'existing_result_conflict'; continue;
      }
      if (before.home_goals === null) { after.home_goals = fixture.homeGoals; entry.fields.push('home_goals'); }
      if (before.away_goals === null) { after.away_goals = fixture.awayGoals; entry.fields.push('away_goals'); }
      entry.action = entry.fields.length ? 'FILL_RESULTS' : 'NO_CHANGE';
    } else if (fixture.status === 'TIMED' && fixture.kickoffUtc && kickoff
      && Date.parse(fixture.kickoffUtc) > Date.parse(asOf) && Date.parse(kickoff) > Date.parse(asOf)) {
      if (before.home_goals !== null || before.away_goals !== null) { entry.action = 'BLOCK'; entry.reason = 'local_results_prevent_kickoff_change'; }
      else if (kickoff === fixture.kickoffUtc) entry.action = 'NO_CHANGE';
      else { entry.action = 'UPDATE_KICKOFF'; entry.fields.push('date'); after.date = fixture.kickoffUtc; entry.reason = 'explicit_future_kickoff_mismatch'; }
    } else { entry.reason = 'fixture_not_eligible_for_update'; }
    if (!entry.fields.length) continue;
    const raw = await updatedRaw(options.client, before, snapshot, fixture, entry.fields);
    if (raw === null) { entry.action = 'BLOCK'; entry.reason = 'local_raw_json_requires_review'; entry.fields = []; continue; }
    after.raw_json = raw;
    base.updates.push({ providerMatchId: fixture.providerMatchId, fields: [...entry.fields], before, after });
  }
  base.counts = { fixtures: base.entries.length, updates: base.updates.length, creates: base.creates.length,
    skipped: base.entries.filter((entry) => entry.action === 'SKIP').length,
    blocked: base.entries.filter((entry) => entry.action === 'BLOCK').length,
    unchanged: base.entries.filter((entry) => entry.action === 'NO_CHANGE').length };
  return finishPlan({ ...base, status: base.counts.blocked ? 'blocked' : 'ready', reason: base.counts.blocked ? 'source_import_review_required' : null });
}

/** Explicit apply only. A new source failure or any changed target baseline aborts the whole transaction. */
export async function applySourceFeedImport(options: {
  client: SourceFeedImportClient; store: Pick<SourceFeedStore, 'read'>; plan: SourceFeedImportPlan; asOf: string;
  allowVerifiedSubset?: boolean; expectedPlanHash?: string;
}): Promise<SourceFeedImportResult> {
  const startedAt = Date.now();
  const asOf = utc(options.asOf);
  const { planHash, ...content } = options.plan;
  if (digest(content) !== planHash || options.plan.mappingSha256 !== digest(options.plan.mapping)) throw Error('source_import_plan_hash_mismatch');
  const plan = options.plan;
  validateMapping(plan.mapping, asOf);
  if (options.allowVerifiedSubset === true && plan.status !== 'blocked') throw Error('source_import_subset_not_applicable');
  const partial = plan.status === 'blocked' && options.allowVerifiedSubset === true;
  if (partial && (typeof options.expectedPlanHash !== 'string' || options.expectedPlanHash !== plan.planHash)) throw Error('source_import_subset_approval_mismatch');
  if (plan.version !== 1 || (plan.status !== 'ready' && !partial) || !plan.source || Date.parse(asOf) < Date.parse(plan.plannedAt)) throw Error('source_import_plan_not_ready');
  if (partial) {
    const mutations = [
      ...plan.updates.map((update) => ({ providerId: update.providerMatchId, localId: update.before.match_id,
        fields: update.fields, action: update.fields.includes('date') ? 'UPDATE_KICKOFF' : 'FILL_RESULTS' })),
      ...plan.creates.map((create) => ({ providerId: create.providerMatchId, localId: String(create.after.match_id), fields: ['date'], action: 'CREATE_FIXTURE' })),
    ];
    const localIds = (entry: SourceFeedImportEntry) => new Set([...(entry.localMatchId ? [entry.localMatchId] : []), ...(entry.relatedLocalMatchIds ?? [])]);
    for (const mutation of mutations) {
      const sameProvider = plan.entries.filter((entry) => entry.providerMatchId === mutation.providerId);
      const sameLocal = plan.entries.filter((entry) => localIds(entry).has(mutation.localId));
      if (mutations.filter((other) => other.providerId === mutation.providerId || other.localId === mutation.localId).length !== 1
        || sameProvider.length !== 1 || sameLocal.length !== 1 || sameProvider[0] !== sameLocal[0]
        || sameProvider[0].action !== mutation.action || !equal(sameProvider[0].fields, mutation.fields)
        || sameProvider[0].sourceFixtureId !== `${SOURCE_FEED_PROVIDER}:match:${mutation.providerId}`) throw Error('source_import_subset_binding_invalid');
    }
  }
  const currentFeed = await options.store.read(plan.mapping.competition, plan.mapping.season, asOf);
  const unavailable = sourceReason(currentFeed, plan.mapping, asOf);
  if (unavailable) throw Error(unavailable);
  if (!equal(evidence(currentFeed), plan.source)) throw Error('source_import_source_changed');
  // Old/prepared plans and subset approvals must not bypass a newly identified
  // mapping incident. Replanning can retain BLOCK entries and import only
  // unrelated verified fixtures; it cannot carry mutations for this identity.
  for (const fixture of currentFeed.snapshot!.fixtures) {
    if (!quarantinedIdentity(plan.mapping, plan.mapping.teams[fixture.providerHomeTeamId], plan.mapping.teams[fixture.providerAwayTeamId])) continue;
    const entries = plan.entries.filter((entry) => entry.providerMatchId === fixture.providerMatchId);
    if (entries.length !== 1 || entries[0].action !== 'BLOCK' || entries[0].reason !== 'source_import_team_identity_quarantined'
      || entries[0].fields.length || plan.updates.some((update) => update.providerMatchId === fixture.providerMatchId)
      || plan.creates.some((create) => create.providerMatchId === fixture.providerMatchId)) throw Error('source_import_team_identity_quarantined');
  }
  if (plan.updates.some((update) => quarantinedIdentity(plan.mapping, update.before.home_team_id, update.before.away_team_id))
    || plan.creates.some((create) => quarantinedIdentity(plan.mapping, String(create.after.home_team_id), String(create.after.away_team_id)))) throw Error('source_import_team_identity_quarantined');
  for (const update of plan.updates) {
    const fixture = currentFeed.snapshot!.fixtures.find((row) => row.providerMatchId === update.providerMatchId);
    if (!fixture || !update.fields.length || new Set(update.fields).size !== update.fields.length
      || update.fields.some((field) => !['home_goals', 'away_goals', 'date'].includes(field))
      || COLUMNS.some((column) => column !== 'raw_json' && !update.fields.includes(column as ImportField) && !equal(update.before[column], update.after[column]))
      || plan.mapping.teams[fixture.providerHomeTeamId] !== update.before.home_team_id
      || plan.mapping.teams[fixture.providerAwayTeamId] !== update.before.away_team_id
      || update.before.competition !== LOCAL_COMPETITIONS[plan.mapping.competition]
      || !seasons(plan.mapping.season).includes(update.before.season)) throw Error('source_import_invalid_update');
    if (update.fields.includes('date')) {
      if (update.fields.length !== 1 || fixture.status !== 'TIMED' || update.before.home_goals !== null || update.before.away_goals !== null
        || !localUtc(update.before.date) || Date.parse(localUtc(update.before.date)!) <= Date.parse(asOf)
        || !fixture.kickoffUtc || Date.parse(fixture.kickoffUtc) <= Date.parse(asOf)
        || update.after.date !== fixture.kickoffUtc) throw Error('source_import_invalid_update');
    } else if (fixture.status !== 'FINISHED' || !fixture.resultAvailable || !count(fixture.homeGoals) || !count(fixture.awayGoals)
      || update.after.home_goals !== fixture.homeGoals || update.after.away_goals !== fixture.awayGoals
      || update.fields.some((field) => update.before[field] !== null)
      || (update.before.date !== null && localUtc(update.before.date)?.slice(0, 10) !== fixture.kickoffUtc?.slice(0, 10))) throw Error('source_import_invalid_update');
    if (await updatedRaw(options.client, update.before, currentFeed.snapshot!, fixture, update.fields) !== update.after.raw_json) throw Error('source_import_invalid_update');
  }
  if (plan.creates.length && !plan.allowCreateFixtures) throw Error('source_import_creation_not_authorized');
  const result: SourceFeedImportResult = { applied: 0, created: 0, alreadyApplied: 0, fieldsFilled: 0, kickoffUpdates: 0, planHash,
    partial, blockedSkipped: partial ? plan.entries.filter((entry) => entry.action === 'BLOCK').length : 0,
    planStatus: partial ? 'blocked' : 'ready' };
  if (!plan.updates.length && !plan.creates.length) return result;
  const transaction = await options.client.transaction('write');
  try {
    const currentMatches = await localMatches(transaction, plan.mapping);
    const neededTeams = [...new Set([...plan.updates.flatMap((update) => [update.before.home_team_id, update.before.away_team_id]),
      ...plan.creates.flatMap((create) => [String(create.after.home_team_id), String(create.after.away_team_id)])])];
    const teams = new Map((await transaction.execute({ sql: `SELECT team_id,name FROM teams WHERE team_id IN (${neededTeams.map(() => '?').join(',')})`, args: neededTeams })).rows.map((row) => [String(row.team_id), row.name]));
    const pending: SourceFeedImportPlan['updates'] = [];
    for (const update of plan.updates) {
      const candidates = currentMatches.filter((match) => match.home_team_id === update.before.home_team_id && match.away_team_id === update.before.away_team_id);
      if (candidates.length !== 1 || !teams.has(update.before.home_team_id) || !teams.has(update.before.away_team_id)) throw Error('source_import_target_changed');
      const current = candidates[0];
      if (equal(current, update.after)) { result.alreadyApplied++; continue; }
      if (!equal(current, update.before)) throw Error('source_import_target_changed');
      pending.push(update);
    }
    const pendingCreates: SourceFeedImportPlan['creates'] = [];
    if (plan.creates.length && !equal(await nullableStats(transaction), plan.createNullColumns)) throw Error('source_import_target_schema_changed');
    for (const create of plan.creates) {
      const fixture = currentFeed.snapshot!.fixtures.find((row) => row.providerMatchId === create.providerMatchId);
      if (!fixture || !['TIMED', 'SCHEDULED'].includes(fixture.status) || !fixture.kickoffUtc || Date.parse(fixture.kickoffUtc) <= Date.parse(asOf)) throw Error('source_import_invalid_creation');
      const home = plan.mapping.teams[fixture.providerHomeTeamId], away = plan.mapping.teams[fixture.providerAwayTeamId];
      if (!home || !away || typeof teams.get(home) !== 'string' || !teams.get(home).trim()
        || typeof teams.get(away) !== 'string' || !teams.get(away).trim()) throw Error('source_import_target_changed');
      const expected = futureFixture(currentFeed.snapshot!, fixture, plan.mapping, teams.get(home), teams.get(away), plan.createNullColumns);
      if (!equal(expected, create.after)) throw Error('source_import_invalid_creation');
      const samePair = currentMatches.filter((match) => match.home_team_id === home && match.away_team_id === away);
      const columns = Object.keys(create.after);
      const sameId = (await transaction.execute({ sql: `SELECT ${columns.join(',')} FROM matches WHERE match_id=?`, args: [String(create.after.match_id)] })).rows;
      if (samePair.length === 1 && sameId.length === 1 && equal(sameId[0], create.after)) { result.alreadyApplied++; continue; }
      if (samePair.length || sameId.length) throw Error('source_import_target_changed');
      pendingCreates.push(create);
    }
    for (const update of pending) {
      const assignments = update.fields.map((field) => `${field}=?`);
      const before = update.before;
      const changed = await transaction.execute({
        sql: `UPDATE matches SET ${assignments.join(',')},raw_json=? WHERE ${COLUMNS.map((column) => `${column} IS ?`).join(' AND ')}`,
        args: [...update.fields.map((field) => update.after[field]), update.after.raw_json, ...COLUMNS.map((column) => before[column])],
      });
      if (changed.rowsAffected !== 1) throw Error('source_import_target_changed');
      result.applied++;
      result.fieldsFilled += update.fields.filter((field) => field !== 'date').length;
      result.kickoffUpdates += Number(update.fields.includes('date'));
    }
    for (const create of pendingCreates) {
      const columns = Object.keys(create.after);
      const inserted = await transaction.execute({ sql: `INSERT INTO matches(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, args: columns.map((column) => create.after[column]) });
      if (inserted.rowsAffected !== 1) throw Error('source_import_target_changed');
      result.applied++; result.created++;
    }
    // Recheck the separate source cache immediately before committing. This
    // narrows the race but does not claim an atomic transaction across databases.
    const commitAsOf = new Date(Date.parse(asOf) + Math.max(0, Date.now() - startedAt)).toISOString();
    const commitFeed = await options.store.read(plan.mapping.competition, plan.mapping.season, commitAsOf);
    const commitUnavailable = sourceReason(commitFeed, plan.mapping, commitAsOf);
    if (commitUnavailable) throw Error(commitUnavailable);
    if (!equal(evidence(commitFeed), plan.source)) throw Error('source_import_source_changed');
    await transaction.commit();
    return result;
  } catch (error) {
    try { await transaction.rollback(); } catch { /* Preserve the original failure. */ }
    throw error;
  } finally { transaction.close?.(); }
}

/** Library entrypoint: plan is the default; apply requires an explicit true flag. */
export async function runSourceFeedImport(options: {
  client: SourceFeedImportClient; store: Pick<SourceFeedStore, 'read'>;
  competition: FootballDataCompetition; season: number; mapping: ReviewedSourceTeamMapping;
  asOf: string; apply?: boolean; allowCreateFixtures?: boolean; allowVerifiedSubset?: boolean; expectedPlanHash?: string;
}): Promise<{ plan: SourceFeedImportPlan; result: SourceFeedImportResult | null }> {
  if (options.competition !== options.mapping.competition || options.season !== options.mapping.season) throw Error('source_import_mapping_scope_mismatch');
  const feed = await options.store.read(options.competition, options.season, options.asOf);
  const plan = await planSourceFeedImport({ ...options, feed });
  const result = options.apply === true ? await applySourceFeedImport({ ...options, plan }) : null;
  return { plan, result };
}
