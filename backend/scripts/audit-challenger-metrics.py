#!/usr/bin/env python3
"""Independent, standard-library audit of saved C development predictions.

Run from the repository root (output directories must not already exist):
  python backend/scripts/audit-challenger-metrics.py --report REPORT --out NEW_DIR
  python backend/scripts/audit-challenger-metrics.py --bundle NEW_DIR --out REPLAY_DIR
Add --gzip to write deterministic predictions.jsonl.gz; hashes cover decoded JSONL.
Use --expected-records N --expected-cohort N for a revised strict dataset.
Use --generic only for noncanonical fixtures; it disables all canonical guards.
No model, TypeScript metric implementation, database, or network is executed.
"""
import argparse
from collections import Counter
from datetime import datetime, timedelta
import gzip
import hashlib
import io
import json
import math
from pathlib import Path

SCHEMA = "independent-challenger-metrics-audit-v1"
TOLERANCE = 1e-12
ARMS = ("no_ml", "development_current_replica", "intensity_legacy",
        "intensity_recent_xg", "intensity_schedule", "intensity_full")
CLASSES = ["homeWin", "draw", "awayWin"]
FIELDS = ("matchId", "competition", "season", "kickoffAt", "forecastAt", "availableAt",
          "homeGoals", "awayGoals", "phase", "admissibleQuoteCount", "predictionExclusions", "exclusion")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def deterministic_gzip(data):
    # Empty filename and fixed mtime omit local paths and clock-dependent headers.
    stream = io.BytesIO()
    with gzip.GzipFile(fileobj=stream, mode="wb", filename="", mtime=0, compresslevel=9) as writer:
        writer.write(data)
    return stream.getvalue()


def positive_int(value):
    try:
        parsed = int(value)
    except (ValueError, TypeError):
        raise argparse.ArgumentTypeError("expected a positive integer") from None
    if parsed <= 0:
        raise argparse.ArgumentTypeError("expected a positive integer")
    return parsed


def week(at):
    date = datetime.fromisoformat(at.replace("Z", "+00:00"))
    if date.utcoffset() is None or date.utcoffset().total_seconds() != 0:
        raise ValueError("forecastAt must have an explicit UTC offset")
    return (date.date() - timedelta(days=date.weekday())).isoformat()


def outcome(row):
    goals = [row["homeGoals"], row["awayGoals"]]
    if any(type(g) is not int or g < 0 for g in goals):
        raise ValueError("goals must be nonnegative integers")
    return 0 if goals[0] > goals[1] else 1 if goals[0] == goals[1] else 2


def probabilities(value):
    if not isinstance(value, list) or len(value) != 3 or any(
            type(p) not in (int, float) or not math.isfinite(p) or not 0 <= p <= 1 for p in value):
        raise ValueError("probabilities must be three finite numbers in [0, 1]")
    if abs(math.fsum(value) - 1) > TOLERANCE:
        raise ValueError("probabilities do not sum to one; never renormalized by audit")
    return value


def calculate(rows, variant):
    """Compute LL (clamp 1e-15), sum-3 Brier, top-label ECE and accuracy."""
    losses, briers, correct = [], [], []
    bins = [[] for _ in range(10)]
    selected = [r for r in rows if variant in r["predictions"]]
    for row in selected:
        p = probabilities(row["predictions"][variant]["probabilities"])
        y = outcome(row)
        confidence = max(p)
        hit = int(p.index(confidence) == y)  # First maximum: home, draw, away.
        losses.append(-math.log(max(1e-15, p[y])))
        briers.append(math.fsum((v - int(i == y)) ** 2 for i, v in enumerate(p)))
        correct.append(hit)
        bins[min(9, math.floor(confidence * 10))].append((confidence, hit))
    n = len(selected)
    calibration = []
    for index, bucket in enumerate(bins):
        size = len(bucket)
        calibration.append({"lower": index / 10, "upper": (index + 1) / 10, "n": size,
                            "predicted": math.fsum(x[0] for x in bucket) / size if size else None,
                            "observed": math.fsum(x[1] for x in bucket) / size if size else None})
    return {"n": n, "logLoss": math.fsum(losses) / n if n else None,
            "brier": math.fsum(briers) / n if n else None,
            "accuracy": math.fsum(correct) / n if n else None,
            "ece": math.fsum(b["n"] / n * abs(b["predicted"] - b["observed"])
                             for b in calibration if b["n"]) if n else None,
            "calibration": calibration,
            "leagues": sorted({r["competition"] for r in selected}),
            "periods": sorted({week(r["forecastAt"]) for r in selected})}


