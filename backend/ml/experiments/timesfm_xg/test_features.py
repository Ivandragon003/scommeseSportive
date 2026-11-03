"""Synthetic guards for information availability, not predictive evidence."""
import copy
import unittest

import features


def match(identity, day, **extra):
    return {"matchId": identity, "date": f"2023-01-{day:02}T12:00:00Z", "competition": "L",
            "homeTeamId": "h", "awayTeamId": "a", "homeGoals": 1, "awayGoals": 0,
            "homeXG": float(day), "awayXG": float(day) / 2, **extra}


class FeatureTests(unittest.TestCase):
    def setUp(self):
        self.protocol = {"context": 3, "minimumHistory": 2, "wmaHalfLifeMatches": 5}
        self.dataset = {"featureNames": ["home_xg_for", "home_xg_against", "away_xg_for", "away_xg_against"],
                        "rows": [{"matchId": "target", "competition": "L", "homeTeamId": "h", "awayTeamId": "a",
                                  "forecastAt": "2023-01-08T14:00:00Z", "kickoffAt": "2023-01-08T18:00:00Z",
                                  "features": [1.1, 1.2, 1.3, 1.4]}]}

    def test_forbidden_identity_filtered_before_any_values_are_read(self):
        index = features.history_index([{"matchId": "protected"}, {"matchId": "quarantined"}],
                                       {"protected"}, {"quarantined"})
        self.assertEqual(dict(index), {})

    def test_future_boundary_late_availability_target_and_other_league_excluded(self):
        history = [match("m1", 1), match("m2", 2), match("m3", 3), match("m4", 4),
                   match("late", 5, availableAt="2023-01-09T12:00:00Z"), match("equal", 8),
                   match("future", 9), match("target", 7), match("other", 6, competition="Other")]
        # Target itself is not a permitted history identity even with an incorrect earlier date.
        with self.assertRaisesRegex(ValueError, "future_context"):
            features.build_contexts(self.dataset, history, set(), set(), self.protocol)
        history = [m for m in history if m["matchId"] != "target"]
        contexts, rows, _ = features.build_contexts(self.dataset, history, set(), set(), self.protocol)
        self.assertEqual(rows[0]["history"][0]["ids"], ["m2", "m3", "m4"])
        self.assertTrue(all(c["ids"] == ["m2", "m3", "m4"] for c in contexts.values()))
        mutated = copy.deepcopy(history)
        for m in mutated:
            if m["matchId"] in {"late", "equal", "future", "other"}:
                m["homeXG"], m["awayXG"] = 99999, 99999
        self.assertEqual((contexts, rows), features.build_contexts(self.dataset, mutated, set(), set(), self.protocol)[:2])

    def test_short_history_same_fallback_both_arms_and_missing_xg_not_goals(self):
        contexts, rows, fallbacks = features.build_contexts(self.dataset, [match("one", 1), match("missing", 2, homeXG=None)],
                                                          set(), set(), self.protocol)
        self.assertEqual(contexts, {})
        self.assertEqual(fallbacks, 2)
        self.assertEqual(rows[0]["wma"], [1.1, 1.2, 1.3, 1.4])
        self.assertEqual(rows[0]["timesfm"], rows[0]["wma"])

    def test_weighted_mean_known_half_life(self):
        self.assertAlmostEqual(features.weighted_mean([1, 3], half_life=1), 7 / 3)

    def test_duplicate_source_and_forbidden_target_fail(self):
        with self.assertRaisesRegex(ValueError, "duplicate_source_identity"):
            features.history_index([match("duplicate", 1), match("duplicate", 2)], set(), set())
        with self.assertRaisesRegex(ValueError, "forbidden_target"):
            features.build_contexts(self.dataset, [], {"target"}, set(), self.protocol)


if __name__ == "__main__":
    unittest.main()
