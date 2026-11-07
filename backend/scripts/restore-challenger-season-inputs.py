"""Restore historical C data and saved predictions from the hash-checked bundle.

Local files and Python's standard library only. Historical model weights were
removed by request: this tool cannot regenerate forecasts or restore old models.
It preserves data bytes for integrity checks and saved-prediction metric audits.
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


SCHEMA = "challenger-season-data-bundle-v2"
CHUNK = 1024 * 1024
GZIP_OUTPUTS = {
    "nightly-extended-canonical.json.gz": "nightly-extended-canonical.json",
    "season-plan.json.gz": "season-plan.json",
    "comparison-plan.json.gz": "comparison-plan.json",
    "matches-frozen.json.gz": "matches.json",
}
COPY_OUTPUTS = {
    "predictions/bundle.json": "predictions/bundle.json",
    "predictions/audit.json": "predictions/audit.json",
    "predictions/predictions.jsonl.gz": "predictions/predictions.jsonl.gz",
}
PREDICTIONS = "predictions/predictions.jsonl.gz"
PRIOR_FILES = {"matches-frozen.json.gz"}
PRIOR_FOLDER = "c-data-audit-2026-10-31"
DEFAULT_EVIDENCE = Path(__file__).resolve().parents[2] / "docs/performance/evidence/c-three-season-backtest-2026-10-31"


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


def checked_source_path(evidence, name):
    # Names come only from fixed allowlists, never from manifest-selected paths.
    path = source_path(evidence, name)
    root = evidence.parent / PRIOR_FOLDER if name in PRIOR_FILES else evidence
    try:
        path.resolve(strict=True).relative_to(root.resolve(strict=True))
    except (OSError, ValueError) as error:
        raise ValueError(f"unsafe_or_missing_bundle_source: {name}") from error
    if not path.is_file():
        raise ValueError(f"invalid_bundle_source: {name}")
    return path


def check_gzip(path, info, label, sink=None):
    # Read the validated compressed bytes and decoded data through the same
    # descriptor, including during restore after the preflight integrity check.
    with path.open("rb") as raw:
        check_stream(raw, checked_digest(info, label), label)
        raw.seek(0)
        with gzip.GzipFile(fileobj=raw, mode="rb") as decoded:
            return check_stream(decoded, checked_digest(info, label, decoded=True), f"decoded:{label}", sink)


def validate_bundle(evidence):
    manifest_path = evidence / "bundle-files.json"
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(manifest, dict) or manifest.get("schemaVersion") != SCHEMA or not isinstance(files, dict):
        raise ValueError("invalid_season_data_bundle_manifest")
    required = set(GZIP_OUTPUTS) | set(COPY_OUTPUTS)
    if set(files) != required:
        raise ValueError("unexpected_or_missing_season_data_bundle_file_metadata")
    for name in sorted(required):
        source = checked_source_path(evidence, name)
        if name in GZIP_OUTPUTS or name == PREDICTIONS:
            check_gzip(source, files[name], name)
        else:
            with source.open("rb") as stream:
                check_stream(stream, checked_digest(files[name], name), name)
    prediction_manifest = json.loads(checked_source_path(evidence, "predictions/bundle.json").read_bytes())
    wanted = checked_digest(files[PREDICTIONS], PREDICTIONS, decoded=True)
    if (not isinstance(prediction_manifest, dict)
            or prediction_manifest.get("schemaVersion") != "independent-challenger-metrics-audit-v1"
            or prediction_manifest.get("predictionsFile") != "predictions.jsonl.gz"
            or prediction_manifest.get("predictionsSha256") != wanted["sha256"]
            or prediction_manifest.get("predictionsBytes") != wanted["bytes"]):
        raise ValueError("invalid_saved_prediction_bundle_reference")
    return files, {"sha256": hashlib.sha256(manifest_bytes).hexdigest(), "bytes": len(manifest_bytes)}


def restore(evidence, output):
    evidence, output = Path(evidence).resolve(), Path(output).absolute()
    # lexists also refuses a dangling symlink; existing paths are never owned.
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
            with target.open("xb") as sink:
                restored[relative] = check_gzip(checked_source_path(evidence, name), files[name], name, sink)
        for name, relative in COPY_OUTPUTS.items():
            target = output / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with checked_source_path(evidence, name).open("rb") as source, target.open("xb") as sink:
                restored[relative] = check_stream(source, checked_digest(files[name], name), name, sink)
        # Verify the copied compressed predictions too; the receipt hashes their
        # encoded bytes, while bundle.json pins the decoded JSONL used by audits.
        check_gzip(output / PREDICTIONS, files[PREDICTIONS], PREDICTIONS)
        receipt = {"schemaVersion": "restored-challenger-season-data-v2", "bundleManifest": manifest_digest,
            "files": dict(sorted(restored.items())), "modelWeightsRestored": 0,
            "modelReconstructionAvailable": False, "savedPredictionMetricsAvailable": True,
            "limitation": "Historical model weights were removed by request; forecasts cannot be regenerated.",
            "semantics": "exact_data_and_saved_prediction_bytes_hash_verified_no_training_adoption_or_source_timestamp_claim"}
        with (output / "restore-manifest.json").open("x", encoding="utf-8", newline="\n") as stream:
            json.dump(receipt, stream, indent=2, ensure_ascii=False)
            stream.write("\n")
        return receipt
    except BaseException:
        # Cleanup only the exact new directory created by this invocation.
        if created and not output.is_symlink() and output.resolve(strict=False) == owned_root:
            shutil.rmtree(output)
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--out", type=Path, required=True, help="New data restore directory; existing paths are refused")
    options = parser.parse_args(argv)
    receipt = restore(options.evidence, options.out)
    print(json.dumps({"restoredTo": str(options.out), "restoredFiles": len(receipt["files"]),
        "modelWeightsRestored": 0, "modelReconstructionAvailable": False,
        "bundleManifestSha256": receipt["bundleManifest"]["sha256"]}))
    return receipt


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, EOFError) as error:
        print(f"season_data_restore_failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
