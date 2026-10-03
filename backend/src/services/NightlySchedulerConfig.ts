export function loadNightlySchedulerConfig(env: NodeJS.ProcessEnv = process.env) {
  const orchestrator = String(env.NIGHTLY_ORCHESTRATOR ?? 'github_actions').trim().toLowerCase();
  if (orchestrator !== 'github_actions' && orchestrator !== 'backend') {
    throw new Error('NIGHTLY_ORCHESTRATOR must be github_actions or backend');
  }
  const enabled = (key: string, fallback: string) => orchestrator === 'backend'
    && String(env[key] ?? fallback).trim().toLowerCase() === 'true';
  return {
    orchestrator,
    autoSyncOnBoot: enabled('AUTO_SYNC_ON_BOOT', 'true'),
    understatEnabled: enabled('UNDERSTAT_SCHEDULER_ENABLED', 'true'),
    oddsEnabled: enabled('ODDS_SNAPSHOT_SCHEDULER_ENABLED', 'false'),
    learningEnabled: enabled('LEARNING_REVIEW_SCHEDULER_ENABLED', 'false'),
  };
}
