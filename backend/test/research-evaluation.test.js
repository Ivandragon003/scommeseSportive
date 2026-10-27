const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateResearchBenchmark, evaluateResearchPipelineBenchmark, selectResearchDecision, explainResearchDecision } = require('../dist/research/ResearchEvaluation');

const matrix = (home = 0.9) => [[(1 - home) / 2, (1 - home) / 2, 0], [home, 0, 0], [0, 0, 0]];
const quote = (extra = {}) => ({ selection: 'homeWin', market: '1x2', side: 'home', odds: 2.4,
  bookmaker: 'Real operator', source: 'odds_api', capturedAt: '2026-10-01T11:44:00Z',
  updatedAt: '2026-10-01T11:44:00Z', ...extra });
const row = (extra = {}) => ({ matchId: 'test-1', competition: 'Serie A', season: '2026-27',
  kickoffAt: '2026-10-01T12:00:00Z', forecastAt: '2026-10-01T11:45:00Z',
  homeGoals: 2, awayGoals: 0, matrixA: matrix(0.7), matrixC: matrix(0.9), quotes: [quote()],
  phase: 'test', modelVersionA: 'A-fixed', modelVersionC: 'C-fixed', ...extra });
const options = { bootstrapSamples: 100, seed: 42 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-10, `${a} != ${b}`);
const calibration = (n = 60, extra = {}) => Array.from({ length: n }, (_, i) => ({
  matchId: `validation-${i}`, market: '1x2', probability: 0.9, odds: 2.4,
  expectedValue: 1.16, returnMultiplier: 2.4, outcomeAvailableAt: '2026-01-01T15:00:00Z', phase: 'validation', ...extra,
}));
const validationRows = (quotes = [quote()]) => Array.from({ length: 60 }, (_, i) => {
  const kickoff = new Date(Date.UTC(2026, 0, 1 + i, 12));
  const forecast = new Date(kickoff.getTime() - 15 * 60 * 1000).toISOString();
  return row({ matchId: `validation-${i}`, kickoffAt: kickoff.toISOString(), forecastAt: forecast,
    matrixA: matrix(), matrixC: matrix(), phase: 'validation',
    quotes: quotes.map((q) => ({ ...q, capturedAt: forecast, updatedAt: forecast })) });
});

test('primary metrics score the explicit holdout only and preserve baseline flat probabilities', () => {
  const target = row({ matrixA: matrix(0.2), probabilitiesA: { homeWin: 0.8, draw: 0.1, awayWin: 0.1 } });
  const report = evaluateResearchBenchmark([...validationRows(), target], options);
  assert.equal(report.A.n, 1); assert.equal(report.C.n, 1); assert.equal(report.paired.n, 1);
  close(report.A.logLoss, -Math.log(0.8)); close(report.A.brier, 0.06);
  close(report.C.logLoss, -Math.log(0.9)); assert.equal(report.protocol.validationMatches, 60);
  assert.equal(report.conclusion, 'inconclusive');
  const perturbed = evaluateResearchBenchmark([...validationRows().map((v) => ({ ...v, homeGoals: 0, awayGoals: 5 })), target], options);
  assert.deepEqual(report.A, perturbed.A); assert.deepEqual(report.C, perturbed.C);
});

test('validation labels that overlap the final holdout and unspecified phases are excluded', () => {
  const overlap = row({ matchId: 'overlap', phase: 'validation', kickoffAt: '2026-10-01T11:00:00Z', forecastAt: '2026-10-01T10:45:00Z' });
  const report = evaluateResearchBenchmark([row(), overlap, row({ matchId: 'unphased', phase: undefined })], options);
  assert.equal(report.A.n, 1); assert.equal(report.protocol.validationMatches, 0);
  assert.equal(report.exclusions.validation_overlaps_holdout, 1); assert.equal(report.exclusions.phase_missing, 1);
  assert.equal(report.economics.onePercent.A.bets, 0);
  const unchangedBoundary = evaluateResearchBenchmark([
    row({ homeGoals: null }),
    row({ matchId: 'later-test', kickoffAt: '2026-10-03T12:00:00Z', forecastAt: '2026-10-03T11:45:00Z' }),
    row({ matchId: 'intermediate-validation', phase: 'validation', kickoffAt: '2026-10-02T12:00:00Z', forecastAt: '2026-10-02T11:45:00Z' }),
  ], options);
  assert.equal(unchangedBoundary.protocol.validationMatches, 0);
  assert.equal(unchangedBoundary.protocol.validationFrozenBefore, '2026-10-01T11:45:00.000Z');
});

