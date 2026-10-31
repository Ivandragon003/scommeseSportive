#!/usr/bin/env python3
"""Read-only C dataset audit against cached original HTTP sources.

No database, environment file, application service or model is changed. Raw
captures and every discrepancy remain local. A naive source time stays naive.
"""

import argparse
import collections
import csv
import datetime as dt
import gzip
import hashlib
import io
import json
import math
import pathlib
import re
import unicodedata
import urllib.error
import urllib.request
import zlib
from concurrent.futures import ThreadPoolExecutor

ROOT = pathlib.Path(__file__).resolve().parents[1]
LEAGUES = {
    "Premier League": ("EPL", "epl", "E0"),
    "Serie A": ("Serie_A", "serie_a", "I1"),
    "La Liga": ("La_liga", "la_liga", "SP1"),
    "Bundesliga": ("Bundesliga", "bundesliga", "D1"),
    "Ligue 1": ("Ligue_1", "ligue_1", "F1"),
}
STAT_COLUMNS = {
    "homeGoals": "FTHG", "awayGoals": "FTAG",
    "homeTotalShots": "HS", "awayTotalShots": "AS",
    "homeShotsOnTarget": "HST", "awayShotsOnTarget": "AST",
    "homeYellowCards": "HY", "awayYellowCards": "AY",
    "homeRedCards": "HR", "awayRedCards": "AR",
    "homeFouls": "HF", "awayFouls": "AF",
    "homeCorners": "HC", "awayCorners": "AC",
}
RANGES = {**{field: (0, 100) for field in STAT_COLUMNS},
          "homeGoals": (0, 20), "awayGoals": (0, 20),
          "homeXG": (0, 20), "awayXG": (0, 20),
          "homeYellowCards": (0, 20), "awayYellowCards": (0, 20),
          "homeRedCards": (0, 5), "awayRedCards": (0, 5)}
DATABASE_FIELDS = {
    "match_id": "matchId", "home_team_id": "homeTeamId", "away_team_id": "awayTeamId",
    "home_team_name": "homeTeamName", "away_team_name": "awayTeamName",
    "home_goals": "homeGoals", "away_goals": "awayGoals", "home_xg": "homeXG", "away_xg": "awayXG",
    "home_shots": "homeTotalShots", "away_shots": "awayTotalShots",
    "home_shots_on_target": "homeShotsOnTarget", "away_shots_on_target": "awayShotsOnTarget",
    "home_fouls": "homeFouls", "away_fouls": "awayFouls",
    "home_yellow_cards": "homeYellowCards", "away_yellow_cards": "awayYellowCards",
    "home_red_cards": "homeRedCards", "away_red_cards": "awayRedCards",
    "home_corners": "homeCorners", "away_corners": "awayCorners",
}


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf8")


def number(value):
    if value is None or isinstance(value, bool) or str(value).strip() == "":
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError):
        return None


def completed(row):
    return number(row.get("homeGoals")) is not None and number(row.get("awayGoals")) is not None


def source_id(row):
    match = re.fullmatch(r"understat_(\d+)", str(row.get("matchId", "")))
    return match.group(1) if match else None


def source_datetime(value):
    """Return the source's own civil datetime, without appending a timezone."""
    try:
        parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return {"raw": value, "datetime": parsed, "timezoneDeclared": parsed.tzinfo is not None}
    except (TypeError, ValueError):
        return None


def load_rows(path):
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    rows = data if isinstance(data, list) else data.get("matches", data.get("rows", data.get("teams")))
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("Input must contain a list of match objects")
    return rows


