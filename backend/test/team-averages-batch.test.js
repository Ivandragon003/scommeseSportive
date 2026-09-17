const test = require('node:test');
const assert = require('node:assert/strict');

process.env.TURSO_DATABASE_URL = 'file::memory:';
process.env.TURSO_AUTH_TOKEN = 'test-token';
const { DatabaseService } = require('../dist/db/DatabaseService.js');

let db;
test.before(async () => {
  db = new DatabaseService();
  await db.initPromise;
});
test.after(() => db.db.close());
test.beforeEach(async () => {
  await db.db.execute('DELETE FROM matches');
  await db.db.execute('DELETE FROM teams');
});

async function seed() {
  for (const id of ['a', 'b', 'c', 'empty', 'unrelated']) {
    await db.db.execute({
      sql: 'INSERT INTO teams (team_id, name, avg_away_shots, team_stats_json) VALUES (?, ?, 8.75, ?)',
      args: [id, id, JSON.stringify({ imported: { preserved: true }, computed: { custom: 'keep' } })],
    });
  }
  const columns = ['home_shots', 'away_shots', 'home_shots_on_target', 'away_shots_on_target',
    'home_xg', 'away_xg', 'home_yellow_cards', 'away_yellow_cards', 'home_red_cards', 'away_red_cards',
    'home_fouls', 'away_fouls', 'home_corners', 'away_corners', 'home_possession', 'away_possession'];
  for (let i = 0; i < 16; i++) {
    const values = columns.map((_, j) => (i + j) % 5 === 0 ? null : (i + j) % 12 + 1);
    await db.db.execute({
      sql: `INSERT INTO matches (match_id, home_team_id, away_team_id, date, home_goals, away_goals, ${columns.join(',')})
        VALUES (${Array(6 + columns.length).fill('?').join(',')})`,
      args: [`m${i}`, i % 2 ? 'a' : 'b', i % 2 ? 'b' : 'c',
        `2026-08-${String(i + 1).padStart(2, '0')}T12:00:00Z`, i % 4, i === 4 ? null : i % 3, ...values],
    });
  }
  await db.db.execute("INSERT INTO matches (match_id, home_team_id, away_team_id, date) VALUES ('unfinished', 'a', 'empty', '2030-01-01')");
}

// Independent reconstruction of the previous per-team aggregate queries.
function legacyAggregateSql(side) {
  const other = side === 'home' ? 'away' : 'home';
  const w = "EXP(-0.005 * (julianday('now') - julianday(date)))";
  const weighted = [
    [`${side}_shots`, 'shots'], [`${side}_shots_on_target`, 'shots_ot'],
    [`${side}_xg`, 'xg'], [`${other}_shots`, 'shots_conceded'],
    [`${side}_yellow_cards`, 'yellow'], [`${side}_red_cards`, 'red'],
    [`${side}_fouls`, 'fouls'], [`${side}_corners`, 'corners'],
    [`${other}_corners`, 'corners_conceded'],
  ].map(([col, alias]) => `SUM(CASE WHEN ${col} IS NOT NULL THEN ${col} * ${w} END) /
    NULLIF(SUM(CASE WHEN ${col} IS NOT NULL THEN ${w} END), 0) AS avg_${alias}`);
  const variance = [[`${side}_shots`, 'shots'], [`${side}_shots_on_target`, 'shots_ot'],
    [`${side}_yellow_cards`, 'yellow'], [`${side}_fouls`, 'fouls']]
    .map(([col, alias]) => `AVG(${col} * ${col} * 1.0) - AVG(${col} * 1.0) * AVG(${col} * 1.0) AS var_${alias}`);
  const totals = [[`${side}_shots`, 'shots'], [`${side}_shots_on_target`, 'shots_ot'],
    [`${side}_xg`, 'xg'], [`${other}_xg`, 'xga'], [`${side}_fouls`, 'fouls_committed'],
    [`${other}_fouls`, 'fouls_drawn'], [`${side}_yellow_cards`, 'yellow'],
    [`${side}_red_cards`, 'red'], [`${side}_corners`, 'corners']]
    .map(([col, alias]) => `SUM(COALESCE(${col}, 0)) AS total_${alias}`);
  return `SELECT ${[...weighted, ...variance, ...totals,
    `AVG(${side}_possession * 1.0) AS avg_possession`, `SUM(${w}) AS total_weight`, 'COUNT(*) AS n'].join(',')}
    FROM matches WHERE ${side}_team_id = ? AND home_goals IS NOT NULL`;
}

function canonicalArgs(args) {
  const json = JSON.parse(args.teamStatsJson);
  delete json.computed.updatedAt;
  return { ...args, teamStatsJson: json };
}

function assertEquivalent(actual, expected, path = '') {
  if (typeof expected === 'number') {
    assert.ok(Math.abs(actual - expected) < 1e-8, path);
  } else if (expected && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), path);
    for (const key of Object.keys(expected)) assertEquivalent(actual[key], expected[key], `${path}.${key}`);
  } else {
    assert.deepEqual(actual, expected, path);
  }
}

