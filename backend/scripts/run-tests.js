const { readdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

// Generated isolated-build copies and fixture modules are not additional tests.
function testFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? testFiles(path) : /\.test\.[cm]?js$/.test(entry.name) ? [path] : [];
  }).sort();
}
const files = testFiles(resolve(__dirname, '../test'));
if (!files.length) throw new Error('No backend test files discovered');
const args = process.argv.slice(2);
// Native libSQL handles and teardown can race between test files on Windows.
// Serialize files there; concurrency tests within each file still run normally.
const platformOptions = process.platform === 'win32' && !args.some((arg) => /^--test-concurrency(?:=|$)/.test(arg))
  ? ['--test-concurrency=1'] : [];
const result = spawnSync(process.execPath, ['--test', ...platformOptions, ...args, ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
