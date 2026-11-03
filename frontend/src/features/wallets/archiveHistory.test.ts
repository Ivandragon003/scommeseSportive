import { archiveSummary, filterArchiveRows, historicalArchiveRows } from './archiveHistory';
import { ComparisonBet } from '../research/researchComparisonTypes';

const rows = historicalArchiveRows([
  { bet_id: 'won', match_id: 'old-1', home_team_name: 'Home', away_team_name: 'Away', market_name: '1X2', selection: 'homeWin',
    stake: 10, odds: 3, profit: 20, status: 'WON', classification: 'HIGH', placed_at: '2026-10-29T10:00:00Z', match_date: '2026-10-31T23:30:00Z' },
  { bet_id: 'lost', match_id: 'old-2', market_name: '1X2', selection: 'awayWin', stake: 8, odds: 2, profit: -8, status: 'LOST', placed_at: '2026-10-29T11:00:00Z' },
  { bet_id: 'open', match_id: 'old-3', market_name: '1X2', selection: 'draw', stake: 50, odds: 4, profit: null, status: 'PENDING', placed_at: '2026-10-29T12:00:00Z' },
]);

test('summary uses net profit, excludes open stakes and never turns missing quality into LOW', () => {
  const summary = archiveSummary(rows);
  expect(summary).toEqual(expect.objectContaining({ total: 3, settled: 2, open: 1, wonCents: 2000, lostCents: -800, netCents: 1200 }));
  expect(rows[1].classification).toBeNull();
  expect(filterArchiveRows(rows, { model: 'all', status: 'all', from: '', to: '', qualities: ['LOW'] })).toHaveLength(0);
});

test('Rome match date and quality filters apply to the same rows used by the summary', () => {
  const filtered = filterArchiveRows(rows, { model: 'baseline', status: 'settled', from: '2026-11-01', to: '2026-11-01', qualities: ['HIGH'] });
  expect(filtered.map(row => row.id)).toEqual(['baseline:won']);
  expect(archiveSummary(filtered).netCents).toBe(2000);
});

test('a missing recorded profit is explicit rather than a fabricated zero', () => {
  const incomplete = { ...rows[0], profitCents: null } as ComparisonBet;
  expect(archiveSummary([incomplete])).toEqual(expect.objectContaining({ missingProfit: true, netCents: null, wonCents: null }));
});
