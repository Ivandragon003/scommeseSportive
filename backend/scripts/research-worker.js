/* Retired T-15 entrypoint; explicit injected fixtures retain the historical harness. */
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');

async function startWorker(options = {}) {
  const enabled = options.enabled === true;
  const log = options.log ?? ((record) => console.log(JSON.stringify(record)));
  const ownerId = options.ownerId ?? randomUUID();
  const stateFile = options.stateFile ?? process.env.RESEARCH_WORKER_STATE_FILE;
  const state = { ownerId, enabled, phase: enabled ? 'starting' : 'disabled', lastTickAt: null, observedAt: null };
  const publish = () => {
    state.observedAt = new Date().toISOString();
    if (stateFile) writeFileSync(stateFile, JSON.stringify(state));
  };
  publish();
  const keepAlive = setInterval(publish, 15_000);
  let db, runtime;
  try {
    if (enabled) {
      const { DatabaseService } = require('../dist/db/DatabaseService');
      const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
      db = options.db ?? new DatabaseService();
      runtime = options.runtime ?? new ResearchRuntime(db, { ...options.runtimeOptions,
        coordinator: options.coordinator ?? db.researchWorker, ownerId,
        onTick: (summary) => {
          state.lastTickAt = summary.at;
          state.phase = summary.errors ? 'error' : 'running';
          publish(); log({ component: 'research_t15', ownerId, ...summary });
          options.onTick?.(summary);
        } });
      await runtime.start();
      state.phase = 'running'; publish();
    }
    log({ component: 'research_t15', event: enabled ? 'worker_started' : 'worker_disabled', ownerId, enabled });
  } catch {
    clearInterval(keepAlive);
    await runtime?.shutdown().catch(() => undefined);
    await db?.close().catch(() => undefined);
    throw new Error('research_worker_start_failed');
  }
  let stopping;
  return { enabled, runtime, state, stop: () => stopping ??= (async () => {
    clearInterval(keepAlive); state.phase = 'stopping'; publish();
    await runtime?.shutdown();
    await db?.close();
    state.phase = 'stopped'; publish();
    log({ component: 'research_t15', event: 'worker_stopped', ownerId });
  })() };
}

if (require.main === module) {
  console.log(JSON.stringify({ component: 'research_t15', event: 'worker_retired', enabled: false,
    replacement: 'node scripts/research-nightly.js' }));
}
module.exports = { startWorker };
