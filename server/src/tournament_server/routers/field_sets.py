from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id
from tournament_server.models.division import Division
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field_set import FieldSetCreate, FieldSetRead, FieldSetUpdate

router = APIRouter(prefix="/api/field-sets", tags=["field-sets"])


@router.post("", response_model=FieldSetRead, status_code=201)
def create_field_set(payload: FieldSetCreate, db: Session = Depends(get_db)) -> FieldSet:
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")
    field_set = FieldSet(
        session_id=payload.session_id,
        name=payload.name,
        division_id=payload.division_id,
    )
    db.add(field_set)
    db.commit()
    db.refresh(field_set)
    return field_set


@router.patch("/{field_set_id}", response_model=FieldSetRead)
def update_field_set(
    field_set_id: int, payload: FieldSetUpdate, db: Session = Depends(get_db)
) -> FieldSet:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")
    field_set.division_id = payload.division_id
    db.commit()
    db.refresh(field_set)
    return field_set


@router.get("", response_model=list[FieldSetRead])
def list_field_sets(
    session_id: int = Depends(get_session_id), db: Session = Depends(get_db)
) -> list[FieldSet]:
    return list(
        db.execute(
            select(FieldSet).where(FieldSet.session_id == session_id)
        ).scalars().all()
    )
