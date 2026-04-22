const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeBudgetBetsInternal } = require('../dist/services/PredictionService.js');

test('summarizeBudgetBetsInternal mantiene gli stessi aggregati economici attesi', () => {
  const bets = [
    { status: 'WON', stake: 10, return_amount: 21, profit: 11 },
    { status: 'LOST', stake: 5, return_amount: 0, profit: -5 },
    { status: 'VOID', stake: 8, return_amount: 8, profit: 0 },
    { status: 'PENDING', stake: 12, return_amount: 0, profit: 0 },
  ];

  const summary = summarizeBudgetBetsInternal(bets);

  assert.equal(summary.totalBets, 4);
  assert.equal(summary.totalStaked, 35);
  assert.equal(summary.totalWon, 21);
  assert.equal(summary.totalLost, 5);
  assert.equal(summary.totalReturned, 29);
  assert.equal(summary.totalProfit, 6);
  assert.equal(summary.settledStaked, 23);
  assert.equal(summary.settledCount, 2);
  assert.equal(summary.wonCount, 1);
  assert.equal(Number(summary.winRate.toFixed(2)), 50);
  assert.equal(Number(summary.roi.toFixed(2)), Number(((6 / 23) * 100).toFixed(2)));
});
