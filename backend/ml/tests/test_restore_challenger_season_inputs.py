"""Synthetic data bytes only; no real training, providers or model evidence."""
from contextlib import redirect_stdout
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[2] / "scripts/restore-challenger-season-inputs.py"
SPEC = importlib.util.spec_from_file_location("season_restorer", PATH)
restorer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(restorer)


def digest(payload):
    return {"sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}


def save_manifest(evidence, manifest):
    (evidence / "bundle-files.json").write_bytes(json.dumps(manifest, indent=2).encode() + b"\n")


def fixture(root):
    evidence = root / "evidence" / "c-three-season-backtest-2026-10-31"
    evidence.mkdir(parents=True)
    (evidence.parent / restorer.PRIOR_FOLDER).mkdir()
    (evidence / "predictions").mkdir()
    manifest = {"schemaVersion": restorer.SCHEMA, "files": {}}
    expected = {}
    for name, destination in restorer.GZIP_OUTPUTS.items():
        payload = json.dumps({"synthetic_unit_bytes": name, "rows": []}, indent=2).replace("\n", "\r\n").encode() + b"\r\n"
        encoded = gzip.compress(payload, mtime=0)
        restorer.source_path(evidence, name).write_bytes(encoded)
        manifest["files"][name] = {**digest(encoded), "decodedSha256": digest(payload)["sha256"], "decodedBytes": len(payload)}
        expected[destination] = payload
    predictions = b'{"matchId":"synthetic","predictions":{}}\n'
    encoded = gzip.compress(predictions, mtime=0)
    (evidence / restorer.PREDICTIONS).write_bytes(encoded)
    manifest["files"][restorer.PREDICTIONS] = {
        **digest(encoded), "decodedSha256": digest(predictions)["sha256"], "decodedBytes": len(predictions)}
    expected[restorer.PREDICTIONS] = encoded
    prediction_manifest = {"schemaVersion": "independent-challenger-metrics-audit-v1",
        "predictionsFile": "predictions.jsonl.gz", "predictionsSha256": digest(predictions)["sha256"],
        "predictionsBytes": len(predictions)}
    for name, value in [("predictions/bundle.json", prediction_manifest), ("predictions/audit.json", {"synthetic": True})]:
        payload = json.dumps(value).encode() + b"\r\n"
        (evidence / name).write_bytes(payload)
        manifest["files"][name] = digest(payload)
        expected[name] = payload
    save_manifest(evidence, manifest)
    return evidence, manifest, expected


class RestoreSeasonInputsTests(unittest.TestCase):
    def test_data_and_saved_predictions_restore_exact_bytes_without_model_archives(self):
        with tempfile.TemporaryDirectory(prefix="restore-season-bytes-unit-") as directory:
            root = Path(directory)
            evidence, _, expected = fixture(root)
            output = root / "new-output"
            receipt = restorer.restore(evidence, output)
            self.assertEqual(receipt["modelWeightsRestored"], 0)
            self.assertFalse(receipt["modelReconstructionAvailable"])
            self.assertTrue(receipt["savedPredictionMetricsAvailable"])
            self.assertIn("cannot be regenerated", receipt["limitation"])
            self.assertEqual(len(receipt["files"]), 7)
            self.assertEqual(set(receipt["files"]), set(expected))
            for name, payload in expected.items():
                self.assertEqual((output / name).read_bytes(), payload, name)
                self.assertEqual(receipt["files"][name], digest(payload), name)
            self.assertFalse((output / "comparison-canonical-inputs").exists())
            self.assertIn(b"\r\n", (output / "nightly-extended-canonical.json").read_bytes())
            self.assertEqual(receipt, json.loads((output / "restore-manifest.json").read_bytes()))
            self.assertNotIn(b"\r\n", (output / "restore-manifest.json").read_bytes())

    def test_cli_reports_data_only_capability_and_cannot_claim_forecast_reconstruction(self):
        with tempfile.TemporaryDirectory(prefix="restore-season-cli-unit-") as directory:
            root = Path(directory)
            evidence, _, _ = fixture(root)
            stdout = io.StringIO()
            with redirect_stdout(stdout):
                receipt = restorer.main(["--evidence", str(evidence), "--out", str(root / "new-output")])
            status = json.loads(stdout.getvalue())
            self.assertEqual(status["restoredFiles"], 7)
            self.assertEqual(status["modelWeightsRestored"], 0)
            self.assertFalse(status["modelReconstructionAvailable"])
            self.assertEqual(status["bundleManifestSha256"], receipt["bundleManifest"]["sha256"])

    def test_existing_output_file_or_directory_is_refused_before_input_reads_or_writes(self):
        with tempfile.TemporaryDirectory(prefix="restore-season-existing-unit-") as directory:
            root = Path(directory)
            for kind in ("file", "directory"):
                output = root / kind
                if kind == "file":
                    output.write_bytes(b"existing-user-file")
                else:
                    output.mkdir()
                    (output / "marker").write_bytes(b"existing-user-folder")
                with patch.object(restorer, "validate_bundle", side_effect=AssertionError("Inputs must not be read")):
                    with self.assertRaises(FileExistsError):
                        restorer.restore(root / "missing-evidence", output)
                self.assertEqual(output.read_bytes() if kind == "file" else (output / "marker").read_bytes(),
                    b"existing-user-file" if kind == "file" else b"existing-user-folder")

    def test_corrupt_raw_decoded_hash_size_or_crc_in_data_or_predictions_leaves_no_output(self):
        for name in ("nightly-extended-canonical.json.gz", restorer.PREDICTIONS):
            for corruption in ("raw", "decoded_hash", "decoded_size", "crc"):
                with self.subTest(name=name, corruption=corruption), tempfile.TemporaryDirectory(prefix="restore-season-corrupt-unit-") as directory:
                    root = Path(directory)
                    evidence, manifest, _ = fixture(root)
                    if corruption == "decoded_hash":
                        manifest["files"][name]["decodedSha256"] = "0" * 64
                    elif corruption == "decoded_size":
                        manifest["files"][name]["decodedBytes"] -= 1
                    else:
                        encoded = bytearray((evidence / name).read_bytes())
                        encoded[-8] ^= 1
                        (evidence / name).write_bytes(encoded)
                        if corruption == "crc":
                            manifest["files"][name].update(digest(encoded))
                    save_manifest(evidence, manifest)
                    with self.assertRaises((ValueError, OSError, EOFError)):
                        restorer.restore(evidence, root / "must-not-exist")
                    self.assertFalse((root / "must-not-exist").exists())

    def test_manifest_traversal_absolute_windows_or_old_model_paths_are_rejected(self):
        for name in ("../escape.json", "/tmp/escape.json", "C:\\escape.json", "predictions/../../escape.json",
                     "evaluation-fold-0.tar.gz", "actual-c906-artifact.json.gz"):
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix="restore-season-path-unit-") as directory:
                root = Path(directory)
                evidence, manifest, _ = fixture(root)
                manifest["files"][name] = digest(b"not-allowed")
                save_manifest(evidence, manifest)
                with self.assertRaisesRegex(ValueError, "unexpected_or_missing_season_data_bundle_file_metadata"):
                    restorer.restore(evidence, root / "must-not-exist")
                self.assertFalse((root / "must-not-exist").exists())
                self.assertFalse((root / "escape.json").exists())

    def test_missing_files_bad_metadata_and_old_model_bundle_schema_are_rejected(self):
        for corruption in ("missing_metadata", "missing_file", "bad_digest", "boolean_size", "old_schema"):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory(prefix="restore-season-metadata-unit-") as directory:
                root = Path(directory)
                evidence, manifest, _ = fixture(root)
                name = "season-plan.json.gz"
                if corruption == "missing_metadata":
                    del manifest["files"][name]
                elif corruption == "missing_file":
                    (evidence / name).unlink()
                elif corruption == "bad_digest":
                    manifest["files"][name]["sha256"] = "not-sha256"
                elif corruption == "boolean_size":
                    manifest["files"][name]["bytes"] = True
                else:
                    manifest["schemaVersion"] = "challenger-season-evidence-bundle-v1"
                save_manifest(evidence, manifest)
                with self.assertRaises(ValueError):
                    restorer.restore(evidence, root / "must-not-exist")
                self.assertFalse((root / "must-not-exist").exists())

    def test_prediction_bundle_rejects_unsafe_or_mismatching_references_even_when_rehashed(self):
        for field, value in [("predictionsFile", "../../private.json"), ("predictionsFile", "C:\\private.json"),
                             ("predictionsSha256", "0" * 64), ("predictionsBytes", 1), ("schemaVersion", "wrong")]:
            with self.subTest(field=field, value=value), tempfile.TemporaryDirectory(prefix="restore-season-reference-unit-") as directory:
                root = Path(directory)
                evidence, manifest, _ = fixture(root)
                name = "predictions/bundle.json"
                payload = json.loads((evidence / name).read_bytes())
                payload[field] = value
                encoded = json.dumps(payload).encode()
                (evidence / name).write_bytes(encoded)
                manifest["files"][name] = digest(encoded)
                save_manifest(evidence, manifest)
                with self.assertRaisesRegex(ValueError, "invalid_saved_prediction_bundle_reference"):
                    restorer.restore(evidence, root / "must-not-exist")
                self.assertFalse((root / "must-not-exist").exists())

    def test_unlisted_old_model_files_are_never_read_or_restored(self):
        with tempfile.TemporaryDirectory(prefix="restore-season-no-model-unit-") as directory:
            root = Path(directory)
            evidence, _, _ = fixture(root)
            (evidence / "evaluation-fold-0.tar.gz").write_bytes(b"not a model archive")
            (evidence.parent / restorer.PRIOR_FOLDER / "actual-c906-artifact.json.gz").write_bytes(b"not a gzip")
            receipt = restorer.restore(evidence, root / "new-output")
            self.assertEqual(len(receipt["files"]), 7)
            self.assertFalse(any("artifact" in name or ".tar" in name for name in receipt["files"]))

    def test_late_input_changes_clean_only_the_new_owned_directory(self):
        for name in ("nightly-extended-canonical.json.gz", "predictions/bundle.json", restorer.PREDICTIONS):
            with self.subTest(name=name), tempfile.TemporaryDirectory(prefix="restore-season-cleanup-unit-") as directory:
                root = Path(directory)
                evidence, _, _ = fixture(root)
                marker = root / "preserved-user-file"
                marker.write_bytes(b"preserve")
                validate = restorer.validate_bundle

                def change_after_validation(path):
                    result = validate(path)
                    (evidence / name).write_bytes(b"changed-after-validation")
                    return result

                with patch.object(restorer, "validate_bundle", side_effect=change_after_validation):
                    with self.assertRaisesRegex(ValueError, "bundle_(digest|size)_mismatch"):
                        restorer.restore(evidence, root / "new-owned-output")
                self.assertFalse((root / "new-owned-output").exists())
                self.assertEqual(marker.read_bytes(), b"preserve")


if __name__ == "__main__":
    unittest.main()
