from __future__ import annotations

from typing import TYPE_CHECKING, Coroutine

if TYPE_CHECKING:
    import concurrent.futures

    from fastapi import FastAPI

COUNTDOWN_SECONDS = 3

_AUTO_ADVANCE = {
    "countdown_autonomous": "autonomous",
    "autonomous": "awaiting_driver",
    "countdown_driver": "driver",
    "driver": "ended",
}


def phase_after_start(autonomous_seconds: int) -> str:
    return "countdown_autonomous" if autonomous_seconds > 0 else "countdown_driver"


def next_auto_phase(phase: str) -> str | None:
    return _AUTO_ADVANCE.get(phase)


def phase_duration_seconds(
    phase: str, autonomous_seconds: int, driver_seconds: int
) -> float | None:
    if phase == "countdown_autonomous":
        return COUNTDOWN_SECONDS
    if phase == "autonomous":
        return autonomous_seconds
    if phase == "countdown_driver":
        return COUNTDOWN_SECONDS
    if phase == "driver":
        return driver_seconds
    return None


class MatchTimerRegistry:
    def __init__(self) -> None:
        self.futures: dict[int, "concurrent.futures.Future"] = {}


def init_match_timer_state(app: "FastAPI") -> None:
    app.state.match_timers = MatchTimerRegistry()


def schedule_auto_advance(app: "FastAPI", match_id: int, coro: Coroutine) -> None:
    import asyncio

    loop = app.state.realtime.event_loop
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    app.state.match_timers.futures[match_id] = future


def cancel_auto_advance(app: "FastAPI", match_id: int) -> None:
    future = app.state.match_timers.futures.pop(match_id, None)
    if future is not None:
        future.cancel()
