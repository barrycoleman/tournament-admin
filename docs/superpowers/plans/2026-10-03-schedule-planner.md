# Schedule Planner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Schedule tab's time-block form with a live planner: session-level playing windows, per-division rounds (matches per team + cycle time) that flow through those windows, a server-computed live summary with fix suggestions, and in-place round edits that rebuild the changed round and every round after it.

**Architecture:** The server gains a `session_playing_windows` table and endpoints, a pure flow-through placement engine in `services/schedule_timing.py`, a rewritten `POST /api/schedule` (new `rounds` request shape; replaces unlocked rounds atomically; dry runs report overflow with a suggested cycle time and window end), and a read-only `GET /api/schedule/rounds`. The admin UI's Schedule tab becomes division tabs → a per-division `DivisionPlanner` (playing-times panel with timeline, rounds table, fit status, actions), driven by debounced dry-run calls so the server stays the single source of truth for match counts and times.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy, Alembic, pytest; TypeScript, React 19, React Router 6 data routers (`useBlocker`), TanStack Query 5, react-i18next, Vitest + React Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-03-schedule-planner-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere (code, comments, tests, commit messages, UI text).
- Every backend change ships with pytest tests against a real FastAPI `TestClient` and a real temp-file SQLite database, in the same commit as the code.
- Every frontend change ships with Vitest component tests; user-facing flows get Playwright E2E coverage with no mocking at the HTTP/WebSocket boundary.
- Changing the plugin interface means updating the conformance tool (`server/src/tournament_server/plugin_registry/conformance.py`) in the same change.
- Schema changes go through an Alembic migration in `server/src/tournament_server/_alembic/versions/` in the same commit as the model change, and never destroy existing data. The current head is `c9d34b7a1f02`.
- Every user-facing string goes through `t(...)` with entries in both `frontend/apps/admin/src/i18n/en/admin.json` and `.../zh/admin.json`.
- Match times always render in the session's timezone (`src/matchTime.ts`), never the browser's.
- Work on branch `schedule-planner` in the main checkout (no worktrees). Commit after each task; never push.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Server commands run from `server/` with `.venv/bin/python -m pytest`. Frontend commands run from `frontend/apps/admin/` (`npx vitest run`, `npx tsc --noEmit -p .`, `npm run test:e2e`).

## Review Focus

1. **A session whose timezone has a DST change between two playing days** — windows convert per date through `block_utc_bounds`, so each day's local 09:00 must land at its own correct UTC instant. Pinned by `test_windows_on_either_side_of_a_dst_change_keep_local_clock_times` (Task 3).
2. **A division whose earlier round ends inside the lunch gap** — the next round must start at the next window's start, not in the gap. Pinned by `test_a_round_after_one_that_ends_in_a_gap_starts_at_the_next_window` (Task 4).
3. **Another admin applies a change while this admin is editing** — refreshed server rounds must keep this admin's unlocked edits and drop (with a message) edits to rounds that became locked. Pinned by `mergeServerRounds` tests (Task 7).
4. **Extending the last window or saving playing times while a dry-run result is cached** — the summary must re-run, not show the stale result for an identical request body. Pinned by the `DivisionPlanner` test "re-checks the plan after Extend" (Task 10).
5. **A single-division event** (no `division_id`) — rounds, rebuilds, and the rounds endpoint must use the no-division scope exactly as generation does. Pinned by `test_rounds_endpoint_uses_the_no_division_scope_in_a_single_division_event` (Task 5) and the route test "shows no tabs in a single-division event" (Task 10).

---

## File Structure

**Server — create**
- `server/src/tournament_server/models/playing_window.py` — `SessionPlayingWindow` model.
- `server/src/tournament_server/_alembic/versions/e5a1c3b9d2f4_add_session_playing_windows.py` — migration.
- `server/src/tournament_server/_alembic/versions/f6b2d4c8e1a7_add_schedule_generations_cycle_time_seconds.py` — migration.
- `server/src/tournament_server/schemas/playing_window.py` — request/response models.
- `server/src/tournament_server/services/playing_windows.py` — validation + loading.
- `server/src/tournament_server/routers/playing_windows.py` — `GET`/`PUT /api/sessions/{id}/playing-windows`.
- `server/tests/test_playing_windows.py`, `server/tests/schedule_helpers.py`.

**Server — modify**
- `models/__init__.py`, `models/schedule_generation.py`, `app.py` (router), `schemas/event.py`, `routers/event.py`, `plugin_registry/conformance.py`, `plugins/games/sample_cooperative/plugin.py`, `services/schedule_timing.py`, `services/scheduling.py`, `schemas/schedule.py`, `routers/schedule.py`, `CLAUDE.md`.
- Tests: `test_plugin_conformance.py`, `test_event.py`, `test_sample_cooperative_plugin.py`, `test_schedule_timing.py`, `test_schedule.py`, `test_broadcast_wiring.py`.

**Frontend — create** (all under `frontend/apps/admin/`)
- `src/schedule/planDraft.ts` — pure draft model (rows, change detection, what to send, defaults, merge).
- `src/schedule/playingWindows.ts` — pure window-draft helpers and summaries.
- `src/schedule/timeline.ts` — pure timeline geometry.
- `src/schedule/formatDuration.ts` — "1 h 5 min".
- `src/schedule/usePlannerDraft.ts`, `src/schedule/usePlanPreview.ts`, `src/schedule/useUnsavedChangesGuard.tsx` — hooks.
- `src/schedule/PlayingTimesPanel.tsx`, `src/schedule/PlanTimeline.tsx`, `src/schedule/DivisionTabs.tsx`, `src/schedule/RoundsTable.tsx`, `src/schedule/FitStatus.tsx`, `src/schedule/ClearRoundDialog.tsx`, `src/schedule/DivisionPlanner.tsx` — components.
- Tests: `tests/unit/planDraft.test.ts`, `tests/unit/playingWindows.test.ts`, `tests/unit/timeline.test.ts`, `tests/unit/PlayingTimesPanel.test.tsx`, `tests/unit/DivisionTabs.test.tsx`.

**Frontend — modify:** `src/types.ts`, `src/schedule/readiness.ts`, `src/schedule/ReadinessChecklist.tsx`, `src/routes/SessionScheduleRoute.tsx`, `src/styles/components.css`, both `admin.json` files, `tests/unit/readiness.test.ts`, `tests/unit/SessionScheduleRoute.test.tsx`, `tests/e2e/z_sessionSchedule.spec.ts`, `frontend/CLAUDE.md`.

**Frontend — delete:** `src/schedule/ScheduleForm.tsx`, `src/schedule/PreviewPanel.tsx`, `src/schedule/CurrentRounds.tsx`, `src/schedule/scheduleRequest.ts`, `tests/unit/scheduleRequest.test.ts`.

Between Task 4 and Task 10 the admin UI's Schedule tab talks to an API shape it no longer matches. That is expected mid-branch; the E2E suite is only run from Task 11 on.

---

### Task 1: Session playing windows (storage + endpoints)

**Files:**
- Create: `server/src/tournament_server/models/playing_window.py`
- Create: `server/src/tournament_server/_alembic/versions/e5a1c3b9d2f4_add_session_playing_windows.py`
- Create: `server/src/tournament_server/schemas/playing_window.py`
- Create: `server/src/tournament_server/services/playing_windows.py`
- Create: `server/src/tournament_server/routers/playing_windows.py`
- Modify: `server/src/tournament_server/models/__init__.py`, `server/src/tournament_server/app.py:222-243`
- Test: `server/tests/test_playing_windows.py`

**Interfaces:**
- Produces: `SessionPlayingWindow` (table `session_playing_windows`); `validate_windows(windows: list[dict]) -> list[dict]` (raises `ValueError`); `load_windows(db: Session, session_id: int) -> list[dict]` returning `{"date": dt.date, "start_time": "HH:MM", "end_time": "HH:MM"}` sorted by `(date, start_time)`; `GET`/`PUT /api/sessions/{session_id}/playing-windows` returning `list[PlayingWindowRead]` (`date`, `start_time`, `end_time`, `start_utc`, `end_utc`).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_playing_windows.py`:

```python
SAT_MORNING = {"date": "2026-11-07", "start_time": "09:00", "end_time": "12:00"}
SAT_AFTERNOON = {"date": "2026-11-07", "start_time": "13:00", "end_time": "17:00"}
SUN = {"date": "2026-11-08", "start_time": "09:00", "end_time": "15:00"}


def _session(client, timezone: str | None = "America/Los_Angeles") -> int:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    body = {"label": "Weekend", "session_date": "2026-11-07"}
    if timezone is not None:
        body["timezone"] = timezone
    return client.post("/api/sessions", json=body).json()["id"]


def _put(client, session_id, windows):
    return client.put(f"/api/sessions/{session_id}/playing-windows", json={"windows": windows})


def test_a_new_session_has_no_playing_windows(client):
    session_id = _session(client)
    response = client.get(f"/api/sessions/{session_id}/playing-windows")
    assert response.status_code == 200
    assert response.json() == []


def test_put_stores_windows_sorted_with_their_utc_bounds(client):
    session_id = _session(client)
    response = _put(client, session_id, [SUN, SAT_AFTERNOON, SAT_MORNING])
    assert response.status_code == 200, response.text
    assert response.json() == [
        {**SAT_MORNING, "start_utc": "2026-11-07T17:00:00Z", "end_utc": "2026-11-07T20:00:00Z"},
        {**SAT_AFTERNOON, "start_utc": "2026-11-07T21:00:00Z", "end_utc": "2026-11-08T01:00:00Z"},
        {**SUN, "start_utc": "2026-11-08T17:00:00Z", "end_utc": "2026-11-08T23:00:00Z"},
    ]
    assert client.get(f"/api/sessions/{session_id}/playing-windows").json() == response.json()


def test_put_replaces_rather_than_appends(client):
    session_id = _session(client)
    _put(client, session_id, [SAT_MORNING, SAT_AFTERNOON])
    _put(client, session_id, [SUN])
    windows = client.get(f"/api/sessions/{session_id}/playing-windows").json()
    assert [(w["date"], w["start_time"]) for w in windows] == [("2026-11-08", "09:00")]


def test_put_with_no_windows_clears_them(client):
    session_id = _session(client)
    _put(client, session_id, [SAT_MORNING])
    assert _put(client, session_id, []).json() == []


def test_adjacent_windows_and_same_times_on_different_days_are_allowed(client):
    session_id = _session(client)
    touching = {"date": "2026-11-07", "start_time": "12:00", "end_time": "13:00"}
    response = _put(client, session_id, [SAT_MORNING, touching, SAT_AFTERNOON, {**SAT_MORNING, "date": "2026-11-08"}])
    assert response.status_code == 200, response.text


def test_rejects_a_window_that_ends_before_it_starts(client):
    session_id = _session(client)
    response = _put(client, session_id, [{"date": "2026-11-07", "start_time": "12:00", "end_time": "09:00"}])
    assert response.status_code == 422
    assert "must end after it starts" in response.json()["detail"]


def test_rejects_overlapping_windows_on_the_same_day(client):
    session_id = _session(client)
    overlapping = {"date": "2026-11-07", "start_time": "11:00", "end_time": "14:00"}
    response = _put(client, session_id, [SAT_MORNING, overlapping])
    assert response.status_code == 422
    assert "overlap" in response.json()["detail"]


def test_rejects_an_invalid_clock_time(client):
    session_id = _session(client)
    response = _put(client, session_id, [{"date": "2026-11-07", "start_time": "09:00", "end_time": "24:00"}])
    assert response.status_code == 422


def test_rejects_more_than_fifty_windows(client):
    session_id = _session(client)
    windows = [
        {"date": f"2026-12-{day:02d}", "start_time": f"{hour:02d}:00", "end_time": f"{hour:02d}:30"}
        for day in range(1, 27)
        for hour in (9, 10)
    ]
    assert len(windows) == 52
    response = _put(client, session_id, windows)
    assert response.status_code == 422
    assert "at most 50" in response.json()["detail"]


def test_rejects_windows_for_a_session_without_a_timezone(client):
    session_id = _session(client, timezone=None)
    response = _put(client, session_id, [SAT_MORNING])
    assert response.status_code == 422
    assert "timezone" in response.json()["detail"]


def test_unknown_session_is_404(client):
    _session(client)
    assert client.get("/api/sessions/999/playing-windows").status_code == 404
    assert _put(client, 999, [SAT_MORNING]).status_code == 404


def test_playing_windows_require_the_admin_role(client):
    from tests.auth_helpers import bearer, login_as

    session_id = _session(client)
    token = login_as(client, "front_desk")
    response = client.get(f"/api/sessions/{session_id}/playing-windows", headers=bearer(token))
    assert response.status_code == 403
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_playing_windows.py -q`
Expected: FAIL — every test gets 404/405 because the route doesn't exist.

- [ ] **Step 3: Add the model and migration**

Create `server/src/tournament_server/models/playing_window.py`:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import Date, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class SessionPlayingWindow(Base):
    """A span of session-local clock time on one date during which matches
    may be played. A session's windows never overlap; matches flow through
    them in (date, start_time) order, and the gaps between them are breaks."""

    __tablename__ = "session_playing_windows"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    date: Mapped[dt.date] = mapped_column(Date)
    start_time: Mapped[str] = mapped_column(String(5))
    end_time: Mapped[str] = mapped_column(String(5))
```

In `server/src/tournament_server/models/__init__.py` add `from tournament_server.models.playing_window import SessionPlayingWindow` (alphabetical with the other imports) and `"SessionPlayingWindow"` to `__all__`.

Create `server/src/tournament_server/_alembic/versions/e5a1c3b9d2f4_add_session_playing_windows.py`:

```python
"""add session_playing_windows

Revision ID: e5a1c3b9d2f4
Revises: c9d34b7a1f02
Create Date: 2026-10-03 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'e5a1c3b9d2f4'
down_revision: Union[str, None] = 'c9d34b7a1f02'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'session_playing_windows',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('session_id', sa.Integer(), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('start_time', sa.String(length=5), nullable=False),
        sa.Column('end_time', sa.String(length=5), nullable=False),
        sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )


def downgrade() -> None:
    op.drop_table('session_playing_windows')
```

Confirm `c9d34b7a1f02` is the head first: `grep -h "^down_revision" server/src/tournament_server/_alembic/versions/*.py` must not list `'c9d34b7a1f02'` anywhere before this file is added.

- [ ] **Step 4: Add the schemas, service and router**

Create `server/src/tournament_server/schemas/playing_window.py`:

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, Field

CLOCK_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class PlayingWindowIn(BaseModel):
    date: dt.date
    start_time: str = Field(pattern=CLOCK_PATTERN)
    end_time: str = Field(pattern=CLOCK_PATTERN)


class PlayingWindowsReplace(BaseModel):
    windows: list[PlayingWindowIn]


class PlayingWindowRead(BaseModel):
    date: dt.date
    start_time: str
    end_time: str
    # Null only when the session has no timezone to resolve them against.
    start_utc: dt.datetime | None
    end_utc: dt.datetime | None
```

Create `server/src/tournament_server/services/playing_windows.py`:

```python
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.playing_window import SessionPlayingWindow

MAX_WINDOWS = 50


def validate_windows(windows: list[dict]) -> list[dict]:
    """Returns the windows sorted by (date, start_time), or raises ValueError
    naming the first problem. Clock times are zero-padded HH:MM strings, so
    comparing them as strings compares them as times. A window ending
    exactly when the next one starts is allowed."""
    if len(windows) > MAX_WINDOWS:
        raise ValueError(f"A session can have at most {MAX_WINDOWS} playing windows")
    ordered = sorted(windows, key=lambda w: (w["date"], w["start_time"]))
    for window in ordered:
        if window["end_time"] <= window["start_time"]:
            raise ValueError(
                f"The playing window on {window['date'].isoformat()} starting at "
                f"{window['start_time']} must end after it starts"
            )
    for current, following in zip(ordered, ordered[1:]):
        if current["date"] == following["date"] and following["start_time"] < current["end_time"]:
            raise ValueError(
                f"Playing windows on {current['date'].isoformat()} overlap: "
                f"{current['start_time']}-{current['end_time']} and "
                f"{following['start_time']}-{following['end_time']}"
            )
    return ordered


def load_windows(db: Session, session_id: int) -> list[dict]:
    rows = db.execute(
        select(SessionPlayingWindow)
        .where(SessionPlayingWindow.session_id == session_id)
        .order_by(SessionPlayingWindow.date, SessionPlayingWindow.start_time)
    ).scalars().all()
    return [
        {"date": row.date, "start_time": row.start_time, "end_time": row.end_time}
        for row in rows
    ]
```

Create `server/src/tournament_server/routers/playing_windows.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin
from tournament_server.deps import get_db
from tournament_server.models.playing_window import SessionPlayingWindow
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.playing_window import PlayingWindowRead, PlayingWindowsReplace
from tournament_server.services.playing_windows import load_windows, validate_windows
from tournament_server.services.schedule_timing import block_utc_bounds

router = APIRouter(prefix="/api/sessions", tags=["playing-windows"])


def _read_models(windows: list[dict], timezone_name: str | None) -> list[PlayingWindowRead]:
    models = []
    for window in windows:
        start_utc = end_utc = None
        if timezone_name is not None:
            start_utc, end_utc = block_utc_bounds(window, timezone_name)
        models.append(PlayingWindowRead(**window, start_utc=start_utc, end_utc=end_utc))
    return models


