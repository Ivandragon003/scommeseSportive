"""Freeze supplementary football-data CSVs; never substitute primary match data."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import csv
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
LEAGUES = {'E0': 'Premier League', 'SP1': 'La Liga', 'D1': 'Bundesliga',
           'I1': 'Serie A', 'F1': 'Ligue 1'}
CACHE_MANIFEST = ROOT / 'backend/artifacts/research/current-c-vs-a-20261108/odds-audit/raw-source-manifest.json'


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def acquire(output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)

    def download(pair):
        code, year = pair
        season = f'{year % 100:02d}{(year + 1) % 100:02d}'
        url = f'https://www.football-data.co.uk/mmz4281/{season}/{code}.csv'
        request = urllib.request.Request(url, headers={'User-Agent': 'FootPredictor historical research'})
        with urllib.request.urlopen(request, timeout=30) as response:
            raw, actual_url = response.read(), response.url
        observed = datetime.now(timezone.utc).isoformat()
        rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        required = {'Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG'}
        if not rows or not required.issubset(rows[0]):
            raise ValueError(f'invalid_csv:{code}:{year}')
        file = output / f'{code}-{year}.csv'
        with file.open('xb') as handle:
            handle.write(raw)
        return {'file': file.relative_to(ROOT).as_posix(), 'sha256': sha(file),
                'competition': LEAGUES[code], 'seasonStart': year,
                'archiveAcquiredAt': observed, 'url': url, 'responseUrl': actual_url,
                'rows': len(rows), 'bytes': len(raw),
                'hasBet365Closing1x2Columns': {'B365CH', 'B365CD', 'B365CA'}.issubset(rows[0]),
                'role': 'supplementary_missing_statistics_and_real_closing_quotes_only'}

    with ThreadPoolExecutor(max_workers=2) as executor:
        sources = list(executor.map(download, [(code, year) for year in range(2018, 2022) for code in LEAGUES]))
    cached = json.loads(CACHE_MANIFEST.read_bytes())
    for entry in cached['raw_csv_files']:
        year, code = entry['season_start'], entry['league_code']
        if year not in range(2022, 2026) or code not in LEAGUES:
            continue
        file = ROOT / entry['file']
        if sha(file) != entry['sha256']:
            raise ValueError(f'cached_csv_hash_changed:{file.name}')
        sources.append({'file': entry['file'], 'sha256': entry['sha256'],
                        'competition': LEAGUES[code], 'seasonStart': year,
                        'archiveAcquiredAt': entry['verified_at'], 'rows': entry['rows'],
                        'actualRemoteUrl': entry['actual_remote_url'],
                        'role': 'previously_frozen_supplementary_csv'})
    if len(sources) != 40 or len({(x['competition'], x['seasonStart']) for x in sources}) != 40:
        raise ValueError('expected_40_unique_league_season_sources')
    manifest = {'createdAt': datetime.now(timezone.utc).isoformat(), 'sources': sources,
                'scriptHash': sha(Path(__file__)), 'cacheManifestHash': sha(CACHE_MANIFEST),
                'primarySourceReplaced': False, 'databaseWrites': 0,
                'limitations': ['Closing quotes are retrospectively acquired, not observed Nightly prices.',
                                'These files do not replace Understat match identities, results or xG.']}
    manifest_file = output.parent / 'csv-manifest.json'
    with manifest_file.open('x', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=2, allow_nan=False)
        handle.write('\n')
    return {'manifest': str(manifest_file), 'sha256': sha(manifest_file),
            'newDownloads': 20, 'reusedVerifiedFiles': 20}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(acquire(args.out)))
