from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass
from zoneinfo import ZoneInfo


@dataclass
class ResolvedBlock:
    date: dt.date
    start_time: str
    end_time: str | None
    cycle_time_seconds: float
    time_slot_count: int


def _parse_time_of_day(value: str) -> dt.time:
    hour_str, minute_str = value.split(":")
    return dt.time(hour=int(hour_str), minute=int(minute_str))


def _block_duration_seconds(start_time: str, end_time: str) -> int:
    start = _parse_time_of_day(start_time)
    end = _parse_time_of_day(end_time)
    start_seconds = start.hour * 3600 + start.minute * 60
    end_seconds = end.hour * 3600 + end.minute * 60
    return end_seconds - start_seconds


def _apportion_time_slots(
    blocks: list[dict], total_to_distribute: int
) -> list[int]:
    """Distributes `total_to_distribute` time_slots across `blocks` in
    proportion to each block's duration, using the largest-remainder
    method so the results sum to exactly `total_to_distribute` even when
    proportional shares aren't whole numbers."""
    if total_to_distribute < len(blocks):
        raise ValueError(
            f"Only {total_to_distribute} time slot(s) remain to distribute "
            f"across {len(blocks)} 'calculate for me' time blocks — each "
            "needs at least one; adjust target_matches_per_team or the blocks"
        )
    durations = [
        _block_duration_seconds(b["start_time"], b["end_time"]) for b in blocks
    ]
    total_duration = sum(durations)
    ideal_shares = [total_to_distribute * d / total_duration for d in durations]
    counts = [int(share) for share in ideal_shares]
    remainder = total_to_distribute - sum(counts)
    by_fractional_part_desc = sorted(
        range(len(blocks)), key=lambda i: ideal_shares[i] - counts[i], reverse=True
    )
    for i in by_fractional_part_desc[:remainder]:
        counts[i] += 1
    if 0 in counts:
        raise ValueError(
            "Duration-proportional apportionment left at least one "
            "'calculate for me' time block with zero time slots — its "
            "duration is too small relative to the others; adjust the "
            "blocks or target_matches_per_team"
        )
    return counts


def validate_blocks_ordered_and_non_overlapping(time_blocks: list[dict]) -> None:
    """Raises ValueError unless time_blocks are given in ascending
    (date, start_time) order with no two blocks' windows overlapping.
    Two blocks on different dates never overlap regardless of their
    time-of-day values; two blocks on the same date compare start_time/
    end_time exactly as before this function became date-aware."""
    for i in range(len(time_blocks) - 1):
        current = time_blocks[i]
        following = time_blocks[i + 1]
        current_key = (current["date"], current["start_time"])
        following_key = (following["date"], following["start_time"])
        if current_key >= following_key:
            raise ValueError(
                "time_blocks must be given in (date, start_time)-ascending "
                f"order ({current_key!r} is not before {following_key!r})"
            )
        if (
            current.get("end_time") is not None
            and current["date"] == following["date"]
            and current["end_time"] > following["start_time"]
        ):
            raise ValueError(
                "time_blocks must not overlap: block starting at "
                f"{current['date']} {current['start_time']!r} ends at "
                f"{current['end_time']!r}, after the next block starts at "
                f"{following['start_time']!r} on the same date"
            )


