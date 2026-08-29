def _setup_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    t3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]
    t4 = client.post("/api/teams", json={"number": "4", "name": "Team Four"}).json()["id"]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    return match["id"], red_id, blue_id


def test_submit_score(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}},
        headers={"X-Actor-Name": "shifty-squirrel"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["computed_score"] == 5 * 3 + 2 * 1
    assert body["submitted_by_device"] == "shifty-squirrel"
    assert body["saved_at"] is not None


def test_resubmitting_score_updates_existing_record(client):
    match_id, red_id, blue_id = _setup_match(client)
    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}},
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 17

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "scheduled"  # blue alliance hasn't scored yet


def test_submit_score_rejects_out_of_range_violations(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 999, "low_balls": 0, "auto_winner": "tie"}},
    )
    assert response.status_code == 422


def test_submit_score_force_overrides_violations(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={
            "data": {"high_balls": 999, "low_balls": 0, "auto_winner": "tie"},
            "force": True,
        },
    )
    assert response.status_code == 200


def test_no_show_zeroes_computed_score(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={
            "data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"},
            "no_show": True,
        },
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 0


def test_match_marked_completed_once_both_alliances_scored(client):
    match_id, red_id, blue_id = _setup_match(client)
    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match_id}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 1, "auto_winner": "tie"}},
    )

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "completed"


def test_submit_score_requires_game_plugin_selected(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red_id = match["alliances"][0]["id"]

    response = client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0}},
    )
    assert response.status_code == 422