test('paired fixture and week bootstrap are deterministic and grouped readouts retain sample size', () => {
  const targets = Array.from({ length: 40 }, (_, i) => {
    const kickoff = new Date(Date.UTC(2026, 7, 1 + i * 2, 12));
    return row({ matchId: `pair-${i}`, kickoffAt: kickoff.toISOString(),
      forecastAt: new Date(kickoff.getTime() - 900000).toISOString(), quotes: [],
      competition: i % 2 ? 'Serie A' : 'La Liga', season: i < 20 ? '2025-26' : '2026-27' });
  });
  const report = evaluateResearchBenchmark(targets, options);
  assert.deepEqual(report, evaluateResearchBenchmark([...targets].reverse(), options));
  assert.equal(report.byLeague['Serie A'].n, 20); assert.equal(report.bySeason['2026-27'].n, 20);
  assert.ok(report.paired.weekClusters >= 4); assert.ok(report.paired.logLossCI[1] < 0);
  assert.equal(report.conclusion, 'C_supported_on_primary_holdout');
});

test('decision abstains without sufficient independent, past validation evidence', () => {
  const input = { matrix: matrix(), quotes: [quote()], now: '2026-10-01T11:45:00Z' };
  assert.equal(selectResearchDecision(input), null);
  assert.equal(explainResearchDecision(input).reasons.insufficient_validation_calibration, 1);
  assert.equal(selectResearchDecision({ ...input, calibrationSamples: calibration(49) }), null);
  assert.equal(selectResearchDecision({ ...input, calibrationSamples: calibration(60, { matchId: 'same-match' }) }), null);
  assert.equal(selectResearchDecision({ ...input, calibrationSamples: calibration(60, { phase: 'test' }) }), null);
  assert.equal(selectResearchDecision({ ...input, calibrationSamples: calibration(60, { outcomeAvailableAt: '2026-10-02T00:00:00Z' }) }), null);
  const decision = selectResearchDecision({ ...input, calibrationSamples: calibration() });
  assert.equal(decision.calibrationN, 60); assert.ok(decision.prudentialEv > 0.01);
  assert.equal(decision.prudentialMethod, 'validation_payout_residual_hoeffding');
  assert.ok(decision.prudentialEv <= decision.ev); assert.ok(decision.uncertainty > 0);
  const poorValidation = explainResearchDecision({ ...input,
    calibrationSamples: calibration(60, { returnMultiplier: 0 }) });
  assert.equal(poorValidation.decision, null);
  assert.equal(poorValidation.reasons.prudential_ev_below_threshold, 1);
});

test('future and unverified historical prices cannot produce decisions', () => {
  const input = { matrix: matrix(), quotes: [quote()], now: '2026-10-01T11:45:00Z', calibrationSamples: calibration() };
  for (const q of [quote({ capturedAt: '2026-10-01T11:46:00Z' }), quote({ updatedAt: '2026-10-01T11:46:00Z' }),
    quote({ source: 'football_data', priceType: undefined }), quote({ source: 'synthetic' }),
    quote({ priceType: 'closing' }), quote({ capturedAt: '' })]) {
    assert.equal(selectResearchDecision({ ...input, quotes: [q] }), null);
  }
  assert.equal(selectResearchDecision({ ...input, now: undefined }), null);
  const opening = selectResearchDecision({ ...input, quotes: [quote({ source: 'football_data', priceType: 'opening' })] });
  assert.equal(opening.priceType, 'opening');
});

