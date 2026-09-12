from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.auth import ROLES, decode_role_from_token

router = APIRouter(tags=["websockets"])


async def _authenticate(websocket: WebSocket, allowed_roles: tuple[str, ...]) -> str | None:
    token = websocket.query_params.get("token")
    if token is None:
        await websocket.close(code=1008)
        return None
    db: Session = websocket.app.state.session_factory()
    try:
        role = decode_role_from_token(token, db)
    except ValueError:
        await websocket.close(code=1008)
        return None
    finally:
        db.close()
    if role != "admin" and role not in allowed_roles:
        await websocket.close(code=1008)
        return None
    return role


async def _drain_until_disconnect(websocket: WebSocket) -> None:
    """Reads and discards whatever the client sends until it disconnects.

    Both channels are receive-only — a client never sends application
    messages over the socket, and the server never inspects one — so this
    uses the raw `receive()` rather than `receive_text()`. `receive_text()`
    raises a bare `KeyError` (not a graceful disconnect) on a binary frame,
    since it reaches for `message["text"]` unconditionally; `receive()`
    tolerates every frame type identically.
    """
    while True:
        message = await websocket.receive()
        if message["type"] == "websocket.disconnect":
            return


@router.websocket("/ws/active-session")
async def active_session_channel(websocket: WebSocket) -> None:
    role = await _authenticate(websocket, ROLES)
    if role is None:
        return
    await websocket.accept()
    realtime.register_active_session(websocket.app, websocket)
    try:
        await _drain_until_disconnect(websocket)
    except WebSocketDisconnect:
        pass
    finally:
        realtime.unregister_active_session(websocket.app, websocket)


@router.websocket("/ws/session/{session_id}")
async def session_channel(websocket: WebSocket, session_id: int) -> None:
    role = await _authenticate(websocket, ())
    if role is None:
        return
    await websocket.accept()
    realtime.register_session(websocket.app, session_id, websocket)
    try:
        await _drain_until_disconnect(websocket)
    except WebSocketDisconnect:
        pass
    finally:
        realtime.unregister_session(websocket.app, session_id, websocket)
