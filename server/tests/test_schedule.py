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


def test_clear_schedule_recomputes_rankings_instead_of_wiping_other_round_types(client):
    session_id, team_ids = _setup_ready_session(client)

    # Practice: 8 teams, target 1 -> 2 matches.
    practice_response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "practice",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert practice_response.status_code == 201
    assert practice_response.json()["match_count"] == 2

    # Qualification: 8 teams, target 3 -> 6 matches.
    qual_response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert qual_response.status_code == 201
    assert qual_response.json()["match_count"] == 6

    all_matches = client.get(f"/api/matches?session_id={session_id}").json()
    qual_matches_before = [m for m in all_matches if m["round_type"] == "qualification"]
    practice_matches_before = [m for m in all_matches if m["round_type"] == "practice"]
    assert len(qual_matches_before) == 6
    assert len(practice_matches_before) == 2

    # Score every qualification match so real rankings exist.
    for match in qual_matches_before:
        for alliance in match["alliances"]:
            resp = client.post(
                f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
                json={"data": {"high_balls": alliance["id"] % 5 + 1, "low_balls": 1}},
            )
            assert resp.status_code == 200

    rankings_before = client.get(f"/api/rankings?session_id={session_id}").json()
    assert rankings_before != []

    response = client.delete(
        "/api/schedule",
        params={"session_id": session_id, "round_type": "practice"},
    )
    assert response.status_code == 200
    assert response.json()["matches_deleted"] == 2

    # Not one qualification match or score was touched.
    all_matches_after = client.get(f"/api/matches?session_id={session_id}").json()
    qual_matches_after = [m for m in all_matches_after if m["round_type"] == "qualification"]
    practice_matches_after = [m for m in all_matches_after if m["round_type"] == "practice"]
    assert practice_matches_after == []
    assert {m["id"] for m in qual_matches_after} == {m["id"] for m in qual_matches_before}

    rankings_after = client.get(f"/api/rankings?session_id={session_id}").json()
    assert rankings_after == rankings_before


def test_clear_schedule_with_no_matching_round_type_leaves_rankings_untouched(client):
    session_id, team_ids = _setup_ready_session(client)

    qual_response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert qual_response.status_code == 201

    qual_matches = client.get(f"/api/matches?session_id={session_id}").json()
    for match in qual_matches:
        for alliance in match["alliances"]:
            resp = client.post(
                f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
                json={"data": {"high_balls": alliance["id"] % 5 + 1, "low_balls": 1}},
            )
            assert resp.status_code == 200

    rankings_before = client.get(f"/api/rankings?session_id={session_id}").json()
    assert rankings_before != []

    # A typo'd/nonexistent round_type matches zero Match rows: a genuine no-op.
    response = client.delete(
        "/api/schedule",
        params={"session_id": session_id, "round_type": "quallification"},
    )
    assert response.status_code == 200
    assert response.json()["matches_deleted"] == 0

    rankings_after = client.get(f"/api/rankings?session_id={session_id}").json()
    assert rankings_after == rankings_before

    matches_after = client.get(f"/api/matches?session_id={session_id}").json()
    assert {m["id"] for m in matches_after} == {m["id"] for m in qual_matches}


def test_clear_schedule_rejects_nonexistent_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.delete(
        "/api/schedule",
        params={"session_id": 999999, "round_type": "qualification"},
    )
    assert response.status_code == 404


def test_generate_schedule_rejects_invalid_round_type(client):
    session_id, _ = _setup_ready_session(client)

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "not-a-real-round-type",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert matches == []

    from sqlalchemy import select

    from tournament_server.models.schedule_generation import ScheduleGeneration

    db = client.app.state.session_factory()
    try:
        generations = db.execute(select(ScheduleGeneration)).scalars().all()
        assert generations == []
    finally:
        db.close()


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


def test_generate_schedule_with_time_blocks_assigns_scheduled_time(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    team_ids = []
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        team_ids.append(team_id)
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "10:00", "end_time": "12:00", "cycle_time": None}
            ],
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert len(body["resolved_time_blocks"]) == 1
    assert body["resolved_time_blocks"][0]["cycle_time_seconds"] > 0

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    for match in matches:
        assert match["scheduled_time"] is not None