test('observed historical snapshots retain missing provider updates and cannot become T-15 prices', () => {
  const now = '2026-10-01T11:45:00Z';
  const q = quote({ capturedAt: now, updatedAt: undefined, timestampEvidence: 'observed_snapshot', priceType: 'prematch' });
  const input = { matrix: matrix(), quotes: [q], now, calibrationSamples: calibration(), historical: true };
  assert.ok(selectResearchDecision(input));
  assert.equal(q.updatedAt, undefined);
  assert.equal(selectResearchDecision({ ...input, historical: false }), null);
  assert.equal(selectResearchDecision({ ...input, quotes: [{ ...q, priceType: 't15' }] }), null);
  assert.equal(selectResearchDecision({ ...input, now: '2026-10-01T11:46:00Z' }), null);
});

test('economic simulation floors stakes and rounds payouts exactly like the persistent cent ledger', () => {
  const targets = [row({ matchId: 'cent-first', matrixA: matrix(), matrixC: matrix(), quotes: [quote({ odds: 1.95 })] }),
    row({ matchId: 'cent-second', matrixA: matrix(), matrixC: matrix(),
      kickoffAt: '2026-10-09T12:00:00Z', forecastAt: '2026-10-09T11:45:00Z',
      quotes: [quote({ odds: 1.95, capturedAt: '2026-10-09T11:44:00Z', updatedAt: '2026-10-09T11:44:00Z' })] })];
  const report = evaluateResearchBenchmark([...validationRows([quote({ odds: 1.95 })]), ...targets], options);
  const results = report.economics.onePercent.A;
  assert.deepEqual(results.records.map((bet) => bet.stakeCents), [1000, 1009]);
  assert.deepEqual(results.records.map((bet) => bet.returnCents), [1950, 1968]);
  assert.equal(results.finalBankroll, 1019.09);
  assert.equal(results.netProfit, 19.09);
  assert.equal(results.accountingProtocol, 'integer_cents_floor_stake_round_payout_v2');
  assert.ok(results.uncertainty.roiCI.every(Number.isFinite));
});

test('same-time allocation caps exposure at 5% with fixed 1% stakes and deterministic ties', () => {
  const targets = Array.from({ length: 25 }, (_, i) => row({ matchId: `sim-${String(i).padStart(2, '0')}`, matrixA: matrix(), matrixC: matrix() }));
  const report = evaluateResearchBenchmark([...validationRows(), ...targets.reverse()], options);
  assert.equal(report.economics.onePercent.A.bets, 5);
  assert.equal(report.economics.onePercent.A.exclusions.max_exposure_exceeded, 20);
  close(report.economics.onePercent.A.totalStaked, 50);
  close(report.economics.onePercent.A.finalBankroll, 1070);
  assert.deepEqual(report.economics.onePercent.A.records.map((b) => b.matchId), targets.map((r) => r.matchId).sort().slice(0, 5));
  assert.equal(report.economics.onePercent.A.maxExposureFraction, 0.05);
  assert.equal(report.economics.onePercent.A.equityCurve.length, 1);
  assert.equal(report.economics.onePercent.A.equityCurve[0].equityCents, 107000);
  assert.equal(report.economics.onePercent.A.winRate, 1);
  assert.equal(report.decisionDifferences.same, 25);
});

test('simulated partial losses refund half the stake and test labels cannot choose the market', () => {
  const q = quote({ market: 'asian_handicap', selection: 'ahcp_-0.25', side: 'home', line: -0.25 });
  const target = row({ matrixA: matrix(), matrixC: matrix(), homeGoals: 1, awayGoals: 1, quotes: [q] });
  const report = evaluateResearchBenchmark([...validationRows([q]), target], options);
  const A = report.economics.onePercent.A;
  assert.equal(A.bets, 1); assert.equal(A.records[0].status, 'HALF_LOST');
  close(A.netProfit, -5); close(A.finalBankroll, 995);
  const winner = evaluateResearchBenchmark([...validationRows([q]), { ...target, homeGoals: 2, awayGoals: 0 }], options);
  assert.equal(winner.economics.onePercent.A.records[0].selection, A.records[0].selection);
  assert.equal(report.exclusions.non_binary_market_score_excluded, 1);
});

