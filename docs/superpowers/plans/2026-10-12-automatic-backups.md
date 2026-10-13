# Automatic Backups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server snapshots the tournament file every 5 minutes when it changed and before risky steps, an admin can list, take and restore backups from a Backups page, and a damaged file is restored from the picker.

**Architecture:** A new `services/backups.py` owns everything about backup files (naming, the SQLite online-backup snapshot, listing, retention, checking a backup, swapping a file in). A `BackupManager` on `app.state.backups` adds per-process state (last backup, last error, change detection) and a lock; a lifespan task drives the 5-minute timer. Restores go through the picker config (`pending_restore`) and the existing `os.execve` restart; `main._startup()` performs the swap before any engine opens the file, and starts the picker in "damaged" mode when `PRAGMA quick_check` fails.

**Tech Stack:** Python 3.12 stdlib `sqlite3` (online backup API), FastAPI, SQLAlchemy, pytest; React 19, TanStack Query, react-i18next, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-12-automatic-backups-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere (code, comments, strings, commit messages).
- Every backend change ships with pytest tests; every UI change with Vitest and Playwright tests (root `CLAUDE.md`).
- Snapshots use `sqlite3.Connection.backup`, never a plain file copy of the live file.
- Backup file name: `<stem>-<YYYY-MM-DD>-<HHMMSS>-<reason>.db` in server local time; a same-second clash appends `-2`, `-3`, …
- Interval: every 300 seconds, only when the newest `audit_log` id grew since the last snapshot; at startup the current newest id is the baseline.
- Retention: keep the newest 50 `interval` files; never delete any other reason automatically.
- Backup folder default: `<tournament dir>/backups/<tournament stem>/`; a custom folder lives in the picker config's `backup_dirs` (key: the tournament file's resolved path).
- A backup file gets the tournament file's permission bits.
- A failed snapshot before a risky step never blocks the step; it sets `last_error`.
- Every backups endpoint is admin-only (403 for every other role). Picker endpoints stay unauthenticated.
- Schema: no model or migration changes in this plan.
- Every user-facing string goes through i18n, English and Chinese.
- Isolated Playwright ports for this feature: backend 8131, frontend 5191.
- Commit messages are plain sentences and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A custom backup folder that disappears or becomes read-only after it was set (USB stick pulled) → interval and risky-step snapshots fail quietly with `last_error` shown, and the step still succeeds. Pinned in Task 3 (`test_risky_step_still_succeeds_when_the_snapshot_fails`) and Task 1 (`test_snapshot_failure_records_last_error`).
2. The live file's newest writes are still in the WAL when a snapshot runs → the snapshot must contain them. Pinned in Task 1 (`test_snapshot_includes_writes_still_in_the_wal`).
3. Restoring while the old process's `-wal` file still exists → the swapped-in file must not be replayed against the old WAL. Pinned in Task 4 (`test_startup_swap_replaces_the_file_and_removes_wal_files`).
4. Two snapshots in the same second (Back up now right after a risky step) → distinct names, both listed, newest first. Pinned in Task 1 (`test_same_second_snapshots_get_a_suffix_and_sort_newest_first`).
5. A restore from a backup made by an older build (squashed baseline edited since) → refused with 409 and nothing changed, rather than a server that won't start. Pinned in Task 4 (`test_restore_refuses_a_backup_from_an_older_build`).

---

### Task 1: Backup service — snapshot, list, retention, manager

**Files:**
- Create: `server/src/tournament_server/services/backups.py`
- Modify: `server/src/tournament_server/picker_config.py` (two new `PickerConfig` fields)
- Test: `server/tests/test_backups_service.py`

**Interfaces:**
- Produces (used by Tasks 2-5):
  - `INTERVAL_SECONDS = 300`, `KEEP_INTERVAL = 50`
  - `class BackupError(Exception)`
  - `@dataclass(frozen=True) class BackupEntry: filename: str; created_at: datetime (aware, UTC); reason: str; size_bytes: int; path: Path; sequence: int`
  - `config_key(db_path: str) -> str`
  - `default_folder(db_path: str) -> Path`
  - `backup_folder(db_path: str, config_path: Path) -> Path`
  - `list_backups(folder: Path, stem: str) -> list[BackupEntry]` (newest first)
  - `take_snapshot(db_path: str, folder: Path, reason: str, now: datetime | None = None) -> BackupEntry`
  - `class BackupManager(db_path: str, config_path: Path)` with `.db_path`, `.config_path`, `.last_backup_at: datetime | None`, `.last_error: dict | None` (`{"message": str, "at": datetime}`), `.folder() -> Path`, `.folder_is_default() -> bool`, `.list() -> list[BackupEntry]`, `.snapshot(reason) -> BackupEntry` (raises `BackupError`), `.snapshot_quietly(reason) -> None`, `.interval_tick() -> BackupEntry | None`
  - `PickerConfig.backup_dirs: dict[str, str]`, `PickerConfig.pending_restore: dict[str, str] | None`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_backups_service.py`:

```python
from __future__ import annotations

import datetime as dt
import os
import sqlite3
import stat
from pathlib import Path

from tournament_server.db import make_engine
from tournament_server.migrations import ensure_schema_current
from tournament_server.picker_config import PickerConfig, load_config, save_config
from tournament_server.services import backups
from tournament_server.services.backups import BackupError, BackupManager


def _tournament(tmp_path: Path, name: str = "spring.db") -> str:
    db_path = str(tmp_path / name)
    engine = make_engine(db_path)
    ensure_schema_current(engine, db_path)
    engine.dispose()
    return db_path


def _write(db_path: str, name: str) -> None:
    conn = sqlite3.connect(db_path)
    conn.execute("INSERT INTO events (name, created_at) VALUES (?, '2026-01-01 00:00:00')", (name,))
    conn.execute(
        "INSERT INTO audit_log (timestamp, table_name, action, actor) "
        "VALUES ('2026-01-01 00:00:00', 'events', 'insert', 'test')"
    )
    conn.commit()
    conn.close()


def _event_names(path: Path) -> list[str]:
    conn = sqlite3.connect(str(path))
    try:
        return [row[0] for row in conn.execute("SELECT name FROM events ORDER BY id")]
    finally:
        conn.close()


def test_default_folder_sits_next_to_the_tournament(tmp_path):
    db_path = _tournament(tmp_path)
    assert backups.default_folder(db_path) == (tmp_path / "backups" / "spring").resolve()


def test_backup_folder_uses_the_custom_folder_from_the_picker_config(tmp_path):
    db_path = _tournament(tmp_path)
    config_path = tmp_path / "server-config.json"
    save_config(config_path, PickerConfig(backup_dirs={backups.config_key(db_path): str(tmp_path / "usb")}))
    assert backups.backup_folder(db_path, config_path) == tmp_path / "usb"
    assert load_config(config_path).pending_restore is None


def test_snapshot_is_a_named_copy_with_the_sources_permissions(tmp_path):
    db_path = _tournament(tmp_path)
    _write(db_path, "Spring League")
    os.chmod(db_path, 0o600)
    folder = tmp_path / "backups" / "spring"
    now = dt.datetime(2026, 10, 12, 14, 30, 5).astimezone()

    entry = backups.take_snapshot(db_path, folder, "manual", now=now)

    assert entry.filename == "spring-2026-10-12-143005-manual.db"
    assert entry.reason == "manual"
    assert entry.path == folder / entry.filename
    assert stat.S_IMODE(os.stat(entry.path).st_mode) == 0o600
    assert _event_names(entry.path) == ["Spring League"]
    assert not [p for p in folder.iterdir() if p.name.endswith(".partial")]


def test_snapshot_includes_writes_still_in_the_wal(tmp_path):
    db_path = _tournament(tmp_path)
    holder = sqlite3.connect(db_path)  # keeps the WAL from being checkpointed on close
    holder.execute("PRAGMA journal_mode=WAL")
    holder.execute("PRAGMA wal_autocheckpoint=0")
    holder.execute("INSERT INTO events (name, created_at) VALUES ('In WAL', '2026-01-01 00:00:00')")
    holder.commit()
    assert Path(f"{db_path}-wal").stat().st_size > 0

    entry = backups.take_snapshot(db_path, tmp_path / "b", "manual")
    holder.close()

    assert _event_names(entry.path) == ["In WAL"]


def test_same_second_snapshots_get_a_suffix_and_sort_newest_first(tmp_path):
    db_path = _tournament(tmp_path)
    folder = tmp_path / "b"
    now = dt.datetime(2026, 10, 12, 9, 0, 0).astimezone()
    first = backups.take_snapshot(db_path, folder, "before-schedule", now=now)
    second = backups.take_snapshot(db_path, folder, "manual", now=now)
    third = backups.take_snapshot(db_path, folder, "manual", now=now)

    assert second.filename == "spring-2026-10-12-090000-manual.db"
    assert third.filename == "spring-2026-10-12-090000-manual-2.db"
    listed = backups.list_backups(folder, "spring")
    assert [e.filename for e in listed] == [third.filename, second.filename, first.filename]
    assert [e.reason for e in listed] == ["manual", "manual", "before-schedule"]


def test_list_ignores_other_files_and_other_tournaments(tmp_path):
    db_path = _tournament(tmp_path)
    folder = tmp_path / "b"
    backups.take_snapshot(db_path, folder, "manual")
    (folder / "notes.txt").write_text("x")
    (folder / "autumn-2026-10-12-090000-manual.db").write_bytes(b"")
    (folder / ".spring-2026-10-12-090000-manual.db.partial").write_bytes(b"")
    assert len(backups.list_backups(folder, "spring")) == 1
    assert backups.list_backups(tmp_path / "missing", "spring") == []


def test_manager_interval_tick_only_snapshots_after_a_change(tmp_path):
    db_path = _tournament(tmp_path)
    manager = BackupManager(db_path, tmp_path / "server-config.json")

    assert manager.interval_tick() is None  # nothing changed since startup
    _write(db_path, "Changed")
    entry = manager.interval_tick()
    assert entry is not None and entry.reason == "interval"
    assert manager.interval_tick() is None  # nothing changed since that snapshot
    assert manager.last_backup_at == entry.created_at


def test_manager_keeps_the_newest_50_interval_snapshots_and_every_other_reason(tmp_path, monkeypatch):
    db_path = _tournament(tmp_path)
    manager = BackupManager(db_path, tmp_path / "server-config.json")
    monkeypatch.setattr(backups, "KEEP_INTERVAL", 3)
    base = dt.datetime(2026, 10, 12, 8, 0, 0).astimezone()
    folder = manager.folder()
    for minute in range(5):
        backups.take_snapshot(db_path, folder, "interval", now=base + dt.timedelta(minutes=minute))
    backups.take_snapshot(db_path, folder, "before-finals", now=base)
    backups.take_snapshot(db_path, folder, "manual", now=base)

    _write(db_path, "Changed")
    newest = manager.interval_tick()

    reasons = [e.reason for e in manager.list()]
    assert reasons.count("interval") == 3
    assert "before-finals" in reasons and "manual" in reasons
    assert manager.list()[0].filename == newest.filename


