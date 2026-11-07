const test = require('node:test');
const assert = require('node:assert/strict');
const { settleResearchBets } = require('../dist/research/ResearchRuntime');
const { appRecommendationQuote } = require('../dist/research/AppRecommendationQuotes');
const marker = 'c-team-markets-v1';
test('C statistical settlement needs the new execution marker and observed booking points', async () => {
  const quote = appRecommendationQuote('cards_total_over_3.5', { odds: 2, bookmaker: 'Book', source: 'odds_api', priceType: 'prematch', capturedAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:00:00Z' });
  const match = { home_goals: 1, away_goals: 0, home_yellow_cards: 1, away_yellow_cards: 1, home_red_cards: 1, away_red_cards: 0 };
  let snapshot = { quote }, writes = [];
  const db = { getMatchById: async () => match, research: { listBets: async () => [{ id: 'bet', matchId: 'match', family: 'C', executionDecisionId: 'execution', snapshot }], settleBet: async (...args) => { writes.push(args); return { settled: true }; } } };
  assert.equal((await settleResearchBets(db)).unresolved, 1);
  snapshot = { quote, probabilityConfiguration: { marketPolicyVersion: marker } };
  match.away_red_cards = null;
  assert.equal((await settleResearchBets(db)).unresolved, 1);
  match.away_red_cards = 0;
  assert.equal((await settleResearchBets(db)).settled, 1);
  assert.equal(writes[0][1], 2);
});