def load_benchmark(path):
    """Load an explicit, nonempty scored cohort and verify public bundles."""
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    evidence = {"file": str(path.resolve())}
    filter_predictions = False
    if isinstance(data, list):
        targets, evidence["format"] = data, "flat_list"
    elif isinstance(data, dict) and ("predictionsFile" in data or "predictionsSha256" in data):
        if data.get("schemaVersion") != "independent-challenger-metrics-audit-v1":
            raise ValueError("Unknown benchmark bundle schema")
        filename, expected_hash = data.get("predictionsFile"), data.get("predictionsSha256")
        if not isinstance(filename, str) or not filename.strip() or pathlib.Path(filename).is_absolute():
            raise ValueError("Benchmark predictionsFile must be a local relative path")
        predictions_path = (path.parent / filename).resolve()
        if not predictions_path.is_relative_to(path.parent.resolve()):
            raise ValueError("Benchmark predictionsFile must stay inside its bundle directory")
        if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", expected_hash):
            raise ValueError("Benchmark bundle requires predictionsSha256")
        raw = predictions_path.read_bytes()
        payload = gzip.decompress(raw) if filename.endswith(".gz") or raw[:2] == b"\x1f\x8b" else raw
        if sha256(payload) != expected_hash.lower():
            raise ValueError("Benchmark predictionsSha256 mismatch (decoded JSONL bytes)")
        if data.get("predictionsBytes") is not None and data["predictionsBytes"] != len(payload):
            raise ValueError("Benchmark predictionsBytes mismatch (decoded JSONL bytes)")
        targets = [json.loads(line) for line in payload.decode("utf-8-sig").splitlines() if line.strip()]
        evidence.update({"format": "independent_metric_bundle", "predictionsFile": str(predictions_path),
                         "predictionsFileSha256": sha256(raw), "predictionsSha256": sha256(payload),
                         "predictionsBytes": len(payload)})
        filter_predictions = True
    elif isinstance(data, dict):
        recognized = [key for key in ("predictions", "rows", "records") if key in data]
        if len(recognized) != 1:
            raise ValueError("Unknown or ambiguous benchmark schema: expected predictions, rows or records")
        key = recognized[0]
        targets, evidence["format"] = data[key], key
        filter_predictions = key == "records"
    else:
        raise ValueError("Unknown benchmark schema")
    if not isinstance(targets, list) or not targets or not all(isinstance(row, dict) for row in targets):
        raise ValueError("Benchmark cohort must be a nonempty list of match objects")
    evidence["inputRecords"] = len(targets)
    if filter_predictions:
        if any(row.get("predictions") is not None and not isinstance(row["predictions"], dict) for row in targets):
            raise ValueError("Benchmark records require predictions to be an object")
        targets = [row for row in targets if row.get("predictions")]
    if not targets:
        raise ValueError("Benchmark cohort is empty after filtering records without predictions")
    for target in targets:
        if (not isinstance(target.get("matchId"), str) or not target["matchId"].strip()
                or not completed(target) or not source_datetime(target.get("kickoffAt", target.get("date")))):
            raise ValueError("Unknown benchmark row schema: require matchId, kickoff/date and completed score")
    evidence.update({"selectedRecords": len(targets), "excludedWithoutPredictions": evidence["inputRecords"] - len(targets)})
    return targets, evidence


def normalize_database_rows(rows):
    return [{DATABASE_FIELDS.get(key, key): value for key, value in row.items()} for row in rows]


def snapshot_drift(before, after):
    before_by_id = {row.get("matchId"): row for row in before}
    after_by_id = {row.get("matchId"): row for row in after}
    differences = []
    for match_id in sorted(before_by_id.keys() & after_by_id.keys()):
        old, new = before_by_id[match_id], after_by_id[match_id]
        for field, value in old.items():
            if field in new and value != new[field]:
                differences.append({"matchId": match_id, "field": field, "frozen": value, "current": new[field]})
    return {"commonMatches": len(before_by_id.keys() & after_by_id.keys()),
            "missingFromCurrent": sorted(before_by_id.keys() - after_by_id.keys()),
            "newInCurrent": sorted(after_by_id.keys() - before_by_id.keys()),
            "differences": differences, "changedMatches": len({row["matchId"] for row in differences}),
            "fieldCounts": dict(collections.Counter(row["field"] for row in differences))}


def load_aliases():
    # Read the actual supplementary matching aliases; never alter shared code.
    text = (ROOT / "src/services/FootballDataService.ts").read_text(encoding="utf8")
    section = text.split("const TEAM_ALIASES:", 1)[1].split("};", 1)[0]
    return dict(re.findall(r"\b([a-zA-Z0-9_]+)\s*:\s*'([^']+)'", section))


def canonical(value, aliases):
    ascii_name = "".join(character for character in unicodedata.normalize("NFD", str(value))
                         if not unicodedata.combining(character))
    normalized = re.sub(r"[^a-z0-9]", "", ascii_name.lower())
    return aliases.get(normalized, normalized)


def decode_javascript_string(encoded):
    """Decode only JS string escapes; never eval downloaded JavaScript."""
    substitutions = {"n": "\n", "r": "\r", "t": "\t", "b": "\b", "f": "\f", "v": "\v", "0": "\0"}
    pattern = r"\\(?:x([0-9a-fA-F]{2})|u([0-9a-fA-F]{4})|([\s\S]))"
    def replace(match):
        if match.group(1) or match.group(2):
            return chr(int(match.group(1) or match.group(2), 16))
        return substitutions.get(match.group(3), match.group(3))
    return re.sub(pattern, replace, encoded)


def embedded_league_data(html):
    result = {}
    for name, quote, encoded in re.findall(
            r"\b(datesData|teamsData)\s*=\s*JSON\.parse\(\s*(['\"])((?:\\.|(?!\2)[\s\S])*?)\2\s*\)", html):
        result["dates" if name == "datesData" else "teams"] = json.loads(decode_javascript_string(encoded))
    return result if isinstance(result.get("dates"), list) else None


