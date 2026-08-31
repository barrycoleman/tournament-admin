def _setup_ranked_teams(client, count: int) -> tuple[int, list[int]]:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        for i in range(count)
    ]
    return session_id, team_ids


def _rank_teams_directly(cooperative_client, session_id: int, team_ids: list[int]) -> None:
    # Score each team a distinct, descending amount so ranks are deterministic
    # (team_ids[0] ends up rank 1, etc.) — one solo match per team via the
    # cooperative-game fixture's alliance_count=2 shape, scoring only the
    # "red" alliance for each (mirroring copies it to "blue" automatically).
    for i, team_id in enumerate(team_ids):
        match = cooperative_client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 1000 + i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        cooperative_client.post(
            f"/api/matches/{match['id']}/alliances/{red_id}/score",
            json={"data": {"objects_scored": (len(team_ids) - i) * 10}},
        )


def test_start_finals_seed_pairing_forms_alliances_immediately(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    _rank_teams_directly(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "in_progress"
    assert len(body["alliances"]) == 2
    assert body["alliances"][0]["seed"] == 1
    assert set(body["alliances"][0]["team_ids"]) == {team_ids[0], team_ids[1]}
    assert body["alliances"][1]["seed"] == 2
    assert set(body["alliances"][1]["team_ids"]) == {team_ids[2], team_ids[3]}


def test_start_finals_rejects_single_elimination(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": 2},
    )
    assert response.status_code == 422
    assert "not implemented" in response.json()["detail"]


def test_start_finals_rejects_odd_bracket_size(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _setup_ranked_teams(client, 4)
    _rank_teams_directly(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 3},
    )
    assert response.status_code == 422


def test_start_finals_auto_defaults_single_field_set(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    field = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    _rank_teams_directly(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2},
    )
    assert response.status_code == 201
    assert response.json()["field_set_id"] == field["field_set_id"]


def test_start_finals_requires_enough_ranked_teams(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _setup_ranked_teams(client, 2)
    _rank_teams_directly(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4},
    )
    assert response.status_code == 422


def test_get_finals_returns_current_state(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    _rank_teams_directly(client, session_id, team_ids)

    started = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    ).json()

    response = client.get(f"/api/finals/{started['id']}")
    assert response.status_code == 200
    assert response.json()["id"] == started["id"]
    assert response.json()["status"] == "in_progress"


def test_captain_pick_rejects_out_of_turn_pick(captain_pick_client):
    client = captain_pick_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "captain-pick-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[0]]},
                {"station": "blue", "team_ids": [team_ids[1]]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[2]]},
                {"station": "blue", "team_ids": [team_ids[3]]},
            ],
        },
    ).json()
    red2_id = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    blue2_id = next(a["id"] for a in match2["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match2['id']}/alliances/{blue2_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": 2},
    ).json()
    assert bracket["status"] == "selecting_alliances"
    seed_1_alliance = bracket["alliances"][0]
    seed_2_alliance = bracket["alliances"][1]

    unclaimed = [t for t in team_ids if t not in seed_1_alliance["team_ids"] and t not in seed_2_alliance["team_ids"]]

    response = client.post(
        f"/api/finals/{bracket['id']}/pick",
        json={
            "captain_bracket_alliance_id": seed_2_alliance["id"],
            "partner_team_id": unclaimed[0],
        },
    )
    assert response.status_code == 422


def test_captain_pick_rejects_already_claimed_partner(captain_pick_client):
    client = captain_pick_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "captain-pick-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[0]]},
                {"station": "blue", "team_ids": [team_ids[1]]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[2]]},
                {"station": "blue", "team_ids": [team_ids[3]]},
            ],
        },
    ).json()
    red2_id = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    blue2_id = next(a["id"] for a in match2["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match2['id']}/alliances/{blue2_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": 2},
    ).json()
    seed_1_alliance = bracket["alliances"][0]

    response = client.post(
        f"/api/finals/{bracket['id']}/pick",
        json={
            "captain_bracket_alliance_id": seed_1_alliance["id"],
            "partner_team_id": seed_1_alliance["team_ids"][0],
        },
    )
    assert response.status_code == 409


def test_captain_pick_completes_bracket_once_every_captain_has_picked(captain_pick_client):
    client = captain_pick_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "captain-pick-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[0]]},
                {"station": "blue", "team_ids": [team_ids[1]]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[2]]},
                {"station": "blue", "team_ids": [team_ids[3]]},
            ],
        },
    ).json()
    red2_id = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    blue2_id = next(a["id"] for a in match2["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match2['id']}/alliances/{blue2_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": 2},
    ).json()
    assert bracket["status"] == "selecting_alliances"
    seed_1 = bracket["alliances"][0]
    seed_2 = bracket["alliances"][1]
    unclaimed = [
        t for t in team_ids if t not in seed_1["team_ids"] and t not in seed_2["team_ids"]
    ]

    client.post(
        f"/api/finals/{bracket['id']}/pick",
        json={"captain_bracket_alliance_id": seed_1["id"], "partner_team_id": unclaimed[0]},
    )
    response = client.post(
        f"/api/finals/{bracket['id']}/pick",
        json={"captain_bracket_alliance_id": seed_2["id"], "partner_team_id": unclaimed[1]},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "in_progress"
    # captain-pick-game declares finals_format="score_chase", so once every
    # captain has picked this bracket's first score-chase run is created
    # automatically for the worst seed (seed_2, per "worst to best" order).
    assert len(body["runs"]) == 1
    assert body["runs"][0]["bracket_alliance_id"] == seed_2["id"]


def test_starting_a_score_chase_bracket_creates_the_first_run_for_the_worst_seed(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    for i, team_id in enumerate(team_ids):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 100 + i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": (4 - i) * 10}},
        )

    bracket = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    ).json()
    assert bracket["status"] == "in_progress"
    assert len(bracket["runs"]) == 1
    worst_seed_alliance = bracket["alliances"][-1]
    assert bracket["runs"][0]["bracket_alliance_id"] == worst_seed_alliance["id"]
    assert bracket["runs"][0]["score"] is None


def test_field_allocation_round_robins_across_multiple_fields(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    field1 = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()
    field2 = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 2"}
    ).json()

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    for i, team_id in enumerate(team_ids):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 100 + i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": (4 - i) * 10}},
        )

    bracket = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    ).json()

    first_run_match = client.get(f"/api/matches/{bracket['runs'][0]['match_id']}").json()
    assert first_run_match["field_id"] in {field1["id"], field2["id"]}
