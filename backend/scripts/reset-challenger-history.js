/* Maintenance primitive for the C operational history. The caller must supply an
 * exclusive, verified backup and reviewed plan; shared archives are separate. */
const { createHash } = require('node:crypto');
const { preflight } = require('./backup-turso');
const { researchHash } = require('./lib/challenger-archive-reset');
const sha = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const tables = [
  'research_bet_cancellations','research_ledger','research_settlements','research_bets',
  'research_decisions','research_execution_decisions','research_prospective_observations',
  'research_prospective_results','research_prospective_invalidations','manual_model_archives',
  'manual_model_bets','manual_model_settlements','paper_model_bets','paper_model_settlements',
  'paper_model_bet_cancellations','funded_model_bets','funded_model_settlements',
  'funded_model_bet_cancellations','dynamic_model_bets','dynamic_model_settlements',
  'challenger_paired_forecasts','challenger_forecast_results'
];
const children = [
  ['research_settlements','research_bets','bet_id'],
  ['paper_model_settlements','paper_model_bets','bet_id'],
  ['paper_model_bet_cancellations','paper_model_bets','bet_id'],
  ['funded_model_settlements','funded_model_bets','bet_id'],
  ['funded_model_bet_cancellations','funded_model_bets','bet_id'],
  ['dynamic_model_settlements','dynamic_model_bets','bet_id'],
  ['manual_model_settlements','manual_model_bets','bet_id'],
  ['research_prospective_results','research_prospective_observations','observation_id'],
  ['research_prospective_invalidations','research_prospective_observations','observation_id']
];
const familyTables = ['research_bets','paper_model_bets','funded_model_bets','dynamic_model_bets',
  'manual_model_bets','manual_model_archives','research_prospective_observations',
  'research_execution_decisions','research_decisions'];
const preservedTables = ['research_inputs','research_execution_inputs','research_jobs','research_execution_jobs',
  'research_models','research_markets','research_portfolios','research_execution_policies',
  'challenger_candidates','challenger_candidate_reviews','challenger_adoption_events'];
