# Multi-Round Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the tournament-admin server backend a real notion of multi-day division schedules, practice-vs-qualification ranking exclusion, human-legible per-match labels, and one combined "practice + qualification" schedule-generation call with a dry-run preview mode.

**Architecture:** Four phases, built in dependency order, each ending in a working, independently-tested slice: (1) exclude practice matches from ranking queries; (2) let a `TimeBlock` carry its own calendar date so one `POST /api/schedule` (and its cumulative history for a `(session, division)`) can span multiple days; (3) compute a human-legible `label` on every `MatchRead`, which requires `BracketMatchup` to know its own position in the bracket; (4) let one `POST /api/schedule` request generate several round types ("phases") in one call, with earlier phases always landing at earlier `scheduled_time`s, plus a `dry_run` preview mode.

**Tech Stack:** Python, FastAPI, SQLAlchemy 2.0, Alembic, SQLite, pytest + `TestClient`.

**Spec:** `docs/superpowers/specs/2026-09-26-multi-round-scheduling-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every change ships with pytest unit/integration tests against a real `TestClient` and a real temp-file SQLite database, in the same commit as the code.
- Existing single-day, single-round-type callers of `POST /api/schedule` must keep working unchanged (backward-compatible request/response shape) — run the full existing `tests/test_schedule.py` suite at the end of every task that touches `routers/schedule.py` or `services/schedule_timing.py`.
- No schema change may destroy existing data. Every model change ships with a real Alembic migration in the same commit as the model change (`server/CLAUDE.md`'s "Database migrations" section) — nullable columns, no data loss.
- The current Alembic head revision is `f3a91c6e5b7d`. Migrations in this plan chain from there in task order.

---

### Task 1: Exclude practice matches from rankings

**Files:**
- Modify: `server/src/tournament_server/services/ranking.py:140-154` (`recompute_rankings`'s match query)
- Modify: `server/src/tournament_server/services/ranking.py:333-358` (`recompute_event_rankings`'s match query)
- Test: `server/tests/test_rankings.py`

**Interfaces:**
- Consumes: nothing new — `Match.round_type` already exists.
- Produces: nothing new — this task only narrows two existing internal queries. No caller-visible signature changes.

- [ ] **Step 1: Write the failing test**

Add to `server/tests/test_rankings.py`:

```python
def test_practice_matches_never_count_toward_rankings(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    team_ids = {}
    for number in ["1", "2", "3", "4"]:
        team = client.post(
            "/api/teams", json={"number": number, "name": f"Team {number}"}
        ).json()
        team_ids[number] = team["id"]
    t1, t2, t3, t4 = team_ids["1"], team_ids["2"], team_ids["3"], team_ids["4"]

    # A practice match, fully scored: if it counted, T1/T2 would show up
    # with win_points from this match alone (no qualification matches
    # exist yet at this point).
    practice_match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "practice",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    red = next(a["id"] for a in practice_match["alliances"] if a["station"] == "red")
    blue = next(a["id"] for a in practice_match["alliances"] if a["station"] == "blue")
    _score(client, practice_match["id"], red, high_balls=16, low_balls=2)
    _score(client, practice_match["id"], blue, high_balls=6, low_balls=2)

    response = client.get(f"/api/rankings?session_id={session_id}")
    assert response.status_code == 200
    assert response.json() == []

    # A qualification match between the same teams must still count.
    qual_match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    red = next(a["id"] for a in qual_match["alliances"] if a["station"] == "red")
    blue = next(a["id"] for a in qual_match["alliances"] if a["station"] == "blue")
    _score(client, qual_match["id"], red, high_balls=16, low_balls=2)
    _score(client, qual_match["id"], blue, high_balls=6, low_balls=2)

    response = client.get(f"/api/rankings?session_id={session_id}")
    assert response.status_code == 200
    rows = {row["team_id"]: row for row in response.json()}
    assert rows[t1]["win_points"] == 2
    assert rows[t3]["win_points"] == 0


def test_practice_matches_never_count_toward_event_wide_rankings(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    team_id = client.post(
        "/api/teams", json={"number": "1", "name": "Team 1"}
    ).json()["id"]

    practice_match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "practice",
            "match_number": 1,
            "field_id": None,
            "alliances": [{"station": "solo", "team_ids": [team_id]}],
        },
    ).json()
    alliance_id = practice_match["alliances"][0]["id"]
    _score(client, practice_match["id"], alliance_id, high_balls=16, low_balls=2)

    response = client.get(f"/api/rankings?session_id={session_id}&event_wide=true")
    assert response.status_code == 200
    assert response.json() == []
```

Check whether `_score` in `test_rankings.py` already exists (it does, at the top of the file) — reuse it as-is; it takes `(client, match_id, alliance_id, high_balls, low_balls)`.

The second test uses the `cooperative_client` fixture (see `server/tests/conftest.py`) — this exercises `recompute_event_rankings`, which only runs for the `cooperative_score` game model (see `services/ranking.py:337`), so it needs a plugin declaring that model. Confirm `cooperative_client` seeds a `cooperative_score` game plugin before writing the assertion; if its default game plugin name differs from what auto-registers, check `conftest.py` for the exact plugin name it installs and use whatever `POST /api/event/game-plugin` call (if any) that fixture already performs — if the fixture already selects the plugin, do not call `POST /api/event/game-plugin` again in the test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pytest tests/test_rankings.py -v`
Expected: `test_practice_matches_never_count_toward_rankings` FAILS (rows for t1/t3 would show `win_points` reflecting the practice match, or the first assertion `response.json() == []` fails because the practice match already produced a ranking row).

- [ ] **Step 3: Implement the fix**

In `server/src/tournament_server/services/ranking.py`, `recompute_rankings` (around line 145):

```python
    query = select(Match).where(
        Match.session_id == session_id,
        Match.status == "completed",
        Match.finals_bracket_id.is_(None),
        Match.round_type != "practice",
    )
```

And in `recompute_event_rankings` (around line 349):

```python
    query = select(Match).where(
        Match.session_id.in_(session_ids),
        Match.status == "completed",
        Match.finals_bracket_id.is_(None),
        Match.round_type != "practice",
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pytest tests/test_rankings.py tests/test_ranking_configuration.py -v`
Expected: all PASS.

- [ ] **Step 5: Run the full backend suite to check for regressions**

Run: `cd server && pytest tests/ -v`
Expected: all PASS (this query narrowing only removes rows that were previously wrongly included; no existing test should have depended on a practice match counting).

- [ ] **Step 6: Update the known-gap note in `server/CLAUDE.md`**

Find the "Known, deliberate gap" paragraph under "## Finals" that reads:

```
**Known, deliberate gap**: `recompute_rankings`/`recompute_event_rankings`
now exclude finals matches (`Match.finals_bracket_id IS NOT NULL`) from
qualification ranking — but they still don't exclude `practice`-round
matches, a pre-existing gap from an earlier phase this plan didn't
introduce and doesn't fix.
```

Replace it with:

```
**Fixed**: `recompute_rankings`/`recompute_event_rankings` exclude both
finals matches (`Match.finals_bracket_id IS NOT NULL`) and `practice`-round
matches (`Match.round_type == "practice"`) from qualification ranking. See
`docs/superpowers/specs/2026-09-26-multi-round-scheduling-design.md`'s
Phase 1.
```

- [ ] **Step 7: Commit**

```bash
cd server
git add src/tournament_server/services/ranking.py tests/test_rankings.py CLAUDE.md
git commit -m "Exclude practice matches from ranking computation"
```

---

### Task 2: Make `schedule_timing.py` date-aware

**Files:**
- Modify: `server/src/tournament_server/services/schedule_timing.py` (whole file — every block-ordering/comparison function, plus two new serialization helpers)
- Test: `server/tests/test_schedule_timing.py` (whole file — every existing block dict/`ResolvedBlock` needs a `date`)

**Interfaces:**
- Consumes: nothing new.
- Produces (for later tasks):
  - `ResolvedBlock` dataclass gains a required `date: dt.date` field (used by Task 3's `routers/schedule.py` wiring and Task 8's multi-phase logic).
  - `assign_scheduled_times(resolved_blocks: list[ResolvedBlock], sorted_distinct_time_slots: list[int], timezone_name: str) -> dict[int, dt.datetime]` — the `session_date: dt.date` positional parameter is **removed**; every caller must be updated (Task 3, Task 8).
  - `validate_blocks_ordered_and_non_overlapping(time_blocks: list[dict]) -> None` — every input dict now requires a `"date"` key (a `dt.date`), not just `"start_time"`/`"end_time"`.
  - `resolve_block_cycle_times(time_blocks: list[dict], total_time_slots_needed: int) -> list[ResolvedBlock]` — every input dict now requires a `"date"` key; sorts by `(date, start_time)` instead of `start_time` alone.
  - New: `serialize_time_blocks(time_blocks: list[dict]) -> str` and `deserialize_time_blocks(time_blocks_json: str) -> list[dict]` (used by Task 3's `ScheduleGeneration.time_blocks_json` persistence and Task 4's overlap check).

- [ ] **Step 1: Write the failing tests (full replacement of `server/tests/test_schedule_timing.py`)**

Replace the entire file content with:

```python
import datetime as dt

import pytest

from tournament_server.services.schedule_timing import (
    ResolvedBlock,
    assign_scheduled_times,
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
    round_tripped = deserialize_time_blocks(serialize_time_blocks(blocks))
    assert round_tripped == blocks
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pytest tests/test_schedule_timing.py -v`
Expected: FAIL — `assign_scheduled_times() takes 3 positional arguments but 4 were given` is wrong direction (old signature still takes 4; these calls now give 3 without `session_date`), `ResolvedBlock() got an unexpected keyword argument 'date'`, `KeyError: 'date'` inside `resolve_block_cycle_times`/`validate_blocks_ordered_and_non_overlapping`, and `ImportError: cannot import name 'serialize_time_blocks'`.

- [ ] **Step 3: Rewrite `server/src/tournament_server/services/schedule_timing.py`**

Replace the whole file with:

```python
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


def implicit_default_time_block(
    match_duration_seconds: int, warn_below_multiplier: float
) -> dict:
    return {
        "start_time": "00:00",
        "end_time": None,
        "cycle_time": round(match_duration_seconds * warn_below_multiplier),
    }


def serialize_time_blocks(time_blocks: list[dict]) -> str:
    """JSON-encodes a list of time-block dicts (as produced by
    ScheduleGenerateRequest.time_blocks or the implicit-default path) for
    storage in ScheduleGeneration.time_blocks_json. Each block's `date`
    (a real dt.date) is encoded as an ISO-8601 string."""
    return json.dumps(
        [
            {
                "date": b["date"].isoformat(),
                "start_time": b["start_time"],
                "end_time": b.get("end_time"),
                "cycle_time": b.get("cycle_time"),
            }
            for b in time_blocks
        ]
    )


def deserialize_time_blocks(time_blocks_json: str) -> list[dict]:
    """Inverse of serialize_time_blocks: decodes stored JSON back into
    block dicts with a real dt.date under "date", suitable for passing to
    validate_blocks_ordered_and_non_overlapping."""
    raw = json.loads(time_blocks_json)
    return [
        {
            "date": dt.date.fromisoformat(b["date"]),
            "start_time": b["start_time"],
            "end_time": b.get("end_time"),
            "cycle_time": b.get("cycle_time"),
        }
        for b in raw
    ]
```

Note `implicit_default_time_block` is deliberately unchanged (no `date` key) — its caller (`routers/schedule.py`, Task 3) patches in both `start_time` and `date` after calling it, matching the existing pattern where the caller already patches `start_time`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pytest tests/test_schedule_timing.py -v`
Expected: all PASS.

- [ ] **Step 5: Commit**

Note: `routers/schedule.py` still calls the old 4-argument `assign_scheduled_times` and still builds block dicts with no `"date"` key — it will not import or run correctly until Task 3 updates it. Do not run the full test suite yet; `tests/test_schedule.py` is expected to fail until Task 3 lands. Commit this task's changes on their own:

```bash
cd server
git add src/tournament_server/services/schedule_timing.py tests/test_schedule_timing.py
git commit -m "Make schedule_timing.py date-aware for multi-day time blocks"
```

---

### Task 3: `TimeBlock.date`, `ScheduleGeneration.time_blocks_json`, and single-call wiring

**Files:**
- Modify: `server/src/tournament_server/schemas/schedule.py`
- Modify: `server/src/tournament_server/models/schedule_generation.py`
- Create: `server/src/tournament_server/_alembic/versions/a2c6f19e4d80_add_schedule_generations_time_blocks_json.py`
- Modify: `server/src/tournament_server/routers/schedule.py` (imports, the `session_obj`/`time_blocks`/`assign_scheduled_times` block, the `ScheduleGeneration(...)` construction)
- Test: `server/tests/test_schedule.py`

**Interfaces:**
- Consumes: `ResolvedBlock.date`, `assign_scheduled_times(resolved_blocks, sorted_distinct_time_slots, timezone_name)`, `serialize_time_blocks` (all from Task 2).
- Produces: `TimeBlock.date: dt.date` (required field on every `time_blocks` entry in `POST /api/schedule`'s request body); `ScheduleGeneration.time_blocks_json: str | None` (consumed by Task 4's overlap check and Task 8's persistence).

- [ ] **Step 1: Update `server/src/tournament_server/schemas/schedule.py`**

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, Field


class TimeBlock(BaseModel):
    date: dt.date
    start_time: str = Field(pattern=r"^\d{2}:\d{2}$")
    end_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    cycle_time: int | None = Field(default=None, gt=0)


class ScheduleGenerateRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    round_type: str
    target_matches_per_team: int
    scheduler_plugin_name: str
    excluded_team_ids: list[int] = []
    time_blocks: list[TimeBlock] | None = None
    warn_below_multiplier: float = 1.5


class ResolvedTimeBlockRead(BaseModel):
    start_time: str
    end_time: str | None
    cycle_time_seconds: float


class ScheduleGenerateResponse(BaseModel):
    schedule_generation_id: int
    match_count: int
    resolved_time_blocks: list[ResolvedTimeBlockRead]
    cycle_time_warning: str | None
```

(This is the same file as before with only the `TimeBlock` class changed — `ScheduleGenerateRequest`/`ScheduleGenerateResponse` gain their Phase 4 fields in Task 7, not here.)

- [ ] **Step 2: Update `server/src/tournament_server/models/schedule_generation.py`**

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


class ScheduleGeneration(Base):
    __tablename__ = "schedule_generations"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    round_type: Mapped[str] = mapped_column(String(20))
    scheduler_plugin_name: Mapped[str] = mapped_column(String(200))
    scheduler_plugin_version: Mapped[str] = mapped_column(String(50))
    target_matches_per_team: Mapped[int] = mapped_column(Integer)
    generated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime)
    time_blocks_json: Mapped[str | None] = mapped_column(Text, default=None)
