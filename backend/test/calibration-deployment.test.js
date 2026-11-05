const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, cpSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { execFileSync } = require('node:child_process');

test('clean build removes obsolete compiled modules while preserving sources', () => {
  const root = mkdtempSync(join(tmpdir(), 'calibration-build-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'dist'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'dist/obsolete.js'), 'obsolete');
    writeFileSync(join(root, 'src/keep.ts'), 'source');
    cpSync(join(__dirname, '../src/research/frozen'), join(root, 'src/research/frozen'), { recursive: true });
    writeFileSync(join(root, 'scripts/clean-build.js'), readFileSync(join(__dirname, '../scripts/clean-build.js')));
    execFileSync(process.execPath, [join(root, 'scripts/clean-build.js')]);
    assert.equal(existsSync(join(root, 'dist/obsolete.js')), false);
    const baseline = 'research/frozen/a-80cb25df/research/ForecastCore.js';
    assert.deepEqual(readFileSync(join(root, 'dist', baseline)), readFileSync(join(root, 'src', baseline)));
    assert.equal(readFileSync(join(root, 'src/keep.ts'), 'utf8'), 'source');
  } finally {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    rmSync(target, { recursive: true, force: true });
  }
});

test('authorized manual preparation builds matching code and only prepares calibration, independently of nightly ingestion', () => {
  const workflow = readFileSync(join(__dirname, '../../.github/workflows/calibration-warm.yml'), 'utf8');
  const pkg = require('../package.json');
  const docker = readFileSync(join(__dirname, '../Dockerfile'), 'utf8');
  assert.doesNotMatch(workflow, /^ {2}(?:push|pull_request):/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /inputs\.authorize_database_writes == true && vars\.OPERATIONAL_CALIBRATION_ENABLED == 'true'/);
  assert.match(workflow, /npm ci[\s\S]*npm run build[\s\S]*npm run calibration:warm/);
  assert.doesNotMatch(workflow, /nightly-sync\.sh|ODDS_API_KEY|API_FOOTBALL_KEY|AUTO_BET/);
  assert.equal(pkg.scripts.prebuild, 'node scripts/clean-build.js');
  assert.match(docker, /COPY scripts\/clean-build.js[\s\S]*RUN npm run build/);
  const nightly = readFileSync(join(__dirname, '../../scripts/ci/nightly-sync.sh'), 'utf8');
  assert.match(nightly, /timeout "\$CALIBRATION_WARM_TIMEOUT_SECONDS" npm --prefix "\$BACKEND_DIR" run calibration:warm/);
  const warmer = readFileSync(join(__dirname, '../scripts/warm-calibration.js'), 'utf8');
  assert.match(warmer, /recentReplayLimit: 10/);
});
