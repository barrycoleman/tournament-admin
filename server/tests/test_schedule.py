import copy
import datetime as dt
import json
import random
from zoneinfo import ZoneInfo

from schedule_helpers import ALL_DAY, PLAY_DATE, TZ, schedule, set_playing_windows

LA = ZoneInfo(TZ)


def _setup_ready_session(
    client, num_teams: int = 8, num_fields: int = 2
) -> tuple[int, list[int]]:
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

    for i in range(num_fields):
        client.post("/api/fields", json={"session_id": session_id, "name": f"Field {i + 1}"})

    set_playing_windows(client, session_id)
    return session_id, team_ids


def _local_times(client, session_id, round_type=None):
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    return sorted(
        {
            dt.datetime.fromisoformat(m["scheduled_time"]).astimezone(LA).strftime("%a %H:%M:%S")
            for m in matches
            if round_type is None or m["round_type"] == round_type
        }
    )


def _score_one_match(client, session_id, round_type):
    match = next(
        m for m in client.get(f"/api/matches?session_id={session_id}").json()
        if m["round_type"] == round_type
    )
    for alliance in match["alliances"]:
        response = client.post(
            f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": 1, "low_balls": 1}},
        )
        assert response.status_code in (200, 201), response.text


def test_generate_schedule_creates_matches(client):
    session_id, team_ids = _setup_ready_session(client)

    response = schedule(client, session_id, [("qualification", 3)])
    assert response.status_code == 201
    body = response.json()
    match_count = sum(r["match_count"] for r in body["rounds"])
    assert match_count > 0

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert len(matches) == match_count
    for match in matches:
        assert match["round_type"] == "qualification"
        assert match["field_id"] is not None
        assert match["time_slot"] is not None
        assert len(match["alliances"]) == 2


def test_generate_schedule_succeeds_in_a_single_division_event(client):
    # Regression test: before this fix, every team created via
    # _setup_ready_session ended up with a real division_id (the event
    # has exactly one division -- the auto-seeded "Division 1" -- and
    # assign_sole_division, added earlier in this plan, assigns every
    # team to it). That made the eligible-team-pool query below --
    # which filtered for Team.division_id IS NULL when no division_id
    # was given in the request -- find zero teams, turning this into a
    # 422 instead of a successful schedule generation. This is the exact
    # scenario _setup_ready_session already exercises; naming it
    # explicitly here documents the regression this task fixes.
    session_id, team_ids = _setup_ready_session(client)

    response = schedule(client, session_id, [("qualification", 3)])
    assert response.status_code == 201


def test_generate_schedule_rejects_unknown_scheduler_plugin(client):
    session_id, _ = _setup_ready_session(client)
    response = schedule(client, session_id, [("qualification", 3)], scheduler="does-not-exist")
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

    response = schedule(client, session_id, [("qualification", 3)])
    assert response.status_code == 422
    assert "double-booked" in response.json()["detail"]


def test_clear_schedule_deletes_matches_and_rankings(client):
    session_id, team_ids = _setup_ready_session(client)
    schedule(client, session_id, [("qualification", 3)])
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
    practice_response = schedule(client, session_id, [("practice", 1)])
    assert practice_response.status_code == 201
    assert sum(r["match_count"] for r in practice_response.json()["rounds"]) == 2

    # Qualification: 8 teams, target 3 -> 6 matches.
    qual_response = schedule(client, session_id, [("qualification", 3)])
    assert qual_response.status_code == 201
    assert sum(r["match_count"] for r in qual_response.json()["rounds"]) == 6

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

    qual_response = schedule(client, session_id, [("qualification", 3)])
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

    response = schedule(client, session_id, [("not-a-real-round-type", 3)])
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
    schedule(client, session_id, [("qualification", 3)])
    client.delete(
        "/api/schedule",
        params={"session_id": session_id, "round_type": "qualification"},
    )

    response = schedule(client, session_id, [("qualification", 3)])
    assert response.status_code == 201


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

    response = schedule(client, session_id, [("qualification", 1)])
    assert response.status_code == 201
    body = response.json()
    # Two matches share time_slot 0 across two FieldSets: this must count
    # as ONE distinct time slot when placing them in the playing windows.
    assert body["rounds"][0]["slot_count"] == 1

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert len(matches) == 2
    scheduled_times = {m["scheduled_time"] for m in matches}
    assert len(scheduled_times) == 1
    # The one shared slot starts when the session's 08:00 window opens.
    assert _local_times(client, session_id) == ["Sat 08:00:00"]


