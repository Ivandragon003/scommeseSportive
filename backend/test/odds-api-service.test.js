const test = require('node:test');
const assert = require('node:assert/strict');
const { OddsApiService } = require('../dist/services/OddsApiService.js');

test('compareBookmakers keeps non-h2h soccer markets such as corners and cards', () => {
  const service = new OddsApiService('test-key');
  const match = {
    matchId: 'odds_1',
    homeTeam: 'Inter',
    awayTeam: 'Milan',
    commenceTime: '2026-03-28T19:45:00Z',
    bookmakers: [
      {
        bookmakerKey: 'eurobet',
        bookmakerName: 'Eurobet',
        markets: [
          {
            marketKey: 'h2h',
            outcomes: [
              { name: 'Inter', price: 1.95 },
              { name: 'Draw', price: 3.4 },
              { name: 'Milan', price: 4.1 },
            ],
          },
          {
            marketKey: 'alternate_totals_corners',
            outcomes: [
              { name: 'Over', price: 1.88, point: 9.5 },
              { name: 'Under', price: 1.92, point: 9.5 },
            ],
          },
          {
            marketKey: 'alternate_totals_cards',
            outcomes: [
              { name: 'Over', price: 1.83, point: 4.5 },
              { name: 'Under', price: 1.97, point: 4.5 },
            ],
          },
        ],
      },
    ],
  };

  const eurobetOdds = service.extractBestOdds(match, 'eurobet');
  const comparison = service.compareBookmakers(match);

  assert.equal(eurobetOdds.homeWin, 1.95);
  assert.equal(eurobetOdds['corners_over_9.5'], 1.88);
  assert.equal(eurobetOdds['corners_under_9.5'], 1.92);
  assert.equal(eurobetOdds['yellow_over_4.5'], 1.83);
  assert.equal(eurobetOdds['yellow_under_4.5'], 1.97);

  assert.equal(comparison.Eurobet.homeWin, 1.95);
  assert.equal(comparison.Eurobet['corners_over_9.5'], 1.88);
  assert.equal(comparison.Eurobet['yellow_over_4.5'], 1.83);
});
