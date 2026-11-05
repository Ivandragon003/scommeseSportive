const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArguments, validateSeed, seedMatch, runStage } = require('../scripts/stage-alternative-sources');
const { settleResearchBets } = require('../dist/research/ResearchRuntime');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

test('sandbox staging is inert without explicit stage and requires all local inputs', async () => {
  const result = await runStage([]);
  assert.equal(result.mode, 'disabled');
  assert.equal(result.operationalWrites, 0);
  assert.equal(result.networkRequests, 0);
  assert.equal(parseArguments(['--help']).enabled, false);
  assert.throws(() => parseArguments(['--stage']), /stage_invalid_arguments/);
  assert.throws(() => parseArguments(['--stage', '--stage']), /stage_invalid_arguments/);
});

test('an existing sandbox target is rejected before opening any source or database', async () => {
  const file = path.join(os.tmpdir(), `source-stage-existing-${randomUUID()}.db`);
  fs.writeFileSync(file, 'existing-data-must-remain');
  try {
    await assert.rejects(runStage(['--stage', '--sandbox', file, '--source-cache', 'missing-cache', '--seed-matches', 'missing-seed', '--mapping', 'missing-map', '--season', '2026']), /stage_target_must_be_new/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'existing-data-must-remain');
  } finally { fs.unlinkSync(file); }
});

test('seed validation preserves real zero and rejects invalid counts, scopes and dates', () => {
  const row = { match_id: 'understat_1', home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home', away_team_name: 'Away',
    source: 'understat', date: '2026-08-01T12:00:00Z', season: '2026/2027', competition: 'Serie A', home_goals: 0, away_goals: null, home_xg: 0, away_xg: null };
  assert.deepEqual(validateSeed([row], 2026), [row]);
  for (const createdAt of ['2026-08-01 10:11:12', '2026-08-01T10:11:12.123Z', null]) {
    assert.equal(validateSeed([{ ...row, created_at: createdAt, home_possession: 0, away_possession: null }], 2026)[0].created_at, createdAt);
  }
  for (const patch of [{ home_goals: '' }, { home_goals: false }, { home_goals: -1 }, { home_goals: 1.5 },
    { date: '2026-02-30T12:00:00Z' }, { date: '2026-08-01' }, { season: '2025/2026' }, { home_xg: Infinity },
    { home_possession: '' }, { away_possession: false }, { home_possession: NaN }, { away_possession: -1 },
    { created_at: '2026-02-30 10:11:12' }, { created_at: '2026-08-01' }, { created_at: '' }, { created_at: 0 }]) {
    assert.throws(() => validateSeed([{ ...row, ...patch }], 2026), /stage_invalid_seed/);
  }
  assert.throws(() => validateSeed([row, row], 2026), /stage_invalid_seed/);
});

test('authentic seed projection uses DB service observation fields without losing zeros or missingness', () => {
  const input = { match_id: 'x', home_shots: 0, away_shots: 12, home_shots_on_target: 0, away_shots_on_target: null,
    home_yellow_cards: 0, away_yellow_cards: 2, home_red_cards: 0, away_red_cards: null, home_possession: 0, away_possession: null };
  const dto = seedMatch(input, 'a'.repeat(64));
  assert.deepEqual([dto.homeTotalShots, dto.awayTotalShots, dto.homeShotsOnTarget, dto.awayShotsOnTarget], [0, 12, 0, null]);
  assert.deepEqual([dto.homeYellowCards, dto.awayYellowCards, dto.homeRedCards, dto.awayRedCards], [0, 2, 0, null]);
  assert.deepEqual([dto.homePossession, dto.awayPossession], [0, null]);
  assert.equal(Object.hasOwn(dto, 'homeShots'), false);
});

