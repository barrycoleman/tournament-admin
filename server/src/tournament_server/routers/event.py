from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from tournament_server.auth import (
    ROLES,
    encrypt_password,
    get_password_encryption_key,
    hash_password,
    require_admin,
)
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.role_credential import RoleCredential
from tournament_server.models.session import TournamentSession
from tournament_server.realtime import broadcast_active_session
from tournament_server.schemas.event import (
    ActiveSessionUpdate,
    EventCreate,
    EventRead,
    EventRename,
    GamePluginSelect,
)

router = APIRouter(prefix="/api/event", tags=["event"])


@router.post("", response_model=EventRead, status_code=201)
def create_event(payload: EventCreate, db: Session = Depends(get_db)) -> Event:
    if get_the_event(db) is not None:
        raise HTTPException(status_code=409, detail="Event already initialized")
    # get_password_encryption_key() commits on its own the first time it
    # lazily creates the key row -- called here, before anything below is
    # staged, so that internal commit can never split this function's own
    # event+division+credentials insert across two transactions.
    password_encrypted = encrypt_password(payload.password, get_password_encryption_key(db))
    event = Event(name=payload.name)
    db.add(event)
    db.flush()  # populates event.id, needed by the Division row below
    db.add(Division(event_id=event.id, name="Division 1"))
    password_hash = hash_password(payload.password)
    for role in ROLES:
        db.add(
            RoleCredential(
                role=role, password_hash=password_hash, password_encrypted=password_encrypted
            )
        )
    db.commit()
    db.refresh(event)
    return event


@router.get("", response_model=EventRead)
def read_event(db: Session = Depends(get_db)) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    return event


@router.patch("", response_model=EventRead)
def update_event(
    payload: EventRename,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Event name cannot be empty")
    event.name = name
    db.commit()
    db.refresh(event)
    return event


@router.post("/active-session", response_model=EventRead)
def set_active_session(
    payload: ActiveSessionUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    session_obj = db.get(TournamentSession, payload.session_id)
    if session_obj is None or session_obj.event_id != event.id:
        raise HTTPException(status_code=404, detail="Session not found")
    event.active_session_id = session_obj.id
    db.commit()
    db.refresh(event)
    broadcast_active_session(
        request.app, "active_session_changed", {"active_session_id": event.active_session_id}
    )
    return event


@router.post("/game-plugin", response_model=EventRead)
def select_game_plugin(
    payload: GamePluginSelect,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if event.game_plugin_name is not None:
        raise HTTPException(
            status_code=409,
            detail="A game plugin has already been selected for this event",
        )
    if payload.name not in request.app.state.game_plugins:
        raise HTTPException(
            status_code=404, detail=f"No game plugin named {payload.name!r} is loaded"
        )
    event.game_plugin_name = payload.name
    db.commit()
    db.refresh(event)
    return event
