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
