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
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import numpy as np
from catboost import CatBoostClassifier, CatBoostRegressor, Pool, __version__ as catboost_version

KINDS = ("intensity_correction", "probability_correction", "calibrated_ensemble")
WEIGHTS = (0.0, 0.1, 0.25, 0.5, 0.75, 1.0)
TEMPERATURES = (0.8, 0.9, 1.0, 1.1, 1.25)
CHALLENGER_SCHEMA = "prematch-challenger-v2"
CHALLENGER_PROTOCOL = "asof-opponent-xg-calendar-v1"
SPLIT_PROTOCOL = "purged-temporal-train-selection-calibration-test-v1"
TEAM_FEATURES = ("elo", "sample", "goals_for", "goals_against", "xg_for", "xg_against", "xg_coverage",
                 "shots_for", "shots_against", "recent_points", "recent_goal_diff", "venue_goals_for",
                 "venue_goals_against", "rest_days", "season_goals_for", "season_goals_against")
LEGACY_FEATURES = [f"{side}_{name}" for side in ("home", "away") for name in TEAM_FEATURES] + [
    "elo_difference", "lambda_home_A", "lambda_away_A"] + [f"league_{index}" for index in range(5)]
FEATURE_BLOCKS = {
    "recent_xg": [f"{side}_{name}" for side in ("home", "away") for name in (
        "recent_xg_for", "recent_xg_against", "recent_adjusted_xg_for", "recent_adjusted_xg_against", "recent_xg_coverage")],
    "schedule": [f"{side}_{name}" for side in ("home", "away") for name in (
        "observed_rest_days", "observed_matches_7d", "observed_matches_14d")],
}
CONTROLLED_ARMS = (
    {"name": "no_ml", "kind": "no_ml", "blocks": [], "weight": 0.0, "temperature": 1.0},
    {"name": "development_current_replica", "kind": "calibrated_ensemble", "blocks": [], "weight": .75, "temperature": .8},
    {"name": "intensity_legacy", "kind": "intensity_correction", "blocks": [], "weight": .25, "temperature": 1.0},
    {"name": "intensity_recent_xg", "kind": "intensity_correction", "blocks": ["recent_xg"], "weight": .25, "temperature": 1.0},
    {"name": "intensity_schedule", "kind": "intensity_correction", "blocks": ["schedule"], "weight": .25, "temperature": 1.0},
    {"name": "intensity_full", "kind": "intensity_correction", "blocks": ["recent_xg", "schedule"], "weight": .25, "temperature": 1.0},
)


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("timestamp_requires_timezone")
    return parsed.timestamp()


@lru_cache(maxsize=1)
def rome_timezone():
    try:
        return ZoneInfo("Europe/Rome")
    except ZoneInfoNotFoundError as error:
        raise ValueError("rome_timezone_data_unavailable_install_tzdata") from error


def nightly_decision_schedule(dataset):
    declared = dataset.get("decisionSchedule", {})
    if not isinstance(declared, dict):
        raise ValueError("invalid_nightly_decision_schedule")
    hour, minute = declared.get("hour", 3), declared.get("minute", 7)
    if (type(hour) is not int or not 0 <= hour <= 23 or type(minute) is not int or not 0 <= minute <= 59
            or declared.get("timezone", "Europe/Rome") != "Europe/Rome"):
        raise ValueError("invalid_nightly_decision_schedule")
    return {"hour": hour, "minute": minute, "timezone": "Europe/Rome"}


def resolve_nightly_forecast_at(kickoff_at, schedule):
    """Last real Rome boundary, including skipped and repeated local DST times."""
    kickoff = timestamp(kickoff_at)
    rome = rome_timezone()
    local_date = datetime.fromtimestamp(kickoff, timezone.utc).astimezone(rome)
    candidates = set()
    for days_back in range(3):
        date = local_date - timedelta(days=days_back)
        wall = datetime(date.year, date.month, date.day, schedule["hour"], schedule["minute"])
        for fold in (0, 1):
            utc = wall.replace(tzinfo=rome, fold=fold).astimezone(timezone.utc)
            # Nonexistent spring times fail this round trip. Repeated times produce two real candidates.
            if utc.astimezone(rome).replace(tzinfo=None) == wall and utc.timestamp() < kickoff:
                candidates.add(utc.timestamp())
    if not candidates:
        raise ValueError("nightly_decision_boundary_unavailable")
    return max(candidates)


