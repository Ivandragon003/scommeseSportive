"""Acquire a pinned public Understat archive; never execute downloaded source."""
import argparse
import collections
import concurrent.futures
import csv
import datetime as dt
import hashlib
import io
import json
import math
import re
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COMMIT = "4b42df35599f574c08ac65caacaf7975ed5fa138"
ARCHIVE = "https://github.com/Markjwilkins/Understat"
LEAGUES = {
    "EPL": ("epl", "Premier League"),
    "La_Liga": ("la_liga", "La Liga"),
    "Bundesliga": ("bundesliga", "Bundesliga"),
    "Serie_A": ("serie_a", "Serie A"),
    "Ligue_1": ("ligue_1", "Ligue 1"),
}
HEADERS = {"User-Agent": "FootPredictor-research-archive-audit/1.0"}
SHOT_RESULTS = {"Goal", "SavedShot", "BlockedShot", "MissedShots", "ShotOnPost", "OwnGoal"}


def normalized(value):
    value = unicodedata.normalize("NFD", str(value).lower())
    return re.sub("[^a-z0-9]", "", "".join(c for c in value if not unicodedata.combining(c)))


def timestamp(value):
    parsed = dt.datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def finite(value):
    number = float(value)
    if not math.isfinite(number):
        raise ValueError("nonfinite source number")
    return number


