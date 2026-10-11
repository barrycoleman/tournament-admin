from __future__ import annotations

import pytest

from award_helpers import create_session
from skills_helpers import enable_skills
from tournament_server.services.awards import availability_error

JUDGED = {"name": "Excellence Award", "kind": "judged", "scope": "event"}
TEAMWORK = {
    "name": "Teamwork Champion", "kind": "performance", "scope": "division",
    "source": "teamwork_ranking", "basis": "session", "placement": 1,
}
SKILLS_EVENT = {
    "name": "Skills Champion", "kind": "performance", "scope": "event",
    "source": "skills_overall", "basis": "session", "placement": 1,
}
SKILLS_DIVISION = {**SKILLS_EVENT, "scope": "division"}

NEEDS_PLUGIN = "Performance awards need a game plugin."
EVENT_NEEDS_SKILLS = "Event-wide performance awards come from skills challenges, which are off."
SKILLS_OFF = "Skills awards need skills challenges turned on."


@pytest.mark.parametrize(("definition", "plugin", "skills", "expected"), [
    (JUDGED, False, False, None),
    (TEAMWORK, False, False, NEEDS_PLUGIN),
    (SKILLS_EVENT, False, False, NEEDS_PLUGIN),
    (TEAMWORK, True, False, None),
    (SKILLS_EVENT, True, False, EVENT_NEEDS_SKILLS),
    (SKILLS_DIVISION, True, False, SKILLS_OFF),
    ({**SKILLS_DIVISION, "source": "skills_type", "skills_type": "driver"}, True, False, SKILLS_OFF),
    (SKILLS_EVENT, True, True, None),
    (SKILLS_DIVISION, True, True, None),
])
def test_availability_rules(definition, plugin, skills, expected):
    assert availability_error(definition, plugin, skills) == expected


def _event(client, plugin: bool = True) -> int:
    client.post("/api/event", json={"name": "League"})
    if plugin:
        assert client.post("/api/event/game-plugin", json={"name": "example-game"}).status_code == 200
    return create_session(client)


def test_create_refuses_a_performance_award_without_a_plugin(client):
    session_id = _event(client, plugin=False)
    response = client.post(f"/api/sessions/{session_id}/awards", json=TEAMWORK)
    assert response.status_code == 422
    assert response.json()["detail"] == NEEDS_PLUGIN
    assert client.post(f"/api/sessions/{session_id}/awards", json=JUDGED).status_code == 201


def test_create_refuses_skills_awards_while_skills_are_off(client):
    session_id = _event(client)
    event_wide = client.post(f"/api/sessions/{session_id}/awards", json=SKILLS_EVENT)
    assert (event_wide.status_code, event_wide.json()["detail"]) == (422, EVENT_NEEDS_SKILLS)
    division = client.post(f"/api/sessions/{session_id}/awards", json=SKILLS_DIVISION)
    assert (division.status_code, division.json()["detail"]) == (422, SKILLS_OFF)
    assert client.post(f"/api/sessions/{session_id}/awards", json=TEAMWORK).status_code == 201


def test_a_name_only_edit_is_allowed_after_skills_turn_off_but_a_rule_edit_is_not(client):
    session_id = _event(client)
    enable_skills(client)
    award = client.post(f"/api/sessions/{session_id}/awards", json=SKILLS_EVENT).json()
    assert client.put("/api/skills/settings", json={"enabled": False, "attempts": {}}).status_code == 200

    renamed = client.patch(f"/api/awards/{award['id']}", json={"name": "Robot Skills Champion", "description": "Top score"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["source"] == "skills_overall"

    rule_edit = client.patch(f"/api/awards/{award['id']}", json={"placement": 2})
    assert (rule_edit.status_code, rule_edit.json()["detail"]) == (422, EVENT_NEEDS_SKILLS)


def test_copy_keeps_unavailable_awards(client):
    saturday = _event(client)
    enable_skills(client)
    client.post(f"/api/sessions/{saturday}/awards", json=SKILLS_EVENT)
    assert client.put("/api/skills/settings", json={"enabled": False, "attempts": {}}).status_code == 200
    sunday = create_session(client, "Sunday")
    copied = client.post(f"/api/sessions/{sunday}/awards/copy", json={"from_session_id": saturday})
    assert copied.status_code in (200, 201), copied.text
    names = [a["name"] for a in client.get(f"/api/sessions/{sunday}/awards").json()["awards"]]
    assert names == ["Skills Champion"]
