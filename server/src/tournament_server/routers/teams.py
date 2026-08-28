from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.team import Team
from tournament_server.routers.event import get_the_event
from tournament_server.schemas.team import TeamCreate, TeamRead, TeamUpdate

router = APIRouter(prefix="/api/teams", tags=["teams"])


@router.post("", response_model=TeamRead, status_code=201)
def create_team(payload: TeamCreate, db: Session = Depends(get_db)) -> Team:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    team = Team(event_id=event.id, **payload.model_dump())
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


@router.get("", response_model=list[TeamRead])
def list_teams(db: Session = Depends(get_db)) -> list[Team]:
    return list(db.execute(select(Team)).scalars().all())


@router.get("/{team_id}", response_model=TeamRead)
def get_team(team_id: int, db: Session = Depends(get_db)) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    return team


@router.patch("/{team_id}", response_model=TeamRead)
def update_team(
    team_id: int, payload: TeamUpdate, db: Session = Depends(get_db)
) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(team, key, value)
    db.commit()
    db.refresh(team)
    return team
