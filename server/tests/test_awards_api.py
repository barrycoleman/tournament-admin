from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from award_helpers import create_session, db_session, enter, setup_two_divisions
from skills_helpers import next_event
from tournament_server.models.award import AwardWinner
from tournament_server.models.ranking import Ranking

JUDGED = {"name": "Excellence Award", "kind": "judged", "scope": "event"}
CHAMPION = {
    "name": "Teamwork Champion", "kind": "performance", "scope": "division",
    "source": "teamwork_ranking", "basis": "session", "placement": 1,
}


def _create(client, session_id, body):
    response = client.post(f"/api/sessions/{session_id}/awards", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def test_create_and_list_awards_in_order_with_slots(client):
    first, second, teams = setup_two_divisions(client)
    saturday = create_session(client)
    with db_session(client) as db:
        db.add(Ranking(session_id=saturday, division_id=first, team_id=teams["A2"], rank=1))
        db.commit()

    excellence = _create(client, saturday, {**JUDGED, "description": "  The top all-round team  "})
    champion = _create(client, saturday, CHAMPION)

    body = client.get(f"/api/sessions/{saturday}/awards").json()
    assert body["awards_finalized_at"] is None
    assert [a["id"] for a in body["awards"]] == [excellence["id"], champion["id"]]
    assert [a["position"] for a in body["awards"]] == [0, 1]
    assert body["awards"][0]["description"] == "The top all-round team"
    assert body["awards"][0]["slots"] == [{
        "division_id": None, "division_name": None, "status": "judged_pending", "winners": [],
        "override_reason": None, "note": None, "moved_team_ids": [],
    }]
    slots = body["awards"][1]["slots"]
    assert [(s["division_id"], s["division_name"], s["status"]) for s in slots] == [
        (first, "Division 1", "resolved"), (second, "Division 2", "no_result"),
    ]
    assert slots[0]["winners"] == [
        {"team_id": teams["A2"], "number": "A2", "name": "Team A2", "organization": None}
    ]


def test_a_division_list_limits_the_slots(client):
    first, second, _ = setup_two_divisions(client)
    saturday = create_session(client)
    award = _create(client, saturday, {**CHAMPION, "division_ids": [second]})
    assert [s["division_id"] for s in award["slots"]] == [second]


@pytest.mark.parametrize("body", [
    {**JUDGED, "name": "   "},
    {**JUDGED, "name": "x" * 201},
    {**JUDGED, "description": "x" * 2001},
    {**JUDGED, "source": "finals"},
    {**JUDGED, "placement": 1},
    {**CHAMPION, "placement": 0},
    {**CHAMPION, "basis": None},
    {**CHAMPION, "source": "podium"},
    {**CHAMPION, "scope": "event"},
    {**CHAMPION, "source": "finals", "basis": "season"},
    {**CHAMPION, "source": "skills_type"},
    {**CHAMPION, "source": "skills_overall", "skills_type": "driver"},
    {**JUDGED, "division_ids": [1]},
    {**CHAMPION, "division_ids": [999]},
    {**JUDGED, "kind": "random"},
    {**JUDGED, "scope": "galaxy"},
    {**JUDGED, "colour": "gold"},
])
def test_invalid_definitions_are_422(client, body):
    setup_two_divisions(client)
    saturday = create_session(client)
    response = client.post(f"/api/sessions/{saturday}/awards", json=body)
    assert response.status_code == 422, body
    assert client.get(f"/api/sessions/{saturday}/awards").json()["awards"] == []


def test_unknown_session_is_404(client):
    setup_two_divisions(client)
    assert client.post("/api/sessions/999/awards", json=JUDGED).status_code == 404
    assert client.get("/api/sessions/999/awards").status_code == 404


def test_patch_merges_and_rule_changes_clear_winners_but_name_changes_keep_them(client):
    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"])
    award = _create(client, saturday, {**JUDGED, "scope": "division"})
    with db_session(client) as db:
        db.add(AwardWinner(award_id=award["id"], division_id=first, team_id=teams["A1"], origin="judged", recorded_by="admin"))
        db.commit()

    renamed = client.patch(f"/api/awards/{award['id']}", json={"name": "Design Award", "description": "Best design"})
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["name"] == "Design Award"
    assert renamed.json()["slots"][0]["status"] == "judged"

    unchanged_rule = client.patch(f"/api/awards/{award['id']}", json={"scope": "division"})
    assert unchanged_rule.json()["slots"][0]["status"] == "judged"

    changed = client.patch(f"/api/awards/{award['id']}", json={"division_ids": [first]})
    assert changed.json()["slots"][0]["status"] == "judged_pending"


def test_patch_validates_the_merged_award(client):
    setup_two_divisions(client)
    saturday = create_session(client)
    award = _create(client, saturday, CHAMPION)
    assert client.patch(f"/api/awards/{award['id']}", json={"scope": "event"}).status_code == 422
    assert client.patch("/api/awards/999", json={"name": "X"}).status_code == 404


def test_patch_refuses_an_explicit_null_division_list_and_omission_keeps_it(client):
    first, _, _ = setup_two_divisions(client)
    saturday = create_session(client)
    award = _create(client, saturday, {**CHAMPION, "division_ids": [first]})
    response = client.patch(f"/api/awards/{award['id']}", json={"division_ids": None})
    assert response.status_code == 422, response.text
    kept = client.patch(f"/api/awards/{award['id']}", json={"name": "Renamed"})
    assert kept.status_code == 200, kept.text
    assert kept.json()["division_ids"] == [first]


def test_delete_closes_the_position_gap(client):
    setup_two_divisions(client)
    saturday = create_session(client)
    a, b, c = (_create(client, saturday, {**JUDGED, "name": n}) for n in ("A", "B", "C"))
    assert client.delete(f"/api/awards/{b['id']}").status_code == 204
    awards = client.get(f"/api/sessions/{saturday}/awards").json()["awards"]
    assert [(x["id"], x["position"]) for x in awards] == [(a["id"], 0), (c["id"], 1)]


def test_order_rewrites_positions(client):
    setup_two_divisions(client)
    saturday = create_session(client)
    a, b, c = (_create(client, saturday, {**JUDGED, "name": n}) for n in ("A", "B", "C"))
    response = client.put(f"/api/sessions/{saturday}/awards/order", json={"award_ids": [c["id"], a["id"], b["id"]]})
    assert response.status_code == 200, response.text
    assert [x["name"] for x in response.json()["awards"]] == ["C", "A", "B"]


def test_order_must_list_exactly_the_sessions_awards(client):
    setup_two_divisions(client)
    saturday = create_session(client)
    a, b = (_create(client, saturday, {**JUDGED, "name": n}) for n in ("A", "B"))
    for ids in ([a["id"]], [b["id"], a["id"], a["id"]], [b["id"], 999]):
        response = client.put(f"/api/sessions/{saturday}/awards/order", json={"award_ids": ids})
        assert response.status_code == 422, ids
    assert [x["name"] for x in client.get(f"/api/sessions/{saturday}/awards").json()["awards"]] == ["A", "B"]


def test_copy_appends_definitions_without_winners(client):
    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client, "Saturday")
    sunday = create_session(client, "Sunday")
    enter(client, saturday, teams["A1"])
    source = _create(client, saturday, {**JUDGED, "scope": "division", "description": "D"})
    _create(client, saturday, CHAMPION)
    _create(client, sunday, {**JUDGED, "name": "Already here"})
    with db_session(client) as db:
        db.add(AwardWinner(award_id=source["id"], division_id=first, team_id=teams["A1"], origin="judged", recorded_by="admin"))
        db.commit()

    response = client.post(f"/api/sessions/{sunday}/awards/copy", json={"from_session_id": saturday})
    assert response.status_code == 200, response.text
    awards = response.json()["awards"]
    assert [(a["name"], a["position"], a["description"]) for a in awards] == [
        ("Already here", 0, None), ("Excellence Award", 1, "D"), ("Teamwork Champion", 2, None),
    ]
    assert awards[1]["slots"][0]["status"] == "judged_pending"
    assert client.post(f"/api/sessions/{sunday}/awards/copy", json={"from_session_id": sunday}).status_code == 422
    assert client.post(f"/api/sessions/{sunday}/awards/copy", json={"from_session_id": 999}).status_code == 404


def test_definition_writes_are_admin_only_and_reads_are_open(client):
    setup_two_divisions(client)
    saturday = create_session(client)
    award = _create(client, saturday, JUDGED)
    raw = TestClient(client.app)
    for role in ("judge", "referee", "scorer"):
        headers = bearer(login_as(raw, role))
        assert raw.get(f"/api/sessions/{saturday}/awards", headers=headers).status_code == 200
        assert raw.post(f"/api/sessions/{saturday}/awards", json=JUDGED, headers=headers).status_code == 403
        assert raw.patch(f"/api/awards/{award['id']}", json={"name": "X"}, headers=headers).status_code == 403
        assert raw.delete(f"/api/awards/{award['id']}", headers=headers).status_code == 403


def test_writes_broadcast_awards_changed(client):
    setup_two_divisions(client)
    saturday = create_session(client)
    client.post("/api/event/active-session", json={"session_id": saturday})
    token = client.headers["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect(f"/ws/active-session?token={token}") as socket:
        _create(client, saturday, JUDGED)
        assert next_event(socket, "awards_changed")["data"] == {"session_id": saturday}
