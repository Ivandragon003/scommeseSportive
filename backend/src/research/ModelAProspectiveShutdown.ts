import { drainModelAProspective, modelAProspectiveEnabled, modelAProspectiveStats, stopModelAProspectiveRecovery, setModelAProspectiveAdmissionDeadline, closeModelAProspectiveAdmission } from './ModelAProspectiveRecorder';

/** Installed only when collection is enabled; a persistent spool retains timed-out jobs. */
export function installModelAProspectiveShutdown(server: { close: (done: () => void) => unknown }): void {
  if (!modelAProspectiveEnabled()) return;
  let stopping = false;
  const shutdown = (signal: 'SIGTERM' | 'SIGINT') => {
    if (stopping) return;
    stopping = true;
    stopModelAProspectiveRecovery();
    const configured = Number(process.env.MODEL_A_PROSPECTIVE_SHUTDOWN_MS ?? 5000);
    const timeout = Number.isFinite(configured) ? Math.max(100, Math.min(30000, configured)) : 5000;
    const started = Date.now();
    setModelAProspectiveAdmissionDeadline(started + timeout);
    void (async () => {
      await Promise.race([new Promise<void>(resolve => server.close(() => resolve())),
        new Promise<void>(resolve => setTimeout(resolve, timeout))]);
      closeModelAProspectiveAdmission();
      const drained = await drainModelAProspective(Math.max(0, timeout - (Date.now() - started)));
      console.log('[ModelAProspective] shutdown:', JSON.stringify({ signal, drained, ...modelAProspectiveStats() }));
      process.exit(signal === 'SIGINT' ? 130 : 143);
    })().catch(error => { console.error('[ModelAProspective] shutdown failed:', error); process.exit(1); });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
