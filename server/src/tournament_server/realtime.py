from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import WebSocket

from tournament_server.deps import get_the_event

if TYPE_CHECKING:
    from fastapi import FastAPI
    from sqlalchemy.orm import Session


class ConnectionRegistry:
    def __init__(self) -> None:
        self.active_session: set[WebSocket] = set()
        self.by_session: dict[int, set[WebSocket]] = {}
        self.event_loop: asyncio.AbstractEventLoop | None = None


def init_realtime_state(app: "FastAPI") -> None:
    app.state.realtime = ConnectionRegistry()


def set_event_loop(app: "FastAPI", loop: asyncio.AbstractEventLoop) -> None:
    app.state.realtime.event_loop = loop


def register_active_session(app: "FastAPI", websocket: WebSocket) -> None:
    app.state.realtime.active_session.add(websocket)


def unregister_active_session(app: "FastAPI", websocket: WebSocket) -> None:
    app.state.realtime.active_session.discard(websocket)


def register_session(app: "FastAPI", session_id: int, websocket: WebSocket) -> None:
    app.state.realtime.by_session.setdefault(session_id, set()).add(websocket)


def unregister_session(app: "FastAPI", session_id: int, websocket: WebSocket) -> None:
    subscribers = app.state.realtime.by_session.get(session_id)
    if subscribers is not None:
        subscribers.discard(websocket)
        if not subscribers:
            del app.state.realtime.by_session[session_id]


async def _send_to_all(subscribers: set[WebSocket], event: str, data: dict) -> None:
    message = {"event": event, "data": data}
    dead: list[WebSocket] = []
    for ws in list(subscribers):
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        subscribers.discard(ws)


def broadcast_active_session(app: "FastAPI", event: str, data: dict) -> None:
    registry = app.state.realtime
    if registry.event_loop is None or not registry.active_session:
        return
    asyncio.run_coroutine_threadsafe(
        _send_to_all(registry.active_session, event, data), registry.event_loop
    )


def broadcast_session(app: "FastAPI", session_id: int, event: str, data: dict) -> None:
    registry = app.state.realtime
    subscribers = registry.by_session.get(session_id)
    if registry.event_loop is None or not subscribers:
        return
    asyncio.run_coroutine_threadsafe(
        _send_to_all(subscribers, event, data), registry.event_loop
    )


def broadcast_for_session(
    app: "FastAPI", db: "Session", session_id: int, event: str, data: dict
) -> None:
    broadcast_session(app, session_id, event, data)
    event_row = get_the_event(db)
    if event_row is not None and event_row.active_session_id == session_id:
        broadcast_active_session(app, event, data)


def broadcast_new_finals_matches(
    app: "FastAPI", db: "Session", bracket_id: int, match_ids_before: set[int]
) -> None:
    from sqlalchemy import select

    from tournament_server.models.match import Match

    current_matches = db.execute(
        select(Match).where(Match.finals_bracket_id == bracket_id)
    ).scalars().all()
    for match in current_matches:
        if match.id in match_ids_before:
            continue
        broadcast_for_session(
            app, db, match.session_id, "new_match_created",
            {
                "match_id": match.id,
                "session_id": match.session_id,
                "division_id": match.division_id,
                "field_id": match.field_id,
            },
        )
