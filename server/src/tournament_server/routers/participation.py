from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.schemas.participation import (
    ParticipationCreate,
    ParticipationRead,
)

router = APIRouter(prefix="/api/sessions", tags=["participation"])


@router.post(
    "/{session_id}/participants", response_model=ParticipationRead, status_code=201
)
def add_participant(
    session_id: int, payload: ParticipationCreate, db: Session = Depends(get_db)
) -> SessionParticipation:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    team = db.get(Team, payload.team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    participation = SessionParticipation(
        session_id=session_id, team_id=payload.team_id, checked_in=payload.checked_in
    )
    db.add(participation)
    db.commit()
    db.refresh(participation)
    return participation


@router.get(
    "/{session_id}/participants", response_model=list[ParticipationRead]
)
def list_participants(
    session_id: int, db: Session = Depends(get_db)
) -> list[SessionParticipation]:
    return list(
        db.execute(
            select(SessionParticipation).where(
                SessionParticipation.session_id == session_id
            )
        )
        .scalars()
        .all()
    )
