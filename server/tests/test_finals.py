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


def _setup_ranked_teams_for_example_game(client, count: int) -> tuple[int, list[int]]:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        for i in range(count)
    ]
    # example-game is captain_pick, which now requires 2 * bracket_size teams
    # checked into the session before /api/finals/start will even form a
    # bracket, so every caller of this helper needs its teams checked in.
    for team_id in team_ids:
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    return session_id, team_ids


def _rank_teams_directly_head_to_head(client, session_id: int, team_ids: list[int]) -> None:
    # Pairs teams into single-team-per-alliance qualification matches (the
    # same pattern the existing captain-pick tests already use against
    # example-game) so every team ends up with a Ranking row. The exact
    # win/loss pattern doesn't matter for this plan's tests, which only
    # assert on counts (how many byes, how many real games) — never on
    # which specific team ends up holding which seed.
    match_number = 1000
    for i in range(0, len(team_ids) - 1, 2):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": match_number,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[i]]},
                    {"station": "blue", "team_ids": [team_ids[i + 1]]},
                ],
            },
        ).json()
        match_number += 1
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
    if len(team_ids) % 2 == 1:
        # Odd count: give the last team a match of its own too (reusing an
        # already-ranked team as its opponent) so it still gets a Ranking row.
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": match_number,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[-1]]},
                    {"station": "blue", "team_ids": [team_ids[0]]},
                ],
            },
        ).json()
        red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red_id}/score",
            json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
        )
        client.post(
            f"/api/matches/{match['id']}/alliances/{blue_id}/score",
            json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
        )


def test_start_finals_single_elimination_accepts_wins_to_advance_list(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": [1, 2]},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "selecting_alliances"
    assert body["wins_to_advance"] == [1, 2]


def test_start_finals_rejects_wrong_length_wins_to_advance_list(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": [1, 1, 1]},
    )
    assert response.status_code == 422


def test_generate_bracket_resolves_byes_and_seeds_pairs_correctly(client):
    # example-game is captain_pick + single_elimination. 5 captains means 5
    # alliances once every captain has picked a partner from the remaining
    # 5 teams (10 teams total). capacity = 8 for bracket_size=5, giving 3
    # round-1 byes and 1 real round-1 game.
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 10)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 5, "wins_to_advance": 1},
    ).json()
    assert bracket["status"] == "selecting_alliances"
    assert len(bracket["alliances"]) == 5

    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    final_body = final_response.json()
    assert final_body["status"] == "in_progress"

    matchups = final_body["matchups"]
    assert len(matchups) == 7  # capacity 8 -> 4 round-1 + 2 round-2 + 1 final
    round_1 = [m for m in matchups if m["round_number"] == 1]
    assert len(round_1) == 4
    decided_byes = [m for m in round_1 if m["winner_alliance_id"] is not None]
    assert len(decided_byes) == 3

    real_game_matchup = next(m for m in round_1 if m["winner_alliance_id"] is None)
    assert real_game_matchup["alliance_a_id"] is not None
    assert real_game_matchup["alliance_b_id"] is not None

    games_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games = [m for m in games_response.json() if m["round_type"] == "elimination"]
    # Round-1 produces exactly 1 real game (4v5, asserted above via
    # real_game_matchup). But with byes going to seeds 1, 2 and 3 (seeds 6-8
    # don't exist), round-2 slot 1 is fed by *two* round-1 byes (seed 2 and
    # seed 3 both advance without playing), so that round-2 matchup already
    # has both alliances known at generation time and is immediately
    # playable too — a legitimate cascade, not a bug. Hence 2 real games
    # total, not 1.
    assert len(finals_games) == 2


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
    for team_id in team_ids:
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
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
    for team_id in team_ids:
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
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
    for team_id in team_ids:
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
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


def _setup_and_start_score_chase(client, scores: list[int]):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(len(scores) * 2)
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
            json={"data": {"objects_scored": (len(team_ids) - i) * 10}},
        )

    bracket = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": len(scores)}
    ).json()
    return bracket


