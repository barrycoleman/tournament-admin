from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass
from zoneinfo import ZoneInfo


def _parse_time_of_day(value: str) -> dt.time:
    hour_str, minute_str = value.split(":")
    return dt.time(hour=int(hour_str), minute=int(minute_str))


def block_utc_bounds(
    block: dict, timezone_name: str
) -> tuple[dt.datetime, dt.datetime | None]:
    """Resolves a single time-block dict's own window to real UTC instants,
    combining its `date` with its `start_time`/`end_time` wall-clock
    strings against `timezone_name`. Returns (start_utc, end_utc), with
    end_utc None for an open-ended block (no end_time) -- the caller
    decides how "no confirmed end" should behave for its own purposes
    (e.g. overlap-checking treats it as extending indefinitely).

    This is the single place block-to-instant conversion logic lives;
    to_utc_windows and routers/schedule.py's
    _check_no_overlap_with_prior_generations both need exactly this same
    date+time-of-day-against-a-timezone resolution and must not each
    reimplement it by hand."""
    tz = ZoneInfo(timezone_name)
    start_utc = dt.datetime.combine(
        block["date"], _parse_time_of_day(block["start_time"]), tzinfo=tz
    ).astimezone(dt.UTC)
    end_time = block.get("end_time")
    end_utc = (
        dt.datetime.combine(
            block["date"], _parse_time_of_day(end_time), tzinfo=tz
        ).astimezone(dt.UTC)
        if end_time is not None
        else None
    )
    return start_utc, end_utc


def serialize_time_blocks(
    time_blocks: list[dict],
    timezone_name: str,
    occupied: list[tuple[dt.datetime, dt.datetime] | None] | None = None,
) -> str:
    """JSON-encodes the playing windows one round's matches use, for
    storage in ScheduleGeneration.time_blocks_json: one dict per window with
    `date` (encoded as an ISO-8601 string), `start_time`, `end_time` and
    `cycle_time`.

    Each encoded entry also carries `timezone` (timezone_name), the IANA
    zone its wall-clock start_time/end_time strings are meant to be read
    against -- the session's timezone. That is what lets a later
    generation's overlap check (routers/schedule.py's
    _check_no_overlap_with_prior_generations) convert a stored window back
    to real UTC instants.

    `occupied` (one (from, until) entry per window in the same order, as
    occupied_by_window reports them, or None) is stored per entry as
    `occupied_from`/`occupied_until` ISO-8601 UTC instants: the time the
    round's matches actually claim inside that window. Both are null for a
    window holding none of them."""
    if occupied is not None and len(occupied) != len(time_blocks):
        raise ValueError("occupied needs exactly one entry per time block")
    encoded = []
    for index, b in enumerate(time_blocks):
        entry = {
            "date": b["date"].isoformat(),
            "start_time": b["start_time"],
            "end_time": b.get("end_time"),
            "cycle_time": b.get("cycle_time"),
            "timezone": timezone_name,
        }
        if occupied is not None:
            window = occupied[index]
            entry["occupied_from"] = window[0].isoformat() if window is not None else None
            entry["occupied_until"] = window[1].isoformat() if window is not None else None
        encoded.append(entry)
    return json.dumps(encoded)


def deserialize_time_blocks(time_blocks_json: str) -> list[dict]:
    """Inverse of serialize_time_blocks: decodes stored JSON back into
    window dicts with a real dt.date under "date", suitable for passing to
    block_utc_bounds.

    Rows written before newer keys existed stay readable: a missing
    "timezone" defaults to "UTC", and a row without "occupied_from" gets no
    "occupied" key at all. When present, "occupied" is a (from, until) pair
    of UTC datetimes, or None for a window holding none of the round's
    matches, so callers can tell "no matches" (None) from "unknown" (key
    absent, fall back to the requested start_time/end_time)."""
    blocks = []
    for b in json.loads(time_blocks_json):
        block = {
            "date": dt.date.fromisoformat(b["date"]),
            "start_time": b["start_time"],
            "end_time": b.get("end_time"),
            "cycle_time": b.get("cycle_time"),
            "timezone": b.get("timezone", "UTC"),
        }
        if "occupied_from" in b:
            if b["occupied_until"] is None:
                block["occupied"] = None
            else:
                block["occupied"] = (
                    dt.datetime.fromisoformat(b["occupied_from"]),
                    dt.datetime.fromisoformat(b["occupied_until"]),
                )
        blocks.append(block)
    return blocks


@dataclass(frozen=True)
class PlayingWindow:
    """A session playing window with its real UTC bounds."""

    date: dt.date
    start_time: str
    end_time: str
    start: dt.datetime
    end: dt.datetime


_FOREVER = dt.datetime.max.replace(tzinfo=dt.UTC)


def to_utc_windows(rows: list[dict], timezone_name: str) -> list[PlayingWindow]:
    """Sorted PlayingWindows for rows shaped like services.playing_windows'
    load_windows. Each date resolves on its own, so a DST change between two
    playing days keeps both days' local clock times."""
    windows = []
    for row in sorted(rows, key=lambda r: (r["date"], r["start_time"])):
        start, end = block_utc_bounds(row, timezone_name)
        windows.append(PlayingWindow(row["date"], row["start_time"], row["end_time"], start, end))
    return windows


