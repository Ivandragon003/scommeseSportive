'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runPreflight, TABLES } = require('../scripts/model-a-target-preflight');

const HOST = 'preflight-test.turso.io';
const HASH = createHash('sha256').update(HOST).digest('hex');
const SEASON = '2026/2027';
const LEAGUES = [
  ['Serie A', 'SA', 2019, 20], ['Premier League', 'PL', 2021, 20],
  ['La Liga', 'PD', 2014, 20], ['Bundesliga', 'BL1', 2002, 18], ['Ligue 1', 'FL1', 2015, 18],
];

function fixture(options = {}) {
  const mapping = {}, local = {}, payloads = {};
  let sequence = 1;
  for (const [name, code, id, teams] of LEAGUES) {
    mapping[name] = Object.fromEntries(Array.from({ length: teams }, (_, index) => [String(index + 1), `${code}_${index + 1}`]));
    local[name] = [];
    const matches = [];
    for (let home = 1; home <= teams; home++) {
      for (let away = 1; away <= teams; away++) {
        if (home === away) continue;
        matches.push({ id: sequence, homeTeam: { id: home }, awayTeam: { id: away }, status: 'TIMED', utcDate: '2026-11-20T12:00:00Z' });
        local[name].push({ match_id: `understat_${sequence}`, home_team_id: `${code}_${home}`,
          away_team_id: `${code}_${away}`, source: 'understat', source_match_id: sequence });
        sequence++;
      }
    }
    payloads[code] = { competition: { id }, season: { startDate: '2026-08-01' }, matches };
  }
  const statements = [], requests = [];
  let closed = false, clients = 0;
  const env = { TURSO_DATABASE_URL: `libsql://${HOST}`, TURSO_AUTH_TOKEN: 'PRIVATE_DB_TOKEN',
    FOOTBALL_DATA_ORG_API_KEY: 'PRIVATE_PROVIDER_TOKEN', MODEL_A_RESEARCH_CALENDAR_MAPPING_JSON: JSON.stringify(mapping) };
  const createClient = () => {
    clients++;
    return {
      execute: async (statement) => {
        statements.push(statement);
        assert.match(statement.sql, /^SELECT /);
        assert.doesNotMatch(statement.sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|PRAGMA)\b/i);
        if (statement.sql.includes('FROM sqlite_schema')) return { rows: (options.tables || TABLES).map(name => ({ name })) };
        assert.equal(statement.sql, 'SELECT match_id,home_team_id,away_team_id,source,source_match_id FROM matches WHERE competition=? AND season=?');
        assert.equal(statement.args[1], SEASON);
        return { rows: local[statement.args[0]] };
      },
      close: () => { closed = true; },
    };
  };
  const fetchCalendar = async (request) => {
    requests.push(request);
    assert.equal(request.season, 2026);
    return { payload: payloads[request.competition], acquiredAt: '2026-11-05T12:00:00Z' };
  };
  return { env, statements, requests, payloads, createClient, fetchCalendar,
    options: { env, expectedHostSha256: HASH, season: SEASON, createClient, fetchCalendar },
    get closed() { return closed; }, get clients() { return clients; } };
}

test('target preflight confirms identity with six SELECTs and five calendar requests, without persistence claims', async () => {
  const f = fixture();
  const report = await runPreflight(f.options);
  assert.equal(report.status, 'checks_passed');
  assert.equal(report.hostSha256, HASH);
  assert.equal(report.readQueryConfirmed, true);
  assert.equal(report.schema.scope, 'table_presence_only');
  assert.equal(Object.keys(report.schema.tables).length, 10);
  assert.equal(f.statements.length, 6);
  assert.deepEqual(f.requests.map(request => request.competition), ['SA', 'PL', 'PD', 'BL1', 'FL1']);
  assert.deepEqual(report.calendar.map(entry => entry.coverage.expectedTeams), [20, 20, 20, 18, 18]);
  assert.ok(report.calendar.every(entry => entry.coverage.mappingComplete));
  assert.equal(report.persistenceVerified, false);
  assert.equal(report.collectionVerified, false);
  assert.equal(f.closed, true);
  const output = JSON.stringify(report);
  for (const secret of [HOST, f.env.TURSO_AUTH_TOKEN, f.env.FOOTBALL_DATA_ORG_API_KEY, 'utcDate', 'understat_1']) {
    assert.equal(output.includes(secret), false);
  }
});