def test_generate_schedule_scopes_field_sets_to_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    set_playing_windows(client, session_id)

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

    red_response = schedule(client, session_id, [("qualification", 1)], division_id=division_red)
    assert red_response.status_code == 201

    blue_response = schedule(
        client, session_id, [("qualification", 1)], division_id=division_blue
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
    set_playing_windows(client, session_id)
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

    response = schedule(client, session_id, [("qualification", 1)], division_id=division_id)
    assert response.status_code == 422
    assert str(division_id) in response.json()["detail"]


def test_generate_schedule_without_division_only_uses_unassigned_field_sets(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    set_playing_windows(client, session_id)

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

    response = schedule(client, session_id, [("qualification", 1)])
    assert response.status_code == 201

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    fields = client.get(f"/api/fields?session_id={session_id}").json()
    unassigned_field_id = next(f["id"] for f in fields if f["name"] == "Unassigned Field")

    assert matches
    for match in matches:
        assert match["field_id"] == unassigned_field_id


def test_generate_schedule_allows_overlap_across_different_divisions(client):
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
    set_playing_windows(client, session_id)
    division_2_id = client.post("/api/divisions", json={"name": "Division 2"}).json()["id"]

    division_1_id = client.get("/api/divisions").json()[0]["id"]
    field_set_1 = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Set 1", "division_id": division_1_id},
    ).json()["id"]
    field_set_2 = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Set 2", "division_id": division_2_id},
    ).json()["id"]
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Field A", "field_set_id": field_set_1},
    )
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Field B", "field_set_id": field_set_2},
    )

    team_ids_div1, team_ids_div2 = [], []
    for i in range(4):
        team = client.post(
            "/api/teams", json={"number": f"1{i}", "name": f"D1 Team {i}"}
        ).json()
        client.patch(f"/api/teams/{team['id']}", json={"division_id": division_1_id})
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team["id"], "checked_in": True},
        )
        team_ids_div1.append(team["id"])
    for i in range(4):
        team = client.post(
            "/api/teams", json={"number": f"2{i}", "name": f"D2 Team {i}"}
        ).json()
        client.patch(f"/api/teams/{team['id']}", json={"division_id": division_2_id})
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team["id"], "checked_in": True},
        )
        team_ids_div2.append(team["id"])

    # 4 teams per division / 4 teams-per-match -> 1 match, 1 time_slot per
    # division. Both divisions flow through the same playing window, so
    # their matches start at the same moment on their own fields.
    response_1 = schedule(client, session_id, [("qualification", 1)], division_id=division_1_id)
    assert response_1.status_code == 201

    response_2 = schedule(client, session_id, [("qualification", 1)], division_id=division_2_id)
    assert response_2.status_code == 201

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert len(matches) == 2
    assert len({m["scheduled_time"] for m in matches}) == 1
    assert _local_times(client, session_id) == ["Sat 08:00:00"]


def test_generated_qualification_matches_have_q_prefixed_labels(client):
    session_id, team_ids = _setup_ready_session(client)
    schedule(client, session_id, [("qualification", 3)])
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    labels = sorted(m["label"] for m in matches)
    assert labels == [f"Q{n}" for n in range(1, len(matches) + 1)]


def test_generated_practice_matches_have_p_prefixed_labels(client):
    session_id, team_ids = _setup_ready_session(client)
    schedule(client, session_id, [("practice", 1)])
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    labels = sorted(m["label"] for m in matches)
    assert labels == [f"P{n}" for n in range(1, len(matches) + 1)]


def test_generate_schedule_rejects_empty_phases_list(client):
    session_id, team_ids = _setup_ready_session(client)
    response = schedule(client, session_id, [])
    assert response.status_code == 422


