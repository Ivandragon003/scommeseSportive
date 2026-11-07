const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService } = require('../dist/db/DatabaseService');
const { assessFinalObservations } = require('../dist/services/FinalObservationLock');

test('only matching final source values are eligible and locked values survive imports', async () => {
  process.env.TURSO_DATABASE_URL = 'file::memory:';
  process.env.TURSO_AUTH_TOKEN = 'local';
  const db = new DatabaseService();
  const raw = { id: '123', isResult: true, h:{id:'1',title:'Home'},a:{id:'2',title:'Away'},datetime:'2026-11-01 12:00:00', goals: { h: '2', a: '0' }, xG: { h: '1.2', a: '0.4' } };
  const fixture = { matchId: 'understat_123', homeTeamId: 'h', awayTeamId: 'a',homeTeamName:'Home',awayTeamName:'Away', date: '2026-11-01T12:00:00Z', homeGoals: 2, awayGoals: 0, homeXG: 1.2, awayXG: 0.4, competition: 'Serie A', season: '2026/2027', source: 'understat', sourceMatchId: 123, rawJson: JSON.stringify(raw) };
  try {
    await db.initPromise;
    await db.db.execute("INSERT INTO teams(team_id,name,source_team_id) VALUES('h','Home',1),('a','Away',2)");
    await db.upsertMatch(fixture);
    const row = await db.getMatchById(fixture.matchId);
    const assessment = assessFinalObservations(row);
    assert.equal(assessment.observations.length, 4);
    assert.equal((await db.db.execute('SELECT * FROM final_observations')).rows.length, 4);
    await db.upsertMatch({ ...fixture, homeGoals: 4, awayGoals: 1, homeFouls: 7 });
    const updated = await db.getMatchById(fixture.matchId);
    assert.equal(updated.home_goals, 2); assert.equal(updated.away_goals, 0); assert.equal(updated.home_fouls, 7);
    const conflicts = await db.db.execute('SELECT field,existing_value,attempted_value FROM final_observation_conflicts');
    assert.equal(conflicts.rows.length, 2); assert.equal(conflicts.rows[0].field, 'home_goals');
    await assert.rejects(db.db.execute("UPDATE matches SET home_goals=5 WHERE match_id='understat_123'"), /final_observation_locked/);
    await assert.rejects(db.db.execute('DELETE FROM final_observations'), /final_observation_immutable/);
    const mismatch = assessFinalObservations({ ...row, home_goals: 3, home_xg: null });
    assert.equal(mismatch.reasons.home_goals, 'source_value_missing_or_mismatch');
    assert.equal(mismatch.reasons.home_xg, 'missing');
    assert.equal(assessFinalObservations({ ...row, raw_json: JSON.stringify({ ...raw, isResult: false }) }).observations.length, 0);
  } finally { db.db.close(); }
});


test('retention preserves a whole season with frozen observations and its linked records', async () => {
  const { pruneOldSeasons } = require('../dist/services/FootballDataService');
  const client = {
    async execute(query) {
      if (query.sql.includes('SELECT season FROM matches')) return { rows: [{season:'2021/2022'},{season:'2026/2027'}] };
      if (query.sql.includes('protected_season')) return { rows: [{protected_season:'2021/2022'}] };
      return { rows: [], rowsAffected: 0 };
    },
    async batch() { assert.fail('must not delete the protected season'); },
  };
  const summary = await pruneOldSeasons(client, 5, new Date('2026-11-07T10:00:00Z'));
  assert.deepEqual(summary.seasonsProtected, ['2021/2022']);
  assert.deepEqual(summary.seasonsDeleted, []);
});

