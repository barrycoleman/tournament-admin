from __future__ import annotations

import json
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server import audit, realtime
from tournament_server.audit import AuditLog
from tournament_server.auth import Caller, get_caller, hash_token, require_admin
from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_event_or_404
from tournament_server.models.device import Device
from tournament_server.routers.pairing import UNKNOWN_CODE
from tournament_server.schemas.device import (
    DeviceRead,
    DeviceSelf,
    DeviceSettings,
    DeviceUpdate,
    PairRequest,
)
from tournament_server.services.devices import (
    PAIRABLE_ROLES,
    clean_name,
    device_status,
    idle_minutes_for,
    name_key,
)

router = APIRouter(prefix="/api/devices", tags=["devices"])

DUPLICATE_NAME = "A device with that name already exists."


def to_device_read(device: Device, db: Session) -> DeviceRead:
    return DeviceRead(
        id=device.id,
        name=device.name,
        role=device.role,
        status=device_status(device, utc_now(), idle_minutes_for(db)),
        paired_at=device.paired_at,
        paired_by=device.paired_by,
        last_seen_at=device.last_seen_at,
        disabled_at=device.disabled_at,
    )


def device_snapshot(device: Device) -> dict:
    """What the audit log records about a device: never its token hash."""
    return {"name": device.name, "role": device.role, "disabled": device.disabled_at is not None}


def audit_device(db: Session, device_id: int | None, action: str, before: dict | None, after: dict | None) -> None:
    db.add(
        AuditLog(
            table_name="devices",
            row_pk=device_id,
            action=action,
            actor=audit.current_actor.get(),
            before_json=json.dumps(before) if before is not None else None,
            after_json=json.dumps(after) if after is not None else None,
        )
    )


def notify_devices_changed(request: Request) -> None:
    realtime.broadcast_active_session(request.app, "devices_changed", {})


def checked_role(role: str) -> str:
    if role not in PAIRABLE_ROLES:
        raise HTTPException(status_code=422, detail="This role can't be paired.")
    return role


def checked_name(raw: str) -> str:
    try:
        return clean_name(raw)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))


@router.get("", response_model=list[DeviceRead])
def list_devices(db: Session = Depends(get_db), _role: str = Depends(require_admin)) -> list[DeviceRead]:
    devices = db.execute(select(Device).order_by(Device.name_key)).scalars().all()
    return [to_device_read(d, db) for d in devices]


@router.post("/pair", response_model=DeviceRead, status_code=201)
def pair_device(
    payload: PairRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    store = request.app.state.pairing
    pending = store.find_open(payload.code)
    if pending is None:
        raise HTTPException(status_code=404, detail=UNKNOWN_CODE)
    role = checked_role(payload.role)
    name = checked_name(payload.name)
    if db.execute(select(Device).where(Device.name_key == name_key(name))).scalars().first():
        raise HTTPException(status_code=409, detail=DUPLICATE_NAME)
    device_token = secrets.token_urlsafe(32)
    now = utc_now()
    device = Device(
        name=name,
        name_key=name_key(name),
        role=role,
        token_hash=hash_token(device_token),
        paired_at=now,
        paired_by=audit.current_actor.get(),
        last_seen_at=now,
    )
    db.add(device)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=DUPLICATE_NAME)
    if not store.attach_token(pending.id, device_token):
        db.rollback()
        raise HTTPException(status_code=404, detail=UNKNOWN_CODE)
    audit_device(db, device.id, "pair", None, device_snapshot(device))
    db.commit()
    db.refresh(device)
    notify_devices_changed(request)
    return to_device_read(device, db)


# /settings and /me are registered before the /{device_id} routes.


@router.get("/settings", response_model=DeviceSettings)
def read_settings(db: Session = Depends(get_db), _role: str = Depends(require_admin)) -> DeviceSettings:
    return DeviceSettings(idle_minutes=idle_minutes_for(db))


@router.put("/settings", response_model=DeviceSettings)
def write_settings(
    payload: DeviceSettings,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceSettings:
    event = get_event_or_404(db)
    before = {"idle_minutes": event.device_idle_minutes}
    event.device_idle_minutes = payload.idle_minutes
    audit_device(db, None, "idle_setting", before, {"idle_minutes": payload.idle_minutes})
    db.commit()
    notify_devices_changed(request)
    return DeviceSettings(idle_minutes=event.device_idle_minutes)


@router.get("/me", response_model=DeviceSelf)
def read_me(caller: Caller = Depends(get_caller), db: Session = Depends(get_db)) -> DeviceSelf:
    if caller.device_id is None:
        raise HTTPException(status_code=404, detail="Not a paired device")
    device = db.get(Device, caller.device_id)
    if device is None:
        raise HTTPException(status_code=401, detail="This device is no longer paired")
    # get_caller only admits an active device, so its status here is active.
    return DeviceSelf(id=device.id, name=device.name, role=device.role, status="active")


def _device_or_404(db: Session, device_id: int) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.patch("/{device_id}", response_model=DeviceRead)
def update_device(
    device_id: int,
    payload: DeviceUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = _device_or_404(db, device_id)
    changes = payload.model_dump(exclude_unset=True)
    if any(changes.get(field, "") is None for field in ("name", "role")):
        raise HTTPException(status_code=422, detail="Name and role can't be empty.")
    before = device_snapshot(device)
    role_changed = False
    if "role" in changes:
        role = checked_role(changes["role"])
        role_changed = role != device.role
        device.role = role
    if "name" in changes:
        name = checked_name(changes["name"])
        clash = db.execute(
            select(Device).where(Device.name_key == name_key(name), Device.id != device.id)
        ).scalars().first()
        if clash is not None:
            raise HTTPException(status_code=409, detail=DUPLICATE_NAME)
        device.name = name
        device.name_key = name_key(name)
    audit_device(db, device.id, "update", before, device_snapshot(device))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=DUPLICATE_NAME)
    db.refresh(device)
    if role_changed:
        realtime.close_device_sockets(request.app, device.id)
    notify_devices_changed(request)
    return to_device_read(device, db)


@router.post("/{device_id}/disable", response_model=DeviceRead)
def disable_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = _device_or_404(db, device_id)
    before = device_snapshot(device)
    if device.disabled_at is None:
        device.disabled_at = utc_now()
    audit_device(db, device.id, "disable", before, device_snapshot(device))
    db.commit()
    db.refresh(device)
    realtime.close_device_sockets(request.app, device.id)
    notify_devices_changed(request)
    return to_device_read(device, db)


@router.post("/{device_id}/enable", response_model=DeviceRead)
def enable_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = _device_or_404(db, device_id)
    before = device_snapshot(device)
    device.disabled_at = None
    # Enabling also clears idle: the device counts as just seen.
    device.last_seen_at = utc_now()
    audit_device(db, device.id, "enable", before, device_snapshot(device))
    db.commit()
    db.refresh(device)
    notify_devices_changed(request)
    return to_device_read(device, db)


@router.delete("/{device_id}", status_code=204)
def delete_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    device = _device_or_404(db, device_id)
    audit_device(db, device.id, "delete", device_snapshot(device), None)
    db.delete(device)
    db.commit()
    realtime.close_device_sockets(request.app, device_id)
    notify_devices_changed(request)
    return Response(status_code=204)
