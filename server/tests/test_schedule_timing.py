import datetime as dt

import pytest

from tournament_server.services.schedule_timing import (
    ResolvedBlock,
    assign_scheduled_times,
    implicit_default_time_block,
    resolve_block_cycle_times,
)


def test_resolve_pinned_and_calculate_for_me_matches_worked_example():
    # The brainstorm's worked example: 10:00-12:00 pinned at 180s (40
    # matches), 12:30-14:30 calculate-for-me. 30 teams, 6 matches/team,
    # 1 team per alliance -> 90 matches total needed.
    blocks = [
        {"start_time": "10:00", "end_time": "12:00", "cycle_time": 180},
        {"start_time": "12:30", "end_time": "14:30", "cycle_time": None},
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=90)
    assert len(resolved) == 2
    assert resolved[0].time_slot_count == 40
    assert resolved[0].cycle_time_seconds == 180.0
    assert resolved[1].time_slot_count == 50
    assert resolved[1].cycle_time_seconds == pytest.approx(144.0)


def test_resolve_rejects_open_ended_with_calculate_for_me():
    blocks = [
        {"start_time": "10:00", "end_time": None, "cycle_time": 180},
        {"start_time": "08:00", "end_time": "10:00", "cycle_time": None},
    ]
    with pytest.raises(ValueError, match="cannot coexist"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=50)


def test_resolve_rejects_open_ended_not_last():
    blocks = [
        {"start_time": "08:00", "end_time": None, "cycle_time": 180},
        {"start_time": "10:00", "end_time": "12:00", "cycle_time": 120},
    ]
    with pytest.raises(ValueError, match="must be the last block"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=50)


def test_resolve_open_ended_absorbs_remaining_after_fixed_block():
    blocks = [
        {"start_time": "10:00", "end_time": "11:00", "cycle_time": 120},  # 30 slots
        {"start_time": "11:00", "end_time": None, "cycle_time": 90},
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=50)
    fixed = next(b for b in resolved if b.end_time is not None)
    open_ended = next(b for b in resolved if b.end_time is None)
    assert fixed.time_slot_count == 30
    assert open_ended.time_slot_count == 20


def test_resolve_rejects_mismatched_fully_pinned_blocks():
    blocks = [{"start_time": "10:00", "end_time": "11:00", "cycle_time": 120}]
    with pytest.raises(ValueError, match="account for 30 matches"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=50)


def test_resolve_rejects_fixed_capacity_exceeding_target():
    blocks = [{"start_time": "10:00", "end_time": "12:00", "cycle_time": 60}]
    with pytest.raises(ValueError, match="more than the"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=10)


def test_resolve_rejects_block_with_neither_end_time_nor_cycle_time():
    blocks = [{"start_time": "10:00", "end_time": None, "cycle_time": None}]
    with pytest.raises(ValueError, match="no end_time"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=10)


def test_multiple_calculate_for_me_blocks_split_capacity_by_duration():
    # Durations divide the remaining slots into exact integer proportions
    # here (1hr:2hr = 10:20 of 30), so the computed cycle times end up
    # equal — the common case, not a general guarantee (see the next test
    # for the case where they don't divide evenly).
    blocks = [
        {"start_time": "08:00", "end_time": "09:00", "cycle_time": None},  # 1hr
        {"start_time": "10:00", "end_time": "12:00", "cycle_time": None},  # 2hr
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=30)
    cycle_times = {round(b.cycle_time_seconds) for b in resolved}
    assert len(cycle_times) == 1
    assert sum(b.time_slot_count for b in resolved) == 30


def test_multiple_calculate_for_me_blocks_can_get_different_cycle_times():
    # 20min + 60min blocks needing 7 slots: proportional shares are 1.75
    # and 5.25, which the largest-remainder method rounds to 2 and 5 —
    # integer counts that don't divide the durations into equal cycle
    # times (1200/2=600s vs 3600/5=720s). This is expected, not a bug:
    # each block's own slots still fit exactly inside its own window.
    blocks = [
        {"start_time": "00:00", "end_time": "00:20", "cycle_time": None},
        {"start_time": "01:00", "end_time": "02:00", "cycle_time": None},
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=7)
    assert resolved[0].time_slot_count == 2
    assert resolved[0].cycle_time_seconds == pytest.approx(600.0)
    assert resolved[1].time_slot_count == 5
    assert resolved[1].cycle_time_seconds == pytest.approx(720.0)
    assert sum(b.time_slot_count for b in resolved) == 7


