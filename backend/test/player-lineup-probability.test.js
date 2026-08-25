const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assessPlayerLineup,
  buildPredictedLineup,
  completeOfficialTeamIds,
  extractOfficialLineupHistory,
  estimateStartingProbability,
  retainCompleteOfficialLineupRows,
} = require('../dist/services/PlayerLineupProbabilityService.js');

test('la formazione ufficiale prevale sul modello storico', () => {
  const result = assessPlayerLineup(
    { avg_minutes: 20, games_played: 3 },
    { status: 'confirmed_starter', probability: 1 },
  );
  assert.equal(result.probability, 1);
  assert.equal(result.tier, 'confirmed_starter');
  assert.deepEqual(result.warnings, []);
});

test('il modello distingue titolare probabile e ballottaggio', () => {
  const regular = assessPlayerLineup({ avg_minutes: 86, games_played: 15 });
  const rotation = assessPlayerLineup({ avg_minutes: 60, games_played: 8 });
  assert.equal(regular.tier, 'probable_starter');
  assert.equal(rotation.tier, 'ballotaggio');
  assert.ok(regular.probability > rotation.probability);
});

test('campione e minuti troppo bassi producono una probabilità prudente', () => {
  assert.ok(estimateStartingProbability({ avg_minutes: 25, games_played: 2 }) < 0.70);
  const result = assessPlayerLineup({ avg_minutes: 25, games_played: 2 });
  assert.equal(result.tier, 'uncertain');
  assert.ok(result.warnings.includes('lineup_modelled_not_confirmed'));
});

test('panchina e indisponibilità bloccano la player bet', () => {
  assert.equal(assessPlayerLineup({}, { status: 'confirmed_bench', probability: 0 }).tier, 'confirmed_bench');
  assert.equal(assessPlayerLineup({}, { status: 'predicted_bench', probability: 0.25 }).tier, 'uncertain');
  assert.equal(assessPlayerLineup({}, { status: 'unavailable', probability: 0 }).tier, 'unavailable');
});

test('una formazione provider diventa autoritativa solo con undici titolari unici abbinati', () => {
  const partial = Array.from({ length: 10 }, (_, index) => ({
    player_id: `p${index}`, team_id: 'team-a', status: 'confirmed_starter',
  }));
  assert.equal(completeOfficialTeamIds(partial).has('team-a'), false);
  assert.deepEqual(retainCompleteOfficialLineupRows(partial), []);

  const complete = [...partial, { player_id: 'p10', team_id: 'team-a', status: 'confirmed_starter' }];
  assert.equal(completeOfficialTeamIds(complete).has('team-a'), true);
  assert.equal(retainCompleteOfficialLineupRows(complete).length, 11);

  const oversized = [...complete, { player_id: 'p11', team_id: 'team-a', status: 'confirmed_starter' }];
  assert.equal(completeOfficialTeamIds(oversized).has('team-a'), false);
  assert.deepEqual(retainCompleteOfficialLineupRows(oversized), []);
});

const makePlayers = () => [
  { player_id: 'gk1', name: 'Portiere Uno', position_code: 'GK', avg_minutes: 90, games_played: 12 },
  { player_id: 'gk2', name: 'Portiere Due', position_code: 'GK', avg_minutes: 8, games_played: 2 },
  ...Array.from({ length: 5 }, (_, index) => ({ player_id: `df${index + 1}`, name: `Difensore ${index + 1}`, position_code: 'DF', avg_minutes: 80 - index, games_played: 12 })),
  ...Array.from({ length: 5 }, (_, index) => ({ player_id: `mf${index + 1}`, name: `Centrocampista ${index + 1}`, position_code: 'MF', avg_minutes: 78 - index, games_played: 12 })),
  ...Array.from({ length: 4 }, (_, index) => ({ player_id: `fw${index + 1}`, name: `Attaccante ${index + 1}`, position_code: 'FW', avg_minutes: 76 - index, games_played: 12 })),
];

