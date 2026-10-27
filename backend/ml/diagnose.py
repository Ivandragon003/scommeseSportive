"""Bounded, chronological development experiments. No final-holdout fitting or network.

This diagnostic runner reuses train.py's CatBoost integration and numeric joint
distribution. It never writes the original training run, the shared database or
the production registry. Artifacts are diagnostic-only until separately validated.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys

import numpy as np
from catboost import CatBoostClassifier, CatBoostRegressor, Pool, __version__ as CATBOOST_VERSION

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import train as trainer

SEED = 20261027
WEIGHTS = (0, .1, .25, .5, .75, 1)
TEMPERATURES = (.8, .9, 1, 1.1, 1.25)
KINDS = trainer.KINDS
EPS = 1e-15


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def dump(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":"), allow_nan=False), encoding="utf-8")


def protected_development_rows(dataset, original):
    """The observed original final holdout can only be excluded, never retuned."""
    version = original["finalHoldout"]["version"]
    protected = {row["matchId"] for row in original["predictions"] if row["versionC"] == version}
    if len(protected) != original["finalHoldout"]["testN"]:
        raise ValueError("protected_holdout_identity_mismatch")
    cutoff = min(trainer.timestamp(row["forecastAt"]) for row in original["predictions"] if row["matchId"] in protected)
    rows = [row for row in dataset["rows"] if row["matchId"] not in protected and trainer.timestamp(row["forecastAt"]) < cutoff]
    if any(row["matchId"] in protected for row in rows):
        raise ValueError("protected_holdout_contamination")
    return rows, sorted(protected), cutoff


def development_folds(rows, count=3):
    """Expanding training, separate selection/calibration and disjoint dev checks."""
    rows = sorted(rows, key=lambda row: (trainer.timestamp(row["forecastAt"]), row["matchId"]))
    times = sorted({row["forecastAt"] for row in rows}, key=trainer.timestamp)
    boundaries = np.linspace(int(len(times) * .65), len(times), count + 1, dtype=int)
    for index, (start, end) in enumerate(zip(boundaries[:-1], boundaries[1:])):
        calibration_start = max(2, start - int(len(times) * .065))
        selection_start = max(1, calibration_start - int(len(times) * .10))
        ts = trainer.timestamp
        selection_time, calibration_time, check_time = map(ts, [times[selection_start], times[calibration_start], times[start]])
        end_time = ts(times[end]) if end < len(times) else float("inf")
        train = [row for row in rows if ts(row["forecastAt"]) < selection_time and ts(row["availableAt"]) < selection_time]
        selection = [row for row in rows if selection_time <= ts(row["forecastAt"]) < calibration_time and ts(row["availableAt"]) < calibration_time]
        calibration = [row for row in rows if calibration_time <= ts(row["forecastAt"]) < check_time and ts(row["availableAt"]) < check_time]
        check = [row for row in rows if check_time <= ts(row["forecastAt"]) < end_time]
        if min(map(len, [train, selection, calibration, check])) < 30:
            raise ValueError("insufficient_development_fold")
        yield {"index": index, "train": train, "selection": selection, "calibration": calibration, "check": check}


def feature_groups(names):
    group = lambda suffixes: [i for i, name in enumerate(names) if any(name.endswith(suffix) for suffix in suffixes)]
    basic = group(("_sample", "_goals_for", "_goals_against", "_shots_for", "_shots_against", "_rest_days"))
    basic = [i for i in basic if not any(token in names[i] for token in ("season_", "venue_"))]
    # A's intensities and league indicators are always admissible baseline context.
    basic += [i for i, name in enumerate(names) if name.startswith("lambda_") or name.startswith("league_")]
    groups = {"basic": sorted(set(basic)), "xg": group(("_xg_for", "_xg_against", "_xg_coverage")),
              "recent": group(("_recent_points", "_recent_goal_diff")),
              "elo": [i for i, name in enumerate(names) if "elo" in name],
              "venue": group(("_venue_goals_for", "_venue_goals_against")),
              "season": group(("_season_goals_for", "_season_goals_against"))}
    ablations = {"basic": groups["basic"]}
    for name in ("xg", "recent", "elo", "venue"):
        ablations[f"basic_plus_{name}"] = sorted(set(groups["basic"] + groups[name]))
    ablations["full"] = list(range(len(names)))
    return groups, ablations


def masked(rows, indices):
    allowed = set(indices)
    return [{**row, "features": [value if i in allowed else 0 for i, value in enumerate(row["features"])]} for row in rows]


def chronological_reduced_masks(names, groups, group_utility, individual, fold_indices):
    """A later selection window can never choose an earlier check's feature set."""
    group_masks, feature_masks = {}, {}
    always = [i for i, name in enumerate(names) if name.startswith("lambda_") or name.startswith("league_")]
    for fold in fold_indices:
        needed = min(2, fold + 1)
        stable_groups = [group for group, deltas in group_utility.items()
                         if sum(value > 0 for value in deltas[:fold + 1]) >= needed
                         and float(np.mean(deltas[:fold + 1])) > 0]
        group_masks[fold] = sorted(set(groups["basic"] + [index for group in stable_groups for index in groups[group]]))
        stable_features = [name for name in names if sum(item["feature"] == name and item["fold"] <= fold
            and item["weekLogLossCI"][0] > 0 for item in individual) >= needed]
        feature_masks[fold] = sorted(set(always + [i for i, name in enumerate(names) if name in stable_features]))
    return group_masks, feature_masks


