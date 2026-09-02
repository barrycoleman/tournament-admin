# Time-Based Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an organizer describe the real time windows their fields are available (each independently pinned, computed, or open-ended) and have `POST /api/schedule` compute whatever cycle times are missing and stamp every generated match with a real UTC `scheduled_time`.

**Architecture:** A new `TournamentSession.timezone` column joins the existing `session_date` to give a session a real calendar/clock anchor. A new pure module resolves a list of `TimeBlock` inputs against however many distinct `time_slot`s the scheduler plugin's output actually needs, then maps each `time_slot` to a UTC timestamp — entirely as core-server bookkeeping *after* the plugin runs, with zero changes to the plugin contract itself. `POST /api/schedule` wires this in as a new step between plugin-output validation and match creation.

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy 2.0, SQLite, Pydantic v2, pytest, `zoneinfo` (stdlib).

**Spec:** `docs/superpowers/specs/2026-09-01-time-based-scheduling-design.md` — read the whole thing, but especially §3 (the `TimeBlock` shape and resolution algorithm, the core of this plan) and §4 (endpoint changes). Also skim `docs/superpowers/specs/2026-08-29-qualification-and-practice-scheduling-design.md` (Phase 4, the scheduling system this plan extends without changing the plugin contract).

## Global Constraints

- No brand names anywhere (code, comments, docs, file names, user-facing text) — master spec §0.
- Python 3.11+, FastAPI, SQLAlchemy 2.0 synchronous `Mapped`/`mapped_column` style, one SQLite file per event — matches existing codebase.
- No Alembic/migrations — this plan adds a new nullable column; a pre-this-plan database is recreated (delete the `.db` file), not migrated, consistent with every prior phase.
- The scheduler plugin contract (`generate_schedule(...)`) does not change at all — it stays completely unaware that real time exists. All new logic is core-server post-processing of the plugin's existing `time_slot`/`field_set_id`/`alliances` output.
- Store every timestamp in UTC (`UTCDateTime`/`utc_now()`, already established in `db.py`); convert to local-for-display is a client concern, never done server-side.
- A `TimeBlock` with `cycle_time: null` requires `end_time` set ("calculate it for me"); a `TimeBlock` with `end_time: null` requires `cycle_time` set (open-ended); an open-ended block must be the last block chronologically and cannot coexist with a "calculate for me" block (spec §3) — this is the one validation rule most likely to be gotten subtly wrong, so it gets its own dedicated tests in Task 2.

---

### Task 1: `TournamentSession.timezone`

**Files:**
- Modify: `src/tournament_server/models/session.py`
- Modify: `src/tournament_server/schemas/session.py`
- Modify: `src/tournament_server/routers/sessions.py`
- Test: `tests/test_sessions.py`

**Interfaces:**
- Produces: `TournamentSession.timezone: str | None` — consumed by Task 3 (read at schedule-generation time to resolve `time_blocks`).
- Consumes: nothing new.

- [ ] **Step 1: Add the column**

In `src/tournament_server/models/session.py`, replace:

```python
class TournamentSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    label: Mapped[str] = mapped_column(String(200))
    session_date: Mapped[dt.date | None] = mapped_column(Date, default=None)
```

with:

```python
class TournamentSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    label: Mapped[str] = mapped_column(String(200))
    session_date: Mapped[dt.date | None] = mapped_column(Date, default=None)
    timezone: Mapped[str | None] = mapped_column(String(100), default=None)
```

- [ ] **Step 2: Add it to the schemas**

In `src/tournament_server/schemas/session.py`, replace:

```python
class SessionCreate(BaseModel):
    label: str
    session_date: dt.date | None = None


class SessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    label: str
    session_date: dt.date | None
```

with:

```python
class SessionCreate(BaseModel):
    label: str
    session_date: dt.date | None = None
    timezone: str | None = None


class SessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    label: str
    session_date: dt.date | None
    timezone: str | None
```

- [ ] **Step 3: Validate and persist it in the endpoint**

In `src/tournament_server/routers/sessions.py`, add the import `from zoneinfo import ZoneInfo, ZoneInfoNotFoundError` at the top, then replace:

```python
@router.post("", response_model=SessionRead, status_code=201)
def create_session(
    payload: SessionCreate, db: Session = Depends(get_db)
) -> TournamentSession:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    session_obj = TournamentSession(
        event_id=event.id, label=payload.label, session_date=payload.session_date
    )
    db.add(session_obj)
    db.commit()
    db.refresh(session_obj)
    return session_obj
```

with:

