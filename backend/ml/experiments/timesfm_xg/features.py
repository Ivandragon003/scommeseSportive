"""Offline, strictly as-of xG contexts; only the public checkpoint download uses network."""
from __future__ import annotations

import argparse
from bisect import bisect_left
from collections import defaultdict
from datetime import datetime, timezone
import gzip
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import platform
import time

ROOT = Path(__file__).resolve().parents[3]
PROTOCOL_PATH = Path(__file__).with_name("protocol.json")
FEATURE_NAMES = [f"{side}_temporal_{metric}" for side in ("home", "away") for metric in ("xg", "xga")]


def digest(data):
    return hashlib.sha256(data).hexdigest()


def stamp(value):
    value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        raise ValueError("timezone_required")
    return value.timestamp()


def encode(value):
    return json.dumps(value, separators=(",", ":"), allow_nan=False).encode()


def weighted_mean(values, half_life=5):
    weights = [2 ** (-(len(values) - 1 - i) / half_life) for i in range(len(values))]
    return math.fsum(v * w for v, w in zip(values, weights)) / math.fsum(weights)


def history_index(matches, protected, quarantined):
    """Reject forbidden identities before reading their outcomes or xG values."""
    index, seen = defaultdict(list), set()
    for match in matches:
        identity = match["matchId"]
        if identity in protected or identity in quarantined:
            continue
        if identity in seen:
            raise ValueError("duplicate_source_identity")
        seen.add(identity)
        if match.get("homeGoals") is None or match.get("awayGoals") is None:
            continue
        xg = [match.get("homeXG"), match.get("awayXG")]
        if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in xg):
            continue  # Never replace missing xG with the match result.
        kickoff = stamp(match["date"])
        available = max(kickoff + 7200, stamp(match["availableAt"]) if match.get("availableAt") else -math.inf)
        for side, other in (("home", "away"), ("away", "home")):
            index[(match["competition"], match[f"{side}TeamId"])].append({
                "id": identity, "kickoff": kickoff, "available": available,
                "xg": match[f"{side}XG"], "xga": match[f"{other}XG"]})
    for entries in index.values():
        entries.sort(key=lambda e: (e["available"], e["id"]))
    return index