def test_snapshot_failure_records_last_error(tmp_path):
    db_path = _tournament(tmp_path)
    config_path = tmp_path / "server-config.json"
    blocker = tmp_path / "not-a-folder"
    blocker.write_text("a file where the folder should be")
    save_config(config_path, PickerConfig(backup_dirs={backups.config_key(db_path): str(blocker)}))
    manager = BackupManager(db_path, config_path)

    try:
        manager.snapshot("manual")
        raised = False
    except BackupError:
        raised = True
    assert raised
    assert manager.last_error is not None and manager.last_error["message"]
    manager.snapshot_quietly("before-finals")  # never raises

    save_config(config_path, PickerConfig())
    manager.snapshot("manual")
    assert manager.last_error is None
    assert manager.folder_is_default()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_backups_service.py -q`
Expected: FAIL with `ImportError: cannot import name 'backups'` (and `PickerConfig` has no `backup_dirs`).

- [ ] **Step 3: Add the picker config fields**

In `server/src/tournament_server/picker_config.py`, extend the dataclass and `load_config`:

```python
@dataclass
class PickerConfig:
    allowed_directories: list[str] = field(default_factory=list)
    last_opened_path: str | None = None
    # Tournament file's resolved path -> its custom backup folder.
    backup_dirs: dict[str, str] = field(default_factory=dict)
    # {"target": tournament path, "source": backup path}, applied by main._startup().
    pending_restore: dict[str, str] | None = None
```

```python
    raw = json.loads(config_path.read_text())
    return PickerConfig(
        allowed_directories=list(raw.get("allowed_directories", [])),
        last_opened_path=raw.get("last_opened_path"),
        backup_dirs=dict(raw.get("backup_dirs") or {}),
        pending_restore=raw.get("pending_restore"),
    )
```

- [ ] **Step 4: Write the service**

Create `server/src/tournament_server/services/backups.py`:

```python
"""Backups of the tournament file: timed and before-risky-step snapshots,
listing, retention, checking a backup, and swapping one in.

Snapshots use SQLite's online backup API so they are complete and
consistent while other requests write, including writes still in the WAL.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import os
import re
import shutil
import sqlite3
import stat
import threading
from dataclasses import dataclass
from pathlib import Path

from tournament_server.db import utc_now
from tournament_server.picker_config import load_config

logger = logging.getLogger(__name__)

INTERVAL_SECONDS = 300
KEEP_INTERVAL = 50
INTERVAL = "interval"
MANUAL = "manual"
BEFORE_RESTORE = "before-restore"


class BackupError(Exception):
    """A snapshot could not be written."""


@dataclass(frozen=True)
class BackupEntry:
    filename: str
    created_at: dt.datetime
    reason: str
    size_bytes: int
    path: Path
    sequence: int


def config_key(db_path: str) -> str:
    return str(Path(db_path).resolve())


def default_folder(db_path: str) -> Path:
    path = Path(db_path).resolve()
    return path.parent / "backups" / path.stem


def backup_folder(db_path: str, config_path: Path) -> Path:
    custom = load_config(config_path).backup_dirs.get(config_key(db_path))
    return Path(custom) if custom else default_folder(db_path)


def _name_pattern(stem: str) -> re.Pattern[str]:
    return re.compile(
        rf"^{re.escape(stem)}-(\d{{4}}-\d{{2}}-\d{{2}})-(\d{{6}})-([a-z]+(?:-[a-z]+)*)(?:-(\d+))?\.db$"
    )


def _entry(path: Path, match: re.Match[str]) -> BackupEntry:
    local = dt.datetime.strptime(match[1] + match[2], "%Y-%m-%d%H%M%S").astimezone()
    return BackupEntry(
        filename=path.name,
        created_at=local.astimezone(dt.UTC),
        reason=match[3],
        size_bytes=path.stat().st_size,
        path=path,
        sequence=int(match[4] or 1),
    )


def list_backups(folder: Path, stem: str) -> list[BackupEntry]:
    """This tournament's backups in `folder`, newest first."""
    if not folder.is_dir():
        return []
    pattern = _name_pattern(stem)
    entries = []
    for path in folder.iterdir():
        match = pattern.match(path.name)
        if match and path.is_file():
            entries.append(_entry(path, match))
    entries.sort(key=lambda e: (e.created_at, e.sequence, e.filename), reverse=True)
    return entries


def copy_mode(source: Path, target: Path) -> None:
    os.chmod(target, stat.S_IMODE(os.stat(source).st_mode))


def take_snapshot(db_path: str, folder: Path, reason: str, now: dt.datetime | None = None) -> BackupEntry:
    """Writes one snapshot into `folder` and returns it. Raises BackupError."""
    source = Path(db_path)
    tmp: Path | None = None
    try:
        folder.mkdir(parents=True, exist_ok=True)
        local = (now or dt.datetime.now()).astimezone()
        base = f"{source.stem}-{local:%Y-%m-%d-%H%M%S}-{reason}"
        name = f"{base}.db"
        sequence = 2
        while (folder / name).exists():
            name = f"{base}-{sequence}.db"
            sequence += 1
        tmp = folder / f".{name}.partial"
        src = sqlite3.connect(str(source))
        try:
            dst = sqlite3.connect(str(tmp))
            try:
                src.backup(dst)
            finally:
                dst.close()
        finally:
            src.close()
        copy_mode(source, tmp)
        final = folder / name
        os.replace(tmp, final)
    except (OSError, sqlite3.Error) as exc:
        if tmp is not None:
            tmp.unlink(missing_ok=True)
        raise BackupError(str(exc)) from exc
    match = _name_pattern(source.stem).match(final.name)
    assert match is not None
    return _entry(final, match)


class BackupManager:
    """Per-process backup state for one tournament file."""

    def __init__(self, db_path: str, config_path: Path) -> None:
        self.db_path = db_path
        self.config_path = config_path
        self.last_backup_at: dt.datetime | None = None
        self.last_error: dict | None = None
        self._lock = threading.Lock()
        self._last_audit_id = self._current_audit_id()

    def folder(self) -> Path:
        return backup_folder(self.db_path, self.config_path)

    def folder_is_default(self) -> bool:
        return config_key(self.db_path) not in load_config(self.config_path).backup_dirs

    def list(self) -> list[BackupEntry]:
        return list_backups(self.folder(), Path(self.db_path).stem)

    def _current_audit_id(self) -> int:
        conn = sqlite3.connect(self.db_path)
        try:
            row = conn.execute("SELECT MAX(id) FROM audit_log").fetchone()
        except sqlite3.Error:
            return 0
        finally:
            conn.close()
        return row[0] or 0

    def snapshot(self, reason: str) -> BackupEntry:
        with self._lock:
            audit_id = self._current_audit_id()
            try:
                entry = take_snapshot(self.db_path, self.folder(), reason)
            except BackupError as exc:
                self.last_error = {"message": str(exc), "at": utc_now()}
                logger.error("Backup (%s) failed: %s", reason, exc)
                raise
            self._last_audit_id = audit_id
            self.last_backup_at = entry.created_at
            self.last_error = None
            if reason == INTERVAL:
                self._prune()
            return entry

    def snapshot_quietly(self, reason: str) -> None:
        """For risky steps: a failure is recorded, never raised."""
        try:
            self.snapshot(reason)
        except BackupError:
            pass

    def interval_tick(self) -> BackupEntry | None:
        if self._current_audit_id() <= self._last_audit_id:
            return None
        try:
            return self.snapshot(INTERVAL)
        except BackupError:
            return None

    def _prune(self) -> None:
        intervals = [e for e in self.list() if e.reason == INTERVAL]
        for entry in intervals[KEEP_INTERVAL:]:
            try:
                entry.path.unlink()
            except OSError as exc:
                logger.warning("Could not delete old backup %s: %s", entry.path, exc)


async def run_interval(manager: BackupManager, seconds: float = INTERVAL_SECONDS) -> None:
    """The lifespan task: one interval check every `seconds`, off the event loop."""
    while True:
        await asyncio.sleep(seconds)
        try:
            await asyncio.to_thread(manager.interval_tick)
        except Exception:  # noqa: BLE001 - the timer must keep running
            logger.exception("Interval backup check failed")
```

Note: `_prune` reads `KEEP_INTERVAL` at call time through the module global, so the test's `monkeypatch.setattr(backups, "KEEP_INTERVAL", 3)` takes effect.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_backups_service.py -q`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/services/backups.py server/src/tournament_server/picker_config.py server/tests/test_backups_service.py
git commit -m "Add the backup service: online-backup snapshots with stable names, newest-first listing, interval change detection and retention of the last 50 timed snapshots

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Backups API, the interval timer, and a boot id

**Files:**
- Create: `server/src/tournament_server/schemas/backups.py`
- Create: `server/src/tournament_server/routers/backups.py`
- Modify: `server/src/tournament_server/app.py` (manager on `app.state.backups`, lifespan task, include router)
- Modify: `server/src/tournament_server/routers/time_sync.py` (`boot_id`)
- Test: `server/tests/test_backups_api.py`

**Interfaces:**
- Consumes: Task 1's `BackupManager`, `BackupError`, `config_key`, `run_interval`.
- Produces:
  - `app.state.backups: BackupManager` (every normal app)
  - `GET /api/backups` → `BackupsRead {folder: str, folder_is_default: bool, last_backup_at: datetime | null, last_error: {message, at} | null, backups: BackupEntryRead[]}`; `BackupEntryRead {filename, created_at, reason, size_bytes}`
  - `POST /api/backups` → 201 `BackupEntryRead`; 500 `{"detail": "The backup failed: <reason>"}`
  - `PUT /api/backups/folder` body `{folder: string | null}` → `BackupsRead`; 422 for a relative path or an unwritable one
  - `GET /api/time-sync` → `{server_time, boot_id}`
  - `routers/backups.py`'s `router` (Task 4 adds the restore route to it)

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_backups_api.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as


def _event(client) -> None:
    assert client.post("/api/event", json={"name": "Spring"}).status_code == 201


def test_backups_start_empty_with_the_default_folder(client, tmp_path):
    _event(client)
    body = client.get("/api/backups").json()
    assert body["folder"] == str((tmp_path / "backups" / "test").resolve())
    assert body["folder_is_default"] is True
    assert body["backups"] == []
    assert body["last_backup_at"] is None
    assert body["last_error"] is None


def test_back_up_now_adds_a_manual_backup(client):
    _event(client)
    response = client.post("/api/backups")
    assert response.status_code == 201, response.text
    entry = response.json()
    assert entry["reason"] == "manual"
    assert entry["size_bytes"] > 0
    body = client.get("/api/backups").json()
    assert [b["filename"] for b in body["backups"]] == [entry["filename"]]
    assert body["last_backup_at"] is not None


def test_folder_can_be_changed_and_reset(client, tmp_path):
    _event(client)
    custom = tmp_path / "usb" / "event-backups"
    response = client.put("/api/backups/folder", json={"folder": str(custom)})
    assert response.status_code == 200, response.text
    assert response.json()["folder"] == str(custom.resolve())
    assert response.json()["folder_is_default"] is False
    client.post("/api/backups")
    assert len(list(custom.glob("test-*-manual.db"))) == 1

    reset = client.put("/api/backups/folder", json={"folder": "  "})
    assert reset.json()["folder_is_default"] is True
    assert client.put("/api/backups/folder", json={"folder": None}).json()["folder_is_default"] is True


