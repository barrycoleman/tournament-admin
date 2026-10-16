from __future__ import annotations

import pytest

from device_helpers import paired_device
from display_helpers import add_field_set, admin_token, assignments, groups, setup_event
from skills_helpers import next_event
from sqlalchemy import select
from tournament_server.models.event import Event
from tournament_server.models.field_set import FieldSet


@pytest.fixture
def event(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    return {"session_id": session_id, "field_set": field_set}


def _audience(client):
    return groups(client, kind="audience")[0]


def _pit(client, session_id, name="Pit TVs", division_id=None):
    created = client.post(
        "/api/displays/pit-groups", json={"session_id": session_id, "name": name, "division_id": division_id}
    )
    assert created.status_code == 201, created.text
    return created.json()


def test_the_list_shows_groups_in_order_with_their_displays_and_the_unassigned(client, event):
    session_id = event["session_id"]
    pit = _pit(client, session_id)
    tv = paired_device(client, role="display_device", name="Big TV")
    spare = paired_device(client, role="display_device", name="Spare TV")
    paired_device(client, role="scorer", name="Tablet")
    put = client.put(
        "/api/displays/assignments", json={"session_id": session_id, "device_id": tv["id"], "group_id": _audience(client).id}
    )
    assert put.status_code == 200, put.text
    body = client.get(f"/api/displays?session_id={session_id}").json()
    assert body["session_id"] == session_id and body["has_setup"] is True
    assert [(g["kind"], g["name"]) for g in body["groups"]] == [
        ("audience", "Main Fields"), ("field", "Field 1"), ("field", "Field 2"), ("pit", "Pit TVs"),
    ]
    audience = body["groups"][0]
    assert audience["field_set_id"] == event["field_set"]["id"] and audience["screen"] == "logo"
    assert audience["displays"] == [{"device_id": tv["id"], "name": "Big TV", "online": False}]
    assert body["groups"][1]["field_set_id"] == event["field_set"]["id"]
    assert body["groups"][3]["id"] == pit["id"] and body["groups"][3]["screen"] == "teamwork_rankings"
    assert body["unassigned"] == [{"device_id": spare["id"], "name": "Spare TV", "online": False}]


def test_a_display_with_an_open_socket_is_online(client, event):
    tv = paired_device(client, role="display_device", name="Big TV")
    with client.websocket_connect(f"/ws/active-session?token={tv['access_token']}"):
        body = client.get(f"/api/displays?session_id={event['session_id']}").json()
        assert body["unassigned"][0]["online"] is True


def test_pit_groups_need_a_unique_name_and_a_real_division(client, event):
    session_id = event["session_id"]
    _pit(client, session_id, "Hallway")
    duplicate = client.post("/api/displays/pit-groups", json={"session_id": session_id, "name": " hallway "})
    assert duplicate.status_code == 409
    assert client.post("/api/displays/pit-groups", json={"session_id": session_id, "name": "  "}).status_code == 422
    assert client.post("/api/displays/pit-groups", json={"session_id": session_id, "name": "X", "division_id": 999}).status_code == 404
    assert client.post("/api/displays/pit-groups", json={"session_id": 999, "name": "X"}).status_code == 404


def test_patching_screens_is_checked_against_the_registry(client, event):
    audience = _audience(client)
    ok = client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "upcoming_matches"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["screen_settings"] == {"count": 3, "scope": "field_set"}
    changed = client.patch(f"/api/displays/groups/{audience.id}", json={"screen_settings": {"count": 5}})
    assert changed.json()["screen_settings"] == {"count": 5, "scope": "field_set"}
    switched = client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "schedule"})
    assert switched.json()["screen_settings"] == {}
    assert client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "banner"}).status_code == 422
    assert client.patch(f"/api/displays/groups/{audience.id}", json={"rotation": [{"screen": "logo"}]}).status_code == 422
    assert client.patch(f"/api/displays/groups/{audience.id}", json={"name": "X"}).status_code == 422
    assert client.patch(f"/api/displays/groups/{audience.id}", json={"play_sounds": True}).json()["play_sounds"] is True
    field_group = groups(client, kind="field")[0]
    assert client.patch(f"/api/displays/groups/{field_group.id}", json={"screen": "logo"}).status_code == 422


