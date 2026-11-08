"""Repair archived total-shot counts without changing immutable source inputs."""
import argparse
import collections
import copy
import csv
import datetime as dt
import decimal
import hashlib
import io
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ACQUISITION = ROOT / "backend/artifacts/research/c-five-season-projection-20261108/acquisition"
EXPECTED_MATCHES_SHA256 = "71e9681decd606dc870dbb2edb470edbaa45fd669049913c56182c43564c1513"
EXPECTED_MANIFEST_SHA256 = "825399a4b42e301c74d134c55f21f7e55bb3050b97045738da04bd9ee4146e20"
YEARS = {2019, 2020, 2021}
SHOT_RESULTS = {"Goal", "SavedShot", "BlockedShot", "MissedShots", "ShotOnPost", "OwnGoal"}
TOTAL_SHOT_FIELDS = {"homeTotalShots", "awayTotalShots"}


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def canonical_id(value):
    number = decimal.Decimal(str(value).strip())
    if not number.is_finite() or number <= 0 or number != number.to_integral_value():
        raise ValueError("invalid_positive_integer_source_id")
    return str(int(number))


def aggregate_shots(rows, seen_ids=None):
    """Require unique explicit IDs; an own-goal event is never a total shot."""
    seen = set() if seen_ids is None else seen_ids
    counts = {}
    for row in rows:
        shot_id = canonical_id(row["id"])
        if shot_id in seen:
            raise ValueError("duplicate_shot_id")
        seen.add(shot_id)
        side = str(row["h_a"]).strip()
        result = str(row["result"]).strip()
        if side not in ("h", "a") or result not in SHOT_RESULTS:
            raise ValueError("unsupported_shot_side_or_result")
        match_id = "understat_" + canonical_id(row["match_id"])
        match = counts.setdefault(match_id, {"h": {"all": 0, "ownGoals": 0, "counted": 0},
                                            "a": {"all": 0, "ownGoals": 0, "counted": 0}})
        match[side]["all"] += 1
        match[side]["ownGoals"] += int(result == "OwnGoal")
        match[side]["counted"] += int(result != "OwnGoal")
    return counts


def repair_matches(matches, counts):
    """Return a copy differing only in the two permitted total-shot fields."""
    repaired = copy.deepcopy(matches)
    original_ids = [row["matchId"] for row in matches]
    if len(original_ids) != len(set(original_ids)):
        raise ValueError("duplicate_input_match_id")
    expected_ids = {row["matchId"] for row in matches if int(row["season"][:4]) in YEARS}
    if set(counts) != expected_ids:
        raise ValueError("shot_match_ids_do_not_equal_target_ids")
    changes = []
    summary = collections.Counter()
    per_cohort = collections.defaultdict(collections.Counter)
    for original, updated in zip(matches, repaired):
        if original["matchId"] not in expected_ids:
            if original != updated:
                raise AssertionError("untargeted_row_changed")
            summary["untargetedRowsPreserved"] += 1
            continue
        event_counts = counts[original["matchId"]]
        cohort = per_cohort[(original["season"], original["competition"])]
        summary["targetRowsChecked"] += 1
        cohort["matchesChecked"] += 1
        delta = {"matchId": original["matchId"], "season": original["season"],
                 "competition": original["competition"], "sides": {}}
        for side, code in (("home", "h"), ("away", "a")):
            field = side + "TotalShots"
            old = original[field]
            current = event_counts[code]
            if type(old) is not int or old < 0 or old != current["all"]:
                raise ValueError("old_total_shots_do_not_equal_verified_raw_event_count")
            new = current["counted"]
            if new < 0 or old - new != current["ownGoals"]:
                raise AssertionError("shot_repair_delta_is_not_own_goal_count")
            on_target = original.get(side + "ShotsOnTarget")
            if on_target is not None and (type(on_target) is not int or not 0 <= on_target <= new):
                raise ValueError("preserved_on_target_shots_outside_corrected_total_bounds")
            updated[field] = new
            summary["rawShotEvents"] += current["all"]
            summary["ownGoalEventsExcluded"] += current["ownGoals"]
            summary["correctedTotalShots"] += new
            cohort["ownGoalEventsExcluded"] += current["ownGoals"]
            if new != old:
                summary["changedTeamSides"] += 1
                cohort["changedTeamSides"] += 1
                delta["sides"][side] = {"oldTotalShots": old, "newTotalShots": new,
                                        "excludedOwnGoalEvents": current["ownGoals"]}
        if delta["sides"]:
            changes.append(delta)
            cohort["changedMatches"] += 1
        before_other = {key: value for key, value in original.items() if key not in TOTAL_SHOT_FIELDS}
        after_other = {key: value for key, value in updated.items() if key not in TOTAL_SHOT_FIELDS}
        if before_other != after_other or original.keys() != updated.keys():
            raise AssertionError("field_outside_total_shots_changed")
    summary["changedMatches"] = len(changes)
    if [row["matchId"] for row in repaired] != original_ids:
        raise AssertionError("match_order_or_id_changed")
    return repaired, {"summary": dict(summary), "changedMatches": changes,
                      "perLeagueSeason": [{"season": season, "competition": competition, **dict(values)}
                                          for (season, competition), values in sorted(per_cohort.items())]}