@pytest.mark.parametrize("folder", ["relative/path", "~nobody-such-user/x"])
def test_folder_must_be_a_full_path(client, folder):
    _event(client)
    response = client.put("/api/backups/folder", json={"folder": folder})
    assert response.status_code == 422
    assert response.json()["detail"] == "Enter a full folder path, starting from the root."


def test_folder_that_cannot_be_written_is_refused(client, tmp_path):
    _event(client)
    blocker = tmp_path / "a-file"
    blocker.write_text("x")
    response = client.put("/api/backups/folder", json={"folder": str(blocker / "sub")})
    assert response.status_code == 422
    assert response.json()["detail"].startswith("Can't write to ")


def test_back_up_now_reports_a_failure(client, tmp_path):
    _event(client)
    blocker = tmp_path / "a-file"
    blocker.write_text("x")
    client.app.state.backups.config_path.write_text(
        '{"allowed_directories": [], "backup_dirs": {"%s": "%s"}}'
        % (str((tmp_path / "test.db").resolve()), str(blocker))
    )
    response = client.post("/api/backups")
    assert response.status_code == 500
    assert response.json()["detail"].startswith("The backup failed: ")
    assert client.get("/api/backups").json()["last_error"]["message"]


@pytest.mark.parametrize("role", ["scorer", "judge", "referee", "attendee", "display_device", "front_desk"])
def test_backups_are_admin_only(client, role):
    _event(client)
    raw = TestClient(client.app)
    headers = bearer(login_as(raw, role))
    assert raw.get("/api/backups", headers=headers).status_code == 403
    assert raw.post("/api/backups", headers=headers).status_code == 403
    assert raw.put("/api/backups/folder", json={"folder": None}, headers=headers).status_code == 403
    # Task 4 adds this route:
    # assert raw.post("/api/backups/x.db/restore", headers=headers).status_code == 403


def test_time_sync_reports_a_stable_boot_id(client):
    first = client.get("/api/time-sync").json()
    second = client.get("/api/time-sync").json()
    assert isinstance(first["boot_id"], str) and len(first["boot_id"]) >= 16
    assert first["boot_id"] == second["boot_id"]


def test_the_interval_task_runs_inside_the_app(client):
    """The lifespan task exists and is a running task (the 300 s sleep keeps it pending)."""
    _event(client)
    task = client.app.state.backup_task
    assert task is not None and not task.done()
```

Note: `login_as` and `bearer` come from `tests/auth_helpers.py`; the `client` fixture's database is `tmp_path / "test.db"`, so its stem is `test` and the default folder is `tmp_path / "backups" / "test"`. The restore assertion stays commented out until Task 4 adds the route.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_backups_api.py -q`
Expected: FAIL (404 on `/api/backups`, `KeyError: 'boot_id'`, no `backup_task`).

- [ ] **Step 3: Schemas**

Create `server/src/tournament_server/schemas/backups.py`:

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class BackupEntryRead(BaseModel):
    filename: str
    created_at: dt.datetime
    reason: str
    size_bytes: int


class BackupErrorRead(BaseModel):
    message: str
    at: dt.datetime


class BackupsRead(BaseModel):
    folder: str
    folder_is_default: bool
    last_backup_at: dt.datetime | None
    last_error: BackupErrorRead | None
    backups: list[BackupEntryRead]


class BackupFolderUpdate(BaseModel):
    folder: str | None
```

- [ ] **Step 4: Router**

Create `server/src/tournament_server/routers/backups.py`:

```python
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
```

(`~nobody-such-user/x` is not absolute, so it gets the relative-path 422 — the server never expands `~`.)

- [ ] **Step 5: Boot id**

Replace `server/src/tournament_server/routers/time_sync.py` with:

```python
from __future__ import annotations

import uuid

from fastapi import APIRouter
from pydantic import BaseModel

from tournament_server.db import utc_now

router = APIRouter(prefix="/api/time-sync", tags=["time-sync"])

# Fixed for the life of this process. A restore restarts the server from the
# normal app into the normal app, so the admin UI waits for a different id.
BOOT_ID = uuid.uuid4().hex


class TimeSyncResponse(BaseModel):
    server_time: str
    boot_id: str


@router.get("", response_model=TimeSyncResponse)
def get_server_time() -> TimeSyncResponse:
    return TimeSyncResponse(server_time=utc_now().isoformat(), boot_id=BOOT_ID)
```

- [ ] **Step 6: Wire the manager and the timer into `create_app`**

In `server/src/tournament_server/app.py`:

1. Add imports: `import contextlib` at the top with the other stdlib imports; add `backups` to the `from tournament_server.routers import (...)` list (alphabetical, after `awards`); add `from tournament_server.services.backups import BackupManager, run_interval`.
2. After the startup self-heal `with session_factory() as db:` block and before `@asynccontextmanager`, add:

```python
    picker_config_path = config_path if config_path is not None else resolve_config_path()
    backup_manager = BackupManager(settings.db_path, picker_config_path)
```

3. Replace the lifespan with:

```python
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        realtime.set_event_loop(app, asyncio.get_running_loop())
        await _recover_in_flight_matches(app)
        app.state.backup_task = asyncio.create_task(run_interval(app.state.backups))
        yield
        app.state.backup_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await app.state.backup_task
```

4. Replace `app.state.picker_config_path = config_path if config_path is not None else resolve_config_path()` with:

```python
    app.state.picker_config_path = picker_config_path
    app.state.backups = backup_manager
    app.state.backup_task = None
```

5. Add `app.include_router(backups.router)` after `app.include_router(server_info.router)`.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_backups_api.py tests/test_backups_service.py -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/src/tournament_server/schemas/backups.py server/src/tournament_server/routers/backups.py server/src/tournament_server/routers/time_sync.py server/src/tournament_server/app.py server/tests/test_backups_api.py
git commit -m "Add the backups API (list, back up now, change folder), run the five-minute backup check from the app lifespan, and report a per-process boot id from time sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Snapshots before risky steps

**Files:**
- Modify: `server/src/tournament_server/routers/event.py` (`set_active_session`, `_change_game_plugin`)
- Modify: `server/src/tournament_server/routers/schedule.py` (`generate_schedule`, `clear_schedule`)
- Modify: `server/src/tournament_server/routers/qualification.py` (`finalize`, `reopen`)
- Modify: `server/src/tournament_server/routers/finals.py` (`start_finals`, `delete_finals`)
- Modify: `server/src/tournament_server/routers/sessions.py` (`remove_session`)
- Modify: `server/src/tournament_server/routers/awards.py` (`finalize_awards`)
- Modify: `server/tests/conftest.py` (`backup_reasons` fixture)
- Test: `server/tests/test_backup_risky_steps.py`

**Interfaces:**
- Consumes: `request.app.state.backups.snapshot_quietly(reason: str)` from Task 2.
- Produces: the reasons `before-active-session`, `before-schedule`, `before-clear-schedule`, `before-qualification`, `before-finals`, `before-delete-session`, `before-game-plugin`, `before-awards-finalize`.

- [ ] **Step 1: Add the recording fixture**

Append to `server/tests/conftest.py`:

```python
@pytest.fixture()
def backup_reasons():
    """Records the reason of every risky-step snapshot instead of taking it.

    Usage: `reasons = backup_reasons(client)`; the returned list fills as
    requests run."""

    def attach(test_client):
        reasons: list[str] = []
        test_client.app.state.backups.snapshot_quietly = reasons.append
        return reasons

    return attach
```

- [ ] **Step 2: Write the failing tests**

Create `server/tests/test_backup_risky_steps.py`:

```python
from __future__ import annotations

from award_helpers import create_session
from schedule_helpers import schedule, set_playing_windows
from test_qualification_finalize import _finalize, _uneven_session


def _event_with_teams(client, count=4, plugin="example-game") -> tuple[int, list[int]]:
    client.post("/api/event", json={"name": "Regional"})
    client.post("/api/event/game-plugin", json={"name": plugin})
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    teams = []
    for i in range(count):
        team_id = client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        client.post(f"/api/sessions/{session_id}/participants", json={"team_id": team_id, "checked_in": True})
        teams.append(team_id)
    return session_id, teams


def test_active_session_switch_backs_up_first(client, backup_reasons):
    reasons = backup_reasons(client)
    session_id, _ = _event_with_teams(client)
    assert client.post("/api/event/active-session", json={"session_id": 99999}).status_code == 404
    assert reasons == []
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    assert reasons == ["before-active-session"]


def test_game_plugin_change_backs_up_only_on_a_real_change(client, backup_reasons):
    client.post("/api/event", json={"name": "Regional"})
    reasons = backup_reasons(client)
    assert client.post("/api/event/game-plugin?dry_run=true", json={"name": "example-game"}).status_code == 200
    assert reasons == []
    assert client.post("/api/event/game-plugin", json={"name": "example-game"}).status_code == 200
    assert reasons == ["before-game-plugin"]
    assert client.post("/api/event/game-plugin", json={"name": "example-game"}).status_code == 200  # no-op
    assert client.delete("/api/event/game-plugin?dry_run=true").status_code == 200
    assert reasons == ["before-game-plugin"]
    assert client.delete("/api/event/game-plugin").status_code == 200
    assert reasons == ["before-game-plugin", "before-game-plugin"]


def test_schedule_generate_and_clear_back_up_first(client, backup_reasons):
    session_id, _ = _event_with_teams(client)
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    set_playing_windows(client, session_id)
    reasons = backup_reasons(client)

    assert schedule(client, session_id, [("qualification", 1)], dry_run=True).status_code == 200
    assert reasons == []
    assert schedule(client, session_id, [("qualification", 1)]).status_code == 201
    assert reasons == ["before-schedule"]
    cleared = client.delete(
        "/api/schedule", params={"session_id": session_id, "round_type": "qualification"}
    )
    assert cleared.status_code == 200, cleared.text
    assert reasons == ["before-schedule", "before-clear-schedule"]


def test_qualification_and_finals_steps_back_up_first(cooperative_client, backup_reasons):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    client.post("/api/fields", json={"session_id": s1, "name": "Field 1"})
    reasons = backup_reasons(client)

    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    started = client.post("/api/finals/start", json={"session_id": s1, "bracket_size": 2})
    assert started.status_code == 201, started.text
    assert client.delete(f"/api/finals/{started.json()['id']}").status_code == 204
    assert client.post(f"/api/sessions/{s1}/qualification/reopen").status_code == 200
    assert reasons == ["before-qualification", "before-finals", "before-finals", "before-qualification"]


def test_session_delete_backs_up_first(client, backup_reasons):
    session_id, _ = _event_with_teams(client)
    reasons = backup_reasons(client)
    assert client.delete(f"/api/sessions/{session_id}").status_code == 204
    assert reasons == ["before-delete-session"]


