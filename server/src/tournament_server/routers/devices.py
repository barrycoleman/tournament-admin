from __future__ import annotations

import json
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server import audit, realtime
from tournament_server.audit import AuditLog
from tournament_server.auth import hash_token, require_admin
from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.models.device import Device
from tournament_server.routers.pairing import UNKNOWN_CODE
from tournament_server.schemas.device import DeviceRead, PairRequest
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


def audit_device(db: Session, device_id: int, action: str, before: dict | None, after: dict | None) -> None:
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
