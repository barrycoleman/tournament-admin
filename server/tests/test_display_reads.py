from __future__ import annotations

import pytest

from device_helpers import paired_device
from display_helpers import add_field_set, add_match, add_teams, score_match, setup_event
from tournament_server.models.finals_bracket import FinalsBracket


@pytest.fixture
def scored(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    match = add_match(client, session_id, field_set["field_ids"][0], 1, add_teams(client))
    score_match(client, match, high_balls=(3, 1))
    display = paired_device(client, role="display_device")
    return {"session_id": session_id, "field_set": field_set, "match": match, "display": display}


def test_scores_list_each_alliances_effective_score_and_sheet(client, scored):
    rows = client.get(f"/api/scores?session_id={scored['session_id']}", headers=scored["display"]["headers"]).json()
    by_alliance = {row["alliance_id"]: row for row in rows}
    red, blue = scored["match"]["alliances"]
    assert by_alliance[red["id"]]["score"] == 9 and by_alliance[blue["id"]]["score"] == 3
    assert by_alliance[red["id"]]["match_id"] == scored["match"]["id"]
    assert by_alliance[red["id"]]["data"]["high_balls"] == 3
    assert by_alliance[red["id"]]["teams"] == [] and by_alliance[red["id"]]["saved_at"] is not None


def test_a_flagged_alliance_scores_zero_in_the_list(client, scored):
    red = scored["match"]["alliances"][0]
    flags = [{"team_id": t, "dq": True} for t in red["team_ids"]]
    client.post(
        f"/api/matches/{scored['match']['id']}/alliances/{red['id']}/score",
        json={"data": {"high_balls": 3, "low_balls": 0, "parked": False, "auto_winner": "tie"}, "teams": flags},
    )
    rows = client.get(f"/api/scores?session_id={scored['session_id']}").json()
    assert next(r for r in rows if r["alliance_id"] == red["id"])["score"] == 0


def test_finals_are_listed_newest_first_for_the_division(client, scored):
    division = client.get("/api/divisions").json()[0]["id"]
    with client.app.state.session_factory() as db:
        for division_id in (None, None, division):
            db.add(FinalsBracket(session_id=scored["session_id"], division_id=division_id,
                                 field_set_id=scored["field_set"]["id"], format="score_chase", bracket_size=2))
        db.commit()
    headers = scored["display"]["headers"]
    unscoped = client.get(f"/api/finals?session_id={scored['session_id']}", headers=headers).json()
    assert [b["division_id"] for b in unscoped] == [None, None] and unscoped[0]["id"] > unscoped[1]["id"]
    scoped = client.get(f"/api/finals?session_id={scored['session_id']}&division_id={division}", headers=headers).json()
    assert [b["division_id"] for b in scoped] == [division]


def test_the_scoresheet_schema_and_match_format_are_readable(client, scored):
    headers = scored["display"]["headers"]
    schema = client.get("/api/event/scoresheet-schema", headers=headers).json()
    assert [f["name"] for f in schema] == ["high_balls", "low_balls", "parked", "auto_winner"]
    match_format = client.get("/api/event/match-format", headers=headers).json()
    assert (match_format["game_model"], match_format["autonomous_seconds"], match_format["driver_seconds"]) == (
        "head_to_head", 15, 105,
    )


def test_matches_carry_their_finals_links(client, scored):
    match = client.get(f"/api/matches/{scored['match']['id']}").json()
    assert match["bracket_matchup_id"] is None and match["bracket_alliance_id"] is None


def test_reads_without_a_game_plugin_are_empty(client):
    session_id = setup_event(client, game=None)
    assert client.get(f"/api/scores?session_id={session_id}").json() == []
    assert client.get(f"/api/finals?session_id={session_id}").json() == []
    assert client.get("/api/event/scoresheet-schema").status_code == 422


def test_a_display_can_read_everything_a_screen_reads(client, scored):
    session_id = scored["session_id"]
    headers = scored["display"]["headers"]
    paths = [
        "/api/event", "/api/event/match-format", "/api/event/scoresheet-schema", "/api/divisions", "/api/teams",
        "/api/sessions",
        f"/api/matches?session_id={session_id}", f"/api/scores?session_id={session_id}",
        f"/api/field-sets?session_id={session_id}", f"/api/fields?session_id={session_id}",
        f"/api/rankings?session_id={session_id}", "/api/ranking-settings", "/api/skills/settings",
        f"/api/skills/rankings?tab=overall&session_id={session_id}",
        f"/api/sessions/{session_id}/skills/attempts", f"/api/finals?session_id={session_id}",
        "/api/time-sync", "/api/displays/me",
    ]
    for path in paths:
        assert client.get(path, headers=headers).status_code == 200, path
