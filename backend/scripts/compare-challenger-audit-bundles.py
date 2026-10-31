#!/usr/bin/env python3
"""Compare C procedures on the same fixtures and forecast times.

The default requires every updated test to belong to the original test.
Use --common-only explicitly for different test periods: calculate deltas only
on their fixture and variant intersection, disclosing all cohort IDs/hashes.
Actual/reconstructed C906 reference series are excluded from candidate IDs.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
from pathlib import Path

spec = importlib.util.spec_from_file_location("independent_c_metrics", Path(__file__).with_name("audit-challenger-metrics.py"))
metrics = importlib.util.module_from_spec(spec)
spec.loader.exec_module(metrics)
REFERENCE_VARIANTS = {"actual_C906", "actual_C906_new_selector", "C906_reconstructed", "C906_reconstructed_new_selector"}


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


def compare(before, after, common_only=False):
    before_by_id = {row["matchId"]: row for row in before}
    if len(before_by_id) != len(before) or len({row["matchId"] for row in after}) != len(after):
        raise ValueError("duplicate fixture")
    if common_only:
        return compare_intersection(before, after)
    return paired_metrics_report(before, after, metrics.ARMS)


def paired_metrics_report(before, after, variants):
    before_by_id = {row["matchId"]: row for row in before}
    results = {}
    cohorts = []
    for arm in variants:
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


def compare_intersection(before, after):
    def scored_variants(rows):
        return {variant for row in rows for variant in row["predictions"]} - REFERENCE_VARIANTS

    def controlled_ids(rows, side):
        cohorts = [{row["matchId"] for row in rows if arm in row["predictions"]} for arm in metrics.ARMS]
        if any(cohort != cohorts[0] for cohort in cohorts[1:]):
            raise ValueError(f"six controlled arms must share the same test fixtures in {side}")
        for variant in scored_variants(rows) - set(metrics.ARMS):
            diagnostic_ids = {row["matchId"] for row in rows if variant in row["predictions"]}
            if diagnostic_ids != cohorts[0]:
                raise ValueError(f"variant must share the controlled test fixtures in {side}: {variant}")
        return cohorts[0]

    before_ids, after_ids = controlled_ids(before, "before"), controlled_ids(after, "after")
    before_variants, after_variants = scored_variants(before), scored_variants(after)
    shared_variants = sorted(before_variants & after_variants)
    shared = before_ids & after_ids
    if not shared:
        raise ValueError("no paired test fixtures in the intersection")
    # Reuse the strict pairing checks on the shared fixtures only. Neither full
    # population contributes to the metric differences returned below.
    report = paired_metrics_report([row for row in before if row["matchId"] in shared],
                                   [row for row in after if row["matchId"] in shared], shared_variants)
    old_only, new_only = before_ids - shared, after_ids - shared
    def coverage(ids):
        ordered = sorted(ids)
        return {"n": len(ordered), "ids": ordered, "idsSha256": metrics.sha256(metrics.encode(ordered))}

    report.update({"comparisonMode": "common_intersection_only", "cohortCoverage": {
        "before": coverage(before_ids), "after": coverage(after_ids), "shared": coverage(shared),
        "beforeOnly": coverage(old_only), "afterOnly": coverage(new_only)},
        "interpretation": "Retrospective comparison on identical shared fixtures only; unpaired fixtures are excluded from all deltas. Never independent prospective evidence."})
    report.update({"beforeVariantIds": sorted(before_variants), "afterVariantIds": sorted(after_variants),
                   "comparedVariantIds": shared_variants,
                   "beforeOnlyVariants": sorted(before_variants - after_variants),
                   "afterOnlyVariants": sorted(after_variants - before_variants)})
    for variant in report["variants"].values():
        variant["removedOriginalTestIds"] = sorted(old_only)
        variant["addedUpdatedTestIds"] = sorted(new_only)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--before", required=True, type=Path)
    parser.add_argument("--after", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--common-only", action="store_true", help="compare only the intersection; disclose all cohort IDs")
    args = parser.parse_args(argv)
    before_manifest, before = load_bundle(args.before)
    after_manifest, after = load_bundle(args.after)
    report = compare(before, after, common_only=args.common_only)
    report["predictionsSha256"] = {"before": before_manifest["predictionsSha256"], "after": after_manifest["predictionsSha256"]}
    with args.out.open("x", encoding="utf-8") as output:
        json.dump(report, output, indent=2, ensure_ascii=False, allow_nan=False)
        output.write("\n")
    print(json.dumps({"cohortMatches": report["cohortMatches"], "sameFixturesAndConditions": True}))


if __name__ == "__main__":
    main()
