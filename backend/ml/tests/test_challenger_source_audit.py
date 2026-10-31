"""The source audit runs without providers or credentials in these fixtures."""
import gzip
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[2] / "scripts/audit-challenger-sources.py"
SPEC = importlib.util.spec_from_file_location("challenger_source_audit", SCRIPT)
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)


def row(match_id="understat_1"):
    return {"matchId": match_id, "competition": "Premier League", "season": "2025/2026",
            "homeTeamId": "home", "awayTeamId": "understat_team_2", "date": "2025-08-15T19:00:00Z",
            "homeGoals": 2, "awayGoals": 1, "homeXG": 1.25, "awayXG": .75,
            "homeTotalShots": 10, "awayTotalShots": 8, "homeShotsOnTarget": 4, "awayShotsOnTarget": 2}


def source():
    return {"competition": "Premier League", "season": "2025/2026", "understat": {"dates": [{
        "id": "1", "h": {"id": "1", "title": "Home"}, "a": {"id": "2", "title": "Away"},
        "datetime": "2025-08-15 19:00:00", "isResult": True,
        "goals": {"h": "2", "a": "1"}, "xG": {"h": "1.25", "a": ".75"}}]},
        "csvRows": [{"_date": "2025-08-15", "HomeTeam": "Home", "AwayTeam": "Away",
                     "FTHG": "2", "FTAG": "1", "HS": "11", "AS": "8", "HST": "4", "AST": "2"}]}


