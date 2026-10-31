#!/usr/bin/env python3
"""Summarize the three-season C backtest with independent standard-library metrics.

python backend/scripts/summarize-challenger-seasons.py --before OLD_BUNDLE --after NEW_BUNDLE --out NEW_FILE.json

The new bundle must score the six controlled arms and c906_recipe_retrained on
identical fixtures. C906 reference series are not candidates. Outputs contain
full-cohort/season/league metrics and paired comparisons on shared fixtures only.
Intervals resample UTC Monday weeks (500 draws, seed 20261031); they do not
account for configuration selection, repeated inspection or historical-data bias.
No model, provider, database or TypeScript code is executed.
"""
import argparse
from collections import defaultdict
import importlib.util
import json
import math
from pathlib import Path
import random

COMPARISON_PATH = Path(__file__).with_name("compare-challenger-audit-bundles.py")
SPEC = importlib.util.spec_from_file_location("season_comparison", COMPARISON_PATH)
comparison = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(comparison)
metrics = comparison.metrics
VARIANTS = (*metrics.ARMS, "c906_recipe_retrained")
METRIC_KEYS = ("n", "logLoss", "brier", "ece", "accuracy")
CONDITIONS = ("competition", "kickoffAt", "forecastAt", "homeGoals", "awayGoals", "phase")
SAMPLES = 500
SEED = 20261031


def compact_metrics(rows, variant):
    calculated = metrics.calculate(rows, variant)
    return {key: calculated[key] for key in METRIC_KEYS}


def paired_rows(left, right):
    left_by_id, right_by_id = ({row["matchId"]: row for row in rows} for rows in (left, right))
    if len(left_by_id) != len(left) or len(right_by_id) != len(right):
        raise ValueError("duplicate paired fixture")
    if not left_by_id or left_by_id.keys() != right_by_id.keys():
        raise ValueError("paired cohorts must have identical nonempty IDs")
    pairs = []
    for match_id in sorted(left_by_id):
        a, b = left_by_id[match_id], right_by_id[match_id]
        if any(a[key] != b[key] for key in CONDITIONS):
            raise ValueError("paired fixture, label or decision conditions changed: " + match_id)
        pairs.append((a, b))
    return pairs


def row_losses(row, variant):
    p = metrics.probabilities(row["predictions"][variant]["probabilities"])
    y = metrics.outcome(row)
    return (-math.log(max(1e-15, p[y])), math.fsum((v - int(index == y)) ** 2 for index, v in enumerate(p)))


def paired_week_interval(left, right, left_variant, right_variant, samples=SAMPLES, seed=SEED):
    """Draw K complete week blocks with replacement; weight by sampled row count."""
    if type(samples) is not int or samples < 2:
        raise ValueError("bootstrap requires at least two draws")
    groups = defaultdict(list)
    for a, b in paired_rows(left, right):
        old, new = row_losses(a, left_variant), row_losses(b, right_variant)
        groups[metrics.week(a["forecastAt"])].append((new[0] - old[0], new[1] - old[1]))
    blocks = [(len(group), math.fsum(v[0] for v in group), math.fsum(v[1] for v in group))
              for _, group in sorted(groups.items())]
    n = sum(block[0] for block in blocks)
    point = {"logLoss": math.fsum(block[1] for block in blocks) / n,
             "brier": math.fsum(block[2] for block in blocks) / n}
    lower, upper = math.floor(.025 * (samples - 1)), math.ceil(.975 * (samples - 1))
    result = {"method": "paired_week_block_bootstrap", "week": "UTC_Monday", "samples": samples,
              "seed": seed, "blocks": len(blocks), "n": n, "deltaDirection": "right_minus_left",
              "pointEstimate": point, "quantileIndices": [lower, upper], "logLoss95": None, "brier95": None}
    if len(blocks) < 2:
        result["limitation"] = "fewer_than_two_observed_week_blocks"
        return result
    rng = random.Random(seed)
    losses, briers = [], []
    for _ in range(samples):
        draw = [blocks[rng.randrange(len(blocks))] for _ in blocks]
        denominator = sum(block[0] for block in draw)
        losses.append(math.fsum(block[1] for block in draw) / denominator)
        briers.append(math.fsum(block[2] for block in draw) / denominator)
    for key, values in (("logLoss95", losses), ("brier95", briers)):
        values.sort()
        result[key] = [values[lower], values[upper]]
    return result


def unchanged_raw_baseline(before, after):
    max_difference = 0.0
    count = 0
    for old, new in paired_rows(before, after):
        vectors = []
        for row in (old, new):
            stages = row["predictions"]["no_ml"].get("probabilityStages", {})
            if "raw" not in stages:
                raise ValueError("no_ml raw baseline evidence missing: " + row["matchId"])
            vectors.append(metrics.probabilities(stages["raw"]))
        max_difference = max(max_difference, *(abs(a - b) for a, b in zip(*vectors)))
        count += 1
    if max_difference > 1e-12:
        raise ValueError(f"no_ml raw baseline changed on paired fixtures: max difference {max_difference}")
    return {"n": count, "maxAbsoluteDifference": max_difference, "exactlyEqual": max_difference == 0,
            "toleranceAbsolute": 1e-12, "stage": "no_ml.probabilityStages.raw"}


