from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.division import Division
from tournament_server.models.team import Team
from tournament_server.schemas.division import DivisionCreate, DivisionRead, DivisionUpdate

router = APIRouter(prefix="/api/divisions", tags=["divisions"])


@router.post("", response_model=DivisionRead, status_code=201)
def create_division(
    payload: DivisionCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Division:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    division = Division(
        event_id=event.id, name=payload.name, target_team_count=payload.target_team_count
    )
    db.add(division)
    db.commit()
    db.refresh(division)
    return division


@router.get("", response_model=list[DivisionRead])
def list_divisions(
    db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> list[Division]:
    return list(db.execute(select(Division)).scalars().all())


@router.patch("/{division_id}", response_model=DivisionRead)
def update_division(
    division_id: int,
    payload: DivisionUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Division:
    division = db.get(Division, division_id)
    if division is None:
        raise HTTPException(status_code=404, detail="Division not found")
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"] is None:
        raise HTTPException(status_code=422, detail="name cannot be null")
    for key, value in updates.items():
        setattr(division, key, value)
    db.commit()
    db.refresh(division)
    return division


@router.delete("/{division_id}", status_code=204)
def delete_division(
    division_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    division = db.get(Division, division_id)
    if division is None:
        raise HTTPException(status_code=404, detail="Division not found")
    teams_in_division = list(
        db.execute(select(Team).where(Team.division_id == division_id)).scalars().all()
    )
    for team in teams_in_division:
        team.division_id = None
    db.delete(division)
    db.commit()
    return Response(status_code=204)