class HttpCache:
    def __init__(self, directory, timeout=25, offline=False, refresh=False):
        self.directory = directory
        self.timeout, self.offline, self.refresh = timeout, offline, refresh

    def fetch(self, url, source, referer=None, binary=False):
        key = sha256(url.encode("utf8"))
        meta_path, raw_path = self.directory / (key + ".json"), self.directory / (key + ".raw")
        if meta_path.exists() and raw_path.exists() and not self.refresh:
            meta, raw = json.loads(meta_path.read_text(encoding="utf8")), raw_path.read_bytes()
            if meta.get("url") != url or meta.get("source") != source or meta.get("rawSha256") != sha256(raw):
                raise ValueError("Source cache hash or identity mismatch: " + url)
        elif self.offline:
            return None, {"source": source, "url": url, "status": "not_cached", "error": "offline cache miss"}
        else:
            headers = {"User-Agent": "Mozilla/5.0 (compatible; FootPredictorReadOnlyAudit/1.0)",
                       "Accept-Encoding": "identity"}
            if referer:
                headers.update({"Referer": referer, "X-Requested-With": "XMLHttpRequest"})
            try:
                request = urllib.request.Request(url, headers=headers)
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    raw = response.read()
                    meta = {"source": source, "url": url, "finalUrl": response.geturl(),
                            "status": response.status, "capturedAt": utc_now(),
                            "contentType": response.headers.get("Content-Type"),
                            "contentEncoding": response.headers.get("Content-Encoding"),
                            "rawBytes": len(raw), "rawSha256": sha256(raw),
                            "rawFile": str(raw_path.resolve())}
                self.directory.mkdir(parents=True, exist_ok=True)
                raw_path.write_bytes(raw)
                save_json(meta_path, meta)
            except (OSError, urllib.error.URLError) as error:
                meta = {"source": source, "url": url, "status": getattr(error, "code", "http_error"),
                        "capturedAt": utc_now(), "error": str(error)}
                save_json(meta_path, meta)
                return None, meta
        decoded = raw
        if decoded[:2] == b"\x1f\x8b":
            decoded = gzip.decompress(decoded)
        elif meta.get("contentEncoding") == "deflate":
            decoded = zlib.decompress(decoded)
        if binary:
            return decoded, meta
        header_charset = re.search(r"charset\s*=\s*['\"]?([\w.-]+)", str(meta.get("contentType", "")), re.I)
        html_charset = re.search(br"charset\s*=\s*['\"]?([\w.-]+)", decoded[:10000], re.I)
        encoding = (header_charset.group(1) if header_charset else
                    html_charset.group(1).decode("ascii") if html_charset else "utf-8-sig")
        try:
            text = decoded.decode(encoding, errors="strict")
        except UnicodeDecodeError:
            # Legacy original club pages can predate UTF-8. Preserve bytes and
            # disclose the fallback, rather than silently replacing accents.
            encoding = "cp1252"
            text = decoded.decode(encoding, errors="strict")
            meta["decodingFallback"] = "utf8_failed_cp1252_used"
        meta["decodedEncoding"] = encoding
        save_json(meta_path, meta)
        return text, meta


def fetch_pair(pair, cache):
    league, season = pair
    page_slug, json_slug, csv_slug = LEAGUES[league]
    year = int(str(season)[:4])
    page_url = f"https://understat.com/league/{page_slug}/{year}"
    captures, errors = [], []
    page, metadata = cache.fetch(page_url, "understat_league_html")
    captures.append(metadata)
    payload = None
    if page:
        try:
            payload = embedded_league_data(page)
        except (ValueError, TypeError) as error:
            errors.append("embedded_json: " + str(error))
    route = "embedded_json"
    if payload is None:
        route = "original_same_source_json_endpoint"
        raw, metadata = cache.fetch(f"https://understat.com/getLeagueData/{json_slug}/{year}",
                                    "understat_league_json", page_url)
        captures.append(metadata)
        if raw:
            try:
                payload = json.loads(raw)
                if not isinstance(payload.get("dates"), list):
                    raise ValueError("Understat dates is not a list")
            except (ValueError, AttributeError) as error:
                payload = None
                errors.append("original_json: " + str(error))
    code = f"{year % 100:02d}{(year + 1) % 100:02d}"
    csv_text, metadata = cache.fetch(f"https://www.football-data.co.uk/mmz4281/{code}/{csv_slug}.csv",
                                    "football-data.co.uk_csv")
    captures.append(metadata)
    csv_rows = []
    if csv_text:
        reader = csv.DictReader(io.StringIO(csv_text))
        if not {"Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG"}.issubset(reader.fieldnames or []):
            errors.append("CSV does not contain required match columns")
        else:
            for row in reader:
                try:
                    raw_date = row.get("Date", "").strip()
                    pattern = "%d/%m/%Y" if len(raw_date.split("/")[-1]) == 4 else "%d/%m/%y"
                    row["_date"] = dt.datetime.strptime(raw_date, pattern).date().isoformat()
                    csv_rows.append(row)
                except (ValueError, AttributeError):
                    continue
    return {"competition": league, "season": season, "understatRoute": route,
            "understat": payload, "csvRows": csv_rows, "captures": captures, "errors": errors}


