const test = require('node:test');
const assert = require('node:assert/strict');
const { UnderstatScraper, hasValidUnderstatMatchDetails } = require('../dist/services/UnderstatScraper');
const { parseFootballDataCsv, createLibsqlFootballDataDb } = require('../dist/services/FootballDataService');

const roster = (offset = 0) => Object.fromEntries(Array.from({ length: 11 }, (_, index) => {
  const id = String(offset + index + 1);
  return [id, { player_id: id, player: `Fixture Player ${id}`, team_id: String(offset),
    shots: '0', goals: '0', xG: '0', time: '90', yellow_card: '0', red_card: '0' }];
}));
const details = () => ({ rosters: { h: roster(), a: roster(100) }, shots: { h: [], a: [] } });
const leagueMatch = { id: '900', datetime: '2026-08-01 12:00:00',
  h: { id: '1', title: 'Fixture Home' }, a: { id: '2', title: 'Fixture Away' },
  goals: { h: '0', a: '0' }, xG: { h: '0', a: '0' } };
async function scrape(detail, overrides = {}) {
  const scraper = new UnderstatScraper();
  scraper.client.get = async path => ({ data: path.startsWith('/getLeagueData/')
    ? { dates: [{ ...leagueMatch, ...overrides }] } : detail });
  return (await scraper.scrapeSeason('Serie A', '2026/2027', { includeDetails: true }))[0];
}
const absentNumbers = [null, undefined, '', '   ', '\t', 'unreadable', Number.NaN, Infinity, false, {}, []];

test('Understat league numeric missing values stay absent while observed zero survives', async () => {
  for (const value of absentNumbers) {
    const result = await scrape(details(), { xG: { h: value, a: '0' } });
    assert.equal(result.homeXG, null, String(value));
    assert.equal(result.awayXG, 0);
  }
});

test('Understat complete zero-event details keep genuine team zero values', async () => {
  const result = await scrape(details());
  for (const side of ['home', 'away']) {
    for (const field of ['TotalShots', 'ShotsOnTarget', 'YellowCards', 'RedCards']) {
      assert.equal(result[`${side}${field}`], 0);
    }
  }
});

test('Understat cards require every roster count independently of the other card color', async () => {
  for (const value of [...absentNumbers, -1, 0.5]) {
    const detail = details();
    detail.rosters.h['1'].yellow_card = value;
    detail.rosters.a['101'].red_card = value;
    const result = await scrape(detail);
    assert.equal(result.homeYellowCards, null, String(value));
    assert.equal(result.homeRedCards, 0);
    assert.equal(result.awayYellowCards, 0);
    assert.equal(result.awayRedCards, null);
    assert.equal(result.homeTotalShots, 0);
  }
});

test('Understat absent arrays and partial, malformed or duplicate rosters never produce observed zeros', async () => {
  const malformed = [];
  const noShots = details(); delete noShots.shots.h; malformed.push(noShots);
  const emptyRoster = details(); emptyRoster.rosters.h = {}; malformed.push(emptyRoster);
  const partial = details(); delete partial.rosters.h['1']; malformed.push(partial);
  const extraInvalid = details(); extraInvalid.rosters.h.invalid = null; malformed.push(extraInvalid);
  const duplicate = details(); duplicate.rosters.h['11'] = { ...duplicate.rosters.h['1'] }; malformed.push(duplicate);
  for (const detail of malformed) {
    assert.equal(hasValidUnderstatMatchDetails(detail), false);
    const result = await scrape(detail);
    assert.equal(result.homeTotalShots, null);
    assert.equal(result.homeShotsOnTarget, null);
    assert.equal(result.homeYellowCards, null);
    assert.equal(result.homeRedCards, null);
    assert.deepEqual(result.playerStats, []);
  }
});