```python
@router.post("", response_model=SessionRead, status_code=201)
def create_session(
    payload: SessionCreate, db: Session = Depends(get_db)
) -> TournamentSession:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if payload.timezone is not None:
        try:
            ZoneInfo(payload.timezone)
        except ZoneInfoNotFoundError:
            raise HTTPException(
                status_code=422, detail=f"Unknown timezone: {payload.timezone!r}"
            )
    session_obj = TournamentSession(
        event_id=event.id,
        label=payload.label,
        session_date=payload.session_date,
        timezone=payload.timezone,
    )
    db.add(session_obj)
    db.commit()
    db.refresh(session_obj)
    return session_obj
```

- [ ] **Step 4: Write the tests**

Append to the existing `tests/test_sessions.py` (it already has 4 tests using the same bare `client`-fixture style shown below):

```python
def test_create_session_with_valid_timezone(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["timezone"] == "America/Los_Angeles"
    assert body["session_date"] == "2026-09-05"


def test_create_session_rejects_invalid_timezone(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/sessions",
        json={"label": "Session 1", "timezone": "Not/A/Real/Zone"},
    )
    assert response.status_code == 422


def test_create_session_without_timezone_defaults_to_none(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/sessions", json={"label": "Session 1"})
    assert response.status_code == 201
    assert response.json()["timezone"] is None
```

- [ ] **Step 5: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_sessions.py -v`
Expected: all 7 pass (4 existing + 3 new).

Run: `.venv/bin/pytest tests/ -v`
Expected: 192 passed (189 baseline + 3 new), 0 failures.

- [ ] **Step 6: Commit**

```bash
git add src/tournament_server/models/session.py \
        src/tournament_server/schemas/session.py \
        src/tournament_server/routers/sessions.py \
        tests/test_sessions.py
git commit -m "Add TournamentSession.timezone"
```

---

### Task 2: `TimeBlock` resolution algorithm (pure functions)

**Files:**
- Create: `src/tournament_server/services/schedule_timing.py`
- Test: `tests/test_schedule_timing.py`

**Interfaces:**
- Produces: `services/schedule_timing.py`'s `ResolvedBlock` (dataclass: `start_time: str, end_time: str | None, cycle_time_seconds: float, time_slot_count: int`), `resolve_block_cycle_times(time_blocks: list[dict], total_time_slots_needed: int) -> list[ResolvedBlock]` (raises `ValueError` with a descriptive message on any invalid/mismatched input), `assign_scheduled_times(resolved_blocks: list[ResolvedBlock], sorted_distinct_time_slots: list[int], session_date: date, timezone_name: str) -> dict[int, datetime]`, `implicit_default_time_block(match_duration_seconds: int, warn_below_multiplier: float) -> dict` — all consumed by Task 3.
- Consumes: nothing from other tasks in this plan (pure, standalone module — testable entirely without HTTP, a DB, or any other part of this codebase).

**Note on scope:** this task is deliberately not wired into any endpoint yet — every test in this task calls these functions directly with plain Python values. Task 3 does the integration.

- [ ] **Step 1: Write the time-of-day and duration helpers, and `ResolvedBlock`**

Create `src/tournament_server/services/schedule_timing.py`:

```python
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
```

- [ ] **Step 2: Write the proportional-apportionment helper**

Add to the same file:

```python
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
```

- [ ] **Step 3: Write `resolve_block_cycle_times`**

Add to the same file:

```python
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
```

(`id(block)` is used as a dict key purely to correlate `_apportion_time_slots`'s positional output back to the original block dicts — safe here because `calculate_for_me_blocks` and the dicts within `time_blocks` are the same objects throughout this one function call, never copied.)

- [ ] **Step 4: Write `assign_scheduled_times` and `implicit_default_time_block`**

Add to the same file:

```python
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
```

(`implicit_default_time_block`'s `start_time` is a placeholder that Task 3 overrides with the real "5 minutes from now" instant before calling `resolve_block_cycle_times` — this function only supplies the `cycle_time` derivation, which is the part that doesn't depend on wall-clock "now." See Task 3 Step 2 for how the real start time gets substituted in.)

- [ ] **Step 5: Write the tests**

Create `tests/test_schedule_timing.py`:

```python
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
```

- [ ] **Step 6: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_schedule_timing.py -v`
Expected: all 11 pass.

Run: `.venv/bin/pytest tests/ -v`
Expected: 203 passed (192 from Task 1 + 11 new), 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/tournament_server/services/schedule_timing.py tests/test_schedule_timing.py
git commit -m "Add pure TimeBlock cycle-time resolution algorithm"
```

---

### Task 3: Wire `time_blocks` into `POST /api/schedule`

**Files:**
- Modify: `src/tournament_server/schemas/schedule.py`
- Modify: `src/tournament_server/routers/schedule.py`
- Test: `tests/test_schedule.py`

**Interfaces:**
- Consumes: `resolve_block_cycle_times`, `assign_scheduled_times`, `implicit_default_time_block` (Task 2); `TournamentSession.timezone` (Task 1).
- Produces: nothing consumed by a later task in this plan.

- [ ] **Step 1: Add the new request/response schema fields**

Replace the entire contents of `src/tournament_server/schemas/schedule.py` with:

```python
from __future__ import annotations

