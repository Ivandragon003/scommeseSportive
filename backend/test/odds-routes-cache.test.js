const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildOddsCompetitionCacheKey,
  shouldUseOddsCompetitionCache,
} = require('../dist/api/routes.js');
const fs = require('node:fs');
const path = require('node:path');

test('Odds API cache key bulk resta stabile per richieste competition-wide', () => {
  const first = buildOddsCompetitionCacheKey({
    competition: 'Serie A',
    includeExtendedGroups: false,
  });
  const second = buildOddsCompetitionCacheKey({
    competition: 'Serie A',
    includeExtendedGroups: false,
    fixtures: [],
  });

  assert.equal(first, second);
  assert.equal(shouldUseOddsCompetitionCache(undefined), true);
  assert.equal(shouldUseOddsCompetitionCache([]), true);
});

test('Odds API fixture signature distingue match diversi della stessa competizione', () => {
  const first = buildOddsCompetitionCacheKey({
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

  const second = buildOddsCompetitionCacheKey({
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
  assert.equal(shouldUseOddsCompetitionCache([
    {
      homeTeam: 'Inter',
      awayTeam: 'Milan',
      commenceTime: '2026-04-12T18:45:00.000Z',
    },
  ]), false);
});

test('Odds API fixture signature normalizza il commenceTime per evitare chiavi instabili', () => {
  const first = buildOddsCompetitionCacheKey({
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

  const second = buildOddsCompetitionCacheKey({
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

test('match odds cache resta bounded e rimuove scaduti opportunisticamente', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'api', 'routes.ts'), 'utf8');
  assert.match(source, /MATCH_ODDS_CACHE_MAX_ENTRIES = 200/);
  assert.match(source, /const pruneMatchOddsCache[\s\S]*cached\.cachedAt[\s\S]*?};/);
  assert.match(source, /const ensureMatchOddsCacheCapacityForInsert[\s\S]*if \(matchOddsCache\.has\(cacheKey\)\) return;[\s\S]*while \(matchOddsCache\.size >= MATCH_ODDS_CACHE_MAX_ENTRIES\)/);
  assert.match(source, /setCachedMatchOddsPayload[\s\S]*pruneMatchOddsCache\(\)[\s\S]*ensureMatchOddsCacheCapacityForInsert\(cacheKey\)/);
});
