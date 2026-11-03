"""Offline diagnostic only: frozen C recipe versus identical four-feature refits."""
from __future__ import annotations
import argparse
import gzip
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta

import numpy as np

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[2]
sys.path.insert(0, str(BACKEND / 'ml'))
import train as core

FEATURES = ['home_temporal_xg', 'home_temporal_xga', 'away_temporal_xg', 'away_temporal_xga']
ARMS = ('c_recipe', 'c_wma', 'c_timesfm')
SEED = 20261103
EVIDENCE = BACKEND.parent / 'docs/performance/evidence/c-three-season-backtest-2026-10-31/predictions/predictions.jsonl.gz'


def validate_features(document, data_hash, rows, protocol_hash):
    if document.get('schemaVersion') != 'timesfm-xg-features-v1' or document.get('datasetHash') != data_hash or document.get('featureNames') != FEATURES:
        raise ValueError('feature_contract_or_dataset_hash_mismatch')
    metadata = document.get('metadata')
    if (not isinstance(metadata, dict) or metadata.get('protocolHash') != protocol_hash
            or metadata.get('sourceMatchesHash') != '249233a01c52ddd2578b676ae0a464ecbcce01907e34b89138a23c15e1178dc9'
            or type(metadata.get('protectedCount')) is not int or metadata['protectedCount'] != 745
            or type(metadata.get('quarantineCount')) is not int or metadata['quarantineCount'] != 22):
        raise ValueError('feature_provenance_mismatch')
    feature_rows = document.get('rows')
    if not isinstance(feature_rows, list):
        raise ValueError('feature_rows_missing')
    by_id = {}
    for row in feature_rows:
        mid = row.get('matchId')
        if not isinstance(mid, str) or mid in by_id:
            raise ValueError('duplicate_or_invalid_feature_match')
        for arm in ('wma', 'timesfm'):
            values = row.get(arm)
            if not isinstance(values, list) or len(values) != 4 or any(type(v) not in (int, float) or not math.isfinite(v) for v in values):
                raise ValueError('invalid_temporal_features')
        by_id[mid] = row
    if set(by_id) != {r['matchId'] for r in rows}:
        raise ValueError('feature_cohort_mismatch')
    return by_id


def metrics(probs, y):
    p = np.asarray(probs, dtype=float)
    y = np.asarray(y, dtype=int)
    if p.shape != (len(y), 3) or not len(y) or not np.all(np.isfinite(p)) or np.any(p < 0) or np.any(p > 1) or np.any(np.abs(p.sum(axis=1) - 1) > 1e-12):
        raise ValueError('invalid_probabilities')
    hit = p.argmax(axis=1) == y
    confidence = p.max(axis=1)
    bins = np.minimum((confidence * 10).astype(int), 9)
    ece = sum(abs(confidence[bins == i].sum() - hit[bins == i].sum()) for i in range(10)) / len(y)
    return {'n': len(y), 'logLoss': float(-np.log(np.maximum(p[np.arange(len(y)), y], 1e-15)).mean()),
            'brier': float(((p - np.eye(3)[y]) ** 2).sum(axis=1).mean()), 'ece': float(ece), 'accuracy': float(hit.mean())}