def _get_session(db: Session, session_id: int) -> TournamentSession:
    session = db.get(TournamentSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.get("/{session_id}/playing-windows", response_model=list[PlayingWindowRead])
def read_playing_windows(
    session_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> list[PlayingWindowRead]:
    session = _get_session(db, session_id)
    return _read_models(load_windows(db, session_id), session.timezone)


@router.put("/{session_id}/playing-windows", response_model=list[PlayingWindowRead])
def replace_playing_windows(
    session_id: int,
    payload: PlayingWindowsReplace,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> list[PlayingWindowRead]:
    """Replaces every playing window at once. Matches already scheduled
    never move when the windows change; the Schedule tab flags rounds that
    now fall outside them."""
    session = _get_session(db, session_id)
    if session.timezone is None:
        raise HTTPException(
            status_code=422, detail="Set the session's timezone before adding playing times"
        )
    try:
        ordered = validate_windows([window.model_dump() for window in payload.windows])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    db.execute(delete(SessionPlayingWindow).where(SessionPlayingWindow.session_id == session_id))
    for window in ordered:
        db.add(SessionPlayingWindow(session_id=session_id, **window))
    db.commit()
    return _read_models(load_windows(db, session_id), session.timezone)
```

In `server/src/tournament_server/app.py` import `playing_windows` alongside the other routers and add `app.include_router(playing_windows.router)` right after `app.include_router(sessions.router)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_playing_windows.py tests/test_alembic_drift.py tests/test_alembic_baseline.py tests/test_migrations.py -q`
Expected: PASS. If the drift test reports a difference, make the migration match the model exactly (do not edit the model to match a typo in the migration).

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/models server/src/tournament_server/_alembic/versions/e5a1c3b9d2f4_add_session_playing_windows.py server/src/tournament_server/schemas/playing_window.py server/src/tournament_server/services/playing_windows.py server/src/tournament_server/routers/playing_windows.py server/src/tournament_server/app.py server/tests/test_playing_windows.py
git commit -m "Add session playing windows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Optional per-game default cycle time

**Files:**
- Modify: `server/src/tournament_server/plugin_registry/conformance.py:183-225`
- Modify: `server/src/tournament_server/schemas/event.py:35-39`, `server/src/tournament_server/routers/event.py:87-94`
- Modify: `server/plugins/games/sample_cooperative/plugin.py` (`match_format`)
- Test: `server/tests/test_plugin_conformance.py`, `server/tests/test_event.py:167-174`, `server/tests/test_sample_cooperative_plugin.py`

**Interfaces:**
- Produces: `match_format()["default_cycle_time_seconds"]` (optional int ≥ match length); `GET /api/event/match-format` gains `default_cycle_time_seconds: int | null`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_plugin_conformance.py`:

```python
def _example_with_default_cycle(tmp_path, name: str, value: str):
    import shutil

    plugin_dir = tmp_path / name
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, plugin_dir)
    manifest = json.loads((plugin_dir / "manifest.json").read_text())
    manifest["name"] = name
    (plugin_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (plugin_dir / "plugin.py").read_text()
    anchor = '"finals_format": "single_elimination",'
    assert anchor in plugin_text, "test fixture setup did not find the line to extend"
    (plugin_dir / "plugin.py").write_text(
        plugin_text.replace(anchor, f'{anchor}\n        "default_cycle_time_seconds": {value},')
    )
    return plugin_dir


def test_a_default_cycle_time_of_at_least_the_match_length_passes(tmp_path):
    report = run_conformance_checks(_example_with_default_cycle(tmp_path, "cycle-ok", "300"))
    check = next(c for c in report.checks if c.name == "match_format() shape")
    assert check.passed, check.message


def test_a_default_cycle_time_shorter_than_the_match_fails(tmp_path):
    report = run_conformance_checks(_example_with_default_cycle(tmp_path, "cycle-short", "90"))
    check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not check.passed
    assert "at least the match length (120s)" in check.message


def test_a_non_integer_default_cycle_time_fails(tmp_path):
    report = run_conformance_checks(_example_with_default_cycle(tmp_path, "cycle-float", "300.5"))
    check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not check.passed
    assert "default_cycle_time_seconds must be an integer" in check.message
```

In `server/tests/test_event.py`, change the expected body at lines 169-174 to include `"default_cycle_time_seconds": None,` after `"match_duration_seconds": 120,`.

Append to `server/tests/test_sample_cooperative_plugin.py`:

```python
def test_sample_game_declares_a_five_minute_default_cycle_time():
    plugin_path = Path(__file__).parent.parent / "plugins" / "games" / "sample_cooperative" / "plugin.py"
    namespace: dict = {}
    exec(compile(plugin_path.read_text(), str(plugin_path), "exec"), namespace)
    assert namespace["match_format"]()["default_cycle_time_seconds"] == 300
```

Make sure `Path` is imported at the top of the file (`from pathlib import Path`).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_plugin_conformance.py tests/test_event.py tests/test_sample_cooperative_plugin.py -q`
Expected: the "shorter" and "non-integer" tests fail (no check yet), the match-format body test fails (missing key), the sample-game test fails with `KeyError`.

- [ ] **Step 3: Implement**

In `conformance.py`'s `_check_match_format`, insert before the final `return CheckResult("match_format() shape", True)`:

```python
    default_cycle = result.get("default_cycle_time_seconds")
    if default_cycle is not None:
        match_seconds = result["autonomous_seconds"] + result["driver_seconds"]
        if isinstance(default_cycle, bool) or not isinstance(default_cycle, int):
            return CheckResult(
                "match_format() shape",
                False,
                "default_cycle_time_seconds must be an integer number of seconds, got "
                f"{default_cycle!r}",
            )
        if default_cycle < match_seconds:
            return CheckResult(
                "match_format() shape",
                False,
                f"default_cycle_time_seconds ({default_cycle}) must be at least the "
                f"match length ({match_seconds}s)",
            )
```

In `schemas/event.py` add to `MatchFormatRead`: `default_cycle_time_seconds: int | None = None`.

In `routers/event.py`'s `read_match_format`, add to the `MatchFormatRead(...)` call: `default_cycle_time_seconds=match_format.get("default_cycle_time_seconds"),`.

In `server/plugins/games/sample_cooperative/plugin.py`'s `match_format()` dict, add after `"finals_format": "score_chase",`:

```python
        # A starting point for the Schedule tab: a 60-second match plus
        # time to reset the field and queue the next teams.
        "default_cycle_time_seconds": 300,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_plugin_conformance.py tests/test_event.py tests/test_sample_cooperative_plugin.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/plugin_registry/conformance.py server/src/tournament_server/schemas/event.py server/src/tournament_server/routers/event.py server/plugins/games/sample_cooperative/plugin.py server/tests/test_plugin_conformance.py server/tests/test_event.py server/tests/test_sample_cooperative_plugin.py
git commit -m "Let a game plugin declare a default cycle time

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Flow-through placement engine

**Files:**
- Modify: `server/src/tournament_server/services/schedule_timing.py` (add functions; nothing removed yet)
- Test: `server/tests/test_schedule_timing.py` (append)

**Interfaces:**
- Consumes: `block_utc_bounds(block: dict, timezone_name: str)` (existing).
- Produces:
  - `PlayingWindow` (frozen dataclass: `date: dt.date`, `start_time: str`, `end_time: str`, `start: dt.datetime`, `end: dt.datetime`, both UTC).
  - `to_utc_windows(rows: list[dict], timezone_name: str) -> list[PlayingWindow]`.
  - `ceil_minute(instant: dt.datetime) -> dt.datetime`.
  - `place_slots(windows, earliest, slot_count, cycle_seconds, match_seconds) -> list[dt.datetime]`.
  - `PlanPlacement` (`round_starts: list[list[dt.datetime]]`, `unplaced_slot_count: int`, property `fits`).
  - `place_plan(windows, earliest, rounds: list[tuple[int, int]], match_seconds) -> PlanPlacement` — each tuple is `(slot_count, cycle_seconds)`.
  - `OverflowSuggestions` (`over_by_seconds: int`, `suggested_cycle_time_seconds: int | None`, `suggested_last_window_end: str | None`).
  - `overflow_suggestions(windows, earliest, rounds, match_seconds, timezone_name) -> OverflowSuggestions`.
  - `occupied_by_window(windows, starts, match_seconds) -> list[tuple[PlayingWindow, dt.datetime, dt.datetime]]`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_schedule_timing.py` (add `import datetime as dt` at the top if not present):

```python
from tournament_server.services.schedule_timing import (
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


def _windows(*spans, date=SAT):
    return to_utc_windows(
        [{"date": d, "start_time": s, "end_time": e} for d, s, e in
         ((span[0], span[1], span[2]) if len(span) == 3 else (date, span[0], span[1]) for span in spans)],
        LA,
    )


def _local(instant):
    from zoneinfo import ZoneInfo

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
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_schedule_timing.py -q`
Expected: FAIL with `ImportError: cannot import name 'ceil_minute'`.

- [ ] **Step 3: Implement**

Append to `server/src/tournament_server/services/schedule_timing.py`:

```python
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_schedule_timing.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/services/schedule_timing.py server/tests/test_schedule_timing.py
git commit -m "Add flow-through placement across playing windows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Rewrite `POST /api/schedule` around rounds and playing windows

**Files:**
- Create: `server/src/tournament_server/_alembic/versions/f6b2d4c8e1a7_add_schedule_generations_cycle_time_seconds.py`
- Create: `server/tests/schedule_helpers.py`
- Modify: `server/src/tournament_server/models/schedule_generation.py`
- Modify: `server/src/tournament_server/schemas/schedule.py`
- Modify: `server/src/tournament_server/services/scheduling.py:11-25` (`build_pairing_history`)
- Modify: `server/src/tournament_server/services/schedule_timing.py` (remove the old block engine)
- Modify: `server/src/tournament_server/routers/schedule.py` (whole `generate_schedule`, overlap check, delete helper)
- Test: `server/tests/test_schedule.py` (rewrite), `server/tests/test_schedule_timing.py` (prune), `server/tests/test_broadcast_wiring.py:64-72`, `server/tests/test_sample_cooperative_plugin.py:150-160`

**Interfaces:**
- Consumes: everything Task 3 produces; `load_windows` (Task 1).
- Produces:
  - Request: `{"session_id", "division_id"?, "scheduler_plugin_name", "rounds": [{"round_type", "target_matches_per_team", "cycle_time_seconds"}], "excluded_team_ids"?, "dry_run"?}`. Unknown keys (e.g. the old `time_blocks`, `phases`, `round_type`) are rejected with 422.
  - Response `ScheduleGenerateResponse`: `fits: bool`, `rounds: list[RoundResult]` (`round_type`, `schedule_generation_id`, `match_count`, `slot_count`, `first_start`, `last_end`), `overflow: ScheduleOverflow | None` (`unplaced_slot_count`, `unplaced_match_count`, `over_by_seconds`, `suggested_cycle_time_seconds`, `suggested_last_window_end`).
  - `ScheduleGeneration.cycle_time_seconds: int | None`.
  - `build_pairing_history(db, event_id, exclude_match_ids=frozenset())`.
  - Router helpers reused in Task 5: `_division_rounds(db, session_id, division_id) -> list[_DivisionRound]`, `_delete_round(db, session_id, division_id, round_type) -> int`, `_round_label(round_type) -> str`.
  - Test helpers: `set_playing_windows(client, session_id, windows=ALL_DAY)`, `schedule(client, session_id, rounds, *, division_id=None, scheduler="simple_random", dry_run=False)`.

- [ ] **Step 1: Add the shared test helpers**

Create `server/tests/schedule_helpers.py`:

```python
"""Shared setup for tests that generate schedules: every schedule now
needs a session timezone and at least one playing window."""

PLAY_DATE = "2026-11-07"
TZ = "America/Los_Angeles"
ALL_DAY = [{"date": PLAY_DATE, "start_time": "08:00", "end_time": "20:00"}]
DEFAULT_CYCLE = 300


def set_playing_windows(client, session_id: int, windows=ALL_DAY) -> None:
    client.patch(f"/api/sessions/{session_id}", json={"timezone": TZ})
    response = client.put(f"/api/sessions/{session_id}/playing-windows", json={"windows": windows})
    assert response.status_code == 200, response.text


def schedule(
    client,
    session_id: int,
    rounds,
    *,
    division_id: int | None = None,
    scheduler: str = "simple_random",
    dry_run: bool = False,
):
    """`rounds` is a list of (round_type, matches_per_team) or
    (round_type, matches_per_team, cycle_time_seconds) tuples."""
    body = {
        "session_id": session_id,
        "scheduler_plugin_name": scheduler,
        "rounds": [
            {
                "round_type": entry[0],
                "target_matches_per_team": entry[1],
                "cycle_time_seconds": entry[2] if len(entry) > 2 else DEFAULT_CYCLE,
            }
            for entry in rounds
        ],
        "dry_run": dry_run,
    }
    if division_id is not None:
        body["division_id"] = division_id
    return client.post("/api/schedule", json=body)
```

- [ ] **Step 2: Rewrite the schedule tests (they will fail)**

Rewrite `server/tests/test_schedule.py` as follows.

(a) Keep `_setup_ready_session`, give it a `num_fields: int = 2` parameter (create that many fields named `Field 1..n`), and end it with `set_playing_windows(client, session_id)` before returning. Import the helpers at the top: `from schedule_helpers import ALL_DAY, PLAY_DATE, TZ, schedule, set_playing_windows` (the tests directory is on `sys.path`, as `auth_helpers` already is).

(b) **Delete** these tests — the concepts they cover no longer exist:
`test_generate_schedule_rejects_when_matches_already_exist`, `test_generate_schedule_with_time_blocks_assigns_scheduled_time`, `test_generate_schedule_without_time_blocks_uses_implicit_default`, `test_generate_schedule_rejects_time_blocks_without_timezone`, `test_generate_schedule_allows_time_blocks_without_session_date`, `test_generate_schedule_rejects_mismatched_time_blocks`, `test_generate_schedule_warns_when_cycle_time_too_tight`, `test_generate_schedule_rejects_zero_cycle_time`, `test_generate_schedule_rejects_negative_cycle_time`, `test_generate_schedule_rejects_malformed_start_time`, `test_generate_schedule_rejects_overlapping_time_blocks`, `test_generate_schedule_rejects_time_blocks_not_in_ascending_order`, `test_generate_schedule_warn_below_multiplier_override_changes_warning_outcome`, `test_generate_schedule_with_time_blocks_spanning_multiple_days`, `test_generate_schedule_rejects_overlap_with_a_prior_generation`, `test_delete_schedule_clears_stored_blocks_allowing_reuse`, `test_generate_schedule_rejects_both_round_type_and_phases`, `test_generate_schedule_rejects_neither_round_type_nor_phases`, `test_generate_schedule_phases_all_or_nothing_conflict`, `test_generate_schedule_singular_shape_unaffected_by_phases_support`, `test_generate_schedule_rejects_overlap_across_timezone_frames_from_implicit_and_explicit_paths`, `test_generate_schedule_with_phases_and_explicit_multi_block_time_blocks`, `test_resolved_time_blocks_report_their_time_slot_count`, `test_a_block_may_start_once_an_open_ended_blocks_matches_finish`, `test_a_block_starting_before_the_last_match_ends_names_both_windows`, `test_an_open_ended_new_block_may_finish_before_an_existing_round`, `test_a_new_block_running_into_an_existing_round_says_when_to_finish`, `test_a_fixed_block_that_finishes_early_frees_the_rest_of_its_window`, `test_a_generation_saved_without_occupied_times_keeps_its_requested_window`, `test_clearing_one_phase_of_a_combined_request_frees_only_its_time`, `test_a_later_phase_claims_only_its_own_matches_window`, and the helpers `_timed_session`, `_generate`, `_open_ended_practice`.

(c) **Convert** every remaining test's `POST /api/schedule` call mechanically:
- A body with `"round_type": X, "target_matches_per_team": N` (and optionally `"scheduler_plugin_name": S`, `"division_id": D`, `"dry_run": B`) becomes `schedule(client, session_id, [(X, N)], scheduler=S, division_id=D, dry_run=B)`.
- A body with `"phases": [{"round_type": X, "target_matches_per_team": N}, ...]` becomes `schedule(client, session_id, [(X, N), ...], ...)`.
- `body["match_count"]` becomes `sum(r["match_count"] for r in body["rounds"])`; `body["phase_results"]` becomes `body["rounds"]`; `body["schedule_generation_id"]` becomes `body["rounds"][0]["schedule_generation_id"]`.
- Any session created outside `_setup_ready_session` gets `set_playing_windows(client, session_id)` before its first `schedule(...)`.
- `test_generate_schedule_rejects_duplicate_round_type_across_phases`: expect detail `"rounds must not repeat a round_type"`.
- `test_generate_schedule_shares_scheduled_time_across_concurrent_field_sets` and `test_generate_schedule_allows_overlap_across_different_divisions` keep their assertions about equal `scheduled_time`s; those times now come from the 08:00 window.

(d) **Add** these tests:

```python
from zoneinfo import ZoneInfo

LA = ZoneInfo(TZ)


def _local_times(client, session_id, round_type=None):
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    return sorted(
        {
            dt.datetime.fromisoformat(m["scheduled_time"]).astimezone(LA).strftime("%a %H:%M:%S")
            for m in matches
            if round_type is None or m["round_type"] == round_type
        }
    )


def _score_one_match(client, session_id, round_type):
    match = next(
        m for m in client.get(f"/api/matches?session_id={session_id}").json()
        if m["round_type"] == round_type
    )
    for alliance in match["alliances"]:
        response = client.post(
            f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": 1, "low_balls": 1}},
        )
        assert response.status_code in (200, 201), response.text


def test_rejects_a_session_without_playing_windows(client):
    session_id, _ = _setup_ready_session(client)
    client.put(f"/api/sessions/{session_id}/playing-windows", json={"windows": []})
    response = schedule(client, session_id, [("qualification", 1)])
    assert response.status_code == 422
    assert response.json()["detail"] == "This session has no playing times; add them before scheduling"


def test_rejects_a_session_without_a_timezone(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "No zone"}).json()["id"]
    response = schedule(client, session_id, [("qualification", 1)])
    assert response.status_code == 422
    assert response.json()["detail"] == "Set the session's timezone before scheduling"


def test_rejects_the_old_request_shape(client):
    session_id, _ = _setup_ready_session(client)
    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422


def test_rejects_elimination_and_a_cycle_shorter_than_the_match(client):
    session_id, _ = _setup_ready_session(client)
    elimination = schedule(client, session_id, [("elimination", 1)])
    assert elimination.status_code == 422
    assert "finals" in elimination.json()["detail"]
    short = schedule(client, session_id, [("qualification", 1, 90)])
    assert short.status_code == 422
    assert "at least the match length (120s)" in short.json()["detail"]


def test_matches_flow_across_a_break_and_into_the_next_day(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [
        {"date": PLAY_DATE, "start_time": "09:00", "end_time": "09:06"},
        {"date": PLAY_DATE, "start_time": "13:00", "end_time": "13:06"},
        {"date": "2026-11-08", "start_time": "09:00", "end_time": "12:00"},
    ])
    # 8 teams, 4 per match, 1 field: 1 match per slot. 1/team = 2 slots.
    response = schedule(client, session_id, [("qualification", 3, 240)])
    assert response.status_code == 201, response.text
    assert _local_times(client, session_id) == [
        "Sat 09:00:00", "Sat 09:04:00", "Sat 13:00:00", "Sat 13:04:00", "Sun 09:00:00", "Sun 09:04:00",
    ]


def test_a_new_round_starts_on_the_minute_after_the_previous_rounds_last_match(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "12:00"}])
    assert schedule(client, session_id, [("practice", 1, 150)]).status_code == 201
    # Practice: 09:00 and 09:02:30, which ends at 09:04:30.
    assert schedule(client, session_id, [("qualification", 1, 240)]).status_code == 201
    assert _local_times(client, session_id, "qualification")[0] == "Sat 09:05:00"


def test_a_round_after_one_that_ends_in_a_gap_starts_at_the_next_window(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [
        {"date": PLAY_DATE, "start_time": "09:00", "end_time": "09:05"},
        {"date": PLAY_DATE, "start_time": "13:00", "end_time": "14:00"},
    ])
    # Practice 09:00 (ends 09:02) and 09:02:30 would end 09:04:30; both fit before 09:05.
    assert schedule(client, session_id, [("practice", 1, 150)]).status_code == 201
    assert schedule(client, session_id, [("qualification", 1, 240)]).status_code == 201
    assert _local_times(client, session_id, "qualification")[0] == "Sat 13:00:00"


def test_a_dry_run_reports_each_rounds_times_and_creates_nothing(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "12:00"}])
    response = schedule(client, session_id, [("practice", 1, 150), ("qualification", 1, 240)], dry_run=True)
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["fits"] is True and body["overflow"] is None
    practice, qualification = body["rounds"]
    assert (practice["match_count"], practice["slot_count"]) == (2, 2)
    assert practice["schedule_generation_id"] is None
    assert practice["first_start"] == "2026-11-07T17:00:00Z"
    assert practice["last_end"] == "2026-11-07T17:04:30Z"
    assert qualification["first_start"] == "2026-11-07T17:05:00Z"
    assert client.get(f"/api/matches?session_id={session_id}").json() == []


def test_a_dry_run_that_does_not_fit_reports_overflow_and_suggestions(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "10:00"}])
    # 6 matches per team = 12 single-field slots at 6:00: the last would start 10:06.
    body = schedule(client, session_id, [("qualification", 6, 360)], dry_run=True).json()
    assert body["fits"] is False
    assert body["rounds"][0]["last_end"] is None
    overflow = body["overflow"]
    assert overflow["unplaced_slot_count"] == 2
    assert overflow["unplaced_match_count"] == 2
    assert overflow["over_by_seconds"] == 480  # last match would end 10:08
    assert overflow["suggested_last_window_end"] == "10:08"
    assert overflow["suggested_cycle_time_seconds"] == 316  # 11 * c + 120 <= 3600


def test_a_real_request_that_does_not_fit_is_422_and_creates_nothing(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "10:00"}])
    response = schedule(client, session_id, [("qualification", 6, 360)])
    assert response.status_code == 422
    assert response.json()["detail"].startswith("2 matches don't fit in the session's playing times")
    assert client.get(f"/api/matches?session_id={session_id}").json() == []


def test_rebuilding_a_round_also_rebuilds_the_rounds_after_it(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    response = schedule(client, session_id, [("practice", 2), ("qualification", 1)])
    assert response.status_code == 201, response.text
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert sum(m["round_type"] == "practice" for m in matches) == 4
    last_practice = max(m["scheduled_time"] for m in matches if m["round_type"] == "practice")
    first_qualification = min(m["scheduled_time"] for m in matches if m["round_type"] == "qualification")
    assert first_qualification > last_practice


def test_rebuilding_a_round_without_the_rounds_after_it_is_rejected(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    response = schedule(client, session_id, [("practice", 2)])
    assert response.status_code == 422
    assert response.json()["detail"] == (
        "Rebuilding Practice also moves the rounds after it; include Qualification too"
    )


def test_rebuilding_only_the_last_round_keeps_the_earlier_ones(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    before = {m["id"] for m in client.get(f"/api/matches?session_id={session_id}").json() if m["round_type"] == "practice"}
    assert schedule(client, session_id, [("qualification", 2)]).status_code == 201
    after = {m["id"] for m in client.get(f"/api/matches?session_id={session_id}").json() if m["round_type"] == "practice"}
    assert after == before


def test_a_round_with_scores_cannot_be_rebuilt(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    _score_one_match(client, session_id, "practice")
    response = schedule(client, session_id, [("practice", 2), ("qualification", 1)])
    assert response.status_code == 422
    assert response.json()["detail"] == "Practice has scored matches, so it can't be rebuilt. Clear it first."


def test_a_round_after_a_scored_round_can_still_be_rebuilt(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    _score_one_match(client, session_id, "practice")
    assert schedule(client, session_id, [("qualification", 2)]).status_code == 201


def test_a_rebuild_whose_scheduler_fails_leaves_the_old_schedule_intact(client, monkeypatch):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    before = client.get(f"/api/matches?session_id={session_id}").json()
    module = client.app.state.scheduler_plugins.get("simple_random").module
    real = module.generate_schedule
    calls = {"n": 0}

    def fail_second(**kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("scheduler exploded")
        return real(**kwargs)

    monkeypatch.setattr(module, "generate_schedule", fail_second)
    response = schedule(client, session_id, [("practice", 2), ("qualification", 1)])
    assert response.status_code == 422
    assert client.get(f"/api/matches?session_id={session_id}").json() == before


def test_a_rebuild_that_fails_while_saving_rolls_back(client, monkeypatch):
    import pytest

    from tournament_server.routers import schedule as schedule_router

    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    before = client.get(f"/api/matches?session_id={session_id}").json()
    real = schedule_router.serialize_time_blocks
    calls = {"n": 0}

    def fail_second(*args, **kwargs):
        calls["n"] += 1
        if calls["n"] == 2:
            raise RuntimeError("disk full")
        return real(*args, **kwargs)

    monkeypatch.setattr(schedule_router, "serialize_time_blocks", fail_second)
    with pytest.raises(RuntimeError):
        schedule(client, session_id, [("practice", 2), ("qualification", 1)])
    assert client.get(f"/api/matches?session_id={session_id}").json() == before


def test_pairing_history_leaves_out_the_rounds_being_replaced(client, monkeypatch):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("qualification", 1)]).status_code == 201
    module = client.app.state.scheduler_plugins.get("simple_random").module
    real = module.generate_schedule
    seen = []

    def capture(**kwargs):
        seen.append(kwargs["cross_session_pairing_history"])
        return real(**kwargs)

    monkeypatch.setattr(module, "generate_schedule", capture)
    assert schedule(client, session_id, [("qualification", 1)]).status_code == 201
    assert seen == [{}]


def test_a_generation_records_its_cycle_time_and_the_windows_it_uses(client):
    from tournament_server.models.schedule_generation import ScheduleGeneration

    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [
        {"date": PLAY_DATE, "start_time": "09:00", "end_time": "09:05"},
        {"date": PLAY_DATE, "start_time": "13:00", "end_time": "14:00"},
    ])
    assert schedule(client, session_id, [("qualification", 2, 240)]).status_code == 201
    db = client.app.state.session_factory()
    try:
        generation = db.query(ScheduleGeneration).one()
        assert generation.cycle_time_seconds == 240
        blocks = json.loads(generation.time_blocks_json)
        assert [(b["start_time"], b["occupied_from"], b["occupied_until"]) for b in blocks] == [
            ("09:00", "2026-11-07T17:00:00+00:00", "2026-11-07T17:02:00+00:00"),
            ("13:00", "2026-11-07T21:00:00+00:00", "2026-11-07T21:10:00+00:00"),
        ]
    finally:
        db.close()


def test_an_old_format_generation_still_blocks_overlapping_matches(client):
    from tournament_server.models.schedule_generation import ScheduleGeneration

    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1)]).status_code == 201
    db = client.app.state.session_factory()
    try:
        generation = db.query(ScheduleGeneration).one()
        # A row saved before occupied windows existed: an open-ended block
        # from 08:00 claims everything after it.
        generation.time_blocks_json = json.dumps([
            {"date": PLAY_DATE, "start_time": "08:00", "end_time": None, "cycle_time": 300, "timezone": TZ}
        ])
        db.commit()
    finally:
        db.close()
    response = schedule(client, session_id, [("qualification", 1)])
    assert response.status_code == 422
    assert "overlapping the practice round's matches" in response.json()["detail"]
```

Also rewrite `test_generate_schedule_combined_phases_fold_pairing_history_between_phases` only as far as rule (c) requires — its assertion about the second phase seeing the first phase's pairings stays.

- [ ] **Step 3: Update the other tests that call the endpoint**

`server/tests/test_broadcast_wiring.py` (around line 64): before opening the websocket, call `set_playing_windows(client, session_id)` and replace the `client.post("/api/schedule", ...)` with `schedule(client, session_id, [("qualification", 1)])` (import from `schedule_helpers`).

`server/tests/test_sample_cooperative_plugin.py` (around line 150): call `set_playing_windows(sample_client, session_id)` and replace the post with `schedule(sample_client, session_id, [("qualification", 4)])`. The sample game's match is 60 seconds, so the helper's 300-second default cycle is valid.

`server/tests/test_schedule_timing.py`: delete every test that imports or calls `resolve_block_cycle_times`, `assign_scheduled_times`, `blocks_occupied_windows`, `validate_blocks_ordered_and_non_overlapping`, `implicit_default_time_block`, `_apportion_time_slots` or `ResolvedBlock`. Keep the `block_utc_bounds`, `serialize_time_blocks` and `deserialize_time_blocks` tests; where a kept serialization test built its `occupied` argument with `blocks_occupied_windows`, pass a literal list of `(datetime, datetime)` tuples instead.

Run: `cd server && .venv/bin/python -m pytest tests/test_schedule.py tests/test_broadcast_wiring.py tests/test_sample_cooperative_plugin.py tests/test_schedule_timing.py -q`
Expected: FAIL — the endpoint still takes the old shape.

- [ ] **Step 4: Add the cycle-time column and migration**

In `server/src/tournament_server/models/schedule_generation.py` add (after `time_blocks_json`, importing `Integer` if needed):

```python
    # The round's cycle time; null for rows saved before rounds recorded it.
    cycle_time_seconds: Mapped[int | None] = mapped_column(Integer, default=None)
```

Create `server/src/tournament_server/_alembic/versions/f6b2d4c8e1a7_add_schedule_generations_cycle_time_seconds.py`:

```python
"""add schedule_generations cycle_time_seconds

Revision ID: f6b2d4c8e1a7
Revises: e5a1c3b9d2f4
Create Date: 2026-10-03 13:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'f6b2d4c8e1a7'
down_revision: Union[str, None] = 'e5a1c3b9d2f4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: earlier generations used per-block cycle times, so there is
    # no single value to backfill. The Schedule tab falls back to a default.
    op.add_column(
        'schedule_generations', sa.Column('cycle_time_seconds', sa.Integer(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('schedule_generations', 'cycle_time_seconds')
```

- [ ] **Step 5: Replace the schemas**

Replace the contents of `server/src/tournament_server/schemas/schedule.py` with:

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, Field


class ScheduleRound(BaseModel):
    round_type: str
    target_matches_per_team: int = Field(ge=1)
    cycle_time_seconds: int = Field(gt=0)


class ScheduleGenerateRequest(BaseModel):
    # Forbid unknown keys so a client still sending the old time_blocks/
    # phases shape fails loudly instead of being half-understood.
    model_config = ConfigDict(extra="forbid")

    session_id: int
    division_id: int | None = None
    scheduler_plugin_name: str
    rounds: list[ScheduleRound] = Field(min_length=1)
    excluded_team_ids: list[int] = []
    dry_run: bool = False


class RoundResult(BaseModel):
    round_type: str
    schedule_generation_id: int | None
    match_count: int
    slot_count: int
    first_start: dt.datetime | None
    # Null when the round doesn't fully fit in the playing windows.
    last_end: dt.datetime | None


class ScheduleOverflow(BaseModel):
    unplaced_slot_count: int
    unplaced_match_count: int
    over_by_seconds: int
    suggested_cycle_time_seconds: int | None
    suggested_last_window_end: str | None


class ScheduleGenerateResponse(BaseModel):
    fits: bool
    rounds: list[RoundResult]
    overflow: ScheduleOverflow | None


class ScheduledRoundRead(BaseModel):
    round_type: str
    target_matches_per_team: int | None
    cycle_time_seconds: int | None
    match_count: int
    scored_count: int
    first_start: dt.datetime | None
    last_end: dt.datetime | None
    locked: bool
    outside_playing_windows: bool


class ScheduleRoundsRead(BaseModel):
    rounds: list[ScheduledRoundRead]
    session_last_cycle_time_seconds: int | None
```

(`ScheduledRoundRead`/`ScheduleRoundsRead` are used by Task 5; defining them now keeps the schema module in one piece.)

- [ ] **Step 6: Let pairing history leave out replaced matches**

In `server/src/tournament_server/services/scheduling.py`, change `build_pairing_history`'s signature and match query:

```python
def build_pairing_history(
    db: Session, event_id: int, exclude_match_ids: frozenset[int] | set[int] = frozenset()
) -> dict[frozenset[int], dict[str, int]]:
```

and after `matches = db.execute(...).scalars().all()` add:

```python
    # A rebuild must not count the very matches it is about to replace.
    matches = [match for match in matches if match.id not in exclude_match_ids]
```

- [ ] **Step 7: Remove the old block engine**

In `server/src/tournament_server/services/schedule_timing.py` delete `ResolvedBlock`, `_block_duration_seconds`, `_apportion_time_slots`, `validate_blocks_ordered_and_non_overlapping`, `resolve_block_cycle_times`, `assign_scheduled_times`, `blocks_occupied_windows` and `implicit_default_time_block`. Keep `_parse_time_of_day`, `block_utc_bounds`, `serialize_time_blocks`, `deserialize_time_blocks` and everything Task 3 added. In `serialize_time_blocks`'s docstring, replace the sentence about `ScheduleGenerateRequest.time_blocks or the implicit-default path` with "the playing windows a round's matches use".

- [ ] **Step 8: Rewrite the router**

In `server/src/tournament_server/routers/schedule.py`:

Replace the imports from `schemas.schedule` and `services.schedule_timing` with:

```python
from dataclasses import dataclass
import math

from tournament_server.schemas.schedule import (
    RoundResult,
    ScheduleGenerateRequest,
    ScheduleGenerateResponse,
    ScheduleOverflow,
)
from tournament_server.services.playing_windows import load_windows
from tournament_server.services.schedule_timing import (
    PlayingWindow,
    block_utc_bounds,
    ceil_minute,
    deserialize_time_blocks,
    occupied_by_window,
    overflow_suggestions,
    place_plan,
    serialize_time_blocks,
    to_utc_windows,
)
```

(Remove the now-unused `SchedulePhase`, `PhaseResult`, `ResolvedTimeBlockRead` and `ResolvedBlock` imports.)

Replace `_check_no_overlap_with_prior_generations` with:

```python
def _check_no_overlap_with_prior_generations(
    db: Session,
    session_id: int,
    division_id: int | None,
    skip_round_types: set[str],
    new_windows: list[tuple[str, PlayingWindow, dt.datetime, dt.datetime]],
    new_timezone_name: str,
) -> None:
    """A safety net: raises ValueError if any new round's matches overlap the
    matches of another live generation in this (session, division). Rounds
    being rebuilt (skip_round_types) are about to be deleted, so they don't
    count. Under normal use this can't fire, because a plan starts after the
    division's kept matches; it guards against rows saved before occupied
    windows existed, which fall back to their requested window (open-ended
    meaning indefinitely). Both sides are compared as real UTC instants."""
    query = select(ScheduleGeneration).where(ScheduleGeneration.session_id == session_id)
    if division_id is None:
        query = query.where(ScheduleGeneration.division_id.is_(None))
    else:
        query = query.where(ScheduleGeneration.division_id == division_id)

    for prior in db.execute(query).scalars().all():
        if prior.round_type in skip_round_types or prior.time_blocks_json is None:
            continue
        for prior_block in deserialize_time_blocks(prior.time_blocks_json):
            prior_timezone = prior_block["timezone"]
            prior_start, prior_end = block_utc_bounds(prior_block, prior_timezone)
            if "occupied" in prior_block:
                if prior_block["occupied"] is None:
                    continue
                prior_start, prior_end = prior_block["occupied"]
            for round_type, window, new_start, new_end in new_windows:
                if new_end <= prior_start or (prior_end is not None and prior_end <= new_start):
                    continue
                prior_from = _local_clock(prior_start, prior_timezone, prior_block["date"])
                prior_range = (
                    f"from {prior_from} to "
                    f"{_local_clock(prior_end, prior_timezone, prior_block['date'])}"
                    if prior_end is not None
                    else f"from {prior_from} with no end time"
                )
                raise ValueError(
                    f"The new {_round_label(round_type)} matches on {window.date.isoformat()} "
                    f"would run from {_local_clock(new_start, new_timezone_name, window.date)} to "
                    f"{_local_clock(new_end, new_timezone_name, window.date)}, overlapping the "
                    f"{prior.round_type} round's matches on {prior_block['date'].isoformat()}, "
                    f"which run {prior_range} ({prior_timezone}). Clear that round or change "
                    "the playing times."
                )
```

Add these helpers above `generate_schedule`:

```python
def _round_label(round_type: str) -> str:
    return round_type.replace("_", " ").capitalize()


@dataclass
class _DivisionRound:
    round_type: str
    matches: list[Match]
    first_start: dt.datetime | None
    scored_match_ids: set[int]


def _division_rounds(db: Session, session_id: int, division_id: int | None) -> list[_DivisionRound]:
    """The scope's schedule-generated rounds (finals games excluded) in
    chronological order of their first match."""
    query = select(Match).where(Match.session_id == session_id, Match.finals_bracket_id.is_(None))
    if division_id is None:
        query = query.where(Match.division_id.is_(None))
    else:
        query = query.where(Match.division_id == division_id)
    matches = db.execute(query).scalars().all()
    match_ids = [match.id for match in matches]
    scored = (
        set(
            db.execute(
                select(Alliance.match_id)
                .join(ScoreRecord, ScoreRecord.alliance_id == Alliance.id)
                .where(Alliance.match_id.in_(match_ids))
            ).scalars().all()
        )
        if match_ids
        else set()
    )
    by_type: dict[str, list[Match]] = {}
    for match in matches:
        by_type.setdefault(match.round_type, []).append(match)
    rounds = []
    for round_type, round_matches in by_type.items():
        times = [m.scheduled_time for m in round_matches if m.scheduled_time is not None]
        rounds.append(
            _DivisionRound(
                round_type=round_type,
                matches=round_matches,
                first_start=min(times) if times else None,
                scored_match_ids={m.id for m in round_matches if m.id in scored},
            )
        )
    latest = dt.datetime.max.replace(tzinfo=dt.UTC)
    rounds.sort(key=lambda r: (r.first_start or latest, r.round_type))
    return rounds


def _rounds_to_replace(existing: list[_DivisionRound], listed: list[str]) -> list[_DivisionRound]:
    """The existing rounds a request rebuilds: from the earliest listed one
    to the end. Every round after it must be listed too (a rebuild moves
    them), and none of them may have scores."""
    first = next((i for i, r in enumerate(existing) if r.round_type in listed), None)
    if first is None:
        return []
    tail = existing[first:]
    for later in tail:
        if later.round_type not in listed:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Rebuilding {_round_label(tail[0].round_type)} also moves the rounds "
                    f"after it; include {_round_label(later.round_type)} too"
                ),
            )
    for round_ in tail:
        if round_.scored_match_ids:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{_round_label(round_.round_type)} has scored matches, so it can't be "
                    "rebuilt. Clear it first."
                ),
            )
    return tail