test('identity mismatch or invalid target is rejected before client or provider access', async () => {
  for (const target of [`libsql://${HOST}`, `file:test.db`, `libsql://${HOST}/other`, `libsql://${HOST}?token=secret`]) {
    const f = fixture();
    f.env.TURSO_DATABASE_URL = target;
    const report = await runPreflight({ ...f.options, expectedHostSha256: '0'.repeat(64) });
    assert.equal(report.status, 'blocked');
    assert.equal(f.clients, 0);
    assert.equal(f.requests.length, 0);
    assert.equal(f.statements.length, 0);
    assert.equal(report.readQueryConfirmed, false);
  }
});

test('missing schema is reported without applying it and calendar diagnostics still run', async () => {
  const f = fixture({ tables: ['runtime_calibration_profiles'] });
  const report = await runPreflight(f.options);
  assert.equal(report.status, 'blocked');
  assert.equal(report.schema.tables.model_a_calendar_attempts, 'absent');
  assert.equal(report.schema.tables.runtime_calibration_profiles, 'present');
  assert.ok(report.errors.includes('required_tables_absent'));
  assert.equal(f.requests.length, 5);
  assert.equal(f.statements.length, 6);
});

test('incomplete reviewed mapping fails with aggregate coverage only', async () => {
  const f = fixture();
  const mapping = JSON.parse(f.env.MODEL_A_RESEARCH_CALENDAR_MAPPING_JSON);
  delete mapping['Serie A']['1'];
  f.env.MODEL_A_RESEARCH_CALENDAR_MAPPING_JSON = JSON.stringify(mapping);
  const report = await runPreflight(f.options);
  assert.equal(report.status, 'blocked');
  assert.ok(report.errors.includes('calendar_mapping_invalid'));
  assert.equal(report.calendar[0].coverage.unmappedFixtures, 38);
  assert.equal(report.calendar[0].issues.unmapped_team, 38);
  assert.equal(f.requests.length, 5);
});

test('provider payload mismatch and raw provider or database errors are redacted', async () => {
  const f = fixture();
  f.payloads.SA.competition.id = 0;
  const report = await runPreflight({ ...f.options, fetchCalendar: async (request) => {
    if (request.competition === 'PL') throw new Error(`${HOST} PRIVATE_DB_TOKEN PRIVATE_PROVIDER_TOKEN payload`);
    return f.fetchCalendar(request);
  } });
  assert.equal(report.status, 'blocked');
  assert.equal(report.calendar[0].error, 'calendar_fetch_or_payload_failed');
  assert.equal(report.calendar[1].error, 'calendar_fetch_or_payload_failed');
  assert.equal(report.calendar.length, 5);
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|payload"|preflight-test/);
  const databaseFailure = await runPreflight({ ...f.options, createClient: () => { throw new Error('PRIVATE_DB_TOKEN'); } });
  assert.deepEqual(databaseFailure.errors, ['database_or_calendar_setup_failed']);
  assert.doesNotMatch(JSON.stringify(databaseFailure), /PRIVATE_DB_TOKEN/);
});

test('manual workflow has read-only permissions and supplies explicit identity inputs without activation', () => {
  const workflow = readFileSync(join(__dirname, '../../.github/workflows/model-a-target-preflight.yml'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /expected_host_sha256:/);
  assert.match(workflow, /MODEL_A_EXPECTED_HOST_SHA256: \$\{\{ inputs.expected_host_sha256 \}\}/);
  assert.doesNotMatch(workflow, /\b(?:schedule|push|pull_request):|contents: write|model-a-prospective-collect|PROSPECTIVE_ENABLED|COLLECTION_ENABLED/);
});
