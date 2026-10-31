"""Synthetic unit fixtures only; they are never evidence of football performance."""
import importlib.util
import json
from copy import deepcopy
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from datetime import datetime, timedelta, timezone

MODULE_PATH = Path(__file__).resolve().parents[1] / "train.py"
SPEC = importlib.util.spec_from_file_location("challenger_trainer", MODULE_PATH)
trainer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(trainer)


def dataset():
    names = trainer.LEGACY_FEATURES + trainer.FEATURE_BLOCKS["recent_xg"] + trainer.FEATURE_BLOCKS["schedule"]
    start = datetime(2023, 1, 1, 3, 7, tzinfo=trainer.rome_timezone())
    rows = []
    for i in range(150):
        at = start + timedelta(days=i)
        iso = lambda value: value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
        rows.append({"matchId": f"synthetic-training-unit-{i}", "competition": "Serie A", "season": "synthetic",
            "forecastAt": iso(at), "kickoffAt": iso(at + timedelta(hours=16)),
            "availableAt": iso(at + timedelta(hours=18)), "modelFitAt": "2022-12-01T00:00:00Z",
            "maxTrainingAvailableAt": "2022-12-01T00:00:00Z", "featureSchema": trainer.CHALLENGER_SCHEMA,
            "featureNames": names, "features": [(i + j) % 7 / 7 for j in range(len(names))],
            "challengerFeatureMetadata": {"maxHistoryAvailableAt": "2022-12-01T00:00:00Z"},
            "baselineMatrix": [[.2, .1, .05], [.15, .15, .05], [.15, .1, .05]],
            "baselineProbabilities": {"homeWin": .4, "draw": .4, "awayWin": .2},
            "baselineVersion": "A-synthetic-fixture", "lambdaHome": 1.3, "lambdaAway": .8,
            "homeGoals": i % 3, "awayGoals": 0 if i % 3 == 2 else 1})
    return {"schemaVersion": trainer.CHALLENGER_SCHEMA, "featureNames": names, "featureBlocks": ["recent_xg", "schedule"],
        "decisionSchedule": {"hour": 3, "minute": 7, "timezone": "Europe/Rome"},
        "forecastTiming": {"policy": "nightly-unit-03:07-Europe-Rome", "resultDelayMs": 7200000, "forecastBeforeKickoff": True},
        "baselineManifest": {"version": "A-synthetic-fixture", "fixtureOnly": True},
        "asOf": "2024-01-01T00:00:00Z", "rows": rows}


def frozen_plan(rows, folds=2):
    return {"datasetHash": "a" * 64, "folds": [{"fold": index,
        "trainingSplit": trainer.split_manifest(train, selection, calibration, test)}
        for index, train, selection, calibration, test in trainer.chronological_folds(rows, folds)]}


def quality_dataset():
    value = dataset()
    policy = trainer.challenger_data_quality_policy()
    digest = trainer.json_stringify_hash(policy)
    population = {"inputRows": len(value["rows"]), "retainedRows": len(value["rows"]),
                  "excludedRows": 0, "excludedMatchIds": []}
    value.update({"dataQualityPolicy": policy, "dataQualityPolicyHash": digest, "dataQualityBaselineClean": True,
        "dataQualityEvidence": {"policyVersion": policy["version"], "policyHash": digest,
            "action": "quarantine_not_timestamp_correction", "history": deepcopy(population), "targets": deepcopy(population)}})
    for row in value["rows"]:
        row.update({"dataQualityPolicyHash": digest, "dataQualityBaselineClean": True})
    return value


