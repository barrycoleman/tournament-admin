from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_session_id
from tournament_server.models.division import Division
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field_set import FieldSetCreate, FieldSetRead, FieldSetUpdate, QueuedMatchWrite, TimeoutWrite
from tournament_server.services import displays, qualification

router = APIRouter(prefix="/api/field-sets", tags=["field-sets"])


@router.post("", response_model=FieldSetRead, status_code=201)
def create_field_set(
    payload: FieldSetCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FieldSet:
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
    db.flush()
    displays.ensure_audience_group(db, field_set)
    db.commit()
    db.refresh(field_set)
    return field_set


@router.patch("/{field_set_id}", response_model=FieldSetRead)
def update_field_set(
    field_set_id: int,
    payload: FieldSetUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FieldSet:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates:
        name = (updates["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="name must not be empty")
        field_set.name = name
    if "division_id" in updates:
        division_id = updates["division_id"]
        if division_id is not None and db.get(Division, division_id) is None:
            raise HTTPException(status_code=404, detail="Division not found")
        field_set.division_id = division_id
    db.commit()
    db.refresh(field_set)
    return field_set


@router.get("", response_model=list[FieldSetRead])
def list_field_sets(
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[FieldSet]:
    return list(
        db.execute(
            select(FieldSet).where(FieldSet.session_id == session_id)
        ).scalars().all()
    )


@router.delete("/{field_set_id}", status_code=204)
def delete_field_set(
    field_set_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    # Checked before the match check: a finals bracket's own run matches
    # also sit on this set's fields, and the bracket is the reason to name.
    used_by_bracket = db.execute(
        select(FinalsBracket.id).where(FinalsBracket.field_set_id == field_set_id).limit(1)
    ).first()
    if used_by_bracket is not None:
        raise HTTPException(status_code=409, detail="Field set is used by a finals bracket")
    fields = db.execute(
        select(Field).where(Field.field_set_id == field_set_id)
    ).scalars().all()
    field_ids = [field.id for field in fields]
    if field_ids:
        in_use = db.execute(
            select(Match.id).where(Match.field_id.in_(field_ids)).limit(1)
        ).first()
        if in_use is not None:
            raise HTTPException(
                status_code=409,
                detail="Field set has scheduled matches; clear the schedule first",
            )
    displays.delete_field_set_groups(db, field_set_id)
    for field in fields:
        db.delete(field)
    db.flush()
    db.delete(field_set)
    db.commit()
    return Response(status_code=204)


def _field_set_or_404(db: Session, field_set_id: int) -> FieldSet:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    return field_set


@router.put("/{field_set_id}/queued-match", response_model=FieldSetRead)
def queue_match(
    field_set_id: int,
    payload: QueuedMatchWrite,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FieldSet:
    """Sets or clears the field group's next-match override (spec section 6.1)."""
    field_set = _field_set_or_404(db, field_set_id)
    if payload.match_id is not None:
        match = db.get(Match, payload.match_id)
        if (
            match is None
            or match.field_id not in displays.field_ids_for_set(db, field_set_id)
            or match.phase != "not_started"
            or match.status in ("completed", qualification.NOT_PLAYED)
        ):
            raise HTTPException(status_code=422, detail="Pick a match on this field group that hasn't started.")
    field_set.queued_match_id = payload.match_id
    db.commit()
    db.refresh(field_set)
    displays.notify_field_set_changed(request.app, field_set_id)
    return field_set


@router.post("/{field_set_id}/timeout", response_model=FieldSetRead)
def start_timeout(
    field_set_id: int,
    payload: TimeoutWrite,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FieldSet:
    field_set = _field_set_or_404(db, field_set_id)
    field_set.timeout_deadline = utc_now() + dt.timedelta(seconds=payload.seconds)
    db.commit()
    db.refresh(field_set)
    displays.notify_field_set_changed(request.app, field_set_id)
    return field_set


@router.delete("/{field_set_id}/timeout", status_code=204)
def cancel_timeout(
    field_set_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    field_set = _field_set_or_404(db, field_set_id)
    field_set.timeout_deadline = None
    db.commit()
    displays.notify_field_set_changed(request.app, field_set_id)
    return Response(status_code=204)
