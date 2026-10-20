"""Field-set purpose (live scoring design §4.1): skills sets get a timer,
purpose changes are guarded, and scheduling, finals, match creation, the
start guard and the audience In Match switch use teamwork sets only."""
from __future__ import annotations

from sqlalchemy import select

from display_helpers import BASE_TIME, add_field_set, add_match, add_teams, admin_token, groups, setup_event
from ranking_helpers import finalize_qualification
from schedule_helpers import schedule, set_playing_windows
from skills_helpers import next_event
from tournament_server.models.field_set import FieldSet
from tournament_server.models.match import Match
from tournament_server.models.scoring_draft import SkillsRun, SkillsSetTimer
from tournament_server.services import displays

SKILLS_SET = "This is a skills field set."


def _skills_set(client, session_id: int, name: str = "Skills", fields=("Skills 1", "Skills 2")) -> dict:
    created = client.post("/api/field-sets", json={"session_id": session_id, "name": name, "purpose": "skills"})
    assert created.status_code == 201, created.text
    assert created.json()["purpose"] == "skills"
    field_ids = []
    for field_name in fields:
        field = client.post(
            "/api/fields", json={"session_id": session_id, "field_set_id": created.json()["id"], "name": field_name}
        )
        assert field.status_code == 201, field.text
        field_ids.append(field.json()["id"])
    return {"id": created.json()["id"], "field_ids": field_ids}


def _timer_set_ids(client) -> list[int]:
    with client.app.state.session_factory() as db:
        return [t.field_set_id for t in db.execute(select(SkillsSetTimer).order_by(SkillsSetTimer.id)).scalars().all()]


def _purpose(client, field_set_id: int) -> str:
    with client.app.state.session_factory() as db:
        return db.get(FieldSet, field_set_id).purpose


def test_a_set_is_teamwork_unless_created_for_skills_and_a_skills_set_gets_a_timer(client):
    session_id = setup_event(client)
    add_field_set(client, session_id)
    skills = _skills_set(client, session_id)
    listed = client.get("/api/field-sets", params={"session_id": session_id}).json()
    assert [(fs["name"], fs["purpose"]) for fs in listed] == [("Main Fields", "teamwork"), ("Skills", "skills")]
    assert _timer_set_ids(client) == [skills["id"]]


