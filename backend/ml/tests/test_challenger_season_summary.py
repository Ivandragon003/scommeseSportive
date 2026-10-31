"""Public synthetic fixtures; none are evidence of football performance."""
import copy
import importlib.util
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/summarize-challenger-seasons.py"
SPEC = importlib.util.spec_from_file_location("season_summary", SCRIPT)
summary = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(summary)


def row(match_id, forecast="2024-01-01T03:07:00Z", season="2023/2024", extra=False):
    variants = summary.VARIANTS if extra else summary.metrics.ARMS
    return {"matchId": match_id, "competition": "Synthetic League", "season": season,
        "forecastAt": forecast, "kickoffAt": forecast.replace("03:07", "18:00"),
        "homeGoals": 1, "awayGoals": 0, "phase": "development", "predictions": {
            variant: {"probabilities": [.6, .3, .1], "probabilityStages": {
                "raw": [.5, .3, .2], "calibrated": [.6, .3, .1], "decision": [.6, .3, .1]}}
            for variant in variants}}


def fixtures():
    before = [row("shared-one"), row("shared-two", "2024-08-12T03:07:00Z", "2024/2025"),
              row("old-only", "2026-10-26T03:07:00Z", "2026/2027")]
    after = [row("shared-one", extra=True), row("shared-two", "2024-08-12T03:07:00Z", "2024/2025", extra=True),
             row("new-only", "2025-08-11T03:07:00Z", "2025/2026", extra=True)]
    return before, after


