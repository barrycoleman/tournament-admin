def _setup_ready_session(client, num_teams: int = 8) -> tuple[int, list[int]]:
    client.post("/api/event", json={"name": "Regional Qualifier"})

    plugins = client.get("/api/plugins/games").json()
    game_plugin_name = plugins[0]["name"]
    client.post("/api/event/game-plugin", json={"name": game_plugin_name})

    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    team_ids = []
    for i in range(num_teams):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        team_ids.append(team_id)
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 2"})

    return session_id, team_ids


def test_generate_schedule_creates_matches(client):
    session_id, team_ids = _setup_ready_session(client)

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["match_count"] > 0

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert len(matches) == body["match_count"]
    for match in matches:
        assert match["round_type"] == "qualification"
        assert match["field_id"] is not None
        assert match["time_slot"] is not None
        assert len(match["alliances"]) == 2


def test_generate_schedule_rejects_when_matches_already_exist(client):
    session_id, _ = _setup_ready_session(client)
    payload = {
        "session_id": session_id,
        "round_type": "qualification",
        "target_matches_per_team": 3,
        "scheduler_plugin_name": "simple_random",
    }
    client.post("/api/schedule", json=payload)

    response = client.post("/api/schedule", json=payload)
    assert response.status_code == 409


def test_generate_schedule_rejects_unknown_scheduler_plugin(client):
    session_id, _ = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "does-not-exist",
        },
    )
    assert response.status_code == 404


def test_generate_schedule_rejects_double_booking_plugin_output(client):
    session_id, team_ids = _setup_ready_session(client)

    import types

    from tournament_server.plugin_registry.loader import LoadedPlugin

    def bad_generate_schedule(**kwargs):
        field_set_id = kwargs["field_sets"][0]["field_set_id"]
        return [
            {
                "time_slot": 0,
                "field_set_id": field_set_id,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[0], team_ids[1]]},
                    {"station": "blue", "team_ids": [team_ids[2], team_ids[3]]},
                ],
            },
            {
                "time_slot": 0,
                "field_set_id": field_set_id,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[0], team_ids[4]]},
                    {"station": "blue", "team_ids": [team_ids[5], team_ids[6]]},
                ],
            },
        ]

    stub = LoadedPlugin(
        name="simple_random",
        version="1.0.0",
        display_name="Simple Random",
        folder=None,
        module=types.SimpleNamespace(generate_schedule=bad_generate_schedule),
    )
    client.app.state.scheduler_plugins["simple_random"] = stub

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422
    assert "double-booked" in response.json()["detail"]


def test_clear_schedule_deletes_matches_and_rankings(client):
    session_id, team_ids = _setup_ready_session(client)
    client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    matches_before = client.get(f"/api/matches?session_id={session_id}").json()
    match = matches_before[0]
    for alliance in match["alliances"]:
        client.post(
            f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": 1, "low_balls": 1}},
        )

    rankings_before = client.get(f"/api/rankings?session_id={session_id}").json()
    assert rankings_before != []  # the completed match above must have produced rankings

    response = client.delete(
        "/api/schedule",
        params={"session_id": session_id, "round_type": "qualification"},
    )
    assert response.status_code == 200
    assert response.json()["matches_deleted"] == len(matches_before)

    remaining_matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert remaining_matches == []

    rankings_after = client.get(f"/api/rankings?session_id={session_id}").json()
    assert rankings_after == []


def test_clear_schedule_allows_regeneration_afterward(client):
    session_id, team_ids = _setup_ready_session(client)
    payload = {
        "session_id": session_id,
        "round_type": "qualification",
        "target_matches_per_team": 3,
        "scheduler_plugin_name": "simple_random",
    }
    client.post("/api/schedule", json=payload)
    client.delete(
        "/api/schedule",
        params={"session_id": session_id, "round_type": "qualification"},
    )

    response = client.post("/api/schedule", json=payload)
    assert response.status_code == 201
