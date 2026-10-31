"""Tiny synthetic byte bundles only; no real training, providers or model evidence."""
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[2] / "scripts/restore-challenger-season-inputs.py"
SPEC = importlib.util.spec_from_file_location("season_restorer", PATH)
restorer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(restorer)


def digest(payload):
    return {"sha256": hashlib.sha256(payload).hexdigest(), "bytes": len(payload)}


def tar_payload(members):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as archive:
        for name, payload, kind in members:
            info = tarfile.TarInfo(name)
            info.mtime = 0
            info.type = kind
            if kind == tarfile.SYMTYPE:
                info.linkname = "../../outside.json"
                archive.addfile(info)
            else:
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
    return gzip.compress(output.getvalue(), mtime=0)


def fixture(root):
    evidence = root / "evidence" / "c-three-season-backtest-2026-10-31"
    evidence.mkdir(parents=True)
    (evidence.parent / restorer.PRIOR_FOLDER).mkdir()
    manifest = {"schemaVersion": restorer.SCHEMA, "files": {}}
    expected, archive_rows = {}, {}
    for name, destination in restorer.GZIP_OUTPUTS.items():
        payload = json.dumps({"synthetic_unit_bytes": name, "rows": []}, indent=2).replace("\n", "\r\n").encode() + b"\r\n"
        encoded = gzip.compress(payload, mtime=0)
        restorer.source_path(evidence, name).write_bytes(encoded)
        manifest["files"][name] = {**digest(encoded), "decodedSha256": digest(payload)["sha256"], "decodedBytes": len(payload)}
        expected[destination] = payload
    for fold, name in enumerate(restorer.ARCHIVES):
        rows = [(member, json.dumps({"synthetic_fixture_only": True, "member": member}).encode() + b"\n", tarfile.REGTYPE)
                for member in sorted(restorer.expected_members(fold))]
        encoded = tar_payload(rows)
        (evidence / name).write_bytes(encoded)
        manifest["files"][name] = {**digest(encoded), "members": {member: digest(payload) for member, payload, _ in rows}}
        archive_rows[name] = rows
        expected.update({member: payload for member, payload, _ in rows})
    variants = {"variants": [{"id": arm, "folds": [{"artifactPath": f"fold-{fold}-{arm}.json"} for fold in range(6)]}
        for arm in restorer.ARMS] + [{"id": "actual_fixture", "artifactPath": "incumbent.json"}]}
    payload = json.dumps(variants, indent=2).encode() + b"\r\n"
    (evidence / restorer.VARIANTS).write_bytes(payload)
    manifest["files"][restorer.VARIANTS] = digest(payload)
    expected["comparison-canonical-inputs/variants.json"] = payload
    save_manifest(evidence, manifest)
    return evidence, manifest, expected, archive_rows


def save_manifest(evidence, manifest):
    (evidence / "bundle-files.json").write_bytes(json.dumps(manifest, indent=2).encode() + b"\n")


def replace_archive(evidence, manifest, name, rows):
    payload = tar_payload(rows)
    (evidence / name).write_bytes(payload)
    manifest["files"][name].update(digest(payload))
    save_manifest(evidence, manifest)


