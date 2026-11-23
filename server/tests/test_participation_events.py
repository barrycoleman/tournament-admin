from __future__ import annotations

import pytest

from device_helpers import paired_device
from skills_helpers import next_event
from tournament_server.routers import participation


@pytest.fixture
def setup(client):
    client.post("/api/event", json={"name": "Check-in Event"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"}).json()["id"]
    return session_id, team_id


def _check_in(client, session_id, team_id, checked_in=True):
    response = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": checked_in},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _admin_token(client):
    return client.headers["Authorization"].removeprefix("Bearer ")


def test_checking_in_a_team_tells_the_active_session_channel(client, setup):
    session_id, team_id = setup
    client.post("/api/event/active-session", json={"session_id": session_id})
    with client.websocket_connect(f"/ws/active-session?token={_admin_token(client)}") as socket:
        _check_in(client, session_id, team_id)
        assert next_event(socket, "participation_changed")["data"] == {"session_id": session_id}


def test_unchecking_an_existing_participant_also_broadcasts(client, setup):
    session_id, team_id = setup
    client.post("/api/event/active-session", json={"session_id": session_id})
    with client.websocket_connect(f"/ws/active-session?token={_admin_token(client)}") as socket:
        _check_in(client, session_id, team_id)
        next_event(socket, "participation_changed")
        unchecked = _check_in(client, session_id, team_id, checked_in=False)
        assert unchecked["checked_in"] is False
        assert next_event(socket, "participation_changed")["data"] == {"session_id": session_id}


def test_a_display_device_receives_the_event(client, setup):
    session_id, team_id = setup
    client.post("/api/event/active-session", json={"session_id": session_id})
    device = paired_device(client, role="display_device")
    with client.websocket_connect(f"/ws/active-session?token={device['access_token']}") as socket:
        _check_in(client, session_id, team_id)
        assert next_event(socket, "participation_changed")["data"] == {"session_id": session_id}


def test_an_inactive_sessions_channel_receives_it(client, setup):
    session_id, team_id = setup
    with client.websocket_connect(f"/ws/session/{session_id}?token={_admin_token(client)}") as socket:
        _check_in(client, session_id, team_id)
        assert next_event(socket, "participation_changed")["data"] == {"session_id": session_id}


def test_a_refused_check_in_sends_nothing(client, setup, monkeypatch):
    session_id, team_id = setup
    calls = []
    monkeypatch.setattr(participation, "broadcast_for_session", lambda *a, **k: calls.append(a))
    unknown_team = client.post(
        f"/api/sessions/{session_id}/participants", json={"team_id": 9999, "checked_in": True}
    )
    unknown_session = client.post(
        "/api/sessions/9999/participants", json={"team_id": team_id, "checked_in": True}
    )
    assert unknown_team.status_code == 404
    assert unknown_session.status_code == 404
    assert calls == []
    _check_in(client, session_id, team_id)
    assert len(calls) == 1