def test_awards_finalize_backs_up_only_when_confirmed(client, backup_reasons):
    client.post("/api/event", json={"name": "Regional"})
    session_id = create_session(client)
    reasons = backup_reasons(client)
    assert client.post(f"/api/sessions/{session_id}/awards/finalize", json={}).status_code == 200
    assert reasons == []
    assert client.post(f"/api/sessions/{session_id}/awards/finalize", json={"confirm": True}).status_code == 200
    assert reasons == ["before-awards-finalize"]


def test_risky_step_still_succeeds_when_the_snapshot_fails(client, tmp_path):
    session_id, _ = _event_with_teams(client)
    blocker = tmp_path / "a-file"
    blocker.write_text("x")
    client.app.state.backups.config_path.write_text(
        '{"allowed_directories": [], "backup_dirs": {"%s": "%s"}}'
        % (str((tmp_path / "test.db").resolve()), str(blocker))
    )
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    assert client.get("/api/backups").json()["last_error"]["message"]
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_backup_risky_steps.py -q`
Expected: FAIL — every `reasons` list stays `[]` (and the last test finds `last_error` null).

- [ ] **Step 4: Add the calls**

Each call goes after the request's own checks and before its first write. Add exactly these lines:

`routers/event.py`, in `set_active_session`, right after the `if session_obj is None or session_obj.event_id != event.id:` raise:

```python
    request.app.state.backups.snapshot_quietly("before-active-session")
```

`routers/event.py`, in `_change_game_plugin`, right after `if dry_run: return game_plugin_service.preview(db, event, target)`:

```python
    request.app.state.backups.snapshot_quietly("before-game-plugin")
```

`routers/schedule.py`, in `generate_schedule`, right after `if payload.dry_run: return ScheduleGenerateResponse(fits=True, ...)` and before the `# Everything below runs in one transaction` comment:

```python
    request.app.state.backups.snapshot_quietly("before-schedule")
```

`routers/schedule.py`, in `clear_schedule`, right after the `if qualification.is_finalized(session_obj) and round_type != "practice":` raise:

```python
    request.app.state.backups.snapshot_quietly("before-clear-schedule")
```

`routers/qualification.py`, in `finalize`, right after the `for played, drops in payload.drops.items():` validation loop and before `try:`:

```python
    request.app.state.backups.snapshot_quietly("before-qualification")
```

`routers/qualification.py`, in `reopen`, right after the `if has_finals is not None:` raise:

```python
    request.app.state.backups.snapshot_quietly("before-qualification")
```

`routers/finals.py`, in `start_finals`, right before `bracket = FinalsBracket(`:

```python
    request.app.state.backups.snapshot_quietly("before-finals")
```

`routers/finals.py`, in `delete_finals`, right after the `if bracket.status == "complete":` raise:

```python
    request.app.state.backups.snapshot_quietly("before-finals")
```

`routers/sessions.py`, in `remove_session`, right after the `if session_has_scores(db, session_id):` raise:

```python
    request.app.state.backups.snapshot_quietly("before-delete-session")
```

`routers/awards.py`, in `finalize_awards`, right after `if not payload.confirm: return FinalizeRead(...)`:

```python
    request.app.state.backups.snapshot_quietly("before-awards-finalize")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_backup_risky_steps.py tests/test_event.py tests/test_qualification_finalize.py tests/test_finals.py tests/test_session_delete.py tests/test_award_finalize_api.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/routers/event.py server/src/tournament_server/routers/schedule.py server/src/tournament_server/routers/qualification.py server/src/tournament_server/routers/finals.py server/src/tournament_server/routers/sessions.py server/src/tournament_server/routers/awards.py server/tests/conftest.py server/tests/test_backup_risky_steps.py
git commit -m "Back up before every risky step (active session, schedule build and clear, qualification, finals, session delete, game plugin change, awards finalize) without ever blocking the step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Restore from the admin app

**Files:**
- Modify: `server/src/tournament_server/services/backups.py` (`backup_problem`, `replace_database`, `apply_pending_restore`, detail constants)
- Modify: `server/src/tournament_server/routers/backups.py` (restore route)
- Modify: `server/src/tournament_server/main.py` (apply the pending restore)
- Modify: `server/tests/test_backups_api.py` (uncomment the restore 403 assertion)
- Test: `server/tests/test_backup_restore.py`

**Interfaces:**
- Consumes: Tasks 1-2; `routers.picker._delayed_restart`; `schemas.picker.RestartingResponse`; `migrations._reflected_schema_matches_models(engine) -> bool`.
- Produces:
  - `DAMAGED_DETAIL = "This backup is damaged."`, `OLDER_BUILD_DETAIL = "This backup was made by an older build and can't be restored."`
  - `backup_problem(path: Path) -> str | None`
  - `replace_database(source: Path, target: Path) -> None` (raises `OSError`)
  - `apply_pending_restore(config_path: Path, db_path: str) -> None`
  - `POST /api/backups/{filename}/restore` → 202 `{"status": "restarting"}`; 404 `Backup not found`; 409 with a detail above; 500 `The current state couldn't be saved, so nothing was restored: <reason>`

- [ ] **Step 1: Write the failing tests**

In `server/tests/test_backups_api.py`, replace the two commented lines in `test_backups_are_admin_only` with:

```python
    assert raw.post("/api/backups/x.db/restore", headers=headers).status_code == 403
```

Create `server/tests/test_backup_restore.py`:

```python
from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from tournament_server.picker_config import PickerConfig, load_config, save_config
from tournament_server.routers import backups as backups_router
from tournament_server.services import backups


@pytest.fixture()
def no_restart(monkeypatch):
    calls: list[bool] = []

    async def fake_restart() -> None:
        calls.append(True)

    monkeypatch.setattr(backups_router, "_delayed_restart", fake_restart)
    return calls


def _rename_event(client, name: str) -> None:
    assert client.patch("/api/event", json={"name": name}).status_code == 200


def test_restore_records_a_pending_restore_and_restarts(client, tmp_path, no_restart):
    client.post("/api/event", json={"name": "Before"})
    backup = client.post("/api/backups").json()
    _rename_event(client, "After")

    response = client.post(f"/api/backups/{backup['filename']}/restore")

    assert response.status_code == 202, response.text
    assert response.json() == {"status": "restarting"}
    assert no_restart == [True]
    pending = load_config(client.app.state.backups.config_path).pending_restore
    assert pending == {
        "target": str((tmp_path / "test.db").resolve()),
        "source": str(client.app.state.backups.folder() / backup["filename"]),
    }
    reasons = [b["reason"] for b in client.get("/api/backups").json()["backups"]]
    assert "before-restore" in reasons


def test_restore_of_an_unknown_backup_is_404(client, no_restart):
    client.post("/api/event", json={"name": "Spring"})
    assert client.post("/api/backups/nope.db/restore").status_code == 404
    assert no_restart == []


def test_restore_refuses_a_damaged_backup(client, no_restart):
    client.post("/api/event", json={"name": "Spring"})
    backup = client.post("/api/backups").json()
    (client.app.state.backups.folder() / backup["filename"]).write_bytes(b"not a database" * 200)

    response = client.post(f"/api/backups/{backup['filename']}/restore")

    assert response.status_code == 409
    assert response.json()["detail"] == backups.DAMAGED_DETAIL
    assert no_restart == []
    assert load_config(client.app.state.backups.config_path).pending_restore is None


def test_restore_refuses_a_backup_from_an_older_build(client, no_restart):
    client.post("/api/event", json={"name": "Spring"})
    backup = client.post("/api/backups").json()
    conn = sqlite3.connect(str(client.app.state.backups.folder() / backup["filename"]))
    conn.execute("DROP TABLE awards")
    conn.commit()
    conn.close()

    response = client.post(f"/api/backups/{backup['filename']}/restore")

    assert response.status_code == 409
    assert response.json()["detail"] == backups.OLDER_BUILD_DETAIL
    assert no_restart == []


def _db_with_event(path: Path, name: str) -> None:
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE IF NOT EXISTS t (name TEXT)")
    conn.execute("DELETE FROM t")
    conn.execute("INSERT INTO t VALUES (?)", (name,))
    conn.commit()
    conn.close()


def _name(path: Path) -> str:
    conn = sqlite3.connect(str(path))
    try:
        return conn.execute("SELECT name FROM t").fetchone()[0]
    finally:
        conn.close()


def test_startup_swap_replaces_the_file_and_removes_wal_files(tmp_path):
    target = tmp_path / "spring.db"
    source = tmp_path / "backup.db"
    _db_with_event(target, "live")
    _db_with_event(source, "backup")
    Path(f"{target}-wal").write_bytes(b"stale wal from the old process")
    Path(f"{target}-shm").write_bytes(b"stale shm")
    config_path = tmp_path / "server-config.json"
    save_config(config_path, PickerConfig(pending_restore={"target": str(target), "source": str(source)}))

    backups.apply_pending_restore(config_path, str(target))

    assert _name(target) == "backup"
    assert not Path(f"{target}-wal").exists() or Path(f"{target}-wal").read_bytes() != b"stale wal from the old process"
    assert load_config(config_path).pending_restore is None


def test_startup_ignores_a_pending_restore_for_another_file(tmp_path):
    target = tmp_path / "spring.db"
    _db_with_event(target, "live")
    source = tmp_path / "backup.db"
    _db_with_event(source, "backup")
    config_path = tmp_path / "server-config.json"
    save_config(
        config_path,
        PickerConfig(pending_restore={"target": str(tmp_path / "autumn.db"), "source": str(source)}),
    )

    backups.apply_pending_restore(config_path, str(target))

    assert _name(target) == "live"
    assert load_config(config_path).pending_restore is None


def test_a_failed_swap_leaves_the_original(tmp_path, capsys):
    target = tmp_path / "spring.db"
    _db_with_event(target, "live")
    config_path = tmp_path / "server-config.json"
    save_config(
        config_path,
        PickerConfig(pending_restore={"target": str(target), "source": str(tmp_path / "missing.db")}),
    )

    backups.apply_pending_restore(config_path, str(target))

    assert _name(target) == "live"
    assert "ERROR: restoring" in capsys.readouterr().err
    assert not list(tmp_path.glob(".spring.db.restoring"))
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_backup_restore.py tests/test_backups_api.py -q`
Expected: FAIL (restore route 404/405, `backups` has no `apply_pending_restore`).

- [ ] **Step 3: Service additions**

Append to `server/src/tournament_server/services/backups.py` (add `import sys` and `from sqlalchemy import create_engine` to the imports, and `from tournament_server.picker_config import load_config, save_config`):

