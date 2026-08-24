const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService, MatchBatchCommitError } = require('../dist/db/DatabaseService.js');
const { OddsApiProvider } = require('../dist/services/odds-provider/OddsApiProvider.js');
const {
  hasUnderstatRawJsonDetails,
  hasUnderstatMatchUpsertChange,
  preserveUnderstatRichRawJson,
  shouldRebuildUnderstatPlayers,
} = require('../dist/api/routes.js');

test('appendPredictions invia l intero audit append-only in un unico batch write atomico', async () => {
  const batches = [];
  const db = Object.create(DatabaseService.prototype);
  db.initPromise = Promise.resolve();
  db.db = {
    async batch(statements, mode) {
      batches.push({ statements, mode });
    },
  };

  await db.appendPredictions([
    {
      predictionId: 'prediction-1', matchId: 'match-1', market: '1x2', selection: 'homeWin',
      rawProbability: 0.51, loggingFlags: {
        hasFullMarketLogging: true, hasImmutabilityEnforced: true,
        hasGenericVoidHandling: true, hasConfigurableThresholds: true,
      },
    },
    {
      predictionId: 'prediction-2', matchId: 'match-1', market: 'goal', selection: 'over2_5',
      rawProbability: 0.61, loggingFlags: {
        hasFullMarketLogging: true, hasImmutabilityEnforced: true,
        hasGenericVoidHandling: true, hasConfigurableThresholds: true,
      },
    },
  ]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].mode, 'write');
  assert.equal(batches[0].statements.length, 2);
  assert.equal(batches[0].statements[0].args.predictionId, 'prediction-1');
  assert.equal(batches[0].statements[1].args.predictionId, 'prediction-2');
});

test('upsertMatches usa un batch write e non emette scritture per un array vuoto', async () => {
  const batches = [];
  const db = Object.create(DatabaseService.prototype);
  db.initPromise = Promise.resolve();
  db.db = { async batch(statements, mode) { batches.push({ statements, mode }); } };

  await db.upsertMatches([]);
  await db.upsertMatches([{ matchId: 'understat_1', homeTeamId: 'h', awayTeamId: 'a', date: '2026-04-25T18:45:00.000Z' }]);

  assert.equal(batches.length, 1);
  assert.equal(batches[0].mode, 'write');
  assert.equal(batches[0].statements.length, 1);
});

test('upsertMatches rende osservabile il prefisso committato se un chunk successivo fallisce', async () => {
  const db = Object.create(DatabaseService.prototype);
  db.initPromise = Promise.resolve();
  let calls = 0;
  db.db = {
    async batch() {
      calls += 1;
      if (calls === 2) throw new Error('second chunk failed');
    },
  };
  const rows = Array.from({ length: 3 }, (_, index) => ({
    matchId: `understat_${index}`, homeTeamId: 'h', awayTeamId: 'a', date: '2026-04-25T18:45:00.000Z',
  }));

  await assert.rejects(
    () => db.upsertMatches(rows, 2),
    (error) => error instanceof MatchBatchCommitError && error.committedCount === 2 && /second chunk failed/.test(error.message)
  );
});

test('OddsApiProvider blocca subito i retry dopo una risposta 401 o 403', async () => {
  const provider = new OddsApiProvider('cooldown-key-one');
  let calls = 0;
  provider.service = {
    getRemainingRequests: () => 499,
    async getOdds() {
      calls += 1;
      throw { response: { status: 401 }, message: 'Unauthorized' };
    },
  };

  const request = { competition: 'Serie A', markets: ['h2h'] };
  await assert.rejects(() => provider.getCompetitionOdds(request));
  await assert.rejects(() => provider.getCompetitionOdds(request));
  assert.equal(calls, 1);
});