def test_score_chase_progression_creates_runs_in_worst_to_best_order(cooperative_client):
    client = cooperative_client
    bracket = _setup_and_start_score_chase(client, [1, 2])

    assert len(bracket["runs"]) == 1
    worst_seed_alliance_id = bracket["alliances"][-1]["id"]
    assert bracket["runs"][0]["bracket_alliance_id"] == worst_seed_alliance_id

    first_run_match_id = bracket["runs"][0]["match_id"]
    first_run_alliance_id = client.get(f"/api/matches/{first_run_match_id}").json()["alliances"][0]["id"]
    client.post(
        f"/api/matches/{first_run_match_id}/alliances/{first_run_alliance_id}/score",
        json={"data": {"objects_scored": 5}},
    )

    updated = client.get(f"/api/finals/{bracket['id']}").json()
    assert len(updated["runs"]) == 2
    best_seed_alliance_id = updated["alliances"][0]["id"]
    assert updated["runs"][1]["bracket_alliance_id"] == best_seed_alliance_id
    assert updated["status"] == "in_progress"


def test_score_chase_completes_after_the_last_run_and_ranks_by_score(cooperative_client):
    client = cooperative_client
    bracket = _setup_and_start_score_chase(client, [1, 2])

    first_run_match_id = bracket["runs"][0]["match_id"]
    first_run_alliance_id = client.get(f"/api/matches/{first_run_match_id}").json()["alliances"][0]["id"]
    client.post(
        f"/api/matches/{first_run_match_id}/alliances/{first_run_alliance_id}/score",
        json={"data": {"objects_scored": 5}},
    )

    updated = client.get(f"/api/finals/{bracket['id']}").json()
    second_run_match_id = updated["runs"][1]["match_id"]
    second_run_alliance_id = client.get(f"/api/matches/{second_run_match_id}").json()["alliances"][0]["id"]
    client.post(
        f"/api/matches/{second_run_match_id}/alliances/{second_run_alliance_id}/score",
        json={"data": {"objects_scored": 20}},
    )

    final = client.get(f"/api/finals/{bracket['id']}").json()
    assert final["status"] == "complete"
    assert len(final["results"]) == 2
    assert final["results"][0]["score"] == 40
    assert final["results"][0]["rank"] == 1
    assert final["results"][1]["score"] == 10
    assert final["results"][1]["rank"] == 2


def test_finals_matches_are_excluded_from_qualification_rankings(cooperative_client):
    client = cooperative_client
    bracket = _setup_and_start_score_chase(client, [1, 2])
    session_id = bracket["session_id"]

    before = client.get(f"/api/rankings?session_id={session_id}").json()
    total_matches_before = {row["team_id"]: row["matches_played"] for row in before}

    first_run_match_id = bracket["runs"][0]["match_id"]
    first_run_alliance_id = client.get(f"/api/matches/{first_run_match_id}").json()["alliances"][0]["id"]
    client.post(
        f"/api/matches/{first_run_match_id}/alliances/{first_run_alliance_id}/score",
        json={"data": {"objects_scored": 5}},
    )

    after = client.get(f"/api/rankings?session_id={session_id}").json()
    total_matches_after = {row["team_id"]: row["matches_played"] for row in after}
    assert total_matches_after == total_matches_before