class ChallengerTrainingTests(unittest.TestCase):
    def test_frozen_windows_preserve_dates_and_original_cohorts_after_removals(self):
        rows = dataset()["rows"]
        plan = frozen_plan(rows)
        original = list(trainer.fixed_window_folds(rows, plan))
        removed = {original[0][1][0]["matchId"], original[0][2][0]["matchId"], original[0][4][0]["matchId"]}
        remaining = [row for row in rows if row["matchId"] not in removed]
        corrected = list(trainer.fixed_window_folds(remaining, plan))
        self.assertEqual(len(corrected), len(original))
        for before, after, declared in zip(original, corrected, plan["folds"]):
            self.assertEqual(before[0], after[0])
            manifest = trainer.frozen_split_manifest(after[1:], declared["trainingSplit"])
            for name, old_rows, new_rows in zip(("train", "selection", "calibration", "test"), before[1:], after[1:]):
                self.assertEqual({row["matchId"] for row in new_rows}, {row["matchId"] for row in old_rows} - removed)
                self.assertEqual(manifest[name]["from"], declared["trainingSplit"][name]["from"])
                self.assertEqual(manifest[name]["to"], declared["trainingSplit"][name]["to"])
                self.assertEqual(manifest[name]["n"], len(new_rows))
                if len(new_rows) != len(old_rows):
                    self.assertNotEqual(manifest[name]["matchIdsHash"], declared["trainingSplit"][name]["matchIdsHash"])

    def test_frozen_windows_purge_labels_at_each_original_next_boundary(self):
        rows = dataset()["rows"]
        plan = frozen_plan(rows, 1)
        original = list(trainer.fixed_window_folds(rows, plan))[0]
        delayed_ids = set()
        for index, following in enumerate(("selection", "calibration", "test"), 1):
            changed = original[index][0]
            changed["availableAt"] = plan["folds"][0]["trainingSplit"][following]["from"]
            delayed_ids.add(changed["matchId"])
        after = list(trainer.fixed_window_folds(rows, plan))[0]
        self.assertFalse(delayed_ids & {row["matchId"] for group in after[1:] for row in group})
        trainer.frozen_split_manifest(after[1:], plan["folds"][0]["trainingSplit"])

    def test_invalid_frozen_boundaries_and_overlapping_test_windows_fail_closed(self):
        rows = dataset()["rows"]
        valid = frozen_plan(rows)
        for patch in ("overlap_parts", "leaky_labels", "no_timezone", "reverse", "duplicate_fold", "overlap_tests", "non_object"):
            plan = deepcopy(valid)
            first = plan["folds"][0]["trainingSplit"]
            if patch == "overlap_parts": first["train"]["to"] = first["selection"]["from"]
            elif patch == "leaky_labels": first["selection"]["availableThrough"] = first["calibration"]["from"]
            elif patch == "no_timezone": first["test"]["from"] = "2023-04-15T02:07:00"
            elif patch == "reverse": first["test"]["from"] = "2030-01-01T00:00:00Z"
            elif patch == "duplicate_fold": plan["folds"][1]["fold"] = plan["folds"][0]["fold"]
            elif patch == "overlap_tests":
                plan["folds"][1] = deepcopy(plan["folds"][0]); plan["folds"][1]["fold"] = 1
            else: plan["folds"][0] = None
            with self.subTest(patch=patch), self.assertRaisesRegex(ValueError, "frozen_split|frozen_test"):
                trainer.checked_split_plan(plan)

    def test_quality_policy_requires_trusted_manifest_and_all_clean_row_tags(self):
        value = quality_dataset()
        trainer.checked_dataset(value, controlled=True)
        checked = trainer.checked_data_quality(value)
        self.assertEqual(checked["policyHash"], value["dataQualityPolicyHash"])
        self.assertTrue(checked["baselineClean"])
        for change in ("mixed", "untagged", "unclean", "forged_policy", "quarantined_target", "missing_evidence", "orphan_rows"):
            changed = deepcopy(value)
            if change == "mixed": changed["rows"][0]["dataQualityPolicyHash"] = "b" * 64
            elif change == "untagged": del changed["rows"][0]["dataQualityPolicyHash"]
            elif change == "unclean": changed["rows"][0]["dataQualityBaselineClean"] = False
            elif change == "forged_policy":
                changed["dataQualityPolicy"]["entries"] = []
                changed["dataQualityPolicyHash"] = trainer.json_stringify_hash(changed["dataQualityPolicy"])
            elif change == "quarantined_target": changed["rows"][0]["matchId"] = value["dataQualityPolicy"]["entries"][0]["matchId"]
            elif change == "missing_evidence": del changed["dataQualityEvidence"]
            else:
                for key in ("dataQualityPolicyHash", "dataQualityPolicy", "dataQualityEvidence", "dataQualityBaselineClean"): del changed[key]
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "data_quality|quarantined"):
                trainer.checked_dataset(changed, controlled=True)

    def test_frozen_plan_and_quality_provenance_reach_every_controlled_artifact(self):
        value = quality_dataset()
        plan = frozen_plan(value["rows"], 1)
        removed = plan["folds"][0]["trainingSplit"]["test"]["from"]
        value["rows"] = [row for row in value["rows"] if row["forecastAt"] != removed]
        with tempfile.TemporaryDirectory(prefix="challenger-fixed-split-unit-") as directory:
            root = Path(directory)
            (root / "dataset.json").write_text(json.dumps(value), encoding="utf-8")
            (root / "plan.json").write_text(json.dumps(plan), encoding="utf-8")
            trainer.run_controlled(SimpleNamespace(input=str(root / "dataset.json"), output=str(root / "output"),
                iterations=5, depth=2, folds=1, split_plan=str(root / "plan.json")))
            report = json.loads((root / "output/report.json").read_text(encoding="utf-8"))
            self.assertFalse(report["splitPlan"]["quantilesRecomputed"])
            self.assertEqual(report["dataQuality"]["policyHash"], value["dataQualityPolicyHash"])
            for arm in trainer.CONTROLLED_ARMS:
                artifact = json.loads((root / "output" / f"artifact-{arm['name']}.json").read_text(encoding="utf-8"))
                self.assertEqual(artifact["dataQualityPolicyHash"], value["dataQualityPolicyHash"])
                self.assertTrue(artifact["dataQualityBaselineClean"])
                self.assertEqual(artifact["splitPlanHash"], report["splitPlan"]["fileHash"])
                self.assertEqual(artifact["trainingSplit"]["test"]["from"], removed)
                self.assertNotEqual(artifact["trainingSplit"]["test"]["observedFrom"], removed)
                self.assertEqual(artifact["frozenTrainingSplit"], plan["folds"][0]["trainingSplit"])
                self.assertEqual(artifact["trainingSplit"]["test"]["n"], plan["folds"][0]["trainingSplit"]["test"]["n"] - 1)

    def test_protected_targets_excluded_before_any_split(self):
        value = dataset()
        protected = trainer.protected_holdout_policy()["protectedOriginalFinalMatchIds"][0]
        value["rows"].append({**value["rows"][0], "matchId": protected})
        _, rows, protection = trainer.checked_dataset(value, controlled=True)
        self.assertNotIn(protected, {row["matchId"] for row in rows})
        self.assertEqual(protection["excluded"], 1)
        self.assertEqual(protection["protectedRowsUsed"], 0)

    def test_four_disjoint_splits_purge_unavailable_labels(self):
        _, rows, _ = trainer.checked_dataset(dataset(), controlled=True)
        folds = list(trainer.chronological_folds(rows, 2))
        self.assertEqual(len(folds), 2)
        test_ids = set()
        for _, train, selection, calibration, test in folds:
            split = trainer.split_manifest(train, selection, calibration, test)
            groups = [train, selection, calibration, test]
            self.assertEqual(sum(len(group) for group in groups), len({row["matchId"] for group in groups for row in group}))
            for earlier, later in (("train", "selection"), ("selection", "calibration"), ("calibration", "test")):
                self.assertLess(trainer.timestamp(split[earlier]["availableThrough"]), trainer.timestamp(split[later]["from"]))
            self.assertFalse(test_ids & {row["matchId"] for row in test})
            test_ids.update(row["matchId"] for row in test)

    def test_future_features_and_relabelled_t15_inputs_fail_closed(self):
        value = dataset()
        value["forecastTiming"]["policy"] = "preserved-input-forecast-times"
        with self.assertRaisesRegex(ValueError, "real_nightly"):
            trainer.checked_dataset(value, controlled=True)
        value = dataset()
        value["rows"][0]["challengerFeatureMetadata"]["maxHistoryAvailableAt"] = "2030-01-01T00:00:00Z"
        with self.assertRaisesRegex(ValueError, "future_challenger"):
            trainer.checked_dataset(value, controlled=True)
        value = dataset()
        value["rows"][0]["availableAt"] = value["rows"][0]["kickoffAt"]
        with self.assertRaisesRegex(ValueError, "conservative_delay"):
            trainer.checked_dataset(value, controlled=True)

    def test_t15_with_forged_nightly_label_is_rejected(self):
        value = dataset()
        kickoff = datetime.fromisoformat(value["rows"][0]["kickoffAt"].replace("Z", "+00:00"))
        value["rows"][0]["forecastAt"] = (kickoff - timedelta(minutes=15)).isoformat()
        with self.assertRaisesRegex(ValueError, "nightly_forecast_time_mismatch"):
            trainer.checked_dataset(value, controlled=True)

    def test_rome_dst_boundaries_and_declared_schedule(self):
        nominal = {"hour": 3, "minute": 7, "timezone": "Europe/Rome"}
        for kickoff, expected in (
            ("2026-01-15T19:00:00Z", "2026-01-15T02:07:00Z"),
            ("2026-07-15T19:00:00Z", "2026-07-15T01:07:00Z"),
            ("2026-03-29T19:00:00Z", "2026-03-29T01:07:00Z"),
            ("2026-10-25T19:00:00Z", "2026-10-25T02:07:00Z"),
            ("2026-07-15T01:07:00Z", "2026-07-14T01:07:00Z"),
        ):
            self.assertEqual(trainer.resolve_nightly_forecast_at(kickoff, nominal), trainer.timestamp(expected))
        repeated = {"hour": 2, "minute": 30, "timezone": "Europe/Rome"}
        for kickoff, expected in (
            ("2026-03-29T19:00:00Z", "2026-03-28T01:30:00Z"),
            ("2026-10-25T19:00:00Z", "2026-10-25T01:30:00Z"),
            ("2026-10-25T00:45:00Z", "2026-10-25T00:30:00Z"),
        ):
            self.assertEqual(trainer.resolve_nightly_forecast_at(kickoff, repeated), trainer.timestamp(expected))
        value = dataset()
        value["decisionSchedule"]["hour"] = 4
        with self.assertRaisesRegex(ValueError, "nightly_forecast_time_mismatch"):
            trainer.checked_dataset(value, controlled=True)
        for row in value["rows"]:
            row["forecastAt"] = datetime.fromtimestamp(trainer.timestamp(row["forecastAt"]) + 3600, timezone.utc).isoformat()
        trainer.checked_dataset(value, controlled=True)
        value = dataset()
        value["decisionSchedule"]["timezone"] = "UTC"
        with self.assertRaisesRegex(ValueError, "invalid_nightly_decision_schedule"):
            trainer.checked_dataset(value, controlled=True)

    def test_explicit_recorded_decision_times_must_match_and_follow_nominal_boundary(self):
        value = dataset()
        row = value["rows"][0]
        nominal = trainer.timestamp(row["forecastAt"])
        actual = datetime.fromtimestamp(nominal + 120, timezone.utc).isoformat()
        row["forecastAt"] = actual
        with self.assertRaisesRegex(ValueError, "nightly_forecast_time_mismatch"):
            trainer.checked_dataset(value, controlled=True)
        value["recordedDecisionTimes"] = {row["matchId"]: actual}
        trainer.checked_dataset(value, controlled=True)
        value["recordedDecisionTimes"][row["matchId"]] = datetime.fromtimestamp(nominal + 180, timezone.utc).isoformat()
        with self.assertRaisesRegex(ValueError, "recorded_nightly_time_mismatch"):
            trainer.checked_dataset(value, controlled=True)
        before = datetime.fromtimestamp(nominal - 60, timezone.utc).isoformat()
        row["forecastAt"] = before
        value["recordedDecisionTimes"][row["matchId"]] = before
        with self.assertRaisesRegex(ValueError, "recorded_nightly_time_mismatch"):
            trainer.checked_dataset(value, controlled=True)

    def test_missing_iana_timezone_data_fails_without_utc_fallback(self):
        trainer.rome_timezone.cache_clear()
        try:
            with patch.object(trainer, "ZoneInfo", side_effect=trainer.ZoneInfoNotFoundError("Europe/Rome")):
                with self.assertRaisesRegex(ValueError, "rome_timezone_data_unavailable_install_tzdata"):
                    trainer.rome_timezone()
        finally:
            trainer.rome_timezone.cache_clear()

    def test_six_fixed_arms_train_with_metadata_and_no_independence_claim(self):
        with tempfile.TemporaryDirectory(prefix="challenger-training-unit-") as directory:
            root = Path(directory)
            (root / "dataset.json").write_text(json.dumps(dataset()), encoding="utf-8")
            trainer.run_controlled(SimpleNamespace(input=str(root / "dataset.json"), output=str(root / "output"),
                                                   iterations=5, depth=2, folds=1))
            report = json.loads((root / "output/report.json").read_text(encoding="utf-8"))
            self.assertEqual(len(report["arms"]), 6)
            self.assertFalse(report["independentEvidence"])
            self.assertFalse(report["productionPromotion"])
            self.assertEqual(report["holdoutProtection"]["protectedRowsUsed"], 0)
            self.assertTrue(report["predictions"])
            self.assertTrue(all(len(row["variants"]) == 6 for row in report["predictions"]))
            for arm in trainer.CONTROLLED_ARMS:
                artifact = json.loads((root / "output" / f"artifact-{arm['name']}.json").read_text(encoding="utf-8"))
                self.assertEqual(artifact["comparisonArm"], arm["name"])
                self.assertEqual(artifact["trainingSplit"]["protocol"], trainer.SPLIT_PROTOCOL)
                self.assertEqual(artifact["featureBlocks"], arm["blocks"])
                self.assertEqual(artifact["weight"], arm["weight"])
                self.assertEqual(artifact["temperature"], arm["temperature"])
                self.assertFalse(artifact["productionValidated"])


if __name__ == "__main__":
    unittest.main()
