import copy
from pathlib import Path
import sys
import unittest
import json
import os
import subprocess

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import diagnose


class DiagnosticProtocolTests(unittest.TestCase):
    def test_protected_final_rows_are_never_relabelled_as_development(self):
        rows = [{"matchId": str(i), "forecastAt": f"2026-01-0{i + 1}T00:00:00Z"} for i in range(4)]
        original = {"finalHoldout": {"version": "protected", "testN": 2}, "predictions": [
            {**rows[2], "versionC": "protected"}, {**rows[3], "versionC": "protected"}]}
        development, protected, _ = diagnose.protected_development_rows({"rows": rows}, original)
        self.assertEqual([row["matchId"] for row in development], ["0", "1"])
        self.assertEqual(protected, ["2", "3"])
        original["finalHoldout"]["testN"] = 3
        with self.assertRaisesRegex(ValueError, "identity_mismatch"):
            diagnose.protected_development_rows({"rows": rows}, original)

    def test_masking_is_explicit_and_does_not_modify_frozen_input(self):
        rows = [{"features": [1, 2, 3]}]
        saved = copy.deepcopy(rows)
        self.assertEqual(diagnose.masked(rows, [0, 2])[0]["features"], [1, 0, 3])
        self.assertEqual(rows, saved)

    def test_later_selection_cannot_choose_an_earlier_reduced_mask(self):
        names = ["lambda_home_A", "signal", "later_signal"]
        groups = {"basic": [0], "signal": [1], "later": [2]}
        utility = {"signal": [.1, .1, .1], "later": [-.1, .2, .2]}
        evidence = [{"fold": i, "feature": feature, "weekLogLossCI": [lower, .3]}
                    for i, feature, lower in ((0, "signal", .1), (1, "signal", .1), (1, "later_signal", .1), (2, "later_signal", .1))]
        groups_before, features_before = diagnose.chronological_reduced_masks(names, groups, utility, evidence, [0, 1, 2])
        self.assertEqual(features_before[0], [0, 1])
        self.assertEqual(features_before[2], [0, 1, 2])
        poisoned = evidence + [{"fold": 2, "feature": "signal", "weekLogLossCI": [-10, -1]}]
        groups_after, features_after = diagnose.chronological_reduced_masks(names, groups, {"signal": [.1, .1, -100], "later": [-.1, .2, 100]}, poisoned, [0, 1, 2])
        self.assertEqual(features_before[0], features_after[0])
        self.assertEqual(features_before[1], features_after[1])
        self.assertEqual(groups_before[0], groups_after[0])
        self.assertEqual(groups_before[1], groups_after[1])

    def test_zero_ml_weight_is_identity_and_joint_projection_is_coherent(self):
        matrices = np.array([[[.2, .3], [.4, .1]]])
        other = np.array([[[.4, .1], [.2, .3]]])
        self.assertTrue(np.allclose(diagnose.mix(matrices, other, 0, 1), matrices))
        target = np.array([[.5, .2, .3]])
        changed = diagnose.project(matrices, target)
        self.assertTrue(np.allclose(diagnose.probabilities(changed), target))
        self.assertAlmostEqual(float(changed.sum()), 1)
        self.assertTrue((changed >= 0).all())

    def test_isotonic_fit_is_monotonic_and_returns_a_simplex(self):
        points = diagnose.fit_isotonic([.2, .3, .4, .6, .7, .8] * 10, [0, 1, 0, 1, 0, 1] * 10)
        self.assertTrue(all(a[1] <= b[1] for a, b in zip(points[:-1], points[1:])))
        result = diagnose.apply_isotonic(np.array([[.2, .3, .5]]), points, 60)
        self.assertAlmostEqual(float(result.sum()), 1)
        self.assertTrue((result > 0).all())

    def test_metric_definitions_keep_classwise_and_top_label_ece_separate(self):
        rows = [{"homeGoals": 1, "awayGoals": 0, "competition": "Serie A", "season": "test"},
                {"homeGoals": 0, "awayGoals": 1, "competition": "Serie A", "season": "test"}]
        result = diagnose.metric(rows, [[.5, .2, .3], [.4, .1, .5]])
        self.assertEqual(result["n"], 2)
        self.assertAlmostEqual(result["logLoss"], -np.log(.5))
        self.assertAlmostEqual(result["topLabelEce"], .5)
        self.assertNotEqual(result["classwisePooledEce"], result["topLabelEce"])

    def test_pushes_and_half_outcomes_have_effective_stake_denominators(self):
        rows = [{"homeGoals": 0, "awayGoals": 0}, {"homeGoals": 0, "awayGoals": 1}]
        matrix = np.array([[[.5, .5], [0, 0]]] * 2)
        result = diagnose.market_metrics(rows, matrix)
        self.assertEqual(result["asian_handicap_home_0"]["n"], 1)
        self.assertEqual(result["asian_handicap_home_0.25"]["effectiveStakeSamples"], 1.5)
        self.assertEqual(result["dnb_home"]["n"], 1)

    def test_dedicated_calibrator_matches_typescript_joint_pipeline(self):
        # The isolated build is created by the backend tests; no mock calibrator.
        backend = Path(__file__).resolve().parents[2]
        module = Path(os.environ.get("RESEARCH_COHERENT_MODULE", backend / "dist/research/CoherentProbabilityPipeline.js"))
        if not module.exists():
            module = backend / "artifacts/coherent-probability-test/research/CoherentProbabilityPipeline.js"
        if not module.exists():
            self.skipTest("Build the backend coherent pipeline before the parity check")
        rng = np.random.default_rng(42)
        p = rng.dirichlet([2, 2, 2], 80)
        rows = [{"matchId": f"test-{i:03}", "homeGoals": int(i % 3 == 0), "awayGoals": int(i % 3 == 2)} for i in range(80)]
        profile = diagnose.isotonic_profile(rows, p)
        observations = [{"matchId": row["matchId"], "availableAt": "2025-01-01T00:00:00Z",
                         "probabilities": dict(zip(("homeWin", "draw", "awayWin"), values)),
                         "outcomes": dict(zip(("homeWin", "draw", "awayWin"), np.eye(3)[diagnose.trainer.class_of(row)].astype(int).tolist()))}
                        for row, values in zip(rows, p)]
        matrix = np.array([[[.2, .3], [.4, .1]]])
        payload = {"observations": observations, "asOf": "2025-01-02T00:00:00Z", "matrix": matrix[0].tolist()}
        environment = {**os.environ, "RESEARCH_COHERENT_MODULE": str(module.resolve())}
        result = subprocess.run(["node", str(backend / "ml/diagnostics/verify_calibration.cjs")],
                                input=json.dumps(payload), text=True, capture_output=True, env=environment, check=True)
        actual = json.loads(result.stdout)
        expected = diagnose.apply_isotonic(diagnose.probabilities(matrix), profile["points"], profile["nObservations"])
        self.assertTrue(np.allclose(actual["probabilities"], expected[0], atol=1e-12))
        self.assertTrue(np.allclose(actual["matrix"], diagnose.project(matrix, expected)[0], atol=1e-12))


if __name__ == "__main__":
    unittest.main()