def test_an_unknown_or_null_purpose_is_refused(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    bad = client.post("/api/field-sets", json={"session_id": session_id, "name": "Odd", "purpose": "practice"})
    assert bad.status_code == 422
    cleared = client.patch(f"/api/field-sets/{main['id']}", json={"purpose": None})
    assert cleared.status_code == 422
    assert cleared.json()["detail"] == "purpose cannot be null"


def test_changing_the_purpose_creates_and_removes_the_set_timer(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    to_skills = client.patch(f"/api/field-sets/{main['id']}", json={"purpose": "skills"})
    assert to_skills.status_code == 200, to_skills.text
    assert to_skills.json()["purpose"] == "skills"
    assert _timer_set_ids(client) == [main["id"]]
    to_teamwork = client.patch(f"/api/field-sets/{main['id']}", json={"purpose": "teamwork"})
    assert to_teamwork.status_code == 200, to_teamwork.text
    assert _timer_set_ids(client) == []


def test_a_set_with_matches_cannot_become_a_skills_set(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    add_match(client, session_id, main["field_ids"][0], 1, add_teams(client))
    refused = client.patch(f"/api/field-sets/{main['id']}", json={"purpose": "skills"})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "This field set has matches."
    assert _purpose(client, main["id"]) == "teamwork"
    assert _timer_set_ids(client) == []


def test_a_set_with_skills_runs_cannot_become_teamwork(client):
    session_id = setup_event(client)
    skills = _skills_set(client, session_id)
    team_id = add_teams(client, count=1)[0]
    with client.app.state.session_factory() as db:
        db.add(
            SkillsRun(
                field_id=skills["field_ids"][0], field_set_id=skills["id"],
                session_id=session_id, team_id=team_id, skills_type="driver",
            )
        )
        db.commit()
    refused = client.patch(f"/api/field-sets/{skills['id']}", json={"purpose": "teamwork"})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "This field set has skills runs."
    assert _purpose(client, skills["id"]) == "skills"
    assert _timer_set_ids(client) == [skills["id"]]


def test_a_purpose_change_announces_the_field_set(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        client.patch(f"/api/field-sets/{main['id']}", json={"purpose": "skills"})
        assert next_event(socket, "field_set_changed")["data"] == {"field_set_id": main["id"]}


def test_copying_fields_keeps_each_sets_purpose(client):
    session_id = setup_event(client)
    add_field_set(client, session_id)
    _skills_set(client, session_id)
    other = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    copied = client.post(f"/api/sessions/{other}/copy-fields", json={"source_session_id": session_id})
    assert copied.status_code == 201, copied.text
    assert [(fs["name"], fs["purpose"]) for fs in copied.json()] == [("Main Fields", "teamwork"), ("Skills", "skills")]
    copied_skills_id = copied.json()[1]["id"]
    assert copied_skills_id in _timer_set_ids(client)


def test_schedule_generation_uses_teamwork_sets_only(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    skills = _skills_set(client, session_id)
    for team_id in add_teams(client, count=8):
        joined = client.post(f"/api/sessions/{session_id}/participants", json={"team_id": team_id, "checked_in": True})
        assert joined.status_code == 201, joined.text
    set_playing_windows(client, session_id)
    response = schedule(client, session_id, [("qualification", 2)])
    assert response.status_code == 201, response.text
    field_ids = {m["field_id"] for m in client.get("/api/matches", params={"session_id": session_id}).json()}
    assert field_ids and field_ids <= set(main["field_ids"])
    assert not field_ids & set(skills["field_ids"])


def test_a_session_with_only_skills_sets_cannot_be_scheduled(client):
    session_id = setup_event(client)
    _skills_set(client, session_id)
    for team_id in add_teams(client, count=8):
        client.post(f"/api/sessions/{session_id}/participants", json={"team_id": team_id, "checked_in": True})
    set_playing_windows(client, session_id)
    response = schedule(client, session_id, [("qualification", 2)])
    assert response.status_code == 422
    assert response.json()["detail"] == "Session has no unassigned FieldSets configured"


def _ranked_cooperative_session(client) -> tuple[int, int]:
    """A cooperative-game session with a finalized qualification of four
    ranked teams; returns (session id, teamwork field set id)."""
    session_id = setup_event(client, game="cooperative-game")
    main = add_field_set(client, session_id, fields=("Field 1",))
    team_ids = add_teams(client, count=4)
    for index, team_id in enumerate(team_ids):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 1000 + index,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        client.post(
            f"/api/matches/{match['id']}/alliances/{match['alliances'][0]['id']}/score",
            json={"data": {"objects_scored": (4 - index) * 10}},
        )
    finalize_qualification(client, session_id)
    return session_id, main["id"]


def test_finals_pick_the_teamwork_set_when_a_skills_set_exists(cooperative_client):
    client = cooperative_client
    session_id, main_id = _ranked_cooperative_session(client)
    _skills_set(client, session_id)
    started = client.post("/api/finals/start", json={"session_id": session_id, "bracket_size": 2})
    assert started.status_code == 201, started.text
    assert started.json()["field_set_id"] == main_id


def test_finals_refuse_an_explicit_skills_set(cooperative_client):
    client = cooperative_client
    session_id, _ = _ranked_cooperative_session(client)
    skills = _skills_set(client, session_id)
    refused = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2, "field_set_id": skills["id"]}
    )
    assert refused.status_code == 409
    assert refused.json()["detail"] == SKILLS_SET


def test_a_match_on_a_skills_set_cannot_be_created_or_started(client):
    session_id = setup_event(client)
    main = add_field_set(client, session_id)
    team_ids = add_teams(client)
    match = add_match(client, session_id, main["field_ids"][0], 1, team_ids)
    skills = _skills_set(client, session_id)
    created = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": skills["field_ids"][0],
            "scheduled_time": BASE_TIME.isoformat(),
            "alliances": [
                {"station": "red", "team_ids": team_ids[:2]},
                {"station": "blue", "team_ids": team_ids[2:4]},
            ],
        },
    )
    assert created.status_code == 409
    assert created.json()["detail"] == SKILLS_SET
    # A set turned to skills behind the API's back: the start guard still refuses.
    with client.app.state.session_factory() as db:
        db.get(FieldSet, main["id"]).purpose = "skills"
        db.commit()
    refused = client.post(f"/api/matches/{match['id']}/start")
    assert refused.status_code == 409
    assert refused.json()["detail"] == SKILLS_SET
    with client.app.state.session_factory() as db:
        assert db.get(Match, match["id"]).phase == "not_started"


def test_the_audience_in_match_switch_never_fires_for_a_skills_set(client):
    session_id = setup_event(client)
    skills = _skills_set(client, session_id)
    with client.app.state.session_factory() as db:
        assert displays.on_match_started(db, skills["id"]) == []
        db.commit()
    assert groups(client, kind="audience", field_set_id=skills["id"])[0].screen == "logo"
