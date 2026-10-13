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
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import create_engine

from tournament_server.db import utc_now
from tournament_server.picker_config import load_config, save_config

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
        if not match:
            continue
        try:
            if path.is_file():
                entries.append(_entry(path, match))
        except FileNotFoundError:
            continue  # pruned between listing and stat
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
        self._remove_stale_partials()

    def _remove_stale_partials(self) -> None:
        """Hidden temp files left by a snapshot that was interrupted."""
        try:
            stem = Path(self.db_path).stem
            for path in self.folder().glob(f".{stem}-*.partial"):
                path.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001 - best effort
            pass

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
        except Exception as exc:  # noqa: BLE001 - a risky step must never fail on a backup
            self.last_error = {"message": str(exc), "at": utc_now()}
            logger.exception("Backup (%s) failed", reason)

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


DAMAGED_DETAIL = "This backup is damaged."
PENDING_RESTORE_MAX_AGE_SECONDS = 120
OLDER_BUILD_DETAIL = "This backup was made by an older build and can't be restored."


def _immutable_uri(path: Path) -> str:
    return f"{path.resolve().as_uri()}?mode=ro&immutable=1"


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
        for suffix in ("-wal", "-shm"):
            Path(f"{target}{suffix}").unlink(missing_ok=True)
        os.replace(tmp, target)
    except OSError:
        tmp.unlink(missing_ok=True)
        raise


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
    if _is_stale(pending.get("requested_at")):
        _record_restore_error(
            config_path,
            "The restore was cancelled because the server took too long to restart. Nothing was changed.",
        )
        print(
            f"ERROR: ignoring the pending restore of {pending['source']}: it was not requested just now",
            file=sys.stderr,
        )
        return
    try:
        replace_database(Path(pending["source"]), target)
    except OSError as exc:
        _record_restore_error(
            config_path, f"The restore didn't happen: {exc.strerror or exc}. Nothing was changed."
        )
        print(
            f"ERROR: restoring {pending['source']} failed, keeping the current file: {exc}",
            file=sys.stderr,
        )


def _record_restore_error(config_path: Path, message: str) -> None:
    config = load_config(config_path)
    config.last_restore_error = {"message": message, "at": utc_now().isoformat()}
    save_config(config_path, config)


def _is_stale(requested_at: str | None) -> bool:
    if not requested_at:
        return True
    try:
        when = dt.datetime.fromisoformat(requested_at)
    except ValueError:
        return True
    if when.tzinfo is None:
        when = when.replace(tzinfo=dt.UTC)
    return (utc_now() - when).total_seconds() > PENDING_RESTORE_MAX_AGE_SECONDS


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
    except sqlite3.OperationalError:
        # Locked or unreadable is not corruption; let startup fail loudly
        # rather than inviting an overwrite.
        return False
    except sqlite3.DatabaseError:
        return True


def restore_damaged(db_path: str, backup: Path, folder: Path) -> None:
    """Keeps a copy of the damaged file in `folder` as
    `<stem>-<timestamp>-damaged.db`, then swaps `backup` in."""
    target = Path(db_path).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().astimezone().strftime("%Y-%m-%d-%H%M%S")
    base = f"{target.stem}-{stamp}-damaged"
    kept = folder / f"{base}.db"
    sequence = 2
    while kept.exists():
        kept = folder / f"{base}-{sequence}.db"
        sequence += 1
    shutil.copyfile(target, kept)
    copy_mode(target, kept)
    wal = Path(f"{target}-wal")
    if wal.exists():
        kept_wal = Path(f"{kept}-wal")
        shutil.copyfile(wal, kept_wal)
        copy_mode(target, kept_wal)
    replace_database(backup, target)