def profile(rows, benchmark_ids, teams=None):
    issues, groups = [], collections.defaultdict(list)
    calendar_groups = collections.defaultdict(list)
    by_id, by_fixture = collections.defaultdict(list), collections.defaultdict(list)
    registry = None if teams is None else {str(row.get("teamId", row.get("team_id", row.get("id", "")))) for row in teams}
    for row in rows:
        match_id = row.get("matchId")
        by_id[str(match_id)].append(row)
        groups[(str(row.get("competition")), str(row.get("season")))].append(row)
        calendar_groups[(str(row.get("competition")), str(row.get("date", ""))[:4])].append(row)
        by_fixture[(row.get("competition"), row.get("date"), row.get("homeTeamId"), row.get("awayTeamId"))].append(row)
        def issue(kind, **details):
            issues.append({"matchId": match_id, "kind": kind, "benchmark": match_id in benchmark_ids, **details})
        date = source_datetime(row.get("date"))
        if not date:
            issue("invalid_date", value=row.get("date"))
        elif not date["timezoneDeclared"]:
            issue("dataset_date_has_no_timezone", value=row.get("date"))
        if not source_id(row):
            issue("missing_understat_match_id")
        if (number(row.get("homeGoals")) is None) != (number(row.get("awayGoals")) is None):
            issue("partial_score")
        for side in ("home", "away"):
            team_id = row.get(side + "TeamId")
            if not team_id:
                issue("missing_team_id", side=side)
            elif registry is not None and str(team_id) not in registry:
                issue("orphan_team_id", side=side, teamId=team_id)
            shots, on_target = number(row.get(side + "TotalShots")), number(row.get(side + "ShotsOnTarget"))
            if shots is not None and on_target is not None and on_target > shots:
                issue("shots_on_target_exceeds_shots", side=side, shots=shots, shotsOnTarget=on_target)
        if row.get("homeTeamId") and row.get("homeTeamId") == row.get("awayTeamId"):
            issue("same_home_away_team")
        for field, bounds in RANGES.items():
            value = row.get(field)
            numeric = number(value)
            if value is not None and (numeric is None or not bounds[0] <= numeric <= bounds[1]):
                issue("invalid_or_extreme_numeric", field=field, value=str(value))
            elif numeric is not None and "XG" not in field and numeric != int(numeric):
                issue("noninteger_count", field=field, value=value)
    def summarize(subset):
        finished = [row for row in subset if completed(row)]
        fields = sorted(set().union(*(row.keys() for row in subset))) if subset else []
        return {"records": len(subset), "completed": len(finished), "pending": len(subset) - len(finished),
                "benchmark": sum(row.get("matchId") in benchmark_ids for row in subset),
                "dateFrom": min((str(row.get("date")) for row in subset), default=None),
                "dateUntil": max((str(row.get("date")) for row in subset), default=None),
                "fields": {field: {"present": sum(row.get(field) is not None for row in subset),
                                   "completedMissing": sum(row.get(field) is None for row in finished),
                                   "completedMin": min((number(row.get(field)) for row in finished if number(row.get(field)) is not None), default=None),
                                   "completedMax": max((number(row.get(field)) for row in finished if number(row.get(field)) is not None), default=None)} for field in fields}}
    duplicate_ids = [{"matchId": key, "count": len(value)} for key, value in by_id.items() if len(value) > 1]
    duplicate_fixtures = [{"key": list(key), "matchIds": [r.get("matchId") for r in value]}
                          for key, value in by_fixture.items() if len(value) > 1]
    return {"all": summarize(rows), "benchmark": summarize([r for r in rows if r.get("matchId") in benchmark_ids]),
            "byLeagueSeason": [{"competition": key[0], "season": key[1], **summarize(value)} for key, value in sorted(groups.items())],
            "byLeagueCalendarYear": [{"competition": key[0], "calendarYear": key[1], **summarize(value)}
                                     for key, value in sorted(calendar_groups.items())],
            "duplicateMatchIds": duplicate_ids, "duplicateFixtures": duplicate_fixtures,
            "issues": issues, "issueCounts": dict(collections.Counter(row["kind"] for row in issues)),
            "orphanTeamCheck": "checked_against_supplied_registry" if registry is not None else "not_verifiable_without_team_registry"}


