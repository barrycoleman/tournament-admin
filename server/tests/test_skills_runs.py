from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from auth_helpers import bearer, login_as
from device_helpers import paired_device
from skills_helpers import admin_token, create_event, create_session, next_event, record_attempt
from skills_run_helpers import add_set, read_set, run_length, run_on, skills_event, start_run
from tournament_server.models.scoring_draft import SkillsRun


@pytest.fixture
def event(client):
    return skills_event(client, attempts={"autonomous": 1, "driver": 2})


def test_a_new_run_follows_the_set_with_the_sets_type(client, event):
    field_id = event["set"]["field_ids"][0]
    run = start_run(client, field_id, event["teams"][0])
    assert (run["field_id"], run["field_set_id"]) == (field_id, event["set"]["id"])
    assert (run["team_id"], run["team_number"], run["team_name"]) == (event["teams"][0], "1", "Team 1")
    assert (run["skills_type"], run["follows_set"], run["phase"], run["deadline"]) == ("autonomous", True, "ready", None)
    assert (run["data"], run["item_meta"], run["version"], run["score"]) == ({}, {}, 0, 0)
    body = read_set(client, event["set"]["id"])
    timer = body["timer"]
    assert (timer["field_set_id"], timer["skills_type"], timer["phase"]) == (event["set"]["id"], "autonomous", "ready")
    assert timer["run_seconds"] == run_length(client, "autonomous")
    assert [(f["name"], f["run"] is not None) for f in body["fields"]] == [("Skills 1", True), ("Skills 2", False)]
    assert body["fields"][0]["run"]["id"] == run["id"]


def test_a_run_needs_a_checked_in_team_with_attempts_left_and_a_free_field(client, event):
    first, second = event["set"]["field_ids"]
    team_1, team_2, team_3 = event["teams"]
    url = f"/api/fields/{first}/skills-run"
    refused = client.post(url, json={"team_id": team_3})
    assert (refused.status_code, refused.json()["detail"]) == (409, "Team 3 is not checked in for this session.")
    assert record_attempt(client, event["session_id"], team_1, "autonomous").status_code == 201
    refused = client.post(url, json={"team_id": team_1})
    assert (refused.status_code, refused.json()["detail"]) == (409, "Team 1 has used all 1 Autonomous attempts.")
    start_run(client, first, team_2)
    refused = client.post(url, json={"team_id": team_2, "skills_type": "driver", "follows_set": False})
    assert (refused.status_code, refused.json()["detail"]) == (409, "This field already has a run.")
    assert client.post(f"/api/fields/{second}/skills-run", json={"team_id": 999}).status_code == 422
    unknown_type = client.post(
        f"/api/fields/{second}/skills-run", json={"team_id": team_2, "skills_type": "teleop", "follows_set": False}
    )
    assert unknown_type.status_code == 422


def test_no_run_while_skills_are_off(client):
    teams = create_event(client)
    session_id = create_session(client, checked_in=teams)
    field_id = add_set(client, session_id, "Skills Row A")["field_ids"][0]
    refused = client.post(f"/api/fields/{field_id}/skills-run", json={"team_id": teams[0]})
    assert (refused.status_code, refused.json()["detail"]) == (409, "Skills challenges are turned off for this event.")


def test_another_type_needs_the_run_on_its_own_timer(client, event):
    field_id = event["set"]["field_ids"][0]
    refused = client.post(
        f"/api/fields/{field_id}/skills-run", json={"team_id": event["teams"][0], "skills_type": "driver"}
    )
    assert (refused.status_code, refused.json()["detail"]) == (409, "A run following the set uses the set's skills type.")
    run = start_run(client, field_id, event["teams"][0], skills_type="driver", follows_set=False)
    assert (run["skills_type"], run["follows_set"], run["phase"]) == ("driver", False, "ready")


