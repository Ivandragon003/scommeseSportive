"""Diagnose the already-scored empty-leaf prefix backoff; never prepare a candidate."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import subprocess
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / 'backend/experiments/c-tree-empty-leaf-backoff/diagnose.py'
HELPER_HASH = '60c366521b74be1588bda6552b0298764528e244af0132e9586c2571dcf45d9b'
COMPARISON = ROOT / 'backend/artifacts/research/c-tree-empty-leaf-backoff-20261108/run/comparison.json'
COMPARISON_HASH = '7e17676370c2309f5aababdee1631d3806de00ae153b02782bc85200f1799f6f'
CANDIDATE = COMPARISON.parent / 'candidate.json'
INCUMBENT = ROOT / 'backend/current-models/challenger.json'
DATASET = ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json'
HISTORY = ROOT / 'backend/artifacts/research/current-c-real-odds-backtest-20261108/history.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


assert digest(HELPER) == HELPER_HASH
SPEC = importlib.util.spec_from_file_location('frozen_probability_diagnosis', HELPER)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
read, metric, outcome = helper.read, helper.metric, helper.outcome
KEYS, STAGES = helper.KEYS, helper.STAGES


def routes(model, x):
    x = np.asarray(x, dtype=np.float32)
    mapping = {f['feature_index']: f['flat_feature_index'] for f in model['features_info']['float_features']}
    result = []
    for tree in model['oblivious_trees']:
        leaf = np.zeros(len(x), dtype=int)
        for bit, split in enumerate(tree['splits']):
            leaf += (x[:, mapping[split['float_feature_index']]] > split['border']) * (1 << bit)
        result.append(leaf)
    return np.asarray(result).T


def condition(split, bit, leaf, names, x=None):
    feature = split['float_feature_index']
    return {'bit': bit, 'feature': names[feature], 'operator': '>' if leaf & (1 << bit) else '<=',
            'border': split['border'], **({'targetValue': x[feature]} if x is not None else {})}


def rebuild_missing(ids, names):
    if not ids:
        return {}
    code = r"""