def check_nightly_decision_time(row, schedule, recorded_times):
    forecast, kickoff = timestamp(row["forecastAt"]), timestamp(row["kickoffAt"])
    expected = resolve_nightly_forecast_at(row["kickoffAt"], schedule)
    recorded = recorded_times.get(row["matchId"])
    if recorded is not None:
        observed = timestamp(recorded)
        if forecast != observed or observed < expected or observed >= kickoff:
            raise ValueError("recorded_nightly_time_mismatch")
    elif forecast != expected:
        raise ValueError("nightly_forecast_time_mismatch")


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


def train_candidates(train, features, output, iterations, depth, kinds=KINDS):
    x = np.array([row["features"] for row in train], dtype=float)
    labels = np.array([class_of(row) for row in train])
    base_probs = np.array([result_probabilities(normalize(row["baselineMatrix"])) for row in train])
    common = dict(iterations=iterations, depth=depth, learning_rate=0.05, random_seed=20261027,
                  thread_count=2, verbose=False, allow_writing_files=False)
    models = {}
    for residual, kind in ((True, KINDS[0]), (False, KINDS[2])):
        if kind not in kinds:
            continue
        pair = {}
        for side in ("home", "away"):
            y = np.array([row[f"{side}Goals"] for row in train], dtype=float)
            baseline = np.log(np.maximum(0.05, [row[f"lambda{side.title()}"] for row in train])) if residual else None
            pool = Pool(x, label=y, baseline=baseline, feature_names=features)
            model = CatBoostRegressor(loss_function="Poisson", **common)
            model.fit(pool)
            pair[side] = model
        models[kind] = pair
    if KINDS[1] in kinds:
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


def protected_holdout_policy():
    return json.loads((Path(__file__).resolve().parents[1] / "src/research/original-holdout-policy.json").read_text(encoding="utf-8"))


def checked_dataset(dataset, controlled=False):
    features, original = dataset["featureNames"], dataset["rows"]
    if not original or not features:
        raise ValueError("empty_training_dataset")
    if len({row["matchId"] for row in original}) != len(original):
        raise ValueError("duplicate_training_match")
    policy = protected_holdout_policy()
    protected = set(policy["protectedOriginalFinalMatchIds"])
    rows = sorted((row for row in original if row["matchId"] not in protected),
                  key=lambda row: (timestamp(row["forecastAt"]), row["matchId"]))
    if not rows:
        raise ValueError("no_unprotected_training_rows")
    if controlled:
        blocks = dataset.get("featureBlocks", [])
        expected = LEGACY_FEATURES + [name for block in blocks for name in FEATURE_BLOCKS.get(block, [])]
        timing = dataset.get("forecastTiming", {})
        if (dataset.get("schemaVersion") != CHALLENGER_SCHEMA or len(set(blocks)) != len(blocks)
                or set(blocks) != set(FEATURE_BLOCKS) or features != expected):
            raise ValueError("controlled_challenger_requires_both_versioned_feature_blocks")
        if ("nightly" not in str(timing.get("policy", "")).lower()
                or timing.get("forecastBeforeKickoff") is not True or timing.get("resultDelayMs") != 7200000):
            raise ValueError("controlled_challenger_requires_real_nightly_forecast_times")
        schedule = nightly_decision_schedule(dataset)
        recorded_times = dataset.get("recordedDecisionTimes", {})
        if not isinstance(recorded_times, dict) or any(not isinstance(value, str) for value in recorded_times.values()):
            raise ValueError("invalid_recorded_nightly_times")
    for row in rows:
        if (len(row["features"]) != len(features)
                or not all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in row["features"])):
            raise ValueError("invalid_numeric_features")
        if row.get("featureNames", features) != features or row.get("featureSchema", dataset["schemaVersion"]) != dataset["schemaVersion"]:
            raise ValueError("row_feature_schema_mismatch")
        forecast = timestamp(row["forecastAt"])
        if row.get("maxTrainingAvailableAt") and timestamp(row["maxTrainingAvailableAt"]) > forecast:
            raise ValueError("future_feature_information")
        extra = row.get("challengerFeatureMetadata", {})
        if extra.get("maxHistoryAvailableAt") and timestamp(extra["maxHistoryAvailableAt"]) > forecast:
            raise ValueError("future_challenger_feature_information")
        if timestamp(row["modelFitAt"]) > forecast:
            raise ValueError("future_baseline_parameters")
        if forecast >= timestamp(row["kickoffAt"]):
            raise ValueError("postkickoff_training_forecast")
        if controlled:
            check_nightly_decision_time(row, schedule, recorded_times)
        if timestamp(row["availableAt"]) < timestamp(row["kickoffAt"]) + 7200:
            raise ValueError("result_available_before_conservative_delay")
        if dataset.get("asOf") and timestamp(row["availableAt"]) > timestamp(dataset["asOf"]):
            raise ValueError("future_training_label")
        if any(not isinstance(row[key], (int, float)) or isinstance(row[key], bool)
               or not math.isfinite(row[key]) or row[key] < 0 or int(row[key]) != row[key] for key in ("homeGoals", "awayGoals")):
            raise ValueError("invalid_observed_goals")
    return features, rows, {"policyVersion": policy["version"], "excluded": len(original) - len(rows) + int(dataset.get("protectedMatchesExcluded", 0)),
                            "excludedInTrainer": len(original) - len(rows),
                            "protectedFinalCount": len(protected), "protectedRowsUsed": 0}


