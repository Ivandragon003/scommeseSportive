const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');

const root = join(__dirname, '../..');
const script = readFileSync(join(root, 'scripts/ci/nightly-sync.sh'), 'utf8');
const workflow = readFileSync(join(root, '.github/workflows/nightly-sync.yml'), 'utf8');

test('nightly has no path or stale flag that can register or reserve future betting decisions', () => {
  assert.doesNotMatch(script, /place-valid-bets|AUTO_BET|\/bets\/place|research\/t15|research\/tick/);
  assert.doesNotMatch(workflow, /AUTO_BET|place-valid-bets/);
  assert.match(script, /RESEARCH_T15_SCHEDULER_ENABLED=false \\\r?\n/);
  assert.match(workflow, /RESEARCH_T15_SCHEDULER_ENABLED: 'false'/);
  assert.match(workflow, /RUN_ODDS_SYNC: 'false'/);
  assert.match(workflow, /ODDS_INFORMATIONAL_NETWORK_ENABLED: 'false'/);
  assert.match(script, /RUN_ODDS_SYNC="\$\{RUN_ODDS_SYNC:-false\}"/);
  for (const route of [
    '/api/scraper/understat', '/api/scraper/football-data',
    '/api/competition-transitions/sync-references', '/api/bets/sync',
    '/api/predictions/settle-completed', '/api/learning/reviews/sync',
  ]) assert.ok(script.includes(route), `maintenance retained: ${route}`);
  assert.match(script, /run calibration:warm/);
  assert.ok(script.indexOf('/api/research/nightly-complete') > script.indexOf('if (( ${#REQUIRED_SYNC_FAILURES[@]} > 0 ))'));
});

test('web and maintenance entrypoint cannot start automatic decisions even with a stale worker flag', () => {
  const web = readFileSync(join(root, 'backend/src/index.ts'), 'utf8');
  assert.doesNotMatch(web, /ResearchRuntime|new\s+T15Scheduler|RESEARCH_T15_SCHEDULER_ENABLED/);
  assert.match(web, /Web process does not run automatic decisions/);
  const routes = readFileSync(join(root, 'backend/src/api/routes.ts'), 'utf8');
  const placementRoutes = [...routes.matchAll(/router\.post\('([^']+)'/g)]
    .map((match) => match[1]).filter((path) => /research\/(?:tick|t15|place|record|start)/.test(path));
  assert.deepEqual(placementRoutes, []);
});

test('manual odds smoke cannot bypass the persistent shared budget or silently enable paid feeds', () => {
  const smoke = readFileSync(join(root, '.github/workflows/odds-api-smoke.yml'), 'utf8');
  assert.match(smoke, /TURSO_DATABASE_URL:/);
  assert.match(smoke, /TURSO_AUTH_TOKEN:/);
  assert.match(smoke, /db\.oddsRequests/);
  assert.match(smoke, /operation: 'smoke'/);
  assert.match(smoke, /allowNetwork: process\.env\.ODDS_INFORMATIONAL_NETWORK_ENABLED === 'true'/);
  assert.match(smoke, /persistent_manager_unavailable/);
  assert.doesNotMatch(smoke, /apiKey.*console\.log|console\.log.*apiKey/);
});

test('actual nightly shell path performs maintenance only even when legacy betting flags are enabled', (t) => {
  const bash = process.platform === 'win32'
    ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!existsSync(bash)) return t.skip('Bash is unavailable; static and scheduler tests still run.');
  const temp = mkdtempSync(join(tmpdir(), 'footpredictor-nightly-maintenance-'));
  const posix = (path) => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  try {
    const bin = join(temp, 'bin');
    mkdirSync(bin);
    mkdirSync(join(temp, 'backend'));
    mkdirSync(join(temp, 'scripts/ci'), { recursive: true });
    const shellPath = join(temp, 'scripts/ci/nightly-sync.sh');
    writeFileSync(shellPath, script);
    const writeExecutable = (name, body) => {
      const path = join(bin, name);
      writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(path, 0o755);
    };
    writeExecutable('curl', 'printf "%s\\n" "$*" >> "$CALL_LOG"\nprintf \'{"success":true}\\n\'');
    writeExecutable('npm', 'printf "%s\\n" "$*" >> "$NPM_LOG"');
    writeExecutable('node', 'printf "%s\\n" "$RESEARCH_T15_SCHEDULER_ENABLED" >> "$NODE_LOG"\nwhile true; do sleep 1; done');
    writeFileSync(join(temp, 'bash-env'), `export PATH="${posix(bin)}:$PATH"\n`);
    execFileSync(bash, ['--noprofile', '--norc', posix(shellPath)], {
      timeout: 15000,
      env: {
        ...process.env, BASH_ENV: posix(join(temp, 'bash-env')),
        CALL_LOG: posix(join(temp, 'calls.log')), NPM_LOG: posix(join(temp, 'npm.log')),
        NODE_LOG: posix(join(temp, 'node.log')), TURSO_DATABASE_URL: 'file:test-only',
        TURSO_AUTH_TOKEN: 'test-token', ODDS_API_KEY: 'test-odds-key',
        RUN_ODDS_SYNC: 'true', RUN_TRANSITION_REFERENCE_SYNC: 'true',
        GITHUB_EVENT_NAME: 'workflow_dispatch', PLAYER_AVAILABILITY_ENABLED: 'false',
        AUTO_BET_ENABLED: 'true', AUTO_BET_DRY_RUN: 'false',
        RESEARCH_T15_SCHEDULER_ENABLED: 'true',
      },
    });
    const calls = readFileSync(join(temp, 'calls.log'), 'utf8');
    assert.doesNotMatch(calls, /place-valid-bets|\/bets\/place|research\/t15|research\/tick/);
    assert.match(calls, /\/api\/scraper\/understat/);
    assert.match(calls, /\/api\/scraper\/football-data/);
    assert.match(calls, /\/api\/bets\/sync/);
    assert.match(calls, /\/api\/predictions\/settle-completed/);
    assert.match(calls, /\/api\/learning\/reviews\/sync/);
    assert.equal(readFileSync(join(temp, 'node.log'), 'utf8').trim(), 'false');
    assert.match(readFileSync(join(temp, 'npm.log'), 'utf8'), /run calibration:warm/);
  } finally {
    const target = resolve(temp);
    assert.equal(dirname(target), resolve(tmpdir()));
    rmSync(target, { recursive: true, force: true });
  }
});
