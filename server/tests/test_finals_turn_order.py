"""Best-of series within a round take turns: game k of every undecided
series is played before game k+1 of any, because Match Control's next match
is the lowest match id and finals games carry no scheduled time."""

from test_finals import (
    _rank_teams_directly_head_to_head,
    _setup_ranked_teams_for_example_game,
)

ROUND_NAMES = {1: "SF", 2: "F"}


def _start_four_alliance_bracket(client, wins_to_advance):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)
    response = client.post(
        "/api/finals/start",
        json={
            "session_id": session_id,
            "bracket_size": 4,
            "alliance_selection": "seed_pairing",
            "wins_to_advance": wins_to_advance,
        },
    )
    assert response.status_code == 201, response.text
    return session_id, response.json()


def _score(client, game, outcome):
    """outcome is 'red', 'blue' or 'tie'."""
    red = next(a for a in game["alliances"] if a["station"] == "red")
    blue = next(a for a in game["alliances"] if a["station"] == "blue")
    balls = {"red": (10, 0), "blue": (0, 10), "tie": (0, 0)}[outcome]
    for alliance, high in ((red, balls[0]), (blue, balls[1])):
        response = client.post(
            f"/api/matches/{game['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": high, "low_balls": 0, "auto_winner": "tie"}},
        )
        assert response.status_code in (200, 201), response.text


def _play_out(client, session_id, bracket, outcome_for):
    """Repeatedly plays the lowest-id unscored finals game, the way Match
    Control picks its next match. Returns the labels in play order."""
    matchups = {m["id"]: m for m in bracket["matchups"]}
    played = []
    for _ in range(40):
        games = [
            m
            for m in client.get(f"/api/matches?session_id={session_id}").json()
            if m["round_type"] == "elimination" and m["status"] != "completed"
        ]
        if not games:
            break
        game = min(games, key=lambda m: m["id"])
        matchup = matchups[game["bracket_matchup_id"]]
        label = (
            f"{ROUND_NAMES[matchup['round_number']]}"
            f"{matchup['position'] + 1 if matchup['round_number'] == 1 else ''}"
            f"-G{game['match_number']}"
        )
        played.append(label)
        _score(client, game, outcome_for(label))
    return played


def test_best_of_series_take_turns_within_a_round(client):
    session_id, bracket = _start_four_alliance_bracket(client, [2, 2])
    played = _play_out(client, session_id, bracket, lambda label: "red")
    assert played == ["SF1-G1", "SF2-G1", "SF1-G2", "SF2-G2", "F-G1", "F-G2"]


def test_tied_game_adds_a_turn(client):
    session_id, bracket = _start_four_alliance_bracket(client, [2, 2])
    outcomes = {"SF1-G1": "tie"}
    played = _play_out(
        client, session_id, bracket, lambda label: outcomes.get(label, "red")
    )
    assert played[:5] == ["SF1-G1", "SF2-G1", "SF1-G2", "SF2-G2", "SF1-G3"]
    # SF1 needs two wins: the tie replays, so it ends after G3.
    assert "SF1-G4" not in played


def test_last_open_series_plays_back_to_back(client):
    session_id, bracket = _start_four_alliance_bracket(client, [2, 2])
    outcomes = {"SF1-G2": "blue"}
    played = _play_out(
        client, session_id, bracket, lambda label: outcomes.get(label, "red")
    )
    assert played[:5] == ["SF1-G1", "SF2-G1", "SF1-G2", "SF2-G2", "SF1-G3"]
