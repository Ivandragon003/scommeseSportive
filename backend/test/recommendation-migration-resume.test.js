const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService } = require('../dist/db/DatabaseService');

const migration = '023_research_recommendation_execution.sql';
const statement = 'ALTER TABLE research_bets ADD COLUMN execution_decision_id TEXT REFERENCES research_execution_decisions(id)';
const validColumn = { name: 'execution_decision_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 };
const validReference = { from: 'execution_decision_id', table: 'research_execution_decisions', to: 'id' };

function fixture(columns, references = []) {
  const service = Object.create(DatabaseService.prototype);
  const queries = [];
  service.execute = async (sql) => {
    queries.push(sql);
    if (sql === 'PRAGMA table_info(research_bets)') return { rows: columns };
    if (sql === 'PRAGMA foreign_key_list(research_bets)') return { rows: references };
    throw new Error('Unexpected SQL in migration-resume check');
  };
  return { service, queries };
}

test('first application still executes ADD COLUMN; only the exact interrupted migration can skip it', async () => {
  const f = fixture([]);
  assert.equal(await f.service.recommendationColumnAlreadyApplied(migration, statement), false);
  assert.deepEqual(f.queries, ['PRAGMA table_info(research_bets)']);
  f.queries.length = 0;
  assert.equal(await f.service.recommendationColumnAlreadyApplied('022_other.sql', statement), false);
  assert.equal(await f.service.recommendationColumnAlreadyApplied(migration, 'CREATE TABLE unrelated(id TEXT)'), false);
  assert.deepEqual(f.queries, []);
});

test('resume accepts the existing nullable TEXT foreign key without issuing a write', async () => {
  const f = fixture([validColumn], [validReference]);
  assert.equal(await f.service.recommendationColumnAlreadyApplied(migration, statement), true);
  assert.equal(f.queries.length, 2);
  assert.ok(f.queries.every((sql) => sql.startsWith('PRAGMA ')));
});

test('resume refuses incompatible column shape instead of silently acknowledging it', async () => {
  for (const change of [{ type: 'INTEGER' }, { notnull: 1 }, { dflt_value: "'unknown'" }, { pk: 1 }]) {
    const f = fixture([{ ...validColumn, ...change }], [validReference]);
    await assert.rejects(f.service.recommendationColumnAlreadyApplied(migration, statement), /does not match migration 023/);
  }
});

test('resume refuses missing, duplicated or incorrect references', async () => {
  for (const references of [[], [validReference, validReference], [{ ...validReference, table: 'research_decisions' }],
    [{ ...validReference, to: 'origin_decision_id' }]]) {
    const f = fixture([validColumn], references);
    await assert.rejects(f.service.recommendationColumnAlreadyApplied(migration, statement), /does not match migration 023/);
  }
});
