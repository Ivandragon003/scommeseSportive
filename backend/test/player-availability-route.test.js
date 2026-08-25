const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const {
  createApiRouter,
  buildProviderSquadReconciliationPlan,
  buildConfirmedStatusRows,
  matchUniquePlayerByName,
  officialFormationFromRows,
} = require('../dist/api/routes.js');

test('piano rosa sposta i trasferiti noti, conserva il ruolo provider e registra identita nuove', () => {
  const currentPlayers = Array.from({ length: 10 }, (_, index) => ({
    player_id: `current-${index}`, name: `Current ${index}`, team_id: 'home', position_code: 'MF',
  }));
  const transferred = { player_id: 'understat_player_999', source_player_id: 999, name: 'Known Transfer', team_id: 'old', position_code: 'MF' };
  const squad = [
    ...currentPlayers.map((player, index) => ({ id: 100 + index, name: player.name, position: index === 0 ? 'Goalkeeper' : 'Defender' })),
    { id: 9999, name: 'Known Transfer', position: 'Attacker' },
    { id: 7777, name: 'Brand New', position: 'Midfielder' },
  ];
  const plan = buildProviderSquadReconciliationPlan({
    teamId: 'home', currentPlayers, allPlayers: [...currentPlayers, transferred], squad,
  });
  assert.equal(plan.safeToApply, true);
  assert.equal(plan.coverage, 1);
  assert.equal(plan.resolved.find((player) => player.name === 'Known Transfer').playerId, transferred.player_id);
  assert.equal(plan.resolved.find((player) => player.name === 'Known Transfer').positionCode, 'Attacker');
  assert.deepEqual(
    plan.resolved.find((player) => player.name === 'Brand New'),
    {
      playerId: 'api_football_player_7777', positionCode: 'Midfielder', isNew: true,
      name: 'Brand New', providerId: 7777,
    },
  );
});

test('piano rosa rifiuta una risposta provider corta prima di disattivare giocatori', () => {
  const squad = Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `Player ${index}`, position: 'MF' }));
  const plan = buildProviderSquadReconciliationPlan({
    teamId: 'home', currentPlayers: [], allPlayers: [], squad,
  });
  assert.equal(plan.safeToApply, false);
  assert.equal(plan.resolved.length, 10);
});

let playerSequence = 1;
const makePlayer = (name, position, minutes) => ({
  player_id: `understat_player_${playerSequence++}`, name, team_id: 'home',
  position_code: position, avg_minutes: minutes, games_played: 12, is_available: 1,
});
const players = [
  makePlayer('Portiere', 'GK', 90),
  ...Array.from({ length: 5 }, (_, i) => makePlayer(`DF ${i + 1}`, 'DF', 80 - i)),
  ...Array.from({ length: 5 }, (_, i) => makePlayer(`MF ${i + 1}`, 'MF', 78 - i)),
  ...Array.from({ length: 4 }, (_, i) => makePlayer(`FW ${i + 1}`, 'FW', 76 - i)),
];

const history = Array.from({ length: 5 }, (_, index) => ({
  match_id: `past-${index}`,
  date: `2026-08-${String(10 + index).padStart(2, '0')}T20:00:00Z`,
  home_team_id: 'home', away_team_id: 'past-away', home_goals: 1, away_goals: 0,
  raw_json: JSON.stringify({ details: { rosters: { h: Object.fromEntries(
    players.slice(0, 11).map((player) => [player.player_id, {
      player_id: player.player_id.replace('understat_player_', ''),
      player: player.name,
      position: player.position_code,
      roster_in: 0,
    }])
  ), a: {} } } }),
}));

