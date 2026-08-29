from __future__ import annotations

import argparse
import sys
from pathlib import Path

from tournament_server.plugin_registry.conformance import run_conformance_checks


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="tm")
    subparsers = parser.add_subparsers(dest="command", required=True)

    test_plugin_parser = subparsers.add_parser(
        "test-plugin", help="Run conformance checks against a game plugin folder"
    )
    test_plugin_parser.add_argument("path", type=str)

    args = parser.parse_args(argv)

    if args.command == "test-plugin":
        return _run_test_plugin(Path(args.path))

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


def run() -> None:
    sys.exit(main())


if __name__ == "__main__":
    run()