test('OddsApiProvider non condivide il cooldown auth con una chiave API diversa', async () => {
  const rejectedProvider = new OddsApiProvider('cooldown-key-isolated-one');
  rejectedProvider.service = {
    getRemainingRequests: () => 499,
    async getOdds() { throw { response: { status: 403 }, message: 'Forbidden' }; },
  };
  await assert.rejects(() => rejectedProvider.getCompetitionOdds({ competition: 'Serie A', markets: ['h2h'] }));

  let calls = 0;
  const independentProvider = new OddsApiProvider('cooldown-key-isolated-two');
  independentProvider.service = {
    getRemainingRequests: () => 498,
    async getOdds() {
      calls += 1;
      return [];
    },
  };
  await independentProvider.getCompetitionOdds({ competition: 'Serie A', markets: ['h2h'] });
  assert.equal(calls, 1);
});

test('OddsApiProvider limita e pruna il cooldown cache senza perdere isolamento per chiave', () => {
  OddsApiProvider.authCooldowns.clear();
  OddsApiProvider.authCooldowns.set('expired', { until: 0, message: 'expired' });
  for (let index = 0; index <= 100; index += 1) {
    const provider = new OddsApiProvider(`bounded-cooldown-key-${index}`);
    provider.startAuthCooldown('Serie A', { response: { status: 401 } });
  }
  assert.equal(OddsApiProvider.authCooldowns.has('expired'), false);
  assert.ok(OddsApiProvider.authCooldowns.size <= 100);
  OddsApiProvider.authCooldowns.clear();
});

test('Understat invariato non richiede un upsert, ma rileva solo campi che il COALESCE puo aggiornare', () => {
  const existing = {
    match_id: 'understat_1', home_team_id: 'home', away_team_id: 'away',
    home_team_name: 'Home', away_team_name: 'Away', date: '2026-04-25T18:45:00.000Z',
    home_goals: 1, away_goals: 0, home_xg: 1.2, away_xg: 0.8,
    home_shots: 11, away_shots: 7, home_shots_on_target: 4, away_shots_on_target: 2,
    home_possession: null, away_possession: null, home_fouls: null, away_fouls: null,
    home_yellow_cards: 2, away_yellow_cards: 1, home_red_cards: 0, away_red_cards: 0,
    home_corners: null, away_corners: null, referee: null, competition: 'Serie A',
    season: '2025/2026', source: 'understat', source_match_id: '1', raw_json: '{"id":1}',
  };
  const unchanged = {
    matchId: 'understat_1', homeTeamId: 'home', awayTeamId: 'away',
    homeTeamName: 'Home', awayTeamName: 'Away', date: new Date(existing.date),
    homeGoals: 1, awayGoals: 0, homeXG: 1.2, awayXG: 0.8,
    homeTotalShots: 11, awayTotalShots: 7, homeShotsOnTarget: 4, awayShotsOnTarget: 2,
    homePossession: null, awayPossession: null, homeFouls: null, awayFouls: null,
    homeYellowCards: 2, awayYellowCards: 1, homeRedCards: 0, awayRedCards: 0,
    homeCorners: null, awayCorners: null, referee: null, competition: 'Serie A',
    season: '2025/2026', source: 'understat', sourceMatchId: '1', rawJson: '{"id":1}',
  };

  assert.equal(hasUnderstatMatchUpsertChange(existing, unchanged), false);
  assert.equal(hasUnderstatMatchUpsertChange(existing, { ...unchanged, homeXG: 1.3 }), true);
  assert.equal(hasUnderstatMatchUpsertChange(existing, { ...unchanged, homePossession: 55 }), true);
  assert.equal(hasUnderstatMatchUpsertChange(existing, { ...unchanged, homePossession: null }), false);
});

test('Understat non degrada raw_json ricco con payload base o non valido, ma accetta un nuovo dettaglio ricco', () => {
  const existingRich = { raw_json: JSON.stringify({
    match: { id: 1 },
    details: { rosters: { h: {}, a: {} }, shots: { h: [], a: [] } },
  }) };
  const base = { rawJson: JSON.stringify({ match: { id: 1 } }) };
  const invalid = { rawJson: '{non-json' };
  const richer = { rawJson: JSON.stringify({
    match: { id: 1 },
    details: { rosters: { h: { player: {} }, a: {} }, shots: { h: [], a: [] } },
  }) };

  const protectedBase = preserveUnderstatRichRawJson(existingRich, base);
  const protectedInvalid = preserveUnderstatRichRawJson(existingRich, invalid);
  assert.equal(protectedBase.rawJson, null);
  assert.equal(protectedInvalid.rawJson, null);
  assert.equal(hasUnderstatMatchUpsertChange(existingRich, protectedBase), false);
  assert.equal(hasUnderstatMatchUpsertChange(existingRich, protectedInvalid), false);
  assert.equal(preserveUnderstatRichRawJson({ raw_json: JSON.stringify({ match: { id: 1 } }) }, richer).rawJson, richer.rawJson);
  assert.equal(hasUnderstatMatchUpsertChange(existingRich, richer), true);
});

