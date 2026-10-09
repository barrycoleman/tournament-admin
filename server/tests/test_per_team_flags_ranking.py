def _event(client, count):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    teams = [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, count + 1)
    ]
    return session_id, teams


def _match(client, session_id, number, red, blue):
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": number,
            "field_id": None,
            "alliances": [{"station": "red", "team_ids": red}, {"station": "blue", "team_ids": blue}],
        },
    ).json()
    return {"id": match["id"], **{a["station"]: a["id"] for a in match["alliances"]}}


def _score(client, match, station, high_balls, teams=()):
    # example-game: 3 points per high ball.
    response = client.post(
        f"/api/matches/{match['id']}/alliances/{match[station]}/score",
        json={"data": {"high_balls": high_balls, "low_balls": 0, "auto_winner": "tie"}, "teams": list(teams)},
    )
    assert response.status_code == 200, response.text


def _rows(client, session_id):
    return {
        row["team_id"]: (row["win_points"], row["strength_of_schedule"])
        for row in client.get("/api/rankings", params={"session_id": session_id}).json()
    }


def test_a_dqd_partner_gets_nothing_and_the_other_keeps_the_win(client):
    session_id, (t1, t2, t3, t4, t5, t6) = _event(client, 6)
    first = _match(client, session_id, 1, [t1, t2], [t3, t4])
    _score(client, first, "red", 10, [{"team_id": t2, "dq": True}])  # 30
    _score(client, first, "blue", 5)  # 15
    second = _match(client, session_id, 2, [t3, t4], [t5, t6])
    _score(client, second, "red", 10)
    _score(client, second, "blue", 5)

    rows = _rows(client, session_id)
    # Win points: t1 2, t2 0 (DQ'd), t3 2, t4 2 (won match 2), t5 0, t6 0.
    # Strength of schedule: t1 adds t3 + t4 = 4; t2 adds nothing from its DQ'd
    # match; t3 and t4 add t1 + t2 = 2 and t5 + t6 = 0; t5 and t6 add t3 + t4 = 4.
    assert rows == {
        t1: (2, 4.0),
        t2: (0, 0.0),
        t3: (2, 2.0),
        t4: (2, 2.0),
        t5: (0, 4.0),
        t6: (0, 4.0),
    }


def test_a_fully_flagged_alliance_loses_to_a_lower_scoresheet(client):
    session_id, (t1, t2, t3, t4) = _event(client, 4)
    match = _match(client, session_id, 1, [t1, t2], [t3, t4])
    _score(client, match, "red", 10, [{"team_id": t1, "dq": True}, {"team_id": t2, "no_show": True}])
    _score(client, match, "blue", 5)

    rows = _rows(client, session_id)
    assert rows[t3][0] == 2 and rows[t4][0] == 2
    # Flagged in their only match, t1 and t2 are still listed, with nothing.
    assert rows[t1] == (0, 0.0)
    assert rows[t2] == (0, 0.0)


def test_a_tie_with_one_flagged_team(client):
    session_id, (t1, t2, t3, t4) = _event(client, 4)
    match = _match(client, session_id, 1, [t1, t2], [t3, t4])
    _score(client, match, "red", 5, [{"team_id": t2, "no_show": True}])
    _score(client, match, "blue", 5)

    rows = _rows(client, session_id)
    assert {team: points for team, (points, _) in rows.items()} == {t1: 1, t2: 0, t3: 1, t4: 1}
