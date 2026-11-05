'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { loss, summarize, utcWeek, blockBootstrap } = require('../scripts/model-a-prospective-statistics');
const { evaluateProspective, evaluateRows, canonical, selectOnly, openClient, optionsFor } = require('../scripts/model-a-prospective-evaluate');
const [major, minor] = process.versions.node.split('.').map(Number);
const sqliteSupported = major > 22 || major === 22 && minor >= 13;
const localTest = (name, fn) => test(name, { skip: sqliteSupported ? false : 'Local read-only evaluator requires Node >=22.13; remote raw client remains Node20 compatible.' }, fn);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
const options = { cutoff: '2026-11-05T12:00:00Z', origin: 'direct_a', expectedCodeHash: 'a'.repeat(64), resultSource: 'understat' };
const script = path.join(__dirname, '../scripts/model-a-prospective-evaluate.js');
const schema = fs.readFileSync(path.join(__dirname, '../experiments/model-a-prospective/schema.sql'), 'utf8');

function payload(id, overrides = {}) {
  const snapshot = { z: 2, a: { b: 1 } };
  return { schema: 'model-a-operational-prospective-v1', family: 'A', id, matchId: id,
    forecastAt: '2026-11-04T12:00:00.000Z', inputAsOf: '2026-11-04T11:59:00.000Z', kickoffAt: '2026-11-04T18:00:00.000Z',
    origin: 'direct_a', competition: 'Serie A', season: '2026/27',
    model: { version: 'A-v1', codeHash: 'a'.repeat(64), configHash: 'b'.repeat(64), stateHash: 'c'.repeat(64) },
    provenance: { snapshot, inputSnapshotHash: hash(snapshot), inputAvailableThrough: null, classification: 'technical_only', rigorousEligible: false },
    stages: { ensembleRaw: { value: null }, contextual: { value: { over: .8, under: .3 } }, calibrated: { value: { over: .7, under: .4 } },
      marketBlended: { value: null }, decision: { value: { over: .65, under: null } } }, selected: null, quotes: [], ...overrides };
}
function verified(id, overrides) {
  const p = payload(id, overrides);
  p.provenance = { ...p.provenance, classification: 'verified', rigorousEligible: true, inputAvailableThrough: '2026-11-04T11:00:00Z' };
  return p;
}
function row(p, home = 2, away = 1) {
  return { id: p.id, match_id: p.matchId, forecast_at: p.forecastAt, kickoff_at: p.kickoffAt, payload_json: JSON.stringify(p), evidence_id: `result-${p.matchId}`,
    source: 'understat', observed_at: '2026-11-04T21:00:00Z', recorded_at: '2026-11-04T21:01:00Z', home_goals: home, away_goals: away };
}
function fixture(t) {
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(':memory:'); db.exec(schema);
  t.after(() => db.close());
  const reads = [], client = { async execute(statement) { selectOnly(statement.sql); reads.push(statement.sql); return { rows: db.prepare(statement.sql).all(statement.args) }; } };
  function add(p, result = true, home = 2, away = 1) {
    db.prepare('INSERT INTO model_a_prospective_forecasts VALUES (?,?,?,?,?)').run(p.id, p.matchId, p.forecastAt, p.kickoffAt, JSON.stringify(p));
    if (result) db.prepare('INSERT OR IGNORE INTO model_a_prospective_results VALUES (?,?,?,?,?,?,?,?,?)').run(`result-${p.matchId}`, p.matchId, 'understat', p.kickoffAt,
      '2026-11-04T21:00:00Z', '2026-11-04T21:01:00Z', home, away, '{}');
  }
  return { db, client, reads, add };
}

test('Brier, clamped log loss and independent Under probabilities match manual values', () => {
  assert.deepEqual(loss(.8, 1).brier, (.8 - 1) ** 2);
  assert.ok(Math.abs(loss(.8, 1).logLoss + Math.log(.8)) < 1e-14);
  assert.equal(loss(0, 0).brier, 0); assert.equal(loss(1, 1).brier, 0);
  assert.ok(Number.isFinite(loss(0, 1).logLoss)); assert.ok(Number.isFinite(loss(1, 0).logLoss));
  assert.ok(Math.abs(loss(0, 1).logLoss + Math.log(1e-15)) < 1e-14);
  assert.throws(() => loss(NaN, 1)); assert.throws(() => loss(.4, 2));
  const p = payload('manual'), report = evaluateRows([row(p)], [], { ...options, mode: 'technical' });
  assert.ok(Math.abs(report.stages.contextual.over.brier - .04) < 1e-14);
  assert.ok(Math.abs(report.stages.contextual.under.brier - .09) < 1e-14);
  assert.ok(Math.abs(report.stages.calibrated.under.logLoss + Math.log(.6)) < 1e-14);
  assert.equal(report.comparisons.primary.ensembleRawToContextual.matchCount, 0);
  assert.equal(report.comparisons.secondaryContextualToCalibrated.matchCount, 1);
});