```python
DAMAGED_DETAIL = "This backup is damaged."
OLDER_BUILD_DETAIL = "This backup was made by an older build and can't be restored."


def _immutable_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?immutable=1"


def backup_problem(path: Path) -> str | None:
    """Why `path` can't be restored, or None. Opens it read-only without
    creating -wal/-shm files beside it."""
    from tournament_server.migrations import _reflected_schema_matches_models

    uri = _immutable_uri(path)
    try:
        conn = sqlite3.connect(uri, uri=True)
        try:
            result = conn.execute("PRAGMA quick_check").fetchone()[0]
        finally:
            conn.close()
    except sqlite3.Error:
        return DAMAGED_DETAIL
    if result != "ok":
        return DAMAGED_DETAIL
    engine = create_engine("sqlite://", creator=lambda: sqlite3.connect(uri, uri=True))
    try:
        if not _reflected_schema_matches_models(engine):
            return OLDER_BUILD_DETAIL
    except Exception:  # noqa: BLE001 - any failure to read it means it can't be restored
        return DAMAGED_DETAIL
    finally:
        engine.dispose()
    return None


def replace_database(source: Path, target: Path) -> None:
    """Copies `source` over `target` through a temporary name, keeps the
    target's permission bits, and removes the target's -wal/-shm files so the
    old process's WAL is never replayed against the new file. Raises OSError;
    on failure `target` is untouched."""
    tmp = target.with_name(f".{target.name}.restoring")
    try:
        shutil.copyfile(source, tmp)
        if target.exists():
            copy_mode(target, tmp)
        os.replace(tmp, target)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise
    for suffix in ("-wal", "-shm"):
        Path(f"{target}{suffix}").unlink(missing_ok=True)


def apply_pending_restore(config_path: Path, db_path: str) -> None:
    """Called by main._startup() before anything opens `db_path`."""
    config = load_config(config_path)
    pending = config.pending_restore
    if not pending:
        return
    config.pending_restore = None
    save_config(config_path, config)
    target = Path(db_path).resolve()
    if Path(pending["target"]).resolve() != target:
        return
    try:
        replace_database(Path(pending["source"]), target)
    except OSError as exc:
        print(
            f"ERROR: restoring {pending['source']} failed, keeping the current file: {exc}",
            file=sys.stderr,
        )
```

- [ ] **Step 4: Restore route**

Add to `server/src/tournament_server/routers/backups.py` (imports: `BackgroundTasks` from fastapi; `from tournament_server.routers.picker import _delayed_restart`; `from tournament_server.schemas.picker import RestartingResponse`; `BEFORE_RESTORE, backup_problem` from the service):

```python
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
    config.pending_restore = {"target": config_key(manager.db_path), "source": str(entry.path)}
    save_config(manager.config_path, config)
    background_tasks.add_task(_delayed_restart)
    return RestartingResponse(status="restarting")
```

Note: the test fixture patches `backups_router._delayed_restart`, so reference the module-level name (`background_tasks.add_task(_delayed_restart)` reads the global at call time — keep it a plain global lookup, not a default argument).

- [ ] **Step 5: Apply it at startup**

In `server/src/tournament_server/main.py`, import `from tournament_server.services.backups import apply_pending_restore`, and right after `resolved_db_path = resolve_active_db_path(settings.db_path)` and its `if resolved_db_path is None:` picker branch, before `try: app = create_app(`, add:

```python
    apply_pending_restore(config_path, resolved_db_path)
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_backup_restore.py tests/test_backups_api.py tests/test_main.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/tournament_server/services/backups.py server/src/tournament_server/routers/backups.py server/src/tournament_server/main.py server/tests/test_backup_restore.py server/tests/test_backups_api.py
git commit -m "Restore a backup from the admin API: check it, save the current state, record the restore and restart, then swap the file in at startup before anything opens it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Damaged file at startup

**Files:**
- Modify: `server/src/tournament_server/services/backups.py` (`database_is_damaged`, `restore_damaged`)
- Modify: `server/src/tournament_server/main.py` (damaged check)
- Modify: `server/src/tournament_server/picker_app.py` (`damaged_path` parameter)
- Modify: `server/src/tournament_server/routers/picker.py` (`GET /damaged`, `POST /restore`)
- Modify: `server/src/tournament_server/schemas/picker.py` (`DamagedRead`, `PickerRestoreRequest`)
- Test: `server/tests/test_backup_damaged.py`

**Interfaces:**
- Consumes: Tasks 1 and 4 (`backup_folder`, `list_backups`, `backup_problem`, `replace_database`).
- Produces:
  - `database_is_damaged(db_path: str) -> bool`
  - `restore_damaged(db_path: str, backup: Path, folder: Path) -> None`
  - `create_picker_app(config_path, static_dir=None, damaged_path: str | None = None)`; `app.state.damaged_path`
  - `GET /api/picker/damaged` → `{path: str, backups: BackupEntryRead[]}` or 404 `Nothing is damaged`
  - `POST /api/picker/restore` body `{filename}` → 202 `{"status": "restarting"}`; 404 / 409 as in Task 4

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_backup_damaged.py`:

```python
from __future__ import annotations

import json
import os
import socket
import sqlite3
import subprocess
import sys
import urllib.request
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tournament_server.db import make_engine
from tournament_server.migrations import ensure_schema_current
from tournament_server.picker_app import create_picker_app
from tournament_server.routers import picker as picker_router
from tournament_server.services import backups


def _good_tournament(path: Path) -> None:
    engine = make_engine(str(path))
    ensure_schema_current(engine, str(path))
    engine.dispose()
    conn = sqlite3.connect(str(path))
    conn.execute("INSERT INTO events (name, created_at) VALUES ('Good', '2026-01-01 00:00:00')")
    conn.commit()
    conn.close()


def test_a_garbage_file_is_damaged_and_a_good_or_missing_one_is_not(tmp_path):
    good = tmp_path / "good.db"
    _good_tournament(good)
    bad = tmp_path / "bad.db"
    bad.write_bytes(b"not a database" * 200)
    assert backups.database_is_damaged(str(bad)) is True
    assert backups.database_is_damaged(str(good)) is False
    assert backups.database_is_damaged(str(tmp_path / "missing.db")) is False


@pytest.fixture()
def damaged(tmp_path, monkeypatch):
    target = tmp_path / "spring.db"
    _good_tournament(target)
    folder = backups.default_folder(str(target))
    entry = backups.take_snapshot(str(target), folder, "manual")
    target.write_bytes(b"not a database" * 200)
    calls: list[bool] = []

    async def fake_restart() -> None:
        calls.append(True)

    monkeypatch.setattr(picker_router, "_delayed_restart", fake_restart)
    app = create_picker_app(tmp_path / "server-config.json", damaged_path=str(target))
    return TestClient(app), target, entry, calls


def test_damaged_mode_lists_the_files_backups(damaged):
    client, target, entry, _ = damaged
    body = client.get("/api/picker/damaged").json()
    assert body["path"] == str(target.resolve())
    assert [b["filename"] for b in body["backups"]] == [entry.filename]


def test_restoring_a_damaged_file_keeps_a_copy_and_restarts(damaged):
    client, target, entry, calls = damaged
    response = client.post("/api/picker/restore", json={"filename": entry.filename})
    assert response.status_code == 202, response.text
    assert calls == [True]
    assert backups.database_is_damaged(str(target)) is False
    kept = list(backups.default_folder(str(target)).glob("spring-*-damaged.db"))
    assert len(kept) == 1 and kept[0].read_bytes().startswith(b"not a database")


def test_picker_restore_refuses_unknown_and_damaged_backups(damaged):
    client, _, entry, calls = damaged
    assert client.post("/api/picker/restore", json={"filename": "nope.db"}).status_code == 404
    entry.path.write_bytes(b"also garbage" * 200)
    refused = client.post("/api/picker/restore", json={"filename": entry.filename})
    assert refused.status_code == 409
    assert refused.json()["detail"] == backups.DAMAGED_DETAIL
    assert calls == []


def test_damaged_endpoints_404_outside_damaged_mode(tmp_path):
    client = TestClient(create_picker_app(tmp_path / "server-config.json"))
    assert client.get("/api/picker/damaged").status_code == 404
    assert client.post("/api/picker/restore", json={"filename": "x.db"}).status_code == 404


def _free_port() -> int:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    return port


def test_main_starts_the_picker_in_damaged_mode_for_a_damaged_file(tmp_path):
    from test_main import _wait_for_http

    target = tmp_path / "spring.db"
    target.write_bytes(b"not a database" * 200)
    config_path = tmp_path / "server-config.json"
    config_path.write_text(json.dumps({"allowed_directories": [], "last_opened_path": str(target)}))
    port = _free_port()
    env = dict(os.environ)
    env.pop("TOURNAMENT_DB_PATH", None)
    env.update(
        TOURNAMENT_HOST="127.0.0.1", TOURNAMENT_PORT=str(port), TOURNAMENT_CONFIG_PATH=str(config_path)
    )
    process = subprocess.Popen([sys.executable, "-m", "tournament_server.main"], env=env)
    try:
        _wait_for_http(f"http://127.0.0.1:{port}/health")
        body = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/picker/damaged"))
        assert body["path"] == str(target.resolve())
        assert json.loads(config_path.read_text())["last_opened_path"] == str(target)
    finally:
        process.terminate()
        process.wait(timeout=10)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_backup_damaged.py -q`
Expected: FAIL (`database_is_damaged` missing; `create_picker_app` has no `damaged_path`).

- [ ] **Step 3: Service additions**

Append to `server/src/tournament_server/services/backups.py`:

```python
def database_is_damaged(db_path: str) -> bool:
    """True when SQLite's quick integrity check fails. A missing file is not
    damaged (it is about to be created)."""
    path = Path(db_path)
    if not path.exists():
        return False
    try:
        conn = sqlite3.connect(str(path))
        try:
            return conn.execute("PRAGMA quick_check").fetchone()[0] != "ok"
        finally:
            conn.close()
    except sqlite3.DatabaseError:
        return True


def restore_damaged(db_path: str, backup: Path, folder: Path) -> None:
    """Keeps a copy of the damaged file in `folder` as
    `<stem>-<timestamp>-damaged.db`, then swaps `backup` in."""
    target = Path(db_path).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().astimezone().strftime("%Y-%m-%d-%H%M%S")
    shutil.copyfile(target, folder / f"{target.stem}-{stamp}-damaged.db")
    replace_database(backup, target)
```

- [ ] **Step 4: Picker schemas, app and routes**

Append to `server/src/tournament_server/schemas/picker.py`:

```python
from tournament_server.schemas.backups import BackupEntryRead  # noqa: E402


class DamagedRead(BaseModel):
    path: str
    backups: list[BackupEntryRead]


class PickerRestoreRequest(BaseModel):
    filename: str
```

(Move that import to the top of the file with the others rather than leaving it mid-file.)

In `server/src/tournament_server/picker_app.py`, change the signature and store the path:

```python
def create_picker_app(
    config_path: Path, static_dir: str | None = None, damaged_path: str | None = None
) -> FastAPI:
    ...
    app.state.picker_config_path = config_path
    app.state.damaged_path = damaged_path
```

Add to `server/src/tournament_server/routers/picker.py` (on `router`, which only the picker app includes; imports: `DamagedRead`, `PickerRestoreRequest` from schemas.picker; `BackupEntryRead` from schemas.backups; `from tournament_server.services import backups as backup_service`):

