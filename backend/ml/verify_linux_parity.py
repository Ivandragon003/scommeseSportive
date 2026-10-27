"""Offline native CatBoost parity; no network, training, database or betting writes."""
import argparse
import json
import resource
import tempfile
import time
from pathlib import Path

import catboost
import numpy as np
from catboost import CatBoostClassifier, CatBoostRegressor

parser = argparse.ArgumentParser()
parser.add_argument('--parity', required=True)
args = parser.parse_args()
started = time.perf_counter()
parity = json.loads(Path(args.parity).read_text(encoding='utf-8'))
features = np.array([row['features'] for row in parity['rows']], dtype=float)
maximum = 0.0
comparisons = 0
with tempfile.TemporaryDirectory(prefix='footpredictor-native-parity-') as directory:
    for kind, bundle in parity['candidateModels'].items():
        for name, exported in bundle.items():
            path = Path(directory) / f'{kind}-{name}.json'
            path.write_text(json.dumps(exported), encoding='utf-8')
            model = CatBoostClassifier() if name == 'probability' else CatBoostRegressor()
            model.load_model(str(path), format='json')
            actual = np.asarray(model.predict(features, prediction_type='RawFormulaVal', thread_count=1)).reshape(len(features), -1)
            expected = np.array([row['rawByCandidate'][kind][name] for row in parity['rows']])
            error = float(np.max(np.abs(actual - expected)))
            maximum = max(maximum, error)
            comparisons += actual.size
            if error >= 1e-9:
                raise AssertionError(f'native_catboost_parity_failed:{kind}:{name}:{error}')
usage = resource.getrusage(resource.RUSAGE_SELF)
print(json.dumps({'platform': 'Linux native CatBoost verification only; not production Python dependency',
                  'catboost': catboost.__version__, 'numpy': np.__version__, 'comparisons': comparisons,
                  'maxAbsoluteError': maximum, 'wallMs': (time.perf_counter() - started) * 1000,
                  'cpuUserMs': usage.ru_utime * 1000, 'cpuSystemMs': usage.ru_stime * 1000,
                  'maxRssMiB': usage.ru_maxrss / 1024}, indent=2))
