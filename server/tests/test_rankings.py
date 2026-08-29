def _score(client, match_id, alliance_id, high_balls, low_balls):
    return client.post(
        f"/api/matches/{match_id}/alliances/{alliance_id}/score",
        json={
            "data": {
                "high_balls": high_balls,
                "low_balls": low_balls,
                "auto_winner": "tie",
            }
        },
    )


def test_rankings_reflect_win_points_and_strength_of_schedule(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    team_ids = {}
    for number in ["1", "2", "3", "4"]:
        team = client.post(
            "/api/teams", json={"number": number, "name": f"Team {number}"}
        ).json()
        team_ids[number] = team["id"]
    t1, t2, t3, t4 = team_ids["1"], team_ids["2"], team_ids["3"], team_ids["4"]

    tiebreaker_seeds = {
        number: client.get(f"/api/teams/{team_id}").json()["tiebreaker_seed"]
        for number, team_id in team_ids.items()
    }

    # Match 1: (T1,T2) vs (T3,T4), red wins 50-20.
    match1 = client.post(
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
    red1 = next(a["id"] for a in match1["alliances"] if a["station"] == "red")
    blue1 = next(a["id"] for a in match1["alliances"] if a["station"] == "blue")
    _score(client, match1["id"], red1, high_balls=16, low_balls=2)  # 50
    _score(client, match1["id"], blue1, high_balls=6, low_balls=2)  # 20

    # Match 2: (T1,T3) vs (T2,T4), red wins 40-10.
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t3]},
                {"station": "blue", "team_ids": [t2, t4]},
            ],
        },
    ).json()
    red2 = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    blue2 = next(a["id"] for a in match2["alliances"] if a["station"] == "blue")
    _score(client, match2["id"], red2, high_balls=13, low_balls=1)  # 40
    _score(client, match2["id"], blue2, high_balls=3, low_balls=1)  # 10

    # Hand-computed expectations:
    # win_points: T1=4 (won both), T2=2 (won m1, lost m2),
    #             T3=2 (lost m1, won m2), T4=0 (lost both)
    # strength_of_schedule: sum of opponents' final win_points per match
    #   T1: m1 opp(T3,T4)=2+0=2, m2 opp(T2,T4)=2+0=2 -> 4
    #   T2: m1 opp(T3,T4)=2+0=2, m2 opp(T1,T3)=4+2=6 -> 8
    #   T3: m1 opp(T1,T2)=4+2=6, m2 opp(T2,T4)=2+0=2 -> 8
    #   T4: m1 opp(T1,T2)=4+2=6, m2 opp(T1,T3)=4+2=6 -> 12
    expected = {
        t1: {"win_points": 4, "strength_of_schedule": 4.0},
        t2: {"win_points": 2, "strength_of_schedule": 8.0},
        t3: {"win_points": 2, "strength_of_schedule": 8.0},
        t4: {"win_points": 0, "strength_of_schedule": 12.0},
    }

    response = client.get(f"/api/rankings?session_id={session_id}")
    assert response.status_code == 200
    rows = {row["team_id"]: row for row in response.json()}

    for team_id, exp in expected.items():
        assert rows[team_id]["win_points"] == exp["win_points"]
        assert rows[team_id]["strength_of_schedule"] == exp["strength_of_schedule"]

    # Replicate the example plugin's own sort key to compute the expected
    # rank order deterministically, regardless of the random tiebreaker
    # seeds actually assigned to these teams.
    id_to_number = {v: k for k, v in team_ids.items()}
    expected_order = sorted(
        expected.keys(),
        key=lambda tid: (
            -expected[tid]["win_points"],
            -expected[tid]["strength_of_schedule"],
            -tiebreaker_seeds[id_to_number[tid]],
        ),
    )
    actual_order = sorted(rows.keys(), key=lambda tid: rows[tid]["rank"])
    assert actual_order == expected_order
    assert [rows[tid]["rank"] for tid in actual_order] == [1, 2, 3, 4]


def test_rankings_default_to_active_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/event/active-session", json={"session_id": session_id})

    response = client.get("/api/rankings")
    assert response.status_code == 200
    assert response.json() == []
