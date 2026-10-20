"""The two live-score switches on a session (live scoring design §4.1, §7)."""
from __future__ import annotations

import inspect

from tournament_server.services import live_scores


def _event(client) -> None:
    client.post("/api/event", json={"name": "Switch Event"})


def test_a_new_session_shows_qualification_scores_and_hides_finals_scores(client):
    _event(client)
    created = client.post("/api/sessions", json={"label": "Saturday"})
    assert created.status_code == 201
    assert (created.json()["live_scores_qualification"], created.json()["live_scores_finals"]) == (True, False)
    listed = client.get("/api/sessions").json()[0]
    assert (listed["live_scores_qualification"], listed["live_scores_finals"]) == (True, False)


def test_a_session_can_be_created_with_its_switches(client):
    _event(client)
    created = client.post(
        "/api/sessions", json={"label": "Sunday", "live_scores_qualification": False, "live_scores_finals": True}
    ).json()
    assert (created["live_scores_qualification"], created["live_scores_finals"]) == (False, True)


def test_the_switches_are_updated_alone_and_never_nulled(client):
    _event(client)
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    updated = client.patch(f"/api/sessions/{session_id}", json={"live_scores_finals": True})
    assert updated.status_code == 200
    assert (updated.json()["live_scores_qualification"], updated.json()["live_scores_finals"]) == (True, True)
    assert updated.json()["label"] == "Saturday"
    refused = client.patch(f"/api/sessions/{session_id}", json={"live_scores_qualification": None})
    assert refused.status_code == 422
    assert refused.json()["detail"] == "live_scores_qualification cannot be null"


def test_only_a_real_switch_change_re_evaluates_live_scores(client, monkeypatch):
    calls = []
    monkeypatch.setattr(live_scores, "on_switches_changed", lambda app, db, session_id: calls.append(session_id))
    _event(client)
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    client.patch(f"/api/sessions/{session_id}", json={"label": "Renamed"})
    client.patch(f"/api/sessions/{session_id}", json={"live_scores_qualification": True})
    assert calls == []
    client.patch(f"/api/sessions/{session_id}", json={"live_scores_finals": True})
    client.patch(f"/api/sessions/{session_id}", json={"live_scores_qualification": False, "live_scores_finals": True})
    assert calls == [session_id, session_id]


def test_the_live_scores_hooks_exist_with_their_final_signatures():
    expected = {
        "on_switches_changed": ["app", "db", "session_id"],
        "on_draft_changed": ["app", "db", "match"],
        "on_match_phase_changed": ["app", "db", "match"],
        "on_skills_changed": ["app", "db", "field_set_id"],
    }
    # Signatures only: Tasks 7 and 10 replace the no-op bodies, and this test
    # keeps running after them.
    for name, params in expected.items():
        assert list(inspect.signature(getattr(live_scores, name)).parameters) == params
