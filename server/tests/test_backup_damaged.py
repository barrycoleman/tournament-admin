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


def test_restoring_keeps_the_wal_sidecar_the_mode_and_never_overwrites_a_kept_copy(damaged):
    client, target, entry, _ = damaged
    os.chmod(target, 0o640)
    Path(f"{target}-wal").write_bytes(b"newest committed frames")
    folder = backups.default_folder(str(target))
    backups.restore_damaged(str(target), entry.path, folder)
    kept = list(folder.glob("spring-*-damaged.db"))
    assert len(kept) == 1
    assert Path(f"{kept[0]}-wal").read_bytes() == b"newest committed frames"
    assert (kept[0].stat().st_mode & 0o777) == 0o640
    target.write_bytes(b"not a database" * 200)
    backups.restore_damaged(str(target), entry.path, folder)
    assert len(list(folder.glob("spring-*-damaged*.db"))) == 2


def test_a_locked_or_unreadable_file_is_not_called_damaged(tmp_path, monkeypatch):
    path = tmp_path / "x.db"
    path.write_bytes(b"whatever")

    def locked(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(backups.sqlite3, "connect", locked)
    assert backups.database_is_damaged(str(path)) is False


def test_a_second_picker_restore_after_success_is_404(damaged):
    client, _, entry, calls = damaged
    assert client.post("/api/picker/restore", json={"filename": entry.filename}).status_code == 202
    assert client.post("/api/picker/restore", json={"filename": entry.filename}).status_code == 404
    assert calls == [True]


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
