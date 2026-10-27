const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { evaluateMarketValidation, marketEvidenceHash, MARKET_VALIDATION_RULE } = require(path.join(
  process.env.RESEARCH_MARKET_TEST_DIST || path.join(__dirname, '../dist'), 'research/MarketValidationEngine.js'));

// Deliberate fixtures exercise eligibility rules. They are never evidence about production model quality.
const matrix = [[0, .5], [.5, 0]];
const probabilityConfiguration = { version: 'probability-configuration-v1', family: 'C', baselineVersion: 'fixture-baseline',
  probabilityProtocol: 'joint-goal-coherent-v2', pipelineHashV2: '1'.repeat(64), mode: 'identity', temperature: 1, calibratorHash: '2'.repeat(64) };
const probabilityConfigurationHash = marketEvidenceHash(probabilityConfiguration);
const plan = () => ({ family: 'C', modelVersion: 'C-fixture', referenceVersion: 'A-fixture', market: '1x2',
  probabilityConfiguration, probabilityConfigurationHash,
  baselineHash: 'fixture-baseline', featureSchema: ['fixture-feature'], trainedThrough: '2025-12-01T00:00:00Z',
  calibratedThrough: '2025-12-10T00:00:00Z', selectedThrough: '2025-12-15T00:00:00Z',
  holdoutFrom: '2026-01-01T00:00:00Z', holdoutTo: '2026-02-01T00:00:00Z',
  trainingMatchIds: ['training-fixture'], calibrationMatchIds: ['calibration-fixture'], selectionMatchIds: ['tuning-fixture'] });
function observations(phase = 'holdout', count = 200) {
  const start = Date.parse(phase === 'holdout' ? '2026-01-04T12:00:00Z' : '2026-02-08T12:00:00Z');
  return Array.from({ length: count }, (_unused, index) => {
    const forecast = start + Math.floor(index / 50) * 7 * 86400000 + (index % 50) * 60000;
    const forecastAt = new Date(forecast).toISOString(), kickoffAt = new Date(forecast + 900000).toISOString();
    const quotes = ['home', 'draw', 'away'].map((side) => ({ market: '1x2', side, selection: side,
      odds: side === 'draw' ? 100 : 2, bookmaker: 'Fixture bookmaker', source: 'odds_api', capturedAt: forecastAt, updatedAt: forecastAt }));
    const snapshot = { observedAt: forecastAt, featureAvailableThrough: '2025-12-01T00:00:00Z', quotes };
    return { matchId: `${phase}-${index}`, competition: ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'][index % 5],
      modelVersion: 'C-fixture', probabilityConfigurationHash, phase, kickoffAt, forecastAt, referenceForecastAt: forecastAt,
      modelFitThrough: '2025-12-01T00:00:00Z', snapshot, referenceSnapshotHash: marketEvidenceHash(snapshot),
      matrix, referenceMatrix: matrix, quote: quotes[0], priceType: phase === 'prospective' ? 't15' : 'opening',
      result: { homeGoals: Number(index % 2 === 0), awayGoals: Number(index % 2 !== 0),
        availableAt: new Date(forecast + 900000 + 7200000).toISOString(), source: 'understat' },
      settlement: { returnMultiplier: index % 2 === 0 ? 2 : 0,
        recordedAt: new Date(forecast + 900000 + 7260000).toISOString() } };
  });
}
const evaluate = (rows, extra = {}) => evaluateMarketValidation({ plan: plan(), observations: rows, now: '2026-04-01T00:00:00Z', ...extra });
function approval() {
  const artifact = { fixture: true }, report = { warnings: [], validation: { passed: true, finalHoldout: true,
    operationalChecksPassed: true, pairedCI: true, minSamplesSatisfied: true, nPaired: 600, leagueCount: 5, periodCount: 4,
    deltaLogLossCI: [-.02, -.001], deltaBrierCI: [-.01, -.001], preRegisteredRule: 'research-promotion-v1',
    comparisonReference: 'model_A', referenceModelVersion: 'A-fixture', dataHash: 'fixture-dataset',
    baselineHash: 'fixture-baseline', featureSchema: ['fixture-feature'] } };
  return { model: { family: 'C', version: 'C-fixture', artifact, artifactHash: marketEvidenceHash(artifact) },
    benchmark: { id: 'fixture-model-approval', family: 'C', modelVersion: 'C-fixture', report, reportHash: marketEvidenceHash(report) },
    event: { family: 'C', version: 'C-fixture', action: 'PROMOTE', benchmarkId: 'fixture-model-approval', createdAt: '2026-01-01T00:00:00Z' } };
}

