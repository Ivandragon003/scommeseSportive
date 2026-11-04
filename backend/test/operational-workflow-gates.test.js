const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext } = require('node:vm');
const { CALIBRATION_GATE, COLLECTION_GATE, MONITORING_STEP_GATE, calibrationRunAllowed, collectionRunAllowed, checkWorkflowSources, checkWorkflows, validateCalibrationWorkflow, validateCollectionWorkflow, validateCiWorkflow } = require('../scripts/check-operational-workflow-gates');

const workflow = (name) => readFileSync(join(__dirname, '../../.github/workflows', name), 'utf8').replace(/\r\n/g, '\n');
const calibration = workflow('calibration-warm.yml');
const ci = workflow('ci.yml');
const collection = workflow('model-a-prospective.yml');

test('calibration authorization requires explicit manual consent and repository opt-in together', () => {
  for (const eventName of ['push', 'pull_request', 'schedule', 'workflow_dispatch']) {
    for (const authorizeDatabaseWrites of [undefined, false, 'true', true]) {
      for (const operationalCalibrationEnabled of [undefined, '', 'false', true, 'true']) {
        assert.equal(calibrationRunAllowed(calibration, { eventName, authorizeDatabaseWrites, operationalCalibrationEnabled }),
          eventName === 'workflow_dispatch' && authorizeDatabaseWrites === true && operationalCalibrationEnabled === 'true');
      }
    }
  }
});

test('calibration gate rejects automatic triggers, permissive expressions and permissive defaults', () => {
  assert.equal(validateCalibrationWorkflow(calibration), true);
  for (const changed of [
    calibration.replace('on:\n', 'on:\n  push:\n'),
    calibration.replace('default: false', 'default: true'),
    calibration.replace('required: true', 'required: false'),
    calibration.replace(CALIBRATION_GATE, CALIBRATION_GATE.replace(' && ', ' || ')),
    calibration.replace(CALIBRATION_GATE, "github.event_name == 'workflow_dispatch'"),
    calibration.replace('jobs:\n', 'env:\n  TURSO_AUTH_TOKEN: unsafe\njobs:\n'),
    calibration.replace('  prepare:\n', '  extra:\n    runs-on: ubuntu-latest\n  prepare:\n'),
    calibration.replace('  prepare:\n', '  "extra":\n    runs-on: ubuntu-latest\n  prepare:\n'),
  ]) assert.throws(() => validateCalibrationWorkflow(changed));
});

test('ordinary CI retains both publication triggers and all backend/frontend quality checks', () => {
  assert.equal(validateCiWorkflow(ci), true);
  assert.throws(() => validateCiWorkflow(ci.replace('  pull_request:', '  workflow_dispatch:')));
  assert.throws(() => validateCiWorkflow(ci.replace('npm run lint', 'npm run ignored')));
  assert.throws(() => validateCiWorkflow(ci.replace('  backend:\n', '  backend:\n    if: false\n')));
});

test('collection is disabled for missing/false opt-in and for every push or pull request', () => {
  for (const eventName of ['push', 'pull_request', 'schedule', 'workflow_dispatch']) {
    for (const authorizeCollection of [undefined, false, 'true', true]) {
      for (const collectionEnabled of [undefined, '', 'false', true, 'true']) {
        assert.equal(collectionRunAllowed(collection, { eventName, authorizeCollection, collectionEnabled }),
          collectionEnabled === 'true' && (eventName === 'schedule' || (eventName === 'workflow_dispatch' && authorizeCollection === true)));
      }
    }
  }
});

