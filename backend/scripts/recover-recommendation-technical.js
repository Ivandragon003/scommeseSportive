#!/usr/bin/env node
// Plan only: bounded SELECTs, no application bootstrap, providers or betting writes.
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');

const LIMIT = 100;
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fail = reason => { throw new Error(reason); };
const recoveryTools = () => ({ ...require('../dist/research/ResearchRecommendationRecovery'),
  ...require('../dist/research/ResearchStore') });

function readOnlyClient(client) {
  return Object.freeze({ execute(statement) {
    const sql = typeof statement === 'string' ? statement : statement?.sql;
    if (typeof sql !== 'string' || !/^\s*SELECT\b/i.test(sql) || /;|--|\/\*/.test(sql)) fail('technical_recovery_select_only');
    return client.execute(statement);
  } });
}

function romeDayWindow(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) fail('technical_recovery_day_invalid');
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) fail('technical_recovery_day_invalid');
  const offset = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', timeZoneName: 'shortOffset' });
  const midnight = value => {
    const zone = offset.formatToParts(value).find(part => part.type === 'timeZoneName')?.value;
    const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(zone ?? '');
    if (!match) fail('technical_recovery_rome_timezone_unavailable');
    const minutes = (Number(match[2]) * 60 + Number(match[3] ?? 0)) * (match[1] === '+' ? 1 : -1);
    return new Date(value.getTime() - minutes * 60000).toISOString();
  };
  const next = new Date(date.getTime() + 86400000);
  return { dayStartAt: midnight(date), dayEndAt: midnight(next) };
}

