import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from plugin_helpers import zip_fixture_plugin
from skills_helpers import SECOND_GAME, admin_token, create_event, create_session, enable_skills, next_event

TYPES = [{"key": "autonomous", "label": "Autonomous"}, {"key": "driver", "label": "Driver"}]


def test_settings_read_the_defaults_before_anything_is_saved(client):
    create_event(client)
    assert client.get("/api/skills/settings").json() == {
        "enabled": False,
        "attempts": {"autonomous": 3, "driver": 3},
        "types": TYPES,
    }


def test_settings_before_a_game_plugin_is_chosen(client):
    client.post("/api/event", json={"name": "League"})
    assert client.get("/api/skills/settings").json() == {"enabled": False, "attempts": {}, "types": []}
    refused = client.put("/api/skills/settings", json={"enabled": False, "attempts": {}})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Choose a game plugin before setting up skills challenges."


def test_update_settings(client):
    create_event(client)
    response = client.put("/api/skills/settings", json={"enabled": True, "attempts": {"driver": 5}})
    assert response.status_code == 200, response.text
    expected = {"enabled": True, "attempts": {"autonomous": 3, "driver": 5}, "types": TYPES}
    assert response.json() == expected
    assert client.get("/api/skills/settings").json() == expected


@pytest.mark.parametrize(
    "attempts",
    [{"teleop": 3}, {"driver": 0}, {"driver": 21}, {"driver": 2.5}, {"driver": "3"}, {"driver": None}],
)
def test_update_settings_rejects_bad_attempts(client, attempts):
    create_event(client)
    assert client.put("/api/skills/settings", json={"enabled": True, "attempts": attempts}).status_code == 422
    assert client.get("/api/skills/settings").json()["enabled"] is False


@pytest.mark.parametrize("value", [True, 1.5, "3"])
def test_settings_reject_non_integer_attempts(client, value):
    create_event(client)
    session_id = create_session(client)
    assert client.put("/api/skills/settings", json={"enabled": True, "attempts": {"driver": value}}).status_code == 422
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": value}}).status_code == 422
    assert client.get("/api/skills/settings").json()["attempts"]["driver"] == 3
    assert client.get(f"/api/sessions/{session_id}/skills").json()["override"] is None


def test_enabling_a_game_without_skills_types_is_refused(client):
    client.post("/api/event", json={"name": "League"})
    uploaded = client.post(
        "/api/plugins/games",
        files={"file": ("second-game.zip", zip_fixture_plugin(SECOND_GAME), "application/zip")},
    )
    assert uploaded.status_code == 201, uploaded.text
    assert client.post("/api/event/game-plugin", json={"name": "second-game"}).status_code == 200
    refused = client.put("/api/skills/settings", json={"enabled": True, "attempts": {}})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "This game has no skills challenges."
    allowed = client.put("/api/skills/settings", json={"enabled": False, "attempts": {}})
    assert allowed.status_code == 200
    assert allowed.json() == {"enabled": False, "attempts": {}, "types": []}


def test_settings_are_read_by_any_role_and_changed_by_admin_only(client):
    create_event(client)
    raw = TestClient(client.app)
    assert raw.get("/api/skills/settings").status_code == 401
    assert raw.get("/api/skills/settings", headers=bearer(login_as(raw, "attendee"))).status_code == 200
    scorer = bearer(login_as(raw, "scorer"))
    assert raw.put("/api/skills/settings", json={"enabled": True, "attempts": {}}, headers=scorer).status_code == 403


def test_settings_change_broadcasts_on_the_active_session_channel(client):
    create_event(client)
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        enable_skills(client)
        assert next_event(socket, "skills_settings_changed")["data"] == {"session_id": None}


def test_session_override_set_and_cleared(client):
    create_event(client)
    enable_skills(client, {"driver": 5})
    session_id = create_session(client)

    assert client.get(f"/api/sessions/{session_id}/skills").json() == {
        "types": [{**TYPES[0], "allowed": 3}, {**TYPES[1], "allowed": 5}],
        "override": None,
    }
    overridden = client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"autonomous": 1}})
    assert overridden.status_code == 200, overridden.text
    assert overridden.json() == {
        "types": [{**TYPES[0], "allowed": 1}, {**TYPES[1], "allowed": 5}],
        "override": {"autonomous": 1},
    }
    cleared = client.put(f"/api/sessions/{session_id}/skills", json={"attempts": None})
    assert cleared.json()["override"] is None
    assert [t["allowed"] for t in cleared.json()["types"]] == [3, 5]
    emptied = client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {}})
    assert emptied.json()["override"] is None


def test_session_override_validation_permissions_and_404(client):
    create_event(client)
    session_id = create_session(client)
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"teleop": 2}}).status_code == 422
    assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": 21}}).status_code == 422
    assert client.get("/api/sessions/999/skills").status_code == 404
    assert client.put("/api/sessions/999/skills", json={"attempts": None}).status_code == 404
    raw = TestClient(client.app)
    referee = bearer(login_as(raw, "referee"))
    assert raw.get(f"/api/sessions/{session_id}/skills", headers=referee).status_code == 200
    assert raw.put(f"/api/sessions/{session_id}/skills", json={"attempts": None}, headers=referee).status_code == 403


def test_session_override_broadcasts_on_both_channels(client):
    create_event(client)
    session_id = create_session(client)
    token = admin_token(client)
    with client.websocket_connect(f"/ws/session/{session_id}?token={token}") as session_socket, \
            client.websocket_connect(f"/ws/active-session?token={token}") as active_socket:
        assert client.put(f"/api/sessions/{session_id}/skills", json={"attempts": {"driver": 2}}).status_code == 200
        assert next_event(session_socket, "skills_settings_changed")["data"] == {"session_id": session_id}
        assert next_event(active_socket, "skills_settings_changed")["data"] == {"session_id": session_id}


def test_scoresheet_schema_per_type(client):
    create_event(client)
    autonomous = client.get("/api/skills/types/autonomous/schema")
    assert autonomous.status_code == 200
    assert [f["name"] for f in autonomous.json()] == ["objects_scored", "parked"]
    assert [f["name"] for f in client.get("/api/skills/types/driver/schema").json()] == ["objects_scored"]
    assert client.get("/api/skills/types/teleop/schema").status_code == 404
