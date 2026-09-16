from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI

from tournament_server.routers import picker
from tournament_server.static_ui import mount_static_admin_ui


def create_picker_app(config_path: Path, static_dir: str | None = None) -> FastAPI:
    """Builds the minimal app served when no tournament path is
    resolvable yet -- see the design spec's "Picker API surface"
    section. Every route here is unauthenticated by design: nothing
    sensitive exists until a tournament has been created."""
    app = FastAPI(title="Tournament Server (picker)")
    app.state.picker_config_path = config_path

    app.include_router(picker.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    mount_static_admin_ui(app, static_dir)
    return app