function jsonObject(value) {
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail('technical_recovery_snapshot_json_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('technical_recovery_snapshot_json_invalid');
  return parsed;
}
const unique = values => [...new Set(values.filter(value => typeof value === 'string' && value.length > 0))];
const placeholders = values => values.map(() => '?').join(',');
const grouped = (rows, key) => {
  const groups = new Map();
  for (const row of rows) { const values = groups.get(row[key]) ?? []; values.push(row); groups.set(row[key], values); }
  return groups;
};

async function loadTechnicalRecoveryRecords(client, { sourcePolicyHash, day, now = new Date() }) {
  if (!validHash(sourcePolicyHash)) fail('technical_recovery_source_policy_hash_invalid');
  if (!(now instanceof Date) && (typeof now !== 'string' || !/(?:z|[+-]\d{2}:\d{2})$/i.test(now))) fail('technical_recovery_time_invalid');
  const at = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(at.getTime())) fail('technical_recovery_time_invalid');
  const window = romeDayWindow(day), db = readOnlyClient(client);
  const { researchHash, TECHNICAL_RECOVERY_PROTOCOL } = recoveryTools();
  const policies = (await db.execute({ sql: 'SELECT hash,version,descriptor_json FROM research_execution_policies WHERE hash=? LIMIT 2',
    args: [sourcePolicyHash] })).rows;
  if (policies.length !== 1) fail('technical_recovery_source_policy_missing');
  const currentPolicy = jsonObject(policies[0].descriptor_json);
  if (researchHash(currentPolicy) !== sourcePolicyHash || policies[0].hash !== sourcePolicyHash
    || currentPolicy.version !== policies[0].version) fail('technical_recovery_source_policy_identity_mismatch');
  const jobs = (await db.execute({ sql: `SELECT j.id,j.match_id,j.policy_hash,j.run_id,j.status,j.kickoff_at,
    j.window_start_at,j.window_end_at,j.claimed_at,m.date AS fixture_kickoff_at,
    m.home_goals AS fixture_home_goals,m.away_goals AS fixture_away_goals
    FROM matches m JOIN research_execution_jobs j ON j.match_id=m.match_id AND j.policy_hash=?
    WHERE m.date>=? AND m.date<? ORDER BY m.date,j.match_id,j.id LIMIT 101`,
  args: [sourcePolicyHash, window.dayStartAt, window.dayEndAt] })).rows;
  if (jobs.length > LIMIT) fail('technical_recovery_record_limit_exceeded');
  const metadata = { sourcePolicyHash, day, ...window, readOnly: true };
  if (!jobs.length) return { records: [], currentPolicy, ...metadata };
  const jobIds = unique(jobs.map(row => row.id)), matchIds = unique(jobs.map(row => row.match_id));
  const select = async (sql, args, max) => {
    if (!args.length) return [];
    const result = (await db.execute({ sql, args })).rows;
    if (result.length > max) fail('technical_recovery_related_record_limit_exceeded');
    return result;
  };
  const [inputs, bets, recoveries] = await Promise.all([
    select(`SELECT id,job_id,origin_input_id,input_hash,decisions_hash,snapshot_json,captured_at,kickoff_at
      FROM research_execution_inputs WHERE job_id IN (${placeholders(jobIds)}) LIMIT 101`, jobIds, LIMIT),
    select(`SELECT id,portfolio_id,match_id FROM research_bets WHERE portfolio_id IN ('shadow_A','shadow_C')
      AND match_id IN (${placeholders(matchIds)}) LIMIT 201`, matchIds, 2 * LIMIT),
    select(`SELECT j.id,j.match_id,j.policy_hash,j.status,j.lease_expires_at,i.id AS recovery_input_id,
      p.hash AS stored_policy_hash,p.descriptor_json FROM research_execution_jobs j
      JOIN research_execution_policies p ON p.hash=j.policy_hash
      LEFT JOIN research_execution_inputs i ON i.job_id=j.id
      WHERE j.match_id IN (${placeholders(matchIds)}) AND p.hash<>?
      AND json_extract(p.descriptor_json,'$.recovery.parentPolicyHash')=? LIMIT 501`,
    [...matchIds, sourcePolicyHash, sourcePolicyHash], 500),
  ]);
  const inputIds = unique(inputs.map(row => row.id)), originInputIds = unique(inputs.map(row => row.origin_input_id));
  const [decisions, originInputs, originDecisions] = await Promise.all([
    select(`SELECT id,input_id,origin_decision_id,family,model_version,portfolio_id,action,reason,snapshot_json
      FROM research_execution_decisions WHERE input_id IN (${placeholders(inputIds)}) LIMIT 601`, inputIds, 6 * LIMIT),
    select(`SELECT id,job_id FROM research_inputs WHERE id IN (${placeholders(originInputIds)}) LIMIT 101`, originInputIds, LIMIT),
    select(`SELECT id,input_id,family,portfolio_id FROM research_decisions
      WHERE input_id IN (${placeholders(originInputIds)}) LIMIT 601`, originInputIds, 6 * LIMIT),
  ]);
  const originJobIds = unique(originInputs.map(row => row.job_id));
  const originJobs = await select(`SELECT id,match_id FROM research_jobs WHERE id IN (${placeholders(originJobIds)}) LIMIT 101`, originJobIds, LIMIT);
  const inputsByJob = grouped(inputs, 'job_id'), originsById = new Map(originInputs.map(row => [row.id, row]));
  const jobsById = new Map(originJobs.map(row => [row.id, row]));
  const decisionsByInput = grouped(decisions, 'input_id'), originDecisionsByInput = grouped(originDecisions, 'input_id');
  const betsByMatch = grouped(bets, 'match_id');
  const recoveriesByMatch = grouped(recoveries, 'match_id');
  const records = jobs.map(job => {
    if (!Object.hasOwn(job, 'fixture_home_goals') || !Object.hasOwn(job, 'fixture_away_goals')) fail('technical_recovery_fixture_result_state_missing');
    const matchingInputs = inputsByJob.get(job.id) ?? [];
    if (matchingInputs.length > 1) fail('technical_recovery_source_input_ambiguous');
    const input = matchingInputs[0], origin = input && originsById.get(input.origin_input_id);
    const originJob = origin && jobsById.get(origin.job_id);
    const existingRecoveries = (recoveriesByMatch.get(job.match_id) ?? []).map(row => {
      const descriptor = jsonObject(row.descriptor_json), recovery = descriptor.recovery;
      const parent = { ...descriptor }; delete parent.recovery;
      if (row.stored_policy_hash !== row.policy_hash || !validHash(row.policy_hash) || researchHash(descriptor) !== row.policy_hash
        || researchHash(parent) !== sourcePolicyHash || !recovery || typeof recovery !== 'object' || Array.isArray(recovery)
        || recovery.protocol !== TECHNICAL_RECOVERY_PROTOCOL || recovery.parentPolicyHash !== sourcePolicyHash
        || recovery.maxDepth !== 1 || recovery.retrospective !== false || recovery.reason !== 'retry_technical_failure' || !Array.isArray(recovery.sources)
        || recovery.sources.length === 0 || recovery.sources.length > LIMIT || !Array.isArray(recovery.matchIds)
        || recovery.matchIds.length !== recovery.sources.length || new Set(recovery.matchIds).size !== recovery.sources.length
        || recovery.sources.some(source => !source || typeof source.matchId !== 'string' || !source.matchId || !recovery.matchIds.includes(source.matchId)
          || typeof source.sourceJobId !== 'string' || !source.sourceJobId || typeof source.sourceInputId !== 'string' || !source.sourceInputId)
        || new Set(recovery.sources.map(source => source.matchId)).size !== recovery.sources.length) {
        fail('technical_recovery_prior_policy_invalid');
      }
      const sources = recovery.sources.filter(source => source.matchId === job.match_id);
      if (sources.length !== 1 || !input || sources[0].sourceJobId !== job.id || sources[0].sourceInputId !== input.id) {
        fail('technical_recovery_prior_source_identity_mismatch');
      }
      if (typeof row.id !== 'string' || !row.id || !['CLAIMED', 'COMPLETED', 'SKIPPED', 'ERROR'].includes(row.status)
        || !Object.hasOwn(row, 'recovery_input_id') || (row.recovery_input_id !== null && typeof row.recovery_input_id !== 'string')
        || !Object.hasOwn(row, 'lease_expires_at') || (row.lease_expires_at !== null && typeof row.lease_expires_at !== 'string')) {
        fail('technical_recovery_prior_job_invalid');
      }
      return { jobId: row.id, status: row.status, inputId: row.recovery_input_id,
        sourceJobId: sources[0].sourceJobId, sourceInputId: sources[0].sourceInputId,
        parentPolicyHash: recovery.parentPolicyHash, leaseExpiresAt: row.lease_expires_at };
    });
    return { match: { matchId: job.match_id, kickoffAt: job.fixture_kickoff_at,
      homeGoals: job.fixture_home_goals, awayGoals: job.fixture_away_goals },
    policy: { hash: sourcePolicyHash, descriptor: currentPolicy },
    job: { id: job.id, matchId: job.match_id, policyHash: job.policy_hash, runId: job.run_id, status: job.status,
      kickoffAt: job.kickoff_at, windowStartAt: job.window_start_at, windowEndAt: job.window_end_at, claimedAt: job.claimed_at },
    input: input ? { id: input.id, jobId: input.job_id, originInputId: input.origin_input_id, inputHash: input.input_hash,
      decisionsHash: input.decisions_hash, capturedAt: input.captured_at, kickoffAt: input.kickoff_at, snapshot: jsonObject(input.snapshot_json) } : null,
    decisions: (decisionsByInput.get(input?.id) ?? []).map(row => ({ id: row.id, inputId: row.input_id,
      originDecisionId: row.origin_decision_id, family: row.family, portfolioId: row.portfolio_id, modelVersion: row.model_version,
      action: row.action, reason: row.reason, snapshot: jsonObject(row.snapshot_json) })),
    originInput: origin ? { id: origin.id, jobId: origin.job_id } : null,
    originJob: originJob ? { id: originJob.id, matchId: originJob.match_id } : null,
    originDecisions: (originDecisionsByInput.get(origin?.id) ?? []).map(row => ({ id: row.id, inputId: row.input_id,
      family: row.family, portfolioId: row.portfolio_id })),
    existingBets: (betsByMatch.get(job.match_id) ?? []).map(row => ({ id: row.id, portfolioId: row.portfolio_id })), existingRecoveries };
  });
  return { records, currentPolicy, ...metadata };
}

