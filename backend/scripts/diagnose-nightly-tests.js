// Run these fixture files directly so their native process exit is visible.
// This is a diagnostic, not a substitute for the complete backend suite.
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const choices = {
  nightly: 'research-nightly.test.js',
  recommendation: 'research-recommendation-nightly.test.js',
};
const args = process.argv.slice(2);
const name = args[0];
const repeatArg = args[1];
if (!choices[name] || args.length > 2 || (repeatArg && !/^--repeat=(?:[1-9]|1\d|20)$/.test(repeatArg))) {
  console.error('Usage: node scripts/diagnose-nightly-tests.js nightly|recommendation [--repeat=1..20]');
  process.exit(2);
}
const repeat = repeatArg ? Number(repeatArg.split('=')[1]) : 1;
const file = resolve(__dirname, '../test', choices[name]);
let failed = false;
for (let attempt = 1; attempt <= repeat; attempt++) {
  const directory = mkdtempSync(join(tmpdir(), 'nightly-diagnostic-'));
  console.log(`\nDiagnostic ${attempt}/${repeat}: ${file}`);
  const result = spawnSync(process.execPath, ['--test-reporter=tap', file], {
    env: { ...process.env, TEMP: directory, TMP: directory, TMPDIR: directory },
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const output = (result.stdout || '') + '\n' + (result.stderr || '');
  const hex = result.status === null ? null : `0x${(result.status >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
  const nativeAccessViolation = result.status !== null && (result.status >>> 0) === 0xC0000005;
  const assertionFailure = /^not ok\s/m.test(output);
  const cleanupErrorReported = /\b(?:EPERM|EBUSY)\b/.test(output);
  const remaining = readdirSync(directory);
  const ok = !result.error && result.status === 0 && !result.signal && !assertionFailure && !cleanupErrorReported && !remaining.length;
  console.log(JSON.stringify({ attempt, status: result.status, statusHex: hex, signal: result.signal,
    spawnError: result.error?.message || null, nativeAccessViolation, assertionFailure,
    cleanupErrorReported, remainingTemporaryFiles: remaining, ok }));
  if (!ok) failed = true;
  // The child has exited: remove only this run's private temporary directory.
  try { rmSync(directory, { recursive: true, force: true }); }
  catch (error) { failed = true; console.error(`Temporary cleanup failed (${directory}): ${error.message}`); }
}
if (failed) process.exitCode = 1;
