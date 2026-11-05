const test = require('node:test');
const assert = require('node:assert/strict');
const { parseFootballDataCsv } = require('../dist/services/FootballDataService');
const { buildSourceFeedReadiness, summarizeFootballDataEvidence } = require('../dist/services/SourceFeedReadiness');

const csv = (home, away) => `Date,HomeTeam,AwayTeam,FTHG,FTAG,HS,AS,HST,AST,HY,AY,HR,AR,HxG,AxG\n01/11/2026,Alpha,Beta,0,1,0,8,0,3,0,1,0,0,${home},${away}`;
test('CSV xG candidates preserve missing and zero without masquerading as primary xG', () => {
  for (const [input, expected] of [['', null], [' ', null], ['NaN', null], ['-1', null], ['Infinity', null], ['0', 0], ['1.25', 1.25]]) {
    const row = parseFootballDataCsv(csv(input, '0'))[0];
    assert.equal(row.unverifiedXg.home, expected);
    assert.equal(row.unverifiedXg.away, 0);
    assert.equal(row.unverifiedXg.status, 'provider_semantics_unverified');
    assert.equal(Object.hasOwn(row, 'homeXG'), false);
    assert.equal(Object.hasOwn(row, 'home_xg'), false);
  }
  assert.equal(parseFootballDataCsv('Date,HomeTeam,AwayTeam\n01/11/2026,Alpha,Beta')[0].unverifiedXg, undefined);
});
test('offline evidence reports paired observed counts and unverified xG separately', () => {
  const report = summarizeFootballDataEvidence(csv('0', '1.25'));
  assert.deepEqual(report.observedPairs, { results: 1, shots: 1, shotsOnTarget: 1, yellowCards: 1, redCards: 1, xgCandidates: 1 });
  assert.equal(report.xgAdmissibleAsUnderstat, false);
  assert.equal(report.probabilities, null);
  assert.equal(summarizeFootballDataEvidence(csv('', '0')).observedPairs.xgCandidates, 0);
  assert.equal(summarizeFootballDataEvidence(csv('0', '0').replace('Alpha,Beta,0,1', 'Alpha,Beta,0.5,1')).observedPairs.results, 0);
});
test('source success permits inspection, never grants model or scientific readiness', () => {
  const feed = { competition: 'SA', season: 2026, available: true, status: 'available', reason: null,
    snapshot: { acquiredAt: '2026-11-05T20:00:00Z', fieldAvailability: { calendar: { available: true }, results: { available: true } } } };
  const result = buildSourceFeedReadiness([feed]);
  const competition = result.competitions[0];
  assert.deepEqual(competition.operations, { inspectCalendar: true, inspectResults: true, automaticSettlement: false, operationalImport: false });
  assert.ok(competition.markets.every(market => market.action === 'ABSTAIN' && !market.computed && market.probabilities === null));
  assert.equal(competition.markets.find(m => m.market === 'A_goal').reason, 'model_input_adequacy_not_verified');
  assert.ok(competition.markets.find(m => m.market === 'C_goal').missingSourceFields.includes('xg'));
  assert.equal(result.prospectiveEligibility, 'not_attested');
});
test('retained snapshots after failure or staleness never supply currently available data', () => {
  for (const status of ['failure', 'pending', 'stale', 'unavailable']) {
    const result = buildSourceFeedReadiness([{ competition: 'SA', season: 2026, available: false, status,
      reason: 'source_feed_unavailable', snapshot: { acquiredAt: '2026-11-05T20:00:00Z', fieldAvailability: { calendar: { available: true }, results: { available: true } } } }]);
    const competition = result.competitions[0];
    assert.equal(competition.sourceAvailable, false);
    assert.equal(competition.operations.inspectCalendar, false);
    assert.equal(competition.retainedSnapshotForInspectionOnly, true);
  }
});
