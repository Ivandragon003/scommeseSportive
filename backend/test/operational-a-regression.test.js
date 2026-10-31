const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const manifest = require('./fixtures/operational-a/source-manifest.json');
const expected = require('./fixtures/operational-a/expected.json');
const { scenarios, runScenario, BOOKMAKER } = require('./fixtures/operational-a/scenarios');

const BASELINE = 'a474e36cee8372d4e214c704effdb92b488f9242';

test('operational A and its shared decision/price components retain the explicit pre-C source snapshot', () => {
  assert.equal(manifest.baselineCommit, BASELINE);
  assert.equal(expected.baselineCommit, BASELINE);
  const root = resolve(__dirname, '../..');
  for (const [file, hash] of Object.entries(manifest.files)) {
    const source = readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), hash,
      `Operational A baseline changed: ${file}. C work must not silently change A or refresh its golden.`);
  }
  assert.deepEqual(expected.scenarios.map((scenario) => scenario.scenario), scenarios.map((scenario) => scenario.id));
});

for (const scenario of scenarios) {
  test(`operational A golden at ${BASELINE.slice(0, 8)}: ${scenario.id}`, async () => {
    const actual = await runScenario(scenario);
    const frozen = expected.scenarios.find((entry) => entry.scenario === scenario.id);
    // Golden was captured before the C work; no expectation is derived from current output.
    assert.deepEqual(actual, frozen);
    assert.equal(actual.packet.model.source, 'PredictionService');
    assert.equal(actual.packet.odds.source, 'odds_api');
    assert.ok(Object.values(actual.packet.odds.bookmakerBySelection).every((name) => name === BOOKMAKER));
    assert.equal(Object.keys(actual.raw).some((selection) => /^(corners|fouls)/i.test(selection)), false);
    assert.equal(actual.valueOpportunities.some((opportunity) => ['corners', 'fouls'].includes(opportunity.marketCategory)), false);
    if (scenario.noOdds) {
      assert.equal(actual.packet.decisionStatus, 'NO_BET');
      assert.equal(actual.packet.selected, null);
      assert.deepEqual(actual.packet.probabilities.decision, {});
    } else {
      assert.equal(actual.packet.decisionStatus, 'RECOMMENDED');
      assert.deepEqual(actual.packet.selected, actual.packet.ranked[0]);
      assert.ok(actual.packet.selected.suggestedStakePercent > 0);
      if (scenario.cardsOnly) assert.equal(actual.packet.selected.marketCategory, 'yellow_cards');
      if (scenario.samples < 8) {
        assert.equal(Object.keys(actual.raw).some((selection) => /^(shots|yellow|cardsTotal)/i.test(selection)), false);
        assert.ok(actual.valueOpportunities.every((opportunity) => opportunity.confidence === 'LOW'));
      } else {
        assert.ok(actual.valueOpportunities.some((opportunity) => opportunity.marketCategory === 'yellow_cards'));
        if (!scenario.cardsOnly) assert.ok(actual.valueOpportunities.some((opportunity) => opportunity.marketCategory === 'shots'));
      }
    }
  });
}