def ceil_minute(instant: dt.datetime) -> dt.datetime:
    remainder = dt.timedelta(seconds=instant.second, microseconds=instant.microsecond)
    if not remainder:
        return instant
    return instant - remainder + dt.timedelta(minutes=1)


def place_slots(
    windows: list[PlayingWindow],
    earliest: dt.datetime,
    slot_count: int,
    cycle_seconds: int,
    match_seconds: int,
) -> list[dt.datetime]:
    """Start times for up to slot_count time slots, cycle_seconds apart,
    from `earliest`. A slot starts only if a match started then finishes
    (match_seconds later) by its window's end; otherwise it moves to the
    next window's start and spacing restarts there. Returns fewer than
    slot_count starts when the windows run out."""
    match = dt.timedelta(seconds=match_seconds)
    cycle = dt.timedelta(seconds=cycle_seconds)
    starts: list[dt.datetime] = []
    cursor = earliest
    index = 0
    while len(starts) < slot_count and index < len(windows):
        window = windows[index]
        cursor = max(cursor, window.start)
        if cursor + match > window.end:
            index += 1
            continue
        starts.append(cursor)
        cursor += cycle
    return starts


@dataclass
class PlanPlacement:
    round_starts: list[list[dt.datetime]]
    unplaced_slot_count: int

    @property
    def fits(self) -> bool:
        return self.unplaced_slot_count == 0


def place_plan(
    windows: list[PlayingWindow],
    earliest: dt.datetime,
    rounds: list[tuple[int, int]],
    match_seconds: int,
) -> PlanPlacement:
    """Places each (slot_count, cycle_seconds) round in order; a round
    starts on the first whole minute after the previous round's last match
    ends. Once one round runs out of room, every later slot is unplaced."""
    round_starts: list[list[dt.datetime]] = []
    unplaced = 0
    cursor = earliest
    for slot_count, cycle_seconds in rounds:
        if unplaced:
            round_starts.append([])
            unplaced += slot_count
            continue
        starts = place_slots(windows, cursor, slot_count, cycle_seconds, match_seconds)
        round_starts.append(starts)
        unplaced += slot_count - len(starts)
        if starts:
            cursor = ceil_minute(starts[-1] + dt.timedelta(seconds=match_seconds))
    return PlanPlacement(round_starts, unplaced)


@dataclass(frozen=True)
class OverflowSuggestions:
    over_by_seconds: int
    suggested_cycle_time_seconds: int | None
    suggested_last_window_end: str | None


def overflow_suggestions(
    windows: list[PlayingWindow],
    earliest: dt.datetime,
    rounds: list[tuple[int, int]],
    match_seconds: int,
    timezone_name: str,
) -> OverflowSuggestions:
    """For a plan that doesn't fit: how far past the last window's end it
    runs, the earliest whole-minute end for that window that would fit
    (None if that passes midnight), and the longest whole-second cycle time
    for the last round alone that would fit (None if not even the match
    length does). Placement times never decrease as a cycle time grows, so
    a binary search finds that cycle time."""
    last = windows[-1]
    unbounded = [*windows[:-1], PlayingWindow(last.date, last.start_time, last.end_time, last.start, _FOREVER)]
    extended = place_plan(unbounded, earliest, rounds, match_seconds)
    final_start = next(starts[-1] for starts in reversed(extended.round_starts) if starts)
    final_end = final_start + dt.timedelta(seconds=match_seconds)
    over_by = max(0, int((final_end - last.end).total_seconds()))
    local_end = ceil_minute(final_end).astimezone(ZoneInfo(timezone_name))
    suggested_end = local_end.strftime("%H:%M") if local_end.date() == last.date else None

    *earlier, (last_slots, last_cycle) = rounds

    def fits_with(cycle: int) -> bool:
        return place_plan(windows, earliest, [*earlier, (last_slots, cycle)], match_seconds).fits

    suggested_cycle = None
    if last_cycle > match_seconds and fits_with(match_seconds):
        low, high = match_seconds, last_cycle - 1
        while low < high:
            middle = (low + high + 1) // 2
            if fits_with(middle):
                low = middle
            else:
                high = middle - 1
        suggested_cycle = low
    return OverflowSuggestions(over_by, suggested_cycle, suggested_end)


def occupied_by_window(
    windows: list[PlayingWindow], starts: list[dt.datetime], match_seconds: int
) -> list[tuple[PlayingWindow, dt.datetime, dt.datetime]]:
    """For each window holding any of `starts`, its first start and its last
    start plus one match: the time a generation claims there."""
    match = dt.timedelta(seconds=match_seconds)
    occupied = []
    for window in windows:
        inside = [s for s in starts if window.start <= s and s + match <= window.end]
        if inside:
            occupied.append((window, inside[0], inside[-1] + match))
    return occupied
