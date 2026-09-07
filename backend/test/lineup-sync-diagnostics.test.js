const test = require('node:test');
const assert = require('node:assert/strict');
const { lineupSyncDiagnostics } = require('../dist/services/LineupSyncDiagnostics');

test('local prediction success does not hide a provider failure', () => {
  const result = lineupSyncDiagnostics({ enabled: true, checked: 2, predictedSaved: 44,
    saved: 0, alreadyConfirmed: 1, providerWarnings: ['fixtures: account suspended'] });
  assert.equal(result.providerStatus, 'degraded');
  assert.equal(result.predictedSaved, 44);
  assert.equal(result.saved, 0);
  assert.equal(result.alreadyConfirmed, 1);
  assert.deepEqual(result.providerWarningMessages, ['fixtures: account suspended']);
  assert.equal(lineupSyncDiagnostics({ enabled: false }).providerStatus, 'disabled');
  assert.equal(lineupSyncDiagnostics({ enabled: true, checked: 1, providerWarnings: [] }).providerStatus, 'ok');
  assert.equal(lineupSyncDiagnostics({ enabled: true, checked: 0, providerWarnings: [] }).providerStatus, 'not_checked');
});
