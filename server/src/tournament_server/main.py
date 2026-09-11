from __future__ import annotations

import sys

import uvicorn

from tournament_server.app import create_app
from tournament_server.migrations import SchemaMismatchError

try:
    app = create_app()
except SchemaMismatchError as exc:
    print(f"ERROR: {exc}", file=sys.stderr)
    sys.exit(1)


def run() -> None:
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    run()