def test_generate_schedule_without_time_blocks_uses_implicit_default(client):
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
    assert len(body["resolved_time_blocks"]) == 1
    assert body["resolved_time_blocks"][0]["end_time"] is None
    assert body["cycle_time_warning"] is None

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    for match in matches:
        assert match["scheduled_time"] is not None


def test_generate_schedule_rejects_time_blocks_without_session_date_or_timezone(client):
    session_id, team_ids = _setup_ready_session(client)

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "10:00", "end_time": "12:00", "cycle_time": None}
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_rejects_mismatched_time_blocks(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    team_ids = []
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        team_ids.append(team_id)
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "10:00", "end_time": "10:05", "cycle_time": 300}
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_warns_when_cycle_time_too_tight(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    game_plugin_name = plugins[0]["name"]
    client.post("/api/event/game-plugin", json={"name": game_plugin_name})

    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    team_ids = []
    for i in range(4):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        team_ids.append(team_id)
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "10:00", "end_time": "10:01", "cycle_time": 60}
            ],
        },
    )
    assert response.status_code == 201
    assert response.json()["cycle_time_warning"] is not None


def test_generate_schedule_rejects_zero_cycle_time(client):
    session_id, team_ids = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "10:00", "end_time": "12:00", "cycle_time": 0}
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_rejects_negative_cycle_time(client):
    session_id, team_ids = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "10:00", "end_time": "12:00", "cycle_time": -60}
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_rejects_malformed_start_time(client):
    session_id, team_ids = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "9:00", "end_time": "12:00", "cycle_time": 180}
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_rejects_overlapping_time_blocks(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "10:00", "end_time": "12:00", "cycle_time": 180},
                {"start_time": "11:00", "end_time": "13:00", "cycle_time": 180},
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_rejects_time_blocks_not_in_ascending_order(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "14:00", "end_time": "16:00", "cycle_time": 180},
                {"start_time": "10:00", "end_time": "12:00", "cycle_time": 180},
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_shares_scheduled_time_across_concurrent_field_sets(client):
    session_id, team_ids = _setup_ready_session(client, num_teams=8)

    field_set_a = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Set A"}
    ).json()["id"]
    field_set_b = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Set B"}
    ).json()["id"]
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Field A1", "field_set_id": field_set_a},
    )
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Field B1", "field_set_id": field_set_b},
    )

    import types

    from tournament_server.plugin_registry.loader import LoadedPlugin

    def concurrent_generate_schedule(**kwargs):
        return [
            {
                "time_slot": 0,
                "field_set_id": field_set_a,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[0], team_ids[1]]},
                    {"station": "blue", "team_ids": [team_ids[2], team_ids[3]]},
                ],
            },
            {
                "time_slot": 0,
                "field_set_id": field_set_b,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[4], team_ids[5]]},
                    {"station": "blue", "team_ids": [team_ids[6], team_ids[7]]},
                ],
            },
        ]

    stub = LoadedPlugin(
        name="simple_random",
        version="1.0.0",
        display_name="Simple Random",
        folder=None,
        module=types.SimpleNamespace(generate_schedule=concurrent_generate_schedule),
    )
    client.app.state.scheduler_plugins["simple_random"] = stub

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 201
    body = response.json()
    # Two matches share time_slot 0 across two FieldSets: this must count
    # as ONE distinct time slot for cycle-time capacity math (an implicit
    # single-slot open-ended default block, not two).
    assert len(body["resolved_time_blocks"]) == 1

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert len(matches) == 2
    scheduled_times = {m["scheduled_time"] for m in matches}
    assert len(scheduled_times) == 1