test('Understat partial or unreadable shot events cannot establish a zero SOT count', async () => {
  const partial = details(); partial.rosters.h['1'].shots = '1';
  const partialResult = await scrape(partial);
  assert.equal(partialResult.homeTotalShots, null);
  assert.equal(partialResult.homeShotsOnTarget, null);
  const unreadable = details(); unreadable.rosters.h['1'].shots = '1';
  unreadable.shots.h = [{ player_id: '1', result: '', xG: '0.1' }];
  const unreadableResult = await scrape(unreadable);
  assert.equal(unreadableResult.homeTotalShots, 1);
  assert.equal(unreadableResult.homeShotsOnTarget, null);
  const malformed = details(); malformed.rosters.h['1'].shots = '1'; malformed.shots.h = [null];
  assert.equal((await scrape(malformed)).homeTotalShots, null);
});

test('Understat complete populated event values and original raw data remain exact', async () => {
  const detail = details();
  detail.rosters.h['1'].shots = '3'; detail.rosters.h['1'].yellow_card = '1'; detail.rosters.a['101'].red_card = '1';
  detail.shots.h = [
    { player_id: '1', result: 'SavedShot', xG: '0.2' },
    { player_id: '1', result: 'Goal', xG: '0.7' },
    { player_id: '1', result: 'MissedShots', xG: '0.1' },
  ];
  const result = await scrape(detail);
  assert.deepEqual([result.homeTotalShots, result.homeShotsOnTarget, result.homeYellowCards, result.awayRedCards], [3, 2, 1, 1]);
  assert.deepEqual(JSON.parse(result.rawJson), { match: leagueMatch, details: detail });
});

test('Understat normalized player rows preserve each known metric without imputing missing values', async () => {
  for (const value of absentNumbers) {
    const detail = details();
    detail.rosters.h['1'].shots = value;
    detail.rosters.h['1'].xG = value;
    detail.rosters.h['1'].goals = value;
    const result = await scrape(detail);
    const player = result.playerStats.find(entry => entry.sourcePlayerId === 1);
    assert.equal(player.shots, null, String(value));
    assert.equal(player.xg, null);
    assert.equal(player.goals, null);
    const other = result.playerStats.find(entry => entry.sourcePlayerId === 2);
    assert.deepEqual([other.shots, other.shotsOnTarget, other.goals, other.xg, other.xgot], [0, 0, 0, 0, 0]);
  }
});

test('Understat normalized SOT and xgot independently abstain on incomplete or unreadable events', async () => {
  const detail = details();
  detail.rosters.h['1'].shots = '1';
  const partial = (await scrape(detail)).playerStats.find(entry => entry.sourcePlayerId === 1);
  assert.deepEqual([partial.shots, partial.shotsOnTarget, partial.xgot], [1, null, null]);
  detail.shots.h = [{ player_id: '1', result: 'SavedShot', xG: null }];
  const noXg = (await scrape(detail)).playerStats.find(entry => entry.sourcePlayerId === 1);
  assert.deepEqual([noXg.shots, noXg.shotsOnTarget, noXg.xgot], [1, 1, null]);
  detail.shots.h[0].xG = '0.4';
  const complete = (await scrape(detail)).playerStats.find(entry => entry.sourcePlayerId === 1);
  assert.deepEqual([complete.shots, complete.shotsOnTarget, complete.xgot], [1, 1, 0.4]);
  detail.shots.h[0].result = 'unreadable';
  const unknown = (await scrape(detail)).playerStats.find(entry => entry.sourcePlayerId === 1);
  assert.deepEqual([unknown.shots, unknown.shotsOnTarget, unknown.xgot], [1, null, null]);
});

test('Understat empty or partial shot arrays require independent roster counts before establishing totals or SOT', async () => {
  for (const value of [...absentNumbers, -1, 0.5]) {
    for (const events of [[], [{ player_id: '1', result: 'SavedShot', xG: '0.3' }]]) {
      const detail = details();
      detail.rosters.h['1'].shots = value;
      detail.shots.h = events;
      const result = await scrape(detail);
      const player = result.playerStats.find(entry => entry.sourcePlayerId === 1);
      assert.deepEqual([player.shots, player.shotsOnTarget, player.xgot], [null, null, null], String(value));
      assert.deepEqual([result.homeTotalShots, result.homeShotsOnTarget], [null, null]);
      assert.deepEqual([result.awayTotalShots, result.awayShotsOnTarget], [0, 0]);
      assert.deepEqual([result.homeYellowCards, result.homeRedCards], [0, 0]);
    }
  }
});

