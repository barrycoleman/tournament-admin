from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.orm import Session

from tournament_server.auth import (
    ROLES,
    encrypt_password,
    get_password_encryption_key,
    hash_password,
    require_admin,
    require_any_role,
)
from tournament_server.deps import get_db, get_event_or_404, get_the_event
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.role_credential import RoleCredential
from tournament_server.models.session import TournamentSession
from tournament_server.realtime import broadcast_active_session, broadcast_all
from tournament_server.schemas.event import (
    ActiveSessionUpdate,
    EventCreate,
    EventRead,
    EventRename,
    GamePluginChangePreview,
    GamePluginSelect,
    MatchFormatRead,
)
from tournament_server.services import game_plugin as game_plugin_service

router = APIRouter(prefix="/api/event", tags=["event"])


def _event_read(db: Session, event: Event) -> EventRead:
    return EventRead(
        id=event.id,
        name=event.name,
        active_session_id=event.active_session_id,
        game_plugin_name=event.game_plugin_name,
        game_plugin_locked=game_plugin_service.is_locked(db, event),
        created_at=event.created_at,
    )


@router.post("", response_model=EventRead, status_code=201)
def create_event(payload: EventCreate, db: Session = Depends(get_db)) -> EventRead:
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
    return _event_read(db, event)


@router.get("", response_model=EventRead)
def read_event(db: Session = Depends(get_db)) -> EventRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    return _event_read(db, event)


@router.get("/match-format", response_model=MatchFormatRead)
def read_match_format(
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> MatchFormatRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if event.game_plugin_name is None:
        raise HTTPException(
            status_code=422, detail="No game plugin has been selected for this event"
        )
    game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
    if game_plugin is None:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Event's selected game plugin {event.game_plugin_name!r} is not "
                "currently loaded"
            ),
        )
    match_format = game_plugin.module.match_format()
    return MatchFormatRead(
        round_types=list(match_format["round_types"]),
        teams_per_alliance=match_format["teams_per_alliance"],
        alliance_count=match_format["alliance_count"],
        match_duration_seconds=(
            match_format["autonomous_seconds"] + match_format["driver_seconds"]
        ),
        default_cycle_time_seconds=match_format.get("default_cycle_time_seconds"),
    )


@router.patch("", response_model=EventRead)
def update_event(
    payload: EventRename,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> EventRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="Event name cannot be empty")
    event.name = name
    db.commit()
    db.refresh(event)
    return _event_read(db, event)


@router.post("/active-session", response_model=EventRead)
def set_active_session(
    payload: ActiveSessionUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> EventRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    session_obj = db.get(TournamentSession, payload.session_id)
    if session_obj is None or session_obj.event_id != event.id:
        raise HTTPException(status_code=404, detail="Session not found")
    request.app.state.backups.snapshot_quietly("before-active-session")
    event.active_session_id = session_obj.id
    db.commit()
    db.refresh(event)
    broadcast_active_session(
        request.app, "active_session_changed", {"active_session_id": event.active_session_id}
    )
    return _event_read(db, event)


def _change_game_plugin(
    request: Request, db: Session, event: Event, target_name: str | None, dry_run: bool
) -> EventRead | GamePluginChangePreview:
    if target_name == event.game_plugin_name:
        return game_plugin_service.empty_preview() if dry_run else _event_read(db, event)
    if game_plugin_service.is_locked(db, event):
        raise HTTPException(status_code=409, detail=game_plugin_service.LOCKED_DETAIL)
    target = request.app.state.game_plugins.get(target_name) if target_name is not None else None
    if dry_run:
        return game_plugin_service.preview(db, event, target)
    request.app.state.backups.snapshot_quietly("before-game-plugin")
    game_plugin_service.reset_settings(db, event)
    event.game_plugin_name = target_name
    db.commit()
    db.refresh(event)
    broadcast_all(request.app, "game_plugin_changed", {"game_plugin_name": target_name})
    return _event_read(db, event)


@router.post("/game-plugin", response_model=EventRead | GamePluginChangePreview)
def select_game_plugin(
    payload: GamePluginSelect,
    request: Request,
    dry_run: bool = Query(False),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> EventRead | GamePluginChangePreview:
    """Chooses, or while unused changes, the event's game plugin. Choosing the
    current plugin again changes nothing."""
    event = get_event_or_404(db)
    if payload.name not in request.app.state.game_plugins:
        raise HTTPException(
            status_code=404, detail=f"No game plugin named {payload.name!r} is loaded"
        )
    return _change_game_plugin(request, db, event, payload.name, dry_run)


@router.delete("/game-plugin", response_model=EventRead | GamePluginChangePreview)
def clear_game_plugin(
    request: Request,
    dry_run: bool = Query(False),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> EventRead | GamePluginChangePreview:
    """Clears the event's game plugin while it is unused."""
    return _change_game_plugin(request, db, get_event_or_404(db), None, dry_run)
