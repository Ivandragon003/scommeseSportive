const test = require('node:test');
const assert = require('node:assert/strict');
const { join } = require('node:path');
const { historicalSnapshotObservation, recordedOddsTimestamp, historicalGoalSelection,
  selectHistoricalObservation, footballDataHistoricalEvidence, linkHistoricalSnapshot,
  buildHistoricalFixtureIndex } = require(process.env.RESEARCH_ODDS_MODULE
  || join(__dirname, '../dist/research/HistoricalResearchOdds'));

// Prices and teams below are deliberately synthetic adapter fixtures, not model evidence.
const fixture = (changes = {}) => ({ snapshot_id: 'fixture-snapshot', match_id: 'fixture-match',
  match_date: '2026-04-01T18:00:00Z', commence_time: '2026-04-01T18:00:00Z',
  source: 'odds_api', captured_at: '2026-04-01T17:00:00Z', competition: 'Serie A', season: '2025/2026',
  selected_bookmaker_name: 'Fixture Book', selected_odds_json: JSON.stringify({ homeWin: 2, draw: 3, awayWin: 4 }),
  used_synthetic_odds: 0, ...changes });

test('archived observations retain real capture time and omit unknown provider update time', () => {
  const { observation, reason } = historicalSnapshotObservation(fixture());
  assert.equal(reason, null);
  assert.equal(observation.observationAt, '2026-04-01T17:00:00.000Z');
  assert.equal(observation.providerUpdatedAt, null);
  assert.equal(observation.t15FreshnessVerified, false);
  assert.equal(observation.quotes.length, 3);
  for (const quote of observation.quotes) {
    assert.equal(quote.updatedAt, undefined);
    assert.equal(quote.timestampEvidence, 'observed_snapshot');
    assert.equal(quote.priceType, 'prematch');
    assert.equal(quote.snapshotId, 'fixture-snapshot');
  }
});

test('complete price partitions stay with one actual operator and Eurobet has priority only when present', () => {
  const books = { Eurobet: { homeWin: 1.9 }, 'Fixture Book': { homeWin: 2, draw: 3, awayWin: 4 } };
  const fallback = historicalSnapshotObservation(fixture({ all_bookmaker_odds_json: JSON.stringify(books) })).observation;
  assert.ok(fallback.quotes.every((quote) => quote.bookmaker === 'Fixture Book'));
  books.Eurobet = { homeWin: 1.9, draw: 3.1, awayWin: 4.2 };
  const eurobet = historicalSnapshotObservation(fixture({ all_bookmaker_odds_json: JSON.stringify(books) })).observation;
  assert.ok(eurobet.quotes.every((quote) => quote.bookmaker === 'Eurobet'));
  assert.equal(eurobet.quotes.find((quote) => quote.side === 'home').odds, 1.9);
});

test('a real alternative bookmaker is not synthetic merely because the legacy source calls it fallback', () => {
  const result = historicalSnapshotObservation(fixture({ source: 'the_odds_api_bulk_fallback_bookmaker', used_fallback_bookmaker: 1 }));
  assert.equal(result.reason, null);
  assert.equal(result.observation.quotes[0].source, 'odds_api');
  assert.equal(result.observation.quotes[0].snapshotSource, 'the_odds_api_bulk_fallback_bookmaker');
  assert.equal(result.observation.quotes[0].bookmaker, 'Fixture Book');
});

test('synthetic, post-kickoff, unproven provider and mismatched fixture prices are excluded', () => {
  for (const changes of [{ source: 'odds_api_plus_model_completion' }, { used_synthetic_odds: 1 }]) {
    assert.equal(historicalSnapshotObservation(fixture(changes)).reason, 'synthetic_or_model_completed');
  }
  assert.equal(historicalSnapshotObservation(fixture({ captured_at: '2026-04-01T18:00:00Z' })).reason, 'observed_at_or_after_kickoff');
  assert.equal(historicalSnapshotObservation(fixture({ source: 'unidentified' })).reason, 'unknown_snapshot_source');
  assert.equal(historicalSnapshotObservation(fixture({ commence_time: '2026-04-01T18:05:00Z' })).reason, 'provider_kickoff_mismatch');
  assert.equal(historicalSnapshotObservation(fixture({ selected_bookmaker_name: null })).reason, 'complete_real_bookmaker_partition_missing');
});

