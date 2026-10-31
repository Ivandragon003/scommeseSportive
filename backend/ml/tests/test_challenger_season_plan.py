"""Metadata-only synthetic fixtures; no training or football-performance evidence."""
from copy import deepcopy
from datetime import timedelta
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

PATH = Path(__file__).resolve().parents[2] / "scripts/plan-challenger-seasons.py"
SPEC = importlib.util.spec_from_file_location("season_planner", PATH)
planner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(planner)


def metadata_dataset():
    quality, _ = planner.repository_policies()
    digest = planner.json_hash(quality)
    rows = []
    for index in range(48):
        at = planner.shift_months(planner.month(2022, 7), index) + timedelta(days=14, hours=2, minutes=7)
        year = at.year if at.month >= 7 else at.year - 1
        rows.append({"matchId": f"metadata-only-{index}", "season": f"{year}/{year + 1}",
            "forecastAt": planner.iso(at), "kickoffAt": planner.iso(at + timedelta(hours=16)),
            "availableAt": planner.iso(at + timedelta(hours=18)), "modelFitAt": "2022-06-01T00:00:00Z",
            "maxTrainingAvailableAt": "2022-06-01T00:00:00Z",
            "challengerFeatureMetadata": {"maxHistoryAvailableAt": "2022-06-01T00:00:00Z"},
            "dataQualityPolicyHash": digest, "dataQualityBaselineClean": True})
    population = {"inputRows": len(rows), "retainedRows": len(rows), "excludedRows": 0, "excludedMatchIds": []}
    return {"asOf": "2026-07-01T00:00:00Z", "rows": rows, "dataQualityPolicy": quality,
        "dataQualityPolicyHash": digest, "dataQualityBaselineClean": True,
        "dataQualityEvidence": {"policyVersion": quality["version"], "policyHash": digest,
            "action": quality["action"], "history": population, "targets": population},
        "decisionSchedule": {"hour": 3, "minute": 7, "timezone": "Europe/Rome"},
        "forecastTiming": {"policy": "nightly-metadata-unit", "forecastBeforeKickoff": True, "resultDelayMs": 7200000}}


