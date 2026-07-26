'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { OddsApiService } = require('../dist/services/OddsApiService');
const { parseLegacyPlayerPropOddsKey } = require('../dist/services/playerProps');

function matchWith(outcomes) {
  return {
    homeTeam: 'Inter', awayTeam: 'Milan',
    bookmakers: [{
      bookmakerKey: 'pinnacle',
      markets: [{ marketKey: 'player_goal_scorer_anytime', outcomes }],
    }],
  };
}

test('anytime scorer: outcome col nome giocatore -> player_goals_<slug>_over_0.5', () => {
  const svc = new OddsApiService('test-key');
  const odds = svc.extractBestOdds(matchWith([
    { name: 'Lautaro Martinez', price: 2.10 },
    { name: 'Rafael Leao', price: 2.75 },
  ]), 'pinnacle');
  assert.equal(odds['player_goals_lautaro_martinez_over_0.5'], 2.10);
  assert.equal(odds['player_goals_rafael_leao_over_0.5'], 2.75);
});

test('anytime scorer: outcome Yes/No con description -> over/under 0.5', () => {
  const svc = new OddsApiService('test-key');
  const odds = svc.extractBestOdds(matchWith([
    { name: 'Yes', description: 'Lautaro Martinez', price: 2.10 },
    { name: 'No', description: 'Lautaro Martinez', price: 1.72 },
  ]), 'pinnacle');
  assert.equal(odds['player_goals_lautaro_martinez_over_0.5'], 2.10);
  assert.equal(odds['player_goals_lautaro_martinez_under_0.5'], 1.72);
});

test('parse chiave legacy marcatore -> marketType goals', () => {
  const parsed = parseLegacyPlayerPropOddsKey('player_goals_lautaro_martinez_over_0.5');
  assert.ok(parsed, 'chiave non parsata');
  assert.equal(parsed.marketType, 'goals');
  assert.equal(parsed.side, 'over');
  assert.equal(parsed.line, 0.5);
  assert.equal(parsed.playerSlug, 'lautaro_martinez');
});