def compact(document):
    rows = []
    for record in document["records"]:
        row = {key: record[key] for key in FIELDS if key in record}
        row["predictions"] = {variant: {key: prediction[key] for key in
                                      ("probabilities", "probabilityStages", "modelVersion", "probabilityConfigurationHash",
                                       "calibrationFittedThrough", "matrixHash", "retrospective") if key in prediction}
                              for variant, prediction in record["predictions"].items()}
        rows.append(row)
    metadata = {key: document.get(key) for key in ("protocol", "plan", "coverage", "holdout", "metricDefinitions", "provenance")}
    metadata["variants"] = {variant: {key: value for key, value in spec.items() if key in
                                    ("role", "availability", "selectionPolicy", "pipelineSource", "byPhase", "foldArtifacts")}
                            for variant, spec in document["variants"].items()}
    # Economics are outside this audit and would unnecessarily enlarge the bundle.
    for spec in metadata["variants"].values():
        spec["byPhase"] = {phase: {"metrics": summary["metrics"]} for phase, summary in spec["byPhase"].items()}
    return metadata, rows


def source_evidence():
    source = Path(__file__).resolve().parents[1] / "src/research/ChallengerDevelopment.ts"
    if not source.is_file():
        return {"available": False, "finalProbabilityEvidence": False}
    data = source.read_bytes()
    text = data.decode("utf-8")
    expression = "return { probabilities: resultKeys.map((key) => pipeline.decision[key])"
    order = "const resultKeys = ['homeWin', 'draw', 'awayWin'];"
    return {"available": True, "file": "backend/src/research/ChallengerDevelopment.ts",
            "sha256": sha256(data), "finalProbabilityEvidence": expression in text and order in text,
            "expression": expression, "scope": "inspected_current_exporter_not_historical_execution_attestation"}


