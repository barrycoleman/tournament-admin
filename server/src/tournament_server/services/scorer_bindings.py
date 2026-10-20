"""Scorer bindings (live scoring spec §6.2): a paired scorer or referee device
may follow one field in the active session. Binding is optional; an unbound
scorer picks each match or skills field."""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.deps import get_the_event
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.scoring_draft import ScorerBinding

ACTIVE_FIELD_DETAIL = "Pick a field in the active session."
BINDING_CHANGED = "scorer_binding_changed"


class BindingRefused(Exception):
    pass


def _active_session_id(db: Session) -> int | None:
    event = get_the_event(db)
    return event.active_session_id if event is not None else None


def find_binding(db: Session, device_id: int) -> ScorerBinding | None:
    """The device's binding in the active session."""
    session_id = _active_session_id(db)
    if session_id is None:
        return None
    return db.execute(
        select(ScorerBinding).where(ScorerBinding.session_id == session_id, ScorerBinding.device_id == device_id)
    ).scalars().first()


def binding_read(db: Session, device_id: int) -> dict | None:
    binding = find_binding(db, device_id)
    if binding is None:
        return None
    field = db.get(Field, binding.field_id)
    return {"field_id": field.id, "field_name": field.name} if field is not None else None


def set_binding(db: Session, device_id: int, field_id: int) -> ScorerBinding:
    """Binds the device to a field of the active session, replacing its binding."""
    session_id = _active_session_id(db)
    field = db.get(Field, field_id)
    field_set = db.get(FieldSet, field.field_set_id) if field is not None else None
    if session_id is None or field_set is None or field_set.session_id != session_id:
        raise BindingRefused(ACTIVE_FIELD_DETAIL)
    binding = find_binding(db, device_id)
    if binding is None:
        binding = ScorerBinding(session_id=session_id, device_id=device_id, field_id=field_id)
        db.add(binding)
    else:
        binding.field_id = field_id
    try:
        db.commit()
    except IntegrityError:
        # The same device bound itself twice at once: the other request's row wins, then this one updates it.
        db.rollback()
        binding = find_binding(db, device_id)
        binding.field_id = field_id
        db.commit()
    return binding


def clear_binding(db: Session, device_id: int) -> bool:
    """Removes the device's binding in the active session; False if it had none."""
    binding = find_binding(db, device_id)
    if binding is None:
        return False
    db.delete(binding)
    db.commit()
    return True


def _delete_where(db: Session, *conditions) -> list[int]:
    rows = db.execute(select(ScorerBinding).where(*conditions)).scalars().all()
    device_ids = sorted({row.device_id for row in rows})
    for row in rows:
        db.delete(row)
    db.flush()
    return device_ids


def clear_for_fields(db: Session, field_ids: Iterable[int]) -> list[int]:
    """Deletes the bindings to these fields (no commit); returns the devices that had one."""
    field_ids = list(field_ids)
    if not field_ids:
        return []
    return _delete_where(db, ScorerBinding.field_id.in_(field_ids))


def clear_for_session(db: Session, session_id: int) -> list[int]:
    return _delete_where(db, ScorerBinding.session_id == session_id)


def clear_for_device(db: Session, device_id: int) -> list[int]:
    return _delete_where(db, ScorerBinding.device_id == device_id)


def notify(app, device_ids: Iterable[int]) -> None:
    """Tells admins and each device that its binding changed."""
    for device_id in device_ids:
        realtime.send_to_devices_and_admins(app, [device_id], BINDING_CHANGED, {"device_id": device_id})
