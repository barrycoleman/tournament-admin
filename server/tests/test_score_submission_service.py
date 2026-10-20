"""services/score_submission: the official score write behind
POST /api/matches/{id}/alliances/{id}/score and the live-scoring Submit."""
from __future__ import annotations

import pytest
from sqlalchemy import select

from display_helpers import add_match, add_teams, admin_token, setup_event
from skills_helpers import next_event
from tournament_server.models.alliance import Alliance
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.schemas.score_record import TeamFlags
from tournament_server.services import qualification
from tournament_server.services.score_submission import (
    SCORE_ALREADY_SUBMITTED_DETAIL,
    ScoreRefused,
    after_scores_written,
    write_alliance_score,
)

SHEET = {"high_balls": 3, "low_balls": 1, "parked": False, "auto_winner": "tie"}


def _match(client, game: str = "example-game") -> dict:
    session_id = setup_event(client, game=game)
    match = add_match(client, session_id, None, 1, add_teams(client))
    return {**match, "session_id": session_id}


def _write(client, match: dict, index: int, *, game="example-game", data=SHEET, teams=(), force=False, is_admin=True):
    plugin = client.app.state.game_plugins[game]
    with client.app.state.session_factory() as db:
        match_row = db.get(Match, match["id"])
        alliance = db.get(Alliance, match["alliances"][index]["id"])
        record, score, mirrored = write_alliance_score(
            db, plugin, match_row, alliance, data=data, teams=list(teams), sitting=False,
            force=force, submitted_by="Field 1 Tablet", is_admin=is_admin,
        )
        return {"alliance_id": record.alliance_id, "by": record.submitted_by_device,
                "mirrored_record": record.mirrored, "score": score, "mirrored": mirrored}


def _refused(client, match, index, **kwargs) -> ScoreRefused:
    with pytest.raises(ScoreRefused) as refused:
        _write(client, match, index, **kwargs)
    return refused.value


def _records(client) -> list[ScoreRecord]:
    with client.app.state.session_factory() as db:
        return list(db.execute(select(ScoreRecord).order_by(ScoreRecord.alliance_id)).scalars().all())


def test_a_write_saves_the_record_and_leaves_completion_to_after_scores_written(client):
    match = _match(client)
    written = _write(client, match, 0)
    assert written == {"alliance_id": match["alliances"][0]["id"], "by": "Field 1 Tablet",
                       "mirrored_record": False, "score": 10, "mirrored": False}
    _write(client, match, 1)
    with client.app.state.session_factory() as db:
        assert db.get(Match, match["id"]).status == "scheduled"
        assert db.execute(select(Ranking)).first() is None


def test_after_scores_written_completes_the_match_and_ranks_it(client):
    match = _match(client)
    _write(client, match, 0)
    _write(client, match, 1)
    plugin = client.app.state.game_plugins["example-game"]
    with client.app.state.session_factory() as db:
        match_row = db.get(Match, match["id"])
        after_scores_written(client.app, db, plugin, match_row, [a["id"] for a in match["alliances"]])
    with client.app.state.session_factory() as db:
        assert db.get(Match, match["id"]).status == "completed"
        session_rows = db.execute(select(Ranking).where(Ranking.session_id == match["session_id"])).scalars().all()
        assert len(session_rows) == 4


def test_after_scores_written_announces_each_listed_alliance(client):
    match = _match(client)
    _write(client, match, 0)
    _write(client, match, 1)
    plugin = client.app.state.game_plugins["example-game"]
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        with client.app.state.session_factory() as db:
            after_scores_written(client.app, db, plugin, db.get(Match, match["id"]), [a["id"] for a in match["alliances"]])
        announced = [next_event(socket, "score_saved")["data"] for _ in match["alliances"]]
    assert announced == [{"match_id": match["id"], "alliance_id": a["id"]} for a in match["alliances"]]


def test_only_an_admin_overwrites_a_submitted_score(client):
    match = _match(client)
    _write(client, match, 0)
    refused = _refused(client, match, 0, is_admin=False)
    assert (refused.status_code, refused.detail) == (409, SCORE_ALREADY_SUBMITTED_DETAIL)
    corrected = _write(client, match, 0, data={**SHEET, "high_balls": 5})
    assert corrected["score"] == 16


def test_plugin_violations_refuse_the_write_unless_forced(client):
    match = _match(client)
    over = {"high_balls": 25, "low_balls": 0, "auto_winner": "tie"}
    refused = _refused(client, match, 0, data=over)
    assert (refused.status_code, refused.detail) == (422, {"violations": ["high_balls cannot exceed 20"]})
    assert _records(client) == []
    assert _write(client, match, 0, data=over, force=True)["score"] == 75


def test_team_flags_must_name_teams_on_the_alliance(client):
    match = _match(client)
    blue_team = match["alliances"][1]["team_ids"][0]
    refused = _refused(client, match, 0, teams=[TeamFlags(team_id=blue_team, dq=True)])
    assert (refused.status_code, refused.detail) == (422, f"Team {blue_team} is not on this alliance.")


def test_a_not_played_match_is_refused(client):
    match = _match(client)
    with client.app.state.session_factory() as db:
        db.get(Match, match["id"]).status = qualification.NOT_PLAYED
        db.commit()
    refused = _refused(client, match, 0)
    assert (refused.status_code, refused.detail) == (409, qualification.NOT_PLAYED_SCORE_DETAIL)


def test_a_cooperative_write_mirrors_onto_the_partner_in_the_same_commit(cooperative_client):
    client = cooperative_client
    match = _match(client, game="cooperative-game")
    written = _write(client, match, 0, game="cooperative-game", data={"objects_scored": 10})
    assert (written["score"], written["mirrored"]) == (20, True)
    red, blue = _records(client)
    assert (red.mirrored, blue.mirrored) == (False, True)
    assert blue.data_json == red.data_json


def test_a_fully_flagged_cooperative_alliance_scores_zero_and_does_not_mirror(cooperative_client):
    client = cooperative_client
    match = _match(client, game="cooperative-game")
    flags = [TeamFlags(team_id=team_id, no_show=True) for team_id in match["alliances"][0]["team_ids"]]
    written = _write(client, match, 0, game="cooperative-game", data={"objects_scored": 10}, teams=flags)
    assert (written["score"], written["mirrored"]) == (0, False)
    assert [r.alliance_id for r in _records(client)] == [match["alliances"][0]["id"]]
