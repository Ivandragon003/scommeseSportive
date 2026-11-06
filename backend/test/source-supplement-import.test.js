const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createClient } = require('@libsql/client');
const { importCapturedSupplement } = require('../dist/services/SourceSupplementImport');

const header = 'Div,Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HF,AF,HC,AC,HY,AY,HR,AR,Referee,HxG,AxG,AvgH,AvgD,AvgA';
const line = (date = '01/09/26', home = 'Home', away = 'Away', goals = ['1','0']) =>
  `I1,${date},${home},${away},${goals[0]},${goals[1]},10,7,4,3,9,10,5,3,2,1,0,0,Ref,7.7,8.8,2.10,3.10,4.10`;
const input = (client, csv) => ({ client, csv, competition: 'Serie A', seasonStart: 2026,
  acquiredAt: '2026-09-02T14:00:00.000Z', asOf: '2026-09-03T12:00:00.000Z',
  sourceUrl: 'https://www.football-data.co.uk/mmz4281/2627/I1.csv', sha256: createHash('sha256').update(csv).digest('hex') });
async function fixture() {
  const sqlite = createClient({ url: 'file::memory:' });
  // libSQL's file::memory: client replaces/closes its connection on native
  // transaction, destroying this temporary database. Keep one connection while
  // exercising a real SQLite transaction with the same transaction interface.
  const client = {
    execute: (...args) => sqlite.execute(...args), close: () => sqlite.close(),
    transaction: async (mode) => {
      assert.equal(mode, 'write');
      await sqlite.execute('BEGIN IMMEDIATE');
      return { execute: (...args) => sqlite.execute(...args),
        commit: () => sqlite.execute('COMMIT'), rollback: () => sqlite.execute('ROLLBACK') };
    },
  };
  await client.execute(`CREATE TABLE matches (match_id TEXT PRIMARY KEY, date TEXT, competition TEXT, source TEXT, source_match_id INTEGER,
    home_team_id TEXT, away_team_id TEXT, home_team_name TEXT, away_team_name TEXT,
    home_goals INTEGER, away_goals INTEGER, home_xg REAL, away_xg REAL,
    home_shots INTEGER, away_shots INTEGER, home_shots_on_target INTEGER, away_shots_on_target INTEGER,
    home_fouls INTEGER, away_fouls INTEGER, home_corners INTEGER, away_corners INTEGER,
    home_yellow_cards INTEGER, away_yellow_cards INTEGER, home_red_cards INTEGER, away_red_cards INTEGER,
    referee TEXT, raw_json TEXT, fd_odds_json TEXT)`);
  return client;
}
async function add(client, { id='m1', date='2026-09-01T18:00:00Z', home='Home', away='Away', raw=JSON.stringify({ original: { keep: true }, fieldProvenance: { old: { source: 'original' } } }), source='understat', sourceMatchId=null, homeGoals=1, awayGoals=0 } = {}) {
  await client.execute({ sql: `INSERT INTO matches (match_id,date,competition,source,home_team_id,away_team_id,home_team_name,away_team_name,
    home_goals,away_goals,home_xg,away_xg,home_shots,raw_json,fd_odds_json,source_match_id) VALUES (?,?,?,?,?,?,?,?,?,?,1.25,0.75,0,?,?,?)`,
  args: [id,date,'Serie A',source,`h-${id}`,`a-${id}`,home,away,homeGoals,awayGoals,raw,'{"old":true}',sourceMatchId] });
}
const read = async (client, id='m1') => (await client.execute({ sql: 'SELECT * FROM matches WHERE match_id=?', args:[id] })).rows[0];

test('CSV supplement preserves the disputed Ligue 1 identity while importing an unrelated fixture', async () => {
  const client = await fixture();
  try {
    await add(client, { id: 'disputed' });
    await add(client, { id: 'other', home: 'Other', away: 'Side' });
    await client.execute("UPDATE matches SET competition='Ligue 1'");
    await client.execute("UPDATE matches SET home_team_id='understat_team_172' WHERE match_id='disputed'");
    const csv = [header, line().replace(/^I1,/, 'F1,'), line('01/09/26', 'Other', 'Side').replace(/^I1,/, 'F1,')].join('\n');
    const result = await importCapturedSupplement({ ...input(client, csv), competition: 'Ligue 1',
      sourceUrl: 'https://www.football-data.co.uk/mmz4281/2627/F1.csv' });
    assert.deepEqual(result.updatedMatchIds, ['other']);
    assert.equal((await read(client, 'disputed')).away_shots, null);
    assert.equal((await read(client, 'other')).away_shots, 7);
  } finally { client.close(); }
});