```python
def _damaged_backups(request: Request) -> tuple[str, Path, list[backup_service.BackupEntry]]:
    damaged = getattr(request.app.state, "damaged_path", None)
    if damaged is None:
        raise HTTPException(status_code=404, detail="Nothing is damaged")
    folder = backup_service.backup_folder(damaged, request.app.state.picker_config_path)
    return damaged, folder, backup_service.list_backups(folder, Path(damaged).stem)


@router.get("/damaged", response_model=DamagedRead)
def get_damaged(request: Request) -> DamagedRead:
    damaged, _, entries = _damaged_backups(request)
    return DamagedRead(
        path=str(Path(damaged).resolve()),
        backups=[
            BackupEntryRead(
                filename=e.filename, created_at=e.created_at, reason=e.reason, size_bytes=e.size_bytes
            )
            for e in entries
        ],
    )


@router.post("/restore", response_model=RestartingResponse, status_code=202)
def restore_damaged_file(
    payload: PickerRestoreRequest, request: Request, background_tasks: BackgroundTasks
) -> RestartingResponse:
    damaged, folder, entries = _damaged_backups(request)
    entry = next((e for e in entries if e.filename == payload.filename), None)
    if entry is None:
        raise HTTPException(status_code=404, detail="Backup not found")
    problem = backup_service.backup_problem(entry.path)
    if problem is not None:
        raise HTTPException(status_code=409, detail=problem)
    try:
        backup_service.restore_damaged(damaged, entry.path, folder)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"The restore failed: {exc}") from exc
    background_tasks.add_task(_delayed_restart)
    return RestartingResponse(status="restarting")
```

- [ ] **Step 5: Check the file at startup**

In `server/src/tournament_server/main.py`, import `database_is_damaged` alongside `apply_pending_restore`, and right after the `apply_pending_restore(config_path, resolved_db_path)` line from Task 4 add:

```python
    if database_is_damaged(resolved_db_path):
        print(f"ERROR: {resolved_db_path} is damaged; starting the picker to restore it.", file=sys.stderr)
        app = create_picker_app(config_path, static_dir=settings.static_dir, damaged_path=resolved_db_path)
        return settings, port, app
```

This path never clears `last_opened_path`, so a restore's restart reopens the same file.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_backup_damaged.py tests/test_main.py tests/test_picker_router.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/src/tournament_server/services/backups.py server/src/tournament_server/main.py server/src/tournament_server/picker_app.py server/src/tournament_server/routers/picker.py server/src/tournament_server/schemas/picker.py server/tests/test_backup_damaged.py
git commit -m "Start the picker in damaged mode when the tournament file fails its integrity check, list that file's backups there, and restore one while keeping a copy of the damaged file

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Backups page in the admin app

**Files:**
- Create: `frontend/apps/admin/src/backups/format.ts`
- Create: `frontend/apps/admin/src/routes/BackupsRoute.tsx`
- Modify: `frontend/apps/admin/src/useRestartPoll.ts` (`"restarted"` target)
- Modify: `frontend/apps/admin/src/router.tsx` (route `backups`)
- Modify: `frontend/apps/admin/src/components/AppShell.tsx` (admin nav link)
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/BackupsRoute.test.tsx`, `frontend/apps/admin/tests/unit/backupsFormat.test.ts`, extend `frontend/apps/admin/tests/unit/useRestartPoll.test.ts`

**Interfaces:**
- Consumes: the Task 2/4 API shapes; `GET /api/time-sync` `boot_id`.
- Produces:
  - `formatSize(bytes: number): string` and `reasonKey(reason: string): string` in `src/backups/format.ts`
  - `useRestartPoll(onReady, "restarted")` whose `start(previousBootId?: string)` waits until `/api/time-sync` answers with a different `boot_id`
  - Exported types `BackupEntry`, `BackupsState` from `BackupsRoute.tsx` (Task 7 imports `BackupEntry`)

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/admin/tests/unit/backupsFormat.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatSize, reasonKey } from "../../src/backups/format";

describe("formatSize", () => {
  it("uses bytes, KB and MB", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(1_572_864)).toBe("1.5 MB");
  });
});

describe("reasonKey", () => {
  it("maps a reason to its translation key", () => {
    expect(reasonKey("before-clear-schedule")).toBe("backups.reasons.before-clear-schedule");
  });
});
```

Append to `frontend/apps/admin/tests/unit/useRestartPoll.test.ts` (inside the top-level `describe`):

```ts
  it('with target "restarted", waits for a different boot id', async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        if (calls === 2) return new Response(null, { status: 502 });
        const boot = calls < 3 ? "old" : "new";
        return new Response(JSON.stringify({ server_time: "x", boot_id: boot }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      })
    );
    const onReady = vi.fn();
    const { result } = renderHook(() => useRestartPoll(onReady, "restarted"));
    act(() => {
      result.current.start("old");
    });
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
    }
    expect(onReady).toHaveBeenCalledTimes(1);
  });
```

Create `frontend/apps/admin/tests/unit/BackupsRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { BackupsRoute, type BackupsState } from "../../src/routes/BackupsRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const STATE: BackupsState = {
  folder: "/events/backups/spring",
  folder_is_default: true,
  last_backup_at: "2026-10-12T21:30:05Z",
  last_error: null,
  backups: [
    { filename: "spring-2026-10-12-143005-manual.db", created_at: "2026-10-12T21:30:05Z", reason: "manual", size_bytes: 2048 },
    { filename: "spring-2026-10-12-140000-before-schedule.db", created_at: "2026-10-12T21:00:00Z", reason: "before-schedule", size_bytes: 1_572_864 },
  ],
};

let state: BackupsState;

function stub(overrides: Partial<Record<string, unknown>> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in overrides) {
      const value = overrides[key];
      if (value instanceof Error) throw value;
      return value as never;
    }
    if (key === "GET /api/backups") return state as never;
    if (key === "POST /api/backups") return state.backups[0] as never;
    if (key === "PUT /api/backups/folder") return { ...state, folder: "/mnt/usb", folder_is_default: false } as never;
    if (key === "GET /api/time-sync") return { server_time: "x", boot_id: "boot-1" } as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <BackupsRoute />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("BackupsRoute", () => {
  beforeEach(() => {
    vi.mocked(apiRequest).mockReset();
    state = structuredClone(STATE);
    stub();
  });

  it("lists backups newest first with their reason and size", async () => {
    renderRoute();
    const rows = await screen.findAllByRole("row");
    expect(rows).toHaveLength(3); // header + 2
    expect(within(rows[1]).getByText("Back up now (manual)")).toBeInTheDocument();
    expect(within(rows[1]).getByText("2 KB")).toBeInTheDocument();
    expect(within(rows[2]).getByText("Before building a schedule")).toBeInTheDocument();
    expect(within(rows[2]).getByText("1.5 MB")).toBeInTheDocument();
    expect(screen.getByText("/events/backups/spring")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use default" })).not.toBeInTheDocument();
  });

  it("shows the last error", async () => {
    state.last_error = { message: "No space left on device", at: "2026-10-12T21:35:00Z" };
    renderRoute();
    expect(await screen.findByRole("alert")).toHaveTextContent("No space left on device");
  });

  it("says when there are no backups yet", async () => {
    state.backups = [];
    state.last_backup_at = null;
    renderRoute();
    expect(await screen.findByText("No backups yet.")).toBeInTheDocument();
  });

  it("backs up now", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/backups", { method: "POST" }));
  });

  it("shows a failed backup's error", async () => {
    stub({ "POST /api/backups": new ApiError(500, "The backup failed: disk full", { detail: "The backup failed: disk full" }) });
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("The backup failed: disk full")).toBeInTheDocument();
  });

  it("changes the folder and shows the server's refusal", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Backup folder"), { target: { value: "/mnt/usb" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/backups/folder", { method: "PUT", body: { folder: "/mnt/usb" } })
    );
  });

  it("confirms a restore with the full warning and shows a 409", async () => {
    stub({
      "POST /api/backups/spring-2026-10-12-143005-manual.db/restore": new ApiError(409, "This backup is damaged.", {
        detail: "This backup is damaged.",
      }),
    });
    renderRoute();
    const rows = await screen.findAllByRole("row");
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Restore" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Everything after it is replaced. The current state is saved as a backup first.");
    expect(dialog).toHaveTextContent("Any device, this one included, may need to log in or be admitted again.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Restore" }));
    expect(await within(dialog).findByText("This backup is damaged.")).toBeInTheDocument();
  });
});
```

Check `ConfirmDialog`'s `Modal` renders `role="alertdialog"` (it does since the game-plugin gating work; if `screen.findByRole("alertdialog")` fails, read `src/components/Modal.tsx` and use the role it renders). Check the `ApiError` constructor signature in `frontend/packages/shared/src/api-client.ts` and match it; `apiErrorMessage(error, fallback)` (`src/apiErrorMessage.ts`) reads the server `detail`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/BackupsRoute.test.tsx tests/unit/backupsFormat.test.ts tests/unit/useRestartPoll.test.ts`
Expected: FAIL (modules missing; the restarted-target test fails).

- [ ] **Step 3: Format helpers**

Create `frontend/apps/admin/src/backups/format.ts`:

```ts
/** "512 B", "2 KB", "1.5 MB": one decimal place at most, dropped when zero. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const round = (n: number) => String(Math.round(n * 10) / 10);
  if (bytes < 1024 * 1024) return `${round(bytes / 1024)} KB`;
  return `${round(bytes / (1024 * 1024))} MB`;
}

export function reasonKey(reason: string): string {
  return `backups.reasons.${reason}`;
}
```

- [ ] **Step 4: The "restarted" restart target**

In `frontend/apps/admin/src/useRestartPoll.ts`:

1. Change the type: `export type RestartTarget = "normal" | "picker" | "restarted";` and add to its doc comment: `- "restarted" (restore): the normal app restarts into the normal app, so the picker route can't tell old from new; readiness is GET /api/time-sync answering with a boot_id different from the one passed to start().`
2. Replace `function start() {` … through the end of `tick` with:

```ts
  function start(previousBootId?: string) {
    setStatus("waiting");
    const deadline = Date.now() + RESTART_POLL_TIMEOUT_MS;

    const tick = async () => {
      if (target === "restarted") {
        try {
          const { boot_id } = await apiRequest<{ boot_id: string }>("/api/time-sync");
          if (boot_id !== previousBootId) {
            onReady();
            return;
          }
        } catch {
          // Still restarting.
        }
      } else {
        try {
          await apiRequest("/api/picker/directories");
          if (target === "picker") {
            onReady();
            return;
          }
        } catch (err) {
          if (target === "normal" && err instanceof ApiError && err.status === 404) {
            onReady();
            return;
          }
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
```

- [ ] **Step 5: Strings**

Add to `frontend/apps/admin/src/i18n/en/admin.json`: under `"shell"` add `"backupsLink": "Backups",`; and a new top-level `"backups"` object:

