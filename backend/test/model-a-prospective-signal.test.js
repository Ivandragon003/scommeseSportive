'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { createClient } = require('@libsql/client');
const { collectionScopeManifest } = require('../dist/research/ModelAProspectiveCollection');

if (process.argv[2] === '--child') {
  const Module = require('node:module');
  const original = Module._load;
  Module._load = function(request, _parent, _isMain) {
    if (request === '../dist/db/DatabaseService') return { DatabaseService: class { async close() {} } };
    if (request === '../dist/services/PredictionService') return { PredictionService: class {
      async predict(request) {
        if (process.send) process.send({ type: 'prediction_started', matchId: request.matchId });
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } };
    return original.apply(this, arguments);
  };
  require('../scripts/model-a-prospective-collect').main(process.env, []).then(() => { if (process.connected) process.disconnect(); }).catch(() => { process.exitCode = 1; if (process.connected) process.disconnect(); });
} else {
  test('SIGTERM interrupts a real collector process without a second claim', { skip: process.platform === 'win32', timeout: 20000 }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-a-signal-'));
    const url = pathToFileURL(path.join(dir, 'test.db')).href;
    const client = createClient({ url });
    let child;
    try {
      await client.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
      await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,home_team_id TEXT,away_team_id TEXT,competition TEXT,season TEXT,date TEXT,home_goals INTEGER,away_goals INTEGER,raw_json TEXT)');
      const now = Date.now();
      for (const [id, hours] of [['first', 2], ['second', 3]]) await client.execute({ sql: 'INSERT INTO matches VALUES(?,?,?,?,?,?,?,?,?)', args: [id, 'h', 'a', 'Serie A', '2026/27', new Date(now + hours * 3600000).toISOString(), null, null, '{}'] });
      const scope = { protocolId: 'signal', seasons: ['2026/27'], from: new Date(now - 3600000).toISOString(), to: new Date(now + 24 * 3600000).toISOString() };
      const env = { ...process.env, TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: 'local-test', MODEL_A_PROSPECTIVE_COLLECTION_ENABLED: 'true', MODEL_A_PROSPECTIVE_ENABLED: 'true', MODEL_A_PROSPECTIVE_STORAGE: 'database', MODEL_A_COLLECTION_PROTOCOL_ID: scope.protocolId, MODEL_A_COLLECTION_SEASONS: scope.seasons.join(','), MODEL_A_COLLECTION_FROM: scope.from, MODEL_A_COLLECTION_TO: scope.to, MODEL_A_COLLECTION_MANIFEST_SHA256: collectionScopeManifest(scope).sha256, MODEL_A_COLLECTION_INTERVAL_SECONDS: '0', MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED: 'false' };
      child = fork(__filename, ['--child'], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      const messages = [];
      child.on('message', message => { messages.push(message); if (message.type === 'prediction_started') child.kill('SIGTERM'); });
      const result = await new Promise((resolve, reject) => {
        const guard = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child_timeout')); }, 12000);
        child.once('error', error => { clearTimeout(guard); reject(error); });
        child.once('exit', (code, signal) => { clearTimeout(guard); resolve({ code, signal }); });
      });
      assert.deepEqual(result, { code: 0, signal: null });
      assert.deepEqual(messages, [{ type: 'prediction_started', matchId: 'first' }]);
      const ledger = (await client.execute('SELECT match_id,state,reason FROM model_a_collection_ledger')).rows;
      assert.equal(ledger.length, 1); assert.equal(ledger[0].match_id, 'first'); assert.equal(ledger[0].state, 'unconfirmed');
      assert.equal((await client.execute('SELECT status FROM model_a_collection_runs')).rows[0].status, 'interrupted');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
      client.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