test('excluding one disputed candidate never makes another same-key candidate look unambiguous', async () => {
  const client = await fixture();
  try {
    await add(client, { id: 'blocked' }); await add(client, { id: 'duplicate' });
    const csv = [header, line()].join('\n');
    const result = await importCapturedSupplement({ ...input(client, csv), excludedMatchIds: ['blocked'] });
    assert.equal(result.ambiguousRows, 1);
    assert.deepEqual(result.updatedMatchIds, []);
    assert.equal((await read(client, 'duplicate')).away_shots, null);
  } finally { client.close(); }
});

test('existing data and real zero survive; missing counts have field provenance; repeat is idempotent', async () => {
  const client = await fixture();
  try {
    await add(client);
    const csv = [header,line()].join('\n');
    const result = await importCapturedSupplement(input(client,csv));
    assert.deepEqual(result.updatedMatchIds,['m1']);
    assert.deepEqual(result.updatedTeamIds,['a-m1','h-m1']);
    assert.equal(result.summary.oddsWritten,0);
    const row = await read(client);
    assert.equal(row.home_shots,0);
    assert.equal(row.away_shots,7);
    assert.equal(row.home_xg,1.25);
    assert.equal(row.away_xg,0.75);
    assert.equal(row.fd_odds_json,'{"old":true}');
    const raw = JSON.parse(row.raw_json);
    assert.deepEqual(raw.original,{keep:true});
    assert.deepEqual(raw.fieldProvenance.old,{source:'original'});
    assert.equal(raw.fieldProvenance.home_shots,undefined);
    assert.equal(raw.fieldProvenance.away_shots.payloadSha256,input(client,csv).sha256);
    assert.equal(raw.fieldProvenance.away_shots.acquiredAt,'2026-09-02T14:00:00.000Z');
    assert.equal(raw.fieldProvenance.away_shots.sourceUrl,input(client,csv).sourceUrl);
    const repeated = await importCapturedSupplement(input(client,csv));
    assert.deepEqual(repeated.updatedMatchIds,[]);
    assert.deepEqual(repeated.updatedTeamIds,[]);
    assert.equal((await read(client)).raw_json,row.raw_json);
  } finally { client.close(); }
});

test('unmatched, ambiguous and conflicting results never promote a score or import data', async () => {
  const client = await fixture();
  try {
    await add(client,{id:'m1'});
    await add(client,{id:'m2',date:'2026-09-01T20:00:00Z',home:'Duplicate',away:'Pair'});
    await add(client,{id:'m3',date:'2026-09-01T21:00:00Z',home:'Duplicate',away:'Pair'});
    await add(client,{id:'m4',home:'Conflict',away:'Score'});
    await add(client,{id:'m5',home:'Pending',away:'Score',awayGoals:null});
    const csv=[header,line(),line('01/09/26','Unknown','Team'),line('01/09/26','Duplicate','Pair'),
      line('01/09/26','Conflict','Score',['9','9']),line('01/09/26','Pending','Score')].join('\n');
    const result = await importCapturedSupplement(input(client,csv));
    assert.equal(result.eligibleRows,1);
    assert.equal(result.unmatchedRows,2);
    assert.equal(result.ambiguousRows,1);
    assert.equal(result.scoreMismatchRows,1);
    assert.deepEqual(result.updatedMatchIds,['m1']);
    assert.equal((await read(client,'m4')).away_shots,null);
    assert.equal((await read(client,'m5')).away_goals,null);
  } finally { client.close(); }
});

test('invalid scope, hash, timestamps, scores or source URL are rejected before writing', async () => {
  const client = await fixture();
  try {
    await add(client);
    const csv = [header,line()].join('\n'), base = input(client,csv), original=(await read(client)).raw_json;
    const bad = [
      { ...base, sha256:'0'.repeat(64) }, { ...base, acquiredAt:'2026-09-04T00:00:00Z' },
      { ...base, asOf:'not-a-date' }, { ...base, sourceUrl:'https://evil.example/mmz4281/2627/I1.csv' },
      { ...base, sourceUrl:'https://www.football-data.co.uk/mmz4281/2627/E0.csv' },
      input(client,[header,line().replace(/^I1,/,'E0,')].join('\n')),
      input(client,[header,line('01/09/25')].join('\n')),
      input(client,[header,line('31/02/26')].join('\n')),
      input(client,[header,line('01/09/26','Home','Away',['','0'])].join('\n')),
      input(client,[header,line().replace(',10,7,',',-1,7,')].join('\n')),
    ];
    for (const request of bad) await assert.rejects(importCapturedSupplement(request));
    assert.equal((await read(client)).raw_json,original);
    assert.equal((await read(client)).away_shots,null);
  } finally { client.close(); }
});