test('local plan requires a verified backup and rejects changed source before applying', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { spawnSync } = require('node:child_process'); const { createHash } = require('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'observation-lock-'));
  const file = path.join(dir, 'target.db'), backup = path.join(dir, 'backup.db'), manifest = path.join(dir, 'manifest.json'), plan = path.join(dir, 'plan.json');
  process.env.TURSO_DATABASE_URL = `file:${file}`; process.env.TURSO_AUTH_TOKEN = 'local';
  const db = new DatabaseService();
  let closed = false;
  try {
    await db.initPromise;
    await db.db.execute("INSERT INTO teams(team_id,name,source_team_id) VALUES('h','Home',1),('a','Away',2)");
    await db.upsertMatch({ matchId:'understat_7',homeTeamId:'h',awayTeamId:'a',homeTeamName:'Home',awayTeamName:'Away',date:'2026-11-01T00:00:00Z',homeGoals:1,awayGoals:0,homeXG:1.3,awayXG:0.2,season:'2026/2027',source:'understat',sourceMatchId:7,rawJson:JSON.stringify({id:'7',isResult:false,h:{id:'1',title:'Home'},a:{id:'2',title:'Away'},datetime:'2026-11-01 00:00:00',goals:{h:'1',a:'0'},xG:{h:'1.3',a:'0.2'}}) });
    await db.db.execute({sql:'UPDATE matches SET raw_json=? WHERE match_id=?',args:[JSON.stringify({id:'7',isResult:true,h:{id:'1',title:'Home'},a:{id:'2',title:'Away'},datetime:'2026-11-01 00:00:00',goals:{h:'1',a:'0'},xG:{h:'1.3',a:'0.2'}}),'understat_7']});
    db.db.close(); closed = true;
    fs.copyFileSync(file, backup);
    const digest = createHash('sha256').update(fs.readFileSync(backup)).digest('hex');
    fs.writeFileSync(manifest, JSON.stringify({complete:true,verification:{readable:true,databaseSha256:digest}}));
    const run = (...args) => spawnSync(process.execPath, [path.join(__dirname,'../scripts/final-observations.js'),...args], {encoding:'utf8'});
    const prepared = run('plan',file,'2026/2027',plan); assert.equal(prepared.status,0,prepared.stderr);
    const planHash = JSON.parse(fs.readFileSync(plan)).planSha256;
    const rejected = run('apply',file,'2026/2027',plan,backup,manifest,'0'.repeat(64)); assert.notEqual(rejected.status,0);
    const applied = run('apply',file,'2026/2027',plan,backup,manifest,planHash); assert.equal(applied.status,0,applied.stderr);
    assert.equal(JSON.parse(applied.stdout).inserted,4);
    const repeated = run('apply',file,'2026/2027',plan,backup,manifest,planHash); assert.equal(repeated.status,0,repeated.stderr);
    assert.equal(JSON.parse(repeated.stdout).inserted,0);
  } finally {
    if (!closed) db.db.close();
    try { fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
    catch (error) { process.emitWarning(`Temporary test directory could not be removed: ${error.message}`); }
  }
});

test('CSV diagnostic requires unique fixture and matching score, and reports disagreements', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { spawnSync } = require('node:child_process'); const { createHash } = require('node:crypto');
  const { createClient } = require('@libsql/client');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'csv-observation-')); const file=path.join(dir,'target.db');
  const client=createClient({url:`file:${file}`});
  let closed = false;
  try {
    await client.execute('CREATE TABLE nightly_csv_attempts(id INTEGER, season INTEGER, status TEXT)');
    await client.execute('CREATE TABLE nightly_csv_snapshots(attempt_id INTEGER, code TEXT, csv TEXT, sha256 TEXT, acquired_at TEXT)');
    await client.execute('CREATE TABLE matches(match_id TEXT, season TEXT, competition TEXT, date TEXT, home_team_name TEXT, away_team_name TEXT, home_goals INTEGER, away_goals INTEGER, home_shots INTEGER, away_shots INTEGER)');
    const csv='Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS\nI1,01/11/26,Alpha,Beta,1,0,10,8\nI1,02/11/26,Gamma,Delta,2,1,9,8\n';
    await client.execute("INSERT INTO nightly_csv_attempts VALUES(1,2026,'success')");
    await client.execute({sql:'INSERT INTO nightly_csv_snapshots VALUES(?,?,?,?,?)',args:[1,'I1',csv,createHash('sha256').update(csv).digest('hex'),'2026-11-05T00:00:00Z']});
    await client.execute("INSERT INTO matches VALUES('one','2026/2027','Serie A','2026-11-01','Alpha','Beta',1,0,10,7),('two','2026/2027','Serie A','2026-11-02','Gamma','Delta',3,1,9,8)");
    client.close(); closed = true;
    const result=spawnSync(process.execPath,[path.join(__dirname,'../scripts/final-observation-csv-diagnostic.js'),file,'2026/2027'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr); const report=JSON.parse(result.stdout);
    assert.equal(report.matchStatus.matched_score,1); assert.equal(report.matchStatus.score_mismatch_or_missing,1);
    assert.equal(report.fields.home_shots.agrees_with_csv,1); assert.equal(report.fields.away_shots.different_from_csv,1);
    assert.equal(report.fields.home_shots.score_mismatch_or_missing,1);
  } finally {
    if (!closed) client.close();
    try { fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100}); }
    catch (error) { process.emitWarning(`Temporary test directory could not be removed: ${error.message}`); }
  }
});

test('CSV import atomically locks only matching observed values and preserves conflicting primary data', async () => {
  const {syncFootballData,createLibsqlFootballDataDb} = require('../dist/services/FootballDataService');
  process.env.TURSO_DATABASE_URL='file::memory:'; process.env.TURSO_AUTH_TOKEN='local';
  const db=new DatabaseService();
  try {
    await db.upsertMatch({matchId:'game',homeTeamId:'h',awayTeamId:'a',homeTeamName:'Alpha',awayTeamName:'Beta',date:'2026-11-01T12:00:00Z',homeGoals:1,awayGoals:0,homeTotalShots:11,competition:'Serie A',season:'2026/2027',source:'manual'});
    if (!(await db.db.execute('PRAGMA table_info(matches)')).rows.some(column=>column.name==='fd_odds_json')) await db.db.execute('ALTER TABLE matches ADD COLUMN fd_odds_json TEXT');
    const csv='Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR\nI1,01/11/26,Alpha,Beta,1,0,10,8,4,3,9,8,4,2,1,2,0,0\n';
    const summary=await syncFootballData(createLibsqlFootballDataDb(db.db),{competitions:['Serie A'],seasonStartYears:[2026],now:new Date('2026-11-05T00:00:00Z'),fetcher:async()=>csv});
    assert.equal(summary.errors.length,0,JSON.stringify(summary.errors));
    const row=await db.getMatchById('game'); assert.equal(row.home_shots,11); assert.equal(row.away_shots,8);
    const locks=(await db.db.execute("SELECT field FROM final_observations WHERE match_id='game'")).rows.map(r=>r.field);
    assert.ok(locks.includes('away_shots')); assert.ok(!locks.includes('home_shots'));
    assert.equal((await db.db.execute('SELECT * FROM final_observation_sources')).rows.length,1);
    await assert.rejects(db.db.execute("UPDATE matches SET away_shots=9 WHERE match_id='game'"),/final_observation_locked/);
  } finally {await db.close();}
});
