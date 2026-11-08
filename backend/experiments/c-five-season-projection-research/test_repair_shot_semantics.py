import copy
import unittest

from repair_shot_semantics import aggregate_shots, repair_matches


def match(match_id="understat_1", season="2020/2021", home=3, away=1):
    return {"matchId": match_id, "season": season, "competition": "Serie A",
            "homeTotalShots": home, "awayTotalShots": away,
            "homeShotsOnTarget": 1, "awayShotsOnTarget": 0,
            "homeGoals": 2, "awayGoals": 0, "homeXG": 0.75, "awayXG": 0.5,
            "homeTeamId": "existing_home", "awayTeamId": "existing_away",
            "date": "2020-09-01T18:00:00.000Z", "archiveProvenance": {"keep": [1, 2]}}


def shot(shot_id, result, side="h", match_id="1"):
    return {"id": shot_id, "match_id": match_id, "h_a": side, "result": result}


class ShotSemanticsRepairTests(unittest.TestCase):
    def test_own_goal_is_excluded_and_all_other_fields_are_exact(self):
        original = [match()]
        before = copy.deepcopy(original)
        rows = [shot("1", "OwnGoal"), shot("2", "Goal"), shot("3", "SavedShot"), shot("4", "OwnGoal", "a")]
        repaired, audit = repair_matches(original, aggregate_shots(rows))
        self.assertEqual((repaired[0]["homeTotalShots"], repaired[0]["awayTotalShots"]), (2, 0))
        self.assertEqual(original, before)
        for key in before[0]:
            if key not in ("homeTotalShots", "awayTotalShots"):
                self.assertEqual(repaired[0][key], before[0][key])
        self.assertEqual(repaired[0].keys(), before[0].keys())
        self.assertEqual(audit["summary"]["ownGoalEventsExcluded"], 2)
        self.assertEqual(audit["summary"]["changedMatches"], 1)

    def test_non_own_goal_events_remain_unchanged(self):
        original = [match(home=2, away=1)]
        rows = [shot("1", "MissedShots"), shot("2", "SavedShot"), shot("3", "BlockedShot", "a")]
        repaired, audit = repair_matches(original, aggregate_shots(rows))
        self.assertEqual(repaired, original)
        self.assertEqual(audit["changedMatches"], [])

    def test_2018_null_shot_fields_and_row_order_are_preserved(self):
        old = match("understat_9", "2018/2019", None, None)
        old["homeShotsOnTarget"] = old["awayShotsOnTarget"] = None
        original = [old, match(home=1, away=0)]
        repaired, _ = repair_matches(original, aggregate_shots([shot("1", "Goal")]))
        self.assertEqual(repaired, original)

    def test_duplicate_ids_are_rejected_even_if_numeric_spelling_differs(self):
        with self.assertRaisesRegex(ValueError, "duplicate_shot_id"):
            aggregate_shots([shot("1", "Goal"), shot("1.0", "Goal")])

    def test_duplicate_match_ids_and_unmatched_source_ids_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "duplicate_input_match_id"):
            repair_matches([match(), match()], {})
        with self.assertRaisesRegex(ValueError, "shot_match_ids_do_not_equal_target_ids"):
            repair_matches([match()], aggregate_shots([shot("1", "Goal", match_id="2")]))

    def test_old_count_drift_and_negative_new_bounds_are_rejected(self):
        counts = aggregate_shots([shot("1", "OwnGoal")])
        with self.assertRaisesRegex(ValueError, "old_total_shots_do_not_equal_verified_raw_event_count"):
            repair_matches([match(home=2, away=0)], counts)
        with self.assertRaisesRegex(ValueError, "preserved_on_target_shots_outside_corrected_total_bounds"):
            repair_matches([match(home=1, away=0)], counts)


if __name__ == "__main__":
    unittest.main()
