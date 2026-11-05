#!/usr/bin/env node
'use strict';

const HELP = `Usage: node backend/scripts/model-a-prospective-results-recover.js --from UTC --to UTC
  [--match-id understat_ID ...] [--limit 20]
  [--execute --authorize-results-writes]
Default: SELECT-only plan; no provider request, lease, bootstrap or migration.
Execute: one page, both explicit arguments and both MODEL_A_PROSPECTIVE_* enable flags required.
Range: inclusive kickoff endpoints, at most 366 days, no future endpoint; existing forecasts only.
Rerun the same scope to resume its own persisted cursor; the ordinary cursor is unchanged.`;
const PUBLIC_ERRORS = new Set([
  'result_recovery_arguments_invalid', 'result_recovery_execution_not_authorized', 'result_recovery_feature_disabled',
  'result_recovery_database_configuration_required', 'result_recovery_database_url_invalid', 'result_recovery_database_file_missing',
  'result_recovery_readonly_runtime_required', 'result_recovery_plan_write_rejected', 'result_refresh_scope_interval_invalid',
  'result_refresh_scope_match_ids_invalid', 'result_refresh_bounds_invalid', 'result_refresh_scoped_sink_required',
  'result_refresh_candidates_outside_scope', 'result_refresh_scope_mismatch', 'result_refresh_lease_lost'
]);

function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { matchIds: [], limit: 20, execute: false, authorize: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!['--from', '--to', '--match-id', '--limit', '--execute', '--authorize-results-writes'].includes(arg)
      || (arg !== '--match-id' && seen.has(arg))) throw new Error('result_recovery_arguments_invalid');
    seen.add(arg);
    if (arg === '--execute') { options.execute = true; continue; }
    if (arg === '--authorize-results-writes') { options.authorize = true; continue; }
    const value = args[++i];
    if (typeof value !== 'string' || value.startsWith('--')) throw new Error('result_recovery_arguments_invalid');
    if (arg === '--from') options.from = value;
    if (arg === '--to') options.to = value;
    if (arg === '--match-id') options.matchIds.push(value);
    if (arg === '--limit') {
      if (!/^[1-9]\d*$/.test(value) || Number(value) > 200) throw new Error('result_recovery_arguments_invalid');
      options.limit = Number(value);
    }
  }
  if (!options.from || !options.to || options.matchIds.length > 1000) throw new Error('result_recovery_arguments_invalid');
  if (options.execute !== options.authorize) throw new Error('result_recovery_execution_not_authorized');
  return options;
}

function openClient(environment, readonly) {
  const url = environment.TURSO_DATABASE_URL?.trim();
  if (!url) throw new Error('result_recovery_database_configuration_required');
  if (url.startsWith('file:')) {
    const path = require('node:path');
    const fs = require('node:fs');
    const { fileURLToPath } = require('node:url');
    if (/[?#\0]/.test(url) || url === 'file::memory:') throw new Error('result_recovery_database_url_invalid');
    let filename;
    try { filename = url.startsWith('file:///') ? fileURLToPath(url) : path.resolve(url.slice(5)); }
    catch { throw new Error('result_recovery_database_url_invalid'); }
    if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) throw new Error('result_recovery_database_file_missing');
    if (readonly) {
      const [major, minor] = process.versions.node.split('.').map(Number);
      if (major < 22 || (major === 22 && minor < 13)) throw new Error('result_recovery_readonly_runtime_required');
      let DatabaseSync;
      try { ({ DatabaseSync } = require('node:sqlite')); }
      catch { throw new Error('result_recovery_readonly_runtime_required'); }
      const database = new DatabaseSync(filename, { readOnly: true, enableExtensions: false });
      return { execute: async statement => ({ rows: database.prepare(statement.sql).all(...(statement.args ?? [])) }), close: () => database.close() };
    }
  } else if (!/^(?:libsql|https):\/\//.test(url) || !environment.TURSO_AUTH_TOKEN?.trim()) {
    throw new Error('result_recovery_database_configuration_required');
  }
  const { createClient } = require('@libsql/client');
  return createClient({ url, ...(environment.TURSO_AUTH_TOKEN?.trim() ? { authToken: environment.TURSO_AUTH_TOKEN.trim() } : {}) });
}

// Dependencies are fixture seams, never read from process arguments or provider data.
async function main(environment = process.env, args = process.argv.slice(2), dependencies = {}) {
  let client, ownsClient = false;
  try {
    const options = parseArguments(args);
    const output = dependencies.output ?? (value => console.log(JSON.stringify(value)));
    if (options.help) { output({ usage: HELP }); return { usage: HELP }; }
    if (options.execute && (environment.MODEL_A_PROSPECTIVE_ENABLED !== 'true' || environment.MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED !== 'true'))
      throw new Error('result_recovery_feature_disabled');
    const { createModelAProspectiveResultRefreshSink, validateModelAProspectiveResultRefreshScope,
      planModelAProspectiveResultRefresh, refreshModelAProspectiveResults } = require('../dist/research/ModelAProspectiveResultRefresh');
    const scope = validateModelAProspectiveResultRefreshScope({ from: options.from, to: options.to,
      ...(options.matchIds.length ? { matchIds: options.matchIds } : {}) }, dependencies.clock ? dependencies.clock() : new Date());
    client = dependencies.client ?? openClient(environment, !options.execute); ownsClient = !dependencies.client;
    const queryClient = options.execute ? client : { execute: statement => {
      if (!/^\s*(?:SELECT|WITH)\b/i.test(statement.sql)) throw new Error('result_recovery_plan_write_rejected');
      return client.execute(statement);
    } };
    const sink = createModelAProspectiveResultRefreshSink(queryClient, scope);
    const result = options.execute ? { mode: 'execute', scope, ...(await refreshModelAProspectiveResults(sink,
      { env: environment, scope, authorizeExplicitScope: true, pageSize: options.limit, source: dependencies.source, clock: dependencies.clock })) }
      : await planModelAProspectiveResultRefresh(sink, options.limit);
    output(result);
    return result;
  } catch (error) {
    throw new Error(error instanceof Error && PUBLIC_ERRORS.has(error.message) ? error.message : 'result_recovery_failed');
  } finally {
    if (ownsClient && client) {
      try { client.close(); } catch { /* Do not print a driver error containing the target or credentials. */ }
    }
  }
}

if (require.main === module) main().then(result => {
  if (result.mode === 'execute' && result.status !== 'completed') process.exitCode = 1;
}).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { main, parseArguments };
