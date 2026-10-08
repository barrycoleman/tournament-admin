import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from skills_helpers import (
    admin_token,
    admitted_device_token,
    create_event,
    create_session,
    enable_skills,
    next_event,
    record_attempt,
)


@pytest.fixture()
def setup(client):
    """Teams 1 and 2 checked in to Saturday; team 3 not. Skills on, 3 attempts each."""
    t1, t2, t3 = create_event(client)
    enable_skills(client)
    session_id = create_session(client, checked_in=(t1, t2))
    return client, session_id, (t1, t2, t3)


def _attempts(client, session_id):
    response = client.get(f"/api/sessions/{session_id}/skills/attempts")
    assert response.status_code == 200, response.text
    return response.json()


def test_create_returns_the_scored_attempt(setup):
    client, s1, (t1, _, _) = setup
    response = record_attempt(client, s1, t1, "autonomous", objects=7, parked=True)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["team_id"] == t1
    assert body["skills_type"] == "autonomous"
    assert body["number"] == 1
    assert body["score"] == 18
    assert body["data"] == {"objects_scored": 7, "parked": True}
    assert body["recorded_at"] == body["updated_at"]


def test_numbers_count_per_team_and_type(setup):
    client, s1, (t1, t2, _) = setup
    record_attempt(client, s1, t1, "driver", objects=1)
    record_attempt(client, s1, t1, "autonomous", objects=2)
    record_attempt(client, s1, t1, "driver", objects=3)
    record_attempt(client, s1, t2, "driver", objects=4)
    listed = [(a["team_id"], a["skills_type"], a["number"], a["score"]) for a in _attempts(client, s1)]
    assert listed == [(t1, "driver", 1, 2), (t1, "autonomous", 1, 4), (t1, "driver", 2, 6), (t2, "driver", 1, 8)]


def test_numbers_move_up_after_a_delete(setup):
    client, s1, (t1, _, _) = setup
    first = record_attempt(client, s1, t1, objects=1).json()
    record_attempt(client, s1, t1, objects=2)
    record_attempt(client, s1, t1, objects=3)
    assert client.delete(f"/api/skills/attempts/{first['id']}").status_code == 204
    assert [(a["number"], a["score"]) for a in _attempts(client, s1)] == [(1, 4), (2, 6)]


def test_edit_rescores_and_keeps_its_place(setup):
    client, s1, (t1, _, _) = setup
    first = record_attempt(client, s1, t1, objects=1).json()
    record_attempt(client, s1, t1, objects=2)
    edited = client.put(f"/api/skills/attempts/{first['id']}", json={"data": {"objects_scored": 10}})
    assert edited.status_code == 200, edited.text
    body = edited.json()
    assert (body["number"], body["score"]) == (1, 20)
    assert body["recorded_at"] == first["recorded_at"]
    assert body["updated_at"] >= first["updated_at"]
    assert [(a["number"], a["score"]) for a in _attempts(client, s1)] == [(1, 20), (2, 4)]


def test_deleting_gives_the_attempt_back(setup):
    client, s1, (t1, _, _) = setup
    client.put(f"/api/sessions/{s1}/skills", json={"attempts": {"driver": 1}})
    first = record_attempt(client, s1, t1).json()
    refused = record_attempt(client, s1, t1)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Team 1 has used all 1 Driver attempts."
    assert client.delete(f"/api/skills/attempts/{first['id']}").status_code == 204
    assert record_attempt(client, s1, t1).status_code == 201


def test_a_zero_score_still_uses_an_attempt(setup):
    client, s1, (t1, _, _) = setup
    client.put(f"/api/sessions/{s1}/skills", json={"attempts": {"driver": 1}})
    assert record_attempt(client, s1, t1, objects=0).json()["score"] == 0
    assert record_attempt(client, s1, t1).status_code == 409


def test_lowering_the_allowed_number_keeps_existing_attempts(setup):
    client, s1, (t1, _, _) = setup
    for objects in (1, 2, 3):
        assert record_attempt(client, s1, t1, objects=objects).status_code == 201
    client.put("/api/skills/settings", json={"enabled": True, "attempts": {"driver": 1}})
    assert len(_attempts(client, s1)) == 3
    refused = record_attempt(client, s1, t1)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Team 1 has used all 1 Driver attempts."


def test_everything_is_refused_while_skills_are_off(setup):
    client, s1, (t1, _, _) = setup
    attempt = record_attempt(client, s1, t1).json()
    client.put("/api/skills/settings", json={"enabled": False, "attempts": {}})
    detail = "Skills challenges are turned off for this event."
    for response in (
        record_attempt(client, s1, t1),
        client.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": 1}}),
        client.delete(f"/api/skills/attempts/{attempt['id']}"),
    ):
        assert response.status_code == 409
        assert response.json()["detail"] == detail
    assert len(_attempts(client, s1)) == 1


def test_a_team_must_be_checked_in(setup):
    client, s1, (_, t2, t3) = setup
    refused = record_attempt(client, s1, t3)
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Team 3 is not checked in for this session."
    client.post(f"/api/sessions/{s1}/participants", json={"team_id": t2, "checked_in": False})
    assert record_attempt(client, s1, t2).json()["detail"] == "Team 2 is not checked in for this session."


def test_unknown_type_team_session_and_attempt(setup):
    client, s1, (t1, _, _) = setup
    unknown_type = client.post(
        f"/api/sessions/{s1}/skills/attempts", json={"team_id": t1, "skills_type": "teleop", "data": {}}
    )
    assert unknown_type.status_code == 422
    assert record_attempt(client, s1, 999).status_code == 422
    assert record_attempt(client, 999, t1).status_code == 404
    assert client.get("/api/sessions/999/skills/attempts").status_code == 404
    assert client.put("/api/skills/attempts/999", json={"data": {"objects_scored": 1}}).status_code == 404
    assert client.delete("/api/skills/attempts/999").status_code == 404