```

- [ ] **Step 3: Write the migration**

Create `server/src/tournament_server/_alembic/versions/a2c6f19e4d80_add_schedule_generations_time_blocks_json.py`:

```python
"""add schedule_generations time_blocks_json

Revision ID: a2c6f19e4d80
Revises: f3a91c6e5b7d
Create Date: 2026-09-28 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'a2c6f19e4d80'
down_revision: Union[str, None] = 'f3a91c6e5b7d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: pre-existing ScheduleGeneration rows have no stored blocks
    # to backfill from -- the new per-(session, division) overlap check
    # (a later phase of this same feature) simply has nothing to compare
    # against for those rows, which is correct: a schedule generated
    # before this column existed never went through block-based
    # cross-generation validation in the first place.
    op.add_column(
        'schedule_generations', sa.Column('time_blocks_json', sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('schedule_generations', 'time_blocks_json')
```

- [ ] **Step 4: Run the alembic drift test**

Run: `cd server && pytest tests/test_alembic_drift.py -v`
Expected: PASS (confirms the migration produces a schema matching the model change exactly).

- [ ] **Step 5: Update `server/src/tournament_server/routers/schedule.py`**

Add `serialize_time_blocks` to the existing `from tournament_server.services.schedule_timing import (...)` block:

```python
from tournament_server.services.schedule_timing import (
    assign_scheduled_times,
    implicit_default_time_block,
    resolve_block_cycle_times,
    serialize_time_blocks,
    validate_blocks_ordered_and_non_overlapping,
)
```

Replace the `session_obj`/`time_blocks_input`/`assign_scheduled_times` block (originally lines 247-280) with:

```python
    session_obj = db.get(TournamentSession, payload.session_id)
    if payload.time_blocks is not None:
        if session_obj.timezone is None:
            raise HTTPException(
                status_code=422,
                detail="Session must have timezone set to use time_blocks",
            )
        time_blocks_input = [b.model_dump() for b in payload.time_blocks]
        timezone_name = session_obj.timezone
    else:
        implicit_start = utc_now() + dt.timedelta(minutes=5)
        time_blocks_input = [implicit_default_time_block(
            match_duration_seconds, payload.warn_below_multiplier
        )]
        time_blocks_input[0]["start_time"] = implicit_start.strftime("%H:%M")
        time_blocks_input[0]["date"] = implicit_start.date()
        timezone_name = "UTC"

    sorted_distinct_time_slots = sorted({entry["time_slot"] for entry in generated})
    try:
        if payload.time_blocks is not None:
            validate_blocks_ordered_and_non_overlapping(time_blocks_input)
        resolved_blocks = resolve_block_cycle_times(
            time_blocks_input, total_time_slots_needed
        )
        scheduled_times = assign_scheduled_times(
            resolved_blocks, sorted_distinct_time_slots, timezone_name
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
```

Add `time_blocks_json=serialize_time_blocks(time_blocks_input),` to the `ScheduleGeneration(...)` construction, right after `generated_at=utc_now(),`.

- [ ] **Step 6: Update `server/tests/test_schedule.py`**

Every dict inside every `time_blocks` list in this file needs a `"date": "2026-09-05"` key added (matching the `"session_date": "2026-09-05"` value already used in that same test's session setup) — this is a mechanical, uniform change: for example,

```python
"time_blocks": [
    {"start_time": "10:00", "end_time": "12:00", "cycle_time": None}
],
```

becomes

```python
"time_blocks": [
    {"date": "2026-09-05", "start_time": "10:00", "end_time": "12:00", "cycle_time": None}
],
```

Apply this to every `time_blocks` list in the file (there are entries at approximately lines 384-386, 432-435, 471-474, 512-515, 530-533, 547-550, 564-567, 601-605, 639-643, 748-750, and any later ones in the file past line 760 — grep for `"time_blocks": [` to find every occurrence and confirm none are missed).

Then replace the test named `test_generate_schedule_rejects_time_blocks_without_session_date_or_timezone` (originally around line 422) — `session_date` is no longer required for `time_blocks`, only `timezone` is — with:

```python
def test_generate_schedule_rejects_time_blocks_without_timezone(client):
    session_id, team_ids = _setup_ready_session(client)

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"date": "2026-09-05", "start_time": "10:00", "end_time": "12:00", "cycle_time": None}
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_allows_time_blocks_without_session_date(client):
    # session_date is display-only now -- a session with no session_date
    # at all, only a timezone, must still be able to use time_blocks,
    # since each block carries its own date.
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={"label": "Session 1", "timezone": "America/Los_Angeles"},
    ).json()["id"]
    assert client.get(f"/api/sessions").json()[0]["session_date"] is None
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"date": "2026-09-05", "start_time": "10:00", "end_time": "12:00", "cycle_time": None}
            ],
        },
    )
    assert response.status_code == 201
```

If `GET /api/sessions` (list) doesn't exist or has a different response shape, adjust the assertion to whatever session-read endpoint exists (`GET /api/sessions/{id}` is an acceptable substitute) — the point of the assertion is just confirming `session_date` really is `None` for this session, not exercising a specific endpoint.

Then add a new test for a genuinely multi-day schedule, appended near the other `time_blocks` tests:

```python
def test_generate_schedule_with_time_blocks_spanning_multiple_days(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 6,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"date": "2026-09-05", "start_time": "09:00", "end_time": "12:00", "cycle_time": 60},
                {"date": "2026-09-06", "start_time": "09:00", "end_time": None, "cycle_time": 60},
            ],
        },
    )
    assert response.status_code == 201

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    scheduled_dates = {m["scheduled_time"][:10] for m in matches}
    assert "2026-09-05" in scheduled_dates
    # America/Los_Angeles 09:00 on 2026-09-06 is 2026-09-06T16:00Z --
    # comparing the UTC date string directly is safe here since the
    # offset doesn't cross midnight UTC for this timezone/time.
    assert "2026-09-06" in scheduled_dates
```

- [ ] **Step 7: Run tests to verify they fail, then pass**

Run: `cd server && pytest tests/test_schedule.py -v`

Before Step 5/6's edits: expect widespread failures (`ResolvedTimeBlockRead`/`assign_scheduled_times` signature mismatches, missing `date` key errors). After Step 5/6's edits: expect all PASS.

- [ ] **Step 8: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
cd server
git add src/tournament_server/schemas/schedule.py src/tournament_server/models/schedule_generation.py \
        src/tournament_server/_alembic/versions/a2c6f19e4d80_add_schedule_generations_time_blocks_json.py \
        src/tournament_server/routers/schedule.py tests/test_schedule.py
git commit -m "Add per-block dates and time_blocks_json storage for multi-day schedules"
```

---

### Task 4: Per-`(session, division)` overlap enforcement across generation calls

**Files:**
- Modify: `server/src/tournament_server/routers/schedule.py` (new helper function, one call site in `generate_schedule`, and `clear_schedule`'s deletion logic)
- Test: `server/tests/test_schedule.py`

**Interfaces:**
- Consumes: `deserialize_time_blocks` (Task 2), `ScheduleGeneration.time_blocks_json` (Task 3).
- Produces: nothing new for later tasks — this closes the loop Task 3 opened (a generation's blocks are now checked against every other generation's blocks for the same `(session, division)`, and a cleared generation's blocks stop being checked against).

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/test_schedule.py`:

```python
def test_generate_schedule_rejects_overlap_with_a_prior_generation(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    first = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "practice",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"date": "2026-09-05", "start_time": "09:00", "end_time": "10:00", "cycle_time": 60}
            ],
        },
    )
    assert first.status_code == 201

    # A second generation (different round_type, same session/division)
    # whose block overlaps the first's must be rejected.
    second = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"date": "2026-09-05", "start_time": "09:30", "end_time": "11:00", "cycle_time": 60}
            ],
        },
    )
    assert second.status_code == 422
    assert "schedule_generation_id" in second.json()["detail"]

    # Matches from the first generation are untouched by the rejected call.
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert all(m["round_type"] == "practice" for m in matches)


def test_generate_schedule_allows_overlap_across_different_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    division_2_id = client.post("/api/divisions", json={"name": "Division 2"}).json()["id"]

    division_1_id = client.get("/api/divisions").json()[0]["id"]
    field_set_1 = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Set 1", "division_id": division_1_id},
    ).json()["id"]
    field_set_2 = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Set 2", "division_id": division_2_id},
    ).json()["id"]
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Field A", "field_set_id": field_set_1},
    )
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Field B", "field_set_id": field_set_2},
    )

    team_ids_div1, team_ids_div2 = [], []
    for i in range(4):
        team = client.post(
            "/api/teams", json={"number": f"1{i}", "name": f"D1 Team {i}"}
        ).json()
        client.patch(f"/api/teams/{team['id']}", json={"division_id": division_1_id})
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team["id"], "checked_in": True},
        )
        team_ids_div1.append(team["id"])
    for i in range(4):
        team = client.post(
            "/api/teams", json={"number": f"2{i}", "name": f"D2 Team {i}"}
        ).json()
        client.patch(f"/api/teams/{team['id']}", json={"division_id": division_2_id})
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team["id"], "checked_in": True},
        )
        team_ids_div2.append(team["id"])

    same_block = [
        {"date": "2026-09-05", "start_time": "09:00", "end_time": "10:00", "cycle_time": 60}
    ]
    response_1 = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "division_id": division_1_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": same_block,
        },
    )
    assert response_1.status_code == 201

    response_2 = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "division_id": division_2_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": same_block,
        },
    )
    assert response_2.status_code == 201


def test_delete_schedule_clears_stored_blocks_allowing_reuse(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    block = [
        {"date": "2026-09-05", "start_time": "09:00", "end_time": "10:00", "cycle_time": 60}
    ]
    first = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": block,
        },
    )
    assert first.status_code == 201

    client.delete(
        "/api/schedule",
        params={"session_id": session_id, "round_type": "qualification"},
    )

    # The exact same block, reused for the same round_type after a
    # DELETE, must succeed -- the cleared generation's blocks must no
    # longer be checked against.
    second = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": block,
        },
    )
    assert second.status_code == 201
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pytest tests/test_schedule.py -k "overlap_with_a_prior or overlap_across_different_divisions or clears_stored_blocks" -v`
Expected: `test_generate_schedule_rejects_overlap_with_a_prior_generation` FAILS (second call returns 201, not 422 — no cross-generation check exists yet). The other two may already pass by coincidence but must be re-verified after Step 3.

- [ ] **Step 3: Implement the overlap check and DELETE cleanup**

In `server/src/tournament_server/routers/schedule.py`, add `deserialize_time_blocks` to the existing `schedule_timing` import block (alongside `serialize_time_blocks` from Task 3):

```python
from tournament_server.services.schedule_timing import (
    assign_scheduled_times,
    deserialize_time_blocks,
    implicit_default_time_block,
    resolve_block_cycle_times,
    serialize_time_blocks,
    validate_blocks_ordered_and_non_overlapping,
)
```

Add a new helper function right after `_validate_generated_schedule`:

```python
def _check_no_overlap_with_prior_generations(
    db: Session, session_id: int, division_id: int | None, new_blocks: list[dict]
) -> None:
    """Raises ValueError if any of new_blocks overlaps any block stored by
    an earlier, still-live ScheduleGeneration for the same
    (session_id, division_id) -- checked across every round_type, not just
    the one being generated now, since two round_types sharing the same
    physical fields must never double-book a time window."""
    query = select(ScheduleGeneration).where(ScheduleGeneration.session_id == session_id)
    if division_id is None:
        query = query.where(ScheduleGeneration.division_id.is_(None))
    else:
        query = query.where(ScheduleGeneration.division_id == division_id)
    for prior in db.execute(query).scalars().all():
        if prior.time_blocks_json is None:
            continue
        prior_blocks = deserialize_time_blocks(prior.time_blocks_json)
        for new_block in new_blocks:
            for prior_block in prior_blocks:
                if new_block["date"] != prior_block["date"]:
                    continue
                new_start, new_end = new_block["start_time"], new_block.get("end_time")
                prior_start, prior_end = prior_block["start_time"], prior_block.get("end_time")
                new_ends_before_prior = new_end is not None and new_end <= prior_start
                prior_ends_before_new = prior_end is not None and prior_end <= new_start
                if not (new_ends_before_prior or prior_ends_before_new):
                    raise ValueError(
                        "time_blocks overlap with an existing schedule: "
                        f"schedule_generation_id {prior.id}'s block starting at "
                        f"{prior_block['date']} {prior_start!r}"
                    )
```

In `generate_schedule`, add the call right after `validate_blocks_ordered_and_non_overlapping(time_blocks_input)`:

```python
    try:
        if payload.time_blocks is not None:
            validate_blocks_ordered_and_non_overlapping(time_blocks_input)
            _check_no_overlap_with_prior_generations(
                db, payload.session_id, payload.division_id, time_blocks_input
            )
        resolved_blocks = resolve_block_cycle_times(
            time_blocks_input, total_time_slots_needed
        )
        scheduled_times = assign_scheduled_times(
            resolved_blocks, sorted_distinct_time_slots, timezone_name
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
```

In `clear_schedule`, add ScheduleGeneration deletion right before the existing final `db.commit()` (i.e. after the `for match in matches:` loop that deletes matches/alliances/score records):

```python
    generation_query = select(ScheduleGeneration).where(
        ScheduleGeneration.session_id == session_id,
        ScheduleGeneration.round_type == round_type,
    )
    if division_id is None:
        generation_query = generation_query.where(ScheduleGeneration.division_id.is_(None))
    else:
        generation_query = generation_query.where(ScheduleGeneration.division_id == division_id)
    for generation in db.execute(generation_query).scalars().all():
        db.delete(generation)

    db.commit()
```

(This replaces the bare `db.commit()` that currently follows the match-deletion loop — the `for generation in ...` block goes immediately before it, matches are already `db.delete()`-queued from the loop above and get flushed automatically before the `select(ScheduleGeneration)` query runs, so there is no foreign-key ordering hazard.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pytest tests/test_schedule.py -v`
Expected: all PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd server
git add src/tournament_server/routers/schedule.py tests/test_schedule.py
git commit -m "Enforce per-(session, division) time-block overlap across generation calls"
```

---

### Task 5: `BracketMatchup.matchup_number` and per-matchup game numbering

**Files:**
- Modify: `server/src/tournament_server/models/bracket_matchup.py`
- Create: `server/src/tournament_server/_alembic/versions/c9d34b7a1f02_add_bracket_matchups_matchup_number.py`
- Modify: `server/src/tournament_server/services/finals.py` (`generate_bracket`, `_create_matchup_game`)
- Test: `server/tests/test_finals.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `BracketMatchup.matchup_number: int | None` (consumed by Task 6's `match_label` wiring); `_create_matchup_game`'s `Match.match_number` is now scoped per `bracket_matchup_id` (restarts at 1 for each matchup) rather than bracket-wide.

- [ ] **Step 1: Write/update the failing tests**

In `server/tests/test_finals.py`, two existing tests rely on `match_number` being a single bracket-wide counter to disambiguate which pending/created game belongs to which matchup. Both assumptions become false once `match_number` restarts per matchup (every matchup's *first* game gets `match_number == 1`). Fix them to key on `id` (still a real, bracket-wide monotonically increasing counter, since row ids are assigned in the same creation order `match_number` used to track) instead:

Around line 1558-1571 (inside the walkover/unavailable test), replace:

```python
    # Now play the still-pending round-1 real game — the moment its winner
    # is placed into round 2, the earlier unavailable flag resolves that
    # round-2 matchup as a walkover instead of creating a game for it.
    # Two incomplete elimination matches exist at this point (round-1
    # position 1's real game, and round-2 position 1's real game, both
    # created directly by generate_bracket since two round-1 byes feed
    # round-2 position 1 immediately). match_number is assigned as a
    # strictly-increasing per-bracket counter in the exact order
    # generate_bracket creates matches (round 1 before round 2), so the
    # lowest match_number deterministically identifies round-1's game
    # regardless of the API's response ordering.
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    pending_games = sorted(
        (
            m for m in matches_response.json()
            if m["round_type"] == "elimination" and m["status"] != "completed"
        ),
        key=lambda m: m["match_number"],
    )
```

with:

```python
    # Now play the still-pending round-1 real game — the moment its winner
    # is placed into round 2, the earlier unavailable flag resolves that
    # round-2 matchup as a walkover instead of creating a game for it.
    # Two incomplete elimination matches exist at this point (round-1
    # position 1's real game, and round-2 position 1's real game, both
    # created directly by generate_bracket since two round-1 byes feed
    # round-2 position 1 immediately). match_number now restarts at 1 for
    # every matchup's own series, so it can no longer disambiguate across
    # matchups -- id is still a real bracket-wide creation-order counter
    # (round 1's games are always inserted before round 2's), so the
    # lowest id deterministically identifies round-1's game regardless of
    # the API's response ordering.
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    pending_games = sorted(
        (
            m for m in matches_response.json()
            if m["round_type"] == "elimination" and m["status"] != "completed"
        ),
        key=lambda m: m["id"],
    )
```

Around line 1622-1632 (inside the mid-series walkover test), replace:

```python
    # match_number is a strictly-increasing per-bracket counter assigned in
    # creation order; generate_bracket creates round-1 position 0's game
    # before position 1's (both created immediately here since bracket_size
    # == capacity == 4, so there are no byes), so match_number 1 always
    # belongs to round_1_matchup regardless of the API's response order.
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    elimination_matches = [
        m for m in matches_response.json() if m["round_type"] == "elimination"
    ]
    assert len(elimination_matches) == 2  # both round-1 games created immediately
    game_1 = next(m for m in elimination_matches if m["match_number"] == 1)
```

with:

```python
    # match_number now restarts at 1 for every matchup's own series (both
    # of these round-1 games are each the first game of their own matchup,
    # so both get match_number == 1) -- id is still a real bracket-wide
    # creation-order counter, and generate_bracket creates round-1 position
    # 0's game before position 1's (both created immediately here since
    # bracket_size == capacity == 4, so there are no byes), so the lowest
    # id always belongs to round_1_matchup (position 0) regardless of the
    # API's response order.
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    elimination_matches = [
        m for m in matches_response.json() if m["round_type"] == "elimination"
    ]
    assert len(elimination_matches) == 2  # both round-1 games created immediately
    game_1 = min(elimination_matches, key=lambda m: m["id"])
```

Now add new tests confirming the actual behavior this task introduces. Add to `server/tests/test_finals.py` (near the other bracket-generation tests — reuse whatever session/team setup helper the file already uses, e.g. `_setup_ranked_teams_for_example_game` and `_rank_teams_directly_head_to_head`, matching the existing style in the file):

```python
def test_matchup_numbers_assigned_round_then_position(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 8, "wins_to_advance": 1},
    ).json()

    round_1 = sorted(
        (m for m in bracket["matchups"] if m["round_number"] == 1),
        key=lambda m: m["position"],
    )
    round_2 = sorted(
        (m for m in bracket["matchups"] if m["round_number"] == 2),
        key=lambda m: m["position"],
    )
    round_3 = [m for m in bracket["matchups"] if m["round_number"] == 3]

    # Round 1's four matchups get the lowest numbers (in position order),
    # then round 2's two, then round 3's one final -- matching
    # generate_bracket's own (round_number, position) creation loop.
    assert [m["matchup_number"] for m in round_1] == [1, 2, 3, 4]
    assert [m["matchup_number"] for m in round_2] == [5, 6]
    assert [m["matchup_number"] for m in round_3] == [7]


def test_single_elimination_series_match_number_restarts_per_matchup(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 4)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": [2, 1]},
    ).json()

    matches_response = client.get(f"/api/matches?session_id={session_id}")
    elimination_matches = {
        m["id"]: m
        for m in matches_response.json()
        if m["round_type"] == "elimination"
    }
    # Both round-1 games (one per matchup) are each the first game of
    # their own matchup.
    round_1_games = sorted(elimination_matches.values(), key=lambda m: m["id"])[:2]
    assert all(g["match_number"] == 1 for g in round_1_games)

    # Play round-1 position 0's series to completion (best-of-3, so a
    # second game is needed to reach wins_needed=2 with alternating
    # winners is impossible here -- have the same side win both games so
    # the series decides after exactly 2 games).
    game_1 = round_1_games[0]
    for _ in range(2):
        matches_response = client.get(f"/api/matches?session_id={session_id}")
        candidate = next(
            m for m in matches_response.json()
            if m["round_type"] == "elimination"
            and m["status"] != "completed"
            and m["id"] == game_1["id"] or (
                m["round_type"] == "elimination" and m["status"] != "completed"
            )
        )
        red_id = next(a["id"] for a in candidate["alliances"] if a["station"] == "red")
        blue_id = next(a["id"] for a in candidate["alliances"] if a["station"] == "blue")
        client.post(
            f"/api/matches/{candidate['id']}/alliances/{red_id}/score",
            json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
        )
        client.post(
            f"/api/matches/{candidate['id']}/alliances/{blue_id}/score",
            json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
        )
        game_1 = candidate
```

The second test's polling loop is deliberately conservative (re-fetching the still-incomplete game for the same matchup each iteration) since exact match ids for a follow-up game in the same series aren't known ahead of time; if this proves awkward against the real `wins_to_advance` semantics once written, simplify to directly asserting on the two known round-1 game ids' `match_number` (both `== 1`) and stop there — the restart-at-1 assertion is the point of this test, not full series completion. Adjust freely to make it deterministic; the two hard requirements are: (a) both round-1 games (different matchups) independently show `match_number == 1`, and (b) a matchup's *second* game (if the series needs one) shows `match_number == 2`, not a bracket-wide-continuing number.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pytest tests/test_finals.py -v`
Expected: `test_matchup_numbers_assigned_round_then_position` FAILS (`KeyError: 'matchup_number'` — field doesn't exist in the API response yet). The two rewritten tests (walkover ones) should already pass with the `id`-based fix even before Step 3's implementation, since `id` ordering doesn't depend on this task's change — confirm they still pass as a sanity check that the rewrite itself is correct, independent of the new feature.

- [ ] **Step 3: Update `server/src/tournament_server/models/bracket_matchup.py`**

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class BracketMatchup(Base):
    __tablename__ = "bracket_matchups"

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    round_number: Mapped[int] = mapped_column(Integer)
    position: Mapped[int] = mapped_column(Integer)
    matchup_number: Mapped[int | None] = mapped_column(Integer, default=None)
    alliance_a_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
    alliance_b_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
    winner_alliance_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
```

- [ ] **Step 4: Write the migration**

Create `server/src/tournament_server/_alembic/versions/c9d34b7a1f02_add_bracket_matchups_matchup_number.py`:

```python
"""add bracket_matchups matchup_number

