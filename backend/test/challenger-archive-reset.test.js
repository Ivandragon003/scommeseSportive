'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { researchHash, scrubSharedInput, updateInputHashReferences } = require('../scripts/lib/challenger-archive-reset');
test('removes C evidence and preserves A, policy and audit hash', () => {
  const input = { forecasts: { A: { probability: 0.3 }, C: { probability: 0.7 } }, quoteSnapshots: { A: [1], C: [2] },
    prospectiveObservations: [{ family: 'A', p: 0.3 }, { family: 'C', p: 0.7 }], metadata: { policy: { familyC: { version: 1 } },
      technicalRecovery: { source: { C: 1 } }, challengerCollection: { results: [1] },
      sourceAdmission: { families: { A: true, C: false }, markets: { goal: { A: true, C: false } } } } };
  const old = researchHash(input), result = scrubSharedInput(input, old, 'old-decisions');
  assert.deepEqual(result.snapshot.forecasts, { A: input.forecasts.A });
  assert.deepEqual(result.snapshot.quoteSnapshots, { A: [1] });
  assert.deepEqual(result.snapshot.prospectiveObservations, [input.prospectiveObservations[0]]);
  assert.deepEqual(result.snapshot.metadata.policy, input.metadata.policy);
  assert.deepEqual(result.snapshot.metadata.sourceAdmission, { families: { A: true }, markets: { goal: { A: true } } });
  assert.equal(result.snapshot.metadata.technicalRecovery, undefined);
  assert.equal(result.snapshot.metadata.challengerCollection, undefined);
  assert.equal(result.snapshot.cHistoryReset.originalInputHash, old);
  assert.equal(researchHash(result.snapshot), result.inputHash);
  assert.equal(input.forecasts.C.probability, 0.7);
  assert.throws(() => scrubSharedInput(input, 'wrong'), /hash mismatch/);
});
test('updates only input hash references in A evidence', () => {
  const input = { inputHash: 'old', probability: 0.3, nested: { inputHash: 'old', unrelated: 'old' } };
  const result = updateInputHashReferences(input, { old: 'new' });
  assert.deepEqual(result.snapshot, { inputHash: 'new', probability: 0.3, nested: { inputHash: 'new', unrelated: 'old' } });
  assert.equal(result.changed, true);
  assert.equal(input.inputHash, 'old');
});

test('plans guarded changes and restores immutable triggers in a transaction', async () => {
  const { createClient } = require('@libsql/client');
  const { planSharedArchives, applySharedArchives, researchJson } = require('../scripts/lib/challenger-archive-reset');
  const db = createClient({ url: 'file::memory:' });
  const tx = await db.transaction('write');
  try {
    await tx.execute('CREATE TABLE research_inputs(id TEXT PRIMARY KEY,input_hash TEXT,snapshot_json TEXT)');
    await tx.execute('CREATE TABLE research_execution_inputs(id TEXT PRIMARY KEY,input_hash TEXT,decisions_hash TEXT,snapshot_json TEXT)');
    await tx.execute('CREATE TABLE research_decisions(id TEXT PRIMARY KEY,family TEXT,snapshot_json TEXT)');
    await tx.execute("CREATE TRIGGER input_guard BEFORE UPDATE ON research_inputs BEGIN SELECT RAISE(ABORT,'immutable'); END");
    const input = { forecasts: { A: { probability: 0.2 }, C: { probability: 0.8 } }, prospectiveObservations: [{family:'A'}, {family:'C'}] };
    const old = researchHash(input);
    await tx.execute({ sql: 'INSERT INTO research_inputs VALUES (?,?,?)', args: ['i', old, researchJson(input)] });
    await tx.execute({ sql: 'INSERT INTO research_decisions VALUES (?,?,?)', args: ['a','A',researchJson({inputHash:old,probability:0.2})] });
    const plan = await planSharedArchives(tx);
    await applySharedArchives(tx, plan);
    const row = (await tx.execute('SELECT * FROM research_inputs')).rows[0];
    const decision = JSON.parse((await tx.execute('SELECT snapshot_json FROM research_decisions')).rows[0].snapshot_json);
    assert.equal(researchHash(JSON.parse(row.snapshot_json)), row.input_hash);
    assert.equal(decision.inputHash, row.input_hash);
    assert.equal(decision.probability, 0.2);
    assert.deepEqual(JSON.parse(row.snapshot_json).forecasts, { A: { probability: 0.2 } });
    await assert.rejects(tx.execute("UPDATE research_inputs SET input_hash='wrong'"), /immutable/);
    await assert.rejects(applySharedArchives(tx, plan), /Archive changed/);
  } finally { await tx.rollback(); db.close(); }
});

test('a stale row in a later batch is fully undone by caller rollback', async () => {
  const { createClient } = require('@libsql/client');
  const { planSharedArchives, applySharedArchives, researchJson } = require('../scripts/lib/challenger-archive-reset');
  const db = createClient({ url: 'file::memory:' });
  const tx = await db.transaction('write');
  try {
    await tx.execute('CREATE TABLE research_inputs(id TEXT PRIMARY KEY,input_hash TEXT,snapshot_json TEXT)');
    await tx.execute('CREATE TABLE research_execution_inputs(id TEXT PRIMARY KEY,input_hash TEXT,decisions_hash TEXT,snapshot_json TEXT)');
    await tx.execute('CREATE TABLE research_decisions(id TEXT PRIMARY KEY,family TEXT,snapshot_json TEXT)');
    await tx.execute("CREATE TRIGGER input_guard BEFORE UPDATE ON research_inputs BEGIN SELECT RAISE(ABORT,'immutable'); END");
    const original = { forecasts: { A: { probability: 0.2 }, C: { probability: 0.8 } } };
    const oldHash = researchHash(original);
    await tx.execute({sql:'INSERT INTO research_inputs VALUES (?,?,?)',args:['i',oldHash,researchJson(original)]});
    for (let i=0;i<51;i++) await tx.execute({sql:'INSERT INTO research_decisions VALUES (?,?,?)',args:[String(i),'A',researchJson({inputHash:oldHash, probability:i})]});
    const plan = await planSharedArchives(tx);
    await tx.execute({sql:'UPDATE research_decisions SET snapshot_json=? WHERE id=?',args:['{"changed":true}','50']});
    await tx.execute('SAVEPOINT before_apply');
    await assert.rejects(applySharedArchives(tx, plan), /Archive changed: research_decisions\/50/);
    assert.notEqual((await tx.execute('SELECT input_hash FROM research_inputs')).rows[0].input_hash, oldHash);
    await tx.execute('ROLLBACK TO before_apply');
    assert.equal((await tx.execute('SELECT input_hash FROM research_inputs')).rows[0].input_hash, oldHash);
    assert.equal(JSON.parse((await tx.execute("SELECT snapshot_json FROM research_decisions WHERE id='0'")).rows[0].snapshot_json).inputHash,oldHash);
    await assert.rejects(tx.execute("UPDATE research_inputs SET input_hash='wrong'"), /immutable/);
  } finally { await tx.rollback(); db.close(); }
});
