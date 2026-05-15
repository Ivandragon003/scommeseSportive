const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readRootFile = (fileName) =>
  fs.readFileSync(path.resolve(__dirname, '..', '..', fileName), 'utf8');

const assertComposeOddsRuntime = (fileName) => {
  const content = readRootFile(fileName);

  assert.match(content, /ODDS_PRIMARY_PROVIDER=\$\{ODDS_PRIMARY_PROVIDER:-eurobet\}/);
  assert.match(content, /SKIP_EUROBET_SCRAPER=\$\{SKIP_EUROBET_SCRAPER:-false\}/);
  assert.match(content, /THE_ODDS_API_KEY=\$\{THE_ODDS_API_KEY:-\}/);
  assert.match(content, /EUROBET_MATCH_TIMEOUT_MS=\$\{EUROBET_MATCH_TIMEOUT_MS:-180000\}/);
  assert.match(content, /ODDS_EVENT_TIMEOUT_MS=\$\{ODDS_EVENT_TIMEOUT_MS:-60000\}/);
  assert.match(content, /ODDS_PROVIDER_MATCH_TIMEOUT_MS=\$\{ODDS_PROVIDER_MATCH_TIMEOUT_MS:-45000\}/);
};

test('docker-compose.yml espone provider Eurobet default e timeout compatibili con Playwright', () => {
  assertComposeOddsRuntime('docker-compose.yml');
});

test('docker-compose.prod.yml espone provider Eurobet default e timeout compatibili con Playwright', () => {
  assertComposeOddsRuntime('docker-compose.prod.yml');
});
