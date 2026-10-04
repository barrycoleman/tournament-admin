import datetime as dt
import json

from tournament_server.services.schedule_timing import (
    block_utc_bounds,
    deserialize_time_blocks,
    serialize_time_blocks,
)

D1 = dt.date(2026, 9, 5)
D2 = dt.date(2026, 9, 6)


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



def test_serialize_stores_each_blocks_occupied_window():
    blocks = [
        {"date": D1, "start_time": "09:00", "end_time": "12:00", "cycle_time": None},
        {"date": D1, "start_time": "13:00", "end_time": "13:01", "cycle_time": 120},
    ]
    occupied = [
        (
            dt.datetime(2026, 9, 5, 16, 30, tzinfo=dt.UTC),
            dt.datetime(2026, 9, 5, 18, 59, 30, tzinfo=dt.UTC),
        ),
        None,
    ]
    round_tripped = deserialize_time_blocks(
        serialize_time_blocks(blocks, "America/Los_Angeles", occupied)
    )
    assert [b["occupied"] for b in round_tripped] == occupied


def test_deserialize_leaves_occupied_out_of_rows_that_never_stored_it():
    # A generation saved before occupied windows existed: the overlap check
    # must fall back to the block's own window, so the key stays absent
    # rather than reading as None ("this block holds no matches").
    legacy_json = json.dumps(
        [{"date": "2026-09-05", "start_time": "10:00", "end_time": None, "cycle_time": 180}]
    )
    assert "occupied" not in deserialize_time_blocks(legacy_json)[0]


from zoneinfo import ZoneInfo  # noqa: E402

from tournament_server.services.schedule_timing import (  # noqa: E402
    ceil_minute,
    occupied_by_window,
    overflow_suggestions,
    place_plan,
    place_slots,
    to_utc_windows,
)

LA = "America/Los_Angeles"
SAT = dt.date(2026, 11, 7)
SUN = dt.date(2026, 11, 8)


def _windows(*spans):
    """spans are (date, start_time, end_time) triples, or (start_time, end_time)
    pairs that default to SAT."""
    rows = []
    for span in spans:
        day, start, end = span if len(span) == 3 else (SAT, *span)
        rows.append({"date": day, "start_time": start, "end_time": end})
    return to_utc_windows(rows, LA)


def _local(instant):
    return instant.astimezone(ZoneInfo(LA)).strftime("%a %H:%M:%S")


def test_to_utc_windows_sorts_and_converts():
    windows = _windows((SUN, "09:00", "15:00"), (SAT, "09:00", "12:00"))
    assert [(w.date, w.start_time) for w in windows] == [(SAT, "09:00"), (SUN, "09:00")]
    assert windows[0].start == dt.datetime(2026, 11, 7, 17, 0, tzinfo=dt.UTC)
    assert windows[0].end == dt.datetime(2026, 11, 7, 20, 0, tzinfo=dt.UTC)


def test_windows_on_either_side_of_a_dst_change_keep_local_clock_times():
    # Clocks go back on 2026-11-01 in Los Angeles: 09:00 is 16:00Z before, 17:00Z after.
    windows = _windows(
        (dt.date(2026, 10, 31), "09:00", "10:00"), (dt.date(2026, 11, 1), "09:00", "10:00")
    )
    assert windows[0].start == dt.datetime(2026, 10, 31, 16, 0, tzinfo=dt.UTC)
    assert windows[1].start == dt.datetime(2026, 11, 1, 17, 0, tzinfo=dt.UTC)


def test_ceil_minute_rounds_up_only_off_the_minute():
    on = dt.datetime(2026, 11, 7, 17, 4, tzinfo=dt.UTC)
    assert ceil_minute(on) == on
    assert ceil_minute(on + dt.timedelta(seconds=30)) == on + dt.timedelta(minutes=1)


def test_place_slots_spaces_slots_by_the_cycle_time():
    windows = _windows(("09:00", "10:00"))
    starts = place_slots(windows, windows[0].start, 3, 300, 120)
    assert [_local(s) for s in starts] == ["Sat 09:00:00", "Sat 09:05:00", "Sat 09:10:00"]


def test_a_slot_may_finish_exactly_when_its_window_closes():
    windows = _windows(("09:00", "09:10"))
    starts = place_slots(windows, windows[0].start, 3, 240, 120)
    assert [_local(s) for s in starts] == ["Sat 09:00:00", "Sat 09:04:00", "Sat 09:08:00"]


def test_a_slot_that_would_run_past_close_moves_to_the_next_window_and_restarts_spacing():
    windows = _windows(("09:00", "09:09"), ("10:00", "11:00"))
    starts = place_slots(windows, windows[0].start, 4, 240, 120)
    assert [_local(s) for s in starts] == [
        "Sat 09:00:00", "Sat 09:04:00", "Sat 10:00:00", "Sat 10:04:00",
    ]


