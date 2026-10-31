"""Small synthetic fixtures verify that the independent audit detects chronology violations."""
from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/audit-challenger-temporal.py"
SPEC = importlib.util.spec_from_file_location("independent_challenger_temporal_audit", SCRIPT)
auditor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(auditor)


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def fixture(root):
    names = [f"legacy_fixture_{i}" for i in range(40)]
    names += [f"{side}_{name}" for side in ("home", "away") for name in (
        "recent_xg_for", "recent_xg_against", "recent_adjusted_xg_for", "recent_adjusted_xg_against", "recent_xg_coverage")]
    names += [f"{side}_{name}" for side in ("home", "away") for name in (
        "observed_rest_days", "observed_matches_7d", "observed_matches_14d")]
    stamp = lambda value: value.isoformat().replace("+00:00", "Z")
    start = datetime(2025, 1, 1, 2, 7, tzinfo=timezone.utc)
    rows, matches = [], []
    for i in range(10):
        forecast = start + timedelta(days=i)
        kickoff, available = forecast.replace(hour=14, minute=0), forecast.replace(hour=16, minute=0)
        match = {"matchId": f"synthetic-audit-{i}", "competition": "Serie A", "homeTeamId": f"home-{i}",
                 "awayTeamId": f"away-{i}", "date": stamp(kickoff), "homeGoals": 1, "awayGoals": 0, "homeXG": 1.5, "awayXG": 1}
        matches.append(match)
        watermark = rows[-1]["availableAt"] if rows else None
        rows.append({**match, "forecastAt": stamp(forecast), "kickoffAt": stamp(kickoff), "availableAt": stamp(available),
            "modelFitAt": stamp(forecast), "maxTrainingAvailableAt": watermark, "trainingCount": i,
            "featureNames": names, "features": [0] * 40 + [1.3] * 4 + [0] + [1.3] * 4 + [0] + [60, 0, 0] * 2,
            "challengerFeatureMetadata": {"maxHistoryAvailableAt": watermark}})
    dataset = {"rows": rows, "asOf": "2025-02-01T00:00:00Z", "decisionSchedule": {"hour": 3, "minute": 7}}
    save(root / "nightly-extended-canonical.json", dataset)
    save(root / "matches.json", matches)
    groups = {"train": rows[:3], "selection": rows[3:5], "calibration": rows[5:7], "test": rows[7:]}
    split = {"protocol": "purged-temporal-train-selection-calibration-test-v1",
             **{name: auditor.summarize_range(values) for name, values in groups.items()}}
    raw = {"version": "C-synthetic-raw", "trainingSplit": split,
        "trainedThrough": split["train"]["availableThrough"], "validationThrough": split["calibration"]["availableThrough"],
        "calibrationPredictions": groups["calibration"]}
    save(root / "training-canonical/fold-0/no_ml/artifact.json", raw)
    profile = {"matches": 2, "nObservations": 6, "fittedThrough": split["calibration"]["availableThrough"]}
    save(root / "comparison-canonical-inputs/fold-0-no_ml.json", {"version": "C-synthetic-coherent", "parentVersion": raw["version"],
        "calibrationProfilesV2": {"A": profile, "C": profile}})
    save(root / "comparison-canonical-inputs/variants.json", {"variants": [{"id": "no_ml", "folds": [{"artifactPath": "fold-0-no_ml.json"}]},
        {"id": "actual_C906", "from": "2026-10-29T10:40:00Z"}]})
    save(root / "actual-incumbent-artifact.json", {"version": "C-synthetic-incumbent"})
    report = {"datasetHash": hashlib.sha256((root / "nightly-extended-canonical.json").read_bytes()).hexdigest(),
        "arms": [{"name": "no_ml"}], "predictions": groups["test"],
        "folds": [{"fold": 0, "trainingSplit": split, "selectedVariant": "no_ml", "comparisons": [{"name": "no_ml", "selection": {"logLoss": 1}}]}]}
    save(root / "training-canonical/report.json", report)
    return dataset, raw


