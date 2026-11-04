const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createClient } = require('@libsql/client');
const { recordModelAVerifiedResult, reconcileModelAProspectiveResults } = require('../dist/research/ModelAProspectiveResults');
const { DatabaseService } = require('../dist/db/DatabaseService');

test('only verified final evidence links immutable predictions, with idempotent events and corrections', async t => {
  const db = createClient({ url: 'file::memory:' }); t.after(() => db.close());
  await db.executeMultiple(fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8'));
  const sink = { appendModelAProspectiveResult: event => DatabaseService.prototype.appendModelAProspectiveResult.call({ execute: (sql, args) => db.execute({ sql, args }) }, event) };
  const now = Date.now(), iso = delta => new Date(now + delta).toISOString();
  const kickoff = iso(-3 * 3600000);
  const row = { match_id: 'understat_42', source: 'understat', source_match_id: '42', date: kickoff, home_goals: 2, away_goals: 1,
    raw_json: JSON.stringify({ match: { id: '42', isResult: true, goals: { h: '2', a: '1' } },
      resultObservation: { source: 'understat', observedAt: iso(-3600000) } }) };
  const insert = (id, match, forecast, date) => db.execute({ sql: 'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)',
    args: [id, match, forecast, date, '{"origin":"direct_a"}'] });
  await insert('b', row.match_id, iso(-9*3600000), kickoff);
  await insert('a', row.match_id, iso(-9*3600000), kickoff);
  await insert('c', row.match_id, iso(-8*3600000), kickoff);
  await db.execute({sql:'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)',
    args:['internal-earlier',row.match_id,iso(-10*3600000),kickoff,'{"origin":"internal"}']});
  assert.equal((await recordModelAVerifiedResult(sink, row)).status, 'recorded');
  assert.equal((await recordModelAVerifiedResult(sink, row)).status, 'duplicate');
  assert.equal((await recordModelAVerifiedResult(sink, { ...row, raw_json: null })).status, 'unverified');
  assert.equal((await recordModelAVerifiedResult(sink, { ...row, home_goals: 3 })).status, 'unverified');
  const future = JSON.parse(row.raw_json); future.resultObservation.observedAt = iso(3600000);
  assert.equal((await recordModelAVerifiedResult(sink, { ...row, raw_json: JSON.stringify(future) })).status, 'unverified');
  assert.equal((await recordModelAVerifiedResult(sink, { ...row, source_match_id: '99' })).status, 'unverified');
  const pending = JSON.parse(row.raw_json); pending.match.status = 'suspended';
  assert.equal((await recordModelAVerifiedResult(sink, { ...row, raw_json: JSON.stringify(pending) })).status, 'suspended');
  pending.match.status = 'postponed'; assert.equal((await recordModelAVerifiedResult(sink, { ...row, raw_json: JSON.stringify(pending) })).status, 'postponed');
  pending.match.status = 'cancelled'; assert.equal((await recordModelAVerifiedResult(sink, { ...row, raw_json: JSON.stringify(pending) })).status, 'cancelled');
  const correction = JSON.parse(row.raw_json); correction.match.goals.h = '3'; correction.resultObservation.observedAt = iso(-1800000);
  assert.equal((await recordModelAVerifiedResult(sink, { ...row, home_goals: 3, raw_json: JSON.stringify(correction) })).status, 'recorded');
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM model_a_prospective_results')).rows[0].n, 2);
  await assert.rejects(db.execute('UPDATE model_a_prospective_results SET home_goals=9'), /append-only/);
  const sql = fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/paired-results.sql'), 'utf8');
  const paired = await db.execute({ sql, args: { cutoff: iso(3600000), origin: 'direct_a' } });
  assert.equal(paired.rows.length, 1); assert.equal(paired.rows[0].id, 'a'); assert.equal(paired.rows[0].home_goals, 3);
  assert.equal((await db.execute('SELECT COUNT(*) AS n FROM model_a_prospective_forecasts')).rows[0].n, 4);
});
test('reconciliation associates only matching fixture evidence and accepts later score corrections', async t => {
  const db=createClient({url:'file::memory:'});t.after(()=>db.close());
  await db.executeMultiple(fs.readFileSync(path.join(__dirname,'../experiments/model-a-prospective/schema.sql'),'utf8'));
  await db.execute('CREATE TABLE matches(match_id TEXT, source TEXT, source_match_id TEXT, date TEXT, home_team_id TEXT, away_team_id TEXT, competition TEXT, season TEXT, home_goals INTEGER, away_goals INTEGER, raw_json TEXT)');
  const now=Date.now(),iso=delta=>new Date(now+delta).toISOString(),kickoff=iso(-3*3600000);
  const raw=JSON.stringify({id:'42',isResult:true,goals:{h:'2',a:'1'},resultObservation:{source:'understat',observedAt:iso(-3600000)}});
  await db.execute({sql:'INSERT INTO matches VALUES (?,?,?,?,?,?,?,?,?,?,?)',args:['understat_42','understat','42',kickoff,'h','a','Serie A','2026/27',2,1,raw]});
  const payload=JSON.stringify({homeTeamId:'h',awayTeamId:'a',competition:'Serie A',season:'2026/27'});
  await db.execute({sql:'INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)',args:['forecast','understat_42',iso(-9*3600000),kickoff,payload]});
  const wrapper={execute:(sql,args)=>db.execute({sql,args}),all:async(sql,args)=>(await db.execute({sql,args})).rows};
  const sink={getModelAProspectiveResultCandidates:()=>DatabaseService.prototype.getModelAProspectiveResultCandidates.call(wrapper),
    appendModelAProspectiveResult:e=>DatabaseService.prototype.appendModelAProspectiveResult.call(wrapper,e)};
  await reconcileModelAProspectiveResults(sink); await reconcileModelAProspectiveResults(sink);
  assert.equal((await db.execute('SELECT count(*) n FROM model_a_prospective_results')).rows[0].n,1);
  const corrected=JSON.stringify({id:'42',isResult:true,goals:{h:'3',a:'1'},resultObservation:{source:'understat',observedAt:iso(-1800000)}});
  await db.execute({sql:'UPDATE matches SET home_goals=3,raw_json=?',args:[corrected]});
  await reconcileModelAProspectiveResults(sink);
  assert.equal((await db.execute('SELECT count(*) n FROM model_a_prospective_results')).rows[0].n,2);
});