def probabilities(matrices):
    matrices = np.asarray(matrices)
    return np.column_stack((np.tril(matrices, -1).sum(axis=(1, 2)),
                            np.trace(matrices, axis1=1, axis2=2), np.triu(matrices, 1).sum(axis=(1, 2))))


def mix(baselines, ml, weight, temperature):
    matrices = np.maximum(EPS, (1 - weight) * np.asarray(baselines) + weight * np.asarray(ml)) ** (1 / temperature)
    return matrices / matrices.sum(axis=(1, 2), keepdims=True)


def losses(rows, probs):
    probs = np.asarray(probs, dtype=float)
    probs = probs / probs.sum(axis=1, keepdims=True)
    y = np.array([trainer.class_of(row) for row in rows])
    actual = np.eye(3)[y]
    return -np.log(np.clip(probs[np.arange(len(y)), y], EPS, 1)), np.sum((probs - actual) ** 2, axis=1)


def calibration_bins(probs, actual):
    bins = []
    probs, actual = np.asarray(probs).ravel(), np.asarray(actual).ravel()
    index = np.minimum(9, (probs * 10).astype(int))
    for bucket in range(10):
        mask = index == bucket
        n = int(mask.sum())
        if n:
            bins.append({"lower": bucket / 10, "upper": (bucket + 1) / 10, "n": n,
                         "predicted": float(probs[mask].mean()), "observed": float(actual[mask].mean())})
    ece = sum(bucket["n"] * abs(bucket["predicted"] - bucket["observed"]) for bucket in bins) / max(1, len(probs))
    return ece, bins


def metric(rows, probs, breakdown=True):
    probs = np.asarray(probs, dtype=float)
    probs = probs / probs.sum(axis=1, keepdims=True)
    ll, bs = losses(rows, probs)
    y = np.array([trainer.class_of(row) for row in rows])
    top, top_bins = calibration_bins(probs.max(axis=1), (probs.argmax(axis=1) == y).astype(int))
    pooled, pooled_bins = calibration_bins(probs, np.eye(3)[y])
    output = {"n": len(rows), "logLoss": float(ll.mean()), "brier": float(bs.mean()),
              "ece": top, "topLabelEce": top, "classwisePooledEce": pooled,
              "calibration": top_bins, "classwiseCalibration": pooled_bins}
    if breakdown:
        for field, label in (("competition", "byLeague"), ("season", "bySeason")):
            output[label] = {}
            for value in sorted({str(row.get(field, "unknown")) for row in rows}):
                indices = [i for i, row in enumerate(rows) if str(row.get(field, "unknown")) == value]
                output[label][value] = metric([rows[i] for i in indices], probs[indices], False)
    return output


