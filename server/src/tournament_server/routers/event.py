from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.event import Event
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.event import (
    ActiveSessionUpdate,
    EventCreate,
    EventRead,
    GamePluginSelect,
)

router = APIRouter(prefix="/api/event", tags=["event"])


def get_the_event(db: Session) -> Event | None:
    return db.execute(select(Event)).scalars().first()


@router.post("", response_model=EventRead, status_code=201)
def create_event(payload: EventCreate, db: Session = Depends(get_db)) -> Event:
    if get_the_event(db) is not None:
        raise HTTPException(status_code=409, detail="Event already initialized")
    event = Event(name=payload.name)
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@router.get("", response_model=EventRead)
def read_event(db: Session = Depends(get_db)) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    return event


@router.post("/active-session", response_model=EventRead)
def set_active_session(
    payload: ActiveSessionUpdate, db: Session = Depends(get_db)
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
    return event


@router.post("/game-plugin", response_model=EventRead)
def select_game_plugin(
    payload: GamePluginSelect, request: Request, db: Session = Depends(get_db)
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
