'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { ModelAProspectiveCollection, collectionScopeManifest } = require('../dist/research/ModelAProspectiveCollection');

test('legacy manifest remains unchanged and alternate policy is pinned and requires explicit calendar store', async () => {
  const scope = { protocolId: 'calendar-test', seasons: ['2026/27'], from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' };
  const legacy = { ...scope, from: '2026-01-01T00:00:00.000Z', to: '2027-01-01T00:00:00.000Z', competitions: ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'], origin: 'prospective_a', window: 'T-24h..T-60min inclusive' };
  assert.equal(collectionScopeManifest(scope).sha256, createHash('sha256').update(JSON.stringify(legacy)).digest('hex'));
  const calendar = { source: 'football-data.org', mappingSha256: 'a'.repeat(64), maxAgeSeconds: 3600,
    expectedTeamCounts: { 'Serie A': 20, 'Premier League': 20, 'La Liga': 20, Bundesliga: 18, 'Ligue 1': 18 } };
  const configured = { ...scope, calendar };
  const manifest = collectionScopeManifest(configured);
  assert.notEqual(manifest.sha256, collectionScopeManifest(scope).sha256);
  assert.deepEqual(manifest.snapshot.calendar, calendar);
  const client = { execute() { throw new Error('database_access_unexpected'); } };
  const collector = new ModelAProspectiveCollection(client, { predict() { throw new Error('prediction_unexpected'); } }, { ...configured, manifestSha256: manifest.sha256 });
  await assert.rejects(collector.run(), /collection_calendar_store_required/);
});
