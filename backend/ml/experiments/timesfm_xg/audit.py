"""Standard-library audit independent of benchmark metric/context helpers."""
import argparse
from datetime import datetime
import gzip
import hashlib
import importlib.util
import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2]


def ts(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()


def read_json(path):
    data = Path(path).read_bytes()
    if str(path).endswith(".gz"):
        data = gzip.decompress(data)
    return json.loads(data)


def main():
    parser = argparse.ArgumentParser()
    for name in ("dataset", "matches", "features", "contexts", "predictions", "summary", "out"):
        parser.add_argument("--" + name, required=True)
    args = parser.parse_args()
    dataset, bundle = read_json(args.dataset), read_json(args.features)
    summary = read_json(args.summary)
    protected = set(read_json(BACKEND / "src/research/original-holdout-policy.json")["protectedOriginalFinalMatchIds"])
    quarantine = {r["matchId"] for r in read_json(BACKEND / "src/research/challenger-data-quarantine.json")["entries"]}
    source = [m for m in read_json(args.matches) if m["matchId"] not in protected | quarantine]
    contexts = {c["key"]: c for c in map(json.loads, gzip.decompress(Path(args.contexts).read_bytes()).splitlines())}
    extra = {r["matchId"]: r for r in bundle["rows"]}
    assert set(extra) == {r["matchId"] for r in dataset["rows"]}
    assert not (set(extra) & (protected | quarantine))
    by_team = {}
    for m in source:
        if m.get("homeGoals") is None or m.get("awayGoals") is None:
            continue
        if not all(type(m.get(f"{side}XG")) in (int, float) and math.isfinite(m[f"{side}XG"]) and m[f"{side}XG"] >= 0
                   for side in ("home", "away")):
            continue
        for side in ("home", "away"):
            by_team.setdefault((m["competition"], m[f"{side}TeamId"]), []).append(m)
    maximum_feature_error, history_checks, used = 0.0, 0, set()
    for r in dataset["rows"]:
        f = extra[r["matchId"]]
        legacy = dict(zip(dataset["featureNames"], r["features"]))
        for side_index, side in enumerate(("home", "away")):
            cutoff = ts(r["forecastAt"])
            def available(m):
                return max(ts(m["date"]) + 7200, ts(m["availableAt"]) if m.get("availableAt") else 0)
            history = sorted((m for m in by_team.get((r["competition"], r[f"{side}TeamId"]), [])
                              if available(m) < cutoff), key=lambda m: (ts(m["date"]), m["matchId"]))[-64:]
            ids = [m["matchId"] for m in history]
            assert r["matchId"] not in ids
            assert ids == f["history"][side_index]["ids"]
            assert f["history"][side_index]["maximumAvailableAt"] == max(map(available, history), default=None)
            history_checks += 1
            for metric_index, (metric, legacy_name) in enumerate((("XG", "xg_for"), ("XGA", "xg_against"))):
                column = side_index * 2 + metric_index
                key = f["contextKeys"][column]
                if len(history) < 5:
                    assert key is None
                    expected = [legacy[f"{side}_{legacy_name}"]] * 2
                else:
                    assert key in contexts
                    c = contexts[key]
                    values = []
                    for m in history:
                        observed_side = "home" if m["homeTeamId"] == r[f"{side}TeamId"] else "away"
                        source_side = observed_side if metric == "XG" else ("away" if observed_side == "home" else "home")
                        values.append(float(m[f"{source_side}XG"]))
                    assert c["ids"] == ids and c["values"] == values
                    assert hashlib.sha256(json.dumps({"ids": ids, "values": values}, separators=(",", ":")).encode()).hexdigest() == key
                    weights = [math.exp(-math.log(2) * (len(values) - i - 1) / 5) for i in range(len(values))]
                    expected = [sum(w * v for w, v in zip(weights, values)) / sum(weights), c["forecast"]]
                    used.add(key)
                for arm, expected_value in zip(("wma", "timesfm"), expected):
                    error = abs(f[arm][column] - min(8.0, max(0.0, expected_value)))
                    maximum_feature_error = max(maximum_feature_error, error)
                    assert error < 1e-12
    assert used == set(contexts)
    spec = importlib.util.spec_from_file_location("independent_metrics", BACKEND / "scripts/audit-challenger-metrics.py")
    audit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(audit)
    predictions = [json.loads(line) for line in gzip.decompress(Path(args.predictions).read_bytes()).splitlines()]
    assert len(predictions) == 4892 and len({r["matchId"] for r in predictions}) == 4892
    assert not ({r["matchId"] for r in predictions} & (protected | quarantine))
    converted = [{**r, "predictions": {a: {"probabilities": p} for a, p in r["predictions"].items()}} for r in predictions]
    metrics_error = 0.0
    for field in (None, "competition", "season", "fold"):
        groups = [None] if field is None else sorted({r[field] for r in converted})
        for group in groups:
            rows = converted if field is None else [r for r in converted if r[field] == group]
            target = summary["overall"] if field is None else summary["groups"][field][str(group)]
            for arm in ("c_recipe", "c_wma", "c_timesfm"):
                measured = audit.calculate(rows, arm)
                assert measured["n"] == target[arm]["n"]
                for metric in ("logLoss", "brier", "ece", "accuracy"):
                    error = abs(measured[metric] - target[arm][metric])
                    metrics_error = max(metrics_error, error)
                    assert error < 1e-12
    result = {"status": "PASS", "historyContextsChecked": history_checks, "uniqueModelContextsChecked": len(contexts),
              "featureRows": len(extra), "predictions": len(predictions), "maximumFeatureError": maximum_feature_error,
              "maximumMetricError": metrics_error, "scope": "all_feature_contexts_WMA_saved_TimesFM_binding_and_all_point_metrics",
              "notVerified": ["rerun_of_every_TimesFM_forecast", "historical_provider_first_seen", "pretraining_overlap"]}
    with Path(args.out).open("x", encoding="utf-8") as stream:
        json.dump(result, stream, indent=2)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
