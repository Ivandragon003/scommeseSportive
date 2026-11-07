import copy
import hashlib
import importlib.util
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'audit-odds-high-goal-lines.py'
spec = importlib.util.spec_from_file_location('odds_audit', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class AuditTests(unittest.TestCase):
    def setUp(self):
        self.snap = {'source': 'odds_api', 'used_synthetic_odds': 0, 'snapshot_id': 's1',
                     'odds_provider_match_id': 'e1', 'captured_at': '2026-10-31T12:00:00Z',
                     'selected_bookmaker_key': '1xbet', 'selected_bookmaker_name': '1xBet',
                     'home_team_name': 'Manchester City', 'away_team_name': 'Brighton',
                     'commence_time': '2026-10-31T15:00:00Z',
                     'selected_odds_json': json.dumps({'shots_total_over_8.5': 1.22}),
                     'live_selected_odds_json': json.dumps({'shots_total_over_8.5': 1.22})}
        self.event = {'id': 'e1', 'home_team': 'Manchester City', 'away_team': 'Brighton',
                      'commence_time': '2026-10-31T15:00:00Z', 'bookmakers': [
                      {'key': '1xbet', 'title': '1xBet', 'markets': [
                      {'key': 'alternate_totals', 'outcomes': [{'name': 'Over', 'point': 8.5, 'price': 1.22}]}]}]}
        self.cache = {'provider': 'odds_api', 'fetched_at': self.snap['captured_at'], 'request_id': 'r1',
                      'data_json': json.dumps(self.event)}

    def test_proven_and_ambiguous(self):
        result, status = module.inspect(self.snap, [self.cache])
        self.assertEqual(status, 'proven_candidate')
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]['add_selection'], 'over85')
        self.assertEqual(module.inspect(self.snap, [self.cache, self.cache])[1], 'raw_event_not_unique')
        raw = copy.deepcopy(self.event)
        raw['bookmakers'][0]['markets'].append({'key': 'shots', 'outcomes': [{'name': 'Over', 'point': 8.5, 'price': 1.22}]})
        row = {**self.cache, 'data_json': json.dumps(raw)}
        self.assertEqual(module.inspect(self.snap, [row])[0], [])
        conflict = {**self.snap, 'selected_odds_json': json.dumps({'shots_total_over_8.5': 1.22, 'over85': 5})}
        self.assertEqual(len(module.inspect(conflict, [self.cache])[0]), 1)
        self.assertEqual(module.inspect({**self.snap, 'used_synthetic_odds': 1}, [self.cache])[0], [])
        self.assertEqual(module.inspect({**self.snap, 'captured_at': 'other'}, [self.cache])[0], [])

    def test_backup_is_unchanged_and_report_bound_to_hash(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'backup.sqlite'
            db = sqlite3.connect(path)
            fields = list(self.snap)
            db.execute('CREATE TABLE odds_snapshots (' + ','.join('"' + x + '"' for x in fields) + ')')
            db.execute('INSERT INTO odds_snapshots VALUES (' + ','.join('?' for _ in fields) + ')', tuple(self.snap.values()))
            db.execute('CREATE TABLE smart_odds_cache (provider, fetched_at, request_id, data_json)')
            db.execute('INSERT INTO smart_odds_cache VALUES (?,?,?,?)', tuple(self.cache.values()))
            db.commit()
            db.close()
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            result = subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)['backup_sha256'], digest)
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
            self.assertEqual(len(json.loads(result.stdout)['candidates']), 2)

if __name__ == '__main__':
    unittest.main()
