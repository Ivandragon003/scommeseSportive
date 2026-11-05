'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectionBudgetsFromEnv, ModelACollectionPerformanceMeter } = require('../dist/research/ModelAProspectiveBudget');
test('budgets validate positive bounded integers and signal only strict exceedance', () => {
  assert.deepEqual(collectionBudgetsFromEnv({}), { predictMs: 30000, confirmationMs: 45000 });
  for (const value of ['0', '-1', '1.5', '3600001', 'bogus']) assert.throws(() => collectionBudgetsFromEnv({ MODEL_A_COLLECTION_PREDICT_BUDGET_MS: value }), /budget_invalid/);
  const meter = new ModelACollectionPerformanceMeter({ predictMs: 10, confirmationMs: 20 });
  meter.observe('predict', 10); meter.observe('confirmation', 21, 'unconfirmed');
  const summary = meter.snapshot(); assert.equal(summary.predict.overBudget, 0); assert.equal(summary.confirmation.overBudget, 1);
  assert.equal(summary.confirmation.unconfirmed, 1); assert.equal(summary.alert, true);
});
