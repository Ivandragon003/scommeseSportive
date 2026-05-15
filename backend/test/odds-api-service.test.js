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

test('extractBestOdds maps extended statistical and player markets without collapsing selections', () => {
  const service = new OddsApiService('test-key');
  const match = {
    matchId: 'odds_2',
    homeTeam: 'Inter',
    awayTeam: 'Milan',
    commenceTime: '2026-03-28T19:45:00Z',
    bookmakers: [
      {
        bookmakerKey: 'pinnacle',
        bookmakerName: 'Pinnacle',
        markets: [
          {
            marketKey: 'shots',
            outcomes: [
              { name: 'Over', price: 1.9, point: 25.5, description: 'Shots' },
              { name: 'Under', price: 1.9, point: 25.5, description: 'Shots' },
            ],
          },
          {
            marketKey: 'shots_on_target',
            outcomes: [
              { name: 'Over', price: 1.85, point: 8.5, description: 'Shots On Target' },
            ],
          },
          {
            marketKey: 'corners',
            outcomes: [
              { name: 'Over', price: 1.8, point: 9.5, description: 'Corners' },
            ],
          },
          {
            marketKey: 'cards',
            outcomes: [
              { name: 'Over', price: 1.77, point: 4.5, description: 'Cards' },
            ],
          },
          {
            marketKey: 'fouls',
            outcomes: [
              { name: 'Over', price: 1.92, point: 22.5, description: 'Fouls' },
            ],
          },
          {
            marketKey: 'player_shots',
            outcomes: [
              { name: 'Over', price: 2.1, point: 1.5, description: 'Lautaro Martinez' },
              { name: 'Over', price: 2.35, point: 1.5, description: 'Rafael Leao' },
            ],
          },
        ],
      },
    ],
  };

  const odds = service.extractBestOdds(match, 'pinnacle');

  assert.equal(odds['shots_total_over_25.5'], 1.9);
  assert.equal(odds['shots_total_under_25.5'], 1.9);
  assert.equal(odds['sot_total_over_8.5'], 1.85);
  assert.equal(odds['corners_over_9.5'], 1.8);
  assert.equal(odds['yellow_over_4.5'], 1.77);
  assert.equal(odds['fouls_over_22.5'], 1.92);
  assert.equal(odds['player_shots_lautaro_martinez_over_1.5'], 2.1);
  assert.equal(odds['player_shots_rafael_leao_over_1.5'], 2.35);
});