def audit(metadata, rows, canonical=True, expected_records=6587, expected_cohort=1975):
    if any(type(n) is not int or n <= 0 for n in (expected_records, expected_cohort)):
        raise ValueError("expected record and cohort counts must be positive integers")
    findings = []
    def check(condition, message):
        if not condition:
            findings.append(message)

    ids = [row["matchId"] for row in rows]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise ValueError("duplicate or invalid matchId in records")
    variants = metadata["variants"]
    for row in rows:
        outcome(row)
        week(row["forecastAt"])
        if set(row["predictions"]) - set(variants):
            raise ValueError("prediction references an undeclared variant")
        if set(row["predictions"]) & set(row.get("predictionExclusions", {})):
            raise ValueError("prediction is simultaneously excluded")
        for variant, prediction in row["predictions"].items():
            probabilities(prediction.get("probabilities"))
            if "probabilityStages" in prediction:
                stages = prediction["probabilityStages"]
                if not isinstance(stages, dict) or not {"raw", "calibrated", "decision"} <= set(stages):
                    raise ValueError("probabilityStages must include raw, calibrated and decision")
                for stage in ("raw", "calibrated", "decision"):
                    probabilities(stages[stage])
                check(stages["decision"] == prediction["probabilities"],
                      "final probability differs from decision stage: " + row["matchId"] + "." + variant)
    coverage = metadata.get("coverage") or {}
    check(coverage.get("inputMatches") == len(rows), "coverage.inputMatches differs from records")
    phases = dict(sorted(Counter(r["phase"] for r in rows).items()))
    for phase, count in (coverage.get("phases") or {}).items():
        check(phases.get(phase, 0) == count, "coverage phase mismatch: " + phase)
    results, max_delta = {}, 0.0
    def compare(actual, declared, at):
        nonlocal max_delta
        if isinstance(actual, (int, float)) and not isinstance(actual, bool):
            valid = type(declared) in (int, float) and math.isfinite(declared)
            delta = abs(actual - declared) if valid else None
            if delta is not None:
                max_delta = max(max_delta, delta)
            check(valid and delta <= TOLERANCE, "metric mismatch: " + at)
        else:
            check(actual == declared, "metric mismatch: " + at)
    for variant, spec in variants.items():
        predictions = [r["predictions"][variant] for r in rows if variant in r["predictions"]]
        summary = {"role": spec["role"], "availability": spec.get("availability"), "byPhase": {},
                   "predictionEvidence": {"n": len(predictions),
                       "withAllStages": sum("probabilityStages" in p for p in predictions),
                       "withModelVersion": sum("modelVersion" in p for p in predictions),
                       "withConfigurationHash": sum("probabilityConfigurationHash" in p for p in predictions)}}
        for phase, declared in spec["byPhase"].items():
            selected = [r for r in rows if r["phase"] == phase]
            computed = calculate(selected, variant)
            claims = declared["metrics"]
            for key in ("n", "logLoss", "brier", "ece", "leagues", "periods"):
                compare(computed[key], claims.get(key), variant + "." + phase + "." + key)
            if "accuracy" in claims:
                compare(computed["accuracy"], claims["accuracy"], variant + "." + phase + ".accuracy")
            bins = claims.get("calibration", [])
            check(len(bins) == 10, "missing calibration bins: " + variant + "." + phase)
            for index, (actual_bin, claimed_bin) in enumerate(zip(computed["calibration"], bins)):
                for key, value in actual_bin.items():
                    compare(value, claimed_bin.get(key), f"{variant}.{phase}.calibration[{index}].{key}")
            cohort = [r for r in selected if variant in r["predictions"]]
            summary["byPhase"][phase] = {"metrics": computed, "accuracyDeclared": "accuracy" in claims, "cohort": distribution(cohort),
                "excludedReasons": dict(sorted(Counter(r.get("predictionExclusions", {}).get(variant, "unexplained")
                                                       for r in selected if variant not in r["predictions"]).items()))}
        results[variant] = summary
    cohorts = {arm: {r["matchId"] for r in rows if arm in r["predictions"]} for arm in ARMS}
    same = all(cohorts[arm] == cohorts[ARMS[0]] for arm in ARMS)
    if canonical:
        check(len(rows) == expected_records, f"canonical input must contain {expected_records} records")
        check(all(arm in variants for arm in ARMS), "missing controlled arm")
        check(same and len(cohorts[ARMS[0]]) == expected_cohort,
              f"six arms must share exactly {expected_cohort} unique matchIds")
        for arm in ARMS:
            expected_role = "no_ml" if arm == "no_ml" else "ablation"
            check(variants.get(arm, {}).get("role") == expected_role, "incorrect controlled role: " + arm)
            check(variants.get(arm, {}).get("availability") == "retrospective_development", "incorrect availability: " + arm)
            check(all(r["phase"] == "development" for r in rows if arm in r["predictions"]), "controlled arm outside development: " + arm)
        for variant, count, role, availability in (("actual_C906", 0, "current", "recorded_available"),
                ("actual_C906_new_selector", 0, "current", "recorded_available"),
                ("C906_reconstructed", 10, "ablation", "retrospective_development"),
                ("C906_reconstructed_new_selector", 10, "ablation", "retrospective_development")):
            check(sum(variant in r["predictions"] for r in rows) == count, "incorrect C906 cohort: " + variant)
            check(variants.get(variant, {}).get("role") == role and variants.get(variant, {}).get("availability") == availability,
                  "incorrect C906 role/availability: " + variant)
        check(all(r["predictions"].get("C906_reconstructed", {}).get("probabilities") ==
                  r["predictions"].get("C906_reconstructed_new_selector", {}).get("probabilities") for r in rows),
              "reconstructed selector cohorts or probabilities differ")
    prediction_count = sum(len(r["predictions"]) for r in rows)
    stages_count = sum("probabilityStages" in p for r in rows for p in r["predictions"].values())
    return {"passed": not findings, "findings": findings, "recordDistribution": distribution(rows),
            "canonicalExpectedCounts": {"records": expected_records, "cohort": expected_cohort},
            "probabilityStageCoverage": {"predictions": prediction_count, "withAllStages": stages_count,
                                         "withoutStages": prediction_count - stages_count},
            "sixArmSameIds": same, "sixArmCounts": {arm: len(ids) for arm, ids in cohorts.items()},
            "maxAbsoluteDeclaredMetricDelta": max_delta, "variants": results}