Revision ID: c9d34b7a1f02
Revises: a2c6f19e4d80
Create Date: 2026-09-28 09:05:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9d34b7a1f02'
down_revision: Union[str, None] = 'a2c6f19e4d80'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: an already-decided finals bracket from before this column
    # existed has no retroactive numbering need, since it's already
    # complete.
    op.add_column(
        'bracket_matchups', sa.Column('matchup_number', sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('bracket_matchups', 'matchup_number')
```

- [ ] **Step 5: Run the alembic drift test**

Run: `cd server && pytest tests/test_alembic_drift.py -v`
Expected: PASS.

- [ ] **Step 6: Update `server/src/tournament_server/services/finals.py`**

In `generate_bracket`, add a running counter to the existing matchup-creation loop:

```python
    matchups: dict[tuple[int, int], BracketMatchup] = {}
    matchup_number = 0
    for round_number in range(1, total_rounds + 1):
        for position in range(capacity // (2**round_number)):
            matchup_number += 1
            matchup = BracketMatchup(
                bracket_id=bracket.id,
                round_number=round_number,
                position=position,
                matchup_number=matchup_number,
            )
            db.add(matchup)
            db.flush()
            matchups[(round_number, position)] = matchup
```

In `_create_matchup_game`, change the game-counting query from bracket-wide to matchup-scoped:

```python
def _create_matchup_game(db: Session, bracket: FinalsBracket, matchup: BracketMatchup) -> Match:
    field_id = next_finals_field_id(db, bracket)
    existing_game_count = len(
        db.execute(
            select(Match).where(Match.bracket_matchup_id == matchup.id)
        ).scalars().all()
    )

    match = Match(
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        round_type="elimination",
        match_number=existing_game_count + 1,
        field_id=field_id,
        finals_bracket_id=bracket.id,
        bracket_matchup_id=matchup.id,
    )
```

(Everything else in `_create_matchup_game` is unchanged — only the `existing_game_count` query's `where` clause changes.)

- [ ] **Step 7: Check whether `matchup_number` needs exposing on the bracket-read response**

Grep `server/src/tournament_server/schemas/finals.py` (or wherever the bracket/matchup read schema lives) for the matchup schema class, and add a `matchup_number: int | None` field to it alongside `round_number`/`position`/etc. — the new tests in Step 1 read `m["matchup_number"]` directly off `bracket["matchups"]`, so the API response must include it. Follow whatever field-ordering convention the existing schema uses.

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd server && pytest tests/test_finals.py tests/test_finals_service.py -v`
Expected: all PASS. If the new `test_single_elimination_series_match_number_restarts_per_matchup` proves awkward to get fully green given the real `wins_to_advance`/scoring flow, simplify it per the note at the end of Step 1 rather than spending excessive time forcing the original version to pass — the goal is pinning "match_number restarts per matchup," not exercising the full series-decision flow (that's already covered by other existing tests).

- [ ] **Step 9: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 10: Commit**

```bash
cd server
git add src/tournament_server/models/bracket_matchup.py \
        src/tournament_server/_alembic/versions/c9d34b7a1f02_add_bracket_matchups_matchup_number.py \
        src/tournament_server/services/finals.py src/tournament_server/schemas/finals.py \
        tests/test_finals.py
git commit -m "Number bracket matchups and scope single_elimination match_number per matchup"
```

---

### Task 6: `match_label()` and `MatchRead.label`

**Files:**
- Create: `server/src/tournament_server/services/match_labeling.py`
- Test: `server/tests/test_match_labeling.py`
- Modify: `server/src/tournament_server/schemas/match.py`
- Modify: `server/src/tournament_server/routers/matches.py` (`_to_match_read`)
- Test: `server/tests/test_matches.py`, `server/tests/test_schedule.py`, `server/tests/test_finals.py`

**Interfaces:**
- Consumes: `BracketMatchup.matchup_number` (Task 5).
- Produces: `match_label(round_type, match_number, *, finals_bracket_id, bracket_matchup_id, bracket_alliance_id, matchup_number=None) -> str` and `MatchRead.label: str` (no later task in this plan consumes these, but this is the field the follow-on admin UI spec will read).

- [ ] **Step 1: Write the failing unit tests**

Create `server/tests/test_match_labeling.py`:

```python
import pytest

from tournament_server.services.match_labeling import match_label


def test_practice_round_gets_p_prefix():
    label = match_label(
        "practice", 7,
        finals_bracket_id=None, bracket_matchup_id=None, bracket_alliance_id=None,
    )
    assert label == "P7"


def test_qualification_round_gets_q_prefix():
    label = match_label(
        "qualification", 42,
        finals_bracket_id=None, bracket_matchup_id=None, bracket_alliance_id=None,
    )
    assert label == "Q42"


def test_unknown_round_type_falls_back_to_own_first_letter_uppercased():
    label = match_label(
        "tiebreaker", 3,
        finals_bracket_id=None, bracket_matchup_id=None, bracket_alliance_id=None,
    )
    assert label == "T3"


def test_single_elimination_series_game_label():
    label = match_label(
        "elimination", 2,
        finals_bracket_id=99, bracket_matchup_id=5, bracket_alliance_id=None,
        matchup_number=3,
    )
    assert label == "F3-2"


def test_single_elimination_without_matchup_number_raises():
    with pytest.raises(ValueError, match="matchup_number"):
        match_label(
            "elimination", 1,
            finals_bracket_id=99, bracket_matchup_id=5, bracket_alliance_id=None,
        )


def test_score_chase_run_label_has_no_suffix():
    label = match_label(
        "elimination", 4,
        finals_bracket_id=99, bracket_matchup_id=None, bracket_alliance_id=17,
    )
    assert label == "F4"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pytest tests/test_match_labeling.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'tournament_server.services.match_labeling'`.

- [ ] **Step 3: Create `server/src/tournament_server/services/match_labeling.py`**

```python
from __future__ import annotations

ROUND_TYPE_LABEL_PREFIX = {"practice": "P", "qualification": "Q"}


def match_label(
    round_type: str,
    match_number: int,
    *,
    finals_bracket_id: int | None,
    bracket_matchup_id: int | None,
    bracket_alliance_id: int | None,
    matchup_number: int | None = None,
) -> str:
    """Computes a match's human-legible label.

    Non-finals matches (finals_bracket_id is None) use round_type's own
    prefix: P1..P24 for practice, Q1..Q132 for qualification, or an
    unknown round type's own first letter uppercased as a fallback.

    Finals matches branch on which finals concept the match belongs to:
    - bracket_matchup_id set: a single_elimination series game, labeled
      "F{matchup_number}-{match_number}" (match_number restarts at 1 per
      matchup -- see services/finals.py's _create_matchup_game).
    - bracket_alliance_id set (no bracket_matchup_id): a score_chase run,
      labeled "F{match_number}" with no per-game suffix -- match_number
      there is already a bracket-wide, worst-seed-first sequential
      counter, so no matchup_number is needed.
    """
    if finals_bracket_id is None:
        prefix = ROUND_TYPE_LABEL_PREFIX.get(round_type, round_type[:1].upper())
        return f"{prefix}{match_number}"
    if bracket_matchup_id is not None:
        if matchup_number is None:
            raise ValueError(
                "matchup_number is required to label a single_elimination "
                "series game"
            )
        return f"F{matchup_number}-{match_number}"
    return f"F{match_number}"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pytest tests/test_match_labeling.py -v`
Expected: all PASS.

- [ ] **Step 5: Add `label` to `MatchRead` and wire it into `_to_match_read`**

In `server/src/tournament_server/schemas/match.py`, add `label: str` to `MatchRead`, right after `match_number: int`:

```python
class MatchRead(BaseModel):
    id: int
    session_id: int
    division_id: int | None
    round_type: str
    match_number: int
    label: str
    field_id: int | None
    time_slot: int | None
    scheduled_time: dt.datetime | None
    status: str
    phase: str
    phase_deadline: dt.datetime | None
    paused: bool
    remaining_seconds_at_pause: float | None
    alliances: list[AllianceRead]
```

In `server/src/tournament_server/routers/matches.py`, add imports:

```python
from tournament_server.models.bracket_matchup import BracketMatchup
from tournament_server.services.match_labeling import match_label
```

Update `_to_match_read`:

```python
def _to_match_read(match: Match, db: Session) -> MatchRead:
    alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match.id)
    ).scalars().all()
    alliance_reads = []
    for alliance in alliances:
        team_ids = [
            row.team_id
            for row in db.execute(
                select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
            )
            .scalars()
            .all()
        ]
        alliance_reads.append(
            AllianceRead(id=alliance.id, station=alliance.station, team_ids=team_ids)
        )
    matchup_number = None
    if match.bracket_matchup_id is not None:
        matchup = db.get(BracketMatchup, match.bracket_matchup_id)
        matchup_number = matchup.matchup_number if matchup is not None else None
    label = match_label(
        match.round_type,
        match.match_number,
        finals_bracket_id=match.finals_bracket_id,
        bracket_matchup_id=match.bracket_matchup_id,
        bracket_alliance_id=match.bracket_alliance_id,
        matchup_number=matchup_number,
    )
    return MatchRead(
        id=match.id,
        session_id=match.session_id,
        division_id=match.division_id,
        round_type=match.round_type,
        match_number=match.match_number,
        label=label,
        field_id=match.field_id,
        time_slot=match.time_slot,
        scheduled_time=match.scheduled_time,
        status=match.status,
        phase=match.phase,
        phase_deadline=match.phase_deadline,
        paused=match.paused,
        remaining_seconds_at_pause=match.remaining_seconds_at_pause,
        alliances=alliance_reads,
    )
```

- [ ] **Step 6: Write integration tests confirming `label` in real API responses**

Add to `server/tests/test_schedule.py`:

```python
def test_generated_qualification_matches_have_q_prefixed_labels(client):
    session_id, team_ids = _setup_ready_session(client)
    client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    labels = sorted(m["label"] for m in matches)
    assert labels == [f"Q{n}" for n in range(1, len(matches) + 1)]


def test_generated_practice_matches_have_p_prefixed_labels(client):
    session_id, team_ids = _setup_ready_session(client)
    client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "practice",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    labels = sorted(m["label"] for m in matches)
    assert labels == [f"P{n}" for n in range(1, len(matches) + 1)]
```

Add to `server/tests/test_finals.py` (reusing whatever session/ranking setup helper the file already uses):

```python
def test_single_elimination_game_label_uses_matchup_and_match_number(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 4)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": 1},
    )

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    elimination_matches = [m for m in matches if m["round_type"] == "elimination"]
    assert len(elimination_matches) == 2
    for match in elimination_matches:
        assert match["label"] in ("F1-1", "F2-1")


def test_score_chase_run_labels_are_sequential_with_no_suffix(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 4)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4},
    )
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    elimination_matches = [m for m in matches if m["round_type"] == "elimination"]
    assert len(elimination_matches) == 1
    assert elimination_matches[0]["label"] == "F1"
```

If `_setup_ranked_teams_for_example_game`/`_rank_teams_directly_head_to_head` aren't the exact helper names in `test_finals.py`, or if the `score_chase` finals format requires a different game plugin/fixture than `example-game` (check `match_format()["finals_format"]` on whatever plugin fixture `cooperative_client` seeds), adjust the setup calls to match whatever helpers/fixtures the file already uses for a `score_chase`-format bracket — grep the file for `finals_format` and `score_chase` to find the right pattern before writing this test's setup.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server && pytest tests/test_match_labeling.py tests/test_schedule.py tests/test_finals.py tests/test_matches.py -v`
Expected: all PASS.

- [ ] **Step 8: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS (every existing `MatchRead`-shaped assertion elsewhere in the suite must tolerate the new `label` field — since none of them assert on an exact/exhaustive JSON shape via strict equality against a fixed dict missing `label`, this should be a no-op for them; if any test does assert exact response-body equality against a hardcoded dict, add `"label": ...` to that expected dict).

- [ ] **Step 9: Commit**

```bash
cd server
git add src/tournament_server/services/match_labeling.py tests/test_match_labeling.py \
        src/tournament_server/schemas/match.py src/tournament_server/routers/matches.py \
        tests/test_schedule.py tests/test_finals.py tests/test_matches.py
git commit -m "Add computed human-legible match labels (P/Q/F-prefixed)"
```

---

### Task 7: Phase 4 schemas — `SchedulePhase`, `PhaseResult`, `phases`, `dry_run`

**Files:**
- Modify: `server/src/tournament_server/schemas/schedule.py`
- Test: `server/tests/test_schedule.py`

**Interfaces:**
- Consumes: nothing new.
- Produces (for Task 8): `SchedulePhase(round_type: str, target_matches_per_team: int)`; `PhaseResult(round_type: str, schedule_generation_id: int | None, match_count: int)`; `ScheduleGenerateRequest.round_type`/`.target_matches_per_team` become `str | None`/`int | None`; `ScheduleGenerateRequest.phases: list[SchedulePhase] | None`; `ScheduleGenerateRequest.dry_run: bool = False`; a `model_validator` enforcing exactly one of (`round_type` + `target_matches_per_team`) or `phases`, and `phases` non-empty when given; `ScheduleGenerateResponse.schedule_generation_id` becomes `int | None`; `ScheduleGenerateResponse.phase_results: list[PhaseResult] | None = None`.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/test_schedule.py`:

```python
def test_generate_schedule_rejects_both_round_type_and_phases(client):
    session_id, team_ids = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "phases": [{"round_type": "practice", "target_matches_per_team": 1}],
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422


def test_generate_schedule_rejects_neither_round_type_nor_phases(client):
    session_id, team_ids = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422


def test_generate_schedule_rejects_empty_phases_list(client):
    session_id, team_ids = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "phases": [],
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pytest tests/test_schedule.py -k "rejects_both_round_type_and_phases or rejects_neither_round_type_nor_phases or rejects_empty_phases_list" -v`
Expected: FAIL — the first two currently return other status codes (a request with both `round_type` and `phases` present, or neither, is currently accepted/rejected only based on `round_type`'s own presence, since `phases` doesn't exist as a field yet — actually since `phases` isn't a declared field yet, pydantic will just ignore the extra key by default and process the request using `round_type` alone; the "neither" case will 422 today too, but only because `round_type`/`target_matches_per_team` are still non-optional required fields — that accidental pass is fine, this is really pinning intended behavior, not proving a regression). The empty-phases test fails since `phases` doesn't exist yet.

- [ ] **Step 3: Update `server/src/tournament_server/schemas/schedule.py`**

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, Field, model_validator


class TimeBlock(BaseModel):
    date: dt.date
    start_time: str = Field(pattern=r"^\d{2}:\d{2}$")
    end_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    cycle_time: int | None = Field(default=None, gt=0)


class SchedulePhase(BaseModel):
    round_type: str
    target_matches_per_team: int


class ScheduleGenerateRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    round_type: str | None = None
    target_matches_per_team: int | None = None
    phases: list[SchedulePhase] | None = None
    scheduler_plugin_name: str
    excluded_team_ids: list[int] = []
    time_blocks: list[TimeBlock] | None = None
    warn_below_multiplier: float = 1.5
    dry_run: bool = False

    @model_validator(mode="after")
    def _check_round_type_xor_phases(self) -> "ScheduleGenerateRequest":
        singular_given = (
            self.round_type is not None or self.target_matches_per_team is not None
        )
        if self.phases is not None:
            if singular_given:
                raise ValueError(
                    "Provide either round_type/target_matches_per_team or "
                    "phases, not both"
                )
            if len(self.phases) < 1:
                raise ValueError("phases must contain at least one entry")
        else:
            if self.round_type is None or self.target_matches_per_team is None:
                raise ValueError(
                    "Provide either round_type and target_matches_per_team, "
                    "or phases"
                )
        return self


class ResolvedTimeBlockRead(BaseModel):
    start_time: str
    end_time: str | None
    cycle_time_seconds: float


class PhaseResult(BaseModel):
    round_type: str
    schedule_generation_id: int | None
    match_count: int


class ScheduleGenerateResponse(BaseModel):
    schedule_generation_id: int | None
    match_count: int
    resolved_time_blocks: list[ResolvedTimeBlockRead]
    cycle_time_warning: str | None
    phase_results: list[PhaseResult] | None = None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pytest tests/test_schedule.py -k "rejects_both_round_type_and_phases or rejects_neither_round_type_nor_phases or rejects_empty_phases_list" -v`
Expected: all PASS. (A pydantic `model_validator` raising `ValueError` becomes a FastAPI 422 automatically — no router change needed for this to work at the schema-validation level.)

Note: the rest of `tests/test_schedule.py` will now fail to even construct valid requests only if some existing test omitted both `round_type` and `phases` while relying on Pydantic's old required-field enforcement to 422 for an unrelated reason — this is extremely unlikely given the fixtures read earlier in this plan's investigation, but run the full file now to confirm:

Run: `cd server && pytest tests/test_schedule.py -v`
Expected: all PASS (every existing test supplies `round_type` + `target_matches_per_team` together, which the new validator accepts identically to before).

- [ ] **Step 5: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd server
git add src/tournament_server/schemas/schedule.py tests/test_schedule.py
git commit -m "Add phases/dry_run request schema and PhaseResult response schema"
```

---

### Task 8: Combined multi-phase schedule generation with `dry_run`

**Files:**
- Modify: `server/src/tournament_server/routers/schedule.py` (`generate_schedule` — full-function rewrite)
- Test: `server/tests/test_schedule.py`

**Interfaces:**
- Consumes: everything from Tasks 2-4 and 7 (`ResolvedBlock`, `assign_scheduled_times`, `serialize_time_blocks`, `deserialize_time_blocks`, `_check_no_overlap_with_prior_generations`, `SchedulePhase`, `PhaseResult`, `ScheduleGenerateRequest.phases`/`.dry_run`).
- Produces: the finished `POST /api/schedule` contract this whole plan builds toward. No later task in this plan depends on anything new from this task.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/test_schedule.py`:

```python
def test_generate_schedule_with_phases_orders_matches_by_phase(client):
    session_id, team_ids = _setup_ready_session(client, num_teams=8)

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "phases": [
                {"round_type": "practice", "target_matches_per_team": 1},
                {"round_type": "qualification", "target_matches_per_team": 2},
            ],
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["phase_results"] is not None
    assert [pr["round_type"] for pr in body["phase_results"]] == ["practice", "qualification"]
    practice_count = next(
        pr["match_count"] for pr in body["phase_results"] if pr["round_type"] == "practice"
    )
    qualification_count = next(
        pr["match_count"] for pr in body["phase_results"] if pr["round_type"] == "qualification"
    )
    assert body["match_count"] == practice_count + qualification_count
    assert body["schedule_generation_id"] == body["phase_results"][0]["schedule_generation_id"]

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    practice_times = [m["scheduled_time"] for m in matches if m["round_type"] == "practice"]
    qualification_times = [
        m["scheduled_time"] for m in matches if m["round_type"] == "qualification"
    ]
    assert max(practice_times) < min(qualification_times)


def test_generate_schedule_phases_all_or_nothing_conflict(client):
    session_id, team_ids = _setup_ready_session(client, num_teams=8)

    # Pre-create a qualification match directly, occupying that
    # round_type -- a subsequent combined-phase request that includes
    # qualification must fail entirely, including for the practice phase.
    client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[0], team_ids[1]]},
                {"station": "blue", "team_ids": [team_ids[2], team_ids[3]]},
            ],
        },
    )

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "phases": [
                {"round_type": "practice", "target_matches_per_team": 1},
                {"round_type": "qualification", "target_matches_per_team": 2},
            ],
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 409

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert all(m["round_type"] != "practice" for m in matches)


