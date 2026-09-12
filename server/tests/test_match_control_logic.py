from __future__ import annotations

import asyncio
import threading
import time

import pytest

from tournament_server import match_control, realtime


def test_phase_after_start_goes_to_countdown_autonomous_when_autonomous_exists():
    assert match_control.phase_after_start(15) == "countdown_autonomous"


def test_phase_after_start_skips_to_countdown_driver_when_no_autonomous():
    assert match_control.phase_after_start(0) == "countdown_driver"


@pytest.mark.parametrize(
    "phase,expected",
    [
        ("countdown_autonomous", "autonomous"),
        ("autonomous", "awaiting_driver"),
        ("countdown_driver", "driver"),
        ("driver", "ended"),
        ("not_started", None),
        ("awaiting_driver", None),
        ("ended", None),
    ],
)
def test_next_auto_phase(phase, expected):
    assert match_control.next_auto_phase(phase) == expected


@pytest.mark.parametrize(
    "phase,expected",
    [
        ("countdown_autonomous", match_control.COUNTDOWN_SECONDS),
        ("autonomous", 15),
        ("countdown_driver", match_control.COUNTDOWN_SECONDS),
        ("driver", 105),
        ("not_started", None),
        ("awaiting_driver", None),
        ("ended", None),
    ],
)
def test_phase_duration_seconds(phase, expected):
    assert match_control.phase_duration_seconds(phase, 15, 105) == expected


@pytest.fixture()
def running_loop():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


class _FakeApp:
    def __init__(self) -> None:
        self.state = type("State", (), {})()


def _wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_schedule_auto_advance_runs_the_coroutine(running_loop):
    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    match_control.init_match_timer_state(app)
    ran = []

    async def _mark():
        ran.append(True)

    match_control.schedule_auto_advance(app, 1, _mark())

    assert _wait_for(lambda: ran)


def test_cancel_auto_advance_prevents_the_coroutine_from_completing(running_loop):
    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    match_control.init_match_timer_state(app)
    ran = []

    async def _mark_after_delay():
        await asyncio.sleep(0.5)
        ran.append(True)

    match_control.schedule_auto_advance(app, 1, _mark_after_delay())
    match_control.cancel_auto_advance(app, 1)

    time.sleep(0.7)
    assert ran == []


def test_cancel_auto_advance_with_nothing_scheduled_is_a_noop(running_loop):
    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    match_control.init_match_timer_state(app)

    match_control.cancel_auto_advance(app, 999)  # must not raise