def distribution(rows):
    ids = sorted(r["matchId"] for r in rows)
    return {"n": len(rows), "uniqueIds": len(set(ids)), "sortedIdsSha256": sha256(encode(ids)),
            "byOutcome": {CLASSES[i]: sum(outcome(r) == i for r in rows) for i in range(3)},
            **{key: dict(sorted(Counter(str(r.get(key, "missing")) for r in rows).items()))
               for key in ("competition", "season", "phase")},
            "forecastWeeks": dict(sorted(Counter(week(r["forecastAt"]) for r in rows).items())),
            "forecastFrom": min((r["forecastAt"] for r in rows), default=None),
            "forecastUntil": max((r["forecastAt"] for r in rows), default=None)}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    inputs = parser.add_mutually_exclusive_group(required=True)
    inputs.add_argument("--report", type=Path)
    inputs.add_argument("--bundle", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--generic", action="store_true")
    parser.add_argument("--gzip", action="store_true", help="write deterministic gzip predictions; hash decoded JSONL")
    parser.add_argument("--expected-records", type=positive_int, default=6587)
    parser.add_argument("--expected-cohort", type=positive_int, default=1975)
    args = parser.parse_args(argv)
    if args.out.exists():
        raise ValueError("output directory must be new")
    if args.report:
        data = args.report.read_bytes()
        metadata, rows = compact(json.loads(data))
        origin = {"reportSha256": sha256(data), "reportBytes": len(data), "exporterEvidence": source_evidence()}
    else:
        manifest = json.loads((args.bundle / "bundle.json").read_text(encoding="utf-8"))
        if manifest.get("schemaVersion") != SCHEMA:
            raise ValueError("unsupported bundle schema")
        filename = manifest.get("predictionsFile", "predictions.jsonl")
        if filename not in ("predictions.jsonl", "predictions.jsonl.gz"):
            raise ValueError("predictionsFile must be predictions.jsonl or predictions.jsonl.gz")
        data = (args.bundle / filename).read_bytes()
        if filename.endswith(".gz"):
            data = gzip.decompress(data)
        if sha256(data) != manifest["predictionsSha256"]:
            raise ValueError("compact prediction hash mismatch")
        metadata, origin = manifest["metadata"], manifest["origin"]
        rows = [json.loads(line) for line in data.splitlines()]
    result = audit(metadata, rows, canonical=not args.generic,
                   expected_records=args.expected_records, expected_cohort=args.expected_cohort)
    evidence = origin["exporterEvidence"]
    if not evidence.get("finalProbabilityEvidence"):
        result["findings"].append("exporter evidence for final decision probabilities unavailable")
        result["passed"] = False
    result.update({"schemaVersion": SCHEMA, "origin": origin, "canonicalChecks": not args.generic,
        "definitions": {"classOrder": CLASSES, "tieBreak": "first_maximum_home_then_draw_then_away",
            "logLoss": "mean(-ln(max(1e-15,p_observed)))", "brier": "mean(sum_3((p_i-1_i_observed)^2))",
            "ece": "top_label_10_equal_width_bins_floor(10*confidence)_capped_at_9_weighted_absolute_gap",
            "accuracy": "mean(argmax_first(probabilities)==observed_class)", "toleranceAbsolute": TOLERANCE,
            "aggregation": "Python_math.fsum_no_probability_renormalization", "week": "UTC_Monday"},
        "limitations": ["Checks arithmetic of exported final probabilities, not model fitting or source data correctness.",
            "Current exporter source identifies pipeline.decision; no historical execution attestation is inferred.",
            "Present raw/calibrated/decision vectors are validated and decision equals final probabilities exactly; missing stages are counted explicitly.",
            "Full score matrices are absent: probability transformation and model fitting cannot be independently replayed from these vectors.",
            "Accuracy is independently calculated and compared whenever the original report declares it.",
            "Development reconstructions are not independent prospective evidence or operational adoption.",
            "Bundle hashes detect byte changes against the manifest, not malicious replacement of both files."]})
    prediction_bytes = b"".join(encode(row) + b"\n" for row in rows)
    filename = "predictions.jsonl.gz" if args.gzip else "predictions.jsonl"
    output_bytes = deterministic_gzip(prediction_bytes) if args.gzip else prediction_bytes
    manifest = {"schemaVersion": SCHEMA, "predictionsFile": filename, "predictionsSha256": sha256(prediction_bytes),
                "predictionsBytes": len(prediction_bytes), "origin": origin, "metadata": metadata}
    result["compactPredictions"] = {"file": filename, "sha256": manifest["predictionsSha256"],
                                    "bytes": len(prediction_bytes), "records": len(rows)}
    args.out.mkdir(parents=True, exist_ok=False)
    (args.out / filename).write_bytes(output_bytes)
    (args.out / "bundle.json").write_bytes(encode(manifest) + b"\n")
    (args.out / "audit.json").write_text(json.dumps(result, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    print(json.dumps({"passed": result["passed"], "records": len(rows), "findings": result["findings"],
                      "predictionsSha256": manifest["predictionsSha256"]}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError, OSError, EOFError) as error:
        print(json.dumps({"passed": False, "error": str(error)}))
        raise SystemExit(2)