class ChallengerSeasonPlanTests(unittest.TestCase):
    def test_six_calendar_blocks_cover_three_seasons_exactly_once_without_warmup_tests(self):
        value = metadata_dataset()
        result = planner.build_plan(value, "a" * 64)
        self.assertEqual(len(result["folds"]), 6)
        self.assertEqual(result["declaredSeasons"], ["2023/2024", "2024/2025", "2025/2026"])
        self.assertEqual(result["coverage"]["testRows"], 36)
        self.assertEqual(result["coverage"]["outsideTargetSeasons"], {"2022/2023": 12})
        self.assertTrue(result["coverage"]["testCoverageExactlyOnce"])
        for summary in result["coverage"]["perSeason"].values():
            self.assertEqual(summary["testRows"], 12)
        first = result["folds"][0]["trainingSplit"]
        self.assertEqual(first["train"]["from"], "2022-07-01T00:00:00.000Z")
        self.assertEqual(first["train"]["to"], "2023-02-28T23:59:59.999Z")
        self.assertEqual(first["selection"]["from"], "2023-03-01T00:00:00.000Z")
        self.assertEqual(first["calibration"]["from"], "2023-05-01T00:00:00.000Z")
        self.assertEqual(first["test"]["from"], "2023-07-01T00:00:00.000Z")
        self.assertEqual(result["evaluationPlan"]["independentFrom"], "2026-07-01T00:00:00.001Z")
        self.assertFalse(result["independentEvidence"])
        self.assertFalse(result["currentC906Backdated"])
        self.assertFalse(result["operationalAModified"])
        # Contract check only; this imports no A component and fits no model.
        spec = importlib.util.spec_from_file_location("trainer_contract", PATH.parent.parent / "ml/train.py")
        trainer = importlib.util.module_from_spec(spec); spec.loader.exec_module(trainer)
        self.assertEqual(len(trainer.checked_split_plan(result)), 6)
        self.assertEqual(sum(len(fold[4]) for fold in trainer.fixed_window_folds(value["rows"], result)), 36)

    def test_labels_at_or_after_each_next_window_are_purged_from_fits(self):
        value = metadata_dataset()
        first = planner.build_plan(value, "a" * 64)["folds"][0]["trainingSplit"]
        for part, following in (("train", "selection"), ("selection", "calibration"), ("calibration", "test")):
            candidate = next(row for row in value["rows"] if first[part]["from"] <= row["forecastAt"] <= first[part]["to"])
            candidate["availableAt"] = first[following]["from"]
        result = planner.build_plan(value, "a" * 64)
        for part in ("train", "selection", "calibration"):
            self.assertEqual(result["folds"][0]["trainingSplit"][part]["purgedUnavailableLabels"], 1)
        self.assertEqual(result["coverage"]["testRows"], 36)

    def test_scores_features_and_outcomes_cannot_choose_or_change_boundaries(self):
        value = metadata_dataset()
        expected = planner.build_plan(value, "a" * 64)
        for row in value["rows"]:
            row.update({"homeGoals": {"never_read": True}, "awayGoals": -999,
                "features": ["not-a-numeric-feature"], "baselineMatrix": "not-consulted", "probabilities": None})
        self.assertEqual(planner.build_plan(value, "a" * 64), expected)

    def test_overlap_empty_window_and_wrong_season_fail_closed(self):
        value = metadata_dataset()
        result = planner.build_plan(value, "a" * 64)
        overlapping = deepcopy(result["folds"])
        overlapping[1]["trainingSplit"]["test"]["from"] = overlapping[0]["trainingSplit"]["test"]["to"]
        with self.assertRaisesRegex(ValueError, "overlapping"):
            planner.validate_windows(overlapping)
        value["rows"] = [row for row in value["rows"] if not row["forecastAt"].startswith(("2023-05", "2023-06"))]
        with self.assertRaisesRegex(ValueError, "empty_season_plan_interval"):
            planner.build_plan(value, "a" * 64)
        value = metadata_dataset(); value["rows"][12]["season"] = "2022/2023"
        with self.assertRaisesRegex(ValueError, "season_date_mismatch"):
            planner.build_plan(value, "a" * 64)

    def test_original_protected_and_quarantined_ids_and_mixed_tags_cannot_enter(self):
        value = metadata_dataset()
        quality, holdout = planner.repository_policies()
        for key, replacement in (("matchId", quality["entries"][0]["matchId"]),
            ("matchId", holdout["protectedOriginalFinalMatchIds"][0]), ("dataQualityPolicyHash", "b" * 64),
            ("dataQualityBaselineClean", False)):
            changed = deepcopy(value); changed["rows"][12][key] = replacement
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "protected_or_quarantined|mixed_or_unclean"):
                planner.build_plan(changed, "a" * 64)
        changed = deepcopy(value); changed["dataQualityPolicy"]["entries"] = []
        changed["dataQualityPolicyHash"] = planner.json_hash(changed["dataQualityPolicy"])
        with self.assertRaisesRegex(ValueError, "authentic_clean_c_policy"):
            planner.build_plan(changed, "a" * 64)

    def test_optional_source_ledger_counts_known_exclusions_without_reading_results(self):
        value = metadata_dataset()
        quality, holdout = planner.repository_policies()
        source = [{"matchId": row["matchId"], "season": row["season"]} for row in value["rows"]]
        quarantine_id = quality["entries"][0]["matchId"]
        quarantine_ids = {entry["matchId"] for entry in quality["entries"]}
        protected_id = next(match_id for match_id in holdout["protectedOriginalFinalMatchIds"] if match_id not in quarantine_ids)
        source.extend([{"matchId": quarantine_id, "season": "2023/2024"},
            {"matchId": protected_id, "season": "2023/2024"}, {"matchId": "metadata-only-missing", "season": "2023/2024"}])
        result = planner.build_plan(value, "a" * 64, source, "b" * 64)
        audit = result["coverage"]["perSeason"]["2023/2024"]["sourceAudit"]
        self.assertEqual(audit["sourceRows"], 15)
        self.assertEqual(audit["exclusionCounts"], {"protected_original_holdout": 1, "quarantine_policy": 1, "not_present_in_clean_dataset": 1})
        self.assertEqual(result["coverage"]["protectedTargetsUsed"], 0)
        self.assertEqual(result["coverage"]["quarantinedTargetsUsed"], 0)

    def test_output_is_new_and_never_overwrites_a_frozen_plan(self):
        with tempfile.TemporaryDirectory(prefix="season-plan-metadata-unit-") as directory:
            root = Path(directory)
            (root / "dataset.json").write_text(json.dumps(metadata_dataset()), encoding="utf-8")
            argv = ["--dataset", str(root / "dataset.json"), "--out", str(root / "new-plan.json")]
            planner.main(argv)
            frozen = (root / "new-plan.json").read_bytes()
            self.assertNotIn(b"\r\n", frozen)
            with self.assertRaises(FileExistsError):
                planner.main(argv)
            self.assertEqual((root / "new-plan.json").read_bytes(), frozen)


if __name__ == "__main__":
    unittest.main()
