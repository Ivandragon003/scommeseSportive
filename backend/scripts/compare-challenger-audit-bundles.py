#!/usr/bin/env python3
"""Compare C procedures on exactly the same retained fixtures and forecast times."""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("independent_c_metrics", Path(__file__).with_name("audit-challenger-metrics.py"))
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)


def load_bundle(directory):
    manifest = json.loads((directory / "bundle.json").read_text(encoding="utf-8"))
    filename = manifest.get("predictionsFile", "predictions.jsonl")
    if filename not in ("predictions.jsonl", "predictions.jsonl.gz"):
        raise ValueError("unsupported predictions file")
    data = (directory / filename).read_bytes()
    if filename.endswith(".gz"):
        data = gzip.decompress(data)
    if hashlib.sha256(data).hexdigest() != manifest["predictionsSha256"]:
        raise ValueError("bundle prediction hash mismatch")
    return manifest, [json.loads(line) for line in data.splitlines()]


def compare(before, after):
    before_by_id = {row["matchId"]: row for row in before}
    if len(before_by_id) != len(before) or len({row["matchId"] for row in after}) != len(after):
        raise ValueError("duplicate fixture")
    results = {}
    cohorts = []
    for arm in metrics.ARMS:
        retained = [row for row in after if arm in row["predictions"]]
        for row in retained:
            old = before_by_id.get(row["matchId"])
            if not old or arm not in old["predictions"]:
                raise ValueError("updated test must be a subset of the original test")
            if any(old[key] != row[key] for key in ("competition", "kickoffAt", "forecastAt", "homeGoals", "awayGoals", "phase")):
                raise ValueError("paired fixture, label or decision conditions changed")
        ids = {row["matchId"] for row in retained}
        if not ids:
            raise ValueError("no paired test fixtures")
        cohorts.append(ids)
        old_rows = [row for row in before if row["matchId"] in ids]
        previous, updated = metrics.calculate(old_rows, arm), metrics.calculate(retained, arm)
        original_ids = {row["matchId"] for row in before if arm in row["predictions"]}
        results[arm] = {"n": len(ids), "beforeOnSameFixtures": previous, "afterOnSameFixtures": updated,
                        "deltaDirection": "after_minus_before",
                        "delta": {key: updated[key] - previous[key] for key in ("logLoss", "brier", "ece", "accuracy")},
                        "removedOriginalTestIds": sorted(original_ids - ids),
                        "pairedIdsSha256": metrics.sha256(metrics.encode(sorted(ids)))}
    if any(cohort != cohorts[0] for cohort in cohorts[1:]):
        raise ValueError("six controlled arms must share the same paired test fixtures")
    return {"schemaVersion": "independent-c-before-after-common-cohort-v1", "sameFixturesAndConditions": True,
            "cohortMatches": len(cohorts[0]), "variants": results, "independentProspectiveEvidence": False,
            "interpretation": "Development data-pipeline correction; never an independent performance certificate."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", required=True, type=Path)
    parser.add_argument("--after", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    before_manifest, before = load_bundle(args.before)
    after_manifest, after = load_bundle(args.after)
    report = compare(before, after)
    report["predictionsSha256"] = {"before": before_manifest["predictionsSha256"], "after": after_manifest["predictionsSha256"]}
    with args.out.open("x", encoding="utf-8") as output:
        json.dump(report, output, indent=2, ensure_ascii=False, allow_nan=False)
        output.write("\n")
    print(json.dumps({"cohortMatches": report["cohortMatches"], "sameFixturesAndConditions": True}))


if __name__ == "__main__":
    main()
