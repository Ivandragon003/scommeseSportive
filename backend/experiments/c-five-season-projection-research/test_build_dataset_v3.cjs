'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawnSync } = require('node:child_process');
const { buildPartition, validateSourceSchema, optionsOf } = require('./build_dataset_v3.cjs');

test('canonical runtime builds fifty-six source features and Python controlled validation projects forty', () => {
  // Forty-eight warm-up results and two targets; the real per-match baseline is fitted by ForecastCore.
  const history = Array.from({ length: 50 }, (_, i) => ({ matchId: `synthetic_runtime_${i}`, homeTeamId: `toy_${i % 4}`,
    awayTeamId: `toy_${(i % 4 + 1 + Math.floor(i / 4) % 3) % 4}`, competition: 'Serie A', season: i < 48 ? '2018/2019' : '2019/2020',
    date: i < 48 ? new Date(Date.UTC(2018, 7, 1 + i * 5, 18)).toISOString() : `2019-08-${i === 48 ? '10' : '17'}T18:00:00.000Z`,
    homeGoals: i % 3, awayGoals: (i + 1) % 3, homeXG: 1.2 + i % 3 / 5, awayXG: .8 + i % 2 / 5,
    homeTotalShots: 12, awayTotalShots: 9, homeShotsOnTarget: 4, awayShotsOnTarget: 3 }));
  const dataset = buildPartition(history, '2026-07-01T00:00:00.000Z', ['Serie A']);
  assert.equal(dataset.rows.length, 2); assert(dataset.rows.every(row => row.trainingCount >= 30));
  const receipt = validateSourceSchema(dataset); assert.equal(receipt.unusedSourceFeatures.length, 16);
  dataset.decisionSchedule = { hour: 3, minute: 7, timezone: 'Europe/Rome' };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'five-season-runtime-preflight-'));
  try {
    const file = path.join(directory, 'synthetic.json'); fs.writeFileSync(file, JSON.stringify(dataset));
    const code = "import sys,json;sys.path.insert(0,'backend/ml');import train;d=json.load(open(sys.argv[1]));names,rows,_=train.checked_dataset(d,controlled=True); model_names,projected=train.project_feature_rows(rows,names,[]);assert len(names)==56 and len(model_names)==40 and len(projected)==2;assert all(len(r['features'])==40 for r in projected);print(json.dumps({'controlled':True,'sourceFeatures':len(names),'modelFeatures':len(model_names),'rows':len(rows),'fits':0}))";
    const result = spawnSync('python', ['-c', code, file], { cwd: path.resolve(__dirname, '../../..'), encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr); assert.equal(JSON.parse(result.stdout.trim()).sourceFeatures, 56);
  } finally { assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('bounded workers and source schema reject the former empty-block dataset', () => {
  assert.throws(() => optionsOf(['--plan', 'p', '--matches', 'm', '--asof', '2026-07-01T00:00:00Z', '--out', 'o', '--workers', '3']));
  assert.throws(() => validateSourceSchema({ featureNames: Array(40).fill('x'), featureBlocks: [], rows: [] }));
});
