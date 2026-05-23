const test = require('node:test');
const assert = require('node:assert/strict');
const {
  matchFixturesToMatches,
  normalizeTeamForOdds,
} = require('../dist/services/odds-provider/oddsProviderUtils.js');

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