def build_contexts(dataset, matches, protected, quarantined, protocol):
    index = history_index(matches, protected, quarantined)
    clocks = {key: [e["available"] for e in entries] for key, entries in index.items()}
    contexts, rows, fallback_sides = {}, [], 0
    for row in dataset["rows"]:
        if row["matchId"] in protected or row["matchId"] in quarantined:
            raise ValueError("forbidden_target")
        cutoff = stamp(row["forecastAt"])
        if cutoff >= stamp(row["kickoffAt"]):
            raise ValueError("postmatch_target")
        legacy = dict(zip(dataset["featureNames"], row["features"]))
        result = {"matchId": row["matchId"], "wma": [], "timesfm": [], "contextKeys": [], "history": []}
        for side in ("home", "away"):
            key = (row["competition"], row[f"{side}TeamId"])
            entries = index.get(key, [])[:bisect_left(clocks.get(key, []), cutoff)]
            entries = sorted(entries, key=lambda e: (e["kickoff"], e["id"]))[-protocol["context"]:]
            if any(e["id"] == row["matchId"] or e["available"] >= cutoff for e in entries):
                raise ValueError("future_context")
            ids = [e["id"] for e in entries]
            result["history"].append({"ids": ids, "maximumAvailableAt": max((e["available"] for e in entries), default=None)})
            short = len(entries) < protocol["minimumHistory"]
            fallback_sides += int(short)
            for metric, legacy_name in (("xg", "xg_for"), ("xga", "xg_against")):
                if short:
                    result["wma"].append(float(legacy[f"{side}_{legacy_name}"]))
                    result["timesfm"].append(float(legacy[f"{side}_{legacy_name}"]))
                    result["contextKeys"].append(None)
                else:
                    values = [float(e[metric]) for e in entries]
                    identity = digest(encode({"ids": ids, "values": values}))
                    contexts.setdefault(identity, {"key": identity, "ids": ids, "values": values})
                    result["contextKeys"].append(identity)
                    result["wma"].append(weighted_mean(values, protocol["wmaHalfLifeMatches"]))
                    result["timesfm"].append(None)
        rows.append(result)
    return contexts, rows, fallback_sides


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--matches", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--cache", required=True)
    args = parser.parse_args()
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=False)
    protocol_bytes = PROTOCOL_PATH.read_bytes()
    protocol = json.loads(protocol_bytes)
    data_bytes = Path(args.dataset).read_bytes()
    if digest(data_bytes) != protocol["datasetSha256"]:
        raise ValueError("frozen_dataset_hash_mismatch")
    dataset = json.loads(data_bytes)
    policies = ROOT / "src/research"
    protected = set(json.loads((policies / "original-holdout-policy.json").read_bytes())["protectedOriginalFinalMatchIds"])
    quarantine_bytes = (policies / "challenger-data-quarantine.json").read_bytes()
    quarantined = {entry["matchId"] for entry in json.loads(quarantine_bytes)["entries"]}
    matches_bytes = Path(args.matches).read_bytes()
    if digest(matches_bytes) != "249233a01c52ddd2578b676ae0a464ecbcce01907e34b89138a23c15e1178dc9":
        raise ValueError("frozen_source_hash_mismatch")
    build_start = time.perf_counter()
    contexts, rows, fallbacks = build_contexts(dataset, json.loads(matches_bytes), protected, quarantined, protocol)
    build_seconds = time.perf_counter() - build_start
    (output / "protocol.json").write_bytes(protocol_bytes)
    print(json.dumps({"stage": "contexts", "rows": len(rows), "uniqueSeries": len(contexts), "fallbackSides": fallbacks}), flush=True)

    import numpy as np
    import psutil
    import torch
    import timesfm
    from huggingface_hub import snapshot_download

    torch.set_num_threads(protocol["timesfm"]["threads"])
    torch.set_num_interop_threads(1)
    torch.manual_seed(20261103)
    torch.use_deterministic_algorithms(True)
    process = psutil.Process()
    rss_max = process.memory_info().rss
    load_start = time.perf_counter()
    checkpoint = Path(snapshot_download(protocol["model"], revision=protocol["revision"], cache_dir=args.cache,
                                        token=False, allow_patterns=["config.json", "model.safetensors", "README.md"]))
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained(checkpoint, torch_compile=False)
    model.compile(timesfm.ForecastConfig(max_context=protocol["context"], max_horizon=1,
        per_core_batch_size=protocol["timesfm"]["batchSize"], normalize_inputs=True,
        force_flip_invariance=True, infer_is_positive=True, use_continuous_quantile_head=False))
    load_seconds = time.perf_counter() - load_start
    rss_max = max(rss_max, process.memory_info().rss)
    keys, batch, elapsed, repeat_error = sorted(contexts), protocol["timesfm"]["batchSize"], [], None
    start = time.perf_counter()
    with torch.inference_mode():
        for offset in range(0, len(keys), batch):
            selected = keys[offset:offset + batch]
            inputs = [np.asarray(contexts[key]["values"], dtype=np.float32) for key in selected]
            tick = time.perf_counter()
            point, _ = model.forecast(horizon=1, inputs=inputs)
            elapsed.append(time.perf_counter() - tick)
            if offset == 0:
                repeated, _ = model.forecast(horizon=1, inputs=inputs)
                repeat_error = float(np.max(np.abs(point - repeated)))
                if repeat_error != 0:
                    raise ValueError("nondeterministic_repeat_forecast")
            for key, value in zip(selected, point[:, 0]):
                if not np.isfinite(value):
                    raise ValueError("nonfinite_timesfm_output")
                contexts[key]["forecast"] = float(value)
            rss_max = max(rss_max, process.memory_info().rss)
            if offset % (batch * 20) == 0:
                print(json.dumps({"stage": "inference", "done": offset + len(selected), "total": len(keys),
                                  "seconds": round(time.perf_counter() - start, 2)}), flush=True)
    inference_seconds = time.perf_counter() - start
    clipped = {"wma": 0, "timesfm": 0}
    for row in rows:
        for i, key in enumerate(row["contextKeys"]):
            if key is not None:
                row["timesfm"][i] = contexts[key]["forecast"]
        for arm in clipped:
            for i, value in enumerate(row[arm]):
                clipped[arm] += int(not 0 <= value <= 8)
                row[arm][i] = min(8.0, max(0.0, value))
    checkpoint_hashes = {name: digest((checkpoint / name).read_bytes()) for name in ("config.json", "model.safetensors", "README.md")}
    metadata = {"protocolHash": digest(protocol_bytes), "sourceMatchesHash": digest(matches_bytes),
        "protectedCount": len(protected), "quarantineCount": len(quarantined), "fallbackSides": fallbacks,
        "uniqueSeries": len(contexts), "clippedFeatures": clipped, "contextBuildSeconds": build_seconds,
        "modelLoadIncludingDownloadSeconds": load_seconds, "inferenceSeconds": inference_seconds,
        "batchLatencyMedianSeconds": float(np.median(elapsed)), "batchLatencyP95Seconds": float(np.quantile(elapsed, .95)),
        "processPeakRssBytes": getattr(process.memory_info(), "peak_wset", rss_max), "sampledMaximumRssBytes": rss_max,
        "repeatBatchMaximumError": repeat_error, "checkpointFiles": checkpoint_hashes,
        "platform": platform.platform(), "processor": platform.processor(), "logicalCpus": psutil.cpu_count(),
        "versions": {name: importlib.metadata.version(name) for name in ("numpy", "torch", "timesfm", "catboost", "huggingface-hub", "psutil")},
        "modelTrainingProvenance": "model_card_GiftEvalPretrain_Wikimedia_to_Nov2023_Trends_to_end2022_synthetic_augmented_no_per_series_manifest",
        "pretrainingContaminationExcluded": False, "independentEvidence": False}
    document = {"schemaVersion": "timesfm-xg-features-v1", "datasetHash": digest(data_bytes),
                "featureNames": FEATURE_NAMES, "metadata": metadata, "rows": rows}
    (output / "features.json").write_bytes(encode(document))
    with (output / "contexts.jsonl.gz").open("wb") as stream:
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as zipped:
            for key in keys:
                zipped.write(encode(contexts[key]) + b"\n")
    (output / "metadata.json").write_bytes(encode(metadata))
    print(json.dumps({"stage": "complete", **metadata}), flush=True)


if __name__ == "__main__":
    main()
