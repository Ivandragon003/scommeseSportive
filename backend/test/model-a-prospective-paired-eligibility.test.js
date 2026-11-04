const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const directory = path.join(__dirname, '../experiments/model-a-prospective');
const strictSql = fs.readFileSync(path.join(directory, 'paired-results.sql'), 'utf8');
const technicalSql = fs.readFileSync(path.join(directory, 'technical-paired-results.sql'), 'utf8');
const kickoff = '2026-10-01T15:00:00.000Z';
const forecastAt = '2026-10-01T10:00:00.000Z';
function payload(extra = {}) {
  return { origin: 'direct_a', inputAsOf: '2026-10-01T09:59:00.000Z',
    model: { codeHash: 'a'.repeat(64), configHash: 'b'.repeat(64), stateHash: 'c'.repeat(64) },
    provenance: { rigorousEligible: true, classification: 'verified', inputAvailableThrough: '2026-10-01T09:58:00.000Z', inputSnapshotHash: 'd'.repeat(64) }, ...extra };
}
async function context(t) {
  const db = createClient({ url: 'file::memory:' }); t.after(() => db.close());
  await db.executeMultiple(fs.readFileSync(path.join(directory, 'schema.sql'), 'utf8'));
  const insert = (id, data, at = forecastAt, matchId = 'understat_42') => db.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)',
    args: [id, matchId, at, kickoff, JSON.stringify(data)] });
  const run = (sql = strictSql, origin = 'direct_a', protocolId = null) => db.execute({ sql, args: { cutoff: '2026-10-02T00:00:00Z', origin, protocol_id: protocolId } });
  return { db, insert, run };
}

test('strict export excludes technical-only records while technical export visibly denies temporal eligibility', async t => {
  const { insert, run } = await context(t);
  await insert('technical', payload({ provenance: { rigorousEligible: false, classification: 'technical_only', inputAvailableThrough: null, inputSnapshotHash: 'd'.repeat(64) } }));
  assert.equal((await run()).rows.length, 0);
  const rows = (await run(technicalSql)).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].temporal_eligible, 0); assert.match(rows[0].temporal_eligibility_reason, /does_not_establish/);
});

test('an unverified first forecast cannot be replaced by a later verified forecast', async t => {
  const { insert, run } = await context(t);
  await insert('first', payload({ provenance: { rigorousEligible: false, classification: 'technical_only' } }));
  await insert('second', payload(), '2026-10-01T11:00:00Z');
  assert.equal((await run()).rows.length, 0);
  assert.equal((await run(technicalSql)).rows[0].id, 'first');
});

test('strict eligibility requires true boolean, verified classification, available inputs and complete hashes', async t => {
  const { insert, run } = await context(t);
  const invalid = [
    { provenance: { ...payload().provenance, rigorousEligible: 'true' } },
    { provenance: { ...payload().provenance, classification: 'locally_observed' } },
    { provenance: { ...payload().provenance, inputAvailableThrough: null } },
    { provenance: { ...payload().provenance, inputAvailableThrough: '2026-10-01T10:01:00Z' } },
    { provenance: { ...payload().provenance, inputAvailableThrough: '2026-10-01T09:58:00' } },
    { provenance: { ...payload().provenance, inputSnapshotHash: 'unknown' } },
    { model: { ...payload().model, stateHash: null } },
    { inputAsOf: '2026-10-01T10:01:00Z' },
    { inputAsOf: '2026-10-01T09:59:00' }
  ];
  for (let i = 0; i < invalid.length; i++) await insert(`invalid${i}`, payload(invalid[i]), forecastAt, `understat_${100 + i}`);
  await insert('verified', payload(), forecastAt, 'understat_999');
  const rows = (await run()).rows;
  assert.equal(rows.length, 1); assert.equal(rows[0].id, 'verified'); assert.equal(rows[0].temporal_eligible, 1);
});

test('both exports require the requested collection protocol and never mix other protocol cohorts', async t => {
  const { insert, run } = await context(t);
  await insert('protocol-one', payload({ origin: 'prospective_a', collection: { protocolId: 'one' } }));
  await insert('protocol-two', payload({ origin: 'prospective_a', collection: { protocolId: 'two' } }), forecastAt, 'understat_43');
  for (const sql of [strictSql, technicalSql]) {
    assert.equal((await run(sql, 'prospective_a', null)).rows.length, 0);
    assert.deepEqual((await run(sql, 'prospective_a', 'one')).rows.map(r => r.id), ['protocol-one']);
    assert.deepEqual((await run(sql, 'prospective_a', 'two')).rows.map(r => r.id), ['protocol-two']);
    assert.equal((await run(sql, 'direct_a', 'one')).rows.length, 0);
  }
});

test('missing/provider failures and a newer unwritten final conservatively withhold the previous score', async t => {
  const { db, insert, run } = await context(t);
  await insert('verified', payload());
  await db.execute({ sql: 'INSERT INTO model_a_prospective_results VALUES (?,?,?,?,?,?,?,?,?)',
    args: ['result', 'understat_42', 'understat', kickoff, '2026-10-01T17:00:00Z', '2026-10-01T17:01:00Z', 2, 1, '{}'] });
  assert.equal((await run()).rows[0].home_goals, 2);
  const statuses = ['missing', 'provider_error', 'not_final', 'final'];
  for (let i = 0; i < statuses.length; i++) {
    const observed = `2026-10-01T17:${String(10 + i).padStart(2, '0')}:00Z`;
    await db.execute({ sql: 'INSERT INTO model_a_prospective_result_observations VALUES (?,?,?,?,?,?,?,?,?)',
      args: [`observation-${i}`, 'understat_42', 'understat', kickoff, observed, observed, statuses[i], 'fixture', '{}'] });
    for (const sql of [strictSql, technicalSql]) assert.equal((await run(sql)).rows[0].home_goals, null);
  }
  assert.equal((await db.execute('SELECT home_goals FROM model_a_prospective_results')).rows[0].home_goals, 2);
});