def test_generate_schedule_with_phases_orders_matches_by_phase(client):
    session_id, team_ids = _setup_ready_session(client, num_teams=8)

    response = schedule(client, session_id, [("practice", 1), ("qualification", 2)])
    assert response.status_code == 201
    body = response.json()
    assert [pr["round_type"] for pr in body["rounds"]] == ["practice", "qualification"]
    practice_count = next(
        pr["match_count"] for pr in body["rounds"] if pr["round_type"] == "practice"
    )
    qualification_count = next(
        pr["match_count"] for pr in body["rounds"] if pr["round_type"] == "qualification"
    )
    assert (practice_count, qualification_count) == (2, 4)
    assert all(pr["schedule_generation_id"] is not None for pr in body["rounds"])

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    practice_times = [m["scheduled_time"] for m in matches if m["round_type"] == "practice"]
    qualification_times = [
        m["scheduled_time"] for m in matches if m["round_type"] == "qualification"
    ]
    assert max(practice_times) < min(qualification_times)


def test_generate_schedule_dry_run_creates_nothing(client):
    session_id, team_ids = _setup_ready_session(client, num_teams=8)

    response = schedule(
        client, session_id, [("practice", 1), ("qualification", 2)], dry_run=True
    )
    assert response.status_code == 201
    body = response.json()
    assert body["rounds"][0]["schedule_generation_id"] is None
    assert sum(r["match_count"] for r in body["rounds"]) > 0
    assert all(pr["schedule_generation_id"] is None for pr in body["rounds"])

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert matches == []

    # Since nothing was persisted, a real (non-dry-run) request for the
    # same rounds must still succeed afterward.
    real_response = schedule(client, session_id, [("practice", 1), ("qualification", 2)])
    assert real_response.status_code == 201


def test_generate_schedule_dry_run_is_idempotent(client):
    session_id, team_ids = _setup_ready_session(client, num_teams=8)

    first = schedule(client, session_id, [("qualification", 3)], dry_run=True).json()
    second = schedule(client, session_id, [("qualification", 3)], dry_run=True).json()

    assert sum(r["match_count"] for r in first["rounds"]) == sum(
        r["match_count"] for r in second["rounds"]
    )
    assert first["rounds"][0]["schedule_generation_id"] is None
    assert second["rounds"][0]["schedule_generation_id"] is None
    assert first["rounds"] == second["rounds"]

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert matches == []


def test_generate_schedule_rejects_duplicate_round_type_across_phases(client):
    # A rounds list repeating the same round_type against itself is a
    # request-shape problem -- it must be rejected, all-or-nothing, before
    # anything is generated or persisted.
    session_id, team_ids = _setup_ready_session(client, num_teams=8)

    response = schedule(client, session_id, [("qualification", 1), ("qualification", 2)])
    assert response.status_code == 422
    assert response.json()["detail"] == "rounds must not repeat a round_type"

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert matches == []


def test_generate_schedule_combined_phases_fold_pairing_history_between_phases(client):
    # Regression check for a subtler bug: cross_session_pairing_history is
    # computed once from the DB before the round loop runs, and nothing is
    # persisted until the whole combined request succeeds -- so without
    # explicitly folding each round's own just-generated pairings into that
    # in-memory dict before the next round's scheduler-plugin call, a
    # later round in the same request never sees an earlier round's own
    # pairings, silently degrading a pairing-aware scheduler plugin
    # (`balanced`) relative to issuing the same rounds as separate,
    # sequential requests.
    #
    # With exactly 4 teams, 1 field_set, target_matches_per_team=1 on both
    # rounds, and no pre-existing matches, `balanced`'s cost-minimization
    # over its 20 sampling attempts is fully determined by
    # `random`'s state once seeded, since nothing else in the request path
    # consumes it. Folding round 1's own partner/opponent pairings into
    # `cross_session_pairing_history` before round 2's call always makes
    # round 2's cost model rate repeating round 1's own partner-alliance
    # split strictly worse than at least one alternative split; without
    # folding, round 2 sees the same (empty) history round 1 did, and can
    # -- depending on the RNG state carried over from round 1's own call,
    # which seed=1 is confirmed to trigger -- pick the exact same
    # partner-alliance split again. This makes the assertion below a real,
    # falsifiable proof that the fold is happening: reverting it (restoring
    # the pre-fix behavior) makes this specific seed fail.
    session_id, team_ids = _setup_ready_session(client, num_teams=4)

    random.seed(1)
    response = schedule(
        client, session_id, [("practice", 1), ("qualification", 1)], scheduler="balanced"
    )
    assert response.status_code == 201

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    practice_matches = [m for m in matches if m["round_type"] == "practice"]
    qualification_matches = [m for m in matches if m["round_type"] == "qualification"]
    assert len(practice_matches) == 1
    assert len(qualification_matches) == 1

    def partner_split(match) -> set[frozenset[int]]:
        return {frozenset(a["team_ids"]) for a in match["alliances"]}

    practice_split = partner_split(practice_matches[0])
    qualification_split = partner_split(qualification_matches[0])
    assert practice_split != qualification_split


