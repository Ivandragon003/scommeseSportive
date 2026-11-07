#!/usr/bin/env python3
"""Read-only evidence report for the historical high-goal-line mapping defect.

Input must be a verified, stable local SQLite backup. Nothing is written to it;
JSON on stdout is a proposed overlay for review, never an applied correction.
"""
import argparse
import hashlib
import json
import math
import re
import sqlite3
from pathlib import Path

PATTERN = re.compile(r'^shots_total_(over|under)_(\d+(?:\.\d+)?)$')
STAT_CONTEXT = re.compile(r'\b(shots?|target|sot|corners?|fouls?|yellow|cards?|bookings?)\b', re.I)


def obj(value):
    try:
        result = json.loads(value or '{}')
        return result if isinstance(result, dict) else {}
    except (ValueError, TypeError):
        return {}


def inspect(snapshot, cache_rows):
    if snapshot['source'] != 'odds_api' or snapshot['used_synthetic_odds'] != 0:
        return [], 'source_not_verified'
    if not all(snapshot[k] for k in ('snapshot_id', 'odds_provider_match_id', 'captured_at', 'selected_bookmaker_key', 'selected_bookmaker_name')):
        return [], 'identity_missing'
    events = []
    for row in cache_rows:
        if row['provider'] != 'odds_api' or row['fetched_at'] != snapshot['captured_at']:
            continue
        try:
            payload = json.loads(row['data_json'])
        except (TypeError, ValueError):
            continue
        for event in payload if isinstance(payload, list) else [payload]:
            if isinstance(event, dict) and str(event.get('id')) == str(snapshot['odds_provider_match_id']):
                events.append((row, event))
    if len(events) != 1:
        return [], 'raw_event_not_unique'
    row, event = events[0]
    if (event.get('home_team') != snapshot['home_team_name'] or event.get('away_team') != snapshot['away_team_name']
            or event.get('commence_time') != snapshot['commence_time']):
        return [], 'fixture_mismatch'
    bookmakers = [b for b in event.get('bookmakers', []) if isinstance(b, dict)
                  and b.get('key') == snapshot['selected_bookmaker_key'] and b.get('title') == snapshot['selected_bookmaker_name']]
    if len(bookmakers) != 1:
        return [], 'raw_bookmaker_not_unique'
    markets = bookmakers[0].get('markets', [])
    findings = []
    for field in ('selected_odds_json', 'live_selected_odds_json'):
        sheet = obj(snapshot[field])
        for selection, price in sheet.items():
            match = PATTERN.fullmatch(selection)
            if not match or float(match.group(2)) < 8 or isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price):
                continue
            side, line = match.group(1), float(match.group(2))
            observations = []
            for market in markets:
                if not isinstance(market, dict):
                    continue
                for outcome in market.get('outcomes', []):
                    if not isinstance(outcome, dict):
                        continue
                    point = outcome.get('point')
                    if (isinstance(point, (int, float)) and not isinstance(point, bool) and point == line
                            and str(outcome.get('name', '')).lower() == side and outcome.get('price') == price):
                        observations.append((market, outcome))
            if len(observations) != 1:
                continue
            market, outcome = observations[0]
            if market.get('key') not in ('totals', 'alternate_totals') or STAT_CONTEXT.search(str(outcome.get('description', ''))):
                continue
            goal_key = side + match.group(2).replace('.', '')
            if goal_key in sheet and sheet[goal_key] != price:
                continue
            findings.append({'snapshot_id': snapshot['snapshot_id'], 'field': field, 'remove_selection': selection,
                             'add_selection': goal_key, 'price': price, 'bookmaker_key': snapshot['selected_bookmaker_key'],
                             'provider_event_id': str(event['id']), 'raw_market': market['key'],
                             'captured_at': row['fetched_at'], 'cache_request_id': row['request_id']})
    return findings, 'matched_raw_no_proven_error' if not findings else 'proven_candidate'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('sqlite_backup', help='local, stable SQLite backup (opened read-only)')
    args = parser.parse_args()
    path = Path(args.sqlite_backup).resolve(strict=True)
    if any(Path(str(path) + suffix).exists() for suffix in ('-wal', '-journal')):
        raise SystemExit('Use a stable standalone backup without WAL or journal sidecars')
    digest = hashlib.sha256()
    with path.open('rb') as backup:
        for chunk in iter(lambda: backup.read(1024 * 1024), b''):
            digest.update(chunk)
    db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise SystemExit('Backup integrity check failed')
    cache = list(db.execute('SELECT provider, fetched_at, request_id, data_json FROM smart_odds_cache'))
    counts, candidates = {}, []
    for row in db.execute('SELECT * FROM odds_snapshots'):
        findings, status = inspect(row, cache)
        counts[status] = counts.get(status, 0) + 1
        candidates.extend(findings)
    print(json.dumps({'mode': 'read_only_review_only', 'backup_sha256': digest.hexdigest(),
                      'counts': counts, 'candidates': candidates}, ensure_ascii=False, indent=2))
    db.close()


if __name__ == '__main__':
    main()