def split_manifest(train, selection, calibration, test):
    def interval(rows):
        return {"n": len(rows), "from": min((row["forecastAt"] for row in rows), key=timestamp),
                "to": max((row["forecastAt"] for row in rows), key=timestamp),
                "availableThrough": max((row["availableAt"] for row in rows), key=timestamp),
                "matchIdsHash": hashlib.sha256("\n".join(sorted(row["matchId"] for row in rows)).encode()).hexdigest()}
    result = {"protocol": SPLIT_PROTOCOL, "train": interval(train), "selection": interval(selection),
              "calibration": interval(calibration), "test": interval(test)}
    for earlier, later in (("train", "selection"), ("selection", "calibration"), ("calibration", "test")):
        if (timestamp(result[earlier]["to"]) >= timestamp(result[later]["from"])
                or timestamp(result[earlier]["availableThrough"]) >= timestamp(result[later]["from"])):
            raise ValueError("non_disjoint_or_unpurged_training_split")
    return result


def project_feature_rows(rows, source_names, blocks):
    names = LEGACY_FEATURES + [name for block in blocks for name in FEATURE_BLOCKS[block]]
    indices = [source_names.index(name) for name in names]
    return names, [{**row, "features": [row["features"][index] for index in indices], "featureNames": names,
                    "featureSchema": CHALLENGER_SCHEMA if blocks else "prematch-numeric-v1"} for row in rows]


def arm_matrices(rows, arm, models):
    baseline = [normalize(row["baselineMatrix"]) for row in rows]
    if arm["kind"] == "no_ml":
        return baseline
    raw = raw_matrices(rows, arm["kind"], models)
    return [calibrated_mix(base, ml, arm["weight"], arm["temperature"]) for base, ml in zip(baseline, raw)]


