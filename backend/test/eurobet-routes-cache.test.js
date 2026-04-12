const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildEurobetCompetitionCacheKey,
  shouldUseEurobetCompetitionCache,
} = require('../dist/api/routes.js');

test('Eurobet cache key bulk resta stabile per richieste competition-wide', () => {
  const first = buildEurobetCompetitionCacheKey({
    competition: 'Serie A',
    includeExtendedGroups: false,
  });
  const second = buildEurobetCompetitionCacheKey({
    competition: 'Serie A',
    includeExtendedGroups: false,
    fixtures: [],
  });

  assert.equal(first, second);
  assert.equal(shouldUseEurobetCompetitionCache(undefined), true);
  assert.equal(shouldUseEurobetCompetitionCache([]), true);
});

test('Eurobet fixture signature distingue match diversi della stessa competizione', () => {
  const first = buildEurobetCompetitionCacheKey({
    competition: 'Serie A',
    includeExtendedGroups: false,
    fixtures: [
      {
        homeTeam: 'Inter',
        awayTeam: 'Milan',
        commenceTime: '2026-04-12T18:45:00.000Z',
      },
    ],
  });

  const second = buildEurobetCompetitionCacheKey({
    competition: 'Serie A',
    includeExtendedGroups: false,
    fixtures: [
      {
        homeTeam: 'Roma',
        awayTeam: 'Lazio',
        commenceTime: '2026-04-12T18:45:00.000Z',
      },
    ],
  });

  assert.notEqual(first, second);
  assert.equal(shouldUseEurobetCompetitionCache([
    {
      homeTeam: 'Inter',
      awayTeam: 'Milan',
      commenceTime: '2026-04-12T18:45:00.000Z',
    },
  ]), false);
});

test('Eurobet fixture signature normalizza il commenceTime per evitare chiavi instabili', () => {
  const first = buildEurobetCompetitionCacheKey({
    competition: 'Serie A',
    includeExtendedGroups: true,
    fixtures: [
      {
        homeTeam: 'Inter',
        awayTeam: 'Milan',
        commenceTime: '2026-04-12T18:45:00.000Z',
      },
    ],
  });

  const second = buildEurobetCompetitionCacheKey({
    competition: 'Serie A',
    includeExtendedGroups: true,
    fixtures: [
      {
        homeTeam: 'Inter',
        awayTeam: 'Milan',
        commenceTime: '2026-04-12T20:45:00+02:00',
      },
    ],
  });

  assert.equal(first, second);
});
