'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { persistSpool, countSpool } = require('../dist/research/ModelAProspectiveSpool');

function probe(run) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-a-directory-'));
  const directory = path.join(base, 'new', 'nested', 'spool');
  const open = fs.openSync, sync = fs.fsyncSync, close = fs.closeSync;
  const handles = new Map(), seen = []; let fail;
  fs.openSync = (name, flags, ...rest) => {
    const fd = open(name, flags, ...rest);
    if (flags === 'r' && fs.statSync(name).isDirectory()) handles.set(fd, path.resolve(name));
    return fd;
  };
  fs.fsyncSync = fd => { if (handles.has(fd)) { seen.push(handles.get(fd)); if (handles.get(fd) === fail) throw Error('directory sync failed'); } return sync(fd); };
  fs.closeSync = fd => { handles.delete(fd); return close(fd); };
  const record = () => ({ id: randomUUID(), matchId: 'm', forecastAt: new Date().toISOString(), kickoffAt: new Date(Date.now() + 3600000).toISOString(), payload: '{}' });
  try { run({ base, directory, seen, record, failAt: value => { fail = value; } }); }
  finally { fs.openSync = open; fs.fsyncSync = sync; fs.closeSync = close; fs.rmSync(base, { recursive: true, force: true }); }
}

test('new nested spool names are synced in their parents even when recovery creates the directory first', { skip: process.platform === 'win32' }, () => probe(({ base, directory, seen, record }) => {
  assert.equal(countSpool(directory), 0);
  assert.deepEqual(seen, [path.dirname(directory), path.join(base, 'new'), base]);
  const receipt = persistSpool(directory, record());
  assert.equal(receipt.directorySyncConfirmed, true);
  assert.equal(seen.at(-1), directory);
}));

test('a failed parent sync is retried before a later event can be admitted', { skip: process.platform === 'win32' }, () => probe(({ base, directory, seen, record, failAt }) => {
  failAt(base); assert.throws(() => persistSpool(directory, record()), /directory sync failed/);
  assert.equal(fs.readdirSync(directory).length, 0);
  const previous = seen.length; failAt(undefined);
  assert.equal(persistSpool(directory, record()).directorySyncConfirmed, true);
  assert.deepEqual(seen.slice(previous), [path.dirname(directory), path.join(base, 'new'), base, directory]);
}));
