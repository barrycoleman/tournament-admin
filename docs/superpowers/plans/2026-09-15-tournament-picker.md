# Multi-Tournament Picker Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the server start with no tournament file chosen yet, offer an admin a "Create New Tournament" / "Open Existing Tournament" picker screen (no login required), and restart itself into the normal single-tournament app once a path is resolved.

**Architecture:** A new JSON config file (outside any tournament's own SQLite file) records the directory allowlist and the last-opened tournament path. `main.py`'s startup resolves a tournament path from (in order) the legacy `TOURNAMENT_DB_PATH` env var, then the config's `last_opened_path`; if neither resolves, it serves a small, separate, fully unauthenticated "picker" FastAPI app instead of the normal one. Choosing a path in the picker UI writes it to the config and self-execs (`os.execve`) to restart the process, which then boots the normal app unchanged.

**Tech Stack:** Python 3.11+, FastAPI, pydantic v2, SQLAlchemy; TypeScript, React 19, React Router 6 (data routers), TanStack Query 5, react-i18next, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-tournament-bootstrap-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere (code, comments, docs, commit messages, user-facing text).
- Every backend feature ships with pytest unit tests in the same change; every API flow gets integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database — never mocked at the HTTP boundary.
- Every piece of UI work requires Playwright E2E tests covering its golden path and important edge cases.
- Every user-facing string goes through `useTranslation()`/`t(...)` with both an English (`frontend/apps/admin/src/i18n/en/admin.json`) and Chinese (`.../zh/admin.json`) entry — never a bare string literal.
- The existing `TOURNAMENT_DB_PATH` env var keeps working byte-for-byte unchanged as a legacy override that skips the picker entirely.
- Tournament files live on the server's filesystem only, browsed through a server-side listing API scoped to an explicit directory allowlist — never a raw client-supplied path outside that allowlist.
- Automatic pre-migration backup files (`<path>.pre-migration-<timestamp>.bak`) must never be openable as, or appear as, ordinary tournaments.
- `playwright.config.ts` uses `channel: "chrome"` (the machine's installed Google Chrome), not Playwright's own managed browser download — this project's sandbox can't reach `cdn.playwright.dev` reliably.

---

## Task 1: Picker config module

**Files:**
- Create: `server/src/tournament_server/picker_config.py`
- Test: `server/tests/test_picker_config.py`

**Interfaces:**
- Consumes: nothing from this plan (uses only the standard library).
- Produces (used by Tasks 2, 4, 5):
  - `@dataclass class PickerConfig: allowed_directories: list[str]; last_opened_path: str | None`
  - `def resolve_config_path() -> Path`
  - `def load_config(config_path: Path) -> PickerConfig`
  - `def save_config(config_path: Path, config: PickerConfig) -> None`
  - `def is_path_allowed(path: Path, allowed_directories: list[str]) -> bool`
  - `def add_allowed_directory(config_path: Path, directory: str) -> PickerConfig`
  - `def list_tournament_files(directory: str) -> list[dict[str, object]]` — each dict has keys `filename`, `path`, `size_bytes`, `modified_at`.
  - `def resolve_active_db_path(explicit: str | None = None) -> str | None`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_picker_config.py`:

```python
from __future__ import annotations

import json
from pathlib import Path

from tournament_server.picker_config import (
    PickerConfig,
    add_allowed_directory,
    is_path_allowed,
    list_tournament_files,
    load_config,
    resolve_active_db_path,
    resolve_config_path,
    save_config,
)


def test_load_config_creates_a_fresh_file_when_none_exists(tmp_path):
    config_path = tmp_path / "server-config.json"

    config = load_config(config_path)

    assert config == PickerConfig(allowed_directories=[], last_opened_path=None)
    assert config_path.exists()
    on_disk = json.loads(config_path.read_text())
    assert on_disk == {"allowed_directories": [], "last_opened_path": None}


def test_load_config_seeds_default_dir_from_env_var_on_first_creation(tmp_path, monkeypatch):
    config_path = tmp_path / "server-config.json"
    seed_dir = tmp_path / "tournaments"
    seed_dir.mkdir()
    monkeypatch.setenv("TOURNAMENT_DEFAULT_DIR", str(seed_dir))

    config = load_config(config_path)

    assert config.allowed_directories == [str(seed_dir.resolve())]


def test_load_config_reads_an_existing_file_without_reseeding(tmp_path, monkeypatch):
    config_path = tmp_path / "server-config.json"
    save_config(
        config_path,
        PickerConfig(allowed_directories=["/already/there"], last_opened_path="/x.db"),
    )
    monkeypatch.setenv("TOURNAMENT_DEFAULT_DIR", "/should/not/appear")

    config = load_config(config_path)

    assert config.allowed_directories == ["/already/there"]
    assert config.last_opened_path == "/x.db"


def test_save_config_creates_parent_directories(tmp_path):
    config_path = tmp_path / "nested" / "dir" / "server-config.json"

    save_config(config_path, PickerConfig(allowed_directories=[], last_opened_path=None))

    assert config_path.exists()


def test_resolve_config_path_uses_env_var_override(monkeypatch, tmp_path):
    override = tmp_path / "custom-config.json"
    monkeypatch.setenv("TOURNAMENT_CONFIG_PATH", str(override))

    assert resolve_config_path() == override


def test_resolve_config_path_defaults_to_home_directory(monkeypatch):
    monkeypatch.delenv("TOURNAMENT_CONFIG_PATH", raising=False)

    assert resolve_config_path() == Path.home() / ".tournament-admin" / "server-config.json"


def test_is_path_allowed_accepts_an_exact_match(tmp_path):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()

    assert is_path_allowed(allowed, [str(allowed)])


def test_is_path_allowed_accepts_a_descendant(tmp_path):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    nested_file = allowed / "event.db"
    nested_file.write_text("")

    assert is_path_allowed(nested_file, [str(allowed)])


def test_is_path_allowed_rejects_a_path_outside_every_allowed_directory(tmp_path):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    outside = tmp_path / "elsewhere" / "event.db"

    assert not is_path_allowed(outside, [str(allowed)])


def test_is_path_allowed_rejects_a_path_traversal_attempt(tmp_path):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    (tmp_path / "secret.db").write_text("")
    traversal = allowed / ".." / "secret.db"

    assert not is_path_allowed(traversal, [str(allowed)])


def test_add_allowed_directory_appends_and_persists(tmp_path):
    config_path = tmp_path / "server-config.json"
    new_dir = tmp_path / "usb-drive"
    new_dir.mkdir()

    config = add_allowed_directory(config_path, str(new_dir))

    assert config.allowed_directories == [str(new_dir.resolve())]
    assert load_config(config_path).allowed_directories == [str(new_dir.resolve())]


def test_add_allowed_directory_is_idempotent(tmp_path):
    config_path = tmp_path / "server-config.json"
    new_dir = tmp_path / "usb-drive"
    new_dir.mkdir()

    add_allowed_directory(config_path, str(new_dir))
    config = add_allowed_directory(config_path, str(new_dir))

    assert config.allowed_directories == [str(new_dir.resolve())]


def test_list_tournament_files_excludes_backups_and_non_db_files(tmp_path):
    (tmp_path / "regional.db").write_text("x")
    (tmp_path / "regional.db.pre-migration-20260101120000.bak").write_text("x")
    (tmp_path / "notes.txt").write_text("x")

    entries = list_tournament_files(str(tmp_path))

    assert [e["filename"] for e in entries] == ["regional.db"]
    assert entries[0]["path"] == str((tmp_path / "regional.db").resolve())
    assert entries[0]["size_bytes"] == 1
    assert "modified_at" in entries[0]


def test_resolve_active_db_path_prefers_explicit_argument(monkeypatch):
    monkeypatch.setenv("TOURNAMENT_DB_PATH", "/from/env.db")

    assert resolve_active_db_path("/explicit.db") == "/explicit.db"


def test_resolve_active_db_path_falls_back_to_env_var(monkeypatch):
    monkeypatch.setenv("TOURNAMENT_DB_PATH", "/from/env.db")

    assert resolve_active_db_path() == "/from/env.db"


def test_resolve_active_db_path_falls_back_to_last_opened_path(tmp_path, monkeypatch):
    monkeypatch.delenv("TOURNAMENT_DB_PATH", raising=False)
    config_path = tmp_path / "server-config.json"
    monkeypatch.setenv("TOURNAMENT_CONFIG_PATH", str(config_path))
    save_config(config_path, PickerConfig(allowed_directories=[], last_opened_path="/opened.db"))

    assert resolve_active_db_path() == "/opened.db"


def test_resolve_active_db_path_returns_none_when_nothing_is_resolvable(tmp_path, monkeypatch):
    monkeypatch.delenv("TOURNAMENT_DB_PATH", raising=False)
    monkeypatch.setenv("TOURNAMENT_CONFIG_PATH", str(tmp_path / "server-config.json"))

    assert resolve_active_db_path() is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_picker_config.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'tournament_server.picker_config'`

- [ ] **Step 3: Implement the module**

Create `server/src/tournament_server/picker_config.py`:

```python
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_CONFIG_PATH = Path.home() / ".tournament-admin" / "server-config.json"


@dataclass
class PickerConfig:
    allowed_directories: list[str] = field(default_factory=list)
    last_opened_path: str | None = None


def resolve_config_path() -> Path:
    override = os.environ.get("TOURNAMENT_CONFIG_PATH")
    return Path(override) if override else DEFAULT_CONFIG_PATH


def load_config(config_path: Path) -> PickerConfig:
    if not config_path.exists():
        config = PickerConfig()
        default_dir = os.environ.get("TOURNAMENT_DEFAULT_DIR")
        if default_dir:
            config.allowed_directories.append(str(Path(default_dir).resolve()))
        save_config(config_path, config)
        return config

    raw = json.loads(config_path.read_text())
    return PickerConfig(
        allowed_directories=list(raw.get("allowed_directories", [])),
        last_opened_path=raw.get("last_opened_path"),
    )


def save_config(config_path: Path, config: PickerConfig) -> None:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(json.dumps(asdict(config), indent=2))


def is_path_allowed(path: Path, allowed_directories: list[str]) -> bool:
    """True if `path`, once resolved (symlinks followed, ".." normalized),
    IS one of `allowed_directories` or is nested inside one of them. This
    is the actual path-traversal guard for every picker endpoint that
    takes a client-supplied path -- never trust the raw string."""
    resolved = path.resolve()
    for allowed in allowed_directories:
        allowed_resolved = Path(allowed).resolve()
        if resolved == allowed_resolved or allowed_resolved in resolved.parents:
            return True
    return False


def add_allowed_directory(config_path: Path, directory: str) -> PickerConfig:
    """Adds a brand-new top-level directory (the USB-drive case) to the
    allowlist. Unlike `is_path_allowed`, this deliberately does NOT check
    containment against existing entries -- it's establishing a new root,
    not validating a path against established ones."""
    resolved = str(Path(directory).resolve())
    config = load_config(config_path)
    if resolved not in config.allowed_directories:
        config.allowed_directories.append(resolved)
        save_config(config_path, config)
    return config


def list_tournament_files(directory: str) -> list[dict[str, object]]:
    """Non-recursive `*.db` glob. This alone already excludes automatic
    pre-migration backups (named `<path>.pre-migration-<timestamp>.bak`,
    see migrations.py::_backup_path) since they never match `*.db`."""
    entries: list[dict[str, object]] = []
    for db_file in sorted(Path(directory).glob("*.db")):
        stat = db_file.stat()
        entries.append(
            {
                "filename": db_file.name,
                "path": str(db_file.resolve()),
                "size_bytes": stat.st_size,
                "modified_at": datetime.fromtimestamp(
                    stat.st_mtime, tz=timezone.utc
                ).isoformat(),
            }
        )
    return entries


def resolve_active_db_path(explicit: str | None = None) -> str | None:
    """Resolution order: an explicit argument (e.g. a CLI flag) wins,
    then the legacy TOURNAMENT_DB_PATH env var, then the picker config's
    last_opened_path. Returns None if nothing resolves -- the caller
    (main.py's _startup, or the `tm migrate` CLI) decides what that
    means for it."""
    if explicit is not None:
        return explicit
    env_path = os.environ.get("TOURNAMENT_DB_PATH")
    if env_path is not None:
        return env_path
    return load_config(resolve_config_path()).last_opened_path
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_picker_config.py -v`
Expected: PASS (16 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/picker_config.py server/tests/test_picker_config.py
git commit -m "Add the picker config module: allowlist, resolution, and containment checks"
```

---

## Task 2: Picker schemas and API router

**Files:**
- Create: `server/src/tournament_server/schemas/picker.py`
- Create: `server/src/tournament_server/routers/picker.py`
- Test: `server/tests/test_picker_router.py`

**Interfaces:**
- Consumes: everything from Task 1's `tournament_server.picker_config`; `tournament_server.auth.require_admin` (already exists).
- Produces (used by Tasks 4, 5):
  - `router = APIRouter(prefix="/api/picker", ...)` — unauthenticated: `GET/POST /directories`, `GET /tournaments`, `POST /create`, `POST /open`.
  - `switch_router = APIRouter(prefix="/api/picker", ...)` — admin-gated: `POST /switch`.
  - Both routers read/write via `request.app.state.picker_config_path`, which the mounting app must set.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_picker_router.py`:

```python
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tournament_server.picker_config import load_config
from tournament_server.routers import picker


@pytest.fixture()
def execve_calls(monkeypatch):
    calls = []
    monkeypatch.setattr(
        "os.execve", lambda executable, args, env: calls.append((executable, args))
    )
    return calls


@pytest.fixture()
def picker_client(tmp_path) -> TestClient:
    app = FastAPI()
    app.state.picker_config_path = tmp_path / "server-config.json"
    app.include_router(picker.router)
    with TestClient(app) as client:
        yield client


def test_get_directories_starts_empty(picker_client):
    response = picker_client.get("/api/picker/directories")
    assert response.status_code == 200
    assert response.json() == {"allowed_directories": []}


def test_post_directory_adds_a_valid_directory(picker_client, tmp_path):
    new_dir = tmp_path / "tournaments"
    new_dir.mkdir()

    response = picker_client.post("/api/picker/directories", json={"path": str(new_dir)})

    assert response.status_code == 200
    assert response.json()["allowed_directories"] == [str(new_dir.resolve())]


def test_post_directory_422s_for_a_file_that_is_not_a_directory(picker_client, tmp_path):
    not_a_dir = tmp_path / "file.txt"
    not_a_dir.write_text("x")

    response = picker_client.post("/api/picker/directories", json={"path": str(not_a_dir)})

    assert response.status_code == 422


def test_get_tournaments_lists_db_files_and_excludes_backups(picker_client, tmp_path):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    (allowed / "regional.db").write_text("x")
    (allowed / "regional.db.pre-migration-20260101120000.bak").write_text("x")
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.get("/api/picker/tournaments", params={"dir": str(allowed)})

    assert response.status_code == 200
    filenames = [t["filename"] for t in response.json()["tournaments"]]
    assert filenames == ["regional.db"]


def test_get_tournaments_403s_for_a_directory_outside_the_allowlist(picker_client, tmp_path):
    outside = tmp_path / "not-allowed"
    outside.mkdir()

    response = picker_client.get("/api/picker/tournaments", params={"dir": str(outside)})

    assert response.status_code == 403


def test_get_tournaments_404s_for_a_missing_directory(picker_client, tmp_path):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.get(
        "/api/picker/tournaments", params={"dir": str(allowed / "gone")}
    )

    assert response.status_code == 404


def test_create_tournament_triggers_a_restart_and_records_the_path(
    picker_client, tmp_path, execve_calls
):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/create", json={"directory": str(allowed), "filename": "new.db"}
    )

    assert response.status_code == 202
    assert len(execve_calls) == 1
    config = load_config(picker_client.app.state.picker_config_path)
    assert config.last_opened_path == str((allowed / "new.db").resolve())


def test_create_tournament_403s_for_a_disallowed_directory(picker_client, tmp_path, execve_calls):
    outside = tmp_path / "not-allowed"
    outside.mkdir()

    response = picker_client.post(
        "/api/picker/create", json={"directory": str(outside), "filename": "new.db"}
    )

    assert response.status_code == 403
    assert execve_calls == []


def test_create_tournament_409s_if_the_file_already_exists(picker_client, tmp_path, execve_calls):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    (allowed / "existing.db").write_text("x")
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/create", json={"directory": str(allowed), "filename": "existing.db"}
    )

    assert response.status_code == 409
    assert execve_calls == []


