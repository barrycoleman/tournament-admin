from __future__ import annotations

import pytest

from auth_helpers import login_as
from tournament_server import realtime

# NOTE: what actually has to happen exactly once, from an *entered*
# TestClient, is the ASGI lifespan run that captures
# app.state.realtime.event_loop — a bare, never-entered `TestClient(...)`
# never runs lifespan at all, so that stays None and every broadcast_* call
# (and every schedule_auto_advance) silently no-ops or raises. Receiving is
# not similarly constrained: Starlette's WebSocketTestSession hands frames
# across a thread-safe `queue.Queue`, which is loop-agnostic, so a
# connection opened on a *different* TestClient — even an un-entered one,
# as test_broadcast_wiring.py does — still correctly receives a broadcast
# scheduled onto the loop some other entered client captured. This file
# opens everything through the entered `client` fixture anyway, which is
# the simplest thing that is always right.


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


def test_a_binary_frame_from_a_client_does_not_break_the_connection(client):
    """Both channels are receive-only and never inspect what a client sends,
    so every frame type has to be tolerated identically. `receive_text()`
    reached for `message["text"]` unconditionally and raised a bare
    `KeyError` — not a graceful disconnect — on a binary frame, tearing the
    connection down and unregistering the subscriber."""
    client.post("/api/event", json={"name": "Regional Qualifier"})
    token = login_as(client, "scorer")

    with client.websocket_connect(f"/ws/active-session?token={token}") as ws:
        ws.send_bytes(b"\x00\x01\x02")
        realtime.broadcast_active_session(
            client.app, "match_phase_changed", {"match_id": 1}
        )
        message = ws.receive_json()

    assert message == {"event": "match_phase_changed", "data": {"match_id": 1}}


def test_broadcast_active_session_delivers_over_real_websocket_connection(client):
    """Regression test for the Task 4 review finding.

    Proves the fix actually closes the gap: the `client` fixture is entered
    as a context manager, so the ASGI lifespan ran and
    `app.state.realtime.event_loop` holds a real loop — which is what lets
    `realtime.broadcast_active_session` (scheduling via
    `asyncio.run_coroutine_threadsafe(coro, registry.event_loop)`) deliver
    anything at all. Before the fix the fixture was never entered, that
    loop reference stayed `None`, and `broadcast_active_session` returned
    without sending, so this assertion would hang waiting for a frame that
    was never scheduled.
    """
    client.post("/api/event", json={"name": "Regional Qualifier"})
    token = login_as(client, "scorer")

    with client.websocket_connect(f"/ws/active-session?token={token}") as ws:
        realtime.broadcast_active_session(
            client.app, "match_phase_changed", {"match_id": 1}
        )
        message = ws.receive_json()

    assert message == {"event": "match_phase_changed", "data": {"match_id": 1}}
