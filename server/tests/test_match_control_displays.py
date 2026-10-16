from __future__ import annotations

import datetime as dt

import pytest

from display_helpers import add_field_set, add_match, add_teams, admin_token, groups, score_match, setup_event
from skills_helpers import next_event
from tournament_server.db import utc_now
from tournament_server.models.display import DisplayGroup


@pytest.fixture
def field(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    teams = add_teams(client)
    matches = [
        add_match(client, session_id, field_set["field_ids"][n % 2], n + 1, teams, minutes=5 * n) for n in range(3)
    ]
    return {"session_id": session_id, "field_set": field_set, "matches": matches, "teams": teams}


def _field_set(client, field_set_id):
    return next(fs for fs in client.get("/api/field-sets").json() if fs["id"] == field_set_id)


def test_field_sets_report_their_override_and_time_out(client, field):
    body = _field_set(client, field["field_set"]["id"])
    assert body["queued_match_id"] is None and body["timeout_deadline"] is None


def test_starting_a_match_moves_the_audience_to_in_match_keeping_its_settings_and_clears_override_and_time_out(client, field):
    fs_id = field["field_set"]["id"]
    first, second, _ = field["matches"]
    client.put(f"/api/field-sets/{fs_id}/queued-match", json={"match_id": second["id"]})
    client.post(f"/api/field-sets/{fs_id}/timeout", json={"seconds": 60})
    audience = groups(client, kind="audience")[0]
    with client.app.state.session_factory() as db:
        db.get(DisplayGroup, audience.id).screen = "upcoming_matches"
        db.get(DisplayGroup, audience.id).screen_settings = {"count": 5}
        db.commit()
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        assert client.post(f"/api/matches/{second['id']}/start").status_code == 200
        assert next_event(socket, "display_changed")["data"] == {"session_id": field["session_id"], "group_id": audience.id}
        assert next_event(socket, "field_set_changed")["data"] == {"field_set_id": fs_id}
    after = groups(client, kind="audience")[0]
    assert (after.screen, after.screen_settings) == ("in_match", {"count": 5})
    body = _field_set(client, fs_id)
    assert body["queued_match_id"] is None and body["timeout_deadline"] is None


def _audience_on_upcoming_then_match_started(client, field):
    audience = groups(client, kind="audience")[0]
    with client.app.state.session_factory() as db:
        db.get(DisplayGroup, audience.id).screen = "upcoming_matches"
        db.get(DisplayGroup, audience.id).screen_settings = {"count": 5}
        db.commit()
    assert client.post(f"/api/matches/{field['matches'][0]['id']}/start").status_code == 200
    return audience


def test_choosing_in_match_after_a_match_start_ignores_the_kept_settings_it_cannot_take(client, field):
    audience = _audience_on_upcoming_then_match_started(client, field)
    response = client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "in_match"})
    assert response.status_code == 200, response.text
    assert response.json()["screen"] == "in_match"


def test_choosing_the_previous_screen_after_a_match_start_restores_its_kept_settings(client, field):
    audience = _audience_on_upcoming_then_match_started(client, field)
    response = client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "upcoming_matches"})
    assert response.status_code == 200, response.text
    assert response.json()["screen_settings"]["count"] == 5


def test_only_one_match_runs_per_field_group(client, field):
    first, second, _ = field["matches"]
    assert client.post(f"/api/matches/{first['id']}/start").status_code == 200
    refused = client.post(f"/api/matches/{second['id']}/start")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Another match is running on this field group."
    other_set = add_field_set(client, field["session_id"], "Side Fields", ("Side 1",))
    elsewhere = add_match(client, field["session_id"], other_set["field_ids"][0], 9, field["teams"])
    assert client.post(f"/api/matches/{elsewhere['id']}/start").status_code == 200
    assert client.post(f"/api/matches/{first['id']}/end").status_code == 200
    assert client.post(f"/api/matches/{second['id']}/start").status_code == 200


def test_a_match_without_a_field_still_starts(client, field):
    loose = add_match(client, field["session_id"], None, 10, field["teams"])
    assert client.post(f"/api/matches/{field['matches'][0]['id']}/start").status_code == 200
    assert client.post(f"/api/matches/{loose['id']}/start").status_code == 200


def test_the_override_must_be_an_unstarted_match_on_this_field_group(client, field):
    fs_id = field["field_set"]["id"]
    first, second, third = field["matches"]
    queue = lambda match_id: client.put(f"/api/field-sets/{fs_id}/queued-match", json={"match_id": match_id})
    assert queue(third["id"]).json()["queued_match_id"] == third["id"]
    assert queue(None).json()["queued_match_id"] is None
    client.post(f"/api/matches/{first['id']}/start")
    assert queue(first["id"]).status_code == 422
    assert queue(999).status_code == 422
    other_set = add_field_set(client, field["session_id"], "Side Fields", ("Side 1",))
    foreign = add_match(client, field["session_id"], other_set["field_ids"][0], 9, field["teams"])
    assert queue(foreign["id"]).status_code == 422
    assert client.put("/api/field-sets/999/queued-match", json={"match_id": None}).status_code == 404


def test_the_override_is_cleared_when_its_match_is_fully_scored(client, field):
    fs_id = field["field_set"]["id"]
    third = field["matches"][2]
    client.put(f"/api/field-sets/{fs_id}/queued-match", json={"match_id": third["id"]})
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        score_match(client, third)
        assert next_event(socket, "field_set_changed")["data"] == {"field_set_id": fs_id}
    assert _field_set(client, fs_id)["queued_match_id"] is None


def test_time_outs_start_restart_and_cancel(client, field):
    fs_id = field["field_set"]["id"]
    before = utc_now()
    started = client.post(f"/api/field-sets/{fs_id}/timeout", json={})
    assert started.status_code == 200
    deadline = dt.datetime.fromisoformat(started.json()["timeout_deadline"])
    assert dt.timedelta(seconds=179) <= deadline - before <= dt.timedelta(seconds=182)
    restarted = client.post(f"/api/field-sets/{fs_id}/timeout", json={"seconds": 10})
    assert dt.datetime.fromisoformat(restarted.json()["timeout_deadline"]) < deadline
    for seconds in (9, 601):
        assert client.post(f"/api/field-sets/{fs_id}/timeout", json={"seconds": seconds}).status_code == 422
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        assert client.delete(f"/api/field-sets/{fs_id}/timeout").status_code == 204
        assert next_event(socket, "field_set_changed")["data"] == {"field_set_id": fs_id}
    assert _field_set(client, fs_id)["timeout_deadline"] is None


def test_only_admins_queue_and_time_out(client, field):
    from device_helpers import paired_device

    scorer = paired_device(client, role="scorer")
    fs_id = field["field_set"]["id"]
    assert client.put(f"/api/field-sets/{fs_id}/queued-match", json={"match_id": None}, headers=scorer["headers"]).status_code == 403
    assert client.post(f"/api/field-sets/{fs_id}/timeout", json={}, headers=scorer["headers"]).status_code == 403
