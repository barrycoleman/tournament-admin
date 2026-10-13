from __future__ import annotations

import tempfile
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request

from tournament_server.auth import require_admin
from tournament_server.db import utc_now
from tournament_server.picker_config import load_config, save_config
from tournament_server.routers.picker import _delayed_restart
from tournament_server.schemas.backups import (
    BackupEntryRead,
    BackupErrorRead,
    BackupFolderUpdate,
    BackupsRead,
)
from tournament_server.schemas.picker import RestartingResponse
from tournament_server.services.backups import (
    BEFORE_RESTORE,
    MANUAL,
    BackupEntry,
    BackupError,
    BackupManager,
    backup_problem,
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


async def _restart_for_restore(config_path: Path) -> None:
    """On success the restart never returns; if it does return, the restart
    failed, so the pending restore must not stay armed for a later restart."""
    await _delayed_restart()
    config = load_config(config_path)
    config.pending_restore = None
    save_config(config_path, config)


@router.post("/{filename}/restore", response_model=RestartingResponse, status_code=202)
def restore_backup(
    filename: str,
    request: Request,
    background_tasks: BackgroundTasks,
    _role: str = Depends(require_admin),
) -> RestartingResponse:
    manager = _manager(request)
    entry = next((e for e in manager.list() if e.filename == filename), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Backup not found")
    problem = backup_problem(entry.path)
    if problem is not None:
        raise HTTPException(status_code=409, detail=problem)
    try:
        manager.snapshot(BEFORE_RESTORE)
    except BackupError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"The current state couldn't be saved, so nothing was restored: {exc}",
        ) from exc
    config = load_config(manager.config_path)
    config.pending_restore = {
        "target": config_key(manager.db_path),
        "source": str(entry.path),
        "requested_at": utc_now().isoformat(),
    }
    save_config(manager.config_path, config)
    background_tasks.add_task(_restart_for_restore, manager.config_path)
    return RestartingResponse(status="restarting")
