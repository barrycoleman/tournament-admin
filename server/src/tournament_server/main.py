from __future__ import annotations

import uvicorn

from tournament_server.app import create_app

app = create_app()


def run() -> None:
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    run()