test('Understat considera ricco solo un payload details strutturalmente valido', () => {
  const existingRich = { raw_json: JSON.stringify({
    match: { id: 1 },
    details: { rosters: { h: {}, a: {} }, shots: { h: [], a: [] } },
  }) };
  const malformedDetails = { rawJson: JSON.stringify({ match: { id: 1 }, details: {} }) };
  const validDetails = { rawJson: JSON.stringify({
    match: { id: 1 },
    details: { rosters: { h: {}, a: {} }, shots: { h: [], a: [] } },
  }) };

  assert.equal(hasUnderstatRawJsonDetails(malformedDetails.rawJson), false);
  assert.equal(hasUnderstatRawJsonDetails(validDetails.rawJson), true);
  assert.equal(preserveUnderstatRichRawJson(existingRich, malformedDetails).rawJson, null);
});

test('snapshot odds_api senza bookmaker selezionato non entra nello storico backtest', async () => {
  const db = Object.create(DatabaseService.prototype);
  db.all = async () => [{
    match_id: 'legacy-odds-api',
    source: 'odds_api',
    selected_bookmaker_name: null,
    selected_bookmaker_key: null,
    live_selected_odds_json: JSON.stringify({ homeWin: 2.2, draw: 3.2, awayWin: 3.4 }),
    selected_odds_json: '{}', eurobet_odds_json: '{}', fallback_odds_json: '{}',
    all_bookmaker_odds_json: '{}', markets_requested_json: '[]',
    used_fallback_bookmaker: 0, used_synthetic_odds: 0,
    captured_at: '2026-01-01T12:00:00.000Z', match_date: '2026-01-02T20:00:00.000Z',
    home_goals: 1, away_goals: 0,
  }];

  assert.deepEqual(await db.getHistoricalOddsDetailMap(), {});
});

test('snapshot odds_api con bookmaker selezionato resta una fonte storica reale', async () => {
  const db = Object.create(DatabaseService.prototype);
  db.all = async () => [{
    match_id: 'named-odds-api',
    source: 'odds_api',
    selected_bookmaker_name: 'Pinnacle',
    selected_bookmaker_key: 'pinnacle',
    live_selected_odds_json: JSON.stringify({ homeWin: 2.2, draw: 3.2, awayWin: 3.4 }),
    selected_odds_json: '{}', eurobet_odds_json: '{}', fallback_odds_json: '{}',
    all_bookmaker_odds_json: '{}', markets_requested_json: '[]',
    used_fallback_bookmaker: 0, used_synthetic_odds: 0,
    captured_at: '2026-01-01T12:00:00.000Z', match_date: '2026-01-02T20:00:00.000Z',
    home_goals: 1, away_goals: 0,
  }];

  const details = await db.getHistoricalOddsDetailMap();
  assert.equal(details['named-odds-api'].oddsSource, 'odds_api');
  assert.equal(details['named-odds-api'].selectedBookmakerName, 'Pinnacle');
  assert.equal(details['named-odds-api'].odds.homeWin, 2.2);
});

test('una write solo fixture non avvia il rebuild player Understat', () => {
  assert.equal(shouldRebuildUnderstatPlayers([{ isPlayed: false }]), false);
  assert.equal(shouldRebuildUnderstatPlayers([{ isPlayed: false }, { isPlayed: true }]), true);
  assert.equal(shouldRebuildUnderstatPlayers([{ isPlayed: true }], 'second chunk failed'), false);
});