test('decile boundaries include zero and one without imputing empty bins', () => {
  const report = summarize([0, .1, .2, .9, 1].map(probability => ({ probability, outcome: 1 })));
  assert.deepEqual(report.deciles.map(bin => bin.count), [1, 1, 1, 0, 0, 0, 0, 0, 0, 2]);
  assert.equal(report.deciles[9].meanPrediction, .95); assert.equal(report.deciles[3].observedRate, null);
  assert.equal(summarize([]).brier, null);
  assert.equal(utcWeek('2027-01-03T23:59:59Z'), '2026-12-28');
});

test('block bootstrap is deterministic, preserves difference sign and rejects one-block precision', () => {
  const observations = Array.from({ length: 8 }, (_, index) => ({ league: index % 2 ? 'Serie A' : 'La Liga', week: `2026-10-${index < 4 ? '19' : '26'}`, brier: .02, logLoss: .03 }));
  const first = blockBootstrap(observations, 42);
  assert.deepEqual(first, blockBootstrap(observations, 42));
  assert.equal(first.replicas, 2000); assert.equal(first.blocks, 4);
  assert.ok(first.brierCI95.every(value => Math.abs(value - .02) < 1e-14));
  const negative = blockBootstrap(observations.map(r => ({ ...r, brier: -.02, logLoss: -.03 })), 42);
  assert.ok(negative.logLossCI95.every(value => value < 0));
  assert.equal(blockBootstrap(observations.slice(0, 1), 42).brierCI95, null);
  assert.equal(blockBootstrap([], 42).deltaBrier, null);
  const unequal = blockBootstrap([{ league: 'Serie A', week: 'one', brier: .1, logLoss: .2 },
    ...Array.from({ length: 3 }, () => ({ league: 'Serie A', week: 'two', brier: -.1, logLoss: -.2 }))], 42);
  assert.ok(Math.abs(unequal.deltaBrier + .05) < 1e-14);
  assert.deepEqual(unequal.brierCI95, [-.10000000000000002, .1]);
});

localTest('canonical SQL keeps first forecast even when invalid, and uses result cutoff and latest lifecycle', async t => {
  const f = fixture(t), first = verified('first'); first.provenance.inputSnapshotHash = '0'.repeat(64); f.add(first);
  f.add(verified('later', { matchId: 'first', forecastAt: '2026-11-04T13:00:00.000Z' }));
  f.add(verified('missing'), false);
  f.add(verified('corrected'));
  f.db.prepare('INSERT INTO model_a_prospective_result_observations VALUES (?,?,?,?,?,?,?,?,?)').run('blocked', 'corrected', 'understat', first.kickoffAt,
    '2026-11-04T22:00:00Z', '2026-11-04T22:01:00Z', 'not_final', 'provider says not final', '{}');
  f.add(verified('future-result'), false);
  f.db.prepare('INSERT INTO model_a_prospective_results VALUES (?,?,?,?,?,?,?,?,?)').run('future-result', 'future-result', 'understat', first.kickoffAt,
    '2026-11-06T21:00:00Z', '2026-11-06T21:01:00Z', 2, 1, '{}');
  const report = await evaluateProspective(f.client, options);
  assert.equal(report.denominators.scopedForecastRows, 5); assert.equal(report.denominators.firstForecastCandidates, 4);
  assert.equal(report.exclusions.input_snapshot_hash_mismatch, 1); assert.equal(report.exclusions.missing_or_unconfirmed_result, 3);
  assert.equal(report.denominators.scoredMatches, 0); assert.equal(report.scientificStatus.validationStatisticallyConcluded, false);
  assert.ok(f.reads.every(sql => /^(\s*--[^\n]*\n)*\s*(SELECT|WITH)/i.test(sql)));
});