class SourceAuditTests(unittest.TestCase):
    def test_benchmark_rejects_unknown_schemas_and_empty_cohorts(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "benchmark.json"
            invalid = [{}, {"unrecognized": [row()]}, [], {"predictions": []}, {"rows": []},
                       {"records": [{**row(), "predictions": {}}]}, {"predictions": [{"matchId": "unknown"}]},
                       {"predictions": [row()], "records": [row()]}]
            for value in invalid:
                with self.subTest(value=value):
                    path.write_text(json.dumps(value), encoding="utf8")
                    with self.assertRaises(ValueError):
                        AUDIT.load_benchmark(path)

    def test_comparison_records_select_only_matches_with_nonempty_predictions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "benchmark.json"
            predicted = {**row(), "predictions": {"no_ml": {"probabilities": [.5, .3, .2]}}}
            records = [predicted, {**row("understat_2"), "predictions": {}}]
            path.write_text(json.dumps({"records": records}), encoding="utf8")
            targets, evidence = AUDIT.load_benchmark(path)
            self.assertEqual([target["matchId"] for target in targets], ["understat_1"])
            self.assertEqual(evidence["inputRecords"], 2)
            self.assertEqual(evidence["excludedWithoutPredictions"], 1)
            self.assertEqual(evidence["format"], "records")

    def test_public_metric_bundle_verifies_decoded_jsonl_hash_and_size_before_using_cohort(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            records = [{**row(), "predictions": {"no_ml": {"probabilities": [.5, .3, .2]}}},
                       {**row("understat_2"), "predictions": {}}]
            payload = ("\n".join(json.dumps(record) for record in records) + "\n").encode("utf8")
            compressed = gzip.compress(payload)
            (root / "predictions.jsonl.gz").write_bytes(compressed)
            manifest = {"schemaVersion": "independent-challenger-metrics-audit-v1",
                        "predictionsFile": "predictions.jsonl.gz", "predictionsBytes": len(payload),
                        "predictionsSha256": AUDIT.sha256(payload)}
            path = root / "bundle.json"
            path.write_text(json.dumps(manifest), encoding="utf8")
            targets, evidence = AUDIT.load_benchmark(path)
            self.assertEqual(len(targets), 1)
            self.assertEqual(evidence["predictionsSha256"], AUDIT.sha256(payload))
            self.assertEqual(evidence["predictionsFileSha256"], AUDIT.sha256(compressed))
            self.assertEqual(evidence["excludedWithoutPredictions"], 1)
            for change, message in [({"predictionsSha256": "0" * 64}, "Sha256 mismatch"),
                                    ({"predictionsBytes": len(payload) + 1}, "Bytes mismatch"),
                                    ({"schemaVersion": "unknown-v1"}, "Unknown benchmark bundle schema"),
                                    ({"predictionsFile": "../outside.gz"}, "stay inside")]:
                with self.subTest(change=change):
                    path.write_text(json.dumps({**manifest, **change}), encoding="utf8")
                    with self.assertRaisesRegex(ValueError, message):
                        AUDIT.load_benchmark(path)

    def test_embedded_json_is_decoded_without_executing_javascript(self):
        encoded = "".join("\\x" + format(character, "02x") for character in b'[{"id":"1"}]')
        result = AUDIT.embedded_league_data("var datesData = JSON.parse('" + encoded + "');")
        self.assertEqual(result["dates"], [{"id": "1"}])
        self.assertIsNone(AUDIT.embedded_league_data("window.datesData = dangerous_function();"))
        self.assertEqual(AUDIT.decode_javascript_string(r"a\'b\n\u00e9"), "a'b\né")

    def test_naive_datetime_remains_naive_and_does_not_certify_utc(self):
        parsed = AUDIT.source_datetime("2025-08-15 19:00:00")
        self.assertIsNone(parsed["datetime"].tzinfo)
        result = AUDIT.compare_sources([row()], [source()], {"understat_1"}, {})
        self.assertEqual(result["coverage"]["benchmark"]["understatTimezoneUndeclared"], 1)
        self.assertEqual(result["coverage"]["all"]["understatWallClockEqualButInstantUnverified"], 1)
        self.assertNotIn("understatInstantVerified", result["coverage"]["all"])

    def test_primary_stats_are_compared_without_replacing_them_or_forcing_date_matching(self):
        original = row()
        result = AUDIT.compare_sources([original], [source()], {"understat_1"}, {})
        difference = result["differences"][0]
        self.assertEqual(difference["kind"], "football_data_statistic_difference_primary_may_differ")
        self.assertEqual(difference["field"], "homeTotalShots")
        self.assertEqual(original["homeTotalShots"], 10)
        changed = source()
        changed["csvRows"][0]["_date"] = "2025-08-16"
        result = AUDIT.compare_sources([original], [changed], set(), {})
        self.assertEqual(result["coverage"]["all"]["footballDataNotMatched"], 1)
        self.assertNotIn("footballDataMatched", result["coverage"]["all"])
        self.assertEqual(result["footballDataUnmatched"][0]["sameTeamsCsvAlternatives_DIAGNOSTIC_ONLY"][0]["date"], "2025-08-16")

    def test_profile_distinguishes_missing_registry_from_proven_orphans(self):
        original = row()
        original.update({"homeShotsOnTarget": 12, "awayGoals": -1, "homeXG": float("inf")})
        result = AUDIT.profile([original, original.copy()], {"understat_1"})
        self.assertEqual(result["duplicateMatchIds"][0]["count"], 2)
        self.assertEqual(result["issueCounts"]["shots_on_target_exceeds_shots"], 2)
        self.assertEqual(result["orphanTeamCheck"], "not_verifiable_without_team_registry")
        result = AUDIT.profile([original], set(), [{"team_id": "home"}])
        self.assertEqual(result["issueCounts"]["orphan_team_id"], 1)
        json.dumps(result, allow_nan=False)

    def test_registry_and_local_id_collisions_are_explicit(self):
        second = row("understat_3")
        data = source()
        extra = dict(data["understat"]["dates"][0])
        extra.update({"id": "3", "h": {"id": "3", "title": "Another Home"}})
        data["understat"]["dates"].append(extra)
        result = AUDIT.compare_sources([row(), second], [data], set(), {},
                                       [{"team_id": "home", "source_team_id": 1}])
        self.assertEqual(result["localIdentityCollisions"][0]["understatTeamIds"], {"1": 1, "3": 1})
        self.assertEqual(result["differenceCounts"]["registered_source_team_id_mismatch"], 1)

    def test_cache_keeps_raw_gzip_hash_and_captured_time_and_detects_tampering(self):
        raw = gzip.compress(b'{"dates":[]}')
        class Response:
            status = 200
            headers = {"Content-Type": "application/json", "Content-Encoding": "gzip"}
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def read(self): return raw
            def geturl(self): return "https://understat.com/getLeagueData/epl/2025"
        with tempfile.TemporaryDirectory() as directory:
            cache = AUDIT.HttpCache(pathlib.Path(directory))
            url = "https://understat.com/getLeagueData/epl/2025"
            with patch.object(AUDIT.urllib.request, "urlopen", return_value=Response()) as fetch:
                text, metadata = cache.fetch(url, "understat_league_json")
                self.assertEqual(json.loads(text), {"dates": []})
                self.assertEqual(metadata["rawSha256"], AUDIT.sha256(raw))
                capture_time = metadata["capturedAt"]
                self.assertEqual(cache.fetch(url, "understat_league_json")[1]["capturedAt"], capture_time)
                self.assertEqual(fetch.call_count, 1)
            pathlib.Path(metadata["rawFile"]).write_bytes(b"modified")
            with self.assertRaisesRegex(ValueError, "hash or identity mismatch"):
                cache.fetch(url, "understat_league_json")

    def test_offline_cache_miss_never_calls_network(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(AUDIT.urllib.request, "urlopen", side_effect=AssertionError("no network")):
                text, metadata = AUDIT.HttpCache(pathlib.Path(directory), offline=True).fetch(
                    "https://understat.com/league/EPL/2025", "understat_league_html")
                self.assertIsNone(text)
                self.assertEqual(metadata["status"], "not_cached")

    def test_original_legacy_html_charset_is_preserved_and_disclosed(self):
        raw = '<html><meta charset="iso-8859-1">f\xe9vrier</html>'.encode("latin1")
        class Response:
            status = 200
            headers = {"Content-Type": "text/html"}
            def __enter__(self): return self
            def __exit__(self, *args): return None
            def read(self): return raw
            def geturl(self): return "https://example.com/club"
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(AUDIT.urllib.request, "urlopen", return_value=Response()):
                text, metadata = AUDIT.HttpCache(pathlib.Path(directory)).fetch("https://example.com/club", "official_club")
                self.assertIn("février", text)
                self.assertEqual(metadata["decodedEncoding"], "iso-8859-1")
                self.assertEqual(metadata["rawSha256"], AUDIT.sha256(raw))

    def test_current_export_drift_compares_identical_fields_after_normalization(self):
        old = row()
        raw_current = {"match_id": "understat_1", "home_team_id": "home", "home_goals": 3,
                       "home_corners": 6}
        result = AUDIT.snapshot_drift([old], AUDIT.normalize_database_rows([raw_current]))
        self.assertEqual(result["changedMatches"], 1)
        self.assertEqual(result["fieldCounts"], {"homeGoals": 1})
        self.assertEqual(result["differences"][0]["current"], 3)

    def test_primary_detail_sample_uses_real_shot_results_and_does_not_complete_missing_rosters(self):
        original = row()
        original.update({"homeTotalShots": 3, "homeShotsOnTarget": 2,
                         "awayTotalShots": 0, "awayShotsOnTarget": 0,
                         "homeYellowCards": 1, "awayYellowCards": 0,
                         "homeRedCards": 0, "awayRedCards": 0})
        roster = {str(index): {"yellow_card": "0", "red_card": "0"} for index in range(11)}
        payload = {"shots": {"h": [{"result": "Goal"}, {"result": "SavedShot"}, {"result": "MissedShots"}], "a": []},
                   "rosters": {"h": {**roster, "0": {"yellow_card": "1", "red_card": "0"}}, "a": roster}}
        class Cache:
            def fetch(self, *args): return json.dumps(payload), {"status": 200}
        comparison = {"differences": []}
        result = AUDIT.primary_detail_sample([original], comparison, {"understat_1"}, 1, Cache(), 1)
        self.assertEqual(result["verifiedMatches"], 1)
        self.assertEqual(result["comparedFields"], 8)
        self.assertEqual(result["differingFields"], 0)
        self.assertFalse(result["sampleRepresentative"])
        payload["rosters"]["h"] = {}
        result = AUDIT.primary_detail_sample([original], comparison, {"understat_1"}, 1, Cache(), 1)
        self.assertEqual(result["verifiedMatches"], 0)
        self.assertEqual(result["comparedFields"], 0)
        self.assertIn("Missing shots or complete roster", result["matches"][0]["error"])

    def test_report_reproduces_offline_and_keeps_curated_clock_conflicts_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            matches, benchmark, clocks = root / "matches.json", root / "benchmark.json", root / "clocks.json"
            matches.write_text(json.dumps([row()]), encoding="utf8")
            benchmark.write_text(json.dumps({"predictions": [{**row(), "kickoffAt": row()["date"]}]}), encoding="utf8")
            clocks.write_text(json.dumps({"matches": [{"matchId": "understat_1", "forecastAfterOfficialKickoff": True}]}), encoding="utf8")
            args = ["--matches", str(matches), "--benchmark", str(benchmark), "--out", str(root / "out"),
                    "--max-pairs", "0", "--offline", "--clock-evidence", str(clocks), "--related-evidence", str(clocks)]
            with patch.object(AUDIT.urllib.request, "urlopen", side_effect=AssertionError("no network")):
                with patch("builtins.print"):
                    first, second = AUDIT.main(args), AUDIT.main(args)
            self.assertEqual(first["comparison"], second["comparison"])
            self.assertEqual(first["inputSha256"], second["inputSha256"])
            self.assertEqual(first["benchmarkDatasetConsistency"]["changedMatches"], 0)
            self.assertEqual(first["relatedEvidence"][0]["sha256"], AUDIT.sha256(clocks.read_bytes()))
            self.assertIn("forecast successivo al programma ufficiale", (root / "out/audit.md").read_text(encoding="utf8"))


if __name__ == "__main__":
    unittest.main()
