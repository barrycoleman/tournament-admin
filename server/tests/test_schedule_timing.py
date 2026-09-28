import datetime as dt
import json

import pytest

from tournament_server.services.schedule_timing import (
    ResolvedBlock,
    assign_scheduled_times,
    block_utc_bounds,
    deserialize_time_blocks,
    implicit_default_time_block,
    resolve_block_cycle_times,
    serialize_time_blocks,
    validate_blocks_ordered_and_non_overlapping,
)

D1 = dt.date(2026, 9, 5)
D2 = dt.date(2026, 9, 6)


def test_resolve_pinned_and_calculate_for_me_matches_worked_example():
    # The brainstorm's worked example: 10:00-12:00 pinned at 180s (40
    # matches), 12:30-14:30 calculate-for-me. 30 teams, 6 matches/team,
    # 1 team per alliance -> 90 matches total needed.
    blocks = [
        {"date": D1, "start_time": "10:00", "end_time": "12:00", "cycle_time": 180},
        {"date": D1, "start_time": "12:30", "end_time": "14:30", "cycle_time": None},
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=90)
    assert len(resolved) == 2
    assert resolved[0].time_slot_count == 40
    assert resolved[0].cycle_time_seconds == 180.0
    assert resolved[1].time_slot_count == 50
    assert resolved[1].cycle_time_seconds == pytest.approx(144.0)
    assert all(b.date == D1 for b in resolved)


def test_resolve_rejects_open_ended_with_calculate_for_me():
    blocks = [
        {"date": D1, "start_time": "10:00", "end_time": None, "cycle_time": 180},
        {"date": D1, "start_time": "08:00", "end_time": "10:00", "cycle_time": None},
    ]
    with pytest.raises(ValueError, match="cannot coexist"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=50)


def test_resolve_rejects_open_ended_not_last():
    blocks = [
        {"date": D1, "start_time": "08:00", "end_time": None, "cycle_time": 180},
        {"date": D1, "start_time": "10:00", "end_time": "12:00", "cycle_time": 120},
    ]
    with pytest.raises(ValueError, match="must be the last block"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=50)


def test_resolve_open_ended_absorbs_remaining_after_fixed_block():
    blocks = [
        {"date": D1, "start_time": "10:00", "end_time": "11:00", "cycle_time": 120},  # 30 slots
        {"date": D1, "start_time": "11:00", "end_time": None, "cycle_time": 90},
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=50)
    fixed = next(b for b in resolved if b.end_time is not None)
    open_ended = next(b for b in resolved if b.end_time is None)
    assert fixed.time_slot_count == 30
    assert open_ended.time_slot_count == 20


def test_resolve_rejects_mismatched_fully_pinned_blocks():
    blocks = [{"date": D1, "start_time": "10:00", "end_time": "11:00", "cycle_time": 120}]
    with pytest.raises(ValueError, match="account for 30 matches"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=50)


def test_resolve_rejects_fixed_capacity_exceeding_target():
    blocks = [{"date": D1, "start_time": "10:00", "end_time": "12:00", "cycle_time": 60}]
    with pytest.raises(ValueError, match="more than the"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=10)


def test_resolve_rejects_block_with_neither_end_time_nor_cycle_time():
    blocks = [{"date": D1, "start_time": "10:00", "end_time": None, "cycle_time": None}]
    with pytest.raises(ValueError, match="no end_time"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=10)


def test_multiple_calculate_for_me_blocks_split_capacity_by_duration():
    blocks = [
        {"date": D1, "start_time": "08:00", "end_time": "09:00", "cycle_time": None},  # 1hr
        {"date": D1, "start_time": "10:00", "end_time": "12:00", "cycle_time": None},  # 2hr
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=30)
    cycle_times = {round(b.cycle_time_seconds) for b in resolved}
    assert len(cycle_times) == 1
    assert sum(b.time_slot_count for b in resolved) == 30


def test_multiple_calculate_for_me_blocks_can_get_different_cycle_times():
    blocks = [
        {"date": D1, "start_time": "00:00", "end_time": "00:20", "cycle_time": None},
        {"date": D1, "start_time": "01:00", "end_time": "02:00", "cycle_time": None},
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=7)
    assert resolved[0].time_slot_count == 2
    assert resolved[0].cycle_time_seconds == pytest.approx(600.0)
    assert resolved[1].time_slot_count == 5
    assert resolved[1].cycle_time_seconds == pytest.approx(720.0)
    assert sum(b.time_slot_count for b in resolved) == 7


