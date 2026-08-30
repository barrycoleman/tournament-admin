def _setup_cooperative_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    return match["id"], red_id, blue_id, t1, t2


def test_submitting_to_one_alliance_mirrors_data_and_completes_match(cooperative_client):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 20

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "completed"

    blue_response = client.get(f"/api/matches/{match_id}").json()
    blue_alliance = next(a for a in blue_response["alliances"] if a["id"] == blue_id)
    assert blue_alliance["team_ids"] == [t2]


def test_dq_on_one_alliance_does_not_affect_the_other(cooperative_client):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )

    dq_response = client.post(
        f"/api/matches/{match_id}/alliances/{blue_id}/score",
        json={"data": {"objects_scored": 10}, "dq": True},
    )
    assert dq_response.status_code == 200
    assert dq_response.json()["computed_score"] == 0

    red_after = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )
    assert red_after.status_code == 200
    assert red_after.json()["computed_score"] == 20
    assert red_after.json()["dq"] is False


def test_cooperative_score_ranking_is_average_no_win_loss(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    t3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]

    # Match 1: T1 (red) + T2 (blue) share a scoresheet scoring 20 total.
    match1 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red1 = next(a["id"] for a in match1["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match1['id']}/alliances/{red1}/score",
        json={"data": {"objects_scored": 10}},
    )

    # Match 2: T1 (red) + T3 (blue) share a scoresheet scoring 30 total.
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t3]},
            ],
        },
    ).json()
    red2 = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2}/score",
        json={"data": {"objects_scored": 15}},
    )

    response = client.get(f"/api/rankings?session_id={session_id}")
    assert response.status_code == 200
    rows = {row["team_id"]: row for row in response.json()}

    # T1 played both matches: average = (20 + 30) / 2 = 25.
    assert rows[t1]["average_score"] == 25.0
    assert rows[t1]["matches_played"] == 2
    assert rows[t1]["win_points"] == 0
    # T2 played only match 1: average = 20.
    assert rows[t2]["average_score"] == 20.0
    assert rows[t2]["matches_played"] == 1
    # T3 played only match 2: average = 30.
    assert rows[t3]["average_score"] == 30.0
    assert rows[t3]["matches_played"] == 1

    # rank_teams sorts by -average_score, so T3 (30) > T1 (25) > T2 (20).
    assert rows[t3]["rank"] == 1
    assert rows[t1]["rank"] == 2
    assert rows[t2]["rank"] == 3


def test_exclude_mode_drops_lowest_non_protected_match(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    client.post("/api/ranking-configuration", json={"mode": "exclude", "count": 1})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    scores = [30, 10, 20]
    for i, total in enumerate(scores, start=1):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [t1]},
                    {"station": "blue", "team_ids": [t2]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": total // 2}},
        )

    response = client.get(f"/api/rankings?session_id={session_id}")
    rows = {row["team_id"]: row for row in response.json()}

    # Lowest match (10) is dropped: average of (30, 20) = 25. matches_played
    # still reports all 3 real matches played, not the post-exclusion count.
    assert rows[t1]["average_score"] == 25.0
    assert rows[t1]["matches_played"] == 3


def test_include_mode_zero_pads_a_team_with_fewer_matches_than_count(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    client.post("/api/ranking-configuration", json={"mode": "include", "count": 3})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red}/score",
        json={"data": {"objects_scored": 15}},
    )

    response = client.get(f"/api/rankings?session_id={session_id}")
    rows = {row["team_id"]: row for row in response.json()}

    # T1 played 1 real match scoring 30; count=3 pads in 2 zero matches:
    # (30 + 0 + 0) / 3 = 10.
    assert rows[t1]["average_score"] == 10.0
    assert rows[t1]["matches_played"] == 1