def test_start_finals_rejects_empty_field_set(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    empty_field_set = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Empty Set"}
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

    response = client.post(
        "/api/finals/start",
        json={
            "session_id": session_id,
            "bracket_size": 2,
            "field_set_id": empty_field_set["id"],
        },
    )
    assert response.status_code == 422


def test_resubmitting_a_completed_run_does_not_create_an_extra_run(cooperative_client):
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
    first_run_match_id = bracket["runs"][0]["match_id"]
    first_run_alliance_id = client.get(f"/api/matches/{first_run_match_id}").json()["alliances"][0]["id"]
    client.post(
        f"/api/matches/{first_run_match_id}/alliances/{first_run_alliance_id}/score",
        json={"data": {"objects_scored": 5}},
    )

    after_first_score = client.get(f"/api/finals/{bracket['id']}").json()
    assert len(after_first_score["runs"]) == 2

    # Resubmit a correction to the first (already-completed) run.
    client.post(
        f"/api/matches/{first_run_match_id}/alliances/{first_run_alliance_id}/score",
        json={"data": {"objects_scored": 7}},
    )

    after_resubmit = client.get(f"/api/finals/{bracket['id']}").json()
    assert len(after_resubmit["runs"]) == 2
    # cooperative-game's calculate_score doubles objects_scored.
    assert after_resubmit["runs"][0]["score"] == 14


def _score_matchup_game(client, session_id: int, matchup_id: int, red_score: int, blue_score: int):
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    game = next(
        m for m in matches_response.json()
        if m.get("status") != "completed"
        and any(a["station"] == "red" for a in m["alliances"])
        and m["round_type"] == "elimination"
    )
    red_id = next(a["id"] for a in game["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in game["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{game['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": red_score, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{game['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": blue_score, "low_balls": 0, "auto_winner": "tie"}},
    )


def test_single_elimination_full_4_alliance_bracket_traced_end_to_end(client):
    # bracket_size=4, capacity=4, no byes: 2 round-1 games, 1 final.
    # wins_to_advance=[1, 2]: round 1 is single-game, the final is best-of-3.
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": [1, 2]},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    bracket = final_response.json()
    assert bracket["status"] == "in_progress"
    assert len(bracket["matchups"]) == 3  # 2 round-1 + 1 final

    matches_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games = [m for m in matches_response.json() if m["round_type"] == "elimination"]
    assert len(finals_games) == 2  # both round-1 games created immediately (no byes)

    # Round 1, matchup 0: red wins 10-0 (decides the series, wins_to_advance[0]=1).
    _score_matchup_game(client, session_id, None, red_score=10, blue_score=0)
    # Round 1, matchup 1: red wins 10-0.
    _score_matchup_game(client, session_id, None, red_score=10, blue_score=0)

    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    final_matchup = next(m for m in bracket["matchups"] if m["round_number"] == 2)
    assert final_matchup["alliance_a_id"] is not None
    assert final_matchup["alliance_b_id"] is not None

    matches_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games = [m for m in matches_response.json() if m["round_type"] == "elimination"]
    assert len(finals_games) == 3  # the final's first game was created immediately

    # Final, game 1: a tie — doesn't count toward either side's series win.
    _score_matchup_game(client, session_id, None, red_score=5, blue_score=5)
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games = [m for m in matches_response.json() if m["round_type"] == "elimination"]
    assert len(finals_games) == 4  # an extra game was generated after the tie

    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    assert bracket["status"] == "in_progress"  # still not decided after the tie

    # Final, game 2: red wins (1 win so far, needs 2).
    _score_matchup_game(client, session_id, None, red_score=10, blue_score=0)
    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    assert bracket["status"] == "in_progress"

    # Final, game 3: red wins again (2 wins, reaches wins_to_advance[1]=2).
    _score_matchup_game(client, session_id, None, red_score=10, blue_score=0)
    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    assert bracket["status"] == "complete"
    final_matchup = next(m for m in bracket["matchups"] if m["round_number"] == 2)
    assert final_matchup["winner_alliance_id"] is not None


def test_resubmitting_a_decided_matchups_game_does_not_re_decide_it(client):
    # Mirrors test_resubmitting_a_completed_run_does_not_create_an_extra_run's
    # score-chase resubmission-safety check, but for single-elimination:
    # advance_single_elimination's first guard ("matchup.winner_alliance_id
    # is not None") must make a post-hoc correction to an already-decided
    # matchup's completed game a no-op — it must not re-decide the matchup,
    # touch its advanced winner, or spawn an extra game.
    #
    # Critically, the resubmitted score below FLIPS what the winner would be
    # if the guard were missing and the code recomputed from scratch (red's
    # 10-0 win becomes a 0-10 loss). A test that merely resubmits a *bigger*
    # win for the same side can't tell "guard worked" from "guard was never
    # there" — this one can.
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": [1, 2]},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    bracket = final_response.json()

    matches_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games = [m for m in matches_response.json() if m["round_type"] == "elimination"]
    assert len(finals_games) == 2  # both round-1 games created immediately (no byes)

    # Decide one round-1 matchup outright: red wins 10-0 (wins_to_advance[0]=1).
    game = next(m for m in finals_games if any(a["station"] == "red" for a in m["alliances"]))
    red_id = next(a["id"] for a in game["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in game["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{game['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{game['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    decided_matchup = next(
        m for m in bracket["matchups"] if m["round_number"] == 1 and m["winner_alliance_id"] is not None
    )
    red_alliance_id = decided_matchup["winner_alliance_id"]  # red is the side that just won

    final_matchup = next(m for m in bracket["matchups"] if m["round_number"] == 2)
    assert red_alliance_id in (final_matchup["alliance_a_id"], final_matchup["alliance_b_id"])

    matches_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games_after_decision = [
        m for m in matches_response.json() if m["round_type"] == "elimination"
    ]
    assert len(finals_games_after_decision) == 2  # no extra game created for the decided matchup;
    # the final isn't created yet since its other side is still unknown.

    # Resubmit a correction to that SAME already-completed game — but this
    # time favoring blue instead. If the guard is doing its job, this must
    # have NO effect: red must remain the recorded winner.
    #
    # The two POSTs below are ordered/valued so blue is strictly ahead after
    # EACH individual post (blue's score is raised to 15 — i.e. 45 points
    # under example-game's high_balls*3 formula, beating red's original 30 —
    # before red's score is then lowered to 0). This avoids ever passing
    # through a tied intermediate state, which would itself spawn a spurious
    # extra game and mask whether the winner really got recomputed. With the
    # guard removed, this ordering deterministically flips the recorded
    # winner straight to blue; with the guard present, neither post has any
    # effect at all.
    client.post(
        f"/api/matches/{game['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 15, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{game['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    decided_matchup_after_resubmit = next(
        m for m in bracket["matchups"] if m["id"] == decided_matchup["id"]
    )
    # Unchanged, NOT flipped to blue — proves the guard actually fired.
    assert decided_matchup_after_resubmit["winner_alliance_id"] == red_alliance_id

    final_matchup_after_resubmit = next(m for m in bracket["matchups"] if m["round_number"] == 2)
    assert red_alliance_id in (
        final_matchup_after_resubmit["alliance_a_id"],
        final_matchup_after_resubmit["alliance_b_id"],
    )

    matches_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games_after_resubmit = [
        m for m in matches_response.json() if m["round_type"] == "elimination"
    ]
    assert len(finals_games_after_resubmit) == 2  # still no extra game created


def test_start_finals_rejects_insufficient_checked_in_teams_for_captain_pick(captain_pick_client):
    client = captain_pick_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "captain-pick-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    # Only check in 3 of the 4 teams a bracket_size=2 captain_pick bracket needs.
    for team_id in team_ids[:3]:
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

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

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": 2},
    )
    assert response.status_code == 422


def test_unavailable_alliance_with_known_opponent_resolves_immediately(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": 1},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    bracket = final_response.json()
    round_1_matchup = bracket["matchups"][0]
    alliance_to_forfeit = round_1_matchup["alliance_b_id"]

    response = client.post(
        f"/api/finals/{bracket['id']}/alliances/{alliance_to_forfeit}/unavailable"
    )
    assert response.status_code == 200
    body = response.json()
    decided_matchup = next(m for m in body["matchups"] if m["id"] == round_1_matchup["id"])
    assert decided_matchup["winner_alliance_id"] == round_1_matchup["alliance_a_id"]


def test_unavailable_alliance_waiting_on_earlier_round_resolves_later(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 10)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 5, "wins_to_advance": 1},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    bracket = final_response.json()
    round_1 = [m for m in bracket["matchups"] if m["round_number"] == 1]
    bye_matchup = next(m for m in round_1 if m["winner_alliance_id"] is not None)
    real_game_matchup = next(m for m in round_1 if m["winner_alliance_id"] is None)

    # bye_matchup's winner is already sitting in round 2, waiting on
    # real_game_matchup's still-unplayed result. Mark that winner
    # unavailable now — its round-2 matchup has only one side known, so
    # nothing resolves yet.
    response = client.post(
        f"/api/finals/{bracket['id']}/alliances/{bye_matchup['winner_alliance_id']}/unavailable"
    )
    body = response.json()
    round_2_matchup = next(
        m for m in body["matchups"]
        if m["round_number"] == 2
        and (m["alliance_a_id"] == bye_matchup["winner_alliance_id"]
             or m["alliance_b_id"] == bye_matchup["winner_alliance_id"])
    )
    assert round_2_matchup["winner_alliance_id"] is None

    # Now play the still-pending round-1 real game — the moment its winner
    # is placed into round 2, the earlier unavailable flag resolves that
    # round-2 matchup as a walkover instead of creating a game for it.
    # Two incomplete elimination matches exist at this point (round-1
    # position 1's real game, and round-2 position 1's real game, both
    # created directly by generate_bracket since two round-1 byes feed
    # round-2 position 1 immediately). match_number is assigned as a
    # strictly-increasing per-bracket counter in the exact order
    # generate_bracket creates matches (round 1 before round 2), so the
    # lowest match_number deterministically identifies round-1's game
    # regardless of the API's response ordering.
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    pending_games = sorted(
        (
            m for m in matches_response.json()
            if m["round_type"] == "elimination" and m["status"] != "completed"
        ),
        key=lambda m: m["match_number"],
    )
    game = pending_games[0]
    red_id = next(a["id"] for a in game["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in game["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{game['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{game['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    round_2_matchup = next(m for m in bracket["matchups"] if m["id"] == round_2_matchup["id"])
    assert round_2_matchup["winner_alliance_id"] is not None
    assert round_2_matchup["winner_alliance_id"] != bye_matchup["winner_alliance_id"]


def test_unavailable_alliance_mid_series_resolves_walkover_without_extra_game(client):
    # Mid-series walkover: a wins_to_advance=[2, 2] (best-of-3 everywhere)
    # round-1 matchup that has already played and completed ONE game (red
    # wins, 1 win -- not yet enough to decide the series at wins_needed=2)
    # must still have `unavailable` resolve it immediately. This exercises
    # the check-ordering in `_maybe_create_matchup_game`: the `unavailable`
    # check has to run BEFORE the "is there an incomplete game already
    # scheduled for this matchup" check, because completing that first
    # (non-deciding) game already auto-schedules a follow-up game via
    # `advance_single_elimination`'s "winner_id is None -> create another
    # game" branch -- exactly the kind of "incomplete game" that would
    # otherwise block a naive re-ordering of these two checks.
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": [2, 2]},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    bracket = final_response.json()
    round_1_matchup = bracket["matchups"][0]  # round 1, position 0

    # match_number is a strictly-increasing per-bracket counter assigned in
    # creation order; generate_bracket creates round-1 position 0's game
    # before position 1's (both created immediately here since bracket_size
    # == capacity == 4, so there are no byes), so match_number 1 always
    # belongs to round_1_matchup regardless of the API's response order.
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    elimination_matches = [
        m for m in matches_response.json() if m["round_type"] == "elimination"
    ]
    assert len(elimination_matches) == 2  # both round-1 games created immediately
    game_1 = next(m for m in elimination_matches if m["match_number"] == 1)
    red_id = next(a["id"] for a in game_1["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in game_1["alliances"] if a["station"] == "blue")

    # Play ONE game of that series: red wins 10-0 -> 1 win, not enough
    # (wins_needed=2).
    client.post(
        f"/api/matches/{game_1['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{game_1['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket_after_game_1 = client.get(f"/api/finals/{bracket['id']}").json()
    matchup_after_game_1 = next(
        m for m in bracket_after_game_1["matchups"] if m["id"] == round_1_matchup["id"]
    )
    assert matchup_after_game_1["winner_alliance_id"] is None  # series not yet decided

    # Completing that non-deciding game already auto-scheduled a follow-up
    # game for the same matchup (ordinary best-of-N continuation) -- confirm
    # it's there before the walkover, so the count-unchanged assertion below
    # is actually meaningful and not vacuously true.
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    elimination_matches = [
        m for m in matches_response.json() if m["round_type"] == "elimination"
    ]
    assert len(elimination_matches) == 3  # matchup 0's follow-up game auto-created
    games_before_unavailable = len(elimination_matches)

    # Now mark the losing alliance (blue) unavailable. Even though a second,
    # unplayed game for this series already exists, the unavailable check
    # must take priority and decide the matchup for red immediately -- not
    # silently defer just because "an incomplete game exists for this
    # matchup".
    response = client.post(
        f"/api/finals/{bracket['id']}/alliances/{round_1_matchup['alliance_b_id']}/unavailable"
    )
    assert response.status_code == 200
    body = response.json()
    decided_matchup = next(m for m in body["matchups"] if m["id"] == round_1_matchup["id"])
    assert decided_matchup["winner_alliance_id"] == round_1_matchup["alliance_a_id"]

    # And no additional (third) game was created for this matchup as a side
    # effect of resolving the walkover.
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    elimination_matches_after = [
        m for m in matches_response.json() if m["round_type"] == "elimination"
    ]
    assert len(elimination_matches_after) == games_before_unavailable
