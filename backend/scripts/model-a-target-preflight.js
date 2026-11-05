'use strict';

const { createHash } = require('node:crypto');

const COMPETITIONS = [
  { name: 'Serie A', code: 'SA', teams: 20 },
  { name: 'Premier League', code: 'PL', teams: 20 },
  { name: 'La Liga', code: 'PD', teams: 20 },
  { name: 'Bundesliga', code: 'BL1', teams: 18 },
  { name: 'Ligue 1', code: 'FL1', teams: 18 },
];
const TABLES = [
  'model_a_prospective_forecasts', 'model_a_prospective_results',
  'model_a_collection_protocols', 'model_a_collection_ledger', 'model_a_collection_runs',
  'model_a_prospective_result_observations', 'model_a_prospective_result_refresh_state',
  'model_a_calendar_attempts', 'model_a_calendar_fixtures', 'runtime_calibration_profiles',
];
const SCHEMA_SQL = `SELECT name FROM sqlite_schema WHERE type='table' AND name IN (
  'model_a_prospective_forecasts','model_a_prospective_results','model_a_collection_protocols',
  'model_a_collection_ledger','model_a_collection_runs','model_a_prospective_result_observations',
  'model_a_prospective_result_refresh_state','model_a_calendar_attempts','model_a_calendar_fixtures',
  'runtime_calibration_profiles')`;
const MATCHES_SQL = 'SELECT match_id,home_team_id,away_team_id,source,source_match_id FROM matches WHERE competition=? AND season=?';

/** This script deliberately does not import the application, dotenv or DatabaseService. */
async function runPreflight(options) {
  const env = options.env || process.env;
  const report = {
    status: 'blocked', hostSha256: null, expectedHostMatched: false, readQueryConfirmed: false,
    schema: { scope: 'table_presence_only', checked: false, tables: {} },
    calendar: [], errors: [], persistenceVerified: false, collectionVerified: false,
  };
  const fail = (code) => { report.errors.push(code); return report; };
  let url;
  try {
    url = new URL(env.TURSO_DATABASE_URL || '');
    if (!['libsql:', 'https:'].includes(url.protocol) || !url.hostname || url.port ||
        url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
      return fail('database_url_invalid');
    }
  } catch { return fail('database_url_invalid'); }
  report.hostSha256 = createHash('sha256').update(url.hostname.toLowerCase()).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(options.expectedHostSha256 || '')) return fail('expected_host_hash_invalid');
  if (report.hostSha256 !== options.expectedHostSha256) return fail('database_identity_mismatch');
  report.expectedHostMatched = true;
  const season = options.season;
  if (!/^\d{4}\/\d{4}$/.test(season || '') || Number(season.slice(5)) !== Number(season.slice(0, 4)) + 1 ||
      Number(season.slice(0, 4)) < 1900 || Number(season.slice(0, 4)) > 2100) return fail('season_invalid');
  if (!env.TURSO_AUTH_TOKEN?.trim()) return fail('database_credentials_missing');
  if (!env.FOOTBALL_DATA_ORG_API_KEY?.trim()) return fail('calendar_credentials_missing');
  let mapping = {};
  try {
    mapping = JSON.parse(env.MODEL_A_RESEARCH_CALENDAR_MAPPING_JSON || '');
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('invalid_mapping');
    if (Object.keys(mapping).length !== COMPETITIONS.length || COMPETITIONS.some(({ name, teams }) => {
          const entries = mapping[name];
          return !entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length !== teams ||
            Object.entries(entries).some(([id, local]) => !/^[1-9]\d*$/.test(id) || typeof local !== 'string' || !local.trim() || local !== local.trim()) ||
            new Set(Object.values(entries)).size !== teams;
        })) report.errors.push('calendar_mapping_invalid');
  } catch { report.errors.push('calendar_mapping_invalid'); mapping = {}; }

  let client;
  try {
    const createClient = options.createClient || require('@libsql/client').createClient;
    client = createClient({ url: url.toString(), authToken: env.TURSO_AUTH_TOKEN.trim() });
    const rows = (await client.execute({ sql: SCHEMA_SQL, args: [] })).rows;
    report.readQueryConfirmed = true;
    const present = new Set(rows.map(row => String(row.name)));
    report.schema.checked = true;
    report.schema.tables = Object.fromEntries(TABLES.map(name => [name, present.has(name) ? 'present' : 'absent']));
    if (TABLES.some(name => !present.has(name))) report.errors.push('required_tables_absent');
    const calendar = require('../dist/services/modelAResearchCalendar');
    const fetchCalendar = options.fetchCalendar || calendar.fetchFootballDataCalendar;
    for (const { name, code, teams } of COMPETITIONS) {
      const entry = { competition: name, status: 'blocked', localFixtures: null, coverage: null, issues: {}, error: null };
      report.calendar.push(entry);
      let localMatches = [];
      let localReadable = false;
      try {
        const local = (await client.execute({ sql: MATCHES_SQL, args: [name, season] })).rows;
        localMatches = local.map(row => ({ id: String(row.match_id), homeTeamId: String(row.home_team_id ?? ''),
          awayTeamId: String(row.away_team_id ?? ''), source: String(row.source ?? ''), sourceMatchId: String(row.source_match_id ?? '') }));
        entry.localFixtures = local.length;
        localReadable = true;
      } catch { entry.error = 'local_matches_read_failed'; }
      try {
        // Exactly one request per competition, including when the local mapping is incomplete.
        const response = await fetchCalendar({ competition: code, season: Number(season.slice(0, 4)), apiKey: env.FOOTBALL_DATA_ORG_API_KEY.trim() });
        const teamMapping = mapping[name] && typeof mapping[name] === 'object' && !Array.isArray(mapping[name]) ? mapping[name] : {};
        const resolved = calendar.resolveFootballDataCalendar({ payload: response.payload, competition: code,
          season: Number(season.slice(0, 4)), acquiredAt: response.acquiredAt, expectedTeamCount: teams, teamMapping, localMatches });
        entry.coverage = resolved.coverage;
        for (const fixture of resolved.fixtures) {
          if (fixture.issue) entry.issues[fixture.issue] = (entry.issues[fixture.issue] || 0) + 1;
        }
        if (localReadable && resolved.coverage.mappingComplete) entry.status = 'checks_passed';
        else if (!entry.error) entry.error = 'calendar_coverage_incomplete';
      } catch { entry.error = 'calendar_fetch_or_payload_failed'; }
    }
    if (report.calendar.some(entry => entry.status !== 'checks_passed')) report.errors.push('calendar_checks_failed');
    if (!report.errors.length) report.status = 'checks_passed';
  } catch { report.errors.push('database_or_calendar_setup_failed'); }
  finally {
    if (client) {
      try { client.close(); } catch { report.errors.push('database_close_failed'); report.status = 'blocked'; }
    }
  }
  return report;
}

async function main(env = process.env) {
  const report = await runPreflight({ env, expectedHostSha256: env.MODEL_A_EXPECTED_HOST_SHA256, season: env.MODEL_A_PREFLIGHT_SEASON });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === 'checks_passed' ? 0 : 1;
}

if (require.main === module) main().catch(() => {
  console.error('model_a_target_preflight_failed');
  process.exitCode = 1;
});

module.exports = { runPreflight, TABLES };
