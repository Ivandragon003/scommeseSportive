#!/usr/bin/env node
'use strict';

// No dotenv, application startup, schema installation or notifications.
const { inspect } = require('./model-a-prospective-inspect');
const { evaluate, thresholds, rigorousRequirement } = require('./model-a-prospective-alerts');

function main(argv = process.argv.slice(2), environment = process.env, write = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)) {
  // Opt-in is tested before parsing URLs or touching any file/database.
  if (environment.MODEL_A_PROSPECTIVE_MONITORING_ENABLED !== 'true') {
    write({ enabled: false, status: 'disabled', alerts: [] }); return 0;
  }
  if (argv.includes('--configured-database')) return configuredMain(argv, environment, write);
  try {
    const names = { '--db-url': 'dbUrl', '--competition': 'competition', '--season': 'season', '--from': 'from', '--to': 'to', '--cutoff': 'cutoff', '--origin': 'origin', '--spool-dir': 'spoolDir', '--protocol-id': 'protocolId',
      '--max-liveness-age-hours': 'maxLivenessAgeHours', '--max-pending-age-hours': 'maxPendingAgeHours', '--result-grace-hours': 'resultGraceHours', '--result-horizon-days': 'resultHorizonDays' };
    const options = { requireRigorousInputs: rigorousRequirement(environment.MODEL_A_PROSPECTIVE_REQUIRE_RIGOROUS_INPUTS) };
    for (let i = 0; i < argv.length;) {
      if (argv[i] === '--require-rigorous-inputs') { if (options.rigorousFlag) throw new Error('invalid_arguments'); options.requireRigorousInputs = true; options.rigorousFlag = true; i++; continue; }
      const key = names[argv[i]];
      if (!key || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_arguments');
      options[key] = argv[i + 1];
      i += 2;
    }
    thresholds(options);
    const inspection = inspect(options, environment), monitoring = evaluate(inspection, options);
    write({ ...monitoring, mode: 'local_read_only', measuredAt: inspection.measuredAt, inspection });
    return monitoring.alerts.length ? 1 : 0;
  } catch (error) {
    const code = /^[a-z_]+$/.test(error.code ?? error.message ?? '') ? (error.code ?? error.message) : 'monitoring_failed';
    write({ enabled: true, status: 'critical', mode: 'local_read_only', error: code,
      alerts: [{ code: 'inspection_failed', severity: 'critical', action: 'Verify the explicit local snapshot and arguments; no coverage was certified.' }] });
    return 1;
  }
}
async function configuredMain(argv, environment, write) {
  let client;
  try {
    const names = { '--competition': 'competition', '--season': 'season', '--cutoff': 'cutoff',
      '--max-liveness-age-hours': 'maxLivenessAgeHours', '--max-pending-age-hours': 'maxPendingAgeHours', '--result-grace-hours': 'resultGraceHours', '--result-horizon-days': 'resultHorizonDays' };
    if (argv[0] !== '--configured-database') throw new Error('invalid_arguments');
    const options = { requireRigorousInputs: rigorousRequirement(environment.MODEL_A_PROSPECTIVE_REQUIRE_RIGOROUS_INPUTS) };
    for (let i = 1; i < argv.length;) {
      if (argv[i] === '--require-rigorous-inputs') { if (options.rigorousFlag) throw new Error('invalid_arguments'); options.requireRigorousInputs = true; options.rigorousFlag = true; i++; continue; }
      const key = names[argv[i]];
      if (!key || options[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('invalid_arguments');
      options[key] = argv[i + 1];
      i += 2;
    }
    Object.assign(options, thresholds(options), { protocolId: environment.MODEL_A_COLLECTION_PROTOCOL_ID, manifestSha256: environment.MODEL_A_COLLECTION_MANIFEST_SHA256 });
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.protocolId ?? '') || !/^[a-f0-9]{64}$/.test(options.manifestSha256 ?? '')) throw new Error('monitoring_scope_invalid');
    if (!environment.TURSO_DATABASE_URL?.trim() || !environment.TURSO_AUTH_TOKEN?.trim()) throw new Error('monitoring_database_credentials_required');
    // Only this explicitly opted-in branch imports a network client or compiled service.
    const { createClient } = require('@libsql/client');
    const { readModelAProspectiveMonitoring } = require('../dist/research/ModelAProspectiveMonitoring');
    client = createClient({ url: environment.TURSO_DATABASE_URL.trim(), authToken: environment.TURSO_AUTH_TOKEN.trim() });
    const { report: inspection, monitoring } = await readModelAProspectiveMonitoring(client, options);
    write({ ...monitoring, mode: 'configured_read_only', measuredAt: inspection.measuredAt, inspection });
    return monitoring.alerts.length ? 1 : 0;
  } catch (error) {
    const code = /^[a-z_]+$/.test(error.code ?? error.message ?? '') ? (error.code ?? error.message) : 'monitoring_failed';
    write({ enabled: true, status: 'critical', mode: 'configured_read_only', error: code,
      alerts: [{ code: 'inspection_failed', severity: 'critical', action: 'Verify the existing configured database, frozen scope and schema; no coverage was certified.' }] });
    return 1;
  } finally { if (client) client.close(); }
}
if (require.main === module) Promise.resolve(main()).then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
module.exports = { evaluate, main, thresholds };