def test_scoresheet_violations_are_reported_per_field(setup):
    client, s1, (t1, _, _) = setup
    bad = {"team_id": t1, "skills_type": "driver", "data": {"objects_scored": 31, "extra": 1}}
    response = client.post(f"/api/sessions/{s1}/skills/attempts", json=bad)
    assert response.status_code == 422
    assert response.json() == {
        "detail": "The scoresheet has errors.",
        "violations": [
            {"field": "objects_scored", "message": "Must be at most 30."},
            {"field": "extra", "message": "Unknown field."},
        ],
    }
    assert _attempts(client, s1) == []
    attempt = record_attempt(client, s1, t1).json()
    edit = client.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": True}})
    assert edit.status_code == 422
    assert edit.json()["violations"] == [{"field": "objects_scored", "message": "Must be a whole number."}]


def test_plugin_error_while_scoring_stores_nothing(setup, monkeypatch):
    client, s1, (t1, _, _) = setup
    client.put(f"/api/sessions/{s1}/skills", json={"attempts": {"driver": 1}})
    module = client.app.state.game_plugins["example-game"].module

    def broken(skills_type, scoresheet):
        raise ValueError("boom")

    monkeypatch.setattr(module, "calculate_skills_score", broken)
    response = record_attempt(client, s1, t1)
    assert response.status_code == 422
    assert response.json()["detail"] == "Plugin could not score this scoresheet: boom"
    assert _attempts(client, s1) == []
    monkeypatch.undo()
    assert record_attempt(client, s1, t1).status_code == 201


def test_admin_edit_ignores_check_in_and_the_limit(setup):
    client, s1, (t1, _, _) = setup
    first = record_attempt(client, s1, t1, objects=1).json()
    record_attempt(client, s1, t1, objects=2)
    client.post(f"/api/sessions/{s1}/participants", json={"team_id": t1, "checked_in": False})
    client.put(f"/api/sessions/{s1}/skills", json={"attempts": {"driver": 1}})
    edited = client.put(f"/api/skills/attempts/{first['id']}", json={"data": {"objects_scored": 9}})
    assert edited.status_code == 200, edited.text
    assert (edited.json()["number"], edited.json()["score"]) == (1, 18)


def test_admins_edit_attempts_in_past_sessions(setup):
    client, s1, (t1, t2, _) = setup
    attempt = record_attempt(client, s1, t1).json()
    s2 = create_session(client, "Sunday", checked_in=(t1, t2))
    client.post("/api/event/active-session", json={"session_id": s2})
    assert client.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": 2}}).status_code == 200


def test_scorers_and_referees_record_on_an_admitted_device_only(setup):
    client, s1, (t1, t2, _) = setup
    device = admitted_device_token(client)
    raw = TestClient(client.app)
    for role, team_id in (("scorer", t1), ("referee", t2)):
        headers = {**bearer(login_as(raw, role)), "X-Device-Token": device}
        assert record_attempt(raw, s1, team_id, headers=headers).status_code == 201, role
    scorer = bearer(login_as(raw, "scorer"))
    assert record_attempt(raw, s1, t1, headers=scorer).status_code == 401
    assert record_attempt(raw, s1, t1, headers=bearer(login_as(raw, "attendee"))).status_code == 403


def test_scorers_and_referees_cannot_change_a_submitted_attempt(setup):
    client, s1, (t1, _, _) = setup
    attempt = record_attempt(client, s1, t1).json()
    device = admitted_device_token(client)
    raw = TestClient(client.app)
    detail = "Only an admin can change a submitted skills attempt."
    for role in ("scorer", "referee"):
        headers = {**bearer(login_as(raw, role)), "X-Device-Token": device}
        edit = raw.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": 1}}, headers=headers)
        delete = raw.delete(f"/api/skills/attempts/{attempt['id']}", headers=headers)
        assert (edit.status_code, edit.json()["detail"]) == (403, detail), role
        assert (delete.status_code, delete.json()["detail"]) == (403, detail), role
    attendee = bearer(login_as(raw, "attendee"))
    assert raw.get(f"/api/sessions/{s1}/skills/attempts", headers=attendee).status_code == 200


def test_changes_broadcast_skills_changed_on_both_channels(setup):
    client, s1, (t1, _, _) = setup
    token = admin_token(client)
    with client.websocket_connect(f"/ws/session/{s1}?token={token}") as session_socket, \
            client.websocket_connect(f"/ws/active-session?token={token}") as active_socket:
        attempt = record_attempt(client, s1, t1).json()
        assert next_event(session_socket, "skills_changed")["data"] == {"session_id": s1}
        assert next_event(active_socket, "skills_changed")["data"] == {"session_id": s1}
        client.put(f"/api/skills/attempts/{attempt['id']}", json={"data": {"objects_scored": 1}})
        # Consume the update's event on both sockets so the delete's are fresh.
        assert next_event(session_socket, "skills_changed")["data"] == {"session_id": s1}
        assert next_event(active_socket, "skills_changed")["data"] == {"session_id": s1}
        client.delete(f"/api/skills/attempts/{attempt['id']}")
        assert next_event(session_socket, "skills_changed")["data"] == {"session_id": s1}
        assert next_event(active_socket, "skills_changed")["data"] == {"session_id": s1}