def test_rejects_a_session_without_playing_windows(client):
    session_id, _ = _setup_ready_session(client)
    client.put(f"/api/sessions/{session_id}/playing-windows", json={"windows": []})
    response = schedule(client, session_id, [("qualification", 1)])
    assert response.status_code == 422
    assert response.json()["detail"] == "This session has no playing times; add them before scheduling"


def test_rejects_a_session_without_a_timezone(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "No zone"}).json()["id"]
    response = schedule(client, session_id, [("qualification", 1)])
    assert response.status_code == 422
    assert response.json()["detail"] == "Set the session's timezone before scheduling"


def test_rejects_the_old_request_shape(client):
    session_id, _ = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422


def test_rejects_elimination_and_a_cycle_shorter_than_the_match(client):
    session_id, _ = _setup_ready_session(client)
    elimination = schedule(client, session_id, [("elimination", 1)])
    assert elimination.status_code == 422
    assert "finals" in elimination.json()["detail"]
    short = schedule(client, session_id, [("qualification", 1, 90)])
    assert short.status_code == 422
    assert "at least the match length (120s)" in short.json()["detail"]


def test_matches_flow_across_a_break_and_into_the_next_day(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [
        {"date": PLAY_DATE, "start_time": "09:00", "end_time": "09:06"},
        {"date": PLAY_DATE, "start_time": "13:00", "end_time": "13:06"},
        {"date": "2026-11-08", "start_time": "09:00", "end_time": "12:00"},
    ])
    # 8 teams, 4 per match, 1 field: 1 match per slot. 1/team = 2 slots.
    response = schedule(client, session_id, [("qualification", 3, 240)])
    assert response.status_code == 201, response.text
    assert _local_times(client, session_id) == [
        "Sat 09:00:00", "Sat 09:04:00", "Sat 13:00:00", "Sat 13:04:00", "Sun 09:00:00", "Sun 09:04:00",
    ]


def test_a_new_round_starts_on_the_minute_after_the_previous_rounds_last_match(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "12:00"}])
    assert schedule(client, session_id, [("practice", 1, 150)]).status_code == 201
    # Practice: 09:00 and 09:02:30, which ends at 09:04:30.
    assert schedule(client, session_id, [("qualification", 1, 240)]).status_code == 201
    assert _local_times(client, session_id, "qualification")[0] == "Sat 09:05:00"


def test_a_round_after_one_that_ends_in_a_gap_starts_at_the_next_window(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [
        {"date": PLAY_DATE, "start_time": "09:00", "end_time": "09:05"},
        {"date": PLAY_DATE, "start_time": "13:00", "end_time": "14:00"},
    ])
    # Practice 09:00 (ends 09:02) and 09:02:30 would end 09:04:30; both fit before 09:05.
    assert schedule(client, session_id, [("practice", 1, 150)]).status_code == 201
    assert schedule(client, session_id, [("qualification", 1, 240)]).status_code == 201
    assert _local_times(client, session_id, "qualification")[0] == "Sat 13:00:00"


def test_a_dry_run_reports_each_rounds_times_and_creates_nothing(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "12:00"}])
    response = schedule(client, session_id, [("practice", 1, 150), ("qualification", 1, 240)], dry_run=True)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["fits"] is True and body["overflow"] is None
    practice, qualification = body["rounds"]
    assert (practice["match_count"], practice["slot_count"]) == (2, 2)
    assert practice["schedule_generation_id"] is None
    assert practice["first_start"] == "2026-11-07T17:00:00Z"
    assert practice["last_end"] == "2026-11-07T17:04:30Z"
    assert qualification["first_start"] == "2026-11-07T17:05:00Z"
    assert client.get(f"/api/matches?session_id={session_id}").json() == []


