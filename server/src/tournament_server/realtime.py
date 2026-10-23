from __future__ import annotations

import asyncio
import contextlib
from typing import TYPE_CHECKING

from fastapi import WebSocket

from tournament_server.deps import get_the_event

if TYPE_CHECKING:
    from fastapi import FastAPI
    from sqlalchemy.orm import Session


# Close code for a paired device whose state changed (disabled, deleted or a
# new role): the device reconnects and sees its new state at once.
DEVICE_CHANGED_CLOSE_CODE = 4403


class ConnectionRegistry:
    def __init__(self) -> None:
        self.active_session: set[WebSocket] = set()
        # The caller's role for each active-session socket, so a broadcast
        # can go to some roles only (live scoring design §8).
        self.active_roles: dict[WebSocket, str] = {}
        self.by_session: dict[int, set[WebSocket]] = {}
        self.by_device: dict[int, set[WebSocket]] = {}
        self.event_loop: asyncio.AbstractEventLoop | None = None


def init_realtime_state(app: "FastAPI") -> None:
    app.state.realtime = ConnectionRegistry()


def set_event_loop(app: "FastAPI", loop: asyncio.AbstractEventLoop) -> None:
    app.state.realtime.event_loop = loop


def register_active_session(app: "FastAPI", websocket: WebSocket, role: str) -> None:
    app.state.realtime.active_session.add(websocket)
    app.state.realtime.active_roles[websocket] = role


def unregister_active_session(app: "FastAPI", websocket: WebSocket) -> None:
    app.state.realtime.active_session.discard(websocket)
    app.state.realtime.active_roles.pop(websocket, None)


def register_session(app: "FastAPI", session_id: int, websocket: WebSocket) -> None:
    app.state.realtime.by_session.setdefault(session_id, set()).add(websocket)


def unregister_session(app: "FastAPI", session_id: int, websocket: WebSocket) -> None:
    subscribers = app.state.realtime.by_session.get(session_id)
    if subscribers is not None:
        subscribers.discard(websocket)
        if not subscribers:
            del app.state.realtime.by_session[session_id]


def register_device_socket(app: "FastAPI", device_id: int, websocket: WebSocket) -> None:
    """Records a device's socket. Its first socket makes it connected, which
    the admin's TV list shows, so admins are told."""
    sockets = app.state.realtime.by_device.setdefault(device_id, set())
    connected_before = bool(sockets)
    sockets.add(websocket)
    if not connected_before:
        broadcast_active_session(app, "devices_changed", {}, roles=("admin",))


def unregister_device_socket(app: "FastAPI", device_id: int, websocket: WebSocket) -> None:
    """Forgets a device's socket; once its last one is gone it is no longer
    connected, and admins are told."""
    sockets = app.state.realtime.by_device.get(device_id)
    if sockets is not None:
        sockets.discard(websocket)
        if not sockets:
            del app.state.realtime.by_device[device_id]
            broadcast_active_session(app, "devices_changed", {}, roles=("admin",))


def close_device_sockets(app: "FastAPI", device_id: int) -> None:
    """Closes a device's open sockets so it reconnects and sees its new state
    (disabled, deleted or a different role)."""
    registry = app.state.realtime
    if registry.event_loop is None:
        return

    async def _close() -> None:
        for websocket in list(registry.by_device.get(device_id, ())):
            with contextlib.suppress(Exception):
                await websocket.close(code=DEVICE_CHANGED_CLOSE_CODE)

    asyncio.run_coroutine_threadsafe(_close(), registry.event_loop)


async def _send_to_all(
    subscribers: set[WebSocket], event: str, data: dict, targets: list[WebSocket] | None = None
) -> None:
    """Sends to `targets` (every subscriber when None) and drops any socket
    that fails from `subscribers`."""
    message = {"event": event, "data": data}
    dead: list[WebSocket] = []
    for ws in list(subscribers) if targets is None else targets:
        try:
            await ws.send_json(message)
        except Exception:
            dead.append(ws)
    for ws in dead:
        subscribers.discard(ws)


def broadcast_active_session(
    app: "FastAPI", event: str, data: dict, roles: tuple[str, ...] | None = None
) -> None:
    """Sends on the active-session channel: to every socket, or with `roles`
    only to sockets whose caller has one of them. "admin" is never implied;
    list it when admins should get the event."""
    registry = app.state.realtime
    if registry.event_loop is None or not registry.active_session:
        return

    # The registry is mutated on the event-loop thread, so the targets are picked there too.
    async def _send() -> None:
        targets = [
            ws for ws in list(registry.active_session)
            if roles is None or registry.active_roles.get(ws) in roles
        ]
        await _send_to_all(registry.active_session, event, data, targets)
        for ws in [ws for ws in registry.active_roles if ws not in registry.active_session]:
            del registry.active_roles[ws]

    asyncio.run_coroutine_threadsafe(_send(), registry.event_loop)


def broadcast_session(app: "FastAPI", session_id: int, event: str, data: dict) -> None:
    registry = app.state.realtime
    subscribers = registry.by_session.get(session_id)
    if registry.event_loop is None or not subscribers:
        return
    asyncio.run_coroutine_threadsafe(
        _send_to_all(subscribers, event, data), registry.event_loop
    )


def broadcast_all(app: "FastAPI", event: str, data: dict) -> None:
    """Sends to every connected socket: the active-session channel and every
    per-session channel. Dead sockets are left for their own channel's next
    broadcast or unregister to clean up."""
    registry = app.state.realtime
    if registry.event_loop is None:
        return

    # The registry is mutated on the event-loop thread, so the union is built there too.
    async def _send() -> None:
        sockets = set(registry.active_session)
        for subscribers in registry.by_session.values():
            sockets |= subscribers
        if sockets:
            await _send_to_all(sockets, event, data)

    asyncio.run_coroutine_threadsafe(_send(), registry.event_loop)


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


def send_to_device(app: "FastAPI", device_id: int, event: str, data: dict) -> None:
    """Sends to one paired device's open sockets only (display_identify)."""
    registry = app.state.realtime
    if registry.event_loop is None:
        return

    async def _send() -> None:
        sockets = registry.by_device.get(device_id)
        if sockets:
            await _send_to_all(sockets, event, data)

    asyncio.run_coroutine_threadsafe(_send(), registry.event_loop)


def send_to_devices_and_admins(app: "FastAPI", device_ids: list[int], event: str, data: dict) -> None:
    """Sends to every admin on the active-session channel and to the listed
    devices' sockets, each socket once (scorer_binding_changed)."""
    registry = app.state.realtime
    if registry.event_loop is None:
        return

    async def _send() -> None:
        sockets = {ws for ws in registry.active_session if registry.active_roles.get(ws) == "admin"}
        for device_id in device_ids:
            sockets |= registry.by_device.get(device_id, set())
        if sockets:
            await _send_to_all(sockets, event, data)

    asyncio.run_coroutine_threadsafe(_send(), registry.event_loop)
