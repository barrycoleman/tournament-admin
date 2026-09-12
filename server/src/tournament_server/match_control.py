from __future__ import annotations

import asyncio
import concurrent.futures
import logging
from typing import TYPE_CHECKING, Coroutine

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = logging.getLogger(__name__)

_CANCELLED = (concurrent.futures.CancelledError, asyncio.CancelledError)

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
        self.futures: dict[int, concurrent.futures.Future] = {}


def init_match_timer_state(app: "FastAPI") -> None:
    app.state.match_timers = MatchTimerRegistry()


def _log_auto_advance_failure(future: concurrent.futures.Future) -> None:
    """Done-callback for a scheduled auto-advance.

    Without this, an exception raised inside the background coroutine is
    stored on the `concurrent.futures.Future` and never looked at by
    anyone — no log, no traceback, the match simply freezes in its
    current phase forever. A cancellation is the one genuinely expected
    outcome (pause/end/reset all cancel a pending timer), so it stays
    silent; anything else is a real bug and gets logged.
    """
    try:
        exc = future.exception()
    except _CANCELLED:
        return
    if exc is None or isinstance(exc, _CANCELLED):
        return
    logger.error(
        "Match auto-advance timer raised an unhandled exception", exc_info=exc
    )


def schedule_auto_advance(app: "FastAPI", match_id: int, coro: Coroutine) -> None:
    loop = app.state.realtime.event_loop
    # Belt-and-suspenders against two live timer chains for one match: an
    # entry being overwritten here means whatever it pointed at is now
    # obsolete, so cancel it rather than dropping the only handle to it.
    # (The real guarantee is `_auto_advance_match`'s deadline-identity
    # check, which makes a stale timer harmless even if this misses.)
    existing = app.state.match_timers.futures.pop(match_id, None)
    if existing is not None:
        existing.cancel()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    future.add_done_callback(_log_auto_advance_failure)
    app.state.match_timers.futures[match_id] = future


def cancel_auto_advance(app: "FastAPI", match_id: int) -> None:
    future = app.state.match_timers.futures.pop(match_id, None)
    if future is not None:
        future.cancel()