def test_a_dry_run_that_does_not_fit_reports_overflow_and_suggestions(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "10:00"}])
    # 6 matches per team = 12 single-field slots at 6:00: the last would start 10:06.
    body = schedule(client, session_id, [("qualification", 6, 360)], dry_run=True).json()
    assert body["fits"] is False
    assert body["rounds"][0]["last_end"] is None
    overflow = body["overflow"]
    assert overflow["unplaced_slot_count"] == 2
    assert overflow["unplaced_match_count"] == 2
    assert overflow["over_by_seconds"] == 480  # last match would end 10:08
    assert overflow["suggested_last_window_end"] == "10:08"
    assert overflow["suggested_cycle_time_seconds"] == 316  # 11 * c + 120 <= 3600


def test_a_real_request_that_does_not_fit_is_422_and_creates_nothing(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "10:00"}])
    response = schedule(client, session_id, [("qualification", 6, 360)])
    assert response.status_code == 422
    assert response.json()["detail"].startswith("2 matches don't fit in the session's playing times")
    assert client.get(f"/api/matches?session_id={session_id}").json() == []


def test_rebuilding_a_round_also_rebuilds_the_rounds_after_it(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    response = schedule(client, session_id, [("practice", 2), ("qualification", 1)])
    assert response.status_code == 201, response.text
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert sum(m["round_type"] == "practice" for m in matches) == 4
    last_practice = max(m["scheduled_time"] for m in matches if m["round_type"] == "practice")
    first_qualification = min(m["scheduled_time"] for m in matches if m["round_type"] == "qualification")
    assert first_qualification > last_practice


def test_rebuilding_a_round_without_the_rounds_after_it_is_rejected(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    response = schedule(client, session_id, [("practice", 2)])
    assert response.status_code == 422
    assert response.json()["detail"] == (
        "Rebuilding Practice also moves the rounds after it; include Qualification too"
    )


def test_rebuilding_only_the_last_round_keeps_the_earlier_ones(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    before = {m["id"] for m in client.get(f"/api/matches?session_id={session_id}").json() if m["round_type"] == "practice"}
    assert schedule(client, session_id, [("qualification", 2)]).status_code == 201
    after = {m["id"] for m in client.get(f"/api/matches?session_id={session_id}").json() if m["round_type"] == "practice"}
    assert after == before


def test_a_round_with_scores_cannot_be_rebuilt(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    _score_one_match(client, session_id, "practice")
    response = schedule(client, session_id, [("practice", 2), ("qualification", 1)])
    assert response.status_code == 422
    assert response.json()["detail"] == "Practice has scored matches, so it can't be rebuilt. Clear it first."


def test_a_round_after_a_scored_round_can_still_be_rebuilt(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    _score_one_match(client, session_id, "practice")
    assert schedule(client, session_id, [("qualification", 2)]).status_code == 201


def test_a_rebuild_whose_scheduler_fails_leaves_the_old_schedule_intact(client, monkeypatch):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    before = client.get(f"/api/matches?session_id={session_id}").json()
    module = client.app.state.scheduler_plugins.get("simple_random").module
    real = module.generate_schedule
    calls = {"n": 0}

    def fail_second(**kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("scheduler exploded")
        return real(**kwargs)

    monkeypatch.setattr(module, "generate_schedule", fail_second)
    response = schedule(client, session_id, [("practice", 2), ("qualification", 1)])
    assert response.status_code == 422
    assert client.get(f"/api/matches?session_id={session_id}").json() == before


def test_a_rebuild_that_fails_while_saving_rolls_back(client, monkeypatch):
    import pytest

    from tournament_server.routers import schedule as schedule_router

    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    before = client.get(f"/api/matches?session_id={session_id}").json()
    real = schedule_router.serialize_time_blocks
    calls = {"n": 0}

    def fail_second(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk full")
        return real(*args, **kwargs)

    monkeypatch.setattr(schedule_router, "serialize_time_blocks", fail_second)
    with pytest.raises(RuntimeError):
        schedule(client, session_id, [("practice", 2), ("qualification", 1)])
    assert client.get(f"/api/matches?session_id={session_id}").json() == before


def test_pairing_history_leaves_out_the_rounds_being_replaced(client, monkeypatch):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("qualification", 1)]).status_code == 201
    module = client.app.state.scheduler_plugins.get("simple_random").module
    real = module.generate_schedule
    seen = []

    def capture(**kwargs):
        # A snapshot: the router folds this round's own pairings into the
        # same dict once the plugin returns.
        seen.append(copy.deepcopy(kwargs["cross_session_pairing_history"]))
        return real(**kwargs)

    monkeypatch.setattr(module, "generate_schedule", capture)
    assert schedule(client, session_id, [("qualification", 1)]).status_code == 201
    assert seen == [{}]


def test_a_generation_records_its_cycle_time_and_the_windows_it_uses(client):
    from tournament_server.models.schedule_generation import ScheduleGeneration

    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [
        {"date": PLAY_DATE, "start_time": "09:00", "end_time": "09:05"},
        {"date": PLAY_DATE, "start_time": "13:00", "end_time": "14:00"},
    ])
    assert schedule(client, session_id, [("qualification", 2, 240)]).status_code == 201
    db = client.app.state.session_factory()
    try:
        generation = db.query(ScheduleGeneration).one()
        assert generation.cycle_time_seconds == 240
        blocks = json.loads(generation.time_blocks_json)
        assert [(b["start_time"], b["occupied_from"], b["occupied_until"]) for b in blocks] == [
            ("09:00", "2026-11-07T17:00:00+00:00", "2026-11-07T17:02:00+00:00"),
            ("13:00", "2026-11-07T21:00:00+00:00", "2026-11-07T21:10:00+00:00"),
        ]
    finally:
        db.close()


def test_an_old_format_generation_still_blocks_overlapping_matches(client):
    from tournament_server.models.schedule_generation import ScheduleGeneration

    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1)]).status_code == 201
    db = client.app.state.session_factory()
    try:
        generation = db.query(ScheduleGeneration).one()
        # A row saved before occupied windows existed: an open-ended block
        # from 08:00 claims everything after it.
        generation.time_blocks_json = json.dumps([
            {"date": PLAY_DATE, "start_time": "08:00", "end_time": None, "cycle_time": 300, "timezone": TZ}
        ])
        db.commit()
    finally:
        db.close()
    response = schedule(client, session_id, [("qualification", 1)])
    assert response.status_code == 422
    assert "overlapping the practice round's matches" in response.json()["detail"]


def _rounds(client, session_id, division_id=None):
    params = {"session_id": session_id}
    if division_id is not None:
        params["division_id"] = division_id
    response = client.get("/api/schedule/rounds", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_rounds_endpoint_lists_rounds_in_order_with_their_settings(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "12:00"}])
    assert schedule(client, session_id, [("practice", 1, 150), ("qualification", 2, 240)]).status_code == 201
    body = _rounds(client, session_id)
    assert body["session_last_cycle_time_seconds"] == 240
    practice, qualification = body["rounds"]
    assert practice == {
        "round_type": "practice",
        "target_matches_per_team": 1,
        "cycle_time_seconds": 150,
        "match_count": 2,
        "scored_count": 0,
        "first_start": "2026-11-07T17:00:00Z",
        "last_end": "2026-11-07T17:04:30Z",
        "locked": False,
        "outside_playing_windows": False,
    }
    assert qualification["round_type"] == "qualification"
    assert qualification["cycle_time_seconds"] == 240