def enable_quality_policy(root, include_quarantined_source=True):
    dataset = json.loads((root / "nightly-extended-canonical.json").read_text())
    matches = json.loads((root / "matches.json").read_text())
    policy = json.loads((auditor.REPO / "backend/src/research/challenger-data-quarantine.json").read_text())
    policy_hash = hashlib.sha256(json.dumps(policy, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    if include_quarantined_source:
        # A poisoned final label would be eligible on the supplied clock unless the C policy removes it.
        matches.append({**matches[0], "matchId": "understat_22621", "homeTeamId": "home-1", "awayTeamId": "away-1",
                        "homeGoals": 1, "awayGoals": 2, "homeXG": 90, "awayXG": 90})
        save(root / "matches.json", matches)
    excluded = sum(match["matchId"] == 'understat_22621' for match in matches)
    population = {"inputRows": len(matches), "retainedRows": len(matches) - excluded, "excludedRows": excluded,
                  "excludedMatchIds": ["understat_22621"] if excluded else []}
    dataset.update({"dataQualityPolicyHash": policy_hash, "dataQualityBaselineClean": True, "dataQualityPolicy": policy,
                    "dataQualityEvidence": {"policyVersion": policy["version"], "policyHash": policy_hash,
                        "action": "quarantine_not_timestamp_correction", "history": population, "targets": population}})
    for row in dataset["rows"]:
        row.update({"dataQualityPolicyHash": policy_hash, "dataQualityBaselineClean": True})
        row["challengerFeatureMetadata"]["dataQualityPolicyHash"] = policy_hash
    save(root / "nightly-extended-canonical.json", dataset)
    report = json.loads((root / "training-canonical/report.json").read_text())
    report["datasetHash"] = hashlib.sha256((root / "nightly-extended-canonical.json").read_bytes()).hexdigest()
    save(root / "training-canonical/report.json", report)
    for path in [root / "training-canonical/fold-0/no_ml/artifact.json", root / "comparison-canonical-inputs/fold-0-no_ml.json"]:
        artifact = json.loads(path.read_text())
        artifact.update({"dataQualityPolicyHash": policy_hash, "dataQualityBaselineClean": True})
        save(path, artifact)
    return dataset


def freeze_split_plan(root):
    report = json.loads((root / "training-canonical/report.json").read_text())
    fold = report["folds"][0]
    frozen = json.loads(json.dumps(fold["trainingSplit"]))
    plan_path = root / "original-split-plan.json"
    save(plan_path, {"datasetHash": "synthetic-source-dataset-hash", "folds": [{"fold": 0, "trainingSplit": frozen}]})
    plan_hash = hashlib.sha256(plan_path.read_bytes()).hexdigest()
    report["splitPlan"] = {"fileHash": plan_hash, "sourceDatasetHash": "synthetic-source-dataset-hash",
                           "foldCount": 1, "quantilesRecomputed": False}
    fold.update({"splitPlanHash": plan_hash, "frozenTrainingSplit": frozen})
    for part in ("train", "selection", "calibration", "test"):
        fold["trainingSplit"][part]["observedFrom"] = frozen[part]["from"]
        fold["trainingSplit"][part]["observedTo"] = frozen[part]["to"]
    save(root / "training-canonical/report.json", report)
    for path in [root / "training-canonical/fold-0/no_ml/artifact.json", root / "comparison-canonical-inputs/fold-0-no_ml.json"]:
        artifact = json.loads(path.read_text())
        artifact.update({"trainingSplit": fold["trainingSplit"], "frozenTrainingSplit": frozen, "splitPlanHash": plan_hash})
        save(path, artifact)
    return plan_path


def add_diagnostic_recipe_arm(root):
    name = "c906_recipe_retrained"
    raw = json.loads((root / "training-canonical/fold-0/no_ml/artifact.json").read_text())
    raw.update({"version": "C-synthetic-depth-five-recipe", "selectionEligible": False,
                "productionAdoptionEligible": False, "hyperparameters": {"depth": 5}})
    save(root / f"training-canonical/fold-0/{name}/artifact.json", raw)
    coherent = json.loads((root / "comparison-canonical-inputs/fold-0-no_ml.json").read_text())
    coherent.update({"version": "C-synthetic-depth-five-coherent", "parentVersion": raw["version"],
                     "selectionEligible": False, "productionAdoptionEligible": False})
    save(root / f"comparison-canonical-inputs/fold-0-{name}.json", coherent)
    manifest = json.loads((root / "comparison-canonical-inputs/variants.json").read_text())
    manifest["variants"].append({"id": name, "folds": [{"artifactPath": f"fold-0-{name}.json"}]})
    save(root / "comparison-canonical-inputs/variants.json", manifest)
    report = json.loads((root / "training-canonical/report.json").read_text())
    report["arms"].append({"name": name, "selectionEligible": False})
    report["folds"][0]["comparisons"].append({"name": name, "selectionEligible": False,
        "comparisonRole": "retrospective_recipe_control", "selection": {"logLoss": .1}})
    save(root / "training-canonical/report.json", report)


class TemporalAuditTests(unittest.TestCase):
    def test_diagnostic_depth_five_recipe_cannot_win_selection_despite_better_metric(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            fixture(root)
            add_diagnostic_recipe_arm(root)
            result = auditor.audit(root)
            self.assertTrue(result["passed"], result)
            self.assertEqual(result["folds"][0]["selectedVariant"], "no_ml")
            self.assertEqual(result["artifactsChecked"], 4)
            report = json.loads((root / "training-canonical/report.json").read_text())
            report["folds"][0]["selectedVariant"] = "c906_recipe_retrained"
            save(root / "training-canonical/report.json", report)
            result = auditor.audit(root)
            self.assertFalse(result["passed"])
            self.assertTrue(any(issue["kind"] == "candidate_not_selected_by_selection_only" for issue in result["folds"][0]["issues"]))

    def test_selection_eligibility_defaults_to_true_and_invalid_flags_or_empty_selection_fail(self):
        baseline = {"name": "no_ml", "selection": {"logLoss": 1}}
        diagnostic = {"name": "c906_recipe_retrained", "selection": {"logLoss": .1}, "selectionEligible": False}
        self.assertEqual(auditor.eligible_selection_winner([baseline, diagnostic]), "no_ml")
        self.assertEqual(auditor.eligible_selection_winner([baseline, {**diagnostic, "selectionEligible": True}]), diagnostic["name"])
        for invalid in ("false", "true", None, 0, 1):
            with self.assertRaisesRegex(ValueError, "invalid_selection_eligibility_flag"):
                auditor.eligible_selection_winner([baseline, {**diagnostic, "selectionEligible": invalid}])
        with self.assertRaisesRegex(ValueError, "no_selection_eligible_arm"):
            auditor.eligible_selection_winner([{**baseline, "selectionEligible": False}, diagnostic])

    def test_all_ineligible_comparisons_are_recorded_as_a_failing_audit(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            fixture(root)
            report = json.loads((root / "training-canonical/report.json").read_text())
            report["folds"][0]["comparisons"][0]["selectionEligible"] = False
            save(root / "training-canonical/report.json", report)
            for path in [root / "training-canonical/fold-0/no_ml/artifact.json", root / "comparison-canonical-inputs/fold-0-no_ml.json"]:
                artifact = json.loads(path.read_text())
                artifact["selectionEligible"] = False
                save(path, artifact)
            result = auditor.audit(root)
            self.assertFalse(result["passed"])
            self.assertTrue(any(issue["kind"] == "no_selection_eligible_arm" for issue in result["folds"][0]["issues"]))

    def test_clean_fixture_passes_and_outputs_no_absolute_paths(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            fixture(root)
            before = {str(path.relative_to(root)): auditor.sha(path) for path in root.rglob("*.json")}
            result = auditor.audit(root)
            self.assertTrue(result["passed"])
            self.assertEqual(result["datasetRows"], 10)
            self.assertEqual(result["assuranceScope"]["kind"], "computational_asof_consistency_only")
            self.assertFalse(result["assuranceScope"]["independentKickoffVerification"])
            self.assertEqual(result["artifactIssueCount"], 0)
            self.assertFalse(result["incumbentC906"]["available"])
            self.assertTrue(all(not Path(item["path"]).is_absolute() for item in result["files"].values()))
            self.assertEqual(before, {str(path.relative_to(root)): auditor.sha(path) for path in root.rglob("*.json")})

    def test_future_history_watermark_and_t15_relabelling_are_detected(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            dataset, _ = fixture(root)
            dataset["rows"][2]["maxTrainingAvailableAt"] = "2030-01-01T00:00:00Z"
            dataset["rows"][3]["forecastAt"] = "2025-01-04T13:45:00Z"
            save(root / "nightly-extended-canonical.json", dataset)
            result = auditor.audit(root)
            self.assertFalse(result["passed"])
            self.assertEqual(result["rowIssueCounts"]["future_declared_baseline_history"], 1)
            self.assertEqual(result["rowIssueCounts"]["nightly_boundary_mismatch"], 1)

    def test_future_calibration_labels_are_detected(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            _, raw = fixture(root)
            raw["calibrationPredictions"][0]["availableAt"] = "2030-01-01T00:00:00Z"
            save(root / "training-canonical/fold-0/no_ml/artifact.json", raw)
            result = auditor.audit(root)
            self.assertFalse(result["passed"])
            self.assertEqual(result["artifactIssueCount"], 1)
            self.assertEqual(result["artifactIssuesFirst20"][0]["kind"], "calibration_label_or_time_mismatch")

    def test_policy_tagged_corpus_excludes_quarantine_from_baseline_and_extra_history(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            fixture(root)
            enable_quality_policy(root)
            result = auditor.audit(root)
            self.assertTrue(result["passed"], result)
            self.assertTrue(result["dataQuality"]["policyApplied"])
            self.assertEqual(result["dataQuality"]["manifestEntries"], 22)
            self.assertEqual(result["dataQuality"]["knownQuarantinedTargetsPresent"], 0)
            self.assertEqual(result["sourceCompletedMatches"], 11)
            self.assertEqual(result["baselineHistoryCompletedMatches"], 10)
            self.assertEqual(result["dataQuality"]["independentExpectedEvidence"]["history"]["excludedRows"], 1)

    def test_forged_policy_and_row_clean_proof_fail_closed(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            fixture(root)
            dataset = enable_quality_policy(root)
            dataset["dataQualityPolicyHash"] = "a" * 64
            save(root / "nightly-extended-canonical.json", dataset)
            result = auditor.audit(root)
            self.assertFalse(result["passed"])
            self.assertIn("dataset_policy_hash_mismatch", result["dataQuality"]["issues"])
            dataset = enable_quality_policy(root, include_quarantined_source=False)
            dataset["rows"][1]["dataQualityBaselineClean"] = False
            save(root / "nightly-extended-canonical.json", dataset)
            result = auditor.audit(root)
            self.assertFalse(result["passed"])
            self.assertEqual(result["rowIssueCounts"]["row_clean_baseline_not_proven"], 1)

    def test_tagging_a_dirty_baseline_does_not_hide_its_training_population(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            fixture(root)
            dataset = enable_quality_policy(root)
            for row in dataset["rows"][1:]: row["trainingCount"] += 1
            save(root / "nightly-extended-canonical.json", dataset)
            result = auditor.audit(root)
            self.assertFalse(result["passed"])
            self.assertEqual(result["rowIssueCounts"]["baseline_fit_training_count_mismatch"], 9)

    def test_quarantined_target_and_false_population_evidence_are_detected(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            fixture(root)
            dataset = enable_quality_policy(root)
            blocked = {**dataset["rows"][0], "matchId": "understat_22621", "homeTeamId": "home-1", "awayTeamId": "away-1",
                       "homeGoals": 1, "awayGoals": 2}
            dataset["rows"].append(blocked)
            dataset["dataQualityEvidence"]["history"]["excludedRows"] = 0
            save(root / "nightly-extended-canonical.json", dataset)
            result = auditor.audit(root)
            self.assertFalse(result["passed"])
            self.assertEqual(result["rowIssueCounts"]["quarantined_target_used"], 1)
            self.assertIn("data_quality_population_evidence_mismatch", result["dataQuality"]["issues"])

    def test_independent_dst_boundaries_skip_gap_and_choose_latest_repeated_time(self):
        for kickoff, hour, minute, expected in (
            ("2026-03-29T19:00:00Z", 3, 7, "2026-03-29T01:07:00Z"),
            ("2026-10-25T19:00:00Z", 3, 7, "2026-10-25T02:07:00Z"),
            ("2026-03-29T19:00:00Z", 2, 30, "2026-03-28T01:30:00Z"),
            ("2026-10-25T19:00:00Z", 2, 30, "2026-10-25T01:30:00Z"),
        ):
            self.assertEqual(auditor.boundary(auditor.ts(kickoff), hour, minute), auditor.ts(expected))

    def test_frozen_window_observed_metadata_and_original_plan_are_verified(self):
        with tempfile.TemporaryDirectory(prefix="challenger-temporal-audit-unit-") as directory:
            root = Path(directory) / "frozen"
            fixture(root)
            plan_path = freeze_split_plan(root)
            result = auditor.audit(root, split_plan=plan_path)
            self.assertTrue(result["passed"], result)
            self.assertTrue(result["frozenSplitPlan"]["sourceFileVerified"])
            plan = json.loads(plan_path.read_text())
            plan["folds"][0]["trainingSplit"]["train"]["from"] = "2024-12-31T02:07:00Z"
            save(plan_path, plan)
            result = auditor.audit(root, split_plan=plan_path)
            self.assertFalse(result["passed"])
            self.assertIn("frozen_plan_file_hash_mismatch", result["frozenSplitPlan"]["issues"])

    def test_observed_bounds_may_narrow_a_frozen_window_but_cannot_lie(self):
        observed = {"n": 2, "from": "2025-01-02T00:00:00Z", "to": "2025-01-03T00:00:00Z",
                    "availableThrough": "2025-01-03T02:00:00Z", "matchIdsHash": "fixture-hash"}
        declared = {**observed, "from": "2025-01-01T00:00:00Z", "to": "2025-01-04T00:00:00Z",
                    "observedFrom": observed["from"], "observedTo": observed["to"]}
        self.assertTrue(auditor.range_metadata_matches(observed, declared))
        self.assertFalse(auditor.range_metadata_matches(observed, {**declared, "observedTo": declared["to"]}))


if __name__ == "__main__": unittest.main()