def test_teamwork_fields_and_sets_refuse_skills_runs(client, event):
    teamwork_field = event["teamwork"]["field_ids"][0]
    refused = client.post(f"/api/fields/{teamwork_field}/skills-run", json={"team_id": event["teams"][0]})
    assert (refused.status_code, refused.json()["detail"]) == (409, "This is not a skills field.")
    patched = client.patch(f"/api/fields/{teamwork_field}/skills-run/draft", json={"changes": {}})
    assert (patched.status_code, patched.json()["detail"]) == (409, "This is not a skills field.")
    deleted = client.delete(f"/api/fields/{teamwork_field}/skills-run")
    assert (deleted.status_code, deleted.json()["detail"]) == (409, "This is not a skills field.")
    read = client.get(f"/api/field-sets/{event['teamwork']['id']}/skills")
    assert (read.status_code, read.json()["detail"]) == (409, "This is not a skills field set.")
    assert client.post("/api/fields/999/skills-run", json={"team_id": event["teams"][0]}).status_code == 404
    assert client.get("/api/field-sets/999/skills").status_code == 404


def test_draft_changes_merge_item_by_item(client, event):
    field_id = event["set"]["field_ids"][0]
    scorer = paired_device(client, role="scorer", name="Scorer A")
    start_run(client, field_id, event["teams"][0], headers=scorer["headers"])
    url = f"/api/fields/{field_id}/skills-run/draft"
    first = client.patch(url, json={"changes": {"objects_scored": 3}}, headers=scorer["headers"])
    assert first.status_code == 200, first.text
    body = first.json()
    assert (body["data"], body["version"], body["score"]) == ({"objects_scored": 3}, 1, 6)
    assert body["item_meta"]["objects_scored"]["device_name"] == "Scorer A"
    second = client.patch(url, json={"changes": {"parked": True}}).json()
    assert (second["data"], second["version"], second["score"]) == ({"objects_scored": 3, "parked": True}, 2, 10)
    assert second["item_meta"]["objects_scored"]["device_name"] == "Scorer A"
    assert second["item_meta"]["parked"]["device_name"] == "Admin"
    third = client.patch(url, json={"changes": {"objects_scored": 4}}).json()
    assert (third["data"]["objects_scored"], third["version"]) == (4, 3)
    assert third["item_meta"]["objects_scored"]["device_name"] == "Admin"
    assert run_on(client, event["set"]["id"], field_id)["data"] == {"objects_scored": 4, "parked": True}


def test_bad_draft_items_are_refused_and_nothing_is_applied(client, event):
    first, second = event["set"]["field_ids"]
    start_run(client, first, event["teams"][0])
    url = f"/api/fields/{first}/skills-run/draft"
    refused = client.patch(url, json={"changes": {"objects_scored": 31, "parked": True}})
    assert refused.status_code == 422
    assert refused.json()["violations"] == [{"field": "objects_scored", "message": "Must be at most 30."}]
    unknown = client.patch(url, json={"changes": {"bogus": 1}})
    assert unknown.json()["violations"] == [{"field": "bogus", "message": "Unknown field."}]
    wrong_type = client.patch(url, json={"changes": {"parked": 1}})
    assert wrong_type.json()["violations"] == [{"field": "parked", "message": "Must be true or false."}]
    assert client.patch(url, json={"changes": {}, "teams": []}).status_code == 422
    run = run_on(client, event["set"]["id"], first)
    assert (run["data"], run["version"]) == ({}, 0)
    missing = client.patch(f"/api/fields/{second}/skills-run/draft", json={"changes": {}})
    assert (missing.status_code, missing.json()["detail"]) == (404, "This field has no run.")


