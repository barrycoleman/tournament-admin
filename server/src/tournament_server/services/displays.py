"""Display groups: which screen each group of paired displays shows.
See docs/superpowers/specs/2026-10-15-display-groups-design.md.
None of these functions commit; the caller decides when a change lands."""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.display import DisplayAssignment, DisplayGroup
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet

AUDIENCE = "audience"
FIELD = "field"
PIT = "pit"
GROUP_KINDS = (AUDIENCE, FIELD, PIT)
DEFAULT_AUDIENCE_SCREEN = "logo"
DEFAULT_PIT_SCREEN = "teamwork_rankings"


def ensure_audience_group(db: Session, field_set: FieldSet) -> DisplayGroup:
    group = db.execute(
        select(DisplayGroup).where(DisplayGroup.kind == AUDIENCE, DisplayGroup.field_set_id == field_set.id)
    ).scalars().first()
    if group is None:
        group = DisplayGroup(
            session_id=field_set.session_id,
            kind=AUDIENCE,
            field_set_id=field_set.id,
            screen=DEFAULT_AUDIENCE_SCREEN,
            screen_settings={},
        )
        db.add(group)
        db.flush()
    return group


def ensure_field_group(db: Session, field: Field) -> DisplayGroup:
    group = db.execute(
        select(DisplayGroup).where(DisplayGroup.kind == FIELD, DisplayGroup.field_id == field.id)
    ).scalars().first()
    if group is None:
        field_set = db.get(FieldSet, field.field_set_id)
        group = DisplayGroup(session_id=field_set.session_id, kind=FIELD, field_id=field.id, screen_settings={})
        db.add(group)
        db.flush()
    return group


def ensure_all_groups(db: Session) -> None:
    """Startup self-heal: every field set has its audience group and every
    field its field group, whatever build made the file."""
    with_audience = set(
        db.execute(select(DisplayGroup.field_set_id).where(DisplayGroup.kind == AUDIENCE)).scalars().all()
    )
    with_field = set(db.execute(select(DisplayGroup.field_id).where(DisplayGroup.kind == FIELD)).scalars().all())
    for field_set in db.execute(select(FieldSet).order_by(FieldSet.id)).scalars().all():
        if field_set.id not in with_audience:
            ensure_audience_group(db, field_set)
    for field in db.execute(select(Field).order_by(Field.id)).scalars().all():
        if field.id not in with_field:
            ensure_field_group(db, field)


def delete_group(db: Session, group: DisplayGroup) -> None:
    for row in db.execute(select(DisplayAssignment).where(DisplayAssignment.group_id == group.id)).scalars().all():
        db.delete(row)
    db.flush()
    db.delete(group)
    db.flush()


def _delete_all(db: Session, query) -> None:
    for group in db.execute(query).scalars().all():
        delete_group(db, group)


def delete_field_groups(db: Session, field_id: int) -> None:
    _delete_all(db, select(DisplayGroup).where(DisplayGroup.field_id == field_id))


def delete_field_set_groups(db: Session, field_set_id: int) -> None:
    field_ids = db.execute(select(Field.id).where(Field.field_set_id == field_set_id)).scalars().all()
    for field_id in field_ids:
        delete_field_groups(db, field_id)
    _delete_all(db, select(DisplayGroup).where(DisplayGroup.field_set_id == field_set_id))


def delete_session_displays(db: Session, session_id: int) -> None:
    _delete_all(db, select(DisplayGroup).where(DisplayGroup.session_id == session_id))


def delete_device_assignments(db: Session, device_id: int) -> None:
    for row in db.execute(select(DisplayAssignment).where(DisplayAssignment.device_id == device_id)).scalars().all():
        db.delete(row)
    db.flush()


def clear_queued_matches(db: Session, match_ids: Iterable[int]) -> list[int]:
    """Clears any field set's next-match override that points at one of
    these matches. Returns the ids of the field sets it changed."""
    ids = list(match_ids)
    if not ids:
        return []
    changed = []
    for field_set in db.execute(select(FieldSet).where(FieldSet.queued_match_id.in_(ids))).scalars().all():
        field_set.queued_match_id = None
        changed.append(field_set.id)
    db.flush()
    return changed


def clear_division_from_pit_groups(db: Session, division_id: int) -> None:
    for group in db.execute(select(DisplayGroup).where(DisplayGroup.division_id == division_id)).scalars().all():
        group.division_id = None
    db.flush()