test('set-based averages match legacy per-team inputs and preserve imported JSON', async () => {
  await seed();
  const expected = new Map();
  for (const id of ['a', 'b', 'c', 'empty']) {
    const team = await db.getTeam(id);
    const home = await db.get(legacyAggregateSql('home'), [id]);
    const away = await db.get(legacyAggregateSql('away'), [id]);
    const metrics = { shots: 'shots', shots_ot: 'shots_on_target', xg: 'xg',
      goals_for: 'goals', fouls: 'fouls', yellow_cards: 'yellow_cards', corners: 'corners' };
    const fields = Object.entries(metrics).map(([alias, col]) =>
      `CASE WHEN home_team_id = ? THEN home_${col} ELSE away_${col} END AS ${alias}`);
    fields.push('CASE WHEN home_team_id = ? THEN away_goals ELSE home_goals END AS goals_against');
    const recent = await db.all(`SELECT date, ${fields.join(',')} FROM matches
      WHERE (home_team_id = ? OR away_team_id = ?) AND home_goals IS NOT NULL AND away_goals IS NOT NULL
      ORDER BY datetime(date) DESC LIMIT 10`, Array(fields.length + 2).fill(id));
    const statement = db.teamAverageUpdateStatement(id, team, home, away, recent);
    if (statement) expected.set(id, canonicalArgs(statement.args));
  }

  const originalBatch = db.db.batch.bind(db.db);
  const writes = [];
  let writeBatches = 0;
  db.db.batch = async (statements, mode) => {
    writeBatches++;
    writes.push(...statements);
    return originalBatch(statements, mode);
  };
  const originalAll = db.all.bind(db);
  let reads = 0;
  db.all = async (...args) => { reads++; return originalAll(...args); };
  try {
    await db.recomputeTeamAveragesBatch(['a', 'b', 'c', 'empty', 'a', ' ', '']);
    assert.equal(reads, 4);
    assert.equal(writeBatches, 1);
    assert.equal(writes.length, 3);
    for (const statement of writes) {
      const actual = canonicalArgs(statement.args);
      const reference = expected.get(statement.args.teamId);
      // Weight computations use julianday('now'); tolerate only subsecond drift.
      assertEquivalent(actual, reference);
    }
  } finally {
    db.all = originalAll;
    db.db.batch = originalBatch;
  }
  const c = await db.getTeam('c');
  assert.equal(c.avg_home_shots, 12.1); // no home history: keep the existing value
  assert.equal(JSON.parse(c.team_stats_json).imported.preserved, true);
  assert.equal(JSON.parse(c.team_stats_json).computed.custom, 'keep');
  const a = JSON.parse((await db.getTeam('a')).team_stats_json).computed;
  assert.equal(a.recent.last10.matches, 8);
  const b = JSON.parse((await db.getTeam('b')).team_stats_json).computed;
  assert.equal(b.recent.last10.matches, 10);
  assert.equal(b.recent.last5.matches, 5);
  assert.equal(JSON.parse((await db.getTeam('empty')).team_stats_json).computed.overallSampleSize, undefined);
  assert.equal(JSON.parse((await db.getTeam('unrelated')).team_stats_json).computed.overallSampleSize, undefined);
});

test('empty input performs no reads or writes', async () => {
  const original = db.all;
  db.all = async () => { throw new Error('unexpected database read'); };
  try { await db.recomputeTeamAveragesBatch(['', ' ']); } finally { db.all = original; }
});

test('all-null statistics retain shot averages and the existing fallback rules', async () => {
  await db.db.execute("INSERT INTO teams (team_id, name, avg_home_shots, avg_away_shots) VALUES ('a', 'A', 13.5, 8.75)");
  await db.db.execute("INSERT INTO teams (team_id, name) VALUES ('b', 'B')");
  await db.db.execute("INSERT INTO matches (match_id, home_team_id, away_team_id, date, home_goals, away_goals) VALUES ('nulls', 'a', 'b', '2026-08-01', 1, 0)");
  await db.recomputeTeamAveragesBatch(['a', 'b']);
  const a = await db.getTeam('a');
  assert.equal(a.avg_home_shots, 13.5);
  assert.equal(a.avg_away_shots, 8.75);
  assertEquivalent(a.avg_yellow_cards, 1.9);
  assert.equal(a.avg_home_corners, 5.5);
  assert.equal(a.avg_away_corners, 4.5);
  const computed = JSON.parse(a.team_stats_json).computed;
  assert.equal(computed.home.varShots, null);
  assert.equal(computed.overallSampleSize, 1);
  assert.equal(computed.recent.last5.avgShots, 0);
});

test('overlapping single-team and batch requests share the pending recomputation', async () => {
  const original = db.loadTeamAveragesBatch;
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  db.loadTeamAveragesBatch = async (ids) => { calls.push(ids); await gate; };
  try {
    const first = db.recomputeTeamAveragesBatch(['a', 'b']);
    const second = db.recomputeTeamAverages('a');
    const third = db.recomputeTeamAveragesBatch(['b', 'c']);
    release();
    await Promise.all([first, second, third]);
    assert.deepEqual(calls, [['a', 'b'], ['c']]);
    assert.equal(db.teamAverageLoads.size, 0);
  } finally { db.loadTeamAveragesBatch = original; }
});

test('large inputs are chunked and a failed batch can be retried', async () => {
  const originalAll = db.all;
  const originalBatch = db.db.batch;
  let reads = 0;
  db.all = async () => { reads++; return []; };
  db.db.batch = async () => { throw new Error('unexpected write'); };
  try {
    await db.recomputeTeamAveragesBatch(Array.from({ length: 205 }, (_, i) => `team-${i}`));
    assert.equal(reads, 12);
    db.all = async () => { throw new Error('read failed'); };
    await assert.rejects(db.recomputeTeamAveragesBatch(['retry']), /read failed/);
    assert.equal(db.teamAverageLoads.size, 0);
    db.all = async () => [];
    await db.recomputeTeamAveragesBatch(['retry']);
  } finally {
    db.all = originalAll;
    db.db.batch = originalBatch;
  }
});
