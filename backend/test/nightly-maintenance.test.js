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
  assert.match(workflow, /ODDS_EXTRA_EVENT_NETWORK_ENABLED: 'true'/);
  assert.ok(workflow.includes("RESEARCH_NIGHTLY_ENABLED: ${{ vars.RESEARCH_NIGHTLY_ENABLED || 'false' }}"));
  assert.match(script, /RESEARCH_NIGHTLY_ENABLED="\$\{RESEARCH_NIGHTLY_ENABLED:-false\}"/);
  assert.match(script, /node scripts\/research-nightly\.js/);
  assert.match(script, /RESEARCH_NIGHTLY_DATA_GATES_PASSED="\$RESEARCH_NIGHTLY_DATA_GATES_PASSED"/);
  assert.match(script, /RUN_ODDS_SYNC="\$\{RUN_ODDS_SYNC:-false\}"/);
  for (const route of [
    '/api/scraper/understat',
    '/api/competition-transitions/sync-references', '/api/bets/sync',
    '/api/predictions/settle-completed', '/api/learning/reviews/sync', '/api/research/settle',
  ]) assert.ok(script.includes(route), `maintenance retained: ${route}`);
  assert.doesNotMatch(script, /\/api\/scraper\/football-data|run calibration:warm/);
  assert.match(script, /nightly-alternative-sources\.js --execute/);
  assert.match(script, /nightly-source-context\.js --recompute-imported-teams/);
  const nightlyCli = readFileSync(join(root, 'backend/scripts/research-nightly.js'), 'utf8');
  const runtime = readFileSync(join(root, 'backend/src/research/ResearchRecommendationRuntime.ts'), 'utf8');
  assert.match(nightlyCli, /requireExistingCalibration: true/);
  assert.match(runtime, /allowCalibrationRebuild: options\.requireExistingCalibration !== true/);
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

test('nightly shell preserves settlement, source isolation and ordering across modes', (t) => {
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash';
  if (!existsSync(bash)) return t.skip('Bash is unavailable.');
  const temp = mkdtempSync(join(tmpdir(), 'footpredictor-nightly-maintenance-'));
  const posix = (path) => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
  try {
    const bin = join(temp, 'bin'); mkdirSync(bin); mkdirSync(join(temp, 'backend'));
    mkdirSync(join(temp, 'scripts/ci'), { recursive: true });
    const shellPath = join(temp, 'scripts/ci/nightly-sync.sh'); writeFileSync(shellPath, script);
    const executable = (name, body) => { const file = join(bin, name); writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`); chmodSync(file, 0o755); };
    executable('curl', `printf 'curl:%s\\n' "$*" >> "$CALL_LOG"
if [[ "$*" == *"/api/system/sync-upcoming-kickoffs"* && "$CALENDAR_FAILURE" == "true" ]]; then exit 22; fi
if [[ "$*" == *"/api/scraper/understat"* && "$UNDERSTAT_FAILURE" == "true" ]]; then exit 22; fi
printf '{"success":true}\\n'`);
    executable('node', `case "$1" in
  *prepare-nightly-source-config.js) printf 'prepare\\n' >> "$CALL_LOG"; exit 0 ;;
  scripts/nightly-alternative-sources.js)
    printf 'sources:%s\\n' "$*" >> "$CALL_LOG"
    if [[ "$SOURCE_FAILURE" == "true" ]]; then exit 1; fi
    printf '{"schemaVersion":1,"updatedTeamIds":[]}\\n'; exit 0 ;;
  scripts/nightly-source-context.js) printf 'recompute:%s\\n' "$*" >> "$CALL_LOG"; exit 0 ;;
  scripts/research-nightly.js)
    printf 'nightly:%s:%s:%s\\n' "$RESEARCH_NIGHTLY_ENABLED" "$RESEARCH_T15_SCHEDULER_ENABLED" "$RESEARCH_NIGHTLY_DATA_GATES_PASSED" >> "$CALL_LOG"
    [[ "$RESEARCH_NIGHTLY_DATA_GATES_PASSED" == "true" && !( "$NIGHTLY_SOURCE_MODE" == "verified-alternatives" && "$SOURCE_FAILURE" == "true" ) ]]; exit $? ;;
  dist/index.js) printf 'backend:%s\\n' "$RESEARCH_T15_SCHEDULER_ENABLED" >> "$CALL_LOG"; while true; do sleep 1; done ;;
  *) printf 'unexpected-node:%s\\n' "$*" >> "$CALL_LOG"; exit 1 ;;
