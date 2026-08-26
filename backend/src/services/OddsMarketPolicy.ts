export const MATCH_EVENT_ADDITIONAL_MARKETS: string[] = [
  'h2h_3_way',
  'spreads',
  'alternate_totals',
  'alternate_spreads',
  'alternate_totals_cards',
  'alternate_spreads_cards',
  'team_totals',
  'alternate_team_totals',
  'btts',
  'double_chance',
  'draw_no_bet',
  'player_shots',
  'player_shots_on_target',
  'player_goal_scorer_anytime',
  'alternate_totals_corners',
  'alternate_spreads_corners',
  'alternate_team_totals_corners',
  'corners_1x2',
];

export const hasCurrentMatchMarketCoverage = (markets: unknown): boolean => {
  if (!Array.isArray(markets)) return false;
  const requested = new Set(markets.map((market) => String(market).trim()).filter(Boolean));
  return MATCH_EVENT_ADDITIONAL_MARKETS.every((market) => requested.has(market))
    && !requested.has('correct_score');
};
