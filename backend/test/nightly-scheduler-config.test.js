const test = require('node:test');
const assert = require('node:assert/strict');
const { loadNightlySchedulerConfig } = require('../dist/services/NightlySchedulerConfig');

test('GitHub owns nightly jobs even when a deployment retains old enabled flags', () => {
  const flags = {
    AUTO_SYNC_ON_BOOT: 'true', UNDERSTAT_SCHEDULER_ENABLED: 'true',
    ODDS_SNAPSHOT_SCHEDULER_ENABLED: 'true', LEARNING_REVIEW_SCHEDULER_ENABLED: 'true',
    LINEUP_REFRESH_SCHEDULER_ENABLED: 'true',
  };
  for (const config of [flags, { ...flags, NIGHTLY_ORCHESTRATOR: 'github_actions' }]) {
    assert.deepEqual(loadNightlySchedulerConfig(config), {
      orchestrator: 'github_actions', autoSyncOnBoot: false,
      understatEnabled: false, oddsEnabled: false, learningEnabled: false,
    });
    assert.equal(config.LINEUP_REFRESH_SCHEDULER_ENABLED, 'true');
  }
});

test('backend scheduling requires explicit ownership and respects disabled jobs', () => {
  assert.deepEqual(loadNightlySchedulerConfig({
    NIGHTLY_ORCHESTRATOR: 'backend', AUTO_SYNC_ON_BOOT: 'false',
    UNDERSTAT_SCHEDULER_ENABLED: 'true', ODDS_SNAPSHOT_SCHEDULER_ENABLED: 'true',
    LEARNING_REVIEW_SCHEDULER_ENABLED: 'false',
  }), {
    orchestrator: 'backend', autoSyncOnBoot: false,
    understatEnabled: true, oddsEnabled: true, learningEnabled: false,
  });
  assert.throws(() => loadNightlySchedulerConfig({ NIGHTLY_ORCHESTRATOR: 'typo' }), /NIGHTLY_ORCHESTRATOR/);
});