from pydantic import BaseModel


class TimeBlock(BaseModel):
    start_time: str
    end_time: str | None = None
    cycle_time: int | None = None


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

- [ ] **Step 2: Resolve time blocks after plugin-output validation, before match creation**

In `src/tournament_server/routers/schedule.py`, add these imports at the top:

```python
import datetime as dt

from tournament_server.models.session import TournamentSession
from tournament_server.schemas.schedule import ResolvedTimeBlockRead
from tournament_server.services.schedule_timing import (
    assign_scheduled_times,
    implicit_default_time_block,
    resolve_block_cycle_times,
)
```

(`TournamentSession` may already be imported in this file — check first and don't duplicate the import if so.)

Replace:

```python
    _validate_generated_schedule(generated, {fs.id for fs in field_sets}, alliance_count)

    generation = ScheduleGeneration(
```

with:

```python
    _validate_generated_schedule(generated, {fs.id for fs in field_sets}, alliance_count)

    match_duration_seconds = (
        match_format["autonomous_seconds"] + match_format["driver_seconds"]
    )
    total_time_slots_needed = len({entry["time_slot"] for entry in generated})

    session_obj = db.get(TournamentSession, payload.session_id)
    if payload.time_blocks is not None:
        if session_obj.session_date is None or session_obj.timezone is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Session must have both session_date and timezone set "
                    "to use time_blocks"
                ),
            )
        time_blocks_input = [b.model_dump() for b in payload.time_blocks]
        session_date = session_obj.session_date
        timezone_name = session_obj.timezone
    else:
        implicit_start = utc_now() + dt.timedelta(minutes=5)
        time_blocks_input = [implicit_default_time_block(
            match_duration_seconds, payload.warn_below_multiplier
        )]
        time_blocks_input[0]["start_time"] = implicit_start.strftime("%H:%M")
        session_date = implicit_start.date()
        timezone_name = "UTC"

    try:
        resolved_blocks = resolve_block_cycle_times(
            time_blocks_input, total_time_slots_needed
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    sorted_distinct_time_slots = sorted({entry["time_slot"] for entry in generated})
    scheduled_times = assign_scheduled_times(
        resolved_blocks, sorted_distinct_time_slots, session_date, timezone_name
    )

    warn_threshold_seconds = match_duration_seconds * payload.warn_below_multiplier
    tight_blocks = [
        b for b in resolved_blocks if b.cycle_time_seconds < warn_threshold_seconds
    ]
    cycle_time_warning = None
    if tight_blocks:
        block_names = ", ".join(b.start_time for b in tight_blocks)
        cycle_time_warning = (
            f"Cycle time is below {payload.warn_below_multiplier}x match "
            f"duration ({match_duration_seconds}s) in block(s) starting at "
            f"{block_names}"
        )

    generation = ScheduleGeneration(
```

(`match_format` and `utc_now` are already available in this function — `match_format` is computed earlier in `generate_schedule`, and `utc_now` is already imported from `tournament_server.db` at the top of this file.)

- [ ] **Step 3: Set `scheduled_time` on every created `Match`, and return the new response fields**

Replace:

```python
        match = Match(
            session_id=payload.session_id,
            division_id=payload.division_id,
            round_type=payload.round_type,
            match_number=match_number,
            field_id=field_id,
            time_slot=entry["time_slot"],
            schedule_generation_id=generation.id,
        )
```

with:

```python
        match = Match(
            session_id=payload.session_id,
            division_id=payload.division_id,
            round_type=payload.round_type,
            match_number=match_number,
            field_id=field_id,
            time_slot=entry["time_slot"],
            schedule_generation_id=generation.id,
            scheduled_time=scheduled_times[entry["time_slot"]],
        )
```

Then replace:

```python
    return ScheduleGenerateResponse(
        schedule_generation_id=generation.id, match_count=len(created_matches)
    )
```

with:

```python
    return ScheduleGenerateResponse(
        schedule_generation_id=generation.id,
        match_count=len(created_matches),
        resolved_time_blocks=[
            ResolvedTimeBlockRead(
                start_time=b.start_time,
                end_time=b.end_time,
                cycle_time_seconds=b.cycle_time_seconds,
            )
            for b in resolved_blocks
        ],
        cycle_time_warning=cycle_time_warning,
    )
```

- [ ] **Step 4: Write the tests**

Append to `tests/test_schedule.py`:

```python
def test_generate_schedule_with_time_blocks_assigns_scheduled_time(client):
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
    team_ids = []
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        team_ids.append(team_id)
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
                {"start_time": "10:00", "end_time": "12:00", "cycle_time": None}
            ],
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert len(body["resolved_time_blocks"]) == 1
    assert body["resolved_time_blocks"][0]["cycle_time_seconds"] > 0

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    for match in matches:
        assert match["scheduled_time"] is not None


def test_generate_schedule_without_time_blocks_uses_implicit_default(client):
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
    assert len(body["resolved_time_blocks"]) == 1
    assert body["resolved_time_blocks"][0]["end_time"] is None
    assert body["cycle_time_warning"] is None

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    for match in matches:
        assert match["scheduled_time"] is not None


def test_generate_schedule_rejects_time_blocks_without_session_date_or_timezone(client):
    session_id, team_ids = _setup_ready_session(client)

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 3,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "10:00", "end_time": "12:00", "cycle_time": None}
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_rejects_mismatched_time_blocks(client):
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
    team_ids = []
    for i in range(8):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        team_ids.append(team_id)
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
                {"start_time": "10:00", "end_time": "10:05", "cycle_time": 300}
            ],
        },
    )
    assert response.status_code == 422


def test_generate_schedule_warns_when_cycle_time_too_tight(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    game_plugin_name = plugins[0]["name"]
    client.post("/api/event/game-plugin", json={"name": game_plugin_name})

    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]
    team_ids = []
    for i in range(4):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        team_ids.append(team_id)
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
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
            "time_blocks": [
                {"start_time": "10:00", "end_time": "10:01", "cycle_time": 5}
            ],
        },
    )
    assert response.status_code == 201
    assert response.json()["cycle_time_warning"] is not None
```

(`test_generate_schedule_warns_when_cycle_time_too_tight` uses a `cycle_time` of `5` seconds — tight enough to trigger the warning against any realistic game plugin's `autonomous_seconds + driver_seconds`, without needing to look up the exact value.)

- [ ] **Step 5: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_schedule.py -v`
Expected: all pass, including the 5 new tests.

Run: `.venv/bin/pytest tests/ -v`
Expected: 208 passed (203 from Task 2 + 5 new), 0 failures. Also specifically confirm every pre-existing `test_schedule.py` test (the ones from Phase 4, none of which pass `time_blocks`) still passes unchanged — they all take the implicit-default path now instead of leaving `scheduled_time` `NULL`, which is a real, deliberate behavior change from before this plan; nothing about their own assertions should break, since none of them assert `scheduled_time is None`.

- [ ] **Step 6: Commit**

```bash
git add src/tournament_server/schemas/schedule.py \
        src/tournament_server/routers/schedule.py \
        tests/test_schedule.py
git commit -m "Wire time_blocks into POST /api/schedule, assign real scheduled_time"
```

---

### Task 4: Documentation

**Files:**
- Modify: `server/CLAUDE.md`

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (documentation only).

- [ ] **Step 1: Add a "Time-based scheduling" section**

In `CLAUDE.md`, after the existing "## Scheduling" section, add:

```markdown
## Time-based scheduling

`POST /api/schedule` assigns every generated `Match` a real UTC
`scheduled_time`, computed from `time_blocks` — a list of `{start_time,
end_time, cycle_time}` windows (`services/schedule_timing.py`). Each
block is independently pinned (`end_time` + `cycle_time` both given, a
fixed match capacity), "calculate for me" (`cycle_time: null`, needs
`end_time` to divide by), or open-ended (`end_time: null`, needs
`cycle_time`, must be the last block, and cannot coexist with a
"calculate for me" block — see `resolve_block_cycle_times`'s docstring-
equivalent validation for why). Multiple "calculate for me" blocks always
end up with the same computed cycle time, by construction — capacity is
apportioned by duration via `_apportion_time_slots`'s largest-remainder
method.

Cycle time governs the interval between distinct `time_slot`s, not raw
matches — several matches can share one `time_slot` when multiple
`FieldSet`s run concurrently, and they all get the identical
`scheduled_time`.

Omitting `time_blocks` entirely synthesizes one implicit open-ended block
starting five minutes from `utc_now()`, at a cycle time derived from the
game plugin's `autonomous_seconds + driver_seconds` times
`warn_below_multiplier` (default `1.5`) — a pace that's never tight
enough to trigger this feature's own warning. This requires no
`session_date`/`timezone` on the session at all; using real `time_blocks`
does, since there's a real calendar window to resolve times against
(`TournamentSession.timezone`, an IANA zone name, alongside the existing
`session_date`).

`ScheduleGenerateResponse.cycle_time_warning` fires when any resolved
block's cycle time is below `match_duration_seconds *
warn_below_multiplier` — informational only, never blocks generation.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document time-based scheduling"
```
