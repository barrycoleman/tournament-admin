from __future__ import annotations

import datetime as dt
import json

import pytest
from sqlalchemy import select

from device_helpers import paired_device
from skills_helpers import admin_token, next_event
from skills_run_helpers import expire, read_set, run_length, run_on, runs_by_field, skills_event, start_run
from tournament_server.db import utc_now
from tournament_server.models.scoring_draft import SkillsRun, SkillsSetTimer
from tournament_server.services import skills as skills_service


@pytest.fixture
def event(client):
    return skills_event(client, attempts={"autonomous": 1, "driver": 2})


def _set_action(client, event, action: str) -> dict:
    response = client.post(f"/api/field-sets/{event['set']['id']}/skills-timer/{action}")
    assert response.status_code == 200, response.text
    return response.json()


def _field_action(client, field_id: int, action: str) -> dict:
    response = client.post(f"/api/fields/{field_id}/skills-run/{action}")
    assert response.status_code == 200, response.text
    return response.json()


def _submit(client, field_id: int, **body):
    return client.post(f"/api/fields/{field_id}/skills-run/submit", json=body)


def _next_live(socket, field_id: int) -> dict:
    """The next live_score for this field, skipping every other message."""
    while True:
        message = socket.receive_json()
        if message["event"] == "live_score" and message["data"].get("field_id") == field_id:
            return message["data"]


def _within(deadline: str, before: dt.datetime, seconds: int) -> bool:
    gap = dt.datetime.fromisoformat(deadline) - before
    return dt.timedelta(seconds=seconds - 1) <= gap <= dt.timedelta(seconds=seconds + 2)


