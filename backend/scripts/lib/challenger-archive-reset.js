'use strict';

const { createHash } = require('node:crypto');

// Keep this encoding aligned with researchJson in ResearchStore.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}
const researchJson = value => JSON.stringify(canonical(value));
const researchHash = value => createHash('sha256').update(researchJson(value)).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));

function removeAdmissionC(admission) {
  if (!admission || typeof admission !== 'object') return;
  if (admission.families) delete admission.families.C;
  for (const market of Object.values(admission.markets || {})) {
    if (market && typeof market === 'object') delete market.C;
  }
}

function scrubContainer(container) {
  if (!container || typeof container !== 'object') return;
  delete container.challengerCollection;
  delete container.technicalRecovery;
  removeAdmissionC(container.sourceAdmission);
  if (Array.isArray(container.prospectiveObservations)) {
    container.prospectiveObservations = container.prospectiveObservations.filter(item => item.family !== 'C');
  }
  if (container.forecasts) delete container.forecasts.C;
  if (container.quoteSnapshots) delete container.quoteSnapshots.C;
}

/** Pure transformation; callers must guard against replay and update all dependent hashes atomically. */
function scrubSharedInput(snapshot, oldHash, oldDecisionsHash = null) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid snapshot');
  if (researchHash(snapshot) !== oldHash) throw new Error('Original input hash mismatch');
  const result = clone(snapshot);
  if (result.cHistoryReset) throw new Error('Snapshot already migrated');
  scrubContainer(result);
  scrubContainer(result.metadata);
  result.cHistoryReset = { protocol: 'c-history-reset-v1', originalInputHash: oldHash,
    ...(oldDecisionsHash ? { originalDecisionsHash: oldDecisionsHash } : {}), replayable: false };
  return { snapshot: result, snapshotJson: researchJson(result), inputHash: researchHash(result) };
}

/** Replace only references, leaving predictions, stakes and all other evidence unchanged. */
function updateInputHashReferences(snapshot, hashMap) {
  const result = clone(snapshot);
  let changed = false;
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(visit);
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'inputHash' && typeof entry === 'string' && hashMap[entry]) {
        value[key] = hashMap[entry]; changed = true;
      } else visit(entry);
    }
  }
  visit(result);
  return { snapshot: result, snapshotJson: researchJson(result), changed };
}

module.exports = { researchHash, researchJson, scrubSharedInput, updateInputHashReferences };

const INPUT_TABLES = ['research_inputs', 'research_execution_inputs'];
const REFERENCE_TABLES = ['research_decisions', 'research_execution_decisions', 'research_bets',
  'research_prospective_observations', 'paper_model_bets', 'funded_model_bets', 'dynamic_model_bets'];
const quoteIdentifier = name => '"' + name.replace(/"/g, '""') + '"';

/** Build a read-only plan. Do not print the plan: it contains retained A evidence. */
async function planSharedArchives(db) {
  const tableRows = await db.execute("SELECT name FROM sqlite_master WHERE type='table'");
  const tables = new Set(tableRows.rows.map(row => row.name));
  for (const name of INPUT_TABLES) if (!tables.has(name)) throw new Error(`Missing table: ${name}`);
  const updates = [];
  const hashMap = Object.create(null);
  for (const table of INPUT_TABLES) {
    const rows = (await db.execute(`SELECT id,input_hash,snapshot_json${table === 'research_execution_inputs' ? ',decisions_hash' : ''} FROM ${quoteIdentifier(table)}`)).rows;
    for (const row of rows) {
      const scrubbed = scrubSharedInput(JSON.parse(row.snapshot_json), row.input_hash, row.decisions_hash || null);
      if (hashMap[row.input_hash] && hashMap[row.input_hash] !== scrubbed.inputHash) throw new Error('Ambiguous input hash mapping');
      hashMap[row.input_hash] = scrubbed.inputHash;
      updates.push({ table, id: row.id, oldSnapshot: row.snapshot_json, newSnapshot: scrubbed.snapshotJson,
        oldHash: row.input_hash, newHash: scrubbed.inputHash, oldDecisionsHash: row.decisions_hash || null });
    }
  }
  for (const table of REFERENCE_TABLES) {
    if (!tables.has(table)) continue;
    const rows = (await db.execute(`SELECT id,snapshot_json FROM ${quoteIdentifier(table)} WHERE family='A'`)).rows;
    for (const row of rows) {
      const original = JSON.parse(row.snapshot_json);
      const changed = updateInputHashReferences(original, hashMap);
      if (!changed.changed) continue;
      // Reversing the mapping proves that no A evidence except input references changed.
      const reverse = Object.fromEntries(Object.entries(hashMap).map(([before, after]) => [after, before]));
      if (researchHash(updateInputHashReferences(changed.snapshot, reverse).snapshot) !== researchHash(original)) {
        throw new Error(`A evidence changed: ${table}/${row.id}`);
      }
      updates.push({ table, id: row.id, oldSnapshot: row.snapshot_json, newSnapshot: changed.snapshotJson });
    }
  }
  const changedTables = new Set(updates.map(update => update.table));
  const triggers = (await db.execute("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL")).rows
    .filter(row => changedTables.has(row.tbl_name) && /\bBEFORE\s+UPDATE\b/i.test(row.sql))
    .map(row => ({ name: row.name, table: row.tbl_name, sql: row.sql }));
  return { version: 'c-shared-archive-reset-v1', updates, triggers };
}

/** Caller owns the transaction and must roll it back on any exception. */
async function applySharedArchives(tx, plan) {
  if (plan?.version !== 'c-shared-archive-reset-v1') throw new Error('Invalid archive plan');
  for (const trigger of plan.triggers) {
    const row = (await tx.execute({ sql: "SELECT tbl_name,sql FROM sqlite_master WHERE type='trigger' AND name=?", args: [trigger.name] })).rows[0];
    if (!row || row.tbl_name !== trigger.table || row.sql !== trigger.sql) throw new Error(`Trigger changed: ${trigger.name}`);
    await tx.execute(`DROP TRIGGER ${quoteIdentifier(trigger.name)}`);
  }
  const statements = plan.updates.map(update => {
    if (![...INPUT_TABLES, ...REFERENCE_TABLES].includes(update.table)) throw new Error('Unexpected table');
    const input = INPUT_TABLES.includes(update.table);
    let sql = `UPDATE ${quoteIdentifier(update.table)} SET snapshot_json=?${input ? ',input_hash=?' : ''} WHERE id=? AND snapshot_json=?`;
    const args = [update.newSnapshot, ...(input ? [update.newHash] : []), update.id, update.oldSnapshot];
    if (input) { sql += ' AND input_hash=?'; args.push(update.oldHash); }
    if (update.table === 'research_execution_inputs') { sql += ' AND decisions_hash=?'; args.push(update.oldDecisionsHash); }
    return { sql, args };
  });
  for (let offset = 0; offset < statements.length; offset += 50) {
    const chunk = statements.slice(offset, offset + 50);
    const results = await tx.batch(chunk);
    if (results.length !== chunk.length) throw new Error('Incomplete archive batch result');
    for (let i = 0; i < results.length; i++) {
      if (results[i].rowsAffected !== 1) {
        const update = plan.updates[offset + i];
        throw new Error(`Archive changed: ${update.table}/${update.id}`);
      }
    }
  }
  for (const trigger of plan.triggers) await tx.execute(trigger.sql);
  return { updated: plan.updates.length };
}
module.exports.planSharedArchives = planSharedArchives;
module.exports.applySharedArchives = applySharedArchives;
