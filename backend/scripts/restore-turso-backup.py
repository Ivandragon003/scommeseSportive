"""Restore an official SQL dump into a new local file, never a remote database."""
import json
import os
from pathlib import Path
import re
import sqlite3
import sys


def statements(source):
    """Keep only the current statement; SQLite recognizes strings and triggers."""
    pending = []
    for line in source:
        parts = line.split(";")
        for index, part in enumerate(parts):
            pending.append(part)
            if index < len(parts) - 1:
                pending.append(";")
                candidate = "".join(pending)
                if sqlite3.complete_statement(candidate):
                    yield candidate
                    pending = []
    if "".join(pending).strip():
        raise ValueError("Incomplete SQL statement")


def restore(dump_path, database_path):
    dump_path = Path(dump_path).resolve()
    database_path = Path(database_path).resolve()
    # Validate again when this helper is invoked directly, using bounded reads.
    with dump_path.open("rb") as source:
        first = source.read(4096)
        source.seek(max(0, source.seek(0, 2) - 4096))
        last = source.read(4096)
    if not re.match(rb"\s*PRAGMA foreign_keys=OFF;\s*BEGIN TRANSACTION;", first, re.I) or not re.search(rb"\bCOMMIT;\s*$", last, re.I):
        raise ValueError("Incomplete dump envelope")
    fd = os.open(database_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    connection = sqlite3.connect(database_path, isolation_level=None)
    try:
        with dump_path.open("r", encoding="utf-8", newline="") as source:
            for statement in statements(source):
                # execute preserves the dump's BEGIN/COMMIT, including trigger bodies.
                connection.execute(statement)
        if connection.in_transaction:
            raise ValueError("Dump did not commit")
        integrity = [row[0] for row in connection.execute("PRAGMA integrity_check")]
        foreign_keys = sum(1 for _ in connection.execute("PRAGMA foreign_key_check"))
        tables = connection.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
        counts = {}
        for (name,) in tables:
            quoted = '"' + name.replace('"', '""') + '"'
            counts[name] = str(connection.execute(f"SELECT COUNT(*) FROM {quoted}").fetchone()[0])
        return {"integrity": integrity, "foreignKeyViolations": foreign_keys, "tableCounts": counts,
                "readable": integrity == ["ok"]}
    finally:
        if connection.in_transaction:
            connection.rollback()
        connection.close()


if __name__ == "__main__":
    try:
        if len(sys.argv) != 3:
            raise ValueError("Expected dump and new local database paths")
        print(json.dumps(restore(sys.argv[1], sys.argv[2])))
    except Exception:
        # Exceptions can contain SQL and private values; expose no raw error.
        print("Isolated restore failed; no production database was modified.", file=sys.stderr)
        sys.exit(1)