def resolve_block_cycle_times(
    time_blocks: list[dict], total_time_slots_needed: int
) -> list[ResolvedBlock]:
    """Resolves each time block's cycle time and slot capacity against
    total_time_slots_needed. Raises ValueError if any block is invalid, if
    an open-ended block coexists with a 'calculate for me' block or isn't
    last, or if the blocks' combined capacity doesn't add up."""
    open_ended = [b for b in time_blocks if b.get("end_time") is None]
    if len(open_ended) > 1:
        raise ValueError("At most one time block may be open-ended (no end_time)")

    for block in time_blocks:
        if block.get("end_time") is None and block.get("cycle_time") is None:
            raise ValueError(
                f"Time block starting at {block['start_time']} has no end_time "
                "and no cycle_time — an open-ended block must specify cycle_time"
            )
        if block.get("end_time") is not None:
            duration = _block_duration_seconds(block["start_time"], block["end_time"])
            if duration <= 0:
                raise ValueError(
                    f"Time block end_time must be after start_time: {block}"
                )

    sorted_blocks = sorted(time_blocks, key=lambda b: (b["date"], b["start_time"]))

    if open_ended:
        open_ended_block = open_ended[0]
        other_blocks = [b for b in time_blocks if b is not open_ended_block]
        calculate_for_me = [b for b in other_blocks if b.get("cycle_time") is None]
        if calculate_for_me:
            raise ValueError(
                "A 'calculate for me' block (cycle_time: null) cannot coexist "
                "with an open-ended block (end_time: null) — every other "
                "block must specify both end_time and cycle_time"
            )
        if sorted_blocks[-1] is not open_ended_block:
            raise ValueError(
                "An open-ended time block (no end_time) must be the last "
                "block in chronological order"
            )
        fixed_capacity = sum(
            _block_duration_seconds(b["start_time"], b["end_time"]) // b["cycle_time"]
            for b in other_blocks
        )
        remaining = total_time_slots_needed - fixed_capacity
        if remaining < 0:
            raise ValueError(
                f"Fixed time blocks already account for {fixed_capacity} "
                f"matches, more than the {total_time_slots_needed} needed"
            )
        resolved = []
        for block in sorted_blocks:
            if block is open_ended_block:
                resolved.append(
                    ResolvedBlock(
                        date=block["date"],
                        start_time=block["start_time"],
                        end_time=None,
                        cycle_time_seconds=float(block["cycle_time"]),
                        time_slot_count=remaining,
                    )
                )
            else:
                count = _block_duration_seconds(
                    block["start_time"], block["end_time"]
                ) // block["cycle_time"]
                resolved.append(
                    ResolvedBlock(
                        date=block["date"],
                        start_time=block["start_time"],
                        end_time=block["end_time"],
                        cycle_time_seconds=float(block["cycle_time"]),
                        time_slot_count=count,
                    )
                )
        return resolved

    fixed_blocks = [b for b in time_blocks if b.get("cycle_time") is not None]
    calculate_for_me_blocks = [b for b in time_blocks if b.get("cycle_time") is None]

    fixed_capacity = sum(
        _block_duration_seconds(b["start_time"], b["end_time"]) // b["cycle_time"]
        for b in fixed_blocks
    )
    remaining = total_time_slots_needed - fixed_capacity
    if remaining < 0:
        raise ValueError(
            f"Fixed time blocks already account for {fixed_capacity} matches, "
            f"more than the {total_time_slots_needed} needed"
        )

    if not calculate_for_me_blocks:
        if remaining != 0:
            raise ValueError(
                f"Time blocks account for {fixed_capacity} matches, but "
                f"{total_time_slots_needed} are needed — add a 'calculate "
                "for me' or open-ended block, or adjust the existing blocks"
            )
        return [
            ResolvedBlock(
                date=b["date"],
                start_time=b["start_time"],
                end_time=b["end_time"],
                cycle_time_seconds=float(b["cycle_time"]),
                time_slot_count=_block_duration_seconds(
                    b["start_time"], b["end_time"]
                )
                // b["cycle_time"],
            )
            for b in sorted_blocks
        ]

    if remaining <= 0:
        raise ValueError(
            "No matches remain to distribute across the 'calculate for me' "
            "time blocks — adjust target_matches_per_team or the blocks"
        )
    counts_by_block = dict(
        zip(
            (id(b) for b in calculate_for_me_blocks),
            _apportion_time_slots(calculate_for_me_blocks, remaining),
        )
    )

    resolved = []
    for block in sorted_blocks:
        if block.get("cycle_time") is not None:
            resolved.append(
                ResolvedBlock(
                    date=block["date"],
                    start_time=block["start_time"],
                    end_time=block["end_time"],
                    cycle_time_seconds=float(block["cycle_time"]),
                    time_slot_count=_block_duration_seconds(
                        block["start_time"], block["end_time"]
                    )
                    // block["cycle_time"],
                )
            )
        else:
            count = counts_by_block[id(block)]
            duration = _block_duration_seconds(block["start_time"], block["end_time"])
            resolved.append(
                ResolvedBlock(
                    date=block["date"],
                    start_time=block["start_time"],
                    end_time=block["end_time"],
                    cycle_time_seconds=duration / count,
                    time_slot_count=count,
                )
            )
    return resolved