localTest('strict mode excludes all technical records while technical metrics keep missing stages and sources explicit', async t => {
  const f = fixture(t); f.add(payload('technical')); f.add(payload('other-origin', { origin: 'shared_ac' }));
  const strict = await evaluateProspective(f.client, options), technical = await evaluateProspective(f.client, { ...options, mode: 'technical' });
  assert.equal(strict.mode, 'strict'); assert.equal(strict.denominators.scoredMatches, 0); assert.equal(strict.denominators.strictSqlDeclaredCandidates, 0);
  assert.equal(strict.denominators.temporalTechnicalOrUnverified, 1);
  assert.equal(technical.denominators.scoredMatches, 1); assert.equal(technical.missingStageProbabilities.counts['ensembleRaw.over'], 1);
  assert.equal(technical.stages.ensembleRaw.over.count, 0); assert.equal(technical.stages.marketBlended.over.count, 0);
  assert.equal(technical.readiness.eighteenMonthsElapsed, null); assert.equal(technical.readiness.eighteenMonthDeadline, null);
  assert.equal(technical.scientificStatus.eligibility, 'technical_descriptive_only');
});

localTest('declared verified hash without stored snapshot is excluded from strict scoring', async t => {
  const f = fixture(t), p = verified('no-snapshot'); delete p.provenance.snapshot; f.add(p);
  const strict = await evaluateProspective(f.client, options);
  assert.equal(strict.denominators.strictSqlDeclaredCandidates, 1);
  assert.equal(strict.denominators.inputSnapshotNotAvailableForHashCheck, 1);
  assert.equal(strict.exclusions.input_snapshot_not_verifiable, 1);
  assert.equal(strict.denominators.scoredMatches, 0);
  const technical = await evaluateProspective(f.client, { ...options, mode: 'technical' });
  assert.equal(technical.denominators.inputSnapshotNotAvailableForHashCheck, 1);
  assert.equal(technical.denominators.scoredMatches, 1);
  assert.equal(technical.scientificStatus.eligibility, 'technical_descriptive_only');
});