def test_generate_schedule_warn_below_multiplier_override_changes_warning_outcome(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    for i in range(4):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    payload = {
        "session_id": session_id,
        "round_type": "qualification",
        "target_matches_per_team": 1,
        "scheduler_plugin_name": "simple_random",
        "time_blocks": [
            {"start_time": "10:00", "end_time": "10:01", "cycle_time": 60}
        ],
    }

    lenient_response = client.post(
        "/api/schedule", json={**payload, "warn_below_multiplier": 0.1}
    )
    assert lenient_response.status_code == 201
    assert lenient_response.json()["cycle_time_warning"] is None

    client.delete(
        f"/api/schedule?session_id={session_id}&round_type=qualification"
    )

    strict_response = client.post(
        "/api/schedule", json={**payload, "warn_below_multiplier": 1000.0}
    )
    assert strict_response.status_code == 201
    assert strict_response.json()["cycle_time_warning"] is not None


def test_generate_schedule_scopes_field_sets_to_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    division_red = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    division_blue = client.post("/api/divisions", json={"name": "Blue"}).json()["id"]

    field_set_red = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Red Fields", "division_id": division_red},
    ).json()["id"]
    field_set_blue = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Blue Fields", "division_id": division_blue},
    ).json()["id"]
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Red Field 1", "field_set_id": field_set_red},
    )
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Blue Field 1", "field_set_id": field_set_blue},
    )

    for i in range(4):
        team_id = client.post(
            "/api/teams",
            json={
                "number": f"R{i + 1}",
                "name": f"Red Team {i + 1}",
                "division_id": division_red,
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    for i in range(4):
        team_id = client.post(
            "/api/teams",
            json={
                "number": f"B{i + 1}",
                "name": f"Blue Team {i + 1}",
                "division_id": division_blue,
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

    red_response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "division_id": division_red,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert red_response.status_code == 201

    blue_response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "division_id": division_blue,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert blue_response.status_code == 201

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    red_matches = [m for m in matches if m["division_id"] == division_red]
    blue_matches = [m for m in matches if m["division_id"] == division_blue]
    assert red_matches
    assert blue_matches

    fields = client.get(f"/api/fields?session_id={session_id}").json()
    red_field_id = next(f["id"] for f in fields if f["name"] == "Red Field 1")
    blue_field_id = next(f["id"] for f in fields if f["name"] == "Blue Field 1")

    assert {m["field_id"] for m in red_matches} == {red_field_id}
    assert {m["field_id"] for m in blue_matches} == {blue_field_id}

    delete_response = client.delete(
        "/api/schedule",
        params={
            "session_id": session_id,
            "division_id": division_red,
            "round_type": "qualification",
        },
    )
    assert delete_response.json()["matches_deleted"] == len(red_matches)

    remaining = client.get(f"/api/matches?session_id={session_id}").json()
    assert {m["division_id"] for m in remaining} == {division_blue}


def test_generate_schedule_rejects_division_with_no_field_set(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    other_division_id = client.post("/api/divisions", json={"name": "Blue"}).json()["id"]

    # A FieldSet exists in the session, but it belongs to a different
    # division — Red has none of its own. Pre-fix, this FieldSet would be
    # found anyway (the query ignored division entirely), so this must
    # fail even though a FieldSet technically exists in the session.
    other_field_set_id = client.post(
        "/api/field-sets",
        json={
            "session_id": session_id,
            "name": "Blue Fields",
            "division_id": other_division_id,
        },
    ).json()["id"]
    client.post(
        "/api/fields",
        json={
            "session_id": session_id,
            "name": "Blue Field 1",
            "field_set_id": other_field_set_id,
        },
    )

    for i in range(4):
        team_id = client.post(
            "/api/teams",
            json={"number": str(i + 1), "name": f"Team {i + 1}", "division_id": division_id},
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "division_id": division_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422
    assert str(division_id) in response.json()["detail"]


def test_generate_schedule_without_division_only_uses_unassigned_field_sets(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    red_field_set_id = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Red Fields", "division_id": division_id},
    ).json()["id"]
    client.post(
        "/api/fields",
        json={
            "session_id": session_id,
            "name": "Red Field 1",
            "field_set_id": red_field_set_id,
        },
    )

    unassigned_field_set_id = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Unassigned Fields"}
    ).json()["id"]
    client.post(
        "/api/fields",
        json={
            "session_id": session_id,
            "name": "Unassigned Field",
            "field_set_id": unassigned_field_set_id,
        },
    )

    for i in range(4):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 201

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    fields = client.get(f"/api/fields?session_id={session_id}").json()
    unassigned_field_id = next(f["id"] for f in fields if f["name"] == "Unassigned Field")

    assert matches
    for match in matches:
        assert match["field_id"] == unassigned_field_id
