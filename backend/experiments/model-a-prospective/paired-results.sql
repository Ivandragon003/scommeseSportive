-- Bind :cutoff to the preregistered analysis freeze (ISO UTC).
-- Bind :origin to a scope fixed before collection, e.g. direct_a; do not mix internal and A/C calls.
-- Pick the first prediction in [kickoff-24h, kickoff-1h]; ties by immutable id.
-- A changed kickoff excludes a result instead of silently linking a postponed fixture.
WITH candidate AS (
 SELECT f.*, row_number() OVER (PARTITION BY match_id ORDER BY julianday(forecast_at), id) AS rank
 FROM model_a_prospective_forecasts f
 WHERE json_extract(f.payload_json,'$.origin') = :origin
   AND julianday(forecast_at) >= julianday(kickoff_at) - 1
   AND julianday(forecast_at) <= julianday(kickoff_at) - 1.0/24
   AND julianday(forecast_at) <= julianday(:cutoff)
), outcome AS (
 SELECT r.*, row_number() OVER (PARTITION BY match_id, kickoff_at
   ORDER BY julianday(observed_at) DESC, julianday(recorded_at) DESC, evidence_id DESC) AS rank
 FROM model_a_prospective_results r
 WHERE julianday(observed_at) <= julianday(:cutoff) AND julianday(recorded_at) <= julianday(:cutoff)
)
SELECT c.id, c.match_id, c.forecast_at, c.kickoff_at, c.payload_json,
       o.evidence_id, o.source, o.observed_at, o.recorded_at, o.home_goals, o.away_goals
FROM candidate c LEFT JOIN outcome o ON o.match_id=c.match_id AND julianday(o.kickoff_at)=julianday(c.kickoff_at)
  AND o.rank=1 AND julianday(o.observed_at)>julianday(c.kickoff_at)
WHERE c.rank=1;
