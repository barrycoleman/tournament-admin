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
