const test = require('node:test');
const assert = require('node:assert/strict');
const { appRecommendationQuote, appQuoteSettlementSupported, settleAppRecommendationQuote } = require('../dist/research/AppRecommendationQuotes');
const { recommendationQuoteReason } = require('../dist/research/ResearchRecommendationPolicy');

const now = new Date('2026-10-30T10:00:00Z');
const evidence = { odds: 2.2, bookmaker: 'Actual bookmaker', source: 'odds_api', priceType: 'prematch',
  capturedAt: now.toISOString(), updatedAt: now.toISOString() };
const match = { home_goals: 1, away_goals: 0, home_shots: 12, away_shots: 8,
  home_shots_on_target: 5, away_shots_on_target: 2,
  home_yellow_cards: 1, away_yellow_cards: 1, home_red_cards: 1, away_red_cards: 0 };

test('app quote adapter preserves team market scope and decodes existing selection conventions', () => {
  for (const [selection, expected] of [
    ['homeWin', ['1x2', 'home']], ['bttsNo', ['btts', 'no']],
    ['double_chance_x2', ['double_chance', 'x2']], ['dnb_away', ['dnb', 'away']],
    ['over25', ['totals', 'over', 2.5]], ['over275', ['totals', 'over', 2.75]],
    ['team_home_over_15', ['team_totals', 'over', 1.5, 'home']],
    ['cards_total_over_3.5', ['cards_total', 'over', 3.5]], ['cardsTotalUnder45', ['cards_total', 'under', 4.5]],
    ['yellowOver35', ['yellow_cards', 'over', 3.5]], ['shotsOver205', ['shots', 'over', 20.5]],
    ['shots_home_under_12.5', ['shots', 'under', 12.5, 'home']],
    ['shotsAwayOver75', ['shots', 'over', 7.5, 'away']], ['shotsOTUnder75', ['shots_on_target', 'under', 7.5]],
    ['ahcp_0.25', ['asian_handicap', 'home', -.25]], ['ahcp_away_0.25', ['asian_handicap', 'away', .25]],
    ['hcp_home-1', ['european_handicap', 'home', -1]], ['hcp_away+1', ['european_handicap', 'away', -1]],
  ]) {
    const quote = appRecommendationQuote(selection, evidence);
    assert.ok(quote, selection);
    assert.deepEqual([quote.market, quote.side, ...(quote.line === undefined ? [] : [quote.line]),
      ...(quote.team === undefined ? [] : [quote.team])], expected, selection);
    assert.equal(quote.selection, selection);
    assert.equal(appQuoteSettlementSupported(quote), true, selection);
  }
  for (const selection of ['cornersOver95', 'fouls_over_20.5', 'player_123_shots_over_1.5',
    'player_goals_osimhen_over_0.5', 'exact_1-0', 'over85', 'unknown']) {
    assert.equal(appRecommendationQuote(selection, evidence), null, selection);
  }
});

test('cards and shots quotes are admitted only for app A with real, consistent prices', () => {
  for (const selection of ['cards_total_over_3.5', 'shotsOver195', 'shotsOTOver65']) {
    const quote = appRecommendationQuote(selection, evidence);
    assert.equal(recommendationQuoteReason(quote, now, 'A'), null);
    assert.equal(recommendationQuoteReason(quote, now, 'C'), 'unsupported_quote_settlement');
    for (const change of [{ source: 'odds_api_plus_model_completion' }, { odds: NaN },
      { market: 'corners' }, { side: 'home' }, { line: 3.25 }, { bookmaker: '' }, { updatedAt: '' }]) {
      assert.equal(appQuoteSettlementSupported({ ...quote, ...change }), false);
    }
  }
});

test('app statistics settlement uses booking points, team scopes and refunds on integer lines', () => {
  assert.equal(settleAppRecommendationQuote(appRecommendationQuote('cards_total_over_3.5', evidence), match).status, 'WON');
  assert.equal(settleAppRecommendationQuote(appRecommendationQuote('yellow_over_3.5', evidence), match).status, 'LOST');
  assert.deepEqual(settleAppRecommendationQuote(appRecommendationQuote('shots_total_over_20', evidence), match),
    { status: 'VOID', returnMultiplier: 1 });
  assert.equal(settleAppRecommendationQuote(appRecommendationQuote('shots_home_under_12.5', evidence), match).status, 'WON');
  assert.equal(settleAppRecommendationQuote(appRecommendationQuote('shots_away_over_8.5', evidence), match).status, 'LOST');
  assert.equal(settleAppRecommendationQuote(appRecommendationQuote('sot_total_over_6.5', evidence), match).status, 'WON');
  assert.equal(settleAppRecommendationQuote(appRecommendationQuote('ahcp_0.25', evidence), { home_goals: 1, away_goals: 1 }).status, 'HALF_LOST');
});

test('missing, invalid and synthetic statistic evidence stays unresolved rather than settling as zero', () => {
  for (const [selection, field] of [['cards_total_over_3.5', 'away_red_cards'], ['yellow_over_3.5', 'away_yellow_cards'],
    ['shots_total_under_20.5', 'home_shots'], ['sot_total_under_6.5', 'away_shots_on_target']]) {
    const quote = appRecommendationQuote(selection, evidence);
    for (const value of [null, undefined, '', NaN, -1, false]) {
      assert.equal(settleAppRecommendationQuote(quote, { ...match, [field]: value }).status, 'UNRESOLVED', `${selection} ${value}`);
    }
    assert.equal(settleAppRecommendationQuote({ ...quote, source: 'model_completion' }, match).status, 'UNRESOLVED');
  }
});