def test_a_scored_round_and_every_round_before_it_are_locked(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    _score_one_match(client, session_id, "qualification")
    practice, qualification = _rounds(client, session_id)["rounds"]
    assert qualification["scored_count"] == 1 and qualification["locked"] is True
    assert practice["scored_count"] == 0 and practice["locked"] is True


def test_rounds_after_a_scored_round_stay_unlocked(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    _score_one_match(client, session_id, "practice")
    practice, qualification = _rounds(client, session_id)["rounds"]
    assert practice["locked"] is True
    assert qualification["locked"] is False


def test_a_round_outside_new_playing_times_is_flagged(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "12:00"}])
    assert schedule(client, session_id, [("practice", 1)]).status_code == 201
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "13:00", "end_time": "17:00"}])
    assert _rounds(client, session_id)["rounds"][0]["outside_playing_windows"] is True


def test_rounds_endpoint_uses_the_no_division_scope_in_a_single_division_event(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1)]).status_code == 201
    assert [r["round_type"] for r in _rounds(client, session_id)["rounds"]] == ["practice"]


def test_rounds_endpoint_with_nothing_scheduled(client):
    session_id, _ = _setup_ready_session(client)
    assert _rounds(client, session_id) == {"rounds": [], "session_last_cycle_time_seconds": None}
