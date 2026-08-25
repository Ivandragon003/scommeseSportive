const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const { fixedFiveSeasonPolicy, isCompleteUnderstatSeasonDetail } = require('../dist/api/routes.js');

test('nightly and runtime defaults request exactly five seasons', () => {
  const nightly = read('scripts', 'ci', 'nightly-sync.sh');
  const backend = read('backend', 'src', 'index.ts');
  const compose = read('docker-compose.yml');
  const composeProd = read('docker-compose.prod.yml');
  const frontendDockerfile = read('frontend', 'Dockerfile');
  assert.doesNotMatch(nightly, /FOOTBALL_DATA_KEEP_SEASONS/);
  assert.match(nightly, /\\"yearsBack\\":5/);
  assert.match(backend, /UNDERSTAT_SCHEDULER_YEARS_BACK = 5/);
  assert.match(compose, /UNDERSTAT_SCHEDULER_YEARS_BACK=5/);
  assert.match(composeProd, /UNDERSTAT_SCHEDULER_YEARS_BACK=5/);
  assert.match(compose, /API_FOOTBALL_ENABLED=\$\{API_FOOTBALL_ENABLED:-false\}/);
  assert.match(compose, /API_FOOTBALL_KEY=\$\{API_FOOTBALL_KEY:-\}/);
  assert.match(composeProd, /API_FOOTBALL_ENABLED=\$\{API_FOOTBALL_ENABLED:-false\}/);
  assert.match(composeProd, /API_FOOTBALL_KEY=\$\{API_FOOTBALL_KEY:-\}/);
  assert.match(nightly, /api\/player-availability\/sync-upcoming/);
  assert.doesNotMatch(nightly, /if \[\[ "\$API_FOOTBALL_ENABLED"/);
  assert.match(frontendDockerfile, /^FROM node:22-alpine AS builder/m);
});

test('policy API resta esattamente corrente piu quattro precedenti', () => {
  const policy = fixedFiveSeasonPolicy(new Date('2026-08-25T00:00:00Z'));
  assert.deepEqual(policy, {
    seasonLabels: ['2022/2023', '2023/2024', '2024/2025', '2025/2026', '2026/2027'],
    seasonStartYears: [2022, 2023, 2024, 2025, 2026],
    keepSeasons: 5,
    prune: true,
  });
  const routes = read('backend', 'src', 'api', 'routes.ts');
  assert.doesNotMatch(routes, /body\.keepSeasons|body\.prune === false/);
  assert.match(routes, /const retentionPolicy = fixedFiveSeasonPolicy\(\)/);
  assert.match(routes, /const seasonsToScrape = retentionPolicy\.seasonLabels/);
  assert.doesNotMatch(routes, /generateSeasons\(6\)/);
  assert.match(routes, /const seasons = fixedFiveSeasonPolicy\(\)\.seasonLabels/);
  const transitionRoute = routes.slice(
    routes.indexOf("router.post('/competition-transitions/sync-references'"),
    routes.indexOf("router.get('/competition-transitions/competitions'"),
  );
  assert.match(transitionRoute, /const policy = fixedFiveSeasonPolicy\(\)/);
  assert.doesNotMatch(transitionRoute, /seasonStartYears\.map|requestedYears/);
});

test('ogni entry point di ingest applica la retention prima della rete', () => {
  const routes = read('backend', 'src', 'api', 'routes.ts');
  const footballDataRoute = routes.slice(
    routes.indexOf("router.post('/scraper/football-data'"),
    routes.indexOf("router.post('/predict'"),
  );
  assert.ok(footballDataRoute.indexOf('pruneOldSeasons') < footballDataRoute.indexOf('syncFootballData'));

  const transitionRoute = routes.slice(
    routes.indexOf("router.post('/competition-transitions/sync-references'"),
    routes.indexOf("router.get('/competition-transitions/competitions'"),
  );
  assert.ok(transitionRoute.indexOf('pruneOldSeasons') < transitionRoute.indexOf('syncTransitionSeasonReferences'));

  const understatRoute = routes.slice(
    routes.indexOf('async function runUnderstatImport'),
    routes.indexOf("router.post('/scraper/understat'"),
  );
  assert.ok(understatRoute.indexOf('pruneOldSeasons') < understatRoute.indexOf('for (const comp of competitionsToRun)'));
});

test('la nightly fallisce se una coppia Understat campionato-stagione non e completa', () => {
  assert.equal(isCompleteUnderstatSeasonDetail({ totalOnSource: 380, persistedSourceMatches: 380, missingSourceMatches: 0, error: null }), true);
  assert.equal(isCompleteUnderstatSeasonDetail({ totalOnSource: 0, persistedSourceMatches: 0, missingSourceMatches: 0, error: null }), false);
  assert.equal(isCompleteUnderstatSeasonDetail({ totalOnSource: 380, persistedSourceMatches: 379, missingSourceMatches: 1, error: null }), false);
  assert.equal(isCompleteUnderstatSeasonDetail({ totalOnSource: 380, persistedSourceMatches: 380, missingSourceMatches: 0, error: 'provider down' }), false);
});

test('lo script nightly tratta football-data e transizioni come gate obbligatori', () => {
  const nightly = read('scripts', 'ci', 'nightly-sync.sh');
  const supplementalBlock = nightly.slice(
    nightly.indexOf('Running football-data.co.uk supplemental sync'),
    nightly.indexOf('Saving local last-five lineup predictions'),
  );
  const transitionBlock = nightly.slice(
    nightly.indexOf('Syncing second-division seasonal references'),
    nightly.indexOf('# The Understat route already settles'),
  );
  assert.doesNotMatch(supplementalBlock, /Warning: supplemental football-data sync failed/);
  assert.doesNotMatch(transitionBlock, /Warning: transition reference sync failed/);
  assert.match(nightly, /REQUIRED_SYNC_FAILURES=\(\)/);
  assert.match(nightly, /REQUIRED_SYNC_FAILURES\+=\("understat"\)/);
  assert.match(nightly, /REQUIRED_SYNC_FAILURES\+=\("football-data"\)/);
  assert.match(nightly, /REQUIRED_SYNC_FAILURES\+=\("second-division-references"\)/);
  const failureGate = nightly.indexOf('Required data gates failed:');
  assert.ok(failureGate > nightly.indexOf('/api/scraper/understat'));
  assert.ok(failureGate > nightly.indexOf('/api/scraper/football-data'));
  assert.ok(failureGate > nightly.indexOf('/api/competition-transitions/sync-references'));
  assert.ok(failureGate < nightly.indexOf('/api/automation/place-valid-bets'));
});
