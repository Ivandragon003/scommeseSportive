"""Compare two coherent SQLite restores without opening either for writing."""
import hashlib
import heapq
import json
import os
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile


CHUNK_ROWS = 4096
MERGE_FAN_IN = 32


def row_digest(row):
    digest = hashlib.sha256(b"footpredictor-row-v1\0" + len(row).to_bytes(4, "big"))
    for value in row:
        if value is None:
            kind, payload = b"N", b""
        elif isinstance(value, int):
            kind, payload = b"I", str(value).encode("ascii")
        elif isinstance(value, float):
            kind, payload = b"R", struct.pack(">d", value)
        elif isinstance(value, str):
            kind, payload = b"T", value.encode("utf-8")
        elif isinstance(value, bytes):
            kind, payload = b"B", value
        else:
            raise ValueError("Unsupported SQLite value")
        digest.update(kind + len(payload).to_bytes(8, "big") + payload)
    return digest.digest()


def digests_from_file(path):
    with path.open("rb") as source:
        while True:
            value = source.read(32)
            if not value:
                return
            if len(value) != 32:
                raise ValueError("Incomplete checksum chunk")
            yield value


def write_chunk(path, values):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as target:
        for value in values:
            target.write(value)


def table_checksum(connection, name, directory):
    quoted = '"' + name.replace('"', '""') + '"'
    chunks, values, count = [], [], 0
    # Sorting fixed-size hashes instead of complete rows avoids large SQLite sorts.
    # The checksum is independent of physical rowids and insertion order.
    for row in connection.execute(f"SELECT * FROM {quoted}"):
        count += 1
        values.append(row_digest(row))
        if len(values) == CHUNK_ROWS:
            path = directory / f"chunk-{len(chunks)}"
            write_chunk(path, sorted(values))
            chunks.append(path)
            values = []
    if chunks and values:
        path = directory / f"chunk-{len(chunks)}"
        write_chunk(path, sorted(values))
        chunks.append(path)
    generation = 0
    while len(chunks) > MERGE_FAN_IN:
        merged = []
        for start in range(0, len(chunks), MERGE_FAN_IN):
            group = chunks[start:start + MERGE_FAN_IN]
            path = directory / f"merged-{generation}-{start}"
            write_chunk(path, heapq.merge(*(digests_from_file(item) for item in group)))
            for item in group:
                item.unlink()
            merged.append(path)
        chunks = merged
        generation += 1
    digest = hashlib.sha256(b"footpredictor-table-multiset-v1\0" + count.to_bytes(8, "big"))
    ordered = heapq.merge(*(digests_from_file(path) for path in chunks)) if chunks else sorted(values)
    for value in ordered:
        digest.update(value)
    for path in chunks:
        path.unlink()
    return {"count": str(count), "sha256": digest.hexdigest()}


def inspect(path):
    path = Path(path).resolve(strict=True)
    for suffix in ("-wal", "-journal"):
        sidecar = Path(str(path) + suffix)
        if sidecar.exists() and sidecar.stat().st_size:
            raise ValueError("Restore must have no pending journal")
    connection = sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        foreign_keys = sum(1 for _ in connection.execute("PRAGMA foreign_key_check"))
        schema = list(connection.execute("""SELECT type,name,tbl_name,sql FROM sqlite_schema
            WHERE sql IS NOT NULL AND (name NOT GLOB 'sqlite_*' OR name='sqlite_sequence')
            ORDER BY type COLLATE BINARY,name COLLATE BINARY,tbl_name COLLATE BINARY"""))
        schema_hash = hashlib.sha256(b"footpredictor-schema-v1\0")
        for entry in schema:
            # Preserve SQL literals and constraints; only normalize line endings.
            schema_hash.update(row_digest(tuple(value.replace("\r\n", "\n") if isinstance(value, str) else value
                                                for value in entry)))
        tables = {}
        with tempfile.TemporaryDirectory(prefix="footpredictor-migration-checksums-") as temporary:
            directory = Path(temporary)
            for entry in schema:
                if entry[0] == "table":
                    tables[entry[1]] = table_checksum(connection, entry[1], directory)
        return {"integrity": integrity, "foreignKeyViolations": foreign_keys,
                "schemaSha256": schema_hash.hexdigest(), "schemaObjects": len(schema), "tables": tables}
    finally:
        connection.close()


def compare(source_path, target_path):
    if os.path.samefile(source_path, target_path):
        raise ValueError("Distinct restored snapshots are required")
    source, target = inspect(source_path), inspect(target_path)
    mismatches = []
    for name in sorted(set(source["tables"]) | set(target["tables"])):
        left, right = source["tables"].get(name), target["tables"].get(name)
        if left != right:
            mismatches.append({"table": name, "source": left, "target": right})
    schema_matches = source["schemaSha256"] == target["schemaSha256"]
    valid = all(snapshot["integrity"] == ["ok"] and snapshot["foreignKeyViolations"] == 0
                for snapshot in (source, target))
    return {"format": "turso-restored-snapshot-comparison-v1", "readOnly": True,
            "snapshotParity": valid and schema_matches and not mismatches,
            "schemaMatches": schema_matches, "source": source, "target": target,
            "mismatchedTables": mismatches}


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Expected two restored SQLite files")
        print(json.dumps(compare(sys.argv[1], sys.argv[2])))
    except Exception:
        # SQLite errors can include SQL or private values. Do not expose them.
        print("Offline migration comparison failed; no database was modified.", file=sys.stderr)
        sys.exit(1)
