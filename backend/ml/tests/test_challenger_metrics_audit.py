"""Public synthetic fixtures: no football performance evidence or private inputs."""
import copy
import gzip
import importlib.util
import io
import json
import math
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/audit-challenger-metrics.py"
SPEC = importlib.util.spec_from_file_location("challenger_metrics_audit", SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def public_fixture():
    rows = []
    for i, (goals, p) in enumerate([((1, 0), [1, 0, 0]), ((0, 1), [0, 1, 0]), ((1, 1), [.5, .5, 0])]):
        rows.append({"matchId": f"public-synthetic-{i}", "competition": "Synthetic League", "season": "synthetic",
                     "forecastAt": "2026-01-04T03:07:00.000Z", "phase": "development",
                     "homeGoals": goals[0], "awayGoals": goals[1], "predictionExclusions": {},
                     "predictions": {"fixture": {"probabilities": p, "matrixHash": "synthetic", "retrospective": True}}})
    bins = [{"lower": i / 10, "upper": (i + 1) / 10, "n": 0, "predicted": None, "observed": None} for i in range(10)]
    bins[5].update(n=1, predicted=.5, observed=0)
    bins[9].update(n=2, predicted=1, observed=.5)
    # Analytic reference: one correct certainty, one wrong certainty, one losing tie.
    metrics = {"n": 3, "logLoss": (-math.log(1e-15) + math.log(2)) / 3, "brier": 5 / 6,
               "ece": .5, "accuracy": 1 / 3, "calibration": bins, "leagues": ["Synthetic League"],
               "periods": ["2025-12-29"]}
    return {"protocol": "synthetic-public-fixture", "coverage": {"inputMatches": 3, "phases": {"development": 3}},
            "variants": {"fixture": {"role": "ablation", "availability": "retrospective_development",
                                     "byPhase": {"development": {"metrics": metrics}}}}, "records": rows}


def strict_public_fixture():
    """Small structural fixture; analytic arithmetic references are tested above."""
    template = public_fixture()
    rows = []
    for index in range(12):
        row = copy.deepcopy(template["records"][index % 3])
        row["matchId"] = f"public-strict-{index}"
        prediction = row["predictions"].pop("fixture")
        for variant in audit.ARMS if index < 2 else ("C906_reconstructed", "C906_reconstructed_new_selector"):
            row["predictions"][variant] = copy.deepcopy(prediction)
        rows.append(row)
    variants = {arm: {"role": "no_ml" if arm == "no_ml" else "ablation", "availability": "retrospective_development"}
                for arm in audit.ARMS}
    variants.update({variant: {"role": role, "availability": availability} for variant, role, availability in (
        ("actual_C906", "current", "recorded_available"), ("actual_C906_new_selector", "current", "recorded_available"),
        ("C906_reconstructed", "ablation", "retrospective_development"),
        ("C906_reconstructed_new_selector", "ablation", "retrospective_development"))})
    for variant, spec in variants.items():
        spec["byPhase"] = {"development": {"metrics": audit.calculate(rows, variant)}}
    return {"protocol": "synthetic-public-strict-fixture", "coverage": {"inputMatches": 12, "phases": {"development": 12}},
            "variants": variants, "records": rows}


class ChallengerMetricsAuditTests(unittest.TestCase):
    def test_analytic_zero_one_tie_fixture(self):
        fixture = public_fixture()
        metadata, rows = audit.compact(fixture)
        result = audit.audit(metadata, rows, canonical=False)
        self.assertTrue(result["passed"], result["findings"])
        computed = result["variants"]["fixture"]["byPhase"]["development"]["metrics"]
        self.assertEqual(computed["accuracy"], 1 / 3)
        self.assertAlmostEqual(computed["brier"], 5 / 6)
        self.assertAlmostEqual(computed["ece"], .5)
        self.assertEqual(sum(b["n"] for b in computed["calibration"]), 3)

    def test_bin_boundaries_and_one_go_to_expected_bins(self):
        rows = public_fixture()["records"]
        for row, p in zip(rows, ([.4, .3, .3], [.6, .2, .2], [1, 0, 0])):
            row["predictions"]["fixture"]["probabilities"] = p
        computed = audit.calculate(rows, "fixture")
        self.assertEqual([b["n"] for b in computed["calibration"]], [0, 0, 0, 0, 1, 0, 1, 0, 0, 1])

    def test_first_class_wins_three_way_tie(self):
        rows = public_fixture()["records"][:1]
        rows[0]["predictions"]["fixture"]["probabilities"] = [1 / 3] * 3
        self.assertEqual(audit.calculate(rows, "fixture")["accuracy"], 1)
        rows[0].update(homeGoals=0, awayGoals=0)
        self.assertEqual(audit.calculate(rows, "fixture")["accuracy"], 0)

    def test_duplicate_id_rejected_even_with_different_result(self):
        metadata, rows = audit.compact(public_fixture())
        rows[1]["matchId"] = rows[0]["matchId"]
        with self.assertRaisesRegex(ValueError, "duplicate"):
            audit.audit(metadata, rows, canonical=False)

    def test_invalid_probabilities_fail_instead_of_silent_normalization(self):
        for value in ([.5, .4], [float("nan"), 0, 1], [float("inf"), 0, 0], [-.1, .6, .5],
                      [.5, .5, .5], [True, 0, 0], ["1", 0, 0]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                audit.probabilities(value)

    def test_empty_cohort_has_null_metrics_and_empty_bins(self):
        value = audit.calculate([], "fixture")
        self.assertEqual(value["n"], 0)
        self.assertTrue(all(value[k] is None for k in ("accuracy", "logLoss", "brier", "ece")))
        self.assertEqual(sum(b["n"] for b in value["calibration"]), 0)

    def test_declared_metric_and_bin_tampering_is_detected(self):
        for field in ("logLoss", "brier", "ece", "accuracy", "n"):
            fixture = public_fixture()
            fixture["variants"]["fixture"]["byPhase"]["development"]["metrics"][field] += 1e-6
            metadata, rows = audit.compact(fixture)
            self.assertFalse(audit.audit(metadata, rows, canonical=False)["passed"])
        fixture = public_fixture()
        fixture["variants"]["fixture"]["byPhase"]["development"]["metrics"]["calibration"][5]["n"] = 2
        metadata, rows = audit.compact(fixture)
        self.assertFalse(audit.audit(metadata, rows, canonical=False)["passed"])

    def test_unexplained_exclusion_and_undeclared_prediction_fail(self):
        metadata, rows = audit.compact(public_fixture())
        rows[0]["predictionExclusions"]["fixture"] = "invalid"
        with self.assertRaisesRegex(ValueError, "simultaneously excluded"):
            audit.audit(metadata, rows, canonical=False)
        rows[0]["predictionExclusions"] = {}
        rows[0]["predictions"]["unknown"] = rows[0]["predictions"]["fixture"]
        with self.assertRaisesRegex(ValueError, "undeclared"):
            audit.audit(metadata, rows, canonical=False)

    def test_canonical_checks_reject_fixture_and_role_changes(self):
        metadata, rows = audit.compact(public_fixture())
        result = audit.audit(metadata, rows, canonical=True)
        self.assertFalse(result["passed"])
        self.assertIn("canonical input must contain 6587 records", result["findings"])
        self.assertIn("incorrect C906 role/availability: actual_C906", result["findings"])

    def test_same_count_different_ids_is_not_a_paired_cohort(self):
        metadata, rows = audit.compact(public_fixture())
        for arm in audit.ARMS:
            metadata["variants"][arm] = copy.deepcopy(metadata["variants"]["fixture"])
            for row in rows[:2]:
                row["predictions"][arm] = copy.deepcopy(row["predictions"]["fixture"])
        del rows[0]["predictions"][audit.ARMS[-1]]
        rows[2]["predictions"][audit.ARMS[-1]] = copy.deepcopy(rows[2]["predictions"]["fixture"])
        result = audit.audit(metadata, rows, canonical=False)
        self.assertFalse(result["sixArmSameIds"])
        self.assertEqual(set(result["sixArmCounts"].values()), {2})

    def test_bundle_replay_without_original_report_and_hash_tamper(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, out, replay = root / "fixture.json", root / "first", root / "replay"
            source.write_text(json.dumps(public_fixture()), encoding="utf-8")
            with patch("builtins.print"):
                self.assertEqual(audit.main(["--report", str(source), "--out", str(out), "--generic"]), 0)
                source.unlink()
                self.assertEqual(audit.main(["--bundle", str(out), "--out", str(replay), "--generic"]), 0)
            self.assertEqual((out / "audit.json").read_bytes(), (replay / "audit.json").read_bytes())
            with self.assertRaisesRegex(ValueError, "must be new"):
                audit.main(["--bundle", str(out), "--out", str(replay), "--generic"])
            with (out / "predictions.jsonl").open("ab") as stream:
                stream.write(b"\n")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                audit.main(["--bundle", str(out), "--out", str(root / "tampered"), "--generic"])

    def test_no_final_probability_evidence_prevents_pass(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "fixture.json"
            source.write_text(json.dumps(public_fixture()), encoding="utf-8")
            with patch.object(audit, "source_evidence", return_value={"finalProbabilityEvidence": False}), patch("builtins.print"):
                self.assertEqual(audit.main(["--report", str(source), "--out", str(root / "audit"), "--generic"]), 1)

    def test_final_stages_and_identity_survive_compact_export(self):
        fixture = public_fixture()
        for row in fixture["records"]:
            prediction = row["predictions"]["fixture"]
            prediction.update(probabilityStages={"raw": [.4, .3, .3], "calibrated": [.5, .3, .2],
                                                  "decision": list(prediction["probabilities"])},
                              modelVersion="C-public-synthetic", probabilityConfigurationHash="f" * 64)
        metadata, rows = audit.compact(fixture)
        result = audit.audit(metadata, rows, canonical=False)
        self.assertTrue(result["passed"], result["findings"])
        self.assertEqual(result["probabilityStageCoverage"], {"predictions": 3, "withAllStages": 3, "withoutStages": 0})
        self.assertEqual(rows[0]["predictions"]["fixture"]["modelVersion"], "C-public-synthetic")
        self.assertEqual(rows[0]["predictions"]["fixture"]["probabilityConfigurationHash"], "f" * 64)
        self.assertTrue(result["variants"]["fixture"]["byPhase"]["development"]["accuracyDeclared"])
        rows[0]["predictions"]["fixture"]["probabilityStages"]["decision"] = [.5, .5, 0]
        result = audit.audit(metadata, rows, canonical=False)
        self.assertFalse(result["passed"])
        self.assertTrue(any("differs from decision stage" in finding for finding in result["findings"]))

    def test_present_but_incomplete_stages_rejected(self):
        metadata, rows = audit.compact(public_fixture())
        rows[0]["predictions"]["fixture"]["probabilityStages"] = {"decision": [1, 0, 0]}
        with self.assertRaisesRegex(ValueError, "must include raw, calibrated and decision"):
            audit.audit(metadata, rows, canonical=False)

    def test_gzip_is_deterministic_and_replays_equivalent_plain_metrics(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "fixture.json"
            source.write_text(json.dumps(public_fixture()), encoding="utf-8")
            with patch("builtins.print"):
                for name, options in (("plain", []), ("gzip-one", ["--gzip"]), ("gzip-two", ["--gzip"])):
                    self.assertEqual(audit.main(["--report", str(source), "--out", str(root / name), "--generic"] + options), 0)
                source.unlink()
                self.assertEqual(audit.main(["--bundle", str(root / "gzip-one"), "--out", str(root / "replay"),
                                             "--generic", "--gzip"]), 0)
                self.assertEqual(audit.main(["--bundle", str(root / "gzip-one"), "--out", str(root / "replay-plain"),
                                             "--generic"]), 0)
            plain = (root / "plain/predictions.jsonl").read_bytes()
            compressed = (root / "gzip-one/predictions.jsonl.gz").read_bytes()
            self.assertEqual(gzip.decompress(compressed), plain)
            self.assertEqual(compressed[4:8], b"\x00" * 4)  # mtime=0.
            self.assertEqual(compressed[3], 0)  # No filename or other optional header fields.
            self.assertEqual(compressed, (root / "gzip-two/predictions.jsonl.gz").read_bytes())
            self.assertEqual(compressed, (root / "replay/predictions.jsonl.gz").read_bytes())
            self.assertEqual(plain, (root / "replay-plain/predictions.jsonl").read_bytes())
            for name in ("plain", "gzip-one", "gzip-two", "replay", "replay-plain"):
                manifest = json.loads((root / name / "bundle.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["predictionsSha256"], audit.sha256(plain))
                self.assertEqual(manifest["predictionsBytes"], len(plain))
                self.assertEqual(manifest["predictionsFile"], "predictions.jsonl.gz" if name in
                                 ("gzip-one", "gzip-two", "replay") else "predictions.jsonl")
            self.assertEqual((root / "gzip-one/audit.json").read_bytes(), (root / "replay/audit.json").read_bytes())
            self.assertEqual((root / "plain/audit.json").read_bytes(), (root / "replay-plain/audit.json").read_bytes())

    def test_legacy_manifest_without_predictions_filename_still_replays(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, output = root / "fixture.json", root / "first"
            source.write_text(json.dumps(public_fixture()), encoding="utf-8")
            with patch("builtins.print"):
                self.assertEqual(audit.main(["--report", str(source), "--out", str(output), "--generic"]), 0)
                manifest_path = output / "bundle.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                del manifest["predictionsFile"]
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                self.assertEqual(audit.main(["--bundle", str(output), "--out", str(root / "replay"), "--generic"]), 0)

    def test_gzip_payload_tampering_and_invalid_stream_fail(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, output = root / "fixture.json", root / "first"
            source.write_text(json.dumps(public_fixture()), encoding="utf-8")
            with patch("builtins.print"):
                self.assertEqual(audit.main(["--report", str(source), "--out", str(output), "--generic", "--gzip"]), 0)
            predictions = output / "predictions.jsonl.gz"
            decoded = gzip.decompress(predictions.read_bytes())
            predictions.write_bytes(audit.deterministic_gzip(decoded + b"\n"))
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                audit.main(["--bundle", str(output), "--out", str(root / "tampered"), "--generic"])
            predictions.write_bytes(b"invalid gzip")
            with self.assertRaises(gzip.BadGzipFile):
                audit.main(["--bundle", str(output), "--out", str(root / "invalid"), "--generic"])
            self.assertFalse((root / "tampered").exists())
            self.assertFalse((root / "invalid").exists())

    def test_bundle_filename_allowlist_rejects_path_traversal(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, output = root / "fixture.json", root / "first"
            source.write_text(json.dumps(public_fixture()), encoding="utf-8")
            with patch("builtins.print"):
                self.assertEqual(audit.main(["--report", str(source), "--out", str(output), "--generic"]), 0)
            manifest_path = output / "bundle.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for filename in ("../predictions.jsonl", "nested/predictions.jsonl.gz", "/predictions.jsonl", "other.jsonl", None):
                with self.subTest(filename=filename):
                    manifest["predictionsFile"] = filename
                    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                    with self.assertRaisesRegex(ValueError, "predictionsFile must be"):
                        audit.main(["--bundle", str(output), "--out", str(root / "invalid"), "--generic"])

    def test_expected_counts_allow_small_strict_cli_fixture_and_replay(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "fixture.json"
            source.write_text(json.dumps(strict_public_fixture()), encoding="utf-8")
            counts = ["--expected-records", "12", "--expected-cohort", "2"]
            with patch("builtins.print"):
                self.assertEqual(audit.main(["--report", str(source), "--out", str(root / "strict"), "--gzip"] + counts), 0)
                self.assertEqual(audit.main(["--bundle", str(root / "strict"), "--out", str(root / "replay"), "--gzip"] + counts), 0)
                self.assertEqual(audit.main(["--report", str(source), "--out", str(root / "wrong-defaults")]), 1)
                self.assertEqual(audit.main(["--report", str(source), "--out", str(root / "wrong-records"),
                                             "--expected-records", "13", "--expected-cohort", "2"]), 1)
                self.assertEqual(audit.main(["--report", str(source), "--out", str(root / "wrong-cohort"),
                                             "--expected-records", "12", "--expected-cohort", "3"]), 1)
            result = json.loads((root / "strict/audit.json").read_text(encoding="utf-8"))
            self.assertTrue(result["canonicalChecks"])
            self.assertEqual(result["canonicalExpectedCounts"], {"records": 12, "cohort": 2})
            self.assertEqual((root / "strict/audit.json").read_bytes(), (root / "replay/audit.json").read_bytes())

    def test_expected_counts_keep_c906_role_count_and_pairing_guards(self):
        for tamper in ("role", "reconstructed-count", "paired-ids"):
            with self.subTest(tamper=tamper):
                metadata, rows = audit.compact(strict_public_fixture())
                if tamper == "role":
                    metadata["variants"]["actual_C906"]["role"] = "ablation"
                elif tamper == "reconstructed-count":
                    del rows[2]["predictions"]["C906_reconstructed"]
                else:
                    rows[2]["predictions"][audit.ARMS[-1]] = rows[0]["predictions"].pop(audit.ARMS[-1])
                # Refresh arithmetic claims so only the structural guard can fail.
                for variant, spec in metadata["variants"].items():
                    spec["byPhase"]["development"]["metrics"] = audit.calculate(rows, variant)
                result = audit.audit(metadata, rows, expected_records=12, expected_cohort=2)
                self.assertFalse(result["passed"])
                expected = {"role": "incorrect C906 role/availability: actual_C906",
                            "reconstructed-count": "incorrect C906 cohort: C906_reconstructed",
                            "paired-ids": "six arms must share exactly 2 unique matchIds"}[tamper]
                self.assertIn(expected, result["findings"])

    def test_expected_count_cli_rejects_zero_negative_fraction_and_text(self):
        for option in ("--expected-records", "--expected-cohort"):
            for value in ("0", "-1", "1.5", "NaN", "wrong"):
                with self.subTest(option=option, value=value), patch("sys.stderr", new_callable=io.StringIO), self.assertRaises(SystemExit) as raised:
                    audit.main(["--report", "unread-fixture.json", "--out", "unwritten-directory", option, value])
                self.assertEqual(raised.exception.code, 2)

    def test_zero_reconstructed_strict_cli_keeps_other_c906_guards(self):
        fixture = strict_public_fixture()
        for row in fixture["records"]:
            for variant in ("C906_reconstructed", "C906_reconstructed_new_selector"):
                row["predictions"].pop(variant, None)
        for variant, spec in fixture["variants"].items():
            spec["byPhase"]["development"]["metrics"] = audit.calculate(fixture["records"], variant)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = root / "fixture.json"
            source.write_text(json.dumps(fixture), encoding="utf-8")
            counts = ["--expected-records", "12", "--expected-cohort", "2"]
            with patch("builtins.print"):
                self.assertEqual(audit.main(["--report", str(source), "--out", str(root / "zero"), "--gzip"] +
                                             counts + ["--expected-reconstructed", "0"]), 0)
                self.assertEqual(audit.main(["--report", str(source), "--out", str(root / "default")] + counts), 1)
                self.assertEqual(audit.main(["--bundle", str(root / "zero"), "--out", str(root / "replay"), "--gzip"] +
                                             counts + ["--expected-reconstructed", "0"]), 0)
            result = json.loads((root / "zero/audit.json").read_text(encoding="utf-8"))
            self.assertTrue(result["canonicalChecks"])
            self.assertEqual(result["canonicalExpectedCounts"], {"records": 12, "cohort": 2, "reconstructed": 0})
            self.assertEqual((root / "zero/audit.json").read_bytes(), (root / "replay/audit.json").read_bytes())
        metadata, rows = audit.compact(fixture)
        metadata["variants"]["actual_C906"]["role"] = "ablation"
        result = audit.audit(metadata, rows, expected_records=12, expected_cohort=2, expected_reconstructed=0)
        self.assertFalse(result["passed"])
        self.assertIn("incorrect C906 role/availability: actual_C906", result["findings"])

    def test_expected_reconstructed_rejects_negative_fraction_and_text(self):
        for value in ("-1", "1.5", "NaN", "wrong"):
            with self.subTest(value=value), patch("sys.stderr", new_callable=io.StringIO), self.assertRaises(SystemExit) as raised:
                audit.main(["--report", "unread-fixture.json", "--out", "unwritten-directory", "--expected-reconstructed", value])
            self.assertEqual(raised.exception.code, 2)

    def test_optional_c906_recipe_diagnostic_requires_same_ids_and_size(self):
        metadata, rows = audit.compact(strict_public_fixture())
        diagnostic = "c906_recipe_retrained"
        metadata["variants"][diagnostic] = copy.deepcopy(metadata["variants"]["development_current_replica"])
        for record in rows[:2]:
            record["predictions"][diagnostic] = copy.deepcopy(record["predictions"]["development_current_replica"])
        result = audit.audit(metadata, rows, expected_records=12, expected_cohort=2)
        self.assertTrue(result["passed"], result["findings"])
        for tamper in ("missing", "same-count-other-id"):
            with self.subTest(tamper=tamper):
                changed = copy.deepcopy(rows)
                prediction = changed[0]["predictions"].pop(diagnostic)
                if tamper == "same-count-other-id":
                    changed[2]["predictions"][diagnostic] = prediction
                metadata["variants"][diagnostic]["byPhase"]["development"]["metrics"] = audit.calculate(changed, diagnostic)
                result = audit.audit(metadata, changed, expected_records=12, expected_cohort=2)
                self.assertFalse(result["passed"])
                self.assertIn("c906_recipe_retrained must share exactly the controlled test cohort", result["findings"])


if __name__ == "__main__":
    unittest.main()