test('entry selection never backdates a model or transplant a later price into an earlier forecast', () => {
  const observations = ['16:00', '17:00', '17:50'].map((time) => historicalSnapshotObservation(fixture({
    snapshot_id: `fixture-${time}`, captured_at: `2026-04-01T${time}:00Z` })).observation);
  const selected = selectHistoricalObservation(observations, { matchId: 'fixture-match',
    forecastCutoff: '2026-04-01T17:45:00Z', modelAvailableThrough: '2026-04-01T16:30:00Z' });
  assert.equal(selected.snapshotId, 'fixture-17:00');
  assert.equal(selectHistoricalObservation(observations, { matchId: 'fixture-match',
    forecastCutoff: '2026-04-01T17:45:00Z', modelAvailableThrough: '2026-04-01T17:30:00Z' }), null);
});

test('aggregate football-data maps never acquire an invented operator or timestamp', () => {
  const result = footballDataHistoricalEvidence(JSON.stringify({ opening: { homeWin: 1.8, draw: 3, awayWin: 4 }, closing: { over25: 2.1 } }));
  assert.equal(result.available, true);
  assert.equal(result.openingSelections, 3);
  assert.equal(result.closingSelections, 1);
  assert.equal(result.economicAdmissible, false);
  assert.match(result.reason, /unknown_bookmaker/);
});

test('timestamp and market decoding preserve documented quarter lines and reject ambiguous legacy keys', () => {
  assert.equal(recordedOddsTimestamp('2026-04-01 17:00:00'), '2026-04-01T17:00:00.000Z');
  assert.equal(recordedOddsTimestamp('2026-02-30T12:00:00Z'), null);
  assert.equal(recordedOddsTimestamp('2026-04-01'), null);
  assert.equal(historicalGoalSelection('over325').line, 3.25);
  assert.equal(historicalGoalSelection('over3').line, 3);
  assert.equal(historicalGoalSelection('team_home_over_15').line, 1.5);
  assert.equal(historicalGoalSelection('team_away_under_05').line, .5);
  assert.equal(historicalGoalSelection('over10'), null);
  assert.equal(historicalGoalSelection('ahcp_away_-0.25').line, -.25);
  assert.equal(historicalGoalSelection('hcp_away+1'), null);
  assert.equal(historicalGoalSelection('cardsTotalOver45'), null);
});

test('unlinked bulk rows are resolved only by one exact known fixture without reversed teams or date tolerance', () => {
  const matches = [{ match_id: 'known-fixture', date: '2026-04-01T18:00:00Z', competition: 'Serie A',
    season: '2025/2026', home_team_name: 'Home', away_team_name: 'Away' }];
  const normalize = (name) => name.toLowerCase();
  const row = fixture({ match_id: null, match_date: null, home_team_name: 'HOME', away_team_name: 'AWAY' });
  const index = buildHistoricalFixtureIndex(matches, normalize);
  const resolved = linkHistoricalSnapshot(row, index, normalize);
  assert.equal(resolved.row.match_id, 'known-fixture');
  assert.equal(resolved.row.matchLinkEvidence.originalMatchId, null);
  assert.equal(resolved.row.matchLinkEvidence.method, 'unique_exact_fixture');
  assert.equal(row.match_id, null);
  assert.equal(linkHistoricalSnapshot({ ...row, commence_time: '2026-04-01T18:01:00Z' }, index, normalize).reason, 'exact_fixture_not_found');
  assert.equal(linkHistoricalSnapshot({ ...row, home_team_name: 'Away', away_team_name: 'Home' }, index, normalize).reason, 'exact_fixture_not_found');
  assert.equal(linkHistoricalSnapshot(row, [...matches, { ...matches[0], match_id: 'ambiguous' }], normalize).reason, 'ambiguous_fixture_identity');
});

test('legacy 1-X-2 aliases retain their source keys and conflicting duplicate prices are rejected', () => {
  const result = historicalSnapshotObservation(fixture({ selected_odds_json: JSON.stringify({ 1: 2, X: 3, 2: 4 }) }));
  assert.deepEqual(result.observation.quotes.map((quote) => quote.selection).sort(), ['awayWin', 'draw', 'homeWin']);
  assert.equal(result.observation.quotes.find((quote) => quote.side === 'home').sourceSelectionKey, '1');
  const conflicting = historicalSnapshotObservation(fixture({ selected_odds_json: JSON.stringify({ 1: 2, homeWin: 1.9, X: 3, 2: 4 }) }));
  assert.equal(conflicting.reason, 'complete_real_bookmaker_partition_missing');
});
