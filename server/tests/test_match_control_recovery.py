from __future__ import annotations

import datetime as dt
import shutil
import time
from pathlib import Path

from fastapi.testclient import TestClient

from auth_helpers import login_as
from tournament_server.app import create_app
from tournament_server.db import utc_now

FAST_TIMER_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "fast-timer-game"
)


def _build_app_with_stuck_match(tmp_path, phase: str, deadline_offset_seconds: float):
    db_path = str(tmp_path / "test.db")
    plugins_root = tmp_path / "plugins"
    games_target = plugins_root / "games" / "fast-timer-game"
    games_target.parent.mkdir(parents=True)
    shutil.copytree(FAST_TIMER_GAME_PLUGIN, games_target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    client = TestClient(app)
    client.post("/api/event", json={"name": "Regional Qualifier", "password": "p"})
    token = login_as(client, "admin", password="p")
    client.headers["Authorization"] = f"Bearer {token}"
    client.post("/api/event/game-plugin", json={"name": "fast-timer-game"})
    session_id = client.post("/api/sessions", json={"label": "Qualification"}).json()["id"]
    client.post("/api/event/active-session", json={"session_id": session_id})
    client.post("/api/teams", json={"number": "101", "name": "Alpha"})
    client.post("/api/teams", json={"number": "102", "name": "Beta"})
    match_id = client.post(
        "/api/matches",
        json={
            "round_type": "qualification",
            "match_number": 1,
            "alliances": [
                {"station": "red", "team_ids": [1]},
                {"station": "blue", "team_ids": [2]},
            ],
        },
    ).json()["id"]

    from sqlalchemy import select
    from tournament_server.models.match import Match

    session = app.state.session_factory()
    try:
        match = session.get(Match, match_id)
        match.phase = phase
        match.phase_deadline = utc_now() + dt.timedelta(seconds=deadline_offset_seconds)
        session.commit()
    finally:
        session.close()

    return db_path, str(plugins_root), match_id


def test_deadline_already_past_transitions_immediately_on_startup(tmp_path):
    db_path, plugins_root, match_id = _build_app_with_stuck_match(
        tmp_path, phase="driver", deadline_offset_seconds=-10
    )

    recovered_app = create_app(db_path=db_path, plugins_root=plugins_root)
    client = TestClient(recovered_app)
    with client:
        token = login_as(client, "admin", password="p")
        client.headers["Authorization"] = f"Bearer {token}"
        body = client.get(f"/api/matches/{match_id}").json()
        assert body["phase"] == "ended"


def test_deadline_in_future_is_rescheduled_on_startup(tmp_path):
    db_path, plugins_root, match_id = _build_app_with_stuck_match(
        tmp_path, phase="driver", deadline_offset_seconds=0.5
    )

    recovered_app = create_app(db_path=db_path, plugins_root=plugins_root)
    client = TestClient(recovered_app)
    with client:
        token = login_as(client, "admin", password="p")
        client.headers["Authorization"] = f"Bearer {token}"
        deadline = time.monotonic() + 3
        body = None
        while time.monotonic() < deadline:
            body = client.get(f"/api/matches/{match_id}").json()
            if body["phase"] == "ended":
                break
            time.sleep(0.05)
        assert body["phase"] == "ended"


def test_a_paused_match_needs_no_recovery(tmp_path):
    db_path, plugins_root, match_id = _build_app_with_stuck_match(
        tmp_path, phase="driver", deadline_offset_seconds=-10
    )
    from sqlalchemy import select
    from tournament_server.models.match import Match

    _app = create_app(db_path=db_path, plugins_root=plugins_root)
    session = _app.state.session_factory()
    try:
        match = session.get(Match, match_id)
        match.paused = True
        match.remaining_seconds_at_pause = 5.0
        match.phase_deadline = None
        session.commit()
    finally:
        session.close()

    recovered_app = create_app(db_path=db_path, plugins_root=plugins_root)
    client = TestClient(recovered_app)
    with client:
        token = login_as(client, "admin", password="p")
        client.headers["Authorization"] = f"Bearer {token}"
        time.sleep(0.3)
        body = client.get(f"/api/matches/{match_id}").json()
        assert body["phase"] == "driver"
        assert body["paused"] is True
