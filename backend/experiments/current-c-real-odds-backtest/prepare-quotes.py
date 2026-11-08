"""Freeze public CSV prices and match explicit bookmaker closing columns offline."""
import argparse
import collections
import concurrent.futures
import csv
import datetime
import hashlib
import io
import json
import math
import re
import unicodedata
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CODES = {'E0': 'Premier League', 'SP1': 'La Liga', 'D1': 'Bundesliga', 'F1': 'Ligue 1', 'I1': 'Serie A'}


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--refresh-current', action='store_true')
    args = parser.parse_args()
    output = args.out.resolve()
    if (output / 'quotes.json').exists():
        raise ValueError('Quote output already exists')
    manifest_path = ROOT / 'backend/artifacts/research/current-c-vs-a-20261108/odds-audit/raw-source-manifest.json'
    old_manifest = read(manifest_path)
    matches = read(output / 'matches.json')
    model = read(ROOT / 'backend/current-models/challenger.json')
    protected = set(read(ROOT / 'backend/src/research/original-holdout-policy.json')['protectedOriginalFinalMatchIds'])
    quarantine = {item['matchId'] for item in read(ROOT / 'backend/src/research/challenger-data-quarantine.json')['entries']}
    service = (ROOT / 'backend/src/services/FootballDataService.ts').read_text(encoding='utf-8')
    block = service.split('const TEAM_ALIASES: Record<string, string> = {', 1)[1].split('};', 1)[0]
    aliases = dict(re.findall(r"\b([a-z0-9]+):\s*'([a-z0-9]+)'", block))
    if len(aliases) < 30:
        raise ValueError('Team aliases unavailable')

    def norm(value):
        value = ''.join(char for char in unicodedata.normalize('NFD', str(value).lower()) if not unicodedata.combining(char))
        value = re.sub('[^a-z0-9]', '', value)
        return aliases.get(value, value)

    def match_key(league, day, home, away):
        return league, day, norm(home), norm(away)

    index = collections.defaultdict(list)
    for match in matches:
        index[match_key(match['competition'], match['date'][:10], match['home_team_name'], match['away_team_name'])].append(match)
    source_files = []
    for entry in old_manifest['raw_csv_files']:
        raw = (ROOT / entry['file']).read_bytes()
        if sha(raw) != entry['sha256'] or sha(raw) != entry['source_sha256'] or len(raw) != entry['bytes']:
            raise ValueError('Archived source hash mismatch')
        if args.refresh_current and entry['season_start'] == 2026:
            continue
        source_files.append({**entry, 'acquiredAt': entry.get('verified_at', entry.get('acquired_at'))})

    if args.refresh_current:
        csv_dir = output / 'csv-current'
        csv_dir.mkdir(exist_ok=False)

        def fetch(code):
            url = f'https://www.football-data.co.uk/mmz4281/2627/{code}.csv'
            request = urllib.request.Request(url, headers={'User-Agent': 'FootPredictor-private-research/1.0'})
            with urllib.request.urlopen(request, timeout=45) as response:
                raw = response.read(2_000_001)
                if len(raw) > 2_000_000 or response.status != 200:
                    raise ValueError('Invalid CSV response')
                final_url = response.url
            acquired = datetime.datetime.now(datetime.timezone.utc).isoformat()
            if 'B365CH' not in raw.decode('utf-8-sig').splitlines()[0]:
                raise ValueError('Closing bookmaker columns missing')
            file = csv_dir / f'{code}-2627.csv'
            file.write_bytes(raw)
            return {'file': file.relative_to(ROOT).as_posix(), 'sha256': sha(raw), 'bytes': len(raw), 'league_code': code,
                    'season_start': 2026, 'acquiredAt': acquired, 'sourceUrl': url, 'responseUrl': final_url,
                    'priceTimestamp': None, 'source': 'football_data_csv'}

        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            source_files.extend(pool.map(fetch, CODES))

    def number(row, field):
        try:
            value = float(row[field])
            return value if math.isfinite(value) and value > 1 else None
        except (KeyError, TypeError, ValueError):
            return None

    counts = collections.Counter()
    matched = []
    coverage = collections.defaultdict(collections.Counter)
    for entry in source_files:
        raw = (ROOT / entry['file']).read_bytes()
        if sha(raw) != entry['sha256']:
            raise ValueError('Source changed')
        csv_rows = list(csv.DictReader(io.StringIO(raw.decode('utf-8-sig'))))
        unique = collections.Counter()
        parsed = []
        for row_number, row in enumerate(csv_rows, 2):
            try:
                day = datetime.datetime.strptime(row['Date'], '%d/%m/%Y').date().isoformat()
            except (KeyError, ValueError):
                counts['invalid_csv_date'] += 1
                continue
            key = match_key(CODES[entry['league_code']], day, row.get('HomeTeam', ''), row.get('AwayTeam', ''))
            unique[key] += 1
            parsed.append((row_number, row, key))
        for row_number, row, key in parsed:
            candidates = index.get(key, [])
            if len(candidates) != 1 or unique[key] != 1:
                counts['ambiguous_or_unmatched'] += 1
                continue
            match = candidates[0]
            season = match['season']
            coverage[season]['matched_csv_rows'] += 1
            if match['home_goals'] is None or match['away_goals'] is None:
                counts['unfinished'] += 1
                continue
            if match['date'] <= model['validationThrough']:
                counts['before_model_calibration_cutoff'] += 1
                coverage[season]['before_calibration_cutoff'] += 1
                continue
            if match['match_id'] in protected:
                counts['protected_original_holdout'] += 1
                coverage[season]['protected_original_holdout'] += 1
                continue
            if match['match_id'] in quarantine:
                counts['data_quality_quarantine'] += 1
                continue
            try:
                goals = int(row['FTHG']), int(row['FTAG'])
            except (KeyError, TypeError, ValueError):
                counts['missing_csv_result'] += 1
                continue
            if goals != (match['home_goals'], match['away_goals']):
                counts['conflicting_result'] += 1
                continue
            columns = {'1x2': ['B365CH', 'B365CD', 'B365CA'], 'totals': ['B365C>2.5', 'B365C<2.5'],
                       'asian_handicap': ['B365CAHH', 'B365CAHA']}
            sheets = {}
            for market, fields in columns.items():
                values = [number(row, field) for field in fields]
                if all(value is not None for value in values):
                    sheets[market] = {'columns': fields, 'prices': values}
            try:
                line = float(row['AHCh'])
                if not math.isfinite(line) or abs(line * 4 - round(line * 4)) > 1e-8:
                    raise ValueError('Invalid Asian line')
            except (KeyError, TypeError, ValueError):
                line = None
                sheets.pop('asian_handicap', None)
            if not sheets:
                counts['no_complete_real_bookmaker_sheet'] += 1
                continue
            matched.append({'matchId': match['match_id'], 'competition': match['competition'], 'season': season,
                            'kickoffAt': match['date'], 'home': match['home_team_name'], 'away': match['away_team_name'],
                            'homeGoals': goals[0], 'awayGoals': goals[1], 'bookmaker': 'Bet365', 'source': 'football_data_csv',
                            'priceType': 'closing', 'priceTimestamp': None, 'archiveAcquiredAt': entry['acquiredAt'],
                            'sourceFile': entry['file'], 'sourceSha256': entry['sha256'], 'csvRowNumber': row_number,
                            'asianHomeLine': line, 'sheets': sheets})
            coverage[season]['eligible_matches'] += 1
    by_match = collections.Counter(row['matchId'] for row in matched)
    if any(count != 1 for count in by_match.values()):
        raise ValueError('Duplicate target in CSV sources')
    matched.sort(key=lambda row: (row['kickoffAt'], row['matchId']))
    payload = {'protocol': 'current-c-real-closing-prices-v1', 'artifactVersion': model['version'],
               'sourceManifestSha256': sha(manifest_path.read_bytes()), 'teamAliasSourceSha256': sha(service.encode()),
               'scope': 'Closing-price scenario; prices are real, their historical observation time is unknown.',
               'sources': source_files, 'exclusions': dict(counts), 'coverage': dict(coverage), 'rows': matched}
    with (output / 'quotes.json').open('x', encoding='utf-8') as file:
        json.dump(payload, file, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
    print(json.dumps({'matches': len(matched), 'coverage': dict(coverage), 'exclusions': dict(counts)}))


if __name__ == '__main__':
    main()
