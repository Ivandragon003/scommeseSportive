const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { DatabaseService } = require('../dist/db/DatabaseService');

test('wallet history reads all recorded sessions for its owner with only matching recorded classifications', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute('CREATE TABLE bets(bet_id TEXT, user_id TEXT, budget_session_id TEXT, placed_at TEXT, stake REAL, profit REAL)');
    await client.execute('CREATE TABLE automated_bet_decisions(decision_id TEXT, bet_id TEXT, user_id TEXT, decision_status TEXT, confidence TEXT, exclusion_reason TEXT, created_at TEXT)');
    await client.execute("INSERT INTO bets VALUES ('old','owner','closed-session','2026-10-01',10,5),('new','owner','current-session','2026-11-01',20,-20),('unknown','owner','closed-session','2026-10-02',5,0),('other','someone-else','session','2026-10-01',100,100)");
    await client.execute("INSERT INTO automated_bet_decisions VALUES ('old-decision','old','owner','placed','MEDIUM',NULL,'2026-10-01'),('new-decision','new','owner','placed','HIGH','speculative_saved_only','2026-11-01'),('wrong-owner','unknown','someone-else','placed','HIGH',NULL,'2026-11-01')");
    const before = await client.execute('SELECT * FROM bets ORDER BY bet_id');
    const reader = { all: async (sql, args) => (await client.execute({ sql, args })).rows };
    const rows = await DatabaseService.prototype.getBetHistory.call(reader, 'owner');
    assert.equal(rows.length, 3);
    assert.equal(rows.find(row => row.bet_id === 'old').classification, 'MEDIUM');
    assert.equal(rows.find(row => row.bet_id === 'new').classification, 'SPECULATIVE');
    assert.equal(rows.find(row => row.bet_id === 'unknown').classification, null);
    await client.execute('CREATE TABLE budgets(user_id TEXT, active_session_id TEXT)');
    await client.execute("INSERT INTO budgets VALUES ('owner','current-session')");
    reader.getBetHistory = (userId, options) => DatabaseService.prototype.getBetHistory.call(reader, userId, options);
    const active = await DatabaseService.prototype.getBets.call(reader, 'owner');
    assert.deepEqual(active.map(row => [row.bet_id, row.classification]), [['new', 'SPECULATIVE']]);
    assert.deepEqual((await client.execute('SELECT * FROM bets ORDER BY bet_id')).rows, before.rows);
  } finally { client.close(); }
});


test('migration stores deterministic A identity while preserving amounts and outcomes', async () => {
  const {readFileSync}=require('node:fs'); const {join}=require('node:path');
  const client=createClient({url:'file::memory:'});
  try {
    await client.execute('CREATE TABLE bets(bet_id TEXT PRIMARY KEY, stake REAL, profit REAL, status TEXT)');
    await client.execute("INSERT INTO bets VALUES('old',10,5,'WON')");
    await client.execute(readFileSync(join(__dirname,'../migrations/027_deterministic_bet_model.sql'),'utf8'));
    const rows=(await client.execute('SELECT * FROM bets')).rows;
    assert.equal(rows[0].model_family,'A');assert.equal(rows[0].stake,10);assert.equal(rows[0].profit,5);assert.equal(rows[0].status,'WON');
    await assert.rejects(client.execute("UPDATE bets SET model_family='C'"));
  } finally {client.close();}
});
