#!/usr/bin/env node
'use strict';

// This check precedes application imports, credential access and database creation.
async function main(env = process.env, args = process.argv.slice(2)) {
  if (args.length && (args.length !== 1 || args[0] !== '--print-scope')) throw new Error('collection_arguments_invalid');
  if (args[0] === '--print-scope') {
    const { collectionScopeManifest } = require('../dist/research/ModelAProspectiveCollection');
    console.log(JSON.stringify(collectionScopeManifest({ protocolId: env.MODEL_A_COLLECTION_PROTOCOL_ID, seasons: (env.MODEL_A_COLLECTION_SEASONS || '').split(',').filter(Boolean), from: env.MODEL_A_COLLECTION_FROM, to: env.MODEL_A_COLLECTION_TO })));
    return;
  }
  if (env.MODEL_A_PROSPECTIVE_COLLECTION_ENABLED !== 'true' || env.MODEL_A_PROSPECTIVE_ENABLED !== 'true') {
    console.log(JSON.stringify({ enabled: false, reason: 'collection_or_recorder_disabled' })); return;
  }
  if (env.MODEL_A_PROSPECTIVE_STORAGE !== 'database' && !env.MODEL_A_PROSPECTIVE_SPOOL_DIR?.trim()) throw new Error('collection_durable_storage_required');
  const { collectionBudgetsFromEnv } = require('../dist/research/ModelAProspectiveBudget');
  const budgets = collectionBudgetsFromEnv(env);
  if (!env.TURSO_DATABASE_URL?.trim() || !env.TURSO_AUTH_TOKEN?.trim()) throw new Error('collection_database_credentials_required');
  const { ModelAProspectiveCollection, validateCollectionScope } = require('../dist/research/ModelAProspectiveCollection');
  const scope = validateCollectionScope({ protocolId: env.MODEL_A_COLLECTION_PROTOCOL_ID, manifestSha256: env.MODEL_A_COLLECTION_MANIFEST_SHA256, seasons: (env.MODEL_A_COLLECTION_SEASONS || '').split(',').filter(Boolean), from: env.MODEL_A_COLLECTION_FROM, to: env.MODEL_A_COLLECTION_TO });
  const interval = Number(env.MODEL_A_COLLECTION_INTERVAL_SECONDS || 0);
  if (!Number.isInteger(interval) || interval < 0 || (interval > 0 && interval < 60) || interval > 86400) throw new Error('collection_interval_invalid');
  const { createClient } = require('@libsql/client');
  const { DatabaseService } = require('../dist/db/DatabaseService');
  const { PredictionService } = require('../dist/services/PredictionService');
  const { drainModelAProspective, stopModelAProspectiveRecovery, closeModelAProspectiveAdmission } = require('../dist/research/ModelAProspectiveRecorder');
  const { refreshModelAProspectiveResults, createModelAProspectiveResultRefreshSink } = require('../dist/research/ModelAProspectiveResultRefresh');
  const client = createClient({ url: env.TURSO_DATABASE_URL.trim(), authToken: env.TURSO_AUTH_TOKEN.trim() });
  let db;
  let stopping = false, wake, deadlineTimer;
  let deadlineReject;
  const deadline = new Promise((_, reject) => { deadlineReject = reject; });
  const stop = () => { stopping = true; if (wake) wake(); if (!deadlineTimer) deadlineTimer = setTimeout(() => { closeModelAProspectiveAdmission(); deadlineReject(new Error('collection_shutdown_timeout')); }, 10000); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  try {
    db = new DatabaseService({ skipSchemaBootstrap: true });
    const collector = new ModelAProspectiveCollection(client, new PredictionService(db), scope, undefined, () => stopping, budgets);
    const resultSink = createModelAProspectiveResultRefreshSink(client);
    do {
      const cycle = await Promise.race([collector.run(), deadline]);
      console.log(JSON.stringify({ enabled: true, ...cycle }));
      if (cycle.performance.alert) { console.error('collection_performance_budget_exceeded'); process.exitCode = 1; }
      if (!stopping && env.MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED === 'true') console.log(JSON.stringify({ resultRefresh: await Promise.race([refreshModelAProspectiveResults(resultSink, { env }), deadline]) }));
      if (!interval || stopping) break;
      await new Promise(resolve => { const timer = setTimeout(resolve, interval * 1000); wake = () => { clearTimeout(timer); resolve(); }; });
      wake = undefined;
    } while (!stopping);
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    stopModelAProspectiveRecovery(); closeModelAProspectiveAdmission();
    try { if (!(await drainModelAProspective(10000))) { console.error('collection_recorder_drain_incomplete'); process.exitCode = 1; } }
    finally { try { if (db) await db.close(); } finally { client.close(); } }
  }
}
if (require.main === module) main().catch(() => { console.error('collection_failed'); process.exitCode = 1; });
module.exports = { main };
