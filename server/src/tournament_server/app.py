from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, Request

from tournament_server import audit  # noqa: F401  (registers AuditLog + hooks)
from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.plugin_registry.discovery import (
    discover_game_plugins,
    discover_scheduler_plugins,
)
from tournament_server.routers import (
    audit_log,
    divisions,
    event,
    field_sets,
    fields,
    matches,
    participation,
    plugins,
    ranking_configuration,
    rankings,
    schedule,
    scores,
    sessions,
    teams,
)
from tournament_server.settings import Settings


def create_app(
    db_path: str | None = None, plugins_root: str | None = None
) -> FastAPI:
    settings = Settings.from_env()
    if db_path is not None:
        settings.db_path = db_path
    if plugins_root is not None:
        settings.plugins_root = plugins_root

    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    init_db(engine)

    app = FastAPI(title="Tournament Server")
    app.state.session_factory = session_factory
    app.state.plugins_root = Path(settings.plugins_root)
    app.state.game_plugins = discover_game_plugins(app.state.plugins_root)
    app.state.scheduler_plugins = discover_scheduler_plugins(app.state.plugins_root)

    @app.middleware("http")
    async def actor_middleware(request: Request, call_next):
        with audit.actor_scope(request.headers.get("x-actor-name", "admin")):
            return await call_next(request)

    app.include_router(event.router)
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

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
