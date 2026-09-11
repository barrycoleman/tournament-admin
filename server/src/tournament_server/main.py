from __future__ import annotations

import sys
from typing import TYPE_CHECKING

import uvicorn

from tournament_server.app import create_app
from tournament_server.migrations import SchemaMismatchError
from tournament_server.network import NoFreePortError, find_free_port
from tournament_server.settings import Settings

if TYPE_CHECKING:
    from fastapi import FastAPI


def _startup() -> tuple[Settings, int, "FastAPI"]:
    """Loads settings, probes for a free port, and builds the app.

    Isolated from module level so it's actually testable: a subprocess
    invocation of this module (see test_main.py) exercises the real
    `ERROR: ... / exit 1` clean-failure path on either NoFreePortError
    or SchemaMismatchError."""
    settings = Settings.from_env()

    try:
        port = find_free_port(settings.host, settings.port)
    except NoFreePortError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    try:
        app = create_app(port=port)
    except SchemaMismatchError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    return settings, port, app


_settings, _port, app = _startup()


def run() -> None:
    try:
        uvicorn.run(app, host=_settings.host, port=_port)
    except OSError as exc:
        # Defense-in-depth for the narrow TOCTOU race between the port
        # probe in _startup() and this real bind — a racing process
        # could steal the port in between. Not expected to be hit in
        # normal operation.
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    run()
