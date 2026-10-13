from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request

from tournament_server.auth import require_admin
from tournament_server.picker_config import load_config, save_config
from tournament_server.schemas.backups import (
    BackupEntryRead,
    BackupErrorRead,
    BackupFolderUpdate,
    BackupsRead,
)
from tournament_server.services.backups import (
    MANUAL,
    BackupEntry,
    BackupError,
    BackupManager,
    config_key,
)

router = APIRouter(prefix="/api/backups", tags=["backups"])

RELATIVE_FOLDER_DETAIL = "Enter a full folder path, starting from the root."


def _manager(request: Request) -> BackupManager:
    return request.app.state.backups


def _entry_read(entry: BackupEntry) -> BackupEntryRead:
    return BackupEntryRead(
        filename=entry.filename,
        created_at=entry.created_at,
        reason=entry.reason,
        size_bytes=entry.size_bytes,
    )


def _state(manager: BackupManager) -> BackupsRead:
    error = manager.last_error
    return BackupsRead(
        folder=str(manager.folder()),
        folder_is_default=manager.folder_is_default(),
        last_backup_at=manager.last_backup_at,
        last_error=BackupErrorRead(**error) if error else None,
        backups=[_entry_read(entry) for entry in manager.list()],
    )


def _folder_problem(path: Path) -> str | None:
    try:
        path.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=path):
            pass
    except OSError as exc:
        return f"Can't write to {path}: {exc.strerror or exc}"
    return None


@router.get("", response_model=BackupsRead)
def get_backups(request: Request, _role: str = Depends(require_admin)) -> BackupsRead:
    return _state(_manager(request))


@router.post("", response_model=BackupEntryRead, status_code=201)
def back_up_now(request: Request, _role: str = Depends(require_admin)) -> BackupEntryRead:
    try:
        entry = _manager(request).snapshot(MANUAL)
    except BackupError as exc:
        raise HTTPException(status_code=500, detail=f"The backup failed: {exc}") from exc
    return _entry_read(entry)


@router.put("/folder", response_model=BackupsRead)
def set_folder(
    payload: BackupFolderUpdate, request: Request, _role: str = Depends(require_admin)
) -> BackupsRead:
    manager = _manager(request)
    config = load_config(manager.config_path)
    key = config_key(manager.db_path)
    folder = (payload.folder or "").strip()
    if not folder:
        config.backup_dirs.pop(key, None)
    else:
        path = Path(folder)
        if not path.is_absolute():
            raise HTTPException(status_code=422, detail=RELATIVE_FOLDER_DETAIL)
        problem = _folder_problem(path)
        if problem is not None:
            raise HTTPException(status_code=422, detail=problem)
        config.backup_dirs[key] = str(path.resolve())
    save_config(manager.config_path, config)
    return _state(manager)
