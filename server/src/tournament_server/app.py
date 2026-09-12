from __future__ import annotations

import asyncio
import datetime as dt
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request

from tournament_server import audit, device_auth  # noqa: F401  (audit registers hooks)
from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server import realtime
from tournament_server.db import make_engine, make_session_factory
from tournament_server.migrations import ensure_schema_current
from tournament_server.plugin_registry.discovery import (
    discover_game_plugins,
    discover_scheduler_plugins,
)
from tournament_server.routers import (
    audit_log,
    auth,
    devices,
    divisions,
    event,
    field_sets,
    fields,
    finals,
    matches,
    participation,
    plugins,
    ranking_configuration,
    rankings,
    schedule,
    scores,
    server_info,
    time_sync,
    sessions,
    teams,
    websockets,
)
from tournament_server.settings import Settings


def create_app(
    db_path: str | None = None,
    plugins_root: str | None = None,
    # If omitted, app.state.port falls back to the configured default
    # (Settings.port), which may not match the process's actual bound
    # port if a different entry point (or a port-probing step like
    # find_free_port) binds it elsewhere. The caller owns correctness —
    # pass the real bound port whenever one was resolved.
    port: int | None = None,
) -> FastAPI:
    settings = Settings.from_env()
    if db_path is not None:
        settings.db_path = db_path
    if plugins_root is not None:
        settings.plugins_root = plugins_root
    if port is not None:
        settings.port = port

    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    ensure_schema_current(engine, settings.db_path)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        realtime.set_event_loop(app, asyncio.get_running_loop())
        yield

    app = FastAPI(title="Tournament Server", lifespan=lifespan)
    app.state.session_factory = session_factory
    app.state.plugins_root = Path(settings.plugins_root)
    app.state.game_plugins = discover_game_plugins(app.state.plugins_root)
    app.state.scheduler_plugins = discover_scheduler_plugins(app.state.plugins_root)
    app.state.device_idle_timeout = dt.timedelta(
        minutes=settings.device_idle_timeout_minutes
    )
    app.state.port = settings.port
    realtime.init_realtime_state(app)

    @app.middleware("http")
    async def actor_middleware(request: Request, call_next):
        with audit.actor_scope(request.headers.get("x-actor-name", "admin")):
            return await call_next(request)

    @app.middleware("http")
    async def device_activity_middleware(request: Request, call_next):
        device_token = request.headers.get("x-device-token")
        response = await call_next(request)
        # Only a *successful* request counts as activity. Touching
        # last_seen_at unconditionally — including on a rejected request —
        # would let an idle device silently revive its own admission just
        # by attempting (and failing) a request, defeating the "requires
        # one-click re-admission" goal: see the design spec's §5.
        if device_token and response.status_code < 400:
            db = request.app.state.session_factory()
            try:
                device_auth.touch_device_activity(
                    db, device_token, request.app.state.device_idle_timeout
                )
            finally:
                db.close()
        return response

    app.include_router(event.router)
    app.include_router(auth.router)
    app.include_router(devices.router)
    app.include_router(sessions.router)
    app.include_router(divisions.router)
    app.include_router(field_sets.router)
    app.include_router(fields.router)
    app.include_router(teams.router)
    app.include_router(participation.router)
    app.include_router(audit_log.router)
    app.include_router(plugins.router)
    app.include_router(plugins.scheduler_router)
    app.include_router(matches.router)
    app.include_router(scores.router)
    app.include_router(ranking_configuration.router)
    app.include_router(rankings.router)
    app.include_router(schedule.router)
    app.include_router(finals.router)
    app.include_router(server_info.router)
    app.include_router(time_sync.router)
    app.include_router(websockets.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
