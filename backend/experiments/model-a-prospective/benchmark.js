'use strict';
// Isolated recorder microbenchmark, not an HTTP or production database benchmark.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { fork } = require('node:child_process');
const { createClient } = require('@libsql/client');
const { DatabaseService } = require('../../dist/db/DatabaseService');
const { scheduleModelAProspective, drainModelAProspective, modelAProspectiveStats } = require('../../dist/research/ModelAProspectiveRecorder');
process.env.MODEL_A_PROSPECTIVE_ALLOW_VOLATILE = 'true';
function sample() {
  const now = Date.now(); return { match: { match_id: 'm', home_team_id: 'h', away_team_id: 'a',
    home_goals: null, away_goals: null, date: new Date(now + 3600000).toISOString() },
  request: { matchId: 'm', homeTeamId: 'h', awayTeamId: 'a' }, asOf: new Date(now).toISOString(), origin: 'direct_a',
  model: { version: 'APP-A-bench', codeHash: '', configHash: '', stateHash: '' }, contextual: { over25: .54, under25: .46 },
  calibrated: null, decision: {}, selected: null, modelParametersHash: '',
  calibration: { profileHash: '', globalSamples: 0, overSamples: null, underSamples: null, overCurve: 'unavailable', underCurve: 'unavailable' } };
}
if (process.argv[2] === 'graceful-child') {
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true'; let written = 0;
  const sink = { appendModelAProspectiveForecast: async () => { await new Promise(r => setTimeout(r, 4)); written++; } };
  for (let i = 0; i < 40; i++) scheduleModelAProspective(sink, sample());
  drainModelAProspective(5000).then(drained => { if (process.send) process.send({ drained, written, stats: modelAProspectiveStats() }); });
} else if (process.argv[2] === 'crash-child') {
  process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
  const sink = { appendModelAProspectiveForecast: () => new Promise(() => {}) };
  for (let i = 0; i < 40; i++) scheduleModelAProspective(sink, sample());
  if (process.send) process.send(modelAProspectiveStats());
  setInterval(() => {}, 1000);
} else {
  (async () => {
    const client = createClient({ url: 'file::memory:' });
    try {
      await client.executeMultiple(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
      const wrapper = { execute: (sql, args) => client.execute({ sql, args }),
        get: async (sql, args) => (await client.execute({ sql, args })).rows[0] ?? null };
      const durable = record => DatabaseService.prototype.appendModelAProspectiveForecast.call(wrapper, record);
      const percent = (values, p) => [...values].sort((a, b) => a-b)[Math.floor((values.length-1)*p)];
      const input = sample(), off = [], on = []; process.env.MODEL_A_PROSPECTIVE_ENABLED = 'false';
      for (let i = 0; i < 200; i++) { const t = performance.now(); scheduleModelAProspective({ appendModelAProspectiveForecast: durable }, input); off.push(performance.now()-t); }
      process.env.MODEL_A_PROSPECTIVE_ENABLED = 'true';
      const started = performance.now();
      for (let i = 0; i < 200; i++) { const t = performance.now(); scheduleModelAProspective({ appendModelAProspectiveForecast: durable }, input); on.push(performance.now()-t); }
      const drained = await drainModelAProspective(30000), durationMs = performance.now()-started;
      let attempts = 0; const previousError = console.error; console.error = () => {};
      try {
        scheduleModelAProspective({ appendModelAProspectiveForecast: async r => { attempts++; if (attempts <= 2) throw Error('temporary outage'); await durable(r); } }, sample());
        if (!await drainModelAProspective(5000)) throw Error('outage drain timeout');
        let commits = 0;
        scheduleModelAProspective({ appendModelAProspectiveForecast: async r => { await durable(r); commits++; if (commits === 1) throw Error('ack lost'); } }, sample());
        if (!await drainModelAProspective(5000)) throw Error('ack drain timeout');
        const count = (await client.execute('SELECT COUNT(*) AS n FROM model_a_prospective_forecasts')).rows[0].n;
        const child = fork(__filename, ['crash-child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const killed = await new Promise((resolve, reject) => { child.once('error', reject); child.once('message', message => {
          child.once('exit', (code, signal) => resolve({ accepted: message.accepted, pending: message.pending, exitCode: code, signal })); child.kill('SIGKILL');
        }); });
        const graceful = fork(__filename, ['graceful-child'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const gracefulResult = await new Promise((resolve, reject) => { graceful.once('error', reject); graceful.once('message', message => {
          graceful.once('exit', code => resolve({ ...message, exitCode: code })); graceful.disconnect();
        }); });
        const output = { benchmark: 'isolated in-memory libSQL, recorder enqueue only, not HTTP', n: 200,
          offMs: { p50: percent(off,.5), p95: percent(off,.95) }, onMs: { p50: percent(on,.5), p95: percent(on,.95) },
          drained, durationMs, throughputPerSecond: 200000/durationMs, outageAttempts: attempts,
          ackLostAttempts: commits, rows: count, stats: modelAProspectiveStats(), gracefulDrain: gracefulResult, abruptKill: killed };
        const destination = process.argv[2]; if (destination) fs.writeFileSync(destination, JSON.stringify(output, null, 2)+'\n');
        process.stdout.write(JSON.stringify(output, null, 2)+'\n');
      } finally { console.error = previousError; }
    } finally { client.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
