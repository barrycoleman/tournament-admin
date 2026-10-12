from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from plugin_helpers import zip_fixture_plugin
from skills_helpers import SECOND_GAME, admin_token, create_session, enable_skills, next_event, record_attempt

LOCKED = "The game plugin can't be changed after matches are scheduled or skills attempts are recorded."
DRIVER_AWARD = {
    "name": "Driver Champion", "kind": "performance", "scope": "event",
    "source": "skills_type", "skills_type": "driver", "basis": "session", "placement": 1,
}


def _event(client) -> None:
    """An event with example-game and second-game (no skills types) installed, none selected."""
    assert client.post("/api/event", json={"name": "League"}).status_code == 201
    uploaded = client.post(
        "/api/plugins/games",
        files={"file": ("second-game.zip", zip_fixture_plugin(SECOND_GAME), "application/zip")},
    )
    assert uploaded.status_code == 201, uploaded.text


def _select(client, name: str) -> dict:
    response = client.post("/api/event/game-plugin", json={"name": name})
    assert response.status_code == 200, response.text
    return response.json()


def _schedule_one_match(client) -> None:
    session_id = create_session(client, "Match day")
    team_ids = [client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"] for n in range(1, 5)]
    response = client.post("/api/matches", json={
        "session_id": session_id, "round_type": "qualification", "match_number": 1, "field_id": None,
        "alliances": [
            {"station": "red", "team_ids": team_ids[:2]},
            {"station": "blue", "team_ids": team_ids[2:]},
        ],
    })
    assert response.status_code == 201, response.text


def test_switch_and_clear_while_unused(client):
    _event(client)
    assert _select(client, "example-game")["game_plugin_locked"] is False
    assert _select(client, "second-game")["game_plugin_name"] == "second-game"
    cleared = client.delete("/api/event/game-plugin")
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["game_plugin_name"] is None
    assert client.get("/api/event").json()["game_plugin_name"] is None


def test_unknown_plugin_is_404(client):
    _event(client)
    assert client.post("/api/event/game-plugin", json={"name": "no-such-game"}).status_code == 404


def test_reselecting_the_same_plugin_keeps_settings_and_does_not_broadcast(client, monkeypatch):
    _event(client)
    _select(client, "example-game")
    enable_skills(client, {"driver": 5})
    sent = []
    monkeypatch.setattr("tournament_server.routers.event.broadcast_all", lambda *args: sent.append(args))
    _select(client, "example-game")
    assert client.get("/api/skills/settings").json()["enabled"] is True
    assert client.get("/api/skills/settings").json()["attempts"]["driver"] == 5
    assert sent == []


def test_switching_resets_skills_session_overrides_and_ranking_settings(client):
    _event(client)
    _select(client, "example-game")
    enable_skills(client, {"driver": 5})
    session_id = create_session(client)
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": 2}}).status_code == 200
    ranking = client.get("/api/ranking-settings").json()
    ranking.pop("game_model")
    ranking["session_drop_no_show"] = True
    assert client.put("/api/ranking-settings", json=ranking).status_code == 200, "ranking settings save"

    _select(client, "second-game")

    assert client.get("/api/skills/settings").json() == {"enabled": False, "attempts": {}, "types": []}
    assert client.get(f"/api/sessions/{session_id}/skills").json()["override"] is None
    # The second-game fixture declares no game_model, so ranking settings are read back
    # through example-game (the switch back is itself a change that resets nothing further).
    _select(client, "example-game")
    assert client.get("/api/ranking-settings").json()["session_drop_no_show"] is False


def test_clearing_resets_settings_too(client):
    _event(client)
    _select(client, "example-game")
    enable_skills(client)
    assert client.delete("/api/event/game-plugin").status_code == 200
    _select(client, "example-game")
    assert client.get("/api/skills/settings").json()["enabled"] is False


def test_a_scheduled_match_locks_the_plugin(client):
    _event(client)
    _select(client, "example-game")
    _schedule_one_match(client)
    assert client.get("/api/event").json()["game_plugin_locked"] is True
    for response in (
        client.post("/api/event/game-plugin", json={"name": "second-game"}),
        client.delete("/api/event/game-plugin"),
        client.post("/api/event/game-plugin?dry_run=true", json={"name": "second-game"}),
        client.delete("/api/event/game-plugin?dry_run=true"),
    ):
        assert (response.status_code, response.json()["detail"]) == (409, LOCKED)
    assert _select(client, "example-game")["game_plugin_name"] == "example-game"


def test_a_skills_attempt_locks_the_plugin(client):
    _event(client)
    _select(client, "example-game")
    team_id = client.post("/api/teams", json={"number": "1", "name": "Team 1"}).json()["id"]
    session_id = create_session(client, checked_in=[team_id])
    enable_skills(client)
    assert record_attempt(client, session_id, team_id).status_code == 201
    response = client.post("/api/event/game-plugin", json={"name": "second-game"})
    assert (response.status_code, response.json()["detail"]) == (409, LOCKED)


@pytest.mark.parametrize("role", ["scorer", "judge", "referee", "attendee", "front_desk"])
def test_only_admins_choose_change_or_clear(client, role):
    _event(client)
    raw = TestClient(client.app)
    headers = bearer(login_as(raw, role))
    assert raw.post("/api/event/game-plugin", json={"name": "example-game"}, headers=headers).status_code == 403
    _select(client, "example-game")
    assert raw.post("/api/event/game-plugin", json={"name": "second-game"}, headers=headers).status_code == 403
    assert raw.post("/api/event/game-plugin?dry_run=true", json={"name": "second-game"}, headers=headers).status_code == 403
    assert raw.delete("/api/event/game-plugin", headers=headers).status_code == 403
    assert raw.delete("/api/event/game-plugin?dry_run=true", headers=headers).status_code == 403


def test_dry_run_reports_what_would_reset_and_changes_nothing(client):
    _event(client)
    _select(client, "example-game")
    enable_skills(client)
    session_id = create_session(client)
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": 2}}).status_code == 200
    award = client.post(f"/api/sessions/{session_id}/awards", json=DRIVER_AWARD).json()
    judged = {"name": "Excellence Award", "kind": "judged", "scope": "event"}
    assert client.post(f"/api/sessions/{session_id}/awards", json=judged).status_code == 201

    switch = client.post("/api/event/game-plugin?dry_run=true", json={"name": "second-game"})
    assert switch.status_code == 200, switch.text
    assert switch.json() == {
        "would_reset": {"skills_enabled": True, "session_attempt_overrides": 1, "ranking_settings": False},
        "awards_needing_attention": [{
            "award_id": award["id"], "session_id": session_id, "session_label": "Saturday",
            "name": "Driver Champion", "reason": "unknown_skills_type",
        }],
    }
    clear = client.delete("/api/event/game-plugin?dry_run=true").json()
    assert clear["awards_needing_attention"][0]["reason"] == "unavailable"

    assert client.get("/api/event").json()["game_plugin_name"] == "example-game"
    assert client.get("/api/skills/settings").json()["enabled"] is True
    assert client.get(f"/api/sessions/{session_id}/skills").json()["override"] == {"driver": 2}


def test_dry_run_of_the_current_plugin_reports_nothing(client):
    _event(client)
    _select(client, "example-game")
    enable_skills(client)
    response = client.post("/api/event/game-plugin?dry_run=true", json={"name": "example-game"})
    assert response.json() == {
        "would_reset": {"skills_enabled": False, "session_attempt_overrides": 0, "ranking_settings": False},
        "awards_needing_attention": [],
    }


def test_a_change_broadcasts_on_every_channel(client):
    _event(client)
    _select(client, "example-game")
    session_id = create_session(client)
    token = admin_token(client)
    with client.websocket_connect(f"/ws/session/{session_id}?token={token}") as session_socket, \
            client.websocket_connect(f"/ws/active-session?token={token}") as active_socket:
        _select(client, "second-game")
        expected = {"game_plugin_name": "second-game"}
        assert next_event(session_socket, "game_plugin_changed")["data"] == expected
        assert next_event(active_socket, "game_plugin_changed")["data"] == expected
