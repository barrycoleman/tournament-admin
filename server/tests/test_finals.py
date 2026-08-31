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