localTest('registered protocol, expected manifest, competition, season and kickoff scope are checked', async t => {
  const f = fixture(t);
  const scope = { protocolId: 'study', seasons: ['2026/27'], from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z',
    competitions: ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'], origin: 'prospective_a', window: 'T-24h..T-60min inclusive' };
  const manifestSha256 = hash(JSON.stringify(scope));
  f.db.prepare('INSERT INTO model_a_collection_protocols VALUES (?,?,?)').run('study', JSON.stringify({ snapshot: scope, sha256: manifestSha256 }), '2026-11-01T00:00:00Z');
  const collection = { protocolId: 'study', manifestSha256, claimId: 'claim' };
  f.add(payload('study', { origin: 'prospective_a', collection }));
  f.add(payload('foreign', { origin: 'prospective_a', collection: { ...collection, protocolId: 'another' } }));
  f.add(payload('wrong-manifest', { origin: 'prospective_a', collection: { ...collection, manifestSha256: 'f'.repeat(64) } }));
  const scoped = { ...options, origin: 'prospective_a', protocolId: 'study', manifestSha256, mode: 'technical' };
  const report = await evaluateProspective(f.client, scoped);
  assert.equal(report.denominators.firstForecastCandidates, 2); assert.equal(report.denominators.scoredMatches, 1);
  assert.equal(report.exclusions.collection_manifest_or_scope_mismatch, 1);
  await assert.rejects(evaluateProspective(f.client, { ...scoped, manifestSha256: '0'.repeat(64) }), /registered_manifest_mismatch/);
  assert.throws(() => optionsFor({ ...options, origin: 'prospective_a' }), /protocol_and_expected_manifest_required/);
  assert.throws(() => optionsFor({ ...options, protocolId: 'study' }), /protocol_not_allowed_for_origin/);
});

test('all stages, paired intersections, selected exact probability and supplied Under remain distinct', () => {
  const a = payload('a'), b = payload('b'), missing = payload('c');
  for (const p of [a, b]) {
    p.stages.ensembleRaw.value = { over: .6, under: .35 };
    p.stages.marketBlended.value = { over: .66, under: .45 };
    p.selected = { selection: 'over25', probability: .6543, exactProbability: .654321 };
    p.quotes = ['over25', 'under25'].map(selection => ({ selection, provider: 'odds_api', bookmaker: 'Real Bookmaker', odds: 2,
      capturedAt: '2026-11-04T11:58:00Z', updatedAt: '2026-11-04T11:57:00Z' }));
  }
  missing.stages.calibrated.value.under = null;
  const report = evaluateRows([row(a), row(b, 0, 0), row(missing)], [], { ...options, mode: 'technical', quoteMaxAgeMs: 300000 });
  assert.equal(report.comparisons.primary.contextualToCalibrated.matchCount, 2);
  assert.equal(report.comparisons.secondaryContextualToCalibrated.matchCount, 2);
  assert.equal(report.stages.contextual.over.count, 3); assert.equal(report.stages.calibrated.under.count, 2);
  assert.equal(report.comparisons.calibratedToMarketBlended.matchCount, 2);
  assert.equal(report.comparisons.marketBlendedToDecisionSelectedOnly.over.count, 2);
  assert.equal(report.comparisons.marketBlendedToDecisionSelectedOnly.under.count, 0);
  assert.equal(report.selected.exact.count, 2); assert.equal(report.selected.abstentions, 1);
  const withoutPricePolicy = evaluateRows([row(a)], [], { ...options, mode: 'technical' });
  assert.equal(withoutPricePolicy.comparisons.calibratedToMarketBlended.matchCount, 0);
});

localTest('offline CLI is read-only, does not create missing DB or overwrite output and redacts driver errors', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-a-evaluation-')), filename = path.join(dir, 'study.db');
  t.after(() => { assert.ok(path.resolve(dir).startsWith(`${path.resolve(os.tmpdir())}${path.sep}model-a-evaluation-`)); fs.rmSync(dir, { recursive: true, force: true }); });
  const setup = spawnSync(process.execPath, ['-e', `const fs=require('node:fs');const {DatabaseSync}=require('node:sqlite');const input=JSON.parse(fs.readFileSync(0,'utf8'));const db=new DatabaseSync(input.filename);db.exec(input.schema);db.close();`],
    { input: JSON.stringify({ filename, schema }), encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);
  const run = extra => spawnSync(process.execPath, [script, '--db-url', pathToFileURL(filename).href, '--cutoff', options.cutoff, '--origin', options.origin, '--expected-code-hash', options.expectedCodeHash, '--result-source', options.resultSource, ...extra], { encoding: 'utf8' });
  const before = fs.readFileSync(filename), files = fs.readdirSync(dir);
  const first = run([]); assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).denominators.scoredMatches, 0);
  assert.deepEqual(fs.readFileSync(filename), before); assert.deepEqual(fs.readdirSync(dir), files);
  const output = path.join(dir, 'result.json'); assert.equal(run(['--output', output]).status, 0);
  const resultBefore = fs.readFileSync(output), again = run(['--output', output]); assert.equal(again.status, 1);
  assert.equal(JSON.parse(again.stdout).error, 'output_already_exists'); assert.deepEqual(fs.readFileSync(output), resultBefore);
  const missing = path.join(dir, 'missing.db');
  const child = spawnSync(process.execPath, [script, '--db-url', pathToFileURL(missing).href, '--cutoff', options.cutoff, '--origin', options.origin, '--expected-code-hash', options.expectedCodeHash, '--result-source', options.resultSource], { encoding: 'utf8' });
  assert.equal(child.status, 1); assert.equal(fs.existsSync(missing), false);
  const malicious = spawnSync(process.execPath, [script, '--db-url', 'https://user:SUPER_SECRET@example.com/?token=PRIVATE', '--cutoff', options.cutoff, '--origin', options.origin, '--expected-code-hash', options.expectedCodeHash, '--result-source', options.resultSource], { encoding: 'utf8' });
  assert.equal(malicious.status, 1); assert.ok(!malicious.stdout.includes('SUPER_SECRET')); assert.ok(!malicious.stdout.includes('PRIVATE')); assert.equal(malicious.stderr, '');
});

test('raw client boundary rejects mutation and unsafe remote credential URLs before connecting', async () => {
  for (const sql of ['UPDATE x SET y=1', 'WITH x AS (DELETE FROM t) SELECT 1', 'SELECT 1; DELETE FROM t', 'PRAGMA journal_mode=WAL']) assert.throws(() => selectOnly(sql), /select_only_required/);
  assert.doesNotThrow(() => selectOnly("SELECT 'UPDATE' AS label;"));
  await assert.rejects(openClient({ remote: true }, { TURSO_DATABASE_URL: 'https://user:SECRET@example.com/?token=LEAK', TURSO_AUTH_TOKEN: 'SECRET' }), /unsafe_database_url/);
  await assert.rejects(openClient({ remote: true, dbUrl: 'libsql://private' }, {}), /remote_credentials_environment_only/);
  assert.throws(() => optionsFor({ ...options, cutoff: '2026-02-30T12:00:00Z' }), /invalid_utc_timestamp/);
});