def _delete_round(db: Session, session_id: int, division_id: int | None, round_type: str) -> int:
    """Deletes one round's schedule-generated matches (with their alliances
    and score records) and its ScheduleGeneration rows. Doesn't commit."""
    match_query = select(Match).where(
        Match.session_id == session_id,
        Match.round_type == round_type,
        Match.finals_bracket_id.is_(None),
    )
    generation_query = select(ScheduleGeneration).where(
        ScheduleGeneration.session_id == session_id,
        ScheduleGeneration.round_type == round_type,
    )
    if division_id is None:
        match_query = match_query.where(Match.division_id.is_(None))
        generation_query = generation_query.where(ScheduleGeneration.division_id.is_(None))
    else:
        match_query = match_query.where(Match.division_id == division_id)
        generation_query = generation_query.where(ScheduleGeneration.division_id == division_id)
    matches = db.execute(match_query).scalars().all()
    for match in matches:
        for alliance in db.execute(select(Alliance).where(Alliance.match_id == match.id)).scalars().all():
            for record in db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
            ).scalars().all():
                db.delete(record)
            for alliance_team in db.execute(
                select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
            ).scalars().all():
                db.delete(alliance_team)
            db.flush()
            db.delete(alliance)
        db.delete(match)
    for generation in db.execute(generation_query).scalars().all():
        db.delete(generation)
    db.flush()
    return len(matches)
```

In `clear_schedule`, replace the block from `# Then delete matches and their cascading objects` through the generation-deletion loop with:

```python
    matches_deleted = _delete_round(db, session_id, division_id, round_type)
```

and its final `return {"matches_deleted": len(matches)}` with `return {"matches_deleted": matches_deleted}`.

Replace the whole `generate_schedule` function with:

```python
@router.post("", response_model=ScheduleGenerateResponse, status_code=201)
def generate_schedule(
    payload: ScheduleGenerateRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> ScheduleGenerateResponse:
    """Plans (dry_run) or builds a division's rounds, flowing their matches
    through the session's playing windows. A listed round that already
    exists is rebuilt, together with every round after it, in one
    transaction."""
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

    session_obj = db.get(TournamentSession, payload.session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")

    scheduler_plugin = request.app.state.scheduler_plugins.get(payload.scheduler_plugin_name)
    if scheduler_plugin is None:
        raise HTTPException(
            status_code=404,
            detail=f"Scheduler plugin {payload.scheduler_plugin_name!r} is not installed",
        )

    match_format = game_plugin.module.match_format()
    match_seconds = match_format["autonomous_seconds"] + match_format["driver_seconds"]
    listed = [r.round_type for r in payload.rounds]
    if len(set(listed)) != len(listed):
        raise HTTPException(status_code=422, detail="rounds must not repeat a round_type")
    for round_in in payload.rounds:
        if round_in.round_type == "elimination":
            raise HTTPException(
                status_code=422,
                detail="Elimination matches are created by the finals bracket, not the schedule",
            )
        if round_in.round_type not in match_format["round_types"]:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{round_in.round_type!r} is not a valid round_type for this "
                    "event's game plugin"
                ),
            )
        if round_in.cycle_time_seconds < match_seconds:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{_round_label(round_in.round_type)}'s cycle time must be at least "
                    f"the match length ({match_seconds}s)"
                ),
            )

    if session_obj.timezone is None:
        raise HTTPException(
            status_code=422, detail="Set the session's timezone before scheduling"
        )
    timezone_name = session_obj.timezone
    window_rows = load_windows(db, payload.session_id)
    if not window_rows:
        raise HTTPException(
            status_code=422,
            detail="This session has no playing times; add them before scheduling",
        )
    windows = to_utc_windows(window_rows, timezone_name)

    existing = _division_rounds(db, payload.session_id, payload.division_id)
    replaced = _rounds_to_replace(existing, listed)
    kept_starts = [
        match.scheduled_time
        for round_ in existing
        if round_.round_type not in listed
        for match in round_.matches
        if match.scheduled_time is not None
    ]
    earliest = (
        ceil_minute(max(kept_starts) + dt.timedelta(seconds=match_seconds))
        if kept_starts
        else windows[0].start
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
        field_set_query = field_set_query.where(FieldSet.division_id == payload.division_id)
    field_sets = db.execute(field_set_query).scalars().all()
    if not field_sets:
        if payload.division_id is None:
            raise HTTPException(
                status_code=422, detail="Session has no unassigned FieldSets configured"
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

    teams_per_alliance = match_format["teams_per_alliance"]
    alliance_count = match_format["alliance_count"]
    pairing_history = build_pairing_history(
        db, event.id, exclude_match_ids={m.id for r in replaced for m in r.matches}
    )

    generated_rounds: list[list[dict]] = []
    for round_in in payload.rounds:
        try:
            generated = scheduler_plugin.module.generate_schedule(
                teams=[{"team_id": t.id, "organization": t.organization} for t in teams],
                target_matches_per_team=round_in.target_matches_per_team,
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
                    f"round_type {round_in.round_type!r}: {exc}"
                ),
            )
        _validate_generated_schedule(
            generated, {fs.id for fs in field_sets}, alliance_count, round_in.round_type
        )
        _fold_generated_into_pairing_history(pairing_history, generated)
        generated_rounds.append(generated)

    # Each round's time slots in order; matches sharing a slot run together.
    slot_ranks = [
        {slot: rank for rank, slot in enumerate(sorted({e["time_slot"] for e in generated}))}
        for generated in generated_rounds
    ]
    plan = [
        (len(ranks), round_in.cycle_time_seconds)
        for ranks, round_in in zip(slot_ranks, payload.rounds)
    ]
    placement = place_plan(windows, earliest, plan, match_seconds)
    match_length = dt.timedelta(seconds=match_seconds)

    round_results = []
    unplaced_matches = 0
    for round_in, generated, ranks, starts in zip(
        payload.rounds, generated_rounds, slot_ranks, placement.round_starts
    ):
        unplaced_matches += sum(1 for e in generated if ranks[e["time_slot"]] >= len(starts))
        round_results.append(
            RoundResult(
                round_type=round_in.round_type,
                schedule_generation_id=None,
                match_count=len(generated),
                slot_count=len(ranks),
                first_start=starts[0] if starts else None,
                last_end=starts[-1] + match_length if len(starts) == len(ranks) else None,
            )
        )

    if not placement.fits:
        suggestions = overflow_suggestions(windows, earliest, plan, match_seconds, timezone_name)
        overflow = ScheduleOverflow(
            unplaced_slot_count=placement.unplaced_slot_count,
            unplaced_match_count=unplaced_matches,
            over_by_seconds=suggestions.over_by_seconds,
            suggested_cycle_time_seconds=suggestions.suggested_cycle_time_seconds,
            suggested_last_window_end=suggestions.suggested_last_window_end,
        )
        if not payload.dry_run:
            first_short = next(r for r in round_results if r.last_end is None)
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{unplaced_matches} matches don't fit in the session's playing times, "
                    f"starting with {_round_label(first_short.round_type)} (over by "
                    f"{math.ceil(suggestions.over_by_seconds / 60)} min). Shorten the cycle "
                    "time or add playing time."
                ),
            )
        return ScheduleGenerateResponse(fits=False, rounds=round_results, overflow=overflow)

    occupied_per_round = [
        occupied_by_window(windows, starts, match_seconds) for starts in placement.round_starts
    ]
    try:
        _check_no_overlap_with_prior_generations(
            db,
            payload.session_id,
            payload.division_id,
            set(listed),
            [
                (round_in.round_type, window, start, end)
                for round_in, occupied in zip(payload.rounds, occupied_per_round)
                for window, start, end in occupied
            ],
            timezone_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if payload.dry_run:
        return ScheduleGenerateResponse(fits=True, rounds=round_results, overflow=None)

    # Everything below runs in one transaction: a failure before commit
    # leaves the previous schedule exactly as it was.
    for round_ in replaced:
        _delete_round(db, payload.session_id, payload.division_id, round_.round_type)

    fields_by_set: dict[int, list[int]] = {}
    for f in fields:
        fields_by_set.setdefault(f.field_set_id, []).append(f.id)
    for field_ids in fields_by_set.values():
        field_ids.sort()

    created_matches = []
    for index, (round_in, generated, ranks, starts, occupied) in enumerate(
        zip(payload.rounds, generated_rounds, slot_ranks, placement.round_starts, occupied_per_round)
    ):
        generation = ScheduleGeneration(
            session_id=payload.session_id,
            division_id=payload.division_id,
            round_type=round_in.round_type,
            scheduler_plugin_name=scheduler_plugin.name,
            scheduler_plugin_version=scheduler_plugin.version,
            target_matches_per_team=round_in.target_matches_per_team,
            cycle_time_seconds=round_in.cycle_time_seconds,
            generated_at=utc_now(),
            time_blocks_json=serialize_time_blocks(
                [
                    {
                        "date": window.date,
                        "start_time": window.start_time,
                        "end_time": window.end_time,
                        "cycle_time": round_in.cycle_time_seconds,
                    }
                    for window, _, _ in occupied
                ],
                timezone_name,
                [(start, end) for _, start, end in occupied],
            ),
        )
        db.add(generation)
        db.flush()

        next_field_index: dict[int, int] = {fs_id: 0 for fs_id in fields_by_set}
        for match_number, entry in enumerate(generated, start=1):
            field_ids_for_set = fields_by_set[entry["field_set_id"]]
            field_id = field_ids_for_set[
                next_field_index[entry["field_set_id"]] % len(field_ids_for_set)
            ]
            next_field_index[entry["field_set_id"]] += 1
            match = Match(
                session_id=payload.session_id,
                division_id=payload.division_id,
                round_type=round_in.round_type,
                match_number=match_number,
                field_id=field_id,
                time_slot=entry["time_slot"],
                schedule_generation_id=generation.id,
                scheduled_time=starts[ranks[entry["time_slot"]]],
            )
            db.add(match)
            db.flush()
            for alliance_entry in entry["alliances"]:
                alliance = Alliance(match_id=match.id, station=alliance_entry["station"])
                db.add(alliance)
                db.flush()
                for team_id in alliance_entry["team_ids"]:
                    db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))
            created_matches.append(match)
        round_results[index].schedule_generation_id = generation.id

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

    return ScheduleGenerateResponse(fits=True, rounds=round_results, overflow=None)
```

Make sure nothing from the old function body survives: the `SchedulePhase` usage, the `phases` handling, the 409 "Matches already exist" check, the `cycle_time_warning` code and the `resolved_time_blocks_read` code — all gone with the old function body. `ZoneInfo` stays (used by `_local_clock`).

- [ ] **Step 9: Run the server suite**

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: PASS (the whole suite: the rewritten schedule tests, the timing tests, drift/migration tests, and every other file). Fix any remaining caller of a removed name that `grep -rn "resolve_block_cycle_times\|assign_scheduled_times\|blocks_occupied_windows\|implicit_default_time_block\|phase_results\|resolved_time_blocks" server/src server/tests` finds.

- [ ] **Step 10: Commit**

```bash
git add server
git commit -m "Schedule rounds through session playing windows

POST /api/schedule now takes rounds (round type, matches per team,
cycle time) and flows their matches through the session's playing
windows. A listed round that already exists is rebuilt together with
every round after it in one transaction; rounds with scores can't be.
A dry run reports whether the plan fits and, when it doesn't, how far
over it runs, a cycle time that would fit, and a window end that would.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `GET /api/schedule/rounds`

**Files:**
- Modify: `server/src/tournament_server/routers/schedule.py` (add the endpoint)
- Test: `server/tests/test_schedule.py` (append)

**Interfaces:**
- Consumes: `_division_rounds`, `_round_label` (Task 4); `ScheduleRoundsRead`, `ScheduledRoundRead` (Task 4 schemas); `load_windows`, `to_utc_windows`.
- Produces: `GET /api/schedule/rounds?session_id=&division_id=` → `ScheduleRoundsRead`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_schedule.py`:

```python
def _rounds(client, session_id, division_id=None):
    params = {"session_id": session_id}
    if division_id is not None:
        params["division_id"] = division_id
    response = client.get("/api/schedule/rounds", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_rounds_endpoint_lists_rounds_in_order_with_their_settings(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "12:00"}])
    assert schedule(client, session_id, [("practice", 1, 150), ("qualification", 2, 240)]).status_code == 201
    body = _rounds(client, session_id)
    assert body["session_last_cycle_time_seconds"] == 240
    practice, qualification = body["rounds"]
    assert practice == {
        "round_type": "practice",
        "target_matches_per_team": 1,
        "cycle_time_seconds": 150,
        "match_count": 2,
        "scored_count": 0,
        "first_start": "2026-11-07T17:00:00Z",
        "last_end": "2026-11-07T17:04:30Z",
        "locked": False,
        "outside_playing_windows": False,
    }
    assert qualification["round_type"] == "qualification"
    assert qualification["cycle_time_seconds"] == 240


def test_a_scored_round_and_every_round_before_it_are_locked(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    _score_one_match(client, session_id, "qualification")
    practice, qualification = _rounds(client, session_id)["rounds"]
    assert qualification["scored_count"] == 1 and qualification["locked"] is True
    assert practice["scored_count"] == 0 and practice["locked"] is True


def test_rounds_after_a_scored_round_stay_unlocked(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1), ("qualification", 1)]).status_code == 201
    _score_one_match(client, session_id, "practice")
    practice, qualification = _rounds(client, session_id)["rounds"]
    assert practice["locked"] is True
    assert qualification["locked"] is False


def test_a_round_outside_new_playing_times_is_flagged(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "09:00", "end_time": "12:00"}])
    assert schedule(client, session_id, [("practice", 1)]).status_code == 201
    set_playing_windows(client, session_id, [{"date": PLAY_DATE, "start_time": "13:00", "end_time": "17:00"}])
    assert _rounds(client, session_id)["rounds"][0]["outside_playing_windows"] is True


def test_rounds_endpoint_uses_the_no_division_scope_in_a_single_division_event(client):
    session_id, _ = _setup_ready_session(client, num_fields=1)
    assert schedule(client, session_id, [("practice", 1)]).status_code == 201
    assert [r["round_type"] for r in _rounds(client, session_id)["rounds"]] == ["practice"]


def test_rounds_endpoint_with_nothing_scheduled(client):
    session_id, _ = _setup_ready_session(client)
    assert _rounds(client, session_id) == {"rounds": [], "session_last_cycle_time_seconds": None}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_schedule.py -q -k rounds`
Expected: FAIL — `GET /api/schedule/rounds` hits the `POST`-only route (405).

- [ ] **Step 3: Implement**

Add to `server/src/tournament_server/routers/schedule.py` (import `ScheduleRoundsRead`, `ScheduledRoundRead` from `schemas.schedule`):

