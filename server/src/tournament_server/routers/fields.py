from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_session_id
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.match import Match
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field import FieldCreate, FieldRead, FieldUpdate

router = APIRouter(prefix="/api/fields", tags=["fields"])


@router.post("", response_model=FieldRead, status_code=201)
def create_field(
    payload: FieldCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Field:
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
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
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


@router.patch("/{field_id}", response_model=FieldRead)
def update_field(
    field_id: int,
    payload: FieldUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Field:
    field = db.get(Field, field_id)
    if field is None:
        raise HTTPException(status_code=404, detail="Field not found")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name must not be empty")
    field.name = name
    db.commit()
    db.refresh(field)
    return field


@router.delete("/{field_id}", status_code=204)
def delete_field(
    field_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    field = db.get(Field, field_id)
    if field is None:
        raise HTTPException(status_code=404, detail="Field not found")
    in_use = db.execute(
        select(Match.id).where(Match.field_id == field_id).limit(1)
    ).first()
    if in_use is not None:
        raise HTTPException(
            status_code=409, detail="Field has scheduled matches; clear the schedule first"
        )
    db.delete(field)
    db.commit()
    return Response(status_code=204)