const fs = require('fs');
const {buildForecastInput} = require('./backend/dist/research/ForecastCore');
const {filterChallengerHistory} = require('./backend/dist/research/ChallengerDataQuality');
const {resolveNightlyForecastAt} = require('./backend/dist/research/ForecastDecisionTime');
const args = JSON.parse(fs.readFileSync(0,'utf8'));
const history = filterChallengerHistory(JSON.parse(fs.readFileSync(args.history,'utf8')));
const byId = new Map(history.map(r => [r.matchId,r]));
const output = {};
for (const id of args.ids) {
  const m = byId.get(id);
  const input = buildForecastInput(history,{matchId:m.matchId,homeTeamId:m.homeTeamId,awayTeamId:m.awayTeamId,
    date:m.date,competition:m.competition,season:m.season},resolveNightlyForecastAt(m.date,{hour:3,minute:7}));
  output[id] = args.names.map(n => input.features[input.featureNames.indexOf(n)]);
}
process.stdout.write(JSON.stringify(output));
"""
    proc = subprocess.run(['node', '-e', code], cwd=ROOT, input=json.dumps({'ids': ids, 'names': names,
        'history': HISTORY.relative_to(ROOT).as_posix()}), capture_output=True, text=True, check=True)
    return json.loads(proc.stdout)


def run(output):
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f'Diagnosis output already exists: {output}')
    assert digest(COMPARISON) == COMPARISON_HASH
    comparison = read(COMPARISON)
    expected_hashes = dict(comparison['pinnedSourceHashes'])
    for path in (COMPARISON, CANDIDATE, INCUMBENT, DATASET, HISTORY, HELPER, Path(__file__)):
        key = path.relative_to(ROOT).as_posix()
        if key not in expected_hashes:
            expected_hashes[key] = digest(path)
    expected_hashes[CANDIDATE.relative_to(ROOT).as_posix()] = comparison['candidateHash']

    def verify():
        for key, expected in expected_hashes.items():
            assert digest(ROOT / key) == expected, f'Pinned input changed: {key}'

    verify()
    artifacts = {'incumbent': read(INCUMBENT), 'candidate': read(CANDIDATE)}
    assert artifacts['candidate']['version'] == comparison['candidateVersion'] == 'C-feff393275451d01'
    assert artifacts['incumbent']['version'] == comparison['incumbentVersion'] == 'C-75fd74eb875e9d0e'
    dataset = read(DATASET)
    names = artifacts['incumbent']['featureNames']
    indices = [dataset['featureNames'].index(n) for n in names]
    features = {r['matchId']: [r['features'][i] for i in indices] for r in dataset['rows']}
    rows = comparison['rows']
    missing = [r['matchId'] for r in rows if r['matchId'] not in features]
    features.update(rebuild_missing(missing, names))
    split = artifacts['incumbent']['trainingSplit']
    train = [r for r in dataset['rows'] if split['train']['from'] <= r['forecastAt'] <= split['train']['to']
             and r['availableAt'] < split['selection']['from']]
    assert len(train) == 5293
    assert hashlib.sha256('\n'.join(sorted(r['matchId'] for r in train)).encode()).hexdigest() == split['train']['matchIdsHash']
    x_train = np.array([features[r['matchId']] for r in train], dtype=np.float32)
    x_rows = np.array([features[r['matchId']] for r in rows], dtype=np.float32)
    train_routes, row_routes = {}, {}
    for side in ('home', 'away'):
        model = artifacts['incumbent']['models'][side]
        train_routes[side], row_routes[side] = routes(model, x_train), routes(model, x_rows)
        for ti, tree in enumerate(model['oblivious_trees']):
            assert np.array_equal(np.bincount(train_routes[side][:, ti], minlength=len(tree['leaf_values'])), tree['leaf_weights'])
    profiles = {model: a['calibrationProfilesV2']['C'] for model, a in artifacts.items()}
    max_profile_error = 0.
    for ri, row in enumerate(rows):
        x = features[row['matchId']]
        row['inputDiagnostics'], row['emptyVisits'] = {}, []
        for side in ('home', 'away'):
            logs = {model: helper.predict(a['models'][side], x) for model, a in artifacts.items()}
            rates = {model: min(8., max(.05, math.exp(value))) for model, value in logs.items()}
            count_index = names.index(side + '_sample')
            row['inputDiagnostics'][side] = {**rates, 'delta': rates['candidate'] - rates['incumbent'],
                'deltaLog': logs['candidate'] - logs['incumbent'], 'sample': x[count_index],
                'outsideTrainingRange': x[count_index] > float(x_train[:, count_index].max())}
            original, edited = (artifacts[m]['models'][side] for m in ('incumbent', 'candidate'))
            for ti, tree in enumerate(original['oblivious_trees']):
                leaf = int(row_routes[side][ri, ti])
                if tree['leaf_weights'][leaf] != 0:
                    assert tree['leaf_values'][leaf] == edited['oblivious_trees'][ti]['leaf_values'][leaf]
                    continue
                depth = len(tree['splits'])
                for length in range(depth - 1, -1, -1):
                    mask = (1 << length) - 1
                    example_indices = np.flatnonzero((train_routes[side][:, ti] & mask) == (leaf & mask))
                    if len(example_indices):
                        break
                ancestor_value = math.fsum(tree['leaf_values'][int(train_routes[side][j, ti])] for j in example_indices) / len(example_indices)
                value = edited['oblivious_trees'][ti]['leaf_values'][leaf]
                assert abs(ancestor_value - value) < 1e-15
                visit = {'side': side, 'tree': ti, 'leaf': leaf, 'originalSupport': 0,
                    'originalValue': tree['leaf_values'][leaf], 'backoffValue': value,
                    'prefixLength': length, 'prefixBits': leaf & mask, 'ancestorSupport': len(example_indices),
                    'retainedConditions': [condition(s, b, leaf, names, x) for b, s in enumerate(tree['splits']) if b < length],
                    'discardedConditions': [condition(s, b, leaf, names, x) for b, s in enumerate(tree['splits']) if b >= length],
                    'intensityMultiplier': math.exp(value - tree['leaf_values'][leaf]),
                    'ancestorTrainingExamples': [{**{k: train[j][k] for k in ('matchId', 'competition', 'season', 'forecastAt', 'homeGoals', 'awayGoals')},
                        'leaf': int(train_routes[side][j, ti]), 'leafValue': tree['leaf_values'][int(train_routes[side][j, ti])],
                        'splitFeatures': {names[s['float_feature_index']]: features[train[j]['matchId']][s['float_feature_index']] for s in tree['splits']}}
                        for j in example_indices]}
                row['emptyVisits'].append(visit)
            assert abs(sum(v['backoffValue'] - v['originalValue'] for v in row['emptyVisits'] if v['side'] == side)
                       - row['inputDiagnostics'][side]['deltaLog']) < 1e-12
        row['metricDelta'] = {s: {k: metric(row, s, 'candidate')[k] - metric(row, s, 'incumbent')[k]
                                 for k in ('logLoss', 'brier')} for s in STAGES}
        partitions = {(a, b): helper.calibrate_partition(row['forecasts'][a]['raw'], profiles[b]) for a in artifacts for b in artifacts}
        for model in artifacts:
            max_profile_error = max(max_profile_error, max(abs(partitions[model, model][k] - row['forecasts'][model]['calibrated'][k]) for k in KEYS))
        row['calibrationAlgebraicAttribution'] = {'rawInput': {}, 'calibrationProfile': {}}
        actual = outcome(row)
        for key in ('logLoss', 'brier'):
            def loss(p):
                return -math.log(p[actual]) if key == 'logLoss' else sum((p[k] - int(k == actual)) ** 2 for k in KEYS)
            f00, f10, f01, f11 = [loss(partitions[pair]) for pair in [('incumbent', 'incumbent'), ('candidate', 'incumbent'), ('incumbent', 'candidate'), ('candidate', 'candidate')]]
            raw = ((f10 - f00) + (f11 - f01)) / 2
            profile = ((f01 - f00) + (f11 - f10)) / 2
            assert abs(raw + profile - row['metricDelta']['calibrated'][key]) < 1e-12
            row['calibrationAlgebraicAttribution']['rawInput'][key] = raw
            row['calibrationAlgebraicAttribution']['calibrationProfile'][key] = profile
    assert max_profile_error < 1e-12
    groups = {}
    for league in sorted(set(r['competition'] for r in rows)):
        subset = [r for r in rows if r['competition'] == league]
        groups[league] = {'all': helper.summarize(subset), 'byOutcome': {key: helper.summarize([r for r in subset if outcome(r) == key]) for key in KEYS},
            'byCohort': {cohort: helper.summarize([r for r in subset if (r['season'] == '2026/2027') == (cohort == 'current')]) for cohort in ('historical', 'current')},
            'emptyVisits': sum(len(r['emptyVisits']) for r in subset), 'rowsWithEmptyVisits': sum(bool(r['emptyVisits']) for r in subset)}
        for stage in STAGES:
            for model in artifacts:
                for key in ('logLoss', 'brier'):
                    assert abs(groups[league]['all']['stages'][stage][model][key] - comparison['summary']['byLeague'][league][stage][model][key]) < 1e-12
    ligue = [r for r in rows if r['competition'] == 'Ligue 1']
    raw_changed = [r for r in ligue if r['emptyVisits']]
    assert len(raw_changed) == 5
    report = {'diagnosticOnly': True, 'newCandidatesEvaluated': 0, 'modelsCompared': {m: a['version'] for m, a in artifacts.items()},
        'inputHashesVerifiedBeforeAndAfter': expected_hashes, 'rebuiltInputs': len(missing), 'allOriginalTrainingLeafSupportsReproduced': True,
        'maximumCalibrationDiagonalParityError': max_profile_error, 'byLeague': groups,
        'calibrationAttributionMethod': 'Exact two-factor telescoping averaged over both orders; crossed intermediate partitions are algebraic attribution only, not candidate evaluations.',
        'ligue1RawChangedMatchIds': [r['matchId'] for r in raw_changed],
        'ligue1RankedByDecisionLogLoss': [r['matchId'] for r in sorted(ligue, key=lambda r: r['metricDelta']['decision']['logLoss'], reverse=True)],
        'calibrationCurves': {m: profile['calibrationPoints'] for m, profile in profiles.items()},
        'limitations': ['Retrospective explanation of a previously scored candidate; no independent confirmation or new strategy selection.',
            'Prefix ancestors discard splits by their tree bit order, without a semantic-distance guarantee.',
            'Historical closing odds are diagnostic and not verified forecast-time captures.']}
    verify()
    output.mkdir(parents=True, exist_ok=False)
    for filename, value in [('summary.json', report), ('rows.json', rows), ('ligue1-empty-visits.json', raw_changed)]:
        with (output / filename).open('x', encoding='utf-8') as file:
            file.write(json.dumps(value, indent=2, allow_nan=False) + '\n')
    print(json.dumps({'output': str(output), 'rows': len(rows), 'ligue1EmptyVisitRows': len(raw_changed), 'pinnedInputs': len(expected_hashes)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path, help='Exclusive new diagnosis output directory.')
    run(parser.parse_args().out)
