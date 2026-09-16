from __future__ import annotations

import asyncio
import datetime as dt
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from sqlalchemy import select

from tournament_server import audit, device_auth  # noqa: F401  (audit registers hooks)
from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server import match_control, realtime
from tournament_server.db import make_engine, make_session_factory, utc_now
from tournament_server.migrations import ensure_schema_current
from tournament_server.models.division import Division
from tournament_server.models.event import Event
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
    picker,
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
from tournament_server.picker_config import resolve_config_path
from tournament_server.settings import Settings
from tournament_server.static_ui import mount_static_admin_ui


async def _recover_in_flight_matches(app: FastAPI) -> None:
    """Runs once at startup, inside the lifespan hook (so the event loop
    Task 3's broadcaster/timers need already exists). Any match whose
    phase is mid-lifecycle (not not_started/ended) and not paused either
    needs its auto-advance rescheduled (deadline still ahead) or fired
    immediately (deadline already passed while the server was down)."""
    from tournament_server.match_control import (
        next_auto_phase,
        phase_duration_seconds,
        schedule_auto_advance,
    )
    from tournament_server.models.event import Event
    from tournament_server.models.match import Match
    from tournament_server.realtime import broadcast_for_session

    db = app.state.session_factory()
    try:
        in_flight = db.execute(
            select(Match).where(
                Match.phase.not_in(("not_started", "ended")),
                Match.paused.is_(False),
            )
        ).scalars().all()
        event_row = db.execute(select(Event)).scalars().first()
        if not in_flight or event_row is None or event_row.game_plugin_name is None:
            return
        game_plugin = app.state.game_plugins.get(event_row.game_plugin_name)
        if game_plugin is None:
            return
        match_format = game_plugin.module.match_format()

        from tournament_server.routers.matches import _auto_advance_match

        for match in in_flight:
            if match.phase_deadline is None:
                continue
            remaining = (match.phase_deadline - utc_now()).total_seconds()
            if remaining <= 0:
                new_phase = next_auto_phase(match.phase)
                if new_phase is None:
                    continue
                match.phase = new_phase
                if new_phase in ("ended", "awaiting_driver"):
                    match.phase_deadline = None
                else:
                    duration = phase_duration_seconds(
                        new_phase,
                        match_format["autonomous_seconds"],
                        match_format["driver_seconds"],
                    )
                    match.phase_deadline = utc_now() + dt.timedelta(seconds=duration)
                db.commit()
                broadcast_for_session(
                    app, db, match.session_id, "match_phase_changed",
                    {
                        "match_id": match.id,
                        "phase": match.phase,
                        "phase_deadline": (
                            match.phase_deadline.isoformat()
                            if match.phase_deadline else None
                        ),
                    },
                )
                if next_auto_phase(match.phase) is not None:
                    schedule_auto_advance(app, match.id, _auto_advance_match(app, match.id))
            elif next_auto_phase(match.phase) is not None:
                # Still within this phase's original deadline — resume with
                # only the actual remaining time, not the full phase
                # duration, or the match would run longer than it should.
                schedule_auto_advance(
                    app, match.id,
                    _auto_advance_match(app, match.id, override_sleep_seconds=remaining),
                )
    finally:
        db.close()


def create_app(
    db_path: str | None = None,
    plugins_root: str | None = None,
    # If omitted, app.state.port falls back to the configured default
    # (Settings.port), which may not match the process's actual bound
    # port if a different entry point (or a port-probing step like
    # find_free_port) binds it elsewhere. The caller owns correctness —
    # pass the real bound port whenever one was resolved.
    port: int | None = None,
    static_dir: str | None = None,
    config_path: Path | None = None,
) -> FastAPI:
    settings = Settings.from_env()
    if db_path is not None:
        settings.db_path = db_path
    if plugins_root is not None:
        settings.plugins_root = plugins_root
    if port is not None:
        settings.port = port
    if static_dir is not None:
        settings.static_dir = static_dir

    if settings.db_path is None:
        raise ValueError("create_app() requires a resolved db_path")

    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    ensure_schema_current(engine, settings.db_path)

    # Self-heal the "every event has >= 1 division" invariant at startup,
    # independent of which ensure_schema_current path was taken above (a
    # fresh database, a genuinely-migrated one, or one silently stamped to
    # head without ever running a data-only migration's upgrade() body —
    # see the backfill migration's docstring and Division's own model for
    # the full reasoning). Idempotent and cheap: one or two indexed lookups,
    # a no-op against a database that already has a division.
    with session_factory() as db:
        event_row = db.execute(select(Event)).scalars().first()
        if event_row is not None:
            has_division = db.execute(
                select(Division.id).where(Division.event_id == event_row.id).limit(1)
            ).first()
            if has_division is None:
                db.add(Division(event_id=event_row.id, name="Division 1"))
                db.commit()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        realtime.set_event_loop(app, asyncio.get_running_loop())
        await _recover_in_flight_matches(app)
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
    app.state.picker_config_path = config_path if config_path is not None else resolve_config_path()
    realtime.init_realtime_state(app)
    match_control.init_match_timer_state(app)

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
    app.include_router(picker.switch_router)
    app.include_router(time_sync.router)
    app.include_router(websockets.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    mount_static_admin_ui(app, settings.static_dir)

    return app
