/* Persistent T-15 process. Disabled startup opens no database or provider connection. */
const { randomUUID } = require('node:crypto');
const { writeFileSync } = require('node:fs');

async function startWorker(options = {}) {
  const enabled = options.enabled ?? process.env.RESEARCH_T15_SCHEDULER_ENABLED === 'true';
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
  startWorker().then((worker) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const deadline = setTimeout(() => process.exit(1), 25_000);
      void worker.stop().then(() => { clearTimeout(deadline); process.exitCode = 0; })
        .catch(() => { clearTimeout(deadline); console.error('research_worker_stop_failed'); process.exitCode = 1; });
    };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  }).catch(() => { console.error('research_worker_start_failed'); process.exitCode = 1; });
}
module.exports = { startWorker };
