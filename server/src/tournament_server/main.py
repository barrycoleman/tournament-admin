from __future__ import annotations

import sys
from typing import TYPE_CHECKING

import uvicorn

from tournament_server.app import create_app
from tournament_server.migrations import SchemaMismatchError
from tournament_server.network import NoFreePortError, find_free_port
from tournament_server.picker_app import create_picker_app
from tournament_server.picker_config import (
    load_config,
    resolve_active_db_path,
    resolve_config_path,
    save_config,
)
from tournament_server.settings import Settings

if TYPE_CHECKING:
    from fastapi import FastAPI


def _startup() -> tuple[Settings, int, "FastAPI"]:
    """Loads settings, probes for a free port, and builds either the
    normal app (a tournament path is resolved) or the picker app (none
    is yet). Isolated from module level so it's actually testable: a
    subprocess invocation of this module (see test_main.py) exercises
    the real `ERROR: ... / exit 1` clean-failure path on NoFreePortError
    or SchemaMismatchError, and both the picker-mode and normal-mode
    boot paths."""
    settings = Settings.from_env()
    config_path = resolve_config_path()

    try:
        port = find_free_port(settings.host, settings.port)
    except NoFreePortError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    resolved_db_path = resolve_active_db_path(settings.db_path)

    if resolved_db_path is None:
        app = create_picker_app(config_path, static_dir=settings.static_dir)
        return settings, port, app

    try:
        app = create_app(
            db_path=resolved_db_path,
            port=port,
            static_dir=settings.static_dir,
            config_path=config_path,
        )
    except SchemaMismatchError as exc:
        if settings.db_path is None:
            # resolved_db_path came from the picker config's
            # last_opened_path (not the legacy env var override) --
            # clear it so the *next* restart falls back to the picker
            # instead of retrying the same bad file forever.
            config = load_config(config_path)
            config.last_opened_path = None
            save_config(config_path, config)
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
