/* Finite CI-only Nightly Pre-Match Virtual Betting. Disabled by default. */
async function runNightly(options = {}) {
  const { loadNightlyPolicy, runResearchNightly } = require('../dist/research/ResearchNightly');
  const policy = options.policy ?? loadNightlyPolicy();
  const log = options.log ?? ((record) => console.log(JSON.stringify(record)));
  if (!policy.enabled) {
    const result = { mode: 'NIGHTLY', enabled: false, reason: 'nightly_disabled' };
    log(result); return result;
  }
  if (process.env.RESEARCH_T15_SCHEDULER_ENABLED === 'true') throw new Error('Conflicting automatic research schedulers');
  const githubRunId = process.env.GITHUB_RUN_ID;
  if (githubRunId && !/^\d{1,30}$/.test(githubRunId)) throw new Error('Invalid GitHub workflow run identity');
  const runId = options.runId ?? (githubRunId ? `github-actions:${githubRunId}` : undefined);
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const db = options.db ?? new DatabaseService();
  try {
    const result = await runResearchNightly(db, { ...options, policy, runId,
      dataGatesPassed: options.dataGatesPassed ?? process.env.RESEARCH_NIGHTLY_DATA_GATES_PASSED !== 'false' });
    log(result); return result;
  } finally { if (!options.db) await db.close(); }
}
if (require.main === module) {
  runNightly().then((result) => { if (result.errors) process.exitCode = 1; })
    .catch(() => { console.error('research_nightly_failed'); process.exitCode = 1; });
}
module.exports = { runNightly };