def assign_scheduled_times(
    resolved_blocks: list[ResolvedBlock],
    sorted_distinct_time_slots: list[int],
    timezone_name: str,
) -> dict[int, dt.datetime]:
    """Maps each time_slot to a UTC scheduled_time by walking resolved_blocks
    in chronological order and advancing by each block's cycle_time_seconds.
    Each block combines its own `date` with its own `start_time` -- blocks
    are not assumed to share one calendar date."""
    tz = ZoneInfo(timezone_name)
    assignments: dict[int, dt.datetime] = {}
    slot_index = 0
    for block in resolved_blocks:
        block_start_local = dt.datetime.combine(
            block.date, _parse_time_of_day(block.start_time), tzinfo=tz
        )
        block_start_utc = block_start_local.astimezone(dt.UTC)
        for offset_index in range(block.time_slot_count):
            if slot_index >= len(sorted_distinct_time_slots):
                raise ValueError(
                    "Resolved time blocks account for more time slots than "
                    "were actually generated — this indicates an internal "
                    "inconsistency between resolve_block_cycle_times and the "
                    "generated schedule"
                )
            time_slot = sorted_distinct_time_slots[slot_index]
            assignments[time_slot] = block_start_utc + dt.timedelta(
                seconds=round(offset_index * block.cycle_time_seconds)
            )
            slot_index += 1
    return assignments


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
    assign_scheduled_times's per-block loop and
    routers/schedule.py's _check_no_overlap_with_prior_generations both
    need exactly this same date+time-of-day-against-a-timezone
    resolution and must not each reimplement it by hand."""
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


def implicit_default_time_block(
    match_duration_seconds: int, warn_below_multiplier: float
) -> dict:
    return {
        "start_time": "00:00",
        "end_time": None,
        "cycle_time": round(match_duration_seconds * warn_below_multiplier),
    }


def serialize_time_blocks(time_blocks: list[dict], timezone_name: str) -> str:
    """JSON-encodes a list of time-block dicts (as produced by
    ScheduleGenerateRequest.time_blocks or the implicit-default path) for
    storage in ScheduleGeneration.time_blocks_json. Each block's `date`
    (a real dt.date) is encoded as an ISO-8601 string.

    Each encoded block also carries `timezone_name` -- the IANA zone its
    own start_time/end_time wall-clock strings are meant to be
    interpreted against. This is what lets a later, different generation
    call's overlap check (routers/schedule.py's
    _check_no_overlap_with_prior_generations) convert this stored block
    back to a real UTC instant instead of comparing raw wall-clock
    strings across generations that may have resolved against different
    timezone frames (the implicit-default path always resolves against
    "UTC"; the explicit time_blocks path resolves against the session's
    own timezone) -- see this project's final-review fix wave, Finding 2."""
    return json.dumps(
        [
            {
                "date": b["date"].isoformat(),
                "start_time": b["start_time"],
                "end_time": b.get("end_time"),
                "cycle_time": b.get("cycle_time"),
                "timezone": timezone_name,
            }
            for b in time_blocks
        ]
    )


def deserialize_time_blocks(time_blocks_json: str) -> list[dict]:
    """Inverse of serialize_time_blocks: decodes stored JSON back into
    block dicts with a real dt.date under "date", suitable for passing to
    validate_blocks_ordered_and_non_overlapping.

    A block's "timezone" key defaults to "UTC" when absent, for rows
    written before serialize_time_blocks started storing it: that's the
    frame the more common no-time_blocks-given (implicit-default) call
    path already resolved against, and this project has never had real
    deployed event data (server/CLAUDE.md's "Database migrations"
    section) -- so there is no genuine production row whose true
    original frame this default could get wrong; it only affects test
    data and generations made in the narrow window between the phases/
    dry_run feature landing and this default being added."""
    raw = json.loads(time_blocks_json)
    return [
        {
            "date": dt.date.fromisoformat(b["date"]),
            "start_time": b["start_time"],
            "end_time": b.get("end_time"),
            "cycle_time": b.get("cycle_time"),
            "timezone": b.get("timezone", "UTC"),
        }
        for b in raw
    ]
