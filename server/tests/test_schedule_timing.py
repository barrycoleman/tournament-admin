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


def test_multiple_calculate_for_me_blocks_get_the_same_cycle_time():
    blocks = [
        {"start_time": "08:00", "end_time": "09:00", "cycle_time": None},  # 1hr
        {"start_time": "10:00", "end_time": "12:00", "cycle_time": None},  # 2hr
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=30)
    cycle_times = {round(b.cycle_time_seconds) for b in resolved}
    assert len(cycle_times) == 1
    assert sum(b.time_slot_count for b in resolved) == 30


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
