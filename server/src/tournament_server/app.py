from __future__ import annotations

from fastapi import FastAPI

from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.routers import divisions, event, participation, sessions, teams
from tournament_server.settings import Settings


def create_app(db_path: str | None = None) -> FastAPI:
    settings = Settings(db_path=db_path) if db_path else Settings.from_env()
    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    init_db(engine)

    app = FastAPI(title="Tournament Server")
    app.state.session_factory = session_factory

    app.include_router(event.router)
    app.include_router(sessions.router)
    app.include_router(divisions.router)
    app.include_router(teams.router)
    app.include_router(participation.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
