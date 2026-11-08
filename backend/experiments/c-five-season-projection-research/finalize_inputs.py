"""Exclude two documented archive date conflicts before any feature calculation."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

CONFLICTS = {
    'understat_17955': {'archiveDate': '2022-02-02', 'csvFixtureDate': '2022-02-01',
                       'fixture': 'Lyon - Marseille', 'competition': 'Ligue 1'},
    'understat_17503': {'archiveDate': '2022-05-15', 'csvFixtureDate': '2022-05-14',
                       'fixture': 'Espanyol - Valencia', 'competition': 'La Liga'},
}


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def finalize(source, output):
    source, output = Path(source).resolve(), Path(output).resolve()
    history = json.loads((source / 'history.json').read_bytes())
    quotes = json.loads((source / 'quotes.json').read_bytes())
    by_id = {row['matchId']: row for row in history}
    assert len(by_id) == len(history)
    for match_id, evidence in CONFLICTS.items():
        row = by_id[match_id]
        assert row['competition'] == evidence['competition']
        assert row['date'].startswith(evidence['archiveDate'])
    retained = [row for row in history if row['matchId'] not in CONFLICTS]
    assert len(retained) == len(history) - 2
    filtered_quotes = {**quotes, 'rows': [row for row in quotes['rows'] if row['matchId'] not in CONFLICTS]}
    assert {row['matchId'] for row in filtered_quotes['rows']} <= {row['matchId'] for row in retained}
    receipt = {'createdAt': datetime.now(timezone.utc).isoformat(), 'sourceDirectory': str(source),
               'scriptHash': digest(Path(__file__)),
               'inputHashes': {name: digest(source / name) for name in ['history.json', 'quotes.json', 'input-audit.json']},
               'exclusions': [{'matchId': match_id, **evidence,
                               'reason': 'Conflicting calendar date across archived Understat and football-data fixture; neither date silently repaired.',
                               'excludedFromHistoryAndTargets': True} for match_id, evidence in CONFLICTS.items()],
               'historyRowsBefore': len(history), 'historyRowsAfter': len(retained),
               'quotesBefore': len(quotes['rows']), 'quotesAfter': len(filtered_quotes['rows']),
               'retainedCoverage': dict(Counter(f"{row['competition']}|{row['season']}" for row in retained)),
               'runtimeQuarantinePolicyChanged': False, 'modelOutcomesUsedForExclusions': False}
    output.mkdir(parents=False, exist_ok=False)
    for name, value in [('history.json', retained), ('quotes.json', filtered_quotes), ('source-exclusions.json', receipt)]:
        with (output / name).open('x', encoding='utf-8') as handle:
            json.dump(value, handle, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            handle.write('\n')
    return {'history': len(retained), 'quotes': len(filtered_quotes['rows']), 'excluded': list(CONFLICTS),
            'hashes': {name: digest(output / name) for name in ['history.json', 'quotes.json', 'source-exclusions.json']}}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(finalize(args.input, args.out)))
