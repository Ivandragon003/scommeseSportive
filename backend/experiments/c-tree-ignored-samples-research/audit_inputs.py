"""Describe cumulative-count inputs and original splits without scoring outcomes."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

import numpy as np

HELPER = Path(__file__).resolve().parents[1] / 'c-tree-l2-research/prepare.py'
SPEC = importlib.util.spec_from_file_location('ignored_input_helpers', HELPER)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
shared = helper.shared


def audit(plan_path: Path):
    plan = json.loads(plan_path.read_bytes())
    for relative, expected in plan['sourceHashes'].items():
        assert shared.digest(shared.ROOT / relative) == expected, relative
    incumbent = json.loads((shared.ROOT / shared.INCUMBENT).read_bytes())
    dataset = json.loads((shared.ROOT / shared.DATASET).read_bytes())
    frozen = {'folds': [{'fold': incumbent['frozenFold'], 'trainingSplit': plan['trainingSplit']}]}
    names, groups, *_ = shared.current.prepare_dataset(dataset, frozen, shared.current.current_manifest())
    ignored = plan['intervention']['ignoredFeatures']
    indices = [names.index(name) for name in ignored]
    assert indices == plan['intervention']['ignoredFlatIndices'] == [1, 17]

    def describe(rows):
        values = np.asarray([row['features'] for row in rows], dtype=float)[:, indices]
        return {'n': len(rows), 'counts': {
            name: {'minimum': float(values[:, i].min()), 'median': float(np.median(values[:, i])),
                   'maximum': float(values[:, i].max())}
            for i, name in enumerate(ignored)}}

    partitions = {}
    for label, rows in zip(('training', 'selection'), groups[:2]):
        partitions[label] = describe(rows)
        partitions[label]['membership'] = helper.membership(rows)
        partitions[label]['bySeason'] = {
            str(season): describe([row for row in rows if row.get('season') == season])
            for season in sorted({row.get('season') for row in rows}, key=str)}
        partitions[label]['byLeague'] = {
            league: describe([row for row in rows if row['competition'] == league])
            for league in sorted({row['competition'] for row in rows})}

    splits = {}
    for side, model in incumbent['models'].items():
        feature_map = {feature['feature_index']: feature for feature in model['features_info']['float_features']}
        counts = dict.fromkeys(ignored, 0)
        affected = total = 0
        for tree in model['oblivious_trees']:
            tree_affected = False
            for split in tree['splits']:
                feature = feature_map[split['float_feature_index']]
                total += 1
                if feature['flat_feature_index'] in indices:
                    counts[names[feature['flat_feature_index']]] += 1
                    tree_affected = True
            affected += int(tree_affected)
        splits[side] = {'trees': len(model['oblivious_trees']), 'allSplits': total,
                        'countSplits': counts, 'treesWithCountSplit': affected}
    return {'createdAt': helper.now(), 'planHash': shared.digest(plan_path),
            'scriptHash': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'sourceHashes': plan['sourceHashes'], 'partitions': partitions, 'originalSplits': splits,
            'outcomesScored': False, 'calibrationAndDiagnosticRowsSummarized': False,
            'interpretation': 'Counts summarize all eligible prior team matches. Their association with archive age is descriptive, not proof of harmful leakage or causal feature importance. Removal may discard useful reliability information.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    result = audit(args.plan)
    with args.out.open('x', encoding='utf-8') as output:
        json.dump(result, output, ensure_ascii=False, allow_nan=False, indent=2)
        output.write('\n')
    print(json.dumps({'output': str(args.out), 'sha256': shared.digest(args.out),
                      'originalSplits': result['originalSplits']}))
