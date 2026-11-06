const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { sourceMode, readValidatedManifest, recomputeImportedTeams } = require('../scripts/nightly-source-context');
const { prepare } = require('../scripts/prepare-nightly-source-config');

const canonical = x => Array.isArray(x) ? x.map(canonical) : x && typeof x === 'object'
  ? Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])])) : x;
const sha = x => createHash('sha256').update(x).digest('hex');
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-source-config-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('nightly-source-config-'));
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  });
  const target = 'file:/explicit-isolated-target.sqlite';
  const env = { TURSO_DATABASE_URL: target, NIGHTLY_SOURCE_TARGET_SHA256: sha(target), NIGHTLY_SOURCE_SEASON: '2026',
    NIGHTLY_SOURCE_MANIFEST_FILE: path.join(dir, 'manifest.json'), NIGHTLY_SOURCE_MAPPING_FILE: path.join(dir, 'mapping.json') };
  const content = { schemaVersion: 1, mode: 'execute', targetSha256: sha(target), generatedAt: '2026-11-05T00:00:00Z',
    competitions: [], updatedTeamIds: ['home', 'away', 'home'] };
  const save = x => fs.writeFileSync(env.NIGHTLY_SOURCE_MANIFEST_FILE, JSON.stringify({ ...x,
    manifestSha256: sha(JSON.stringify(canonical(x))) }));
  save(content);
  return { env, content, save };
}

test('source mode defaults to primary and unknown modes cannot silently select a fallback', () => {
  assert.equal(sourceMode({}), 'primary');
  assert.equal(sourceMode({ NIGHTLY_SOURCE_MODE: 'verified-alternatives' }), 'verified-alternatives');
  assert.throws(() => sourceMode({ NIGHTLY_SOURCE_MODE: 'other' }), /mode_invalid/);
});
test('a target mismatch is rejected before trying to read files or opening any database', () => {
  assert.throws(() => readValidatedManifest({ TURSO_DATABASE_URL: 'file:other', NIGHTLY_SOURCE_TARGET_SHA256: 'a'.repeat(64) }), /target_mismatch/);
});
test('only an executed, sealed manifest bound to this target can drive maintenance', async t => {
  const f = setup(t), calls = [];
  assert.equal(readValidatedManifest(f.env).mode, 'execute');
  await recomputeImportedTeams({ recomputeTeamAveragesBatch: async ids => calls.push(ids) }, f.env);
  assert.deepEqual(calls, [['home', 'away']]);
  f.save({ ...f.content, mode: 'plan' });
  await assert.rejects(recomputeImportedTeams({ recomputeTeamAveragesBatch: async () => assert.fail('must not write') }, f.env), /manifest_invalid/);
});
test('tampering, future generated times and foreign target manifests are rejected', t => {
  const f = setup(t);
  const tampered = JSON.parse(fs.readFileSync(f.env.NIGHTLY_SOURCE_MANIFEST_FILE));
  tampered.updatedTeamIds.push('unapproved'); fs.writeFileSync(f.env.NIGHTLY_SOURCE_MANIFEST_FILE, JSON.stringify(tampered));
  assert.throws(() => readValidatedManifest(f.env), /manifest_invalid/);
  f.save({ ...f.content, generatedAt: '2999-01-01T00:00:00Z' });
  assert.throws(() => readValidatedManifest(f.env), /manifest_invalid/);
  f.save({ ...f.content, targetSha256: 'f'.repeat(64) });
  assert.throws(() => readValidatedManifest(f.env), /manifest_invalid/);
});
test('configuration preparation preserves an existing mapping and rejects recorder activation', t => {
  const f = setup(t), mapping = { version: 'reviewed-source-mapping-v1', reference: 'synthetic explicit review',
    reviewedAt: '2026-01-01T00:00:00Z', teams: Object.fromEntries(['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'].map(x => [x, {}])) };
  f.env.NIGHTLY_SOURCE_MAPPING_JSON = JSON.stringify(mapping);
  assert.equal(prepare(f.env).writesToOperationalDatabase, 0);
  const before = fs.readFileSync(f.env.NIGHTLY_SOURCE_MAPPING_FILE, 'utf8');
  assert.throws(() => prepare({ ...f.env, MODEL_A_PROSPECTIVE_ENABLED: 'true' }), /scheduler_conflict/);
  assert.throws(() => prepare({ ...f.env, NIGHTLY_SOURCE_MAPPING_JSON: JSON.stringify({ ...mapping, reference: 'changed' }) }), /mapping_changed/);
  assert.equal(fs.readFileSync(f.env.NIGHTLY_SOURCE_MAPPING_FILE, 'utf8'), before);
});
test('disabled alternative nightly stays inert even without target, cache and mapping configuration', async () => {
  const { runNightly } = require('../scripts/research-nightly');
  const result = await runNightly({ policy: { enabled: false }, env: { NIGHTLY_SOURCE_MODE: 'verified-alternatives' }, log: () => {} });
  assert.equal(result.enabled, false); assert.equal(result.reason, 'nightly_disabled');
});
