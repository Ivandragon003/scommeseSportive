'use strict';

// Standalone, opt-in research prototype. Nothing imports this from the live app.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const STAGES = ['ensembleRaw', 'contextual', 'calibrated', 'marketBlended', 'decision'];
const HEX = /^[a-f0-9]{64}$/;
function only(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error(`invalid_${label}`);
}
function text(value, name) { if (typeof value !== 'string' || !value.trim()) throw Error(`invalid_${name}`); return value; }
function time(value, name) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw Error(`invalid_${name}`);
  return Date.parse(value);
}
function canonical(v) { return Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v; }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }
function stage(value, name) {
  only(value, ['status', 'over', 'under', 'reason'], name);
  if (value.reason != null) text(value.reason, `${name}_reason`);
  if (!['applied', 'not_applied', 'unavailable'].includes(value.status)) throw Error(`invalid_${name}_status`);
  if (value.status !== 'applied') {
    if (value.over != null || value.under != null) throw Error(`unexpected_${name}_probability`);
    text(value.reason, `${name}_reason`);
    return { status: value.status, over: null, under: null, reason: value.reason };
  }
  for (const side of ['over', 'under']) if (value[side] !== null && (typeof value[side] !== 'number' || !Number.isFinite(value[side]) || value[side] < 0 || value[side] > 1)) throw Error(`invalid_${name}_${side}`);
  if (value.over === null && value.under === null) throw Error(`missing_${name}_probability`);
  return { status: value.status, over: value.over, under: value.under, reason: value.reason ?? null };
}
function createRecorder(directory, clock = () => new Date()) {
  function write(kind, payload) {
    fs.mkdirSync(directory, { recursive: true });
    const id = crypto.randomUUID(); const record = { id, kind, ...payload }; const envelope = { record, sha256: digest(record) };
    fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(envelope) + '\n', { flag: 'wx', mode: 0o600 });
    return envelope;
  }
  function read(id) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw Error('invalid_id');
    const e = JSON.parse(fs.readFileSync(path.join(directory, `${id}.json`), 'utf8'));
    if (e.record?.id !== id || e.sha256 !== digest(e.record)) throw Error('integrity_failure');
    return e.record;
  }
  function forecast(input) {
    only(input, ['match', 'forecastAt', 'model', 'stages', 'decisionInfo', 'quotes', 'inputEvidence'], 'forecast');
    only(input.match, ['id', 'competition', 'season', 'home', 'away', 'kickoffAt'], 'match');
    for (const k of ['id', 'competition', 'season', 'home', 'away']) text(input.match[k], `match_${k}`);
    const forecastAt = time(input.forecastAt, 'forecast_time'), kickoff = time(input.match.kickoffAt, 'kickoff');
    const recorded = clock().getTime();
    if (!Number.isFinite(recorded) || forecastAt > recorded || forecastAt >= kickoff || recorded >= kickoff) throw Error('forecast_not_recorded_prematch');
    only(input.model, ['version', 'configHash', 'codeHash', 'stateHash'], 'model');
    if (!/^APP-A-[a-f0-9]+$/.test(text(input.model.version, 'model_version'))) throw Error('invalid_model_a_version');
    for (const key of ['configHash', 'codeHash', 'stateHash']) if (!HEX.test(input.model[key])) throw Error(`invalid_${key}`);
    only(input.inputEvidence, ['snapshotHash', 'availableThrough', 'reason'], 'input_evidence');
    if (input.inputEvidence.snapshotHash !== null && !HEX.test(input.inputEvidence.snapshotHash)) throw Error('invalid_snapshot_hash');
    if (input.inputEvidence.availableThrough !== null && time(input.inputEvidence.availableThrough, 'input_available') > forecastAt) throw Error('future_input');
    if (input.inputEvidence.availableThrough === null) text(input.inputEvidence.reason, 'input_evidence_reason');
    if (input.inputEvidence.reason != null) text(input.inputEvidence.reason, 'input_evidence_reason');
    only(input.stages, STAGES, 'stages');
    const stages = Object.fromEntries(STAGES.map(k => [k, stage(input.stages[k], k)]));
    only(input.decisionInfo, ['action', 'selection', 'reason'], 'decision_info');
    if (!['BET', 'ABSTAIN', 'OTHER', 'NOT_RECORDED'].includes(input.decisionInfo.action)
      || ![null, 'over25', 'under25', 'other'].includes(input.decisionInfo.selection)) throw Error('invalid_decision_info');
    if (input.decisionInfo.reason != null) text(input.decisionInfo.reason, 'decision_reason');
    if (!Array.isArray(input.quotes)) throw Error('invalid_quotes');
    const quotes = input.quotes.map(q => {
      only(q, ['selection', 'odds', 'provider', 'bookmaker', 'capturedAt', 'updatedAt', 'synthetic'], 'quote');
      if (!['over25', 'under25'].includes(q.selection) || typeof q.odds !== 'number' || !Number.isFinite(q.odds) || q.odds <= 1 || q.synthetic !== false) throw Error('invalid_quote');
      text(q.provider, 'provider'); text(q.bookmaker, 'bookmaker');
      if (time(q.capturedAt, 'quote_capture') > forecastAt || time(q.updatedAt, 'quote_update') > forecastAt) throw Error('future_quote');
      return { ...q };
    });
    return write('forecast', { schema: 'model-a-prospective-v1', family: 'A', match: { ...input.match }, forecastAt: input.forecastAt,
      recordedAt: new Date(recorded).toISOString(), model: { ...input.model }, inputEvidence: { ...input.inputEvidence }, stages,
      decisionInfo: { ...input.decisionInfo }, quotes });
  }
  function result(input) {
    only(input, ['forecastId', 'homeGoals', 'awayGoals', 'finalAt', 'availableAt', 'source'], 'result');
    const prediction = read(input.forecastId); if (prediction.kind !== 'forecast') throw Error('forecast_required');
    const now = clock().getTime(), final = time(input.finalAt, 'final_time'), available = time(input.availableAt, 'result_available');
    if (!Number.isFinite(now) || final < time(prediction.match.kickoffAt, 'kickoff') || available < final || available > now) throw Error('result_not_available');
    for (const k of ['homeGoals', 'awayGoals']) if (!Number.isSafeInteger(input[k]) || input[k] < 0) throw Error('invalid_score');
    text(input.source, 'result_source');
    return write('result', { schema: 'model-a-prospective-v1', forecastId: input.forecastId, forecastHash: digest(prediction),
      matchId: prediction.match.id, homeGoals: input.homeGoals, awayGoals: input.awayGoals, finalAt: input.finalAt,
      availableAt: input.availableAt, recordedAt: new Date(now).toISOString(), source: input.source });
  }
  return Object.freeze({ forecast, result, read });
}
module.exports = { createRecorder, digest };
