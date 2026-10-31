import importlib.util
from pathlib import Path
import unittest

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


if __name__ == "__main__":
    unittest.main()
