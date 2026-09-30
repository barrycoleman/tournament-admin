from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
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
    session_id: int,
    payload: ParticipationCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionParticipation:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    team = db.get(Team, payload.team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")

    participation = db.execute(
        select(SessionParticipation).where(
            SessionParticipation.session_id == session_id,
            SessionParticipation.team_id == payload.team_id,
        )
    ).scalars().first()
    if participation is not None:
        participation.checked_in = payload.checked_in
        db.commit()
        db.refresh(participation)
        return participation

    participation = SessionParticipation(
        session_id=session_id, team_id=payload.team_id, checked_in=payload.checked_in
    )
    db.add(participation)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent request inserted this (session_id, team_id) row
        # between our SELECT and this INSERT -- fall back to updating the
        # row it created, since the caller's intent (this team's
        # checked_in state) is still achievable without a 409.
        db.rollback()
        participation = db.execute(
            select(SessionParticipation).where(
                SessionParticipation.session_id == session_id,
                SessionParticipation.team_id == payload.team_id,
            )
        ).scalars().first()
        participation.checked_in = payload.checked_in
        db.commit()
    db.refresh(participation)
    return participation


@router.get(
    "/{session_id}/participants", response_model=list[ParticipationRead]
)
def list_participants(
    session_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
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