def test_create_tournament_422s_on_a_path_traversal_filename(picker_client, tmp_path, execve_calls):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/create",
        json={"directory": str(allowed), "filename": "../../etc/evil.db"},
    )

    assert response.status_code == 422
    assert execve_calls == []


def test_open_tournament_triggers_a_restart_and_records_the_path(
    picker_client, tmp_path, execve_calls
):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    (allowed / "regional.db").write_text("x")
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/open", json={"path": str(allowed / "regional.db")}
    )

    assert response.status_code == 202
    assert len(execve_calls) == 1


def test_open_tournament_403s_for_a_backup_file(picker_client, tmp_path, execve_calls):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    backup = allowed / "regional.db.pre-migration-20260101120000.bak"
    backup.write_text("x")
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post("/api/picker/open", json={"path": str(backup)})

    assert response.status_code == 403
    assert execve_calls == []


def test_open_tournament_404s_for_a_missing_file(picker_client, tmp_path, execve_calls):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/open", json={"path": str(allowed / "missing.db")}
    )

    assert response.status_code == 404
    assert execve_calls == []


def test_create_tournament_logs_rather_than_crashes_if_the_restart_itself_fails(
    picker_client, tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(
        "os.execve",
        lambda executable, args, env: (_ for _ in ()).throw(OSError("no such executable")),
    )
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/create", json={"directory": str(allowed), "filename": "new.db"}
    )

    # The client already got its 202 -- os.execve failing afterwards, in
    # the background task, must not surface as a request failure.
    assert response.status_code == 202
    assert "ERROR: failed to restart the server process" in capsys.readouterr().err