def compare_sources(rows, sources, benchmark_ids, aliases, teams=None):
    differences, coverage = [], collections.defaultdict(collections.Counter)
    identity, reverse_identity = collections.defaultdict(collections.Counter), collections.defaultdict(collections.Counter)
    source_by_pair = {(source["competition"], source["season"]): source for source in sources}
    registry = {str(team.get("teamId", team.get("team_id"))): team for team in (teams or [])}
    unmatched = []
    for row in rows:
        scopes = ["all"] + (["benchmark"] if row.get("matchId") in benchmark_ids else [])
        scopes.append(str(row.get("competition")) + "/" + str(row.get("season")))
        def count(key):
            for scope in scopes:
                coverage[scope][key] += 1
        def difference(kind, **details):
            differences.append({"matchId": row.get("matchId"), "competition": row.get("competition"),
                                "season": row.get("season"), "benchmark": row.get("matchId") in benchmark_ids,
                                "kind": kind, **details})
        count("datasetRecords")
        source = source_by_pair.get((row.get("competition"), row.get("season")))
        if source is None:
            count("sourcePairNotRequested")
            continue
        dates = (source.get("understat") or {}).get("dates", [])
        candidates = [entry for entry in dates if str(entry.get("id")) == source_id(row)]
        if len(candidates) != 1:
            count("understatNotMatched")
            difference("understat_id_not_uniquely_present", candidates=len(candidates))
            continue
        entry = candidates[0]
        count("understatMatched")
        for side, key in (("home", "h"), ("away", "a")):
            local_id, native_id = str(row.get(side + "TeamId", "")), str(entry.get(key, {}).get("id", ""))
            identity[(row.get("competition"), local_id)][native_id] += 1
            reverse_identity[(row.get("competition"), native_id)][local_id] += 1
            native_match = re.fullmatch(r"understat_team_(\d+)", local_id)
            if native_match and native_match.group(1) != native_id:
                difference("native_team_id_mismatch", side=side, dataset=local_id, understat=native_id)
            registered = registry.get(local_id, {}).get("source_team_id")
            if registered is not None and str(registered) != native_id:
                difference("registered_source_team_id_mismatch", side=side, teamId=local_id,
                           registry=str(registered), understat=native_id)
            dataset_name = row.get(side + "TeamName")
            if dataset_name and canonical(dataset_name, aliases) != canonical(entry.get(key, {}).get("title", ""), aliases):
                difference("source_team_name_difference", side=side, dataset=dataset_name,
                           understat=entry.get(key, {}).get("title"))
        date, original_date = source_datetime(row.get("date")), source_datetime(entry.get("datetime"))
        if date and original_date:
            count("understatDateComparable")
            if not original_date["timezoneDeclared"]:
                count("understatTimezoneUndeclared")
            # Civil time comparison, expressly NOT an assertion of UTC equivalence.
            delta = (date["datetime"].replace(tzinfo=None) - original_date["datetime"].replace(tzinfo=None)).total_seconds()
            if delta:
                count("understatWallClockDiffers")
                difference("understat_wall_clock_difference_not_instant_comparison", dataset=row.get("date"),
                           understat=entry.get("datetime"), seconds=delta)
            else:
                count("understatWallClockEqualButInstantUnverified")
        if completed(row) != bool(entry.get("isResult")):
            count("understatStatusDiffers")
            difference("understat_status_difference", datasetCompleted=completed(row), sourceIsResult=entry.get("isResult"))
        for field, section, side in (("homeGoals", "goals", "h"), ("awayGoals", "goals", "a"),
                                      ("homeXG", "xG", "h"), ("awayXG", "xG", "a")):
            observed, original = number(row.get(field)), number(entry.get(section, {}).get(side))
            if observed is None or original is None:
                count("understat_" + field + "_notComparable")
                continue
            count("understat_" + field + "_compared")
            if abs(observed - original) > 0.000001:
                count("understat_" + field + "_differs")
                difference("understat_numeric_difference", field=field, dataset=observed, understat=original)
        if not original_date:
            count("footballDataNoSourceDate")
            continue
        key = (original_date["datetime"].date().isoformat(), canonical(entry.get("h", {}).get("title", ""), aliases),
               canonical(entry.get("a", {}).get("title", ""), aliases))
        matches = [item for item in source["csvRows"] if (item["_date"], canonical(item.get("HomeTeam"), aliases),
                    canonical(item.get("AwayTeam"), aliases)) == key]
        if len(matches) != 1:
            count("footballDataNotMatched")
            # Diagnostic only: exposing a moved fixture must never silently
            # make its statistics or historical outcome temporally eligible.
            alternatives = [item for item in source["csvRows"]
                            if canonical(item.get("HomeTeam"), aliases) == key[1]
                            and canonical(item.get("AwayTeam"), aliases) == key[2]]
            unmatched.append({"matchId": row.get("matchId"), "benchmark": row.get("matchId") in benchmark_ids,
                              "competition": row.get("competition"), "season": row.get("season"),
                              "sourceDate": key[0], "home": entry.get("h", {}).get("title"),
                              "away": entry.get("a", {}).get("title"), "candidates": len(matches),
                              "sameTeamsCsvAlternatives_DIAGNOSTIC_ONLY": [
                                  {"date": item["_date"], "timeRawTimezoneUndeclared": item.get("Time"),
                                   "homeGoals": item.get("FTHG"), "awayGoals": item.get("FTAG")}
                                  for item in alternatives]})
            continue
        count("footballDataMatched")
        original = matches[0]
        for field, column in STAT_COLUMNS.items():
            if field not in row:
                continue
            observed, raw_original = number(row.get(field)), number(original.get(column))
            if observed is None or raw_original is None:
                count("footballData_" + field + "_notComparable")
                continue
            count("footballData_" + field + "_compared")
            if observed != raw_original:
                count("footballData_" + field + "_differs")
                difference("football_data_statistic_difference_primary_may_differ", field=field, dataset=observed,
                           footballData=raw_original, sourceColumn=column)
    collisions = [{"competition": key[0], "localTeamId": key[1], "understatTeamIds": dict(values)}
                  for key, values in sorted(identity.items()) if len(values) > 1]
    fragmentation = [{"competition": key[0], "understatTeamId": key[1], "localTeamIds": dict(values)}
                     for key, values in sorted(reverse_identity.items()) if len(values) > 1]
    return {"coverage": {key: dict(value) for key, value in sorted(coverage.items())},
            "differences": differences, "differenceCounts": dict(collections.Counter(row["kind"] for row in differences)),
            "footballDataUnmatched": unmatched, "localIdentityCollisions": collisions,
            "localIdentityFragmentation": fragmentation}


