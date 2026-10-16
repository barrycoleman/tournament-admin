"""Display groups: what each paired display shows. See
docs/superpowers/specs/2026-10-15-display-groups-design.md."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.auth import Caller, get_caller, require_admin
from tournament_server.deps import get_db, get_session_id, get_the_event
from tournament_server.models.device import Device
from tournament_server.models.display import DisplayAssignment, DisplayGroup
from tournament_server.models.division import Division
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.display import (
    AssignmentWrite,
    CopyDisplaysRequest,
    CopyDisplaysResult,
    DisplayDevice,
    DisplayGroupRead,
    DisplayGroupUpdate,
    DisplayMe,
    DisplayMeGroup,
    DisplayRef,
    DisplaysRead,
    FieldSetLive,
    PitGroupCreate,
    UnplacedDisplay,
)
from tournament_server.services import displays
from tournament_server.services.display_screens import ScreenSettingsError, clean_rotation, clean_screen

router = APIRouter(tags=["displays"])

DISPLAY_ROLE = "display_device"
DUPLICATE_PIT_NAME = "A pit group with that name already exists."
PIT_NAME_MAX_LENGTH = 100
# Which fields each kind of group takes in PATCH (spec §8).
PATCHABLE = {
    displays.AUDIENCE: {"screen", "screen_settings", "play_sounds"},
    displays.PIT: {"screen", "screen_settings", "rotation", "name", "division_id"},
    displays.FIELD: set(),
}


def notify_display_changed(request: Request, session_id: int, group_id: int | None) -> None:
    realtime.broadcast_active_session(
        request.app, "display_changed", {"session_id": session_id, "group_id": group_id}
    )


def _session_or_404(db: Session, session_id: int) -> TournamentSession:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_obj


def _group_or_404(db: Session, group_id: int) -> DisplayGroup:
    group = db.get(DisplayGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Display group not found")
    return group


def _check_division(db: Session, division_id: int | None) -> None:
    if division_id is not None and db.get(Division, division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")


def _pit_name(db: Session, session_id: int, raw: str | None, exclude_id: int | None = None) -> str:
    name = (raw or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Enter a name for the pit group.")
    if len(name) > PIT_NAME_MAX_LENGTH:
        raise HTTPException(status_code=422, detail=f"A pit group name can be at most {PIT_NAME_MAX_LENGTH} characters.")
    for other in db.execute(
        select(DisplayGroup).where(DisplayGroup.session_id == session_id, DisplayGroup.kind == displays.PIT)
    ).scalars().all():
        if other.id != exclude_id and (other.name or "").casefold() == name.casefold():
            raise HTTPException(status_code=409, detail=DUPLICATE_PIT_NAME)
    return name


def _group_fields(db: Session, group: DisplayGroup) -> dict:
    return {
        "id": group.id,
        "session_id": group.session_id,
        "kind": group.kind,
        "name": displays.group_name(db, group),
        "field_set_id": displays.group_field_set_id(db, group),
        "field_id": group.field_id,
        "division_id": group.division_id,
        "screen": group.screen,
        "screen_settings": group.screen_settings or {},
        "rotation": group.rotation,
        "play_sounds": group.play_sounds,
    }


def displays_read(request: Request, db: Session, session_id: int) -> DisplaysRead:
    online = set(request.app.state.realtime.by_device)
    display_devices = {
        device.id: device
        for device in db.execute(select(Device).where(Device.role == DISPLAY_ROLE)).scalars().all()
    }
    rows = db.execute(select(DisplayAssignment).where(DisplayAssignment.session_id == session_id)).scalars().all()
    by_group: dict[int, list[DisplayRef]] = {}
    for row in rows:
        device = display_devices.get(row.device_id)
        if device is not None:
            by_group.setdefault(row.group_id, []).append(
                DisplayRef(device_id=device.id, name=device.name, online=device.id in online)
            )
    assigned = {row.device_id for row in rows}
    session_groups = displays.session_groups(db, session_id)
    by_name = lambda ref: ref.name.casefold()  # noqa: E731
    return DisplaysRead(
        session_id=session_id,
        groups=[
            DisplayGroupRead(**_group_fields(db, group), displays=sorted(by_group.get(group.id, []), key=by_name))
            for group in session_groups
        ],
        unassigned=sorted(
            (
                DisplayRef(device_id=device.id, name=device.name, online=device.id in online)
                for device in display_devices.values()
                if device.id not in assigned
            ),
            key=by_name,
        ),
        has_setup=displays.session_has_display_setup(db, session_id),
    )


@router.get("/api/displays", response_model=DisplaysRead)
def list_displays(
    request: Request,
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DisplaysRead:
    _session_or_404(db, session_id)
    return displays_read(request, db, session_id)


@router.post("/api/displays/pit-groups", response_model=DisplayGroupRead, status_code=201)
def create_pit_group(
    payload: PitGroupCreate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DisplayGroupRead:
    _session_or_404(db, payload.session_id)
    _check_division(db, payload.division_id)
    group = DisplayGroup(
        session_id=payload.session_id,
        kind=displays.PIT,
        name=_pit_name(db, payload.session_id, payload.name),
        division_id=payload.division_id,
        screen=displays.DEFAULT_PIT_SCREEN,
        screen_settings={},
    )
    db.add(group)
    db.commit()
    notify_display_changed(request, group.session_id, group.id)
    return DisplayGroupRead(**_group_fields(db, group), displays=[])


@router.patch("/api/displays/groups/{group_id}", response_model=DisplayGroupRead)
def update_group(
    group_id: int,
    payload: DisplayGroupUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DisplayGroupRead:
    group = _group_or_404(db, group_id)
    changes = payload.model_dump(exclude_unset=True)
    refused = sorted(set(changes) - PATCHABLE[group.kind])
    if refused:
        raise HTTPException(status_code=422, detail=f"{refused[0]} can't be set on a {group.kind} group.")
    try:
        if "screen" in changes or "screen_settings" in changes:
            screen = changes.get("screen", group.screen)
            if screen is None:
                raise ScreenSettingsError("screen can't be empty.")
            if "screen_settings" in changes:
                settings = changes["screen_settings"]
            else:
                # A different screen starts from its own defaults.
                settings = group.screen_settings if screen == group.screen else {}
            group.screen_settings = clean_screen(screen, settings, group.kind)
            group.screen = screen
        if "rotation" in changes:
            group.rotation = None if changes["rotation"] is None else clean_rotation(changes["rotation"])
    except ScreenSettingsError as error:
        raise HTTPException(status_code=422, detail=str(error))
    if "name" in changes:
        group.name = _pit_name(db, group.session_id, changes["name"], exclude_id=group.id)
    if "division_id" in changes:
        _check_division(db, changes["division_id"])
        group.division_id = changes["division_id"]
    if "play_sounds" in changes:
        if changes["play_sounds"] is None:
            raise HTTPException(status_code=422, detail="play_sounds must be true or false.")
        group.play_sounds = changes["play_sounds"]
    db.commit()
    notify_display_changed(request, group.session_id, group.id)
    members = displays_read(request, db, group.session_id)
    return next(g for g in members.groups if g.id == group.id)


@router.delete("/api/displays/groups/{group_id}", status_code=204)
def delete_group(
    group_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    group = _group_or_404(db, group_id)
    if group.kind != displays.PIT:
        raise HTTPException(status_code=409, detail="Only pit groups can be deleted.")
    session_id = group.session_id
    displays.delete_group(db, group)
    db.commit()
    notify_display_changed(request, session_id, group_id)
    realtime.broadcast_active_session(request.app, "devices_changed", {})
    return Response(status_code=204)


@router.put("/api/displays/assignments", response_model=DisplaysRead)
def assign_display(
    payload: AssignmentWrite,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DisplaysRead:
    _session_or_404(db, payload.session_id)
    device = db.get(Device, payload.device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if device.role != DISPLAY_ROLE:
        raise HTTPException(status_code=422, detail="Only a display can join a display group.")
    existing = db.execute(
        select(DisplayAssignment).where(
            DisplayAssignment.session_id == payload.session_id, DisplayAssignment.device_id == device.id
        )
    ).scalars().first()
    if payload.group_id is None:
        if existing is not None:
            db.delete(existing)
    else:
        group = _group_or_404(db, payload.group_id)
        if group.session_id != payload.session_id:
            raise HTTPException(status_code=422, detail="That group belongs to another session.")
        if existing is None:
            db.add(DisplayAssignment(session_id=payload.session_id, device_id=device.id, group_id=group.id))
        else:
            existing.group_id = group.id
    db.commit()
    notify_display_changed(request, payload.session_id, payload.group_id)
    realtime.broadcast_active_session(request.app, "devices_changed", {})
    return displays_read(request, db, payload.session_id)


@router.post("/api/displays/{device_id}/identify", status_code=204)
def identify_display(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if device.role != DISPLAY_ROLE:
        raise HTTPException(status_code=422, detail="Only a display can be identified.")
    realtime.send_to_device(request.app, device_id, "display_identify", {"device_id": device_id})
    return Response(status_code=204)


@router.get("/api/displays/me", response_model=DisplayMe)
def read_me(caller: Caller = Depends(get_caller), db: Session = Depends(get_db)) -> DisplayMe:
    if caller.device_id is None or caller.role != DISPLAY_ROLE:
        raise HTTPException(status_code=403, detail="Only a paired display can read its display setup.")
    device = db.get(Device, caller.device_id)
    event = get_the_event(db)
    session_id = event.active_session_id if event is not None else None
    group = None
    if session_id is not None:
        assignment = db.execute(
            select(DisplayAssignment).where(
                DisplayAssignment.session_id == session_id, DisplayAssignment.device_id == device.id
            )
        ).scalars().first()
        row = db.get(DisplayGroup, assignment.group_id) if assignment is not None else None
        if row is not None:
            fields = _group_fields(db, row)
            field_set = db.get(FieldSet, fields["field_set_id"]) if fields["field_set_id"] is not None else None
            live = (
                FieldSetLive(queued_match_id=field_set.queued_match_id, timeout_deadline=field_set.timeout_deadline)
                if field_set is not None
                else None
            )
            group = DisplayMeGroup(**fields, field_set=live)
    return DisplayMe(device=DisplayDevice(id=device.id, name=device.name), session_id=session_id, group=group)


@router.post("/api/sessions/{session_id}/copy-displays", response_model=CopyDisplaysResult, status_code=201)
def copy_displays(
    session_id: int,
    payload: CopyDisplaysRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> CopyDisplaysResult:
    _session_or_404(db, session_id)
    _session_or_404(db, payload.source_session_id)
    if payload.source_session_id == session_id:
        raise HTTPException(status_code=422, detail="A session can't copy its own displays")
    if displays.session_has_display_setup(db, session_id):
        raise HTTPException(status_code=409, detail="This session already has displays set up")
    if not displays.session_has_display_setup(db, payload.source_session_id):
        raise HTTPException(status_code=422, detail="The source session has no displays set up")
    unplaced = displays.copy_displays(db, session_id, payload.source_session_id)
    db.commit()
    notify_display_changed(request, session_id, None)
    realtime.broadcast_active_session(request.app, "devices_changed", {})
    return CopyDisplaysResult(unplaced=[UnplacedDisplay(**entry) for entry in unplaced])