def test_discarding_a_run_uses_no_attempt(client, event):
    field_id = event["set"]["field_ids"][0]
    team_1 = event["teams"][0]
    start_run(client, field_id, team_1)
    client.patch(f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 5}})
    assert client.delete(f"/api/fields/{field_id}/skills-run").status_code == 204
    assert run_on(client, event["set"]["id"], field_id) is None
    assert client.get(f"/api/sessions/{event['session_id']}/skills/attempts").json() == []
    # Autonomous allows one attempt, and the discarded run didn't use it.
    assert start_run(client, field_id, team_1)["version"] == 0
    assert client.delete(f"/api/fields/{event['set']['field_ids'][1]}/skills-run").status_code == 404


def test_paired_scorers_and_referees_run_skills_and_any_role_reads(client, event):
    field_id = event["set"]["field_ids"][0]
    url = f"/api/fields/{field_id}/skills-run"
    judge = paired_device(client, role="judge")
    assert client.post(url, json={"team_id": event["teams"][0]}, headers=judge["headers"]).status_code == 403
    unpaired = bearer(login_as(TestClient(client.app), "scorer"))
    refused = client.post(url, json={"team_id": event["teams"][0]}, headers=unpaired)
    assert (refused.status_code, refused.json()["detail"]) == (403, "Only a paired device can submit scores.")
    referee = paired_device(client, role="referee")
    start_run(client, field_id, event["teams"][0], headers=referee["headers"])
    display = paired_device(client, role="display_device")
    assert client.get(f"/api/field-sets/{event['set']['id']}/skills", headers=display["headers"]).status_code == 200
    assert client.delete(url, headers=display["headers"]).status_code == 403


def test_run_changes_are_announced_to_scorers_admins_and_displays(client, event):
    field_id = event["set"]["field_ids"][0]
    display = paired_device(client, role="display_device")
    expected = {"field_set_id": event["set"]["id"], "field_id": field_id}
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_socket, \
            client.websocket_connect(f"/ws/active-session?token={display['access_token']}") as display_socket:
        start_run(client, field_id, event["teams"][0])
        assert next_event(admin_socket, "skills_run_changed")["data"] == expected
        assert next_event(display_socket, "skills_run_changed")["data"] == expected
        client.patch(f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"objects_scored": 1}})
        assert next_event(admin_socket, "skills_run_changed")["data"] == expected
        client.delete(f"/api/fields/{field_id}/skills-run")
        assert next_event(admin_socket, "skills_run_changed")["data"] == expected


def test_deleting_a_field_deletes_its_run(client, event):
    field_id = event["set"]["field_ids"][1]
    start_run(client, field_id, event["teams"][0])
    assert client.delete(f"/api/fields/{field_id}").status_code == 204
    with client.app.state.session_factory() as db:
        assert db.execute(select(SkillsRun)).scalars().all() == []


def test_concurrent_run_patches_never_lose_a_change(client, event):
    from concurrent.futures import ThreadPoolExecutor

    field_id = event["set"]["field_ids"][0]
    start_run(client, field_id, event["teams"][0])
    url = f"/api/fields/{field_id}/skills-run/draft"
    changes = [{"objects_scored": n % 30} if n % 2 else {"parked": bool(n % 4)} for n in range(40)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda change: client.patch(url, json={"changes": change}), changes))
    assert [response.status_code for response in responses] == [200] * len(changes)
    assert sorted(response.json()["version"] for response in responses) == list(range(1, len(changes) + 1))
    run = run_on(client, event["set"]["id"], field_id)
    assert run["version"] == len(changes)
    assert set(run["data"]) == {"objects_scored", "parked"}
    assert set(run["item_meta"]) == {"objects_scored", "parked"}


def test_a_patch_after_a_discard_gets_no_run(client, event):
    field_id = event["set"]["field_ids"][0]
    start_run(client, field_id, event["teams"][0])
    assert client.delete(f"/api/fields/{field_id}/skills-run").status_code == 204
    refused = client.patch(f"/api/fields/{field_id}/skills-run/draft", json={"changes": {"parked": True}})
    assert (refused.status_code, refused.json()["detail"]) == (404, "This field has no run.")
