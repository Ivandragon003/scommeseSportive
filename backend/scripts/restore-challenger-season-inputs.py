"""Restore the frozen C seasonal replay inputs from the public, hash-checked bundle.

Local files and Python's standard library only. This is an integrity check and
byte-exact restoration, not model validation, adoption, training or a database write.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile


SCHEMA = "challenger-season-evidence-bundle-v1"
CHUNK = 1024 * 1024
ARMS = ("no_ml", "development_current_replica", "intensity_legacy", "intensity_recent_xg",
        "intensity_schedule", "intensity_full", "c906_recipe_retrained")
GZIP_OUTPUTS = {
    "nightly-extended-canonical.json.gz": "nightly-extended-canonical.json",
    "season-plan.json.gz": "season-plan.json",
    "comparison-plan.json.gz": "comparison-plan.json",
    "matches-frozen.json.gz": "matches.json",
    "actual-c906-artifact.json.gz": "comparison-canonical-inputs/incumbent.json",
}
PRIOR_FILES = {"matches-frozen.json.gz", "actual-c906-artifact.json.gz"}
PRIOR_FOLDER = "c-data-audit-2026-10-31"
ARCHIVES = tuple(f"evaluation-fold-{fold}.tar.gz" for fold in range(6))
VARIANTS = "evaluation-variants.json"
DEFAULT_EVIDENCE = Path(__file__).resolve().parents[2] / "docs/performance/evidence/c-three-season-backtest-2026-10-31"


def expected_members(fold):
    return {f"comparison-canonical-inputs/fold-{fold}-{arm}.json" for arm in ARMS}


def checked_digest(info, label, decoded=False):
    prefix = "decoded" if decoded else ""
    hash_key, size_key = ("decodedSha256", "decodedBytes") if decoded else ("sha256", "bytes")
    if (not isinstance(info, dict) or not isinstance(info.get(hash_key), str)
            or re.fullmatch(r"[a-f0-9]{64}", info[hash_key]) is None
            or type(info.get(size_key)) is not int or info[size_key] < 0):
        raise ValueError(f"invalid_bundle_{prefix}digest: {label}")
    return {"sha256": info[hash_key], "bytes": info[size_key]}


def check_stream(stream, expected, label, sink=None):
    digest, size = hashlib.sha256(), 0
    while True:
        block = stream.read(CHUNK)
        if not block:
            break
        size += len(block)
        if size > expected["bytes"]:
            raise ValueError(f"bundle_size_mismatch: {label}")
        digest.update(block)
        if sink is not None:
            sink.write(block)
    actual = {"sha256": digest.hexdigest(), "bytes": size}
    if actual != expected:
        raise ValueError(f"bundle_digest_mismatch: {label}")
    return actual


def source_path(evidence, name):
    return evidence.parent / PRIOR_FOLDER / name if name in PRIOR_FILES else evidence / name


def check_variants(payload):
    value = json.loads(payload)
    variants = value.get("variants") if isinstance(value, dict) else None
    if not isinstance(variants, list) or not variants:
        raise ValueError("invalid_bundle_variants")
    allowed = {Path(name).name for fold in range(6) for name in expected_members(fold)} | {"incumbent.json"}
    for variant in variants:
        if not isinstance(variant, dict):
            raise ValueError("invalid_bundle_variant")
        references = []
        if "artifactPath" in variant:
            references.append(variant["artifactPath"])
        if "folds" in variant:
            if not isinstance(variant["folds"], list):
                raise ValueError("invalid_bundle_variant_folds")
            for fold in variant["folds"]:
                if not isinstance(fold, dict) or "artifact" in fold or "artifactPath" not in fold:
                    raise ValueError("invalid_bundle_variant_fold")
                references.append(fold["artifactPath"])
        if "artifact" in variant or not references or any(not isinstance(name, str) or name not in allowed for name in references):
            raise ValueError("unsafe_bundle_variant_reference")


def archive_members(path, expected, output=None):
    seen, restored = set(), {}
    # ignore_zeros scans concatenated tar records too: hidden entries after an end
    # marker cannot bypass the same allowlist, duplicate and regular-file checks.
    with gzip.open(path, "rb") as decoded:
        with tarfile.open(fileobj=decoded, mode="r|", ignore_zeros=True) as archive:
            for member in archive:
                name = member.name
                if name not in expected or not member.isfile() or name in seen:
                    raise ValueError(f"unsafe_or_duplicate_bundle_member: {name}")
                wanted = checked_digest(expected[name], name)
                if member.size != wanted["bytes"]:
                    raise ValueError(f"bundle_member_size_mismatch: {name}")
                seen.add(name)
                payload = archive.extractfile(member)
                if payload is None:
                    raise ValueError(f"unreadable_bundle_member: {name}")
                with payload:
                    if output is None:
                        restored[name] = check_stream(payload, wanted, name)
                    else:
                        target = output / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        with target.open("xb") as sink:
                            restored[name] = check_stream(payload, wanted, name, sink)
        # Exhaust gzip so CRC/truncation errors cannot hide behind tar end markers.
        while decoded.read(CHUNK):
            pass
    if seen != set(expected):
        raise ValueError(f"missing_bundle_members: {path.name}")
    return restored


def validate_bundle(evidence):
    manifest_path = evidence / "bundle-files.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != SCHEMA or not isinstance(files, dict):
        raise ValueError("invalid_season_bundle_manifest")
    required = set(GZIP_OUTPUTS) | set(ARCHIVES) | {VARIANTS}
    if not required <= set(files):
        raise ValueError("missing_season_bundle_file_metadata")
    for name in sorted(required):
        expected = checked_digest(files[name], name)
        with source_path(evidence, name).open("rb") as stream:
            check_stream(stream, expected, name)
    for name in GZIP_OUTPUTS:
        expected = checked_digest(files[name], name, decoded=True)
        with gzip.open(source_path(evidence, name), "rb") as stream:
            check_stream(stream, expected, f"decoded:{name}")
    check_variants((evidence / VARIANTS).read_bytes())
    for fold, name in enumerate(ARCHIVES):
        members = files[name].get("members")
        if not isinstance(members, dict) or set(members) != expected_members(fold):
            raise ValueError(f"invalid_season_bundle_member_manifest: {name}")
        archive_members(evidence / name, members)
    return files, {"sha256": hashlib.sha256(manifest_bytes).hexdigest(), "bytes": len(manifest_bytes)}


def restore(evidence, output):
    evidence, output = Path(evidence).resolve(), Path(output).absolute()
    # lexists also refuses a dangling symlink; even an empty existing directory is
    # outside this invocation's ownership and must never receive writes or cleanup.
    if os.path.lexists(output):
        raise FileExistsError(f"restore_output_already_exists: {output}")
    files, manifest_digest = validate_bundle(evidence)
    output.parent.mkdir(parents=True, exist_ok=True)
    created, owned_root = False, None
    try:
        output.mkdir(exist_ok=False)
        created, owned_root = True, output.resolve(strict=True)
        restored = {}
        for name, relative in GZIP_OUTPUTS.items():
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with gzip.open(source_path(evidence, name), "rb") as source, target.open("xb") as sink:
                restored[relative] = check_stream(source, checked_digest(files[name], name, decoded=True), relative, sink)
        variants_path = "comparison-canonical-inputs/variants.json"
        with (evidence / VARIANTS).open("rb") as source, (output / variants_path).open("xb") as sink:
            restored[variants_path] = check_stream(source, checked_digest(files[VARIANTS], VARIANTS), variants_path, sink)
        for name in ARCHIVES:
            restored.update(archive_members(evidence / name, files[name]["members"], output))
        receipt = {"schemaVersion": "restored-challenger-season-inputs-v1", "bundleManifest": manifest_digest,
            "files": dict(sorted(restored.items())), "restoredFoldArtifacts": 42, "incumbentArtifacts": 1,
            "semantics": "exact_frozen_input_bytes_hash_verified_no_training_adoption_or_source_timestamp_claim"}
        with (output / "restore-manifest.json").open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(receipt, stream, indent=2, ensure_ascii=False); stream.write("\n")
        return receipt
    except BaseException:
        # Cleanup only the exact new directory created by this invocation. A path
        # replacement or symlink never authorizes deleting another user's target.
        if created and not output.is_symlink() and output.resolve(strict=False) == owned_root:
            shutil.rmtree(output)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--out", type=Path, required=True, help="New restore directory; existing paths are refused")
    options = parser.parse_args(argv)
    receipt = restore(options.evidence, options.out)
    print(json.dumps({"restoredTo": str(options.out), "restoredFiles": len(receipt["files"]),
                      "foldArtifacts": receipt["restoredFoldArtifacts"], "bundleManifestSha256": receipt["bundleManifest"]["sha256"]}))
    return receipt


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, EOFError, tarfile.TarError) as error:
        print(f"season_input_restore_failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
