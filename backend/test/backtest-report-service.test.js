const test = require('node:test');
const assert = require('node:assert/strict');
const { buildBacktestReport } = require('../dist/services/BacktestReportService.js');

const sampleResult = {
  kind: 'classic',
  competition: 'Serie A',
  season: '2025-26',
  usedSyntheticOddsOnly: false,
  detailedBets: [
    {
      matchId: 'm1',
      matchDate: '2026-01-10T19:45:00.000Z',
      competition: 'Serie A',
      season: '2025-26',
      marketName: 'Esito - 1',
      marketCategory: 'goal_1x2',
      selection: 'homeWin',
      odds: 2.1,
      impliedProbability: 1 / 2.1,
      ourProbability: 0.56,
      expectedValue: 0.08,
      edge: 0.0838,
      edgeNoVig: 0.09,
      confidence: 'HIGH',
      stake: 20,
      profit: 22,
      outcome: 'WON',
      won: true,
      isSynthetic: false,
      oddsSource: 'eurobet_scraper',
      snapshotSource: 'eurobet_scraper_bulk',
      oddsCapturedAt: '2026-01-10T18:00:00.000Z',
    },
    {
      matchId: 'm2',
      matchDate: '2026-01-12T19:45:00.000Z',
      competition: 'Serie A',
      season: '2025-26',
      marketName: 'Tiri Tot Over 25.5',
      marketCategory: 'shots',
      selection: 'shots_total_over_25.5',
      odds: 1.9,
      impliedProbability: 1 / 1.9,
      ourProbability: 0.6,
      expectedValue: 0.04,
      edge: 0.0737,
      edgeNoVig: 0.08,
      confidence: 'MEDIUM',
      stake: 10,
      profit: -10,
      outcome: 'LOST',
      won: false,
      isSynthetic: false,
      oddsSource: 'fallback',
      snapshotSource: 'the_odds_api_bulk_fallback_bookmaker',
      oddsCapturedAt: '2026-01-12T18:30:00.000Z',
    },
    {
      matchId: 'm3',
      matchDate: '2026-01-20T19:45:00.000Z',
      competition: 'Serie A',
      season: '2025-26',
      marketName: 'Over 2.5',
      marketCategory: 'goal_ou',
      selection: 'over25',
      odds: 2.5,
      impliedProbability: 1 / 2.5,
      ourProbability: 0.51,
      expectedValue: 0.275,
      edge: 0.11,
      edgeNoVig: 0.12,
      confidence: 'HIGH',
      stake: 15,
      profit: 22.5,
      outcome: 'WON',
      won: true,
      isSynthetic: true,
      oddsSource: 'synthetic',
      snapshotSource: 'model_estimated',
      oddsCapturedAt: null,
    },
  ],
};

test('buildBacktestReport aggrega metriche, segmenti e bucket', () => {
  const report = buildBacktestReport(sampleResult, {});

  assert.equal(report.run.kind, 'classic');
  assert.equal(report.dataset.legacyData, false);
  assert.equal(report.summary.totalBets, 3);
  assert.equal(report.summary.totalStaked, 45);
  assert.equal(report.summary.netProfit, 34.5);
  assert.equal(report.summary.hitRatePct, 66.67);
  assert.equal(report.summary.yieldPct, 76.67);
  assert.equal(report.summary.roiPct, 3.45);
  assert.equal(report.segments.bySource.length, 3);
  assert.equal(report.segments.byMarket.length, 3);
  assert.equal(report.calibration.probabilityBuckets.length >= 2, true);
  assert.equal(report.clv.available, false);
});

test('buildBacktestReport applica i filtri per market, source e data', () => {
  const report = buildBacktestReport(sampleResult, {
    market: 'shots',
    source: 'fallback',
    dateFrom: '2026-01-11T00:00:00.000Z',
    dateTo: '2026-01-15T23:59:59.000Z',
  });

  assert.equal(report.dataset.filteredBets, 1);
  assert.equal(report.summary.totalBets, 1);
  assert.equal(report.summary.netProfit, -10);
  assert.equal(report.segments.bySource[0].key, 'fallback');
  assert.equal(report.segments.byMarket[0].key, 'shots');
});

test('buildBacktestReport segnala run legacy senza detailed bets', () => {
  const report = buildBacktestReport({
    kind: 'classic',
    competition: 'Serie A',
    season: '2024-25',
    betsPlaced: 40,
    totalStaked: 120,
    totalReturn: 132,
    netProfit: 12,
    averageEV: 4.2,
    averageOdds: 1.98,
    winRate: 52.5,
    brierScore: 0.2012,
    logLoss: 0.6554,
  });

  assert.equal(report.dataset.legacyData, true);
  assert.equal(report.summary.totalBets, 40);
  assert.equal(report.alerts[0].type, 'legacy_data');
});
