-- Technical evidence only: this export NEVER certifies temporal eligibility.
-- Bind :cutoff (ISO UTC), :origin and :protocol_id explicitly.
-- prospective_a requires its registered protocol; other origins require NULL.
WITH candidate AS (
 SELECT f.*, row_number() OVER (PARTITION BY match_id ORDER BY julianday(forecast_at), id) AS rank
 FROM model_a_prospective_forecasts f
 WHERE json_extract(f.payload_json,'$.origin')=:origin
   AND ((:origin='prospective_a' AND :protocol_id IS NOT NULL AND json_extract(f.payload_json,'$.collection.protocolId')=:protocol_id)
     OR (:origin<>'prospective_a' AND :protocol_id IS NULL))
   AND julianday(forecast_at)>=julianday(kickoff_at)-1
   AND julianday(forecast_at)<=julianday(kickoff_at)-1.0/24
   AND julianday(forecast_at)<=julianday(:cutoff)
), lifecycle AS (
 SELECT l.*, row_number() OVER (PARTITION BY match_id,julianday(kickoff_at)
   ORDER BY julianday(observed_at) DESC,julianday(recorded_at) DESC,evidence_id DESC) AS rank
 FROM model_a_prospective_result_observations l
 WHERE julianday(observed_at)<=julianday(:cutoff) AND julianday(recorded_at)<=julianday(:cutoff)
), outcome AS (
 SELECT r.*, row_number() OVER (PARTITION BY match_id,julianday(kickoff_at)
   ORDER BY julianday(observed_at) DESC,julianday(recorded_at) DESC,evidence_id DESC) AS rank
 FROM model_a_prospective_results r
 WHERE julianday(observed_at)<=julianday(:cutoff) AND julianday(recorded_at)<=julianday(:cutoff)
)
SELECT c.id,c.match_id,c.forecast_at,c.kickoff_at,c.payload_json,
       o.evidence_id,o.source,o.observed_at,o.recorded_at,o.home_goals,o.away_goals,
       0 AS temporal_eligible,'technical_export_does_not_establish_temporal_eligibility' AS temporal_eligibility_reason
FROM candidate c LEFT JOIN outcome o ON o.match_id=c.match_id AND julianday(o.kickoff_at)=julianday(c.kickoff_at)
  AND o.rank=1 AND julianday(o.observed_at)>julianday(c.kickoff_at)
  AND NOT EXISTS (SELECT 1 FROM lifecycle l WHERE l.match_id=c.match_id
    AND julianday(l.kickoff_at)=julianday(c.kickoff_at) AND l.rank=1
    AND (l.status<>'final' OR julianday(l.observed_at)>julianday(o.observed_at)))
WHERE c.rank=1;