def paired(rows, a, c, samples=1000):
    lla, bsa = losses(rows, a); llc, bsc = losses(rows, c)
    groups = {}
    for i, row in enumerate(rows):
        week = int(trainer.timestamp(row["kickoffAt"]) // (7 * 86400))
        groups.setdefault(week, []).append(i)
    blocks = list(groups.values())
    rng = np.random.default_rng(SEED)
    draws = rng.integers(0, len(blocks), size=(samples, len(blocks)))
    counts = np.array([len(block) for block in blocks])
    result = {"n": len(rows), "weekClusters": len(blocks), "method": "paired_week_block_bootstrap", "confidence": .95}
    for name, values in (("LogLoss", llc - lla), ("Brier", bsc - bsa)):
        totals = np.array([values[block].sum() for block in blocks])
        estimates = totals[draws].sum(axis=1) / counts[draws].sum(axis=1)
        result[f"delta{name}"] = float(values.mean())
        result[f"week{name}CI"] = [float(x) for x in np.quantile(estimates, [.025, .975])]
    return result


def fit_isotonic(predictions, outcomes):
    paired_values = sorted(zip(predictions, outcomes), key=lambda pair: pair[0])
    buckets = min(10, len(paired_values) // 5)
    if buckets < 2:
        return [(0., 0.), (1., 1.)]
    size = math.ceil(len(paired_values) / buckets)
    pools = []
    for start in range(0, len(paired_values), size):
        values = paired_values[start:start + size]
        pools.append([float(np.mean([v[0] for v in values])), float(np.mean([v[1] for v in values])), 1])
    while any(pools[i][1] > pools[i + 1][1] for i in range(len(pools) - 1)):
        for i in range(len(pools) - 1):
            if pools[i][1] > pools[i + 1][1]:
                a, b = pools[i:i + 2]; weight = a[2] + b[2]
                pools[i:i + 2] = [[(a[0] * a[2] + b[0] * b[2]) / weight,
                                  (a[1] * a[2] + b[1] * b[2]) / weight, weight]]
                break
    return [(0., 0.)] + [(pool[0], pool[1]) for pool in pools] + [(1., 1.)]


def apply_isotonic(probs, points, n):
    values = np.asarray(probs, dtype=float)
    corrected = np.interp(values, [point[0] for point in points], [point[1] for point in points])
    alpha = .9 if n < 200 else max(.1, 1 / (1 + n / 1000))
    corrected = np.clip(alpha * values + (1 - alpha) * corrected, .01, .99)
    return corrected / corrected.sum(axis=1, keepdims=True)


def isotonic_profile(rows, probs, legacy_family=False):
    predictions, outcomes = [], []
    for row, p in zip(rows, probs):
        label = trainer.class_of(row)
        values = list(p); observed = list(np.eye(3)[label])
        if legacy_family:
            values += [p[0] + p[1], p[1] + p[2], p[0] + p[2]]
            observed += [int(label != 2), int(label != 0), int(label != 1)]
            if label != 1:
                values += [p[0] / (p[0] + p[2]), p[2] / (p[0] + p[2])]
                observed += [int(label == 0), int(label == 2)]
        predictions.extend(values); outcomes.extend(observed)
    return {"points": fit_isotonic(predictions, outcomes), "nObservations": len(predictions),
            "matches": len(rows), "target": "legacy_mixed_1x2_dc_dnb" if legacy_family else "normalized_1x2_only"}


def project(matrices, target):
    matrices = np.asarray(matrices, dtype=float)
    prior = probabilities(matrices)
    size = matrices.shape[1]
    h, a = np.indices((size, size))
    partition = np.where(h > a, 0, np.where(h == a, 1, 2))
    ratios = np.asarray(target) / np.maximum(EPS, prior)
    adjusted = matrices * ratios[:, partition]
    return adjusted / adjusted.sum(axis=(1, 2), keepdims=True)


def fit_models(train, names, parameters, time_half_life=None):
    x = np.asarray([row["features"] for row in train], dtype=float)
    labels = np.array([trainer.class_of(row) for row in train])
    sample_weight = None
    if time_half_life:
        latest = max(trainer.timestamp(row["forecastAt"]) for row in train)
        sample_weight = np.exp(-np.log(2) * np.array([latest - trainer.timestamp(row["forecastAt"]) for row in train]) / (time_half_life * 86400))
    settings = {"iterations": parameters["iterations"], "depth": parameters["depth"], "learning_rate": parameters["learningRate"],
                "l2_leaf_reg": parameters.get("l2LeafReg", 3), "random_seed": SEED, "thread_count": 2,
                "verbose": False, "allow_writing_files": False}
    models = {}
    for residual, kind in ((True, KINDS[0]), (False, KINDS[2])):
        pair = {}
        for side in ("home", "away"):
            baseline = np.log(np.maximum(.05, [row[f"lambda{side.title()}"] for row in train])) if residual else None
            model = CatBoostRegressor(loss_function="Poisson", **settings)
            model.fit(Pool(x, label=[row[f"{side}Goals"] for row in train], baseline=baseline,
                           weight=sample_weight, feature_names=names))
            pair[side] = model
        models[kind] = pair
    model = CatBoostClassifier(loss_function="MultiClass", classes_count=3, **settings)
    model.fit(Pool(x, label=labels, baseline=np.log(np.maximum(EPS, probabilities([row["baselineMatrix"] for row in train]))),
                   weight=sample_weight, feature_names=names))
    models[KINDS[1]] = {"probability": model}
    return models


def choose_mix(rows, baselines, raw, weights=WEIGHTS):
    best = None
    for weight in weights:
        for temperature in TEMPERATURES:
            ll, _ = losses(rows, probabilities(mix(baselines, raw, weight, temperature)))
            choice = {"weight": float(weight), "temperature": float(temperature), "selectionLogLoss": float(ll.mean())}
            if best is None or choice["selectionLogLoss"] < best["selectionLogLoss"] - 1e-12:
                best = choice
    return best


def market_metrics(rows, matrices):
    """Probability scores, not simulated payouts; pushes are not labelled losses."""
    matrices = np.asarray(matrices); size = matrices.shape[1]
    h, a = np.indices((size, size)); actual_h = np.array([row["homeGoals"] for row in rows]); actual_a = np.array([row["awayGoals"] for row in rows])
    out = {}
    def binary(name, p, y, weight=None):
        p, y = np.asarray(p, dtype=float), np.asarray(y, dtype=float); weight = np.ones(len(y)) if weight is None else np.asarray(weight)
        eligible = weight > 0
        if not eligible.any():
            return
        weight, p, y = weight[eligible], p[eligible], y[eligible]
        log = -y * np.log(np.clip(p, EPS, 1)) - (1 - y) * np.log(np.clip(1 - p, EPS, 1))
        out[name] = {"n": int(eligible.sum()), "effectiveStakeSamples": float(weight.sum()),
                     "logLoss": float(np.average(log, weights=weight)), "brier": float(np.average((p - y) ** 2, weights=weight))}
    p = probabilities(matrices)
    binary("double_chance_1x", p[:, 0] + p[:, 1], actual_h >= actual_a)
    binary("double_chance_x2", p[:, 2] + p[:, 1], actual_h <= actual_a)
    binary("double_chance_12", p[:, 0] + p[:, 2], actual_h != actual_a)
    binary("dnb_home", p[:, 0] / np.maximum(EPS, p[:, 0] + p[:, 2]), actual_h > actual_a, (actual_h != actual_a).astype(int))
    binary("btts", matrices[:, (h > 0) & (a > 0)].sum(axis=1), (actual_h > 0) & (actual_a > 0))
    for line in (.5, 1.5, 2.5, 3.5, 4.5):
        for prefix, grid, observed in (("totals", h + a, actual_h + actual_a), ("team_home", h, actual_h), ("team_away", a, actual_a)):
            binary(f"{prefix}_over_{line}", matrices[:, grid > line].sum(axis=1), observed > line)
    for line in (-1, 0, 1):
        predicted = np.column_stack([matrices[:, h - a + line > 0].sum(axis=1), matrices[:, h - a + line == 0].sum(axis=1), matrices[:, h - a + line < 0].sum(axis=1)])
        target = np.where(actual_h - actual_a + line > 0, 0, np.where(actual_h - actual_a + line == 0, 1, 2))
        ll = -np.log(np.clip(predicted[np.arange(len(rows)), target], EPS, 1))
        out[f"european_handicap_home_{line}"] = {"n": len(rows), "logLoss": float(ll.mean()), "brier": float(((predicted - np.eye(3)[target]) ** 2).sum(axis=1).mean()), "target": "three_mutually_exclusive_results"}
    for line in (-1, -.75, -.5, -.25, 0, .25, .5, .75, 1):
        components = [line] if line * 2 == round(line * 2) else [math.floor(line * 2) / 2, math.ceil(line * 2) / 2]
        win = sum((h - a + value > 0).astype(float) for value in components) / len(components)
        loss = sum((h - a + value < 0).astype(float) for value in components) / len(components)
        wp = (matrices * win).sum(axis=(1, 2)); lp = (matrices * loss).sum(axis=(1, 2))
        actual_win = sum((actual_h - actual_a + value > 0).astype(float) for value in components) / len(components)
        actual_loss = sum((actual_h - actual_a + value < 0).astype(float) for value in components) / len(components)
        active = actual_win + actual_loss
        binary(f"asian_handicap_home_{line}", wp / np.maximum(EPS, wp + lp), actual_win / np.maximum(EPS, active), active)
    return out


def calibration_variants(calibration, check, c_cal, c_check):
    result = {"identity": {"matrix": c_check, "fit": None}}
    for name, legacy in (("legacy_family_isotonic_normalized", True), ("isotonic_1x2_coherent", False)):
        profile = isotonic_profile(calibration, probabilities(c_cal), legacy)
        target = apply_isotonic(probabilities(c_check), profile["points"], profile["nObservations"])
        result[name] = {"matrix": project(c_check, target), "fit": profile}
    temperature = min(TEMPERATURES, key=lambda t: losses(calibration, probabilities(mix(c_cal, c_cal, 0, t)))[0].mean())
    result["temperature_joint_coherent"] = {"matrix": mix(c_check, c_check, 0, temperature), "fit": {"temperature": temperature, "selectedOn": "calibration_interval_only"}}
    return result


def fold_manifest(fold):
    return {"fold": fold["index"], **{f"{key}N": len(fold[key]) for key in ("train", "selection", "calibration", "check")},
            **{f"{key}From": fold[key][0]["forecastAt"] for key in ("train", "selection", "calibration", "check")},
            **{f"{key}To": fold[key][-1]["forecastAt"] for key in ("train", "selection", "calibration", "check")},
            "checkMatchIds": [row["matchId"] for row in fold["check"]]}


def run(args):
    dataset_path, raw_path, original_path = map(Path, (args.dataset, args.matches, args.original))
    dataset, raw, original = [json.loads(path.read_bytes()) for path in (dataset_path, raw_path, original_path)]
    execution_hash = digest(__file__)
    original_dir = original_path.parent
    immutable = {str(path): digest(path) for path in original_dir.rglob("*") if path.is_file()}
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    rows, protected, cutoff = protected_development_rows(dataset, original)
    names = dataset["featureNames"]; groups, ablations = feature_groups(names)
    folds = list(development_folds(rows, args.folds))
    try:
        from diagnostics.dataset_audit import audit_dataset
        audit = audit_dataset(dataset, raw, original, json.loads((original_dir / "pipeline-report.json").read_bytes()))
    except ImportError:
        audit = {"status": "pending_dataset_audit_helper"}
    dump(output / "audit.json", audit)
    base_parameters = {"iterations": args.iterations, "depth": 5, "learningRate": .05, "l2LeafReg": 3}
    experiment_data = {}
    importance = {"predictionValuesChange": [], "permutation": [], "individualPermutation": [], "shap": []}
    selected_group_utility = {key: [] for key in groups if key != "basic"}
    def run_setting(feature_label, indices, parameters, history_days=None, half_life=None, importance_run=False):
        masks_by_fold = indices if isinstance(indices, dict) else None
        final_indices = indices[folds[-1]["index"]] if masks_by_fold else indices
        key = {"featureGroup": feature_label, "featureMask": final_indices,
               "featureMasksByFold": masks_by_fold, "hyperparameters": parameters,
               "historyDays": history_days, "timeHalfLifeDays": half_life}
        setting_id = hashlib.sha256(json.dumps({**key, "runnerHash": execution_hash,
            "datasetHash": digest(dataset_path)}, sort_keys=True).encode()).hexdigest()[:16]
        for fold in folds:
            current_indices = indices[fold["index"]] if masks_by_fold else indices
            partitions = {part: masked(fold[part], current_indices) for part in ("train", "selection", "calibration", "check")}
            if history_days:
                latest = max(trainer.timestamp(row["forecastAt"]) for row in partitions["train"])
                partitions["train"] = [row for row in partitions["train"] if latest - trainer.timestamp(row["forecastAt"]) <= history_days * 86400]
            models = fit_models(partitions["train"], names, parameters, half_life)
            baselines = {part: np.asarray([row["baselineMatrix"] for row in partitions[part]]) for part in ("selection", "calibration", "check")}
            for kind in KINDS:
                raw_matrices = {part: np.asarray(trainer.raw_matrices(partitions[part], kind, models[kind])) for part in baselines}
                selection = choose_mix(partitions["selection"], baselines["selection"], raw_matrices["selection"])
                c_cal = mix(baselines["calibration"], raw_matrices["calibration"], selection["weight"], selection["temperature"])
                c_check = mix(baselines["check"], raw_matrices["check"], selection["weight"], selection["temperature"])
                variants = calibration_variants(partitions["calibration"], partitions["check"], c_cal, c_check)
                for method, variant in variants.items():
                    experiment_id = f"{setting_id}:{kind}:{method}"
                    storage = experiment_data.setdefault(experiment_id, {"id": experiment_id, **key, "kind": kind, "calibration": method,
                        "rows": [], "matrixA": [], "matrixC": [], "folds": []})
                    # Both sides receive the same selected calibration protocol.
                    a_cal = baselines["calibration"]; a_check = baselines["check"]
                    if method.startswith("legacy_family") or method == "isotonic_1x2_coherent":
                        profile_a = isotonic_profile(partitions["calibration"], probabilities(a_cal), method.startswith("legacy_family"))
                        a_check = project(a_check, apply_isotonic(probabilities(a_check), profile_a["points"], profile_a["nObservations"]))
                    elif method == "temperature_joint_coherent":
                        t = min(TEMPERATURES, key=lambda value: losses(partitions["calibration"], probabilities(mix(a_cal, a_cal, 0, value)))[0].mean())
                        a_check = mix(a_check, a_check, 0, t)
                    c_matrix = variant["matrix"]
                    storage["rows"].extend(partitions["check"]); storage["matrixA"].extend(a_check); storage["matrixC"].extend(c_matrix)
                    storage["folds"].append({"fold": fold["index"], **selection, "trainingN": len(partitions["train"]),
                        "featureMask": current_indices,
                        "metricsA": metric(partitions["check"], probabilities(a_check)), "metricsC": metric(partitions["check"], probabilities(c_matrix)),
                        "calibrationFit": variant["fit"]})
                if fold["index"] == folds[-1]["index"]:
                    bundle_dir = output / "models" / setting_id / kind; bundle_dir.mkdir(parents=True, exist_ok=True)
                    paths = {}
                    for model_name, model in models[kind].items():
                        path = bundle_dir / f"{model_name}.json"; model.save_model(str(path), format="json")
                        paths[model_name] = {"path": str(path), "sha256": digest(path)}
                    for method in variants:
                        experiment_data[f"{setting_id}:{kind}:{method}"]["modelArtifactPaths"] = paths
            if importance_run:
                # Selection evidence can inform a reduced group. Check labels never enter that choice.
                kind = min(KINDS, key=lambda kind: choose_mix(partitions["selection"], baselines["selection"],
                    np.asarray(trainer.raw_matrices(partitions["selection"], kind, models[kind])))["selectionLogLoss"])
                bundle = models[kind]
                values = np.mean([model.get_feature_importance(type="PredictionValuesChange") for model in bundle.values()], axis=0)
                importance["predictionValuesChange"].append({"fold": fold["index"], "kind": kind,
                    "values": [{"feature": name, "importance": float(value)} for name, value in zip(names, values)]})
                sample = partitions["selection"]
                selection_mix = choose_mix(sample, baselines["selection"], np.asarray(trainer.raw_matrices(sample, kind, bundle)))
                original_probabilities = probabilities(mix(baselines["selection"], trainer.raw_matrices(sample, kind, bundle), selection_mix["weight"], selection_mix["temperature"]))
                original_ll = losses(sample, original_probabilities)[0].mean()
                rng = np.random.default_rng(SEED + fold["index"])
                for group_name, group_indices in groups.items():
                    if group_name == "basic":
                        continue
                    permuted = [{**row, "features": list(row["features"])} for row in sample]
                    for league in sorted({row["competition"] for row in sample}):
                        positions = [i for i, row in enumerate(sample) if row["competition"] == league]
                        shuffled = rng.permutation(positions)
                        for target, source in zip(positions, shuffled):
                            for column in group_indices:
                                permuted[target]["features"][column] = sample[source]["features"][column]
                    changed = trainer.raw_matrices(permuted, kind, bundle)
                    delta = float(losses(sample, probabilities(mix(baselines["selection"], changed, selection_mix["weight"], selection_mix["temperature"])))[0].mean() - original_ll)
                    selected_group_utility[group_name].append(delta)
                    importance["permutation"].append({"fold": fold["index"], "group": group_name, "kind": kind,
                        "selectionOnly": True, "deltaLogLoss": delta, "n": len(sample)})
                # Individual utility is accepted only with a positive lower block
                # interval in two development selection windows. No check label
                # or protected final label chooses the reduced feature set.
                for column, feature in enumerate(names):
                    permuted = [{**row, "features": list(row["features"])} for row in sample]
                    for league in sorted({row["competition"] for row in sample}):
                        positions = [i for i, row in enumerate(sample) if row["competition"] == league]
                        for target, source in zip(positions, rng.permutation(positions)):
                            permuted[target]["features"][column] = sample[source]["features"][column]
                    changed = trainer.raw_matrices(permuted, kind, bundle)
                    changed_probabilities = probabilities(mix(baselines["selection"], changed, selection_mix["weight"], selection_mix["temperature"]))
                    evidence = paired(sample, original_probabilities, changed_probabilities)
                    importance["individualPermutation"].append({"fold": fold["index"], "feature": feature,
                        "kind": kind, "selectionOnly": True, "n": len(sample), **evidence})
                subset = sample[-min(100, len(sample)):]
                x = np.asarray([row["features"] for row in subset])
                shap_values = []
                for name, model in bundle.items():
                    shap = np.asarray(model.get_feature_importance(Pool(x, feature_names=names), type="ShapValues"))
                    mean_abs = np.mean(np.abs(shap[..., :-1]), axis=tuple(range(shap.ndim - 1)))
                    shap_values.append({"model": name, "meanAbsolute": [{"feature": feature, "value": float(value)} for feature, value in zip(names, mean_abs)]})
                importance["shap"].append({"fold": fold["index"], "kind": kind, "n": len(subset), "selectionOnly": True,
                    "values": shap_values, "causalInterpretation": False})
            print(json.dumps({"setting": setting_id, "features": feature_label, "fold": fold["index"], "trained": len(partitions["train"])}), flush=True)
    for label, indices in ablations.items():
        run_setting(label, indices, base_parameters, importance_run=label == "full")
    reduced, reduced_features = chronological_reduced_masks(names, groups, selected_group_utility,
        importance["individualPermutation"], [fold["index"] for fold in folds])
    stable_groups = [group for group, deltas in selected_group_utility.items() if sum(value > 0 for value in deltas) >= min(2, len(folds)) and float(np.mean(deltas)) > 0]
    run_setting("reduced_stable_selection_groups", reduced, base_parameters)
    run_setting("reduced_stable_selection_features", reduced_features, base_parameters)
    # Limited hypotheses after the feature audit: less tree variance, stronger L2,
    # shorter label history and smooth temporal weighting. Not a broad grid search.
    for parameters in ({"iterations": 60, "depth": 3, "learningRate": .05, "l2LeafReg": 10},
                       {"iterations": 180, "depth": 4, "learningRate": .03, "l2LeafReg": 10}):
        run_setting("reduced_stable_selection_groups", reduced, parameters)
    run_setting("reduced_history_730_days", reduced, base_parameters, history_days=730)
    run_setting("reduced_temporal_half_life_365_days", reduced, base_parameters, half_life=365)
    experiments = []
    for item in experiment_data.values():
        check_rows = item.pop("rows"); a = np.asarray(item.pop("matrixA")); c = np.asarray(item.pop("matrixC"))
        p_a, p_c = probabilities(a), probabilities(c)
        item.update({"family": "C", "status": "DEVELOPMENT_ONLY", "diagnosticOnly": True, "runtimeCompatible": False,
            "intendedInference": "masked_numeric_features", "metricsA": metric(check_rows, p_a), "metricsC": metric(check_rows, p_c),
            "paired": paired(check_rows, p_a, p_c), "byMarket": {"A": market_metrics(check_rows, a), "C": market_metrics(check_rows, c)},
            "productionPromotion": False, "checkMatchIdsHash": hashlib.sha256("\n".join(row["matchId"] for row in check_rows).encode()).hexdigest()})
        experiments.append(item)
    # Negative controls distinguish ML information from joint-temperature effects.
    controls = []
    for control in ("A_identity", "A_temperature_only"):
        all_rows, before, after, settings = [], [], [], []
        for fold in folds:
            base = np.asarray([row["baselineMatrix"] for row in fold["check"]])
            selection = np.asarray([row["baselineMatrix"] for row in fold["selection"]])
            temperature = 1 if control == "A_identity" else choose_mix(fold["selection"], selection, selection, weights=(0,))["temperature"]
            all_rows.extend(fold["check"]); before.extend(base); after.extend(mix(base, base, 0, temperature)); settings.append({"fold": fold["index"], "temperature": temperature, "weight": 0})
        controls.append({"id": control, "family": "C", "kind": "no_ml_control", "diagnosticOnly": True, "runtimeCompatible": False,
            "metricsA": metric(all_rows, probabilities(before)), "metricsC": metric(all_rows, probabilities(after)),
            "paired": paired(all_rows, probabilities(before), probabilities(after)), "folds": settings, "productionPromotion": False})
    immutable_after = {str(path): digest(path) for path in original_dir.rglob("*") if path.is_file()}
    if immutable != immutable_after or digest(__file__) != execution_hash:
        raise RuntimeError("original_run_modified_during_diagnostics")
    report = {"schemaVersion": "research-diagnostics-v1", "createdAt": datetime.now(timezone.utc).isoformat(),
        "datasetHash": digest(dataset_path), "runnerHash": execution_hash,
        "auditHelperHash": digest(HERE / "diagnostics/dataset_audit.py"), "catboostVersion": CATBOOST_VERSION,
        "audit": audit, "protection": {"originalRunFiles": immutable, "protectedFinalMatchIds": protected,
            "protectedFinalIdsHash": hashlib.sha256("\n".join(protected).encode()).hexdigest(), "excludedFinalN": len(protected),
            "developmentRows": len(rows), "developmentCutoffExclusive": datetime.fromtimestamp(cutoff, timezone.utc).isoformat(),
            "originalFilesUnchanged": True, "newIndependentHoldout": False},
        "developmentProtocol": {"seed": SEED, "folds": [fold_manifest(fold) for fold in folds], "mixingWeights": WEIGHTS,
            "jointTemperatures": TEMPERATURES, "purpose": "development_comparison_not_promotion", "calibrationLabelsSeparateFromSelection": True,
            "featureReductionRule": "For each check fold use only current or preceding selection windows: positive group permutation in min(2, available folds) windows and positive mean; basic always retained",
            "stableGroups": stable_groups, "futureAcceptance": "A new prospective period after experiment registration is required; the old 745 are permanently retired from tuning."},
        "featureGroups": {key: [names[index] for index in indices] for key, indices in groups.items()},
        "featureImportance": importance, "experiments": experiments, "negativeControls": controls,
        "recommendation": {"champion": "A", "promoteC": False, "conclusion": "development_results_require_new_prospective_validation"},
        "limitations": ["Development check periods are already observable and can support diagnosis, never a new independent success claim.",
            "No odds are ML features; there are no quote-labelled economic results in this file.",
            "Feature importance, SHAP and permutation do not imply causality; correlated predictors can divide attribution.",
            "History ablation limits training labels, not the historical depth already encoded in frozen feature averages.",
            "The legacy isotonic comparison is normalized onto the 1X2 simplex before scoring; the old incoherent runtime vector is not deployed."]}
    report["developmentProtocol"]["reducedFeatureNames"] = [names[i] for i in reduced_features[folds[-1]["index"]]]
    report["developmentProtocol"]["reducedFeatureNamesByFold"] = {str(fold): [names[i] for i in mask] for fold, mask in reduced_features.items()}
    report["developmentProtocol"]["individualFeatureReductionRule"] = "Per check fold retain A lambdas and league indicators; any other feature requires selection-only permutation weekly CI lower>0 in min(2, available previous/current selection folds). No future selection is consulted."
    dump(output / "diagnostics.json", report)
    print(json.dumps({"report": str(output / "diagnostics.json"), "experiments": len(experiments), "developmentRows": len(rows), "protectedFinalN": len(protected)}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True); parser.add_argument("--matches", required=True)
    parser.add_argument("--original", required=True); parser.add_argument("--output", required=True)
    parser.add_argument("--folds", type=int, default=3); parser.add_argument("--iterations", type=int, default=120)
    args = parser.parse_args()
    if not 1 <= args.folds <= 3 or not 5 <= args.iterations <= 200:
        parser.error("folds 1..3 and iterations 5..200 required")
    run(args)