def bootstrap(rows, block_length=1, draws=10000, seed=SEED):
    """Paired calendar-week blocks. Empty calendar weeks remain in moving blocks."""
    dates = [datetime.fromisoformat(r['kickoffAt'].replace('Z', '+00:00')).date() for r in rows]
    monday = [d - timedelta(days=d.weekday()) for d in dates]
    first, last = min(monday), max(monday)
    weeks = (last - first).days // 7 + 1
    if weeks < max(2, block_length):
        raise ValueError('insufficient_bootstrap_weeks')
    week_index = np.array([(d - first).days // 7 for d in monday])
    y = np.array([core.class_of(r) for r in rows])
    # Sufficient weekly statistics make top-label ECE recomputed on each sample.
    data = np.zeros((len(ARMS), weeks, 23))
    for a, arm in enumerate(ARMS):
        p = np.array([r['predictions'][arm] for r in rows])
        metrics(p, y)
        conf, hit = p.max(axis=1), (p.argmax(axis=1) == y).astype(float)
        bins = np.minimum((conf * 10).astype(int), 9)
        for w in range(weeks):
            m = week_index == w
            data[a, w, :3] = [-np.log(np.maximum(p[m, y[m]], 1e-15)).sum(), ((p[m] - np.eye(3)[y[m]]) ** 2).sum(), hit[m].sum()]
            for b in range(10):
                z = m & (bins == b)
                data[a, w, 3 + b] = conf[z].sum() - hit[z].sum()
            data[a, w, 13] = m.sum()
    rng = np.random.default_rng(seed)
    starts = rng.integers(0, weeks - block_length + 1, size=(draws, math.ceil(weeks / block_length)))
    sampled = (starts[:, :, None] + np.arange(block_length)).reshape(draws, -1)[:, :weeks]
    weights = np.zeros((draws, weeks), dtype=np.int32)
    for i in range(draws):
        weights[i] = np.bincount(sampled[i], minlength=weeks)
    values = []
    for a in range(len(ARMS)):
        totals = weights @ data[a]
        n = totals[:, 13]
        if np.any(n == 0):
            raise ValueError('empty_bootstrap_sample')
        values.append(np.column_stack((totals[:, 0] / n, totals[:, 1] / n,
                                      np.abs(totals[:, 3:13]).sum(axis=1) / n, totals[:, 2] / n)))
    result = {}
    for ref in ('c_recipe', 'c_wma'):
        delta = values[2] - values[ARMS.index(ref)]
        result[ref] = {}
        for i, name in enumerate(('logLoss', 'brier', 'ece', 'accuracy')):
            result[ref][name] = {str(level): [float(x) for x in np.quantile(delta[:, i], [(1-level)/2, (1+level)/2])]
                                 for level in (0.9, 0.95, 0.9875)}
    absolute = {arm: {name: [float(x) for x in np.quantile(values[a][:, i], [.025, .975])]
                      for i, name in enumerate(('logLoss', 'brier', 'ece', 'accuracy'))}
                for a, arm in enumerate(ARMS)}
    return {'method': 'paired-calendar-week' if block_length == 1 else 'paired-moving-calendar-weeks',
            'blockWeeks': block_length, 'weeks': weeks, 'seed': seed, 'draws': draws,
            'absolute95': absolute, 'comparisons': result}


def run(args):
    dataset_bytes = Path(args.dataset).read_bytes()
    dataset_hash = hashlib.sha256(dataset_bytes).hexdigest()
    plan_bytes = Path(args.plan).read_bytes()
    protocol_bytes = Path(args.protocol).read_bytes()
    protocol = json.loads(protocol_bytes)
    plan_hash = hashlib.sha256(plan_bytes).hexdigest()
    if (protocol.get('protocol') != 'timesfm-xg-c-offline-20261103-v1'
            or protocol.get('status') != 'fixed_before_feature_inference_and_new_arm_results'
            or protocol.get('datasetSha256') != dataset_hash or protocol.get('planSha256') != plan_hash
            or protocol.get('cRecipe') != {'features': 'legacy40_plus_four_forecasts_for_augmented_arms',
                'catboost': '1.2.8', 'iterations': 120, 'depth': 5, 'learningRate': 0.05, 'seed': 20261027,
                'threads': 2, 'mlWeight': 0.75, 'temperature': 0.8,
                'calibration': 'existing_coherent_isotonic_1x2_refit_only_on_fold_calibration',
                'selection': 'unused_no_hyperparameter_search'}
            or protocol.get('inference', {}).get('samples') != 10000
            or protocol.get('inference', {}).get('seed') != SEED
            or protocol.get('inference', {}).get('materialImprovementAbsolute') != .001
            or protocol.get('inference', {}).get('simultaneousIntervalLevel') != .9875):
        raise ValueError('protocol_or_frozen_input_mismatch')
    dataset, plan = json.loads(dataset_bytes), json.loads(plan_bytes)
    source_names, rows, holdout = core.checked_dataset(dataset, controlled=True)
    if core.catboost_version != '1.2.8' or dataset['baselineManifest']['version'] != 'A-80cb25df5552621e':
        raise ValueError('unexpected_baseline_or_catboost_version')
    feature_doc = json.loads(Path(args.features).read_bytes())
    protocol_hash = hashlib.sha256(protocol_bytes).hexdigest()
    features = validate_features(feature_doc, dataset_hash, rows, protocol_hash)
    planned = list(core.fixed_window_folds(rows, plan))
    if len(planned) != 6:
        raise ValueError('expected_six_folds')
    frozen = {f['fold']: f['trainingSplit'] for f in core.checked_split_plan(plan)}
    for index, *groups in planned:
        actual = core.split_manifest(*groups)
        for part in ('train', 'selection', 'calibration', 'test'):
            if any(actual[part][key] != frozen[index][part][key] for key in ('n', 'matchIdsHash')):
                raise ValueError(f'frozen_cohort_mismatch:{index}:{part}')
    test_ids = [r['matchId'] for _, *groups in planned for r in groups[-1]]
    if len(test_ids) != 4892 or len(set(test_ids)) != 4892:
        raise ValueError('test_cohort_not_4892_unique_matches')
    with gzip.open(EVIDENCE, 'rt', encoding='utf-8') as fh:
        published = {r['matchId']: r['predictions']['c906_recipe_retrained']['probabilities'] for r in map(json.loads, fh)
                     if 'c906_recipe_retrained' in r['predictions']}
    if set(published) != set(test_ids):
        raise ValueError('published_cohort_mismatch')
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    predictions, timings, model_hashes = [], [], []
    max_parity_error = 0.0
    with tempfile.TemporaryDirectory(prefix='timesfm-offline-') as temp:
        temp = Path(temp)
        for fold, train, selection, calibration, test in planned:
            fold_predictions = {}
            for arm in ARMS:
                names, training = core.project_feature_rows(train, source_names, [])
                _, calibrating = core.project_feature_rows(calibration, source_names, [])
                _, testing = core.project_feature_rows(test, source_names, [])
                if arm != 'c_recipe':
                    key = 'wma' if arm == 'c_wma' else 'timesfm'
                    names += FEATURES
                    for row in training + calibrating + testing:
                        row['features'] = row['features'] + features[row['matchId']][key]
                start = time.perf_counter()
                models, exported = core.train_candidates(training, names, temp, 120, 5, kinds=('calibrated_ensemble',))
                fitted = time.perf_counter()
                spec = {'kind': 'calibrated_ensemble', 'weight': .75, 'temperature': .8}
                cal_m = core.arm_matrices(calibrating, spec, models['calibrated_ensemble'])
                test_m = core.arm_matrices(testing, spec, models['calibrated_ensemble'])
                predicted = time.perf_counter()
                payload = {'calibration': [{'row': r, 'matrix': m.tolist()} for r, m in zip(calibrating, cal_m)],
                           'test': [{'row': r, 'matrix': m.tolist()} for r, m in zip(testing, test_m)],
                           'cutoff': frozen[fold]['calibration']['availableThrough']}
                input_path, output_path = temp / 'input.json', temp / 'output.json'
                input_path.write_text(json.dumps(payload, allow_nan=False), encoding='utf-8')
                subprocess.run(['node', str(HERE / 'calibrate.cjs'), str(input_path), str(output_path)], check=True)
                result = json.loads(output_path.read_text(encoding='utf-8'))
                done = time.perf_counter()
                for side, model in exported['calibrated_ensemble'].items():
                    content = json.dumps(model, separators=(',', ':'), allow_nan=False).encode('utf-8')
                    relative = f'fold-{fold}-{arm}-{side}.json.gz'
                    with (out / relative).open('xb') as raw:
                        with gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0, compresslevel=9) as stream:
                            stream.write(content)
                    model_hashes.append({'fold': fold, 'arm': arm, 'side': side, 'file': relative,
                                         'decodedSha256': hashlib.sha256(content).hexdigest()})
                if result['matches'] != len(calibration):
                    raise ValueError('calibration_cohort_mismatch')
                fold_predictions[arm] = result['predictions']
                timing = {'fold': fold, 'arm': arm, 'fitSeconds': fitted-start, 'predictSeconds': predicted-fitted,
                          'calibrationSecondsIncludingNodeStartup': done-predicted}
                try:
                    import psutil
                    timing['rssBytesAfterCalibration'] = psutil.Process().memory_info().rss
                except ImportError:
                    timing['rssBytesAfterCalibration'] = None
                timings.append(timing)
                print(json.dumps(timing), flush=True)
            for i, row in enumerate(test):
                probs = {arm: fold_predictions[arm][i] for arm in ARMS}
                error = max(abs(a-b) for a, b in zip(probs['c_recipe'], published[row['matchId']]))
                max_parity_error = max(max_parity_error, error)
                if error > 1e-12:
                    raise ValueError(f'published_recipe_probability_mismatch:{row["matchId"]}')
                predictions.append({k: row[k] for k in ('matchId', 'competition', 'season', 'kickoffAt', 'forecastAt', 'availableAt', 'homeGoals', 'awayGoals')} | {'fold': fold, 'predictions': probs})
    summary = summarize(predictions)
    summary.update({'schemaVersion': 'timesfm-xg-offline-benchmark-v1', 'datasetHash': dataset_hash,
                    'planHash': plan_hash, 'protocolHash': protocol_hash,
                    'featuresHash': hashlib.sha256(Path(args.features).read_bytes()).hexdigest(),
                    'featuresMetadata': feature_doc.get('metadata'), 'holdout': holdout, 'timings': timings,
                    'models': model_hashes, 'publishedRecipeParityTolerance': 1e-12,
                    'publishedRecipeMaxAbsoluteError': max_parity_error, 'operationalC906HistoricalN': 0,
                    'recipeMeaning': 'retrospective fold refit, not frozen operational C906',
                    'productionEligible': False, 'selection': 'unused; no tuning'})
    source_paths = {'benchmark': HERE / 'benchmark.py', 'features': HERE / 'features.py', 'calibrate': HERE / 'calibrate.cjs',
                    'trainer': BACKEND / 'ml/train.py', 'coherentPipeline': BACKEND / 'dist/research/CoherentProbabilityPipeline.js',
                    'researchPipeline': BACKEND / 'dist/research/ResearchProbabilityPipeline.js',
                    'goalSettlement': BACKEND / 'dist/research/GoalSettlement.js',
                    'enhancedMarketAnalysis': BACKEND / 'dist/models/value/EnhancedMarketAnalysis.js',
                    'valueBettingEngine': BACKEND / 'dist/models/value/ValueBettingEngine.js',
                    'predictionEngineConfig': BACKEND / 'dist/config/PredictionEngineConfig.js'}
    summary['sourceHashes'] = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in source_paths.items()}
    payload = b''.join((json.dumps(row, separators=(',', ':'), ensure_ascii=False, allow_nan=False) + '\n').encode('utf-8') for row in predictions)
    with (out / 'predictions.jsonl.gz').open('xb') as raw:
        with gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0, compresslevel=9) as fh:
            fh.write(payload)
    summary['predictionsDecodedSha256'] = hashlib.sha256(payload).hexdigest()
    (out / 'summary.json').write_text(json.dumps(summary, indent=2, allow_nan=False), encoding='utf-8')


