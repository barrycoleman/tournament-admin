from __future__ import annotations

import pytest

from device_helpers import paired_device
from display_helpers import add_field_set, admin_token, assignments, groups, setup_event
from skills_helpers import next_event


@pytest.fixture
def league(client):
    saturday = setup_event(client)
    add_field_set(client, saturday, "Main Fields", ("Field 1", "Field 2"))
    sunday = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    return {"saturday": saturday, "sunday": sunday}


def _put(client, session_id, device_id, group_id):
    assert client.put(
        "/api/displays/assignments", json={"session_id": session_id, "device_id": device_id, "group_id": group_id}
    ).status_code == 200


def _copy(client, target, source):
    return client.post(f"/api/sessions/{target}/copy-displays", json={"source_session_id": source})


def test_copy_matches_groups_by_name_and_lists_what_it_cannot_place(client, league):
    saturday, sunday = league["saturday"], league["sunday"]
    # A second division, so the pit group's division survives the copy.
    division = client.post("/api/divisions", json={"name": "Second", "target_team_count": 10}).json()["id"]
    audience = groups(client, session_id=saturday, kind="audience")[0]
    client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "upcoming_matches", "screen_settings": {"count": 5}, "play_sounds": True})
    pit = client.post("/api/displays/pit-groups", json={"session_id": saturday, "name": "Pits", "division_id": division}).json()
    client.patch(f"/api/displays/groups/{pit['id']}", json={"rotation": [{"screen": "schedule"}, {"screen": "logo", "seconds": 10}]})
    big, field_two, pit_tv, scorer = (paired_device(client, role="display_device", name=n) for n in ("Big", "F2", "Pit", "Was display"))
    field_groups = groups(client, session_id=saturday, kind="field")
    _put(client, saturday, big["id"], audience.id)
    _put(client, saturday, field_two["id"], field_groups[1].id)
    _put(client, saturday, pit_tv["id"], pit["id"])
    _put(client, saturday, scorer["id"], field_groups[0].id)
    client.patch(f"/api/devices/{scorer['id']}", json={"role": "scorer"})  # drops its assignment
    # Sunday's venue has the same field set but only a "Field 1".
    add_field_set(client, sunday, "Main Fields", ("Field 1",))
    unplaced_tv = paired_device(client, role="display_device", name="Lost")
    _put(client, saturday, unplaced_tv["id"], field_groups[0].id)
    client.patch(f"/api/fields/{groups(client, session_id=sunday, kind='field')[0].field_id}", json={"name": "Field A"})

    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        copied = _copy(client, sunday, saturday)
        assert copied.status_code == 201, copied.text
        assert next_event(socket, "display_changed")["data"] == {"session_id": sunday, "group_id": None}
    assert sorted(copied.json()["unplaced"], key=lambda u: u["device_name"]) == [
        {"device_id": field_two["id"], "device_name": "F2", "source_group_name": "Field 2"},
        {"device_id": unplaced_tv["id"], "device_name": "Lost", "source_group_name": "Field 1"},
    ]
    sunday_audience = groups(client, session_id=sunday, kind="audience")[0]
    assert (sunday_audience.screen, sunday_audience.screen_settings, sunday_audience.play_sounds) == (
        "upcoming_matches", {"count": 5, "scope": "field_set"}, True,
    )
    sunday_pit = groups(client, session_id=sunday, kind="pit")[0]
    assert (sunday_pit.name, sunday_pit.division_id, sunday_pit.rotation) == ("Pits", division, [
        {"screen": "schedule", "settings": {}, "seconds": 20}, {"screen": "logo", "settings": {}, "seconds": 10},
    ])
    placed = {(a.device_id, a.group_id) for a in assignments(client) if a.session_id == sunday}
    assert placed == {(big["id"], sunday_audience.id), (pit_tv["id"], sunday_pit.id)}


def test_copied_pit_group_has_no_division_when_the_event_has_only_one(client, league):
    saturday, sunday = league["saturday"], league["sunday"]
    only_division = client.get("/api/divisions").json()[0]["id"]
    assert len(client.get("/api/divisions").json()) == 1
    client.post("/api/displays/pit-groups", json={"session_id": saturday, "name": "Pits", "division_id": only_division})
    assert _copy(client, sunday, saturday).status_code == 201
    sunday_pit = groups(client, session_id=sunday, kind="pit")[0]
    assert (sunday_pit.name, sunday_pit.division_id) == ("Pits", None)


def test_copy_is_refused_when_the_target_is_set_up_or_the_source_is_not(client, league):
    saturday, sunday = league["saturday"], league["sunday"]
    assert _copy(client, sunday, saturday).status_code == 422  # nothing set up on Saturday
    client.post("/api/displays/pit-groups", json={"session_id": saturday, "name": "Pits"})
    assert _copy(client, saturday, saturday).status_code == 422
    assert _copy(client, 999, saturday).status_code == 404
    assert _copy(client, sunday, 999).status_code == 404
    client.post("/api/displays/pit-groups", json={"session_id": sunday, "name": "Own"})
    assert _copy(client, sunday, saturday).status_code == 409
