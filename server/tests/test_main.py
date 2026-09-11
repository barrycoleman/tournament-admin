from __future__ import annotations

import os
import socket
import subprocess
import sys


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
