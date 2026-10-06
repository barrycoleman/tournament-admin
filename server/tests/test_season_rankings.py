from ranking_helpers import DEFAULT_SETTINGS


def _cooperative_event(client) -> tuple[int, int]:
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    return t1, t2


def _session(client, label: str) -> int:
    return client.post("/api/sessions", json={"label": label}).json()["id"]


def _match(client, session_id, number, red, blue, round_type="qualification", division_id=None) -> dict:
    body = {
        "session_id": session_id,
        "round_type": round_type,
        "match_number": number,
        "field_id": None,
        "alliances": [
            {"station": "red", "team_ids": [red]},
            {"station": "blue", "team_ids": [blue]},
        ],
    }
    if division_id is not None:
        body["division_id"] = division_id
    response = client.post("/api/matches", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _alliance(match: dict, station: str) -> int:
    return next(a["id"] for a in match["alliances"] if a["station"] == station)


def _score_cooperative(client, match: dict, objects: int, station: str = "red", **flags) -> None:
    response = client.post(
        f"/api/matches/{match['id']}/alliances/{_alliance(match, station)}/score",
        json={"data": {"objects_scored": objects}, **flags},
    )
    assert response.status_code == 200, response.text


def _put_settings(client, **changes) -> None:
    response = client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, **changes})
    assert response.status_code == 200, response.text


def _rows(client, **params) -> dict[int, dict]:
    return {row["team_id"]: row for row in client.get("/api/rankings", params=params).json()}


