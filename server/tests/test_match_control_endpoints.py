from __future__ import annotations

import asyncio
import contextlib
import datetime as dt
import logging
import shutil
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from auth_helpers import login_as
from tournament_server.app import create_app
from tournament_server.db import utc_now
from tournament_server.match_control import schedule_auto_advance
from tournament_server.models.match import Match
from tournament_server.routers.matches import _auto_advance_match

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


@contextlib.contextmanager
def _active_session_ws(client: TestClient):
    """Opens `/ws/active-session` on the match-control client itself.

    `_build_match_control_client` already pins an admin bearer token on the
    client and sets the session it builds as the event's active session, so
    everything these endpoints broadcast via `broadcast_for_session` lands
    on this one channel. The client is an entered `TestClient`, so the ASGI
    lifespan has run and `app.state.realtime.event_loop` is a real loop —
    without that, `broadcast_*` silently sends nothing at all.
    """
    token = client.headers["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect(f"/ws/active-session?token={token}") as ws:
        yield ws


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


def test_reset_rejects_an_unknown_scope(fast_timer_client):
    # `scope` is a Literal["section", "full"], so a typo can never fall
    # through the reset endpoint's if/elif chain into the *more*
    # destructive full-reset branch.
    response = fast_timer_client.post(
        f"/api/matches/{fast_timer_client.match_id}/reset", json={"scope": "Section"}
    )

    assert response.status_code == 422


# --- WebSocket wire-contract coverage -------------------------------------
#
# Everything above verifies phase transitions through `GET /api/matches/{id}`.
# These verify the *other* half of the contract — the exact event names and
# payload shapes the Admin UI, scorer/tablet and Pi display will code
# against — over a real WebSocket connection, per the design spec's §7.


def test_start_broadcasts_match_phase_changed(fast_timer_client):
    client = fast_timer_client
    match_id = client.match_id

    with _active_session_ws(client) as ws:
        client.post(f"/api/matches/{match_id}/start")
        message = ws.receive_json()

    assert message["event"] == "match_phase_changed"
    assert message["data"]["match_id"] == match_id
    assert message["data"]["phase"] == "countdown_autonomous"
    assert message["data"]["phase_deadline"] is not None


def test_auto_advance_broadcasts_each_phase_and_start_driver_broadcasts_its_own(
    fast_timer_client,
):
    client = fast_timer_client
    match_id = client.match_id

    with _active_session_ws(client) as ws:
        client.post(f"/api/matches/{match_id}/start")

        countdown = ws.receive_json()
        autonomous = ws.receive_json()       # auto-advance, after COUNTDOWN_SECONDS
        awaiting_driver = ws.receive_json()  # auto-advance, after autonomous_seconds

        response = client.post(f"/api/matches/{match_id}/start-driver")
        assert response.status_code == 200
        countdown_driver = ws.receive_json()

    assert countdown["data"]["phase"] == "countdown_autonomous"

    assert autonomous["event"] == "match_phase_changed"
    assert autonomous["data"]["match_id"] == match_id
    assert autonomous["data"]["phase"] == "autonomous"
    assert autonomous["data"]["phase_deadline"] is not None

    assert awaiting_driver["event"] == "match_phase_changed"
    assert awaiting_driver["data"]["phase"] == "awaiting_driver"
    # awaiting_driver waits on a human, not a clock.
    assert awaiting_driver["data"]["phase_deadline"] is None

    assert countdown_driver["event"] == "match_phase_changed"
    assert countdown_driver["data"]["match_id"] == match_id
    assert countdown_driver["data"]["phase"] == "countdown_driver"
    assert countdown_driver["data"]["phase_deadline"] is not None


def test_auto_advance_broadcasts_the_transition_into_ended(no_autonomous_client):
    # The autonomous_seconds == 0 plugin gives the shortest path to `ended`:
    # countdown_driver -> driver -> ended, no start-driver call needed.
    client = no_autonomous_client
    match_id = client.match_id

    with _active_session_ws(client) as ws:
        client.post(f"/api/matches/{match_id}/start")

        countdown_driver = ws.receive_json()
        driver = ws.receive_json()
        ended = ws.receive_json()

    assert countdown_driver["data"]["phase"] == "countdown_driver"
    assert driver["data"]["phase"] == "driver"
    assert driver["data"]["phase_deadline"] is not None
    assert ended == {
        "event": "match_phase_changed",
        "data": {"match_id": match_id, "phase": "ended", "phase_deadline": None},
    }


def test_pause_broadcasts_match_paused(fast_timer_client):
    client = fast_timer_client
    match_id = client.match_id

    with _active_session_ws(client) as ws:
        client.post(f"/api/matches/{match_id}/start")
        ws.receive_json()  # the start's own match_phase_changed

        client.post(f"/api/matches/{match_id}/pause")
        message = ws.receive_json()

    assert message["event"] == "match_paused"
    assert message["data"]["match_id"] == match_id
    assert message["data"]["phase"] == "countdown_autonomous"
    assert message["data"]["remaining_seconds_at_pause"] > 0


def test_resume_broadcasts_match_resumed(fast_timer_client):
    client = fast_timer_client
    match_id = client.match_id

    with _active_session_ws(client) as ws:
        client.post(f"/api/matches/{match_id}/start")
        ws.receive_json()
        client.post(f"/api/matches/{match_id}/pause")
        ws.receive_json()

        client.post(f"/api/matches/{match_id}/resume")
        message = ws.receive_json()

    assert message["event"] == "match_resumed"
    assert message["data"]["match_id"] == match_id
    assert message["data"]["phase"] == "countdown_autonomous"
    assert message["data"]["phase_deadline"] is not None


def test_end_broadcasts_match_phase_changed_ended(fast_timer_client):
    client = fast_timer_client
    match_id = client.match_id

    with _active_session_ws(client) as ws:
        client.post(f"/api/matches/{match_id}/start")
        ws.receive_json()

        client.post(f"/api/matches/{match_id}/end")
        message = ws.receive_json()

    assert message == {
        "event": "match_phase_changed",
        "data": {"match_id": match_id, "phase": "ended", "phase_deadline": None},
    }


def test_reset_full_broadcasts_match_reset_to_not_started(fast_timer_client):
    client = fast_timer_client
    match_id = client.match_id

    with _active_session_ws(client) as ws:
        client.post(f"/api/matches/{match_id}/start")
        ws.receive_json()

        client.post(f"/api/matches/{match_id}/reset", json={"scope": "full"})
        message = ws.receive_json()

    assert message == {
        "event": "match_reset",
        "data": {"match_id": match_id, "phase": "not_started"},
    }


def test_reset_section_broadcasts_match_reset_to_awaiting_driver(fast_timer_client):
    client = fast_timer_client
    match_id = client.match_id

    with _active_session_ws(client) as ws:
        client.post(f"/api/matches/{match_id}/start")
        ws.receive_json()  # countdown_autonomous
        ws.receive_json()  # autonomous
        ws.receive_json()  # awaiting_driver
        client.post(f"/api/matches/{match_id}/start-driver")
        ws.receive_json()  # countdown_driver

        client.post(f"/api/matches/{match_id}/reset", json={"scope": "section"})
        message = ws.receive_json()

    assert message == {
        "event": "match_reset",
        "data": {"match_id": match_id, "phase": "awaiting_driver"},
    }


# --- Background-timer robustness ------------------------------------------


def _set_phase_deadline(client: TestClient, match_id: int, deadline) -> None:
    session = client.app.state.session_factory()
    try:
        match = session.get(Match, match_id)
        match.phase_deadline = deadline
        session.commit()
    finally:
        session.close()


def test_a_timer_does_not_transition_when_the_deadline_moved_under_it(fast_timer_client):
    """The deadline-identity guard, in isolation.

    The scheduled timer is deliberately left un-cancelled; only the fact
    that `match.phase_deadline` no longer equals the value it captured
    before sleeping can stop it from firing.
    """
    client = fast_timer_client
    match_id = client.match_id
    client.post(f"/api/matches/{match_id}/start")

    _set_phase_deadline(client, match_id, utc_now() + dt.timedelta(seconds=30))

    time.sleep(4.0)  # well past the original 3-second countdown deadline

    body = client.get(f"/api/matches/{match_id}").json()
    assert body["phase"] == "countdown_autonomous"


def test_a_timer_orphaned_by_a_reset_does_not_advance_the_next_run(fast_timer_client):
    """The schedule/cancel race, end to end.

    A timer that read the *first* run's deadline and is still asleep gets
    orphaned by a reset (it was never in the registry, so nothing can
    cancel it), then the operator starts the match again. The orphan must
    not advance the second run's phase when it wakes.
    """
    client = fast_timer_client
    match_id = client.match_id
    app = client.app

    client.post(f"/api/matches/{match_id}/start")
    orphan = asyncio.run_coroutine_threadsafe(
        _auto_advance_match(app, match_id, override_sleep_seconds=1.5),
        app.state.realtime.event_loop,
    )

    client.post(f"/api/matches/{match_id}/reset", json={"scope": "full"})
    client.post(f"/api/matches/{match_id}/start")  # a fresh run, new deadline

    orphan.result(timeout=5)  # it woke and returned without raising

    # ~2.2s in: the orphan fired at ~1.5s, but the second run's own
    # 3-second countdown has not elapsed yet, so nothing should have moved.
    time.sleep(0.7)
    body = client.get(f"/api/matches/{match_id}").json()
    assert body["phase"] == "countdown_autonomous"

    # ...and the second run's own timer still works.
    _wait_for_phase(client, match_id, "autonomous")


def test_auto_advance_abandons_cleanly_when_the_game_plugin_is_gone(
    fast_timer_client, caplog
):
    """An admin clearing/swapping the game plugin mid-match used to raise
    AttributeError inside the background coroutine, completely invisibly."""
    client = fast_timer_client
    match_id = client.match_id
    app = client.app
    client.post(f"/api/matches/{match_id}/start")
    phase_before = client.get(f"/api/matches/{match_id}").json()["phase"]

    app.state.game_plugins.clear()

    with caplog.at_level(logging.WARNING):
        future = asyncio.run_coroutine_threadsafe(
            _auto_advance_match(app, match_id), app.state.realtime.event_loop
        )
        future.result(timeout=5)  # returns cleanly rather than raising

    assert client.get(f"/api/matches/{match_id}").json()["phase"] == phase_before
    assert any(
        "no longer registered" in record.getMessage() for record in caplog.records
    ), caplog.text
    assert match_id not in app.state.match_timers.futures


def test_a_failing_auto_advance_coroutine_is_logged(fast_timer_client, caplog):
    """Nothing ever calls `.result()` on a scheduled timer's future, so
    without the done-callback an exception in it would vanish silently."""
    app = fast_timer_client.app

    async def _explode() -> None:
        raise RuntimeError("simulated auto-advance failure")

    with caplog.at_level(logging.ERROR):
        schedule_auto_advance(app, 987654, _explode())
        future = app.state.match_timers.futures[987654]
        with pytest.raises(RuntimeError):
            future.result(timeout=5)
        # add_done_callback runs on the loop thread, possibly just after
        # result() returns, so give it a moment to land.
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not caplog.records:
            time.sleep(0.02)

    assert any(
        record.levelno == logging.ERROR
        and "auto-advance timer" in record.getMessage()
        and record.exc_info is not None
        and isinstance(record.exc_info[1], RuntimeError)
        for record in caplog.records
    ), caplog.text


def test_scheduling_a_second_timer_cancels_the_one_it_replaces(fast_timer_client):
    app = fast_timer_client.app
    match_id = fast_timer_client.match_id

    async def _sleep_forever() -> None:
        await asyncio.sleep(3600)

    schedule_auto_advance(app, match_id, _sleep_forever())
    first = app.state.match_timers.futures[match_id]
    schedule_auto_advance(app, match_id, _sleep_forever())
    second = app.state.match_timers.futures[match_id]

    assert second is not first
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and not first.cancelled():
        time.sleep(0.02)
    assert first.cancelled()

    second.cancel()