```

Note: `switch_router` is admin-gated (via `require_admin`, which needs a real event/token to test meaningfully) and is exercised in Task 5 instead, against the full normal app fixture — not here.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_picker_router.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'tournament_server.schemas.picker'`

- [ ] **Step 3: Implement the schemas**

Create `server/src/tournament_server/schemas/picker.py`:

```python
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class DirectoryListResponse(BaseModel):
    allowed_directories: list[str]


class AddDirectoryRequest(BaseModel):
    path: str


class TournamentFileEntry(BaseModel):
    filename: str
    path: str
    size_bytes: int
    modified_at: str


class TournamentListResponse(BaseModel):
    tournaments: list[TournamentFileEntry]


class CreateTournamentRequest(BaseModel):
    directory: str
    filename: str


class OpenTournamentRequest(BaseModel):
    path: str


class RestartingResponse(BaseModel):
    status: Literal["restarting"]
```

- [ ] **Step 4: Implement the router**

Create `server/src/tournament_server/routers/picker.py`:

```python
from __future__ import annotations

import asyncio
import os
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
    except OSError as exc:
        print(f"ERROR: failed to restart the server process: {exc}", file=sys.stderr)


def _validate_filename(filename: str) -> None:
    if not filename or filename in (".", "..") or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=422, detail="Invalid filename")
    if not filename.endswith(".db"):
        raise HTTPException(status_code=422, detail="Filename must end in .db")


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
    resolved = directory.resolve() / payload.filename
    if resolved.exists():
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
    if not is_path_allowed(path, config.allowed_directories) or path.suffix != ".db":
        raise HTTPException(status_code=403, detail="File is not allowed")
    if not path.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    config.last_opened_path = str(path.resolve())
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_picker_router.py -v`
Expected: PASS (14 tests)

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/schemas/picker.py server/src/tournament_server/routers/picker.py server/tests/test_picker_router.py
git commit -m "Add the picker API router: directories, tournaments, create, open, switch"
```

---

## Task 3: Extract shared static-UI mounting

This is a pure refactor with no new behavior: `app.py`'s inline static-file-serving block moves into a small shared module so the picker app (Task 4) can reuse it verbatim, rather than duplicating ~25 lines. `server/tests/test_static_ui.py` already covers this behavior through `create_app()` and must still pass unmodified — it is the regression check for this task, not a task deliverable to edit.

**Files:**
- Create: `server/src/tournament_server/static_ui.py`
- Modify: `server/src/tournament_server/app.py`

**Interfaces:**
- Produces (used by Task 4): `def mount_static_admin_ui(app: FastAPI, static_dir: str | None) -> None`

- [ ] **Step 1: Confirm the regression baseline passes first**

Run: `cd server && .venv/bin/python -m pytest tests/test_static_ui.py -v`
Expected: PASS (7 tests) — this is the safety net for the refactor below.

- [ ] **Step 2: Create the shared module**

Create `server/src/tournament_server/static_ui.py` with the exact block currently in `app.py` (see `server/src/tournament_server/app.py` around its `resolved_static_dir = ...` line), extracted as a function:

```python
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

# .../tournament_server/static_ui.py -> tournament_server -> src -> server -> repo root
DEFAULT_STATIC_DIR = (
    Path(__file__).resolve().parents[3] / "frontend" / "apps" / "admin" / "dist"
)


def mount_static_admin_ui(app: FastAPI, static_dir: str | None) -> None:
    """Serves the admin SPA's built static assets, with a catch-all
    fallback to index.html for client-side routes. Shared by create_app
    and create_picker_app so both serve the exact same build -- the SPA
    itself detects picker mode at runtime via an API probe, not via a
    different static build.

    Must be registered AFTER any app-specific routes (e.g. /health): the
    catch-all "/{full_path:path}" route would otherwise shadow them,
    since Starlette matches routes in registration order, not by
    specificity."""
    resolved_static_dir = Path(static_dir) if static_dir else DEFAULT_STATIC_DIR
    if not resolved_static_dir.is_dir():
        # Degrade to "no static JS/CSS served" rather than crashing --
        # StaticFiles raises at construction time if the directory is
        # missing, which would take down startup outright for a partial
        # or custom build.
        return

    assets_dir = resolved_static_dir / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="admin-ui-assets")

    @app.get("/{full_path:path}")
    def serve_admin_ui(full_path: str) -> FileResponse:
        if full_path.startswith(("api/", "ws/")) or full_path == "health":
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(resolved_static_dir / "index.html")
```

- [ ] **Step 3: Update `app.py` to use it**

In `server/src/tournament_server/app.py`:

- Remove the `_DEFAULT_STATIC_DIR` module-level constant.
- Remove `from fastapi.responses import FileResponse` and `from fastapi.staticfiles import StaticFiles` from the top imports (no longer used directly in this file); remove `HTTPException` from the `from fastapi import FastAPI, HTTPException, Request` line too, leaving `from fastapi import FastAPI, Request`.
- Add `from tournament_server.static_ui import mount_static_admin_ui`.
- Replace the entire block from the `# Registered after /health ...` comment through the end of the `create_app` function (the `resolved_static_dir = ...` assignment, the `if resolved_static_dir.is_dir(): ...` block including the nested `serve_admin_ui` route) with:

```python
    mount_static_admin_ui(app, settings.static_dir)

    return app
```

- [ ] **Step 4: Run the tests to verify the refactor is behavior-preserving**

Run: `cd server && .venv/bin/python -m pytest tests/test_static_ui.py -v`
Expected: PASS (7 tests, unchanged) — if any fail, the extraction changed behavior; compare against the pre-refactor block line by line.

Also run the full backend suite to catch any other regression:

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: PASS, same count as before this task.

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/static_ui.py server/src/tournament_server/app.py
git commit -m "Extract static admin-UI mounting into a shared, reusable module"
```

---

## Task 4: The picker app

**Files:**
- Create: `server/src/tournament_server/picker_app.py`
- Test: `server/tests/test_picker_app.py`

**Interfaces:**
- Consumes: Task 1's `picker_config`, Task 2's `routers.picker`, Task 3's `static_ui.mount_static_admin_ui`.
- Produces (used by Task 5): `def create_picker_app(config_path: Path, static_dir: str | None = None) -> FastAPI`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_picker_app.py`:

```python
from tournament_server.picker_app import create_picker_app
from fastapi.testclient import TestClient


def test_health_endpoint(tmp_path):
    app = create_picker_app(tmp_path / "server-config.json")
    with TestClient(app) as client:
        response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_picker_routes_are_mounted(tmp_path):
    app = create_picker_app(tmp_path / "server-config.json")
    with TestClient(app) as client:
        response = client.get("/api/picker/directories")
    assert response.status_code == 200
    assert response.json() == {"allowed_directories": []}


def test_serves_the_admin_static_build(tmp_path):
    static_dir = tmp_path / "dist"
    static_dir.mkdir()
    (static_dir / "index.html").write_text("<html>admin ui</html>")

    app = create_picker_app(tmp_path / "server-config.json", static_dir=str(static_dir))
    with TestClient(app) as client:
        response = client.get("/")

    assert response.status_code == 200
    assert "admin ui" in response.text


def test_switch_router_is_not_mounted_on_the_picker_app(tmp_path):
    app = create_picker_app(tmp_path / "server-config.json")
    with TestClient(app) as client:
        response = client.post("/api/picker/switch")
    assert response.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_picker_app.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'tournament_server.picker_app'`

- [ ] **Step 3: Implement `picker_app.py`**

Create `server/src/tournament_server/picker_app.py`:

```python
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI

from tournament_server.routers import picker
from tournament_server.static_ui import mount_static_admin_ui


def create_picker_app(config_path: Path, static_dir: str | None = None) -> FastAPI:
    """Builds the minimal app served when no tournament path is
    resolvable yet -- see the design spec's "Picker API surface"
    section. Every route here is unauthenticated by design: nothing
    sensitive exists until a tournament has been created."""
    app = FastAPI(title="Tournament Server (picker)")
    app.state.picker_config_path = config_path

    app.include_router(picker.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    mount_static_admin_ui(app, static_dir)
    return app
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_picker_app.py -v`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/picker_app.py server/tests/test_picker_app.py
git commit -m "Add create_picker_app: the minimal app served with no tournament resolved"
```

---

## Task 5: Wire main.py, settings.py, app.py, and cli.py together

This is the task that actually changes what the server does at boot. It widens `Settings.db_path` to `str | None` (no more silent default of `"./tournament.db"`), teaches `main.py`'s `_startup()` to resolve a path via the picker config before deciding which app to build, mounts the admin-gated switch endpoint on the normal app, and fixes the one other place (`tm migrate`) that relied on the old always-a-string default.

**Files:**
- Modify: `server/src/tournament_server/settings.py`
- Modify: `server/src/tournament_server/main.py`
- Modify: `server/src/tournament_server/app.py`
- Modify: `server/src/tournament_server/cli.py`
- Modify: `server/tests/conftest.py`
- Test: `server/tests/test_main.py` (extend)
- Test: `server/tests/test_cli.py` (extend)
- Create: `server/tests/test_picker_switch.py`

**Interfaces:**
- Consumes: Task 1's `picker_config` (`resolve_config_path`, `resolve_active_db_path`, `load_config`, `save_config`), Task 2's `routers.picker.switch_router`, Task 4's `create_picker_app`.

- [ ] **Step 1: Update `settings.py`**

Replace `server/src/tournament_server/settings.py` in full:

```python
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    db_path: str | None = None
    plugins_root: str = "./plugins"
    device_idle_timeout_minutes: int = 60
    host: str = "0.0.0.0"
    port: int = 8000
    static_dir: str | None = None

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=os.environ.get("TOURNAMENT_DB_PATH"),
            plugins_root=os.environ.get("TOURNAMENT_PLUGINS_ROOT", "./plugins"),
            device_idle_timeout_minutes=int(
                os.environ.get("TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES", "60")
            ),
            host=os.environ.get("TOURNAMENT_HOST", "0.0.0.0"),
            port=int(os.environ.get("TOURNAMENT_PORT", "8000")),
            static_dir=os.environ.get("TOURNAMENT_STATIC_DIR"),
        )
```

(`db_path` no longer defaults to `"./tournament.db"` — an unset `TOURNAMENT_DB_PATH` now means "no legacy override", not "use the default file". Every real caller of `create_app()` always passes `db_path` explicitly already, so this is safe — see Step 3.)

- [ ] **Step 2: Write the failing `test_main.py` additions**

Append to `server/tests/test_main.py` (keep the existing test and its imports; add `json` and `urllib` imports at the top):

```python
import json
import urllib.error
import urllib.request


def _free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


def _wait_for_http(url: str, timeout: float = 10.0) -> None:
    import time

    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except Exception:
            time.sleep(0.1)
    raise TimeoutError(f"Server never came up at {url}")


def test_main_serves_the_picker_app_when_no_tournament_is_resolvable(tmp_path):
    port = _free_port()
    env = dict(os.environ)
    env.pop("TOURNAMENT_DB_PATH", None)
    env["TOURNAMENT_HOST"] = "127.0.0.1"
    env["TOURNAMENT_PORT"] = str(port)
    env["TOURNAMENT_CONFIG_PATH"] = str(tmp_path / "server-config.json")

    process = subprocess.Popen([sys.executable, "-m", "tournament_server.main"], env=env)
    try:
        _wait_for_http(f"http://127.0.0.1:{port}/health")
        response = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/picker/directories")
        assert response.status == 200
    finally:
        process.terminate()
        process.wait(timeout=10)


def test_main_auto_reopens_the_last_opened_tournament(tmp_path):
    port = _free_port()
    config_path = tmp_path / "server-config.json"
    config_path.write_text(
        json.dumps(
            {"allowed_directories": [], "last_opened_path": str(tmp_path / "regional.db")}
        )
    )
    env = dict(os.environ)
    env.pop("TOURNAMENT_DB_PATH", None)
    env["TOURNAMENT_HOST"] = "127.0.0.1"
    env["TOURNAMENT_PORT"] = str(port)
    env["TOURNAMENT_CONFIG_PATH"] = str(config_path)

    process = subprocess.Popen([sys.executable, "-m", "tournament_server.main"], env=env)
    try:
        _wait_for_http(f"http://127.0.0.1:{port}/health")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/picker/directories")
            picker_mode = True
        except urllib.error.HTTPError as exc:
            picker_mode = exc.code != 404
        assert not picker_mode
    finally:
        process.terminate()
        process.wait(timeout=10)


def test_main_clears_last_opened_path_on_schema_mismatch(tmp_path):
    from tournament_server.db import Base, make_engine

    bad_db = tmp_path / "old.db"
    engine = make_engine(str(bad_db))
    tables_to_create = [
        t for name, t in Base.metadata.tables.items() if name != "scoring_devices"
    ]
    Base.metadata.create_all(engine, tables=tables_to_create)

    config_path = tmp_path / "server-config.json"
    config_path.write_text(
        json.dumps({"allowed_directories": [], "last_opened_path": str(bad_db)})
    )
    port = _free_port()
    env = dict(os.environ)
    env.pop("TOURNAMENT_DB_PATH", None)
    env["TOURNAMENT_HOST"] = "127.0.0.1"
    env["TOURNAMENT_PORT"] = str(port)
    env["TOURNAMENT_CONFIG_PATH"] = str(config_path)

    result = subprocess.run(
        [sys.executable, "-m", "tournament_server.main"],
        capture_output=True,
        text=True,
        timeout=30,
        env=env,
    )

    assert result.returncode == 1
    assert "ERROR:" in result.stderr
    updated = json.loads(config_path.read_text())
    assert updated["last_opened_path"] is None
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_main.py -v`
Expected: The three new tests FAIL (picker mode never reached / `ModuleNotFoundError` for `tournament_server.picker_app` from within the subprocess, surfacing as a connection failure or non-1 exit code depending on where the import breaks).

- [ ] **Step 4: Rewrite `main.py`**

Replace `server/src/tournament_server/main.py` in full:

```python
from __future__ import annotations

