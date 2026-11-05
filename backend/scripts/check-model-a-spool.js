#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function syncDirectory(directory) {
  if (process.platform === 'win32') return false;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  return true;
}
function inspect(directory, probe = false) {
  if (!directory || !path.isAbsolute(directory)) throw Error('absolute_directory_required');
  const target = fs.realpathSync(directory), stat = fs.statSync(target);
  if (!stat.isDirectory()) throw Error('spool_directory_required');
  const privatePermissions = process.platform === 'win32' ? null : (stat.mode & 0o077) === 0;
  const report = { mode: probe ? 'explicit_temporary_write_probe' : 'read_only', directoryExists: true,
    privatePermissions, writableProbePassed: null, hardLinkVerified: null, directorySyncConfirmed: null,
    contentHashVerified: null, externalPersistenceVerified: false,
    limitations: ['This probe does not verify mount persistence, backup/restore, power loss, capacity or database availability.',
      'Unix mode bits do not certify Windows ACLs or remote storage access policy.'] };
  if (!probe) return report;
  let temporary;
  try {
    temporary = fs.mkdtempSync(path.join(target, '.model-a-probe-'));
    if (path.dirname(temporary) !== target || !path.basename(temporary).startsWith('.model-a-probe-')) {
      temporary = undefined; throw Error('spool_probe_cleanup_scope_invalid');
    }
    fs.chmodSync(temporary, 0o700);
    const original = path.join(temporary, 'original'), linked = path.join(temporary, 'linked');
    const contents = Buffer.from('Model A spool capability probe\n');
    const fd = fs.openSync(original, 'wx', 0o600);
    try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(original, linked);
    report.directorySyncConfirmed = syncDirectory(temporary);
    const hash = value => createHash('sha256').update(value).digest('hex');
    report.contentHashVerified = hash(fs.readFileSync(linked)) === hash(contents);
    if (!report.contentHashVerified) throw Error('spool_probe_content_mismatch');
    report.hardLinkVerified = fs.statSync(original).ino === fs.statSync(linked).ino;
    if (!report.hardLinkVerified) throw Error('spool_probe_link_mismatch');
    report.writableProbePassed = true;
  } finally {
    // Only the private mkdtemp child created above may be removed.
    if (temporary) {
      fs.rmSync(temporary, { recursive: true, force: true }); syncDirectory(target);
    }
  }
  return report;
}
function main(argv = process.argv.slice(2), write = report => console.log(JSON.stringify(report))) {
  try {
    if (argv.length < 2 || argv[0] !== '--directory' || argv.length > 3 || (argv[2] !== undefined && argv[2] !== '--probe')) throw Error('spool_probe_arguments_invalid');
    const report = inspect(argv[1], argv[2] === '--probe'); write(report);
    return report.privatePermissions === false ? 1 : 0;
  } catch { write({ status: 'failed', error: 'spool_preflight_failed', externalPersistenceVerified: false }); return 1; }
}
if (require.main === module) process.exitCode = main();
module.exports = { inspect, main };
