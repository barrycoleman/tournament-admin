from __future__ import annotations

import pytest
from sqlalchemy import select

from device_helpers import paired_device
from display_helpers import add_field_set, admin_token, setup_event
from skills_helpers import next_event
from tournament_server.models.scoring_draft import ScorerBinding


@pytest.fixture
def event(client):
    session_id = setup_event(client)
    fields = add_field_set(client, session_id)
    other_session = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    other = add_field_set(client, other_session, fields=("Field 9",))
    return {
        "session_id": session_id,
        "fields": fields,
        "other_session": other_session,
        "other": other,
        "scorer": paired_device(client, role="scorer", name="Scorer A"),
    }


def _bind(client, device: dict, field_id: int):
    return client.put("/api/devices/me/binding", json={"field_id": field_id}, headers=device["headers"])


def _binding(client, device: dict):
    response = client.get("/api/devices/me/binding", headers=device["headers"])
    assert response.status_code == 200, response.text
    return response.json()


def _binding_rows(client) -> list[ScorerBinding]:
    with client.app.state.session_factory() as db:
        return list(db.execute(select(ScorerBinding)).scalars().all())


def _events_until(socket, marker: str) -> list[str]:
    """The names of the events received before the next `marker` event."""
    names = []
    while True:
        message = socket.receive_json()
        if message["event"] == marker:
            return names
        names.append(message["event"])


def test_a_scorer_binds_rebinds_and_clears_its_field(client, event):
    scorer = event["scorer"]
    first, second = event["fields"]["field_ids"]
    assert _binding(client, scorer) is None
    bound = _bind(client, scorer, first)
    assert (bound.status_code, bound.json()) == (200, {"field_id": first, "field_name": "Field 1"})
    assert _binding(client, scorer) == {"field_id": first, "field_name": "Field 1"}
    assert _bind(client, scorer, second).json() == {"field_id": second, "field_name": "Field 2"}
    assert [(row.device_id, row.field_id) for row in _binding_rows(client)] == [(scorer["id"], second)]
    assert client.delete("/api/devices/me/binding", headers=scorer["headers"]).status_code == 204
    assert _binding(client, scorer) is None
    assert client.delete("/api/devices/me/binding", headers=scorer["headers"]).status_code == 204


def test_only_a_field_in_the_active_session_can_be_bound(client, event):
    scorer = event["scorer"]
    other_field = event["other"]["field_ids"][0]
    for field_id in (other_field, 999):
        refused = _bind(client, scorer, field_id)
        assert (refused.status_code, refused.json()["detail"]) == (422, "Pick a field in the active session.")
    assert _bind(client, scorer, event["fields"]["field_ids"][0]).status_code == 200
    client.post("/api/event/active-session", json={"session_id": event["other_session"]})
    assert _binding(client, scorer) is None
    assert _bind(client, scorer, other_field).status_code == 200
    assert len(_binding_rows(client)) == 2


def test_only_paired_scorer_and_referee_devices_bind_themselves(client, event):
    first = event["fields"]["field_ids"][0]
    referee = paired_device(client, role="referee")
    assert _bind(client, referee, first).status_code == 200
    for role in ("judge", "display_device"):
        device = paired_device(client, role=role)
        refused = _bind(client, device, first)
        assert (refused.status_code, refused.json()["detail"]) == (
            403,
            "Only a paired scorer or referee device can be bound to a field.",
        )
        assert client.get("/api/devices/me/binding", headers=device["headers"]).status_code == 403
    assert client.put("/api/devices/me/binding", json={"field_id": first}).status_code == 403
    scorer_headers = event["scorer"]["headers"]
    assert client.delete(f"/api/devices/{referee['id']}/binding", headers=scorer_headers).status_code == 403


def test_an_admin_clears_a_devices_binding(client, event):
    scorer = event["scorer"]
    _bind(client, scorer, event["fields"]["field_ids"][0])
    assert client.delete(f"/api/devices/{scorer['id']}/binding").status_code == 204
    assert _binding(client, scorer) is None
    assert client.delete("/api/devices/999/binding").status_code == 404


