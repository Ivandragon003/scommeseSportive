"""Inspect the saved final DEVELOPMENT fold models, without training or final data."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np
from catboost import CatBoostClassifier, CatBoostRegressor, Pool

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import diagnose as d


def run(args):
    report = json.loads(Path(args.diagnostics).read_bytes())
    dataset = json.loads(Path(args.dataset).read_bytes())
    original = json.loads(Path(args.original).read_bytes())
    development, protected, _ = d.protected_development_rows(dataset, original)
    fold = list(d.development_folds(development, len(report["developmentProtocol"]["folds"])))[-1]
    if any(row["matchId"] in protected for part in ("train", "selection", "calibration", "check") for row in fold[part]):
        raise ValueError("protected_final_in_fit_stability")
    output = {"schemaVersion": "research-fit-stability-v1", "sourceDiagnosticsHash": d.digest(args.diagnostics),
              "fold": fold["index"], "protectedFinalUsed": False, "configurations": [], "shapBySelectionSeason": [],
              "permutationBySelectionSeason": [], "limitations": ["Training scores are in-sample, never evidence of future quality.",
                "Only the final development fold's fitted model is used for seasonal comparisons; sample composition can explain attribution shifts."]}
    for kind in d.KINDS:
        entry = next(item for item in report["experiments"] if item["featureGroup"] == "full" and item["kind"] == kind and item["calibration"] == "identity")
        selected = entry["folds"][-1]
        models, training = {}, {}
        for name, artifact in entry["modelArtifactPaths"].items():
            model = CatBoostClassifier() if name == "probability" else CatBoostRegressor()
            model.load_model(artifact["path"], format="json"); models[name] = model
            encoded = json.loads(Path(artifact["path"]).read_bytes())["model_info"]["training"]
            meta = json.loads(encoded) if isinstance(encoded, str) else encoded
            history = meta["metrics"]["learn_metrics_history"]
            training[name] = {"first": history[0], "last": history[-1], "best": meta["metrics"]["learn_best_error"], "iterations": len(history)}
        scores = {}
        for part in ("train", "selection", "calibration", "check"):
            rows = fold[part]
            baseline = [row["baselineMatrix"] for row in rows]
            predicted = d.mix(baseline, d.trainer.raw_matrices(rows, kind, models), selected["weight"], selected["temperature"])
            scores[part] = {"A": d.metric(rows, d.probabilities(baseline)), "C": d.metric(rows, d.probabilities(predicted))}
        output["configurations"].append({"kind": kind, "selection": {key: selected[key] for key in ("weight", "temperature", "selectionLogLoss")},
            "trainingObjectives": training, "probabilityScores": scores})
        for season in sorted({row["season"] for row in fold["selection"]}):
            rows = [row for row in fold["selection"] if row["season"] == season]
            sample = rows[-min(100, len(rows)):]
            x = np.asarray([row["features"] for row in sample])
            for name, model in models.items():
                values = np.asarray(model.get_feature_importance(Pool(x, feature_names=dataset["featureNames"]), type="ShapValues"))
                importance = np.mean(np.abs(values[..., :-1]), axis=tuple(range(values.ndim - 1)))
                output["shapBySelectionSeason"].append({"kind": kind, "model": name, "season": season, "n": len(sample),
                    "meanAbsolute": [{"feature": feature, "value": float(value)} for feature, value in zip(dataset["featureNames"], importance)]})
            if kind == "intensity_correction":
                groups, _ = d.feature_groups(dataset["featureNames"])
                baseline = [row["baselineMatrix"] for row in rows]
                prior = d.probabilities(d.mix(baseline, d.trainer.raw_matrices(rows, kind, models), selected["weight"], selected["temperature"]))
                rng = np.random.default_rng(d.SEED)
                for group, columns in groups.items():
                    changed = [{**row, "features": list(row["features"])} for row in rows]
                    for league in sorted({row["competition"] for row in rows}):
                        positions = [i for i, row in enumerate(rows) if row["competition"] == league]
                        for target, source in zip(positions, rng.permutation(positions)):
                            for column in columns:
                                changed[target]["features"][column] = rows[source]["features"][column]
                    predicted = d.probabilities(d.mix(baseline, d.trainer.raw_matrices(changed, kind, models), selected["weight"], selected["temperature"]))
                    output["permutationBySelectionSeason"].append({"kind": kind, "group": group, "season": season,
                        **d.paired(rows, prior, predicted)})
    d.dump(args.output, output)
    print(json.dumps({"output": args.output, "configurations": len(output["configurations"]), "protectedFinalUsed": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--diagnostics", required=True); parser.add_argument("--dataset", required=True)
    parser.add_argument("--original", required=True); parser.add_argument("--output", required=True)
    run(parser.parse_args())