import sys
from typing import TYPE_CHECKING

import uvicorn

from tournament_server.app import create_app
from tournament_server.migrations import SchemaMismatchError
from tournament_server.network import NoFreePortError, find_free_port
from tournament_server.picker_app import create_picker_app
from tournament_server.picker_config import (
    load_config,
    resolve_active_db_path,
    resolve_config_path,
    save_config,
)
from tournament_server.settings import Settings

if TYPE_CHECKING:
    from fastapi import FastAPI


def _startup() -> tuple[Settings, int, "FastAPI"]:
    """Loads settings, probes for a free port, and builds either the
    normal app (a tournament path is resolved) or the picker app (none
    is yet). Isolated from module level so it's actually testable: a
    subprocess invocation of this module (see test_main.py) exercises
    the real `ERROR: ... / exit 1` clean-failure path on NoFreePortError
    or SchemaMismatchError, and both the picker-mode and normal-mode
    boot paths."""
    settings = Settings.from_env()
    config_path = resolve_config_path()

    try:
        port = find_free_port(settings.host, settings.port)
    except NoFreePortError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    resolved_db_path = resolve_active_db_path(settings.db_path)

    if resolved_db_path is None:
        app = create_picker_app(config_path, static_dir=settings.static_dir)
        return settings, port, app

    try:
        app = create_app(
            db_path=resolved_db_path,
            port=port,
            static_dir=settings.static_dir,
            config_path=config_path,
        )
    except SchemaMismatchError as exc:
        if settings.db_path is None:
            # resolved_db_path came from the picker config's
            # last_opened_path (not the legacy env var override) --
            # clear it so the *next* restart falls back to the picker
            # instead of retrying the same bad file forever.
            config = load_config(config_path)
            config.last_opened_path = None
            save_config(config_path, config)
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)

    return settings, port, app


_settings, _port, app = _startup()


