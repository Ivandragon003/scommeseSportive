"""Freeze calendar memberships from dataset metadata before any CatBoost fitting."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SPEC = importlib.util.spec_from_file_location('annual_projection_execution_training', HERE / 'train.py')
training = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(training)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def freeze(inputs_plan, dataset_file, quotes_file, output):
    inputs_plan, dataset_file, quotes_file, output = map(lambda p: Path(p).resolve(),
                                                       (inputs_plan, dataset_file, quotes_file, output))
    initial = json.loads(inputs_plan.read_bytes())
    dataset = json.loads(dataset_file.read_bytes())
    assert initial['phase'] == 'input_reconstruction'
    assert dataset['reproduction']['planHash'] == digest(inputs_plan)
    for relative, expected in initial['sourceHashes'].items():
        assert digest(ROOT / relative) == expected, relative
    sources = dict(initial['sourceHashes'])
    helpers = [HERE.parent / 'c-tree-sample-projection' / name for name in ['prepare.py', 'evaluate.cjs', 'verify.py']]
    helpers += [HERE.parent / folder / name for folder, name in [
        ('c-tree-l2-research', 'prepare.py'), ('c-tree-l2-research', 'verify_selection.py'),
        ('c-tree-weight-research', 'verify.py'), ('c-tree-weight-research', 'verify_selection.py'),
        ('c-tree-hierarchical-research', 'verify_selection.py'),
        ('c-tree-ignored-samples-research', 'verify_selection.py'), ('c-tree-newton-one-research', 'verify.py'),
        ('c-parameter-audit', 'metrics.cjs')]]
    helpers += [ROOT / 'backend/ml' / name for name in ['train.py', 'prepare_current_challenger.py']]
    population_file = inputs_plan.parent / 'population-audit.json'
    population = json.loads(population_file.read_bytes())
    files = [inputs_plan, dataset_file, quotes_file, population_file, *helpers]
    files += [file for file in HERE.iterdir() if file.suffix in ['.py', '.cjs']]
    for file in files:
        sources[file.relative_to(ROOT).as_posix()] = digest(file)
    plan = {**initial, 'phase': 'execution', 'createdAt': datetime.now(timezone.utc).isoformat(),
            'inputsPlanHash': digest(inputs_plan), 'datasetHash': digest(dataset_file),
            'quotesHash': digest(quotes_file), 'sourceHashes': sources,
            'recipe': training.RECIPE, 'l2LeafReg': 3., 'baselineManifest': dataset['baselineManifest'],
            'studyExcludedMatchIds': ['understat_17955', 'understat_17503'],
            'metrics': {'primary': ['1X2 Log Loss', 'multiclass Brier sum'],
                        'secondary': ['top-label ECE10 equal-width bins'],
                        'bootstrap': {'unit': 'season and UTC epoch week', 'replications': 2000, 'seed': 20261108}},
            'folds': [], 'newRegressorFits': 10, 'projectedRegressorFits': 0,
            'modelSelection': False, 'productionAdoptionEligible': False, 'databaseWrites': 0}
    _, rows, _, _ = training.checked_dataset(dataset, plan)
    test_ids = set()
    for year in training.YEARS:
        groups, memberships, purged = training.partition_rows(rows, year)
        identifiers = {row['matchId'] for row in groups['test']}
        assert not identifiers.intersection(test_ids)
        test_ids.update(identifiers)
        plan['folds'].append({'year': year, 'boundaries': training.boundaries(year),
                              'memberships': {part: {key: value for key, value in data.items() if key != 'matchIds'}
                                              for part, data in memberships.items()}, 'purgedMatchIds': purged})
    assert not test_ids.intersection(plan['studyExcludedMatchIds'])
    assert len(test_ids) == population['eligibleTestRowsExpected']
    assert hashlib.sha256('\n'.join(sorted(test_ids)).encode()).hexdigest() == population['expectedTestIdsHash']
    quotes = json.loads(quotes_file.read_bytes())['rows']
    assert len(test_ids.intersection(row['matchId'] for row in quotes)) == population['realClosingQuotedRowsExpected']
    plan['expectedTestPopulation'] = {key: value for key, value in population.items() if key != 'rows'}
    training.checked_plan(plan, dataset_file, digest(dataset_file))
    training.checked_folds(rows, plan)
    with output.open('x', encoding='utf-8') as handle:
        json.dump(plan, handle, ensure_ascii=False, indent=2, allow_nan=False)
        handle.write('\n')
    return {'planHash': digest(output), 'sources': len(sources), 'datasetRows': len(rows),
            'folds': [{'year': fold['year'], 'counts': {key: value['n'] for key, value in fold['memberships'].items()}}
                      for fold in plan['folds']]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['inputs-plan', 'dataset', 'quotes', 'out']:
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(freeze(args.inputs_plan, args.dataset, args.quotes, args.out)))