test('la probabile formazione usa solo le ultime cinque ufficiali, esclude indisponibili e completa i ruoli dal depth chart', () => {
  const players = makePlayers();
  const history = [];
  for (let match = 1; match <= 6; match++) {
    const playedAt = `2026-08-${String(20 - match).padStart(2, '0')}T20:00:00Z`;
    for (const player of players.filter((candidate) => candidate.player_id !== 'gk2').slice(0, 11)) {
      history.push({ matchId: `m${match}`, playerId: player.player_id, status: 'confirmed_starter', playedAt });
    }
  }
  // df1 sarebbe il favorito storico, ma è squalificato/infortunato per questa gara.
  const result = buildPredictedLineup(players, history, new Set(['df1']));
  assert.equal(result.historyMatchesUsed, 5);
  assert.equal(result.starters.length, 11);
  assert.equal(result.starters.some((player) => player.playerId === 'df1'), false);
  assert.equal(result.starters.filter((player) => player.positionGroup === 'GK').length, 1);
  assert.equal(result.incomplete, false);
  assert.ok(result.starters.every((player) => player.status === 'predicted_starter'));
});

test('la probabile formazione non inventa un portiere e dichiara il risultato incompleto', () => {
  const players = makePlayers().filter((player) => player.position_code !== 'GK');
  const result = buildPredictedLineup(players, [], new Set());
  assert.equal(result.incomplete, true);
  assert.equal(result.starters.some((player) => player.positionGroup === 'GK'), false);
  assert.ok(result.warnings.includes('lineup_missing_goalkeeper'));
});

test('estrae i titolari solo dalle ultime cinque partite precedenti senza leakage temporale', () => {
  const matches = Array.from({ length: 7 }, (_, index) => ({
    match_id: `m${index + 1}`,
    date: `2026-08-${String(index + 1).padStart(2, '0')}T20:00:00Z`,
    home_team_id: 'team-a',
    away_team_id: 'team-b',
    home_goals: 1,
    away_goals: 0,
    raw_json: JSON.stringify({ details: { rosters: { h: {
      starter: { player_id: 10, player: 'Starter', position: 'F', roster_in: 0 },
      substitute: { player_id: 11, player: 'Sub', position: 'F', roster_in: 65 },
    }, a: {} } } }),
  }));
  matches.push({ ...matches[0], match_id: 'future', date: '2026-09-01T20:00:00Z' });
  const rows = extractOfficialLineupHistory(matches, 'team-a', '2026-08-20T20:00:00Z');
  assert.deepEqual([...new Set(rows.map((row) => row.matchId))], ['m7', 'm6', 'm5', 'm4', 'm3']);
  assert.equal(rows.find((row) => row.playerId === 'understat_player_10').status, 'confirmed_starter');
  assert.equal(rows.find((row) => row.playerId === 'understat_player_11').status, 'confirmed_bench');
  assert.equal(rows.some((row) => row.matchId === 'future'), false);
});

test('salta le gare senza roster e usa le ultime cinque formazioni realmente disponibili', () => {
  const withRoster = Array.from({ length: 5 }, (_, index) => ({
    match_id: `roster-${index}`,
    date: `2026-07-${String(10 + index).padStart(2, '0')}T20:00:00Z`,
    home_team_id: 'team-a', away_team_id: 'team-b', home_goals: 1, away_goals: 0,
    raw_json: JSON.stringify({ details: { rosters: { h: {
      starter: { player_id: index + 1, player: `Starter ${index}`, position: 'F', roster_in: 0 },
    }, a: {} } } }),
  }));
  const withoutRoster = Array.from({ length: 4 }, (_, index) => ({
    match_id: `empty-${index}`,
    date: `2026-08-${String(10 + index).padStart(2, '0')}T20:00:00Z`,
    home_team_id: 'team-a', away_team_id: 'team-b', home_goals: 1, away_goals: 0,
    raw_json: JSON.stringify({ details: {} }),
  }));
  const rows = extractOfficialLineupHistory([...withoutRoster, ...withRoster], 'team-a', '2026-08-20T20:00:00Z', 5);
  assert.deepEqual([...new Set(rows.map((row) => row.matchId))], [
    'roster-4', 'roster-3', 'roster-2', 'roster-1', 'roster-0',
  ]);
});
