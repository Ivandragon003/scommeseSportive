"""Explain the already-scored Hamming backoff; no new model or scoring variant."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
HELPER = ROOT / 'backend/experiments/c-tree-neighbor-backoff/diagnose.py'
HELPER_HASH = '753fafe9c02220bd6682ab75261a763487c57bd435b326d77b11c54764d14ebe'
COMPARISON = ROOT / 'backend/artifacts/research/c-tree-neighbor-backoff-20261108/run/comparison.json'
CANDIDATE = COMPARISON.parent / 'candidate.json'
PREFIX = ROOT / 'backend/artifacts/research/c-tree-empty-leaf-backoff-20261108/run/candidate.json'
INCUMBENT = ROOT / 'backend/current-models/challenger.json'
DATASET = ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json'
HISTORY = ROOT / 'backend/artifacts/research/current-c-real-odds-backtest-20261108/history.json'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


assert digest(HELPER) == HELPER_HASH
SPEC = importlib.util.spec_from_file_location('frozen_empty_leaf_diagnosis', HELPER)
old = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(old)
shared = old.helper
read, metric, outcome = shared.read, shared.metric, shared.outcome
KEYS, STAGES = shared.KEYS, shared.STAGES


def run(output):
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f'Diagnosis output already exists: {output}')
    comparison = read(COMPARISON)
    hashes = dict(comparison['pinnedSourceHashes'])
    for path in (COMPARISON, CANDIDATE, PREFIX, INCUMBENT, DATASET, HISTORY, HELPER, old.HELPER, Path(__file__)):
        hashes.setdefault(path.relative_to(ROOT).as_posix(), digest(path))
    hashes[CANDIDATE.relative_to(ROOT).as_posix()] = comparison['candidateHash']

    def verify():
        for key, expected in hashes.items():
            assert digest(ROOT / key) == expected, f'Pinned input changed: {key}'

    verify()
    artifacts = {'incumbent': read(INCUMBENT), 'candidate': read(CANDIDATE)}
    assert artifacts['candidate']['version'] == comparison['candidateVersion'] == 'C-0a1eeb68738afaa7'
    assert artifacts['incumbent']['version'] == comparison['incumbentVersion'] == 'C-75fd74eb875e9d0e'
    prefix, dataset, history = read(PREFIX), read(DATASET), read(HISTORY)
    history_by_id = {r['matchId']: r for r in history}
    names = artifacts['incumbent']['featureNames']
    indices = [dataset['featureNames'].index(n) for n in names]
    features = {r['matchId']: [r['features'][i] for i in indices] for r in dataset['rows']}
    rows = comparison['rows']
    missing = [r['matchId'] for r in rows if r['matchId'] not in features]
    features.update(old.rebuild_missing(missing, names))
    split = artifacts['incumbent']['trainingSplit']
    training = [r for r in dataset['rows'] if split['train']['from'] <= r['forecastAt'] <= split['train']['to']
                and r['availableAt'] < split['selection']['from']]
    assert len(training) == 5293
    assert hashlib.sha256('\n'.join(sorted(r['matchId'] for r in training)).encode()).hexdigest() == split['train']['matchIdsHash']
    x_train = np.asarray([features[r['matchId']] for r in training], dtype=np.float32)
    x_rows = np.asarray([features[r['matchId']] for r in rows], dtype=np.float32)
    training_routes, diagnostic_routes = {}, {}
    for side in ('home', 'away'):
        original = artifacts['incumbent']['models'][side]
        assert all(f['feature_index'] == f['flat_feature_index'] for f in original['features_info']['float_features'])
        training_routes[side], diagnostic_routes[side] = old.routes(original, x_train), old.routes(original, x_rows)
        for ti, tree in enumerate(original['oblivious_trees']):
            assert np.array_equal(np.bincount(training_routes[side][:, ti], minlength=len(tree['leaf_values'])), tree['leaf_weights'])
    profiles = {m: a['calibrationProfilesV2']['C'] for m, a in artifacts.items()}
    unique_leaves = {}
    maximum_profile_error = 0.
    for ri, row in enumerate(rows):
        x = features[row['matchId']]
        row['inputDiagnostics'], row['emptyVisits'] = {}, []
        match = history_by_id.get(row['matchId'], {})
        row['teams'] = {k: match.get(k) for k in ('homeTeamId', 'awayTeamId')}
        for side in ('home', 'away'):
            logs = {m: shared.predict(a['models'][side], x) for m, a in artifacts.items()}
            rates = {m: min(8., max(.05, math.exp(v))) for m, v in logs.items()}
            si = names.index(side + '_sample')
            row['inputDiagnostics'][side] = {**rates, 'delta': rates['candidate'] - rates['incumbent'],
                'deltaLog': logs['candidate'] - logs['incumbent'], 'sample': x[si],
                'outsideTrainingRange': x[si] > float(x_train[:, si].max())}
            for ti, tree in enumerate(artifacts['incumbent']['models'][side]['oblivious_trees']):
                leaf = int(diagnostic_routes[side][ri, ti])
                edited_value = artifacts['candidate']['models'][side]['oblivious_trees'][ti]['leaf_values'][leaf]
                if tree['leaf_weights'][leaf] > 0:
                    assert edited_value == tree['leaf_values'][leaf]
                    continue
                key = f'{side}:{ti}:{leaf}'
                if key not in unique_leaves:
                    supported = [j for j, support in enumerate(tree['leaf_weights']) if support > 0]
                    distance = min((leaf ^ j).bit_count() for j in supported)
                    donors = [j for j in supported if (leaf ^ j).bit_count() == distance]
                    support = sum(tree['leaf_weights'][j] for j in donors)
                    expected = math.fsum(tree['leaf_values'][j] * tree['leaf_weights'][j] for j in donors) / support
                    assert abs(expected - edited_value) < 1e-15
                    donor_rows = np.flatnonzero(np.isin(training_routes[side][:, ti], donors))
                    donor_examples = []
                    for j in donor_rows:
                        example = training[j]
                        routed = int(training_routes[side][j, ti])
                        donor_examples.append({**{k: example[k] for k in ('matchId', 'competition', 'season', 'forecastAt', 'homeGoals', 'awayGoals')},
                            'teams': {k: history_by_id.get(example['matchId'], {}).get(k) for k in ('homeTeamId', 'awayTeamId')},
                            'leaf': routed, 'leafValue': tree['leaf_values'][routed],
                            'splitFeatures': {names[s['float_feature_index']]: features[example['matchId']][s['float_feature_index']] for s in tree['splits']}})
                    unique_leaves[key] = {'side': side, 'tree': ti, 'leaf': leaf, 'originalSupport': 0, 'originalValue': tree['leaf_values'][leaf],
                        'prefixValue': prefix['models'][side]['oblivious_trees'][ti]['leaf_values'][leaf], 'hammingValue': edited_value,
                        'minimumHammingDistance': distance, 'donorSupport': support,
                        'donorLeaves': [{'leaf': j, 'support': tree['leaf_weights'][j], 'value': tree['leaf_values'][j],
                            'changedBits': [b for b in range(len(tree['splits'])) if (leaf ^ j) & (1 << b)],
                            'changedFeatures': [names[s['float_feature_index']] for b, s in enumerate(tree['splits']) if (leaf ^ j) & (1 << b)]}
                            for j in donors], 'trainingExamples': donor_examples, 'affectedMatchIds': []}
                unique_leaves[key]['affectedMatchIds'].append(row['matchId'])
                row['emptyVisits'].append({'key': key, 'side': side, 'tree': ti, 'leaf': leaf,
                    'deltaLog': edited_value - tree['leaf_values'][leaf], 'intensityMultiplier': math.exp(edited_value - tree['leaf_values'][leaf]),
                    'targetConditions': [old.condition(s, b, leaf, names, x) for b, s in enumerate(tree['splits'])]})
            assert abs(sum(v['deltaLog'] for v in row['emptyVisits'] if v['side'] == side) - row['inputDiagnostics'][side]['deltaLog']) < 1e-12
        row['metricDelta'] = {s: {k: metric(row, s, 'candidate')[k] - metric(row, s, 'incumbent')[k]
                                  for k in ('logLoss', 'brier')} for s in STAGES}
        partitions = {(a, b): shared.calibrate_partition(row['forecasts'][a]['raw'], profiles[b]) for a in artifacts for b in artifacts}
        for model in artifacts:
            maximum_profile_error = max(maximum_profile_error, max(abs(partitions[model, model][k] - row['forecasts'][model]['calibrated'][k]) for k in KEYS))
        row['calibrationAlgebraicAttribution'] = {'rawInput': {}, 'calibrationProfile': {}}
        actual = outcome(row)
        for metric_name in ('logLoss', 'brier'):
            def loss(p):
                return -math.log(p[actual]) if metric_name == 'logLoss' else sum((p[k] - int(k == actual)) ** 2 for k in KEYS)
            f00, f10, f01, f11 = [loss(partitions[p]) for p in [('incumbent', 'incumbent'), ('candidate', 'incumbent'), ('incumbent', 'candidate'), ('candidate', 'candidate')]]
            raw = ((f10 - f00) + (f11 - f01)) / 2
            profile = ((f01 - f00) + (f11 - f10)) / 2
            assert abs(raw + profile - row['metricDelta']['calibrated'][metric_name]) < 1e-12
            row['calibrationAlgebraicAttribution']['rawInput'][metric_name] = raw
            row['calibrationAlgebraicAttribution']['calibrationProfile'][metric_name] = profile
    assert maximum_profile_error < 1e-12
    groups = {}
    for league in sorted(set(r['competition'] for r in rows)):
        subset = [r for r in rows if r['competition'] == league]
        groups[league] = {'all': shared.summarize(subset), 'byOutcome': {k: shared.summarize([r for r in subset if outcome(r) == k]) for k in KEYS},
            'byCohort': {c: shared.summarize([r for r in subset if (r['season'] == '2026/2027') == (c == 'current')]) for c in ('historical', 'current')},
            'affectedRows': sum(bool(r['emptyVisits']) for r in subset), 'emptyVisits': sum(len(r['emptyVisits']) for r in subset),
            'worstRawMatchIds': [r['matchId'] for r in sorted(subset, key=lambda r: r['metricDelta']['raw']['logLoss'], reverse=True)[:10]],
            'worstDecisionMatchIds': [r['matchId'] for r in sorted(subset, key=lambda r: r['metricDelta']['decision']['logLoss'], reverse=True)[:10]]}
        for stage in STAGES:
            for model in artifacts:
                for k in ('logLoss', 'brier'):
                    assert abs(groups[league]['all']['stages'][stage][model][k] - comparison['summary']['byLeague'][league][stage][model][k]) < 1e-12
    report = {'diagnosticOnly': True, 'newCandidatesEvaluated': 0, 'modelsCompared': {m: a['version'] for m, a in artifacts.items()},
        'inputHashesVerifiedBeforeAndAfter': hashes, 'allTrainingLeafSupportsReproduced': True, 'rebuiltInputs': len(missing),
        'maximumCalibrationDiagonalParityError': maximum_profile_error, 'byLeague': groups,
        'calibrationAttribution': 'Exact two-factor telescoping averaged over both orders; crossed partitions are mathematical attribution only.',
        'uniqueEmptyLeavesVisited': len(unique_leaves),
        'limitations': ['Diagnostic cohorts already inspected repeatedly; no independent evidence or future-benefit guarantee.',
            'Hamming distance treats threshold bits equally; it is not distance in the original numerical feature space.',
            'Training support weights need not measure the uncertainty or transportability of a learned leaf value.',
            'No league-specific exception or replacement candidate is selected by this diagnosis.']}
    verify()
    output.mkdir(parents=True, exist_ok=False)
    for filename, value in [('summary.json', report), ('rows.json', rows), ('leaf-donors.json', unique_leaves)]:
        with (output / filename).open('x', encoding='utf-8') as file:
            file.write(json.dumps(value, indent=2, allow_nan=False) + '\n')
    print(json.dumps({'output': str(output), 'rows': len(rows), 'uniqueEmptyLeavesVisited': len(unique_leaves), 'pinnedInputs': len(hashes)}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path, help='Exclusive new diagnosis output directory.')
    run(parser.parse_args().out)