def test_resolve_rejects_too_few_remaining_slots_for_calculate_for_me_blocks():
    blocks = [
        {"date": D1, "start_time": "08:00", "end_time": "09:00", "cycle_time": None},
        {"date": D1, "start_time": "10:00", "end_time": "14:00", "cycle_time": None},
    ]
    with pytest.raises(ValueError, match="at least one"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=1)


def test_resolve_rejects_disproportionately_small_calculate_for_me_block():
    blocks = [
        {"date": D1, "start_time": "00:00", "end_time": "00:01", "cycle_time": None},
        {"date": D1, "start_time": "01:00", "end_time": "23:00", "cycle_time": None},
    ]
    with pytest.raises(ValueError, match="zero time slots"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=2)


def test_resolve_rejects_multiple_open_ended_blocks():
    blocks = [
        {"date": D1, "start_time": "10:00", "end_time": None, "cycle_time": 180},
        {"date": D1, "start_time": "14:00", "end_time": None, "cycle_time": 120},
    ]
    with pytest.raises(ValueError, match="At most one time block may be open-ended"):
        resolve_block_cycle_times(blocks, total_time_slots_needed=50)


def test_resolve_sorts_blocks_across_dates_chronologically():
    # Given out of chronological order (day 2's block listed first) --
    # resolve_block_cycle_times must still resolve day 1's block first.
    blocks = [
        {"date": D2, "start_time": "09:00", "end_time": "10:00", "cycle_time": 60},  # 60 slots
        {"date": D1, "start_time": "09:00", "end_time": "09:10", "cycle_time": 60},  # 10 slots
    ]
    resolved = resolve_block_cycle_times(blocks, total_time_slots_needed=70)
    assert resolved[0].date == D1
    assert resolved[0].time_slot_count == 10
    assert resolved[1].date == D2
    assert resolved[1].time_slot_count == 60


def test_assign_scheduled_times_produces_utc_and_respects_timezone():
    blocks = [
        ResolvedBlock(
            date=D1, start_time="10:00", end_time="10:10", cycle_time_seconds=180.0, time_slot_count=3
        )
    ]
    assignments = assign_scheduled_times(blocks, [5, 6, 7], "America/Los_Angeles")
    assert assignments[5] == dt.datetime(2026, 9, 5, 17, 0, tzinfo=dt.UTC)
    assert assignments[6] == dt.datetime(2026, 9, 5, 17, 3, tzinfo=dt.UTC)
    assert assignments[7] == dt.datetime(2026, 9, 5, 17, 6, tzinfo=dt.UTC)


def test_assign_scheduled_times_same_wall_clock_different_timezone_different_utc():
    blocks = [
        ResolvedBlock(
            date=D1, start_time="10:00", end_time="11:00", cycle_time_seconds=60.0, time_slot_count=1
        )
    ]
    la_assignments = assign_scheduled_times(blocks, [0], "America/Los_Angeles")
    ny_assignments = assign_scheduled_times(blocks, [0], "America/New_York")
    assert la_assignments[0] != ny_assignments[0]


def test_assign_scheduled_times_across_multiple_blocks():
    blocks = [
        ResolvedBlock(
            date=D1, start_time="10:00", end_time="11:00", cycle_time_seconds=120.0, time_slot_count=2
        ),
        ResolvedBlock(
            date=D1, start_time="14:00", end_time=None, cycle_time_seconds=180.0, time_slot_count=3
        ),
    ]
    assignments = assign_scheduled_times(blocks, [10, 20, 30, 40, 50], "America/Los_Angeles")
    assert assignments[10] == dt.datetime(2026, 9, 5, 17, 0, tzinfo=dt.UTC)
    assert assignments[20] == dt.datetime(2026, 9, 5, 17, 2, tzinfo=dt.UTC)
    assert assignments[30] == dt.datetime(2026, 9, 5, 21, 0, tzinfo=dt.UTC)
    assert assignments[40] == dt.datetime(2026, 9, 5, 21, 3, tzinfo=dt.UTC)
    assert assignments[50] == dt.datetime(2026, 9, 5, 21, 6, tzinfo=dt.UTC)
    for dt_obj in assignments.values():
        assert dt_obj.tzinfo is dt.UTC