```python
@router.get("/rounds", response_model=ScheduleRoundsRead)
def read_schedule_rounds(
    request: Request,
    session_id: int = Query(...),
    division_id: int | None = Query(None),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> ScheduleRoundsRead:
    """The scope's rounds in chronological order, with what the Schedule
    tab needs to show and edit them. A round is locked when it, or any
    round after it, has a scored match: rebuilding it would move scored
    matches."""
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")

    match_seconds = 0
    event = get_the_event(db)
    if event is not None and event.game_plugin_name is not None:
        game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
        if game_plugin is not None:
            match_format = game_plugin.module.match_format()
            match_seconds = match_format["autonomous_seconds"] + match_format["driver_seconds"]
    match_length = dt.timedelta(seconds=match_seconds)

    windows = (
        to_utc_windows(load_windows(db, session_id), session_obj.timezone)
        if session_obj.timezone is not None
        else []
    )

    def inside_windows(start: dt.datetime) -> bool:
        return any(w.start <= start and start + match_length <= w.end for w in windows)

    generation_query = select(ScheduleGeneration).where(ScheduleGeneration.session_id == session_id)
    if division_id is None:
        generation_query = generation_query.where(ScheduleGeneration.division_id.is_(None))
    else:
        generation_query = generation_query.where(ScheduleGeneration.division_id == division_id)
    latest_generation: dict[str, ScheduleGeneration] = {}
    for generation in db.execute(
        generation_query.order_by(ScheduleGeneration.generated_at, ScheduleGeneration.id)
    ).scalars().all():
        latest_generation[generation.round_type] = generation

    rounds = []
    for round_ in _division_rounds(db, session_id, division_id):
        generation = latest_generation.get(round_.round_type)
        times = [m.scheduled_time for m in round_.matches if m.scheduled_time is not None]
        rounds.append(
            ScheduledRoundRead(
                round_type=round_.round_type,
                target_matches_per_team=generation.target_matches_per_team if generation else None,
                cycle_time_seconds=generation.cycle_time_seconds if generation else None,
                match_count=len(round_.matches),
                scored_count=len(round_.scored_match_ids),
                first_start=min(times) if times else None,
                last_end=max(times) + match_length if times else None,
                locked=False,
                outside_playing_windows=bool(windows) and any(not inside_windows(t) for t in times),
            )
        )
    locked = False
    for round_read in reversed(rounds):
        locked = locked or round_read.scored_count > 0
        round_read.locked = locked

    last_cycle = db.execute(
        select(ScheduleGeneration.cycle_time_seconds)
        .where(
            ScheduleGeneration.session_id == session_id,
            ScheduleGeneration.cycle_time_seconds.is_not(None),
        )
        .order_by(ScheduleGeneration.generated_at.desc(), ScheduleGeneration.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    return ScheduleRoundsRead(rounds=rounds, session_last_cycle_time_seconds=last_cycle)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_schedule.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/routers/schedule.py server/tests/test_schedule.py
git commit -m "Add GET /api/schedule/rounds for the planner

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Document the server changes

**Files:**
- Modify: `server/CLAUDE.md`

- [ ] **Step 1: Rewrite the scheduling sections**

In `server/CLAUDE.md`:
- Replace the "Time-based scheduling" content (the time blocks, fit/fixed cycle, open-ended block, `resolve_block_cycle_times`, `assign_scheduled_times`, implicit-default UTC block and per-phase `occupied` storage paragraphs) with a section titled **"Playing windows and round placement"** that states:
  - Sessions own playing windows (`session_playing_windows`, `GET`/`PUT /api/sessions/{id}/playing-windows`, admin only, replace-all, validated by `services/playing_windows.validate_windows`; no overlap, end after start, at most 50, session must have a timezone; changing them never moves matches).
  - `POST /api/schedule` takes `rounds`; matches flow through the windows (`schedule_timing.place_slots`/`place_plan`): a slot starts only if it finishes by its window's end, otherwise it moves to the next window's start; each round starts on the first whole minute after the previous round's last match ends; a plan starts after the division's kept matches (or at the first window).
  - Rebuild rules: listing an existing round rebuilds it and every later round (all must be listed; none may have score records), atomically; pairing history excludes the replaced matches.
  - Dry runs return `fits`, per-round times, and `overflow` (`over_by_seconds`, `suggested_cycle_time_seconds` for the last listed round via binary search — placement is monotonic in cycle time — and `suggested_last_window_end`, null past midnight). A real request that doesn't fit is a 422 that creates nothing.
  - Each `ScheduleGeneration` stores `cycle_time_seconds` and, in `time_blocks_json`, one entry per playing window its matches use with `occupied_from`/`occupied_until`; the overlap check is now a safety net for rows saved before occupied windows existed.
  - `GET /api/schedule/rounds` returns the planner's view (settings, counts, times, `locked`, `outside_playing_windows`, `session_last_cycle_time_seconds`).
- In the game-plugin section, document the optional `default_cycle_time_seconds` in `match_format()` (integer ≥ match length; checked by conformance; the sample game declares 300).
- Delete the paragraph that begins "Because each phase claims only its own matches' time" and any remaining reference to `phases`, `time_blocks`, `warn_below_multiplier` or `cycle_time_warning`.

- [ ] **Step 2: Check for stale references**

Run: `grep -n "time_blocks\b\|phases\|warn_below_multiplier\|resolve_block_cycle_times\|implicit" server/CLAUDE.md`
Expected: only mentions that describe `time_blocks_json` storage.

- [ ] **Step 3: Commit**

```bash
git add server/CLAUDE.md
git commit -m "Document playing windows and round placement

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend types and pure planner modules

**Files:**
- Modify: `frontend/apps/admin/src/types.ts`
- Create: `frontend/apps/admin/src/schedule/planDraft.ts`, `src/schedule/playingWindows.ts`, `src/schedule/timeline.ts`, `src/schedule/formatDuration.ts`
- Test: `frontend/apps/admin/tests/unit/planDraft.test.ts`, `tests/unit/playingWindows.test.ts`, `tests/unit/timeline.test.ts`

**Interfaces:**
- Produces (types): `MatchFormat.default_cycle_time_seconds: number | null`; `PlayingWindowRead`; `ScheduledRound`; `ScheduleRounds`; `PlanRoundResult`; `PlanOverflow`; `PlanResponse`.
- Produces (`planDraft.ts`): `RoundRow`, `PlanRequest`, `plannerRoundTypes`, `fallbackCycleSeconds`, `defaultCycleSeconds`, `defaultMatchesPerTeam`, `newRow`, `initialRows`, `mergeServerRounds`, `isRowChanged`, `needsRebuild`, `rowsToSend`, `planAction`, `rowsValid`, `buildPlanRequest`, `formatCycle`, `splitCycle`.
- Produces (`playingWindows.ts`): `WindowDraft`, `WindowDraftError`, `draftsFromWindows`, `validateWindowDrafts`, `windowsPayload`, `nextWindowDraft`, `weekdayLabel`, `summarizeWindows`, `withLastWindowEnd`, `todayInZone`.
- Produces (`timeline.ts`): `TimelineSpan`, `TimelineSegment`, `segmentsInWindow`, `overflowSegment`.
- Produces (`formatDuration.ts`): `formatDuration(t, seconds)`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/admin/tests/unit/planDraft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildPlanRequest,
  defaultCycleSeconds,
  fallbackCycleSeconds,
  formatCycle,
  initialRows,
  isRowChanged,
  mergeServerRounds,
  newRow,
  planAction,
  plannerRoundTypes,
  rowsToSend,
  rowsValid,
  splitCycle,
  type RoundRow,
} from "../../src/schedule/planDraft";
import type { ScheduledRound } from "../../src/types";

function scheduled(overrides: Partial<ScheduledRound>): ScheduledRound {
  return {
    round_type: "practice",
    target_matches_per_team: 1,
    cycle_time_seconds: 420,
    match_count: 6,
    scored_count: 0,
    first_start: "2026-11-07T17:00:00Z",
    last_end: "2026-11-07T17:37:00Z",
    locked: false,
    outside_playing_windows: false,
    ...overrides,
  };
}

const PRACTICE = scheduled({});
const QUALIFICATION = scheduled({
  round_type: "qualification",
  target_matches_per_team: 6,
  match_count: 36,
  first_start: "2026-11-07T17:42:00Z",
});
const cycleFor = () => 420;

describe("defaults", () => {
  it("leaves elimination out of the planner's round types", () => {
    expect(plannerRoundTypes(["practice", "qualification", "elimination"])).toEqual(["practice", "qualification"]);
  });

  it("falls back to the match length plus two minutes, rounded up to a whole minute", () => {
    expect(fallbackCycleSeconds(120)).toBe(240);
    expect(fallbackCycleSeconds(150)).toBe(300);
  });

  it("prefers the previous row, then the session's last cycle, then the plugin default", () => {
    const previous = newRow("practice", 1, 400, "new-1");
    expect(defaultCycleSeconds({ previousRow: previous, sessionLast: 450, pluginDefault: 300, matchSeconds: 120 })).toBe(400);
    expect(defaultCycleSeconds({ sessionLast: 450, pluginDefault: 300, matchSeconds: 120 })).toBe(450);
    expect(defaultCycleSeconds({ sessionLast: null, pluginDefault: 300, matchSeconds: 120 })).toBe(300);
    expect(defaultCycleSeconds({ sessionLast: null, pluginDefault: null, matchSeconds: 120 })).toBe(240);
  });
});

describe("initialRows", () => {
  it("pre-fills Practice x1 and Qualification x6 when nothing is scheduled", () => {
    const rows = initialRows([], ["practice", "qualification"], cycleFor);
    expect(rows.map((r) => [r.roundType, r.matchesPerTeam, r.cycleSeconds, r.scheduled])).toEqual([
      ["practice", 1, 420, null],
      ["qualification", 6, 420, null],
    ]);
  });

  it("shows only the scheduled rounds once anything is scheduled", () => {
    const rows = initialRows([PRACTICE], ["practice", "qualification"], cycleFor);
    expect(rows.map((r) => r.key)).toEqual(["practice"]);
    expect(isRowChanged(rows[0])).toBe(false);
  });
});

describe("what Apply sends", () => {
  const base = initialRows([PRACTICE, QUALIFICATION], ["practice", "qualification"], cycleFor);

  it("sends nothing when nothing changed", () => {
    expect(rowsToSend(base)).toEqual([]);
    expect(planAction(base)).toBe("none");
  });

  it("sends a changed row and every row after it", () => {
    const rows = base.map((r) => (r.key === "practice" ? { ...r, matchesPerTeam: 2 } : r));
    expect(rowsToSend(rows).map((r) => r.key)).toEqual(["practice", "qualification"]);
    expect(planAction(rows)).toBe("apply");
  });

  it("sends only the last row when only it changed", () => {
    const rows = base.map((r) => (r.key === "qualification" ? { ...r, cycleSeconds: 410 } : r));
    expect(rowsToSend(rows).map((r) => r.key)).toEqual(["qualification"]);
  });

  it("generates when only new rows are pending", () => {
    const rows: RoundRow[] = [base[0], newRow("qualification", 6, 420, "new-1")];
    expect(rowsToSend(rows).map((r) => r.key)).toEqual(["new-1"]);
    expect(planAction(rows)).toBe("generate");
  });

  it("rebuilds an unlocked round that now falls outside the playing times", () => {
    const rows = initialRows([scheduled({ outside_playing_windows: true })], [], cycleFor);
    expect(rowsToSend(rows).map((r) => r.key)).toEqual(["practice"]);
  });

  it("builds the request body, with a division only when there is one", () => {
    const rows = base.map((r) => (r.key === "qualification" ? { ...r, matchesPerTeam: 8 } : r));
    expect(
      buildPlanRequest(rowsToSend(rows), { sessionId: 1, divisionId: null, schedulerPluginName: "balanced", dryRun: true })
    ).toEqual({
      session_id: 1,
      scheduler_plugin_name: "balanced",
      rounds: [{ round_type: "qualification", target_matches_per_team: 8, cycle_time_seconds: 420 }],
      dry_run: true,
    });
    expect(
      buildPlanRequest(rowsToSend(rows), { sessionId: 1, divisionId: 2, schedulerPluginName: "balanced", dryRun: false })
        .division_id
    ).toBe(2);
  });
});

describe("validation and cycle formatting", () => {
  it("needs at least one match per team and a cycle no shorter than the match", () => {
    expect(rowsValid([newRow("practice", 1, 120, "a")], 120)).toBe(true);
    expect(rowsValid([newRow("practice", 0, 300, "a")], 120)).toBe(false);
    expect(rowsValid([newRow("practice", 1, 119, "a")], 120)).toBe(false);
    expect(rowsValid([newRow("practice", 1, Number.NaN, "a")], 120)).toBe(false);
  });

  it("formats and splits cycle times", () => {
    expect(formatCycle(410)).toBe("6:50");
    expect(formatCycle(420)).toBe("7:00");
    expect(splitCycle(410)).toEqual({ minutes: 6, seconds: 50 });
  });
});

describe("mergeServerRounds", () => {
  it("keeps this admin's unlocked edits when the server's rounds refresh", () => {
    const rows = initialRows([PRACTICE, QUALIFICATION], [], cycleFor).map((r) =>
      r.key === "qualification" ? { ...r, matchesPerTeam: 8 } : r
    );
    const { rows: merged, dropped } = mergeServerRounds(rows, [PRACTICE, { ...QUALIFICATION, match_count: 40 }], 420);
    expect(merged.find((r) => r.key === "qualification")?.matchesPerTeam).toBe(8);
    expect(merged.find((r) => r.key === "qualification")?.scheduled?.match_count).toBe(40);
    expect(dropped).toEqual([]);
  });

  it("drops an edit to a round that became locked, and says so", () => {
    const rows = initialRows([PRACTICE], [], cycleFor).map((r) => ({ ...r, matchesPerTeam: 2 }));
    const { rows: merged, dropped } = mergeServerRounds(rows, [{ ...PRACTICE, locked: true, scored_count: 1 }], 420);
    expect(merged[0].matchesPerTeam).toBe(1);
    expect(dropped).toEqual(["practice"]);
  });

  it("replaces a new row once its round is scheduled, and keeps other new rows", () => {
    const rows: RoundRow[] = [newRow("practice", 1, 420, "new-1"), newRow("qualification", 6, 420, "new-2")];
    const { rows: merged } = mergeServerRounds(rows, [PRACTICE], 420);
    expect(merged.map((r) => r.key)).toEqual(["practice", "new-2"]);
    expect(isRowChanged(merged[0])).toBe(false);
  });

  it("clears the changed flag once an applied change comes back from the server", () => {
    const rows = initialRows([PRACTICE], [], cycleFor).map((r) => ({ ...r, matchesPerTeam: 2 }));
    const { rows: merged } = mergeServerRounds(rows, [{ ...PRACTICE, target_matches_per_team: 2 }], 420);
    expect(isRowChanged(merged[0])).toBe(false);
  });
});
```

Create `frontend/apps/admin/tests/unit/playingWindows.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  draftsFromWindows,
  nextWindowDraft,
  summarizeWindows,
  validateWindowDrafts,
  windowsPayload,
  withLastWindowEnd,
} from "../../src/schedule/playingWindows";
import type { PlayingWindowRead } from "../../src/types";

const WINDOWS: PlayingWindowRead[] = [
  { date: "2026-11-07", start_time: "09:00", end_time: "12:00", start_utc: null, end_utc: null },
  { date: "2026-11-07", start_time: "13:00", end_time: "17:00", start_utc: null, end_utc: null },
  { date: "2026-11-08", start_time: "09:00", end_time: "15:00", start_utc: null, end_utc: null },
];

describe("playing window drafts", () => {
  it("summarizes windows by day", () => {
    expect(summarizeWindows(WINDOWS, "en")).toBe("Sat 09:00–12:00, 13:00–17:00 · Sun 09:00–15:00");
  });

  it("validates drafts", () => {
    const drafts = draftsFromWindows(WINDOWS);
    expect(validateWindowDrafts(drafts)).toBeNull();
    expect(validateWindowDrafts([{ date: "2026-11-07", startTime: "09:00", endTime: "" }])).toBe("incomplete");
    expect(validateWindowDrafts([{ date: "2026-11-07", startTime: "12:00", endTime: "09:00" }])).toBe("endBeforeStart");
    expect(
      validateWindowDrafts([
        { date: "2026-11-07", startTime: "09:00", endTime: "12:00" },
        { date: "2026-11-07", startTime: "11:00", endTime: "13:00" },
      ])
    ).toBe("overlap");
    expect(
      validateWindowDrafts([
        { date: "2026-11-07", startTime: "09:00", endTime: "12:00" },
        { date: "2026-11-07", startTime: "12:00", endTime: "13:00" },
      ])
    ).toBeNull();
  });

  it("sends drafts sorted", () => {
    const drafts = draftsFromWindows(WINDOWS).reverse();
    expect(windowsPayload(drafts).windows.map((w) => `${w.date} ${w.start_time}`)).toEqual([
      "2026-11-07 09:00",
      "2026-11-07 13:00",
      "2026-11-08 09:00",
    ]);
  });

  it("starts a new window where the last one ends, or at 09:00-12:00 on the session date", () => {
    expect(nextWindowDraft(draftsFromWindows(WINDOWS), "2026-11-07", "2026-10-03")).toEqual({
      date: "2026-11-08",
      startTime: "15:00",
      endTime: "",
    });
    expect(nextWindowDraft([], null, "2026-10-03")).toEqual({ date: "2026-10-03", startTime: "09:00", endTime: "12:00" });
  });

  it("extends only the last window", () => {
    expect(withLastWindowEnd(WINDOWS, "15:16").windows.map((w) => w.end_time)).toEqual(["12:00", "17:00", "15:16"]);
  });
});
```

Create `frontend/apps/admin/tests/unit/timeline.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { overflowSegment, segmentsInWindow } from "../../src/schedule/timeline";

const HOUR = 3_600_000;

