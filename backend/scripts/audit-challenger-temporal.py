"""Read-only, independent computational temporal audit of a frozen C development corpus.

Example: python backend/scripts/audit-challenger-temporal.py --input-dir DIR --out NEW.json
The output contains relative paths and hashes, never model payloads or absolute workspace paths.
Passing establishes consistency on the supplied time axis, not that archived kickoff times were correct.
"""
from __future__ import annotations
import argparse
from bisect import bisect_right
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
import hashlib
import json
import math
import os
from pathlib import Path
from zoneinfo import ZoneInfo

REPO = Path(__file__).resolve().parents[2]


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def ts(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timezone_missing")
    return parsed.timestamp()


def iso(value):
    return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")


def boundary(kickoff, hour=3, minute=7):
    rome = ZoneInfo("Europe/Rome")
    local = datetime.fromtimestamp(kickoff, timezone.utc).astimezone(rome)
    options = set()
    for days in range(3):
        date = local - timedelta(days=days)
        nominal = datetime(date.year, date.month, date.day, hour, minute)
        for fold in (0, 1):
            utc = nominal.replace(tzinfo=rome, fold=fold).astimezone(timezone.utc)
            if utc.astimezone(rome).replace(tzinfo=None) == nominal and utc.timestamp() < kickoff:
                options.add(utc.timestamp())
    return max(options)


def idhash(rows):
    return hashlib.sha256("\n".join(sorted(row["matchId"] for row in rows)).encode()).hexdigest()


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def completed(row):
    return all(finite(row.get(key)) and row[key] >= 0 and row[key] == int(row[key]) for key in ("homeGoals", "awayGoals"))


def league(value):
    return {"EPL": "Premier League", "La_liga": "La Liga", "La liga": "La Liga", "Ligue_1": "Ligue 1", "Serie_A": "Serie A"}.get(value, value)


def available(row):
    return max(ts(row["date"]) + 7200, ts(row["availableAt"]) if row.get("availableAt") else 0)


def summarize_range(rows):
    return {"n": len(rows), "from": min((row["forecastAt"] for row in rows), key=ts),
            "to": max((row["forecastAt"] for row in rows), key=ts),
            "availableThrough": max((row["availableAt"] for row in rows), key=ts), "matchIdsHash": idhash(rows)}


def range_metadata_matches(observed, declared):
    if any(observed[key] != declared.get(key) for key in ("n", "availableThrough", "matchIdsHash")):
        return False
    if "observedFrom" in declared or "observedTo" in declared:
        return (declared.get("observedFrom") == observed["from"] and declared.get("observedTo") == observed["to"]
                and ts(declared["from"]) <= ts(observed["from"]) <= ts(observed["to"]) <= ts(declared["to"]))
    return observed["from"] == declared.get("from") and observed["to"] == declared.get("to")


def quality_context(dataset, matches):
    policy = load(REPO / "backend/src/research/challenger-data-quarantine.json")
    policy_hash = hashlib.sha256(json.dumps(policy, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    ids = {entry["matchId"] for entry in policy["entries"]}
    tagged = dataset.get("dataQualityPolicyHash") is not None
    context = {"mode": "policy_tagged" if tagged else "legacy_untagged", "policyApplied": False,
        "currentPolicyHash": policy_hash, "currentPolicyVersion": policy["version"], "manifestEntries": len(ids),
        "action": "quarantine_not_timestamp_correction", "issues": [],
        "knownQuarantinedTargetsPresent": sum(row["matchId"] in ids for row in dataset["rows"]),
        "knownQuarantinedArchiveRows": sum(row["matchId"] in ids for row in matches)}
    if not tagged:
        return context, ids
    if dataset["dataQualityPolicyHash"] != policy_hash: context["issues"].append("dataset_policy_hash_mismatch")
    if dataset.get("dataQualityPolicy") != policy: context["issues"].append("dataset_policy_payload_mismatch")
    if dataset.get("dataQualityBaselineClean") is not True: context["issues"].append("dataset_clean_baseline_not_proven")
    context["policyApplied"] = dataset["dataQualityPolicyHash"] == policy_hash and dataset.get("dataQualityPolicy") == policy
    def population(rows):
        excluded = [row for row in rows if row["matchId"] in ids]
        return {"inputRows": len(rows), "retainedRows": len(rows) - len(excluded), "excludedRows": len(excluded),
                "excludedMatchIds": sorted({row["matchId"] for row in excluded})}
    schedule = dataset.get("decisionSchedule", {"hour": 3, "minute": 7})
    window = dataset.get("targetWindow", {})
    start, end = ts(window["from"]) if window.get("from") else -math.inf, ts(window["until"]) if window.get("until") else math.inf
    requested = {league(value) for value in dataset.get("targetCompetitions", ["Serie A", "Premier League", "La Liga", "Bundesliga", "Ligue 1"])}
    targets = [row for row in matches if league(row["competition"]) in requested and completed(row)
               and available(row) <= ts(dataset["asOf"])
               and start <= boundary(ts(row["date"]), schedule["hour"], schedule["minute"]) < end]
    expected = {"policyVersion": policy["version"], "policyHash": policy_hash, "action": "quarantine_not_timestamp_correction",
                "history": population(matches), "targets": population(targets)}
    context["independentExpectedEvidence"] = expected
    if dataset.get("dataQualityEvidence") != expected: context["issues"].append("data_quality_population_evidence_mismatch")
    return context, ids


def recreate_xg_observations(history):
    """A separate Python implementation of the documented as-of opponent-strength definition."""
    result = {}
    for competition in sorted({league(row["competition"]) for row in history}):
        matches = sorted([row for row in history if league(row["competition"]) == competition], key=lambda row: (row["_kickoff"], row["matchId"]))
        ready = sorted(matches, key=lambda row: row["_available"])
        sums = defaultdict(lambda: [0, 0.0, 0.0])
        cursor, total, count = 0, 0.0, 0
        def strength(team, index):
            mean = total / count if count else 1.3
            prior = sums[team]
            opponent = (prior[index] + 5 * mean) / (prior[0] + 5)
            return max(.5, min(2, opponent / max(.05, mean)))
        for match in matches:
            while cursor < len(ready) and ready[cursor]["_available"] <= match["_kickoff"]:
                past = ready[cursor]; cursor += 1
                if not all(finite(past.get(key)) and past[key] >= 0 for key in ("homeXG", "awayXG")):
                    continue
                for team, xgf, xga in ((past["homeTeamId"], past["homeXG"], past["awayXG"]), (past["awayTeamId"], past["awayXG"], past["homeXG"])):
                    sums[team][0] += 1; sums[team][1] += xgf; sums[team][2] += xga
                total += past["homeXG"] + past["awayXG"]; count += 2
            if not all(finite(match.get(key)) and match[key] >= 0 for key in ("homeXG", "awayXG")):
                continue
            result[match["matchId"]] = {}
            for side, opponent, xgf, xga in (("home", match["awayTeamId"], match["homeXG"], match["awayXG"]),
                                           ("away", match["homeTeamId"], match["awayXG"], match["homeXG"])):
                result[match["matchId"]][side] = [xgf, xga, xgf / strength(opponent, 2), xga / strength(opponent, 1)]
    return result


def audit(input_dir: Path, legacy_dir: Path | None = None, split_plan: Path | None = None):
    ROOT = Path(input_dir).resolve()
    legacy_dir = Path(legacy_dir).resolve() if legacy_dir else ROOT.parent
    audited_sources = ["backend/src/research/ForecastCore.ts", "backend/src/research/ChallengerFeatures.ts",
                       "backend/src/research/ForecastDecisionTime.ts", "backend/src/research/ChallengerDataQuality.ts",
                       "backend/src/research/challenger-data-quarantine.json", "backend/ml/train.py"]
    source_before = {name: sha(REPO / name) for name in audited_sources}
    paths = {"dataset": ROOT / "nightly-extended-canonical.json", "report": ROOT / "training-canonical/report.json",
             "matches": ROOT / "matches.json", "legacyDataset": legacy_dir / "dataset.json",
             "legacyReport": legacy_dir / "run-20261027/report.json",
             "incumbent": ROOT / "actual-incumbent-artifact.json",
             "variantManifest": ROOT / "comparison-canonical-inputs/variants.json"}
    if split_plan is not None: paths["frozenSplitPlan"] = Path(split_plan).resolve()
    legacy_available = paths["legacyDataset"].exists() and paths["legacyReport"].exists()
    manifest = load(paths["variantManifest"])
    if not paths["incumbent"].exists():
        incumbent_variant = next((item for item in manifest["variants"] if item["id"] == "actual_C906"), None)
        if incumbent_variant and incumbent_variant.get("artifactPath"):
            paths["incumbent"] = paths["variantManifest"].parent / incumbent_variant["artifactPath"]
    before = {name: sha(path) for name, path in paths.items() if path.exists()}
    dataset, report, matches = load(paths["dataset"]), load(paths["report"]), load(paths["matches"])
    declared_plan = report.get("splitPlan")
    plan_document = load(paths["frozenSplitPlan"]) if split_plan is not None else None
    plan_issues = []
    if declared_plan:
        if declared_plan.get("quantilesRecomputed") is not False: plan_issues.append("frozen_plan_quantiles_not_preserved")
        if declared_plan.get("foldCount") != len(report["folds"]): plan_issues.append("frozen_plan_fold_count_mismatch")
        if plan_document is not None:
            if declared_plan.get("fileHash") != before["frozenSplitPlan"]: plan_issues.append("frozen_plan_file_hash_mismatch")
            if declared_plan.get("sourceDatasetHash") != plan_document.get("datasetHash"): plan_issues.append("frozen_plan_source_dataset_hash_mismatch")
    elif plan_document is not None:
        plan_issues.append("requested_frozen_plan_not_declared_by_training_report")
    quality, quarantined = quality_context(dataset, matches)
    policy = load(REPO / "backend/src/research/original-holdout-policy.json")
    protected = set(policy["protectedOriginalFinalMatchIds"])
    rows = sorted(dataset["rows"], key=lambda row: (ts(row["forecastAt"]), row["matchId"]))
    seen = Counter(row["matchId"] for row in rows)
    source = {row["matchId"]: row for row in matches}
    complete = [{**row, "_kickoff": ts(row["date"]), "_available": available(row)} for row in matches if completed(row)]
    baseline_history = [row for row in complete if not quality["policyApplied"] or row["matchId"] not in quarantined]
    history = [row for row in baseline_history if row["matchId"] not in protected]
    available_all = sorted(row["_available"] for row in baseline_history)
    available_extra = sorted(row["_available"] for row in history)
    available_league = {name: sorted(row["_available"] for row in baseline_history if league(row["competition"]) == name)
                       for name in {league(row["competition"]) for row in complete}}
    teams = defaultdict(list)
    for row in history:
        teams[row["homeTeamId"]].append(row); teams[row["awayTeamId"]].append(row)
    for values in teams.values(): values.sort(key=lambda row: (row["_kickoff"], row["matchId"]))
    xg = recreate_xg_observations(history)
    row_issues, feature_issues = defaultdict(list), []
    margins = defaultdict(list)
    schedule = dataset.get("decisionSchedule", {"hour": 3, "minute": 7})
    recorded = dataset.get("recordedDecisionTimes", {})
    extra_keys = ["recent_xg_for", "recent_xg_against", "recent_adjusted_xg_for", "recent_adjusted_xg_against", "recent_xg_coverage"]
    for row in rows:
        mid, cutoff, kickoff = row["matchId"], ts(row["forecastAt"]), ts(row["kickoffAt"])
        check = lambda condition, reason: row_issues[reason].append(mid) if condition else None
        check(seen[mid] != 1, "duplicate_target")
        check(mid in protected, "protected_target_used")
        if quality["mode"] == "policy_tagged":
            check(mid in quarantined, "quarantined_target_used")
            check(row.get("dataQualityPolicyHash") != quality["currentPolicyHash"], "row_data_quality_policy_hash_mismatch")
            check(row.get("dataQualityBaselineClean") is not True, "row_clean_baseline_not_proven")
        nominal = boundary(kickoff, schedule["hour"], schedule["minute"])
        check(cutoff != ts(recorded[mid]) or cutoff < nominal if mid in recorded else cutoff != nominal, "nightly_boundary_mismatch")
        check(cutoff >= kickoff, "forecast_at_or_after_kickoff")
        check(ts(row["availableAt"]) < kickoff + 7200, "target_available_before_two_hour_proxy")
        check(ts(row["availableAt"]) > ts(dataset["asOf"]), "target_label_after_dataset_asof")
        check(ts(row["modelFitAt"]) > cutoff, "future_baseline_fit")
        check(row.get("maxTrainingAvailableAt") and ts(row["maxTrainingAvailableAt"]) > cutoff, "future_declared_baseline_history")
        metadata = row["challengerFeatureMetadata"]
        if quality["mode"] == "policy_tagged":
            check(metadata.get("dataQualityPolicyHash") != quality["currentPolicyHash"], "extra_history_data_quality_policy_hash_mismatch")
        check(metadata.get("maxHistoryAvailableAt") and ts(metadata["maxHistoryAvailableAt"]) > cutoff, "future_declared_extra_history")
        index = bisect_right(available_all, cutoff)
        expected_latest = available_all[index - 1] if index else None
        declared_latest = ts(row["maxTrainingAvailableAt"]) if row.get("maxTrainingAvailableAt") else None
        check(expected_latest != declared_latest, "baseline_history_watermark_does_not_match_source_asof")
        index_extra = bisect_right(available_extra, cutoff)
        expected_extra = available_extra[index_extra - 1] if index_extra else None
        check(expected_extra != (ts(metadata["maxHistoryAvailableAt"]) if metadata.get("maxHistoryAvailableAt") else None), "extra_history_watermark_does_not_match_source_asof")
        check(row["trainingCount"] != bisect_right(available_league[league(row["competition"])], ts(row["modelFitAt"])), "baseline_fit_training_count_mismatch")
        check(any(row[key] != source[mid][key] for key in ("homeGoals", "awayGoals")), "target_label_differs_from_archive")
        margins["forecastLeadHours"].append((kickoff - cutoff) / 3600)
        if declared_latest is not None: margins["baselineHistoryLagHours"].append((cutoff - declared_latest) / 3600)
        values = dict(zip(row["featureNames"], row["features"]))
        expected = {}
        for side in ("home", "away"):
            team_rows = [item for item in teams[row[f"{side}TeamId"]] if item["_available"] <= cutoff and item["matchId"] != mid]
            recent = [item for item in team_rows if league(item["competition"]) == league(row["competition"])][-5:]
            observations = [xg[item["matchId"]]["home" if item["homeTeamId"] == row[f"{side}TeamId"] else "away"]
                            for item in recent if item["matchId"] in xg]
            means = [sum(item[i] for item in observations) / len(observations) if observations else 1.3 for i in range(4)]
            means.append(len(observations) / len(recent) if recent else 0)
            expected.update({f"{side}_{key}": value for key, value in zip(extra_keys, means)})
            expected[f"{side}_observed_rest_days"] = min(60, max(0, (cutoff - team_rows[-1]["_kickoff"]) / 86400)) if team_rows else 60
            for days in (7, 14): expected[f"{side}_observed_matches_{days}d"] = sum(cutoff - item["_kickoff"] <= days * 86400 for item in team_rows)
        differences = {key: {"stored": values.get(key), "independent": value} for key, value in expected.items()
                       if values.get(key) is None or abs(values[key] - value) > 1e-10}
        if differences: feature_issues.append({"matchId": mid, "differences": differences})

    fold_audits, sets, all_test_ids, artifact_issues = [], [], [], []
    for fold in report["folds"]:
        split, partition = fold["trainingSplit"], {}
        issues = []
        for part, following in (("train", "selection"), ("selection", "calibration"), ("calibration", "test"), ("test", None)):
            bounds = split[part]
            next_boundary = ts(split[following]["from"]) if following else math.inf
            partition[part] = [row for row in rows if ts(bounds["from"]) <= ts(row["forecastAt"]) <= ts(bounds["to"])
                               and ts(row["availableAt"]) < next_boundary]
            actual = summarize_range(partition[part])
            if not range_metadata_matches(actual, bounds): issues.append({"kind": "range_or_ids_metadata_mismatch", "part": part, "expected": actual, "stored": bounds})
        if declared_plan:
            if fold.get("splitPlanHash") != declared_plan.get("fileHash"): issues.append({"kind": "fold_frozen_plan_hash_mismatch"})
            frozen = fold.get("frozenTrainingSplit", {})
            if any(split[part][key] != frozen.get(part, {}).get(key) for part in partition for key in ("from", "to")):
                issues.append({"kind": "frozen_forecast_window_changed"})
            if plan_document is not None:
                original = next((item for item in plan_document.get("folds", []) if item["fold"] == fold["fold"]), None)
                if original is None or frozen != original["trainingSplit"]: issues.append({"kind": "frozen_split_manifest_does_not_match_source_plan"})
        ids = {part: {row["matchId"] for row in values} for part, values in partition.items()}
        for i, first in enumerate(ids):
            for second in list(ids)[i + 1:]:
                if ids[first] & ids[second]: issues.append({"kind": "within_fold_overlap", "parts": [first, second], "n": len(ids[first] & ids[second])})
        for early, late in (("train", "selection"), ("selection", "calibration"), ("calibration", "test")):
            if ts(split[early]["availableThrough"]) >= ts(split[late]["from"]): issues.append({"kind": "future_labels_at_split", "parts": [early, late]})
        selected = min(fold["comparisons"], key=lambda item: (item["selection"]["logLoss"], item["name"]))["name"]
        if selected != fold["selectedVariant"]: issues.append({"kind": "candidate_not_selected_by_selection_only"})
        for arm in fold["comparisons"]:
            raw_path = ROOT / "training-canonical" / f"fold-{fold['fold']}" / arm["name"] / "artifact.json"
            artifact = load(raw_path)
            if declared_plan and (artifact.get("splitPlanHash") != declared_plan.get("fileHash")
                    or artifact.get("frozenTrainingSplit") != fold.get("frozenTrainingSplit")):
                artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "artifact_frozen_split_plan_mismatch"})
            if quality["policyApplied"] and (artifact.get("dataQualityPolicyHash") != quality["currentPolicyHash"]
                    or artifact.get("dataQualityBaselineClean") is not True):
                artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "artifact_data_quality_policy_or_clean_proof_mismatch"})
            calibration = artifact["calibrationPredictions"]
            cal_ids = [row["matchId"] for row in calibration]
            if set(cal_ids) != ids["calibration"] or len(cal_ids) != len(set(cal_ids)): artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "calibration_rows_not_exact_calibration_partition"})
            if artifact["trainingSplit"] != split: artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "artifact_split_mismatch"})
            if ts(artifact["trainedThrough"]) != ts(split["train"]["availableThrough"]): artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "artifact_training_cutoff_mismatch"})
            if ts(artifact["validationThrough"]) != max(ts(split[part]["availableThrough"]) for part in ("selection", "calibration")): artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "artifact_validation_cutoff_mismatch"})
            for row in calibration:
                actual = source[row["matchId"]]
                if row["homeGoals"] != actual["homeGoals"] or row["awayGoals"] != actual["awayGoals"] or ts(row["availableAt"]) > ts(artifact["validationThrough"]): artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "calibration_label_or_time_mismatch", "matchId": row["matchId"]})
            variant = next(item for item in manifest["variants"] if item["id"] == arm["name"])
            coherent = load(paths["variantManifest"].parent / variant["folds"][fold["fold"]]["artifactPath"])
            if declared_plan and (coherent.get("splitPlanHash") != declared_plan.get("fileHash")
                    or coherent.get("frozenTrainingSplit") != fold.get("frozenTrainingSplit")):
                artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "coherent_frozen_split_plan_mismatch"})
            if quality["policyApplied"] and (coherent.get("dataQualityPolicyHash") != quality["currentPolicyHash"]
                    or coherent.get("dataQualityBaselineClean") is not True):
                artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "coherent_data_quality_policy_or_clean_proof_mismatch"})
            if coherent.get("parentVersion") != artifact["version"]: artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "coherent_parent_version_mismatch"})
            for family in ("A", "C"):
                profile = coherent["calibrationProfilesV2"][family]
                if profile["matches"] != len(calibration) or profile["nObservations"] != 3 * len(calibration) or ts(profile["fittedThrough"]) != ts(split["calibration"]["availableThrough"]) or ts(profile["fittedThrough"]) >= ts(split["test"]["from"]): artifact_issues.append({"fold": fold["fold"], "arm": arm["name"], "kind": "calibrator_partition_count_or_future_cutoff", "family": family})
        fold_audits.append({"fold": fold["fold"], "selectedVariant": selected, "split": split, "issues": issues})
        sets.append(ids); all_test_ids.extend(ids["test"])
    cross_fold = []
    for i in range(len(sets)):
        for j in range(i + 1, len(sets)):
            cross_fold.append({"fromFold": i, "toFold": j, "testToTest": len(sets[i]["test"] & sets[j]["test"]),
                               **{f"earlierTestToLater{part.title()}": len(sets[i]["test"] & sets[j][part]) for part in ("train", "selection", "calibration")}})

    if legacy_available:
        old_dataset, old_report, incumbent = load(paths["legacyDataset"]), load(paths["legacyReport"]), load(paths["incumbent"])
        old_rows = sorted(old_dataset["rows"], key=lambda row: (ts(row["forecastAt"]), row["matchId"]))
        old_final = old_report["finalHoldout"]
        old_final_ids = {row["matchId"] for row in old_report["predictions"] if row["versionC"] == old_final["version"]}
        old_cal = incumbent["calibrationPredictions"]
        old_split_audits = []
        old_times = sorted({row["forecastAt"] for row in old_rows}, key=ts)
        for index, fold in enumerate(old_report["folds"]):
            test_start_index = old_times.index(fold["testFrom"])
            validation_start_index = max(1, test_start_index - max(2, int(len(old_times) * .15)))
            validation_start, test_start = ts(old_times[validation_start_index]), ts(fold["testFrom"])
            test_end = ts(old_report["folds"][index + 1]["testFrom"]) if index + 1 < len(old_report["folds"]) else float("inf")
            old_train = [row for row in old_rows if ts(row["forecastAt"]) < validation_start and ts(row["availableAt"]) < validation_start]
            validation = [row for row in old_rows if validation_start <= ts(row["forecastAt"]) < test_start and ts(row["availableAt"]) < test_start]
            cal_times = sorted({row["forecastAt"] for row in validation}, key=ts)
            cal_start = ts(cal_times[max(1, int(len(cal_times) * 2 / 3))])
            old_selection = [row for row in validation if ts(row["forecastAt"]) < cal_start and ts(row["availableAt"]) < cal_start]
            old_calibration = [row for row in validation if ts(row["forecastAt"]) >= cal_start]
            old_test = [row for row in old_rows if test_start <= ts(row["forecastAt"]) < test_end]
            derived = {"train": summarize_range(old_train), "selection": summarize_range(old_selection),
                       "calibration": summarize_range(old_calibration), "test": summarize_range(old_test)}
            expected_counts = [fold["trainN"], fold["validationN"], fold["calibrationN"], fold["testN"]]
            old_split_audits.append({"fold": index, "version": fold["version"], "split": derived,
                "countsMatchReport": [len(old_train), len(old_selection), len(old_calibration), len(old_test)] == expected_counts,
                "calibrationIdsMatchReport": {row["matchId"] for row in old_calibration} == {row["matchId"] for row in fold["calibrationPredictions"]},
                "labelsAvailableBeforeNextSplit": all(ts(derived[first]["availableThrough"]) < ts(derived[second]["from"])
                    for first, second in (("train", "selection"), ("selection", "calibration"), ("calibration", "test"))),
                "trainingCutoffMatchesReport": ts(derived["train"]["availableThrough"]) == ts(fold["trainedThrough"]),
                "validationCutoffMatchesReport": max(ts(derived[part]["availableThrough"]) for part in ("selection", "calibration")) == ts(fold["validationThrough"])})
        recorded_variant = next(item for item in manifest["variants"] if item["id"] == "actual_C906")
        old_checks = {"version": incumbent["version"], "parentVersion": incumbent.get("parentVersion"),
            "kind": incumbent["candidateKind"], "createdAt": incumbent["createdAt"], "trainedThrough": incumbent["trainedThrough"],
            "validationThrough": incumbent["validationThrough"], "calibrationRows": len(old_cal),
            "calibrationLabelsAfterValidation": sum(ts(row["availableAt"]) > ts(incumbent["validationThrough"]) for row in old_cal),
            "calibrationRowsInOriginalFinal": len({row["matchId"] for row in old_cal} & old_final_ids),
            "originalFinalCount": len(old_final_ids), "originalProtectedSetMatchesExactly": old_final_ids == protected,
            "canonicalRowsBeforeOrAtIncumbentValidation": sum(ts(row["forecastAt"]) <= ts(incumbent["validationThrough"]) for row in rows),
            "canonicalRowsBeforeIncumbentCreation": sum(ts(row["forecastAt"]) < ts(incumbent["createdAt"]) for row in rows),
            "canonicalRowsAfterCreationAndValidation": sum(ts(row["forecastAt"]) >= ts(incumbent["createdAt"]) and ts(row["forecastAt"]) > ts(incumbent["validationThrough"]) for row in rows),
            "recordedIncumbentAvailabilityFrom": recorded_variant.get("from"),
            "canonicalRowsAfterRecordedIncumbentAvailability": sum(ts(row["forecastAt"]) >= ts(recorded_variant["from"]) for row in rows),
            "oldDatasetHashMatchesReport": old_report["datasetHash"] == before["legacyDataset"],
            "oldSplitAudits": old_split_audits,
            "originalFinal": {key: old_final.get(key) for key in ("version", "trainN", "validationN", "calibrationN", "testN", "trainedThrough", "validationThrough", "testFrom", "testTo")}}
    else:
        old_checks = {"available": False, "reason": "legacy_dataset_or_report_not_supplied",
                      "requestedLegacyDirectory": relative_path(legacy_dir, ROOT)}
    after = {name: sha(path) for name, path in paths.items() if path.exists()}
    audit = {"protocol": "independent-temporal-audit-v1", "auditImplementationHash": sha(Path(__file__)),
        "sourceFiles": {name: {"sha256": value, "unchanged": value == sha(REPO / name)} for name, value in source_before.items()},
        "assuranceScope": {"kind": "computational_asof_consistency_only", "assumesSuppliedKickoffTimesCorrect": True,
            "independentKickoffVerification": False, "actualProviderCaptureVerification": False,
            "crossSourceScheduleDiscrepanciesCanInvalidatePrematchAxis": True},
        "files": {name: {"path": relative_path(path, ROOT), "sha256": before[name], "unchanged": before[name] == after[name]} for name, path in paths.items() if name in before},
        "datasetRows": len(rows), "uniqueTargets": len(seen), "sourceMatches": len(matches), "sourceCompletedMatches": len(complete),
        "dataQuality": quality, "baselineHistoryCompletedMatches": len(baseline_history),
        "frozenSplitPlan": {"declared": declared_plan is not None, "sourceFileVerified": plan_document is not None,
                            "issues": plan_issues},
        "sourceExplicitAvailableAt": sum(bool(row.get("availableAt")) for row in matches),
        "sourceProxyAvailableAt": sum(not bool(row.get("availableAt")) for row in complete),
        "reportDatasetHashMatches": report["datasetHash"] == before["dataset"],
        "rowIssueCounts": {key: len(value) for key, value in row_issues.items() if value},
        "rowIssuesFirst20": {key: value[:20] for key, value in row_issues.items() if value},
        "independentFeatureRowsChecked": len(rows), "independentExtraFeaturesChecked": len(rows) * 16,
        "independentFeatureMismatchRows": len(feature_issues), "independentFeatureMismatchFirst10": feature_issues[:10],
        "margins": {key: {"min": min(value), "max": max(value)} for key, value in margins.items()},
        "folds": fold_audits, "crossFoldOverlap": cross_fold, "testTargets": len(all_test_ids),
        "uniqueTestTargets": len(set(all_test_ids)), "reportTestPredictionRows": len(report["predictions"]),
        "reportTestTargetsMatchReconstructedSplits": {row["matchId"] for row in report["predictions"]} == set(all_test_ids),
        "artifactsChecked": len(report["folds"]) * len(report["arms"]) * 2,
        "artifactIssueCount": len(artifact_issues), "artifactIssuesFirst20": artifact_issues[:20], "incumbentC906": old_checks,
        "interpretation": ["Cross-fold prior-test reuse in a later train/selection/calibration window is chronological expanding walk-forward, not future data in that earlier forecast.",
            "These reused development folds are not a new globally untouched independent holdout.",
            "Source availableAt and xG capture timestamps are unobserved: kickoff+2h is a declared historical proxy, not proof of actual acquisition.",
            "Dataset/archive timestamp agreement does not verify the real fixture schedule. A cross-source kickoff discrepancy can invalidate a pre-match forecast even when computational checks pass.",
            "C906's validation cutoff is not its actual creation time; availability requires both chronology and observed creation/registration evidence.",
            "No A code, application configuration, database or final report was modified."]}
    legacy_checks = old_checks.get("oldSplitAudits", [])
    audit["passed"] = (not audit["rowIssueCounts"] and not feature_issues and not artifact_issues and not quality["issues"] and not plan_issues
        and not any(fold["issues"] for fold in fold_audits) and len(all_test_ids) == len(set(all_test_ids))
        and audit["reportDatasetHashMatches"] and audit["reportTestTargetsMatchReconstructedSplits"]
        and all(item["unchanged"] for item in audit["files"].values())
        and all(item["unchanged"] for item in audit["sourceFiles"].values())
        and all(all(value for key, value in fold.items() if key not in ("fold", "version", "split")) for fold in legacy_checks))
    return audit


