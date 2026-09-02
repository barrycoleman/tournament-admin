from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from zoneinfo import ZoneInfo


@dataclass
class ResolvedBlock:
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
    return counts


def resolve_block_cycle_times(
    time_blocks: list[dict], total_time_slots_needed: int
) -> list[ResolvedBlock]:
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

    sorted_blocks = sorted(time_blocks, key=lambda b: b["start_time"])

    if open_ended:
        open_ended_block = open_ended[0]
        if sorted_blocks[-1] is not open_ended_block:
            raise ValueError(
                "An open-ended time block (no end_time) must be the last "
                "block in chronological order"
            )
        other_blocks = [b for b in time_blocks if b is not open_ended_block]
        calculate_for_me = [b for b in other_blocks if b.get("cycle_time") is None]
        if calculate_for_me:
            raise ValueError(
                "A 'calculate for me' block (cycle_time: null) cannot coexist "
                "with an open-ended block (end_time: null) — every other "
                "block must specify both end_time and cycle_time"
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
    session_date: dt.date,
    timezone_name: str,
) -> dict[int, dt.datetime]:
    tz = ZoneInfo(timezone_name)
    assignments: dict[int, dt.datetime] = {}
    slot_index = 0
    for block in resolved_blocks:
        block_start_local = dt.datetime.combine(
            session_date, _parse_time_of_day(block.start_time), tzinfo=tz
        )
        block_start_utc = block_start_local.astimezone(dt.UTC)
        for offset_index in range(block.time_slot_count):
            if slot_index >= len(sorted_distinct_time_slots):
                break
            time_slot = sorted_distinct_time_slots[slot_index]
            assignments[time_slot] = block_start_utc + dt.timedelta(
                seconds=round(offset_index * block.cycle_time_seconds)
            )
            slot_index += 1
    return assignments


def implicit_default_time_block(
    match_duration_seconds: int, warn_below_multiplier: float
) -> dict:
    return {
        "start_time": "00:00",
        "end_time": None,
        "cycle_time": round(match_duration_seconds * warn_below_multiplier),
    }