def test_generate_schedule_dry_run_creates_nothing(client):
    session_id, team_ids = _setup_ready_session(client, num_teams=8)

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "phases": [
                {"round_type": "practice", "target_matches_per_team": 1},
                {"round_type": "qualification", "target_matches_per_team": 2},
            ],
            "scheduler_plugin_name": "simple_random",
            "dry_run": True,
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["schedule_generation_id"] is None
    assert body["match_count"] > 0
    assert all(pr["schedule_generation_id"] is None for pr in body["phase_results"])

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert matches == []

    # Since nothing was persisted, a real (non-dry-run) request for the
    # same phases must still succeed afterward.
    real_response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "phases": [
                {"round_type": "practice", "target_matches_per_team": 1},
                {"round_type": "qualification", "target_matches_per_team": 2},
            ],
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert real_response.status_code == 201


def test_generate_schedule_dry_run_is_idempotent(client):
    session_id, team_ids = _setup_ready_session(client, num_teams=8)
    payload = {
        "session_id": session_id,
        "round_type": "qualification",
        "target_matches_per_team": 3,
        "scheduler_plugin_name": "simple_random",
        "dry_run": True,
    }

    first = client.post("/api/schedule", json=payload).json()
    second = client.post("/api/schedule", json=payload).json()

    assert first["match_count"] == second["match_count"]
    assert first["schedule_generation_id"] is None
    assert second["schedule_generation_id"] is None
    assert first["phase_results"] is None
    assert second["phase_results"] is None

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert matches == []


