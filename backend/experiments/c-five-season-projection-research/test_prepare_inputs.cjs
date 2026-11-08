'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepare, resolveCsvPath } = require('./prepare_inputs.cjs');
const recent = [{ matchId: 'understat_1', competition: 'Premier League', season: '2022/2023', date: '2022-08-06T14:00:00.000Z',
  homeTeamId: 'arsenal', awayTeamId: 'chelsea', homeGoals: 2, awayGoals: 1, homeXG: 1.3, awayXG: 0.7,
  homeTotalShots: 9, awayTotalShots: null }];
const names = [{ match_id: 'understat_1', competition: 'Premier League', home_team_id: 'arsenal', away_team_id: 'chelsea',
  home_team_name: 'Arsenal', away_team_name: 'Chelsea' }];
const archive = [{ matchId: 'understat_2', competition: 'Premier League', season: '2021/2022', date: '2021-08-07T14:00:00.000Z',
  homeTeamId: 'understat_team_1', awayTeamId: 'understat_team_2', homeTeamName: 'Arsenal', awayTeamName: 'Norwich',
  homeGoals: 1, awayGoals: 0, homeXG: 2.1, awayXG: 0.2, homeTotalShots: 15 }];
const source = text => ({ text, file: 'example.csv', sha256: 'a'.repeat(64), competition: 'Premier League', seasonStart: 2021,
  archiveAcquiredAt: '2026-11-01T00:00:00Z' });
const header = 'Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,AvgCH,AvgCD,AvgCA,B365CH,B365CD,B365CA';
test('Understat preserved, missing stat supplemented, genuine Bet365 closing wins over averages', () => {
  const r = prepare(archive, recent, names, [source(`${header}\n07/08/21,Arsenal,Norwich,1,0,99,4,1.4,4,8,1.5,3.8,7`)]);
  const match = r.history.find(x => x.matchId === 'understat_2');
  assert.equal(match.homeTeamId, 'arsenal'); assert.match(match.awayTeamId, /^archive_internal_/);
  assert.equal(match.homeTotalShots, 15); assert.equal(match.awayTotalShots, 4); assert.equal(match.homeXG, 2.1);
  assert.deepEqual(r.quotes.rows[0].prices, [1.5, 3.8, 7]);
  assert.equal(r.audit.supplementalProvenance[0].field, 'awayTotalShots');
});
test('opening/average prices never impersonate unavailable Bet365 closing', () => {
  const r = prepare(archive, recent, names, [source('Date,HomeTeam,AwayTeam,FTHG,FTAG,AvgCH,AvgCD,AvgCA,B365H,B365D,B365A\n07/08/21,Arsenal,Norwich,1,0,1.4,4,8,1.5,3.8,7')]);
  assert.equal(r.quotes.rows.length, 0);
});
test('mismatched score or duplicate source rows cannot be merged', () => {
  const bad = prepare(archive, recent, names, [source(`${header}\n07/08/21,Arsenal,Norwich,2,0,99,4,1.4,4,8,1.5,3.8,7`)]);
  assert.equal(bad.quotes.rows.length, 0); assert.equal(bad.audit.skipped[0].reason, 'season_or_score_mismatch');
  const row = '07/08/21,Arsenal,Norwich,1,0,99,4,1.4,4,8,1.5,3.8,7';
  const dup = prepare(archive, recent, names, [source(`${header}\n${row}\n${row}`)]);
  assert.equal(dup.quotes.rows.length, 0); assert.equal(dup.audit.skipped[0].reason, 'ambiguous_csv_rows');
});
test('conflicting duplicate Understat match fails closed', () => {
  assert.throws(() => prepare([{ ...archive[0], matchId: 'understat_1', homeGoals: 9 }], recent, names, []), /overlap_match_conflict/);
});
test('declared historical season is retained across calendar-year boundary', () => {
  const late = [{ ...archive[0], season: '2019/2020', date: '2020-07-10T14:00:00.000Z' }];
  assert.equal(prepare(late, recent, names, []).history.find(x => x.matchId === 'understat_2').season, '2019/2020');
});
test('future incomplete fixtures are ignored, incomplete in-scope results fail', () => {
  const future = { ...recent[0], matchId: 'understat_3', date: '2026-08-01T14:00:00.000Z', homeGoals: null, awayGoals: null };
  const r = prepare(archive, [...recent, future], names, []);
  assert.equal(r.history.some(x => x.matchId === future.matchId), false);
  assert.throws(() => prepare(archive, [{ ...recent[0], homeGoals: null }], names, []), /invalid_understat_record/);
});
test('existing snapshot statistics are marked origin unverified, not Understat', () => {
  const r = prepare(archive, recent, names, []);
  assert.equal(r.audit.fieldProvenance.understat_1.homeTotalShots, 'existing_snapshot_field_origin_unverified');
  assert.equal(r.audit.fieldProvenance.understat_1.homeXG, 'understat_recent_snapshot_declared');
});
test('CSV paths resolve relative to project root, manifest directory, or absolute path', () => {
  const root = path.resolve(__dirname, '../../..');
  const manifest = path.join(root, 'temporary', 'manifest.json');
  assert.equal(resolveCsvPath('backend/artifacts/input.csv', manifest), path.join(root, 'backend', 'artifacts', 'input.csv'));
  assert.equal(resolveCsvPath('input.csv', manifest), path.join(root, 'temporary', 'input.csv'));
  assert.equal(resolveCsvPath(path.join(root, 'absolute.csv'), manifest), path.join(root, 'absolute.csv'));
});
test('verified historical alias pairs match while preserving original names and team IDs', () => {
  const aliases = [['SD Huesca', 'Huesca'], ['SPAL 2013', 'Spal'], ['Fortuna Duesseldorf', 'Fortuna Dusseldorf'],
    ['Nuernberg', 'Nurnberg'], ['Hannover 96', 'Hannover'], ['West Bromwich Albion', 'West Brom'],
    ['Arminia Bielefeld', 'Bielefeld'], ['Greuther Fuerth', 'Greuther Furth']];
  for (const [understat, csv] of aliases) {
    const r = prepare([{ ...archive[0], homeTeamName: understat }], recent, names,
      [source(`${header}\n07/08/21,${csv},Norwich,1,0,99,4,1.4,4,8,1.5,3.8,7`)]);
    assert.equal(r.quotes.rows.length, 1, `${understat} / ${csv}`);
    assert.equal(r.history.find(x => x.matchId === 'understat_2').homeTeamName, understat);
  }
});
test('historical alias collisions are rejected, not guessed', () => {
  const a = [{ ...archive[0], homeTeamName: 'SD Huesca' },
    { ...archive[0], matchId: 'understat_3', homeTeamName: 'Huesca', homeTeamId: 'understat_other' }];
  const r = prepare(a, recent, names, [source(`${header}\n07/08/21,Huesca,Norwich,1,0,99,4,1.4,4,8,1.5,3.8,7`)]);
  assert.equal(r.quotes.rows.length, 0);
  assert.equal(r.audit.skipped[0].reason, 'ambiguous_understat_match');
});