test('real isolated DB seeding preserves supplied timestamps, possession zeros and nulls without changing the ordinary default', () => {
  const file = path.join(os.tmpdir(), `source-stage-preserve-${randomUUID()}.db`);
  const script = `
    const assert=require('node:assert/strict');
    const {DatabaseService}=require('./dist/db/DatabaseService');
    const {validateSeed,seedSandboxMatches}=require('./scripts/stage-alternative-sources');
    (async()=>{const db=new DatabaseService();try{
      await db.getMatches();
      await db.upsertTeam({teamId:'home',name:'Home',competition:'Serie A'});
      await db.upsertTeam({teamId:'away',name:'Away',competition:'Serie A'});
      const common={home_team_id:'home',away_team_id:'away',home_team_name:'Home',away_team_name:'Away',
        source:'understat',source_match_id:1,date:'2026-08-01T12:00:00Z',season:'2026/2027',competition:'Serie A',
        home_goals:0,away_goals:null,home_xg:0,away_xg:null};
      const rows=[{...common,match_id:'seed-sqlite-time',created_at:'2026-08-01 10:11:12',home_possession:0,away_possession:null},
        {...common,match_id:'seed-null-time',created_at:null,home_possession:null,away_possession:0},
        {...common,match_id:'seed-iso-time',created_at:'2026-08-01T10:11:12.123Z',home_possession:0.62,away_possession:0.38},
        {...common,match_id:'seed-default-time',home_possession:null,away_possession:null}];
      validateSeed(rows,2026);await seedSandboxMatches(db,rows,'a'.repeat(64));
      const stored=new Map((await db.getMatches()).map(row=>[row.match_id,row]));
      for(const row of rows)for(const[field,value]of Object.entries(row))assert.equal(stored.get(row.match_id)[field],value,field);
      assert.match(stored.get('seed-default-time').created_at,/^\\d{4}-\\d{2}-\\d{2} /);
      process.stdout.write(JSON.stringify({seedPreserved:true}));
    }finally{await db.close();}})().catch(error=>{console.error(error);process.exitCode=1;});`;
  try {
    const output = execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8',
      env: { ...process.env, TURSO_DATABASE_URL: require('node:url').pathToFileURL(file).href,
        TURSO_AUTH_TOKEN: 'isolated-stage-seed-test-only', PLAYER_DATA_ENABLED: 'false' }, maxBuffer: 2 * 1024 * 1024 });
    assert.match(output, /"seedPreserved":true/);
  } finally {
    assert.equal(path.dirname(path.resolve(file)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(file).startsWith('source-stage-preserve-'));
    for (const filename of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) if (fs.existsSync(filename)) fs.unlinkSync(filename);
  }
});

test('ordinary settlement retains the authentic alternative result provenance without changing payout', async () => {
  const captured = [];
  const observation = { source: 'football_data_org', sourceUrl: 'https://api.football-data.org/v4/competitions/SA/matches?season=2026', observedAt: '2026-11-05T22:00:00Z' };
  const db = { getMatchById: async () => ({ source: 'understat', date: '2026-11-02T19:45:00Z', home_goals: 0, away_goals: 1, raw_json: JSON.stringify({ resultObservation: observation }) }),
    research: { listBets: async () => [{ id: 'synthetic-position', matchId: 'fixture', family: 'C', snapshot: {
      quote: { market: '1x2', selection: 'awayWin', side: 'away', odds: 2,
        bookmaker: 'Synthetic fixture bookmaker', source: 'odds_api',
        capturedAt: '2026-11-02T19:00:00Z', updatedAt: '2026-11-02T19:00:00Z' } } }],
    settleBet: async (...args) => { captured.push(args); return { settled: true }; } } };
  assert.equal((await settleResearchBets(db)).settled, 1);
  assert.equal(captured[0][1], 2);
  assert.equal(captured[0][2].source, 'football_data_org');
  assert.equal(captured[0][2].resultObservedAt, observation.observedAt);
  assert.equal(captured[0][2].resultSourceUrl, observation.sourceUrl);
});
