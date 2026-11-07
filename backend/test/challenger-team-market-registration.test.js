const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { mkdtempSync } = require('node:fs');
const { rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { inspect, apply } = require('../scripts/enable-challenger-team-markets');
const { CURRENT_CHALLENGER_RELEASE } = require('../dist/research/CurrentChallengerRelease');

test('registry plan inserts only missing markets and preserves suspended states', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'team-market-test-'));
  const client = createClient({ url: 'file:' + join(dir, 'test.db') });
  try {
    await client.execute('CREATE TABLE research_models(family TEXT,version TEXT,artifact_hash TEXT)');
    await client.execute('CREATE TABLE research_markets(family TEXT,model_version TEXT,market TEXT,state TEXT,evidence_json TEXT,updated_at TEXT,PRIMARY KEY(family,model_version,market))');
    await client.execute('CREATE TABLE research_market_events(id TEXT PRIMARY KEY,family TEXT,model_version TEXT,market TEXT,previous_state TEXT,state TEXT,evidence_json TEXT,reason TEXT,created_at TEXT)');
    await client.execute({ sql: "INSERT INTO research_models VALUES('C',?,?)", args: [CURRENT_CHALLENGER_RELEASE.modelVersion, CURRENT_CHALLENGER_RELEASE.artifactHash] });
    await client.execute({ sql: "INSERT INTO research_markets VALUES('C',?,'shots','SUSPENDED','{}','2026-01-01')", args: [CURRENT_CHALLENGER_RELEASE.modelVersion] });
    const plan = await inspect(client, 'test.invalid');
    assert.equal(plan.missing.includes('shots'), false);
    await apply(client, plan);
    const state = (await client.execute("SELECT state FROM research_markets WHERE market='shots'")).rows[0].state;
    assert.equal(state, 'SUSPENDED');
    const eventCount = Number((await client.execute('SELECT COUNT(*) AS n FROM research_market_events')).rows[0].n);
    assert.equal(eventCount, plan.missing.length);
    await assert.rejects(apply(client, plan), /plan_changed/);
  } finally { client.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
