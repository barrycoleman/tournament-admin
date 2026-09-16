from __future__ import annotations

import os
import socket
import subprocess
import sys


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


def test_main_exits_cleanly_with_no_traceback_when_no_port_is_free():
    """Regression test for main.py's clean-exit path (NoFreePortError ->
    "ERROR: ..." on stderr, exit 1). Runs the real module entry point in
    a fresh subprocess with all 11 candidate ports pre-occupied, matching
    this project's own manual-verification steps for this behavior."""
    # Grab a genuinely free port range from the OS, then occupy all 11
    # candidate ports (start_port through start_port + 10) that
    # find_free_port would probe, so the subprocess has nowhere to bind.
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.bind(("127.0.0.1", 0))
    start_port = probe.getsockname()[1]
    probe.close()

    sockets = []
    try:
        for offset in range(11):
            s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind(("127.0.0.1", start_port + offset))
            s.listen(1)
            sockets.append(s)

        env = dict(os.environ)
        env["TOURNAMENT_HOST"] = "127.0.0.1"
        env["TOURNAMENT_PORT"] = str(start_port)

        result = subprocess.run(
            [sys.executable, "-m", "tournament_server.main"],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )

        assert result.returncode == 1, result.stdout + result.stderr
        assert "ERROR:" in result.stderr
        assert str(start_port) in result.stderr
        assert str(start_port + 10) in result.stderr
        # No raw traceback — just the clean, printed error.
        assert "Traceback" not in result.stderr
    finally:
        for s in sockets:
            s.close()


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


def test_main_clears_last_opened_path_on_non_schema_boot_failure(tmp_path):
    """Modeled on test_main_clears_last_opened_path_on_schema_mismatch,
    but for a boot failure that is NOT a SchemaMismatchError -- e.g. a
    last_opened_path whose parent directory doesn't exist, which makes
    SQLite raise a plain "unable to open database file" error
    (sqlalchemy.exc.OperationalError, which does not subclass
    SchemaMismatchError). Before this fix, _startup()'s recovery branch
    only caught SchemaMismatchError, so this kind of failure would never
    clear last_opened_path and every subsequent restart would fail
    identically. This pins that the broadened except now still exits
    cleanly (no traceback) AND still clears the config."""
    config_path = tmp_path / "server-config.json"
    unopenable_path = tmp_path / "missing-parent-dir" / "regional.db"
    config_path.write_text(
        json.dumps({"allowed_directories": [], "last_opened_path": str(unopenable_path)})
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

    assert result.returncode == 1, result.stdout + result.stderr
    assert "ERROR:" in result.stderr
    assert "Traceback" not in result.stderr
    updated = json.loads(config_path.read_text())
    assert updated["last_opened_path"] is None


def test_main_prefers_the_env_var_over_a_conflicting_last_opened_path(tmp_path):
    """TOURNAMENT_DB_PATH is a legacy override that always wins over the
    picker config's last_opened_path -- see resolve_active_db_path's
    documented precedence. The two candidate paths must be behaviorally
    distinguishable for this test to mean anything: the config's
    last_opened_path points at a database with an old, incompatible
    schema (same construction as
    test_main_clears_last_opened_path_on_schema_mismatch), while
    TOURNAMENT_DB_PATH points at a different, fresh, nonexistent path
    that fresh-installs cleanly. If precedence were backwards (config
    wins), _startup() would hit SchemaMismatchError on the bad config
    path and exit 1 *before ever binding a port* -- so _wait_for_http
    would time out instead of the assertions below ever running. Only a
    correct env-var-wins precedence lets this boot succeed at all."""
    from tournament_server.db import Base, make_engine

    bad_db = tmp_path / "old.db"
    engine = make_engine(str(bad_db))
    tables_to_create = [
        t for name, t in Base.metadata.tables.items() if name != "scoring_devices"
    ]
    Base.metadata.create_all(engine, tables=tables_to_create)

    port = _free_port()
    config_path = tmp_path / "server-config.json"
    config_path.write_text(
        json.dumps({"allowed_directories": [], "last_opened_path": str(bad_db)})
    )

    env = dict(os.environ)
    env["TOURNAMENT_DB_PATH"] = str(tmp_path / "env-chosen.db")
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

        updated = json.loads(config_path.read_text())
        assert updated["last_opened_path"] == str(bad_db)
    finally:
        process.terminate()
        process.wait(timeout=10)


def test_main_schema_mismatch_on_env_var_path_does_not_clear_config(tmp_path):
    """The SchemaMismatchError handler in _startup() only clears
    last_opened_path when the failing path came from the picker config
    (settings.db_path is None) -- never when it came from the legacy
    TOURNAMENT_DB_PATH override. This pins the "does NOT clear" half of
    that branch, which test_main_clears_last_opened_path_on_schema_mismatch
    doesn't cover."""
    from tournament_server.db import Base, make_engine

    bad_db = tmp_path / "old.db"
    engine = make_engine(str(bad_db))
    tables_to_create = [
        t for name, t in Base.metadata.tables.items() if name != "scoring_devices"
    ]
    Base.metadata.create_all(engine, tables=tables_to_create)

    config_path = tmp_path / "server-config.json"
    unrelated_last_opened_path = str(tmp_path / "unrelated.db")
    config_path.write_text(
        json.dumps(
            {"allowed_directories": [], "last_opened_path": unrelated_last_opened_path}
        )
    )
    port = _free_port()
    env = dict(os.environ)
    env["TOURNAMENT_DB_PATH"] = str(bad_db)
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
    assert updated["last_opened_path"] == unrelated_last_opened_path