def run(acquisition):
    matches_file = acquisition / "matches-archive.json"
    manifest_file = acquisition / "archive-manifest-v3.json"
    output_file = acquisition / "matches-archive-v4.json"
    report_file = acquisition / "archive-shot-repair-v4.json"
    if output_file.exists() or report_file.exists():
        raise ValueError("repair_outputs_must_be_new")
    matches_raw = matches_file.read_bytes()
    manifest_raw = manifest_file.read_bytes()
    if digest(matches_raw) != EXPECTED_MATCHES_SHA256 or digest(manifest_raw) != EXPECTED_MANIFEST_SHA256:
        raise ValueError("immutable_archive_input_hash_mismatch")
    manifest = json.loads(manifest_raw)
    if not manifest["exported"] or manifest["validationErrors"]:
        raise ValueError("archive_manifest_is_not_validated")
    receipts = manifest["sourceReceipts"]
    if len(receipts) != 25:
        raise ValueError("expected_25_pinned_original_csv_sources")
    counts = {}
    seen_shots = set()
    checked_sources = []
    cohorts = set()
    for receipt in receipts:
        path = ROOT / receipt["file"]
        raw = path.read_bytes()
        blob = hashlib.sha1(f"blob {len(raw)}\0".encode() + raw).hexdigest()
        if digest(raw) != receipt["sha256"] or blob != receipt["gitBlobSha1"]:
            raise ValueError("original_source_hash_mismatch")
        checked_sources.append({"file": receipt["file"], "sha256": digest(raw), "gitBlobSha1": blob})
        if receipt["kind"] != "shots":
            continue
        cohort = (receipt["competition"], receipt["seasonStart"])
        if receipt["seasonStart"] not in YEARS or cohort in cohorts:
            raise ValueError("duplicate_or_unexpected_shot_source_cohort")
        cohorts.add(cohort)
        rows = list(csv.DictReader(io.StringIO(raw.decode("utf-8-sig"))))
        if len(rows) != receipt["rowCount"]:
            raise ValueError("source_row_count_mismatch")
        source_counts = aggregate_shots(rows, seen_shots)
        if set(counts).intersection(source_counts):
            raise ValueError("match_cloned_across_shot_sources")
        counts.update(source_counts)
    if len(cohorts) != 15:
        raise ValueError("expected_15_league_season_shot_sources")
    original = json.loads(matches_raw)
    repaired, details = repair_matches(original, counts)
    if len(original) != 7202 or len(repaired) != len(original):
        raise ValueError("archive_match_row_count_mismatch")
    raw_output = (json.dumps(repaired, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
    scraper = ROOT / "backend/src/services/UnderstatScraper.ts"
    report = {"format": "immutable-archive-shot-semantics-repair-v4", "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
              "originalMatches": {"file": matches_file.relative_to(ROOT).as_posix(), "sha256": digest(matches_raw)},
              "originalManifest": {"file": manifest_file.relative_to(ROOT).as_posix(), "sha256": digest(manifest_raw)},
              "outputs": {"matches": {"file": output_file.relative_to(ROOT).as_posix(), "sha256": digest(raw_output), "rows": len(repaired)}},
              "repairScriptSha256": digest(Path(__file__).read_bytes()),
              "runtimeSemanticReference": {"file": scraper.relative_to(ROOT).as_posix(), "sha256": digest(scraper.read_bytes()),
                                           "rule": "summarizeShots: unique shot events with result != OwnGoal"},
              "sourceFilesVerified": checked_sources, "uniqueShotIdsVerified": len(seen_shots),
              "changedFieldsOnly": sorted(TOTAL_SHOT_FIELDS), "allOtherFieldsAndKeysExact": True,
              "matchIdsAndOrderExact": True, "noHoldoutOrQuarantineTargetSelectionPerformed": True,
              "untargeted2018ShotFieldsPreserved": True, **details,
              "limitations": ["This repair uses archived shot events without the original per-match roster receipts; it establishes the OwnGoal counting rule, not a new claim that runtime roster-completeness checks passed historically.",
                              "Goals, xG, shots on target, identifiers, timestamps and all provenance fields are unchanged.",
                              "No network, database, registry, forecasts, fitting or probability metrics used."]}
    # Both destinations were checked above. Exclusive writes preserve every older artifact.
    with output_file.open("xb") as stream:
        stream.write(raw_output)
    with report_file.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(report, indent=2, ensure_ascii=False) + "\n")
    if matches_file.read_bytes() != matches_raw or manifest_file.read_bytes() != manifest_raw:
        raise AssertionError("immutable_input_changed_during_repair")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--acquisition", type=Path, default=DEFAULT_ACQUISITION)
    report = run(parser.parse_args().acquisition.resolve())
    print(json.dumps({"outputs": report["outputs"], "summary": report["summary"],
                      "uniqueShotIdsVerified": report["uniqueShotIdsVerified"],
                      "allOtherFieldsAndKeysExact": report["allOtherFieldsAndKeysExact"]}))
