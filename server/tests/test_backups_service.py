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
    base = dt.datetime(2020, 1, 1, 8, 0, 0).astimezone()
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
