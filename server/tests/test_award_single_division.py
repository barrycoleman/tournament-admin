"""Division-scoped performance awards in a single-division event, where the
schedule, rankings and finals carry no division id but the award slot is the
event's one real division."""
from __future__ import annotations

from ranking_helpers import finalize_qualification

CHAMPION = {
    "name": "Teamwork Champion", "kind": "performance", "scope": "division",
    "source": "teamwork_ranking", "basis": "session", "placement": 1,
}
FINALS_WINNER = {
    "name": "Finals Winner", "kind": "performance", "scope": "division",
    "source": "finals", "basis": "session", "placement": 1,
}


def _setup(client, count: int = 8) -> tuple[int, int, list[int]]:
    """An example-game event with only its default division, a session with
    a field, and `count` teams checked in."""
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    divisions = client.get("/api/divisions").json()
    assert len(divisions) == 1
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    team_ids = []
    for n in range(1, count + 1):
        team = client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()
        assert team["division_id"] == divisions[0]["id"]
        team_ids.append(team["id"])
        client.post(f"/api/sessions/{session_id}/participants", json={"team_id": team["id"], "checked_in": True})
    return divisions[0]["id"], session_id, team_ids


def _play(client, session_id: int, match_number: int, winner: int, loser: int) -> None:
    """A qualification match scheduled with no division id, as the admin UI
    does in a single-division event; `winner` scores 10, `loser` 0."""
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id, "round_type": "qualification", "match_number": match_number,
            "field_id": None,
            "alliances": [{"station": "red", "team_ids": [winner]}, {"station": "blue", "team_ids": [loser]}],
        },
    ).json()
    assert match["division_id"] is None
    for alliance in match["alliances"]:
        high = 10 if alliance["station"] == "red" else 0
        response = client.post(
            f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": high, "low_balls": 0, "auto_winner": "tie"}},
        )
        assert response.status_code == 200, response.text


def _slot(client, session_id: int, award_id: int) -> dict:
    award = next(a for a in client.get(f"/api/sessions/{session_id}/awards").json()["awards"] if a["id"] == award_id)
    assert len(award["slots"]) == 1
    return award["slots"][0]


def test_teamwork_ranking_resolves_in_a_single_division_event(client):
    division_id, session_id, team_ids = _setup(client, 2)
    _play(client, session_id, 1, team_ids[0], team_ids[1])

    session_award = client.post(f"/api/sessions/{session_id}/awards", json=CHAMPION).json()
    season_award = client.post(
        f"/api/sessions/{session_id}/awards", json={**CHAMPION, "name": "Season Champion", "basis": "season"}
    ).json()

    for award in (session_award, season_award):
        slot = _slot(client, session_id, award["id"])
        assert slot["division_id"] == division_id
        assert slot["status"] == "resolved"
        assert [w["team_id"] for w in slot["winners"]] == [team_ids[0]]


def test_finals_award_resolves_for_a_bracket_started_with_no_division(client):
    division_id, session_id, team_ids = _setup(client, 8)
    for i in range(0, 8, 2):
        _play(client, session_id, 1 + i, team_ids[i], team_ids[i + 1])
    finalize_qualification(client, session_id)

    bracket = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": 1}
    ).json()
    assert bracket["division_id"] is None
    claimed = {t for alliance in bracket["alliances"] for t in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    for i, alliance in enumerate(bracket["alliances"]):
        response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={"captain_bracket_alliance_id": alliance["id"], "partner_team_id": unclaimed[i]},
        )
        assert response.status_code == 200, response.text
    game = next(
        m for m in client.get(f"/api/matches?session_id={session_id}").json() if m["round_type"] == "elimination"
    )
    for alliance in game["alliances"]:
        high = 10 if alliance["station"] == "red" else 0
        client.post(
            f"/api/matches/{game['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": high, "low_balls": 0, "auto_winner": "tie"}},
        )
    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    assert bracket["status"] == "complete"
    final = bracket["matchups"][0]
    champions = next(a for a in bracket["alliances"] if a["id"] == final["winner_alliance_id"])

    award = client.post(f"/api/sessions/{session_id}/awards", json=FINALS_WINNER).json()
    slot = _slot(client, session_id, award["id"])
    assert slot["division_id"] == division_id
    assert slot["status"] == "resolved"
    assert sorted(w["team_id"] for w in slot["winners"]) == sorted(champions["team_ids"])