class RestoreSeasonInputsTests(unittest.TestCase):
    def test_all_42_fold_artifacts_and_43rd_incumbent_restore_exact_original_bytes(self):
        with tempfile.TemporaryDirectory(prefix="restore-season-bytes-unit-") as directory:
            root = Path(directory)
            evidence, manifest, expected, _ = fixture(root)
            output = root / "new-output"
            receipt = restorer.restore(evidence, output)
            self.assertEqual(receipt["restoredFoldArtifacts"], 42)
            self.assertEqual(receipt["incumbentArtifacts"], 1)
            self.assertEqual(len(receipt["files"]), 48)
            self.assertEqual(set(receipt["files"]), set(expected))
            for name, payload in expected.items():
                self.assertEqual((output / name).read_bytes(), payload, name)
                self.assertEqual(receipt["files"][name], digest(payload))
            self.assertIn(b"\r\n", (output / "nightly-extended-canonical.json").read_bytes())
            self.assertEqual(receipt, json.loads((output / "restore-manifest.json").read_bytes()))
            self.assertNotIn(b"\r\n", (output / "restore-manifest.json").read_bytes())

    def test_existing_output_file_or_directory_is_refused_before_input_reads_or_writes(self):
        with tempfile.TemporaryDirectory(prefix="restore-season-existing-unit-") as directory:
            root = Path(directory)
            for kind in ("file", "directory"):
                output = root / kind
                if kind == "file": output.write_bytes(b"existing-user-file")
                else: output.mkdir(); (output / "marker").write_bytes(b"existing-user-folder")
                with patch.object(restorer, "validate_bundle", side_effect=AssertionError("Inputs must not be read")):
                    with self.assertRaises(FileExistsError): restorer.restore(root / "missing-evidence", output)
                self.assertEqual(output.read_bytes() if kind == "file" else (output / "marker").read_bytes(),
                                 b"existing-user-file" if kind == "file" else b"existing-user-folder")

    def test_corrupt_raw_or_decoded_gzip_and_bad_crc_leave_no_output(self):
        for corruption in ("raw", "decoded_hash", "crc"):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory(prefix="restore-season-corrupt-unit-") as directory:
                root = Path(directory); evidence, manifest, _, _ = fixture(root)
                name = "nightly-extended-canonical.json.gz"
                if corruption == "decoded_hash": manifest["files"][name]["decodedSha256"] = "0" * 64
                else:
                    encoded = bytearray((evidence / name).read_bytes()); encoded[-8] ^= 1
                    (evidence / name).write_bytes(encoded)
                    if corruption == "crc": manifest["files"][name].update(digest(encoded))
                save_manifest(evidence, manifest)
                with self.assertRaises((ValueError, OSError, EOFError)):
                    restorer.restore(evidence, root / "must-not-exist")
                self.assertFalse((root / "must-not-exist").exists())

    def test_archive_paths_duplicates_links_missing_and_wrong_fold_members_are_rejected(self):
        for corruption in ("traversal", "absolute", "windows_path", "duplicate", "link", "missing", "wrong_fold"):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory(prefix="restore-season-archive-unit-") as directory:
                root = Path(directory); evidence, manifest, _, archives = fixture(root)
                name = restorer.ARCHIVES[0]; rows = list(archives[name])
                member, payload, _ = rows[0]
                if corruption == "duplicate": rows.append(rows[0])
                elif corruption == "missing": rows.pop()
                elif corruption == "link": rows[0] = (member, payload, tarfile.SYMTYPE)
                else:
                    path = {"traversal": "../escape.json", "absolute": "/tmp/escape.json",
                            "windows_path": "C:\\escape.json", "wrong_fold": member.replace("fold-0-", "fold-1-")}[corruption]
                    rows[0] = (path, payload, tarfile.REGTYPE)
                replace_archive(evidence, manifest, name, rows)
                with self.assertRaisesRegex(ValueError, "bundle_member|bundle_members"):
                    restorer.restore(evidence, root / "must-not-exist")
                self.assertFalse((root / "must-not-exist").exists())
                self.assertFalse((root / "escape.json").exists())

    def test_same_member_names_with_corrupt_payload_or_bad_member_manifest_are_rejected(self):
        for corruption in ("payload", "manifest_name", "member_digest"):
            with self.subTest(corruption=corruption), tempfile.TemporaryDirectory(prefix="restore-season-member-unit-") as directory:
                root = Path(directory); evidence, manifest, _, archives = fixture(root)
                name = restorer.ARCHIVES[5]; rows = list(archives[name]); member, payload, _ = rows[0]
                if corruption == "payload":
                    rows[0] = (member, b"!" + payload[1:], tarfile.REGTYPE)
                    replace_archive(evidence, manifest, name, rows)
                elif corruption == "member_digest":
                    manifest["files"][name]["members"][member]["sha256"] = "0" * 64; save_manifest(evidence, manifest)
                else:
                    manifest["files"][name]["members"]["../escape.json"] = manifest["files"][name]["members"].pop(member)
                    save_manifest(evidence, manifest)
                with self.assertRaises(ValueError): restorer.restore(evidence, root / "must-not-exist")
                self.assertFalse((root / "must-not-exist").exists())

    def test_unsafe_variant_reference_is_rejected_before_outputs(self):
        with tempfile.TemporaryDirectory(prefix="restore-season-variant-unit-") as directory:
            root = Path(directory); evidence, manifest, _, _ = fixture(root)
            payload = b'{"variants":[{"id":"fixture","artifactPath":"../../private.json"}]}'
            (evidence / restorer.VARIANTS).write_bytes(payload)
            manifest["files"][restorer.VARIANTS] = digest(payload); save_manifest(evidence, manifest)
            with self.assertRaisesRegex(ValueError, "unsafe_bundle_variant_reference"):
                restorer.restore(evidence, root / "must-not-exist")
            self.assertFalse((root / "must-not-exist").exists())

    def test_late_input_change_cleans_only_the_new_owned_directory(self):
        with tempfile.TemporaryDirectory(prefix="restore-season-cleanup-unit-") as directory:
            root = Path(directory); evidence, _, _, _ = fixture(root)
            marker = root / "preserved-user-file"; marker.write_bytes(b"preserve")
            validate = restorer.validate_bundle
            def change_after_validation(path):
                result = validate(path)
                (evidence / restorer.VARIANTS).write_bytes(b"changed-after-validation")
                return result
            with patch.object(restorer, "validate_bundle", side_effect=change_after_validation):
                with self.assertRaisesRegex(ValueError, "bundle_digest_mismatch"):
                    restorer.restore(evidence, root / "new-owned-output")
            self.assertFalse((root / "new-owned-output").exists())
            self.assertEqual(marker.read_bytes(), b"preserve")


if __name__ == "__main__":
    unittest.main()
