from __future__ import annotations

import csv
import io

from fastapi.testclient import TestClient
from sqlalchemy import select

from auth_helpers import bearer, login_as
from award_helpers import create_session, db_session, enter, setup_two_divisions
from tournament_server.models.award import AwardWinner
from tournament_server.models.ranking import Ranking

JUDGED = {"name": "Excellence Award", "kind": "judged", "scope": "event", "description": "Top team"}
CHAMPION = {
    "name": "Teamwork Champion", "kind": "performance", "scope": "division",
    "source": "teamwork_ranking", "basis": "session", "placement": 1,
}


def _create(client, session_id, body):
    response = client.post(f"/api/sessions/{session_id}/awards", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _setup(client):
    """Division 1 has a teamwork winner (A1); Division 2 has none; the judged award is empty."""
    first, second, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"], teams["A2"], teams["B1"])
    with db_session(client) as db:
        db.add(Ranking(session_id=saturday, division_id=first, team_id=teams["A1"], rank=1))
        db.commit()
    judged = _create(client, saturday, JUDGED)
    champion = _create(client, saturday, CHAMPION)
    return first, second, teams, saturday, judged, champion


def test_dry_run_lists_warnings_and_changes_nothing(client):
    first, second, _, saturday, judged, champion = _setup(client)
    response = client.post(f"/api/sessions/{saturday}/awards/finalize", json={})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["awards_finalized_at"] is None
    assert body["warnings"] == [
        {"award_id": judged["id"], "award_name": "Excellence Award", "division_id": None,
         "division_name": None, "status": "judged_pending"},
        {"award_id": champion["id"], "award_name": "Teamwork Champion", "division_id": second,
         "division_name": "Division 2", "status": "no_result"},
    ]
    with db_session(client) as db:
        assert db.execute(select(AwardWinner)).scalars().all() == []


def test_confirm_snapshots_resolved_winners_and_locks_edits(client):
    first, _, teams, saturday, judged, champion = _setup(client)
    response = client.post(f"/api/sessions/{saturday}/awards/finalize", json={"confirm": True})
    assert response.status_code == 200, response.text
    assert response.json()["awards_finalized_at"] is not None

    with db_session(client) as db:
        rows = db.execute(select(AwardWinner)).scalars().all()
        assert [(r.award_id, r.division_id, r.team_id, r.origin) for r in rows] == [
            (champion["id"], first, teams["A1"], "finalized")
        ]
        # A later score change moves the ranking; the finalized winner stays.
        db.execute(Ranking.__table__.delete())
        db.add(Ranking(session_id=saturday, division_id=first, team_id=teams["A2"], rank=1))
        db.commit()
    awards = client.get(f"/api/sessions/{saturday}/awards").json()["awards"]
    slot = awards[1]["slots"][0]
    assert (slot["status"], [w["team_id"] for w in slot["winners"]]) == ("finalized", [teams["A1"]])

    locked = [
        client.post(f"/api/sessions/{saturday}/awards", json=JUDGED),
        client.patch(f"/api/awards/{judged['id']}", json={"name": "X"}),
        client.delete(f"/api/awards/{judged['id']}"),
        client.put(f"/api/sessions/{saturday}/awards/order", json={"award_ids": [champion["id"], judged["id"]]}),
        client.post(f"/api/sessions/{saturday}/awards/copy", json={"from_session_id": create_session(client, "Other")}),
        client.put(f"/api/awards/{judged['id']}/slots/event", json={"team_id": teams["A1"]}),
        client.delete(f"/api/awards/{champion['id']}/slots/{first}"),
    ]
    for response in locked:
        assert response.status_code == 409, response.request.url
        assert response.json()["detail"] == "Unfinalize awards to make changes."


def test_finalize_twice_is_409_and_writes_once(client):
    _, _, _, saturday, _, _ = _setup(client)
    assert client.post(f"/api/sessions/{saturday}/awards/finalize", json={"confirm": True}).status_code == 200
    assert client.post(f"/api/sessions/{saturday}/awards/finalize", json={"confirm": True}).status_code == 409
    with db_session(client) as db:
        assert len(db.execute(select(AwardWinner)).scalars().all()) == 1


def test_unfinalize_keeps_judged_and_override_rows(client):
    first, second, teams, saturday, judged, champion = _setup(client)
    client.put(f"/api/awards/{judged['id']}/slots/event", json={"team_id": teams["B1"]})
    second_place = _create(client, saturday, {**CHAMPION, "name": "Second", "placement": 2})
    client.put(f"/api/awards/{second_place['id']}/slots/{first}", json={"team_ids": [teams["A2"]], "reason": "r"})
    client.post(f"/api/sessions/{saturday}/awards/finalize", json={"confirm": True})

    response = client.post(f"/api/sessions/{saturday}/awards/unfinalize")
    assert response.status_code == 200, response.text
    assert response.json()["awards_finalized_at"] is None
    with db_session(client) as db:
        origins = sorted(r.origin for r in db.execute(select(AwardWinner)).scalars().all())
    assert origins == ["judged", "override"]
    assert client.post(f"/api/sessions/{saturday}/awards/unfinalize").status_code == 409


def test_finalize_is_admin_only(client):
    _, _, _, saturday, _, _ = _setup(client)
    raw = TestClient(client.app)
    judge = bearer(login_as(raw, "judge"))
    assert raw.post(f"/api/sessions/{saturday}/awards/finalize", json={"confirm": True}, headers=judge).status_code == 403
    assert raw.post(f"/api/sessions/{saturday}/awards/unfinalize", headers=judge).status_code == 403


def test_csv_lists_every_winner_in_award_then_slot_order(client):
    first, second, teams, saturday, judged, champion = _setup(client)
    client.patch(f"/api/teams/{teams['A1']}", json={"organization": "North High"})
    response = client.get(f"/api/sessions/{saturday}/awards.csv")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert f'filename="awards-{saturday}.csv"' in response.headers["content-disposition"]
    rows = list(csv.reader(io.StringIO(response.text)))
    assert rows == [
        ["award", "description", "division", "placement", "team_number", "team_name", "organization", "status"],
        ["Excellence Award", "Top team", "", "", "", "", "", "judged_pending"],
        ["Teamwork Champion", "", "Division 1", "1", "A1", "Team A1", "North High", "resolved"],
        ["Teamwork Champion", "", "Division 2", "1", "", "", "", "no_result"],
    ]
    raw = TestClient(client.app)
    judge = bearer(login_as(raw, "judge"))
    assert raw.get(f"/api/sessions/{saturday}/awards.csv", headers=judge).status_code == 200
