#!/usr/bin/env node
// One SELECT and in-memory synthetic inference. No application bootstrap or writes.
const { createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const EXPECTED_HOST = 'footpredictor-selloneciompi.aws-eu-west-1.turso.io';
const MODEL_QUERY = `SELECT m.version,m.artifact_json,m.artifact_hash,m.created_at,
  CASE WHEN c.version=m.version THEN 1 ELSE 0 END AS is_champion
  FROM research_models m LEFT JOIN research_champions c ON c.family=m.family
  WHERE m.family='C'
  ORDER BY CASE WHEN c.version=m.version THEN 0 ELSE 1 END,m.created_at DESC,m.version DESC
  LIMIT 1`;

class ProbeFailure extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new ProbeFailure(code); };
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const artifactHash = (artifact) => createHash('sha256').update(JSON.stringify(canonical(artifact))).digest('hex');
const timestamp = (value) => typeof value === 'string' && /(?:z|[+-]\d{2}:\d{2})$/i.test(value) ? Date.parse(value) : NaN;

async function probeRuntime(options = {}) {
  const env = options.env ?? process.env;
  let client, stage = 'runtime_probe_configuration_invalid';
  const started = performance.now();
  try {
    const url = new URL(env.TURSO_DATABASE_URL || '');
    const readOnlyToken = String(env.TURSO_WATCHDOG_READONLY_TOKEN ?? '').trim();
    if (url.hostname !== EXPECTED_HOST || !['libsql:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.port || url.search || url.hash || !['', '/'].includes(url.pathname)
      || !readOnlyToken) fail(stage);
    // A dedicated RO secret is mandatory. Never consult TURSO_AUTH_TOKEN.
    stage = 'runtime_probe_read_failed';
    const createClient = options.createClient ?? require('@libsql/client').createClient;
    client = createClient({ url: url.toString(), authToken: readOnlyToken });
    const result = await client.execute(MODEL_QUERY);
    const row = result.rows[0];
    if (!row) fail('runtime_probe_model_missing');
    stage = 'runtime_probe_artifact_invalid';
    const { validateArtifact, predictHybrid, normalizeJoint } = require('../dist/research/CatBoostModel');
    const { baselineManifest, FEATURE_NAMES, FEATURE_SCHEMA_VERSION } = require('../dist/research/ForecastCore');
    const { coherentProbabilityPipelineHash, COHERENT_PROBABILITY_PROTOCOL } = require('../dist/research/CoherentProbabilityPipeline');
    const artifact = JSON.parse(row.artifact_json);
    validateArtifact(artifact);
    stage = 'runtime_probe_identity_invalid';
    const now = (options.clock ?? (() => new Date()))();
    const baseline = baselineManifest();
    if (!/^C-[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(row.version) || row.version !== artifact.version
      || !/^[a-f0-9]{64}$/.test(row.artifact_hash) || artifactHash(artifact) !== row.artifact_hash
      || artifact.baselineVersion !== baseline.version || artifact.featureSchema !== FEATURE_SCHEMA_VERSION
      || artifact.probabilityProtocol !== COHERENT_PROBABILITY_PROTOCOL || artifact.pipelineHashV2 !== coherentProbabilityPipelineHash()
      || artifact.diagnosticOnly === true || artifact.runtimeCompatible === false || ![0, 1].includes(Number(row.is_champion))
      || !Number.isFinite(now.getTime()) || !Number.isFinite(timestamp(row.created_at)) || timestamp(row.created_at) > now.getTime()
      || !Number.isFinite(timestamp(artifact.createdAt)) || timestamp(artifact.createdAt) > now.getTime()
      || !Number.isFinite(timestamp(artifact.validationThrough)) || timestamp(artifact.validationThrough) >= now.getTime()) fail(stage);
    const marginal = (lambda) => {
      const values = [Math.exp(-lambda)];
      for (let index = 1; index <= 10; index++) values.push(values[index - 1] * lambda / index);
      return values;
    };
    const home = marginal(1.5), away = marginal(1.1);
    const input = { featureNames: FEATURE_NAMES, featureSchema: FEATURE_SCHEMA_VERSION, features: FEATURE_NAMES.map(() => 0),
      baselineMatrix: normalizeJoint(home.map((h) => away.map((a) => h * a))), baselineVersion: baseline.version,
      lambdaHome: 1.5, lambdaAway: 1.1, forecastAt: now.toISOString() };
    stage = 'runtime_probe_inference_failed';
    const prediction = predictHybrid(input, artifact);
    const finiteProbabilities = Object.values(prediction.probabilities).every((p) => Number.isFinite(p) && p >= 0 && p <= 1);
    const matrixMass = prediction.matrix.flat().reduce((sum, p) => sum + p, 0);
    const oneXTwoMass = ['homeWin', 'draw', 'awayWin'].reduce((sum, key) => sum + prediction.probabilities[key], 0);
    if (!finiteProbabilities || !Number.isFinite(matrixMass) || Math.abs(matrixMass - 1) > 1e-9
      || !Number.isFinite(oneXTwoMass) || Math.abs(oneXTwoMass - 1) > 1e-9) fail(stage);
    for (let index = 0; index < 5; index++) predictHybrid(input, artifact);
    const times = [];
    for (let index = 0; index < 100; index++) {
      const before = performance.now(); predictHybrid(input, artifact); times.push(performance.now() - before);
    }
    times.sort((a, b) => a - b);
    return { ok: true, probe: 'registered_c_numeric_json_node_inference', node: process.version, platform: process.platform,
      model: { version: row.version, artifactHash: row.artifact_hash, baselineVersion: baseline.version,
        pipelineHash: artifact.pipelineHashV2, featureSchema: FEATURE_SCHEMA_VERSION,
        role: Number(row.is_champion) === 1 ? 'CHAMPION' : 'CANDIDATE' },
      checks: { finiteProbabilities, matrixMass, oneXTwoMass }, inference: { samples: times.length, p95Ms: times[95] },
      resources: { wallMs: performance.now() - started, maxRssMiB: process.resourceUsage().maxRSS / 1024 },
      syntheticInput: true, databaseSelects: 1, databaseWrites: 0, providerRequests: 0,
      fixtureCycleVerified: false, nativeParityExecuted: false };
  } catch (error) {
    throw error instanceof ProbeFailure ? error : new ProbeFailure(stage);
  } finally {
    if (client) {
      try { await client.close(); } catch { fail('runtime_probe_close_failed'); }
    }
  }
}

async function main(options = {}) {
  try {
    const report = await probeRuntime(options);
    (options.log ?? console.log)(JSON.stringify(report)); return 0;
  } catch (error) {
    (options.error ?? console.error)(JSON.stringify({ ok: false,
      code: error instanceof ProbeFailure ? error.code : 'runtime_probe_failed',
      syntheticInput: true, databaseWrites: 0, providerRequests: 0 }));
    return 1;
  }
}
module.exports = { probeRuntime, main, EXPECTED_HOST, MODEL_QUERY };
if (require.main === module) main().then((code) => { process.exitCode = code; }).catch(() => {
  console.error(JSON.stringify({ ok: false, code: 'runtime_probe_failed' })); process.exitCode = 1;
});
