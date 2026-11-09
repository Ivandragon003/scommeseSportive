'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const script = path.resolve(__dirname, '../scripts/prepare-opportunity-guard-release.cjs');
const run = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
test('preparer rejects missing arguments and never overwrites a directory', () => {
  assert.notEqual(run([]).status, 0);
  const result = run(['--source', 'unused', '--joint', 'unused', '--guard', 'unused', '--output', __dirname,
    '--created-at', '2020-01-01T00:00:00Z']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /output already exists/);
});
test('preparer rejects a modified verification report before creating output', t => {
  const parent = fs.realpathSync(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'opportunity-guard-test-'));
  assert(path.dirname(fs.realpathSync(dir)) === parent);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const joint = path.join(dir, 'joint'), guard = path.join(dir, 'guard'), source = path.join(dir, 'source.json');
  fs.mkdirSync(joint); fs.mkdirSync(guard); fs.writeFileSync(source, '{}');
  fs.writeFileSync(path.join(joint, 'verification-v2.json'), '{}');
  fs.writeFileSync(path.join(guard, 'verification.json'), '{}'); fs.writeFileSync(path.join(guard, 'study-plan.json'), '{}');
  const output = path.join(dir, 'output');
  const result = run(['--source', source, '--joint', joint, '--guard', guard, '--output', output,
    '--created-at', '2020-01-01T00:00:00Z']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /AssertionError/); assert.equal(fs.existsSync(output), false);
});
