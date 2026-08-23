-- Stable catalog for the transition audit. This is metadata only and does not
-- enable any model adjustment.
INSERT INTO secondary_competitions (competition_id, name, country, tier, cluster_key, is_active)
VALUES
  ('serie_b', 'Serie B', 'Italy', 2, 'second_division_big5', 1),
  ('championship', 'Championship', 'England', 2, 'second_division_big5', 1),
  ('2_bundesliga', '2. Bundesliga', 'Germany', 2, 'second_division_big5', 1),
  ('ligue_2', 'Ligue 2', 'France', 2, 'second_division_big5', 1),
  ('segunda_division', 'Segunda Division', 'Spain', 2, 'second_division_big5', 1)
ON CONFLICT(competition_id) DO UPDATE SET
  name = excluded.name,
  country = excluded.country,
  tier = excluded.tier,
  cluster_key = excluded.cluster_key,
  is_active = excluded.is_active;
