from sqlalchemy import func, select

from auth_helpers import bearer, login_as
from skills_helpers import admitted_device_token
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.score_record_team import ScoreRecordTeam

SHEET = {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}  # 30 points in example-game


def _setup(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1, t2, t3, t4 = (
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in (1, 2, 3, 4)
    )
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    return f"/api/matches/{match['id']}/alliances/{red}/score", (t1, t2, t3, t4), red


def _flag_rows(client):
    db = client.app.state.session_factory()
    try:
        return db.execute(select(func.count()).select_from(ScoreRecordTeam)).scalar_one()
    finally:
        db.close()


def _record_count(client):
    db = client.app.state.session_factory()
    try:
        return db.execute(select(func.count()).select_from(ScoreRecord)).scalar_one()
    finally:
        db.close()


def test_flags_round_trip_and_one_flagged_team_keeps_the_alliance_score(client):
    path, (t1, t2, _, _), _ = _setup(client)
    response = client.post(path, json={"data": SHEET, "teams": [{"team_id": t2, "dq": True}]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["teams"] == [{"team_id": t2, "no_show": False, "dq": True}]
    assert body["computed_score"] == 30
    assert "dq" not in body and "no_show" not in body


def test_every_team_flagged_zeroes_the_alliance(client):
    path, (t1, t2, _, _), _ = _setup(client)
    response = client.post(
        path,
        json={"data": SHEET, "teams": [{"team_id": t1, "no_show": True}, {"team_id": t2, "dq": True}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["computed_score"] == 0


def test_a_team_not_on_the_alliance_is_refused_and_nothing_is_written(client):
    path, (_, _, t3, _), _ = _setup(client)
    response = client.post(path, json={"data": SHEET, "teams": [{"team_id": t3, "dq": True}]})
    assert response.status_code == 422
    assert _record_count(client) == 0


def test_a_team_listed_twice_is_refused(client):
    path, (t1, _, _, _), _ = _setup(client)
    response = client.post(
        path,
        json={"data": SHEET, "teams": [{"team_id": t1, "dq": True}, {"team_id": t1, "no_show": True}]},
    )
    assert response.status_code == 422
    assert _record_count(client) == 0


def test_an_entry_with_no_flags_is_not_stored(client):
    path, (t1, _, _, _), _ = _setup(client)
    response = client.post(path, json={"data": SHEET, "teams": [{"team_id": t1}]})
    assert response.status_code == 200, response.text
    assert response.json()["teams"] == []
    assert _flag_rows(client) == 0


def test_admin_correction_replaces_the_flag_set(client):
    path, (t1, t2, _, _), _ = _setup(client)
    client.post(path, json={"data": SHEET, "teams": [{"team_id": t1, "no_show": True}]})
    second = client.post(path, json={"data": SHEET, "teams": [{"team_id": t2, "dq": True}]})
    assert second.json()["teams"] == [{"team_id": t2, "no_show": False, "dq": True}]
    # The same team flagged again must not trip the (score_record_id, team_id) unique constraint.
    again = client.post(path, json={"data": SHEET, "teams": [{"team_id": t2, "dq": True}]})
    assert again.status_code == 200, again.text
    cleared = client.post(path, json={"data": SHEET})
    assert cleared.json()["teams"] == []
    assert _flag_rows(client) == 0


def test_the_old_alliance_level_flags_are_refused(client):
    path, _, _ = _setup(client)
    for old_field in ("dq", "no_show"):
        response = client.post(path, json={"data": SHEET, old_field: True})
        assert response.status_code == 422, old_field
    assert _record_count(client) == 0


def test_a_scorer_still_cannot_resubmit(client):
    path, (t1, _, _, _), _ = _setup(client)
    raw = client.__class__(client.app)
    scorer = {**bearer(login_as(raw, "scorer")), "X-Device-Token": admitted_device_token(client)}
    assert raw.post(path, json={"data": SHEET}, headers=scorer).status_code == 200
    refused = raw.post(path, json={"data": SHEET, "teams": [{"team_id": t1, "dq": True}]}, headers=scorer)
    assert refused.status_code == 409


def _setup_cooperative(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1, t2, t3, t4 = (
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in (1, 2, 3, 4)
    )
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    ids = {a["station"]: a["id"] for a in match["alliances"]}
    base = f"/api/matches/{match['id']}/alliances"
    return f"{base}/{ids['red']}/score", f"{base}/{ids['blue']}/score", (t1, t2, t3, t4), ids


def _record(client, alliance_id):
    db = client.app.state.session_factory()
    try:
        record = db.execute(select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)).scalar_one()
        return record.data_json, [(f.team_id, f.no_show, f.dq) for f in record.teams]
    finally:
        db.close()


def test_one_flagged_team_still_mirrors(cooperative_client):
    red_path, _, (t1, t2, t3, t4), ids = _setup_cooperative(cooperative_client)
    response = cooperative_client.post(
        red_path, json={"data": {"objects_scored": 10}, "teams": [{"team_id": t2, "dq": True}]}
    )
    assert response.status_code == 200, response.text
    assert _record(cooperative_client, ids["blue"]) == ('{"objects_scored": 10}', [])


def test_a_fully_flagged_alliance_does_not_mirror(cooperative_client):
    red_path, _, (t1, t2, _, _), ids = _setup_cooperative(cooperative_client)
    cooperative_client.post(
        red_path,
        json={"data": {"objects_scored": 10}, "teams": [{"team_id": t1, "dq": True}, {"team_id": t2, "no_show": True}]},
    )
    db = cooperative_client.app.state.session_factory()
    try:
        assert db.execute(select(ScoreRecord).where(ScoreRecord.alliance_id == ids["blue"])).first() is None
    finally:
        db.close()


def test_a_scorer_may_score_the_partner_of_a_fully_flagged_alliance(cooperative_client):
    red_path, blue_path, (t1, t2, _, _), _ = _setup_cooperative(cooperative_client)
    raw = cooperative_client.__class__(cooperative_client.app)
    scorer = {**bearer(login_as(raw, "scorer")), "X-Device-Token": admitted_device_token(cooperative_client)}
    flagged = raw.post(
        red_path,
        json={"data": {"objects_scored": 3}, "teams": [{"team_id": t1, "dq": True}, {"team_id": t2, "dq": True}]},
        headers=scorer,
    )
    assert flagged.status_code == 200, flagged.text
    blue = raw.post(blue_path, json={"data": {"objects_scored": 10}}, headers=scorer)
    assert blue.status_code == 200, blue.text


def test_mirroring_keeps_the_partners_own_flags(cooperative_client):
    red_path, blue_path, (_, _, t3, _), ids = _setup_cooperative(cooperative_client)
    cooperative_client.post(blue_path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": t3, "dq": True}]})
    cooperative_client.post(red_path, json={"data": {"objects_scored": 10}})
    assert _record(cooperative_client, ids["blue"]) == ('{"objects_scored": 10}', [(t3, False, True)])


def _scorer_headers(client):
    raw = client.__class__(client.app)
    return raw, {**bearer(login_as(raw, "scorer")), "X-Device-Token": admitted_device_token(client)}


def test_a_scorer_cannot_overwrite_a_partly_flagged_partner_with_different_data(cooperative_client):
    red_path, blue_path, (_, _, t3, _), ids = _setup_cooperative(cooperative_client)
    raw, scorer = _scorer_headers(cooperative_client)
    first = raw.post(
        blue_path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": t3, "dq": True}]}, headers=scorer
    )
    assert first.status_code == 200, first.text
    second = raw.post(red_path, json={"data": {"objects_scored": 10}}, headers=scorer)
    assert second.status_code == 409, second.text
    assert _record(cooperative_client, ids["blue"])[0] == '{"objects_scored": 5}'


def test_a_scorer_may_submit_matching_data_beside_a_partly_flagged_partner(cooperative_client):
    red_path, blue_path, (_, _, t3, _), _ = _setup_cooperative(cooperative_client)
    raw, scorer = _scorer_headers(cooperative_client)
    first = raw.post(
        blue_path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": t3, "dq": True}]}, headers=scorer
    )
    assert first.status_code == 200, first.text
    second = raw.post(red_path, json={"data": {"objects_scored": 5}}, headers=scorer)
    assert second.status_code == 200, second.text
