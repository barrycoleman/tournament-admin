from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import audit
from tournament_server.auth import hash_token, require_admin
from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.device_auth import (
    device_status,
    generate_device_token,
    generate_friendly_name,
)
from tournament_server.models.scoring_device import ScoringDevice
from tournament_server.schemas.device import DeviceRead, DeviceRegisterResponse

router = APIRouter(prefix="/api/devices", tags=["devices"])


def _to_device_read(device: ScoringDevice, idle_timeout) -> DeviceRead:
    now = utc_now()
    return DeviceRead(
        id=device.id,
        friendly_name=device.friendly_name,
        status=device_status(device, now, idle_timeout),
        registered_at=device.registered_at,
        admitted_at=device.admitted_at,
        admitted_by=device.admitted_by,
        last_seen_at=device.last_seen_at,
    )


@router.post("/register", response_model=DeviceRegisterResponse, status_code=201)
def register_device(db: Session = Depends(get_db)) -> DeviceRegisterResponse:
    friendly_name = generate_friendly_name(db)
    device_token = generate_device_token()
    now = utc_now()
    db.add(
        ScoringDevice(
            friendly_name=friendly_name,
            device_token_hash=hash_token(device_token),
            registered_at=now,
            last_seen_at=now,
        )
    )
    db.commit()
    return DeviceRegisterResponse(
        device_token=device_token, friendly_name=friendly_name, status="pending"
    )


@router.get("", response_model=list[DeviceRead])
def list_devices(
    request: Request, db: Session = Depends(get_db), _role: str = Depends(require_admin)
) -> list[DeviceRead]:
    idle_timeout = request.app.state.device_idle_timeout
    devices = db.execute(select(ScoringDevice)).scalars().all()
    return [_to_device_read(d, idle_timeout) for d in devices]


@router.post("/{device_id}/admit", response_model=DeviceRead)
def admit_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = db.get(ScoringDevice, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    now = utc_now()
    device.admitted_at = now
    device.admitted_by = audit.current_actor.get()
    # Also refresh last_seen_at: otherwise re-admitting a device that has
    # been silent longer than the idle timeout would set a fresh
    # admitted_at but leave is_currently_admitted() false until the
    # device's next successful request happens to touch last_seen_at —
    # re-admitting must take effect immediately.
    device.last_seen_at = now
    db.commit()
    db.refresh(device)
    return _to_device_read(device, request.app.state.device_idle_timeout)


@router.post("/{device_id}/revoke", response_model=DeviceRead)
def revoke_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = db.get(ScoringDevice, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    device.admitted_at = None
    device.admitted_by = None
    db.commit()
    db.refresh(device)
    return _to_device_read(device, request.app.state.device_idle_timeout)
