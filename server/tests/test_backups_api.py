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
    assert raw.post("/api/backups/x.db/restore", headers=headers).status_code == 403


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
