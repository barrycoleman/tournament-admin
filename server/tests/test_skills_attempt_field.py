"""Skills attempts report the skills field they were scored on."""
from __future__ import annotations

from skills_helpers import create_event, create_session, enable_skills, record_attempt


def _setup(client) -> tuple[int, int]:
    t1, _, _ = create_event(client)
    enable_skills(client)
    session_id = create_session(client, checked_in=(t1,))
    activated = client.post("/api/event/active-session", json={"session_id": session_id})
    assert activated.status_code < 300, activated.text
    return session_id, t1


def _skills_field(client, session_id: int) -> int:
    field_set = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Skills Row", "purpose": "skills"}
    )
    assert field_set.status_code == 201, field_set.text
    field = client.post(
        "/api/fields",
        json={"session_id": session_id, "field_set_id": field_set.json()["id"], "name": "Skills 1"},
    )
    assert field.status_code == 201, field.text
    return field.json()["id"]


def test_an_attempt_recorded_on_the_skills_page_has_no_field(client):
    session_id, t1 = _setup(client)
    created = record_attempt(client, session_id, t1, "driver", objects=3)
    assert created.status_code == 201, created.text
    assert created.json()["field_id"] is None
    listed = client.get(f"/api/sessions/{session_id}/skills/attempts").json()
    assert [attempt["field_id"] for attempt in listed] == [None]


def test_an_attempt_submitted_from_a_run_carries_its_field(client):
    session_id, t1 = _setup(client)
    field_id = _skills_field(client, session_id)
    created = client.post(f"/api/fields/{field_id}/skills-run", json={"team_id": t1})
    assert created.status_code < 300, created.text
    patched = client.patch(
        f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 4, "parked": False}}
    )
    assert patched.status_code == 200, patched.text
    submitted = client.post(f"/api/fields/{field_id}/skills-run/submit", json={})
    assert submitted.status_code < 300, submitted.text

    listed = client.get(f"/api/sessions/{session_id}/skills/attempts").json()
    assert [(attempt["field_id"], attempt["skills_type"], attempt["score"]) for attempt in listed] == [
        (field_id, "autonomous", 8)
    ]