def primary_detail_sample(rows, comparison, benchmark_ids, per_league, cache, workers):
    """Stratified diagnostic sample, not a representative error-rate estimate."""
    differing_fields = collections.defaultdict(set)
    for difference in comparison["differences"]:
        if difference["kind"] == "football_data_statistic_difference_primary_may_differ" and difference["benchmark"]:
            differing_fields[difference["matchId"]].add(difference["field"])
    chosen = []
    for league in sorted(LEAGUES):
        candidates = [row for row in rows if row.get("competition") == league and row.get("matchId") in benchmark_ids]
        candidates.sort(key=lambda row: (-len(differing_fields[row["matchId"]]), row["matchId"]))
        chosen.extend(candidates[:per_league])
    def verify(row):
        raw, capture = cache.fetch(f"https://understat.com/getMatchData/{source_id(row)}", "understat_match_json",
                                   f"https://understat.com/match/{source_id(row)}")
        result = {"matchId": row["matchId"], "competition": row["competition"], "capture": capture,
                  "csvDifferingFields": sorted(differing_fields[row["matchId"]]), "comparisons": []}
        try:
            payload = json.loads(raw) if raw else None
            if not isinstance(payload, dict):
                raise ValueError("Unavailable match payload")
            for side, short in (("home", "h"), ("away", "a")):
                shots = payload.get("shots", {}).get(short)
                roster = payload.get("rosters", {}).get(short)
                if not isinstance(shots, list) or not isinstance(roster, dict) or len(roster) < 11:
                    raise ValueError("Missing shots or complete roster on " + side)
                # Same explicit source definitions as UnderstatScraper.enrichMatch.
                values = {side + "TotalShots": len(shots),
                          side + "ShotsOnTarget": sum(shot.get("result") in ("Goal", "SavedShot") for shot in shots),
                          side + "YellowCards": sum(number(player.get("yellow_card")) or 0 for player in roster.values()),
                          side + "RedCards": sum(number(player.get("red_card")) or 0 for player in roster.values())}
                for field, value in values.items():
                    observed = number(row.get(field))
                    result["comparisons"].append({"field": field, "dataset": observed, "understatDetails": value,
                                                  "equal": observed == value if observed is not None else None})
        except (ValueError, AttributeError, TypeError) as error:
            result["error"] = str(error)
            result["comparisons"] = []
        return result
    with ThreadPoolExecutor(max_workers=workers) as executor:
        results = list(executor.map(verify, chosen))
    return {"selection": "up_to_N_per_league_benchmark_ranked_by_most_CSV_differing_fields_then_matchId",
            "sampleRepresentative": False, "requestedPerLeague": per_league, "requested": len(chosen),
            "verifiedMatches": sum(not result.get("error") for result in results),
            "comparedFields": sum(comparison["equal"] is not None for result in results for comparison in result["comparisons"]),
            "differingFields": sum(comparison["equal"] is False for result in results for comparison in result["comparisons"]),
            "matches": results}


