-- Bind :cutoff to the preregistered analysis freeze (ISO UTC).
-- Bind :origin to a scope fixed before collection, e.g. direct_a; do not mix internal and A/C calls.
-- Bind :protocol_id explicitly: the registered protocol for prospective_a, NULL for other origins.
-- Strict temporal eligibility is checked AFTER choosing the first forecast.
-- Pick the first prediction in [kickoff-24h, kickoff-1h]; ties by immutable id.
-- A changed kickoff excludes a result instead of silently linking a postponed fixture.
WITH candidate AS (
 SELECT f.*, row_number() OVER (PARTITION BY match_id ORDER BY julianday(forecast_at), id) AS rank
 FROM model_a_prospective_forecasts f
 WHERE json_extract(f.payload_json,'$.origin') = :origin
   AND ((:origin='prospective_a' AND :protocol_id IS NOT NULL AND json_extract(f.payload_json,'$.collection.protocolId')=:protocol_id)
     OR (:origin<>'prospective_a' AND :protocol_id IS NULL))
   AND julianday(forecast_at) >= julianday(kickoff_at) - 1
   AND julianday(forecast_at) <= julianday(kickoff_at) - 1.0/24
   AND julianday(forecast_at) <= julianday(:cutoff)
), lifecycle AS (
 SELECT l.*, row_number() OVER (PARTITION BY match_id,julianday(kickoff_at)
   ORDER BY julianday(observed_at) DESC,julianday(recorded_at) DESC,evidence_id DESC) AS rank
 FROM model_a_prospective_result_observations l
 WHERE julianday(observed_at)<=julianday(:cutoff) AND julianday(recorded_at)<=julianday(:cutoff)
), outcome AS (
 SELECT r.*, row_number() OVER (PARTITION BY match_id, julianday(kickoff_at)
   ORDER BY julianday(observed_at) DESC, julianday(recorded_at) DESC, evidence_id DESC) AS rank
 FROM model_a_prospective_results r
 WHERE julianday(observed_at) <= julianday(:cutoff) AND julianday(recorded_at) <= julianday(:cutoff)
)
SELECT c.id, c.match_id, c.forecast_at, c.kickoff_at, c.payload_json,
       o.evidence_id, o.source, o.observed_at, o.recorded_at, o.home_goals, o.away_goals,
       1 AS temporal_eligible,'verified_input_availability_declared' AS temporal_eligibility_reason
FROM candidate c LEFT JOIN outcome o ON o.match_id=c.match_id AND julianday(o.kickoff_at)=julianday(c.kickoff_at)
  AND o.rank=1 AND julianday(o.observed_at)>julianday(c.kickoff_at)
  -- Fail closed when newer provider evidence no longer confirms this final.
  AND NOT EXISTS (SELECT 1 FROM lifecycle l WHERE l.match_id=c.match_id
    AND julianday(l.kickoff_at)=julianday(c.kickoff_at) AND l.rank=1
    AND (l.status<>'final' OR julianday(l.observed_at)>julianday(o.observed_at)))
WHERE c.rank=1
  AND json_extract(c.payload_json,'$.provenance.classification')='verified'
  AND json_type(c.payload_json,'$.provenance.rigorousEligible')='true'
  AND json_type(c.payload_json,'$.provenance.inputAvailableThrough')='text'
  AND (json_extract(c.payload_json,'$.provenance.inputAvailableThrough') GLOB '*Z'
    OR json_extract(c.payload_json,'$.provenance.inputAvailableThrough') GLOB '*[+-][0-9][0-9]:[0-9][0-9]')
  AND julianday(json_extract(c.payload_json,'$.provenance.inputAvailableThrough'))<=julianday(c.forecast_at)
  AND json_type(c.payload_json,'$.inputAsOf')='text'
  AND (json_extract(c.payload_json,'$.inputAsOf') GLOB '*Z'
    OR json_extract(c.payload_json,'$.inputAsOf') GLOB '*[+-][0-9][0-9]:[0-9][0-9]')
  AND julianday(json_extract(c.payload_json,'$.inputAsOf'))<=julianday(c.forecast_at)
  AND json_type(c.payload_json,'$.provenance.inputSnapshotHash')='text'
  AND length(json_extract(c.payload_json,'$.provenance.inputSnapshotHash'))=64
  AND json_extract(c.payload_json,'$.provenance.inputSnapshotHash') NOT GLOB '*[^0-9A-Fa-f]*'
  AND json_type(c.payload_json,'$.model.codeHash')='text'
  AND length(json_extract(c.payload_json,'$.model.codeHash'))=64
  AND json_extract(c.payload_json,'$.model.codeHash') NOT GLOB '*[^0-9A-Fa-f]*'
  AND json_type(c.payload_json,'$.model.configHash')='text'
  AND length(json_extract(c.payload_json,'$.model.configHash'))=64
  AND json_extract(c.payload_json,'$.model.configHash') NOT GLOB '*[^0-9A-Fa-f]*'
  AND json_type(c.payload_json,'$.model.stateHash')='text'
  AND length(json_extract(c.payload_json,'$.model.stateHash'))=64
  AND json_extract(c.payload_json,'$.model.stateHash') NOT GLOB '*[^0-9A-Fa-f]*';