def test_device_reads_show_the_binding_in_the_active_session(client, event):
    scorer = event["scorer"]
    display = paired_device(client, role="display_device")
    _bind(client, scorer, event["fields"]["field_ids"][0])
    rows = {device["id"]: device for device in client.get("/api/devices").json()}
    assert rows[scorer["id"]]["binding"] == {"field_id": event["fields"]["field_ids"][0], "field_name": "Field 1"}
    assert rows[display["id"]]["binding"] is None
    client.post("/api/event/active-session", json={"session_id": event["other_session"]})
    rows = {device["id"]: device for device in client.get("/api/devices").json()}
    assert rows[scorer["id"]]["binding"] is None


def test_deleting_the_field_clears_the_binding_and_tells_the_device(client, event):
    scorer = event["scorer"]
    second = event["fields"]["field_ids"][1]
    _bind(client, scorer, second)
    with client.websocket_connect(f"/ws/active-session?token={scorer['access_token']}") as socket:
        assert client.delete(f"/api/fields/{second}").status_code == 204
        assert next_event(socket, "scorer_binding_changed")["data"] == {"device_id": scorer["id"]}
    assert _binding(client, scorer) is None


def test_deleting_a_field_set_or_session_clears_its_bindings(client, event):
    scorer = event["scorer"]
    _bind(client, scorer, event["fields"]["field_ids"][0])
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        assert client.delete(f"/api/field-sets/{event['fields']['id']}").status_code == 204
        assert next_event(socket, "scorer_binding_changed")["data"] == {"device_id": scorer["id"]}
    assert _binding_rows(client) == []
    client.post("/api/event/active-session", json={"session_id": event["other_session"]})
    _bind(client, scorer, event["other"]["field_ids"][0])
    client.post("/api/event/active-session", json={"session_id": event["session_id"]})
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        assert client.delete(f"/api/sessions/{event['other_session']}").status_code == 204
        assert next_event(socket, "scorer_binding_changed")["data"] == {"device_id": scorer["id"]}
    assert _binding_rows(client) == []


def test_a_device_that_stops_scoring_loses_its_bindings(client, event):
    scorer = event["scorer"]
    _bind(client, scorer, event["fields"]["field_ids"][0])
    assert client.patch(f"/api/devices/{scorer['id']}", json={"role": "referee"}).status_code == 200
    assert len(_binding_rows(client)) == 1
    assert client.patch(f"/api/devices/{scorer['id']}", json={"role": "judge"}).status_code == 200
    assert _binding_rows(client) == []


def test_binding_changes_go_to_admins_and_that_device_only(client, event):
    scorer = event["scorer"]
    other_scorer = paired_device(client, role="scorer", name="Scorer B")
    first = event["fields"]["field_ids"][0]
    expected = {"device_id": scorer["id"]}
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_socket, \
            client.websocket_connect(f"/ws/active-session?token={scorer['access_token']}") as mine, \
            client.websocket_connect(f"/ws/active-session?token={other_scorer['access_token']}") as theirs:
        _bind(client, scorer, first)
        assert next_event(admin_socket, "scorer_binding_changed")["data"] == expected
        assert next_event(mine, "scorer_binding_changed")["data"] == expected
        client.delete("/api/devices/me/binding", headers=scorer["headers"])
        assert next_event(mine, "scorer_binding_changed")["data"] == expected
        _bind(client, scorer, first)
        client.delete(f"/api/devices/{scorer['id']}/binding")
        assert next_event(admin_socket, "scorer_binding_changed")["data"] == expected
        # A rename reaches every socket: everything the other scorer got before it
        # is what the binding changes sent it, which must be nothing.
        client.patch(f"/api/devices/{other_scorer['id']}", json={"name": "Scorer B2"})
        assert "scorer_binding_changed" not in _events_until(theirs, "devices_changed")
