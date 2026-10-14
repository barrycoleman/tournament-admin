from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

# .../tournament_server/static_ui.py -> tournament_server -> src -> server -> repo root
DEFAULT_STATIC_DIR = (
    Path(__file__).resolve().parents[3] / "frontend" / "apps" / "admin" / "dist"
)

DEFAULT_DEVICE_STATIC_DIR = (
    Path(__file__).resolve().parents[3] / "frontend" / "apps" / "device" / "dist"
)


def mount_device_ui(app: FastAPI, device_static_dir: str | None) -> None:
    """Serves the device app (built with base "/device/") under /device/,
    with its own SPA fallback, plus the short /pair address a TV can type.
    Must be registered before mount_static_admin_ui's catch-all."""

    @app.get("/pair", include_in_schema=False)
    def pair_shortcut() -> RedirectResponse:
        return RedirectResponse("/device/", status_code=307)

    resolved = Path(device_static_dir) if device_static_dir else DEFAULT_DEVICE_STATIC_DIR
    if not resolved.is_dir():
        return
    assets_dir = resolved / "assets"
    if assets_dir.is_dir():
        app.mount("/device/assets", StaticFiles(directory=assets_dir), name="device-ui-assets")

    @app.get("/device", include_in_schema=False)
    @app.get("/device/{full_path:path}", include_in_schema=False)
    def serve_device_ui(full_path: str = "") -> FileResponse:
        return FileResponse(resolved / "index.html")


def mount_static_admin_ui(app: FastAPI, static_dir: str | None) -> None:
    """Serves the admin SPA's built static assets, with a catch-all
    fallback to index.html for client-side routes. Shared by create_app
    and create_picker_app so both serve the exact same build -- the SPA
    itself detects picker mode at runtime via an API probe, not via a
    different static build.

    Must be registered AFTER any app-specific routes (e.g. /health): the
    catch-all "/{full_path:path}" route would otherwise shadow them,
    since Starlette matches routes in registration order, not by
    specificity."""
    resolved_static_dir = Path(static_dir) if static_dir else DEFAULT_STATIC_DIR
    if not resolved_static_dir.is_dir():
        # Degrade to "no static JS/CSS served" rather than crashing --
        # StaticFiles raises at construction time if the directory is
        # missing, which would take down startup outright for a partial
        # or custom build.
        return

    assets_dir = resolved_static_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="admin-ui-assets")

    @app.get("/{full_path:path}")
    def serve_admin_ui(full_path: str) -> FileResponse:
        if (
            full_path.startswith(("api/", "ws/", "device/"))
            or full_path in ("health", "device")
        ):
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(resolved_static_dir / "index.html")