def passes_improvement(bootstrap_result):
    return all(bootstrap_result['comparisons'][ref][metric]['0.9875'][1] < -0.001
               for ref in ('c_recipe', 'c_wma') for metric in ('logLoss', 'brier'))


def improving_leagues(league_metrics):
    refs = ('c_recipe', 'c_wma')
    by_ref = {ref: {league for league, scores in league_metrics.items()
                    if all(scores['c_timesfm'][metric] < scores[ref][metric] for metric in ('logLoss', 'brier'))}
              for ref in refs}
    return {ref: len(by_ref[ref]) for ref in refs}, sorted(by_ref['c_recipe'] & by_ref['c_wma'])


def summarize(rows):
    def evaluate(group):
        y = [core.class_of(r) for r in group]
        return {a: metrics([r['predictions'][a] for r in group], y) for a in ARMS}
    overall = evaluate(rows)
    grouped = {}
    for field in ('competition', 'season', 'fold'):
        grouped[field] = {str(value): evaluate([r for r in rows if r[field] == value]) for value in sorted({r[field] for r in rows})}
    primary, sensitivity = bootstrap(rows), bootstrap(rows, block_length=4)
    comparisons = primary['comparisons']
    primary_improvement = passes_improvement(primary)
    sensitivity_improvement = passes_improvement(sensitivity)
    improvement = primary_improvement and sensitivity_improvement
    ece_ok = all(overall['c_timesfm']['ece'] <= overall[ref]['ece'] for ref in ('c_recipe', 'c_wma'))
    league_counts, joint_leagues = improving_leagues(grouped['competition'])
    equivalent = all(comparisons[ref][metric]['0.9'][0] > -.001 and comparisons[ref][metric]['0.9'][1] < .001 for ref in ('c_recipe', 'c_wma') for metric in ('logLoss', 'brier'))
    worse_against = {ref: [metric for metric in ('logLoss', 'brier')
                           if all(result['comparisons'][ref][metric]['0.9875'][0] > .001 for result in (primary, sensitivity))]
                     for ref in ('c_recipe', 'c_wma')}
    worse_both = all(worse_against.values())
    verdict = 'better' if improvement and ece_ok and len(joint_leagues) >= 4 else 'equivalent' if equivalent else 'worse_against_both' if worse_both else 'no_credible_benefit_inconclusive'
    league_bootstrap = {str(value): bootstrap([r for r in rows if r['competition'] == value])
                        for value in sorted({r['competition'] for r in rows})}
    point_deltas = {ref: {metric: overall['c_timesfm'][metric] - overall[ref][metric]
                          for metric in ('logLoss', 'brier', 'ece', 'accuracy')}
                    for ref in ('c_recipe', 'c_wma')}
    return {'overall': overall, 'groups': grouped, 'pointDeltasTimesfmMinusComparator': point_deltas,
            'primaryBootstrap': primary, 'sensitivityBootstrap': sensitivity, 'leagueBootstrap': league_bootstrap,
            'gate': {'absoluteMateriality': .001, 'simultaneousInterval': .9875, 'improvement': improvement,
                     'primaryImprovement': primary_improvement, 'sensitivityImprovement': sensitivity_improvement,
                     'eceNotWorse': ece_ok, 'leagueImprovementCounts': league_counts,
                     'jointImprovingLeagues': joint_leagues, 'jointImprovingLeagueCount': len(joint_leagues),
                     'formalEquivalence': equivalent,
                     'materialWorseMetricsByComparator': worse_against, 'verdict': verdict}}


