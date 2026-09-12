from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auth_helpers import login_as


def test_active_session_rejects_missing_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = TestClient(client.app)

    with pytest.raises(Exception):
        with raw.websocket_connect("/ws/active-session"):
            pass


def test_active_session_rejects_invalid_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = TestClient(client.app)

    with pytest.raises(Exception):
        with raw.websocket_connect("/ws/active-session?token=not-a-real-jwt"):
            pass


def test_active_session_accepts_any_authenticated_role(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = TestClient(client.app)
    token = login_as(raw, "scorer")

    with raw.websocket_connect(f"/ws/active-session?token={token}") as ws:
        pass  # connecting without error is the assertion


def test_session_channel_requires_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_response = client.post("/api/sessions", json={"label": "Qualification"})
    session_id = session_response.json()["id"]
    raw = TestClient(client.app)
    scorer_token = login_as(raw, "scorer")

    with pytest.raises(Exception):
        with raw.websocket_connect(
            f"/ws/session/{session_id}?token={scorer_token}"
        ):
            pass


def test_session_channel_accepts_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_response = client.post("/api/sessions", json={"label": "Qualification"})
    session_id = session_response.json()["id"]
    raw = TestClient(client.app)
    admin_token = login_as(raw, "admin")

    with raw.websocket_connect(
        f"/ws/session/{session_id}?token={admin_token}"
    ) as ws:
        pass
