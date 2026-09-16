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
