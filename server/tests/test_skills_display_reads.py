"""A display device reads a skills field set and the live scores it may show."""
from __future__ import annotations

from device_helpers import paired_device
from skills_helpers import create_event, create_session, enable_skills


def test_a_display_reads_a_skills_set_and_its_live_scores(client):
    t1, _, _ = create_event(client)
    enable_skills(client)
    session_id = create_session(client, checked_in=(t1,))
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code < 300
    field_set = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Skills Row", "purpose": "skills"}
    ).json()
    field = client.post(
        "/api/fields", json={"session_id": session_id, "field_set_id": field_set["id"], "name": "Skills 1"}
    ).json()
    display = paired_device(client, role="display_device", name="Skills TV")

    read = client.get(f"/api/field-sets/{field_set['id']}/skills", headers=display["headers"])
    assert read.status_code == 200, read.text
    assert [(row["field_id"], row["name"], row["run"]) for row in read.json()["fields"]] == [
        (field["id"], "Skills 1", None)
    ]

    live = client.get(f"/api/displays/live-scores?field_set_id={field_set['id']}", headers=display["headers"])
    assert live.status_code == 200, live.text
    assert live.json() == {"matches": [], "skills": []}
