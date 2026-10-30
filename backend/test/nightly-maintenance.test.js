const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, chmodSync, rmSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');

const root = join(__dirname, '../..');
const script = readFileSync(join(root, 'scripts/ci/nightly-sync.sh'), 'utf8');
const workflow = readFileSync(join(root, '.github/workflows/nightly-sync.yml'), 'utf8');

test('nightly uses only the explicit opt-in A/C script and retains the legacy placement retirement', () => {
  assert.doesNotMatch(script, /place-valid-bets|AUTO_BET|\/bets\/place|research\/t15|research\/tick/);
  assert.doesNotMatch(workflow, /AUTO_BET|place-valid-bets/);
  assert.match(script, /RESEARCH_T15_SCHEDULER_ENABLED=false \\\r?\n/);
  assert.match(workflow, /RESEARCH_T15_SCHEDULER_ENABLED: 'false'/);
  assert.match(workflow, /RUN_ODDS_SYNC: 'false'/);
  assert.match(workflow, /ODDS_INFORMATIONAL_NETWORK_ENABLED: 'false'/);
  assert.ok(workflow.includes("RESEARCH_NIGHTLY_ENABLED: ${{ vars.RESEARCH_NIGHTLY_ENABLED || 'false' }}"));
  assert.match(script, /RESEARCH_NIGHTLY_ENABLED="\$\{RESEARCH_NIGHTLY_ENABLED:-false\}"/);
  assert.match(script, /node scripts\/research-nightly\.js/);
  assert.match(script, /RESEARCH_NIGHTLY_DATA_GATES_PASSED="\$RESEARCH_NIGHTLY_DATA_GATES_PASSED"/);
  assert.match(script, /RUN_ODDS_SYNC="\$\{RUN_ODDS_SYNC:-false\}"/);
  for (const route of [
    '/api/scraper/understat', '/api/scraper/football-data',
    '/api/competition-transitions/sync-references', '/api/bets/sync',
    '/api/predictions/settle-completed', '/api/learning/reviews/sync', '/api/research/settle',
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

test('actual nightly shell keeps legacy flags inert and invokes only the explicit nightly opt-in after data gates', (t) => {
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
    writeExecutable('curl', 'printf "curl:%s\\n" "$*" >> "$CALL_LOG"\nif [[ "$*" == *"/api/system/sync-upcoming-kickoffs"* && "$CALENDAR_FAILURE" == "true" ]]; then\n  printf \'{"success":false,"error":"odds_calendar_events_unavailable"}\\n\'\n  exit 22\nfi\nprintf \'{"success":true}\\n\'');
    writeExecutable('npm', 'printf "%s\\n" "$*" >> "$NPM_LOG"');
    writeExecutable('node', 'if [[ "$1" == "scripts/research-nightly.js" ]]; then\n  printf "nightly:%s:%s:%s\\n" "$RESEARCH_NIGHTLY_ENABLED" "$RESEARCH_T15_SCHEDULER_ENABLED" "$RESEARCH_NIGHTLY_DATA_GATES_PASSED" >> "$NODE_LOG"\n  printf "nightly:%s\\n" "$RESEARCH_NIGHTLY_DATA_GATES_PASSED" >> "$CALL_LOG"\n  [[ "$RESEARCH_NIGHTLY_DATA_GATES_PASSED" == "true" ]]\n  exit $?\nfi\nprintf "%s\\n" "$RESEARCH_T15_SCHEDULER_ENABLED" >> "$NODE_LOG"\nwhile true; do sleep 1; done');
    writeFileSync(join(temp, 'bash-env'), `export PATH="${posix(bin)}:$PATH"\n`);
    for (const [enabled, calendarFailure] of [['false', 'false'], ['true', 'false'], ['true', 'true'], ['false', 'true']]) {
      writeFileSync(join(temp, 'node.log'), '');
      writeFileSync(join(temp, 'calls.log'), '');
      const run = () => execFileSync(bash, ['--noprofile', '--norc', posix(shellPath)], {
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
        RESEARCH_NIGHTLY_ENABLED: enabled,
        CALENDAR_FAILURE: calendarFailure,
      },
      });
      const failedCalendar = enabled === 'true' && calendarFailure === 'true';
      if (failedCalendar) assert.throws(run, (error) => error.status === 1);
      else run();
      const nodeCalls = readFileSync(join(temp, 'node.log'), 'utf8').trim().split('\n');
      assert.equal(nodeCalls[0], 'false');
      assert.deepEqual(nodeCalls.slice(1), enabled === 'true' ? [`nightly:true:false:${!failedCalendar}`] : []);
      const calls = readFileSync(join(temp, 'calls.log'), 'utf8');
      assert.doesNotMatch(calls, /place-valid-bets|\/bets\/place|research\/t15|research\/tick/);
      for (const route of ['/api/scraper/understat', '/api/scraper/football-data', '/api/bets/sync',
        '/api/predictions/settle-completed', '/api/research/settle']) assert.ok(calls.includes(route));
      const calendarCalls = calls.split('\n').filter((line) => line.includes('/api/system/sync-upcoming-kickoffs'));
      assert.equal(calendarCalls.length, enabled === 'true' ? 1 : 0);
      if (enabled === 'true') {
        assert.match(calendarCalls[0], /--max-time 180/);
        assert.ok(calendarCalls[0].includes('{"mode":"top5","limit":160}'));
        assert.ok(calls.indexOf('/api/scraper/understat') < calls.indexOf('/api/system/sync-upcoming-kickoffs'));
        assert.ok(calls.indexOf('/api/system/sync-upcoming-kickoffs') < calls.indexOf(`nightly:${!failedCalendar}`));
      }
      assert.equal(calls.includes('/api/learning/reviews/sync'), !failedCalendar);
      assert.equal(calls.includes('/api/research/nightly-complete'), !failedCalendar);
      assert.ok(calls.includes('/api/scraper/status'));
    }
    const calls = readFileSync(join(temp, 'calls.log'), 'utf8');
    assert.doesNotMatch(calls, /place-valid-bets|\/bets\/place|research\/t15|research\/tick/);
    assert.match(calls, /\/api\/scraper\/understat/);
    assert.match(calls, /\/api\/scraper\/football-data/);
    assert.match(calls, /\/api\/bets\/sync/);
    assert.match(calls, /\/api\/predictions\/settle-completed/);
    assert.match(calls, /\/api\/learning\/reviews\/sync/);
    assert.match(calls, /\/api\/research\/settle/);
    assert.match(readFileSync(join(temp, 'npm.log'), 'utf8'), /run calibration:warm/);
  } finally {
    const target = resolve(temp);
    assert.equal(dirname(target), resolve(tmpdir()));
    rmSync(target, { recursive: true, force: true });
  }
});
