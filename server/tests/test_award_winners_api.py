from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from auth_helpers import bearer, login_as
from award_helpers import create_session, db_session, enter, setup_two_divisions
from tournament_server.models.award import AwardWinner
from tournament_server.models.ranking import Ranking

JUDGED_DIVISION = {"name": "Design Award", "kind": "judged", "scope": "division"}
JUDGED_EVENT = {"name": "Excellence Award", "kind": "judged", "scope": "event"}
CHAMPION = {
    "name": "Teamwork Champion", "kind": "performance", "scope": "division",
    "source": "teamwork_ranking", "basis": "session", "placement": 1,
}


def _create(client, session_id, body):
    response = client.post(f"/api/sessions/{session_id}/awards", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _slot(award_read: dict, division_id):
    return next(s for s in award_read["slots"] if s["division_id"] == division_id)


def test_admin_sets_and_clears_a_judged_winner(client):
    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"], teams["A2"])
    award = _create(client, saturday, JUDGED_DIVISION)

    response = client.put(f"/api/awards/{award['id']}/slots/{first}", json={"team_id": teams["A1"]})
    assert response.status_code == 200, response.text
    assert _slot(response.json(), first)["status"] == "judged"
    replaced = client.put(f"/api/awards/{award['id']}/slots/{first}", json={"team_id": teams["A2"]}).json()
    assert [w["team_id"] for w in _slot(replaced, first)["winners"]] == [teams["A2"]]

    cleared = client.delete(f"/api/awards/{award['id']}/slots/{first}")
    assert cleared.status_code == 200
    assert _slot(cleared.json(), first)["status"] == "judged_pending"


def test_event_slot_accepts_a_team_from_any_division(client):
    _, _, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["B2"])
    award = _create(client, saturday, JUDGED_EVENT)
    response = client.put(f"/api/awards/{award['id']}/slots/event", json={"team_id": teams["B2"]})
    assert response.status_code == 200, response.text
    with db_session(client) as db:
        row = db.execute(select(AwardWinner)).scalars().one()
        assert (row.division_id, row.origin, row.recorded_by) == (None, "judged", "admin")


def test_judged_team_must_be_in_the_division_and_the_session(client):
    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"], teams["B1"])
    award = _create(client, saturday, JUDGED_DIVISION)
    path = f"/api/awards/{award['id']}/slots/{first}"
    assert client.put(path, json={"team_id": teams["B1"]}).status_code == 422  # other division
    assert client.put(path, json={"team_id": teams["A2"]}).status_code == 422  # not in the session
    assert client.put(path, json={"team_id": 9999}).status_code == 422
    assert client.put(path, json={"team_ids": [teams["A1"]], "reason": "x"}).status_code == 422  # wrong body
    assert client.put(path, json={}).status_code == 422


def test_unknown_slots_are_404(client):
    first, second, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"])
    division_award = _create(client, saturday, {**JUDGED_DIVISION, "division_ids": [second]})
    event_award = _create(client, saturday, JUDGED_EVENT)
    assert client.put(f"/api/awards/{division_award['id']}/slots/{first}", json={"team_id": teams["A1"]}).status_code == 404
    assert client.put(f"/api/awards/{division_award['id']}/slots/event", json={"team_id": teams["A1"]}).status_code == 404
    assert client.put(f"/api/awards/{event_award['id']}/slots/{first}", json={"team_id": teams["A1"]}).status_code == 404
    assert client.put(f"/api/awards/{event_award['id']}/slots/abc", json={"team_id": teams["A1"]}).status_code == 404
    assert client.put("/api/awards/999/slots/event", json={"team_id": teams["A1"]}).status_code == 404


def test_override_replaces_the_resolved_teams_and_removing_it_goes_back(client):
    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"], teams["A2"], teams["A3"])
    with db_session(client) as db:
        db.add(Ranking(session_id=saturday, division_id=first, team_id=teams["A1"], rank=1))
        db.commit()
    award = _create(client, saturday, CHAMPION)
    path = f"/api/awards/{award['id']}/slots/{first}"

    response = client.put(path, json={"team_ids": [teams["A3"], teams["A2"]], "reason": "  A1 failed inspection  "})
    assert response.status_code == 200, response.text
    slot = _slot(response.json(), first)
    assert slot["status"] == "overridden"
    assert [w["team_id"] for w in slot["winners"]] == [teams["A3"], teams["A2"]]
    assert slot["override_reason"] == "A1 failed inspection"

    restored = _slot(client.delete(path).json(), first)
    assert (restored["status"], [w["team_id"] for w in restored["winners"]]) == ("resolved", [teams["A1"]])


