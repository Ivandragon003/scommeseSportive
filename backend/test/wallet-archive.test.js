const test = require('node:test'); const assert = require('node:assert/strict');
const {buildWalletArchive,parseArchiveQuery}=require('../dist/services/WalletArchiveService');
const now=new Date('2026-11-03T12:00:00Z');
const historical=(id,extra={})=>({bet_id:id,user_id:'owner',model_family:'A',match_id:id,home_team_name:'Home',away_team_name:'Away',market_name:'1x2',selection:'homeWin',odds:3,stake:10,profit:20,status:'WON',placed_at:'2026-10-29T10:00:00Z',match_date:'2026-10-31T23:30:00Z',classification:'HIGH',...extra});
const store=(history,research=[])=>({getBetHistory:async user=>{assert.equal(user,'owner');return history;},research:{listBetViews:async()=>research}});
test('server aggregates the complete database set before pagination and excludes pending stakes',async()=>{
 const history=Array.from({length:550},(_,i)=>historical(String(i)));
 history.push(historical('pending',{status:'PENDING',profit:null,stake:999}));
 const result=await buildWalletArchive(store(history),'owner',parseArchiveQuery({limit:'2'}),now);
 assert.equal(result.rows.length,2);assert.equal(result.total,551);assert.equal(result.summary.netCents,1100000);assert.equal(result.summary.open,1);assert.equal(result.summary.settled,550);
 assert.equal(result.byClassification.find(r=>r.quality==='HIGH').total,551);
});
test('model A includes every recorded deterministic bet and Rome dates and quality filters are authoritative',async()=>{
 const history=[historical('old'),historical('unknown',{classification:null,match_date:'2026-10-20T10:00:00Z'})];
 const result=await buildWalletArchive(store(history),'owner',parseArchiveQuery({model:'A',from:'2026-11-01',to:'2026-11-01',qualities:'HIGH'}),now);
 assert.equal(result.total,1);assert.equal(result.rows[0].family,'A');assert.equal(result.summary.netCents,2000);
 const none=await buildWalletArchive(store(history),'owner',parseArchiveQuery({qualities:'LOW'}),now);assert.equal(none.total,0);
});
test('unknown models and incomplete economic data never become invented results',async()=>{
 await assert.rejects(buildWalletArchive(store([historical('bad',{model_family:null})]),'owner',parseArchiveQuery({}),now),/model identity/);
 const result=await buildWalletArchive(store([historical('unknown',{classification:null,profit:null})]),'owner',parseArchiveQuery({}),now);
 assert.equal(result.summary.netCents,null);assert.equal(result.byClassification.find(r=>r.quality==='UNKNOWN').total,1);
 for(const query of [{model:'X'},{from:'2026-02-31'},{from:'2026-11-02',to:'2026-11-01'},{qualities:'made_up'},{limit:'0'}])assert.throws(()=>parseArchiveQuery(query),/Invalid archive/);
});