def fetch(spec, raw_dir, expected_blobs):
    folder, slug, competition, year, kind = spec
    if kind == "matches":
        name = "La_liga" if folder == "La_Liga" else folder
        path = f"Matches/{folder}/{name}_{year}_matches.csv"
    else:
        path = f"Shot Data by Year/{slug}_{year}.csv"
    url = f"https://raw.githubusercontent.com/Markjwilkins/Understat/{COMMIT}/{urllib.parse.quote(path)}"
    receipt = {"competition": competition, "seasonStart": year, "kind": kind,
               "sourceUrl": url, "archivePath": path, "archiveCommit": COMMIT}
    try:
        file = raw_dir / f"{slug}-{year}-{kind}.csv"
        if file.exists():
            raw = file.read_bytes()
            receipt["reusedLocalPinnedArchiveFile"] = True
        else:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=25) as response:
                raw = response.read(4_000_001)
                receipt["httpStatus"] = response.status
            file.write_bytes(raw)
        if len(raw) > 4_000_000:
            raise ValueError("source size limit exceeded")
        blob_hash = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
        if blob_hash != expected_blobs.get(path):
            raise ValueError("pinned Git blob hash mismatch")
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
        receipt.update(status="downloaded", file=file.relative_to(ROOT).as_posix(),
                       verifiedAt=dt.datetime.now(dt.timezone.utc).isoformat(), bytes=len(raw),
                       gitBlobSha1=blob_hash, pinnedGitBlobVerified=True,
                       sha256=hashlib.sha256(raw).hexdigest(), rowCount=len(rows),
                       columns=list(rows[0]) if rows else [])
        return receipt, rows
    except Exception as error:
        receipt.update(status="failed", error=f"{type(error).__name__}: {error}")
        return receipt, []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--reuse-raw", action="store_true")
    parser.add_argument("--team-history-zip", type=Path)
    parser.add_argument("--manifest-name", default="archive-manifest.json")
    args = parser.parse_args()
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / args.manifest_name).exists():
        raise ValueError("manifest output already exists; choose a new versioned name")
    raw_dir = output / "understat-original"
    raw_dir.mkdir(exist_ok=args.reuse_raw)
    tree_url = f"https://api.github.com/repos/Markjwilkins/Understat/git/trees/{COMMIT}?recursive=1"
    tree_file = output / "pinned-archive-tree.json"
    if args.reuse_raw and tree_file.exists():
        tree_raw = tree_file.read_bytes()
    else:
        with urllib.request.urlopen(urllib.request.Request(tree_url, headers=HEADERS), timeout=20) as response:
            tree_raw = response.read()
    tree = json.loads(tree_raw)
    expected_blobs = {item["path"]: item["sha"] for item in tree["tree"] if item["type"] == "blob"}
    (output / "pinned-archive-tree.json").write_bytes(tree_raw)
    specs = [(folder, slug, competition, year, kind)
             for folder, (slug, competition) in LEAGUES.items()
             for year, kind in [(2018, "matches"), (2019, "matches"),
                                (2019, "shots"), (2020, "shots"), (2021, "shots")]]
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        fetched = list(pool.map(lambda spec: fetch(spec, raw_dir, expected_blobs), specs))
    receipts = [entry[0] for entry in fetched]
    sources = {(r["competition"], r["seasonStart"], r["kind"]): (r, rows)
               for r, rows in fetched if r["status"] == "downloaded"}
    local_file = ROOT / "backend/artifacts/research/current-c-real-odds-backtest-20261108/matches.json"
    local_raw = local_file.read_bytes()
    local_rows = json.loads(local_raw)
    local_teams = collections.defaultdict(set)
    for row in local_rows:
        for side in ("home", "away"):
            local_teams[(row["competition"], normalized(row[f"{side}_team_name"]))].add(row[f"{side}_team_id"])
    errors = []
    ambiguous = sorted((league, name, sorted(values)) for (league, name), values in local_teams.items() if len(values) != 1)
    if ambiguous:
        errors.append({"reason": "ambiguous_local_team_crosswalk", "entries": ambiguous})
    team_ids = {key: next(iter(values)) for key, values in local_teams.items() if len(values) == 1}
    team_provenance = {key: "existing_local_team_identity_exact_name" for key in team_ids}
    official = {}
    official_counts = collections.Counter()
    for (league, year, kind), (receipt, rows) in sources.items():
        if kind != "matches":
            continue
        for row in rows:
            if str(row["isResult"]).lower() not in ("true", "1"):
                continue
            mid = "understat_" + str(int(finite(row["id"])))
            for side, source_side in (("home", "h"), ("away", "a")):
                key = (league, normalized(row[f"{source_side}.title"]))
                if key not in team_ids:
                    team_ids[key] = "understat_team_" + str(int(finite(row[f"{source_side}.id"])))
                    team_provenance[key] = "numeric_understat_team_id_from_archived_match_results"
            match = {"matchId": mid, "competition": league, "season": f"{year}/{year + 1}",
                     "date": timestamp(row["datetime"]), "homeTeamName": row["h.title"],
                     "awayTeamName": row["a.title"], "homeGoals": int(finite(row["goals.h"])),
                     "awayGoals": int(finite(row["goals.a"])), "homeXG": finite(row["xG.h"]),
                     "awayXG": finite(row["xG.a"]), "homeTotalShots": None, "awayTotalShots": None,
                     "homeShotsOnTarget": None, "awayShotsOnTarget": None,
                     "archiveProvenance": {"matchFields": receipt["file"], "xgMethod": "archived_official_match_total"}}
            official[mid] = match
            official_counts[(league, year)] += 1
    derived = {}
    coverage = []
    maximum_gap = 0.0
    validation_pairs = 0
    for (league, year, kind), (receipt, rows) in sources.items():
        if kind != "shots":
            continue
        groups = collections.defaultdict(list)
        shot_ids = set()
        for row in rows:
            if "x_g" not in row and "xG" in row:
                row["x_g"] = row["xG"]
            shot_id = str(row["id"])
            if shot_id in shot_ids:
                errors.append({"reason": "duplicate_shot_id", "file": receipt["file"]})
                break
            shot_ids.add(shot_id)
            groups["understat_" + str(int(finite(row["match_id"])))].append(row)
        mismatches = 0
        xg_mismatches = 0
        for mid, shots in groups.items():
            repeated = {key: {row[key] for row in shots} for key in ("home_team", "away_team", "home_goals", "away_goals", "date")}
            if any(len(values) != 1 for values in repeated.values()):
                errors.append({"reason": "inconsistent_repeated_match_fields", "matchId": mid})
                continue
            first = shots[0]
            if any(row["h_a"] not in ("h", "a") or row["result"] not in SHOT_RESULTS for row in shots):
                errors.append({"reason": "unrecognized_shot_side_or_result", "matchId": mid})
                continue
            totals = {side: sum(finite(row["x_g"]) for row in shots if row["h_a"] == side) for side in ("h", "a")}
            if any(finite(row["x_g"]) < 0 or finite(row["x_g"]) > 1 for row in shots):
                errors.append({"reason": "invalid_shot_xg", "matchId": mid})
                continue
            match = {"matchId": mid, "competition": league, "season": f"{year}/{year + 1}",
                     "date": timestamp(first["date"]), "homeTeamName": first["home_team"],
                     "awayTeamName": first["away_team"], "homeGoals": int(finite(first["home_goals"])),
                     "awayGoals": int(finite(first["away_goals"])), "homeXG": totals["h"], "awayXG": totals["a"],
                     "homeTotalShots": sum(r["h_a"] == "h" for r in shots),
                     "awayTotalShots": sum(r["h_a"] == "a" for r in shots),
                     "homeShotsOnTarget": sum(r["h_a"] == "h" and r["result"] in ("Goal", "SavedShot") for r in shots),
                     "awayShotsOnTarget": sum(r["h_a"] == "a" and r["result"] in ("Goal", "SavedShot") for r in shots),
                     "archiveProvenance": {"matchFields": receipt["file"], "goalsMethod": "consistent_repeated_official_match_fields_not_goal_shot_counts", "xgMethod": "sum_all_archived_understat_shots"}}
            if year == 2019:
                reference = official.get(mid)
                if reference is None or any(match[key] != reference[key] for key in ("competition", "date", "homeTeamName", "awayTeamName", "homeGoals", "awayGoals")):
                    mismatches += 1
                    continue
                gap = max(abs(match[side + "XG"] - reference[side + "XG"]) for side in ("home", "away"))
                maximum_gap = max(maximum_gap, gap)
                validation_pairs += 1
                if gap > 0.0001:
                    xg_mismatches += 1
                reference.update({key: match[key] for key in ("homeTotalShots", "awayTotalShots", "homeShotsOnTarget", "awayShotsOnTarget")})
                reference["archiveProvenance"]["shots"] = receipt["file"]
            else:
                derived[mid] = match
        expected = official_counts[(league, 2019)] if year == 2019 else (306 if league == "Bundesliga" else 380)
        complete = len(groups) == expected and mismatches == 0
        coverage.append({"competition": league, "seasonStart": year, "shotRows": len(rows),
                         "uniqueMatches": len(groups), "expectedMatches": expected,
                         "matchedOfficialValidationFailures": mismatches, "coveragePassed": complete,
                         "shotSumXgReferenceFailures": xg_mismatches,
                         "shotSumXgUsedAsFinalMatchTotal": not bool(args.team_history_zip)})
        if not complete:
            errors.append({"reason": "shot_match_coverage_or_reference_failure", "competition": league, "year": year})
        if xg_mismatches and not args.team_history_zip:
            errors.append({"reason": "shot_xg_sum_not_equal_to_official_match_total", "competition": league, "year": year})
    results = list(official.values()) + list(derived.values())
    team_history_audit = None
    if args.team_history_zip:
        zip_path = args.team_history_zip.resolve()
        zip_raw = zip_path.read_bytes()
        expected_zip_sha = "54e5f240b61b425e55c83102e3c803135e28199d97dd6778b59e8721b576828f"
        if hashlib.sha256(zip_raw).hexdigest() != expected_zip_sha:
            raise ValueError("pinned team history ZIP hash mismatch")
        history_index = collections.defaultdict(list)
        league_names = {"EPL": "Premier League", "La_liga": "La Liga", "Bundesliga": "Bundesliga",
                        "Serie_A": "Serie A", "Ligue_1": "Ligue 1"}
        removed_copies = []
        with zipfile.ZipFile(io.BytesIO(zip_raw)) as archive:
            members = set(archive.namelist())
            for member in sorted(members):
                found = re.fullmatch(r"football_data_csv/(EPL|La_liga|Bundesliga|Serie_A|Ligue_1)_(2018|2019|2020|2021)_(.+)\.csv", member)
                if not found:
                    continue
                league_code, year_text, team_name = found.groups()
                raw = archive.read(member)
                if team_name.endswith("2"):
                    original = member[:-5].rstrip() + ".csv"
                    if original not in members or archive.read(original) != raw:
                        errors.append({"reason": "unexpected_nonidentical_numbered_team_copy", "file": member})
                        continue
                    removed_copies.append({"copy": member, "original": original, "sha256": hashlib.sha256(raw).hexdigest()})
                    continue
                for row in csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))):
                    key = (league_names[league_code], int(year_text), normalized(team_name), row["h_a"], timestamp(row["date"]))
                    history_index[key].append((member, row))
        matched = collections.Counter()
        excluded_warmup = []
        original_comparisons = 0
        original_maximum_gap = 0.0
        for match in results:
            year = int(match["season"][:4])
            refs = []
            for side, code in (("home", "h"), ("away", "a")):
                key = (match["competition"], year, normalized(match[side + "TeamName"]), code, match["date"])
                options = history_index.get(key, [])
                if len(options) != 1:
                    if year != 2018:
                        errors.append({"reason": "missing_or_ambiguous_team_history_fixture", "matchId": match["matchId"], "side": side, "matchingRows": len(options)})
                else:
                    refs.append(options[0])
            if len(refs) != 2:
                if year == 2018:
                    excluded_warmup.append({"matchId": match["matchId"], "competition": match["competition"],
                                            "archivedKickoffAt": match["date"],
                                            "reason": "conflicting_or_unmatched_historical_fixture_date_not_corrected"})
                continue
            home_member, home = refs[0]
            away_member, away = refs[1]
            goals_ok = all(finite(value) == expected for value, expected in [
                (home["scored"], match["homeGoals"]), (home["missed"], match["awayGoals"]),
                (away["scored"], match["awayGoals"]), (away["missed"], match["homeGoals"])])
            reciprocal = max(abs(finite(home["xG"]) - finite(away["xGA"])),
                             abs(finite(away["xG"]) - finite(home["xGA"])))
            if not goals_ok or reciprocal > 1e-8 or min(finite(home["xG"]), finite(away["xG"])) < 0:
                errors.append({"reason": "team_history_fixture_goals_or_reciprocal_xg_mismatch", "matchId": match["matchId"]})
                continue
            if year <= 2019:
                gap = max(abs(match["homeXG"] - finite(home["xG"])), abs(match["awayXG"] - finite(away["xG"])))
                original_comparisons += 1
                original_maximum_gap = max(original_maximum_gap, gap)
                if gap > 0.0001:
                    errors.append({"reason": "official_archives_match_total_xg_disagreement", "matchId": match["matchId"]})
                    continue
            else:
                match["homeXG"] = finite(home["xG"])
                match["awayXG"] = finite(away["xG"])
                match["archiveProvenance"]["xgMethod"] = "official_understat_team_fixture_history_not_sum_shots"
            match["archiveProvenance"]["teamHistoryArchive"] = {
                "repository": "https://github.com/mhsendur/understat-football-data-2014-2023",
                "commit": "7fc2d32037ea9bcb83edfbae366c70c938f03e26", "zipSha256": expected_zip_sha,
                "homeMember": home_member, "awayMember": away_member,
                "validation": "unique_name_date_side_join_official_goals_agree_and_xg_xga_reciprocal"}
            matched[(match["competition"], year)] += 1
        team_history_audit = {"zipFile": zip_path.relative_to(ROOT).as_posix(), "sha256": expected_zip_sha,
                              "exactDuplicateWholeFilesRemoved": removed_copies,
                              "matchedFixturesByLeagueSeason": [{"competition": league, "seasonStart": year, "matches": count} for (league, year), count in sorted(matched.items())],
                              "officialMatchTotalComparisons2018_2019": original_comparisons,
                              "officialMatchTotalMaximumGap": original_maximum_gap,
                              "excludedWarmupFixtures": excluded_warmup,
                              "licenseEvidence": "No explicit repository license in GitHub metadata; do not infer a data reuse license."}
        excluded_ids = {row["matchId"] for row in excluded_warmup}
        results = [match for match in results if match["matchId"] not in excluded_ids]
    crosswalk = {}
    for match in results:
        for side in ("home", "away"):
            key = (match["competition"], normalized(match[side + "TeamName"]))
            if key not in team_ids:
                team_ids[key] = "archived_team_" + normalized(match["competition"]) + "_" + key[1]
                team_provenance[key] = "internal_deterministic_name_identity_not_numeric_provider_id"
            match[side + "TeamId"] = team_ids[key]
            crosswalk[key] = {"competition": key[0], "canonicalNameKey": key[1], "teamId": team_ids[key], "identitySource": team_provenance[key]}
        match["source"] = "understat_public_archive"
        match["archiveProvenance"]["repository"] = ARCHIVE
        match["archiveProvenance"]["commit"] = COMMIT
        match["archiveProvenance"]["historicalAvailability"] = "kickoff_plus_two_hours_proxy_not_verified_original_ingestion"
    if len({m["matchId"] for m in results}) != len(results):
        errors.append({"reason": "duplicate_normalized_match_id"})
    manifest = {"format": "pinned-understat-public-archive-acquisition-v1", "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                "archiveRepository": ARCHIVE, "archiveCommit": COMMIT,
                "provenanceChain": ["https://github.com/JaseZiv/worldfootballR_data#the-data", ARCHIVE],
                "sourceDocumentation": "https://github.com/JaseZiv/worldfootballR/blob/main/R/understat_match_results.R",
                "licenseEvidence": {"repositoryLicense": None, "explanation": "GitHub metadata reports no explicit data repository license; do not infer a license from the R package."},
                "sourceReceipts": receipts, "shotCoverage": coverage,
                "xgAggregationValidation2019": {"matchedGames": validation_pairs, "maximumAbsoluteGap": maximum_gap, "absoluteTolerance": 0.0001},
                "teamHistoryValidation": team_history_audit,
                "localIdentityCrosswalkSource": {"file": local_file.relative_to(ROOT).as_posix(), "sha256": hashlib.sha256(local_raw).hexdigest()},
                "teamCrosswalk": list(crosswalk.values()), "validationErrors": errors,
                "exported": False, "constraints": ["No downloaded R or other repository code executed.", "Goals come from source match totals, never counted from shot outcomes.", "Shot xG sums failed equality to official match totals and are not acceptable substitutes. When the separate team-history archive is supplied, its reciprocal official fixture totals are used instead.", "Availability timestamps are reconstruction proxies; archive acquisition is later than the matches.", "No provider substitutions, training, probability metrics, database or operational registry writes."]}
    if len(sources) != len(specs):
        errors.append({"reason": "one_or_more_archive_downloads_failed"})
    if not errors and validation_pairs > 0:
        results.sort(key=lambda m: (m["date"], m["matchId"]))
        file = output / "matches-archive.json"
        raw = (json.dumps(results, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        file.write_bytes(raw)
        manifest.update(exported=True, normalizedMatches={"file": file.relative_to(ROOT).as_posix(), "rows": len(results), "sha256": hashlib.sha256(raw).hexdigest(), "rowsPerSeason": dict(collections.Counter(m["season"] for m in results))})
    (output / args.manifest_name).write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"downloaded": len(sources), "requested": len(specs), "exported": manifest["exported"], "validationErrors": errors, "xg2019": manifest["xgAggregationValidation2019"], "coverage": coverage, "normalizedMatches": manifest.get("normalizedMatches")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