def summarize(before, after):
    paired = comparison.compare(before, after, common_only=True)
    if set(paired["beforeVariantIds"]) != set(metrics.ARMS) or set(paired["afterVariantIds"]) != set(VARIANTS):
        raise ValueError("expected six old controlled arms and seven new arms including c906_recipe_retrained")
    # compare(common_only=True) also checks every diagnostic's full cohort and
    # exact shared forecast/kickoff/competition/outcome/phase conditions.
    shared = set(paired["cohortCoverage"]["shared"]["ids"])
    old_rows = [row for row in before if row["matchId"] in shared]
    new_rows = [row for row in after if row["matchId"] in shared]
    raw = unchanged_raw_baseline(old_rows, new_rows)
    full = [row for row in after if "no_ml" in row["predictions"]]
    seasons, leagues = sorted({row["season"] for row in full}), sorted({row["competition"] for row in full})
    variants = {}
    for variant in VARIANTS:
        variants[variant] = {"fullCohort": compact_metrics(full, variant),
            "bySeason": {season: compact_metrics([row for row in full if row["season"] == season], variant) for season in seasons},
            "byLeague": {league: compact_metrics([row for row in full if row["competition"] == league], variant) for league in leagues}}
    common = {}
    for variant in metrics.ARMS:
        value = paired["variants"][variant]
        common[variant] = {"n": value["n"],
            "beforeOnSameFixtures": {key: value["beforeOnSameFixtures"][key] for key in METRIC_KEYS},
            "afterOnSameFixtures": {key: value["afterOnSameFixtures"][key] for key in METRIC_KEYS},
            "deltaDirection": "after_minus_before", "delta": value["delta"],
            "pairedWeekInterval": paired_week_interval(old_rows, new_rows, variant, variant)}
    within = []
    for left, right in (("development_current_replica", "intensity_recent_xg"),
                        ("development_current_replica", "intensity_full"),
                        ("development_current_replica", "c906_recipe_retrained"),
                        ("no_ml", "development_current_replica")):
        a, b = variants[left]["fullCohort"], variants[right]["fullCohort"]
        within.append({"left": left, "right": right, "n": len(full), "deltaDirection": "right_minus_left",
            "delta": {key: b[key] - a[key] for key in METRIC_KEYS if key != "n"},
            "pairedWeekInterval": paired_week_interval(full, full, left, right)})
    return {"schemaVersion": "independent-c-three-season-summary-v1", "retrospectiveOnly": True,
        "independentProspectiveEvidence": False, "productionPromotion": False,
        "definitions": {"classOrder": metrics.CLASSES, "tieBreak": "first_maximum_home_then_draw_then_away",
            "logLoss": "mean(-ln(max(1e-15,p_observed)))", "brier": "mean_sum_of_three_squared_errors",
            "ece": "top_label_10_equal_width_bins", "accuracy": "fraction_first_argmax_correct",
            "confidenceIntervals": "random.Random_seed20261031_500_week_block_draws_row_weighted_mean",
            "quantiles": "sorted_floor(.025*(samples-1))_ceil(.975*(samples-1))",
            "calibrationBins": "computed_by_independent_metrics_calculate_omitted_from_compact_summary"},
        "cohortCoverage": {key: {"n": value["n"], "idsSha256": value["idsSha256"]}
                           for key, value in paired["cohortCoverage"].items()},
        "beforeVariantIds": paired["beforeVariantIds"], "afterVariantIds": paired["afterVariantIds"],
        "comparedVariantIds": paired["comparedVariantIds"], "beforeOnlyVariants": paired["beforeOnlyVariants"],
        "afterOnlyVariants": paired["afterOnlyVariants"], "rawBaselineOnCommonFixtures": raw,
        "newFullCohort": {"n": len(full), "seasons": seasons, "leagues": leagues, "variants": variants},
        "commonBeforeAfter": common, "newFullCohortComparisons": within,
        "limitations": ["Retrospective development comparison; not independent prospective evidence or an operational adoption.",
            "Week resampling models within-week dependence, not configuration selection, repeated inspection or source/calendar bias.",
            "The before/after deltas use identical shared fixtures only; full cohorts have different coverage and are not subtracted.",
            "The no-ML raw baseline is checked separately from calibration; final probabilities may change with the fitted calibrator.",
            "Published vectors cannot independently prove model fitting or the historical first availability of features.",
            "c906_recipe_retrained is a diagnostic refit, not the operational frozen C906 model.",
            "No admissible contemporary bookmaker prices are supplied: no ROI, profit or drawdown conclusion."]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--before", required=True, type=Path)
    parser.add_argument("--after", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args(argv)
    if args.out.exists():
        raise ValueError("output must be new")
    before_manifest, before = comparison.load_bundle(args.before)
    after_manifest, after = comparison.load_bundle(args.after)
    report = summarize(before, after)
    report["provenance"] = {"predictionsSha256": {"before": before_manifest["predictionsSha256"],
                           "after": after_manifest["predictionsSha256"]},
        "bundleSha256": {"before": metrics.sha256((args.before / "bundle.json").read_bytes()),
                         "after": metrics.sha256((args.after / "bundle.json").read_bytes())},
        "sourceSha256": {name: metrics.sha256(Path(__file__).with_name(name).read_bytes()) for name in
                         ("summarize-challenger-seasons.py", "audit-challenger-metrics.py", "compare-challenger-audit-bundles.py")}}
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2, allow_nan=False)
        stream.write("\n")
    print(json.dumps({"retrospectiveOnly": True, "newCohort": report["newFullCohort"]["n"],
                      "commonCohort": report["cohortCoverage"]["shared"]["n"],
                      "rawBaselineMaxDifference": report["rawBaselineOnCommonFixtures"]["maxAbsoluteDifference"]}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ValueError, KeyError, TypeError, OSError, EOFError) as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(2)
