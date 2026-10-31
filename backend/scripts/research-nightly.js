/* Finite CI-only Nightly Pre-Match Virtual Betting. Disabled by default. */
function recommendationEnabled(env = process.env) {
  const value = env.RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED;
  if (value !== undefined && !['true', 'false'].includes(value)) throw new Error('Invalid RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED');
  return value === 'true';
}
function recoveryConfiguration(env, now) {
  const flag = env.RESEARCH_NIGHTLY_RECOVER_TECHNICAL;
  if (flag !== undefined && !['true', 'false'].includes(flag)) throw new Error('Invalid RESEARCH_NIGHTLY_RECOVER_TECHNICAL');
  if (flag !== 'true') return { enabled: false };
  const sourcePolicyHash = env.RESEARCH_NIGHTLY_RECOVERY_SOURCE_POLICY;
  if (typeof sourcePolicyHash !== 'string' || !/^[a-f0-9]{64}$/.test(sourcePolicyHash)) {
    throw new Error('Invalid RESEARCH_NIGHTLY_RECOVERY_SOURCE_POLICY');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('technical_recovery_time_invalid');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const part = type => parts.find(value => value.type === type).value;
  const configuredDay = env.RESEARCH_NIGHTLY_RECOVERY_DAY;
  if (configuredDay !== undefined && typeof configuredDay !== 'string') throw new Error('technical_recovery_day_invalid');
  // Optional workflow inputs arrive as empty strings; a blank day means today in Rome.
  const day = configuredDay?.trim() || `${part('year')}-${part('month')}-${part('day')}`;
  require('./recover-recommendation-technical').romeDayWindow(day);
  return { enabled: true, sourcePolicyHash, day };
}
function validateRecoveryPlan(plan, sourcePolicyHash) {
  if (!plan?.policy || !Array.isArray(plan.fixtures) || !plan.fixtures.length) throw new Error('technical_recovery_no_eligible_fixtures');
  if (plan.parentPolicyHash !== sourcePolicyHash || typeof plan.policyHash !== 'string' || !/^[a-f0-9]{64}$/.test(plan.policyHash)) {
    throw new Error('technical_recovery_plan_policy_mismatch');
  }
  return plan;
}
async function recoveryPlanFor(env = process.env, options = {}) {
  const now = env.RESEARCH_NIGHTLY_RECOVER_TECHNICAL === 'true' ? (options.clock ?? (() => new Date()))() : undefined;
  const configuration = recoveryConfiguration(env, now);
  if (!configuration.enabled) {
    if (options.technicalRecovery !== undefined) throw new Error('technical_recovery_flag_required');
    return undefined;
  }
  if (options.technicalRecovery !== undefined) return validateRecoveryPlan(options.technicalRecovery, configuration.sourcePolicyHash);
  const url = env.TURSO_DATABASE_URL?.trim();
  const authToken = env.TURSO_WATCHDOG_READONLY_TOKEN?.trim() || env.TURSO_AUTH_TOKEN?.trim();
  if (!url || !authToken) throw new Error('technical_recovery_database_credentials_missing');
  const clientFactory = options.clientFactory ?? require('@libsql/client').createClient;
  const client = clientFactory({ url, authToken });
  try {
    const { loadTechnicalRecoveryRecords } = require('./recover-recommendation-technical');
    const loaded = await loadTechnicalRecoveryRecords(client, { sourcePolicyHash: configuration.sourcePolicyHash, day: configuration.day, now });
    const { buildRecoveryPlan } = require('../dist/research/ResearchRecommendationRecovery');
    return validateRecoveryPlan(buildRecoveryPlan(loaded.records, loaded.currentPolicy, now), configuration.sourcePolicyHash);
  } finally { await client.close(); }
}
async function runNightly(options = {}) {
  const { loadNightlyPolicy, runResearchNightly } = require('../dist/research/ResearchNightly');
  const policy = options.policy ?? loadNightlyPolicy();
  const env = options.env ?? process.env;
  const useRecommendations = recommendationEnabled(env);
  const now = env.RESEARCH_NIGHTLY_RECOVER_TECHNICAL === 'true' ? (options.clock ?? (() => new Date()))() : undefined;
  const recovery = recoveryConfiguration(env, now);
  if (recovery.enabled && (!policy.enabled || !useRecommendations)) throw new Error('technical_recovery_requires_enabled_recommendations');
  if (!recovery.enabled && options.technicalRecovery !== undefined) throw new Error('technical_recovery_flag_required');
  const log = options.log ?? ((record) => console.log(JSON.stringify(record)));
  if (!policy.enabled) {
    const result = { mode: 'NIGHTLY', enabled: false, reason: 'nightly_disabled' };
    log(result); return result;
  }
  if (env.RESEARCH_T15_SCHEDULER_ENABLED === 'true' || process.env.RESEARCH_T15_SCHEDULER_ENABLED === 'true') {
    throw new Error('Conflicting automatic research schedulers');
  }
  const githubRunId = process.env.GITHUB_RUN_ID;
  if (githubRunId && !/^\d{1,30}$/.test(githubRunId)) throw new Error('Invalid GitHub workflow run identity');
  const runId = options.runId ?? (githubRunId ? `github-actions:${githubRunId}` : undefined);
  // Read and validate the old evidence before application initialization can write anything.
  const technicalRecovery = recovery.enabled ? await recoveryPlanFor(env, { clock: () => now,
    clientFactory: options.clientFactory, technicalRecovery: options.technicalRecovery }) : undefined;
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const db = options.db ?? new DatabaseService();
  try {
    const execute = useRecommendations
      ? require('../dist/research/ResearchRecommendationNightly').runRecommendationNightly : runResearchNightly;
    const result = await execute(db, { ...options, policy, runId,
      ...(technicalRecovery ? { technicalRecovery } : {}),
      ...(!useRecommendations ? { diagnosticOnly: true } : {}),
      dataGatesPassed: options.dataGatesPassed ?? process.env.RESEARCH_NIGHTLY_DATA_GATES_PASSED !== 'false' });
    log(result); return result;
  } finally { if (!options.db) await db.close(); }
}
if (require.main === module) {
  runNightly().then((result) => { if (result.errors) process.exitCode = 1; })
    .catch(() => { console.error('research_nightly_failed'); process.exitCode = 1; });
}
module.exports = { runNightly, recommendationEnabled, recoveryPlanFor };
