from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db
from tournament_server.realtime import broadcast_all
from tournament_server.schemas.event_sound import SoundRead
from tournament_server.services import event_sounds as service

router = APIRouter(prefix="/api/sounds", tags=["sounds"])


def _check_slot(slot: str) -> None:
    if slot not in service.SLOTS:
        raise HTTPException(status_code=404, detail="Unknown sound slot")


@router.get("", response_model=list[SoundRead])
def list_sounds(db: Session = Depends(get_db), _role: str = Depends(require_any_role)):
    return service.list_sounds(db)


@router.get("/{slot}/audio")
def get_audio(
    slot: str,
    default: int = 0,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> Response:
    _check_slot(slot)
    row = None if default else service.get_row(db, slot)
    if row is not None:
        data, content_type = row.data, row.content_type
    else:
        data, content_type = service.default_bytes(slot), "audio/mpeg"
    return Response(content=data, media_type=content_type, headers={"Cache-Control": "no-cache"})


@router.put("/{slot}", response_model=SoundRead)
def upload_sound(
    slot: str,
    file: UploadFile,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
):
    _check_slot(slot)
    data = file.file.read(service.MAX_BYTES + 1)
    try:
        row = service.replace_sound(db, slot, file.filename or slot, data)
    except service.SoundRejected as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    broadcast_all(request.app, "sounds_changed", {"slot": slot})
    return service.read_sound(row, slot)


@router.delete("/{slot}", status_code=204)
def restore_sound(
    slot: str,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    _check_slot(slot)
    service.restore_default(db, slot)
    broadcast_all(request.app, "sounds_changed", {"slot": slot})
    return Response(status_code=204)
