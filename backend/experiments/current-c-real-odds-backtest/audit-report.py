"""Independent checks of the replay results against frozen CSV rows."""
import argparse
import collections
import csv
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    if args.out.exists():
        raise ValueError('New audit output required')
    report = read(args.report)
    quotes = read(args.report.parent / 'quotes.json')
    by_match = {row['matchId']: row for row in quotes['rows']}
    assert len(by_match) == len(quotes['rows']) == report['coverage']['matches']
    assert len({row['matchId'] for row in report['rows']}) == len(by_match)
    assert set(by_match) == {row['matchId'] for row in report['rows']}
    source_rows = {}
    for source in quotes['sources']:
        file = ROOT / source['file']
        assert hashlib.sha256(file.read_bytes()).hexdigest() == source['sha256']
        with file.open(encoding='utf-8-sig', newline='') as stream:
            source_rows[source['sha256']] = list(csv.DictReader(stream))
    counts = collections.Counter()
    groups = collections.defaultdict(collections.Counter)
    semantic = set()
    for bet in report['bets']:
        record = by_match[bet['matchId']]
        source = source_rows[bet['sourceSha256']][bet['csvRowNumber'] - 2]
        assert (int(source['FTHG']), int(source['FTAG'])) == tuple(bet['goals'])
        quote = bet['quote']
        assert quote['source'] == 'football_data_csv' and quote['bookmaker'] == 'Bet365'
        assert quote['priceType'] == 'closing' and quote['timestampEvidence'] == 'observed_snapshot'
        assert quote['capturedAt'] == record['archiveAcquiredAt'] and 'updatedAt' not in quote
        if quote['market'] == '1x2':
            column = {'home': 'B365CH', 'draw': 'B365CD', 'away': 'B365CA'}[quote['side']]
            difference = bet['goals'][0] - bet['goals'][1]
            win = {'home': difference > 0, 'draw': difference == 0, 'away': difference < 0}[quote['side']]
            status = 'WON' if win else 'LOST'
        elif quote['market'] == 'totals':
            assert quote['line'] == 2.5
            column = 'B365C>2.5' if quote['side'] == 'over' else 'B365C<2.5'
            total = sum(bet['goals'])
            win = total > 2.5 if quote['side'] == 'over' else total < 2.5
            status = 'WON' if win else 'LOST'
        else:
            raise AssertionError('An unexpected selected market requires an independent settlement audit')
        assert float(source[column]) == quote['odds']
        assert status == bet['status']
        assert bet['returnMultiplier'] == (quote['odds'] if status == 'WON' else 0)
        key = bet['matchId'], quote['market'], quote['side'], quote.get('line'), quote.get('team')
        assert key not in semantic
        semantic.add(key)
        counts[status] += 1
        groups[(quote['market'], quote['side'], quote.get('line'))][status] += 1
    assert dict(counts) == report['statusCounts']
    for row in report['ranking']:
        group = groups[(row['market'], row['side'], row['line'])]
        assert row['LOST'] == group['LOST'] and row['WON'] == group['WON']
        assert row['total'] == sum(group.values())
    assert report['coverage']['selectedBets'] == len(semantic)
    assert all(row['strictOperationalEligible'] is False for row in report['rows'])
    assert report['coverage']['abstentions'] == sum(not row['bets'] for row in report['rows'])
    assert all(report['selectorAdapter']['buildParity'].values())
    result = {'reportSha256': hashlib.sha256(args.report.read_bytes()).hexdigest(), 'sourceCsvFilesVerified': len(source_rows),
              'matches': len(by_match), 'uniqueSelections': len(semantic), 'independentCsvResultAndPriceChecks': len(semantic),
              'statuses': dict(counts), 'allPassed': True, 'databaseWrites': 0}
    with args.out.open('x', encoding='utf-8') as stream:
        json.dump(result, stream, indent=2)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
