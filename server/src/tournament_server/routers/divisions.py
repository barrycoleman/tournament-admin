from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.division import Division
from tournament_server.routers.event import get_the_event
from tournament_server.schemas.division import DivisionCreate, DivisionRead

router = APIRouter(prefix="/api/divisions", tags=["divisions"])


@router.post("", response_model=DivisionRead, status_code=201)
def create_division(
    payload: DivisionCreate, db: Session = Depends(get_db)
) -> Division:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    division = Division(event_id=event.id, name=payload.name)
    db.add(division)
    db.commit()
    db.refresh(division)
    return division


@router.get("", response_model=list[DivisionRead])
def list_divisions(db: Session = Depends(get_db)) -> list[Division]:
    return list(db.execute(select(Division)).scalars().all())
