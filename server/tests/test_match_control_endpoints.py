from __future__ import annotations

import contextlib
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from tournament_server.app import create_app

FAST_TIMER_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "fast-timer-game"
)
NO_AUTONOMOUS_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "no-autonomous-game"
)


@contextlib.contextmanager
def _build_match_control_client(tmp_path, game_plugin_dir: Path):
    # Must enter TestClient as a context manager (`with TestClient(app) as
    # client:`) — a bare, never-entered TestClient never runs the ASGI
    # lifespan, so app.state.realtime.event_loop stays None and every
    # schedule_auto_advance call below raises AttributeError. See
    # test_realtime.py::test_lifespan_captures_the_event_loop_only_once_entered
    # and the module docstring in test_websockets_router.py for the same,
    # already-documented hazard.
    db_path = str(tmp_path / "test.db")
    plugins_root = tmp_path / "plugins"
    games_target = plugins_root / "games" / game_plugin_dir.name
    games_target.parent.mkdir(parents=True)
    shutil.copytree(game_plugin_dir, games_target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    with TestClient(app) as client:
        client.post(
            "/api/event", json={"name": "Regional Qualifier", "password": "test-password"}
        )
        token = login_as(client, "admin", password="test-password")
        client.headers["Authorization"] = f"Bearer {token}"
        client.post("/api/event/game-plugin", json={"name": game_plugin_dir.name})
        session_id = client.post(
            "/api/sessions", json={"label": "Qualification"}
        ).json()["id"]
        client.post("/api/event/active-session", json={"session_id": session_id})
        client.post("/api/teams", json={"number": "101", "name": "Alpha"})
        client.post("/api/teams", json={"number": "102", "name": "Beta"})
        match_response = client.post(
            "/api/matches",
            json={
                "round_type": "qualification",
                "match_number": 1,
                "alliances": [
                    {"station": "red", "team_ids": [1]},
                    {"station": "blue", "team_ids": [2]},
                ],
            },
        )
        client.match_id = match_response.json()["id"]
        yield client


@pytest.fixture()
def fast_timer_client(tmp_path):
    with _build_match_control_client(tmp_path, FAST_TIMER_GAME_PLUGIN) as client:
        yield client


@pytest.fixture()
def no_autonomous_client(tmp_path):
    with _build_match_control_client(tmp_path, NO_AUTONOMOUS_GAME_PLUGIN) as client:
        yield client


def _wait_for_phase(client: TestClient, match_id: int, phase: str, timeout: float = 6.0):
    # COUNTDOWN_SECONDS is a fixed 3-second constant (not overridden by
    # the fast-timer-game fixture), so waiting for a phase reached via a
    # countdown needs real margin above 3s for test/network overhead —
    # 6s is comfortable without making a failing test slow to notice.
    deadline = time.monotonic() + timeout
    last_body = None
    while time.monotonic() < deadline:
        last_body = client.get(f"/api/matches/{match_id}").json()
        if last_body["phase"] == phase:
            return last_body
        time.sleep(0.05)
    raise AssertionError(f"phase never reached {phase!r}, last body: {last_body}")


def test_start_with_autonomous_goes_to_countdown_autonomous(fast_timer_client):
    response = fast_timer_client.post(f"/api/matches/{fast_timer_client.match_id}/start")

    assert response.status_code == 200
    body = fast_timer_client.get(f"/api/matches/{fast_timer_client.match_id}").json()
    assert body["phase"] == "countdown_autonomous"
    assert body["phase_deadline"] is not None


def test_start_without_autonomous_skips_straight_to_countdown_driver(no_autonomous_client):
    response = no_autonomous_client.post(
        f"/api/matches/{no_autonomous_client.match_id}/start"
    )

    assert response.status_code == 200
    body = no_autonomous_client.get(
        f"/api/matches/{no_autonomous_client.match_id}"
    ).json()
    assert body["phase"] == "countdown_driver"


def test_start_is_rejected_when_not_in_not_started(fast_timer_client):
    fast_timer_client.post(f"/api/matches/{fast_timer_client.match_id}/start")

    response = fast_timer_client.post(f"/api/matches/{fast_timer_client.match_id}/start")

    assert response.status_code == 409


def test_full_auto_advance_sequence_with_autonomous(fast_timer_client):
    match_id = fast_timer_client.match_id
    fast_timer_client.post(f"/api/matches/{match_id}/start")
    _wait_for_phase(fast_timer_client, match_id, "autonomous")
    _wait_for_phase(fast_timer_client, match_id, "awaiting_driver")

    response = fast_timer_client.post(f"/api/matches/{match_id}/start-driver")
    assert response.status_code == 200

    _wait_for_phase(fast_timer_client, match_id, "driver")
    _wait_for_phase(fast_timer_client, match_id, "ended")


def test_start_driver_is_rejected_outside_awaiting_driver(fast_timer_client):
    response = fast_timer_client.post(
        f"/api/matches/{fast_timer_client.match_id}/start-driver"
    )

    assert response.status_code == 409


def test_pause_freezes_the_remaining_time(fast_timer_client):
    match_id = fast_timer_client.match_id
    fast_timer_client.post(f"/api/matches/{match_id}/start")

    response = fast_timer_client.post(f"/api/matches/{match_id}/pause")

    assert response.status_code == 200
    body = fast_timer_client.get(f"/api/matches/{match_id}").json()
    assert body["paused"] is True
    assert body["phase_deadline"] is None
    assert body["remaining_seconds_at_pause"] is not None

    time.sleep(1.5)
    still_paused = fast_timer_client.get(f"/api/matches/{match_id}").json()
    assert still_paused["phase"] == body["phase"]


def test_pause_is_rejected_outside_a_timed_phase(fast_timer_client):
    response = fast_timer_client.post(f"/api/matches/{fast_timer_client.match_id}/pause")

    assert response.status_code == 409


def test_resume_continues_the_countdown(fast_timer_client):
    match_id = fast_timer_client.match_id
    fast_timer_client.post(f"/api/matches/{match_id}/start")
    fast_timer_client.post(f"/api/matches/{match_id}/pause")

    response = fast_timer_client.post(f"/api/matches/{match_id}/resume")

    assert response.status_code == 200
    body = fast_timer_client.get(f"/api/matches/{match_id}").json()
    assert body["paused"] is False
    assert body["phase_deadline"] is not None

    _wait_for_phase(fast_timer_client, match_id, "autonomous")


def test_end_aborts_early_from_any_active_phase(fast_timer_client):
    match_id = fast_timer_client.match_id
    fast_timer_client.post(f"/api/matches/{match_id}/start")

    response = fast_timer_client.post(f"/api/matches/{match_id}/end")

    assert response.status_code == 200
    body = fast_timer_client.get(f"/api/matches/{match_id}").json()
    assert body["phase"] == "ended"

    time.sleep(1.5)  # the cancelled auto-advance must not fire afterward
    still_ended = fast_timer_client.get(f"/api/matches/{match_id}").json()
    assert still_ended["phase"] == "ended"


def test_reset_full_returns_to_not_started_from_any_phase(fast_timer_client):
    match_id = fast_timer_client.match_id
    fast_timer_client.post(f"/api/matches/{match_id}/start")

    response = fast_timer_client.post(
        f"/api/matches/{match_id}/reset", json={"scope": "full"}
    )

    assert response.status_code == 200
    body = fast_timer_client.get(f"/api/matches/{match_id}").json()
    assert body["phase"] == "not_started"
    assert body["phase_deadline"] is None


def test_reset_section_from_driver_returns_to_awaiting_driver(fast_timer_client):
    match_id = fast_timer_client.match_id
    fast_timer_client.post(f"/api/matches/{match_id}/start")
    _wait_for_phase(fast_timer_client, match_id, "awaiting_driver")
    fast_timer_client.post(f"/api/matches/{match_id}/start-driver")

    response = fast_timer_client.post(
        f"/api/matches/{match_id}/reset", json={"scope": "section"}
    )

    assert response.status_code == 200
    body = fast_timer_client.get(f"/api/matches/{match_id}").json()
    assert body["phase"] == "awaiting_driver"

    time.sleep(1.5)  # the cancelled auto-advance for the old countdown_driver must not fire
    still_waiting = fast_timer_client.get(f"/api/matches/{match_id}").json()
    assert still_waiting["phase"] == "awaiting_driver"


def test_reset_section_from_autonomous_returns_to_not_started(fast_timer_client):
    match_id = fast_timer_client.match_id
    fast_timer_client.post(f"/api/matches/{match_id}/start")

    response = fast_timer_client.post(
        f"/api/matches/{match_id}/reset", json={"scope": "section"}
    )

    assert response.status_code == 200
    body = fast_timer_client.get(f"/api/matches/{match_id}").json()
    assert body["phase"] == "not_started"


def test_reset_section_is_rejected_from_not_started(fast_timer_client):
    response = fast_timer_client.post(
        f"/api/matches/{fast_timer_client.match_id}/reset", json={"scope": "section"}
    )

    assert response.status_code == 409


def test_reset_is_rejected_once_completed(fast_timer_client):
    match_id = fast_timer_client.match_id
    match = fast_timer_client.get(f"/api/matches/{match_id}").json()
    alliance_id = match["alliances"][0]["id"]
    fast_timer_client.post(
        f"/api/matches/{match_id}/alliances/{alliance_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "parked": False}, "force": True},
    )
    other_alliance_id = match["alliances"][1]["id"]
    fast_timer_client.post(
        f"/api/matches/{match_id}/alliances/{other_alliance_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "parked": False}, "force": True},
    )

    response = fast_timer_client.post(
        f"/api/matches/{match_id}/reset", json={"scope": "full"}
    )

    assert response.status_code == 409
