from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin
from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.models.device import Device
from tournament_server.schemas.device import PairingCodeCheck, PairingCodeRead, PairingPollRead

router = APIRouter(prefix="/api/pairing", tags=["pairing"])

UNKNOWN_CODE = "That code isn't valid or has expired."


@router.post("", response_model=PairingCodeRead, status_code=201)
def open_code(request: Request, db: Session = Depends(get_db)) -> PairingCodeRead:
    taken = set(db.execute(select(Device.name_key)).scalars())
    pending = request.app.state.pairing.open(taken)
    return PairingCodeRead(
        id=pending.id,
        code=pending.code,
        poll_key=pending.poll_key,
        expires_at=pending.expires_at,
        expires_in=max(0, round((pending.expires_at - utc_now()).total_seconds())),
    )


@router.get("/codes/{code}", response_model=PairingCodeCheck)
def check_code(code: str, request: Request, _role: str = Depends(require_admin)) -> PairingCodeCheck:
    pending = request.app.state.pairing.find_open(code)
    if pending is None:
        raise HTTPException(status_code=404, detail=UNKNOWN_CODE)
    return PairingCodeCheck(code=pending.code, suggested_name=pending.suggested_name, expires_at=pending.expires_at)


@router.get("/{pairing_id}", response_model=PairingPollRead)
def poll(
    pairing_id: str,
    request: Request,
    x_pairing_key: str | None = Header(None),
) -> PairingPollRead:
    result = request.app.state.pairing.poll(pairing_id, x_pairing_key or "")
    if result is None:
        raise HTTPException(status_code=404, detail="Not found")
    status, token = result
    return PairingPollRead(status=status, device_token=token)