test('collection rejects permissive gates, volatile storage and missing frozen protocol scope', () => {
  assert.equal(validateCollectionWorkflow(collection), true);
  for (const changed of [
    collection.replace('on:\n', 'on:\n  push:\n'),
    collection.replace('default: false', 'default: true'),
    collection.replace(COLLECTION_GATE, "github.event_name == 'schedule'"),
    collection.replace('MODEL_A_PROSPECTIVE_STORAGE: database', 'MODEL_A_PROSPECTIVE_STORAGE: spool'),
    collection.replace('MODEL_A_COLLECTION_INTERVAL_SECONDS: \'0\'', 'MODEL_A_COLLECTION_INTERVAL_SECONDS: \'60\''),
    collection.replace('vars.MODEL_A_COLLECTION_MANIFEST_SHA256', 'vars.OTHER_SCOPE'),
    collection.replace("vars.MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED || 'false'", "vars.MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED || 'true'"),
    collection.replace('      TZ:', '      ODDS_API_KEY: forbidden\n      TZ:'),
  ]) assert.throws(() => validateCollectionWorkflow(changed));
});

test('publication audit rejects injected secrets, operational commands and indirect CI workflow runs', () => {
  const sources = { 'calibration-warm.yml': calibration, 'ci.yml': ci, 'model-a-prospective.yml': collection };
  assert.equal(checkWorkflowSources(sources).length, 3);
  assert.throws(() => checkWorkflowSources({ ...sources, 'ci.yml': ci + '\n# ${{ secrets.TURSO_AUTH_TOKEN }}\n' }));
  assert.throws(() => checkWorkflowSources({ ...sources, 'ci.yml': ci + '\n# npm run calibration:warm\n' }));
  assert.throws(() => checkWorkflowSources({ ...sources, 'indirect.yml': "on:\n  workflow_run:\n    workflows: ['CI']\n    types: [completed]\njobs:\n  operate:\n    runs-on: ubuntu-latest\n" }));
});

test('post-collection read-only monitoring retains opt-in, failure status and aggregate diagnostics', () => {
  assert.equal(validateCollectionWorkflow(collection), true);
  for (const changed of [
    collection.replace("vars.MODEL_A_PROSPECTIVE_MONITORING_ENABLED || 'false'", "vars.MODEL_A_PROSPECTIVE_MONITORING_ENABLED || 'true'"),
    collection.replace(MONITORING_STEP_GATE, '${{ always() }}'),
    collection.replace('set -eo pipefail', 'set -e'),
    collection.replace('check-model-a-prospective.js --configured-database', 'check-model-a-prospective.js'),
    collection.replace('process.env.GITHUB_STEP_SUMMARY', 'process.env.OTHER_SUMMARY'),
    collection.replace('uses: actions/upload-artifact@v7', 'uses: actions/other-artifact@v7'),
  ]) assert.throws(() => validateCollectionWorkflow(changed));
});

test('GitHub monitoring summary publishes only allowed status and alert count', () => {
  const script = collection.match(/node <<'NODE'\n([\s\S]*?)\n {10}NODE/)[1];
  for (const report of [
    { status: 'warning', alerts: [{ code: 'example', privatePayload: 'credential-do-not-copy' }] },
    { status: 'credential-do-not-copy', alerts: ['credential-do-not-copy'] },
    null,
  ]) {
    const files = new Map();
    const fakeFs = {
      mkdirSync: () => {},
      readFileSync: () => { if (!report) throw new Error('credential-do-not-copy'); return JSON.stringify(report); },
      writeFileSync: (path, content) => files.set(path, content),
      appendFileSync: (path, content) => files.set(path, (files.get(path) || '') + content),
    };
    runInNewContext(script, { require: name => { assert.equal(name, 'node:fs'); return fakeFs; }, process: { env: { GITHUB_STEP_SUMMARY: 'summary.md' } } });
    assert.equal(files.get('summary.md'), files.get('artifacts/model-a-prospective-monitor.log'));
    assert.doesNotMatch(files.get('summary.md'), /credential-do-not-copy|privatePayload/);
    assert.match(files.get('summary.md'), report?.status === 'warning' ? /warning; alerts: 1/ : /unavailable; alerts: (?:1|unknown)/);
  }
});

test('all repository workflow sources separate publication checks from operational jobs', () => {
  const report = checkWorkflows();
  assert.deepEqual(report.filter((entry) => entry.publication).map((entry) => entry.file), ['ci.yml']);
  assert.equal(report.find((entry) => entry.file === 'ci.yml').repositorySecrets, false);
});
