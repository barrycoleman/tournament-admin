from __future__ import annotations

import argparse
import sys
from pathlib import Path

from tournament_server.plugin_registry.conformance import run_conformance_checks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tm")
    subparsers = parser.add_subparsers(dest="command", required=True)

    test_plugin_parser = subparsers.add_parser(
        "test-plugin", help="Run conformance checks against a plugin folder"
    )
    test_plugin_parser.add_argument("path", type=str)

    migrate_parser = subparsers.add_parser(
        "migrate", help="Apply any pending database schema migrations"
    )
    migrate_parser.add_argument(
        "--db-path", type=str, default=None, help="Path to the SQLite database file"
    )

    args = parser.parse_args(argv)

    if args.command == "test-plugin":
        return _run_test_plugin(Path(args.path))
    if args.command == "migrate":
        return _run_migrate(args.db_path)

    return 1


def _run_test_plugin(plugin_dir: Path) -> int:
    report = run_conformance_checks(plugin_dir)
    for check in report.checks:
        status = "PASS" if check.passed else "FAIL"
        line = f"[{status}] {check.name}"
        if check.message:
            line += f": {check.message}"
        print(line)

    if report.passed:
        print(f"\nAll checks passed for {report.plugin_name!r}.")
        return 0

    print(f"\nConformance checks FAILED for {plugin_dir}.")
    return 1


def _run_migrate(db_path: str | None) -> int:
    from tournament_server.db import make_engine
    from tournament_server.migrations import (
        MigrationOutcome,
        SchemaMismatchError,
        ensure_schema_current,
    )
    from tournament_server.picker_config import resolve_active_db_path

    resolved_db_path = resolve_active_db_path(db_path)
    if resolved_db_path is None:
        print(
            "ERROR: no database path given. Pass --db-path, set "
            "TOURNAMENT_DB_PATH, or open a tournament through the server first."
        )
        return 1

    engine = make_engine(resolved_db_path)

    try:
        outcome = ensure_schema_current(engine, resolved_db_path)
    except SchemaMismatchError as exc:
        print(f"ERROR: {exc}")
        return 1

    messages = {
        MigrationOutcome.ALREADY_CURRENT: f"{resolved_db_path}: schema already up to date.",
        MigrationOutcome.FRESH_INSTALL: f"{resolved_db_path}: created fresh with the current schema.",
        MigrationOutcome.STAMPED_BASELINE: (
            f"{resolved_db_path}: matched the current baseline schema; stamped as up to date."
        ),
        MigrationOutcome.UPGRADED: (
            f"{resolved_db_path}: applied pending migrations; a pre-migration backup was created."
        ),
    }
    print(messages[outcome])
    return 0


def run() -> None:
    sys.exit(main())


if __name__ == "__main__":
    run()