describe("timeline geometry", () => {
  it("clips each span to the window and positions it in percent", () => {
    const segments = segmentsInWindow(0, 4 * HOUR, [
      { kind: "scheduled", roundType: "practice", startMs: 0, endMs: HOUR },
      { kind: "draft", roundType: "qualification", startMs: 3 * HOUR, endMs: 6 * HOUR },
      { kind: "draft", roundType: "qualification", startMs: 5 * HOUR, endMs: 7 * HOUR },
    ]);
    expect(segments).toEqual([
      { kind: "scheduled", roundType: "practice", leftPct: 0, widthPct: 25 },
      { kind: "draft", roundType: "qualification", leftPct: 75, widthPct: 25 },
    ]);
  });

  it("treats an open-ended draft span as running to the window's end", () => {
    const [segment] = segmentsInWindow(0, 4 * HOUR, [
      { kind: "draft", roundType: "qualification", startMs: 2 * HOUR, endMs: Number.POSITIVE_INFINITY },
    ]);
    expect(segment).toMatchObject({ leftPct: 50, widthPct: 50 });
  });

  it("draws overflow at the right end, at least 4% and at most 30% wide", () => {
    expect(overflowSegment(0, 4 * HOUR, 60)).toMatchObject({ kind: "overflow", leftPct: 96, widthPct: 4 });
    expect(overflowSegment(0, 4 * HOUR, 7200)).toMatchObject({ leftPct: 70, widthPct: 30 });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/planDraft.test.ts tests/unit/playingWindows.test.ts tests/unit/timeline.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Add the types**

In `frontend/apps/admin/src/types.ts`, add `default_cycle_time_seconds: number | null;` to `MatchFormat`, and add (leave `ResolvedTimeBlock`, `PhaseResult` and `ScheduleGenerateResponse` until Task 10 deletes their last users):

```ts
export interface PlayingWindowRead {
  date: string;
  start_time: string;
  end_time: string;
  start_utc: string | null;
  end_utc: string | null;
}

export interface ScheduledRound {
  round_type: string;
  target_matches_per_team: number | null;
  cycle_time_seconds: number | null;
  match_count: number;
  scored_count: number;
  first_start: string | null;
  last_end: string | null;
  locked: boolean;
  outside_playing_windows: boolean;
}

export interface ScheduleRounds {
  rounds: ScheduledRound[];
  session_last_cycle_time_seconds: number | null;
}

export interface PlanRoundResult {
  round_type: string;
  schedule_generation_id: number | null;
  match_count: number;
  slot_count: number;
  first_start: string | null;
  /** Null when the round doesn't fully fit. */
  last_end: string | null;
}

export interface PlanOverflow {
  unplaced_slot_count: number;
  unplaced_match_count: number;
  over_by_seconds: number;
  suggested_cycle_time_seconds: number | null;
  suggested_last_window_end: string | null;
}

export interface PlanResponse {
  fits: boolean;
  rounds: PlanRoundResult[];
  overflow: PlanOverflow | null;
}
```

- [ ] **Step 4: Implement the modules**

Create `frontend/apps/admin/src/schedule/planDraft.ts`:

```ts
import type { ScheduledRound } from "../types";

/** One row of a division's plan: a scheduled round or one added in this draft. */
export interface RoundRow {
  /** The round type for a scheduled round; a `new-…` key for a row added in this draft. */
  key: string;
  roundType: string;
  matchesPerTeam: number;
  cycleSeconds: number;
  /** The server's round, or null for a new row. */
  scheduled: ScheduledRound | null;
  /** The values the row started from, to tell an edit from no change; null for a new row. */
  original: { matchesPerTeam: number; cycleSeconds: number } | null;
}

export interface PlanRequest {
  session_id: number;
  division_id?: number;
  scheduler_plugin_name: string;
  rounds: { round_type: string; target_matches_per_team: number; cycle_time_seconds: number }[];
  dry_run: boolean;
}

/** Elimination matches come from the finals bracket, never the planner. */
export function plannerRoundTypes(all: string[]): string[] {
  return all.filter((roundType) => roundType !== "elimination");
}

export function fallbackCycleSeconds(matchSeconds: number): number {
  return Math.ceil((matchSeconds + 120) / 60) * 60;
}

export function defaultCycleSeconds({
  previousRow,
  sessionLast,
  pluginDefault,
  matchSeconds,
}: {
  previousRow?: RoundRow;
  sessionLast: number | null;
  pluginDefault: number | null;
  matchSeconds: number;
}): number {
  return previousRow?.cycleSeconds ?? sessionLast ?? pluginDefault ?? fallbackCycleSeconds(matchSeconds);
}

export function defaultMatchesPerTeam(roundType: string): number {
  return roundType === "practice" ? 1 : 6;
}

export function newRow(roundType: string, matchesPerTeam: number, cycleSeconds: number, key: string): RoundRow {
  return { key, roundType, matchesPerTeam, cycleSeconds, scheduled: null, original: null };
}

function rowFromServer(round: ScheduledRound, fallbackCycle: number): RoundRow {
  const matchesPerTeam = round.target_matches_per_team ?? 1;
  const cycleSeconds = round.cycle_time_seconds ?? fallbackCycle;
  return {
    key: round.round_type,
    roundType: round.round_type,
    matchesPerTeam,
    cycleSeconds,
    scheduled: round,
    original: { matchesPerTeam, cycleSeconds },
  };
}

/**
 * A division's rows when it first loads: its scheduled rounds or, when
 * nothing is scheduled yet, a suggested new row per planner round type.
 */
export function initialRows(
  rounds: ScheduledRound[],
  available: string[],
  cycleFor: (previous?: RoundRow) => number
): RoundRow[] {
  if (rounds.length > 0) return rounds.map((round) => rowFromServer(round, cycleFor()));
  const rows: RoundRow[] = [];
  available.forEach((roundType, index) => {
    rows.push(newRow(roundType, defaultMatchesPerTeam(roundType), cycleFor(rows[rows.length - 1]), `new-${index}`));
  });
  return rows;
}

export function isRowChanged(row: RoundRow): boolean {
  return (
    row.original !== null &&
    (row.matchesPerTeam !== row.original.matchesPerTeam || row.cycleSeconds !== row.original.cycleSeconds)
  );
}

export function needsRebuild(row: RoundRow): boolean {
  return Boolean(row.scheduled?.outside_playing_windows && !row.scheduled.locked);
}

/** The first row that is new, changed or needs a rebuild, and every row after it. */
export function rowsToSend(rows: RoundRow[]): RoundRow[] {
  const first = rows.findIndex((row) => row.scheduled === null || isRowChanged(row) || needsRebuild(row));
  return first === -1 ? [] : rows.slice(first);
}

export function planAction(rows: RoundRow[]): "none" | "generate" | "apply" {
  const toSend = rowsToSend(rows);
  if (toSend.length === 0) return "none";
  return toSend.some((row) => row.scheduled !== null) ? "apply" : "generate";
}

export function rowsValid(rows: RoundRow[], matchSeconds: number): boolean {
  return rows.every(
    (row) =>
      Number.isInteger(row.matchesPerTeam) &&
      row.matchesPerTeam >= 1 &&
      Number.isInteger(row.cycleSeconds) &&
      row.cycleSeconds >= matchSeconds
  );
}

export function buildPlanRequest(
  rows: RoundRow[],
  {
    sessionId,
    divisionId,
    schedulerPluginName,
    dryRun,
  }: { sessionId: number; divisionId: number | null; schedulerPluginName: string; dryRun: boolean }
): PlanRequest {
  const request: PlanRequest = {
    session_id: sessionId,
    scheduler_plugin_name: schedulerPluginName,
    rounds: rows.map((row) => ({
      round_type: row.roundType,
      target_matches_per_team: row.matchesPerTeam,
      cycle_time_seconds: row.cycleSeconds,
    })),
    dry_run: dryRun,
  };
  if (divisionId !== null) request.division_id = divisionId;
  return request;
}

/**
 * Folds a refresh of the server's rounds into the draft: unlocked rows keep
 * this admin's edits, rows that became locked go back to the server's
 * values (their round types are returned in `dropped`), and new rows stay
 * unless their round is now scheduled.
 */
export function mergeServerRounds(
  rows: RoundRow[],
  rounds: ScheduledRound[],
  fallbackCycle: number
): { rows: RoundRow[]; dropped: string[] } {
  const dropped: string[] = [];
  const merged = rounds.map((round) => {
    const fresh = rowFromServer(round, fallbackCycle);
    const current = rows.find((row) => row.scheduled !== null && row.key === round.round_type);
    if (!current) return fresh;
    if (round.locked) {
      if (isRowChanged(current)) dropped.push(round.round_type);
      return fresh;
    }
    return { ...current, scheduled: round, original: fresh.original };
  });
  const scheduledTypes = new Set(rounds.map((round) => round.round_type));
  const pendingNew = rows.filter((row) => row.scheduled === null && !scheduledTypes.has(row.roundType));
  return { rows: [...merged, ...pendingNew], dropped };
}

export function splitCycle(seconds: number): { minutes: number; seconds: number } {
  return { minutes: Math.floor(seconds / 60), seconds: seconds % 60 };
}

export function formatCycle(seconds: number): string {
  const { minutes, seconds: rest } = splitCycle(Math.round(seconds));
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
```

Create `frontend/apps/admin/src/schedule/playingWindows.ts`:

```ts
import type { PlayingWindowRead } from "../types";

export interface WindowDraft {
  date: string;
  startTime: string;
  endTime: string;
}

export type WindowDraftError = "incomplete" | "endBeforeStart" | "overlap";

export function draftsFromWindows(windows: PlayingWindowRead[]): WindowDraft[] {
  return windows.map((w) => ({ date: w.date, startTime: w.start_time, endTime: w.end_time }));
}

function sorted(drafts: WindowDraft[]): WindowDraft[] {
  return [...drafts].sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
}

/** Mirrors the server's checks so most mistakes show before Save. */
export function validateWindowDrafts(drafts: WindowDraft[]): WindowDraftError | null {
  if (drafts.some((d) => !d.date || !d.startTime || !d.endTime)) return "incomplete";
  if (drafts.some((d) => d.endTime <= d.startTime)) return "endBeforeStart";
  const ordered = sorted(drafts);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].date === ordered[i - 1].date && ordered[i].startTime < ordered[i - 1].endTime) return "overlap";
  }
  return null;
}

export function windowsPayload(drafts: WindowDraft[]) {
  return {
    windows: sorted(drafts).map((d) => ({ date: d.date, start_time: d.startTime, end_time: d.endTime })),
  };
}

export function nextWindowDraft(drafts: WindowDraft[], sessionDate: string | null, today: string): WindowDraft {
  const last = sorted(drafts).at(-1);
  if (!last) return { date: sessionDate ?? today, startTime: "09:00", endTime: "12:00" };
  return { date: last.date, startTime: last.endTime, endTime: "" };
}

/** A calendar date's short weekday; the date has no zone, so it is read as UTC noon. */
export function weekdayLabel(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function summarizeWindows(
  windows: Pick<PlayingWindowRead, "date" | "start_time" | "end_time">[],
  locale: string
): string {
  const byDate = new Map<string, string[]>();
  for (const w of windows) byDate.set(w.date, [...(byDate.get(w.date) ?? []), `${w.start_time}–${w.end_time}`]);
  return [...byDate.entries()].map(([date, ranges]) => `${weekdayLabel(date, locale)} ${ranges.join(", ")}`).join(" · ");
}

/** The PUT body that moves only the last window's end. */
export function withLastWindowEnd(windows: PlayingWindowRead[], endTime: string) {
  return {
    windows: windows.map((w, index) => ({
      date: w.date,
      start_time: w.start_time,
      end_time: index === windows.length - 1 ? endTime : w.end_time,
    })),
  };
}

export function todayInZone(timeZone: string | null, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
```

Create `frontend/apps/admin/src/schedule/timeline.ts`:

```ts
export interface TimelineSpan {
  kind: "scheduled" | "draft";
  roundType: string;
  startMs: number;
  /** `Infinity` for a draft round that doesn't fully fit. */
  endMs: number;
}

export interface TimelineSegment {
  kind: "scheduled" | "draft" | "overflow";
  roundType: string;
  leftPct: number;
  widthPct: number;
}

export function segmentsInWindow(windowStartMs: number, windowEndMs: number, spans: TimelineSpan[]): TimelineSegment[] {
  const length = windowEndMs - windowStartMs;
  return spans.flatMap((span) => {
    const start = Math.max(span.startMs, windowStartMs);
    const end = Math.min(span.endMs, windowEndMs);
    if (end <= start) return [];
    return [
      {
        kind: span.kind,
        roundType: span.roundType,
        leftPct: ((start - windowStartMs) / length) * 100,
        widthPct: ((end - start) / length) * 100,
      },
    ];
  });
}

/** The red tail on the last window: how far past its end the plan runs, kept visible but bounded. */
export function overflowSegment(windowStartMs: number, windowEndMs: number, overBySeconds: number): TimelineSegment {
  const share = ((overBySeconds * 1000) / (windowEndMs - windowStartMs)) * 100;
  const widthPct = Math.min(30, Math.max(4, share));
  return { kind: "overflow", roundType: "", leftPct: 100 - widthPct, widthPct };
}
```

Create `frontend/apps/admin/src/schedule/formatDuration.ts`:

```ts
import type { TFunction } from "i18next";

/** A whole-minute duration, rounded up: "16 min", "2 h", "2 h 13 min". */
export function formatDuration(t: TFunction, seconds: number): string {
  const totalMinutes = Math.ceil(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return t("sessions.schedule.duration.minutes", { minutes });
  if (minutes === 0) return t("sessions.schedule.duration.hours", { hours });
  return t("sessions.schedule.duration.hoursMinutes", { hours, minutes });
}
```

- [ ] **Step 5: Run the tests and type check**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/planDraft.test.ts tests/unit/playingWindows.test.ts tests/unit/timeline.test.ts && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/admin/src/types.ts frontend/apps/admin/src/schedule/planDraft.ts frontend/apps/admin/src/schedule/playingWindows.ts frontend/apps/admin/src/schedule/timeline.ts frontend/apps/admin/src/schedule/formatDuration.ts frontend/apps/admin/tests/unit/planDraft.test.ts frontend/apps/admin/tests/unit/playingWindows.test.ts frontend/apps/admin/tests/unit/timeline.test.ts
git commit -m "Add the schedule planner's draft, window and timeline logic

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Strings and styles

**Files:**
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `.../zh/admin.json`, `frontend/apps/admin/src/styles/components.css`

**Interfaces:**
- Produces: every `sessions.schedule.*` key the components in Tasks 9–11 use; CSS classes `division-tabs`, `playing-times`, `plan-timeline`, `pill`, `fit-status`, `rounds-table`.

- [ ] **Step 1: Replace the Schedule strings**

In both `admin.json` files, inside `sessions.schedule`:
- Delete the `form` and `preview` objects entirely, and `divisionLabel`/`divisionOption*`.
- Keep `readiness` (adding the two keys below) and `rounds` (keeping its existing `clear*`, `confirmClear`, `typeToConfirm`, `scoredWarning*` keys used by the clear dialog; replacing the rest as below).
- Add the keys below. Merge, don't duplicate: where a key already exists with this name, overwrite its value.

English (`en/admin.json`, under `sessions.schedule`):

```json
"needsGamePlugin": "Select a game plugin on the event setup screen before scheduling.",
"noSchedulers": "No scheduler plugin is installed. Install one before scheduling.",
"divisionTabsLabel": "Divisions",
"divisionTab_one": "{{name}} · {{count}} team",
"divisionTab_other": "{{name}} · {{count}} teams",
"discardHeading": "Discard unapplied changes?",
"discardBody": "Your changes to this division's rounds haven't been applied.",
"discardConfirm": "Discard changes",
"keepEditing": "Keep editing",
"unsaved": {
  "heading": "Leave without applying?",
  "body": "Your changes to the rounds haven't been applied.",
  "leave": "Leave",
  "stay": "Stay"
},
"duration": {
  "minutes": "{{minutes}} min",
  "hours": "{{hours}} h",
  "hoursMinutes": "{{hours}} h {{minutes}} min"
},
"playingTimes": {
  "heading": "Playing times",
  "none": "No playing times yet. Add the times matches can be played, for every day of this session.",
  "edit": "Edit",
  "save": "Save",
  "cancel": "Cancel",
  "add": "Add playing time",
  "remove": "Remove",
  "dateLabel": "Playing time {{n}} date",
  "startLabel": "Playing time {{n}} start",
  "endLabel": "Playing time {{n}} end",
  "removeLabel": "Remove playing time {{n}}",
  "timelineLabel": "Session timeline",
  "gapBreak": "{{duration}} break",
  "gapOvernight": "overnight",
  "outsideRebuild": "Some matches are outside the playing times: {{rounds}}. Apply changes below to rebuild them.",
  "outsideLocked": "{{rounds}} has matches outside the playing times but can't be rebuilt because it has scores. Clear it to move its matches.",
  "errors": {
    "incomplete": "Every playing time needs a date, a start and an end.",
    "endBeforeStart": "Each playing time must end after it starts.",
    "overlap": "Two playing times on the same day overlap."
  }
},
"rounds": {
  "heading": "Rounds",
  "columnRound": "Round",
  "columnMatchesPerTeam": "Matches per team",
  "columnCycle": "Cycle time",
  "columnMatches": "Matches",
  "columnWhen": "When",
  "none": "No rounds yet. Add one to start planning.",
  "add": "Add round",
  "remove": "Remove",
  "removeLabel": "Remove {{round}}",
  "newRoundTypeLabel": "Round type for new round {{n}}",
  "matchesPerTeamLabel": "{{round}} matches per team",
  "cycleMinutesLabel": "{{round}} cycle time minutes",
  "cycleSecondsLabel": "{{round}} cycle time seconds",
  "minutesUnit": "min",
  "secondsUnit": "sec",
  "was": "was {{value}}",
  "pillScheduled": "scheduled",
  "pillChanged": "changed",
  "pillNew": "new",
  "pillNeedsRebuild": "needs rebuild",
  "pillScored_one": "{{count}} scored",
  "pillScored_other": "{{count}} scored",
  "doesNotFit": "doesn't fit",
  "pending": "after {{round}}",
  "droppedLocked": "{{rounds}} now has scores, so your changes to it were discarded.",
  "clearAction": "Clear",
  "clearAriaLabel": "Clear {{round}}",
  "clearAllAction": "Clear all rounds"
},
"fit": {
  "checking": "Checking the plan…",
  "fits": "Fits, with {{free}} of {{day}} still free.",
  "fitsExactly": "Fits.",
  "over_one": "Over by {{duration}}: {{count}} {{round}} match doesn't fit before {{end}}.",
  "over_other": "Over by {{duration}}: {{count}} {{round}} matches don't fit before {{end}}.",
  "useCycle": "Use cycle time {{cycle}}",
  "extend": "Extend {{day}} to {{time}}"
},
"actions": {
  "generate": "Generate",
  "apply": "Apply changes",
  "discard": "Discard changes",
  "rebuilds": "Rebuilds {{rounds}}.",
  "moreOptions": "More options",
  "schedulerLabel": "Scheduler",
  "applied_one": "{{count}} match scheduled.",
  "applied_other": "{{count}} matches scheduled.",
  "viewMatches": "View matches"
}
```

And in `sessions.schedule.readiness` add `"playingTimes": "This session has no playing times."` and `"playingTimesFix": "Add playing times"`.

Chinese (`zh/admin.json`, same keys under `sessions.schedule`):

```json
"needsGamePlugin": "请先在赛事设置中选择游戏插件，再生成赛程。",
"noSchedulers": "尚未安装赛程插件。请先安装一个。",
"divisionTabsLabel": "组别",
"divisionTab_one": "{{name}} · {{count}} 支队伍",
"divisionTab_other": "{{name}} · {{count}} 支队伍",
"discardHeading": "放弃未应用的更改？",
"discardBody": "你对此组别轮次的更改尚未应用。",
"discardConfirm": "放弃更改",
"keepEditing": "继续编辑",
"unsaved": {
  "heading": "不应用就离开？",
  "body": "你对轮次的更改尚未应用。",
  "leave": "离开",
  "stay": "留下"
},
"duration": {
  "minutes": "{{minutes}} 分钟",
  "hours": "{{hours}} 小时",
  "hoursMinutes": "{{hours}} 小时 {{minutes}} 分钟"
},
"playingTimes": {
  "heading": "比赛时段",
  "none": "尚未设置比赛时段。请为本场次的每一天添加可以进行比赛的时间。",
  "edit": "编辑",
  "save": "保存",
  "cancel": "取消",
  "add": "添加比赛时段",
  "remove": "删除",
  "dateLabel": "比赛时段 {{n}} 日期",
  "startLabel": "比赛时段 {{n}} 开始",
  "endLabel": "比赛时段 {{n}} 结束",
  "removeLabel": "删除比赛时段 {{n}}",
  "timelineLabel": "场次时间线",
  "gapBreak": "休息 {{duration}}",
  "gapOvernight": "隔夜",
  "outsideRebuild": "部分比赛不在比赛时段内：{{rounds}}。请在下方应用更改以重新生成。",
  "outsideLocked": "{{rounds}} 有比赛不在比赛时段内，但已有成绩，无法重新生成。清除后才能移动其比赛。",
  "errors": {
    "incomplete": "每个比赛时段都需要日期、开始和结束时间。",
    "endBeforeStart": "每个比赛时段的结束时间必须晚于开始时间。",
    "overlap": "同一天的两个比赛时段重叠。"
  }
},
"rounds": {
  "heading": "轮次",
  "columnRound": "轮次",
  "columnMatchesPerTeam": "每队场数",
  "columnCycle": "周期时间",
  "columnMatches": "场数",
  "columnWhen": "时间",
  "none": "尚无轮次。添加一个轮次开始规划。",
  "add": "添加轮次",
  "remove": "删除",
  "removeLabel": "删除{{round}}",
  "newRoundTypeLabel": "新轮次 {{n}} 的类型",
  "matchesPerTeamLabel": "{{round}}每队场数",
  "cycleMinutesLabel": "{{round}}周期时间（分）",
  "cycleSecondsLabel": "{{round}}周期时间（秒）",
  "minutesUnit": "分",
  "secondsUnit": "秒",
  "was": "原为 {{value}}",
  "pillScheduled": "已安排",
  "pillChanged": "已更改",
  "pillNew": "新",
  "pillNeedsRebuild": "需重新生成",
  "pillScored_one": "{{count}} 场已计分",
  "pillScored_other": "{{count}} 场已计分",
  "doesNotFit": "排不下",
  "pending": "在{{round}}之后",
  "droppedLocked": "{{rounds}} 现已有成绩，你对它的更改已被放弃。",
  "clearAction": "清除",
  "clearAriaLabel": "清除{{round}}",
  "clearAllAction": "清除所有轮次"
},
"fit": {
  "checking": "正在检查方案…",
  "fits": "可以排下，{{day}}还剩 {{free}}。",
  "fitsExactly": "可以排下。",
  "over_one": "超出 {{duration}}：{{count}} 场{{round}}比赛在 {{end}} 前排不下。",
  "over_other": "超出 {{duration}}：{{count}} 场{{round}}比赛在 {{end}} 前排不下。",
  "useCycle": "使用周期时间 {{cycle}}",
  "extend": "将{{day}}延长到 {{time}}"
},
"actions": {
  "generate": "生成",
  "apply": "应用更改",
  "discard": "放弃更改",
  "rebuilds": "将重新生成{{rounds}}。",
  "moreOptions": "更多选项",
  "schedulerLabel": "赛程插件",
  "applied_one": "已安排 {{count}} 场比赛。",
  "applied_other": "已安排 {{count}} 场比赛。",
  "viewMatches": "查看比赛"
}
```

and in `readiness`: `"playingTimes": "本场次尚未设置比赛时段。"`, `"playingTimesFix": "添加比赛时段"`.

Check with: `node -e "for (const l of ['en','zh']) JSON.parse(require('fs').readFileSync('src/i18n/'+l+'/admin.json','utf8'))"` (run from `frontend/apps/admin`). Expected: no output.

- [ ] **Step 2: Add the styles**

Append to `frontend/apps/admin/src/styles/components.css`:

```css
/* Schedule planner */
.division-tabs {
  display: flex;
  gap: var(--space-1);
  overflow-x: auto;
  border-bottom: var(--border-width) solid var(--color-border);
  margin-bottom: var(--space-4);
}
.division-tabs__tab {
  padding: var(--space-2) var(--space-4);
  border: 0;
  border-bottom: 3px solid transparent;
  background: none;
  color: var(--color-text-secondary);
  font: inherit;
  white-space: nowrap;
  cursor: pointer;
}
.division-tabs__tab[aria-selected="true"] {
  border-bottom-color: var(--color-accent);
  color: var(--color-text);
  font-weight: 600;
}
.division-tabs__tab:focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: -2px;
}
.playing-times__header {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--space-3);
}
.playing-times__header h2 {
  margin: 0;
}
.playing-times__summary {
  color: var(--color-text-secondary);
  flex: 1;
}
.plan-timeline {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.plan-timeline__window {
  flex-basis: 0;
  min-width: 3rem;
}
.plan-timeline__bar {
  position: relative;
  height: 1.25rem;
  border-radius: var(--radius-sm);
  background: var(--color-bg-sunken);
  overflow: hidden;
}
.plan-timeline__segment {
  position: absolute;
  top: 0;
  bottom: 0;
  background: var(--color-accent);
}
.plan-timeline__segment[data-round="practice"] {
  background: color-mix(in srgb, var(--color-accent) 55%, var(--color-bg));
}
.plan-timeline__segment--draft {
  opacity: 0.55;
}
.plan-timeline__segment--overflow {
  background: var(--color-danger);
}
.plan-timeline__label,
.plan-timeline__gap {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.plan-timeline__gap {
  align-self: center;
  white-space: nowrap;
}
.pill {
  display: inline-block;
  margin-left: var(--space-2);
  padding: 0 var(--space-2);
  border-radius: 999px;
  font-size: var(--text-xs);
  background: var(--color-bg-sunken);
  color: var(--color-text-secondary);
}
.pill--changed {
  background: var(--color-warning-bg);
  color: var(--color-text);
}
.pill--new {
  background: var(--color-success-bg);
  color: var(--color-text);
}
.rounds-table input.input--changed {
  border-color: var(--color-warning);
  background: var(--color-warning-bg);
}
.rounds-table__hint {
  margin-left: var(--space-2);
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}
.fit-status {
  margin-top: var(--space-3);
}
.fit-status--ok {
  color: var(--color-success);
}
.fit-status--stale {
  opacity: 0.6;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/apps/admin/src/i18n frontend/apps/admin/src/styles/components.css
git commit -m "Add the schedule planner's strings and styles

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(The deleted `form`/`preview` keys break the old `ScheduleForm` text until Task 10 deletes it; unit tests that render it are rewritten in Task 10.)

---

### Task 9: Playing times panel, timeline and division tabs

**Files:**
- Create: `frontend/apps/admin/src/schedule/PlayingTimesPanel.tsx`, `src/schedule/PlanTimeline.tsx`, `src/schedule/DivisionTabs.tsx`
- Test: `frontend/apps/admin/tests/unit/PlayingTimesPanel.test.tsx`, `tests/unit/DivisionTabs.test.tsx`

**Interfaces:**
- Consumes: Task 7 modules, Task 8 strings.
- Produces:
  - `PlayingTimesPanel({ session, windows, timeline, outsideRounds })` — `windows: PlayingWindowRead[]`, `timeline: ReactNode`, `outsideRounds: { roundType: string; locked: boolean }[]`. Region labelled "Playing times", element id `playing-times`. Saving invalidates `["playingWindows", sessionId]`, `["scheduleRounds", sessionId]` and `["schedulePlan"]`.
  - `PlanTimeline({ windows, spans, overBySeconds })`.
  - `DivisionTabs({ divisions, counts, selectedId, onSelect })` — `counts: Map<number, number>`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/admin/tests/unit/PlayingTimesPanel.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { PlayingTimesPanel } from "../../src/schedule/PlayingTimesPanel";
import type { PlayingWindowRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});
import { apiRequest } from "@tournament-admin/shared";

const SESSION: SessionRead = { id: 1, event_id: 1, label: "Weekend", session_date: "2026-11-07", timezone: "America/Los_Angeles" };
const WINDOWS: PlayingWindowRead[] = [
  { date: "2026-11-07", start_time: "09:00", end_time: "12:00", start_utc: "2026-11-07T17:00:00Z", end_utc: "2026-11-07T20:00:00Z" },
  { date: "2026-11-08", start_time: "09:00", end_time: "15:00", start_utc: "2026-11-08T17:00:00Z", end_utc: "2026-11-08T23:00:00Z" },
];

function renderPanel(windows: PlayingWindowRead[], outsideRounds: { roundType: string; locked: boolean }[] = []) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <PlayingTimesPanel session={SESSION} windows={windows} timeline={<div>timeline</div>} outsideRounds={outsideRounds} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => vi.mocked(apiRequest).mockReset());

describe("PlayingTimesPanel", () => {
  it("summarizes saved windows and shows the timeline", () => {
    renderPanel(WINDOWS);
    expect(screen.getByText("Sat 09:00–12:00 · Sun 09:00–15:00")).toBeInTheDocument();
    expect(screen.getByText("timeline")).toBeInTheDocument();
  });

  it("opens the editor straight away when there are no windows, starting on the session date", () => {
    renderPanel([]);
    expect(screen.getByLabelText("Playing time 1 date")).toHaveValue("2026-11-07");
    expect(screen.getByLabelText("Playing time 1 start")).toHaveValue("09:00");
    expect(screen.getByLabelText("Playing time 1 end")).toHaveValue("12:00");
  });

  it("adds a window that starts where the last one ends, and saves them sorted", async () => {
    vi.mocked(apiRequest).mockResolvedValue([] as never);
    renderPanel(WINDOWS);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Add playing time" }));
    expect(screen.getByLabelText("Playing time 3 start")).toHaveValue("15:00");
    fireEvent.change(screen.getByLabelText("Playing time 3 end"), { target: { value: "16:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/1/playing-windows", {
        method: "PUT",
        body: {
          windows: [
            { date: "2026-11-07", start_time: "09:00", end_time: "12:00" },
            { date: "2026-11-08", start_time: "09:00", end_time: "15:00" },
            { date: "2026-11-08", start_time: "15:00", end_time: "16:00" },
          ],
        },
      })
    );
  });

  it("explains an invalid window without saving", () => {
    renderPanel(WINDOWS);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Playing time 1 end"), { target: { value: "08:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Each playing time must end after it starts.");
    expect(apiRequest).not.toHaveBeenCalled();
  });

  it("shows the server's refusal", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new ApiError(422, "Set the session's timezone before adding playing times"));
    renderPanel(WINDOWS);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Set the session's timezone before adding playing times");
  });

  it("says which rounds fall outside the playing times", () => {
    renderPanel(WINDOWS, [
      { roundType: "qualification", locked: false },
      { roundType: "practice", locked: true },
    ]);
    expect(screen.getByText(/Some matches are outside the playing times: Qualification\./)).toBeInTheDocument();
    expect(screen.getByText(/Practice has matches outside the playing times but can't be rebuilt/)).toBeInTheDocument();
  });
});
```

Create `frontend/apps/admin/tests/unit/DivisionTabs.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { DivisionTabs } from "../../src/schedule/DivisionTabs";

const DIVISIONS = [
  { id: 1, event_id: 1, name: "Division 1", target_team_count: null },
  { id: 2, event_id: 1, name: "Blue", target_team_count: null },
];

function renderTabs(onSelect = vi.fn(), selectedId = 1) {
  const i18n = initI18n({ en: { translation: enAdmin } });
  render(
    <I18nextProvider i18n={i18n}>
      <DivisionTabs divisions={DIVISIONS} counts={new Map([[1, 24], [2, 1]])} selectedId={selectedId} onSelect={onSelect} />
    </I18nextProvider>
  );
  return onSelect;
}

describe("DivisionTabs", () => {
  it("shows each division with its checked-in team count and marks the selected one", () => {
    renderTabs();
    expect(screen.getByRole("tab", { name: "Division 1 · 24 teams" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "Blue · 1 team" })).toHaveAttribute("aria-selected", "false");
  });

  it("selects on click", () => {
    const onSelect = renderTabs();
    fireEvent.click(screen.getByRole("tab", { name: "Blue · 1 team" }));
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("moves with the arrow keys, wrapping around", () => {
    const onSelect = renderTabs();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Division 1 · 24 teams" }), { key: "ArrowLeft" });
    expect(onSelect).toHaveBeenCalledWith(2);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Division 1 · 24 teams" }), { key: "ArrowRight" });
    expect(onSelect).toHaveBeenLastCalledWith(2);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/PlayingTimesPanel.test.tsx tests/unit/DivisionTabs.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Create `frontend/apps/admin/src/schedule/PlanTimeline.tsx`:

```tsx
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { formatDuration } from "./formatDuration";
import { weekdayLabel } from "./playingWindows";
import { overflowSegment, segmentsInWindow, type TimelineSpan } from "./timeline";
import type { PlayingWindowRead } from "../types";

/** One bar per playing window, sized by its length, with each round drawn where it runs. */
export function PlanTimeline({
  windows,
  spans,
  overBySeconds,
}: {
  windows: PlayingWindowRead[];
  spans: TimelineSpan[];
  overBySeconds: number;
}) {
  const { t, i18n } = useTranslation();
  const usable = windows.filter((w) => w.start_utc !== null && w.end_utc !== null);
  if (usable.length === 0) return null;
  return (
    <div className="plan-timeline" role="img" aria-label={t("sessions.schedule.playingTimes.timelineLabel")}>
      {usable.map((window, index) => {
        const startMs = Date.parse(window.start_utc!);
        const endMs = Date.parse(window.end_utc!);
        const segments = segmentsInWindow(startMs, endMs, spans);
        if (overBySeconds > 0 && index === usable.length - 1) segments.push(overflowSegment(startMs, endMs, overBySeconds));
        const previous = usable[index - 1];
        return (
          <Fragment key={`${window.date}-${window.start_time}`}>
            {previous && (
              <span className="plan-timeline__gap">
                {previous.date === window.date
                  ? t("sessions.schedule.playingTimes.gapBreak", {
                      duration: formatDuration(t, (startMs - Date.parse(previous.end_utc!)) / 1000),
                    })
                  : t("sessions.schedule.playingTimes.gapOvernight")}
              </span>
            )}
            <div className="plan-timeline__window" style={{ flexGrow: (endMs - startMs) / 60_000 }}>
              <div className="plan-timeline__bar">
                {segments.map((segment, i) => (
                  <span
                    key={i}
                    className={`plan-timeline__segment plan-timeline__segment--${segment.kind}`}
                    data-round={segment.roundType}
                    style={{ left: `${segment.leftPct}%`, width: `${segment.widthPct}%` }}
                  />
                ))}
              </div>
              <span className="plan-timeline__label">
                {weekdayLabel(window.date, i18n.language)} {window.start_time}–{window.end_time}
              </span>
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
```

Create `frontend/apps/admin/src/schedule/PlayingTimesPanel.tsx`:

```tsx
import { useId, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { roundTypeLabel } from "../roundTypeLabel";
import {
  draftsFromWindows,
  nextWindowDraft,
  summarizeWindows,
  todayInZone,
  validateWindowDrafts,
  windowsPayload,
  type WindowDraft,
} from "./playingWindows";
import type { PlayingWindowRead, SessionRead } from "../types";

interface PlayingTimesPanelProps {
  session: SessionRead;
  windows: PlayingWindowRead[];
  timeline: ReactNode;
  outsideRounds: { roundType: string; locked: boolean }[];
}

/** The session's playing windows: a one-line summary and timeline, or an editor. */
export function PlayingTimesPanel({ session, windows, timeline, outsideRounds }: PlayingTimesPanelProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const queryClient = useQueryClient();
  const today = todayInZone(session.timezone);
  const [drafts, setDrafts] = useState<WindowDraft[] | null>(
    windows.length === 0 ? [nextWindowDraft([], session.session_date, today)] : null
  );
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: ReturnType<typeof windowsPayload>) =>
      apiRequest<PlayingWindowRead[]>(`/api/sessions/${session.id}/playing-windows`, { method: "PUT", body }),
    onSuccess: () => {
      setDrafts(null);
      queryClient.invalidateQueries({ queryKey: ["playingWindows", session.id] });
      queryClient.invalidateQueries({ queryKey: ["scheduleRounds", session.id] });
      queryClient.invalidateQueries({ queryKey: ["schedulePlan"] });
    },
  });

  function submit() {
    if (drafts === null) return;
    const error = validateWindowDrafts(drafts);
    if (error) {
      setProblem(t(`sessions.schedule.playingTimes.errors.${error}`));
      return;
    }
    setProblem(null);
    save.mutate(windowsPayload(drafts));
  }

  function updateDraft(index: number, patch: Partial<WindowDraft>) {
    setDrafts((current) => current!.map((draft, i) => (i === index ? { ...draft, ...patch } : draft)));
  }

  const rebuild = outsideRounds.filter((r) => !r.locked).map((r) => roundTypeLabel(t, r.roundType));
  const locked = outsideRounds.filter((r) => r.locked).map((r) => roundTypeLabel(t, r.roundType));

  return (
    <section id="playing-times" className="panel playing-times" aria-labelledby={headingId}>
      <div className="playing-times__header">
        <h2 id={headingId}>{t("sessions.schedule.playingTimes.heading")}</h2>
        {drafts === null && (
          <>
            <span className="playing-times__summary">
              {windows.length > 0 ? summarizeWindows(windows, i18n.language) : t("sessions.schedule.playingTimes.none")}
            </span>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                save.reset();
                setDrafts(draftsFromWindows(windows));
              }}
            >
              {t("sessions.schedule.playingTimes.edit")}
            </button>
          </>
        )}
      </div>

      {drafts === null ? (
        timeline
      ) : (
        <div className="playing-times__editor">
          {windows.length === 0 && <p className="field__hint">{t("sessions.schedule.playingTimes.none")}</p>}
          {drafts.map((draft, index) => (
            <div key={index} className="form-actions">
              <input
                className="input"
                type="date"
                aria-label={t("sessions.schedule.playingTimes.dateLabel", { n: index + 1 })}
                value={draft.date}
                onChange={(event) => updateDraft(index, { date: event.target.value })}
              />
              <input
                className="input"
                type="time"
                aria-label={t("sessions.schedule.playingTimes.startLabel", { n: index + 1 })}
                value={draft.startTime}
                onChange={(event) => updateDraft(index, { startTime: event.target.value })}
              />
              <input
                className="input"
                type="time"
                aria-label={t("sessions.schedule.playingTimes.endLabel", { n: index + 1 })}
                value={draft.endTime}
                onChange={(event) => updateDraft(index, { endTime: event.target.value })}
              />
              <button
                type="button"
                className="btn btn-small"
                aria-label={t("sessions.schedule.playingTimes.removeLabel", { n: index + 1 })}
                onClick={() => setDrafts(drafts.filter((_, i) => i !== index))}
              >
                {t("sessions.schedule.playingTimes.remove")}
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn btn-small schedule-form__add"
            onClick={() => setDrafts([...drafts, nextWindowDraft(drafts, session.session_date, today)])}
          >
            {t("sessions.schedule.playingTimes.add")}
          </button>
          {problem && (
            <p className="alert alert-danger" role="alert">
              {problem}
            </p>
          )}
          {save.isError && (
            <p className="alert alert-danger" role="alert">
              {apiErrorMessage(save.error, t("errors.generic"))}
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="btn btn-primary" disabled={save.isPending} onClick={submit}>
              {t("sessions.schedule.playingTimes.save")}
            </button>
            {windows.length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setDrafts(null);
                  setProblem(null);
                }}
              >
                {t("sessions.schedule.playingTimes.cancel")}
              </button>
            )}
          </div>
        </div>
      )}

      {rebuild.length > 0 && (
        <p className="alert alert-warning">
          {t("sessions.schedule.playingTimes.outsideRebuild", { rounds: rebuild.join(", ") })}
        </p>
      )}
      {locked.length > 0 && (
        <p className="alert alert-warning">
          {t("sessions.schedule.playingTimes.outsideLocked", { rounds: locked.join(", ") })}
        </p>
      )}
    </section>
  );
}
```

Create `frontend/apps/admin/src/schedule/DivisionTabs.tsx`:

```tsx
import { useRef, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Division } from "../types";

interface DivisionTabsProps {
  divisions: Division[];
  /** Checked-in team count per division id. */
  counts: Map<number, number>;
  selectedId: number;
  onSelect: (divisionId: number) => void;
}

/** A tab per division; arrow keys, Home and End move between them. */
export function DivisionTabs({ divisions, counts, selectedId, onSelect }: DivisionTabsProps) {
  const { t } = useTranslation();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = divisions.findIndex((division) => division.id === selectedId);
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % divisions.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + divisions.length) % divisions.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = divisions.length - 1;
    else return;
    event.preventDefault();
    onSelect(divisions[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div className="division-tabs" role="tablist" aria-label={t("sessions.schedule.divisionTabsLabel")} onKeyDown={onKeyDown}>
      {divisions.map((division, index) => {
        const selected = division.id === selectedId;
        return (
          <button
            key={division.id}
            ref={(element) => {
              refs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`division-tab-${division.id}`}
            aria-selected={selected}
            aria-controls="division-panel"
            tabIndex={selected ? 0 : -1}
            className="division-tabs__tab"
            onClick={() => onSelect(division.id)}
          >
            {t("sessions.schedule.divisionTab", { name: division.name, count: counts.get(division.id) ?? 0 })}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the tests and type check**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/PlayingTimesPanel.test.tsx tests/unit/DivisionTabs.test.tsx && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/admin/src/schedule/PlayingTimesPanel.tsx frontend/apps/admin/src/schedule/PlanTimeline.tsx frontend/apps/admin/src/schedule/DivisionTabs.tsx frontend/apps/admin/tests/unit/PlayingTimesPanel.test.tsx frontend/apps/admin/tests/unit/DivisionTabs.test.tsx
git commit -m "Add the playing times panel, session timeline and division tabs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The division planner and the new Schedule tab

**Files:**
- Create: `frontend/apps/admin/src/schedule/usePlannerDraft.ts`, `src/schedule/usePlanPreview.ts`, `src/schedule/useUnsavedChangesGuard.tsx`, `src/schedule/ClearRoundDialog.tsx`, `src/schedule/RoundsTable.tsx`, `src/schedule/FitStatus.tsx`, `src/schedule/DivisionPlanner.tsx`
- Modify: `frontend/apps/admin/src/schedule/readiness.ts`, `src/schedule/ReadinessChecklist.tsx`, `src/routes/SessionScheduleRoute.tsx`, `src/types.ts`
- Delete: `src/schedule/ScheduleForm.tsx`, `src/schedule/PreviewPanel.tsx`, `src/schedule/CurrentRounds.tsx`, `src/schedule/scheduleRequest.ts`, `tests/unit/scheduleRequest.test.ts`
- Test: `frontend/apps/admin/tests/unit/SessionScheduleRoute.test.tsx` (rewrite), `tests/unit/readiness.test.ts`

**Interfaces:**
- Consumes: Tasks 7–9; `ConfirmDialog` (`heading`, `body`, `confirmLabel`, `cancelLabel`, `requiredPhrase?`, `phrasePrompt?`, `isPending?`, `error?`, `onConfirm`, `onCancel`); `formatMatchTime`, `spansMultipleDays` (`src/matchTime.ts`); `roundTypeLabel`; `apiErrorMessage`; `showTransientError` (`src/errorBanner`); `useSessionMatches`.
- Produces: `checkReadiness` input gains `playingWindowCount: number`; readiness key `"playingTimes"` (fix link `#playing-times`); `DivisionPlanner({ session, divisionId, matchFormat, windows, ready, matchesUpdatedAt, onDirtyChange })`; query keys `["scheduleRounds", sessionId, divisionId]`, `["playingWindows", sessionId]`, `["schedulePlan", requestJson]`.

- [ ] **Step 1: Update readiness (test first)**

In `frontend/apps/admin/tests/unit/readiness.test.ts`, add `playingWindowCount: 1` to every `checkReadiness({...})` input, update any expected key list to `["gamePlugin", "timezone", "playingTimes", "teams", "fields"]`, and add:

```ts
it("blocks on a session with no playing times", () => {
  const items = checkReadiness({
    gamePluginSelected: true,
    sessionTimezone: "America/Los_Angeles",
    playingWindowCount: 0,
    checkedInTeamCount: 8,
    teamsNeeded: 4,
    usableFieldCount: 1,
  });
  expect(items.filter((item) => !item.ok).map((item) => item.key)).toEqual(["playingTimes"]);
});
```

Then in `src/schedule/readiness.ts`: change `ReadinessKey` to `"gamePlugin" | "timezone" | "playingTimes" | "teams" | "fields"`, add `playingWindowCount: number` to `checkReadiness`'s input, and insert `{ key: "playingTimes", ok: input.playingWindowCount > 0 },` after the timezone item. In `ReadinessChecklist.tsx`'s `fixLink`, add `case "playingTimes": return "#playing-times";`.

Run: `cd frontend/apps/admin && npx vitest run tests/unit/readiness.test.ts` — Expected: PASS.

- [ ] **Step 2: Write the hooks**

Create `frontend/apps/admin/src/schedule/usePlanPreview.ts`:

```ts
import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { PlanRequest } from "./planDraft";
import type { PlanResponse } from "../types";

export interface PlanPreview {
  data: PlanResponse | undefined;
  error: unknown;
  /** True once the shown result answers the latest draft. */
  settled: boolean;
}

/**
 * Dry-runs the draft 400 ms after the last edit. Keyed by the request body,
 * so only the latest draft's answer is ever shown; the previous answer
 * stays (dimmed by the caller) while the next one is in flight.
 */
export function usePlanPreview(request: PlanRequest | null): PlanPreview {
  const key = request === null ? null : JSON.stringify(request);
  const [debouncedKey, setDebouncedKey] = useState(key);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKey(key), 400);
    return () => clearTimeout(timer);
  }, [key]);
  const query = useQuery({
    queryKey: ["schedulePlan", debouncedKey],
    queryFn: () => apiRequest<PlanResponse>("/api/schedule", { method: "POST", body: JSON.parse(debouncedKey!) }),
    enabled: debouncedKey !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });
  if (key === null) return { data: undefined, error: null, settled: false };
  return {
    data: query.data,
    error: query.isError ? query.error : null,
    settled: key === debouncedKey && !query.isFetching && !query.isPlaceholderData && query.isSuccess,
  };
}
```

Create `frontend/apps/admin/src/schedule/usePlannerDraft.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import {
  defaultCycleSeconds,
  initialRows,
  mergeServerRounds,
  plannerRoundTypes,
  type RoundRow,
} from "./planDraft";
import type { MatchFormat, ScheduleRounds } from "../types";

/** A division's editable rows, rebuilt from the server's rounds whenever they refresh. */
export function usePlannerDraft(scheduled: ScheduleRounds | undefined, matchFormat: MatchFormat) {
  const [rows, setRows] = useState<RoundRow[] | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const nextKey = useRef(1000);

  const cycleFor = useCallback(
    (previous?: RoundRow) =>
      defaultCycleSeconds({
        previousRow: previous,
        sessionLast: scheduled?.session_last_cycle_time_seconds ?? null,
        pluginDefault: matchFormat.default_cycle_time_seconds,
        matchSeconds: matchFormat.match_duration_seconds,
      }),
    [scheduled, matchFormat]
  );

  useEffect(() => {
    if (!scheduled) return;
    if (rows === null) {
      setRows(initialRows(scheduled.rounds, plannerRoundTypes(matchFormat.round_types), cycleFor));
      return;
    }
    const merged = mergeServerRounds(rows, scheduled.rounds, cycleFor());
    setRows(merged.rows);
    if (merged.dropped.length > 0) setDropped(merged.dropped);
    // Re-merge only when the server's rounds change, never on a local edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduled]);

  return {
    rows: rows ?? [],
    loaded: rows !== null,
    setRows,
    dropped,
    cycleFor,
    nextKey: () => `new-${nextKey.current++}`,
    discard: () => {
      if (scheduled) setRows(initialRows(scheduled.rounds, plannerRoundTypes(matchFormat.round_types), cycleFor));
    },
  };
}
```

Create `frontend/apps/admin/src/schedule/useUnsavedChangesGuard.tsx`:

```tsx
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBlocker } from "react-router-dom";
import { ConfirmDialog } from "../components/ConfirmDialog";

/** Asks before leaving the page (or closing the tab) with unapplied changes; returns the dialog to render. */
export function useUnsavedChangesGuard(dirty: boolean): ReactNode {
  const { t } = useTranslation();
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  if (blocker.state !== "blocked") return null;
  return (
    <ConfirmDialog
      heading={t("sessions.schedule.unsaved.heading")}
      body={t("sessions.schedule.unsaved.body")}
      confirmLabel={t("sessions.schedule.unsaved.leave")}
      cancelLabel={t("sessions.schedule.unsaved.stay")}
      onConfirm={() => blocker.proceed()}
      onCancel={() => blocker.reset()}
    />
  );
}
```

- [ ] **Step 3: Write the components**

Create `frontend/apps/admin/src/schedule/ClearRoundDialog.tsx` by moving `CurrentRounds.tsx`'s clear logic, keyed to `ScheduledRound`:

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import { roundTypeLabel } from "../roundTypeLabel";
import type { ScheduledRound } from "../types";

interface ClearRoundDialogProps {
  sessionId: number;
  divisionId: number | null;
  targets: ScheduledRound[];
  onDone: () => void;
}

/** Confirms clearing one round (or all of them); scored rounds need their name typed. */
export function ClearRoundDialog({ sessionId, divisionId, targets, onDone }: ClearRoundDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const clear = useMutation({
    // One DELETE per round, in order; stopping at the first failure leaves the rest intact.
    mutationFn: async () => {
      for (const round of targets) {
        const params = new URLSearchParams({ session_id: String(sessionId), round_type: round.round_type });
        if (divisionId !== null) params.set("division_id", String(divisionId));
        await apiRequest(`/api/schedule?${params.toString()}`, { method: "DELETE" });
      }
    },
    onSuccess: onDone,
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["matches", sessionId] });
      queryClient.invalidateQueries({ queryKey: ["scheduleRounds", sessionId] });
    },
  });
  const isAll = targets.length > 1;
  const scored = targets.reduce((sum, round) => sum + round.scored_count, 0);
  const phrase =
    scored === 0 ? null : isAll ? t("sessions.schedule.rounds.clearAllPhrase") : roundTypeLabel(t, targets[0].round_type);
  const body = [
    isAll
      ? t("sessions.schedule.rounds.clearAllBody")
      : t("sessions.schedule.rounds.clearBody", { count: targets[0].match_count }),
    scored > 0 ? t("sessions.schedule.rounds.scoredWarning", { count: scored }) : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <ConfirmDialog
      heading={
        isAll
          ? t("sessions.schedule.rounds.clearAllHeading")
          : t("sessions.schedule.rounds.clearHeading", { round: roundTypeLabel(t, targets[0].round_type) })
      }
      body={body}
      confirmLabel={t("sessions.schedule.rounds.confirmClear")}
      cancelLabel={t("sessions.cancelAction")}
      requiredPhrase={phrase}
      phrasePrompt={phrase ? t("sessions.schedule.rounds.typeToConfirm", { phrase }) : undefined}
      isPending={clear.isPending}
      error={clear.isError ? apiErrorMessage(clear.error, t("errors.generic")) : null}
      onConfirm={() => clear.mutate()}
      onCancel={onDone}
    />
  );
}
```

(Keep the existing `rounds.clearAllPhrase`, `clearAllBody`, `clearBody*`, `scoredWarning*`, `clearHeading`, `clearAllHeading`, `confirmClear`, `typeToConfirm` strings from before Task 8.)

Create `frontend/apps/admin/src/schedule/RoundsTable.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { formatMatchTime, spansMultipleDays } from "../matchTime";
import { roundTypeLabel } from "../roundTypeLabel";
import {
  defaultMatchesPerTeam,
  formatCycle,
  isRowChanged,
  needsRebuild,
  newRow,
  splitCycle,
  type RoundRow,
} from "./planDraft";
import type { PlanResponse, ScheduledRound } from "../types";

interface RoundsTableProps {
  rows: RoundRow[];
  /** Keys of the rows the next Generate/Apply sends. */
  sendKeys: Set<string>;
  preview: PlanResponse | undefined;
  timeZone: string | null;
  availableTypes: string[];
  onRowsChange: (rows: RoundRow[]) => void;
  onClear: (round: ScheduledRound) => void;
  cycleFor: (previous?: RoundRow) => number;
  nextKey: () => string;
}

export function RoundsTable({
  rows,
  sendKeys,
  preview,
  timeZone,
  availableTypes,
  onRowsChange,
  onClear,
  cycleFor,
  nextKey,
}: RoundsTableProps) {
  const { t, i18n } = useTranslation();
  const used = new Set(rows.map((row) => row.roundType));
  const addable = availableTypes.filter((type) => !used.has(type));

  function update(key: string, patch: Partial<RoundRow>) {
    onRowsChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function when(start: string | null, end: string | null): string {
    if (!start) return "—";
    const from = formatMatchTime(start, timeZone, true, i18n.language);
    if (!end) return `${from} → ${t("sessions.schedule.rounds.doesNotFit")}`;
    return `${from} – ${formatMatchTime(end, timeZone, spansMultipleDays([start, end], timeZone), i18n.language)}`;
  }

  return (
    <>
      {rows.length === 0 ? (
        <p>{t("sessions.schedule.rounds.none")}</p>
      ) : (
        <table className="schedule-table rounds-table">
          <thead>
            <tr>
              <th>{t("sessions.schedule.rounds.columnRound")}</th>
              <th>{t("sessions.schedule.rounds.columnMatchesPerTeam")}</th>
              <th>{t("sessions.schedule.rounds.columnCycle")}</th>
              <th>{t("sessions.schedule.rounds.columnMatches")}</th>
              <th>{t("sessions.schedule.rounds.columnWhen")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const label = roundTypeLabel(t, row.roundType);
              const locked = row.scheduled?.locked ?? false;
              const changed = isRowChanged(row);
              const planned = sendKeys.has(row.key)
                ? preview?.rounds.find((round) => round.round_type === row.roundType)
                : undefined;
              const { minutes, seconds } = splitCycle(Number.isNaN(row.cycleSeconds) ? 0 : row.cycleSeconds);
              const matchesChanged = row.original !== null && row.matchesPerTeam !== row.original.matchesPerTeam;
              const cycleChanged = row.original !== null && row.cycleSeconds !== row.original.cycleSeconds;
              return (
                <tr key={row.key}>
                  <td>
                    {row.scheduled ? (
                      label
                    ) : (
                      <select
                        className="select"
                        aria-label={t("sessions.schedule.rounds.newRoundTypeLabel", { n: index + 1 })}
                        value={row.roundType}
                        onChange={(event) => update(row.key, { roundType: event.target.value })}
                      >
                        {[row.roundType, ...addable].map((type) => (
                          <option key={type} value={type}>
                            {roundTypeLabel(t, type)}
                          </option>
                        ))}
                      </select>
                    )}
                    {locked ? (
                      <span className="pill">
                        <span aria-hidden="true">🔒 </span>
                        {t("sessions.schedule.rounds.pillScored", { count: row.scheduled!.scored_count })}
                      </span>
                    ) : row.scheduled === null ? (
                      <span className="pill pill--new">{t("sessions.schedule.rounds.pillNew")}</span>
                    ) : changed ? (
                      <span className="pill pill--changed">{t("sessions.schedule.rounds.pillChanged")}</span>
                    ) : needsRebuild(row) ? (
                      <span className="pill pill--changed">{t("sessions.schedule.rounds.pillNeedsRebuild")}</span>
                    ) : (
                      <span className="pill">{t("sessions.schedule.rounds.pillScheduled")}</span>
                    )}
                  </td>
                  <td>
                    {locked ? (
                      row.matchesPerTeam
                    ) : (
                      <>
                        <input
                          className={`input schedule-form__number${matchesChanged ? " input--changed" : ""}`}
                          type="number"
                          min={1}
                          step={1}
                          aria-label={t("sessions.schedule.rounds.matchesPerTeamLabel", { round: label })}
                          value={Number.isNaN(row.matchesPerTeam) ? "" : row.matchesPerTeam}
                          onChange={(event) => update(row.key, { matchesPerTeam: event.target.valueAsNumber })}
                        />
                        {matchesChanged && (
                          <span className="rounds-table__hint">
                            {t("sessions.schedule.rounds.was", { value: row.original!.matchesPerTeam })}
                          </span>
                        )}
                      </>
                    )}
                  </td>
                  <td>
                    {locked ? (
                      formatCycle(row.cycleSeconds)
                    ) : (
                      <span className="schedule-form__duration">
                        <input
                          className={`input schedule-form__number${cycleChanged ? " input--changed" : ""}`}
                          type="number"
                          min={0}
                          step={1}
                          aria-label={t("sessions.schedule.rounds.cycleMinutesLabel", { round: label })}
                          value={minutes}
                          onChange={(event) => update(row.key, { cycleSeconds: event.target.valueAsNumber * 60 + seconds })}
                        />
                        <span aria-hidden="true">{t("sessions.schedule.rounds.minutesUnit")}</span>
                        <input
                          className={`input schedule-form__number${cycleChanged ? " input--changed" : ""}`}
                          type="number"
                          min={0}
                          max={59}
                          step={1}
                          aria-label={t("sessions.schedule.rounds.cycleSecondsLabel", { round: label })}
                          value={seconds}
                          onChange={(event) => {
                            const value = event.target.valueAsNumber;
                            update(row.key, { cycleSeconds: value >= 0 && value <= 59 ? minutes * 60 + value : Number.NaN });
                          }}
                        />
                        <span aria-hidden="true">{t("sessions.schedule.rounds.secondsUnit")}</span>
                        {cycleChanged && (
                          <span className="rounds-table__hint">
                            {t("sessions.schedule.rounds.was", { value: formatCycle(row.original!.cycleSeconds) })}
                          </span>
                        )}
                      </span>
                    )}
                  </td>
                  <td>{planned?.match_count ?? row.scheduled?.match_count ?? "—"}</td>
                  <td>
                    {planned
                      ? when(planned.first_start, planned.last_end)
                      : row.scheduled
                        ? when(row.scheduled.first_start, row.scheduled.last_end)
                        : index > 0
                          ? t("sessions.schedule.rounds.pending", { round: roundTypeLabel(t, rows[index - 1].roundType) })
                          : "—"}
                  </td>
                  <td>
                    {row.scheduled ? (
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={t("sessions.schedule.rounds.clearAriaLabel", { round: label })}
                        onClick={() => onClear(row.scheduled!)}
                      >
                        {t("sessions.schedule.rounds.clearAction")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={t("sessions.schedule.rounds.removeLabel", { round: label })}
                        onClick={() => onRowsChange(rows.filter((other) => other.key !== row.key))}
                      >
                        {t("sessions.schedule.rounds.remove")}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <button
        type="button"
        className="btn btn-small schedule-form__add"
        disabled={addable.length === 0}
        onClick={() =>
          onRowsChange([
            ...rows,
            newRow(addable[0], defaultMatchesPerTeam(addable[0]), cycleFor(rows[rows.length - 1]), nextKey()),
          ])
        }
      >
        {t("sessions.schedule.rounds.add")}
      </button>
    </>
  );
}
```

Create `frontend/apps/admin/src/schedule/FitStatus.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { apiErrorMessage } from "../apiErrorMessage";
import { roundTypeLabel } from "../roundTypeLabel";
import { formatDuration } from "./formatDuration";
import { formatCycle } from "./planDraft";
import { weekdayLabel } from "./playingWindows";
import type { PlanPreview } from "./usePlanPreview";
import type { PlayingWindowRead } from "../types";

interface FitStatusProps {
  preview: PlanPreview;
  windows: PlayingWindowRead[];
  onUseCycle: (seconds: number) => void;
  onExtend: (endTime: string) => void;
  extendPending: boolean;
}

/** Whether the draft fits the playing times and, when it doesn't, the two one-click fixes. */
export function FitStatus({ preview, windows, onUseCycle, onExtend, extendPending }: FitStatusProps) {
  const { t, i18n } = useTranslation();
  if (preview.error) {
    return (
      <p className="alert alert-danger fit-status" role="alert">
        {apiErrorMessage(preview.error, t("errors.generic"))}
      </p>
    );
  }
  const data = preview.data;
  if (!data) {
    return (
      <p className="fit-status" role="status">
        {t("sessions.schedule.fit.checking")}
      </p>
    );
  }
  const stale = preview.settled ? "" : " fit-status--stale";
  if (data.fits) {
    const lastEnd = data.rounds.at(-1)?.last_end;
    const lastEndMs = lastEnd ? Date.parse(lastEnd) : Number.NaN;
    const window = windows.find(
      (w) => w.start_utc && w.end_utc && Date.parse(w.start_utc) <= lastEndMs && lastEndMs <= Date.parse(w.end_utc)
    );
    const freeSeconds = window && lastEnd ? (Date.parse(window.end_utc!) - Date.parse(lastEnd)) / 1000 : 0;
    return (
      <p className={`fit-status fit-status--ok${stale}`} role="status">
        {"✓ "}
        {window && freeSeconds >= 60
          ? t("sessions.schedule.fit.fits", {
              free: formatDuration(t, freeSeconds),
              day: weekdayLabel(window.date, i18n.language),
            })
          : t("sessions.schedule.fit.fitsExactly")}
      </p>
    );
  }
  const overflow = data.overflow!;
  const firstShort = data.rounds.find((round) => round.last_end === null) ?? data.rounds.at(-1)!;
  const last = windows.at(-1)!;
  const day = weekdayLabel(last.date, i18n.language);
  return (
    <div className={`alert alert-warning fit-status${stale}`} role="status">
      <p>
        {"⚠ "}
        {t("sessions.schedule.fit.over", {
          duration: formatDuration(t, overflow.over_by_seconds),
          count: overflow.unplaced_match_count,
          round: roundTypeLabel(t, firstShort.round_type),
          end: `${day} ${last.end_time}`,
        })}
      </p>
      <div className="form-actions">
        {overflow.suggested_cycle_time_seconds !== null && (
          <button type="button" className="btn btn-small" onClick={() => onUseCycle(overflow.suggested_cycle_time_seconds!)}>
            {t("sessions.schedule.fit.useCycle", { cycle: formatCycle(overflow.suggested_cycle_time_seconds) })}
          </button>
        )}
        {overflow.suggested_last_window_end !== null && (
          <button
            type="button"
            className="btn btn-small"
            disabled={extendPending}
            onClick={() => onExtend(overflow.suggested_last_window_end!)}
          >
            {t("sessions.schedule.fit.extend", { day, time: overflow.suggested_last_window_end })}
          </button>
        )}
      </div>
    </div>
  );
}
```

Create `frontend/apps/admin/src/schedule/DivisionPlanner.tsx`:

```tsx
import { useEffect, useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { showTransientError } from "../errorBanner";
import { roundTypeLabel } from "../roundTypeLabel";
import { ClearRoundDialog } from "./ClearRoundDialog";
import { FitStatus } from "./FitStatus";
import { PlanTimeline } from "./PlanTimeline";
import { PlayingTimesPanel } from "./PlayingTimesPanel";
import { RoundsTable } from "./RoundsTable";
import {
  buildPlanRequest,
  isRowChanged,
  planAction,
  plannerRoundTypes,
  rowsToSend,
  rowsValid,
  type PlanRequest,
} from "./planDraft";
import { withLastWindowEnd } from "./playingWindows";
import type { TimelineSpan } from "./timeline";
import { usePlannerDraft } from "./usePlannerDraft";
import { usePlanPreview } from "./usePlanPreview";
import { useUnsavedChangesGuard } from "./useUnsavedChangesGuard";
import type {
  MatchFormat,
  PlanResponse,
  PlayingWindowRead,
  PluginSummary,
  ScheduledRound,
  ScheduleRounds,
  SessionRead,
} from "../types";

interface DivisionPlannerProps {
  session: SessionRead;
  divisionId: number | null;
  matchFormat: MatchFormat;
  windows: PlayingWindowRead[];
  ready: boolean;
  /** When the session's matches last changed, so the rounds refresh with them. */
  matchesUpdatedAt: number;
  onDirtyChange: (dirty: boolean) => void;
}

export function DivisionPlanner({
  session,
  divisionId,
  matchFormat,
  windows,
  ready,
  matchesUpdatedAt,
  onDirtyChange,
}: DivisionPlannerProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const queryClient = useQueryClient();
  const [clearTargets, setClearTargets] = useState<ScheduledRound[] | null>(null);
  const [applied, setApplied] = useState<PlanResponse | null>(null);
  const [schedulerChoice, setSchedulerChoice] = useState("");

  const params = new URLSearchParams({ session_id: String(session.id) });
  if (divisionId !== null) params.set("division_id", String(divisionId));
  const roundsQuery = useQuery({
    queryKey: ["scheduleRounds", session.id, divisionId],
    queryFn: () => apiRequest<ScheduleRounds>(`/api/schedule/rounds?${params.toString()}`),
  });
  useEffect(() => {
    queryClient.invalidateQueries({ queryKey: ["scheduleRounds", session.id] });
  }, [matchesUpdatedAt, queryClient, session.id]);

  const { data: schedulers } = useQuery({
    queryKey: ["plugins", "schedulers"],
    queryFn: () => apiRequest<PluginSummary[]>("/api/plugins/schedulers"),
  });
  const schedulerPluginName =
    schedulerChoice ||
    (schedulers?.some((plugin) => plugin.name === "balanced") ? "balanced" : (schedulers?.[0]?.name ?? ""));

  const draft = usePlannerDraft(roundsQuery.data, matchFormat);
  const toSend = rowsToSend(draft.rows);
  const action = planAction(draft.rows);
  const valid = rowsValid(toSend, matchFormat.match_duration_seconds);
  const dirty = draft.rows.some(isRowChanged);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const guardDialog = useUnsavedChangesGuard(dirty);

  const context = { sessionId: session.id, divisionId, schedulerPluginName };
  const previewRequest =
    ready && action !== "none" && valid && schedulerPluginName
      ? buildPlanRequest(toSend, { ...context, dryRun: true })
      : null;
  const preview = usePlanPreview(previewRequest);

  const apply = useMutation({
    mutationFn: (body: PlanRequest) => apiRequest<PlanResponse>("/api/schedule", { method: "POST", body }),
    onSuccess: (response) => {
      setApplied(response);
      queryClient.invalidateQueries({ queryKey: ["matches", session.id] });
      queryClient.invalidateQueries({ queryKey: ["scheduleRounds", session.id] });
      queryClient.invalidateQueries({ queryKey: ["schedulePlan"] });
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) showTransientError(t("errors.network"));
    },
  });
  const extend = useMutation({
    mutationFn: (endTime: string) =>
      apiRequest(`/api/sessions/${session.id}/playing-windows`, { method: "PUT", body: withLastWindowEnd(windows, endTime) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["playingWindows", session.id] });
      queryClient.invalidateQueries({ queryKey: ["scheduleRounds", session.id] });
      queryClient.invalidateQueries({ queryKey: ["schedulePlan"] });
    },
  });

  const sendKeys = new Set(toSend.map((row) => row.key));
  const spans: TimelineSpan[] = [
    ...draft.rows
      .filter((row) => row.scheduled?.first_start && row.scheduled.last_end && !sendKeys.has(row.key))
      .map((row) => ({
        kind: "scheduled" as const,
        roundType: row.roundType,
        startMs: Date.parse(row.scheduled!.first_start!),
        endMs: Date.parse(row.scheduled!.last_end!),
      })),
    ...(preview.data?.rounds ?? [])
      .filter((round) => round.first_start)
      .map((round) => ({
        kind: "draft" as const,
        roundType: round.round_type,
        startMs: Date.parse(round.first_start!),
        endMs: round.last_end ? Date.parse(round.last_end) : Number.POSITIVE_INFINITY,
      })),
  ];
  const scheduledRounds = roundsQuery.data?.rounds ?? [];
  const primaryDisabled =
    !ready ||
    action === "none" ||
    !valid ||
    !schedulerPluginName ||
    !preview.settled ||
    !preview.data?.fits ||
    apply.isPending ||
    roundsQuery.isFetching;

  return (
    <>
      <PlayingTimesPanel
        session={session}
        windows={windows}
        outsideRounds={scheduledRounds
          .filter((round) => round.outside_playing_windows)
          .map((round) => ({ roundType: round.round_type, locked: round.locked }))}
        timeline={
          <PlanTimeline windows={windows} spans={spans} overBySeconds={preview.data?.overflow?.over_by_seconds ?? 0} />
        }
      />
      {draft.dropped.length > 0 && (
        <p className="alert alert-warning" role="status">
          {t("sessions.schedule.rounds.droppedLocked", {
            rounds: draft.dropped.map((type) => roundTypeLabel(t, type)).join(", "),
          })}
        </p>
      )}
      <section className="panel" aria-labelledby={headingId}>
        <h2 id={headingId}>{t("sessions.schedule.rounds.heading")}</h2>
        {draft.loaded && (
          <RoundsTable
            rows={draft.rows}
            sendKeys={sendKeys}
            preview={preview.data}
            timeZone={session.timezone}
            availableTypes={plannerRoundTypes(matchFormat.round_types)}
            onRowsChange={draft.setRows}
            onClear={(round) => setClearTargets([round])}
            cycleFor={draft.cycleFor}
            nextKey={draft.nextKey}
          />
        )}
        {scheduledRounds.length > 1 && (
          <button type="button" className="btn btn-danger btn-small" onClick={() => setClearTargets(scheduledRounds)}>
            {t("sessions.schedule.rounds.clearAllAction")}
          </button>
        )}
        {previewRequest !== null && (
          <FitStatus
            preview={preview}
            windows={windows}
            extendPending={extend.isPending}
            onUseCycle={(seconds) => {
              const lastKey = toSend[toSend.length - 1].key;
              draft.setRows(draft.rows.map((row) => (row.key === lastKey ? { ...row, cycleSeconds: seconds } : row)));
            }}
            onExtend={(endTime) => extend.mutate(endTime)}
          />
        )}
        {apply.error instanceof ApiError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(apply.error, t("errors.generic"))}
          </p>
        )}
        {schedulers && schedulers.length === 0 && (
          <p className="alert alert-danger">{t("sessions.schedule.noSchedulers")}</p>
        )}
        <div className="form-actions">
          {action === "apply" && (
            <span className="field__hint">
              {t("sessions.schedule.actions.rebuilds", {
                rounds: toSend.filter((row) => row.scheduled).map((row) => roundTypeLabel(t, row.roundType)).join(", "),
              })}
            </span>
          )}
          {dirty && (
            <button type="button" className="btn" onClick={draft.discard}>
              {t("sessions.schedule.actions.discard")}
            </button>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={primaryDisabled}
            onClick={() => apply.mutate(buildPlanRequest(toSend, { ...context, dryRun: false }))}
          >
            {action === "apply" ? t("sessions.schedule.actions.apply") : t("sessions.schedule.actions.generate")}
          </button>
        </div>
        {applied && (
          <p className="alert alert-success" role="status">
            {t("sessions.schedule.actions.applied", {
              count: applied.rounds.reduce((sum, round) => sum + round.match_count, 0),
            })}{" "}
            <Link to={`/sessions/${session.id}/matches`}>{t("sessions.schedule.actions.viewMatches")}</Link>
          </p>
        )}
        <details className="schedule-form__more">
          <summary>{t("sessions.schedule.actions.moreOptions")}</summary>
          <label className="field">
            <span className="field__label">{t("sessions.schedule.actions.schedulerLabel")}</span>
            <select
              className="select"
              value={schedulerPluginName}
              onChange={(event) => setSchedulerChoice(event.target.value)}
            >
              {(schedulers ?? []).map((plugin) => (
                <option key={plugin.name} value={plugin.name}>
                  {plugin.display_name}
                </option>
              ))}
            </select>
          </label>
        </details>
      </section>
      {clearTargets && (
        <ClearRoundDialog
          key={clearTargets.map((round) => round.round_type).join(",")}
          sessionId={session.id}
          divisionId={divisionId}
          targets={clearTargets}
          onDone={() => setClearTargets(null)}
        />
      )}
      {guardDialog}
    </>
  );
}
```

- [ ] **Step 4: Rewrite the route**

Replace `frontend/apps/admin/src/routes/SessionScheduleRoute.tsx` with:

```tsx
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DivisionPlanner } from "../schedule/DivisionPlanner";
import { DivisionTabs } from "../schedule/DivisionTabs";
import { OutOfScopeRounds } from "../schedule/OutOfScopeRounds";
import { ReadinessChecklist } from "../schedule/ReadinessChecklist";
import { checkReadiness, countCheckedInTeams, countUsableFields } from "../schedule/readiness";
import { summarizeOutOfScopeRounds } from "../schedule/roundSummary";
import { useSessionMatches } from "../useSessionMatches";
import type {
  Division,
  EventRead,
  FieldRead,
  FieldSetRead,
  MatchFormat,
  ParticipationRead,
  PlayingWindowRead,
  SessionRead,
  TeamSummary,
} from "../types";

export function SessionScheduleRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const [selectedDivisionId, setSelectedDivisionId] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pendingDivisionId, setPendingDivisionId] = useState<number | null>(null);

  const { data: divisions, isError: divisionsError } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { data: event } = useQuery({ queryKey: ["event"], queryFn: () => apiRequest<EventRead>("/api/event") });
  const { data: matchFormat, isError: matchFormatError } = useQuery({
    queryKey: ["matchFormat"],
    queryFn: () => apiRequest<MatchFormat>("/api/event/match-format"),
    enabled: Boolean(event?.game_plugin_name),
  });
  const { data: teams } = useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") });
  const { data: participants } = useQuery({
    queryKey: ["participants", session.id],
    queryFn: () => apiRequest<ParticipationRead[]>(`/api/sessions/${session.id}/participants`),
  });
  const { data: fieldSets } = useQuery({
    queryKey: ["fieldSets", session.id],
    queryFn: () => apiRequest<FieldSetRead[]>(`/api/field-sets?session_id=${session.id}`),
  });
  const { data: fields } = useQuery({
    queryKey: ["fields", session.id],
    queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${session.id}`),
  });
  const { data: windows } = useQuery({
    queryKey: ["playingWindows", session.id],
    queryFn: () => apiRequest<PlayingWindowRead[]>(`/api/sessions/${session.id}/playing-windows`),
  });
  const { data: matches, dataUpdatedAt: matchesUpdatedAt } = useSessionMatches(session.id);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);

  if (divisionsError) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (divisions === undefined) return null;

  // A single-division event schedules with no division_id at all: the
  // backend then uses unassigned FieldSets and the sole division's teams.
  const multiDivision = divisions.length > 1;
  const divisionId = multiDivision ? (selectedDivisionId ?? divisions[0].id) : null;

  const readiness = checkReadiness({
    gamePluginSelected: Boolean(event?.game_plugin_name),
    sessionTimezone: session.timezone,
    playingWindowCount: windows?.length ?? 0,
    checkedInTeamCount: countCheckedInTeams(teams ?? [], participants ?? [], divisionId),
    teamsNeeded: matchFormat ? matchFormat.teams_per_alliance * matchFormat.alliance_count : 0,
    usableFieldCount: countUsableFields(fieldSets ?? [], fields ?? [], divisionId),
  });
  const ready = readiness.every((item) => item.ok);
  // Listing blockers before their data arrives would flash false warnings.
  const readinessLoaded =
    event !== undefined &&
    teams !== undefined &&
    participants !== undefined &&
    fieldSets !== undefined &&
    fields !== undefined &&
    windows !== undefined &&
    (!event.game_plugin_name || matchFormat !== undefined);
  const outOfScopeRounds = summarizeOutOfScopeRounds(matches ?? [], multiDivision);

  function selectDivision(id: number) {
    if (id === divisionId) return;
    if (dirty) setPendingDivisionId(id);
    else setSelectedDivisionId(id);
  }

  const planner =
    matchFormat && windows ? (
      <DivisionPlanner
        key={divisionId ?? "none"}
        session={session}
        divisionId={divisionId}
        matchFormat={matchFormat}
        windows={windows}
        ready={ready}
        matchesUpdatedAt={matchesUpdatedAt}
        onDirtyChange={onDirtyChange}
      />
    ) : event?.game_plugin_name && matchFormatError ? (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    ) : event && !event.game_plugin_name ? (
      <p className="field__hint">{t("sessions.schedule.needsGamePlugin")}</p>
    ) : null;

  return (
    <div className="session-schedule">
      {readinessLoaded && <ReadinessChecklist items={readiness} sessionId={session.id} />}
      {multiDivision && (
        <DivisionTabs
          divisions={divisions}
          counts={new Map(divisions.map((d) => [d.id, countCheckedInTeams(teams ?? [], participants ?? [], d.id)]))}
          selectedId={divisionId!}
          onSelect={selectDivision}
        />
      )}
      <OutOfScopeRounds sessionId={session.id} divisions={divisions} rounds={outOfScopeRounds} />
      {multiDivision ? (
        <div role="tabpanel" id="division-panel" aria-labelledby={`division-tab-${divisionId}`}>
          {planner}
        </div>
      ) : (
        planner
      )}
      {pendingDivisionId !== null && (
        <ConfirmDialog
          heading={t("sessions.schedule.discardHeading")}
          body={t("sessions.schedule.discardBody")}
          confirmLabel={t("sessions.schedule.discardConfirm")}
          cancelLabel={t("sessions.schedule.keepEditing")}
          onConfirm={() => {
            setSelectedDivisionId(pendingDivisionId);
            setPendingDivisionId(null);
            setDirty(false);
          }}
          onCancel={() => setPendingDivisionId(null)}
        />
      )}
    </div>
  );
}
```

Delete `src/schedule/ScheduleForm.tsx`, `src/schedule/PreviewPanel.tsx`, `src/schedule/CurrentRounds.tsx`, `src/schedule/scheduleRequest.ts` and `tests/unit/scheduleRequest.test.ts`. In `src/types.ts` delete `ResolvedTimeBlock`, `PhaseResult` and `ScheduleGenerateResponse`. If `OutOfScopeRounds.tsx` imports anything from the deleted files, switch it to `ClearRoundDialog` or the moved helpers. Confirm nothing else references them: `grep -rn "scheduleRequest\|ScheduleForm\|PreviewPanel\|CurrentRounds\|ScheduleGenerateResponse\|schedule.form\.\|schedule.preview\." src tests` must print nothing.

- [ ] **Step 5: Rewrite the route tests**

Replace `frontend/apps/admin/tests/unit/SessionScheduleRoute.test.tsx`. Keep its existing imports, `vi.mock`, `SESSION`, `ONE_DIVISION`, `TWO_DIVISIONS`, `EVENT`, `TEAMS`, `PARTICIPANTS`, `MAIN_SET`, `FIELD_A`, `SCHEDULERS`, `scheduleMatch`, `SessionOutlet` and `beforeEach`. Change `MATCH_FORMAT` to add `default_cycle_time_seconds: null`, and replace `stub`/`renderSchedule` and every `describe` block with:

```tsx
const WINDOWS = [
  { date: "2026-11-07", start_time: "09:00", end_time: "12:00", start_utc: "2026-11-07T17:00:00Z", end_utc: "2026-11-07T20:00:00Z" },
];

function round(overrides: Partial<ScheduledRound>): ScheduledRound {
  return {
    round_type: "practice",
    target_matches_per_team: 1,
    cycle_time_seconds: 420,
    match_count: 2,
    scored_count: 0,
    first_start: "2026-11-07T17:00:00Z",
    last_end: "2026-11-07T17:09:00Z",
    locked: false,
    outside_playing_windows: false,
    ...overrides,
  };
}

const FITS: PlanResponse = {
  fits: true,
  rounds: [
    { round_type: "practice", schedule_generation_id: null, match_count: 2, slot_count: 1, first_start: "2026-11-07T17:00:00Z", last_end: "2026-11-07T17:02:00Z" },
    { round_type: "qualification", schedule_generation_id: null, match_count: 12, slot_count: 6, first_start: "2026-11-07T17:03:00Z", last_end: "2026-11-07T17:40:00Z" },
  ],
  overflow: null,
};

const OVER: PlanResponse = {
  fits: false,
  rounds: [{ round_type: "qualification", schedule_generation_id: null, match_count: 16, slot_count: 8, first_start: "2026-11-07T17:12:00Z", last_end: null }],
  overflow: { unplaced_slot_count: 2, unplaced_match_count: 3, over_by_seconds: 960, suggested_cycle_time_seconds: 410, suggested_last_window_end: "12:16" },
};

interface StubOptions {
  divisions?: Division[];
  windows?: typeof WINDOWS;
  rounds?: ScheduledRound[] | (() => ScheduledRound[]);
  fields?: FieldRead[];
  plan?: (body: PlanRequest) => PlanResponse | Error;
  onWrite?: (path: string, options: { method?: string; body?: unknown }) => unknown;
}

function stub({
  divisions = ONE_DIVISION,
  windows = WINDOWS,
  rounds = [],
  fields = [FIELD_A],
  plan = () => FITS,
  onWrite = () => undefined,
}: StubOptions = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = (options ?? {}) as { method?: string; body?: unknown };
    if (path === "/api/schedule" && opts.method === "POST") {
      const body = opts.body as PlanRequest;
      if (!body.dry_run) {
        const written = onWrite(path, opts);
        if (written instanceof Error) throw written;
        return (written ?? FITS) as never;
      }
      const result = plan(body);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (opts.method && opts.method !== "GET") {
      const result = onWrite(path, opts);
      if (result instanceof Error) throw result;
      return result as never;
    }
    if (path === "/api/divisions") return divisions as never;
    if (path === "/api/event") return EVENT as never;
    if (path === "/api/event/match-format") return MATCH_FORMAT as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path === "/api/sessions/1/participants") return PARTICIPANTS as never;
    if (path === "/api/field-sets?session_id=1") return [MAIN_SET] as never;
    if (path === "/api/fields?session_id=1") return fields as never;
    if (path === "/api/matches?session_id=1") return [] as never;
    if (path === "/api/plugins/schedulers") return SCHEDULERS as never;
    if (path === "/api/sessions/1/playing-windows") return windows as never;
    if (path.startsWith("/api/schedule/rounds?session_id=1")) {
      return { rounds: typeof rounds === "function" ? rounds() : rounds, session_last_cycle_time_seconds: null } as never;
    }
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderSchedule() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    {
      path: "/",
      element: <SessionOutlet />,
      children: [
        { index: true, element: <SessionScheduleRoute /> },
        { path: "elsewhere", element: <p>Elsewhere</p> },
      ],
    },
  ]);
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
  return { router, queryClient };
}

function dryRuns(): PlanRequest[] {
  return vi
    .mocked(apiRequest)
    .mock.calls.filter(([path, options]) => path === "/api/schedule" && (options as { body?: PlanRequest })?.body?.dry_run)
    .map(([, options]) => (options as { body: PlanRequest }).body);
}

describe("SessionScheduleRoute — planning", () => {
  it("pre-fills Practice and Qualification with the fallback cycle time and checks the plan", async () => {
    stub();
    renderSchedule();
    expect(await screen.findByLabelText("Practice matches per team")).toHaveValue(1);
    expect(screen.getByLabelText("Qualification matches per team")).toHaveValue(6);
    expect(screen.getByLabelText("Practice cycle time minutes")).toHaveValue(4);
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    expect(dryRuns().at(-1)).toEqual({
      session_id: 1,
      scheduler_plugin_name: "balanced",
      rounds: [
        { round_type: "practice", target_matches_per_team: 1, cycle_time_seconds: 240 },
        { round_type: "qualification", target_matches_per_team: 6, cycle_time_seconds: 240 },
      ],
      dry_run: true,
    });
    expect(screen.getByRole("status")).toHaveTextContent("Fits, with 2 h 20 min of Sat still free.");
  });

  it("shows no tabs in a single-division event", async () => {
    stub();
    renderSchedule();
    await screen.findByLabelText("Practice matches per team");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("generates the plan and links to the matches", async () => {
    const writes: PlanRequest[] = [];
    stub({ onWrite: (_path, options) => void writes.push(options.body as PlanRequest) });
    renderSchedule();
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].dry_run).toBe(false);
    expect(await screen.findByText(/14 matches scheduled\./)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View matches" })).toHaveAttribute("href", "/sessions/1/matches");
  });

  it("marks an edited round as changed and sends it with every round after it", async () => {
    stub({ rounds: [round({}), round({ round_type: "qualification", target_matches_per_team: 6 })] });
    renderSchedule();
    const practice = await screen.findByLabelText("Practice matches per team");
    expect(screen.queryByRole("button", { name: /Apply changes|Generate/ })).toBeDisabled();
    fireEvent.change(practice, { target: { value: "2" } });
    expect(screen.getByText("changed")).toBeInTheDocument();
    expect(screen.getByText("was 1")).toBeInTheDocument();
    expect(screen.getByText("Rebuilds Practice, Qualification.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
    expect(dryRuns().at(-1)?.rounds.map((r) => r.round_type)).toEqual(["practice", "qualification"]);
  });

  it("explains an overflow and applies the suggested cycle time", async () => {
    stub({
      rounds: [round({ round_type: "qualification", target_matches_per_team: 6 })],
      plan: (body) => (body.rounds[0].cycle_time_seconds === 410 ? FITS : OVER),
    });
    renderSchedule();
    fireEvent.change(await screen.findByLabelText("Qualification matches per team"), { target: { value: "8" } });
    expect(await screen.findByText(/Over by 16 min: 3 Qualification matches don't fit before Sat 12:00\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply changes" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use cycle time 6:50" }));
    expect(screen.getByLabelText("Qualification cycle time minutes")).toHaveValue(6);
    expect(screen.getByLabelText("Qualification cycle time seconds")).toHaveValue(50);
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
  });

  it("re-checks the plan after Extend", async () => {
    let extended = false;
    stub({
      rounds: [round({ round_type: "qualification", target_matches_per_team: 6 })],
      plan: () => (extended ? FITS : OVER),
      onWrite: (path) => {
        if (path === "/api/sessions/1/playing-windows") extended = true;
        return [];
      },
    });
    renderSchedule();
    fireEvent.change(await screen.findByLabelText("Qualification matches per team"), { target: { value: "8" } });
    fireEvent.click(await screen.findByRole("button", { name: "Extend Sat to 12:16" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply changes" })).toBeEnabled());
  });

  it("locks a scored round and only offers Clear", async () => {
    stub({ rounds: [round({ locked: true, scored_count: 1 }), round({ round_type: "qualification" })] });
    renderSchedule();
    await screen.findByLabelText("Qualification matches per team");
    expect(screen.queryByLabelText("Practice matches per team")).not.toBeInTheDocument();
    expect(screen.getByText(/1 scored/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear Practice" })).toBeInTheDocument();
  });

  it("requires typing the round name to clear a round with scored matches", async () => {
    stub({ rounds: [round({ locked: true, scored_count: 1 })], onWrite: () => ({ matches_deleted: 2 }) });
    renderSchedule();
    fireEvent.click(await screen.findByRole("button", { name: "Clear Practice" }));
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("button", { name: "Clear" })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Type "Practice" to confirm'), { target: { value: "Practice" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/schedule?session_id=1&round_type=practice", { method: "DELETE" })
    );
  });

  it("asks before leaving with unapplied changes", async () => {
    stub({ rounds: [round({})] });
    const { router } = renderSchedule();
    fireEvent.change(await screen.findByLabelText("Practice matches per team"), { target: { value: "3" } });
    await act(() => router.navigate("/elsewhere"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(screen.getByLabelText("Practice matches per team")).toHaveValue(3);
  });
});

describe("SessionScheduleRoute — readiness and divisions", () => {
  it("lists a missing playing time as a blocker, with the editor open", async () => {
    stub({ windows: [] });
    renderSchedule();
    const blockers = await screen.findByRole("region", { name: "Can't schedule yet" });
    expect(within(blockers).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "This session has no playing times. Add playing times",
    ]);
    expect(screen.getByLabelText("Playing time 1 date")).toHaveValue("2026-11-07");
  });

  it("lists only what blocks scheduling, each with a link to fix it", async () => {
    stub({ fields: [] });
    renderSchedule();
    const blockers = await screen.findByRole("region", { name: "Can't schedule yet" });
    expect(within(blockers).getByRole("link", { name: "Add fields" })).toHaveAttribute("href", "/sessions/1/fields");
  });

  it("shows a tab per division with its team count, and scopes requests to the selected one", async () => {
    stub({ divisions: TWO_DIVISIONS });
    renderSchedule();
    expect(await screen.findByRole("tab", { name: "Division 1 · 4 teams" })).toHaveAttribute("aria-selected", "true");
    fireEvent.click(screen.getByRole("tab", { name: "Blue · 0 teams" }));
    await waitFor(() =>
      expect(vi.mocked(apiRequest).mock.calls.some(([path]) => path === "/api/schedule/rounds?session_id=1&division_id=2")).toBe(true)
    );
  });

  it("asks before switching division with unapplied changes", async () => {
    stub({ divisions: TWO_DIVISIONS, rounds: [round({})] });
    renderSchedule();
    fireEvent.change(await screen.findByLabelText("Practice matches per team"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("tab", { name: "Blue · 0 teams" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("tab", { name: "Division 1 · 4 teams" })).toHaveAttribute("aria-selected", "true");
  });

  it("shows the generic error when the divisions fetch fails", async () => {
    vi.mocked(apiRequest).mockRejectedValue(new ApiError(500, "boom"));
    renderSchedule();
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
  });
});
```

Add `act` to the `@testing-library/react` import and import `PlanRequest` from `../../src/schedule/planDraft` and `PlanResponse`, `ScheduledRound` from `../../src/types`. Keep the existing out-of-scope tests from the old "scope changes and failures" block (`lists a round generated for a division …`, `lists a no-division round …`, `shows no out-of-scope panel …`), adding `stub` options they need and replacing any `"Preview"` waits with `await screen.findByLabelText("Practice matches per team")`. If the generic error string in `en/admin.json`'s `errors.generic` isn't "Something went wrong", use its actual text.

- [ ] **Step 6: Run the frontend suite**

Run: `cd frontend/apps/admin && npx vitest run && npx tsc --noEmit -p .`
Expected: PASS, type check clean.

- [ ] **Step 7: Commit**

```bash
git add -A frontend/apps/admin/src frontend/apps/admin/tests/unit
git commit -m "Rebuild the Schedule tab as a live round planner

Division tabs, the session's playing times with a timeline of each
round, and a rounds table whose edits are checked live against the
server and applied by rebuilding the changed round and those after it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: End-to-end tests

**Files:**
- Modify: `frontend/apps/admin/tests/e2e/z_sessionSchedule.spec.ts`

**Interfaces:**
- Consumes: the whole stack. The E2E event uses the example game: 2 teams per alliance, 2 alliances, 120-second matches, no default cycle time (so new rows default to 4:00).

- [ ] **Step 1: Rewrite the spec**

Keep the file's header comment, `token`/`headers`, `uploadPlugin`, `createReadySession`, `loginAsAdmin` and the `beforeAll`. Add these helpers after `createReadySession`:

```ts
async function addField(request: APIRequestContext, sessionId: number, name: string) {
  const response = await request.post("/api/fields", { headers: headers(), data: { session_id: sessionId, name } });
  expect(response.ok()).toBeTruthy();
}

async function setWindows(request: APIRequestContext, sessionId: number, windows: [string, string, string][]) {
  const response = await request.put(`/api/sessions/${sessionId}/playing-windows`, {
    headers: headers(),
    data: { windows: windows.map(([date, start_time, end_time]) => ({ date, start_time, end_time })) },
  });
  expect(response.ok()).toBeTruthy();
}

async function scheduleViaApi(request: APIRequestContext, sessionId: number, rounds: [string, number][]) {
  const response = await request.post("/api/schedule", {
    headers: headers(),
    data: {
      session_id: sessionId,
      scheduler_plugin_name: "balanced",
      rounds: rounds.map(([round_type, target_matches_per_team]) => ({ round_type, target_matches_per_team, cycle_time_seconds: 240 })),
    },
  });
  expect(response.status()).toBe(201);
}

async function scoreFirstMatch(request: APIRequestContext, sessionId: number, roundType: string) {
  const matches = await (await request.get(`/api/matches?session_id=${sessionId}`, { headers: headers() })).json();
  const match = matches.find((m: { round_type: string }) => m.round_type === roundType);
  for (const alliance of match.alliances) {
    const scored = await request.post(`/api/matches/${match.id}/alliances/${alliance.id}/score`, {
      headers: headers(),
      data: { data: { high_balls: 5, low_balls: 2, auto_winner: "tie" } },
    });
    expect(scored.ok()).toBeTruthy();
  }
}
```

Replace the tests inside `test.describe.serial` with:

```ts
  test("set playing times, generate across a break, and see the times in Matches", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/fields`);
    await page.getByLabel("Add your first field").fill("Field A");
    await page.getByRole("button", { name: "Add field", exact: true }).click();
    const card = page.getByRole("region", { name: "Main Fields" });
    await expect(card.getByText("Field A")).toBeVisible();
    await card.getByLabel("New field name for Main Fields").fill("Field B");
    await card.getByRole("button", { name: "Add field", exact: true }).click();
    await expect(card.getByText("Field B")).toBeVisible();

    await page.getByRole("link", { name: "Schedule" }).click();
    const blockers = page.getByRole("region", { name: "Can't schedule yet" });
    await expect(blockers.getByRole("link", { name: "Add playing times" })).toBeVisible();

    await page.getByLabel("Playing time 1 date").fill("2026-11-07");
    await page.getByLabel("Playing time 1 start").fill("09:00");
    await page.getByLabel("Playing time 1 end").fill("09:15");
    await page.getByRole("button", { name: "Add playing time" }).click();
    await page.getByLabel("Playing time 2 start").fill("10:00");
    await page.getByLabel("Playing time 2 end").fill("12:00");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Sat 09:00–09:15, 10:00–12:00")).toBeVisible();
    await expect(blockers).toHaveCount(0);

    await expect(page.getByLabel("Practice matches per team")).toHaveValue("1");
    await expect(page.getByLabel("Qualification matches per team")).toHaveValue("6");
    await expect(page.getByText(/^✓ Fits/)).toBeVisible();
    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText(/^\d+ matches scheduled\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear Qualification" })).toBeVisible();
    // Qualification can't all fit before 09:15, so it continues after the break.
    const qualificationRow = page.getByRole("row", { name: /Qualification/ });
    await expect(qualificationRow).toContainText(/10:\d\d/);

    await page.getByRole("link", { name: "View matches" }).click();
    await expect(page.getByRole("gridcell", { name: "P1", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "09:00", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "10:00", exact: true })).toBeVisible();
  });

  test("an edit that overflows is fixed with the suggested cycle time and applied", async ({ page, request }) => {
    const session = await createReadySession(request, "Overflow E2E", "OVF");
    await addField(request, session.sessionId, "Overflow Field");
    await setWindows(request, session.sessionId, [["2026-11-07", "09:00", "11:00"]]);
    await scheduleViaApi(request, session.sessionId, [["qualification", 4]]);

    await loginAsAdmin(page);
    await page.goto(`/sessions/${session.sessionId}/schedule`);
    // 25 per team on one field is 50 slots: about 3 h 20 min at 4:00, in a 2-hour window.
    await page.getByLabel("Qualification matches per team").fill("25");
    await expect(page.getByText("changed")).toBeVisible();
    await expect(page.getByText(/^⚠ Over by/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Apply changes" })).toBeDisabled();
    await page.getByRole("button", { name: /^Use cycle time / }).click();
    await expect(page.getByText(/^✓ Fits/)).toBeVisible();
    await page.getByRole("button", { name: "Apply changes" }).click();
    await expect(page.getByText(/^\d+ matches scheduled\./)).toBeVisible();
    await expect(page.getByText("changed")).toHaveCount(0);
  });

  test("an edit that overflows is fixed by extending the day", async ({ page, request }) => {
    const session = await createReadySession(request, "Extend E2E", "EXT");
    await addField(request, session.sessionId, "Extend Field");
    await setWindows(request, session.sessionId, [["2026-11-07", "09:00", "10:00"]]);
    await scheduleViaApi(request, session.sessionId, [["qualification", 2]]);

    await loginAsAdmin(page);
    await page.goto(`/sessions/${session.sessionId}/schedule`);
    await page.getByLabel("Qualification matches per team").fill("12");
    await page.getByRole("button", { name: /^Extend Sat to / }).click();
    await expect(page.getByText(/^✓ Fits/)).toBeVisible();
    await expect(page.getByText(/^Sat 09:00–1\d:\d\d$/)).toBeVisible();
    await page.getByRole("button", { name: "Apply changes" }).click();
    await expect(page.getByText(/^\d+ matches scheduled\./)).toBeVisible();
  });

  test("a scored round is locked while the round after it stays editable", async ({ page, request }) => {
    const session = await createReadySession(request, "Locked E2E", "LCK");
    await addField(request, session.sessionId, "Locked Field");
    await setWindows(request, session.sessionId, [["2026-11-07", "09:00", "17:00"]]);
    await scheduleViaApi(request, session.sessionId, [["practice", 1], ["qualification", 2]]);
    await scoreFirstMatch(request, session.sessionId, "practice");

    await loginAsAdmin(page);
    await page.goto(`/sessions/${session.sessionId}/schedule`);
    await expect(page.getByText("1 scored")).toBeVisible();
    await expect(page.getByLabel("Practice matches per team")).toHaveCount(0);
    await expect(page.getByLabel("Qualification matches per team")).toBeEditable();

    await page.getByRole("button", { name: "Clear Practice" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("button", { name: "Clear" })).toBeDisabled();
    await dialog.getByLabel('Type "Practice" to confirm').fill("Practice");
    await dialog.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByRole("button", { name: "Clear Practice" })).toHaveCount(0);
  });

  test("leaving with unapplied changes asks first", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/schedule`);
    await page.getByLabel("Qualification matches per team").fill("7");
    await page.getByRole("link", { name: "Matches", exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByText("Leave without applying?")).toBeVisible();
    await dialog.getByRole("button", { name: "Stay" }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${main.sessionId}/schedule$`));
    await expect(page.getByLabel("Qualification matches per team")).toHaveValue("7");
  });

  test("deleting a field that has matches shows the server's refusal", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/fields`);
    await page.getByRole("button", { name: "Remove field Field A" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByRole("region", { name: "Main Fields" }).getByRole("alert")).toHaveText(
      "Field has scheduled matches; clear the schedule first"
    );
  });

  test("the checklist blocks generating when the division has no fields", async ({ page, request }) => {
    const bare = await createReadySession(request, "No Fields E2E", "NOF");
    await setWindows(request, bare.sessionId, [["2026-11-07", "09:00", "12:00"]]);
    await loginAsAdmin(page);
    await page.goto(`/sessions/${bare.sessionId}/schedule`);
    const blockers = page.getByRole("region", { name: "Can't schedule yet" });
    await expect(blockers.getByRole("listitem")).toHaveCount(1);
    await expect(blockers.getByRole("link", { name: "Add fields" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Generate" })).toBeDisabled();
  });
```

Keep the existing "two divisions each generate on their own field set" test, with these changes:
- After creating the field sets, call `await setWindows(request, sessionId, [["2026-11-07", "09:00", "17:00"]]);`.
- Replace the `page.getByLabel("Division")…toHaveText("E2E Blue (8 teams checked in)")` assertion with `await expect(page.getByRole("tab", { name: "E2E Blue · 8 teams" })).toBeVisible();`.
- Replace each `page.getByLabel("Division").selectOption(String(first.id))` on the Schedule tab with `page.getByRole("tab", { name: new RegExp(`^${first.name} · `) }).click()`, and likewise for `second` (the Matches tab still uses its own `Division` select — leave that line).
- Replace `await expect(page.getByText("No rounds have been generated yet.")).toBeVisible();` with `await expect(page.getByLabel("Practice matches per team")).toHaveValue("1");`.
- Wait for `await expect(page.getByText(/^✓ Fits/)).toBeVisible();` before each `Generate` click.

- [ ] **Step 2: Run the E2E suite**

Run: `cd frontend/apps/admin && npm run test:e2e`
Expected: PASS for every spec file (the schedule spec runs last). If the "generate across a break" test finds Qualification fitting entirely before 09:15 (because the balanced scheduler used fewer slots than expected), shorten the first window to 09:10 rather than loosening the assertion.

- [ ] **Step 3: Commit**

```bash
git add frontend/apps/admin/tests/e2e/z_sessionSchedule.spec.ts
git commit -m "Cover the schedule planner end to end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Frontend docs and full verification

**Files:**
- Modify: `frontend/CLAUDE.md`

- [ ] **Step 1: Update the Schedule tab paragraph**

In `frontend/CLAUDE.md`'s "Routes and role-gated nav" section, replace the paragraph beginning "The Schedule tab is split so the risky logic is unit-testable without rendering" with:

> The Schedule tab is a live planner. `src/schedule/planDraft.ts` (rows, change detection, what Apply sends — the first new/changed/needs-rebuild row and every row after it — default cycle times, and merging a server refresh into the draft), `playingWindows.ts` and `timeline.ts` are pure and unit-tested. `SessionScheduleRoute` loads session-wide data, shows readiness blockers and the division tabs, and renders one `DivisionPlanner` per division (keyed by division, so switching tabs resets its draft after a discard prompt). `DivisionPlanner` owns the draft (`usePlannerDraft`), sends it as a dry run 400 ms after the last edit (`usePlanPreview`, keyed by the request body), and renders `PlayingTimesPanel` (with `PlanTimeline`), `RoundsTable`, `FitStatus` and the Generate/Apply button, which stays disabled until the latest dry run says the plan fits. Anything that changes playing times invalidates `["schedulePlan"]` too, because an identical request body would otherwise reuse a stale answer. `useUnsavedChangesGuard` uses the data router's `useBlocker` plus `beforeunload`. A single-division event never sends `division_id`; a multi-division event always sends the selected one. `useSessionMatches` (`src/useSessionMatches.ts`) is the one `["matches", sessionId]` query both the Schedule and Matches tabs share, kept live off `/ws/session/{id}`; `DELETE /api/schedule` broadcasts nothing, so anything that clears a round invalidates that key itself. Match times always render in the session's timezone (`src/matchTime.ts`), never the browser's.

- [ ] **Step 2: Run everything**

Run:
```bash
cd server && .venv/bin/python -m pytest -q
cd ../frontend/apps/admin && npx vitest run && npx tsc --noEmit -p . && npm run test:e2e
```
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add frontend/CLAUDE.md
git commit -m "Document the schedule planner's frontend structure

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
