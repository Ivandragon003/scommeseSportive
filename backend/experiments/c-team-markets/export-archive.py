"""Export only football/forecast evidence from an immutable local backup, read-only."""
import argparse
import hashlib
import json
import sqlite3
from pathlib import Path


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def project(value, names):
    return {name: value[name] for name in names if name in value} if isinstance(value, dict) else None


def export(database, manifest_path, output):
    database, manifest_path, output = map(Path, (database, manifest_path, output))
    if output.exists():
        raise ValueError("Output already exists")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    before = sha(database)
    if not manifest.get("complete") or before != manifest["verification"]["databaseSha256"]:
        raise ValueError("Verified backup manifest required")
    connection = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only=ON")
    records = []
    try:
        rows = connection.execute("""
          SELECT i.id,i.snapshot_json,i.captured_at,j.match_id,j.kickoff_at,m.competition,
            m.home_goals,m.away_goals,m.home_shots,m.away_shots,
            m.home_shots_on_target,m.away_shots_on_target,
            m.home_yellow_cards,m.away_yellow_cards,m.home_red_cards,m.away_red_cards
          FROM research_execution_inputs i JOIN research_execution_jobs j ON j.id=i.job_id
          JOIN matches m ON m.match_id=j.match_id ORDER BY i.captured_at,i.id
        """)
        quote_keys = "market selection side line team odds bookmaker source priceType capturedAt updatedAt timestampEvidence usedSyntheticOdds used_synthetic_odds providerMarketKey originalProviderMarketKey providerSemanticsVerified".split()
        c_keys = "family modelVersion validated action reason probabilityProtocol calibrationPipelineHash probabilityConfiguration probabilityConfigurationHash calibrationAvailableAt prospectiveMatrix probabilityStages dataQualityPolicyHash dataQualityBaselineClean dataQualityEvidence challengerQuality prudentialSamplesAvailable forecastAt".split()
        for row in rows:
            snapshot = json.loads(row["snapshot_json"])
            forecasts = snapshot.get("forecasts") or {}
            a = project(forecasts.get("A"), "policyVersion selected ranked decisionStatus asOf model odds probabilities".split())
            c = project((forecasts.get("C") or {}).get("decision"), c_keys)
            quotes = [project(q, quote_keys) for q in (snapshot.get("quoteSnapshots") or {}).get("A", []) if isinstance(q, dict)]
            stats = {name: row[name] for name in row.keys() if name.startswith("home_") or name.startswith("away_")}
            records.append({"id": row["id"], "matchId": row["match_id"], "kickoffAt": row["kickoff_at"],
                            "competition": row["competition"], "homeGoals": row["home_goals"], "awayGoals": row["away_goals"],
                            "stats": stats, "snapshot": {"observedAt": snapshot.get("observedAt") or row["captured_at"],
                              "quoteSnapshots": {"A": quotes}, "forecasts": {"A": a, "C": {"decision": c}}},
                            "baselineInput": (snapshot.get("metadata") or {}).get("forecast")})
    finally:
        connection.close()
    after = sha(database)
    if after != before:
        raise ValueError("Backup changed during export")
    result = {"format": "c-team-archive-input-v1", "source": {
      "database": str(database), "databaseSha256": before, "databaseSha256After": after,
      "manifest": str(manifest_path), "manifestSha256": sha(manifest_path),
      "snapshotStartedAt": manifest["startedAt"], "snapshotCompletedAt": manifest["completedAt"],
      "mode": "SQLite mode=ro; query_only=ON; no production or provider calls"}, "records": records}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"records": len(records), "fixtures": len({r["matchId"] for r in records}),
                      "databaseUnchanged": before == after, "outputSha256": sha(output)}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    export(args.database, args.manifest, args.out)
