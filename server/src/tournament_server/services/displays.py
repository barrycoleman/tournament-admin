"""Display groups: which screen each group of paired displays shows.
See docs/superpowers/specs/2026-10-15-display-groups-design.md.
None of these functions commit; the caller decides when a change lands."""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.models.device import Device
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.display import DisplayAssignment, DisplayGroup
from tournament_server.models.field import Field
from tournament_server.models.field_set import SKILLS, FieldSet
from tournament_server.models.match import Match

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


def group_name(db: Session, group: DisplayGroup) -> str:
    if group.kind == AUDIENCE:
        field_set = db.get(FieldSet, group.field_set_id)
        return field_set.name if field_set is not None else ""
    if group.kind == FIELD:
        field = db.get(Field, group.field_id)
        return field.name if field is not None else ""
    return group.name or ""


def group_field_set_id(db: Session, group: DisplayGroup) -> int | None:
    if group.kind == AUDIENCE:
        return group.field_set_id
    if group.kind == FIELD:
        field = db.get(Field, group.field_id)
        return field.field_set_id if field is not None else None
    return None


def session_groups(db: Session, session_id: int) -> list[DisplayGroup]:
    """Each field set's audience group then its field groups, field sets in
    id order, then pit groups by name."""
    rows = db.execute(select(DisplayGroup).where(DisplayGroup.session_id == session_id)).scalars().all()
    field_set_of = dict(
        db.execute(
            select(Field.id, Field.field_set_id)
            .join(FieldSet, FieldSet.id == Field.field_set_id)
            .where(FieldSet.session_id == session_id)
        ).all()
    )

    def order(group: DisplayGroup) -> tuple:
        if group.kind == PIT:
            return (1, 0, 0, (group.name or "").casefold(), group.id)
        if group.kind == AUDIENCE:
            return (0, group.field_set_id, 0, "", group.id)
        return (0, field_set_of.get(group.field_id, 0), 1, "", group.field_id)

    return sorted(rows, key=order)


def display_group_name(db: Session, device_id: int) -> str | None:
    """The name of the group this display follows in the active session."""
    event = db.execute(select(Event)).scalars().first()
    if event is None or event.active_session_id is None:
        return None
    assignment = db.execute(
        select(DisplayAssignment).where(
            DisplayAssignment.session_id == event.active_session_id, DisplayAssignment.device_id == device_id
        )
    ).scalars().first()
    if assignment is None:
        return None
    group = db.get(DisplayGroup, assignment.group_id)
    return group_name(db, group) if group is not None else None


def session_has_display_setup(db: Session, session_id: int) -> bool:
    """True once the session has any display assignment or a pit group; the
    one definition of "this session has display setup"."""
    if db.execute(select(DisplayAssignment.id).where(DisplayAssignment.session_id == session_id)).first():
        return True
    return db.execute(
        select(DisplayGroup.id).where(DisplayGroup.session_id == session_id, DisplayGroup.kind == PIT)
    ).first() is not None


def _copy_key(db: Session, group: DisplayGroup) -> tuple:
    """A group's identity across sessions, case-folded: ("audience", set
    name), ("field", set name, field name) or ("pit", name)."""
    if group.kind == FIELD:
        field = db.get(Field, group.field_id)
        field_set = db.get(FieldSet, field.field_set_id)
        return (FIELD, field_set.name.casefold(), field.name.casefold())
    return (group.kind, group_name(db, group).casefold())


def copy_displays(db: Session, target_session_id: int, source_session_id: int) -> list[dict]:
    """Copies another session's display setup (spec section 4.5) and returns
    the displays it couldn't place, as {device_id, device_name,
    source_group_name}."""
    targets: dict[tuple, DisplayGroup] = {}
    for group in sorted(session_groups(db, target_session_id), key=lambda g: g.id):
        targets.setdefault(_copy_key(db, group), group)
    single_division = db.execute(select(func.count(Division.id))).scalar_one() == 1
    copied_to: dict[int, DisplayGroup] = {}
    for source in session_groups(db, source_session_id):
        if source.kind == PIT:
            keep_division = (
                source.division_id is not None
                and not single_division
                and db.get(Division, source.division_id) is not None
            )
            copy = DisplayGroup(
                session_id=target_session_id,
                kind=PIT,
                name=source.name,
                division_id=source.division_id if keep_division else None,
                screen=source.screen,
                screen_settings=dict(source.screen_settings or {}),
                rotation=[dict(entry) for entry in source.rotation] if source.rotation else None,
            )
            db.add(copy)
            db.flush()
            copied_to[source.id] = copy
            continue
        target = targets.get(_copy_key(db, source))
        if target is None:
            continue
        if source.kind == AUDIENCE:
            target.screen = source.screen
            target.screen_settings = dict(source.screen_settings or {})
            target.play_sounds = source.play_sounds
        copied_to[source.id] = target
    unplaced = []
    for assignment in db.execute(
        select(DisplayAssignment).where(DisplayAssignment.session_id == source_session_id).order_by(DisplayAssignment.id)
    ).scalars().all():
        device = db.get(Device, assignment.device_id)
        if device is None or device.role != "display_device":
            continue
        target = copied_to.get(assignment.group_id)
        if target is None:
            source = db.get(DisplayGroup, assignment.group_id)
            unplaced.append(
                {"device_id": device.id, "device_name": device.name, "source_group_name": group_name(db, source)}
            )
            continue
        db.add(DisplayAssignment(session_id=target_session_id, device_id=device.id, group_id=target.id))
    db.flush()
    return unplaced


RUNNING_EXCLUDED_PHASES = ("not_started", "ended")


def field_ids_for_set(db: Session, field_set_id: int) -> list[int]:
    return list(db.execute(select(Field.id).where(Field.field_set_id == field_set_id)).scalars().all())


def field_set_id_for_field(db: Session, field_id: int | None) -> int | None:
    if field_id is None:
        return None
    field = db.get(Field, field_id)
    return field.field_set_id if field is not None else None


def running_match(db: Session, field_set_id: int, exclude_id: int | None = None) -> Match | None:
    query = select(Match).where(
        Match.field_id.in_(field_ids_for_set(db, field_set_id)),
        Match.phase.not_in(RUNNING_EXCLUDED_PHASES),
    )
    if exclude_id is not None:
        query = query.where(Match.id != exclude_id)
    return db.execute(query.limit(1)).scalars().first()


def on_match_started(db: Session, field_set_id: int) -> list[int]:
    """A match on this field set just started (spec section 6.3): its audience
    groups move to In Match, keeping their settings, and its override and
    time-out are cleared. Returns the ids of the audience groups it switched.
    A skills set has no In Match screen (live scoring design §11): nothing
    changes and nothing is returned."""
    field_set = db.get(FieldSet, field_set_id)
    if field_set is not None and field_set.purpose == SKILLS:
        return []
    switched = []
    for group in db.execute(
        select(DisplayGroup).where(DisplayGroup.kind == AUDIENCE, DisplayGroup.field_set_id == field_set_id)
    ).scalars().all():
        if group.screen != "in_match":
            group.screen = "in_match"
            switched.append(group.id)
    if field_set is not None:
        field_set.queued_match_id = None
        field_set.timeout_deadline = None
    db.flush()
    return switched


def notify_field_set_changed(app, field_set_id: int) -> None:
    realtime.broadcast_active_session(app, "field_set_changed", {"field_set_id": field_set_id})