def test_generate_schedule_singular_shape_unaffected_by_phases_support(client):
    # Backward-compatibility regression check for the singular-shape path
    # now that generate_schedule's internals are phases-aware.
    session_id, team_ids = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["phase_results"] is None
    assert body["schedule_generation_id"] is not None
    assert body["match_count"] > 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pytest tests/test_schedule.py -k "with_phases_orders or all_or_nothing_conflict or dry_run" -v`
Expected: FAIL — `phases`/`dry_run` aren't honored by `generate_schedule` yet (a `phases`-shaped request currently ignores `phases` entirely since the router still reads `payload.round_type`/`payload.target_matches_per_team` directly, which are `None` for these requests, so scheduler calls receive `target_matches_per_team=None` and likely raise inside the scheduler plugin, surfacing as a 422 rather than 201).

- [ ] **Step 3: Rewrite `generate_schedule` in `server/src/tournament_server/routers/schedule.py`**

Add `SchedulePhase`, `PhaseResult` to the existing `from tournament_server.schemas.schedule import (...)` block:

```python
from tournament_server.schemas.schedule import (
    PhaseResult,
    ResolvedTimeBlockRead,
    ScheduleGenerateRequest,
    ScheduleGenerateResponse,
    SchedulePhase,
)
```

Replace the entire `generate_schedule` function body with:

```python
@router.post("", response_model=ScheduleGenerateResponse, status_code=201)
def generate_schedule(
    payload: ScheduleGenerateRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> ScheduleGenerateResponse:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if event.game_plugin_name is None:
        raise HTTPException(
            status_code=422, detail="No game plugin has been selected for this event"
        )
    game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
    if game_plugin is None:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Event's selected game plugin {event.game_plugin_name!r} is not "
                "currently loaded"
            ),
        )

    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")

    scheduler_plugin = request.app.state.scheduler_plugins.get(
        payload.scheduler_plugin_name
    )
    if scheduler_plugin is None:
        raise HTTPException(
            status_code=404,
            detail=f"Scheduler plugin {payload.scheduler_plugin_name!r} is not installed",
        )

    phases: list[SchedulePhase] = (
        payload.phases
        if payload.phases is not None
        else [
            SchedulePhase(
                round_type=payload.round_type,
                target_matches_per_team=payload.target_matches_per_team,
            )
        ]
    )

    # All-or-nothing: every phase's (session, division, round_type) must be
    # conflict-free before anything is generated for any phase.
    for phase in phases:
        existing_query = select(Match).where(
            Match.session_id == payload.session_id, Match.round_type == phase.round_type
        )
        if payload.division_id is None:
            existing_query = existing_query.where(Match.division_id.is_(None))
        else:
            existing_query = existing_query.where(Match.division_id == payload.division_id)
        if db.execute(existing_query).scalars().first() is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Matches already exist for round_type {phase.round_type!r} in "
                    "this session/division; clear them with DELETE /api/schedule "
                    "before regenerating"
                ),
            )

    participation_query = select(SessionParticipation).where(
        SessionParticipation.session_id == payload.session_id,
        SessionParticipation.checked_in.is_(True),
    )
    team_ids_in_session = [
        row.team_id for row in db.execute(participation_query).scalars().all()
    ]
    team_query = select(Team).where(Team.id.in_(team_ids_in_session))
    if payload.division_id is None:
        sole_division_id = get_sole_division_id(db, event.id)
        if sole_division_id is not None:
            team_query = team_query.where(Team.division_id == sole_division_id)
        else:
            team_query = team_query.where(Team.division_id.is_(None))
    else:
        team_query = team_query.where(Team.division_id == payload.division_id)
    teams = db.execute(team_query).scalars().all()

    field_set_query = select(FieldSet).where(FieldSet.session_id == payload.session_id)
    if payload.division_id is None:
        field_set_query = field_set_query.where(FieldSet.division_id.is_(None))
    else:
        field_set_query = field_set_query.where(
            FieldSet.division_id == payload.division_id
        )
    field_sets = db.execute(field_set_query).scalars().all()
    if not field_sets:
        if payload.division_id is None:
            raise HTTPException(
                status_code=422,
                detail="Session has no unassigned FieldSets configured",
            )
        raise HTTPException(
            status_code=422,
            detail=f"No FieldSets are assigned to division_id {payload.division_id}",
        )
    fields = db.execute(
        select(Field).where(Field.field_set_id.in_([fs.id for fs in field_sets]))
    ).scalars().all()
    if not fields:
        raise HTTPException(status_code=422, detail="Session has no Fields configured")

    match_format = game_plugin.module.match_format()
    for phase in phases:
        if phase.round_type not in match_format["round_types"]:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{phase.round_type!r} is not a valid round_type for this "
                    "event's game plugin"
                ),
            )
    teams_per_alliance = match_format["teams_per_alliance"]
    alliance_count = match_format["alliance_count"]

    pairing_history = build_pairing_history(db, event.id)

    match_duration_seconds = (
        match_format["autonomous_seconds"] + match_format["driver_seconds"]
    )

    phase_generated: list[tuple[SchedulePhase, list]] = []
    for phase in phases:
        try:
            generated = scheduler_plugin.module.generate_schedule(
                teams=[{"team_id": t.id, "organization": t.organization} for t in teams],
                target_matches_per_team=phase.target_matches_per_team,
                teams_per_alliance=teams_per_alliance,
                alliance_count=alliance_count,
                fields=[{"field_id": f.id, "field_set_id": f.field_set_id} for f in fields],
                field_sets=[{"field_set_id": fs.id, "name": fs.name} for fs in field_sets],
                cross_session_pairing_history=pairing_history,
                constraints={"excluded_team_ids": payload.excluded_team_ids},
            )
        except Exception as exc:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Scheduler plugin could not generate a schedule for "
                    f"round_type {phase.round_type!r}: {exc}"
                ),
            )
        _validate_generated_schedule(generated, {fs.id for fs in field_sets}, alliance_count)
        phase_generated.append((phase, generated))

    total_time_slots_needed = sum(
        len({entry["time_slot"] for entry in generated}) for _, generated in phase_generated
    )

    session_obj = db.get(TournamentSession, payload.session_id)
    if payload.time_blocks is not None:
        if session_obj.timezone is None:
            raise HTTPException(
                status_code=422,
                detail="Session must have timezone set to use time_blocks",
            )
        time_blocks_input = [b.model_dump() for b in payload.time_blocks]
        timezone_name = session_obj.timezone
    else:
        implicit_start = utc_now() + dt.timedelta(minutes=5)
        time_blocks_input = [implicit_default_time_block(
            match_duration_seconds, payload.warn_below_multiplier
        )]
        time_blocks_input[0]["start_time"] = implicit_start.strftime("%H:%M")
        time_blocks_input[0]["date"] = implicit_start.date()
        timezone_name = "UTC"

    try:
        if payload.time_blocks is not None:
            validate_blocks_ordered_and_non_overlapping(time_blocks_input)
            _check_no_overlap_with_prior_generations(
                db, payload.session_id, payload.division_id, time_blocks_input
            )
        resolved_blocks = resolve_block_cycle_times(
            time_blocks_input, total_time_slots_needed
        )
        global_assignments = assign_scheduled_times(
            resolved_blocks, list(range(total_time_slots_needed)), timezone_name
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    warn_threshold_seconds = match_duration_seconds * payload.warn_below_multiplier
    tight_blocks = [
        b for b in resolved_blocks if b.cycle_time_seconds < warn_threshold_seconds
    ]
    cycle_time_warning = None
    if tight_blocks:
        block_names = ", ".join(f"{b.date} {b.start_time}" for b in tight_blocks)
        cycle_time_warning = (
            f"Cycle time is below {payload.warn_below_multiplier}x match "
            f"duration ({match_duration_seconds}s) in block(s) starting at "
            f"{block_names}"
        )

    resolved_time_blocks_read = [
        ResolvedTimeBlockRead(
            start_time=b.start_time, end_time=b.end_time, cycle_time_seconds=b.cycle_time_seconds
        )
        for b in resolved_blocks
    ]

    if payload.dry_run:
        phase_results_dry = (
            [
                PhaseResult(
                    round_type=phase.round_type,
                    schedule_generation_id=None,
                    match_count=len(generated),
                )
                for phase, generated in phase_generated
            ]
            if payload.phases is not None
            else None
        )
        return ScheduleGenerateResponse(
            schedule_generation_id=None,
            match_count=sum(len(generated) for _, generated in phase_generated),
            resolved_time_blocks=resolved_time_blocks_read,
            cycle_time_warning=cycle_time_warning,
            phase_results=phase_results_dry,
        )

    stored_time_blocks_json = serialize_time_blocks(time_blocks_input)
    phase_results: list[PhaseResult] = []
    created_matches = []
    global_offset = 0
    for phase, generated in phase_generated:
        sorted_local_slots = sorted({entry["time_slot"] for entry in generated})
        global_index_by_local_slot = {
            local_slot: global_offset + rank
            for rank, local_slot in enumerate(sorted_local_slots)
        }
        global_offset += len(sorted_local_slots)

        generation = ScheduleGeneration(
            session_id=payload.session_id,
            division_id=payload.division_id,
            round_type=phase.round_type,
            scheduler_plugin_name=scheduler_plugin.name,
            scheduler_plugin_version=scheduler_plugin.version,
            target_matches_per_team=phase.target_matches_per_team,
            generated_at=utc_now(),
            time_blocks_json=stored_time_blocks_json,
        )
        db.add(generation)
        db.flush()

        fields_by_set: dict[int, list[int]] = {}
        for f in fields:
            fields_by_set.setdefault(f.field_set_id, []).append(f.id)
        for field_ids in fields_by_set.values():
            field_ids.sort()
        next_field_index: dict[int, int] = {fs_id: 0 for fs_id in fields_by_set}

        phase_matches = []
        for match_number, entry in enumerate(generated, start=1):
            field_set_id = entry["field_set_id"]
            field_ids_for_set = fields_by_set[field_set_id]
            field_id = field_ids_for_set[
                next_field_index[field_set_id] % len(field_ids_for_set)
            ]
            next_field_index[field_set_id] += 1

            global_index = global_index_by_local_slot[entry["time_slot"]]
            match = Match(
                session_id=payload.session_id,
                division_id=payload.division_id,
                round_type=phase.round_type,
                match_number=match_number,
                field_id=field_id,
                time_slot=entry["time_slot"],
                schedule_generation_id=generation.id,
                scheduled_time=global_assignments[global_index],
            )
            db.add(match)
            db.flush()
            for alliance_entry in entry["alliances"]:
                alliance = Alliance(match_id=match.id, station=alliance_entry["station"])
                db.add(alliance)
                db.flush()
                for team_id in alliance_entry["team_ids"]:
                    db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))
            phase_matches.append(match)

        created_matches.extend(phase_matches)
        phase_results.append(
            PhaseResult(
                round_type=phase.round_type,
                schedule_generation_id=generation.id,
                match_count=len(phase_matches),
            )
        )

    db.commit()

    for created_match in created_matches:
        broadcast_for_session(
            request.app, db, created_match.session_id, "new_match_created",
            {
                "match_id": created_match.id,
                "session_id": created_match.session_id,
                "division_id": created_match.division_id,
                "field_id": created_match.field_id,
            },
        )

    return ScheduleGenerateResponse(
        schedule_generation_id=phase_results[0].schedule_generation_id,
        match_count=sum(pr.match_count for pr in phase_results),
        resolved_time_blocks=resolved_time_blocks_read,
        cycle_time_warning=cycle_time_warning,
        phase_results=phase_results if payload.phases is not None else None,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pytest tests/test_schedule.py -v`
Expected: all PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 6: Manual sanity check against a real running server (optional but recommended given the size of this rewrite)**

```bash
cd server && python -m tournament_server.main &
sleep 2
curl -s -X POST localhost:8000/api/event -H 'Content-Type: application/json' \
  -d '{"name": "Smoke Test", "password": "smoketest123"}'
# ... exercise POST /api/schedule with a phases payload and dry_run:true via curl,
# confirm the response shape looks sane, then kill the background server.
kill %1
```

This step is optional — do not block completion of the task on it if the automated test suite is fully green; it exists only as an extra confidence check given how much of `generate_schedule` this task rewrites.

- [ ] **Step 7: Commit**

```bash
cd server
git add src/tournament_server/routers/schedule.py tests/test_schedule.py
git commit -m "Support combined multi-phase schedule generation with dry_run preview"
```

---

## Self-Review

**Spec coverage:**
- Phase 1 (practice excluded from rankings) → Task 1. ✅
- Phase 2 (`TimeBlock.date`, `session_date` display-only, date-aware `schedule_timing.py`, `time_blocks_json`, per-`(session,division)` overlap enforcement, `DELETE` clearing stored blocks) → Tasks 2, 3, 4. ✅
- Phase 3 (`matchup_number`, per-matchup `match_number`, `MatchRead.label`) → Tasks 5, 6. ✅
- Phase 4 (`phases`, mutual exclusivity, all-or-nothing conflict check, per-phase persistence, `phase_results`, `dry_run`) → Tasks 7, 8. ✅
- Testing strategy section's specific call-outs (cross-date non-overlap, per-`(session,division)` overlap across generations, `matchup_number` round-then-position ordering, per-matchup game restart, `phases` mutual exclusivity, all-or-nothing conflict, `dry_run` zero-persistence + idempotence, singular-shape regression) — each has a named test above. ✅
- The `GET /api/event/game-plugin/format` endpoint discussed earlier in the brainstorm (before it pivoted into this backend-scheduling spec) does **not** appear in the approved spec's four phases, and is therefore deliberately excluded from this plan — it belongs to the separate, later admin-UI sub-project that will consume this plan's finished API shape, not to this backend spec. Not a gap; a scope boundary.

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate handling" phrasing found; the two spots with lighter guidance (Task 5 Step 7's "check whether... grep to add the field," and Task 5/8's "adjust freely if awkward" notes) are both scoped, mechanical, and paired with a concrete fallback — not open-ended.

**Type consistency check:**
- `ResolvedBlock.date` (Task 2) is threaded consistently through Task 2's own functions, Task 3's `routers/schedule.py` wiring (drops the old `session_date` param), and Task 8's rewrite (never reintroduces `session_date`).
- `serialize_time_blocks`/`deserialize_time_blocks` (Task 2) are used identically in Task 3 (write) and Task 4 (read) and Task 8 (write, again).
- `BracketMatchup.matchup_number` (Task 5) is consumed by `match_label`'s `matchup_number` parameter (Task 6) with matching optionality (`int | None` in both).
- `SchedulePhase`/`PhaseResult` (Task 7) are imported and used with identical field names in Task 8's rewrite.
- `ScheduleGenerateResponse.schedule_generation_id`/`PhaseResult.schedule_generation_id` are `int | None` everywhere from Task 7 onward — Task 8's dry_run branch sets `None`, the persist branch always sets a real `int`.

No gaps found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-28-multi-round-scheduling.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
