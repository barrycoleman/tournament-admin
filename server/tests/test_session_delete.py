from fastapi.testclient import TestClient
from sqlalchemy import func, select

from auth_helpers import bearer, login_as
from ranking_helpers import finalize_qualification
from schedule_helpers import schedule, set_playing_windows
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.bracket_matchup import BracketMatchup
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.finals_result import FinalsResult
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.playing_window import SessionPlayingWindow
from tournament_server.models.ranking import Ranking
from tournament_server.models.schedule_generation import ScheduleGeneration
from tournament_server.models.score_record import ScoreRecord


def _scheduled_session(client, label: str = "Saturday") -> tuple[int, list[int]]:
    """A session with fields, check-ins, playing windows and a generated
    qualification round, none of it scored."""
    session_id = client.post("/api/sessions", json={"label": label}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    team_ids = [
        client.post("/api/teams", json={"number": f"{label}{i}", "name": f"T{i}"}).json()["id"]
        for i in range(8)
    ]
    for team_id in team_ids:
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    set_playing_windows(client, session_id)
    response = schedule(client, session_id, [("qualification", 2)])
    assert response.status_code == 201, response.text
    return session_id, team_ids


def _count(db, model, *where) -> int:
    return db.execute(select(func.count()).select_from(model).where(*where)).scalar_one()


def _setup_event(client) -> None:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})


def test_delete_session_removes_everything_it_owns(client):
    _setup_event(client)
    session_id, _ = _scheduled_session(client)
    other_id, _ = _scheduled_session(client, "Sunday")

    response = client.delete(f"/api/sessions/{session_id}")

    assert response.status_code == 204
    assert [s["id"] for s in client.get("/api/sessions").json()] == [other_id]
    db = client.app.state.session_factory()
    try:
        for model in (
            Match,
            ScheduleGeneration,
            FieldSet,
            SessionParticipation,
            SessionPlayingWindow,
            Ranking,
        ):
            assert _count(db, model, model.session_id == session_id) == 0, model.__name__
        assert _count(db, Field) == 1  # only the other session's field is left
        # The other session is untouched.
        assert _count(db, Match, Match.session_id == other_id) > 0
        assert _count(db, SessionPlayingWindow, SessionPlayingWindow.session_id == other_id) == 1
    finally:
        db.close()


def test_delete_session_with_a_scored_match_is_refused(client):
    _setup_event(client)
    session_id, _ = _scheduled_session(client)
    match = client.get("/api/matches", params={"session_id": session_id}).json()[0]
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    scored = client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )
    assert scored.status_code == 200, scored.text

    response = client.delete(f"/api/sessions/{session_id}")

    assert response.status_code == 409
    assert "scored" in response.json()["detail"]
    assert [s["id"] for s in client.get("/api/sessions").json()] == [session_id]


def test_delete_session_removes_an_unscored_finals_bracket(cooperative_client):
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
                "match_number": 1000 + i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red_id}/score",
            json={"data": {"objects_scored": (4 - i) * 10}},
        )
    finalize_qualification(client, session_id)
    started = client.post("/api/finals/start", json={"session_id": session_id, "bracket_size": 2})
    assert started.status_code == 201, started.text
    # Remove the qualification scores the seeding needed, leaving a bracket
    # (with its first run created) and no score anywhere in the session.
    db = client.app.state.session_factory()
    try:
        for record in db.execute(select(ScoreRecord)).scalars().all():
            db.delete(record)
        db.commit()
    finally:
        db.close()

    response = client.delete(f"/api/sessions/{session_id}")

    assert response.status_code == 204, response.text
    db = client.app.state.session_factory()
    try:
        for model in (
            FinalsBracket,
            BracketAlliance,
            BracketAllianceTeam,
            BracketMatchup,
            FinalsResult,
            Match,
            FieldSet,
            Field,
        ):
            assert _count(db, model) == 0, model.__name__
    finally:
        db.close()


def test_deleting_the_active_session_clears_it_and_broadcasts(client):
    _setup_event(client)
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    client.post("/api/event/active-session", json={"session_id": session_id})
    raw = TestClient(client.app)
    admin_token = client.headers["Authorization"].removeprefix("Bearer ")

    with raw.websocket_connect(f"/ws/active-session?token={admin_token}") as ws:
        response = client.delete(f"/api/sessions/{session_id}")
        received = ws.receive_json()

    assert response.status_code == 204
    assert client.get("/api/event").json()["active_session_id"] is None
    assert received == {"event": "active_session_changed", "data": {"active_session_id": None}}


def test_deleting_another_session_keeps_the_active_one(client):
    _setup_event(client)
    active_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    other_id = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    client.post("/api/event/active-session", json={"session_id": active_id})

    assert client.delete(f"/api/sessions/{other_id}").status_code == 204
    assert client.get("/api/event").json()["active_session_id"] == active_id


def test_delete_unknown_session_is_404(client):
    _setup_event(client)
    assert client.delete("/api/sessions/999").status_code == 404


def test_delete_session_is_admin_only(client):
    _setup_event(client)
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    raw = TestClient(client.app)
    token = login_as(raw, "scorer")

    response = raw.delete(f"/api/sessions/{session_id}", headers=bearer(token))

    assert response.status_code == 403


def test_sessions_report_whether_they_have_scored_matches(client):
    _setup_event(client)
    scored_id, _ = _scheduled_session(client)
    unscored_id, _ = _scheduled_session(client, "Sunday")
    match = client.get("/api/matches", params={"session_id": scored_id}).json()[0]
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )

    listed = {s["id"]: s["has_scored_matches"] for s in client.get("/api/sessions").json()}
    patched = client.patch(f"/api/sessions/{scored_id}", json={"label": "Sat"}).json()
    created = client.post("/api/sessions", json={"label": "Monday"}).json()

    assert listed == {scored_id: True, unscored_id: False}
    assert patched["has_scored_matches"] is True
    assert created["has_scored_matches"] is False


def test_delete_session_removes_its_skills_attempts(client):
    from tournament_server.models.skills import SkillsAttempt

    _setup_event(client)
    session_id, team_ids = _scheduled_session(client)
    other_id, other_team_ids = _scheduled_session(client, "Sunday")
    db = client.app.state.session_factory()
    try:
        for sid, team_id in ((session_id, team_ids[0]), (other_id, other_team_ids[0])):
            db.add(
                SkillsAttempt(
                    session_id=sid,
                    team_id=team_id,
                    skills_type="driver",
                    data_json='{"objects_scored": 5}',
                    score=10,
                    plugin_name="example-game",
                    plugin_version="1.0.0",
                )
            )
        db.commit()
    finally:
        db.close()

    assert client.delete(f"/api/sessions/{session_id}").status_code == 204

    db = client.app.state.session_factory()
    try:
        assert _count(db, SkillsAttempt, SkillsAttempt.session_id == session_id) == 0
        assert _count(db, SkillsAttempt, SkillsAttempt.session_id == other_id) == 1
    finally:
        db.close()
