"""Plan six fixed C-only development windows using IDs and availability metadata.

No model, feature value, probability or match outcome is read to choose a boundary.
This local-file tool neither trains a model nor modifies operational A/A80.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import hashlib
import json
from pathlib import Path


PROTOCOL = "challenger-three-season-calendar-development-v1"
SPLIT_PROTOCOL = "purged-temporal-train-selection-calibration-test-v1"
SEASON_START_YEARS = (2023, 2024, 2025)
PARTS = ("train", "selection", "calibration", "test")
ROOT = Path(__file__).resolve().parents[1]


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("timestamp_requires_explicit_timezone")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp_requires_explicit_timezone")
    return parsed.astimezone(timezone.utc)


def iso(value):
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def month(year, number):
    return datetime(year, number, 1, tzinfo=timezone.utc)


def shift_months(value, count):
    index = value.year * 12 + value.month - 1 + count
    return month(index // 12, index % 12 + 1)


def json_hash(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")).hexdigest()


def ids_hash(rows):
    return hashlib.sha256("\n".join(sorted(row["matchId"] for row in rows)).encode("utf-8")).hexdigest()


def declared_season(value):
    text = str(value)
    if len(text) == 9 and text[4] in "/-" and text[:4].isdigit() and text[5:].isdigit():
        first, last = int(text[:4]), int(text[5:])
    elif len(text) == 7 and text[4] in "/-" and text[:4].isdigit() and text[5:].isdigit():
        first = int(text[:4]); last = first // 100 * 100 + int(text[5:])
    else:
        raise ValueError("invalid_declared_season")
    if last != first + 1:
        raise ValueError("invalid_declared_season")
    return f"{first}/{last}"


def repository_policies():
    quality = json.loads((ROOT / "src/research/challenger-data-quarantine.json").read_text(encoding="utf-8"))
    holdout = json.loads((ROOT / "src/research/original-holdout-policy.json").read_text(encoding="utf-8"))
    return quality, holdout


def checked_rows(dataset, quality, holdout):
    rows = dataset.get("rows")
    if not isinstance(rows, list) or not rows:
        raise ValueError("empty_season_plan_dataset")
    digest = json_hash(quality)
    evidence = dataset.get("dataQualityEvidence")
    if (dataset.get("dataQualityPolicy") != quality or dataset.get("dataQualityPolicyHash") != digest
            or json_hash(dataset.get("dataQualityPolicy")) != digest or dataset.get("dataQualityBaselineClean") is not True
            or not isinstance(evidence, dict) or evidence.get("policyHash") != digest
            or evidence.get("policyVersion") != quality["version"] or evidence.get("action") != quality["action"]):
        raise ValueError("season_plan_requires_authentic_clean_c_policy")
    timing = dataset.get("forecastTiming", {})
    if ("nightly" not in str(timing.get("policy", "")).lower() or timing.get("forecastBeforeKickoff") is not True
            or timing.get("resultDelayMs") != 7200000):
        raise ValueError("season_plan_requires_nightly_inputs")
    schedule = dataset.get("decisionSchedule", {})
    if (schedule.get("hour", 3) != 3 or schedule.get("minute", 7) != 7
            or schedule.get("timezone", "Europe/Rome") != "Europe/Rome"):
        raise ValueError("season_plan_requires_declared_0307_rome_schedule")
    as_of = timestamp(dataset["asOf"])
    protected = set(holdout["protectedOriginalFinalMatchIds"])
    quarantine = {entry["matchId"] for entry in quality["entries"]}
    seen = set()
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get("matchId"), str) or not row["matchId"] or row["matchId"] in seen:
            raise ValueError("invalid_or_duplicate_season_plan_match")
        seen.add(row["matchId"])
        if row["matchId"] in protected or row["matchId"] in quarantine:
            raise ValueError("protected_or_quarantined_season_plan_target")
        if row.get("dataQualityPolicyHash") != digest or row.get("dataQualityBaselineClean") is not True:
            raise ValueError("mixed_or_unclean_season_plan_rows")
        forecast, kickoff, available = (timestamp(row[key]) for key in ("forecastAt", "kickoffAt", "availableAt"))
        if forecast >= kickoff or available < kickoff + timedelta(hours=2) or available > as_of:
            raise ValueError("invalid_season_plan_availability")
        history_times = [row["modelFitAt"], row.get("maxTrainingAvailableAt"),
                         row.get("challengerFeatureMetadata", {}).get("maxHistoryAvailableAt")]
        if any(value is not None and timestamp(value) > forecast for value in history_times):
            raise ValueError("future_season_plan_feature_metadata")
        season = declared_season(row["season"])
        start_year = kickoff.year if kickoff.month >= 7 else kickoff.year - 1
        if season != f"{start_year}/{start_year + 1}":
            raise ValueError("season_plan_declared_season_date_mismatch")
    return sorted(rows, key=lambda row: (timestamp(row["forecastAt"]), row["matchId"]))


def interval(rows, start, end, next_start=None):
    inside = [row for row in rows if start <= timestamp(row["forecastAt"]) < end]
    purged = [row for row in inside if next_start is not None and timestamp(row["availableAt"]) >= next_start]
    purged_ids = {row["matchId"] for row in purged}
    used = [row for row in inside if row["matchId"] not in purged_ids]
    if not used:
        raise ValueError(f"empty_season_plan_interval: {iso(start)}..{iso(end)}")
    return {"n": len(used), "from": iso(start), "to": iso(end - timedelta(milliseconds=1)),
        "availableThrough": max((row["availableAt"] for row in used), key=timestamp),
        "matchIdsHash": ids_hash(used), "observedFrom": used[0]["forecastAt"], "observedTo": used[-1]["forecastAt"],
        "purgedUnavailableLabels": len(purged), "purgedMatchIds": sorted(purged_ids)}, used


def validate_windows(folds):
    previous_test_end = None
    for index, fold in enumerate(folds):
        split = fold["trainingSplit"]
        if fold["fold"] != index or split["protocol"] != SPLIT_PROTOCOL:
            raise ValueError("invalid_season_plan_fold_identity")
        for part in PARTS:
            window = split[part]
            if window["n"] <= 0 or timestamp(window["from"]) > timestamp(window["to"]):
                raise ValueError("invalid_season_plan_window")
        for earlier, later in zip(PARTS, PARTS[1:]):
            if (timestamp(split[earlier]["to"]) >= timestamp(split[later]["from"])
                    or timestamp(split[earlier]["availableThrough"]) >= timestamp(split[later]["from"])):
                raise ValueError("overlapping_or_leaky_season_plan_windows")
        if previous_test_end is not None and timestamp(split["test"]["from"]) <= previous_test_end:
            raise ValueError("overlapping_season_plan_test_windows")
        previous_test_end = timestamp(split["test"]["to"])


def source_audit(matches, eligible_ids, protected, quarantined, season):
    if not isinstance(matches, list):
        raise ValueError("source_matches_must_be_metadata_array")
    source = [row for row in matches if declared_season(row["season"]) == season]
    source_ids = [row["matchId"] for row in source]
    if len(source_ids) != len(set(source_ids)):
        raise ValueError("duplicate_source_season_match")
    if not eligible_ids <= set(source_ids):
        raise ValueError("eligible_season_target_missing_from_source")
    exclusions = {"protected_original_holdout": [], "quarantine_policy": [], "not_present_in_clean_dataset": []}
    for match_id in source_ids:
        if match_id in eligible_ids:
            continue
        reason = "quarantine_policy" if match_id in quarantined else "protected_original_holdout" if match_id in protected else "not_present_in_clean_dataset"
        exclusions[reason].append(match_id)
    return {"sourceRows": len(source), "eligibleRows": len(eligible_ids), "excludedRows": len(source) - len(eligible_ids),
        "sourceProtectedRows": len(set(source_ids) & protected), "sourceQuarantinedRows": len(set(source_ids) & quarantined),
        "protectedQuarantineOverlap": len(set(source_ids) & protected & quarantined),
        "exclusionCounts": {reason: len(ids) for reason, ids in exclusions.items()},
        "excludedMatchIds": {reason: sorted(ids) for reason, ids in exclusions.items()},
        "semantics": "source_season_metadata_counts_only_no_result_or_first_seen_inference"}


def build_plan(dataset, dataset_hash, matches=None, matches_hash=None):
    quality, holdout = repository_policies()
    rows = checked_rows(dataset, quality, holdout)
    folds, test_ids = [], []
    seasons = [f"{year}/{year + 1}" for year in SEASON_START_YEARS]
    target_rows = [row for row in rows if declared_season(row["season"]) in seasons]
    for year in SEASON_START_YEARS:
        season = f"{year}/{year + 1}"
        for start in (month(year, 7), month(year + 1, 1)):
            selection_start, calibration_start, end = shift_months(start, -4), shift_months(start, -2), shift_months(start, 6)
            definitions = ((month(2022, 7), selection_start, selection_start),
                           (selection_start, calibration_start, calibration_start),
                           (calibration_start, start, start), (start, end, None))
            split = {"protocol": SPLIT_PROTOCOL}
            for part, (lower, upper, boundary) in zip(PARTS, definitions):
                window, used = interval(rows, lower, upper, boundary)
                split[part] = window
                if part == "test":
                    if any(declared_season(row["season"]) != season for row in used):
                        raise ValueError("test_window_contains_other_season")
                    test_ids.extend(row["matchId"] for row in used)
            folds.append({"fold": len(folds), "season": season, "testBlock": "July-December" if start.month == 7 else "January-June",
                          "trainingSplit": split})
    validate_windows(folds)
    eligible_ids = {row["matchId"] for row in target_rows}
    if len(test_ids) != len(set(test_ids)) or set(test_ids) != eligible_ids:
        raise ValueError("season_plan_test_coverage_not_exactly_once")
    protected = set(holdout["protectedOriginalFinalMatchIds"])
    quarantine = {entry["matchId"] for entry in quality["entries"]}
    per_season = {}
    for season in seasons:
        eligible = [row for row in target_rows if declared_season(row["season"]) == season]
        summary = {"eligibleRows": len(eligible), "testRows": sum(fold["trainingSplit"]["test"]["n"] for fold in folds if fold["season"] == season),
                   "matchIdsHash": ids_hash(eligible), "protectedTargetsUsed": 0, "quarantinedTargetsUsed": 0}
        if matches is not None:
            summary["sourceAudit"] = source_audit(matches, {row["matchId"] for row in eligible}, protected, quarantine, season)
        per_season[season] = summary
    outside = Counter(declared_season(row["season"]) for row in rows if declared_season(row["season"]) not in seasons)
    source_exclusions = Counter()
    if matches is not None:
        for summary in per_season.values():
            source_exclusions.update(summary["sourceAudit"]["exclusionCounts"])
    return {"protocol": PROTOCOL, "developmentOnly": True, "independentEvidence": False, "productionPromotion": False,
        "currentC906Backdated": False, "operationalAModified": False, "baselineA80Modified": False,
        "datasetHash": dataset_hash, "sourceMatchesFileHash": matches_hash, "declaredSeasons": seasons,
        "evaluationPlan": {"asOf": dataset["asOf"], "developmentFrom": "2023-07-01T00:00:00.000Z",
            "developmentUntil": "2026-07-01T00:00:00.000Z", "independentFrom": iso(timestamp(dataset["asOf"]) + timedelta(milliseconds=1)),
            "schedule": {"hour": 3, "minute": 7}, "allowedMarkets": ["1x2", "totals", "asian_handicap"],
            "initialBankrollCents": 100000, "bootstrapSamples": 500, "seed": 20261031},
        "calendar": {"boundaryTimezone": "UTC", "decisionTimezone": "Europe/Rome", "membershipField": "forecastAt",
            "trainFrom": "2022-07-01T00:00:00.000Z", "testBlockMonths": 6, "selectionMonths": 2, "calibrationMonths": 2,
            "semantics": "fixed_calendar_bounds_not_chosen_from_predictions_features_or_observed_scores",
            "endpoints": "from_inclusive_to_inclusive_last_millisecond_before_next_calendar_bound"},
        "dataQualityPolicyHash": json_hash(quality), "dataQualityBaselineClean": True, "dataQualityEvidence": dataset["dataQualityEvidence"],
        "holdoutPolicyVersion": holdout["version"], "protectedOriginalCount": len(protected),
        "coverage": {"inputRows": len(rows), "eligibleTestRows": len(target_rows), "testRows": len(test_ids),
            "testCoverageExactlyOnce": True, "initialHistoryTestRows": 0, "protectedTargetsUsed": 0, "quarantinedTargetsUsed": 0,
            "sourceTargetRows": sum(summary["sourceAudit"]["sourceRows"] for summary in per_season.values()) if matches is not None else None,
            "sourceExclusionCounts": dict(sorted(source_exclusions.items())) if matches is not None else None,
            "outsideTargetSeasons": dict(sorted(outside.items())), "perSeason": per_season}, "folds": folds,
        "limitations": ["Development replay, not prospective adoption evidence or a backdated current C906.",
            "Calendar boundaries and as-of metadata do not prove historical source ingestion or price availability.",
            "The initial 2022/2023 season is warm-up; each initial fit also reserves separate selection and calibration windows.",
            "No football outcome, feature value or probability was used to choose these fixed calendar boundaries."]}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", required=True, help="Existing clean, Nightly C dataset JSON")
    parser.add_argument("--out", required=True, help="New split-plan JSON; existing files are never overwritten")
    parser.add_argument("--matches", help="Optional frozen match export for season eligibility/exclusion counts")
    options = parser.parse_args(argv)
    payload = Path(options.dataset).read_bytes()
    source = Path(options.matches).read_bytes() if options.matches else None
    plan = build_plan(json.loads(payload), hashlib.sha256(payload).hexdigest(),
        json.loads(source) if source is not None else None, hashlib.sha256(source).hexdigest() if source is not None else None)
    target = Path(options.out); target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(plan, stream, indent=2, ensure_ascii=False, allow_nan=False); stream.write("\n")
    print(json.dumps({"splitPlan": str(target), "folds": len(plan["folds"]), "testRows": plan["coverage"]["testRows"],
        "perSeason": {season: {"eligibleRows": summary["eligibleRows"],
            "exclusions": summary.get("sourceAudit", {}).get("exclusionCounts")} for season, summary in plan["coverage"]["perSeason"].items()},
                      "developmentOnly": True}, ensure_ascii=False))
    return plan


if __name__ == "__main__":
    main()
