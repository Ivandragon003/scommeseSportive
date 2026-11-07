const columns = ['match_id', 'home_team_id', 'away_team_id', 'home_team_name', 'away_team_name', 'date',
  'home_goals', 'away_goals', 'home_xg', 'away_xg', 'home_shots', 'away_shots', 'home_shots_on_target',
  'away_shots_on_target', 'home_possession', 'away_possession', 'home_fouls', 'away_fouls',
  'home_yellow_cards', 'away_yellow_cards', 'home_red_cards', 'away_red_cards', 'home_corners',
  'away_corners', 'referee', 'competition', 'season', 'source', 'source_match_id', 'created_at'];
function snapshot() {
  const matches = Array.from({ length: 90 }, (_, index) => Object.assign(Object.fromEntries(columns.map((column) => [column, null])), {
    match_id: `m-${index}`, home_team_id: `t-${index % 6}`, away_team_id: `t-${(index + 1) % 6}`,
    date: new Date(Date.UTC(2025, 7, index + 1, 12)).toISOString(), competition: 'Serie A', season: '2025/2026',
    home_goals: index % 4, away_goals: index % 3, home_xg: 0, away_xg: 1.1, source: 'test_synthetic',
  })).reverse();
  return {
    matches,
    odds_snapshots: [{ snapshot_id: 'simulated-test-only', match_id: 'm-20', source: 'simulated_test',
      selected_odds_json: '{"homeWin":2}', live_selected_odds_json: '{}', eurobet_odds_json: '{}',
      selected_bookmaker_key: 'simulation', selected_bookmaker_name: 'Simulation',
      used_fallback_bookmaker: 0, used_synthetic_odds: 1, captured_at: '2025-08-20T12:00:00Z',
      market_mapping_version: 'legacy-unverified-v1' }],
    runtime_calibration_profiles: [{ cache_key: 'legacy-incompatible', competition: 'serie a',
      payload_json: '{}', payload_sha256: 'invalid', created_at: '2025-08-01T00:00:00Z' }],
    model_params: [{ id: 1, params_json: '{"preserve":"saved-live-parameters"}' }],
  };
}
module.exports = { snapshot };