```json
  "backups": {
    "heading": "Backups",
    "intro": "The server saves a copy of this tournament every 5 minutes when something changed, and before risky steps.",
    "folderLabel": "Backup folder",
    "change": "Change",
    "save": "Save",
    "cancel": "Cancel",
    "useDefault": "Use default",
    "lastBackup": "Last backup at {{time}}",
    "noneYet": "No backups yet.",
    "lastError": "The last backup failed at {{time}}: {{message}}",
    "backUpNow": "Back up now",
    "time": "Time",
    "reason": "Reason",
    "size": "Size",
    "restore": "Restore",
    "restoreHeading": "Restore this backup?",
    "restoreBody": "Restore the backup from {{time}}? Everything after it is replaced. The current state is saved as a backup first. Every device reconnects. Any device, this one included, may need to log in or be admitted again.",
    "restoring": "Restoring… the page reloads when the server is back.",
    "restoreTimedOut": "The server hasn't come back yet. Reload this page in a moment.",
    "reasons": {
      "interval": "Every 5 minutes",
      "manual": "Back up now (manual)",
      "before-restore": "Before a restore",
      "before-active-session": "Before switching the active session",
      "before-schedule": "Before building a schedule",
      "before-clear-schedule": "Before clearing a round",
      "before-qualification": "Before finalizing or reopening qualification",
      "before-finals": "Before starting or deleting finals",
      "before-delete-session": "Before deleting a session",
      "before-game-plugin": "Before changing the game plugin",
      "before-awards-finalize": "Before finalizing awards",
      "damaged": "Damaged file kept after a restore"
    }
  },
```

Add the same keys to `frontend/apps/admin/src/i18n/zh/admin.json`:

```json
  "backups": {
    "heading": "备份",
    "intro": "有改动时，服务器每 5 分钟保存一次本比赛的副本，并在高风险操作前也保存一次。",
    "folderLabel": "备份文件夹",
    "change": "更改",
    "save": "保存",
    "cancel": "取消",
    "useDefault": "使用默认位置",
    "lastBackup": "上次备份于 {{time}}",
    "noneYet": "还没有备份。",
    "lastError": "上次备份于 {{time}} 失败：{{message}}",
    "backUpNow": "立即备份",
    "time": "时间",
    "reason": "原因",
    "size": "大小",
    "restore": "恢复",
    "restoreHeading": "恢复此备份？",
    "restoreBody": "恢复 {{time}} 的备份？之后的所有内容都会被替换。当前状态会先保存为一个备份。所有设备都会重新连接。任何设备（包括本设备）都可能需要重新登录或重新获准。",
    "restoring": "正在恢复……服务器恢复后页面会自动重新加载。",
    "restoreTimedOut": "服务器还没有恢复。请稍后重新加载此页面。",
    "reasons": {
      "interval": "每 5 分钟",
      "manual": "立即备份（手动）",
      "before-restore": "恢复之前",
      "before-active-session": "切换当前场次之前",
      "before-schedule": "生成赛程之前",
      "before-clear-schedule": "清除一轮之前",
      "before-qualification": "确定或重新开放资格赛之前",
      "before-finals": "开始或删除决赛之前",
      "before-delete-session": "删除场次之前",
      "before-game-plugin": "更改比赛插件之前",
      "before-awards-finalize": "确定奖项之前",
      "damaged": "恢复后保留的损坏文件"
    }
  },
```

and `"backupsLink": "备份",` under `"shell"`.

- [ ] **Step 6: The page**

Create `frontend/apps/admin/src/routes/BackupsRoute.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import { formatSize, reasonKey } from "../backups/format";
import { useRestartPoll } from "../useRestartPoll";

export interface BackupEntry {
  filename: string;
  created_at: string;
  reason: string;
  size_bytes: number;
}

export interface BackupsState {
  folder: string;
  folder_is_default: boolean;
  last_backup_at: string | null;
  last_error: { message: string; at: string } | null;
  backups: BackupEntry[];
}

const BACKUPS_KEY = ["backups"];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

export function BackupsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const backups = useQuery({
    queryKey: BACKUPS_KEY,
    queryFn: () => apiRequest<BackupsState>("/api/backups"),
    refetchOnWindowFocus: true,
  });
  const [editingFolder, setEditingFolder] = useState(false);
  const [folderDraft, setFolderDraft] = useState("");
  const [restoring, setRestoring] = useState<BackupEntry | null>(null);
  const restart = useRestartPoll(undefined, "restarted");

  const backUpNow = useMutation({
    mutationFn: () => apiRequest<BackupEntry>("/api/backups", { method: "POST" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: BACKUPS_KEY }),
  });
  const saveFolder = useMutation({
    mutationFn: (folder: string | null) =>
      apiRequest<BackupsState>("/api/backups/folder", { method: "PUT", body: { folder } }),
    onSuccess: (data) => {
      queryClient.setQueryData(BACKUPS_KEY, data);
      setEditingFolder(false);
    },
  });
  const restore = useMutation({
    mutationFn: async (entry: BackupEntry) => {
      const { boot_id } = await apiRequest<{ boot_id: string }>("/api/time-sync");
      await apiRequest(`/api/backups/${encodeURIComponent(entry.filename)}/restore`, { method: "POST" });
      return boot_id;
    },
    onSuccess: (bootId) => {
      setRestoring(null);
      restart.start(bootId);
    },
  });

  if (!backups.data) return null;
  const state = backups.data;

  return (
    <section className="page">
      <h1>{t("backups.heading")}</h1>
      <p className="field__hint">{t("backups.intro")}</p>

      {restart.status === "waiting" && (
        <p className="alert alert-info" role="status">
          {t("backups.restoring")}
        </p>
      )}
      {restart.status === "timedOut" && (
        <p className="alert alert-warning" role="status">
          {t("backups.restoreTimedOut")}
        </p>
      )}

      <div className="field">
        <span className="field__label" id="backup-folder-label">
          {t("backups.folderLabel")}
        </span>
        {editingFolder ? (
          <>
            <input
              className="input"
              aria-labelledby="backup-folder-label"
              value={folderDraft}
              onChange={(event) => setFolderDraft(event.target.value)}
            />
            <div className="dialog__actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={saveFolder.isPending}
                onClick={() => saveFolder.mutate(folderDraft)}
              >
                {t("backups.save")}
              </button>
              <button type="button" className="btn" onClick={() => setEditingFolder(false)}>
                {t("backups.cancel")}
              </button>
            </div>
          </>
        ) : (
          <p>
            <code>{state.folder}</code>{" "}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setFolderDraft(state.folder);
                setEditingFolder(true);
              }}
            >
              {t("backups.change")}
            </button>{" "}
            {!state.folder_is_default && (
              <button type="button" className="btn btn-small" onClick={() => saveFolder.mutate(null)}>
                {t("backups.useDefault")}
              </button>
            )}
          </p>
        )}
        {saveFolder.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(saveFolder.error, t("errors.generic"))}
          </p>
        )}
      </div>

      {state.last_error && (
        <p className="alert alert-danger" role="alert">
          {t("backups.lastError", { time: formatTime(state.last_error.at), message: state.last_error.message })}
        </p>
      )}
      <p>
        {state.last_backup_at
          ? t("backups.lastBackup", { time: formatTime(state.last_backup_at) })
          : null}{" "}
        <button
          type="button"
          className="btn btn-primary"
          disabled={backUpNow.isPending}
          onClick={() => backUpNow.mutate()}
        >
          {t("backups.backUpNow")}
        </button>
      </p>
      {backUpNow.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(backUpNow.error, t("errors.generic"))}
        </p>
      )}

      {state.backups.length === 0 ? (
        <p>{t("backups.noneYet")}</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>{t("backups.time")}</th>
              <th>{t("backups.reason")}</th>
              <th>{t("backups.size")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {state.backups.map((entry) => (
              <tr key={entry.filename}>
                <td>{formatTime(entry.created_at)}</td>
                <td>{t(reasonKey(entry.reason), { defaultValue: entry.reason })}</td>
                <td>{formatSize(entry.size_bytes)}</td>
                <td>
                  <button type="button" className="btn btn-small" onClick={() => setRestoring(entry)}>
                    {t("backups.restore")}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {restoring && (
        <ConfirmDialog
          heading={t("backups.restoreHeading")}
          body={t("backups.restoreBody", { time: formatTime(restoring.created_at) })}
          confirmLabel={t("backups.restore")}
          cancelLabel={t("backups.cancel")}
          isPending={restore.isPending}
          error={restore.isError ? apiErrorMessage(restore.error, t("errors.generic")) : null}
          onConfirm={() => restore.mutate(restoring)}
          onCancel={() => {
            restore.reset();
            setRestoring(null);
          }}
        />
      )}
    </section>
  );
}
```

Match the page wrapper, table and button classes to an existing admin page (`SettingsRolesRoute.tsx`, `SessionsRoute.tsx`) — if `page`/`table`/`btn-small`/`alert-info` aren't the class names those use, use theirs. Do not add new CSS.

- [ ] **Step 7: Route and nav**

In `frontend/apps/admin/src/router.tsx`: import `BackupsRoute` and add `{ path: "backups", element: <BackupsRoute /> },` after the `settings/roles` route.

In `frontend/apps/admin/src/components/AppShell.tsx`, in the `role === "admin"` nav, after the `/settings/roles` `NavLink`:

```tsx
            <NavLink to="/backups" className={navLinkClassName}>
              {t("shell.backupsLink")}
            </NavLink>
```

If `tests/unit/AppShell.test.tsx` asserts the full list of admin nav links, add "Backups" in that position there.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd frontend/apps/admin && npx vitest run && npx tsc -b`
Expected: all unit tests PASS; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add frontend/apps/admin/src/backups frontend/apps/admin/src/routes/BackupsRoute.tsx frontend/apps/admin/src/useRestartPoll.ts frontend/apps/admin/src/router.tsx frontend/apps/admin/src/components/AppShell.tsx frontend/apps/admin/src/i18n frontend/apps/admin/tests/unit
git commit -m "Add the Backups page: folder, last backup and error, back up now, and restore with a confirm dialog that waits for the restarted server

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Damaged-file restore on the picker page

**Files:**
- Modify: `frontend/apps/admin/src/routes/PickerRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json` (`picker.damaged*`)
- Test: `frontend/apps/admin/tests/unit/PickerRoute.test.tsx`

**Interfaces:**
- Consumes: `GET /api/picker/damaged`, `POST /api/picker/restore` (Task 5); `BackupEntry` type, `formatSize`, `reasonKey` (Task 6); `useRestartPoll()` default `"normal"` target (picker → normal app).

- [ ] **Step 1: Write the failing tests**

Add inside the existing `describe("PickerRoute", …)` block of `tests/unit/PickerRoute.test.tsx` (it already has `jsonResponse` and `renderRoute`, and stubs the global `fetch` per test):

```tsx
  it("offers the damaged file's backups and restores one", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/picker/directories") return jsonResponse({ allowed_directories: [] });
      if (url === "/api/picker/damaged") {
        return jsonResponse({
          path: "/events/spring.db",
          backups: [
            {
              filename: "spring-2026-10-12-143005-manual.db",
              created_at: "2026-10-12T21:30:05Z",
              reason: "manual",
              size_bytes: 2048,
            },
          ],
        });
      }
      if (url === "/api/picker/restore" && method === "POST") return jsonResponse({ status: "restarting" }, 202);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderRoute();

    expect(
      await screen.findByText("/events/spring.db is damaged and can't be opened. Restore it from a backup.")
    ).toBeInTheDocument();
    expect(screen.getByText(/Back up now \(manual\)/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => String(url) === "/api/picker/restore");
      expect(call).toBeDefined();
      expect(JSON.parse(call![1]!.body as string)).toEqual({ filename: "spring-2026-10-12-143005-manual.db" });
    });
  });

  it("shows no damaged section when the server isn't in damaged mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input) === "/api/picker/damaged"
          ? jsonResponse({ detail: "Nothing is damaged" }, 404)
          : jsonResponse({ allowed_directories: [] })
      )
    );
    renderRoute();
    await screen.findByRole("button", { name: "Create New Tournament" });
    expect(screen.queryByText(/is damaged and can't be opened/)).not.toBeInTheDocument();
  });
