'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect, main } = require('../scripts/check-model-a-spool');

test('spool preflight is read-only unless its write probe is explicitly requested', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-a-preflight-'));
  try {
    fs.writeFileSync(path.join(directory, 'pending.json'), 'preserve');
    const before = fs.readdirSync(directory);
    const report = inspect(directory);
    assert.equal(report.mode, 'read_only'); assert.equal(report.writableProbePassed, null);
    assert.equal(report.externalPersistenceVerified, false); assert.deepEqual(fs.readdirSync(directory), before);
    const probe = inspect(directory, true);
    assert.equal(probe.writableProbePassed, true); assert.equal(probe.hardLinkVerified, true);
    assert.equal(probe.contentHashVerified, true); assert.equal(probe.directorySyncConfirmed, process.platform !== 'win32');
    assert.equal(probe.externalPersistenceVerified, false); assert.deepEqual(fs.readdirSync(directory), before);
    assert.equal(fs.readFileSync(path.join(directory, 'pending.json'), 'utf8'), 'preserve');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('spool preflight rejects missing/relative paths and redacts errors', () => {
  for (const args of [[], ['--directory', 'relative'], ['--directory', path.join(os.tmpdir(), 'not-existing-model-a-directory')], ['--directory', 'https://secret.example/token', '--probe']]) {
    const output = []; assert.equal(main(args, report => output.push(report)), 1);
    assert.deepEqual(output, [{ status: 'failed', error: 'spool_preflight_failed', externalPersistenceVerified: false }]);
  }
});
