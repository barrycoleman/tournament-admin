from sqlalchemy import select

from test_finals import (
    _rank_teams_directly,
    _rank_teams_directly_head_to_head,
    _setup_ranked_teams,
    _setup_ranked_teams_for_example_game,
)
from tournament_server.services.finals import auto_pairs


def test_auto_pairs_knockout_odd_drops_lowest():
    pairs = auto_pairs(list(range(1, 32)), "single_elimination")
    assert len(pairs) == 15
    assert pairs[0] == (1, 2)
    assert pairs[-1] == (29, 30)
    assert all(31 not in pair for pair in pairs)


def test_auto_pairs_score_chase_odd_second_lowest_twice():
    pairs = auto_pairs(list(range(1, 32)), "score_chase")
    assert len(pairs) == 16
    assert pairs[0] == (1, 2)
    assert pairs[-2] == (29, 30)
    assert pairs[-1] == (30, 31)


def test_auto_pairs_score_chase_even():
    pairs = auto_pairs(list(range(1, 31)), "score_chase")
    assert len(pairs) == 15
    assert pairs[0] == (1, 2)
    assert pairs[-1] == (29, 30)


def _ranked(client, count):
    session_id, team_ids = _setup_ranked_teams(client, count)
    _rank_teams_directly(client, session_id, team_ids)
    return session_id, team_ids


def test_start_score_chase_with_odd_team_count_runs_worst_pair_first(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 5)
    response = client.post(
        "/api/finals/start", json={"session_id": session_id, "team_count": 5}
    )
    assert response.status_code == 201, response.text
    bracket = response.json()
    assert bracket["bracket_size"] == 3
    assert len(bracket["alliances"]) == 3
    appearances = [t for a in bracket["alliances"] for t in a["team_ids"]]
    assert appearances.count(team_ids[3]) == 2
    assert len(bracket["runs"]) == 1
    match = client.get(f"/api/matches/{bracket['runs'][0]['match_id']}").json()
    run_teams = {t for a in match["alliances"] for t in a["team_ids"]}
    assert run_teams == {team_ids[3], team_ids[4]}


def test_start_knockout_auto_pairs_odd_count(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 7)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)
    response = client.post(
        "/api/finals/start",
        json={
            "session_id": session_id,
            "team_count": 7,
            "alliance_selection": "seed_pairing",
            "wins_to_advance": 1,
        },
    )
    assert response.status_code == 201, response.text
    alliances = response.json()["alliances"]
    assert len(alliances) == 3
    in_alliances = {t for a in alliances for t in a["team_ids"]}
    assert len(in_alliances) == 6


def test_alliance_selection_override_and_default(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)
    default = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "team_count": 8, "wins_to_advance": 1},
    )
    assert default.status_code == 201, default.text
    assert default.json()["alliance_selection"] == "captain_pick"
    assert default.json()["status"] == "selecting_alliances"
    assert client.delete(f"/api/finals/{default.json()['id']}").status_code == 204
    forced = client.post(
        "/api/finals/start",
        json={
            "session_id": session_id,
            "team_count": 8,
            "alliance_selection": "seed_pairing",
            "wins_to_advance": 1,
        },
    )
    assert forced.status_code == 201, forced.text
    assert forced.json()["alliance_selection"] == "seed_pairing"
    assert forced.json()["status"] == "in_progress"
    assert len(forced.json()["alliances"]) == 4


def test_captain_pick_rejects_odd_team_count(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 7)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)
    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "team_count": 7, "wins_to_advance": 1},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "Partner picking needs an even number of teams."


def test_field_subset_rotation(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 6)
    fields = [
        client.post("/api/fields", json={"session_id": session_id, "name": f"Extra {i}"}).json()
        for i in range(2)
    ]
    all_fields = client.get("/api/fields", params={"session_id": session_id}).json()
    ids = sorted(f["id"] for f in all_fields)
    assert len(ids) == 3
    chosen = [ids[0], ids[2]]
    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "team_count": 6, "field_ids": chosen},
    )
    assert response.status_code == 201, response.text
    bracket = response.json()
    assert bracket["field_ids"] == chosen
    seen = []
    for _ in range(3):
        runs = bracket["runs"]
        run = runs[-1]
        match = client.get(f"/api/matches/{run['match_id']}").json()
        seen.append(match["field_id"])
        alliance_id = match["alliances"][0]["id"]
        scored = client.post(
            f"/api/matches/{match['id']}/alliances/{alliance_id}/score",
            json={"data": {"objects_scored": 5}},
        )
        assert scored.status_code in (200, 201), scored.text
        bracket = client.get(f"/api/finals/{bracket['id']}").json()
    assert seen == [ids[0], ids[2], ids[0]]


def test_field_subset_rejects_foreign_field(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 4)
    other_session = client.post("/api/sessions", json={"label": "Session 2"}).json()["id"]
    foreign = client.post("/api/fields", json={"session_id": other_session, "name": "Other"}).json()
    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "team_count": 4, "field_ids": [foreign["id"]]},
    )
    assert response.status_code == 422
    empty = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "team_count": 4, "field_ids": []},
    )
    assert empty.status_code == 422


def test_bracket_size_and_team_count_are_exclusive(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 4)
    both = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "team_count": 4},
    )
    assert both.status_code == 422
    neither = client.post("/api/finals/start", json={"session_id": session_id})
    assert neither.status_code == 422
    too_few = client.post("/api/finals/start", json={"session_id": session_id, "team_count": 1})
    assert too_few.status_code == 422