esac`);
    executable('npm', 'printf "npm:%s\\n" "$*" >> "$CALL_LOG"; exit 1');
    writeFileSync(join(temp, 'bash-env'), `export PATH="${posix(bin)}:$PATH"\n`);
    const cases = [
      { mode:'primary', enabled:'false', config:false },
      { mode:'primary', enabled:'true', config:true, transitions:true },
      { mode:'primary', enabled:'true', config:true, calendarFailure:true },
      { mode:'primary', enabled:'true', config:true, understatFailure:true },
      { mode:'verified-alternatives', enabled:'true', config:true },
      { mode:'verified-alternatives', enabled:'false', config:true, sourceFailure:true },
      { mode:'verified-alternatives', enabled:'true', config:true, sourceFailure:true },
    ];
    for (const scenario of cases) {
      const log=join(temp, 'calls.log'); writeFileSync(log, '');
      const manifest=join(temp, 'source-manifest.json'); if (existsSync(manifest)) rmSync(manifest);
      const run=()=>execFileSync(bash, ['--noprofile','--norc',posix(shellPath)], { timeout:15000, env:{
        ...process.env, BASH_ENV:posix(join(temp,'bash-env')), CALL_LOG:posix(log), TURSO_DATABASE_URL:'file:test-only', TURSO_AUTH_TOKEN:'test-token',
        ODDS_API_KEY:'test-key', RUN_ODDS_SYNC:'true', GITHUB_EVENT_NAME:'workflow_dispatch', PLAYER_AVAILABILITY_ENABLED:'false',
        RESEARCH_NIGHTLY_ENABLED:scenario.enabled, RESEARCH_T15_SCHEDULER_ENABLED:'true', NIGHTLY_SOURCE_MODE:scenario.mode,
        NIGHTLY_SOURCE_TARGET_SHA256:scenario.config?'a'.repeat(64):'', NIGHTLY_SOURCE_SEASON:scenario.config?'2026':'',
        NIGHTLY_SOURCE_MANIFEST_FILE:posix(manifest), NIGHTLY_SOURCE_MAPPING_FILE:posix(join(temp,'mapping.json')),
        RUN_TRANSITION_REFERENCE_SYNC:scenario.transitions?'true':'false', SOURCE_FAILURE:scenario.sourceFailure?'true':'false',
        CALENDAR_FAILURE:scenario.calendarFailure?'true':'false',
        UNDERSTAT_FAILURE:scenario.understatFailure?'true':'false',
      }});
      const fails=(scenario.enabled==='true' && (scenario.sourceFailure || scenario.calendarFailure || scenario.understatFailure));
      if (fails) assert.throws(run, error=>error.status===1); else run();
      const calls=readFileSync(log,'utf8');
      assert.match(calls,/backend:false/);
      assert.doesNotMatch(calls,/place-valid-bets|\/bets\/place|research\/t15|research\/tick|\/api\/scraper\/football-data|npm:/);
      for (const route of ['/api/bets/sync','/api/research/settle','/api/predictions/settle-completed','/api/scraper/status']) assert.ok(calls.includes(route),`${scenario.mode} ${route}`);
      assert.equal(calls.includes('/api/scraper/understat'),scenario.mode==='primary');
      assert.equal(calls.includes('/api/competition-transitions/sync-references'),!!scenario.transitions);
      assert.equal(calls.includes('/api/system/sync-upcoming-kickoffs'),scenario.mode==='primary' && scenario.enabled==='true');
      assert.equal(calls.includes('/api/learning/reviews/sync'),scenario.mode==='primary' && !scenario.calendarFailure && !scenario.understatFailure);
      assert.equal((calls.match(/\/api\/scraper\/odds/g)||[]).length,5);
      assert.equal(calls.includes('sources:'),scenario.config);
      if (scenario.config) {
        assert.ok(calls.includes('--collect-csv'));
        assert.equal(calls.includes('--collect-fdo'),scenario.mode==='verified-alternatives');
        assert.equal(calls.includes('--csv-only'),scenario.mode==='primary');
        assert.equal(calls.includes('recompute:'),!scenario.sourceFailure);
        if (!scenario.sourceFailure) assert.ok(calls.indexOf('sources:') < calls.indexOf('recompute:'));
      }
      if (scenario.enabled==='true') {
        assert.match(calls,/nightly:true:false:/);
        assert.ok(calls.indexOf('/api/research/settle') < calls.indexOf('nightly:true:false:'));
        if (scenario.config && !scenario.sourceFailure) assert.ok(calls.indexOf('recompute:') < calls.indexOf('nightly:true:false:'));
      } else assert.doesNotMatch(calls,/nightly:true:false:/);
      if (scenario.mode==='verified-alternatives') assert.ok(calls.indexOf('prepare') < calls.indexOf('backend:false'));
    }
  } finally {
    const target=resolve(temp); assert.equal(dirname(target),resolve(tmpdir()));
    rmSync(target,{recursive:true,force:true});
  }
});
