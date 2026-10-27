"""Train numeric CatBoost challengers on an exported, chronological football dataset.

No network, credentials, betting writes, or synthetic production data. JSON models
are embedded in the artifact so the Node backend needs no Python for inference.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
from datetime import datetime, timezone

import numpy as np
from catboost import CatBoostClassifier, CatBoostRegressor, Pool, __version__ as catboost_version

KINDS = ("intensity_correction", "probability_correction", "calibrated_ensemble")
WEIGHTS = (0.0, 0.1, 0.25, 0.5, 0.75, 1.0)
TEMPERATURES = (0.8, 0.9, 1.0, 1.1, 1.25)


def timestamp(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def normalize(matrix):
    matrix = np.asarray(matrix, dtype=float)
    if not np.all(np.isfinite(matrix)) or np.any(matrix < 0) or matrix.sum() <= 0:
        raise ValueError("invalid_joint_matrix")
    return matrix / matrix.sum()


def result_probabilities(matrix):
    return np.array([np.tril(matrix, -1).sum(), np.trace(matrix), np.triu(matrix, 1).sum()])


def poisson_joint(home, away, size):
    def marginal(lam):
        values = [math.exp(-lam)]
        for k in range(1, size):
            values.append(values[-1] * lam / k)
        return np.array(values)
    return normalize(np.outer(marginal(home), marginal(away)))


def calibrated_mix(baseline, ml, weight, temperature):
    mixed = (1 - weight) * baseline + weight * ml
    return normalize(np.maximum(1e-15, mixed) ** (1 / temperature))


def class_of(row):
    return 0 if row["homeGoals"] > row["awayGoals"] else 1 if row["homeGoals"] == row["awayGoals"] else 2


def matrix_metrics(rows, matrices, use_a_flat=False):
    probs = np.array([[row["baselineProbabilities"][key] for key in ("homeWin", "draw", "awayWin")]
                      if use_a_flat else result_probabilities(matrix) for row, matrix in zip(rows, matrices)])
    y = np.array([class_of(row) for row in rows])
    actual = np.eye(3)[y]
    losses = -np.log(np.clip(probs[np.arange(len(y)), y], 1e-15, 1))
    brier = np.sum((probs - actual) ** 2, axis=1)
    bins = []
    for lower in np.linspace(0, 0.9, 10):
        mask = (probs >= lower) & (probs < lower + 0.1 + (1e-12 if lower > 0.89 else 0))
        count = int(mask.sum())
        if count:
            bins.append({"lower": float(lower), "upper": float(lower + 0.1), "n": count,
                         "predicted": float(probs[mask].mean()), "observed": float(actual[mask].mean())})
    ece = sum(bucket["n"] * abs(bucket["predicted"] - bucket["observed"]) for bucket in bins) / max(1, len(y) * 3)
    by_league = {}
    for league in sorted({row["competition"] for row in rows}):
        mask = np.array([row["competition"] == league for row in rows])
        by_league[league] = {"n": int(mask.sum()), "logLoss": float(losses[mask].mean()), "brier": float(brier[mask].mean())}
    by_season = {}
    for season in sorted({str(row.get("season", "unknown")) for row in rows}):
        mask = np.array([str(row.get("season", "unknown")) == season for row in rows])
        by_season[season] = {"n": int(mask.sum()), "logLoss": float(losses[mask].mean()), "brier": float(brier[mask].mean())}
    return {"n": len(rows), "logLoss": float(losses.mean()), "brier": float(brier.mean()),
            "ece": float(ece), "calibration": bins, "byLeague": by_league, "bySeason": by_season}, losses, brier


def paired_interval(rows, deltas):
    """Paired block bootstrap by UTC match week, preserving clustered matchdays."""
    groups = {}
    for row, delta in zip(rows, deltas):
        week = int(timestamp(row["kickoffAt"]) // (7 * 86400))
        groups.setdefault(week, []).append(float(delta))
    blocks = list(groups.values())
    if len(blocks) < 2:
        return {"mean": float(np.mean(deltas)), "lower": None, "upper": None, "n": len(deltas), "blocks": len(blocks), "method": "paired-week-block-bootstrap", "conclusive": False}
    rng = np.random.default_rng(20261027)
    means = []
    for _ in range(1000):
        sample = [value for index in rng.integers(0, len(blocks), len(blocks)) for value in blocks[index]]
        means.append(np.mean(sample))
    lower, upper = np.quantile(means, [0.025, 0.975])
    return {"mean": float(np.mean(deltas)), "lower": float(lower), "upper": float(upper),
            "n": len(deltas), "blocks": len(blocks), "method": "paired-week-block-bootstrap",
            "conclusive": bool(len(deltas) >= 200 and len(blocks) >= 12 and (upper < 0 or lower > 0))}


def export_model(model, path):
    model.save_model(str(path), format="json")
    return json.loads(path.read_text(encoding="utf-8"))


def train_candidates(train, features, output, iterations, depth):
    x = np.array([row["features"] for row in train], dtype=float)
    labels = np.array([class_of(row) for row in train])
    base_probs = np.array([result_probabilities(normalize(row["baselineMatrix"])) for row in train])
    common = dict(iterations=iterations, depth=depth, learning_rate=0.05, random_seed=20261027,
                  thread_count=2, verbose=False, allow_writing_files=False)
    models = {}
    for residual, kind in ((True, KINDS[0]), (False, KINDS[2])):
        pair = {}
        for side in ("home", "away"):
            y = np.array([row[f"{side}Goals"] for row in train], dtype=float)
            baseline = np.log(np.maximum(0.05, [row[f"lambda{side.title()}"] for row in train])) if residual else None
            pool = Pool(x, label=y, baseline=baseline, feature_names=features)
            model = CatBoostRegressor(loss_function="Poisson", **common)
            model.fit(pool)
            pair[side] = model
        models[kind] = pair
    if len(set(labels)) < 3:
        raise ValueError("training_requires_all_three_1x2_outcomes")
    probability = CatBoostClassifier(loss_function="MultiClass", classes_count=3, **common)
    probability.fit(Pool(x, label=labels, baseline=np.log(np.maximum(1e-12, base_probs)), feature_names=features))
    models[KINDS[1]] = {"probability": probability}
    exported = {}
    for kind, bundle in models.items():
        exported[kind] = {name: export_model(model, output / f"{kind}-{name}.json") for name, model in bundle.items()}
    return models, exported


def raw_matrices(rows, kind, models):
    x = np.array([row["features"] for row in rows], dtype=float)
    baselines = [normalize(row["baselineMatrix"]) for row in rows]
    if kind == KINDS[1]:
        logits = np.asarray(models["probability"].predict(x, prediction_type="RawFormulaVal"))
        matrices = []
        for baseline, residual in zip(baselines, logits):
            prior = result_probabilities(baseline)
            raw = residual + np.log(np.maximum(1e-12, prior)); raw -= raw.max()
            corrected = np.exp(raw); corrected /= corrected.sum()
            matrix = baseline.copy()
            for h in range(len(matrix)):
                for a in range(len(matrix)):
                    index = 0 if h > a else 1 if h == a else 2
                    matrix[h, a] *= corrected[index] / max(1e-12, prior[index])
            matrices.append(normalize(matrix))
        return matrices
    home = np.asarray(models["home"].predict(x, prediction_type="RawFormulaVal")).reshape(-1)
    away = np.asarray(models["away"].predict(x, prediction_type="RawFormulaVal")).reshape(-1)
    if kind == KINDS[0]:
        home += np.log(np.maximum(0.05, [row["lambdaHome"] for row in rows]))
        away += np.log(np.maximum(0.05, [row["lambdaAway"] for row in rows]))
    return [poisson_joint(float(np.clip(np.exp(h), 0.05, 8)), float(np.clip(np.exp(a), 0.05, 8)), len(baseline))
            for h, a, baseline in zip(home, away, baselines)]


def chronological_folds(rows, fold_count):
    """Expanding training, a preceding validation window, then disjoint test windows.

    Equal kickoff times stay together. Labels not yet available are purged at
    every boundary. The final test window is never consulted for selection.
    """
    times = sorted({row["forecastAt"] for row in rows}, key=timestamp)
    if len(times) < 12:
        raise ValueError("insufficient_distinct_forecast_times")
    fold_count = max(1, min(fold_count, max(1, len(times) // 12)))
    first_test = max(2, int(len(times) * 0.7))
    test_boundaries = np.linspace(first_test, len(times), fold_count + 1, dtype=int)
    for fold_index in range(fold_count):
        test_start_index, test_end_index = test_boundaries[fold_index], test_boundaries[fold_index + 1]
        validation_start_index = max(1, test_start_index - max(2, int(len(times) * 0.15)))
        validation_start, test_start = timestamp(times[validation_start_index]), timestamp(times[test_start_index])
        test_end = timestamp(times[test_end_index]) if test_end_index < len(times) else float("inf")
        train = [row for row in rows if timestamp(row["forecastAt"]) < validation_start and timestamp(row["availableAt"]) < validation_start]
        validation = [row for row in rows if validation_start <= timestamp(row["forecastAt"]) < test_start and timestamp(row["availableAt"]) < test_start]
        test = [row for row in rows if test_start <= timestamp(row["forecastAt"]) < test_end]
        if min(len(train), len(validation), len(test)) < 5:
            continue
        # Calibration labels do not select the candidate, mixing weight or temperature.
        calibration_times = sorted({row["forecastAt"] for row in validation}, key=timestamp)
        if len(calibration_times) < 3:
            continue
        calibration_start = timestamp(calibration_times[max(1, int(len(calibration_times) * 2 / 3))])
        selection = [row for row in validation if timestamp(row["forecastAt"]) < calibration_start
                     and timestamp(row["availableAt"]) < calibration_start]
        calibration = [row for row in validation if timestamp(row["forecastAt"]) >= calibration_start]
        if min(len(selection), len(calibration)) < 2:
            continue
        yield fold_index, train, selection, calibration, test


def run(args):
    dataset_path = Path(args.input)
    dataset_bytes = dataset_path.read_bytes()
    dataset = json.loads(dataset_bytes)
    features, rows = dataset["featureNames"], dataset["rows"]
    if not rows or not features:
        raise ValueError("empty_training_dataset")
    rows = sorted(rows, key=lambda row: (timestamp(row["forecastAt"]), row["matchId"]))
    if len({row["matchId"] for row in rows}) != len(rows):
        raise ValueError("duplicate_training_match")
    for row in rows:
        if len(row["features"]) != len(features) or not all(math.isfinite(value) for value in row["features"]):
            raise ValueError("invalid_numeric_features")
        if row.get("maxTrainingAvailableAt") and timestamp(row["maxTrainingAvailableAt"]) > timestamp(row["forecastAt"]):
            raise ValueError("future_feature_information")
        if timestamp(row["modelFitAt"]) > timestamp(row["forecastAt"]):
            raise ValueError("future_baseline_parameters")
        if timestamp(row["forecastAt"]) > timestamp(row["kickoffAt"]):
            raise ValueError("postkickoff_training_forecast")
        if any(not isinstance(row[key], (int, float)) or not math.isfinite(row[key]) or row[key] < 0 or int(row[key]) != row[key]
               for key in ("homeGoals", "awayGoals")):
            raise ValueError("invalid_observed_goals")
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    folds, all_predictions, all_test_rows, all_a, all_c = [], [], [], [], []
    artifact = None
    for fold_index, train, validation, calibration, test in chronological_folds(rows, args.folds):
        fold_dir = output / f"fold-{fold_index}"; fold_dir.mkdir(exist_ok=True)
        models, exported = train_candidates(train, features, fold_dir, args.iterations, args.depth)
        baselines = [normalize(row["baselineMatrix"]) for row in validation]
        candidate_metrics, selected = [], None
        for kind in KINDS:
            raw = raw_matrices(validation, kind, models[kind])
            best = None
            for weight in WEIGHTS:
                for temperature in TEMPERATURES:
                    matrices = [calibrated_mix(base, ml, weight, temperature) for base, ml in zip(baselines, raw)]
                    metric, _, _ = matrix_metrics(validation, matrices)
                    choice = {"kind": kind, "weight": weight, "temperature": temperature, "validation": metric}
                    if best is None or metric["logLoss"] < best["validation"]["logLoss"]:
                        best = choice
            candidate_metrics.append(best)
            if selected is None or best["validation"]["logLoss"] < selected["validation"]["logLoss"]:
                selected = best
        chosen = selected["kind"]
        calibration_a = [normalize(row["baselineMatrix"]) for row in calibration]
        calibration_raw = raw_matrices(calibration, chosen, models[chosen])
        calibration_c = [calibrated_mix(base, ml, selected["weight"], selected["temperature"])
                         for base, ml in zip(calibration_a, calibration_raw)]
        calibration_predictions = [{"matchId": row["matchId"], "availableAt": row["availableAt"],
            "forecastAt": row["forecastAt"], "kickoffAt": row["kickoffAt"], "competition": row["competition"],
            "season": row.get("season"), "homeGoals": row["homeGoals"], "awayGoals": row["awayGoals"],
            "matrixA": a.tolist(), "matrixC": c.tolist(), "probabilitiesA": row["baselineProbabilities"],
            "probabilitiesC": {key: float(value) for key, value in zip(("homeWin", "draw", "awayWin"), result_probabilities(c))}}
            for row, a, c in zip(calibration, calibration_a, calibration_c)]
        raw_test = raw_matrices(test, chosen, models[chosen])
        a_matrices = [normalize(row["baselineMatrix"]) for row in test]
        c_matrices = [calibrated_mix(base, ml, selected["weight"], selected["temperature"]) for base, ml in zip(a_matrices, raw_test)]
        metrics_a, losses_a, brier_a = matrix_metrics(test, a_matrices, use_a_flat=True)
        metrics_c, losses_c, brier_c = matrix_metrics(test, c_matrices)
        created = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        identity = {"dataset": hashlib.sha256(dataset_bytes).hexdigest(), "trainerHash": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "fold": fold_index,
                    "kind": chosen, "settings": selected, "iterations": args.iterations, "depth": args.depth}
        version = "C-" + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:16]
        trained_through = max((row["availableAt"] for row in train), key=timestamp)
        validation_through = max((row["availableAt"] for row in validation + calibration), key=timestamp)
        artifact = {"version": version, "family": "C", "featureNames": features,
                    "featureSchema": dataset["schemaVersion"], "baselineVersion": dataset["baselineManifest"]["version"],
                    "trainedThrough": trained_through, "validationThrough": validation_through, "createdAt": created,
                    "candidateKind": chosen, "models": exported[chosen], "weight": selected["weight"],
                    "temperature": selected["temperature"], "datasetHash": identity["dataset"],
                    "catboostVersion": catboost_version, "trainerHash": identity["trainerHash"], "hyperparameters": {"iterations": args.iterations, "depth": args.depth,
                    "learningRate": 0.05, "seed": 20261027, "threadCount": 2}, "oddsAsFeatures": False,
                    "selectionProtocol": "Expanding chronological training; weight, candidate and joint temperature selected on preceding validation only; test untouched.",
                    "metrics": {"validation": selected["validation"], "testA": metrics_a, "testC": metrics_c,
                                "pairedLogLossDifference": paired_interval(test, losses_c - losses_a),
                                "pairedBrierDifference": paired_interval(test, brier_c - brier_a)},
                    "candidateComparisons": candidate_metrics, "status": "CANDIDATE", "productionValidated": False}
        artifact["calibrationPredictions"] = calibration_predictions
        (fold_dir / "artifact.json").write_text(json.dumps(artifact, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        folds.append({"fold": fold_index, "version": version, "trainN": len(train), "validationN": len(validation), "calibrationN": len(calibration),
                      "testN": len(test), "trainedThrough": trained_through, "validationThrough": validation_through,
                      "testFrom": test[0]["forecastAt"], "testTo": test[-1]["forecastAt"], "candidateComparisons": candidate_metrics,
                      "selected": chosen, "metrics": artifact["metrics"], "calibrationPredictions": calibration_predictions})
        for row, a_matrix, c_matrix in zip(test, a_matrices, c_matrices):
            all_predictions.append({"matchId": row["matchId"], "competition": row["competition"], "season": row.get("season"),
                "homeTeamId": row.get("homeTeamId"), "awayTeamId": row.get("awayTeamId"),
                "kickoffAt": row["kickoffAt"], "forecastAt": row["forecastAt"], "homeGoals": row["homeGoals"],
                "awayGoals": row["awayGoals"], "versionA": row["baselineVersion"], "versionC": version,
                "trainedThrough": trained_through, "validationThrough": validation_through,
                "probabilitiesA": row["baselineProbabilities"], "matrixA": a_matrix.tolist(), "matrixC": c_matrix.tolist()})
        all_test_rows.extend(test); all_a.extend(a_matrices); all_c.extend(c_matrices)
        print(json.dumps({"fold": fold_index, "train": len(train), "validation": len(validation), "test": len(test), "selected": chosen}), flush=True)
    if artifact is None:
        raise ValueError("insufficient_purged_chronological_folds")
    metrics_a, losses_a, brier_a = matrix_metrics(all_test_rows, all_a, use_a_flat=True)
    metrics_c, losses_c, brier_c = matrix_metrics(all_test_rows, all_c)
    interval = paired_interval(all_test_rows, losses_c - losses_a)
    report = {"schemaVersion": "research-benchmark-v1", "datasetHash": hashlib.sha256(dataset_bytes).hexdigest(),
              "baselineManifest": dataset["baselineManifest"], "type": "historical_probability_walk_forward",
              "economicBacktest": "not_performed_without_separately_verified_historical_odds",
              "folds": folds, "metricsA": metrics_a, "metricsC": metrics_c,
              "pairedLogLossDifference": interval, "pairedBrierDifference": paired_interval(all_test_rows, brier_c - brier_a),
              "conclusion": "inconclusive" if not interval["conclusive"] else "C_probabilistically_better" if interval["upper"] < 0 else "A_probabilistically_better",
              "productionPromotion": False, "finalHoldout": folds[-1], "predictions": all_predictions,
              "limitations": ["No historical quote is represented as an observed T-15 price.",
                  "A uses the frozen existing raw family ensemble; calibration, market blending and decision rules are separately shared downstream.",
                  "The final holdout is untouched within this run. Repeated model development against this holdout invalidates its independence.",
                  "The score grid is truncated and normalized to 0..10 goals per team; outcomes outside it remain in 1X2 metrics but exact-score likelihood is not claimed."]}
    (output / "artifact.json").write_text(json.dumps(artifact, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    (output / "report.json").write_text(json.dumps(report, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    # Numeric parity observations, including residual models before adding the A baseline.
    sample = all_test_rows[-min(10, len(all_test_rows)):]
    selected_models = models[artifact["candidateKind"]]
    parity = {"featureNames": features, "candidateModels": exported, "rows": [{"features": row["features"], "raw": {
        name: np.asarray(model.predict(np.array([row["features"]]), prediction_type="RawFormulaVal")).reshape(-1).tolist()
        for name, model in selected_models.items()}, "rawByCandidate": {
            kind: {name: np.asarray(model.predict(np.array([row["features"]]), prediction_type="RawFormulaVal")).reshape(-1).tolist()
                   for name, model in bundle.items()} for kind, bundle in models.items()}} for row in sample]}
    (output / "parity.json").write_text(json.dumps(parity, allow_nan=False), encoding="utf-8")
    print(json.dumps({"artifact": str(output / "artifact.json"), "report": str(output / "report.json"),
                      "n": len(all_test_rows), "conclusion": report["conclusion"], "productionPromotion": False}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--iterations", type=int, default=120)
    parser.add_argument("--depth", type=int, default=5)
    parser.add_argument("--folds", type=int, default=3)
    options = parser.parse_args()
    if not (5 <= options.iterations <= 1000 and 2 <= options.depth <= 8 and 1 <= options.folds <= 8):
        parser.error("iterations must be 5..1000, depth 2..8, folds 1..8")
    run(options)
