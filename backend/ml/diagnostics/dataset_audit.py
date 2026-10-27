"""Read-only dataset/benchmark checks, independent of model fitting.

Descriptive profiling may include the already observed final period. Returned
protected IDs must be excluded from every feature-selection/tuning experiment.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime
import hashlib
import math
from typing import Any

import numpy as np

RESULT_DELAY_SECONDS = 2 * 60 * 60


def timestamp(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def ids_hash(ids: list[str]) -> str:
    return hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest()


def _counts(rows: list[dict], field: str) -> dict[str, int]:
    return dict(sorted(Counter(str(row.get(field, "unknown")) for row in rows).items()))


def _completed(row: dict) -> bool:
    return all(isinstance(row.get(key), (int, float)) and not isinstance(row.get(key), bool)
               and math.isfinite(row[key]) and row[key] >= 0 and int(row[key]) == row[key]
               for key in ("homeGoals", "awayGoals"))


def _available(row: dict) -> float:
    return max(timestamp(row["date"]) + RESULT_DELAY_SECONDS,
               timestamp(row["availableAt"]) if row.get("availableAt") else 0)


def _target_distribution(rows: list[dict]) -> dict:
    complete = [row for row in rows if _completed(row)]
    outcomes = Counter("home" if row["homeGoals"] > row["awayGoals"] else "away"
                       if row["homeGoals"] < row["awayGoals"] else "draw" for row in complete)
    n = len(complete)
    return {"n": n, "outcomes": dict(outcomes),
            "outcomeFractions": {key: outcomes[key] / n for key in ("home", "draw", "away")} if n else {},
            "homeGoalMean": sum(row["homeGoals"] for row in complete) / n if n else None,
            "awayGoalMean": sum(row["awayGoals"] for row in complete) / n if n else None,
            "scoreBeyondGrid10": sum(max(row["homeGoals"], row["awayGoals"]) > 10 for row in complete)}


def result_probabilities(matrix: list[list[float]]) -> np.ndarray:
    value = np.asarray(matrix, dtype=float)
    if value.ndim != 2 or value.shape[0] != value.shape[1] or not np.isfinite(value).all() or (value < 0).any() or value.sum() <= 0:
        raise ValueError("invalid_score_matrix")
    value = value / value.sum()
    return np.array([np.tril(value, -1).sum(), np.trace(value), np.triu(value, 1).sum()])


def metrics(rows: list[dict], probabilities: list[np.ndarray], ece_mode: str = "confidence") -> dict:
    if not rows:
        return {"n": 0, "logLoss": None, "brier": None, "ece": None, "eceDefinition": ece_mode}
    probs = np.asarray(probabilities, dtype=float)
    probs /= probs.sum(axis=1)[:, None]
    labels = np.array([0 if row["homeGoals"] > row["awayGoals"] else 1 if row["homeGoals"] == row["awayGoals"] else 2 for row in rows])
    actual = np.eye(3)[labels]
    logloss = -np.log(np.clip(probs[np.arange(len(rows)), labels], 1e-15, 1 - 1e-15))
    brier = np.sum((probs - actual) ** 2, axis=1)
    predicted = probs.max(axis=1) if ece_mode == "confidence" else probs.reshape(-1)
    observed = (probs.argmax(axis=1) == labels).astype(float) if ece_mode == "confidence" else actual.reshape(-1)
    bins = []
    for index in range(10):
        mask = np.minimum(9, np.floor(predicted * 10)).astype(int) == index
        if mask.any():
            bins.append({"lower": index / 10, "upper": (index + 1) / 10, "n": int(mask.sum()),
                         "predicted": float(predicted[mask].mean()), "observed": float(observed[mask].mean())})
    ece = sum(bucket["n"] * abs(bucket["predicted"] - bucket["observed"]) for bucket in bins) / len(predicted)
    return {"n": len(rows), "logLoss": float(logloss.mean()), "brier": float(brier.mean()),
            "ece": float(ece), "eceDefinition": ece_mode, "calibration": bins}


def profile_features(dataset: dict) -> dict:
    names, rows = dataset["featureNames"], dataset["rows"]
    x = np.array([row["features"] for row in rows], dtype=float)
    if x.ndim != 2 or x.shape[1] != len(names):
        raise ValueError("feature_schema_mismatch")
    feature_rows, constant, quasi_constant = [], [], []
    for index, name in enumerate(names):
        values = x[:, index]
        valid = values[np.isfinite(values)]
        counter = Counter(valid.tolist())
        top = counter.most_common(1)[0] if counter else (None, 0)
        deviation = float(valid.std()) if len(valid) else None
        if deviation is not None and deviation < 1e-12:
            constant.append(name)
        elif len(valid) and top[1] / len(valid) >= .99:
            quasi_constant.append(name)
        feature_rows.append({"name": name, "missingOrNonFinite": int((~np.isfinite(values)).sum()),
                             "uniqueValues": len(counter), "mostCommonValue": top[0],
                             "mostCommonFraction": top[1] / len(valid) if len(valid) else None,
                             "mean": float(valid.mean()) if len(valid) else None,
                             "std": deviation, "minimum": float(valid.min()) if len(valid) else None,
                             "maximum": float(valid.max()) if len(valid) else None})
    varying = np.where(np.nanstd(x, axis=0) > 1e-12)[0]
    correlation = np.corrcoef(x[:, varying], rowvar=False) if len(varying) > 1 else np.empty((0, 0))
    redundant = []
    for left in range(len(varying)):
        for right in range(left + 1, len(varying)):
            value = correlation[left, right]
            if np.isfinite(value) and abs(value) >= .98:
                redundant.append({"left": names[varying[left]], "right": names[varying[right]], "pearson": float(value)})
    by_season = {}
    for season in sorted({str(row.get("season")) for row in rows}):
        subset = x[np.array([str(row.get("season")) == season for row in rows])]
        valid_columns = [column[np.isfinite(column)] for column in subset.T]
        by_season[season] = {"n": len(subset),
                             "mean": {name: float(column.mean()) if len(column) else None for name, column in zip(names, valid_columns)},
                             "std": {name: float(column.std()) if len(column) else None for name, column in zip(names, valid_columns)}}
    structural = []
    if all(name in names for name in ("home_elo", "away_elo", "elo_difference")):
        residual = x[:, names.index("elo_difference")] - x[:, names.index("home_elo")] + x[:, names.index("away_elo")]
        finite = residual[np.isfinite(residual)]
        maximum = float(np.max(np.abs(finite))) if len(finite) else None
        structural.append({"kind": "exact_linear_combination", "formula": "elo_difference = home_elo - away_elo",
                           "features": ["elo_difference", "home_elo", "away_elo"], "checkedRows": len(finite),
                           "maximumAbsoluteResidual": maximum, "verifiedWithinTolerance": maximum is not None and maximum <= 1e-10})
    league_indices = [index for index, name in enumerate(names) if name.startswith("league_") and name[7:].isdigit()]
    if league_indices:
        league_values = x[:, league_indices]
        valid = league_values[np.isfinite(league_values).all(axis=1)]
        maximum_sum = float(np.max(np.abs(valid.sum(axis=1) - 1))) if len(valid) else None
        maximum_binary = float(np.max(np.minimum(np.abs(valid), np.abs(valid - 1)))) if len(valid) else None
        structural.append({"kind": "one_hot_simplex", "formula": "sum(league_indicators) = 1",
                           "features": [names[index] for index in league_indices], "checkedRows": len(valid),
                           "maximumAbsoluteSumResidual": maximum_sum, "maximumBinaryResidual": maximum_binary,
                           "verifiedWithinTolerance": maximum_sum is not None and maximum_sum <= 1e-10 and maximum_binary <= 1e-10})
    prior_counts = {}
    for side in ("home", "away"):
        if all(f"{side}_{suffix}" in names for suffix in ("sample", "xg_coverage")):
            sample = x[:, names.index(f"{side}_sample")]
            coverage = x[:, names.index(f"{side}_xg_coverage")]
            prior_counts[side] = {"coldStartRows": int(((sample == 0) & (coverage == 0)).sum()),
                                  "positiveSampleIncompleteXgCoverageRows": int(((sample > 0) & (coverage < 1)).sum()),
                                  "meaning": "At zero prior matches the exported means use the same declared 1.3-goal/xG prior, while xG coverage is zero; these priors are not observed xG."}
    return {"n": len(names), "columns": feature_rows, "constant": constant,
            "quasiConstantAtLeast99Percent": quasi_constant, "highCorrelationAbsAtLeast098": redundant,
            "structuralRedundancies": structural, "xgCoveragePriorCounts": prior_counts,
            "structuralRedundancyInterpretation": "Algebraic dependence is descriptive and does not establish that dropping a feature improves tree-model generalization.",
            "bySeason": by_season, "oddsFeatureColumns": [name for name in names if any(token in name.lower() for token in ("odds", "bookmaker", "price"))]}


def verify_temporal_features(dataset: dict, matches: list[dict]) -> dict:
    """Recalculate team aggregates/Elo directly from eligible raw match outcomes.

    This checks exported features, rather than merely trusting maxTrainingAt.
    Aggregate fallback values are explicit priors, never observed statistics.
    """
    completed = sorted([row for row in matches if _completed(row)], key=lambda row: (_available(row), row["date"], row["matchId"]))
    team_rows: dict[str, list[dict]] = defaultdict(list)
    ratings: dict[str, float] = {}
    cursor = 0
    discrepancies: Counter = Counter()
    examples: list[dict] = []
    names = dataset["featureNames"]
    available_order_matches_kickoff = all(timestamp(completed[i]["date"]) <= timestamp(completed[i + 1]["date"]) for i in range(len(completed) - 1))
    if not available_order_matches_kickoff:
        return {"checkedRows": 0, "fullyChecked": False, "reason": "availability_reorders_kickoffs_requires_slow_elo_replay"}

    def numeric(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)

    def team_features(team_id: str, home_venue: bool, season: str, cutoff: float) -> list[float]:
        rows = team_rows[team_id]
        def home(row: dict) -> bool:
            return row["homeTeamId"] == team_id
        def gf(row: dict) -> float:
            return row["homeGoals"] if home(row) else row["awayGoals"]
        def ga(row: dict) -> float:
            return row["awayGoals"] if home(row) else row["homeGoals"]
        def mean_of(subset: list[dict], getter, fallback=0):
            values = [value for row in subset if numeric(value := getter(row))]
            return sum(values) / len(values) if values else fallback
        def xgf(row: dict):
            return row.get("homeXG") if home(row) else row.get("awayXG")
        def xga(row: dict):
            return row.get("awayXG") if home(row) else row.get("homeXG")
        recent = rows[-5:]
        venue = [row for row in rows if home(row) == home_venue]
        current = [row for row in rows if row.get("season") == season]
        return [ratings.get(team_id, 1500), len(rows), mean_of(rows, gf, 1.3), mean_of(rows, ga, 1.3),
                mean_of(rows, xgf, 1.3), mean_of(rows, xga, 1.3),
                sum(numeric(xgf(row)) and numeric(xga(row)) for row in rows) / len(rows) if rows else 0,
                mean_of(rows, lambda row: row.get("homeTotalShots") if home(row) else row.get("awayTotalShots")),
                mean_of(rows, lambda row: row.get("awayTotalShots") if home(row) else row.get("homeTotalShots")),
                mean_of(recent, lambda row: 3 if gf(row) > ga(row) else 1 if gf(row) == ga(row) else 0),
                mean_of(recent, lambda row: gf(row) - ga(row)), mean_of(venue, gf, 1.3), mean_of(venue, ga, 1.3),
                min(60, max(0, (cutoff - timestamp(rows[-1]["date"])) / 86400)) if rows else 60,
                mean_of(current, gf, 1.3), mean_of(current, ga, 1.3)]

    for row in sorted(dataset["rows"], key=lambda item: (timestamp(item["forecastAt"]), item["matchId"])):
        cutoff = timestamp(row["forecastAt"])
        while cursor < len(completed) and _available(completed[cursor]) <= cutoff:
            match = completed[cursor]
            home_id, away_id = match["homeTeamId"], match["awayTeamId"]
            h, a = ratings.get(home_id, 1500), ratings.get(away_id, 1500)
            expected = 1 / (1 + 10 ** ((a - h - 60) / 400))
            actual = 1 if match["homeGoals"] > match["awayGoals"] else .5 if match["homeGoals"] == match["awayGoals"] else 0
            delta = 20 * (actual - expected)
            ratings[home_id], ratings[away_id] = h + delta, a - delta
            team_rows[home_id].append(match)
            team_rows[away_id].append(match)
            cursor += 1
        home = team_features(row["homeTeamId"], True, row.get("season"), cutoff)
        away = team_features(row["awayTeamId"], False, row.get("season"), cutoff)
        expected = home + away + [home[0] - away[0], row["lambdaHome"], row["lambdaAway"]]
        if len(names) > 35:
            leagues = ["Serie A", "Premier League", "La Liga", "Bundesliga", "Ligue 1"]
            expected.extend(int(row["competition"] == league) for league in leagues)
        for index, value in enumerate(expected):
            actual = row["features"][index]
            if not numeric(actual) or abs(value - actual) > 1e-8:
                discrepancies[names[index]] += 1
                if len(examples) < 10:
                    examples.append({"matchId": row["matchId"], "feature": names[index], "exported": actual, "recalculated": value})
    return {"checkedRows": len(dataset["rows"]), "checkedFeatureColumns": len(names),
            "fullyChecked": True, "discrepancyCounts": dict(discrepancies), "examples": examples,
            "tolerance": 1e-8, "method": "independent raw-match replay before each forecast, two-hour result delay"}


def reconstruct_folds(rows: list[dict], fold_count: int) -> list[dict]:
    """Recover the original four temporal sets to cross-check recorded metadata."""
    rows = sorted(rows, key=lambda row: (timestamp(row["forecastAt"]), row["matchId"]))
    times = sorted({row["forecastAt"] for row in rows}, key=timestamp)
    if len(times) < 12:
        return []
    fold_count = max(1, min(fold_count, max(1, len(times) // 12)))
    first_test = max(2, int(len(times) * .7))
    boundaries = np.linspace(first_test, len(times), fold_count + 1, dtype=int)
    result = []
    for index in range(fold_count):
        start, end = int(boundaries[index]), int(boundaries[index + 1])
        validation_index = max(1, start - max(2, int(len(times) * .15)))
        validation_start, test_start = timestamp(times[validation_index]), timestamp(times[start])
        test_end = timestamp(times[end]) if end < len(times) else float("inf")
        train = [row for row in rows if timestamp(row["forecastAt"]) < validation_start and timestamp(row["availableAt"]) < validation_start]
        validation = [row for row in rows if validation_start <= timestamp(row["forecastAt"]) < test_start and timestamp(row["availableAt"]) < test_start]
        test = [row for row in rows if test_start <= timestamp(row["forecastAt"]) < test_end]
        calibration_times = sorted({row["forecastAt"] for row in validation}, key=timestamp)
        if min(len(train), len(validation), len(test)) < 5 or len(calibration_times) < 3:
            continue
        calibration_start = timestamp(calibration_times[max(1, int(len(calibration_times) * 2 / 3))])
        selection = [row for row in validation if timestamp(row["forecastAt"]) < calibration_start and timestamp(row["availableAt"]) < calibration_start]
        calibration = [row for row in validation if timestamp(row["forecastAt"]) >= calibration_start]
        result.append({"fold": index, "train": train, "selection": selection, "calibration": calibration, "test": test})
    return result


def audit_dataset(dataset: dict, matches: list[dict], original_report: dict, pipeline_report: dict | None = None) -> dict:
    rows, names = dataset["rows"], dataset["featureNames"]
    raw_by_id = {row["matchId"]: row for row in matches}
    duplicate_ids = [key for key, count in Counter(row["matchId"] for row in rows).items() if count > 1]
    fixture_counts = Counter((row["homeTeamId"], row["awayTeamId"], row["kickoffAt"], row["competition"]) for row in rows)
    duplicate_fixtures = [list(key) for key, count in fixture_counts.items() if count > 1]
    violations: dict[str, list[str]] = defaultdict(list)
    for row in rows:
        forecast, kickoff = timestamp(row["forecastAt"]), timestamp(row["kickoffAt"])
        for condition, key in ((kickoff - forecast != 900, "not_exact_T15"),
                               (row.get("maxTrainingAvailableAt") and timestamp(row["maxTrainingAvailableAt"]) > forecast, "future_feature_availability"),
                               (timestamp(row["modelFitAt"]) > forecast, "future_baseline_fit"),
                               (timestamp(row["availableAt"]) < kickoff + RESULT_DELAY_SECONDS, "label_available_too_early"),
                               (len(row["features"]) != len(names), "feature_schema_length")):
            if condition:
                violations[key].append(row["matchId"])
        raw = raw_by_id.get(row["matchId"])
        if not raw or any(raw.get(key) != row.get(key) for key in ("homeTeamId", "awayTeamId", "competition", "homeGoals", "awayGoals")):
            violations["target_raw_identity_mismatch"].append(row["matchId"])

    raw_complete = [row for row in matches if _completed(row)]
    xg = {league: {"completed": len(subset), "bothXgPresent": sum(isinstance(row.get("homeXG"), (int, float)) and isinstance(row.get("awayXG"), (int, float)) for row in subset)}
          for league in sorted({row["competition"] for row in raw_complete})
          if (subset := [row for row in raw_complete if row["competition"] == league])}
    folds = reconstruct_folds(rows, len(original_report.get("folds", [])))
    recorded_predictions = original_report.get("predictions", [])
    prediction_ids = [row["matchId"] for row in recorded_predictions]
    exported_by_id = {row["matchId"]: row for row in rows}
    prediction_violations: dict[str, list[str]] = defaultdict(list)
    baseline_serialization_delta = 0.0
    for prediction in recorded_predictions:
        source = exported_by_id.get(prediction["matchId"])
        if not source:
            prediction_violations["not_in_exported_dataset"].append(prediction["matchId"])
            continue
        if any(source.get(key) != prediction.get(key) for key in ("homeGoals", "awayGoals", "forecastAt", "kickoffAt", "competition")):
            prediction_violations["different_target_or_forecast_time"].append(prediction["matchId"])
        if timestamp(prediction["trainedThrough"]) >= timestamp(prediction["forecastAt"]) or timestamp(prediction["validationThrough"]) >= timestamp(prediction["forecastAt"]):
            prediction_violations["future_training_or_validation_information"].append(prediction["matchId"])
        matrix_delta = float(np.max(np.abs(np.asarray(source["baselineMatrix"]) - np.asarray(prediction["matrixA"]))))
        probability_delta = max(abs(source["baselineProbabilities"][key] - prediction["probabilitiesA"].get(key, float("inf"))) for key in source["baselineProbabilities"])
        baseline_serialization_delta = max(baseline_serialization_delta, matrix_delta, probability_delta)
        if matrix_delta > 1e-12 or probability_delta > 1e-12:
            prediction_violations["baseline_prediction_changed_above_numeric_tolerance"].append(prediction["matchId"])
    fold_results, seen_tests = [], set()
    for recovered, recorded in zip(folds, original_report.get("folds", [])):
        subsets = {name: {row["matchId"] for row in recovered[name]} for name in ("train", "selection", "calibration", "test")}
        recorded_tests = [row for row in recorded_predictions if row["versionC"] == recorded["version"]]
        recorded_calibration = recorded.get("calibrationPredictions", [])
        overlaps = {f"{left}:{right}": len(subsets[left] & subsets[right]) for i, left in enumerate(subsets) for right in list(subsets)[i + 1:]}
        counts_match = all(len(subsets[key]) == recorded[field] for key, field in (("train", "trainN"), ("selection", "validationN"), ("calibration", "calibrationN"), ("test", "testN")))
        fold_results.append({"fold": recovered["fold"], "counts": {name: len(value) for name, value in subsets.items()},
                             "countsMatchRecorded": counts_match, "withinFoldOverlap": overlaps,
                             "testOverlapPreviousFolds": len(subsets["test"] & seen_tests),
                             "testIdsMatchRecorded": subsets["test"] == {row["matchId"] for row in recorded_tests},
                             "calibrationIdsMatchRecorded": subsets["calibration"] == {row["matchId"] for row in recorded_calibration},
                             "trainedThroughMatchesLabels": recorded["trainedThrough"] == max(row["availableAt"] for row in recovered["train"]),
                             "validationThroughMatchesLabels": recorded["validationThrough"] == max(row["availableAt"] for row in recovered["selection"] + recovered["calibration"]),
                             "testFrom": recovered["test"][0]["forecastAt"], "testTo": recovered["test"][-1]["forecastAt"],
                             "maxTrainingLabelAt": max(row["availableAt"] for row in recovered["train"]),
                             "firstSelectionForecastAt": min(row["forecastAt"] for row in recovered["selection"]),
                             "maxSelectionLabelAt": max(row["availableAt"] for row in recovered["selection"]),
                             "firstCalibrationForecastAt": min(row["forecastAt"] for row in recovered["calibration"]),
                             "maxCalibrationLabelAt": max(row["availableAt"] for row in recovered["calibration"])})
        seen_tests |= subsets["test"]
    protected = sorted({row["matchId"] for row in recorded_predictions if row["versionC"] == original_report.get("finalHoldout", {}).get("version")})
    final_from = original_report.get("finalHoldout", {}).get("testFrom")
    development = [row for row in rows if row["matchId"] not in set(protected) and (not final_from or timestamp(row["forecastAt"]) < timestamp(final_from))]
    a_probs = [np.array([row["probabilitiesA"][key] for key in ("homeWin", "draw", "awayWin")]) for row in recorded_predictions]
    c_probs = [result_probabilities(row["matrixC"]) for row in recorded_predictions]
    raw_metrics = {"A": metrics(recorded_predictions, a_probs, "all_classes"), "C": metrics(recorded_predictions, c_probs, "all_classes")}
    proxy_delta = [float(np.max(np.abs(result_probabilities(row["baselineMatrix"]) - np.array([row["baselineProbabilities"][key] for key in ("homeWin", "draw", "awayWin")])))) for row in rows]
    team_seasons: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
    for row in matches:
        for key in ("homeTeamId", "awayTeamId"):
            team_seasons[row[key]][str(row.get("season"))].add(row["competition"])
    same_season_multi_league = [{"teamId": team, "season": season, "competitions": sorted(leagues)} for team, seasons in team_seasons.items() for season, leagues in seasons.items() if len(leagues) > 1]
    pipeline_weighted = None
    calibration_populations = []
    if pipeline_report:
        pipeline_weighted = {}
        for family in ("A", "C"):
            fold_metrics = [fold["report"][family] for fold in pipeline_report.get("folds", [])]
            total = sum(item["n"] for item in fold_metrics)
            weighted = {key: sum(item[key] * item["n"] for item in fold_metrics) / total for key in ("logLoss", "brier")} if total else {}
            pipeline_weighted[family] = {"n": total, **weighted, "maxDifferenceFromAggregate": max((abs(weighted[key] - pipeline_report[family][key]) for key in weighted), default=None)}
        for fold in pipeline_report.get("folds", []):
            profiles = fold.get("report", {}).get("calibrationProfiles", {})
            populations = {family: {"matches": profiles.get(family, {}).get("matches"),
                                    "observations": profiles.get(family, {}).get("nObservations"),
                                    "families": {key: value.get("nObservations") for key, value in profiles.get(family, {}).get("byFamily", {}).items()},
                                    "fittedThrough": profiles.get(family, {}).get("fittedThrough")}
                           for family in ("A", "C")}
            calibration_populations.append({"fold": fold["fold"], **populations,
                                            "sameMarketObservationCount": populations["A"]["observations"] == populations["C"]["observations"]})
    targets_by_season = {season: _target_distribution([row for row in rows if str(row.get("season")) == season]) for season in _counts(rows, "season")}
    reference_season = next(iter(targets_by_season), None)
    reference_targets = targets_by_season.get(reference_season, {})
    season_drift = {season: {"n": values["n"],
                            "maximumAbsoluteOutcomeFractionChange": max(abs(values["outcomeFractions"][key] - reference_targets["outcomeFractions"][key]) for key in ("home", "draw", "away")),
                            "homeGoalMeanChange": values["homeGoalMean"] - reference_targets["homeGoalMean"],
                            "awayGoalMeanChange": values["awayGoalMean"] - reference_targets["awayGoalMean"]}
                    for season, values in targets_by_season.items()}
    return {"schemaVersion": "research-dataset-audit-v1", "counts": {"raw": len(matches), "rawCompleted": len(raw_complete), "eligible": len(rows),
            "features": len(names), "byLeague": _counts(rows, "competition"), "bySeason": _counts(rows, "season"),
            "rawByLeague": _counts(matches, "competition"), "rawCompletedBySeason": _counts(raw_complete, "season")},
            "period": {"from": min(row["kickoffAt"] for row in rows), "to": max(row["kickoffAt"] for row in rows), "asOf": dataset.get("asOf")},
            "leagueSeasonCounts": {league: _counts([row for row in rows if row["competition"] == league], "season") for league in _counts(rows, "competition")},
            "duplicates": {"matchIds": duplicate_ids, "fixtures": duplicate_fixtures,
                           "rawMatchIds": [key for key, count in Counter(row["matchId"] for row in matches).items() if count > 1],
                           "predictionIds": [key for key, count in Counter(prediction_ids).items() if count > 1]},
            "temporalViolations": dict(violations), "predictionViolations": dict(prediction_violations), "featureRecomputation": verify_temporal_features(dataset, matches),
            "baselineSerializationMaximumAbsoluteDifference": baseline_serialization_delta,
            "featureProfile": profile_features(dataset), "targets": _target_distribution(rows),
            "targetsBySeason": targets_by_season,
            "descriptiveSeasonDrift": {"referenceSeason": reference_season, "bySeason": season_drift,
                                       "interpretation": "Unadjusted descriptive changes only: league composition, partial seasons and sampling uncertainty can explain differences; no causal structural break is established."},
            "rawXgCoverage": xg,
            "teamIdentity": {"teamIds": len(team_seasons), "sameSeasonMultipleLeagueAnomalies": same_season_multi_league,
                             "limitation": "Source export contains team IDs but no names or identity-transition evidence; physical identity/alias correctness cannot be proven from this export alone."},
            "originalFolds": fold_results, "originalRawMetricsRecomputed": raw_metrics,
            "originalMetricMaxErrors": {family: max(abs(raw_metrics[family][key] - original_report[f"metrics{family}"][key]) for key in ("logLoss", "brier", "ece")) for family in ("A", "C")},
            "pipelineFoldAggregationRecomputed": pipeline_weighted,
            "calibrationPopulations": calibration_populations,
            "baselineJointProxyMismatch": {"meanMaximum1x2AbsoluteDifference": float(np.mean(proxy_delta)),
                                           "maximum1x2AbsoluteDifference": max(proxy_delta), "nonzeroRowsAbove1eMinus8": sum(value > 1e-8 for value in proxy_delta)},
            "protectedFinal": {"n": len(protected), "matchIds": protected, "idHash": ids_hash(protected), "from": final_from,
                               "idsMatchChronologicalFinalFold": bool(folds) and set(protected) == {row["matchId"] for row in folds[-1]["test"]},
                               "useForTuning": False, "alreadyObserved": True},
            "development": {"n": len(development), "idHash": ids_hash([row["matchId"] for row in development]),
                            "from": development[0]["forecastAt"] if development else None, "to": development[-1]["forecastAt"] if development else None,
                            "protectedOverlap": len(set(protected) & {row["matchId"] for row in development}),
                            "independentFutureTestAvailable": False},
            "limitations": ["Availability is reconstructed as kickoff plus two hours; no contemporaneous source-version history is present.",
                            "No bookmaker odds are used as ML feature columns in this dataset.",
                            "Raw trainer ECE averages all three class probabilities; pipeline ECE measures maximum-confidence accuracy. They are not directly comparable.",
                            "Pipeline report does not persist all post-calibration predictions; weighted fold log loss/Brier are independently checked, while exact pipeline transforms require the saved calibration profiles and existing TypeScript implementation."]}
