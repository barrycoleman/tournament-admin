from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field import FieldCreate, FieldRead

router = APIRouter(prefix="/api/fields", tags=["fields"])


@router.post("", response_model=FieldRead, status_code=201)
def create_field(payload: FieldCreate, db: Session = Depends(get_db)) -> Field:
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    field_set_id = payload.field_set_id
    if field_set_id is None:
        existing_sets = db.execute(
            select(FieldSet).where(FieldSet.session_id == payload.session_id)
        ).scalars().all()
        if len(existing_sets) == 0:
            default_set = FieldSet(session_id=payload.session_id, name="Main Fields")
            db.add(default_set)
            db.flush()
            field_set_id = default_set.id
        elif len(existing_sets) == 1:
            field_set_id = existing_sets[0].id
        else:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Multiple FieldSets exist for this session; field_set_id "
                    "must be specified"
                ),
            )
    else:
        field_set = db.get(FieldSet, field_set_id)
        if field_set is None or field_set.session_id != payload.session_id:
            raise HTTPException(status_code=404, detail="FieldSet not found")

    field = Field(field_set_id=field_set_id, name=payload.name)
    db.add(field)
    db.commit()
    db.refresh(field)
    return field


@router.get("", response_model=list[FieldRead])
def list_fields(
    session_id: int = Depends(get_session_id), db: Session = Depends(get_db)
) -> list[Field]:
    field_set_ids = [
        row.id
        for row in db.execute(
            select(FieldSet).where(FieldSet.session_id == session_id)
        ).scalars().all()
    ]
    if not field_set_ids:
        return []
    return list(
        db.execute(
            select(Field).where(Field.field_set_id.in_(field_set_ids))
        ).scalars().all()
    )