def run() -> None:
    try:
        uvicorn.run(app, host=_settings.host, port=_port)
    except OSError as exc:
        # Defense-in-depth for the narrow TOCTOU race between the port
        # probe in _startup() and this real bind — a racing process
        # could steal the port in between. Not expected to be hit in
        # normal operation.
        print(f"ERROR: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    run()
```

- [ ] **Step 5: Update `app.py`: accept a `config_path`, guard against a missing `db_path`, mount `switch_router`**

In `server/src/tournament_server/app.py`:

- Add `config_path: Path | None = None` as a new parameter to `create_app`, after `static_dir`.
- Add `from tournament_server.picker_config import resolve_config_path` to the imports.
- Add `picker` to the existing `from tournament_server.routers import (...)` tuple, in alphabetical position (between `participation` and `plugins`).
- Immediately before `engine = make_engine(settings.db_path)`, add:
  ```python
  if settings.db_path is None:
      raise ValueError("create_app() requires a resolved db_path")
  ```
- After the existing `app.state.port = settings.port` line, add:
  ```python
  app.state.picker_config_path = config_path if config_path is not None else resolve_config_path()
  ```
- Add `app.include_router(picker.switch_router)` alongside the other `app.include_router(...)` calls (next to `server_info.router` is a reasonable spot).

- [ ] **Step 6: Update `cli.py`'s migrate fallback**

In `server/src/tournament_server/cli.py`, remove `from tournament_server.settings import Settings` and replace `_run_migrate`'s body:

```python
def _run_migrate(db_path: str | None) -> int:
    from tournament_server.db import make_engine
    from tournament_server.migrations import (
        MigrationOutcome,
        SchemaMismatchError,
        ensure_schema_current,
    )
    from tournament_server.picker_config import resolve_active_db_path

    resolved_db_path = resolve_active_db_path(db_path)
    if resolved_db_path is None:
        print(
            "ERROR: no database path given. Pass --db-path, set "
            "TOURNAMENT_DB_PATH, or open a tournament through the server first."
        )
        return 1

    engine = make_engine(resolved_db_path)

    try:
        outcome = ensure_schema_current(engine, resolved_db_path)
    except SchemaMismatchError as exc:
        print(f"ERROR: {exc}")
        return 1

    messages = {
        MigrationOutcome.ALREADY_CURRENT: f"{resolved_db_path}: schema already up to date.",
        MigrationOutcome.FRESH_INSTALL: f"{resolved_db_path}: created fresh with the current schema.",
        MigrationOutcome.STAMPED_BASELINE: (
            f"{resolved_db_path}: matched the current baseline schema; stamped as up to date."
        ),
        MigrationOutcome.UPGRADED: (
            f"{resolved_db_path}: applied pending migrations; a pre-migration backup was created."
        ),
    }
    print(messages[outcome])
    return 0
```

Add one regression test to `server/tests/test_cli.py` for the new "nothing resolvable" branch:

```python
def test_migrate_command_reports_a_clean_error_with_no_path_resolvable(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("TOURNAMENT_DB_PATH", raising=False)
    monkeypatch.setenv("TOURNAMENT_CONFIG_PATH", str(tmp_path / "server-config.json"))

    exit_code = main(["migrate"])

    assert exit_code == 1
    captured = capsys.readouterr()
    assert "ERROR" in captured.out
```

- [ ] **Step 7: Isolate `conftest.py`'s app fixtures from the real picker config**

Every existing fixture in `server/tests/conftest.py` (`client`, `cooperative_client`, `captain_pick_client`) calls `create_app(db_path=..., plugins_root=...)` without a `config_path` — after Step 5, that would default to `resolve_config_path()`, which (absent a test-set `TOURNAMENT_CONFIG_PATH`) points at the real `$HOME/.tournament-admin/server-config.json` on whatever machine runs the tests. That's harmless for tests that never touch `/api/picker/*`, but `test_picker_switch.py` (Step 9) does, so give every fixture an isolated, per-test config path now rather than leaving a trap for later.

In each of the three fixtures, change:
```python
    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
```
to:
```python
    app = create_app(
        db_path=db_path, plugins_root=str(plugins_root), config_path=tmp_path / "server-config.json"
    )
```
(Same edit in all three places `create_app(db_path=db_path, plugins_root=str(plugins_root))` appears in `conftest.py`.)

- [ ] **Step 8: Run the `test_main.py`, `test_cli.py`, and full suite to verify everything passes**

Run: `cd server && .venv/bin/python -m pytest tests/test_main.py tests/test_cli.py -v`
Expected: PASS (4 tests in test_main.py, existing `test_cli.py` tests plus the new one)

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: PASS, whole suite green (this exercises every other test file's `create_app()` call still working with the widened `Settings.db_path` type).

- [ ] **Step 9: Write and pass the switch-endpoint test**

Create `server/tests/test_picker_switch.py`:

```python
from auth_helpers import bearer, login_as


def test_switch_tournament_requires_authentication(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    response = raw.post("/api/picker/switch")
    assert response.status_code == 401


def test_switch_tournament_403s_for_non_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")
    response = raw.post("/api/picker/switch", headers=bearer(attendee_token))
    assert response.status_code == 403


def test_switch_tournament_clears_last_opened_path_and_restarts(client, monkeypatch):
    from tournament_server.picker_config import PickerConfig, load_config, save_config

    calls = []
    monkeypatch.setattr(
        "os.execve", lambda executable, args, env: calls.append((executable, args))
    )
    config_path = client.app.state.picker_config_path
    save_config(config_path, PickerConfig(allowed_directories=[], last_opened_path="/whatever.db"))

    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/picker/switch")

    assert response.status_code == 202
    assert len(calls) == 1
    assert load_config(config_path).last_opened_path is None
```

Run: `cd server && .venv/bin/python -m pytest tests/test_picker_switch.py -v`
Expected: PASS (3 tests)

- [ ] **Step 10: Commit**

```bash
git add server/src/tournament_server/settings.py server/src/tournament_server/main.py \
        server/src/tournament_server/app.py server/src/tournament_server/cli.py \
        server/tests/conftest.py server/tests/test_main.py server/tests/test_cli.py \
        server/tests/test_picker_switch.py
git commit -m "Wire the picker layer into main.py's startup resolution and the normal app"
```

---

## Task 6: Frontend picker screen

**Files:**
- Create: `frontend/apps/admin/src/useRestartPoll.ts`
- Create: `frontend/apps/admin/src/routes/PickerRoute.tsx`
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/useRestartPoll.test.ts`

**Interfaces:**
- Produces (used by Task 7): `useRestartPoll(onReady?: () => void): { status: "idle" | "waiting" | "timedOut"; start: () => void }`

- [ ] **Step 1: Write the failing hook test**

Create `frontend/apps/admin/tests/unit/useRestartPoll.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRestartPoll } from "../../src/useRestartPoll";

describe("useRestartPoll", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("calls onReady once the server starts responding 404 (normal mode)", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        callCount += 1;
        return new Response(null, { status: callCount < 3 ? 200 : 404 });
      })
    );
    const onReady = vi.fn();

    const { result } = renderHook(() => useRestartPoll(onReady));
    act(() => {
      result.current.start();
    });

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("moves to timedOut if the server never comes back within the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 }))
    );
    const onReady = vi.fn();

    const { result } = renderHook(() => useRestartPoll(onReady));
    act(() => {
      result.current.start();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000);
    });

    expect(result.current.status).toBe("timedOut");
    expect(onReady).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/apps/admin && npm test -- useRestartPoll`
Expected: FAIL with a module-not-found error for `../../src/useRestartPoll`

- [ ] **Step 3: Implement the hook**

Create `frontend/apps/admin/src/useRestartPoll.ts`:

```ts
import { useState } from "react";
import { apiRequest, ApiError } from "@tournament-admin/shared";

const RESTART_POLL_INTERVAL_MS = 500;
const RESTART_POLL_TIMEOUT_MS = 15_000;

export type RestartPollStatus = "idle" | "waiting" | "timedOut";

/**
 * After a picker action (create/open/switch) triggers a server restart,
 * this polls GET /api/picker/directories until it stops being reachable
 * in picker mode: a 404 means the restarted process is now the normal
 * app (this route only exists in picker mode), which is the signal to
 * call `onReady`. Defaults to a full page reload, since the caller is
 * always about to land on a different app state entirely.
 */
export function useRestartPoll(onReady: () => void = () => window.location.reload()) {
  const [status, setStatus] = useState<RestartPollStatus>("idle");

  function start() {
    setStatus("waiting");
    const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;

    const tick = async () => {
      try {
        await apiRequest("/api/picker/directories");
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          onReady();
          return;
        }
      }
      if (Date.now() > deadline) {
        setStatus("timedOut");
        return;
      }
      setTimeout(() => void tick(), RESTART_POLL_INTERVAL_MS);
    };
    void tick();
  }

  return { status, start };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend/apps/admin && npm test -- useRestartPoll`
Expected: PASS (2 tests)

- [ ] **Step 5: Add the i18n keys**

In `frontend/apps/admin/src/i18n/en/admin.json`, add a new top-level `"picker"` object (after `"teams"` is fine) and a `"switchAction"` key under `"shell"`:

```json
  "shell": {
    "logout": "Log out",
    "dashboardLink": "Dashboard",
    "eventSetupLink": "Event & plugins",
    "rolesLink": "Role passwords",
    "dismiss": "Dismiss",
    "divisionsLink": "Divisions",
    "teamsLink": "Teams"
  },
```
becomes (only the addition shown, keep every existing key):
```json
  "shell": {
    "logout": "Log out",
    "dashboardLink": "Dashboard",
    "eventSetupLink": "Event & plugins",
    "rolesLink": "Role passwords",
    "dismiss": "Dismiss",
    "divisionsLink": "Divisions",
    "teamsLink": "Teams"
  },
  "picker": {
    "heading": "Start a tournament",
    "createAction": "Create New Tournament",
    "openAction": "Open Existing Tournament",
    "directoryLabel": "Directory",
    "directoryPlaceholder": "Choose a directory...",
    "addDirectoryAction": "Add a directory...",
    "newDirectoryLabel": "New directory path",
    "addDirectoryConfirm": "Add",
    "filenameLabel": "Filename",
    "createSubmit": "Create",
    "tournamentFileLabel": "Tournament file",
    "openSubmit": "Open",
    "backAction": "Back",
    "restartingMessage": "Starting tournament…",
    "restartTimedOutMessage": "Tournament failed to start — check the server logs.",
    "switchAction": "Switch Tournament"
  },
```

In `frontend/apps/admin/src/i18n/zh/admin.json`, add the matching block:

```json
  "picker": {
    "heading": "启动赛事",
    "createAction": "创建新赛事",
    "openAction": "打开现有赛事",
    "directoryLabel": "目录",
    "directoryPlaceholder": "选择一个目录...",
    "addDirectoryAction": "添加目录...",
    "newDirectoryLabel": "新目录路径",
    "addDirectoryConfirm": "添加",
    "filenameLabel": "文件名",
    "createSubmit": "创建",
    "tournamentFileLabel": "赛事文件",
    "openSubmit": "打开",
    "backAction": "返回",
    "restartingMessage": "正在启动赛事…",
    "restartTimedOutMessage": "赛事启动失败——请检查服务器日志。",
    "switchAction": "切换赛事"
  },
```

(Insert both blocks in the same relative position — after `"shell"` — in each file, and don't forget the trailing comma on the preceding object.)

- [ ] **Step 6: Implement `PickerRoute.tsx`**

Create `frontend/apps/admin/src/routes/PickerRoute.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { useRestartPoll } from "../useRestartPoll";

interface DirectoryListResponse {
  allowed_directories: string[];
}

interface TournamentFileEntry {
  filename: string;
  path: string;
  size_bytes: number;
  modified_at: string;
}

interface TournamentListResponse {
  tournaments: TournamentFileEntry[];
}

type PickerScreen = "menu" | "create" | "open";

export function PickerRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [screen, setScreen] = useState<PickerScreen>("menu");
  const [directory, setDirectory] = useState("");
  const [filename, setFilename] = useState("");
  const [selectedFile, setSelectedFile] = useState("");
  const [newDirectoryPath, setNewDirectoryPath] = useState("");
  const [addingDirectory, setAddingDirectory] = useState(false);
  const { status: restartStatus, start: startRestartPoll } = useRestartPoll();

  const { data: directoriesData } = useQuery({
    queryKey: ["picker", "directories"],
    queryFn: () => apiRequest<DirectoryListResponse>("/api/picker/directories"),
  });
  const directories = directoriesData?.allowed_directories ?? [];

  const { data: tournamentsData } = useQuery({
    queryKey: ["picker", "tournaments", directory],
    queryFn: () =>
      apiRequest<TournamentListResponse>(
        `/api/picker/tournaments?dir=${encodeURIComponent(directory)}`
      ),
    enabled: screen === "open" && directory !== "",
  });
  const tournaments = tournamentsData?.tournaments ?? [];

  const addDirectoryMutation = useMutation({
    mutationFn: (path: string) =>
      apiRequest<DirectoryListResponse>("/api/picker/directories", {
        method: "POST",
        body: { path },
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(["picker", "directories"], result);
      setNewDirectoryPath("");
      setAddingDirectory(false);
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<unknown>("/api/picker/create", {
        method: "POST",
        body: { directory, filename },
      }),
    onSuccess: () => startRestartPoll(),
  });

  const openMutation = useMutation({
    mutationFn: () =>
      apiRequest<unknown>("/api/picker/open", {
        method: "POST",
        body: { path: selectedFile },
      }),
    onSuccess: () => startRestartPoll(),
  });

  if (restartStatus === "waiting") {
    return (
      <main>
        <p role="status">{t("picker.restartingMessage")}</p>
      </main>
    );
  }

  function renderDirectoryPicker(selected: string, onSelect: (dir: string) => void) {
    return (
      <div>
        <label htmlFor="picker-directory">{t("picker.directoryLabel")}</label>
        <select
          id="picker-directory"
          value={selected}
          onChange={(event) => onSelect(event.target.value)}
        >
          <option value="">{t("picker.directoryPlaceholder")}</option>
          {directories.map((dir) => (
            <option key={dir} value={dir}>
              {dir}
            </option>
          ))}
        </select>
        {!addingDirectory && (
          <button type="button" onClick={() => setAddingDirectory(true)}>
            {t("picker.addDirectoryAction")}
          </button>
        )}
        {addingDirectory && (
          <div>
            <label htmlFor="picker-new-directory">{t("picker.newDirectoryLabel")}</label>
            <input
              id="picker-new-directory"
              value={newDirectoryPath}
              onChange={(event) => setNewDirectoryPath(event.target.value)}
            />
            <button
              type="button"
              onClick={() => addDirectoryMutation.mutate(newDirectoryPath)}
              disabled={addDirectoryMutation.isPending}
            >
              {t("picker.addDirectoryConfirm")}
            </button>
            {addDirectoryMutation.isError && (
              <p role="alert">
                {addDirectoryMutation.error instanceof ApiError
                  ? addDirectoryMutation.error.detail
                  : t("errors.generic")}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  if (screen === "menu") {
    return (
      <main>
        <h1>{t("picker.heading")}</h1>
        {restartStatus === "timedOut" && (
          <p role="alert">{t("picker.restartTimedOutMessage")}</p>
        )}
        <button onClick={() => setScreen("create")}>{t("picker.createAction")}</button>
        <button onClick={() => setScreen("open")}>{t("picker.openAction")}</button>
      </main>
    );
  }

  if (screen === "create") {
    return (
      <main>
        <h1>{t("picker.createAction")}</h1>
        {renderDirectoryPicker(directory, setDirectory)}
        <label htmlFor="picker-filename">{t("picker.filenameLabel")}</label>
        <input
          id="picker-filename"
          value={filename}
          onChange={(event) => setFilename(event.target.value)}
        />
        <button
          onClick={() => createMutation.mutate()}
          disabled={createMutation.isPending || !directory || !filename}
        >
          {t("picker.createSubmit")}
        </button>
        {createMutation.isError && (
          <p role="alert">
            {createMutation.error instanceof ApiError
              ? createMutation.error.detail
              : t("errors.generic")}
          </p>
        )}
        <button onClick={() => setScreen("menu")}>{t("picker.backAction")}</button>
      </main>
    );
  }

  return (
    <main>
      <h1>{t("picker.openAction")}</h1>
      {renderDirectoryPicker(directory, (dir) => {
        setDirectory(dir);
        setSelectedFile("");
      })}
      <label htmlFor="picker-tournament-file">{t("picker.tournamentFileLabel")}</label>
      <select
        id="picker-tournament-file"
        value={selectedFile}
        onChange={(event) => setSelectedFile(event.target.value)}
      >
        <option value="">{t("picker.directoryPlaceholder")}</option>
        {tournaments.map((file) => (
          <option key={file.path} value={file.path}>
            {file.filename}
          </option>
        ))}
      </select>
      <button
        onClick={() => openMutation.mutate()}
        disabled={openMutation.isPending || !selectedFile}
      >
        {t("picker.openSubmit")}
      </button>
      {openMutation.isError && (
        <p role="alert">
          {openMutation.error instanceof ApiError
            ? openMutation.error.detail
            : t("errors.generic")}
        </p>
      )}
      <button onClick={() => setScreen("menu")}>{t("picker.backAction")}</button>
    </main>
  );
}
```

- [ ] **Step 7: Wire the router**

Replace `frontend/apps/admin/src/router.tsx` in full:

```tsx
import { createBrowserRouter, redirect } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead } from "./types";
import { EventsNewRoute } from "./routes/EventsNewRoute";
import { LoginRoute } from "./routes/LoginRoute";
import { PickerRoute } from "./routes/PickerRoute";
import { AuthenticatedLayout } from "./routes/AuthenticatedLayout";
import { DashboardRoute } from "./routes/DashboardRoute";
import { EventSetupRoute } from "./routes/EventSetupRoute";
import { SettingsRolesRoute } from "./routes/SettingsRolesRoute";
import { DivisionsRoute } from "./routes/DivisionsRoute";
import { TeamsRoute } from "./routes/TeamsRoute";

async function isPickerMode(): Promise<boolean> {
  try {
    await apiRequest<unknown>("/api/picker/directories");
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return false;
    }
    throw err;
  }
}

async function eventExists(): Promise<boolean> {
  try {
    await apiRequest<EventRead>("/api/event");
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return false;
    }
    throw err;
  }
}

/**
 * The picker check MUST run before the event check, which in turn MUST
 * run before any token check: GET /api/picker/directories only exists
 * while no tournament has been chosen, and GET /api/event is
 * unauthenticated on the backend (no role credentials exist until an
 * event is created) -- see the tournament-picker design spec's
 * "Architecture & data flow" section and admin-ui-shell's "Routing &
 * guards" section. A fresh install with no tournament at all must reach
 * the picker screen before either later check is even meaningful.
 */
async function rootLoader() {
  if (await isPickerMode()) {
    return redirect("/picker");
  }
  if (!(await eventExists())) {
    return redirect("/events/new");
  }
  return null;
}

async function eventsNewLoader() {
  if (await isPickerMode()) {
    return redirect("/picker");
  }
  if (await eventExists()) {
    return redirect("/login");
  }
  return null;
}

async function loginLoader() {
  if (await isPickerMode()) {
    return redirect("/picker");
  }
  return null;
}

async function pickerLoader() {
  if (!(await isPickerMode())) {
    // A tournament is already resolved (e.g. direct navigation to
    // /picker after the server already restarted) -- send back to the
    // root, which re-runs its own resolution from here.
    return redirect("/");
  }
  return null;
}

export const router = createBrowserRouter([
  {
    path: "/picker",
    loader: pickerLoader,
    element: <PickerRoute />,
  },
  {
    path: "/events/new",
    loader: eventsNewLoader,
    element: <EventsNewRoute />,
  },
  {
    path: "/login",
    loader: loginLoader,
    element: <LoginRoute />,
  },
  {
    path: "/",
    loader: rootLoader,
    element: <AuthenticatedLayout />,
    children: [
      { index: true, element: <DashboardRoute /> },
      { path: "events/setup", element: <EventSetupRoute /> },
      { path: "settings/roles", element: <SettingsRolesRoute /> },
      { path: "divisions", element: <DivisionsRoute /> },
      { path: "teams", element: <TeamsRoute /> },
    ],
  },
]);
```

- [ ] **Step 8: Type-check and run the unit suite**

Run: `cd frontend/apps/admin && npm run typecheck && npm test`
Expected: Clean typecheck; all unit tests pass (including the new `useRestartPoll` tests).

- [ ] **Step 9: Commit**

```bash
git add frontend/apps/admin/src/useRestartPoll.ts frontend/apps/admin/src/routes/PickerRoute.tsx \
        frontend/apps/admin/src/router.tsx frontend/apps/admin/src/i18n/en/admin.json \
        frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/unit/useRestartPoll.test.ts
git commit -m "Add the tournament picker screen and wire it into the router"
```

---

## Task 7: Switch Tournament action

**Files:**
- Modify: `frontend/apps/admin/src/components/AppShell.tsx`

**Interfaces:**
- Consumes: Task 6's `useRestartPoll`.

- [ ] **Step 1: Update `AppShell.tsx`**

Replace `frontend/apps/admin/src/components/AppShell.tsx` in full:

```tsx
import { NavLink, Outlet } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, useAuth } from "@tournament-admin/shared";
import { TransientErrorBanner } from "./TransientErrorBanner";
import { DebugEventPanel } from "./DebugEventPanel";
import { useRestartPoll } from "../useRestartPoll";

export function AppShell() {
  const { t } = useTranslation();
  const { role, logout } = useAuth();
  const { status: switchStatus, start: startSwitchPoll } = useRestartPoll();

  const switchMutation = useMutation({
    mutationFn: () => apiRequest<unknown>("/api/picker/switch", { method: "POST" }),
    onSuccess: () => startSwitchPoll(),
  });

  if (switchStatus === "waiting") {
    return (
      <div>
        <p role="status">{t("picker.restartingMessage")}</p>
      </div>
    );
  }

  return (
    <div>
      <header>
        <p>{t("app.title")}</p>
        <button onClick={() => void logout()}>{t("shell.logout")}</button>
      </header>
      <TransientErrorBanner />
      {role === "admin" && (
        <nav>
          <NavLink to="/">{t("shell.dashboardLink")}</NavLink>
          <NavLink to="/events/setup">{t("shell.eventSetupLink")}</NavLink>
          <NavLink to="/settings/roles">{t("shell.rolesLink")}</NavLink>
          <NavLink to="/divisions">{t("shell.divisionsLink")}</NavLink>
          <NavLink to="/teams">{t("shell.teamsLink")}</NavLink>
        </nav>
      )}
      {role === "admin" && (
        <button onClick={() => switchMutation.mutate()} disabled={switchMutation.isPending}>
          {t("picker.switchAction")}
        </button>
      )}
      {switchMutation.isError && <p role="alert">{t("errors.generic")}</p>}
      {role === "admin" && <DebugEventPanel />}
      <main>
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Type-check and run the unit suite**

Run: `cd frontend/apps/admin && npm run typecheck && npm test`
Expected: Clean typecheck; `AuthenticatedLayout.test.tsx` (which renders `AppShell` indirectly) still passes — none of its tests click the new "Switch Tournament" button, so `switchMutation`/`useRestartPoll` are mounted but never triggered there.

- [ ] **Step 3: Commit**

```bash
git add frontend/apps/admin/src/components/AppShell.tsx
git commit -m "Add an admin-only Switch Tournament action to the app shell"
```

---

## Task 8: End-to-end test

This is the one place the self-exec restart and the reconnect poll get proven against a real, restarting server process in a real browser. It needs its own isolated backend and frontend dev server pair — distinct ports from the shared `playwright.config.ts` pair (`8123`/`5183`), which stay running for every other spec in this suite — because this flow's server process is expected to actually restart itself mid-test.

**Files:**
- Create: `frontend/apps/admin/tests/e2e/tournamentPicker.spec.ts`

- [ ] **Step 1: Write the test**

Create `frontend/apps/admin/tests/e2e/tournamentPicker.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

// package.json sets "type": "module", so this spec file loads as native
// ESM -- __dirname isn't available directly (same reason
// playwright.config.ts computes it this way).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ISOLATED_BACKEND_PORT = 8124;
const ISOLATED_FRONTEND_PORT = 5184;
const BASE_URL = `http://127.0.0.1:${ISOLATED_FRONTEND_PORT}`;

function waitForPort(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ port, host }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

test.describe.serial("tournament picker: fresh server bootstrap", () => {
  test.describe.configure({ timeout: 90_000 });

  let backendProcess: ChildProcess;
  let frontendProcess: ChildProcess;
  let tournamentDir: string;

  test.beforeAll(async () => {
    tournamentDir = mkdtempSync(path.join(tmpdir(), "tournament-admin-picker-e2e-"));
    const configPath = path.join(tournamentDir, "server-config.json");

    const serverRoot = path.resolve(__dirname, "../../../../server");
    backendProcess = spawn(".venv/bin/python", ["-m", "tournament_server.main"], {
      cwd: serverRoot,
      env: {
        ...process.env,
        TOURNAMENT_CONFIG_PATH: configPath,
        TOURNAMENT_PLUGINS_ROOT: path.join(tournamentDir, "plugins"),
        TOURNAMENT_HOST: "127.0.0.1",
        TOURNAMENT_PORT: String(ISOLATED_BACKEND_PORT),
      },
      stdio: "pipe",
      shell: true,
    });
    await waitForPort(ISOLATED_BACKEND_PORT, "127.0.0.1", 30_000);

    const adminAppRoot = path.resolve(__dirname, "../../");
    frontendProcess = spawn(
      "npm",
      ["run", "dev", "--", "--port", String(ISOLATED_FRONTEND_PORT), "--strictPort"],
      {
        cwd: adminAppRoot,
        env: { ...process.env, VITE_BACKEND_PORT: String(ISOLATED_BACKEND_PORT) },
        stdio: "pipe",
        shell: true,
      }
    );
    await waitForPort(ISOLATED_FRONTEND_PORT, "127.0.0.1", 30_000);
  });

  test.afterAll(() => {
    backendProcess?.kill();
    frontendProcess?.kill();
  });

  test("creating a new tournament restarts the server into the event-setup flow", async ({
    page,
  }) => {
    await page.goto(BASE_URL);
    await expect(page.getByRole("heading", { name: "Start a tournament" })).toBeVisible();

    await page.getByRole("button", { name: "Create New Tournament" }).click();
    await page.getByRole("button", { name: "Add a directory..." }).click();
    await page.getByLabel("New directory path").fill(tournamentDir);
    await page.getByRole("button", { name: "Add", exact: true }).click();

    // The newly added directory's <option> value is the server's own
    // resolved (canonical) path -- on this project's Linux dev sandbox,
    // an mkdtemp()'d path under the system temp directory already
    // resolves to itself, so the exact string typed above is also the
    // option's value.
    await page.getByLabel("Directory").selectOption(tournamentDir);
    await page.getByLabel("Filename").fill("e2e-created.db");
    await page.getByRole("button", { name: "Create", exact: true }).click();

    // The backend process restarts itself (os.execve) after this
    // request -- give the reconnect poll (15s timeout, see
    // useRestartPoll.ts) room to see the new process come up.
    await expect(page.getByRole("heading", { name: "Set up your event" })).toBeVisible({
      timeout: 20_000,
    });
  });

  test("switching tournaments from the running app returns to the picker", async ({ page }) => {
    await page.goto(`${BASE_URL}/events/new`);
    await page.getByLabel("Event name").fill("Picker E2E Event");
    await page.getByLabel(/Initial password/).fill("picker-e2e-pw");
    await page.getByRole("button", { name: "Create event" }).click();
    await expect(page).toHaveURL(/\/login$/);

    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill("picker-e2e-pw");
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(BASE_URL + "/");

    await page.getByRole("button", { name: "Switch Tournament" }).click();
    await expect(page.getByRole("heading", { name: "Start a tournament" })).toBeVisible({
      timeout: 20_000,
    });
  });
});
```

- [ ] **Step 2: Run the new spec on its own**

Run: `cd frontend/apps/admin && npx playwright test tournamentPicker.spec.ts`
Expected: PASS (2 tests). If the backend subprocess fails to start, check its stderr by temporarily changing `stdio: "pipe"` to `stdio: "inherit"` on the `spawn(...)` call for `backendProcess` while debugging, then revert.

- [ ] **Step 3: Run the full E2E suite to confirm no interference with the shared backend**

Run: `cd frontend/apps/admin && npm run test:e2e`
Expected: PASS, all spec files green — this spec's isolated processes run on distinct ports (`8124`/`5184`) from the shared pair (`8123`/`5183`), so it neither depends on nor disturbs any other spec file.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/admin/tests/e2e/tournamentPicker.spec.ts
git commit -m "Add an E2E test driving the picker through a real server restart"
```

---

## Final checks

- [ ] Run the full backend suite: `cd server && .venv/bin/python -m pytest -q` — expect all green, no reduction in test count from before this plan.
- [ ] Run the full frontend unit suite: `cd frontend/apps/admin && npm test` — expect all green.
- [ ] Run the full E2E suite: `cd frontend/apps/admin && npm run test:e2e` — expect all green, including both the existing shared-backend specs and this plan's isolated `tournamentPicker.spec.ts`.
- [ ] Update `server/CLAUDE.md` with a short "Tournament picker" section describing: the config file's location/env-var override, the legacy `TOURNAMENT_DB_PATH` precedence, the `is_path_allowed` containment invariant, and the self-exec restart mechanism (so a future contributor touching `main.py` or `app.py` understands why `_startup()` looks the way it does).
- [ ] Update `frontend/CLAUDE.md` with a short note on the picker-mode detection pattern (`isPickerMode()` in `router.tsx`) and the `useRestartPoll` hook, alongside the existing "Bootstrap ordering" section.