def test_pit_groups_take_rotations_names_and_divisions(client, event):
    pit = _pit(client, event["session_id"])
    patched = client.patch(
        f"/api/displays/groups/{pit['id']}",
        json={"rotation": [{"screen": "teamwork_rankings"}, {"screen": "upcoming_matches", "seconds": 30}], "name": "Pit 1"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["rotation"][1] == {"screen": "upcoming_matches", "settings": {"count": 3, "scope": "division"}, "seconds": 30}
    assert patched.json()["name"] == "Pit 1"
    assert client.patch(f"/api/displays/groups/{pit['id']}", json={"rotation": None}).json()["rotation"] is None
    assert client.patch(f"/api/displays/groups/{pit['id']}", json={"play_sounds": True}).status_code == 422
    assert client.patch(f"/api/displays/groups/{pit['id']}", json={"rotation": [{"screen": "in_match"}]}).status_code == 422
    assert client.patch(f"/api/displays/groups/{pit['id']}", json={"division_id": 999}).status_code == 404


def test_only_pit_groups_can_be_deleted(client, event):
    pit = _pit(client, event["session_id"])
    tv = paired_device(client, role="display_device")
    client.put("/api/displays/assignments", json={"session_id": event["session_id"], "device_id": tv["id"], "group_id": pit["id"]})
    assert client.delete(f"/api/displays/groups/{_audience(client).id}").status_code == 409
    assert client.delete(f"/api/displays/groups/{pit['id']}").status_code == 204
    assert assignments(client) == []


def test_assignments_are_one_per_session_and_only_for_displays(client, event):
    session_id = event["session_id"]
    tv = paired_device(client, role="display_device")
    tablet = paired_device(client, role="scorer")
    pit = _pit(client, session_id)
    put = lambda device, group: client.put(
        "/api/displays/assignments", json={"session_id": session_id, "device_id": device, "group_id": group}
    )
    assert put(tv["id"], _audience(client).id).status_code == 200
    assert put(tv["id"], pit["id"]).status_code == 200
    assert [(a.device_id, a.group_id) for a in assignments(client)] == [(tv["id"], pit["id"])]
    assert put(tablet["id"], pit["id"]).status_code == 422
    other = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    assert client.put(
        "/api/displays/assignments", json={"session_id": other, "device_id": tv["id"], "group_id": pit["id"]}
    ).status_code == 422
    assert put(tv["id"], None).status_code == 200
    assert assignments(client) == []
    assert put(999, pit["id"]).status_code == 404


def test_deleting_a_display_or_changing_its_role_drops_its_assignments(client, event):
    session_id = event["session_id"]
    first = paired_device(client, role="display_device")
    second = paired_device(client, role="display_device")
    for device in (first, second):
        client.put("/api/displays/assignments", json={"session_id": session_id, "device_id": device["id"], "group_id": _audience(client).id})
    client.patch(f"/api/devices/{first['id']}", json={"role": "scorer"})
    client.delete(f"/api/devices/{second['id']}")
    assert assignments(client) == []


def test_the_devices_list_shows_each_displays_group_in_the_active_session(client, event):
    tv = paired_device(client, role="display_device", name="Big TV")
    client.put("/api/displays/assignments", json={"session_id": event["session_id"], "device_id": tv["id"], "group_id": groups(client, kind="field")[1].id})
    rows = {d["name"]: d for d in client.get("/api/devices").json()}
    assert rows["Big TV"]["display_group"] == "Field 2"


def test_me_reports_each_state(client, event):
    session_id = event["session_id"]
    tv = paired_device(client, role="display_device", name="Big TV")
    me = lambda: client.get("/api/displays/me", headers=tv["headers"])
    assert me().json() == {"device": {"id": tv["id"], "name": "Big TV"}, "session_id": session_id, "group": None}
    field_group = groups(client, kind="field")[0]
    client.put("/api/displays/assignments", json={"session_id": session_id, "device_id": tv["id"], "group_id": field_group.id})
    with client.app.state.session_factory() as db:
        db.get(FieldSet, event["field_set"]["id"]).queued_match_id = 42
        db.commit()
    group = me().json()["group"]
    assert group["kind"] == "field" and group["name"] == "Field 1"
    assert group["field_id"] == field_group.field_id and group["field_set_id"] == event["field_set"]["id"]
    assert group["field_set"] == {"queued_match_id": 42, "timeout_deadline": None}
    assert "displays" not in group
    # The active-session endpoint can't clear it (session_id is required), so clear it directly.
    with client.app.state.session_factory() as db:
        db.execute(select(Event)).scalars().first().active_session_id = None
        db.commit()
    assert me().json()["session_id"] is None and me().json()["group"] is None
    assert client.get("/api/displays/me").status_code == 403
    assert client.get("/api/displays/me", headers=paired_device(client, role="scorer")["headers"]).status_code == 403


def test_changes_broadcast_display_changed_and_identify_reaches_only_its_device(client, event):
    session_id = event["session_id"]
    tv = paired_device(client, role="display_device")
    other = paired_device(client, role="display_device")
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_socket:
        audience = _audience(client)
        client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "schedule"})
        assert next_event(admin_socket, "display_changed")["data"] == {"session_id": session_id, "group_id": audience.id}
        client.put("/api/displays/assignments", json={"session_id": session_id, "device_id": tv["id"], "group_id": audience.id})
        assert next_event(admin_socket, "display_changed")["data"] == {"session_id": session_id, "group_id": audience.id}
    with client.websocket_connect(f"/ws/active-session?token={tv['access_token']}") as tv_socket, \
            client.websocket_connect(f"/ws/active-session?token={other['access_token']}") as other_socket:
        assert client.post(f"/api/displays/{tv['id']}/identify").status_code == 204
        assert next_event(tv_socket, "display_identify")["data"] == {"device_id": tv["id"]}
        client.patch(f"/api/displays/groups/{_audience(client).id}", json={"screen": "logo"})
        # The other display sees the next broadcast without an identify before it.
        assert other_socket.receive_json()["event"] == "display_changed"
    assert client.post("/api/displays/999/identify").status_code == 404


def test_only_admins_manage_displays(client, event):
    tv = paired_device(client, role="display_device")
    assert client.get(f"/api/displays?session_id={event['session_id']}", headers=tv["headers"]).status_code == 403
    assert client.post("/api/displays/pit-groups", json={"session_id": event["session_id"], "name": "X"}, headers=tv["headers"]).status_code == 403


def test_has_setup_turns_true_with_a_pit_group_or_an_assignment(client, event):
    session_id = event["session_id"]
    assert client.get(f"/api/displays?session_id={session_id}").json()["has_setup"] is False
    tv = paired_device(client, role="display_device")
    client.put("/api/displays/assignments", json={"session_id": session_id, "device_id": tv["id"], "group_id": _audience(client).id})
    assert client.get(f"/api/displays?session_id={session_id}").json()["has_setup"] is True
    client.put("/api/displays/assignments", json={"session_id": session_id, "device_id": tv["id"], "group_id": None})
    assert client.get(f"/api/displays?session_id={session_id}").json()["has_setup"] is False
    _pit(client, session_id)
    assert client.get(f"/api/displays?session_id={session_id}").json()["has_setup"] is True