function normalize(value) {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  return value;
}
async function rows(db, sql, args = []) {
  return (await db.execute({ sql, args })).rows.map(row => Object.fromEntries(Object.entries(row).map(([k,v]) => [k,normalize(v)])));
}
async function tableHash(db, table, where = '1') {
  const data = await rows(db, `SELECT * FROM ${table} WHERE ${where}`);
  const fingerprints = data.map(row => sha(row)).sort();
  return { count: data.length, sha256: sha(fingerprints) };
}
async function inspectOperational(db) {
  const schema = await preflight(db), targets = {}, preserved = {};
  for (const table of tables) targets[table] = await tableHash(db, table);
  for (const table of familyTables) preserved[table] = await tableHash(db, table, "family<>'C'");
  for (const [child,parent,key] of children) preserved[child] = await tableHash(db, child,
    `${key} NOT IN (SELECT id FROM ${parent} WHERE family='C')`);
  preserved.research_ledger = await tableHash(db, 'research_ledger', "portfolio_id<>'shadow_C'");
  preserved.research_bet_cancellations = await tableHash(db, 'research_bet_cancellations', "json_extract(bet_json,'$.family')<>'C'");
  for (const table of preservedTables) preserved[table] = await tableHash(db, table);
  const invalid = await rows(db, `SELECT COUNT(*) AS count FROM research_bet_cancellations
    WHERE NOT json_valid(bet_json) OR COALESCE(json_extract(bet_json,'$.family'),'') NOT IN ('A','C')`);
  if (Number(invalid[0].count)) throw Error('unclassified_cancellation_archive');
  for (const table of ['challenger_candidate_reviews','challenger_adoption_events'])
    if (Number((await rows(db, `SELECT COUNT(*) AS count FROM ${table}`))[0].count)) throw Error('paired_forecasts_required_by_adoption_or_unknown_model');
  const paired = await rows(db, 'SELECT snapshot_json,snapshot_hash FROM challenger_paired_forecasts');
  for (const row of paired) {
    let snapshot; try { snapshot = JSON.parse(row.snapshot_json); } catch { throw Error('invalid_paired_forecast'); }
    if (researchHash(snapshot) !== row.snapshot_hash || !String(snapshot?.candidate?.modelVersion ?? '').startsWith('C-')
      || !String(snapshot?.reference?.modelVersion ?? '').startsWith('C-')) throw Error('invalid_paired_forecast');
  }
  const linked = await rows(db, `SELECT COUNT(*) AS count FROM challenger_paired_forecasts f
    LEFT JOIN challenger_candidates c ON c.id=f.candidate_id
    LEFT JOIN research_models m ON m.family='C' AND m.version=c.model_version
    WHERE c.id IS NULL OR m.version IS NULL
      OR json_extract(f.snapshot_json,'$.candidate.modelVersion')<>c.model_version
      OR NOT EXISTS (SELECT 1 FROM research_models ref WHERE ref.family='C' AND ref.version=json_extract(f.snapshot_json,'$.reference.modelVersion'))
      OR EXISTS (SELECT 1 FROM challenger_candidate_reviews r WHERE r.candidate_id=c.id)
      OR EXISTS (SELECT 1 FROM challenger_adoption_events e WHERE e.candidate_id=c.id)`);
  if (Number(linked[0].count)) throw Error('paired_forecasts_required_by_adoption_or_unknown_model');
  const guards = await rows(db, `SELECT name,sql FROM sqlite_master WHERE type='trigger'
    AND lower(sql) LIKE '%before delete%' AND tbl_name IN (${tables.map(() => '?').join(',')}) ORDER BY name`, tables);
  const badLinks = [
    "SELECT COUNT(*) AS n FROM research_execution_decisions d JOIN research_decisions o ON d.origin_decision_id=o.id WHERE d.family<>o.family",
    ...['research_bets','paper_model_bets','funded_model_bets','dynamic_model_bets'].map(t =>
      `SELECT COUNT(*) AS n FROM ${t} b JOIN research_execution_decisions d ON b.execution_decision_id=d.id WHERE b.family<>d.family`),
    "SELECT COUNT(*) AS n FROM research_bets b JOIN research_decisions d ON b.decision_id=d.id WHERE b.family<>d.family",
    "SELECT COUNT(*) AS n FROM research_ledger l JOIN research_bets b ON l.bet_id=b.id WHERE l.portfolio_id<>'shadow_'||b.family"
  ];
  for (const sql of badLinks) if (Number((await rows(db, sql))[0].n)) throw Error('cross_family_reference');
  if ((await rows(db, 'PRAGMA foreign_key_check')).length) throw Error('foreign_key_violation_before');
  return { schemaHash: schema.schemaSha256, targets, preserved, guards };
}
async function resetOperational(tx, expected, openedAt) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(openedAt) || !Number.isFinite(Date.parse(openedAt))) throw Error('invalid_epoch');
  if (sha(await inspectOperational(tx)) !== sha(expected)) throw Error('operational_plan_changed');
  for (const guard of expected.guards) {
    if (!/^[a-zA-Z0-9_]+$/.test(guard.name) || !guard.sql) throw Error('invalid_trigger');
    await tx.execute(`DROP TRIGGER "${guard.name}"`);
  }
  await tx.execute('DELETE FROM challenger_forecast_results WHERE forecast_id IN (SELECT id FROM challenger_paired_forecasts)');
  await tx.execute('DELETE FROM challenger_paired_forecasts');
  for (const [child,parent,key] of children) await tx.execute(`DELETE FROM ${child} WHERE ${key} IN (SELECT id FROM ${parent} WHERE family='C')`);
  await tx.execute("DELETE FROM research_bet_cancellations WHERE json_extract(bet_json,'$.family')='C'");
  await tx.execute("DELETE FROM research_ledger WHERE portfolio_id='shadow_C'");
  for (const table of familyTables) await tx.execute(`DELETE FROM ${table} WHERE family='C'`);
  await tx.execute({sql: `INSERT INTO research_ledger(id,portfolio_id,bet_id,event,available_delta_cents,committed_delta_cents,created_at)
    VALUES('open:shadow_C','shadow_C',NULL,'OPEN',100000,0,?)`,args:[openedAt]});
  for (const guard of expected.guards) await tx.execute(guard.sql);
  const balance = await rows(tx, "SELECT SUM(available_delta_cents) AS available,SUM(committed_delta_cents) AS committed FROM research_ledger WHERE portfolio_id='shadow_C'");
  if (Number(balance[0].available)!==100000 || Number(balance[0].committed)!==0) throw Error('balance_mismatch');
  if ((await rows(tx, 'PRAGMA foreign_key_check')).length) throw Error('foreign_key_violation_after');
  const after = await inspectOperational(tx);
  for (const [table, fingerprint] of Object.entries(expected.preserved))
    if (sha(after.preserved[table]) !== sha(fingerprint)) throw Error(`protected_data_changed:${table}`);
  if (sha(after.guards) !== sha(expected.guards) || after.schemaHash !== expected.schemaHash) throw Error('schema_changed');
}
module.exports = { inspectOperational, resetOperational, sha };
