"""Scorer bindings (live scoring spec §6.2). The /me routes are registered
before /{device_id}/binding so "me" never reaches the id route."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy.orm import Session

from tournament_server.auth import Caller, get_caller, require_admin
from tournament_server.deps import get_db
from tournament_server.models.device import Device
from tournament_server.schemas.device import BindingRead, BindingWrite
from tournament_server.services import scorer_bindings
from tournament_server.services.devices import SCORING_ROLES

router = APIRouter(prefix="/api/devices", tags=["bindings"])

NOT_A_SCORING_DEVICE = "Only a paired scorer or referee device can be bound to a field."


def _scoring_device(caller: Caller = Depends(get_caller)) -> Caller:
    if caller.device_id is None or caller.role not in SCORING_ROLES:
        raise HTTPException(status_code=403, detail=NOT_A_SCORING_DEVICE)
    return caller


@router.get("/me/binding", response_model=BindingRead | None)
def read_my_binding(caller: Caller = Depends(_scoring_device), db: Session = Depends(get_db)) -> dict | None:
    return scorer_bindings.binding_read(db, caller.device_id)


@router.put("/me/binding", response_model=BindingRead)
def bind_me(
    payload: BindingWrite,
    request: Request,
    caller: Caller = Depends(_scoring_device),
    db: Session = Depends(get_db),
) -> dict | None:
    try:
        scorer_bindings.set_binding(db, caller.device_id, payload.field_id)
    except scorer_bindings.BindingRefused as refused:
        raise HTTPException(status_code=422, detail=str(refused))
    scorer_bindings.notify(request.app, [caller.device_id])
    return scorer_bindings.binding_read(db, caller.device_id)


@router.delete("/me/binding", status_code=204)
def unbind_me(
    request: Request, caller: Caller = Depends(_scoring_device), db: Session = Depends(get_db)
) -> Response:
    if scorer_bindings.clear_binding(db, caller.device_id):
        scorer_bindings.notify(request.app, [caller.device_id])
    return Response(status_code=204)


@router.delete("/{device_id}/binding", status_code=204)
def unbind_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    if db.get(Device, device_id) is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if scorer_bindings.clear_binding(db, device_id):
        scorer_bindings.notify(request.app, [device_id])
    return Response(status_code=204)
