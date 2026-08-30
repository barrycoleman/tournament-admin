from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id, get_the_event
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.field import Field
from tournament_server.models.match import Match
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.schemas.match import AllianceRead, MatchCreate, MatchRead

router = APIRouter(prefix="/api/matches", tags=["matches"])


def _to_match_read(match: Match, db: Session) -> MatchRead:
    alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match.id)
    ).scalars().all()
    alliance_reads = []
    for alliance in alliances:
        team_ids = [
            row.team_id
            for row in db.execute(
                select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
            )
            .scalars()
            .all()
        ]
        alliance_reads.append(
            AllianceRead(id=alliance.id, station=alliance.station, team_ids=team_ids)
        )
    return MatchRead(
        id=match.id,
        session_id=match.session_id,
        division_id=match.division_id,
        round_type=match.round_type,
        match_number=match.match_number,
        field_id=match.field_id,
        time_slot=match.time_slot,
        scheduled_time=match.scheduled_time,
        status=match.status,
        alliances=alliance_reads,
    )


@router.post("", response_model=MatchRead, status_code=201)
def create_match(payload: MatchCreate, db: Session = Depends(get_db)) -> MatchRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")

    session_id = payload.session_id
    if session_id is None:
        session_id = event.active_session_id
    if session_id is None:
        raise HTTPException(
            status_code=422, detail="No session_id given and no active session is set"
        )
    if db.get(TournamentSession, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    if len(payload.alliances) != 2:
        raise HTTPException(
            status_code=422, detail="A match must have exactly 2 alliances"
        )
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")
    if payload.field_id is not None and db.get(Field, payload.field_id) is None:
        raise HTTPException(status_code=404, detail="Field not found")
    for alliance_payload in payload.alliances:
        for team_id in alliance_payload.team_ids:
            if db.get(Team, team_id) is None:
                raise HTTPException(
                    status_code=404, detail=f"Team {team_id} not found"
                )

    match = Match(
        session_id=session_id,
        division_id=payload.division_id,
        round_type=payload.round_type,
        match_number=payload.match_number,
        field_id=payload.field_id,
        scheduled_time=payload.scheduled_time,
    )
    db.add(match)
    db.flush()

    for alliance_payload in payload.alliances:
        alliance = Alliance(match_id=match.id, station=alliance_payload.station)
        db.add(alliance)
        db.flush()
        for team_id in alliance_payload.team_ids:
            db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))

    db.commit()
    db.refresh(match)
    return _to_match_read(match, db)


@router.get("", response_model=list[MatchRead])
def list_matches(
    session_id: int = Depends(get_session_id), db: Session = Depends(get_db)
) -> list[MatchRead]:
    matches = db.execute(
        select(Match).where(Match.session_id == session_id)
    ).scalars().all()
    return [_to_match_read(m, db) for m in matches]


@router.get("/{match_id}", response_model=MatchRead)
def get_match(match_id: int, db: Session = Depends(get_db)) -> MatchRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    return _to_match_read(match, db)