def test_slots_flow_into_the_next_day():
    windows = _windows((SAT, "09:00", "09:05"), (SUN, "09:00", "12:00"))
    starts = place_slots(windows, windows[0].start, 3, 240, 120)
    assert [_local(s) for s in starts] == ["Sat 09:00:00", "Sun 09:00:00", "Sun 09:04:00"]


def test_an_earliest_time_in_a_gap_starts_at_the_next_window():
    windows = _windows(("09:00", "12:00"), ("13:00", "17:00"))
    earliest = dt.datetime(2026, 11, 7, 20, 30, tzinfo=dt.UTC)  # 12:30 local
    assert _local(place_slots(windows, earliest, 1, 300, 120)[0]) == "Sat 13:00:00"


def test_an_earliest_time_inside_a_window_starts_there():
    windows = _windows(("09:00", "12:00"))
    earliest = dt.datetime(2026, 11, 7, 17, 42, tzinfo=dt.UTC)  # 09:42 local
    assert _local(place_slots(windows, earliest, 1, 300, 120)[0]) == "Sat 09:42:00"


def test_place_slots_returns_fewer_starts_when_the_windows_run_out():
    windows = _windows(("09:00", "09:10"))
    assert len(place_slots(windows, windows[0].start, 5, 240, 120)) == 3


def test_the_next_round_starts_on_the_minute_after_the_previous_rounds_last_match_ends():
    windows = _windows(("09:00", "12:00"))
    placement = place_plan(windows, windows[0].start, [(2, 150), (2, 240)], 120)
    assert placement.fits
    first, second = placement.round_starts
    assert [_local(s) for s in first] == ["Sat 09:00:00", "Sat 09:02:30"]
    # The second practice match ends at 09:04:30, so qualification starts at 09:05.
    assert [_local(s) for s in second] == ["Sat 09:05:00", "Sat 09:09:00"]


def test_once_a_round_overflows_every_later_slot_is_unplaced():
    windows = _windows(("09:00", "09:10"))
    placement = place_plan(windows, windows[0].start, [(4, 240), (2, 240)], 120)
    assert not placement.fits
    assert [len(s) for s in placement.round_starts] == [3, 0]
    assert placement.unplaced_slot_count == 3


def test_overflow_reports_how_far_over_and_the_window_end_that_would_fit():
    windows = _windows(("09:00", "09:10"))
    # Unbounded: 09:00, 09:04, 09:08, 09:12 -> the last ends at 09:14.
    suggestions = overflow_suggestions(windows, windows[0].start, [(4, 240)], 120, LA)
    assert suggestions.over_by_seconds == 240
    assert suggestions.suggested_last_window_end == "09:14"


def test_the_suggested_cycle_time_is_the_longest_that_fits():
    windows = _windows(("09:00", "09:10"))
    # Four slots by 09:10 need 3 * cycle + 120 <= 600, so cycle <= 160.
    suggestions = overflow_suggestions(windows, windows[0].start, [(4, 240)], 120, LA)
    assert suggestions.suggested_cycle_time_seconds == 160


def test_the_suggested_cycle_time_only_changes_the_last_round():
    windows = _windows(("09:00", "09:20"))
    # Round 1: 09:00, 09:05 (ends 09:07) -> round 2 from 09:07 needs 3 slots by 09:20.
    suggestions = overflow_suggestions(windows, windows[0].start, [(2, 300), (3, 400)], 120, LA)
    # 09:07 + 2 * cycle + 120 <= 09:20 -> cycle <= 330.
    assert suggestions.suggested_cycle_time_seconds == 330


def test_no_cycle_suggestion_when_even_the_match_length_does_not_fit():
    windows = _windows(("09:00", "09:05"))
    suggestions = overflow_suggestions(windows, windows[0].start, [(4, 240)], 120, LA)
    assert suggestions.suggested_cycle_time_seconds is None


def test_no_window_end_suggestion_past_midnight():
    windows = _windows(("23:00", "23:50"))
    # Unbounded: 23:00, 23:20, 23:40, 00:00 -> ends after midnight.
    suggestions = overflow_suggestions(windows, windows[0].start, [(4, 1200)], 120, LA)
    assert suggestions.suggested_last_window_end is None


def test_occupied_by_window_reports_each_used_windows_span():
    windows = _windows(("09:00", "09:09"), ("10:00", "11:00"), ("13:00", "14:00"))
    starts = place_slots(windows, windows[0].start, 4, 240, 120)
    occupied = occupied_by_window(windows, starts, 120)
    assert [(w.start_time, _local(a), _local(b)) for w, a, b in occupied] == [
        ("09:00", "Sat 09:00:00", "Sat 09:06:00"),
        ("10:00", "Sat 10:00:00", "Sat 10:06:00"),
    ]