def test_assign_scheduled_times_across_multiple_days():
    blocks = [
        ResolvedBlock(
            date=D1, start_time="09:00", end_time="10:00", cycle_time_seconds=120.0, time_slot_count=2
        ),
        ResolvedBlock(
            date=D2, start_time="09:00", end_time=None, cycle_time_seconds=180.0, time_slot_count=1
        ),
    ]
    assignments = assign_scheduled_times(blocks, [1, 2, 3], "America/Los_Angeles")
    assert assignments[1].date() == dt.date(2026, 9, 5)
    assert assignments[2].date() == dt.date(2026, 9, 5)
    assert assignments[3].date() == dt.date(2026, 9, 6)
    # Day 2's block starts fresh at its own 09:00, not continuing day 1's
    # cycle -- there must be a real gap, not a contiguous 120s step.
    assert (assignments[3] - assignments[2]) > dt.timedelta(hours=1)


def test_implicit_default_time_block_derives_cycle_time_from_multiplier():
    block = implicit_default_time_block(match_duration_seconds=120, warn_below_multiplier=1.5)
    assert block["cycle_time"] == 180
    assert block["end_time"] is None


def test_validate_accepts_ascending_non_overlapping_same_date_blocks():
    blocks = [
        {"date": D1, "start_time": "10:00", "end_time": "12:00", "cycle_time": 180},
        {"date": D1, "start_time": "12:00", "end_time": "14:00", "cycle_time": 180},
    ]
    validate_blocks_ordered_and_non_overlapping(blocks)  # must not raise


def test_validate_rejects_overlapping_same_date_blocks():
    blocks = [
        {"date": D1, "start_time": "10:00", "end_time": "12:00", "cycle_time": 180},
        {"date": D1, "start_time": "11:00", "end_time": "13:00", "cycle_time": 180},
    ]
    with pytest.raises(ValueError, match="must not overlap"):
        validate_blocks_ordered_and_non_overlapping(blocks)


def test_validate_accepts_same_time_of_day_on_different_dates():
    # Two blocks that would overlap if compared by time-of-day alone must
    # be accepted once they're on different calendar dates.
    blocks = [
        {"date": D1, "start_time": "10:00", "end_time": "12:00", "cycle_time": 180},
        {"date": D2, "start_time": "10:00", "end_time": "12:00", "cycle_time": 180},
    ]
    validate_blocks_ordered_and_non_overlapping(blocks)  # must not raise


def test_validate_rejects_dates_given_out_of_order():
    blocks = [
        {"date": D2, "start_time": "09:00", "end_time": "10:00", "cycle_time": 180},
        {"date": D1, "start_time": "09:00", "end_time": "10:00", "cycle_time": 180},
    ]
    with pytest.raises(ValueError, match="ascending"):
        validate_blocks_ordered_and_non_overlapping(blocks)


def test_serialize_and_deserialize_time_blocks_round_trip():
    blocks = [
        {"date": D1, "start_time": "10:00", "end_time": "12:00", "cycle_time": 180},
        {"date": D2, "start_time": "09:00", "end_time": None, "cycle_time": 120},
    ]
    round_tripped = deserialize_time_blocks(
        serialize_time_blocks(blocks, "America/Los_Angeles")
    )
    assert round_tripped == [
        {**block, "timezone": "America/Los_Angeles"} for block in blocks
    ]


def test_deserialize_time_blocks_defaults_missing_timezone_to_utc():
    # Rows written before serialize_time_blocks started storing
    # "timezone" have no such key at all -- deserialize_time_blocks must
    # default it rather than KeyError, so a pre-existing generation's
    # blocks stay readable by the overlap check.
    legacy_json = json.dumps(
        [{"date": "2026-09-05", "start_time": "10:00", "end_time": "12:00", "cycle_time": 180}]
    )
    round_tripped = deserialize_time_blocks(legacy_json)
    assert round_tripped[0]["timezone"] == "UTC"


def test_block_utc_bounds_resolves_against_given_timezone():
    block = {"date": D1, "start_time": "10:00", "end_time": "10:10", "cycle_time": 180}
    start_utc, end_utc = block_utc_bounds(block, "America/Los_Angeles")
    assert start_utc == dt.datetime(2026, 9, 5, 17, 0, tzinfo=dt.UTC)
    assert end_utc == dt.datetime(2026, 9, 5, 17, 10, tzinfo=dt.UTC)


def test_block_utc_bounds_open_ended_has_no_end():
    block = {"date": D1, "start_time": "10:00", "end_time": None, "cycle_time": 180}
    _, end_utc = block_utc_bounds(block, "UTC")
    assert end_utc is None
