const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..', '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const {
  fixedFiveSeasonPolicy,
  isCompleteUnderstatSeasonDetail,
  isExpectedPendingCurrentSeasonDetail,
  summarizeUnderstatSeasonReadiness,
} = require('../dist/api/routes.js');

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

test('il backend temporaneo della nightly disabilita solo in CI la sessione amministratore', () => {
  const nightly = read('scripts', 'ci', 'nightly-sync.sh');
  const backendStart = nightly.slice(
    nightly.indexOf('echo "Starting backend for CI sync..."'),
    nightly.indexOf('echo "Waiting for backend health..."'),
  );

  assert.match(backendStart, /NODE_ENV=ci \\\n/);
  assert.match(backendStart, /SHARED_ADMIN_AUTH_ENABLED=false \\\n/);
  assert.doesNotMatch(backendStart, /NODE_ENV=production/);
});

test('la nightly autorizza esplicitamente solo la propria origine loopback per le POST', () => {
  const nightly = read('scripts', 'ci', 'nightly-sync.sh');
  const postJson = nightly.slice(
    nightly.indexOf('post_json()'),
    nightly.indexOf('get_json()'),
  );
  const backendStart = nightly.slice(
    nightly.indexOf('echo "Starting backend for CI sync..."'),
    nightly.indexOf('echo "Waiting for backend health..."'),
  );

  assert.match(postJson, /-H "Origin: http:\/\/127\.0\.0\.1:\$PORT"/);
  assert.match(backendStart, /CORS_ORIGIN="http:\/\/127\.0\.0\.1:\$PORT" \\\n/);
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

test('la stagione corrente vuota e pending solo nel pre-campionato e senza errori provider', () => {
  const empty = { totalOnSource: 0, persistedSourceMatches: 0, missingSourceMatches: 0, error: null };
  assert.equal(
    isExpectedPendingCurrentSeasonDetail(empty, 'Bundesliga', '2026/2027', new Date('2026-08-25T00:00:00Z')),
    true,
  );
  assert.equal(
    isExpectedPendingCurrentSeasonDetail(empty, 'Bundesliga', '2025/2026', new Date('2026-08-25T00:00:00Z')),
    false,
  );
  assert.equal(
    isExpectedPendingCurrentSeasonDetail(empty, 'Bundesliga', '2026/2027', new Date('2026-08-27T22:00:00Z')),
    false,
  );
  assert.equal(
    isExpectedPendingCurrentSeasonDetail({ ...empty, error: 'provider down' }, 'Bundesliga', '2026/2027', new Date('2026-08-25T00:00:00Z')),
    false,
  );
  assert.equal(
    isExpectedPendingCurrentSeasonDetail(empty, 'Serie A', '2026/2027', new Date('2026-08-25T00:00:00Z')),
    false,
  );
});

test('il riepilogo accetta pending solo con le quattro stagioni precedenti complete', () => {
  const complete = { totalOnSource: 380, persistedSourceMatches: 380, missingSourceMatches: 0, error: null };
  const empty = { totalOnSource: 0, persistedSourceMatches: 0, missingSourceMatches: 0, error: null };
  const seasons = ['2022/2023', '2023/2024', '2024/2025', '2025/2026', '2026/2027'];
  const seasonSummary = Object.fromEntries(seasons.map((season) => [`Bundesliga ${season}`, complete]));
  seasonSummary['Bundesliga 2026/2027'] = empty;

  const ready = summarizeUnderstatSeasonReadiness({
    competitions: ['Bundesliga'], seasons, seasonSummary, now: new Date('2026-08-25T00:00:00Z'),
  });
  assert.equal(ready.expectedSeasonPairs, 5);
  assert.equal(ready.completedSeasonPairs, 4);
  assert.equal(ready.pendingSeasonPairs.length, 1);
  assert.equal(ready.failedSeasonPairs.length, 0);
  assert.equal(ready.allExpectedSeasonsComplete, false);
  assert.equal(ready.allExpectedSeasonsReady, true);

  seasonSummary['Bundesliga 2025/2026'] = empty;
  const blocked = summarizeUnderstatSeasonReadiness({
    competitions: ['Bundesliga'], seasons, seasonSummary, now: new Date('2026-08-25T00:00:00Z'),
  });
  assert.equal(blocked.pendingSeasonPairs.length, 0);
  assert.equal(blocked.allExpectedSeasonsReady, false);
  assert.deepEqual(blocked.failedSeasonPairs.map((pair) => pair.key).sort(), [
    'Bundesliga 2025/2026',
    'Bundesliga 2026/2027',
  ]);
});

test('il pending Bundesliga termina alla data ufficiale di avvio in ora di Roma', () => {
  const empty = { totalOnSource: 0, persistedSourceMatches: 0, missingSourceMatches: 0, error: null };
  assert.equal(
    isExpectedPendingCurrentSeasonDetail(empty, 'Bundesliga', '2026/2027', new Date('2026-08-27T21:59:59Z')),
    true,
  );
  assert.equal(
    isExpectedPendingCurrentSeasonDetail(empty, 'Bundesliga', '2026/2027', new Date('2026-08-27T22:00:00Z')),
    false,
  );
});

test('i timeout distinti restano entro il budget totale del job', () => {
  const nightly = read('scripts', 'ci', 'nightly-sync.sh');
  const workflow = read('.github', 'workflows', 'nightly-sync.yml');
  assert.match(nightly, /FOOTBALL_DATA_TIMEOUT_SECONDS="\$\{FOOTBALL_DATA_TIMEOUT_SECONDS:-2400\}"/);
  assert.match(nightly, /TRANSITION_REFERENCE_TIMEOUT_SECONDS="\$\{TRANSITION_REFERENCE_TIMEOUT_SECONDS:-600\}"/);
  assert.match(workflow, /timeout-minutes: 180/);

  const envTimeout = (name) => Number(workflow.match(new RegExp(`${name}: '(\\d+)'`))?.[1]);
  const totalSeconds = envTimeout('UNDERSTAT_SYNC_TIMEOUT_SECONDS')
    + envTimeout('FOOTBALL_DATA_TIMEOUT_SECONDS')
    + envTimeout('TRANSITION_REFERENCE_TIMEOUT_SECONDS')
    + envTimeout('API_FOOTBALL_TIMEOUT_SECONDS')
    + envTimeout('PREDICTIONS_SETTLEMENT_TIMEOUT_SECONDS')
    + envTimeout('ODDS_SYNC_TIMEOUT_SECONDS') * 5
    + envTimeout('AUTO_BET_TIMEOUT_SECONDS')
    + envTimeout('LEARNING_SYNC_TIMEOUT_SECONDS')
    + envTimeout('FINAL_STATUS_TIMEOUT_SECONDS');
  assert.ok(Number.isFinite(totalSeconds));
  assert.ok(totalSeconds <= 180 * 60, `budget timeout ${totalSeconds}s oltre il job`);
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

test('la route football-data accetta solo stagioni complete o pending espliciti', () => {
  const routes = read('backend', 'src', 'api', 'routes.ts');
  const block = routes.slice(
    routes.indexOf("router.post('/scraper/football-data'"),
    routes.indexOf('// ====== PREDICT ======'),
  );
  assert.match(block, /sync\.allExpectedSeasonsReady/);
  assert.doesNotMatch(block, /sync\.completed !== sync\.requested/);
});