test('an invalid raw payload on a later match rolls back earlier statistics and provenance', async () => {
  const client = await fixture();
  try {
    await add(client);
    await add(client,{id:'m2',home:'Other',away:'Side',raw:'{bad'});
    const first = await read(client), second = await read(client,'m2');
    const csv = [header,line(),line('01/09/26','Other','Side')].join('\n');
    await assert.rejects(importCapturedSupplement(input(client,csv)), /supplement_sync_failed/);
    assert.deepEqual(await read(client),first);
    assert.deepEqual(await read(client,'m2'),second);
  } finally { client.close(); }
});

test('provenance conflicts and non-object raw JSON fail closed', async () => {
  for (const raw of ['[]','{"fieldProvenance":[]}', '{"fieldProvenance":{"away_shots":{"old":true}}}']) {
    const client=await fixture();
    try {
      await add(client,{raw});
      await assert.rejects(importCapturedSupplement(input(client,[header,line()].join('\n'))), /supplement_sync_failed/);
      assert.equal((await read(client)).raw_json,raw);
      assert.equal((await read(client)).away_shots,null);
    } finally { client.close(); }
  }
});

test('provenance patch preserves raw numeric precision and unrelated duplicate keys', async () => {
  const client=await fixture();
  try {
    const raw='{"huge":9007199254740993,"extra":1,"extra":2,"nested":{"x":1}}';
    await add(client,{raw});
    await importCapturedSupplement(input(client,[header,line()].join('\n')));
    const result=(await read(client)).raw_json;
    assert.match(result,/"huge":9007199254740993/);
    assert.match(result,/"extra":1,"extra":2/);
    assert.deepEqual(JSON.parse(result).nested,{x:1});
  } finally { client.close(); }
});

test('a result captured before kickoff or without trusted source cannot fill a match', async () => {
  const client=await fixture();
  try {
    await add(client,{id:'before',date:'2026-09-01T18:00:00Z'});
    await add(client,{id:'other',home:'Other',away:'Side',source:'manual'});
    const csv=[header,line(),line('01/09/26','Other','Side')].join('\n');
    const request={...input(client,csv),acquiredAt:'2026-09-01T17:00:00Z'};
    const result=await importCapturedSupplement(request);
    assert.equal(result.eligibleRows,0);
    assert.equal(result.unmatchedRows,2);
    assert.deepEqual(result.updatedTeamIds,[]);
    assert.equal((await read(client,'before')).away_shots,null);
    assert.equal((await read(client,'other')).away_shots,null);
  } finally { client.close(); }
});

test('football-data.org fixtures require matching positive immutable provider identity', async () => {
  const client=await fixture();
  try {
    await add(client,{id:'football_data_org_123',home:'Home',away:'Away',source:'football_data_org',sourceMatchId:123});
    await add(client,{id:'football_data_org_456',home:'Bad',away:'Identity',source:'football_data_org',sourceMatchId:457});
    await add(client,{id:'football_data_org_0',home:'Zero',away:'Identity',source:'football_data_org',sourceMatchId:0});
    const csv=[header,line(),line('01/09/26','Bad','Identity'),line('01/09/26','Zero','Identity')].join('\n');
    const result=await importCapturedSupplement(input(client,csv));
    assert.deepEqual(result.updatedMatchIds,['football_data_org_123']);
    assert.equal(result.unmatchedRows,2);
    const fixtureRow=await read(client,'football_data_org_123');
    assert.equal(fixtureRow.source,'football_data_org');
    assert.equal(fixtureRow.source_match_id,123);
    assert.equal(fixtureRow.home_team_name,'Home');
    assert.equal(fixtureRow.away_team_name,'Away');
    assert.equal(fixtureRow.away_shots,7);
    assert.equal((await read(client,'football_data_org_456')).away_shots,null);
    assert.equal((await read(client,'football_data_org_0')).away_shots,null);
  } finally { client.close(); }
});