def analyze(args):
    compressed = Path(args.predictions).read_bytes()
    decoded = gzip.decompress(compressed)
    rows = [json.loads(line) for line in decoded.splitlines()]
    if (len(rows) != 4892 or len({r['matchId'] for r in rows}) != 4892
            or {r['fold'] for r in rows} != set(range(6))
            or len({r['competition'] for r in rows}) != 5
            or any(set(r['predictions']) != set(ARMS) for r in rows)):
        raise ValueError('invalid_replay_cohort')
    summary = summarize(rows)
    summary.update({'schemaVersion': 'timesfm-xg-offline-analysis-v1',
                    'predictionsDecodedSha256': hashlib.sha256(decoded).hexdigest(),
                    'predictionsGzipSha256': hashlib.sha256(compressed).hexdigest(),
                    'benchmarkSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                    'productionEligible': False})
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=False)
    (out / 'summary.json').write_text(json.dumps(summary, indent=2, allow_nan=False), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('train')
    for name in ('dataset', 'plan', 'features', 'out'):
        p.add_argument('--' + name, required=True)
    p.add_argument('--protocol', default=str(HERE / 'protocol.json'))
    replay = sub.add_parser('analyze')
    replay.add_argument('--predictions', required=True)
    replay.add_argument('--out', required=True)
    args = parser.parse_args()
    if args.command == 'train':
        run(args)
    else:
        analyze(args)


if __name__ == '__main__':
    main()