```

The older tests in this file answer every request (including `/api/picker/damaged`) with `{ allowed_directories: [] }`, so the section must render only when the response has a `path` (Step 4 does this).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/PickerRoute.test.tsx`
Expected: FAIL (no damaged section).

- [ ] **Step 3: Strings**

Under `"picker"` in `en/admin.json` add:

```json
    "damagedHeading": "This tournament file is damaged",
    "damagedBody": "{{path}} is damaged and can't be opened. Restore it from a backup.",
    "damagedNoBackups": "No backups were found for it.",
    "damagedRestore": "Restore",
    "damagedRestoring": "Restoring… the page reloads when the server is back.",
```

and in `zh/admin.json`:

```json
    "damagedHeading": "此比赛文件已损坏",
    "damagedBody": "{{path}} 已损坏，无法打开。请从备份中恢复。",
    "damagedNoBackups": "没有找到它的备份。",
    "damagedRestore": "恢复",
    "damagedRestoring": "正在恢复……服务器恢复后页面会自动重新加载。",
```

- [ ] **Step 4: The damaged section**

In `PickerRoute.tsx` add a component above the existing picker content and render it first inside `PickerRoute`'s returned markup:

```tsx
import type { BackupEntry } from "./BackupsRoute";
import { formatSize, reasonKey } from "../backups/format";

interface DamagedRead {
  path: string;
  backups: BackupEntry[];
}

function DamagedSection() {
  const { t } = useTranslation();
  const restart = useRestartPoll();
  const damaged = useQuery({
    queryKey: ["pickerDamaged"],
    queryFn: () => apiRequest<DamagedRead>("/api/picker/damaged"),
    retry: false,
  });
  const restore = useMutation({
    mutationFn: (filename: string) =>
      apiRequest("/api/picker/restore", { method: "POST", body: { filename } }),
    onSuccess: () => restart.start(),
  });
  // Older picker tests answer every request with the directories body, so
  // render only for a real damaged-mode response.
  if (!damaged.data?.path) return null;
  const entries = damaged.data.backups ?? [];
  return (
    <section className="alert alert-danger" aria-labelledby="damaged-heading">
      <h2 id="damaged-heading">{t("picker.damagedHeading")}</h2>
      <p>{t("picker.damagedBody", { path: damaged.data.path })}</p>
      {restart.status === "waiting" && <p role="status">{t("picker.damagedRestoring")}</p>}
      {entries.length === 0 ? (
        <p>{t("picker.damagedNoBackups")}</p>
      ) : (
        <ul className="list-plain">
          {entries.map((entry) => (
            <li key={entry.filename} className="list-row">
              <span className="list-row__main">
                {new Date(entry.created_at).toLocaleString()} · {t(reasonKey(entry.reason), { defaultValue: entry.reason })} ·{" "}
                {formatSize(entry.size_bytes)}
              </span>
              <button
                type="button"
                className="btn"
                disabled={restore.isPending}
                onClick={() => restore.mutate(entry.filename)}
              >
                {t("picker.damagedRestore")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {restore.isError && <p role="alert">{apiErrorMessage(restore.error, t("errors.generic"))}</p>}
    </section>
  );
}
```

(Import `apiErrorMessage` from `../apiErrorMessage` and `useMutation`/`useQuery` if not already imported.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend/apps/admin && npx vitest run && npx tsc -b`
Expected: PASS; tsc clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/admin/src/routes/PickerRoute.tsx frontend/apps/admin/src/i18n frontend/apps/admin/tests/unit/PickerRoute.test.tsx
git commit -m "Offer a damaged tournament file's backups on the picker page and restore one from there

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: End-to-end test and docs

**Files:**
- Create: `frontend/apps/admin/tests/e2e/backups.spec.ts`
- Modify: `server/CLAUDE.md` (new "Backups" section; `/api/time-sync` `boot_id`)
- Modify: `frontend/CLAUDE.md` (Backups page note; ports list)

**Interfaces:**
- Consumes: everything above; `tests/e2e/fixtures/isolatedServer.ts`'s `startIsolatedServer({ backendPort: 8131, frontendPort: 5191 })`.

- [ ] **Step 1: Write the E2E spec**

Create `frontend/apps/admin/tests/e2e/backups.spec.ts`:

```ts
import os from "node:os";
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "backups-e2e-pw";

test.describe.serial("backups", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let teamId = 0;
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function login(page: Page) {
    await page.goto(`${server.baseUrl}/login`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).not.toHaveURL(/\/login/);
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8131, frontendPort: 5191 });
    expect((await request.post(api("/api/event"), { data: { name: "Backup League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json())
      .access_token;
    const team = await request.post(api("/api/teams"), { headers: headers(), data: { number: "T1", name: "Team One" } });
    teamId = (await team.json()).id;
  });

  test.afterAll(() => server?.stop());

  test("back up, change a team, restore, and the change is gone", async ({ page, request }) => {
    await login(page);
    await page.getByRole("link", { name: "Backups" }).click();
    await expect(page.getByText("No backups yet.")).toBeVisible();
    await page.getByRole("button", { name: "Back up now" }).click();
    const manualRow = page.getByRole("row").filter({ hasText: "Back up now (manual)" });
    await expect(manualRow).toHaveCount(1);

    const renamed = await request.patch(api(`/api/teams/${teamId}`), { headers: headers(), data: { name: "Renamed" } });
    expect(renamed.ok()).toBeTruthy();

    const bootBefore = (await (await request.get(api("/api/time-sync"))).json()).boot_id;
    await manualRow.getByRole("button", { name: "Restore" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText("Everything after it is replaced.");
    await dialog.getByRole("button", { name: "Restore" }).click();

    await expect
      .poll(async () => {
        try {
          return (await (await request.get(api("/api/time-sync"))).json()).boot_id;
        } catch {
          return bootBefore;
        }
      }, { timeout: 30_000 })
      .not.toBe(bootBefore);

    const team = await (await request.get(api(`/api/teams`), { headers: headers() })).json();
    expect(team.find((t: { id: number }) => t.id === teamId).name).toBe("Team One");

    await page.goto(`${server.baseUrl}/backups`);
    if (page.url().includes("/login")) await login(page);
    await page.goto(`${server.baseUrl}/backups`);
    await expect(page.getByRole("row").filter({ hasText: "Before a restore" })).toHaveCount(1);
  });

  test("changing the folder backs up there, and Use default returns", async ({ page }) => {
    const custom = path.join(os.tmpdir(), `tournament-admin-e2e-backups-${Date.now()}`);
    await login(page);
    await page.goto(`${server.baseUrl}/backups`);
    await page.getByRole("button", { name: "Change" }).click();
    await page.getByLabel("Backup folder").fill(custom);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText(custom)).toBeVisible();
    await expect(page.getByText("No backups yet.")).toBeVisible();
    await page.getByRole("button", { name: "Back up now" }).click();
    await expect(page.getByRole("row").filter({ hasText: "Back up now (manual)" })).toHaveCount(1);

    await page.getByRole("button", { name: "Use default" }).click();
    await expect(page.getByText(/backups[\\/]event$/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Use default" })).toHaveCount(0);
  });
});
```

(The isolated server's database is `<tmp>/event.db`, so its default folder ends in `backups/event`.)

- [ ] **Step 2: Run it**

Run: `cd frontend/apps/admin && npx playwright test tests/e2e/backups.spec.ts`
Expected: PASS (2 tests). If the restored server rejects the old access token, the `if (page.url().includes("/login")) await login(page)` line covers the UI; for the API check, log in again with `request.post(api("/api/auth/login"), …)` before `GET /api/teams` and use the new token.

- [ ] **Step 3: Docs**

Add to `server/CLAUDE.md`, a new `## Backups` section before `## Database migrations`:

```markdown
## Backups

`services/backups.py` owns backup files; see
`docs/superpowers/specs/2026-10-12-automatic-backups-design.md`. Snapshots
use SQLite's online backup API (never a file copy), are written to a
temporary name and renamed, and get the tournament file's permission bits.
Names are `<stem>-<YYYY-MM-DD>-<HHMMSS>-<reason>.db` (local time, `-2`… on
a same-second clash). The folder defaults to `backups/<stem>/` next to the
tournament file; a custom one lives in the picker config's `backup_dirs`
(not in the tournament file, so a restore never reverts it).

`app.state.backups` (`BackupManager`) holds the last backup, the last
error and the newest `audit_log` id seen; a lifespan task checks every 5
minutes and snapshots only when that id grew (a restart alone takes none).
Only the newest 50 `interval` snapshots are kept. Risky steps call
`request.app.state.backups.snapshot_quietly("before-…")` after their checks
and before their first write; a failure there only sets `last_error`.
Admin-only routes: `GET/POST /api/backups`, `PUT /api/backups/folder`,
`POST /api/backups/{filename}/restore`.

A restore checks the backup (`PRAGMA quick_check` plus the same schema
comparison as `ensure_schema_current`), takes a `before-restore` snapshot,
writes `pending_restore` to the picker config and restarts;
`main._startup()` swaps the file in before anything opens it and deletes
the old `-wal`/`-shm`. `GET /api/time-sync` returns a per-process
`boot_id` so the admin UI can tell the restarted server from the old one.
If the tournament file fails `quick_check` at startup, the picker app
starts in damaged mode (`GET /api/picker/damaged`, `POST
/api/picker/restore`, unauthenticated like the rest of the picker), which
keeps a `-damaged.db` copy before swapping a backup in.
```

In `frontend/CLAUDE.md`, add after the "Game plugin gating" paragraph:

```markdown
**Backups** (`src/routes/BackupsRoute.tsx`, admin nav "Backups"): folder (Change / Use default), last backup and last error, Back up now, and the backups table with Restore. Restore reads `boot_id` from `GET /api/time-sync`, posts the restore, then waits with `useRestartPoll(…, "restarted")`, which polls time sync until a different `boot_id` answers (the picker-route check can't tell a normal-to-normal restart apart). The picker page shows a damaged file's backups when `GET /api/picker/damaged` answers.
```

and add `` `backups.spec.ts` on 8131/5191 `` to the isolated-server ports sentence.

- [ ] **Step 4: Full verification**

Run:
- `cd server && .venv/bin/python -m pytest -q` — Expected: all pass.
- `cd frontend/apps/admin && npx vitest run && npx tsc -b && npx playwright test` — Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/admin/tests/e2e/backups.spec.ts server/CLAUDE.md frontend/CLAUDE.md
git commit -m "Cover backups end to end (back up, change, restore, folder change) and document the backup service, the restore restart and the damaged-file picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