function writePlan(output, plan, metadata) {
  if (typeof output !== 'string' || !output.trim()) fail('technical_recovery_output_required');
  if (!validHash(metadata?.sourcePolicyHash) || metadata.sourcePolicyHash !== plan.parentPolicyHash) fail('technical_recovery_output_policy_mismatch');
  const window = romeDayWindow(metadata.day);
  if (window.dayStartAt !== metadata.dayStartAt || window.dayEndAt !== metadata.dayEndAt) fail('technical_recovery_output_day_mismatch');
  const document = { ...plan, metadata: { sourcePolicyHash: metadata.sourcePolicyHash, day: metadata.day, ...window, readOnly: true } };
  document.planHash = recoveryTools().researchHash(document);
  const target = resolve(output);
  mkdirSync(dirname(target), { recursive: true });
  try { writeFileSync(target, JSON.stringify(document, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') fail('technical_recovery_output_exists'); throw error; }
  return document;
}

function parseArgs(argv) {
  if (argv[0] !== 'plan') fail('technical_recovery_plan_only');
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1];
    if (!['--source-policy', '--day', '--out'].includes(name) || typeof value !== 'string' || value.startsWith('--')
      || Object.hasOwn(values, name)) fail('technical_recovery_arguments_invalid');
    values[name] = value;
  }
  if (!validHash(values['--source-policy']) || !values['--out']) fail('technical_recovery_arguments_invalid');
  romeDayWindow(values['--day']);
  return { sourcePolicyHash: values['--source-policy'], day: values['--day'], output: values['--out'] };
}

function planSummary(document) {
  const excluded = {};
  for (const item of document.excluded) excluded[item.reason] = (excluded[item.reason] ?? 0) + 1;
  return { action: 'plan', readOnly: true, day: document.metadata.day, sourcePolicyHash: document.parentPolicyHash,
    policyHash: document.policyHash, planHash: document.planHash, eligible: document.fixtures.length,
    sourceDecisions: document.sources.reduce((count, source) => count + source.sourceDecisionIds.length, 0),
    excluded: document.excluded.length, exclusionReasons: excluded, written: true };
}

async function main(argv = process.argv.slice(2), options = {}) {
  const args = parseArgs(argv), env = options.env ?? process.env;
  let client = options.client;
  if (!client) {
    if (!env.TURSO_DATABASE_URL || !(env.TURSO_WATCHDOG_READONLY_TOKEN || env.TURSO_AUTH_TOKEN)) fail('technical_recovery_database_configuration_missing');
    const createClient = options.createClient ?? require('@libsql/client').createClient;
    client = createClient({ url: env.TURSO_DATABASE_URL, authToken: env.TURSO_WATCHDOG_READONLY_TOKEN || env.TURSO_AUTH_TOKEN });
  }
  try {
    const now = (options.clock ?? (() => new Date()))();
    const loaded = await loadTechnicalRecoveryRecords(client, { ...args, now });
    const plan = recoveryTools().buildRecoveryPlan(loaded.records, loaded.currentPolicy, now);
    const document = writePlan(args.output, plan, loaded);
    (options.log ?? (value => console.log(JSON.stringify(value))))(planSummary(document));
    return document;
  } finally { if (!options.client) client.close(); }
}

module.exports = { loadTechnicalRecoveryRecords, writePlan, readOnlyClient, romeDayWindow, parseArgs, planSummary, main };
if (require.main === module) main().catch(error => {
  const reason = typeof error.message === 'string' && /^[a-z][a-z0-9_]{0,100}$/.test(error.message)
    ? error.message : 'technical_recovery_plan_failed';
  console.error(JSON.stringify({ ok: false, reason })); process.exitCode = 1;
});