def test_the_set_timer_moves_every_following_run_at_once(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    start_run(client, second, event["teams"][1])
    before = utc_now()
    started = _set_action(client, event, "start")
    assert started["timer"]["phase"] == "running"
    assert _within(started["timer"]["deadline"], before, run_length(client, "autonomous"))
    for run in runs_by_field(started).values():
        assert (run["phase"], run["paused"], run["follows_set"]) == ("running", False, True)
        assert run["deadline"] == started["timer"]["deadline"]
    paused = _set_action(client, event, "pause")
    assert (paused["timer"]["paused"], paused["timer"]["deadline"]) == (True, None)
    assert paused["timer"]["remaining_seconds"] > 0
    for run in runs_by_field(paused).values():
        assert run["paused"] and run["remaining_seconds"] == paused["timer"]["remaining_seconds"]
    resumed = _set_action(client, event, "resume")
    assert all(run["phase"] == "running" and not run["paused"] for run in runs_by_field(resumed).values())
    ended = _set_action(client, event, "end")
    assert ended["timer"]["phase"] == "ended"
    assert {run["phase"] for run in runs_by_field(ended).values()} == {"ended"}
    reset = _set_action(client, event, "reset")
    assert reset["timer"]["phase"] == "ready"
    assert {run["phase"] for run in runs_by_field(reset).values()} == {"ready"}


def test_the_set_timer_needs_a_following_run_to_start(client, event):
    set_url = f"/api/field-sets/{event['set']['id']}/skills-timer"
    refused = client.post(f"{set_url}/start")
    assert (refused.status_code, refused.json()["detail"]) == (409, "No run is following this field set.")
    start_run(client, event["set"]["field_ids"][0], event["teams"][0], skills_type="driver", follows_set=False)
    assert client.post(f"{set_url}/start").json()["detail"] == "No run is following this field set."
    not_running = client.post(f"{set_url}/pause")
    assert (not_running.status_code, not_running.json()["detail"]) == (409, "The timer is not running.")
    assert client.post(f"{set_url}/jump").status_code == 422


def test_a_field_timer_action_takes_the_field_off_the_set_timer(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    start_run(client, second, event["teams"][1])
    _set_action(client, event, "start")
    alone = _field_action(client, first, "pause")
    assert (alone["follows_set"], alone["phase"], alone["paused"]) == (False, "running", True)
    assert alone["remaining_seconds"] > 0
    runs = runs_by_field(_set_action(client, event, "pause"))
    assert (runs[second]["follows_set"], runs[second]["paused"]) == (True, True)
    runs = runs_by_field(_set_action(client, event, "resume"))
    assert runs[first]["paused"] is True
    assert runs[second]["paused"] is False
    own = _field_action(client, first, "resume")
    assert (own["phase"], own["paused"]) == ("running", False)
    runs = runs_by_field(_set_action(client, event, "end"))
    assert (runs[first]["phase"], runs[second]["phase"]) == ("running", "ended")


def test_a_field_on_its_own_timer_runs_its_own_type(client, event):
    field_id = event["set"]["field_ids"][0]
    start_run(client, field_id, event["teams"][0], skills_type="driver", follows_set=False)
    before = utc_now()
    started = _field_action(client, field_id, "start")
    assert (started["phase"], started["skills_type"]) == ("running", "driver")
    assert _within(started["deadline"], before, run_length(client, "driver"))
    assert read_set(client, event["set"]["id"])["timer"]["phase"] == "ready"
    again = client.post(f"/api/fields/{field_id}/skills-run/start")
    assert (again.status_code, again.json()["detail"]) == (409, "The timer has already started; reset it first.")
    assert _field_action(client, field_id, "end")["phase"] == "ended"
    assert _field_action(client, field_id, "reset")["phase"] == "ready"
    no_run = client.post(f"/api/fields/{event['set']['field_ids'][1]}/skills-run/start")
    assert (no_run.status_code, no_run.json()["detail"]) == (404, "This field has no run.")


def test_the_set_type_changes_only_while_the_set_has_no_runs(client, event):
    field_id = event["set"]["field_ids"][0]
    url = f"/api/field-sets/{event['set']['id']}/skills-timer"
    start_run(client, field_id, event["teams"][0])
    refused = client.put(url, json={"skills_type": "driver"})
    assert (refused.status_code, refused.json()["detail"]) == (409, "Finish or discard this set's runs first.")
    assert client.delete(f"/api/fields/{field_id}/skills-run").status_code == 204
    changed = client.put(url, json={"skills_type": "driver"})
    assert changed.status_code == 200, changed.text
    timer = changed.json()["timer"]
    assert (timer["skills_type"], timer["run_seconds"], timer["phase"]) == ("driver", run_length(client, "driver"), "ready")
    assert start_run(client, field_id, event["teams"][0])["skills_type"] == "driver"
    assert client.put(url, json={"skills_type": "teleop"}).status_code == 422


def test_a_timer_past_its_deadline_reads_as_ended(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    start_run(client, second, event["teams"][1], skills_type="driver", follows_set=False)
    _set_action(client, event, "start")
    _field_action(client, second, "start")
    expire(client, SkillsSetTimer, field_set_id=event["set"]["id"])
    expire(client, SkillsRun, field_id=second)
    body = read_set(client, event["set"]["id"])
    assert (body["timer"]["phase"], body["timer"]["deadline"], body["timer"]["remaining_seconds"]) == ("ended", None, None)
    assert {run["phase"] for run in runs_by_field(body).values()} == {"ended"}
    refused = client.post(f"/api/fields/{second}/skills-run/pause")
    assert (refused.status_code, refused.json()["detail"]) == (409, "The timer is not running.")


def test_a_new_run_after_the_set_ended_starts_the_next_batch(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    _set_action(client, event, "start")
    _set_action(client, event, "end")
    start_run(client, second, event["teams"][1])
    body = read_set(client, event["set"]["id"])
    runs = runs_by_field(body)
    assert (runs[first]["follows_set"], runs[first]["phase"]) == (False, "ended")
    assert (runs[second]["follows_set"], runs[second]["phase"]) == (True, "ready")
    assert body["timer"]["phase"] == "ready"


def test_a_run_created_while_the_set_runs_waits_on_its_own_timer(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    _set_action(client, event, "start")
    late = start_run(client, second, event["teams"][1])
    assert (late["follows_set"], late["phase"], late["skills_type"]) == (False, "ready", "autonomous")


def test_submit_writes_the_attempt_with_its_field_and_ends_the_run(client, event):
    field_id = event["set"]["field_ids"][0]
    team_1 = event["teams"][0]
    start_run(client, field_id, team_1)
    client.patch(f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 5}})
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        submitted = _submit(client, field_id)
        assert submitted.status_code == 200, submitted.text
        attempt = submitted.json()
        assert (attempt["team_id"], attempt["skills_type"], attempt["number"]) == (team_1, "autonomous", 1)
        assert (attempt["score"], attempt["field_id"]) == (10, field_id)
        assert attempt["data"] == {"objects_scored": 5, "parked": False}
        assert next_event(socket, "skills_changed")["data"] == {"session_id": event["session_id"]}
        assert next_event(socket, "skills_run_changed")["data"] == {"field_set_id": event["set"]["id"], "field_id": field_id}
    assert run_on(client, event["set"]["id"], field_id) is None
    listed = client.get(f"/api/sessions/{event['session_id']}/skills/attempts").json()
    assert [(a["team_id"], a["field_id"]) for a in listed] == [(team_1, field_id)]
    again = _submit(client, field_id)
    assert (again.status_code, again.json()["detail"]) == (404, "This field has no run.")


def test_submit_rechecks_the_attempt_limit(client, event):
    first, second = event["set"]["field_ids"]
    team_1 = event["teams"][0]
    # Autonomous allows one attempt; both runs were allowed when created.
    start_run(client, first, team_1)
    start_run(client, second, team_1)
    assert _submit(client, first).status_code == 200
    refused = _submit(client, second)
    assert (refused.status_code, refused.json()["detail"]) == (409, "Team 1 has used all 1 Autonomous attempts.")
    assert run_on(client, event["set"]["id"], second) is not None
    assert len(client.get(f"/api/sessions/{event['session_id']}/skills/attempts").json()) == 1
    assert client.delete(f"/api/fields/{second}/skills-run").status_code == 204


def test_submit_checks_the_scoresheet_unless_forced(client, event):
    field_id = event["set"]["field_ids"][0]
    start_run(client, field_id, event["teams"][0])
    with client.app.state.session_factory() as db:
        run = db.execute(select(SkillsRun)).scalars().one()
        run.data_json = json.dumps({"objects_scored": 31, "parked": False})
        db.commit()
    refused = _submit(client, field_id)
    assert refused.status_code == 422
    assert refused.json()["violations"] == [{"field": "objects_scored", "message": "Must be at most 30."}]
    forced = _submit(client, field_id, force=True)
    assert (forced.status_code, forced.json()["score"]) == (200, 62)


def test_skills_live_scores_follow_the_timer_and_the_switch(client, event):
    first = event["set"]["field_ids"][0]
    start_run(client, first, event["teams"][0])
    draft = f"/api/fields/{first}/skills-run/draft"
    snapshot = f"/api/displays/live-scores?field_set_id={event['set']['id']}"
    assert client.get(snapshot).json()["skills"] == []
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        _set_action(client, event, "start")
        assert _next_live(socket, first) == {"field_id": first, "score": 0}
        client.patch(draft, json={"changes": {"objects_scored": 3}})
        assert _next_live(socket, first) == {"field_id": first, "score": 6}
        assert client.get(snapshot).json()["skills"] == [{"field_id": first, "score": 6}]
        switched = client.patch(f"/api/sessions/{event['session_id']}", json={"live_scores_qualification": False})
        assert switched.status_code == 200, switched.text
        assert _next_live(socket, first) == {"field_id": first, "cleared": True}
        client.patch(draft, json={"changes": {"objects_scored": 4}})
        assert _next_live(socket, first) == {"field_id": first, "cleared": True}
        assert client.get(snapshot).json()["skills"] == []
        _set_action(client, event, "end")
        breakdown = {
            "field_id": first,
            "breakdown": [{"label": "Objects Scored", "value": 4}, {"label": "Robot Parked", "value": False}],
            "score": 8,
        }
        assert _next_live(socket, first) == breakdown
        assert client.get(snapshot).json()["skills"] == [breakdown]
        assert _submit(client, first).status_code == 200
        assert _next_live(socket, first) == {"field_id": first, "cleared": True}
    assert client.get(snapshot).json()["skills"] == []


def test_the_breakdown_goes_out_when_the_timer_runs_out(client, event, monkeypatch):
    monkeypatch.setattr(skills_service, "run_seconds", lambda plugin, skills_type: 1)
    field_id = event["set"]["field_ids"][0]
    start_run(client, field_id, event["teams"][0])
    client.patch(f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 2}})
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        _set_action(client, event, "start")
        assert _next_live(socket, field_id) == {"field_id": field_id, "score": 4}
        expired = _next_live(socket, field_id)
        assert expired["breakdown"][0] == {"label": "Objects Scored", "value": 2}
        assert expired["score"] == 4
    assert read_set(client, event["set"]["id"])["timer"]["phase"] == "ended"


def test_timer_routes_refuse_teamwork_fields_and_sets_and_other_roles(client, event):
    teamwork = event["teamwork"]
    field_id = teamwork["field_ids"][0]
    for response in (
        client.post(f"/api/fields/{field_id}/skills-run/start"),
        _submit(client, field_id),
    ):
        assert (response.status_code, response.json()["detail"]) == (409, "This is not a skills field.")
    for response in (
        client.post(f"/api/field-sets/{teamwork['id']}/skills-timer/start"),
        client.put(f"/api/field-sets/{teamwork['id']}/skills-timer", json={"skills_type": "driver"}),
    ):
        assert (response.status_code, response.json()["detail"]) == (409, "This is not a skills field set.")
    judge = paired_device(client, role="judge")
    skills_set = event["set"]["id"]
    assert client.post(f"/api/field-sets/{skills_set}/skills-timer/start", headers=judge["headers"]).status_code == 403
    scorer = paired_device(client, role="scorer")
    start_run(client, event["set"]["field_ids"][0], event["teams"][0], headers=scorer["headers"])
    started = client.post(f"/api/field-sets/{skills_set}/skills-timer/start", headers=scorer["headers"])
    assert started.status_code == 200, started.text
