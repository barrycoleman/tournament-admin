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


@router.websocket("/ws/active-session")
async def active_session_channel(websocket: WebSocket) -> None:
    role = await _authenticate(websocket, ROLES)
    if role is None:
        return
    await websocket.accept()
    realtime.register_active_session(websocket.app, websocket)
    try:
        while True:
            await websocket.receive_text()
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
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        realtime.unregister_session(websocket.app, session_id, websocket)