def relative_path(path, input_dir):
    path = Path(path).resolve()
    try:
        return path.relative_to(REPO).as_posix()
    except ValueError:
        try:
            return Path(os.path.relpath(path, input_dir)).as_posix()
        except ValueError:
            return "external/" + path.name


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input-dir", required=True, type=Path, help="Frozen C directory with canonical dataset/report and comparison manifest")
    parser.add_argument("--legacy-dir", type=Path, help="Optional legacy archive directory; defaults to input directory's parent")
    parser.add_argument("--split-plan", type=Path, help="Optional original frozen controlled report; verify its file hash and forecast windows")
    parser.add_argument("--out", required=True, type=Path, help="New output file; existing files are never overwritten")
    args = parser.parse_args(argv)
    if args.out.exists():
        parser.error("--out must name a new file")
    result = audit(args.input_dir, args.legacy_dir, args.split_plan)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2, allow_nan=False), encoding="utf-8")
    print(json.dumps({"out": relative_path(args.out, args.input_dir), "passed": result["passed"],
        "rows": result["datasetRows"], "rowIssues": result["rowIssueCounts"],
        "featureMismatchRows": result["independentFeatureMismatchRows"], "artifactIssues": result["artifactIssueCount"]}))
    return 0 if result["passed"] else 1


if __name__ == "__main__": raise SystemExit(main())