def run_controlled(args):
    """Six declared arms, one fixed fit each: no parameter search, no protected holdout reuse."""
    dataset_bytes = Path(args.input).read_bytes()
    dataset = json.loads(dataset_bytes)
    source_names, rows, holdout = checked_dataset(dataset, controlled=True)
    output = Path(args.output); output.mkdir(parents=True, exist_ok=True)
    dataset_hash = hashlib.sha256(dataset_bytes).hexdigest()
    trainer_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    iterations, depth = min(args.iterations, 200), min(args.depth, 3)
    folds, predictions, last_artifacts, parity = [], [], {}, []
    for fold_index, train, selection, calibration, test in chronological_folds(rows, args.folds):
        split = split_manifest(train, selection, calibration, test)
        fold_dir = output / f"fold-{fold_index}"; fold_dir.mkdir(exist_ok=True)
        arm_outputs, comparisons = {}, []
        for arm in CONTROLLED_ARMS:
            name, blocks = arm["name"], arm["blocks"]
            features, training = project_feature_rows(train, source_names, blocks)
            _, selecting = project_feature_rows(selection, source_names, blocks)
            _, calibrating = project_feature_rows(calibration, source_names, blocks)
            _, testing = project_feature_rows(test, source_names, blocks)
            arm_dir = fold_dir / name; arm_dir.mkdir(exist_ok=True)
            if arm["kind"] == "no_ml":
                model, exported = {}, {}
            else:
                trained, bundles = train_candidates(training, features, arm_dir, iterations, depth, kinds=(arm["kind"],))
                model, exported = trained[arm["kind"]], bundles[arm["kind"]]
            selected_matrices = arm_matrices(selecting, arm, model)
            calibration_matrices = arm_matrices(calibrating, arm, model)
            test_matrices = arm_matrices(testing, arm, model)
            selection_metric, _, _ = matrix_metrics(selecting, selected_matrices)
            test_metric, _, _ = matrix_metrics(testing, test_matrices)
            identity = {"dataset": dataset_hash, "trainer": trainer_hash, "fold": fold_index, "arm": arm,
                        "iterations": iterations, "depth": depth, "split": split}
            version = "C-" + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()[:16]
            artifact = {"version": version, "family": "C", "featureNames": features,
                "featureSchema": CHALLENGER_SCHEMA if blocks else "prematch-numeric-v1", "featureBlocks": blocks,
                "featureProtocol": CHALLENGER_PROTOCOL, "baselineVersion": dataset["baselineManifest"]["version"],
                "trainedThrough": split["train"]["availableThrough"],
                "validationThrough": max((split[part]["availableThrough"] for part in ("selection", "calibration")), key=timestamp),
                "createdAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "candidateKind": arm["kind"], "models": exported, "weight": arm["weight"], "temperature": arm["temperature"],
                "trainingForecastTiming": dataset["forecastTiming"], "trainingDecisionSchedule": nightly_decision_schedule(dataset),
                "recordedDecisionTimesHash": hashlib.sha256(json.dumps(dataset.get("recordedDecisionTimes", {}), sort_keys=True).encode()).hexdigest(),
                "trainingSplit": split, "datasetHash": dataset_hash,
                "trainerHash": trainer_hash, "catboostVersion": catboost_version, "comparisonArm": name,
                "hyperparameters": {"iterations": iterations, "depth": depth, "learningRate": .05, "seed": 20261027, "threadCount": 2},
                "holdoutProtection": holdout, "oddsAsFeatures": False, "status": "CANDIDATE", "productionValidated": False,
                "availability": "retrospective_development", "independentEvidence": False,
                "selectionProtocol": "Six preregistered arms with fixed weights/temperature; select only on selection interval; calibration/test disjoint.",
                "metrics": {"selection": selection_metric, "test": test_metric},
                "calibrationPredictions": [{"matchId": row["matchId"], "availableAt": row["availableAt"],
                    "forecastAt": row["forecastAt"], "kickoffAt": row["kickoffAt"], "competition": row["competition"],
                    "season": row.get("season"), "homeGoals": row["homeGoals"], "awayGoals": row["awayGoals"],
                    "matrixA": row["baselineMatrix"], "matrixC": matrix.tolist(), "probabilitiesA": row["baselineProbabilities"],
                    "probabilitiesC": {key: float(value) for key, value in zip(("homeWin", "draw", "awayWin"), result_probabilities(matrix))}}
                    for row, matrix in zip(calibrating, calibration_matrices)]}
            artifact_path = arm_dir / "artifact.json"
            artifact_path.write_text(json.dumps(artifact, separators=(",", ":"), allow_nan=False), encoding="utf-8")
            arm_outputs[name] = {"artifact": artifact, "test": test_matrices, "artifactPath": str(artifact_path)}
            comparisons.append({"name": name, "version": version, "kind": arm["kind"], "featureBlocks": blocks,
                "weight": arm["weight"], "temperature": arm["temperature"], "selection": selection_metric,
                "test": test_metric, "artifactPath": str(artifact_path), "availability": "retrospective_development"})
            parity.extend({"arm": name, "version": version, "features": row["features"], "featureNames": features,
                "models": exported, "raw": {key: np.asarray(value.predict(np.array([row["features"]]),
                    prediction_type="RawFormulaVal")).reshape(-1).tolist() for key, value in model.items()}}
                for row in testing[:min(2, len(testing))])
        chosen = min(comparisons, key=lambda item: (item["selection"]["logLoss"], item["name"]))["name"]
        fold = {"fold": fold_index, "trainingSplit": split, "selectedVariant": chosen, "comparisons": comparisons}
        folds.append(fold)
        last_artifacts = {name: value["artifact"] for name, value in arm_outputs.items()}
        for index, row in enumerate(test):
            variants = {name: {"matrix": value["test"][index].tolist(), "version": value["artifact"]["version"],
                "trainedThrough": value["artifact"]["trainedThrough"], "validationThrough": value["artifact"]["validationThrough"],
                "artifactPath": value["artifactPath"], "availability": "retrospective_development"}
                for name, value in arm_outputs.items()}
            predictions.append({"matchId": row["matchId"], "competition": row["competition"], "season": row.get("season"),
                "homeTeamId": row.get("homeTeamId"), "awayTeamId": row.get("awayTeamId"),
                "forecastAt": row["forecastAt"], "kickoffAt": row["kickoffAt"], "availableAt": row["availableAt"],
                "homeGoals": row["homeGoals"], "awayGoals": row["awayGoals"], "baselineVersion": row["baselineVersion"],
                "matrixA": row["baselineMatrix"], "probabilitiesA": row["baselineProbabilities"], "variants": variants,
                "selectedVariant": chosen, "matrixC": variants[chosen]["matrix"], "versionC": variants[chosen]["version"],
                "trainedThrough": variants[chosen]["trainedThrough"], "validationThrough": variants[chosen]["validationThrough"]})
        print(json.dumps({"fold": fold_index, "arms": len(comparisons), "selected": chosen,
                          "train": len(train), "selection": len(selection), "calibration": len(calibration), "test": len(test)}), flush=True)
    if not folds:
        raise ValueError("insufficient_purged_chronological_folds")
    report = {"schemaVersion": "controlled-challenger-development-v1", "datasetHash": dataset_hash,
        "baselineManifest": dataset["baselineManifest"], "forecastTiming": dataset["forecastTiming"],
        "decisionSchedule": nightly_decision_schedule(dataset),
        "holdoutProtection": holdout, "arms": list(CONTROLLED_ARMS), "folds": folds, "predictions": predictions,
        "independentEvidence": False, "productionPromotion": False, "conclusion": "development_only_requires_future_independent_validation",
        "limitations": ["The current replica is retrained development code, not the frozen C906 artifact.",
            "Original 745 protected targets were excluded before all split and selection operations.",
            "Calendar features count only completed matches with available results; unseen fixtures are not invented.",
            "Historical result-delay assumptions do not establish actual provider capture times.",
            "No economic performance or promotion is inferred from probability metrics."]}
    for name, artifact in last_artifacts.items():
        (output / f"artifact-{name}.json").write_text(json.dumps(artifact, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    (output / "artifact.json").write_text(json.dumps(last_artifacts[folds[-1]["selectedVariant"]], separators=(",", ":"), allow_nan=False), encoding="utf-8")
    (output / "report.json").write_text(json.dumps(report, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    (output / "parity.json").write_text(json.dumps({"rows": parity}, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(json.dumps({"report": str(output / "report.json"), "rows": len(rows), "testPredictions": len(predictions),
                      "protectedRowsExcluded": holdout["excluded"], "independentEvidence": False, "productionPromotion": False}), flush=True)


def run(args):
    dataset_path = Path(args.input)
    dataset_bytes = dataset_path.read_bytes()
    dataset = json.loads(dataset_bytes)
    features, rows, holdout_protection = checked_dataset(dataset)
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
        training_split = split_manifest(train, validation, calibration, test)
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
                    "trainingSplit": training_split, "trainingForecastTiming": dataset.get("forecastTiming", {
                        "policy": "legacy-input-forecast-times", "resultDelayMs": 7200000, "forecastBeforeKickoff": True}),
                    "holdoutProtection": holdout_protection,
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
              "holdoutProtection": holdout_protection,
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
    parser.add_argument("--experiment", choices=("legacy", "controlled-challenger"), default="legacy")
    options = parser.parse_args()
    if not (5 <= options.iterations <= 1000 and 2 <= options.depth <= 8 and 1 <= options.folds <= 8):
        parser.error("iterations must be 5..1000, depth 2..8, folds 1..8")
    (run_controlled if options.experiment == "controlled-challenger" else run)(options)