test('GET player-availability restituisce undici probabili titolari e rimuove gli indisponibili', async () => {
  const app = express();
  app.use(express.json());
  const awayPlayers = players.map((player) => ({ ...player, player_id: `a-${player.player_id}`, team_id: 'away' }));
  const requestedHistoryLimits = [];
  app.use('/api', createApiRouter({
    db: {
      getMatchById: async () => ({
        match_id: 'future', date: '2026-08-25T20:00:00Z',
        home_team_id: 'home', away_team_id: 'away', home_team_name: 'Home', away_team_name: 'Away',
      }),
      getPlayersByTeam: async (teamId) => teamId === 'home' ? players : awayPlayers,
      getPlayerLineupStatuses: async () => [{
        player_id: players[1].player_id, team_id: 'home', status: 'unavailable', probability: 0,
        source: 'api_football_injury', fetched_at: '2026-08-25T08:00:00Z',
      }],
      getRecentCompletedMatchesForTeam: async (teamId, _before, limit) => {
        requestedHistoryLimits.push(limit);
        return teamId === 'home' ? history : [];
      },
    },
    svc: {},
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/player-availability/future`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.home.length, 11);
    assert.equal(body.data.home.some((player) => player.playerId === players[1].player_id), false);
    assert.equal(body.data.home.filter((player) => player.status === 'predicted_starter').length, 11);
    assert.equal(body.data.homeFormation !== null, true);
    assert.equal(body.data.homeHistoryMatchesUsed, 5);
    assert.deepEqual(requestedHistoryLimits, [20, 20]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('formazione ufficiale salva solo i nomi restituiti e prevale su un infortunio stale', () => {
  const teamPlayers = players.slice(0, 15);
  const unavailableId = teamPlayers[14].player_id;
  const lineup = {
    formation: '4-3-3',
    players: teamPlayers.slice(0, 11).map((player) => ({
      name: player.name, starter: true, position: player.position_code,
    })),
  };
  const rows = buildConfirmedStatusRows({
    matchId: 'm1', teamPlayers, lineup, unavailableIds: new Set([unavailableId]),
    providerFixtureId: 'f1', kickoffAt: '2026-08-25T20:00:00Z',
  });
  assert.equal(rows.filter((row) => row.status === 'confirmed_starter').length, 11);
  assert.equal(rows.filter((row) => row.status === 'confirmed_bench').length, 0);
  assert.equal(rows.length, 11);
  assert.equal(rows.some((row) => row.playerId === unavailableId), false);
  assert.equal(rows.every((row) => row.source === 'api_football_confirmed'), true);

  const staleInjuryStarter = buildConfirmedStatusRows({
    matchId: 'm2', teamPlayers, lineup: {
      formation: '4-3-3',
      players: [{ name: teamPlayers[0].name, starter: true, position: teamPlayers[0].position_code }],
    },
    unavailableIds: new Set([teamPlayers[0].player_id]),
    providerFixtureId: 'f2',
  });
  assert.equal(staleInjuryStarter[0].status, 'confirmed_starter');
});

test('matching giocatori rifiuta un cognome ambiguo invece di assegnarlo al primo risultato', () => {
  const candidates = [{ name: 'Luca Rossi' }, { name: 'Marco Rossi' }];
  assert.equal(matchUniquePlayerByName(candidates, 'Rossi'), null);
  assert.equal(matchUniquePlayerByName(candidates, 'Luca Rossi'), candidates[0]);
});

test('la formazione mostrata per un XI ufficiale viene letta dallo snapshot provider', () => {
  const rows = [{
    team_id: 'home', status: 'confirmed_starter',
    raw_json: JSON.stringify({ lineup: { formation: '3-5-2' } }),
  }];
  assert.equal(officialFormationFromRows(rows, 'home'), '3-5-2');
  assert.equal(officialFormationFromRows(rows, 'away'), null);
});

test('refresh vicino al kickoff salva arbitro, indisponibili e formazione ufficiale', async () => {
  const kickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const awayPlayers = players.map((player) => ({ ...player, player_id: `away-${player.player_id}`, team_id: 'away' }));
  const saved = [];
  let referee = null;
  let fixtureCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getMatchById: async () => ({
        match_id: 'future', date: kickoff, home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home FC', away_team_name: 'Away FC',
      }),
      getPlayersByTeam: async (teamId) => teamId === 'home' ? players : awayPlayers,
      getPlayerLineupStatuses: async () => [],
      getRecentCompletedMatchesForTeam: async (teamId) => teamId === 'home' ? history : [],
      fillMatchReferee: async (_matchId, value) => { referee = value; return true; },
      replacePlayerInjuryStatuses: async ({ rows }) => { saved.push(...rows); },
      savePlayerLineupStatuses: async (rows) => { saved.push(...rows); },
    },
    svc: {},
    apiFootballService: {
      enabled: true,
      getFixturesByDate: async () => { fixtureCalls += 1; return [{
        id: 77, date: kickoff, homeName: 'Home FC', awayName: 'Away FC',
        homeProviderTeamId: 1, awayProviderTeamId: 2, referee: 'Rossi',
      }]; },
      getInjuries: async () => [{ team: { name: 'Home FC' }, player: { name: players[14].name }, type: 'Suspended' }],
      getConfirmedLineups: async () => [
        { teamId: 1, teamName: 'Home FC', formation: '4-3-3', players: players.slice(0, 11).map((p) => ({ name: p.name, starter: true, position: p.position_code })) },
        { teamId: 2, teamName: 'Away FC', formation: '4-4-2', players: awayPlayers.slice(0, 11).map((p) => ({ name: p.name, starter: true, position: p.position_code })) },
      ],
      getSquad: async () => [],
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/player-availability/refresh/future`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.officialLineups, 2);
    assert.equal(referee, 'Rossi');
    assert.equal(saved.some((row) => row.status === 'unavailable' && row.playerId === players[14].player_id), true);
    assert.equal(saved.some((row) => row.status === 'confirmed_starter'), true);
    const second = await fetch(`http://127.0.0.1:${port}/api/player-availability/refresh/future`, { method: 'POST' });
    const secondBody = await second.json();
    assert.equal(secondBody.skipped, 'refresh_cooldown');
    assert.equal(fixtureCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('refresh injury vuoto rimuove una vecchia indisponibilita prima di rigenerare la formazione', async () => {
  const kickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const awayPlayers = players.map((player) => ({ ...player, player_id: `recovery-away-${player.player_id}`, team_id: 'away' }));
  const recoveredId = players[1].player_id;
  let statuses = [{
    player_id: recoveredId, team_id: 'home', status: 'unavailable', probability: 0,
    source: 'api_football_injury', fetched_at: new Date().toISOString(), raw_json: null,
  }];
  const saved = [];
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getMatchById: async () => ({
        match_id: 'recovery', date: kickoff,
        home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home FC', away_team_name: 'Away FC',
      }),
      getPlayersByTeam: async (teamId) => teamId === 'home' ? players : awayPlayers,
      getPlayerLineupStatuses: async () => statuses,
      getRecentCompletedMatchesForTeam: async (teamId) => teamId === 'home' ? history : [],
      fillMatchReferee: async () => true,
      replacePlayerInjuryStatuses: async ({ rows }) => {
        statuses = rows.map((row) => ({
          player_id: row.playerId, team_id: row.teamId, status: row.status,
          probability: row.probability, source: row.source, fetched_at: new Date().toISOString(), raw_json: null,
        }));
      },
      savePlayerLineupStatuses: async (rows) => { saved.push(...rows); },
    },
    svc: {},
    apiFootballService: {
      enabled: true,
      getFixturesByDate: async () => [{ id: 89, date: kickoff, homeName: 'Home FC', awayName: 'Away FC', referee: null }],
      getInjuries: async () => [],
      getConfirmedLineups: async () => [],
      getSquad: async () => [],
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/player-availability/refresh/recovery`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(statuses.length, 0);
    assert.equal(saved.some((row) => row.playerId === recoveredId && row.status === 'predicted_starter'), true);
    assert.equal(body.providerWarnings.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('refresh mantiene la formazione locale se injury e lineup provider falliscono dopo il match fixture', async () => {
  const kickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const awayPlayers = players.map((player) => ({ ...player, player_id: `provider-down-away-${player.player_id}`, team_id: 'away' }));
  const saved = [];
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getMatchById: async () => ({
        match_id: 'provider-down', date: kickoff,
        home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home FC', away_team_name: 'Away FC',
      }),
      getPlayersByTeam: async (teamId) => teamId === 'home' ? players : awayPlayers,
      getPlayerLineupStatuses: async () => [],
      getRecentCompletedMatchesForTeam: async (teamId) => teamId === 'home' ? history : [],
      fillMatchReferee: async () => true,
      savePlayerLineupStatuses: async (rows) => { saved.push(...rows); },
    },
    svc: {},
    apiFootballService: {
      enabled: true,
      getFixturesByDate: async () => [{
        id: 88, date: kickoff, homeName: 'Home FC', awayName: 'Away FC',
        homeProviderTeamId: 1, awayProviderTeamId: 2, referee: 'Verdi',
      }],
      getInjuries: async () => { throw new Error('injury endpoint down'); },
      getConfirmedLineups: async () => { throw new Error('lineup endpoint down'); },
      getSquad: async () => [],
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/player-availability/refresh/provider-down`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.source, 'last_five_lineup_model');
    assert.equal(body.providerWarnings.length, 2);
    assert.ok(body.predictedSaved >= 22);
    assert.ok(saved.some((row) => row.status === 'predicted_starter'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('sync manuale condivide il cooldown e non interroga due volte il provider', async () => {
  const kickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  let lineupCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getMatchById: async () => ({
        match_id: 'manual-sync', date: kickoff,
        home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home FC', away_team_name: 'Away FC',
      }),
      getPlayersByTeam: async () => players,
      savePlayerLineupStatuses: async () => undefined,
    },
    svc: {},
    apiFootballService: {
      enabled: true,
      getConfirmedLineups: async () => { lineupCalls += 1; return []; },
      getFixturesByDate: async () => [], getInjuries: async () => [], getSquad: async () => [],
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const request = () => fetch(`http://127.0.0.1:${port}/api/player-availability/sync`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ matchId: 'manual-sync', fixtureId: 'provider-99' }),
    }).then((response) => response.json());
    const first = await request();
    const second = await request();
    assert.equal(first.success, true);
    assert.equal(second.skipped, 'refresh_cooldown');
    assert.equal(lineupCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('refresh dopo il kickoff non interroga API-Football', async () => {
  const kickoff = new Date(Date.now() - 60_000).toISOString();
  let fixtureCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getMatchById: async () => ({
        match_id: 'past', date: kickoff, home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home FC', away_team_name: 'Away FC',
      }),
      getPlayerLineupStatuses: async () => [],
    },
    svc: {},
    apiFootballService: {
      enabled: true,
      getFixturesByDate: async () => { fixtureCalls += 1; return []; },
      getInjuries: async () => [], getConfirmedLineups: async () => [], getSquad: async () => [],
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/player-availability/refresh/past`, { method: 'POST' });
    const body = await response.json();
    assert.equal(body.skipped, 'outside_official_lineup_window');
    assert.equal(fixtureCalls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('sync-upcoming salva la previsione locale anche con API-Football disabilitata', async () => {
  const kickoff = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();
  const awayPlayers = players.map((player) => ({ ...player, player_id: `local-away-${player.player_id}`, team_id: 'away' }));
  const saved = [];
  let providerCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getMatchById: async () => ({
        match_id: 'local-fallback', date: kickoff,
        home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home FC', away_team_name: 'Away FC',
      }),
      getUpcomingMatches: async () => [{
        match_id: 'local-fallback', date: kickoff,
        home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home FC', away_team_name: 'Away FC',
      }],
      getPlayersByTeam: async (teamId) => teamId === 'home' ? players : awayPlayers,
      getPlayerLineupStatuses: async () => [],
      getRecentCompletedMatchesForTeam: async (teamId) => teamId === 'home' ? history : [],
      savePlayerLineupStatuses: async (rows) => { saved.push(...rows); },
    },
    svc: {},
    apiFootballService: {
      enabled: false,
      getFixturesByDate: async () => { providerCalls += 1; return []; },
      getInjuries: async () => { providerCalls += 1; return []; },
      getConfirmedLineups: async () => { providerCalls += 1; return []; },
      getSquad: async () => { providerCalls += 1; return []; },
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/player-availability/sync-upcoming`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.enabled, false);
    assert.equal(body.checked, 1);
    assert.ok(body.predictedSaved >= 22);
    assert.ok(saved.some((row) => row.status === 'predicted_starter'));
    assert.equal(saved.every((row) => row.providerFixtureId === null), true);
    assert.equal(providerCalls, 0);

  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('refresh usa il fallback locale quando API-Football non abbina la fixture', async () => {
  const kickoff = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const awayPlayers = players.map((player) => ({ ...player, player_id: `missing-away-${player.player_id}`, team_id: 'away' }));
  const saved = [];
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getMatchById: async () => ({
        match_id: 'fixture-missing', date: kickoff,
        home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home FC', away_team_name: 'Away FC',
      }),
      getPlayersByTeam: async (teamId) => teamId === 'home' ? players : awayPlayers,
      getPlayerLineupStatuses: async () => [],
      getRecentCompletedMatchesForTeam: async (teamId) => teamId === 'home' ? history : [],
      savePlayerLineupStatuses: async (rows) => { saved.push(...rows); },
    },
    svc: {},
    apiFootballService: {
      enabled: true,
      getFixturesByDate: async () => [],
      getInjuries: async () => [], getConfirmedLineups: async () => [], getSquad: async () => [],
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/player-availability/refresh/fixture-missing`, { method: 'POST' });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.skipped, 'fixture_not_matched');
    assert.equal(body.source, 'last_five_lineup_model');
    assert.ok(body.saved >= 22);
    assert.ok(saved.some((row) => row.status === 'predicted_starter'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('refresh locale concorrente crea un solo batch grazie al cooldown condiviso', async () => {
  const kickoff = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
  const awayPlayers = players.map((player) => ({ ...player, player_id: `race-away-${player.player_id}`, team_id: 'away' }));
  let saveCalls = 0;
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({
    db: {
      getMatchById: async () => ({
        match_id: 'local-race', date: kickoff,
        home_team_id: 'home', away_team_id: 'away',
        home_team_name: 'Home FC', away_team_name: 'Away FC',
      }),
      getPlayersByTeam: async (teamId) => teamId === 'home' ? players : awayPlayers,
      getPlayerLineupStatuses: async () => [],
      getRecentCompletedMatchesForTeam: async (teamId) => teamId === 'home' ? history : [],
      savePlayerLineupStatuses: async () => { saveCalls += 1; },
    },
    svc: {},
    apiFootballService: {
      enabled: false,
      getFixturesByDate: async () => [], getInjuries: async () => [],
      getConfirmedLineups: async () => [], getSquad: async () => [],
    },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  try {
    const responses = await Promise.all([1, 2].map(() => fetch(
      `http://127.0.0.1:${port}/api/player-availability/refresh/local-race`, { method: 'POST' },
    ).then((response) => response.json())));
    assert.equal(responses.filter((body) => body.skipped === 'refresh_cooldown').length, 1);
    assert.equal(responses.filter((body) => body.source === 'last_five_lineup_model').length, 1);
    assert.equal(saveCalls, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