def markdown(report):
    profile_all = report["profile"]["all"]
    lines = ["# Audit locale delle fonti C", "", f"Generato: {report['generatedAt']}", "",
             f"Input: {profile_all['records']} record, {profile_all['completed']} conclusi; benchmark: {report['benchmarkRequested']} target.",
             "", "| Campione | Record | Understat per ID | Football-data data+squadre | Timezone Understat non dichiarata |",
             "|---|---:|---:|---:|---:|"]
    for label in ("all", "benchmark"):
        values = report["comparison"]["coverage"].get(label, {})
        lines.append(f"| {label} | {values.get('datasetRecords', 0)} | {values.get('understatMatched', 0)} | {values.get('footballDataMatched', 0)} | {values.get('understatTimezoneUndeclared', 0)} |")
    lines += ["", "Differenze (tutte conservate in differences.json):", ""]
    lines += [f"- {key}: {value}" for key, value in report["comparison"]["differenceCounts"].items()] or ["- Nessuna differenza sui campi confrontabili."]
    lines += ["", "Copertura per lega/stagione:", "", "| Lega | Stagione | Record | Conclusi | Benchmark | Understat | CSV |",
              "|---|---|---:|---:|---:|---:|---:|"]
    for group in report["profile"]["byLeagueSeason"]:
        counts = report["comparison"]["coverage"].get(group["competition"] + "/" + group["season"], {})
        lines.append(f"| {group['competition']} | {group['season']} | {group['records']} | {group['completed']} | {group['benchmark']} | {counts.get('understatMatched',0)} | {counts.get('footballDataMatched',0)} |")
    lines += ["", "Limiti:", ""] + ["- " + limitation for limitation in report["limitations"]]
    if "primaryDetailSample" in report:
        sample = report["primaryDetailSample"]
        lines += ["", f"Campione diagnostico dettagli Understat: {sample['verifiedMatches']}/{sample['requested']} match, "
                  f"{sample['comparedFields']} campi confrontati, {sample['differingFields']} differenze. "
                  "Campione mirato sugli scarti CSV, senza stima di errore per l'intera popolazione."]
    if "snapshotDrift" in report:
        lines += ["", f"Drift export corrente: {report['snapshotDrift']['changedMatches']} match cambiati; "
                  f"{report['currentProfile']['all']['completed']} conclusi attuali. "
                  "Dettaglio campo per campo in audit.json."]
    if "clockEvidence" in report:
        evidence = report["clockEvidence"]
        invalid = [row["matchId"] for row in evidence.get("matches", []) if row.get("forecastAfterOfficialKickoff")]
        lines += ["", "## Conflitti del calendario verificati", "",
                  f"{len(invalid)} target benchmark hanno forecast successivo al programma ufficiale del match: " + ", ".join(invalid) + ".",
                  "L'accordo con la data civile Understat non dimostra validità pre-match. "
                  "Nessuna correzione automatica o certificazione; fonti e tempi nel dossier allegato."]
    if report.get("relatedEvidence"):
        lines += ["", "Ulteriori dossier originali conservati:", ""]
        lines += [f"- {item['path']} (SHA256 {item['sha256']})" for item in report["relatedEvidence"]]
    lines += ["", "Riproduzione senza rete:", "", "```", report["offlineCommand"], "```", "",
              f"SHA256 input: {report['inputSha256']}", f"SHA256 benchmark: {report['benchmarkSha256']}",
              f"SHA256 script: {report['scriptSha256']}", ""]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--matches", type=pathlib.Path, required=True)
    parser.add_argument("--benchmark", type=pathlib.Path, required=True)
    parser.add_argument("--teams", type=pathlib.Path)
    parser.add_argument("--current", type=pathlib.Path, help="Optional current read-only DB export for snapshot drift")
    parser.add_argument("--clock-evidence", type=pathlib.Path, help="Optional explicitly curated original-source clock conflict dossier")
    parser.add_argument("--related-evidence", type=pathlib.Path, action="append", default=[], help="Additional local source dossiers to hash and reference")
    parser.add_argument("--out", type=pathlib.Path, required=True)
    parser.add_argument("--max-pairs", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=25)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--detail-sample-per-league", type=int, default=0)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args(argv)
    if (not 0 <= args.max_pairs <= 100 or not 1 <= args.workers <= 4 or not 0 < args.timeout <= 60
            or not 0 <= args.detail_sample_per_league <= 20):
        parser.error("max-pairs must be 0..100, workers 1..4, timeout 0..60 seconds")
    rows = load_rows(args.matches)
    targets, benchmark_input = load_benchmark(args.benchmark)
    benchmark_ids = {str(row["matchId"]) for row in targets}
    dataset_ids = {str(row.get("matchId")) for row in rows}
    if not benchmark_ids.intersection(dataset_ids):
        raise ValueError("Benchmark cohort has no matches present in the supplied dataset")
    benchmark_rows = [{("date" if key == "kickoffAt" else key): value for key, value in target.items()
                       if key in ("matchId", "competition", "season", "homeTeamId", "awayTeamId", "kickoffAt", "homeGoals", "awayGoals")}
                      for target in targets]
    teams = load_rows(args.teams) if args.teams else None
    current = normalize_database_rows(load_rows(args.current)) if args.current else None
    pairs = collections.Counter((row.get("competition"), row.get("season")) for row in rows)
    bench_counts = collections.Counter((row.get("competition"), row.get("season")) for row in rows if row.get("matchId") in benchmark_ids)
    selected_pairs = sorted((pair for pair in pairs if pair[0] in LEAGUES),
                            key=lambda pair: (-bench_counts[pair], -pairs[pair], pair))[:args.max_pairs]
    args.out.mkdir(parents=True, exist_ok=True)
    cache = HttpCache(args.out / "raw", args.timeout, args.offline, args.refresh)
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        sources = list(executor.map(lambda pair: fetch_pair(pair, cache), selected_pairs))
    aliases = load_aliases()
    comparison = compare_sources(rows, sources, benchmark_ids, aliases, teams)
    source_manifest = [{key: value for key, value in source.items() if key not in ("understat", "csvRows")} |
                       {"understatRecords": len((source["understat"] or {}).get("dates", [])), "csvRecords": len(source["csvRows"])} for source in sources]
    report = {"schemaVersion": "challenger-source-audit-v1", "generatedAt": utc_now(),
              "inputFile": str(args.matches.resolve()), "inputSha256": sha256(args.matches.read_bytes()),
              "benchmarkSha256": sha256(args.benchmark.read_bytes()), "scriptSha256": sha256(pathlib.Path(__file__).read_bytes()),
              "benchmarkInput": benchmark_input,
              "sourceImplementationHashes": {file: sha256((ROOT / file).read_bytes()) for file in
                                             ("src/services/UnderstatScraper.ts", "src/services/FootballDataService.ts")},
              "benchmarkRequested": len(benchmark_ids), "benchmarkMissingFromDataset": sorted(benchmark_ids - dataset_ids),
              "benchmarkDuplicateIds": [key for key, count in collections.Counter(row["matchId"] for row in targets).items() if count > 1],
              "benchmarkDatasetConsistency": snapshot_drift(benchmark_rows, [row for row in rows if row.get("matchId") in benchmark_ids]),
              "sourcePairsTotal": len(pairs), "sourcePairsRequested": len(selected_pairs), "sources": source_manifest,
              "profile": profile(rows, benchmark_ids, teams), "comparison": comparison,
              "offlineCommand": f'python backend/scripts/audit-challenger-sources.py --matches "{args.matches}" --benchmark "{args.benchmark}" --out "{args.out}" --max-pairs {args.max_pairs} --offline',
              "limitations": [
                  "Understat resta la fonte primaria. Le differenze con CSV supplementare non autorizzano sovrascritture.",
                  "I datetime Understat senza timezone sono confrontati solo come orari civili: nessun suffisso UTC inventato e nessuna certificazione dell'istante.",
                  "Le acquisizioni HTTP attuali verificano lo stato della fonte oggi, non provano disponibilità storica pre-forecast o assenza di revisioni.",
                  "L'export non include provenienza campo per campo: una differenza tra tiri/cartellini Understat e CSV non dimostra da sola errore del dato primario.",
                  "Nessuna quota CSV viene impiegata per ROI/CLV; nessuna modifica a database, motori, servizi o modello A.",
                  "Gli orfani richiedono un registro squadre: " + ("fornito." if teams is not None else "non fornito; controllo non verificabile."),
                  "Matching CSV solo data civile e identità squadre da Understat, senza fuzzy matching o tolleranze di data silenziose."]}
    optional_args = ""
    if teams is not None:
        report["teamsSha256"] = sha256(args.teams.read_bytes())
        optional_args += f' --teams "{args.teams}"'
    if current is not None:
        report["currentSha256"] = sha256(args.current.read_bytes())
        report["snapshotDrift"] = snapshot_drift(rows, current)
        report["currentProfile"] = profile(current, benchmark_ids, teams)
        report["currentComparison"] = compare_sources(current, sources, benchmark_ids, aliases, teams)
        optional_args += f' --current "{args.current}"'
    if args.detail_sample_per_league:
        report["primaryDetailSample"] = primary_detail_sample(rows, comparison, benchmark_ids,
                                                              args.detail_sample_per_league, cache, args.workers)
        optional_args += f" --detail-sample-per-league {args.detail_sample_per_league}"
    if args.clock_evidence:
        report["clockEvidence"] = json.loads(args.clock_evidence.read_text(encoding="utf8"))
        report["clockEvidenceSha256"] = sha256(args.clock_evidence.read_bytes())
        optional_args += f' --clock-evidence "{args.clock_evidence}"'
    report["relatedEvidence"] = []
    for evidence_path in args.related_evidence:
        # Validate readability without inferring or changing its adjudication.
        json.loads(evidence_path.read_text(encoding="utf8"))
        report["relatedEvidence"].append({"path": str(evidence_path.resolve()), "sha256": sha256(evidence_path.read_bytes())})
        optional_args += f' --related-evidence "{evidence_path}"'
    report["offlineCommand"] += optional_args
    save_json(args.out / "audit.json", report)
    save_json(args.out / "differences.json", {"differences": comparison["differences"], "unmatched": comparison["footballDataUnmatched"]})
    (args.out / "audit.md").write_text(markdown(report), encoding="utf8")
    print(json.dumps({"records": len(rows), "completed": report["profile"]["all"]["completed"],
                      "pairs": len(selected_pairs), "coverage": comparison["coverage"].get("all"),
                      "benchmarkCoverage": comparison["coverage"].get("benchmark"),
                      "differenceCounts": comparison["differenceCounts"], "report": str((args.out / "audit.json").resolve())}, ensure_ascii=False))
    return report


if __name__ == "__main__":
    main()