def test_tier_default_drops_nothing_until_the_last_scheduled_matches_are_scored(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1 = _session(client, "Session 1")
    matches = [_match(client, s1, n, t1, t2) for n in range(1, 5)]  # 4 scheduled: 1 drop
    for match, objects in zip(matches[:3], (5, 10, 15)):  # 10, 20, 30
        _score_cooperative(client, match, objects)
    assert _rows(client, session_id=s1)[t1]["average_score"] == 20.0

    _score_cooperative(client, matches[3], 20)  # 40; the 4th scored earns the drop
    row = _rows(client, session_id=s1)[t1]
    assert row["average_score"] == 30.0
    assert row["matches_played"] == 4


def test_lowest_p_counts_against_the_schedule_and_follows_an_extension(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1 = _session(client, "Session 1")
    _put_settings(client, session_drop_mode="lowest", session_drop_count=1)
    first, second = _match(client, s1, 1, t1, t2), _match(client, s1, 2, t1, t2)
    _score_cooperative(client, first, 5)  # 10
    _score_cooperative(client, second, 10)  # 20
    assert _rows(client, session_id=s1)[t1]["average_score"] == 20.0

    _match(client, s1, 3, t1, t2)  # scheduled, not yet scored
    _put_settings(client, session_drop_mode="lowest", session_drop_count=1)  # recompute
    assert _rows(client, session_id=s1)[t1]["average_score"] == 15.0


def test_lowest_p_never_drops_a_teams_last_match(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1 = _session(client, "Session 1")
    _put_settings(client, session_drop_mode="lowest", session_drop_count=3)
    _score_cooperative(client, _match(client, s1, 1, t1, t2), 10)
    assert _rows(client, session_id=s1)[t1]["average_score"] == 20.0


def test_dq_ruled_after_a_drop_was_earned_stays_counted(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1 = _session(client, "Session 1")
    _put_settings(client, session_drop_mode="lowest", session_drop_count=1)
    first, second = _match(client, s1, 1, t1, t2), _match(client, s1, 2, t1, t2)
    _score_cooperative(client, first, 5)  # 10
    _score_cooperative(client, second, 15)  # 30
    assert _rows(client, session_id=s1)[t1]["average_score"] == 30.0

    _score_cooperative(client, second, 15, dq=True)  # t1 is DQ'd in its 30-point match
    # The DQ zero can't be dropped, so the 10 is dropped instead.
    assert _rows(client, session_id=s1)[t1]["average_score"] == 0.0
    assert _rows(client, session_id=s1)[t2]["average_score"] == 30.0

    _put_settings(client, session_drop_mode="lowest", session_drop_count=1, session_drop_dq=True)
    assert _rows(client, session_id=s1)[t1]["average_score"] == 10.0


def test_season_keep_best_minimum_and_only_session_counted(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1, s2 = _session(client, "Session 1"), _session(client, "Session 2")
    for session_id, objects in ((s1, (5, 15)), (s2, (10, 20))):  # S1: 10, 30; S2: 20, 40
        for number, count in enumerate(objects, start=1):
            _score_cooperative(client, _match(client, session_id, number, t1, t2), count)

    settings = dict(
        session_drop_mode="lowest", session_drop_count=1,
        season_keep_best=4, season_minimum=4, season_only_session_counted=True,
    )
    _put_settings(client, **settings)
    assert _rows(client, session_id=s1)[t1]["average_score"] == 30.0
    season = _rows(client, event_wide="true")[t1]
    assert season["average_score"] == 17.5  # (30 + 40) / 4
    assert season["matches_played"] == 4
    assert season["session_id"] is None

    _put_settings(client, **{**settings, "season_only_session_counted": False})
    assert _rows(client, event_wide="true")[t1]["average_score"] == 25.0  # (10+20+30+40) / 4


def test_season_default_is_a_plain_average_and_ignores_practice(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1, s2 = _session(client, "Session 1"), _session(client, "Session 2")
    _score_cooperative(client, _match(client, s1, 1, t1, t2), 5)  # 10
    _score_cooperative(client, _match(client, s2, 1, t1, t2), 15)  # 30
    _score_cooperative(client, _match(client, s2, 2, t1, t2, round_type="practice"), 40)
    season = _rows(client, event_wide="true")[t1]
    assert season["average_score"] == 20.0
    assert season["matches_played"] == 2


def test_saving_settings_recomputes_every_division(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    rookie = client.post("/api/divisions", json={"name": "Rookie"}).json()["id"]
    open_ = client.post("/api/divisions", json={"name": "Open"}).json()["id"]
    teams = [client.post("/api/teams", json={"number": str(n), "name": f"T{n}"}).json()["id"] for n in range(1, 5)]
    s1 = _session(client, "Session 1")
    for division_id, (red, blue), objects in ((rookie, teams[:2], (5, 15)), (open_, teams[2:], (10, 20))):
        for number, count in enumerate(objects, start=1):
            match = _match(client, s1, number + (10 if division_id == open_ else 0), red, blue, division_id=division_id)
            _score_cooperative(client, match, count)
    assert _rows(client, session_id=s1, division_id=rookie)[teams[0]]["average_score"] == 20.0
    assert _rows(client, session_id=s1, division_id=open_)[teams[2]]["average_score"] == 30.0

    _put_settings(client, session_drop_mode="lowest", session_drop_count=1)
    assert _rows(client, session_id=s1, division_id=rookie)[teams[0]]["average_score"] == 30.0
    assert _rows(client, session_id=s1, division_id=open_)[teams[2]]["average_score"] == 40.0


def _score_head_to_head(client, match: dict, red_high: int, blue_high: int) -> None:
    for station, high in (("red", red_high), ("blue", blue_high)):
        response = client.post(
            f"/api/matches/{match['id']}/alliances/{_alliance(match, station)}/score",
            json={"data": {"high_balls": high, "low_balls": 0, "auto_winner": "tie"}},
        )
        assert response.status_code == 200, response.text


def test_head_to_head_season_totals_win_points_across_sessions(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    t1, t2, t3 = (
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in (1, 2, 3)
    )
    s1, s2 = _session(client, "Session 1"), _session(client, "Session 2")
    _score_head_to_head(client, _match(client, s1, 1, t1, t2), 16, 6)  # t1 wins
    _score_head_to_head(client, _match(client, s2, 1, t1, t2), 10, 10)  # tie
    _score_head_to_head(client, _match(client, s2, 2, t3, t2), 16, 6)  # t3 wins; t3 missed S1
    _score_head_to_head(client, _match(client, s2, 3, t2, t1, round_type="practice"), 20, 0)

    session = _rows(client, session_id=s1)
    assert (session[t1]["win_points"], session[t2]["win_points"]) == (2, 0)
    assert t3 not in session

    season = _rows(client, event_wide="true")
    assert {t: season[t]["win_points"] for t in (t1, t2, t3)} == {t1: 3, t2: 1, t3: 2}
    assert {t: season[t]["strength_of_schedule"] for t in (t1, t2, t3)} == {t1: 2.0, t2: 8.0, t3: 1.0}
    assert [season[t]["rank"] for t in (t1, t3, t2)] == [1, 2, 3]
    assert all(row["session_id"] is None for row in season.values())