test('CLV uses only later verified same-bookmaker closing snapshots and opening prices are not T15', () => {
  const opening = quote({ priceType: 'opening', source: 'football_data' });
  const closing = quote({ odds: 2, capturedAt: '2026-10-01T11:59:00Z', updatedAt: '2026-10-01T11:58:30Z' });
  const target = row({ matrixA: matrix(), matrixC: matrix(), quotes: [opening], closingQuotes: [closing] });
  const report = evaluateResearchBenchmark([...validationRows([opening]), target], options);
  close(report.economics.onePercent.A.averageClv, 0.2);
  assert.equal(report.economics.onePercent.A.clvN, 1);
  assert.equal(report.economics.onePercent.A.verifiedT15Bets, 0);
  assert.equal(report.economics.onePercent.A.openingBets, 1);
  const bad = evaluateResearchBenchmark([...validationRows([opening]), { ...target,
    closingQuotes: [{ ...closing, capturedAt: '2026-10-01T12:01:00Z' }] }], options);
  assert.equal(bad.economics.onePercent.A.averageClv, null);
});

test('duplicate rows, invalid forecast chronology and outcomes never silently inflate metrics', () => {
  const report = evaluateResearchBenchmark([row(), row(), row({ matchId: 'started', forecastAt: '2026-10-01T12:00:00Z' }),
    row({ matchId: 'unknown-result', homeGoals: null })], options);
  assert.equal(report.A.n, 1); assert.equal(report.exclusions.duplicate_or_missing_match_id, 1);
  assert.equal(report.exclusions.invalid_forecast_chronology, 1); assert.equal(report.exclusions.outcome_missing, 1);
  const empty = evaluateResearchBenchmark([], options);
  assert.equal(empty.A.logLoss, null); assert.equal(empty.paired.logLossCI, null); assert.equal(empty.conclusion, 'inconclusive');
});

test('full pipeline calibrates only preceding labels and does not recycle calibration labels as prudential evidence', () => {
  const calibrationRows = validationRows();
  const target = row({ matrixA: matrix(0.85), matrixC: matrix(0.9) });
  const report = evaluateResearchPipelineBenchmark([...calibrationRows, target], options);
  assert.equal(report.probabilityPipeline, 'existing_isotonic_and_bookmaker_blend_v1');
  assert.equal(report.calibrationProfiles.A.matches, 60);
  assert.equal(report.economics.onePercent.A.bets, 0);
  assert.equal(report.economics.onePercent.C.bets, 0);
  assert.equal(report.rawProbabilityMetrics.A.n, 1);
  const changedTest = evaluateResearchPipelineBenchmark([...calibrationRows, { ...target, homeGoals: 0, awayGoals: 5 }], options);
  assert.deepEqual(changedTest.calibrationProfiles, report.calibrationProfiles);
  assert.notEqual(changedTest.A.logLoss, report.A.logLoss);
});

test('bookmaker comparison requires a complete same-operator 1X2 snapshot on paired matches', () => {
  const prices = [quote({ side: 'home', odds: 2 }), quote({ selection: 'draw', side: 'draw', odds: 3 }),
    quote({ selection: 'awayWin', side: 'away', odds: 4 })];
  const report = evaluateResearchBenchmark([row({ quotes: prices }), row({ matchId: 'missing-companion' })], options);
  assert.equal(report.bookmakerBenchmark.n, 1);
  close(report.bookmakerBenchmark.bookmaker.logLoss, -Math.log(0.5 / (0.5 + 1 / 3 + 0.25)));
  assert.equal(report.bookmakerBenchmark.AOnSameMatches.n, 1);
  const mixed = evaluateResearchBenchmark([row({ quotes: prices.map((q, i) => i ? { ...q, bookmaker: 'Different operator' } : q) })], options);
  assert.equal(mixed.bookmakerBenchmark.n, 0);
});
