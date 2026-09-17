from __future__ import annotations

import os
import stat

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


def test_create_tournament_422s_on_a_space_in_the_filename(
    picker_client, tmp_path, execve_calls
):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/create",
        json={"directory": str(allowed), "filename": "my tournament.db"},
    )

    assert response.status_code == 422
    assert response.json()["detail"] == (
        "Filename may only contain letters, numbers, underscores, and hyphens"
    )
    assert execve_calls == []


def test_create_tournament_422s_on_a_disallowed_character_in_the_filename(
    picker_client, tmp_path, execve_calls
):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/create",
        json={"directory": str(allowed), "filename": "regional!.db"},
    )

    assert response.status_code == 422
    assert execve_calls == []


def test_create_tournament_allows_letters_numbers_underscore_and_hyphen(
    picker_client, tmp_path, execve_calls
):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/create",
        json={"directory": str(allowed), "filename": "20260916T1454-Regional_2.db"},
    )

    assert response.status_code == 202
    assert len(execve_calls) == 1


def test_create_tournament_422s_for_an_unwritable_directory(
    picker_client, tmp_path, execve_calls
):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    original_mode = stat.S_IMODE(os.stat(allowed).st_mode)
    os.chmod(allowed, stat.S_IRUSR | stat.S_IXUSR)
    try:
        response = picker_client.post(
            "/api/picker/create", json={"directory": str(allowed), "filename": "new.db"}
        )
    finally:
        os.chmod(allowed, original_mode)

    assert response.status_code == 422
    assert execve_calls == []


def test_create_tournament_409s_for_a_dangling_symlink(picker_client, tmp_path, execve_calls):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    dangling = allowed / "planted.db"
    dangling.symlink_to(tmp_path / "does-not-exist-anywhere.db")
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/create", json={"directory": str(allowed), "filename": "planted.db"}
    )

    # exists() alone follows the symlink and would report False for a
    # dangling target -- is_symlink() is what actually catches this.
    assert response.status_code == 409
    assert execve_calls == []


def test_open_tournament_403s_for_a_symlink_pointing_at_a_backup_file(
    picker_client, tmp_path, execve_calls
):
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    backup = allowed / "regional.db.pre-migration-20260101120000.bak"
    backup.write_text("x")
    disguised = allowed / "regional.db"
    disguised.symlink_to(backup)
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post("/api/picker/open", json={"path": str(disguised)})

    # The unresolved name ends in ".db", but it resolves to a
    # ".pre-migration-*.bak" file -- the suffix check must use the
    # resolved path, not the symlink's own name.
    assert response.status_code == 403
    assert execve_calls == []


def test_create_tournament_logs_rather_than_crashes_on_a_non_oserror_restart_failure(
    picker_client, tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(
        "os.execve",
        lambda executable, args, env: (_ for _ in ()).throw(ValueError("malformed argv")),
    )
    allowed = tmp_path / "tournaments"
    allowed.mkdir()
    picker_client.post("/api/picker/directories", json={"path": str(allowed)})

    response = picker_client.post(
        "/api/picker/create", json={"directory": str(allowed), "filename": "new.db"}
    )

    # A non-OSError exception from os.execve must be caught too, not
    # just OSError -- otherwise it vanishes into Starlette's
    # background-task error handling instead of being logged.
    assert response.status_code == 202
    assert "ERROR: failed to restart the server process" in capsys.readouterr().err


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