test('Understat duplicate explicit shot identities cannot establish total or SOT completeness', async () => {
  const detail = details();
  detail.rosters.h['1'].shots = '2';
  detail.shots.h = [
    { id: 'fixture-shot-1', player_id: '1', result: 'Goal', xG: '0.3' },
    { id: 'fixture-shot-1', player_id: '1', result: 'Goal', xG: '0.3' },
  ];
  const result = await scrape(detail);
  const player = result.playerStats.find(entry => entry.sourcePlayerId === 1);
  assert.deepEqual([player.shots, player.shotsOnTarget, player.xgot], [2, null, null]);
  assert.deepEqual([result.homeTotalShots, result.homeShotsOnTarget], [null, null]);
  assert.deepEqual([result.homeYellowCards, result.homeRedCards], [0, 0]);
  assert.deepEqual([result.awayTotalShots, result.awayShotsOnTarget], [0, 0]);
  assert.deepEqual(JSON.parse(result.rawJson).details.shots.h, detail.shots.h);
  detail.shots.h[1] = { id: 'fixture-shot-2', player_id: '1', result: 'MissedShots', xG: '0.1' };
  const complete = await scrape(detail);
  assert.deepEqual([complete.homeTotalShots, complete.homeShotsOnTarget], [2, 1]);
  // Legacy maps without explicit IDs remain valid; no tuple-derived ID is invented.
  delete detail.shots.h[0].id;
  delete detail.shots.h[1].id;
  const legacy = await scrape(detail);
  assert.deepEqual([legacy.homeTotalShots, legacy.homeShotsOnTarget], [2, 1]);
});

test('Understat own goals do not count as team shots or create roster mismatches', async () => {
  const detail = details();
  detail.shots.h = [{ player_id: '1', result: 'OwnGoal', xG: '0.1' }];
  const ownGoalOnly = await scrape(detail);
  const player = ownGoalOnly.playerStats.find(entry => entry.sourcePlayerId === 1);
  assert.deepEqual([player.shots, player.shotsOnTarget, player.xgot], [0, 0, 0]);
  assert.deepEqual([ownGoalOnly.homeTotalShots, ownGoalOnly.homeShotsOnTarget], [0, 0]);
  detail.rosters.h['1'].shots = '1';
  detail.shots.h.push({ player_id: '1', result: 'SavedShot', xG: '0.3' });
  const withSavedShot = await scrape(detail);
  const withShot = withSavedShot.playerStats.find(entry => entry.sourcePlayerId === 1);
  assert.deepEqual([withShot.shots, withShot.shotsOnTarget, withShot.xgot], [1, 1, 0.3]);
  assert.deepEqual([withSavedShot.homeTotalShots, withSavedShot.homeShotsOnTarget], [1, 1]);
  detail.shots.a = [{ player_id: '101', result: 'OwnGoal', xG: '0.1' }];
  const bothSides = await scrape(detail);
  assert.deepEqual([bothSides.homeTotalShots, bothSides.awayTotalShots], [1, 0]);
  detail.rosters.h['1'].shots = '2';
  const unexplained = await scrape(detail);
  assert.equal(unexplained.playerStats.find(entry => entry.sourcePlayerId === 1).shotsOnTarget, null);
  assert.equal(unexplained.homeShotsOnTarget, null);
});

