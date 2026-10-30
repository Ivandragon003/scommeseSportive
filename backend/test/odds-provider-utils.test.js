const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchFixturesToMatches,
  mergeOddsMatchMarkets,
  normalizeTeamForOdds,
} = require('../dist/services/odds-provider/oddsProviderUtils.js');

test('market merge preserves originating captures and does not combine different provider updates', () => {
  const older = '2026-10-30T09:59:00.000Z', newer = '2026-10-30T10:00:00.000Z';
  const event = (capturedAt, markets) => ({ matchId: 'odds_1', homeTeam: 'Inter', awayTeam: 'Milan',
    commenceTime: '2026-10-30T19:00:00Z', capturedAt,
    bookmakers: [{ bookmakerKey: 'real', bookmakerName: 'Real', updatedAt: capturedAt, markets }] });
  const base = event(older, [{ marketKey: 'totals', updatedAt: older,
    outcomes: [{ name: 'Over', point: 2.5, price: 2.1 }] }]);
  const extra = event(newer, [{ marketKey: 'totals', updatedAt: newer,
    outcomes: [{ name: 'Under', point: 2.5, price: 2 }] }, { marketKey: 'alternate_totals_cards', updatedAt: newer,
    outcomes: [{ name: 'Over', point: 4.5, price: 1.9 }] }]);
  const merged = mergeOddsMatchMarkets(base, extra);
  const totals = merged.bookmakers[0].markets.find((market) => market.marketKey === 'totals');
  const cards = merged.bookmakers[0].markets.find((market) => market.marketKey === 'alternate_totals_cards');
  assert.deepEqual(totals.outcomes, extra.bookmakers[0].markets[0].outcomes);
  assert.equal(totals.updatedAt, newer); assert.equal(totals.capturedAt, newer);
  assert.equal(cards.capturedAt, newer);
  assert.equal(merged.capturedAt, older, 'the original core response is not retimestamped');
  assert.equal(base.bookmakers[0].markets[0].outcomes.length, 1);
  assert.equal(base.bookmakers[0].markets[0].capturedAt, undefined);
  const reversed = mergeOddsMatchMarkets(extra, base);
  assert.equal(reversed.bookmakers[0].markets.find((market) => market.marketKey === 'totals').updatedAt, newer);
});

const buildMatch = (overrides = {}) => ({
  matchId: overrides.matchId ?? 'odds_1',
  homeTeam: overrides.homeTeam ?? 'Internazionale',
  awayTeam: overrides.awayTeam ?? 'AC Milan',
  commenceTime: overrides.commenceTime ?? '2026-04-25T18:45:00.000Z',
  bookmakers: [],
});

test('normalizeTeamForOdds supporta alias comuni provider/locali', () => {
  assert.equal(normalizeTeamForOdds('Inter'), normalizeTeamForOdds('Internazionale'));
  assert.equal(normalizeTeamForOdds('Milan'), normalizeTeamForOdds('AC Milan'));
  assert.equal(normalizeTeamForOdds('Juve'), normalizeTeamForOdds('Juventus'));
  assert.equal(normalizeTeamForOdds('PSG'), normalizeTeamForOdds('Paris Saint-Germain'));
  assert.equal(normalizeTeamForOdds('Man City'), normalizeTeamForOdds('Manchester City'));
});

test('matchFixturesToMatches trova fixture con alias squadra e offset orario entro 36 ore', () => {
  const { matchedMatches, missingFixtures, diagnostics } = matchFixturesToMatches(
    [
      {
        homeTeam: 'Inter',
        awayTeam: 'Milan',
        commenceTime: '2026-04-25T20:45:00+02:00',
      },
    ],
    [
      buildMatch({
        homeTeam: 'Internazionale',
        awayTeam: 'AC Milan',
        commenceTime: '2026-04-25T18:45:00.000Z',
      }),
    ]
  );

  assert.equal(matchedMatches.length, 1);
  assert.equal(missingFixtures.length, 0);
  assert.equal(diagnostics[0].matched, true);
  assert.equal(diagnostics[0].matchedCandidate.homeTeam, 'Internazionale');
});

test('matchFixturesToMatches riduce falsi positivi: home/away invertite non vengono accettate', () => {
  const { matchedMatches, missingFixtures, diagnostics } = matchFixturesToMatches(
    [
      {
        homeTeam: 'Inter',
        awayTeam: 'Milan',
        commenceTime: '2026-04-25T18:45:00.000Z',
      },
    ],
    [
      buildMatch({
        homeTeam: 'AC Milan',
        awayTeam: 'Internazionale',
        commenceTime: '2026-04-25T18:45:00.000Z',
      }),
    ]
  );

  assert.equal(matchedMatches.length, 0);
  assert.equal(missingFixtures.length, 1);
  assert.equal(diagnostics[0].matched, false);
  assert.ok(diagnostics[0].warnings.includes('home_away_inverted_candidate'));
});

test('matchFixturesToMatches scarta stesso team con kickoff fuori finestra 36 ore', () => {
  const { matchedMatches, missingFixtures, diagnostics } = matchFixturesToMatches(
    [
      {
        homeTeam: 'Inter',
        awayTeam: 'Milan',
        commenceTime: '2026-04-25T18:45:00.000Z',
      },
    ],
    [
      buildMatch({
        homeTeam: 'Internazionale',
        awayTeam: 'AC Milan',
        commenceTime: '2026-04-28T18:45:00.000Z',
      }),
    ]
  );

  assert.equal(matchedMatches.length, 0);
  assert.equal(missingFixtures.length, 1);
  assert.equal(diagnostics[0].matched, false);
  assert.equal(diagnostics[0].candidates[0].reason, 'kickoff_outside_36h_window');
});

test('matchFixturesToMatches sceglie il candidato con orario vicino invece dello stesso match nel giorno sbagliato', () => {
  const { matchedMatches, missingFixtures, diagnostics } = matchFixturesToMatches(
    [
      {
        homeTeam: 'Fiorentina',
        awayTeam: 'Atalanta',
        commenceTime: '2026-05-22T18:45:00.000Z',
      },
    ],
    [
      buildMatch({
        matchId: 'wrong_day',
        homeTeam: 'Fiorentina',
        awayTeam: 'Atalanta',
        commenceTime: '2026-05-23T13:00:00.000Z',
      }),
      buildMatch({
        matchId: 'correct_time',
        homeTeam: 'Fiorentina',
        awayTeam: 'Atalanta',
        commenceTime: '2026-05-22T18:45:00.000Z',
      }),
    ]
  );

  assert.equal(matchedMatches.length, 1);
  assert.equal(missingFixtures.length, 0);
  assert.equal(matchedMatches[0].matchId, 'correct_time');
  assert.equal(diagnostics[0].matchedCandidate.matchId, 'correct_time');
  assert.ok(diagnostics[0].candidates[0].score > diagnostics[0].candidates[1].score);
});

test('matchFixturesToMatches segnala warning quando manca commenceTime e fa fallback sui nomi', () => {
  const { matchedMatches, diagnostics } = matchFixturesToMatches(
    [
      {
        homeTeam: 'Inter',
        awayTeam: 'Milan',
        commenceTime: null,
      },
    ],
    [
      buildMatch({
        homeTeam: 'Internazionale',
        awayTeam: 'AC Milan',
        commenceTime: '2026-04-25T18:45:00.000Z',
      }),
    ]
  );

  assert.equal(matchedMatches.length, 1);
  assert.ok(diagnostics[0].warnings.includes('missing_commence_time_for_fixture_matching'));
});
