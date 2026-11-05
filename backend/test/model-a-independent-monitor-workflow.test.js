'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const workflow = readFileSync(join(__dirname, '../../.github/workflows/research-watchdog.yml'), 'utf8');
const job = workflow.match(/^ {2}model_a_inspect:\r?\n([\s\S]*?)(?=^ {2}[a-zA-Z_][\w-]*:|$(?![\s\S]))/m)?.[1];

test('Model A monitor is a separate opt-in job on the existing hourly watchdog', () => {
  assert.ok(job, 'Independent Model A job must exist');
  assert.match(job, /^ {4}if: vars\.MODEL_A_PROSPECTIVE_MONITORING_ENABLED == 'true'$/m);
  assert.doesNotMatch(job, /\bneeds:|RESEARCH_NIGHTLY_|expect_enabled|github\.event/);
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(triggers, /cron: '37 \* \* \* \*'/);
  assert.match(triggers, /workflow_run:\r?\n {4}workflows: \['Nightly Sync'\]/);
  assert.match(triggers, /workflow_dispatch:/);
  assert.equal((triggers.match(/cron:/g) || []).length, 1);
  assert.match(workflow, /permissions:\r?\n {2}contents: read\r?\n {2}actions: read/);
});

test('Model A monitor requires the dedicated read-only token without a write fallback', () => {
  assert.match(job, /TURSO_DATABASE_URL: \$\{\{ secrets\.TURSO_DATABASE_URL \}\}/);
  assert.match(job, /TURSO_AUTH_TOKEN: \$\{\{ secrets\.TURSO_WATCHDOG_READONLY_TOKEN \}\}/);
  assert.doesNotMatch(job, /secrets\.TURSO_AUTH_TOKEN|TURSO_AUTH_TOKEN:[^\r\n]*(?:\|\||\?\?)/);
  assert.match(job, /test -n "\$TURSO_AUTH_TOKEN"/);
  assert.match(job, /MODEL_A_COLLECTION_PROTOCOL_ID: \$\{\{ vars\.MODEL_A_COLLECTION_PROTOCOL_ID \}\}/);
  assert.match(job, /MODEL_A_COLLECTION_MANIFEST_SHA256: \$\{\{ vars\.MODEL_A_COLLECTION_MANIFEST_SHA256 \}\}/);
});

test('Model A independent monitor builds the checker without activating collection or providers', () => {
  assert.match(job, /uses: actions\/setup-node@v5/);
  assert.match(job, /run: npm ci/);
  assert.match(job, /run: npm run build/);
  assert.match(job, /node scripts\/check-model-a-prospective\.js --configured-database/);
  assert.match(job, /MODEL_A_PROSPECTIVE_MONITORING_ENABLED: 'true'/);
  assert.doesNotMatch(job, /bootstrap|migrat|FOOTBALL_DATA|ODDS_API|model-a-prospective-collect|MODEL_A_PROSPECTIVE_ENABLED|MODEL_A_PROSPECTIVE_COLLECTION_ENABLED|curl |fetch\(/i);
});
