from test_finals import (
    _rank_teams_directly_head_to_head,
    _setup_and_start_score_chase,
    _setup_ranked_teams_for_example_game,
)


def _start_two_alliance_bracket(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 4)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)
    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": [1]},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    for i, alliance in enumerate(bracket["alliances"]):
        bracket = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={"captain_bracket_alliance_id": alliance["id"], "partner_team_id": unclaimed[i]},
        ).json()
    assert bracket["status"] == "in_progress"
    return session_id, bracket


def _play_final(client, session_id, red_high_balls, blue_high_balls, red_flag):
    game = next(
        m for m in client.get(f"/api/matches?session_id={session_id}").json()
        if m["round_type"] == "elimination" and m["status"] != "completed"
    )
    red = next(a for a in game["alliances"] if a["station"] == "red")
    blue = next(a for a in game["alliances"] if a["station"] == "blue")
    flag = {"team_id": red["team_ids"][0], red_flag: True}
    for alliance, high_balls, teams in ((red, red_high_balls, [flag]), (blue, blue_high_balls, [])):
        response = client.post(
            f"/api/matches/{game['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": high_balls, "low_balls": 0, "auto_winner": "tie"}, "teams": teams},
        )
        assert response.status_code == 200, response.text


def _winner(client, bracket):
    final = client.get(f"/api/finals/{bracket['id']}").json()
    assert final["status"] == "complete"
    return final["matchups"][0]["winner_alliance_id"], final["matchups"][0]


def test_one_dq_zeroes_the_finals_alliance_and_loses_the_game(client):
    session_id, bracket = _start_two_alliance_bracket(client)
    _play_final(client, session_id, red_high_balls=10, blue_high_balls=1, red_flag="dq")
    winner, matchup = _winner(client, bracket)
    assert winner == matchup["alliance_b_id"]  # blue: red scored 0 against 3


def test_one_no_show_is_carried_and_the_alliance_still_wins(client):
    session_id, bracket = _start_two_alliance_bracket(client)
    _play_final(client, session_id, red_high_balls=10, blue_high_balls=1, red_flag="no_show")
    winner, matchup = _winner(client, bracket)
    assert winner == matchup["alliance_a_id"]  # red: 30 against 3


def _first_run(client, bracket):
    match_id = bracket["runs"][0]["match_id"]
    alliance = client.get(f"/api/matches/{match_id}").json()["alliances"][0]
    assert len(alliance["team_ids"]) == 2
    return f"/api/matches/{match_id}/alliances/{alliance['id']}/score", alliance["team_ids"]


def test_a_dq_in_a_score_chase_run_scores_zero(cooperative_client):
    bracket = _setup_and_start_score_chase(cooperative_client, [1, 2])
    path, team_ids = _first_run(cooperative_client, bracket)
    response = cooperative_client.post(
        path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": team_ids[0], "dq": True}]}
    )
    assert response.json()["computed_score"] == 0
    runs = cooperative_client.get(f"/api/finals/{bracket['id']}").json()["runs"]
    assert runs[0]["score"] == 0


def test_one_no_show_in_a_score_chase_run_keeps_the_score(cooperative_client):
    bracket = _setup_and_start_score_chase(cooperative_client, [1, 2])
    path, team_ids = _first_run(cooperative_client, bracket)
    response = cooperative_client.post(
        path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": team_ids[0], "no_show": True}]}
    )
    assert response.json()["computed_score"] == 10
    runs = cooperative_client.get(f"/api/finals/{bracket['id']}").json()["runs"]
    assert runs[0]["score"] == 10


def test_deleting_a_bracket_removes_its_flag_rows(cooperative_client):
    from sqlalchemy import func, select

    from tournament_server.models.score_record_team import ScoreRecordTeam

    bracket = _setup_and_start_score_chase(cooperative_client, [1, 2])
    path, team_ids = _first_run(cooperative_client, bracket)
    cooperative_client.post(path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": team_ids[0], "dq": True}]})
    assert cooperative_client.delete(f"/api/finals/{bracket['id']}").status_code == 204
    db = cooperative_client.app.state.session_factory()
    try:
        assert db.execute(select(func.count()).select_from(ScoreRecordTeam)).scalar_one() == 0
    finally:
        db.close()
