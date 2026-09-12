from __future__ import annotations

import pytest

from auth_helpers import login_as
from tournament_server import realtime

# NOTE: every WebSocket connection opened in this file must live on the same
# event loop/portal that app.state.realtime.event_loop was captured from —
# i.e. it must go through the already-entered `client` fixture itself, or
# through a second `TestClient` that has ALSO been entered via `with
# TestClient(client.app) as raw:`. A bare, never-entered `TestClient(...)`
# spins up its own separate portal/loop/thread for `websocket_connect`,
# which is a different loop than the one realtime.py's broadcast_* functions
# schedule work onto via `asyncio.run_coroutine_threadsafe`. See Task 3's
# fix for the same hazard in conftest.py, and the regression test at the
# bottom of this file.


def test_active_session_rejects_missing_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    with pytest.raises(Exception):
        with client.websocket_connect("/ws/active-session"):
            pass


def test_active_session_rejects_invalid_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    with pytest.raises(Exception):
        with client.websocket_connect("/ws/active-session?token=not-a-real-jwt"):
            pass


def test_active_session_accepts_any_authenticated_role(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    token = login_as(client, "scorer")

    with client.websocket_connect(f"/ws/active-session?token={token}") as ws:
        pass  # connecting without error is the assertion


def test_session_channel_requires_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_response = client.post("/api/sessions", json={"label": "Qualification"})
    session_id = session_response.json()["id"]
    scorer_token = login_as(client, "scorer")

    with pytest.raises(Exception):
        with client.websocket_connect(
            f"/ws/session/{session_id}?token={scorer_token}"
        ):
            pass


def test_session_channel_accepts_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_response = client.post("/api/sessions", json={"label": "Qualification"})
    session_id = session_response.json()["id"]
    admin_token = login_as(client, "admin")

    with client.websocket_connect(
        f"/ws/session/{session_id}?token={admin_token}"
    ) as ws:
        pass


def test_broadcast_active_session_delivers_over_real_websocket_connection(client):
    """Regression test for the Task 4 review finding.

    Proves the fix actually closes the gap: a connection opened through the
    already-entered `client` fixture lives on the same loop that
    `app.state.realtime.event_loop` was captured from, so
    `realtime.broadcast_active_session` (which schedules delivery via
    `asyncio.run_coroutine_threadsafe(coro, registry.event_loop)`) can
    genuinely deliver a message to it. Before the fix, this same assertion
    made against a connection opened via a bare, never-entered
    `TestClient(client.app)` would hang or raise a cross-loop error instead
    of receiving anything, because that connection's `websocket_connect`
    spins up its own independent portal/loop/thread.
    """
    client.post("/api/event", json={"name": "Regional Qualifier"})
    token = login_as(client, "scorer")

    with client.websocket_connect(f"/ws/active-session?token={token}") as ws:
        realtime.broadcast_active_session(
            client.app, "match_phase_changed", {"match_id": 1}
        )
        message = ws.receive_json()

    assert message == {"event": "match_phase_changed", "data": {"match_id": 1}}
