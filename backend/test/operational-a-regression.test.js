const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const manifest = require('./fixtures/operational-a/source-manifest.json');
const deviations = require('./fixtures/operational-a/authorized-source-deviations.json');
const expected = require('./fixtures/operational-a/expected.json');
const { scenarios, runScenario, BOOKMAKER } = require('./fixtures/operational-a/scenarios');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel');

const BASELINE = 'a474e36cee8372d4e214c704effdb92b488f9242';
const DIXON_COLES_SOURCE = 'backend/src/models/core/DixonColesModel.ts';

function assertOperationalSource(file, source) {
  // Reverse only reviewed, exact source patches. Their context must be unique;
  // every remaining byte is still checked against the immutable pre-C hash.
  for (const change of [...deviations.changes].reverse()) {
    for (const edit of [...change.edits].reverse().filter((entry) => entry.file === file)) {
      assert.equal(source.split(edit.after).length - 1, 1,
        `Authorized source patch must occur exactly once: ${file} (${change.commit ?? change.review})`);
      source = source.replace(edit.after, edit.before);
    }
  }
  assert.equal(createHash('sha256').update(source).digest('hex'), manifest.files[file],
    `Operational A baseline changed: ${file}. Do not silently change A or refresh its golden.`);
}

test('operational A retains the pre-C snapshot plus only exact reviewed missing-data and observer deviations', () => {
  assert.equal(manifest.baselineCommit, BASELINE);
  assert.equal(expected.baselineCommit, BASELINE);
  assert.equal(deviations.baselineCommit, BASELINE);
  for (const change of deviations.changes) {
    assert.ok(change.reason);
    assert.ok(change.commit || change.review);
    for (const edit of change.edits) {
      assert.ok(Object.hasOwn(manifest.files, edit.file));
      assert.ok(edit.before && edit.after && edit.before !== edit.after);
    }
  }
  const root = resolve(__dirname, '../..');
  for (const file of Object.keys(manifest.files)) {
    const source = readFileSync(resolve(root, file), 'utf8').replace(/\r\n/g, '\n');
    assertOperationalSource(file, source);
  }
  assert.deepEqual(expected.scenarios.map((scenario) => scenario.scenario), scenarios.map((scenario) => scenario.id));
});

test('source guard rejects unrelated edits, a reverted authorized correction and duplicated patch context', () => {
  const source = readFileSync(resolve(__dirname, '../..', DIXON_COLES_SOURCE), 'utf8').replace(/\r\n/g, '\n');
  const edit = deviations.changes[0].edits.find((entry) => entry.file === DIXON_COLES_SOURCE);
  assert.throws(() => assertOperationalSource(DIXON_COLES_SOURCE, `${source}\n// unreviewed change\n`), /baseline changed/);
  assert.throws(() => assertOperationalSource(DIXON_COLES_SOURCE, source.replace(edit.after, edit.before)), /exactly once/);
  assert.throws(() => assertOperationalSource(DIXON_COLES_SOURCE, `${source}\n${edit.after}`), /exactly once/);
});

test('source guard rejects reverting or duplicating the reviewed market-observation correction', () => {
  const change = deviations.changes.find((entry) => entry.review === 'missing-market-observations-v1');
  assert.ok(change?.edits.length > 0);
  const edit = change.edits.find((entry) => entry.file === DIXON_COLES_SOURCE);
  const source = readFileSync(resolve(__dirname, '../..', edit.file), 'utf8').replace(/\r\n/g, '\n');
  assert.throws(() => assertOperationalSource(edit.file, source.replace(edit.after, edit.before)), /exactly once/);
  assert.throws(() => assertOperationalSource(edit.file, `${source}\n${edit.after}`), /exactly once/);
});

test('source guard preserves only the exact reviewed identity-only input eligibility patch', () => {
  const change = deviations.changes.find((entry) => entry.review === 'identity-only-player-eligibility-v1');
  assert.ok(change?.edits.length > 0);
  const edit = change.edits[0];
  const source = readFileSync(resolve(__dirname, '../..', edit.file), 'utf8').replace(/\r\n/g, '\n');
  assert.throws(() => assertOperationalSource(edit.file, source.replace(edit.after, edit.before)), /exactly once/);
  assert.throws(() => assertOperationalSource(edit.file, `${source}\n${edit.after}`), /exactly once/);
});

test('source guard rejects reverting or duplicating each provider market semantics correction', () => {
  const change = deviations.changes.find((entry) => entry.review === 'provider-market-semantics-v1');
  assert.ok(change?.edits.length > 0);
  for (const edit of change.edits) {
    const source = readFileSync(resolve(__dirname, '../..', edit.file), 'utf8').replace(/\r\n/g, '\n');
    assert.throws(() => assertOperationalSource(edit.file, source.replace(edit.after, edit.before)), /exactly once/);
    assert.throws(() => assertOperationalSource(edit.file, `${source}\n${edit.after}`), /exactly once/);
  }
});

test('authorized xG deviation falls back on either missing side and preserves genuine numeric zero', () => {
  const matches = Array.from({ length: 30 }, (_, index) => ({
    matchId: `authorized-xg-${index}`, homeTeamId: index % 2 ? 'B' : 'A',
    awayTeamId: index % 2 ? 'A' : 'B', date: new Date(Date.UTC(2026, 0, index + 1)),
    homeGoals: 1, awayGoals: 1, season: '2025-2026',
  }));
  const fit = (rows) => new DixonColesModel().fitModel(rows, ['A', 'B'], 60, .04, {
    xgBlendWeight: .8, referenceDate: new Date('2026-03-01T00:00:00Z'),
  });
  const fallback = fit(matches);
  for (const missing of [null, undefined, '', ' ', '\t']) {
    for (const side of ['homeXG', 'awayXG']) {
      const rows = matches.map((match) => ({ ...match, homeXG: 1.5, awayXG: 1.5, [side]: missing }));
      assert.deepEqual(fit(rows), fallback, `${side}=${JSON.stringify(missing)} must use actual goals`);
    }
  }
  const zero = fit(matches.map((match) => ({ ...match, homeXG: 0, awayXG: 0 })));
  assert.notDeepEqual(zero.attackParams, fallback.attackParams);
  assert.deepEqual(fit(matches.map((match) => ({ ...match, homeXG: '0', awayXG: '0' }))), zero);
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
