"""Decompose the two already-scored sample-projection models; never fit a model."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import subprocess
from collections import Counter
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
COMPARISON = ROOT / 'backend/artifacts/research/c-tree-sample-projection-20261108/run/comparison.json'
DATASET = ROOT / 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json'
INCUMBENT = ROOT / 'backend/current-models/challenger.json'
CANDIDATE = COMPARISON.parent / 'candidate.json'
KEYS = ('homeWin', 'draw', 'awayWin')
STAGES = ('raw', 'calibrated', 'decision')


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_pinned_sources(comparison):
    for filename, expected in comparison['pinnedSourceHashes'].items():
        assert digest(ROOT / filename) == expected, f'Pinned source changed: {filename}'


def outcome(row):
    return 'homeWin' if row['homeGoals'] > row['awayGoals'] else 'awayWin' if row['homeGoals'] < row['awayGoals'] else 'draw'


def mean(values):
    return float(np.mean(values)) if len(values) else None


def metric(row, stage, model):
    p = row['forecasts'][model][stage]
    actual = outcome(row)
    return {'logLoss': -math.log(p[actual]), 'brier': sum((p[k] - int(k == actual)) ** 2 for k in KEYS)}


def summarize(rows):
    result = {'n': len(rows), 'outcomes': dict(Counter(outcome(r) for r in rows)), 'stages': {}}
    for stage in STAGES:
        metrics = {model: {key: mean([metric(r, stage, model)[key] for r in rows]) for key in ('logLoss', 'brier')}
                   for model in ('incumbent', 'candidate')}
        metrics['delta'] = {key: metrics['candidate'][key] - metrics['incumbent'][key] for key in ('logLoss', 'brier')} if rows else {}
        metrics['probabilities'] = {model: {k: mean([r['forecasts'][model][stage][k] for r in rows]) for k in KEYS}
                                   for model in ('incumbent', 'candidate')}
        metrics['brierDeltaByClass'] = {k: mean([(r['forecasts']['candidate'][stage][k] - int(outcome(r) == k)) ** 2
                                                - (r['forecasts']['incumbent'][stage][k] - int(outcome(r) == k)) ** 2 for r in rows]) for k in KEYS}
        metrics['trueOutcomeProbabilityDelta'] = mean([r['forecasts']['candidate'][stage][outcome(r)] - r['forecasts']['incumbent'][stage][outcome(r)] for r in rows])
        result['stages'][stage] = metrics
    if rows:
        result['lambda'] = {side: {key: mean([r['inputDiagnostics'][side][key] for r in rows])
                                   for key in ('incumbent', 'candidate', 'delta', 'deltaLog')} for side in ('home', 'away')}
        result['sample'] = {side: {'mean': mean([r['inputDiagnostics'][side]['sample'] for r in rows]),
                                  'outsideTrainingRange': sum(r['inputDiagnostics'][side]['outsideTrainingRange'] for r in rows),
                                  'quantiles': np.quantile([r['inputDiagnostics'][side]['sample'] for r in rows], [0, .25, .5, .75, 1]).tolist()}
                            for side in ('home', 'away')}
        result['calibrationAlgebraicAttribution'] = {factor: {key: mean([r['calibrationAlgebraicAttribution'][factor][key] for r in rows])
                                                             for key in ('logLoss', 'brier')}
                                                    for factor in ('rawInput', 'calibrationProfile')}
        result['rawDrawProbabilityRangeCounts'] = {model: sum(.27 <= r['forecasts'][model]['raw']['draw'] <= .32 for r in rows)
                                                   for model in ('incumbent', 'candidate')}
    return result


def predict(model, features):
    x = np.asarray(features, dtype=np.float32)
    mapping = {f['feature_index']: f['flat_feature_index'] for f in model['features_info']['float_features']}
    total = 0.
    for tree in model['oblivious_trees']:
        leaf = sum((1 << bit) for bit, split in enumerate(tree['splits']) if x[mapping[split['float_feature_index']]] > split['border'])
        total += tree['leaf_values'][leaf]
    return total * model['scale_and_bias'][0] + model['scale_and_bias'][1][0]


def calibrate_scalar(value, profile):
    points = profile['calibrationPoints']
    corrected = value
    for lo, hi in zip(points, points[1:]):
        if lo['x'] <= value <= hi['x']:
            t = (value - lo['x']) / (hi['x'] - lo['x']) if hi['x'] > lo['x'] else 0.
            corrected = lo['y'] + t * (hi['y'] - lo['y'])
            break
    n = max(0, profile['nObservations'])
    alpha = .9 if n < 200 else max(.1, 1 / (1 + n / 1000))
    return min(.99, max(.01, alpha * value + (1 - alpha) * corrected))


def calibrate_partition(values, profile):
    assert profile['byFamily']['goal_1x2']['points'] == profile['calibrationPoints']
    assert profile['byFamily']['goal_1x2']['nObservations'] == profile['nObservations']
    result = {k: calibrate_scalar(values[k], profile) for k in KEYS}
    total = sum(result.values())
    return {k: v / total for k, v in result.items()}


def main(output):
    output = output.resolve()
    if output.exists():
        raise FileExistsError(f'Diagnosis output already exists: {output}')
    comp, dataset = read(COMPARISON), read(DATASET)
    verify_pinned_sources(comp)
    fixed_inputs = (COMPARISON, DATASET, INCUMBENT, CANDIDATE, Path(__file__))
    initial_hashes = {p.relative_to(ROOT).as_posix(): digest(p) for p in fixed_inputs}
    artifacts = {'incumbent': read(INCUMBENT), 'candidate': read(CANDIDATE)}
    assert artifacts['incumbent']['version'] == comp['incumbentVersion']
    assert artifacts['candidate']['version'] == comp['candidateVersion']
    assert digest(CANDIDATE) == comp['candidateHash']
    for file in (INCUMBENT, DATASET):
        assert digest(file) == comp['pinnedSourceHashes'][file.relative_to(ROOT).as_posix()]
    rows = comp['rows']
    features = {r['matchId']: [r['features'][dataset['featureNames'].index(n)] for n in artifacts['incumbent']['featureNames']] for r in dataset['rows']}
    missing = [r['matchId'] for r in rows if r['matchId'] not in features]
    # Rebuild only existing inputs, using the same pure local functions as the scored comparison.
    source_files = ['backend/dist/research/ForecastCore.js', 'backend/dist/research/CatBoostModel.js']
    for file in source_files:
        assert digest(ROOT / file) == comp['pinnedSourceHashes'][file]
    node = r"""
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
    if missing:
        rebuilt = subprocess.run(['node', '-e', node], cwd=ROOT, input=json.dumps({'ids': missing,
            'history': 'backend/artifacts/research/current-c-real-odds-backtest-20261108/history.json',
            'names': artifacts['incumbent']['featureNames']}), capture_output=True, text=True, check=True)
        features.update(json.loads(rebuilt.stdout))
    names = artifacts['incumbent']['featureNames']
    interval = artifacts['incumbent']['trainingSplit']
    training_rows = [r for r in dataset['rows'] if interval['train']['from'] <= r['forecastAt'] <= interval['train']['to']
                     and r['availableAt'] < interval['selection']['from']]
    assert len(training_rows) == 5293
    training_maximum = {side: max(r['features'][dataset['featureNames'].index(side + '_sample')] for r in training_rows)
                        for side in ('home', 'away')}
    profiles = {model: a['calibrationProfilesV2']['C'] for model, a in artifacts.items()}
    maximum_calibration_parity_error = 0.
    for r in rows:
        x = features[r['matchId']]
        r['inputDiagnostics'] = {}
        for side in ('home', 'away'):
            raw = {model: predict(a['models'][side], x) for model, a in artifacts.items()}
            rates = {model: min(8., max(.05, math.exp(value))) for model, value in raw.items()}
            r['inputDiagnostics'][side] = {**rates, 'delta': rates['candidate'] - rates['incumbent'],
                'deltaLog': raw['candidate'] - raw['incumbent'], 'sample': x[names.index(side + '_sample')],
                'outsideTrainingRange': x[names.index(side + '_sample')] > training_maximum[side]}
        r['metricDelta'] = {s: {k: metric(r, s, 'candidate')[k] - metric(r, s, 'incumbent')[k]
                               for k in ('logLoss', 'brier')} for s in STAGES}
        # Exact two-factor telescoping attribution, averaged over both factor orders.
        # Mixed intermediate partitions are algebra only, never new candidate evaluations.
        partitions = {(raw_model, profile_model): calibrate_partition(r['forecasts'][raw_model]['raw'], profiles[profile_model])
                      for raw_model in artifacts for profile_model in artifacts}
        for model in artifacts:
            maximum_calibration_parity_error = max(maximum_calibration_parity_error,
                max(abs(partitions[model, model][k] - r['forecasts'][model]['calibrated'][k]) for k in KEYS))
        r['calibrationAlgebraicAttribution'] = {'rawInput': {}, 'calibrationProfile': {}}
        actual = outcome(r)
        for key in ('logLoss', 'brier'):
            def loss(p):
                return -math.log(p[actual]) if key == 'logLoss' else sum((p[k] - int(k == actual)) ** 2 for k in KEYS)
            f00 = loss(partitions['incumbent', 'incumbent'])
            f10 = loss(partitions['candidate', 'incumbent'])
            f01 = loss(partitions['incumbent', 'candidate'])
            f11 = loss(partitions['candidate', 'candidate'])
            raw_part = ((f10 - f00) + (f11 - f01)) / 2
            profile_part = ((f01 - f00) + (f11 - f10)) / 2
            assert abs(raw_part + profile_part - r['metricDelta']['calibrated'][key]) < 1e-12
            r['calibrationAlgebraicAttribution']['rawInput'][key] = raw_part
            r['calibrationAlgebraicAttribution']['calibrationProfile'][key] = profile_part
    assert maximum_calibration_parity_error < 1e-12
    groups = {'all': summarize(rows), 'byLeague': {}}
    for league in sorted(set(r['competition'] for r in rows)):
        rs = [r for r in rows if r['competition'] == league]
        grouped = {'all': summarize(rs), 'byOutcome': {}, 'byCohort': {}}
        for key in KEYS:
            grouped['byOutcome'][key] = summarize([r for r in rs if outcome(r) == key])
        for cohort in ('historical', 'current'):
            subset = [r for r in rs if (r['season'] == '2026/2027') == (cohort == 'current')]
            grouped['byCohort'][cohort] = {'all': summarize(subset), 'byOutcome': {
                key: summarize([r for r in subset if outcome(r) == key]) for key in KEYS}}
        groups['byLeague'][league] = grouped
        for stage in STAGES:
            for model in ('candidate', 'incumbent'):
                for key in ('logLoss', 'brier'):
                    assert abs(grouped['all']['stages'][stage][model][key] - comp['summary']['byLeague'][league][stage][model][key]) < 1e-12
    la_liga = [r for r in rows if r['competition'] == 'La Liga']
    contributors = {}
    for stage in STAGES:
        ranked = sorted(la_liga, key=lambda r: r['metricDelta'][stage]['logLoss'], reverse=True)
        deltas = [r['metricDelta'][stage]['logLoss'] for r in ranked]
        contributors[stage] = {'positiveCount': sum(v > 0 for v in deltas), 'negativeCount': sum(v < 0 for v in deltas),
            'positiveSum': sum(max(0, v) for v in deltas), 'negativeSum': sum(min(0, v) for v in deltas),
            'topFivePositiveSum': sum(deltas[:5]), 'topTenPositiveSum': sum(deltas[:10]),
            'worstMatchIds': [r['matchId'] for r in ranked[:10]], 'bestMatchIds': [r['matchId'] for r in ranked[-10:][::-1]]}
    report = {'diagnosticOnly': True, 'newCandidatesEvaluated': 0, 'modelsCompared': {k: a['version'] for k, a in artifacts.items()},
        'inputHashes': initial_hashes,
        'pinnedSourceVerification': {'before': True, 'after': True, 'count': len(comp['pinnedSourceHashes']),
            'hashes': comp['pinnedSourceHashes']},
        'inputReconstruction': {'datasetRows': len(rows) - len(missing), 'rebuiltRows': len(missing)},
        'trainingSampleMaximum': training_maximum,
        'groups': groups, 'laLigaContributors': contributors,
        'calibrationAlgebraicAttribution': {'method': 'Exact two-factor telescoping attribution, averaged over both factor orders; mixed intermediate partitions are mathematical attribution only, not candidate evaluations.',
            'maximumDiagonalProbabilityParityError': maximum_calibration_parity_error,
            'scalarCurveBefore1X2Normalization': [{'rawProbability': value,
                **{model: calibrate_scalar(value, profile) for model, profile in profiles.items()}}
                for value in (.2, .25, .27, .28, .29, .3, .31, .32, .34)]},
        'calibrationProfiles': {k: a['calibrationProfilesV2']['C'] for k, a in artifacts.items()},
        'limitations': ['Retrospective decomposition of the already-scored candidate; no new hypothesis validation.',
            'Changing input and refitting calibration jointly prevents causal attribution to either alone.',
            'Closing odds are historical diagnostic evidence, not a verified forecast-time capture.']}
    verify_pinned_sources(comp)
    assert {p.relative_to(ROOT).as_posix(): digest(p) for p in fixed_inputs} == initial_hashes, 'Diagnosis input changed during the run'
    output.mkdir(parents=True, exist_ok=False)
    with (output / 'summary.json').open('x', encoding='utf-8') as file:
        file.write(json.dumps(report, indent=2, allow_nan=False) + '\n')
    with (output / 'rows.json').open('x', encoding='utf-8') as file:
        file.write(json.dumps(rows, indent=2, allow_nan=False) + '\n')
    print(json.dumps({'rows': len(rows), 'laLiga': len(la_liga), 'rebuiltInputs': len(missing), 'summary': str(output / 'summary.json')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path, help='New exclusive output directory; an existing path is rejected.')
    main(parser.parse_args().out)
