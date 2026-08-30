from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field_set import FieldSetCreate, FieldSetRead

router = APIRouter(prefix="/api/field-sets", tags=["field-sets"])


@router.post("", response_model=FieldSetRead, status_code=201)
def create_field_set(payload: FieldSetCreate, db: Session = Depends(get_db)) -> FieldSet:
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    field_set = FieldSet(session_id=payload.session_id, name=payload.name)
    db.add(field_set)
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
