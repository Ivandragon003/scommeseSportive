const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readRootFile = (fileName) =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', fileName), 'utf8');

test('Compose carica la configurazione provider da .env senza sovrascriverla', () => {
  const content = readRootFile('docker-compose.yml');
  assert.match(content, /env_file:\s*\r?\n\s*- \.env\s/);
  assert.match(content, /NODE_ENV:\s*production/);
  assert.match(content, /condition:\s*service_healthy/);
  assert.match(content, /http:\/\/localhost:3001\/api\/health/);
  assert.doesNotMatch(content, /(?:ODDS_PRIMARY_PROVIDER|ODDS_API_KEY|THE_ODDS_API_KEY|API_FOOTBALL_KEY)\s*[:=]/);
  assert.doesNotMatch(content, /SKIP_EUROBET_SCRAPER/);
  assert.doesNotMatch(content, /EUROBET_/);
});

test('frontend Docker compila i sorgenti senza dipendere da una build locale', () => {
  const content = readRootFile('frontend/Dockerfile');
  assert.match(content, /^FROM node:22-alpine AS builder/m);
  assert.match(content, /RUN npm ci/);
  assert.match(content, /COPY src \.\/src/);
  assert.match(content, /RUN npm run build/);
  assert.match(content, /COPY --from=builder \/app\/build \/usr\/share\/nginx\/html/);
  assert.doesNotMatch(content, /^COPY build /m);
  assert.match(readRootFile('frontend/.dockerignore'), /^build\s*$/m);
});

test('Docker delegates nightly jobs to GitHub but keeps near-kickoff lineup refresh', () => {
  const content = readRootFile('docker-compose.yml');
  for (const flag of [
    'AUTO_SYNC_ON_BOOT', 'UNDERSTAT_SCHEDULER_ENABLED',
    'ODDS_SNAPSHOT_SCHEDULER_ENABLED', 'LEARNING_REVIEW_SCHEDULER_ENABLED',
  ]) {
    assert.ok(content.includes(flag + ': "false"'), flag);
    assert.ok(!content.includes(flag + ': ${'), 'nightly flags must override stale .env settings');
  }
  assert.ok(content.includes('LINEUP_REFRESH_SCHEDULER_ENABLED: ${LINEUP_REFRESH_SCHEDULER_ENABLED:-true}'));
  const workflow = readRootFile('.github/workflows/nightly-sync.yml');
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /bash scripts\/ci\/nightly-sync\.sh/);
});
