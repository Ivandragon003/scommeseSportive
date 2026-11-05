'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const script = path.join(__dirname, '../scripts/model-a-prospective-collect.js');

test('calendar opt-in absent does not load its producer or inspect credentials', async () => {
  const { calendarConfiguration, main } = require(script);
  const env = new Proxy({}, { get(_target, name) {
    if (name === 'MODEL_A_RESEARCH_CALENDAR_ENABLED' || name === 'MODEL_A_PROSPECTIVE_COLLECTION_ENABLED') return undefined;
    throw new Error(`unexpected access: ${String(name)}`);
  } });
  assert.equal(calendarConfiguration(env), null);
  await main(env, []);
});

test('print-scope and collector configuration use the same calendar policy without requiring a key', () => {
  const code = `const Module = require('node:module'); const orig = Module._load;
    Module._load = function(id, ...args) {
      if (id.endsWith('/ModelAResearchCalendarStore')) return { calendarMappingHash: () => 'a'.repeat(64) };
      if (id.endsWith('/ModelAProspectiveCollection')) return { collectionScopeManifest: scope => scope };
      return orig.call(this, id, ...args);
    };
    require(process.argv[1]).main({ MODEL_A_RESEARCH_CALENDAR_ENABLED:'true', MODEL_A_RESEARCH_CALENDAR_MAPPING_JSON:'{"Serie A":{"1":"2"}}',
      MODEL_A_RESEARCH_CALENDAR_EXPECTED_TEAM_COUNTS:'{"Serie A":20}', MODEL_A_RESEARCH_CALENDAR_MAX_AGE_SECONDS:'3600',
      MODEL_A_COLLECTION_PROTOCOL_ID:'p', MODEL_A_COLLECTION_SEASONS:'2026/27', MODEL_A_COLLECTION_FROM:'2026-01-01T00:00:00Z', MODEL_A_COLLECTION_TO:'2027-01-01T00:00:00Z' }, ['--print-scope']);`;
  const result = spawnSync(process.execPath, ['-e', code, script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).calendar, { source: 'football-data.org', mappingSha256: 'a'.repeat(64), maxAgeSeconds: 3600, expectedTeamCounts: { 'Serie A': 20 } });
  assert.equal(result.stdout.includes('API_KEY'), false);
});

test('malformed opt-in configuration is rejected before producer import', () => {
  const { calendarConfiguration } = require(script);
  assert.throws(() => calendarConfiguration({ MODEL_A_RESEARCH_CALENDAR_ENABLED: 'true', MODEL_A_RESEARCH_CALENDAR_MAPPING_JSON: '{', MODEL_A_RESEARCH_CALENDAR_EXPECTED_TEAM_COUNTS: '{}' }), /collection_calendar_configuration_invalid/);
});