def test_override_needs_teams_and_a_reason(client):
    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"])
    award = _create(client, saturday, CHAMPION)
    path = f"/api/awards/{award['id']}/slots/{first}"
    for body in (
        {"team_ids": [teams["A1"]]},
        {"team_ids": [teams["A1"]], "reason": "   "},
        {"team_ids": [], "reason": "x"},
        {"team_ids": [teams["A1"], teams["A1"]], "reason": "x"},
        {"team_id": teams["A1"]},
        {"team_ids": [teams["A1"]], "reason": "x" * 501},
    ):
        assert client.put(path, json=body).status_code == 422, body


def test_override_with_one_bad_team_writes_nothing(client):
    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"], teams["B1"])
    award = _create(client, saturday, CHAMPION)
    response = client.put(
        f"/api/awards/{award['id']}/slots/{first}", json={"team_ids": [teams["A1"], teams["B1"]], "reason": "x"}
    )
    assert response.status_code == 422
    with db_session(client) as db:
        assert db.execute(select(AwardWinner)).scalars().all() == []


def test_judge_writes_judged_slots_only(client):
    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"])
    judged = _create(client, saturday, JUDGED_DIVISION)
    champion = _create(client, saturday, CHAMPION)
    raw = TestClient(client.app)
    judge = bearer(login_as(raw, "judge"))

    response = raw.put(f"/api/awards/{judged['id']}/slots/{first}", json={"team_id": teams["A1"]}, headers=judge)
    assert response.status_code == 200, response.text
    with db_session(client) as db:
        assert db.execute(select(AwardWinner.recorded_by)).scalar_one() == "judge"
    assert raw.delete(f"/api/awards/{judged['id']}/slots/{first}", headers=judge).status_code == 200
    assert raw.put(
        f"/api/awards/{champion['id']}/slots/{first}", json={"team_ids": [teams["A1"]], "reason": "x"}, headers=judge
    ).status_code == 403
    assert raw.delete(f"/api/awards/{champion['id']}/slots/{first}", headers=judge).status_code == 403

    for role in ("referee", "scorer"):
        headers = bearer(login_as(raw, role))
        assert raw.put(
            f"/api/awards/{judged['id']}/slots/{first}", json={"team_id": teams["A1"]}, headers=headers
        ).status_code == 403


def test_team_history_lists_this_and_earlier_sessions(client):
    first, _, teams = setup_two_divisions(client)
    friday = create_session(client, "Friday", "2026-10-09")
    saturday = create_session(client, "Saturday", "2026-10-10")
    sunday = create_session(client, "Sunday", "2026-10-11")
    for session_id in (friday, saturday, sunday):
        enter(client, session_id, teams["A1"], teams["A2"])
    friday_award = _create(client, friday, JUDGED_DIVISION)
    client.put(f"/api/awards/{friday_award['id']}/slots/{first}", json={"team_id": teams["A1"]})
    sunday_award = _create(client, sunday, JUDGED_DIVISION)
    client.put(f"/api/awards/{sunday_award['id']}/slots/{first}", json={"team_id": teams["A2"]})
    excellence = _create(client, saturday, {**JUDGED_DIVISION, "name": "Excellence"})
    client.put(f"/api/awards/{excellence['id']}/slots/{first}", json={"team_id": teams["A1"]})
    with db_session(client) as db:
        db.add(Ranking(session_id=saturday, division_id=first, team_id=teams["A2"], rank=1))
        db.commit()
    champion = _create(client, saturday, CHAMPION)

    history = client.get(f"/api/sessions/{saturday}/awards/team-history").json()
    assert history == [
        {"team_id": teams["A1"], "awards": [
            {"award_id": friday_award["id"], "award_name": "Design Award", "kind": "judged",
             "session_id": friday, "session_label": "Friday"},
            {"award_id": excellence["id"], "award_name": "Excellence", "kind": "judged",
             "session_id": saturday, "session_label": "Saturday"},
        ]},
        {"team_id": teams["A2"], "awards": [
            {"award_id": champion["id"], "award_name": "Teamwork Champion",
             "kind": "performance", "session_id": saturday, "session_label": "Saturday"},
        ]},
    ]
    # Sunday's award is later than Saturday, so it is not listed.
    raw = TestClient(client.app)
    judge = bearer(login_as(raw, "judge"))
    assert raw.get(f"/api/sessions/{saturday}/awards/team-history", headers=judge).status_code == 200
    assert client.get("/api/sessions/999/awards/team-history").status_code == 404
