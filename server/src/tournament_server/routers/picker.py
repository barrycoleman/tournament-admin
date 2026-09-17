from __future__ import annotations

import asyncio
import os
import re
import sys
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request

from tournament_server.auth import require_admin
from tournament_server.picker_config import (
    add_allowed_directory,
    is_path_allowed,
    list_tournament_files,
    load_config,
    save_config,
)
from tournament_server.schemas.picker import (
    AddDirectoryRequest,
    CreateTournamentRequest,
    DirectoryListResponse,
    OpenTournamentRequest,
    RestartingResponse,
    TournamentListResponse,
)

router = APIRouter(prefix="/api/picker", tags=["picker"])
switch_router = APIRouter(prefix="/api/picker", tags=["picker"])


async def _delayed_restart() -> None:
    """Runs as a FastAPI BackgroundTask, which only starts after the
    response has already been handed to Starlette to send -- os.execve
    replaces this process's image immediately and never returns, so it
    must not run before the client has a chance to receive its
    response.

    Unlike NoFreePortError/SchemaMismatchError, a failure here can't be
    handled by _startup() -- this runs later, from a live request, not
    at process launch. If os.execve itself raises (e.g. a corrupted
    sys.executable), there's no client left to answer; the best this can
    do is log loudly rather than let the exception vanish into
    Starlette's background-task error handling silently."""
    await asyncio.sleep(0.25)
    try:
        os.execve(sys.executable, [sys.executable, *sys.argv], os.environ.copy())
    except Exception as exc:
        # Broadened from OSError: os.execve can raise other exception
        # types too (e.g. ValueError on a malformed argv), which would
        # otherwise vanish into Starlette's background-task handling --
        # exactly what this try/except exists to avoid.
        print(f"ERROR: failed to restart the server process: {exc}", file=sys.stderr)


# The admin UI sanitizes as the organizer types (spaces -> underscore,
# anything else disallowed dropped) and appends .db automatically, so a
# real user essentially never hits this -- it exists for any other caller
# of this API, since a filename lands directly on the filesystem.
_VALID_FILENAME_RE = re.compile(r"^[A-Za-z0-9_-]+\.db$")


def _validate_filename(filename: str) -> None:
    if not filename or filename in (".", "..") or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=422, detail="Invalid filename")
    if not filename.endswith(".db"):
        raise HTTPException(status_code=422, detail="Filename must end in .db")
    if not _VALID_FILENAME_RE.match(filename):
        raise HTTPException(
            status_code=422,
            detail="Filename may only contain letters, numbers, underscores, and hyphens",
        )


@router.get("/directories", response_model=DirectoryListResponse)
def get_directories(request: Request) -> DirectoryListResponse:
    config = load_config(request.app.state.picker_config_path)
    return DirectoryListResponse(allowed_directories=config.allowed_directories)


@router.post("/directories", response_model=DirectoryListResponse)
def post_directory(request: Request, payload: AddDirectoryRequest) -> DirectoryListResponse:
    if not Path(payload.path).is_dir():
        raise HTTPException(status_code=422, detail="Not a directory")
    config = add_allowed_directory(request.app.state.picker_config_path, payload.path)
    return DirectoryListResponse(allowed_directories=config.allowed_directories)


@router.get("/tournaments", response_model=TournamentListResponse)
def get_tournaments(request: Request, dir: str) -> TournamentListResponse:
    config = load_config(request.app.state.picker_config_path)
    directory = Path(dir)
    if not is_path_allowed(directory, config.allowed_directories):
        raise HTTPException(status_code=403, detail="Directory is not allowed")
    if not directory.is_dir():
        raise HTTPException(status_code=404, detail="Directory not found")
    return TournamentListResponse(tournaments=list_tournament_files(dir))


@router.post("/create", response_model=RestartingResponse, status_code=202)
def create_tournament(
    request: Request, payload: CreateTournamentRequest, background_tasks: BackgroundTasks
) -> RestartingResponse:
    config_path = request.app.state.picker_config_path
    config = load_config(config_path)
    directory = Path(payload.directory)
    if not is_path_allowed(directory, config.allowed_directories):
        raise HTTPException(status_code=403, detail="Directory is not allowed")
    _validate_filename(payload.filename)
    if not os.access(directory, os.W_OK):
        raise HTTPException(status_code=422, detail="Directory is not writable")
    resolved = directory.resolve() / payload.filename
    if resolved.exists() or resolved.is_symlink():
        # is_symlink() also catches a dangling symlink planted at this
        # path (e.g. allowed/x.db -> /etc/something.db): exists() alone
        # follows symlinks, so a dangling one -- whose target doesn't
        # exist -- would otherwise pass this check and let
        # ensure_schema_current create a real SQLite file at the
        # symlink's target, outside the allowlist.
        raise HTTPException(status_code=409, detail="A file with that name already exists")

    config.last_opened_path = str(resolved)
    save_config(config_path, config)
    background_tasks.add_task(_delayed_restart)
    return RestartingResponse(status="restarting")


@router.post("/open", response_model=RestartingResponse, status_code=202)
def open_tournament(
    request: Request, payload: OpenTournamentRequest, background_tasks: BackgroundTasks
) -> RestartingResponse:
    config_path = request.app.state.picker_config_path
    config = load_config(config_path)
    path = Path(payload.path)
    # Check the suffix on the *resolved* path, not the raw one --
    # is_path_allowed() itself resolves its argument, so a symlink named
    # "regional.db" inside an allowed directory that actually points at
    # a ".pre-migration-*.bak" file would otherwise pass both checks
    # (the unresolved name still ends in ".db") and open a backup file.
    resolved_path = path.resolve()
    if not is_path_allowed(path, config.allowed_directories) or resolved_path.suffix != ".db":
        raise HTTPException(status_code=403, detail="File is not allowed")
    if not resolved_path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    config.last_opened_path = str(resolved_path)
    save_config(config_path, config)
    background_tasks.add_task(_delayed_restart)
    return RestartingResponse(status="restarting")


@switch_router.post("/switch", status_code=202)
def switch_tournament(
    request: Request,
    background_tasks: BackgroundTasks,
    _role: str = Depends(require_admin),
) -> RestartingResponse:
    config_path = request.app.state.picker_config_path
    config = load_config(config_path)
    config.last_opened_path = None
    save_config(config_path, config)
    background_tasks.add_task(_delayed_restart)
    return RestartingResponse(status="restarting")
