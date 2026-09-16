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