def test_resolve_rejects_too_few_remaining_slots_for_calculate_for_me_blocks():
    blocks = [
        {"start_time": "08:00", "end_time": "09:00", "cycle_time": None},
        {"start_time": "10:00", "end_time": "14:00", "cycle_time": None},
    ]
    with pytest.raises(ValueError, match="at least one"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=1)


def test_resolve_rejects_disproportionately_small_calculate_for_me_block():
    # Enough slots overall to satisfy the "at least one per block" guard
    # (2 slots, 2 blocks), but one block's duration (1 minute) is so tiny
    # relative to the other (22 hours) that duration-proportional
    # apportionment still rounds its share down to zero.
    blocks = [
        {"start_time": "00:00", "end_time": "00:01", "cycle_time": None},
        {"start_time": "01:00", "end_time": "23:00", "cycle_time": None},
    ]
    with pytest.raises(ValueError, match="zero time slots"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=2)


def test_assign_scheduled_times_produces_utc_and_respects_timezone():
    blocks = [
        ResolvedBlock(
            start_time="10:00", end_time="10:10", cycle_time_seconds=180.0, time_slot_count=3
        )
    ]
    assignments = assign_scheduled_times(
        blocks, [5, 6, 7], dt.date(2026, 9, 5), "America/Los_Angeles"
    )
    assert assignments[5] == dt.datetime(2026, 9, 5, 17, 0, tzinfo=dt.UTC)
    assert assignments[6] == dt.datetime(2026, 9, 5, 17, 3, tzinfo=dt.UTC)
    assert assignments[7] == dt.datetime(2026, 9, 5, 17, 6, tzinfo=dt.UTC)


def test_assign_scheduled_times_same_wall_clock_different_timezone_different_utc():
    blocks = [
        ResolvedBlock(
            start_time="10:00", end_time="11:00", cycle_time_seconds=60.0, time_slot_count=1
        )
    ]
    la_assignments = assign_scheduled_times(
        blocks, [0], dt.date(2026, 9, 5), "America/Los_Angeles"
    )
    ny_assignments = assign_scheduled_times(
        blocks, [0], dt.date(2026, 9, 5), "America/New_York"
    )
    assert la_assignments[0] != ny_assignments[0]


def test_implicit_default_time_block_derives_cycle_time_from_multiplier():
    block = implicit_default_time_block(match_duration_seconds=120, warn_below_multiplier=1.5)
    assert block["cycle_time"] == 180
    assert block["end_time"] is None


def test_resolve_rejects_multiple_open_ended_blocks():
    blocks = [
        {"start_time": "10:00", "end_time": None, "cycle_time": 180},
        {"start_time": "14:00", "end_time": None, "cycle_time": 120},
    ]
    with pytest.raises(ValueError, match="At most one time block may be open-ended"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=50)


def test_assign_scheduled_times_across_multiple_blocks():
    blocks = [
        ResolvedBlock(
            start_time="10:00", end_time="11:00", cycle_time_seconds=120.0, time_slot_count=2
        ),
        ResolvedBlock(
            start_time="14:00", end_time=None, cycle_time_seconds=180.0, time_slot_count=3
        ),
    ]
    assignments = assign_scheduled_times(
        blocks, [10, 20, 30, 40, 50], dt.date(2026, 9, 5), "America/Los_Angeles"
    )
    # First block: 2 slots (10, 20) spaced by 120 seconds at 10:00 LA (17:00 UTC)
    assert assignments[10] == dt.datetime(2026, 9, 5, 17, 0, tzinfo=dt.UTC)
    assert assignments[20] == dt.datetime(2026, 9, 5, 17, 2, tzinfo=dt.UTC)
    # Second block: 3 slots (30, 40, 50) starting at 14:00 LA (21:00 UTC), spaced by 180 seconds
    assert assignments[30] == dt.datetime(2026, 9, 5, 21, 0, tzinfo=dt.UTC)
    assert assignments[40] == dt.datetime(2026, 9, 5, 21, 3, tzinfo=dt.UTC)
    assert assignments[50] == dt.datetime(2026, 9, 5, 21, 6, tzinfo=dt.UTC)
    # All returned datetimes are UTC-aware
    for dt_obj in assignments.values():
        assert dt_obj.tzinfo is dt.UTC
