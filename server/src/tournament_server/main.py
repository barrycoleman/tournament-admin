from __future__ import annotations

import sys

import uvicorn

from tournament_server.app import create_app
from tournament_server.migrations import SchemaMismatchError
from tournament_server.network import NoFreePortError, find_free_port
from tournament_server.settings import Settings

_settings = Settings.from_env()

try:
    _port = find_free_port(_settings.host, _settings.port)
except NoFreePortError as exc:
    print(f"ERROR: {exc}", file=sys.stderr)
    sys.exit(1)

try:
    app = create_app(port=_port)
except SchemaMismatchError as exc:
    print(f"ERROR: {exc}", file=sys.stderr)
    sys.exit(1)


def run() -> None:
    uvicorn.run(app, host=_settings.host, port=_port)


if __name__ == "__main__":
    run()
