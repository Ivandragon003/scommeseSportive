import importlib.util
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("audit_comparison", Path(__file__).parents[2] / "scripts" / "compare-challenger-audit-bundles.py")
comparison = importlib.util.module_from_spec(spec)
spec.loader.exec_module(comparison)


def row(match_id, **patch):
    return {"matchId": match_id, "competition": "Serie A", "kickoffAt": "2026-10-20T18:00:00Z",
            "forecastAt": "2026-10-20T01:07:00Z", "homeGoals": 1, "awayGoals": 0,
            "phase": "development", "predictions": {arm: {"probabilities": [.6, .3, .1]} for arm in comparison.metrics.ARMS}, **patch}


class CommonCohortTests(unittest.TestCase):
    def test_same_predictions_on_retained_fixtures_have_zero_deltas(self):
        result = comparison.compare([row("one"), row("two")], [row("two")])
        self.assertEqual(result["cohortMatches"], 1)
        for variant in result["variants"].values():
            self.assertEqual(variant["removedOriginalTestIds"], ["one"])
            self.assertTrue(all(value == 0 for value in variant["delta"].values()))

    def test_changed_conditions_or_different_arm_cohorts_cannot_be_compared(self):
        for patch in ({"forecastAt": "2026-10-20T17:00:00Z"}, {"homeGoals": 0}, {"kickoffAt": "2026-10-21T18:00:00Z"}):
            with self.assertRaisesRegex(ValueError, "conditions changed"):
                comparison.compare([row("one")], [row("one", **patch)])
        changed = row("one")
        del changed["predictions"][comparison.metrics.ARMS[0]]
        with self.assertRaisesRegex(ValueError, "no paired test"):
            comparison.compare([row("one")], [changed])

    def test_common_only_uses_shared_predictions_and_discloses_all_ids(self):
        old, new = row("shared"), row("shared")
        for prediction in new["predictions"].values():
            prediction["probabilities"] = [.2, .3, .5]
        before, after = [row("old-only"), old], [new, row("new-only")]
        with self.assertRaisesRegex(ValueError, "subset"):
            comparison.compare(before, after)
        result = comparison.compare(before, after, common_only=True)
        self.assertEqual(result["comparisonMode"], "common_intersection_only")
        self.assertEqual(result["cohortMatches"], 1)
        for scope, expected in (("before", ["old-only", "shared"]), ("after", ["new-only", "shared"]),
                                ("shared", ["shared"]), ("beforeOnly", ["old-only"]), ("afterOnly", ["new-only"])):
            self.assertEqual(result["cohortCoverage"][scope], {
                "n": len(expected), "ids": expected,
                "idsSha256": comparison.metrics.sha256(comparison.metrics.encode(expected))})
        for variant in result["variants"].values():
            self.assertEqual(variant["beforeOnSameFixtures"]["n"], 1)
            self.assertEqual(variant["afterOnSameFixtures"]["n"], 1)
            self.assertAlmostEqual(variant["delta"]["logLoss"], math.log(3))
            self.assertAlmostEqual(variant["delta"]["brier"], .72)
            self.assertEqual(variant["delta"]["accuracy"], -1)
            self.assertEqual(variant["removedOriginalTestIds"], ["old-only"])
            self.assertEqual(variant["addedUpdatedTestIds"], ["new-only"])
        # Unshared extreme predictions must not change any paired metric.
        for prediction in before[0]["predictions"].values():
            prediction["probabilities"] = [0, 0, 1]
        for prediction in after[1]["predictions"].values():
            prediction["probabilities"] = [1, 0, 0]
        self.assertEqual(result, comparison.compare(before, after, common_only=True))

    def test_common_only_rejects_lost_arm_even_outside_intersection(self):
        for side in ("before", "after"):
            before, after = [row("shared"), row("old-only")], [row("shared"), row("new-only")]
            selected = before if side == "before" else after
            del selected[1]["predictions"][comparison.metrics.ARMS[-1]]
            with self.assertRaisesRegex(ValueError, "same test fixtures in " + side):
                comparison.compare(before, after, common_only=True)

    def test_common_only_rejects_changed_shared_conditions_and_no_overlap(self):
        for changes in ({"forecastAt": "2026-10-20T17:00:00Z"}, {"homeGoals": 0}, {"awayGoals": 2},
                        {"kickoffAt": "2026-10-21T18:00:00Z"}, {"competition": "La Liga"}, {"phase": "independent_period"}):
            with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, "conditions changed"):
                comparison.compare([row("shared"), row("old-only")], [row("shared", **changes), row("new-only")], common_only=True)
        with self.assertRaisesRegex(ValueError, "no paired test"):
            comparison.compare([row("one")], [row("two")], common_only=True)
        with self.assertRaisesRegex(ValueError, "duplicate fixture"):
            comparison.compare([row("one"), row("one")], [row("one")], common_only=True)

    def test_default_subset_protocol_has_no_intersection_metadata(self):
        result = comparison.compare([row("one"), row("two")], [row("two")])
        self.assertNotIn("comparisonMode", result)
        self.assertNotIn("cohortCoverage", result)
        self.assertEqual(result["schemaVersion"], "independent-c-before-after-common-cohort-v1")
        self.assertTrue(all("addedUpdatedTestIds" not in value for value in result["variants"].values()))

    def test_cli_common_only_is_explicit(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name, rows in (("before", [row("shared"), row("old-only")]), ("after", [row("shared"), row("new-only")])):
                directory = root / name
                directory.mkdir()
                payload = b"".join(comparison.metrics.encode(value) + b"\n" for value in rows)
                (directory / "predictions.jsonl").write_bytes(payload)
                (directory / "bundle.json").write_text(json.dumps({"predictionsSha256": comparison.metrics.sha256(payload)}), encoding="utf-8")
            options = ["--before", str(root / "before"), "--after", str(root / "after"), "--out", str(root / "comparison.json")]
            with self.assertRaisesRegex(ValueError, "subset"):
                comparison.main(options)
            self.assertFalse((root / "comparison.json").exists())
            with patch("builtins.print"):
                comparison.main(options + ["--common-only"])
            report = json.loads((root / "comparison.json").read_text(encoding="utf-8"))
            self.assertEqual(report["cohortMatches"], 1)
            self.assertEqual(report["cohortCoverage"]["beforeOnly"]["n"], 1)

    def test_new_diagnostic_has_no_invented_before_after_comparison(self):
        before, after = [row("shared"), row("old-only")], [row("shared"), row("new-only")]
        diagnostic = "c906_recipe_retrained"
        for record in after:
            record["predictions"][diagnostic] = {"probabilities": [.9, .05, .05]}
        # Legacy C906 references have distinct availability and are not candidates.
        before[0]["predictions"]["C906_reconstructed"] = {"probabilities": [.8, .1, .1]}
        result = comparison.compare(before, after, common_only=True)
        self.assertEqual(result["afterOnlyVariants"], [diagnostic])
        self.assertEqual(result["beforeOnlyVariants"], [])
        self.assertEqual(set(result["comparedVariantIds"]), set(comparison.metrics.ARMS))
        self.assertEqual(len(result["beforeVariantIds"]), 6)
        self.assertEqual(len(result["afterVariantIds"]), 7)
        self.assertNotIn(diagnostic, result["variants"])
        self.assertNotIn("C906_reconstructed", result["variants"])
        self.assertTrue(all(value["n"] == 1 for value in result["variants"].values()))
        before[0]["predictions"][diagnostic] = {"probabilities": [.9, .05, .05]}
        with self.assertRaisesRegex(ValueError, "variant must share the controlled test fixtures in before"):
            comparison.compare(before, after, common_only=True)
        before[1]["predictions"][diagnostic] = {"probabilities": [.9, .05, .05]}
        result = comparison.compare(before, after, common_only=True)
        self.assertEqual(result["afterOnlyVariants"], [])
        self.assertIn(diagnostic, result["variants"])
        self.assertEqual(result["variants"][diagnostic]["n"], 1)


if __name__ == "__main__":
    unittest.main()
