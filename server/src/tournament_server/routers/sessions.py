from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_the_event
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.session import SessionCreate, SessionRead

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=SessionRead, status_code=201)
def create_session(
    payload: SessionCreate, db: Session = Depends(get_db)
) -> TournamentSession:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if payload.timezone is not None:
        try:
            ZoneInfo(payload.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(
                status_code=422, detail=f"Unknown timezone: {payload.timezone!r}"
            )
    session_obj = TournamentSession(
        event_id=event.id,
        label=payload.label,
        session_date=payload.session_date,
        timezone=payload.timezone,
    )
    db.add(session_obj)
    db.commit()
    db.refresh(session_obj)
    return session_obj


@router.get("", response_model=list[SessionRead])
def list_sessions(db: Session = Depends(get_db)) -> list[TournamentSession]:
    return list(db.execute(select(TournamentSession)).scalars().all())
