from __future__ import annotations

from typing import Iterator

from fastapi import Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.event import Event
from tournament_server.plugin_registry.loader import LoadedPlugin


def get_db(request: Request) -> Iterator[Session]:
    db: Session = request.app.state.session_factory()
    try:
        yield db
    finally:
        db.close()


def get_the_event(db: Session) -> Event | None:
    return db.execute(select(Event)).scalars().first()


def get_session_id(
    session_id: int | None = Query(None),
    db: Session = Depends(get_db),
) -> int:
    if session_id is not None:
        return session_id
    event = get_the_event(db)
    if event is None or event.active_session_id is None:
        raise HTTPException(
            status_code=404,
            detail="No session_id given and no active session is set",
        )
    return event.active_session_id


def get_game_plugin_for_event(request: Request, db: Session) -> LoadedPlugin:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if event.game_plugin_name is None:
        raise HTTPException(
            status_code=422, detail="No game plugin has been selected for this event"
        )
    plugin = request.app.state.game_plugins.get(event.game_plugin_name)
    if plugin is None:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Event's selected game plugin {event.game_plugin_name!r} "
                "is not currently loaded"
            ),
        )
    return plugin
