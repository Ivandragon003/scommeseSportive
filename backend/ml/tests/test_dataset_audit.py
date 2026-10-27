import importlib.util
from pathlib import Path
import unittest

MODULE = Path(__file__).parents[1] / "diagnostics" / "dataset_audit.py"
spec = importlib.util.spec_from_file_location("dataset_audit", MODULE)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class DatasetAuditTests(unittest.TestCase):
    def test_metrics_distinguish_ece_definitions_and_reproduce_probability_scores(self):
        import numpy as np
        rows = [{"homeGoals": 1, "awayGoals": 0}, {"homeGoals": 0, "awayGoals": 0}]
        probabilities = [np.array([.6, .3, .1]), np.array([.4, .5, .1])]
        metrics = audit.metrics(rows, probabilities)
        self.assertAlmostEqual(metrics["logLoss"], (-__import__("math").log(.6) - __import__("math").log(.5)) / 2)
        self.assertAlmostEqual(metrics["brier"], (.26 + .42) / 2)
        self.assertNotEqual(metrics["ece"], audit.metrics(rows, probabilities, "all_classes")["ece"])

    def test_feature_profile_detects_constants_redundancy_and_missingness(self):
        result = audit.profile_features({"featureNames": ["constant", "x", "twice_x", "missing"], "rows": [
            {"features": [1, i, 2 * i, float("nan") if i == 0 else i], "season": "test"} for i in range(5)]})
        self.assertEqual(result["constant"], ["constant"])
        self.assertEqual(result["columns"][-1]["missingOrNonFinite"], 1)
        self.assertTrue(any(row["left"] == "x" and row["right"] == "twice_x" for row in result["highCorrelationAbsAtLeast098"]))
        __import__("json").dumps(result, allow_nan=False)

    def test_protected_ids_hash_is_order_independent(self):
        self.assertEqual(audit.ids_hash(["b", "a"]), audit.ids_hash(["a", "b"]))

    def test_structural_feature_dependence_and_cold_start_priors_are_reported_separately(self):
        result = audit.profile_features({"featureNames": ["home_elo", "away_elo", "elo_difference", "league_0", "league_1", "home_sample", "home_xg_coverage"],
                                         "rows": [{"features": [1500, 1400, 100, 1, 0, 0, 0], "season": "s"},
                                                  {"features": [1600, 1500, 100, 0, 1, 4, 1], "season": "s"}]})
        self.assertEqual(len(result["structuralRedundancies"]), 2)
        self.assertTrue(all(item["verifiedWithinTolerance"] for item in result["structuralRedundancies"]))
        self.assertEqual(result["xgCoveragePriorCounts"]["home"]["coldStartRows"], 1)
        self.assertEqual(result["xgCoveragePriorCounts"]["home"]["positiveSampleIncompleteXgCoverageRows"], 0)

    def test_temporal_replay_ignores_unavailable_and_future_outcomes(self):
        feature_names = [str(i) for i in range(35)]
        raw = [{"matchId": "unavailable", "homeTeamId": "h", "awayTeamId": "a", "date": "2026-01-01T11:00:00Z", "season": "s",
                "homeGoals": 9, "awayGoals": 0}]
        initial_side = [1500, 0, 1.3, 1.3, 1.3, 1.3, 0, 0, 0, 0, 0, 1.3, 1.3, 60, 1.3, 1.3]
        row = {"matchId": "target", "homeTeamId": "h", "awayTeamId": "a", "forecastAt": "2026-01-01T12:00:00Z",
               "season": "s", "lambdaHome": 1.2, "lambdaAway": .9, "features": initial_side + initial_side + [0, 1.2, .9]}
        result = audit.verify_temporal_features({"featureNames": feature_names, "rows": [row]}, raw)
        self.assertEqual(result["discrepancyCounts"], {})
        row["features"][2] = 9
        result = audit.verify_temporal_features({"featureNames": feature_names, "rows": [row]}, raw)
        self.assertEqual(result["discrepancyCounts"], {"2": 1})


if __name__ == "__main__":
    unittest.main()