async function seasonStats(players, failed = false) {
  const scraper = new UnderstatScraper();
  scraper.client.get = async path => {
    if (path.startsWith('/getLeagueData/')) return { data: { dates: [], teams: { '1': { title: 'Fixture Home',
      history: [{ result: 'w', scored: '1', missed: '0', xG: '1', xGA: '0', pts: '3' }] } } } };
    if (failed) throw new Error('fixture unavailable');
    return { data: { players } };
  };
  return scraper.getTeamSeasonStats('Serie A', '2026/2027', 'Fixture Home');
}
const seasonPlayers = () => Object.values(roster()).map(entry => ({ id: entry.player_id, player_name: entry.player,
  yellow_cards: '0', red_cards: '0' }));

test('Understat season unavailable, empty and partial player payloads keep cards absent', async () => {
  for (const players of [undefined, null, [], {}, seasonPlayers().slice(0, 10)]) {
    const result = await seasonStats(players);
    assert.deepEqual([result.yellowTotal, result.redTotal, result.yellowPerMatch, result.redPerMatch], [null, null, null, null]);
  }
  assert.equal((await seasonStats(undefined, true)).yellowTotal, null);
});

test('Understat season complete cards preserve zero and abstain independently on a missing count', async () => {
  const players = seasonPlayers();
  const zero = await seasonStats(players);
  assert.deepEqual([zero.yellowTotal, zero.redTotal], [0, 0]);
  players[0].yellow_cards = '2'; players[1].red_cards = '1';
  const full = await seasonStats(players);
  assert.deepEqual([full.yellowTotal, full.redTotal, full.yellowPerMatch, full.redPerMatch], [2, 1, 2, 1]);
  for (const value of absentNumbers) {
    players[0].yellow_cards = value;
    const partial = await seasonStats(players);
    assert.equal(partial.yellowTotal, null);
    assert.equal(partial.yellowPerMatch, null);
    assert.equal(partial.redTotal, 1);
  }
});

const csv = value => `Date,HomeTeam,AwayTeam,HS,AS,HST,AST,HY,AY,HR,AR\n01/08/2026,Fixture Home,Fixture Away,${Array(8).fill(value).join(',')}`;
const csvFields = ['homeShots', 'awayShots', 'homeShotsOnTarget', 'awayShotsOnTarget', 'homeYellow', 'awayYellow', 'homeRed', 'awayRed'];
test('football-data CSV absent, empty, whitespace and invalid values stay null; observed zero survives', () => {
  for (const value of ['', '   ', 'null', 'undefined', 'NaN', 'Infinity', 'unreadable', '-1', '0.5']) {
    const row = parseFootballDataCsv(csv(value))[0];
    for (const field of csvFields) assert.equal(row[field], null, `${field}: ${value}`);
  }
  for (const field of csvFields) assert.equal(parseFootballDataCsv(csv('0'))[0][field], 0);
  for (const field of csvFields) assert.equal(parseFootballDataCsv('Date,HomeTeam,AwayTeam\n01/08/2026,A,B')[0][field], null);
});

test('football-data adapter passes null and genuine zero distinctly with COALESCE in single and batch writes', async () => {
  const statements = [];
  const client = { execute: async statement => { statements.push(statement); return { rows: [], rowsAffected: 0 }; },
    batch: async batch => { statements.push(...batch); return batch.map(() => ({ rows: [], rowsAffected: 0 })); } };
  const db = createLibsqlFootballDataDb(client);
  const missing = parseFootballDataCsv(csv(''))[0];
  const zero = parseFootballDataCsv(csv('0'))[0];
  await db.fillSupplementalStats('fixture-only', missing);
  await db.applySupplementalStatsAndOdds([{ matchId: 'fixture-only', row: zero, fillStats: true, saveOdds: false }]);
  assert.equal(statements.length, 2);
  for (const [index, statement] of statements.entries()) {
    for (const param of ['hs', 'as_', 'hst', 'ast', 'hy', 'ay', 'hr', 'ar']) assert.equal(statement.args[param], index ? 0 : null);
    assert.match(statement.sql, /home_shots = COALESCE\(home_shots, :hs\)/);
    assert.match(statement.sql, /home_yellow_cards = COALESCE\(home_yellow_cards, :hy\)/);
  }
});