test('empty and small samples remain experimental; passing historical evidence can enter shadow without a claim of superiority', () => {
  assert.equal(evaluate([]).state, 'EXPERIMENTAL');
  assert.equal(evaluate(observations('holdout', 50)).state, 'EXPERIMENTAL');
  const report = evaluate(observations());
  assert.equal(report.state, 'SHADOW');
  const evidence = report.marketValidation['1x2'];
  assert.equal(evidence.probabilisticSamples, 200);
  assert.equal(evidence.leagueCount, 5);
  assert.equal(evidence.periodCount, 4);
  assert.equal(evidence.calibrationPassed, true);
  assert.equal(evidence.historical.ece, 0);
  assert.deepEqual(evidence.historical.deltaLogLossCI, [0, 0]);
  assert.deepEqual(evidence.historical.deltaBrierCI, [0, 0]);
  assert.equal(report.validation.passed, false);
  assert.equal(report.validation.finalHoldout, true);
  assert.equal(report.marketValidation['1x2'].independentEvaluationPassed, true);
  assert.equal(MARKET_VALIDATION_RULE.version, 'research-market-eligibility-v1');
});

test('future inputs, different A/C snapshot or forecast time and holdout reuse fail closed', () => {
  for (const alter of [
    (row) => { row.snapshot.featureAvailableThrough = '2027-01-01T00:00:00Z'; },
    (row) => { row.referenceSnapshotHash = 'different-snapshot'; },
    (row) => { row.referenceForecastAt = '2026-01-04T11:59:00Z'; },
    (row) => { row.matchId = 'training-fixture'; },
  ]) {
    const rows = observations(); alter(rows[0]);
    const report = evaluate(rows);
    assert.equal(report.state, 'EXPERIMENTAL');
    assert.equal(report.validation.finalHoldout, false);
  }
  const rows = observations(); rows.push(rows[0]);
  assert.ok(evaluate(rows).reasons.some((reason) => reason.code === 'duplicate_or_missing_match'));
});

test('a market approval binds a computed configuration and never pools changed or absent calibration profiles', () => {
  const good = evaluate(observations());
  assert.equal(good.marketValidation['1x2'].approvedProbabilityConfigurationHash, probabilityConfigurationHash);
  assert.equal(good.validation.probabilityConfigurationHash, probabilityConfigurationHash);
  for (const mismatch of [undefined, 'a'.repeat(64)]) {
    const rows = observations(); rows[0].probabilityConfigurationHash = mismatch;
    const report = evaluate(rows, { previousState: 'ACTIVE' });
    assert.equal(report.state, 'EXPERIMENTAL');
    assert.equal(report.marketValidation['1x2'].independentEvaluationPassed, false);
    assert.equal(report.marketValidation['1x2'].approvedProbabilityConfigurationHash, null);
    assert.equal(report.marketValidation['1x2'].probabilisticSamples, 199);
    assert.ok(report.reasons.some((reason) => reason.code === 'probability_configuration_mismatch'));
  }
  const changed = { ...probabilityConfiguration, temperature: 1.1 };
  const forged = evaluate(observations(), { plan: { ...plan(), probabilityConfiguration: changed } });
  assert.equal(forged.state, 'EXPERIMENTAL');
  assert.equal(forged.marketValidation['1x2'].probabilisticSamples, 0);
  assert.ok(forged.reasons.some((reason) => reason.code === 'invalid_probability_configuration'));
  const missing = { ...plan() }; delete missing.probabilityConfigurationHash;
  assert.equal(evaluate(observations(), { plan: missing }).state, 'EXPERIMENTAL');
});

test('bookmaker margin requires a complete same-operator partition and genuine entry price semantics', () => {
  for (const alter of [
    (row) => { row.priceType = 'closing'; },
    (row) => { row.snapshot.quotes = [row.quote]; },
    (row) => { row.snapshot.quotes[2].bookmaker = 'Other operator'; },
    (row) => { row.quote.source = 'unlicensed_scraper'; },
  ]) {
    const rows = observations();
    for (const row of rows) { alter(row); row.referenceSnapshotHash = marketEvidenceHash(row.snapshot); }
    const report = evaluate(rows);
    assert.equal(report.state, 'EXPERIMENTAL');
    assert.equal(report.marketValidation['1x2'].quoteCoverage, false);
  }
});

