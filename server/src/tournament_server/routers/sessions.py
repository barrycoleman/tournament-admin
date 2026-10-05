from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.realtime import broadcast_active_session
from tournament_server.schemas.field_set import FieldSetRead
from tournament_server.schemas.session import (
    CopyFieldsRequest,
    SessionCreate,
    SessionRead,
    SessionUpdate,
)
from tournament_server.services.deletion import (
    delete_session,
    scored_session_ids,
    session_has_scores,
)

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


def _to_read(session_obj: TournamentSession, has_scored_matches: bool) -> SessionRead:
    read = SessionRead.model_validate(session_obj)
    read.has_scored_matches = has_scored_matches
    return read


@router.post("", response_model=SessionRead, status_code=201)
def create_session(
    payload: SessionCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if payload.timezone is not None:
        try:
            ZoneInfo(payload.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(
                status_code=422, detail=f"Unknown timezone: {payload.timezone!r}"
            )
    session_obj = TournamentSession(
        event_id=event.id,
        label=payload.label,
        session_date=payload.session_date,
        timezone=payload.timezone,
    )
    db.add(session_obj)
    db.commit()
    db.refresh(session_obj)
    return _to_read(session_obj, False)


@router.patch("/{session_id}", response_model=SessionRead)
def update_session(
    session_id: int,
    payload: SessionUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionRead:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    updates = payload.model_dump(exclude_unset=True)
    if "label" in updates and updates["label"] is None:
        raise HTTPException(status_code=422, detail="label cannot be null")
    if "timezone" in updates and updates["timezone"] is not None:
        try:
            ZoneInfo(updates["timezone"])
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(
                status_code=422, detail=f"Unknown timezone: {updates['timezone']!r}"
            )
    for key, value in updates.items():
        setattr(session_obj, key, value)
    db.commit()
    db.refresh(session_obj)
    return _to_read(session_obj, session_has_scores(db, session_obj.id))


@router.get("", response_model=list[SessionRead])
def list_sessions(
    db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> list[SessionRead]:
    scored = scored_session_ids(db)
    return [
        _to_read(session_obj, session_obj.id in scored)
        for session_obj in db.execute(select(TournamentSession)).scalars().all()
    ]


@router.delete("/{session_id}", status_code=204)
def remove_session(
    session_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    """Deletes a session and everything scoped to it, as long as none of its
    matches has a score. A session with no scores contributes nothing to
    event-wide rankings, so those need no recompute."""
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if session_has_scores(db, session_id):
        raise HTTPException(
            status_code=409,
            detail="This session has scored matches, so it can't be deleted.",
        )
    was_active = delete_session(db, session_obj)
    db.commit()
    if was_active:
        broadcast_active_session(request.app, "active_session_changed", {"active_session_id": None})
    return Response(status_code=204)


@router.post("/{session_id}/copy-fields", response_model=list[FieldSetRead], status_code=201)
def copy_fields(
    session_id: int,
    payload: CopyFieldsRequest,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> list[FieldSet]:
    """Recreates another session's field sets (names and division
    assignments) and their fields in this session, which must have none."""
    if db.get(TournamentSession, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if db.get(TournamentSession, payload.source_session_id) is None:
        raise HTTPException(status_code=404, detail="Source session not found")
    if payload.source_session_id == session_id:
        raise HTTPException(status_code=422, detail="A session can't copy its own fields")
    existing = db.execute(
        select(FieldSet.id).where(FieldSet.session_id == session_id).limit(1)
    ).first()
    if existing is not None:
        raise HTTPException(status_code=409, detail="This session already has fields")
    source_sets = db.execute(
        select(FieldSet)
        .where(FieldSet.session_id == payload.source_session_id)
        .order_by(FieldSet.id)
    ).scalars().all()
    if not source_sets:
        raise HTTPException(status_code=422, detail="The source session has no fields")

    copies: list[FieldSet] = []
    for source_set in source_sets:
        copy = FieldSet(
            session_id=session_id, name=source_set.name, division_id=source_set.division_id
        )
        db.add(copy)
        db.flush()
        for field in db.execute(
            select(Field).where(Field.field_set_id == source_set.id).order_by(Field.id)
        ).scalars().all():
            db.add(Field(field_set_id=copy.id, name=field.name))
        copies.append(copy)
    db.commit()
    for copy in copies:
        db.refresh(copy)
    return copies