class ChallengerSeasonSummaryTests(unittest.TestCase):
    def test_identical_predictions_have_zero_paired_intervals(self):
        before, after = fixtures()
        report = summary.summarize(before, after)
        self.assertTrue(report["retrospectiveOnly"])
        self.assertFalse(report["independentProspectiveEvidence"])
        self.assertEqual(report["newFullCohort"]["n"], 3)
        self.assertEqual(report["cohortCoverage"]["shared"]["n"], 2)
        self.assertEqual(report["cohortCoverage"]["beforeOnly"]["n"], 1)
        self.assertEqual(report["cohortCoverage"]["afterOnly"]["n"], 1)
        self.assertEqual(report["afterOnlyVariants"], ["c906_recipe_retrained"])
        self.assertEqual(report["rawBaselineOnCommonFixtures"]["maxAbsoluteDifference"], 0)
        for variant in report["newFullCohort"]["variants"].values():
            self.assertEqual(variant["fullCohort"]["n"], 3)
            self.assertEqual([m["n"] for m in variant["bySeason"].values()], [1, 1, 1])
            self.assertEqual(variant["byLeague"]["Synthetic League"]["n"], 3)
        for variant in report["commonBeforeAfter"].values():
            self.assertEqual(variant["beforeOnSameFixtures"]["n"], 2)
            self.assertEqual(variant["afterOnSameFixtures"]["n"], 2)
            self.assertEqual(variant["pairedWeekInterval"]["logLoss95"], [0, 0])
            self.assertEqual(variant["pairedWeekInterval"]["brier95"], [0, 0])
            self.assertTrue(all(delta == 0 for delta in variant["delta"].values()))
        self.assertEqual(len(report["newFullCohortComparisons"]), 4)
        for result in report["newFullCohortComparisons"]:
            self.assertEqual(result["pairedWeekInterval"]["logLoss95"], [0, 0])

    def test_analytic_constant_difference_and_quantile_indices(self):
        left = [row("one"), row("two", "2024-01-08T03:07:00Z")]
        right = copy.deepcopy(left)
        for record in right:
            record["predictions"]["no_ml"]["probabilities"] = [.3, .3, .4]
        interval = summary.paired_week_interval(left, right, "no_ml", "no_ml")
        self.assertEqual(interval["quantileIndices"], [12, 487])
        self.assertEqual(interval["seed"], 20261031)
        self.assertEqual(interval["samples"], 500)
        self.assertEqual(interval["blocks"], 2)
        for value in interval["logLoss95"]:
            self.assertAlmostEqual(value, math.log(2))
        for value in interval["brier95"]:
            self.assertAlmostEqual(value, .48)
        self.assertEqual(interval, summary.paired_week_interval(left, right, "no_ml", "no_ml"))

    def test_block_point_estimate_weights_rows_instead_of_equal_week_means(self):
        left = [row(str(i)) for i in range(3)] + [row("other-week", "2024-01-08T03:07:00Z")]
        right = copy.deepcopy(left)
        for record in right[:3]:
            record["predictions"]["no_ml"]["probabilities"] = [.3, .3, .4]
        interval = summary.paired_week_interval(left, right, "no_ml", "no_ml")
        self.assertAlmostEqual(interval["pointEstimate"]["logLoss"], 3 * math.log(2) / 4)
        self.assertAlmostEqual(interval["pointEstimate"]["brier"], 3 * .48 / 4)
        self.assertEqual(interval["n"], 4)

    def test_shared_clock_or_future_label_change_fails(self):
        for patch_value in ({"homeGoals": 0}, {"awayGoals": 2}, {"forecastAt": "2024-01-01T19:00:00Z"},
                            {"kickoffAt": "2024-01-02T18:00:00Z"}, {"competition": "Other League"}):
            with self.subTest(patch=patch_value):
                before, after = fixtures()
                after[0].update(patch_value)
                with self.assertRaisesRegex(ValueError, "conditions changed"):
                    summary.summarize(before, after)

    def test_missing_or_changed_raw_baseline_fails_without_final_fallback(self):
        for side in (0, 1):
            for missing in (False, True):
                with self.subTest(side=side, missing=missing):
                    before, after = fixtures()
                    stages = (before, after)[side][0]["predictions"]["no_ml"]["probabilityStages"]
                    if missing:
                        del stages["raw"]
                    else:
                        stages["raw"] = [.51, .29, .2]
                    with self.assertRaisesRegex(ValueError, "raw baseline"):
                        summary.summarize(before, after)

    def test_calibrated_final_can_change_with_identical_raw(self):
        before, after = fixtures()
        after[0]["predictions"]["no_ml"]["probabilities"] = [.3, .3, .4]
        report = summary.summarize(before, after)
        self.assertEqual(report["rawBaselineOnCommonFixtures"]["maxAbsoluteDifference"], 0)
        self.assertGreater(report["commonBeforeAfter"]["no_ml"]["delta"]["logLoss"], 0)

    def test_missing_seventh_arm_or_partial_controlled_cohort_fails(self):
        before, after = fixtures()
        for record in after:
            del record["predictions"]["c906_recipe_retrained"]
        with self.assertRaisesRegex(ValueError, "seven new arms"):
            summary.summarize(before, after)
        before, after = fixtures()
        del after[0]["predictions"][summary.metrics.ARMS[-1]]
        with self.assertRaisesRegex(ValueError, "same test fixtures"):
            summary.summarize(before, after)

    def test_one_week_does_not_claim_an_informative_interval(self):
        rows = [row("one")]
        interval = summary.paired_week_interval(rows, rows, "no_ml", "no_ml")
        self.assertIsNone(interval["logLoss95"])
        self.assertIsNone(interval["brier95"])
        self.assertEqual(interval["limitation"], "fewer_than_two_observed_week_blocks")
        with self.assertRaisesRegex(ValueError, "at least two draws"):
            summary.paired_week_interval(rows, rows, "no_ml", "no_ml", samples=1)

    def test_cli_bundle_hash_and_new_output_guards(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, records in zip(("before", "after"), fixtures()):
                directory = root / name
                directory.mkdir()
                payload = b"".join(summary.metrics.encode(record) + b"\n" for record in records)
                (directory / "predictions.jsonl").write_bytes(payload)
                (directory / "bundle.json").write_text(json.dumps({"predictionsSha256": summary.metrics.sha256(payload)}), encoding="utf-8")
            options = ["--before", str(root / "before"), "--after", str(root / "after"), "--out", str(root / "summary.json")]
            with patch("builtins.print"):
                self.assertEqual(summary.main(options), 0)
            report = json.loads((root / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual(len(report["newFullCohort"]["variants"]), 7)
            self.assertEqual(len(report["provenance"]["sourceSha256"]), 3)
            self.assertNotIn(str(root), json.dumps(report))
            with self.assertRaisesRegex(ValueError, "must be new"):
                summary.main(options)
            (root / "after/predictions.jsonl").write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                summary.main(options[:-1] + [str(root / "tampered.json")])


if __name__ == "__main__":
    unittest.main()