test('settlement disagreements suspend a previously shadow market and are never concealed by a high ROI', () => {
  const rows = observations(); rows[0].settlement.returnMultiplier = 100;
  const report = evaluate(rows, { previousState: 'SHADOW', virtualRoi: 500 });
  assert.equal(report.state, 'SUSPENDED');
  assert.equal(report.marketValidation['1x2'].settlementVerified, false);
  assert.ok(report.reasons.some((reason) => reason.code === 'settlement_mismatch_or_missing'));
});

test('poor calibration and worse proper scores prevent eligibility despite sufficient matches and periods', () => {
  const rows = observations();
  for (const row of rows) row.matrix = [[0, .01], [.99, 0]];
  const report = evaluate(rows);
  assert.equal(report.state, 'EXPERIMENTAL');
  assert.equal(report.marketValidation['1x2'].calibrationPassed, false);
  assert.ok(report.marketValidation['1x2'].historical.deltaBrierCI[1] > .02);
});

test('prospective eligibility requires pre-match T15 prices, freshness, disjoint periods and sufficient samples', () => {
  const historic = observations(), prospective = observations('prospective');
  const report = evaluate([...historic, ...prospective]);
  assert.equal(report.state, 'SHADOW');
  assert.equal(report.marketValidation['1x2'].prospectivePassed, true);
  assert.equal(report.marketValidation['1x2'].prospectiveSamples, 200);
  assert.ok(report.reasons.some((reason) => reason.code === 'approved_champion_evidence_missing'));
  for (const row of prospective) {
    row.quote.updatedAt = new Date(Date.parse(row.forecastAt) - 300001).toISOString();
    row.referenceSnapshotHash = marketEvidenceHash(row.snapshot);
  }
  const stale = evaluate([...historic, ...prospective]);
  assert.equal(stale.marketValidation['1x2'].prospectivePassed, false);
  assert.ok(stale.reasons.some((reason) => reason.code === 'stale_t15_quote'));
  const late = observations('prospective');
  for (const row of late) { row.forecastAt = row.kickoffAt; row.referenceForecastAt = row.kickoffAt; }
  assert.equal(evaluate([...historic, ...late]).state, 'EXPERIMENTAL');
});

test('ACTIVE needs raw consistent registry approval in addition to independently computed prospective evidence', () => {
  const rows = [...observations(), ...observations('prospective')];
  const registryApproval = approval();
  const report = evaluate(rows, { registryApproval });
  assert.equal(report.state, 'ACTIVE');
  assert.equal(report.modelBenchmarkId, 'fixture-model-approval');
  assert.equal(report.validation.passed, false, 'Market evidence never becomes model-promotion evidence.');
  registryApproval.model.artifact = { tampered: true };
  assert.equal(evaluate(rows, { registryApproval }).state, 'SHADOW');
  const unrelated = approval(); unrelated.event.version = 'other-version';
  assert.equal(evaluate(rows, { registryApproval: unrelated }).state, 'SHADOW');
});

test('reordering observations is reproducible and calculations preserve supplied snapshots', () => {
  const rows = observations(), before = JSON.stringify(rows);
  const forward = evaluate(rows), reversed = evaluate([...rows].reverse());
  assert.deepEqual(forward, reversed);
  assert.equal(JSON.stringify(rows), before);
});

test('half wins use half-stake weight and pushes do not count as binary losses', () => {
  const rows = observations();
  const modifiedPlan = { ...plan(), market: 'asian_handicap' };
  for (const row of rows) {
    const forecastAt = row.forecastAt;
    const quotes = ['home', 'away'].map((side) => ({ market: 'asian_handicap', side, selection: side,
      line: side === 'home' ? .25 : -.25, odds: 2, bookmaker: 'Fixture bookmaker', source: 'odds_api', capturedAt: forecastAt, updatedAt: forecastAt }));
    row.quote = quotes[0]; row.snapshot.quotes = quotes; row.referenceSnapshotHash = marketEvidenceHash(row.snapshot);
    row.matrix = row.referenceMatrix = [[.5, .5], [0, 0]];
    const half = Number(row.matchId.split('-')[1]) % 2 === 0;
    row.result.homeGoals = 0; row.result.awayGoals = half ? 0 : 1;
    row.settlement.returnMultiplier = half ? 1.5 : 0;
  }
  const report = evaluate(rows, { plan: modifiedPlan });
  assert.equal(report.marketValidation.asian_handicap.historical.effectiveStakeSamples, 150);
  assert.equal(report.marketValidation.asian_handicap.probabilisticSamples, 200);
  assert.equal(report.marketValidation.asian_handicap.settlementVerified, true);
});
