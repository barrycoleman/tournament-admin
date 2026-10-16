# Display Groups and Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Paired displays follow audience, field or pit groups per session and show kiosk screens (the field's next match and timer, the audience screen an admin picks, pit rotations), driven by a new Match Control page and set up on a new Displays page.

**Architecture:** The server stores each group's state (`display_groups`, `display_assignments`, two new `field_sets` columns), validates screens against one registry, flips audience groups to In Match when a match starts, and broadcasts small `display_changed` / `field_set_changed` / `display_identify` events. The device app, in display mode, reads `GET /api/displays/me` and mounts one self-contained module per screen; each module fetches its own data from existing REST endpoints and refreshes on existing live events. Pure match-order and clock logic lives in `packages/shared` so the admin's Match Control page and the device app agree.

**Tech Stack:** FastAPI, SQLAlchemy, SQLite, Alembic baseline edited in place, pytest; React 19, TypeScript, Vite, TanStack Query 5, react-i18next, Vitest + Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-display-groups-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere: code, comments, tests, commit messages, docs, UI text. Reference screenshots stay outside the repo.
- Until the first release the schema changes by editing `server/src/tournament_server/_alembic/versions/000000000001_baseline.py` in place; never add a revision. `tests/test_alembic_drift.py` must stay green.
- Every backend change ships with pytest in the same task; every UI change ships with Vitest in the same task; Playwright covers the golden path in Task 15.
- Every user-facing string goes through i18n, in English and Chinese (`frontend/apps/device/src/i18n/{en,zh}/device.json`, `frontend/apps/admin/src/i18n/{en,zh}/admin.json`).
- Exact values from the spec: time-out 10–600 s, default 180; rotation entry seconds 5–300, default 20; Upcoming Matches `count` 1–20, default 3, `scope` `field_set` or `division` (pit groups: `division` only); start-time colour green above 30 s, yellow from 30 s to 0, red after; new audience groups start on `logo`, new pit groups on `teamwork_rankings`; identify shows for 10 s; the server clock is re-measured every 10 minutes.
- Screen keys, exactly: `match_intro`, `in_match`, `last_scored_match`, `teamwork_rankings`, `skills_rankings`, `upcoming_matches`, `match_results`, `schedule`, `elimination_bracket`, `logo`. Audience-only: `match_intro`, `in_match`, `last_scored_match`. Scrolling: `teamwork_rankings`, `skills_rankings`, `match_results`, `schedule`.
- Live events, exactly: `display_changed {session_id, group_id}`, `field_set_changed {field_set_id}` (both on the active-session channel), `display_identify {device_id}` (only that device's sockets).
- Work in the main checkout on branch `display-groups`. No worktrees. Commit only the files your task names. Do not push.
- Do not open a running server's tournament database with sqlite.
- Commit messages are plain sentences describing the change, ending with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands: server tests `cd server && .venv/bin/pytest -q <paths>`; shared `cd frontend/packages/shared && npx vitest run <paths>`; device `cd frontend/apps/device && npx vitest run <paths>` and `npx tsc -b`; admin `cd frontend/apps/admin && npx vitest run <paths>` and `npx tsc -b`; E2E `cd frontend/apps/admin && npx playwright test tests/e2e/displays.spec.ts`.

## Review Focus

1. **A TV whose clock is minutes off.** Countdowns and the green/yellow/red bands must use server time, not the TV's clock — Task 7 tests `useServerClock` against a skewed `Date.now`, Task 8 tests the band on a skewed clock.
2. **A field whose matches mix scheduled qualification matches and unscheduled finals games.** Timed matches come first by time, untimed ones after by id, and an untimed match shows "Up next" — Task 6 tests the ordering, Task 8 the "Up next" state.
3. **A stale next-match override** (its match was started, scored or deleted by another admin). The server clears it (Task 4), and the shared next-match function ignores an override that is no longer on the field group or no longer unstarted (Task 6 test).
4. **A display moved to another group, or the active session changed, while it shows a screen.** It must re-read its setup and switch at once — Task 7 tests that `display_changed` and `active_session_changed` refetch `me` and swap the screen.
5. **A list screen inside a rotation whose list fits on screen.** It never scrolls, so it must still move on after the entry's `seconds` instead of waiting forever — Task 10 tests `useAutoScroll`'s fit timer, Task 12 tests the rotation advancing past a fitting list.

---

## File map

**Server (`server/src/tournament_server/`)**
- `models/display.py` (new): `DisplayGroup`, `DisplayAssignment`.
- `models/field_set.py`: `queued_match_id`, `timeout_deadline`.
- `services/displays.py` (new): group lifecycle, naming, ordering, assignments, match-start switch, override clearing, copy displays.
- `services/display_screens.py` (new): the screen registry and settings/rotation validation.
- `schemas/display.py` (new): request and response models.
- `routers/displays.py` (new): `/api/displays...` and `/api/sessions/{id}/copy-displays`.
- `routers/field_sets.py`, `routers/fields.py`, `routers/sessions.py`, `routers/divisions.py`, `services/deletion.py`, `app.py`: lifecycle hooks and self-heal.
- `routers/matches.py`, `routers/scores.py`: start guard, automatic switch, override clearing, `GET /api/scores`.
- `routers/finals.py`: `GET /api/finals`. `routers/event.py`: `GET /api/event/scoresheet-schema`, richer match format.
- `routers/devices.py`, `schemas/device.py`: assignment cleanup and `display_group` on `DeviceRead`.
- `realtime.py`: `send_to_device`.

**Shared (`frontend/packages/shared/src/display/`)**: `types.ts`, `screens.ts`, `matchOrder.ts`, `clock.ts`, `index.ts`.

**Device app (`frontend/apps/device/src/`)**: `deviceApi.ts`, `useDeviceSocket.ts`, `App.tsx`, `display/*` (root, API hooks, events, clock, components, screens, rotation, sounds), `styles/display.css`, i18n.

**Admin app (`frontend/apps/admin/src/`)**: `matchControl/*`, `displays/*`, `routes/MatchControlRoute.tsx`, `routes/DisplaysRoute.tsx`, `routes/DevicesRoute.tsx`, `components/AppShell.tsx`, `router.tsx`, i18n.

**E2E**: `frontend/apps/admin/tests/e2e/displays.spec.ts` (ports 8133 / 5194 / 5195).

---

### Task 1: Display group tables and their lifecycle

**Files:**
- Create: `server/src/tournament_server/models/display.py`
- Modify: `server/src/tournament_server/models/__init__.py`, `server/src/tournament_server/models/field_set.py`
- Modify: `server/src/tournament_server/_alembic/versions/000000000001_baseline.py`
- Create: `server/src/tournament_server/services/displays.py`
- Modify: `server/src/tournament_server/routers/field_sets.py`, `routers/fields.py`, `routers/sessions.py`, `routers/divisions.py`, `services/deletion.py`, `app.py`
- Create: `server/tests/display_helpers.py`
- Test: `server/tests/test_display_groups.py`

**Interfaces:**
- Produces (`models/display.py`): `DisplayGroup(id, session_id, kind, field_set_id, field_id, name, division_id, screen, screen_settings, rotation, play_sounds)`, `DisplayAssignment(id, session_id, device_id, group_id)`.
- Produces (`models/field_set.py`): `FieldSet.queued_match_id: int | None` (plain integer, no FK), `FieldSet.timeout_deadline: datetime | None`.
- Produces (`services/displays.py`): constants `AUDIENCE = "audience"`, `FIELD = "field"`, `PIT = "pit"`, `DEFAULT_AUDIENCE_SCREEN = "logo"`, `DEFAULT_PIT_SCREEN = "teamwork_rankings"`; functions `ensure_audience_group(db, field_set) -> DisplayGroup`, `ensure_field_group(db, field) -> DisplayGroup`, `ensure_all_groups(db) -> None`, `delete_group(db, group) -> None`, `delete_field_groups(db, field_id) -> None`, `delete_field_set_groups(db, field_set_id) -> None`, `delete_session_displays(db, session_id) -> None`, `delete_device_assignments(db, device_id) -> None`, `clear_queued_matches(db, match_ids) -> list[int]` (returns the ids of field sets it changed), `clear_division_from_pit_groups(db, division_id) -> None`. None of them commit.
- Produces (`tests/display_helpers.py`): `setup_event(client, game="example-game") -> int`, `add_field_set(client, session_id, name="Main Fields", fields=("Field 1", "Field 2")) -> dict` (`{"id", "field_ids"}`), `add_teams(client, count=4) -> list[int]`, `add_match(client, session_id, field_id, number, team_ids, *, minutes=0, scheduled=True, round_type="qualification") -> dict`, `score_match(client, match, high_balls=(3, 1)) -> None`, `groups(client, **filters) -> list[DisplayGroup]`, `assignments(client) -> list[DisplayAssignment]`, `assign(client, session_id, group_id, device_id) -> None`, `admin_token(client) -> str`, `BASE_TIME`.

- [ ] **Step 1: Write the test helpers**

Create `server/tests/display_helpers.py`:

```python
"""Shared setup for the display-group tests."""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select

from tournament_server.models.display import DisplayAssignment, DisplayGroup

BASE_TIME = dt.datetime(2026, 11, 7, 16, 0, tzinfo=dt.UTC)


def setup_event(client, game: str | None = "example-game") -> int:
    """Creates the event, picks its game and one active session; returns the session id."""
    client.post("/api/event", json={"name": "Display Event"})
    if game is not None:
        assert client.post("/api/event/game-plugin", json={"name": game}).status_code == 200
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    return session_id


def add_field_set(client, session_id: int, name: str = "Main Fields", fields=("Field 1", "Field 2")) -> dict:
    created = client.post("/api/field-sets", json={"session_id": session_id, "name": name})
    assert created.status_code == 201, created.text
    field_set_id = created.json()["id"]
    field_ids = []
    for field_name in fields:
        field = client.post(
            "/api/fields", json={"session_id": session_id, "field_set_id": field_set_id, "name": field_name}
        )
        assert field.status_code == 201, field.text
        field_ids.append(field.json()["id"])
    return {"id": field_set_id, "field_ids": field_ids}


def add_teams(client, count: int = 4) -> list[int]:
    ids = []
    for n in range(count):
        created = client.post(
            "/api/teams", json={"number": f"{101 + n}A", "name": f"Team {n + 1}", "city": "Springfield"}
        )
        assert created.status_code == 201, created.text
        ids.append(created.json()["id"])
    return ids


def add_match(
    client,
    session_id: int,
    field_id: int | None,
    number: int,
    team_ids: list[int],
    *,
    minutes: int = 0,
    scheduled: bool = True,
    round_type: str = "qualification",
) -> dict:
    created = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": round_type,
            "match_number": number,
            "field_id": field_id,
            "scheduled_time": (BASE_TIME + dt.timedelta(minutes=minutes)).isoformat() if scheduled else None,
            "alliances": [
                {"station": "red", "team_ids": team_ids[:2]},
                {"station": "blue", "team_ids": team_ids[2:4]},
            ],
        },
    )
    assert created.status_code == 201, created.text
    return created.json()


def score_match(client, match: dict, high_balls=(3, 1)) -> None:
    for alliance, balls in zip(match["alliances"], high_balls):
        scored = client.post(
            f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": balls, "low_balls": 0, "parked": False, "auto_winner": "tie"}},
        )
        assert scored.status_code == 200, scored.text


def groups(client, **filters) -> list[DisplayGroup]:
    with client.app.state.session_factory() as db:
        query = select(DisplayGroup)
        for key, value in filters.items():
            query = query.where(getattr(DisplayGroup, key) == value)
        return list(db.execute(query.order_by(DisplayGroup.id)).scalars().all())


def assignments(client) -> list[DisplayAssignment]:
    with client.app.state.session_factory() as db:
        return list(db.execute(select(DisplayAssignment).order_by(DisplayAssignment.id)).scalars().all())


def assign(client, session_id: int, group_id: int, device_id: int) -> None:
    with client.app.state.session_factory() as db:
        db.add(DisplayAssignment(session_id=session_id, device_id=device_id, group_id=group_id))
        db.commit()


def admin_token(client) -> str:
    return client.headers["Authorization"].removeprefix("Bearer ")
```

- [ ] **Step 2: Write the failing tests**

Create `server/tests/test_display_groups.py`:

```python
from __future__ import annotations

from sqlalchemy import select

from device_helpers import paired_device
from display_helpers import (
    add_field_set,
    add_match,
    add_teams,
    assign,
    assignments,
    groups,
    setup_event,
)
from tournament_server.app import create_app
from tournament_server.models.display import DisplayGroup
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.match import Match
from tournament_server.services.deletion import delete_matches


def test_a_field_set_gets_an_audience_group_and_each_field_a_field_group(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    audience = groups(client, kind="audience")
    assert [(g.field_set_id, g.session_id, g.screen, g.screen_settings, g.play_sounds) for g in audience] == [
        (field_set["id"], session_id, "logo", {}, False)
    ]
    field_groups = groups(client, kind="field")
    assert [g.field_id for g in field_groups] == field_set["field_ids"]
    assert all(g.session_id == session_id and g.screen is None for g in field_groups)


def test_the_default_field_set_made_by_adding_a_field_gets_its_audience_group(client):
    session_id = setup_event(client)
    field = client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"}).json()
    assert len(groups(client, kind="audience")) == 1
    assert [g.field_id for g in groups(client, kind="field")] == [field["id"]]


def test_deleting_a_field_deletes_its_group_and_assignments(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    display = paired_device(client, role="display_device")
    field_id = field_set["field_ids"][0]
    assign(client, session_id, groups(client, field_id=field_id)[0].id, display["id"])
    assert client.delete(f"/api/fields/{field_id}").status_code == 204
    assert groups(client, field_id=field_id) == []
    assert assignments(client) == []


def test_deleting_a_field_set_deletes_its_audience_and_field_groups(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    display = paired_device(client, role="display_device")
    assign(client, session_id, groups(client, kind="audience")[0].id, display["id"])
    assert client.delete(f"/api/field-sets/{field_set['id']}").status_code == 204
    assert groups(client) == []
    assert assignments(client) == []


def test_copying_fields_creates_groups_for_the_new_fields(client):
    session_id = setup_event(client)
    add_field_set(client, session_id)
    other = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    copied = client.post(f"/api/sessions/{other}/copy-fields", json={"source_session_id": session_id})
    assert copied.status_code == 201, copied.text
    assert len(groups(client, session_id=other, kind="audience")) == 1
    assert len(groups(client, session_id=other, kind="field")) == 2


def test_deleting_a_session_deletes_its_groups_and_assignments(client):
    session_id = setup_event(client)
    add_field_set(client, session_id)
    display = paired_device(client, role="display_device")
    assign(client, session_id, groups(client, kind="audience")[0].id, display["id"])
    with client.app.state.session_factory() as db:
        db.add(DisplayGroup(session_id=session_id, kind="pit", name="Pits", screen="teamwork_rankings", screen_settings={}))
        db.commit()
    assert client.delete(f"/api/sessions/{session_id}").status_code == 204
    assert groups(client) == []
    assert assignments(client) == []


def test_deleting_a_division_takes_it_off_pit_groups(client):
    session_id = setup_event(client)
    second = client.post("/api/divisions", json={"name": "Division 2"}).json()["id"]
    with client.app.state.session_factory() as db:
        db.add(DisplayGroup(session_id=session_id, kind="pit", name="Pits", division_id=second, screen="logo", screen_settings={}))
        db.commit()
    assert client.delete(f"/api/divisions/{second}").status_code == 204
    assert groups(client, kind="pit")[0].division_id is None


def test_startup_creates_missing_groups_once(client, tmp_path):
    session_id = setup_event(client)
    with client.app.state.session_factory() as db:
        field_set = FieldSet(session_id=session_id, name="Old Fields")
        db.add(field_set)
        db.flush()
        db.add(Field(field_set_id=field_set.id, name="Old 1"))
        db.commit()
    assert groups(client) == []
    for _ in range(2):
        app = create_app(
            db_path=str(tmp_path / "test.db"),
            plugins_root=str(tmp_path / "plugins"),
            config_path=tmp_path / "server-config.json",
        )
        with app.state.session_factory() as db:
            kinds = sorted(g.kind for g in db.execute(select(DisplayGroup)).scalars().all())
        assert kinds == ["audience", "field"]


def test_deleting_matches_clears_a_queued_override(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    match = add_match(client, session_id, field_set["field_ids"][0], 1, add_teams(client))
    with client.app.state.session_factory() as db:
        db.get(FieldSet, field_set["id"]).queued_match_id = match["id"]
        db.commit()
    with client.app.state.session_factory() as db:
        delete_matches(db, [db.get(Match, match["id"])])
        db.commit()
    with client.app.state.session_factory() as db:
        assert db.get(FieldSet, field_set["id"]).queued_match_id is None
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_display_groups.py`
Expected: collection error, `ModuleNotFoundError: No module named 'tournament_server.models.display'`.

- [ ] **Step 4: Add the models**

Create `server/src/tournament_server/models/display.py`:

```python
from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class DisplayGroup(Base):
    """Paired displays that show the same thing (see the display groups
    design). An audience group belongs to a field set, a field group to a
    field, and a pit group is made by an admin. `screen` is null for field
    groups, which always run the field display."""

    __tablename__ = "display_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    kind: Mapped[str] = mapped_column(String(20))
    field_set_id: Mapped[int | None] = mapped_column(ForeignKey("field_sets.id"), default=None)
    field_id: Mapped[int | None] = mapped_column(ForeignKey("fields.id"), default=None)
    name: Mapped[str | None] = mapped_column(String(100), default=None)
    division_id: Mapped[int | None] = mapped_column(ForeignKey("divisions.id"), default=None)
    screen: Mapped[str | None] = mapped_column(String(50), default=None)
    screen_settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    rotation: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, default=None)
    play_sounds: Mapped[bool] = mapped_column(Boolean, default=False)


class DisplayAssignment(Base):
    """The group a display follows in one session."""

    __tablename__ = "display_assignments"
    __table_args__ = (
        UniqueConstraint("session_id", "device_id", name="uq_display_assignment_session_device"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"))
    group_id: Mapped[int] = mapped_column(ForeignKey("display_groups.id"))
```

In `models/__init__.py` add `from tournament_server.models.display import DisplayAssignment, DisplayGroup` (alphabetically after the `device` import) and add `"DisplayAssignment",` and `"DisplayGroup",` to `__all__` after `"Device",`.

Replace `models/field_set.py` with:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


class FieldSet(Base):
    __tablename__ = "field_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    name: Mapped[str] = mapped_column(String(200))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    # The match an admin queued out of schedule order (display groups design
    # §6.1). A plain integer like Event.active_session_id, not a foreign key:
    # matches already point at field sets through fields, and SQLite can't
    # add the reverse key afterwards. services/deletion.delete_matches clears it.
    queued_match_id: Mapped[int | None] = mapped_column(Integer, default=None)
    # A running time-out ends here; an expired deadline is simply ignored.
    timeout_deadline: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
```

- [ ] **Step 5: Edit the baseline migration in place**

In `000000000001_baseline.py`, in the `op.create_table('field_sets', ...)` block, add after `sa.Column('division_id', sa.Integer(), nullable=True),`:

```python
    sa.Column('queued_match_id', sa.Integer(), nullable=True),
    sa.Column('timeout_deadline', tournament_server.db.UTCDateTime(), nullable=True),
```

Directly after the `op.create_table('fields', ...)` block (before `op.create_table('finals_brackets', ...)`), add:

```python
    op.create_table('display_groups',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=20), nullable=False),
    sa.Column('field_set_id', sa.Integer(), nullable=True),
    sa.Column('field_id', sa.Integer(), nullable=True),
    sa.Column('name', sa.String(length=100), nullable=True),
    sa.Column('division_id', sa.Integer(), nullable=True),
    sa.Column('screen', sa.String(length=50), nullable=True),
    sa.Column('screen_settings', sa.JSON(), nullable=False),
    sa.Column('rotation', sa.JSON(), nullable=True),
    sa.Column('play_sounds', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
    sa.ForeignKeyConstraint(['field_id'], ['fields.id'], ),
    sa.ForeignKeyConstraint(['field_set_id'], ['field_sets.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('display_assignments',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('session_id', sa.Integer(), nullable=False),
    sa.Column('device_id', sa.Integer(), nullable=False),
    sa.Column('group_id', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['device_id'], ['devices.id'], ),
    sa.ForeignKeyConstraint(['group_id'], ['display_groups.id'], ),
    sa.ForeignKeyConstraint(['session_id'], ['sessions.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('session_id', 'device_id', name='uq_display_assignment_session_device')
    )
```

At the top of `downgrade()`, before `op.drop_table('score_record_teams')`, add:

```python
    op.drop_table('display_assignments')
    op.drop_table('display_groups')
```

- [ ] **Step 6: Write the lifecycle service**

Create `server/src/tournament_server/services/displays.py`:

```python
"""Display groups: which screen each group of paired displays shows.
See docs/superpowers/specs/2026-10-15-display-groups-design.md.
None of these functions commit; the caller decides when a change lands."""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.display import DisplayAssignment, DisplayGroup
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet

AUDIENCE = "audience"
FIELD = "field"
PIT = "pit"
GROUP_KINDS = (AUDIENCE, FIELD, PIT)
DEFAULT_AUDIENCE_SCREEN = "logo"
DEFAULT_PIT_SCREEN = "teamwork_rankings"


def ensure_audience_group(db: Session, field_set: FieldSet) -> DisplayGroup:
    group = db.execute(
        select(DisplayGroup).where(DisplayGroup.kind == AUDIENCE, DisplayGroup.field_set_id == field_set.id)
    ).scalars().first()
    if group is None:
        group = DisplayGroup(
            session_id=field_set.session_id,
            kind=AUDIENCE,
            field_set_id=field_set.id,
            screen=DEFAULT_AUDIENCE_SCREEN,
            screen_settings={},
        )
        db.add(group)
        db.flush()
    return group


def ensure_field_group(db: Session, field: Field) -> DisplayGroup:
    group = db.execute(
        select(DisplayGroup).where(DisplayGroup.kind == FIELD, DisplayGroup.field_id == field.id)
    ).scalars().first()
    if group is None:
        field_set = db.get(FieldSet, field.field_set_id)
        group = DisplayGroup(session_id=field_set.session_id, kind=FIELD, field_id=field.id, screen_settings={})
        db.add(group)
        db.flush()
    return group


def ensure_all_groups(db: Session) -> None:
    """Startup self-heal: every field set has its audience group and every
    field its field group, whatever build made the file."""
    with_audience = set(
        db.execute(select(DisplayGroup.field_set_id).where(DisplayGroup.kind == AUDIENCE)).scalars().all()
    )
    with_field = set(db.execute(select(DisplayGroup.field_id).where(DisplayGroup.kind == FIELD)).scalars().all())
    for field_set in db.execute(select(FieldSet).order_by(FieldSet.id)).scalars().all():
        if field_set.id not in with_audience:
            ensure_audience_group(db, field_set)
    for field in db.execute(select(Field).order_by(Field.id)).scalars().all():
        if field.id not in with_field:
            ensure_field_group(db, field)


def delete_group(db: Session, group: DisplayGroup) -> None:
    for row in db.execute(select(DisplayAssignment).where(DisplayAssignment.group_id == group.id)).scalars().all():
        db.delete(row)
    db.flush()
    db.delete(group)
    db.flush()


def _delete_all(db: Session, query) -> None:
    for group in db.execute(query).scalars().all():
        delete_group(db, group)


def delete_field_groups(db: Session, field_id: int) -> None:
    _delete_all(db, select(DisplayGroup).where(DisplayGroup.field_id == field_id))


def delete_field_set_groups(db: Session, field_set_id: int) -> None:
    field_ids = db.execute(select(Field.id).where(Field.field_set_id == field_set_id)).scalars().all()
    for field_id in field_ids:
        delete_field_groups(db, field_id)
    _delete_all(db, select(DisplayGroup).where(DisplayGroup.field_set_id == field_set_id))


def delete_session_displays(db: Session, session_id: int) -> None:
    _delete_all(db, select(DisplayGroup).where(DisplayGroup.session_id == session_id))


def delete_device_assignments(db: Session, device_id: int) -> None:
    for row in db.execute(select(DisplayAssignment).where(DisplayAssignment.device_id == device_id)).scalars().all():
        db.delete(row)
    db.flush()


def clear_queued_matches(db: Session, match_ids: Iterable[int]) -> list[int]:
    """Clears any field set's next-match override that points at one of
    these matches. Returns the ids of the field sets it changed."""
    ids = list(match_ids)
    if not ids:
        return []
    changed = []
    for field_set in db.execute(select(FieldSet).where(FieldSet.queued_match_id.in_(ids))).scalars().all():
        field_set.queued_match_id = None
        changed.append(field_set.id)
    db.flush()
    return changed


def clear_division_from_pit_groups(db: Session, division_id: int) -> None:
    for group in db.execute(select(DisplayGroup).where(DisplayGroup.division_id == division_id)).scalars().all():
        group.division_id = None
    db.flush()
```

- [ ] **Step 7: Hook the lifecycle into the routers, deletion and startup**

`routers/field_sets.py`:
- add `from tournament_server.services import displays`;
- in `create_field_set`, replace `db.add(field_set)` / `db.commit()` with `db.add(field_set)`, `db.flush()`, `displays.ensure_audience_group(db, field_set)`, `db.commit()`;
- in `delete_field_set`, call `displays.delete_field_set_groups(db, field_set_id)` immediately before the `for field in fields: db.delete(field)` loop.

`routers/fields.py`:
- add `from tournament_server.services import displays`;
- in `create_field`, after `db.add(default_set)` / `db.flush()` add `displays.ensure_audience_group(db, default_set)`;
- replace the final `db.add(field)` / `db.commit()` with `db.add(field)`, `db.flush()`, `displays.ensure_field_group(db, field)`, `db.commit()`;
- in `delete_field`, call `displays.delete_field_groups(db, field_id)` immediately before `db.delete(field)`.

`routers/sessions.py` `copy_fields`: add `from tournament_server.services import displays` and replace the copy loop body with:

```python
    for source_set in source_sets:
        copy = FieldSet(
            session_id=session_id, name=source_set.name, division_id=source_set.division_id
        )
        db.add(copy)
        db.flush()
        displays.ensure_audience_group(db, copy)
        for field in db.execute(
            select(Field).where(Field.field_set_id == source_set.id).order_by(Field.id)
        ).scalars().all():
            field_copy = Field(field_set_id=copy.id, name=field.name)
            db.add(field_copy)
            db.flush()
            displays.ensure_field_group(db, field_copy)
        copies.append(copy)
```

`services/deletion.py`:
- add `from tournament_server.services import displays`;
- at the start of `delete_matches`, turn `matches` into a list and clear overrides:

```python
def delete_matches(db: Session, matches: Iterable[Match]) -> None:
    """Deletes matches with their alliances, alliance teams and score records,
    and drops any next-match override that points at one of them."""
    matches = list(matches)
    displays.clear_queued_matches(db, [match.id for match in matches])
    for match in matches:
        ...  # existing body unchanged
```

- in `delete_session`, call `displays.delete_session_displays(db, session_id)` immediately before the `for field_set in db.execute(select(FieldSet)...` loop.

`routers/divisions.py` `delete_division`: add `from tournament_server.services import displays` and call `displays.clear_division_from_pit_groups(db, division_id)` right after `remove_division_from_awards(db, division_id)`.

`app.py`: add `from tournament_server.services.displays import ensure_all_groups` and, inside the startup `with session_factory() as db:` block, after the `if event_row is not None:` block (same indentation as that `if`), add:

```python
        # Every field set and field has its display group (display groups design §4.2).
        ensure_all_groups(db)
        db.commit()
```

- [ ] **Step 8: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_display_groups.py tests/test_alembic_drift.py tests/test_field_sets.py tests/test_fields.py tests/test_sessions.py tests/test_divisions.py`
Expected: all pass.

- [ ] **Step 9: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q -p no:cacheprovider`
Expected: all pass (the suite takes about 10 minutes).

- [ ] **Step 10: Commit**

```bash
git add server/src/tournament_server/models/display.py server/src/tournament_server/models/__init__.py \
  server/src/tournament_server/models/field_set.py server/src/tournament_server/_alembic/versions/000000000001_baseline.py \
  server/src/tournament_server/services/displays.py server/src/tournament_server/routers/field_sets.py \
  server/src/tournament_server/routers/fields.py server/src/tournament_server/routers/sessions.py \
  server/src/tournament_server/routers/divisions.py server/src/tournament_server/services/deletion.py \
  server/src/tournament_server/app.py server/tests/display_helpers.py server/tests/test_display_groups.py
git commit -m "Add display groups and assignments: every field set gets an audience group and every field a field group, created and deleted with them, healed at startup, and field sets gain a next-match override and a time-out deadline.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Screen registry and the displays API

**Files:**
- Create: `server/src/tournament_server/services/display_screens.py`
- Create: `server/src/tournament_server/schemas/display.py`
- Create: `server/src/tournament_server/routers/displays.py`
- Modify: `server/src/tournament_server/services/displays.py` (naming, ordering, `display_group_name`)
- Modify: `server/src/tournament_server/realtime.py` (`send_to_device`)
- Modify: `server/src/tournament_server/routers/devices.py`, `server/src/tournament_server/schemas/device.py`
- Modify: `server/src/tournament_server/app.py` (include the router)
- Test: `server/tests/test_display_screens.py`, `server/tests/test_displays_api.py`

**Interfaces:**
- Consumes: Task 1's models, constants and service functions.
- Produces (`services/display_screens.py`): `SCREENS: dict[str, ScreenSpec]`, `ScreenSpec(kinds: frozenset[str], clean_settings, scrolls: bool)`, `ScreenSettingsError(ValueError)`, `clean_screen(screen: str, settings: object, kind: str) -> dict`, `clean_rotation(rotation: object) -> list[dict]`, constants `DEFAULT_ROTATION_SECONDS = 20`, `MIN_ROTATION_SECONDS = 5`, `MAX_ROTATION_SECONDS = 300`, `MAX_ROTATION_ENTRIES = 20`.
- Produces (`services/displays.py` additions): `group_name(db, group) -> str`, `group_field_set_id(db, group) -> int | None`, `session_groups(db, session_id) -> list[DisplayGroup]` (audience then its fields, per field set in id order, then pit groups by name), `display_group_name(db, device_id) -> str | None` (the device's group name in the active session).
- Produces (`realtime.py`): `send_to_device(app, device_id: int, event: str, data: dict) -> None`.
- Produces (routers/displays.py): `notify_display_changed(request, session_id, group_id) -> None`, `displays_read(request, db, session_id) -> DisplaysRead`; the endpoints in spec §8 except copy-displays (Task 3) and the field-set endpoints (Task 4).
- Produces (`schemas/display.py`): `DisplayRef{device_id, name, online}`, `DisplayGroupRead{id, session_id, kind, name, field_set_id, field_id, division_id, screen, screen_settings, rotation, play_sounds, displays}`, `DisplaysRead{session_id, groups, unassigned, has_setup}`, `PitGroupCreate{session_id, name, division_id}`, `DisplayGroupUpdate{screen?, screen_settings?, rotation?, name?, division_id?, play_sounds?}`, `AssignmentWrite{session_id, device_id, group_id}`, `FieldSetLive{queued_match_id, timeout_deadline}`, `DisplayMeGroup` (group read without `displays`, plus `field_set: FieldSetLive | None`), `DisplayMe{device: {id, name}, session_id, group}`.
- Produces (`schemas/device.py`): `DeviceRead.display_group: str | None`.

- [ ] **Step 1: Write the failing registry tests**

Create `server/tests/test_display_screens.py`:

```python
from __future__ import annotations

import pytest

from tournament_server.services.display_screens import (
    SCREENS,
    ScreenSettingsError,
    clean_rotation,
    clean_screen,
)


def test_the_registry_holds_exactly_the_spec_screens():
    assert set(SCREENS) == {
        "match_intro", "in_match", "last_scored_match", "teamwork_rankings", "skills_rankings",
        "upcoming_matches", "match_results", "schedule", "elimination_bracket", "logo",
    }
    assert {k for k, s in SCREENS.items() if s.kinds == frozenset({"audience"})} == {
        "match_intro", "in_match", "last_scored_match",
    }
    assert {k for k, s in SCREENS.items() if s.scrolls} == {
        "teamwork_rankings", "skills_rankings", "match_results", "schedule",
    }


def test_screens_without_settings_refuse_any():
    assert clean_screen("logo", None, "audience") == {}
    assert clean_screen("logo", {}, "pit") == {}
    with pytest.raises(ScreenSettingsError, match="no settings"):
        clean_screen("logo", {"count": 3}, "audience")


def test_unknown_screens_and_wrong_kinds_are_refused():
    with pytest.raises(ScreenSettingsError, match="Unknown screen: banner"):
        clean_screen("banner", {}, "audience")
    with pytest.raises(ScreenSettingsError, match="can't be shown on a pit group"):
        clean_screen("in_match", {}, "pit")
    with pytest.raises(ScreenSettingsError, match="can't be shown on a field group"):
        clean_screen("logo", {}, "field")


def test_upcoming_matches_settings_get_defaults_and_bounds():
    assert clean_screen("upcoming_matches", {}, "audience") == {"count": 3, "scope": "field_set"}
    assert clean_screen("upcoming_matches", {}, "pit") == {"count": 3, "scope": "division"}
    assert clean_screen("upcoming_matches", {"count": 20, "scope": "division"}, "audience") == {
        "count": 20, "scope": "division",
    }
    for bad in ({"count": 0}, {"count": 21}, {"count": True}, {"count": "3"}, {"scope": "event"}, {"colour": "red"}):
        with pytest.raises(ScreenSettingsError):
            clean_screen("upcoming_matches", bad, "audience")
    with pytest.raises(ScreenSettingsError, match="division"):
        clean_screen("upcoming_matches", {"scope": "field_set"}, "pit")


def test_rotations_are_cleaned_entry_by_entry():
    assert clean_rotation([{"screen": "teamwork_rankings"}, {"screen": "upcoming_matches", "seconds": 30}]) == [
        {"screen": "teamwork_rankings", "settings": {}, "seconds": 20},
        {"screen": "upcoming_matches", "settings": {"count": 3, "scope": "division"}, "seconds": 30},
    ]
    with pytest.raises(ScreenSettingsError, match="at least one"):
        clean_rotation([])
    with pytest.raises(ScreenSettingsError, match="Rotation entry 2: seconds"):
        clean_rotation([{"screen": "logo"}, {"screen": "logo", "seconds": 4}])
    with pytest.raises(ScreenSettingsError, match="Rotation entry 1: seconds"):
        clean_rotation([{"screen": "logo", "seconds": 301}])
    with pytest.raises(ScreenSettingsError, match="Rotation entry 1: The in_match screen"):
        clean_rotation([{"screen": "in_match"}])
    with pytest.raises(ScreenSettingsError, match="at most 20"):
        clean_rotation([{"screen": "logo"}] * 21)
    with pytest.raises(ScreenSettingsError, match="Rotation entry 1: unknown key"):
        clean_rotation([{"screen": "logo", "colour": "red"}])
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_display_screens.py`
Expected: collection error, `No module named 'tournament_server.services.display_screens'`.

- [ ] **Step 3: Write the registry**

Create `server/src/tournament_server/services/display_screens.py`:

```python
"""The one registry of display screens (display groups design §5.4).
Adding a screen is one entry here, one device module and one admin label."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

DEFAULT_ROTATION_SECONDS = 20
MIN_ROTATION_SECONDS = 5
MAX_ROTATION_SECONDS = 300
MAX_ROTATION_ENTRIES = 20
DEFAULT_UPCOMING_COUNT = 3
MAX_UPCOMING_COUNT = 20


class ScreenSettingsError(ValueError):
    pass


def _whole_number(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _no_settings(settings: dict[str, Any], kind: str) -> dict[str, Any]:
    if settings:
        raise ScreenSettingsError("This screen has no settings.")
    return {}


def _upcoming_settings(settings: dict[str, Any], kind: str) -> dict[str, Any]:
    unknown = sorted(set(settings) - {"count", "scope"})
    if unknown:
        raise ScreenSettingsError(f"Unknown setting: {unknown[0]}")
    count = settings.get("count", DEFAULT_UPCOMING_COUNT)
    if not _whole_number(count) or not 1 <= count <= MAX_UPCOMING_COUNT:
        raise ScreenSettingsError(f"count must be a whole number from 1 to {MAX_UPCOMING_COUNT}.")
    scope = settings.get("scope", "division" if kind == "pit" else "field_set")
    if kind == "pit" and scope != "division":
        raise ScreenSettingsError("scope must be division on a pit group.")
    if scope not in ("field_set", "division"):
        raise ScreenSettingsError("scope must be field_set or division.")
    return {"count": count, "scope": scope}


@dataclass(frozen=True)
class ScreenSpec:
    kinds: frozenset[str]
    clean_settings: Callable[[dict[str, Any], str], dict[str, Any]]
    scrolls: bool = False


_AUDIENCE = frozenset({"audience"})
_AUDIENCE_AND_PIT = frozenset({"audience", "pit"})

SCREENS: dict[str, ScreenSpec] = {
    "match_intro": ScreenSpec(_AUDIENCE, _no_settings),
    "in_match": ScreenSpec(_AUDIENCE, _no_settings),
    "last_scored_match": ScreenSpec(_AUDIENCE, _no_settings),
    "teamwork_rankings": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings, scrolls=True),
    "skills_rankings": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings, scrolls=True),
    "upcoming_matches": ScreenSpec(_AUDIENCE_AND_PIT, _upcoming_settings),
    "match_results": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings, scrolls=True),
    "schedule": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings, scrolls=True),
    "elimination_bracket": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings),
    "logo": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings),
}


def clean_screen(screen: str, settings: Any, kind: str) -> dict[str, Any]:
    """The settings to store for `screen` on a group of `kind`, with
    defaults filled in. Raises ScreenSettingsError naming the problem."""
    spec = SCREENS.get(screen)
    if spec is None:
        raise ScreenSettingsError(f"Unknown screen: {screen}")
    if kind not in spec.kinds:
        raise ScreenSettingsError(f"The {screen} screen can't be shown on a {kind} group.")
    if settings is None:
        settings = {}
    if not isinstance(settings, dict):
        raise ScreenSettingsError("Screen settings must be an object.")
    return spec.clean_settings(settings, kind)


def clean_rotation(rotation: Any) -> list[dict[str, Any]]:
    """A pit group's rotation, each entry as {screen, settings, seconds}."""
    if not isinstance(rotation, list) or not rotation:
        raise ScreenSettingsError("A rotation needs at least one screen.")
    if len(rotation) > MAX_ROTATION_ENTRIES:
        raise ScreenSettingsError(f"A rotation can have at most {MAX_ROTATION_ENTRIES} screens.")
    cleaned = []
    for number, entry in enumerate(rotation, start=1):
        try:
            if not isinstance(entry, dict):
                raise ScreenSettingsError("each entry must be an object.")
            unknown = sorted(set(entry) - {"screen", "settings", "seconds"})
            if unknown:
                raise ScreenSettingsError(f"unknown key {unknown[0]}.")
            screen = entry.get("screen")
            if not isinstance(screen, str):
                raise ScreenSettingsError("it needs a screen.")
            settings = clean_screen(screen, entry.get("settings"), "pit")
            seconds = entry.get("seconds", DEFAULT_ROTATION_SECONDS)
            if not _whole_number(seconds) or not MIN_ROTATION_SECONDS <= seconds <= MAX_ROTATION_SECONDS:
                raise ScreenSettingsError(
                    f"seconds must be a whole number from {MIN_ROTATION_SECONDS} to {MAX_ROTATION_SECONDS}."
                )
        except ScreenSettingsError as error:
            raise ScreenSettingsError(f"Rotation entry {number}: {error}") from None
        cleaned.append({"screen": screen, "settings": settings, "seconds": seconds})
    return cleaned
```

- [ ] **Step 4: Run the registry tests**

Run: `cd server && .venv/bin/pytest -q tests/test_display_screens.py`
Expected: all pass.

- [ ] **Step 5: Write the failing API tests**

Create `server/tests/test_displays_api.py`:

```python
from __future__ import annotations

import pytest

from device_helpers import paired_device
from display_helpers import add_field_set, admin_token, assignments, groups, setup_event
from skills_helpers import next_event
from sqlalchemy import select
from tournament_server.models.event import Event
from tournament_server.models.field_set import FieldSet


@pytest.fixture
def event(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    return {"session_id": session_id, "field_set": field_set}


def _audience(client):
    return groups(client, kind="audience")[0]


def _pit(client, session_id, name="Pit TVs", division_id=None):
    created = client.post(
        "/api/displays/pit-groups", json={"session_id": session_id, "name": name, "division_id": division_id}
    )
    assert created.status_code == 201, created.text
    return created.json()


def test_the_list_shows_groups_in_order_with_their_displays_and_the_unassigned(client, event):
    session_id = event["session_id"]
    pit = _pit(client, session_id)
    tv = paired_device(client, role="display_device", name="Big TV")
    spare = paired_device(client, role="display_device", name="Spare TV")
    paired_device(client, role="scorer", name="Tablet")
    put = client.put(
        "/api/displays/assignments", json={"session_id": session_id, "device_id": tv["id"], "group_id": _audience(client).id}
    )
    assert put.status_code == 200, put.text
    body = client.get(f"/api/displays?session_id={session_id}").json()
    assert body["session_id"] == session_id and body["has_setup"] is True
    assert [(g["kind"], g["name"]) for g in body["groups"]] == [
        ("audience", "Main Fields"), ("field", "Field 1"), ("field", "Field 2"), ("pit", "Pit TVs"),
    ]
    audience = body["groups"][0]
    assert audience["field_set_id"] == event["field_set"]["id"] and audience["screen"] == "logo"
    assert audience["displays"] == [{"device_id": tv["id"], "name": "Big TV", "online": False}]
    assert body["groups"][1]["field_set_id"] == event["field_set"]["id"]
    assert body["groups"][3]["id"] == pit["id"] and body["groups"][3]["screen"] == "teamwork_rankings"
    assert body["unassigned"] == [{"device_id": spare["id"], "name": "Spare TV", "online": False}]


def test_a_display_with_an_open_socket_is_online(client, event):
    tv = paired_device(client, role="display_device", name="Big TV")
    with client.websocket_connect(f"/ws/active-session?token={tv['access_token']}"):
        body = client.get(f"/api/displays?session_id={event['session_id']}").json()
        assert body["unassigned"][0]["online"] is True


def test_pit_groups_need_a_unique_name_and_a_real_division(client, event):
    session_id = event["session_id"]
    _pit(client, session_id, "Hallway")
    duplicate = client.post("/api/displays/pit-groups", json={"session_id": session_id, "name": " hallway "})
    assert duplicate.status_code == 409
    assert client.post("/api/displays/pit-groups", json={"session_id": session_id, "name": "  "}).status_code == 422
    assert client.post("/api/displays/pit-groups", json={"session_id": session_id, "name": "X", "division_id": 999}).status_code == 404
    assert client.post("/api/displays/pit-groups", json={"session_id": 999, "name": "X"}).status_code == 404


def test_patching_screens_is_checked_against_the_registry(client, event):
    audience = _audience(client)
    ok = client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "upcoming_matches"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["screen_settings"] == {"count": 3, "scope": "field_set"}
    changed = client.patch(f"/api/displays/groups/{audience.id}", json={"screen_settings": {"count": 5}})
    assert changed.json()["screen_settings"] == {"count": 5, "scope": "field_set"}
    switched = client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "schedule"})
    assert switched.json()["screen_settings"] == {}
    assert client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "banner"}).status_code == 422
    assert client.patch(f"/api/displays/groups/{audience.id}", json={"rotation": [{"screen": "logo"}]}).status_code == 422
    assert client.patch(f"/api/displays/groups/{audience.id}", json={"name": "X"}).status_code == 422
    assert client.patch(f"/api/displays/groups/{audience.id}", json={"play_sounds": True}).json()["play_sounds"] is True
    field_group = groups(client, kind="field")[0]
    assert client.patch(f"/api/displays/groups/{field_group.id}", json={"screen": "logo"}).status_code == 422


def test_pit_groups_take_rotations_names_and_divisions(client, event):
    pit = _pit(client, event["session_id"])
    patched = client.patch(
        f"/api/displays/groups/{pit['id']}",
        json={"rotation": [{"screen": "teamwork_rankings"}, {"screen": "upcoming_matches", "seconds": 30}], "name": "Pit 1"},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["rotation"][1] == {"screen": "upcoming_matches", "settings": {"count": 3, "scope": "division"}, "seconds": 30}
    assert patched.json()["name"] == "Pit 1"
    assert client.patch(f"/api/displays/groups/{pit['id']}", json={"rotation": None}).json()["rotation"] is None
    assert client.patch(f"/api/displays/groups/{pit['id']}", json={"play_sounds": True}).status_code == 422
    assert client.patch(f"/api/displays/groups/{pit['id']}", json={"rotation": [{"screen": "in_match"}]}).status_code == 422
    assert client.patch(f"/api/displays/groups/{pit['id']}", json={"division_id": 999}).status_code == 404


def test_only_pit_groups_can_be_deleted(client, event):
    pit = _pit(client, event["session_id"])
    tv = paired_device(client, role="display_device")
    client.put("/api/displays/assignments", json={"session_id": event["session_id"], "device_id": tv["id"], "group_id": pit["id"]})
    assert client.delete(f"/api/displays/groups/{_audience(client).id}").status_code == 409
    assert client.delete(f"/api/displays/groups/{pit['id']}").status_code == 204
    assert assignments(client) == []


def test_assignments_are_one_per_session_and_only_for_displays(client, event):
    session_id = event["session_id"]
    tv = paired_device(client, role="display_device")
    tablet = paired_device(client, role="scorer")
    pit = _pit(client, session_id)
    put = lambda device, group: client.put(
        "/api/displays/assignments", json={"session_id": session_id, "device_id": device, "group_id": group}
    )
    assert put(tv["id"], _audience(client).id).status_code == 200
    assert put(tv["id"], pit["id"]).status_code == 200
    assert [(a.device_id, a.group_id) for a in assignments(client)] == [(tv["id"], pit["id"])]
    assert put(tablet["id"], pit["id"]).status_code == 422
    other = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    assert client.put(
        "/api/displays/assignments", json={"session_id": other, "device_id": tv["id"], "group_id": pit["id"]}
    ).status_code == 422
    assert put(tv["id"], None).status_code == 200
    assert assignments(client) == []
    assert put(999, pit["id"]).status_code == 404


def test_deleting_a_display_or_changing_its_role_drops_its_assignments(client, event):
    session_id = event["session_id"]
    first = paired_device(client, role="display_device")
    second = paired_device(client, role="display_device")
    for device in (first, second):
        client.put("/api/displays/assignments", json={"session_id": session_id, "device_id": device["id"], "group_id": _audience(client).id})
    client.patch(f"/api/devices/{first['id']}", json={"role": "scorer"})
    client.delete(f"/api/devices/{second['id']}")
    assert assignments(client) == []


def test_the_devices_list_shows_each_displays_group_in_the_active_session(client, event):
    tv = paired_device(client, role="display_device", name="Big TV")
    client.put("/api/displays/assignments", json={"session_id": event["session_id"], "device_id": tv["id"], "group_id": groups(client, kind="field")[1].id})
    rows = {d["name"]: d for d in client.get("/api/devices").json()}
    assert rows["Big TV"]["display_group"] == "Field 2"


def test_me_reports_each_state(client, event):
    session_id = event["session_id"]
    tv = paired_device(client, role="display_device", name="Big TV")
    me = lambda: client.get("/api/displays/me", headers=tv["headers"])
    assert me().json() == {"device": {"id": tv["id"], "name": "Big TV"}, "session_id": session_id, "group": None}
    field_group = groups(client, kind="field")[0]
    client.put("/api/displays/assignments", json={"session_id": session_id, "device_id": tv["id"], "group_id": field_group.id})
    with client.app.state.session_factory() as db:
        db.get(FieldSet, event["field_set"]["id"]).queued_match_id = 42
        db.commit()
    group = me().json()["group"]
    assert group["kind"] == "field" and group["name"] == "Field 1"
    assert group["field_id"] == field_group.field_id and group["field_set_id"] == event["field_set"]["id"]
    assert group["field_set"] == {"queued_match_id": 42, "timeout_deadline": None}
    assert "displays" not in group
    # The active-session endpoint can't clear it (session_id is required), so clear it directly.
    with client.app.state.session_factory() as db:
        db.execute(select(Event)).scalars().first().active_session_id = None
        db.commit()
    assert me().json()["session_id"] is None and me().json()["group"] is None
    assert client.get("/api/displays/me").status_code == 403
    assert client.get("/api/displays/me", headers=paired_device(client, role="scorer")["headers"]).status_code == 403


def test_changes_broadcast_display_changed_and_identify_reaches_only_its_device(client, event):
    session_id = event["session_id"]
    tv = paired_device(client, role="display_device")
    other = paired_device(client, role="display_device")
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_socket:
        audience = _audience(client)
        client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "schedule"})
        assert next_event(admin_socket, "display_changed")["data"] == {"session_id": session_id, "group_id": audience.id}
        client.put("/api/displays/assignments", json={"session_id": session_id, "device_id": tv["id"], "group_id": audience.id})
        assert next_event(admin_socket, "display_changed")["data"] == {"session_id": session_id, "group_id": audience.id}
    with client.websocket_connect(f"/ws/active-session?token={tv['access_token']}") as tv_socket, \
            client.websocket_connect(f"/ws/active-session?token={other['access_token']}") as other_socket:
        assert client.post(f"/api/displays/{tv['id']}/identify").status_code == 204
        assert next_event(tv_socket, "display_identify")["data"] == {"device_id": tv["id"]}
        client.patch(f"/api/displays/groups/{_audience(client).id}", json={"screen": "logo"})
        # The other display sees the next broadcast without an identify before it.
        assert other_socket.receive_json()["event"] == "display_changed"
    assert client.post("/api/displays/999/identify").status_code == 404


def test_only_admins_manage_displays(client, event):
    tv = paired_device(client, role="display_device")
    assert client.get(f"/api/displays?session_id={event['session_id']}", headers=tv["headers"]).status_code == 403
    assert client.post("/api/displays/pit-groups", json={"session_id": event["session_id"], "name": "X"}, headers=tv["headers"]).status_code == 403
```

- [ ] **Step 6: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_displays_api.py`
Expected: FAIL with 404s from the missing `/api/displays` routes.

- [ ] **Step 7: Add the schemas**

Create `server/src/tournament_server/schemas/display.py`:

```python
from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict


class DisplayRef(BaseModel):
    device_id: int
    name: str
    online: bool


class DisplayGroupFields(BaseModel):
    id: int
    session_id: int
    kind: str
    name: str
    field_set_id: int | None
    field_id: int | None
    division_id: int | None
    screen: str | None
    screen_settings: dict[str, Any]
    rotation: list[dict[str, Any]] | None
    play_sounds: bool


class DisplayGroupRead(DisplayGroupFields):
    displays: list[DisplayRef]


class DisplaysRead(BaseModel):
    session_id: int
    groups: list[DisplayGroupRead]
    unassigned: list[DisplayRef]
    has_setup: bool


class PitGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: int
    name: str
    division_id: int | None = None


class DisplayGroupUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    screen: str | None = None
    screen_settings: dict[str, Any] | None = None
    rotation: list[dict[str, Any]] | None = None
    name: str | None = None
    division_id: int | None = None
    play_sounds: bool | None = None


class AssignmentWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: int
    device_id: int
    group_id: int | None


class FieldSetLive(BaseModel):
    queued_match_id: int | None
    timeout_deadline: dt.datetime | None


class DisplayMeGroup(DisplayGroupFields):
    field_set: FieldSetLive | None


class DisplayDevice(BaseModel):
    id: int
    name: str


class DisplayMe(BaseModel):
    device: DisplayDevice
    session_id: int | None
    group: DisplayMeGroup | None
```

- [ ] **Step 8: Add naming, ordering and `display_group_name` to the service**

Append to `server/src/tournament_server/services/displays.py` (add `from tournament_server.models.event import Event` to the imports):

```python
def group_name(db: Session, group: DisplayGroup) -> str:
    if group.kind == AUDIENCE:
        field_set = db.get(FieldSet, group.field_set_id)
        return field_set.name if field_set is not None else ""
    if group.kind == FIELD:
        field = db.get(Field, group.field_id)
        return field.name if field is not None else ""
    return group.name or ""


def group_field_set_id(db: Session, group: DisplayGroup) -> int | None:
    if group.kind == AUDIENCE:
        return group.field_set_id
    if group.kind == FIELD:
        field = db.get(Field, group.field_id)
        return field.field_set_id if field is not None else None
    return None


def session_groups(db: Session, session_id: int) -> list[DisplayGroup]:
    """Each field set's audience group then its field groups, field sets in
    id order, then pit groups by name."""
    rows = db.execute(select(DisplayGroup).where(DisplayGroup.session_id == session_id)).scalars().all()
    field_set_of = dict(
        db.execute(
            select(Field.id, Field.field_set_id)
            .join(FieldSet, FieldSet.id == Field.field_set_id)
            .where(FieldSet.session_id == session_id)
        ).all()
    )

    def order(group: DisplayGroup) -> tuple:
        if group.kind == PIT:
            return (1, 0, 0, (group.name or "").casefold(), group.id)
        if group.kind == AUDIENCE:
            return (0, group.field_set_id, 0, "", group.id)
        return (0, field_set_of.get(group.field_id, 0), 1, "", group.field_id)

    return sorted(rows, key=order)


def display_group_name(db: Session, device_id: int) -> str | None:
    """The name of the group this display follows in the active session."""
    event = db.execute(select(Event)).scalars().first()
    if event is None or event.active_session_id is None:
        return None
    assignment = db.execute(
        select(DisplayAssignment).where(
            DisplayAssignment.session_id == event.active_session_id, DisplayAssignment.device_id == device_id
        )
    ).scalars().first()
    if assignment is None:
        return None
    group = db.get(DisplayGroup, assignment.group_id)
    return group_name(db, group) if group is not None else None
```

- [ ] **Step 9: Add `send_to_device` to `realtime.py`**

Append to `server/src/tournament_server/realtime.py`:

```python
def send_to_device(app: "FastAPI", device_id: int, event: str, data: dict) -> None:
    """Sends to one paired device's open sockets only (display_identify)."""
    registry = app.state.realtime
    if registry.event_loop is None:
        return

    async def _send() -> None:
        sockets = registry.by_device.get(device_id)
        if sockets:
            await _send_to_all(sockets, event, data)

    asyncio.run_coroutine_threadsafe(_send(), registry.event_loop)
```

- [ ] **Step 10: Write the router**

Create `server/src/tournament_server/routers/displays.py`:

```python
"""Display groups: what each paired display shows. See
docs/superpowers/specs/2026-10-15-display-groups-design.md."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.auth import Caller, get_caller, require_admin
from tournament_server.deps import get_db, get_session_id, get_the_event
from tournament_server.models.device import Device
from tournament_server.models.display import DisplayAssignment, DisplayGroup
from tournament_server.models.division import Division
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.display import (
    AssignmentWrite,
    DisplayDevice,
    DisplayGroupRead,
    DisplayGroupUpdate,
    DisplayMe,
    DisplayMeGroup,
    DisplayRef,
    DisplaysRead,
    FieldSetLive,
    PitGroupCreate,
)
from tournament_server.services import displays
from tournament_server.services.display_screens import ScreenSettingsError, clean_rotation, clean_screen

router = APIRouter(tags=["displays"])

DISPLAY_ROLE = "display_device"
DUPLICATE_PIT_NAME = "A pit group with that name already exists."
PIT_NAME_MAX_LENGTH = 100
# Which fields each kind of group takes in PATCH (spec §8).
PATCHABLE = {
    displays.AUDIENCE: {"screen", "screen_settings", "play_sounds"},
    displays.PIT: {"screen", "screen_settings", "rotation", "name", "division_id"},
    displays.FIELD: set(),
}


def notify_display_changed(request: Request, session_id: int, group_id: int | None) -> None:
    realtime.broadcast_active_session(
        request.app, "display_changed", {"session_id": session_id, "group_id": group_id}
    )


def _session_or_404(db: Session, session_id: int) -> TournamentSession:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_obj


def _group_or_404(db: Session, group_id: int) -> DisplayGroup:
    group = db.get(DisplayGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Display group not found")
    return group


def _check_division(db: Session, division_id: int | None) -> None:
    if division_id is not None and db.get(Division, division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")


def _pit_name(db: Session, session_id: int, raw: str | None, exclude_id: int | None = None) -> str:
    name = (raw or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="Enter a name for the pit group.")
    if len(name) > PIT_NAME_MAX_LENGTH:
        raise HTTPException(status_code=422, detail=f"A pit group name can be at most {PIT_NAME_MAX_LENGTH} characters.")
    for other in db.execute(
        select(DisplayGroup).where(DisplayGroup.session_id == session_id, DisplayGroup.kind == displays.PIT)
    ).scalars().all():
        if other.id != exclude_id and (other.name or "").casefold() == name.casefold():
            raise HTTPException(status_code=409, detail=DUPLICATE_PIT_NAME)
    return name


def _group_fields(db: Session, group: DisplayGroup) -> dict:
    return {
        "id": group.id,
        "session_id": group.session_id,
        "kind": group.kind,
        "name": displays.group_name(db, group),
        "field_set_id": displays.group_field_set_id(db, group),
        "field_id": group.field_id,
        "division_id": group.division_id,
        "screen": group.screen,
        "screen_settings": group.screen_settings or {},
        "rotation": group.rotation,
        "play_sounds": group.play_sounds,
    }


def displays_read(request: Request, db: Session, session_id: int) -> DisplaysRead:
    online = set(request.app.state.realtime.by_device)
    display_devices = {
        device.id: device
        for device in db.execute(select(Device).where(Device.role == DISPLAY_ROLE)).scalars().all()
    }
    rows = db.execute(select(DisplayAssignment).where(DisplayAssignment.session_id == session_id)).scalars().all()
    by_group: dict[int, list[DisplayRef]] = {}
    for row in rows:
        device = display_devices.get(row.device_id)
        if device is not None:
            by_group.setdefault(row.group_id, []).append(
                DisplayRef(device_id=device.id, name=device.name, online=device.id in online)
            )
    assigned = {row.device_id for row in rows}
    session_groups = displays.session_groups(db, session_id)
    by_name = lambda ref: ref.name.casefold()  # noqa: E731
    return DisplaysRead(
        session_id=session_id,
        groups=[
            DisplayGroupRead(**_group_fields(db, group), displays=sorted(by_group.get(group.id, []), key=by_name))
            for group in session_groups
        ],
        unassigned=sorted(
            (
                DisplayRef(device_id=device.id, name=device.name, online=device.id in online)
                for device in display_devices.values()
                if device.id not in assigned
            ),
            key=by_name,
        ),
        has_setup=bool(rows) or any(group.kind == displays.PIT for group in session_groups),
    )


@router.get("/api/displays", response_model=DisplaysRead)
def list_displays(
    request: Request,
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DisplaysRead:
    _session_or_404(db, session_id)
    return displays_read(request, db, session_id)


@router.post("/api/displays/pit-groups", response_model=DisplayGroupRead, status_code=201)
def create_pit_group(
    payload: PitGroupCreate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DisplayGroupRead:
    _session_or_404(db, payload.session_id)
    _check_division(db, payload.division_id)
    group = DisplayGroup(
        session_id=payload.session_id,
        kind=displays.PIT,
        name=_pit_name(db, payload.session_id, payload.name),
        division_id=payload.division_id,
        screen=displays.DEFAULT_PIT_SCREEN,
        screen_settings={},
    )
    db.add(group)
    db.commit()
    notify_display_changed(request, group.session_id, group.id)
    return DisplayGroupRead(**_group_fields(db, group), displays=[])


@router.patch("/api/displays/groups/{group_id}", response_model=DisplayGroupRead)
def update_group(
    group_id: int,
    payload: DisplayGroupUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DisplayGroupRead:
    group = _group_or_404(db, group_id)
    changes = payload.model_dump(exclude_unset=True)
    refused = sorted(set(changes) - PATCHABLE[group.kind])
    if refused:
        raise HTTPException(status_code=422, detail=f"{refused[0]} can't be set on a {group.kind} group.")
    try:
        if "screen" in changes or "screen_settings" in changes:
            screen = changes.get("screen", group.screen)
            if screen is None:
                raise ScreenSettingsError("screen can't be empty.")
            if "screen_settings" in changes:
                settings = changes["screen_settings"]
            else:
                # A different screen starts from its own defaults.
                settings = group.screen_settings if screen == group.screen else {}
            group.screen_settings = clean_screen(screen, settings, group.kind)
            group.screen = screen
        if "rotation" in changes:
            group.rotation = None if changes["rotation"] is None else clean_rotation(changes["rotation"])
    except ScreenSettingsError as error:
        raise HTTPException(status_code=422, detail=str(error))
    if "name" in changes:
        group.name = _pit_name(db, group.session_id, changes["name"], exclude_id=group.id)
    if "division_id" in changes:
        _check_division(db, changes["division_id"])
        group.division_id = changes["division_id"]
    if "play_sounds" in changes:
        if changes["play_sounds"] is None:
            raise HTTPException(status_code=422, detail="play_sounds must be true or false.")
        group.play_sounds = changes["play_sounds"]
    db.commit()
    notify_display_changed(request, group.session_id, group.id)
    members = displays_read(request, db, group.session_id)
    return next(g for g in members.groups if g.id == group.id)


@router.delete("/api/displays/groups/{group_id}", status_code=204)
def delete_group(
    group_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    group = _group_or_404(db, group_id)
    if group.kind != displays.PIT:
        raise HTTPException(status_code=409, detail="Only pit groups can be deleted.")
    session_id = group.session_id
    displays.delete_group(db, group)
    db.commit()
    notify_display_changed(request, session_id, group_id)
    realtime.broadcast_active_session(request.app, "devices_changed", {})
    return Response(status_code=204)


@router.put("/api/displays/assignments", response_model=DisplaysRead)
def assign_display(
    payload: AssignmentWrite,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DisplaysRead:
    _session_or_404(db, payload.session_id)
    device = db.get(Device, payload.device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if device.role != DISPLAY_ROLE:
        raise HTTPException(status_code=422, detail="Only a display can join a display group.")
    existing = db.execute(
        select(DisplayAssignment).where(
            DisplayAssignment.session_id == payload.session_id, DisplayAssignment.device_id == device.id
        )
    ).scalars().first()
    if payload.group_id is None:
        if existing is not None:
            db.delete(existing)
    else:
        group = _group_or_404(db, payload.group_id)
        if group.session_id != payload.session_id:
            raise HTTPException(status_code=422, detail="That group belongs to another session.")
        if existing is None:
            db.add(DisplayAssignment(session_id=payload.session_id, device_id=device.id, group_id=group.id))
        else:
            existing.group_id = group.id
    db.commit()
    notify_display_changed(request, payload.session_id, payload.group_id)
    realtime.broadcast_active_session(request.app, "devices_changed", {})
    return displays_read(request, db, payload.session_id)


@router.post("/api/displays/{device_id}/identify", status_code=204)
def identify_display(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    if device.role != DISPLAY_ROLE:
        raise HTTPException(status_code=422, detail="Only a display can be identified.")
    realtime.send_to_device(request.app, device_id, "display_identify", {"device_id": device_id})
    return Response(status_code=204)


@router.get("/api/displays/me", response_model=DisplayMe)
def read_me(caller: Caller = Depends(get_caller), db: Session = Depends(get_db)) -> DisplayMe:
    if caller.device_id is None or caller.role != DISPLAY_ROLE:
        raise HTTPException(status_code=403, detail="Only a paired display can read its display setup.")
    device = db.get(Device, caller.device_id)
    event = get_the_event(db)
    session_id = event.active_session_id if event is not None else None
    group = None
    if session_id is not None:
        assignment = db.execute(
            select(DisplayAssignment).where(
                DisplayAssignment.session_id == session_id, DisplayAssignment.device_id == device.id
            )
        ).scalars().first()
        row = db.get(DisplayGroup, assignment.group_id) if assignment is not None else None
        if row is not None:
            fields = _group_fields(db, row)
            field_set = db.get(FieldSet, fields["field_set_id"]) if fields["field_set_id"] is not None else None
            live = (
                FieldSetLive(queued_match_id=field_set.queued_match_id, timeout_deadline=field_set.timeout_deadline)
                if field_set is not None
                else None
            )
            group = DisplayMeGroup(**fields, field_set=live)
    return DisplayMe(device=DisplayDevice(id=device.id, name=device.name), session_id=session_id, group=group)
```

In `app.py` add `displays` to the `from tournament_server.routers import (...)` list and `app.include_router(displays.router)` after `app.include_router(devices.router)`.

- [ ] **Step 11: Clean up assignments from the devices router and show each display's group**

In `schemas/device.py` add to `DeviceRead`: `display_group: str | None = None`.

In `routers/devices.py` add `from tournament_server.services import displays` and:
- in `to_device_read`, pass `display_group=displays.display_group_name(db, device.id) if device.role == "display_device" else None`;
- in `update_device`, right after `device.role = role` inside the `if "role" in changes:` block, add:

```python
        if role_changed and before["role"] == "display_device":
            displays.delete_device_assignments(db, device.id)
```

- in `delete_device`, call `displays.delete_device_assignments(db, device.id)` immediately before `db.delete(device)`.

- [ ] **Step 12: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_display_screens.py tests/test_displays_api.py tests/test_device_management.py tests/test_device_sockets.py tests/test_pairing_api.py`
Expected: all pass.

- [ ] **Step 13: Commit**

```bash
git add server/src/tournament_server/services/display_screens.py server/src/tournament_server/schemas/display.py \
  server/src/tournament_server/routers/displays.py server/src/tournament_server/services/displays.py \
  server/src/tournament_server/realtime.py server/src/tournament_server/routers/devices.py \
  server/src/tournament_server/schemas/device.py server/src/tournament_server/app.py \
  server/tests/test_display_screens.py server/tests/test_displays_api.py
git commit -m "Add the display screen registry and the displays API: list groups with their displays, pit groups, screen and rotation changes checked against the registry, assignments, identify, and a display's own setup, broadcasting display_changed and dropping a display's assignments when it is deleted or stops being a display.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Copy displays from another session

**Files:**
- Modify: `server/src/tournament_server/services/displays.py` (`copy_displays`)
- Modify: `server/src/tournament_server/schemas/display.py` (`CopyDisplaysRequest`, `UnplacedDisplay`, `CopyDisplaysResult`)
- Modify: `server/src/tournament_server/routers/displays.py` (the endpoint)
- Test: `server/tests/test_copy_displays.py`

**Interfaces:**
- Consumes: Task 1 lifecycle, Task 2 `group_name`, `notify_display_changed`.
- Produces: `copy_displays(db, target_session_id: int, source_session_id: int) -> list[dict]` (each `{device_id, device_name, source_group_name}`), `has_display_setup(db, session_id) -> bool`; `POST /api/sessions/{id}/copy-displays {source_session_id} -> {unplaced}` (201).

Divisions are event-wide, so "matched by division name" in the spec means the copy keeps the source's `division_id` while that division still exists, else null.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_copy_displays.py`:

```python
from __future__ import annotations

import pytest

from device_helpers import paired_device
from display_helpers import add_field_set, admin_token, assignments, groups, setup_event
from skills_helpers import next_event


@pytest.fixture
def league(client):
    saturday = setup_event(client)
    add_field_set(client, saturday, "Main Fields", ("Field 1", "Field 2"))
    sunday = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    return {"saturday": saturday, "sunday": sunday}


def _put(client, session_id, device_id, group_id):
    assert client.put(
        "/api/displays/assignments", json={"session_id": session_id, "device_id": device_id, "group_id": group_id}
    ).status_code == 200


def _copy(client, target, source):
    return client.post(f"/api/sessions/{target}/copy-displays", json={"source_session_id": source})


def test_copy_matches_groups_by_name_and_lists_what_it_cannot_place(client, league):
    saturday, sunday = league["saturday"], league["sunday"]
    division = client.get("/api/divisions").json()[0]["id"]
    audience = groups(client, session_id=saturday, kind="audience")[0]
    client.patch(f"/api/displays/groups/{audience.id}", json={"screen": "upcoming_matches", "screen_settings": {"count": 5}, "play_sounds": True})
    pit = client.post("/api/displays/pit-groups", json={"session_id": saturday, "name": "Pits", "division_id": division}).json()
    client.patch(f"/api/displays/groups/{pit['id']}", json={"rotation": [{"screen": "schedule"}, {"screen": "logo", "seconds": 10}]})
    big, field_two, pit_tv, scorer = (paired_device(client, role="display_device", name=n) for n in ("Big", "F2", "Pit", "Was display"))
    field_groups = groups(client, session_id=saturday, kind="field")
    _put(client, saturday, big["id"], audience.id)
    _put(client, saturday, field_two["id"], field_groups[1].id)
    _put(client, saturday, pit_tv["id"], pit["id"])
    _put(client, saturday, scorer["id"], field_groups[0].id)
    client.patch(f"/api/devices/{scorer['id']}", json={"role": "scorer"})  # drops its assignment
    # Sunday's venue has the same field group but only a "Field 1".
    add_field_set(client, sunday, "Main Fields", ("Field 1",))
    unplaced_tv = paired_device(client, role="display_device", name="Lost")
    _put(client, saturday, unplaced_tv["id"], field_groups[0].id)
    client.patch(f"/api/fields/{groups(client, session_id=sunday, kind='field')[0].field_id}", json={"name": "Field A"})

    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        copied = _copy(client, sunday, saturday)
        assert copied.status_code == 201, copied.text
        assert next_event(socket, "display_changed")["data"] == {"session_id": sunday, "group_id": None}
    assert sorted(copied.json()["unplaced"], key=lambda u: u["device_name"]) == [
        {"device_id": field_two["id"], "device_name": "F2", "source_group_name": "Field 2"},
        {"device_id": unplaced_tv["id"], "device_name": "Lost", "source_group_name": "Field 1"},
    ]
    sunday_audience = groups(client, session_id=sunday, kind="audience")[0]
    assert (sunday_audience.screen, sunday_audience.screen_settings, sunday_audience.play_sounds) == (
        "upcoming_matches", {"count": 5, "scope": "field_set"}, True,
    )
    sunday_pit = groups(client, session_id=sunday, kind="pit")[0]
    assert (sunday_pit.name, sunday_pit.division_id, sunday_pit.rotation) == ("Pits", division, [
        {"screen": "schedule", "settings": {}, "seconds": 20}, {"screen": "logo", "settings": {}, "seconds": 10},
    ])
    placed = {(a.device_id, a.group_id) for a in assignments(client) if a.session_id == sunday}
    assert placed == {(big["id"], sunday_audience.id), (pit_tv["id"], sunday_pit.id)}


def test_copy_is_refused_when_the_target_is_set_up_or_the_source_is_not(client, league):
    saturday, sunday = league["saturday"], league["sunday"]
    assert _copy(client, sunday, saturday).status_code == 422  # nothing set up on Saturday
    client.post("/api/displays/pit-groups", json={"session_id": saturday, "name": "Pits"})
    assert _copy(client, saturday, saturday).status_code == 422
    assert _copy(client, 999, saturday).status_code == 404
    assert _copy(client, sunday, 999).status_code == 404
    client.post("/api/displays/pit-groups", json={"session_id": sunday, "name": "Own"})
    assert _copy(client, sunday, saturday).status_code == 409
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_copy_displays.py`
Expected: FAIL (404 from the missing route).

- [ ] **Step 3: Add the schemas**

Append to `schemas/display.py`:

```python
class CopyDisplaysRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_session_id: int


class UnplacedDisplay(BaseModel):
    device_id: int
    device_name: str
    source_group_name: str


class CopyDisplaysResult(BaseModel):
    unplaced: list[UnplacedDisplay]
```

- [ ] **Step 4: Write the service function**

Append to `services/displays.py` (add `from tournament_server.models.device import Device` and `from tournament_server.models.division import Division` to the imports):

```python
def has_display_setup(db: Session, session_id: int) -> bool:
    """A session is set up once it has a pit group or an assignment."""
    pit = db.execute(
        select(DisplayGroup.id).where(DisplayGroup.session_id == session_id, DisplayGroup.kind == PIT).limit(1)
    ).first()
    assigned = db.execute(
        select(DisplayAssignment.id).where(DisplayAssignment.session_id == session_id).limit(1)
    ).first()
    return pit is not None or assigned is not None


def _target_groups_by_key(db: Session, session_id: int) -> dict[tuple, DisplayGroup]:
    """Each target group under its copy key: ("audience", set name),
    ("field", set name, field name) or ("pit", name), all case-folded. The
    first group by id wins a clash."""
    keys: dict[tuple, DisplayGroup] = {}
    for group in sorted(
        db.execute(select(DisplayGroup).where(DisplayGroup.session_id == session_id)).scalars().all(),
        key=lambda g: g.id,
    ):
        keys.setdefault(_copy_key(db, group), group)
    return keys


def _copy_key(db: Session, group: DisplayGroup) -> tuple:
    if group.kind == FIELD:
        field = db.get(Field, group.field_id)
        field_set = db.get(FieldSet, field.field_set_id)
        return (FIELD, field_set.name.casefold(), field.name.casefold())
    return (group.kind, group_name(db, group).casefold())


def copy_displays(db: Session, target_session_id: int, source_session_id: int) -> list[dict]:
    """Copies another session's display setup (spec §4.5). Returns the
    displays it couldn't place."""
    targets = _target_groups_by_key(db, target_session_id)
    source_groups = db.execute(
        select(DisplayGroup).where(DisplayGroup.session_id == source_session_id).order_by(DisplayGroup.id)
    ).scalars().all()
    copied_to: dict[int, DisplayGroup] = {}
    for source in source_groups:
        key = _copy_key(db, source)
        if source.kind == PIT:
            division_id = source.division_id if source.division_id and db.get(Division, source.division_id) else None
            copy = DisplayGroup(
                session_id=target_session_id,
                kind=PIT,
                name=source.name,
                division_id=division_id,
                screen=source.screen,
                screen_settings=dict(source.screen_settings or {}),
                rotation=[dict(entry) for entry in source.rotation] if source.rotation else None,
            )
            db.add(copy)
            db.flush()
            targets.setdefault(key, copy)
            copied_to[source.id] = copy
            continue
        target = targets.get(key)
        if target is None:
            continue
        if source.kind == AUDIENCE:
            target.screen = source.screen
            target.screen_settings = dict(source.screen_settings or {})
            target.play_sounds = source.play_sounds
        copied_to[source.id] = target
    unplaced = []
    for assignment in db.execute(
        select(DisplayAssignment).where(DisplayAssignment.session_id == source_session_id).order_by(DisplayAssignment.id)
    ).scalars().all():
        device = db.get(Device, assignment.device_id)
        if device is None or device.role != "display_device":
            continue
        target = copied_to.get(assignment.group_id)
        if target is None:
            source = db.get(DisplayGroup, assignment.group_id)
            unplaced.append(
                {"device_id": device.id, "device_name": device.name, "source_group_name": group_name(db, source)}
            )
            continue
        db.add(DisplayAssignment(session_id=target_session_id, device_id=device.id, group_id=target.id))
    db.flush()
    return unplaced
```

- [ ] **Step 5: Add the endpoint**

Append to `routers/displays.py` (import `CopyDisplaysRequest`, `CopyDisplaysResult`, `UnplacedDisplay` from the schemas):

```python
@router.post("/api/sessions/{session_id}/copy-displays", response_model=CopyDisplaysResult, status_code=201)
def copy_displays(
    session_id: int,
    payload: CopyDisplaysRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> CopyDisplaysResult:
    _session_or_404(db, session_id)
    if db.get(TournamentSession, payload.source_session_id) is None:
        raise HTTPException(status_code=404, detail="Source session not found")
    if payload.source_session_id == session_id:
        raise HTTPException(status_code=422, detail="A session can't copy its own displays")
    if displays.has_display_setup(db, session_id):
        raise HTTPException(status_code=409, detail="This session already has displays set up")
    if not displays.has_display_setup(db, payload.source_session_id):
        raise HTTPException(status_code=422, detail="The source session has no displays set up")
    unplaced = displays.copy_displays(db, session_id, payload.source_session_id)
    db.commit()
    notify_display_changed(request, session_id, None)
    realtime.broadcast_active_session(request.app, "devices_changed", {})
    return CopyDisplaysResult(unplaced=[UnplacedDisplay(**entry) for entry in unplaced])
```

- [ ] **Step 6: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_copy_displays.py tests/test_displays_api.py`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add server/src/tournament_server/services/displays.py server/src/tournament_server/schemas/display.py \
  server/src/tournament_server/routers/displays.py server/tests/test_copy_displays.py
git commit -m "Copy a session's display setup into a session with none yet: audience screens and sounds, pit groups with their rotations, and every display placed in the group of the same field group, field or pit name, listing the displays it couldn't place.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Match control on the server: one running match per field group, the automatic switch, the override and time-outs

**Files:**
- Modify: `server/src/tournament_server/services/displays.py` (`field_ids_for_set`, `field_set_id_for_field`, `running_match`, `on_match_started`)
- Modify: `server/src/tournament_server/schemas/field_set.py` (`FieldSetRead` fields, `QueuedMatchWrite`, `TimeoutWrite`)
- Modify: `server/src/tournament_server/routers/field_sets.py` (queued-match and time-out endpoints)
- Modify: `server/src/tournament_server/routers/matches.py` (`start_match`)
- Modify: `server/src/tournament_server/routers/scores.py` (clear the override once its match is complete)
- Test: `server/tests/test_match_control_displays.py`

**Interfaces:**
- Consumes: Task 1 `clear_queued_matches`, Task 2 `notify_display_changed`.
- Produces: `field_ids_for_set(db, field_set_id) -> list[int]`, `field_set_id_for_field(db, field_id: int | None) -> int | None`, `running_match(db, field_set_id, exclude_id=None) -> Match | None` (phase not in `not_started`/`ended`), `on_match_started(db, field_set_id) -> list[int]` (audience group ids it switched to `in_match`; also clears the override and time-out); `notify_field_set_changed(app, field_set_id)` in `services/displays.py`; `FieldSetRead.queued_match_id`, `FieldSetRead.timeout_deadline`; endpoints `PUT /api/field-sets/{id}/queued-match`, `POST /api/field-sets/{id}/timeout`, `DELETE /api/field-sets/{id}/timeout`; start refuses (409 `Another match is running on this field group.`) while another match on the field group runs.

The spec says the server "already refuses" a second running match on a field group; it doesn't (`start_match` has no such check). This task adds it.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_match_control_displays.py`:

```python
from __future__ import annotations

import datetime as dt

import pytest

from display_helpers import add_field_set, add_match, add_teams, admin_token, groups, score_match, setup_event
from skills_helpers import next_event
from tournament_server.db import utc_now


@pytest.fixture
def field(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    teams = add_teams(client)
    matches = [
        add_match(client, session_id, field_set["field_ids"][n % 2], n + 1, teams, minutes=5 * n) for n in range(3)
    ]
    return {"session_id": session_id, "field_set": field_set, "matches": matches}


def _field_set(client, field_set_id):
    return next(fs for fs in client.get("/api/field-sets").json() if fs["id"] == field_set_id)


def test_field_sets_report_their_override_and_time_out(client, field):
    body = _field_set(client, field["field_set"]["id"])
    assert body["queued_match_id"] is None and body["timeout_deadline"] is None


def test_starting_a_match_moves_the_audience_to_in_match_and_clears_override_and_time_out(client, field):
    fs_id = field["field_set"]["id"]
    first, second, _ = field["matches"]
    client.put(f"/api/field-sets/{fs_id}/queued-match", json={"match_id": second["id"]})
    client.post(f"/api/field-sets/{fs_id}/timeout", json={"seconds": 60})
    audience = groups(client, kind="audience")[0]
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        assert client.post(f"/api/matches/{second['id']}/start").status_code == 200
        assert next_event(socket, "display_changed")["data"] == {"session_id": field["session_id"], "group_id": audience.id}
        assert next_event(socket, "field_set_changed")["data"] == {"field_set_id": fs_id}
    after = groups(client, kind="audience")[0]
    assert (after.screen, after.screen_settings) == ("in_match", {})
    body = _field_set(client, fs_id)
    assert body["queued_match_id"] is None and body["timeout_deadline"] is None


def test_only_one_match_runs_per_field_group(client, field):
    first, second, _ = field["matches"]
    assert client.post(f"/api/matches/{first['id']}/start").status_code == 200
    refused = client.post(f"/api/matches/{second['id']}/start")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Another match is running on this field group."
    other_set = add_field_set(client, field["session_id"], "Side Fields", ("Side 1",))
    elsewhere = add_match(client, field["session_id"], other_set["field_ids"][0], 9, add_teams(client))
    assert client.post(f"/api/matches/{elsewhere['id']}/start").status_code == 200
    assert client.post(f"/api/matches/{first['id']}/end").status_code == 200
    assert client.post(f"/api/matches/{second['id']}/start").status_code == 200


def test_a_match_without_a_field_still_starts(client, field):
    loose = add_match(client, field["session_id"], None, 10, add_teams(client))
    assert client.post(f"/api/matches/{field['matches'][0]['id']}/start").status_code == 200
    assert client.post(f"/api/matches/{loose['id']}/start").status_code == 200


def test_the_override_must_be_an_unstarted_match_on_this_field_group(client, field):
    fs_id = field["field_set"]["id"]
    first, second, third = field["matches"]
    queue = lambda match_id: client.put(f"/api/field-sets/{fs_id}/queued-match", json={"match_id": match_id})
    assert queue(third["id"]).json()["queued_match_id"] == third["id"]
    assert queue(None).json()["queued_match_id"] is None
    client.post(f"/api/matches/{first['id']}/start")
    assert queue(first["id"]).status_code == 422
    assert queue(999).status_code == 422
    other_set = add_field_set(client, field["session_id"], "Side Fields", ("Side 1",))
    foreign = add_match(client, field["session_id"], other_set["field_ids"][0], 9, add_teams(client))
    assert queue(foreign["id"]).status_code == 422
    assert client.put("/api/field-sets/999/queued-match", json={"match_id": None}).status_code == 404


def test_the_override_is_cleared_when_its_match_is_fully_scored(client, field):
    fs_id = field["field_set"]["id"]
    third = field["matches"][2]
    client.put(f"/api/field-sets/{fs_id}/queued-match", json={"match_id": third["id"]})
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        score_match(client, third)
        assert next_event(socket, "field_set_changed")["data"] == {"field_set_id": fs_id}
    assert _field_set(client, fs_id)["queued_match_id"] is None


def test_time_outs_start_restart_and_cancel(client, field):
    fs_id = field["field_set"]["id"]
    before = utc_now()
    started = client.post(f"/api/field-sets/{fs_id}/timeout", json={})
    assert started.status_code == 200
    deadline = dt.datetime.fromisoformat(started.json()["timeout_deadline"])
    assert dt.timedelta(seconds=179) <= deadline - before <= dt.timedelta(seconds=182)
    restarted = client.post(f"/api/field-sets/{fs_id}/timeout", json={"seconds": 10})
    assert dt.datetime.fromisoformat(restarted.json()["timeout_deadline"]) < deadline
    for seconds in (9, 601):
        assert client.post(f"/api/field-sets/{fs_id}/timeout", json={"seconds": seconds}).status_code == 422
    with client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as socket:
        assert client.delete(f"/api/field-sets/{fs_id}/timeout").status_code == 204
        assert next_event(socket, "field_set_changed")["data"] == {"field_set_id": fs_id}
    assert _field_set(client, fs_id)["timeout_deadline"] is None


def test_only_admins_queue_and_time_out(client, field):
    from device_helpers import paired_device

    scorer = paired_device(client, role="scorer")
    fs_id = field["field_set"]["id"]
    assert client.put(f"/api/field-sets/{fs_id}/queued-match", json={"match_id": None}, headers=scorer["headers"]).status_code == 403
    assert client.post(f"/api/field-sets/{fs_id}/timeout", json={}, headers=scorer["headers"]).status_code == 403
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_match_control_displays.py`
Expected: FAIL (`KeyError: 'queued_match_id'` and missing routes).

- [ ] **Step 3: Add the service functions**

Append to `services/displays.py` (add `from tournament_server import realtime` and `from tournament_server.models.match import Match` to the imports; `realtime` imports only `deps`, so there is no cycle):

```python
RUNNING_EXCLUDED_PHASES = ("not_started", "ended")


def field_ids_for_set(db: Session, field_set_id: int) -> list[int]:
    return list(db.execute(select(Field.id).where(Field.field_set_id == field_set_id)).scalars().all())


def field_set_id_for_field(db: Session, field_id: int | None) -> int | None:
    if field_id is None:
        return None
    field = db.get(Field, field_id)
    return field.field_set_id if field is not None else None


def running_match(db: Session, field_set_id: int, exclude_id: int | None = None) -> Match | None:
    query = select(Match).where(
        Match.field_id.in_(field_ids_for_set(db, field_set_id)),
        Match.phase.not_in(RUNNING_EXCLUDED_PHASES),
    )
    if exclude_id is not None:
        query = query.where(Match.id != exclude_id)
    return db.execute(query.limit(1)).scalars().first()


def on_match_started(db: Session, field_set_id: int) -> list[int]:
    """A match on this field set just started (spec §6.3): its audience
    groups move to In Match, and its override and time-out are cleared.
    Returns the ids of the audience groups it switched."""
    switched = []
    for group in db.execute(
        select(DisplayGroup).where(DisplayGroup.kind == AUDIENCE, DisplayGroup.field_set_id == field_set_id)
    ).scalars().all():
        if group.screen != "in_match":
            group.screen = "in_match"
            group.screen_settings = {}
            switched.append(group.id)
    field_set = db.get(FieldSet, field_set_id)
    if field_set is not None:
        field_set.queued_match_id = None
        field_set.timeout_deadline = None
    db.flush()
    return switched


def notify_field_set_changed(app, field_set_id: int) -> None:
    realtime.broadcast_active_session(app, "field_set_changed", {"field_set_id": field_set_id})
```

- [ ] **Step 4: Extend the field set schemas and add the endpoints**

In `schemas/field_set.py`, add `import datetime as dt` and `from pydantic import Field as PydanticField`, extend `FieldSetRead` and add the two request models:

```python
class FieldSetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    name: str
    division_id: int | None
    queued_match_id: int | None = None
    timeout_deadline: dt.datetime | None = None


class QueuedMatchWrite(BaseModel):
    match_id: int | None


class TimeoutWrite(BaseModel):
    seconds: int = PydanticField(180, ge=10, le=600)
```

Append to `routers/field_sets.py` (add `from fastapi import Request`, `from tournament_server.db import utc_now`, `import datetime as dt`, `from tournament_server.services import qualification`, and import `QueuedMatchWrite`, `TimeoutWrite`):

```python
def _field_set_or_404(db: Session, field_set_id: int) -> FieldSet:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    return field_set


@router.put("/{field_set_id}/queued-match", response_model=FieldSetRead)
def queue_match(
    field_set_id: int,
    payload: QueuedMatchWrite,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FieldSet:
    """Sets or clears the field group's next-match override (spec §6.1)."""
    field_set = _field_set_or_404(db, field_set_id)
    if payload.match_id is not None:
        match = db.get(Match, payload.match_id)
        if (
            match is None
            or match.field_id not in displays.field_ids_for_set(db, field_set_id)
            or match.phase != "not_started"
            or match.status in ("completed", qualification.NOT_PLAYED)
        ):
            raise HTTPException(status_code=422, detail="Pick a match on this field group that hasn't started.")
    field_set.queued_match_id = payload.match_id
    db.commit()
    db.refresh(field_set)
    displays.notify_field_set_changed(request.app, field_set_id)
    return field_set


@router.post("/{field_set_id}/timeout", response_model=FieldSetRead)
def start_timeout(
    field_set_id: int,
    payload: TimeoutWrite,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FieldSet:
    field_set = _field_set_or_404(db, field_set_id)
    field_set.timeout_deadline = utc_now() + dt.timedelta(seconds=payload.seconds)
    db.commit()
    db.refresh(field_set)
    displays.notify_field_set_changed(request.app, field_set_id)
    return field_set


@router.delete("/{field_set_id}/timeout", status_code=204)
def cancel_timeout(
    field_set_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    field_set = _field_set_or_404(db, field_set_id)
    field_set.timeout_deadline = None
    db.commit()
    displays.notify_field_set_changed(request.app, field_set_id)
    return Response(status_code=204)
```

- [ ] **Step 5: Guard the start and switch the audience**

In `routers/matches.py` add `from tournament_server.realtime import broadcast_active_session` (next to the existing realtime import) and `from tournament_server.services import displays`. In `start_match`, after the `if match.phase != "not_started": ...` check, add:

```python
    field_set_id = displays.field_set_id_for_field(db, match.field_id)
    if field_set_id is not None and displays.running_match(db, field_set_id, exclude_id=match.id) is not None:
        raise HTTPException(status_code=409, detail="Another match is running on this field group.")
```

and after `schedule_auto_advance(...)`, before `return _to_match_read(match, db)`, add:

```python
    if field_set_id is not None:
        switched = displays.on_match_started(db, field_set_id)
        db.commit()
        for group_id in switched:
            broadcast_active_session(
                request.app, "display_changed", {"session_id": match.session_id, "group_id": group_id}
            )
        displays.notify_field_set_changed(request.app, field_set_id)
```

- [ ] **Step 6: Clear the override once its match is complete**

In `routers/scores.py` add `from tournament_server.services import displays`, and replace

```python
    if len(scored_alliance_ids) == len(all_alliances):
        match.status = "completed"
        db.commit()
```

with

```python
    if len(scored_alliance_ids) == len(all_alliances):
        match.status = "completed"
        cleared = displays.clear_queued_matches(db, [match.id])
        db.commit()
        for field_set_id in cleared:
            displays.notify_field_set_changed(request.app, field_set_id)
```

- [ ] **Step 7: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_match_control_displays.py tests/test_match_control_endpoints.py tests/test_broadcast_wiring.py tests/test_field_sets.py tests/test_scores.py`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add server/src/tournament_server/services/displays.py server/src/tournament_server/schemas/field_set.py \
  server/src/tournament_server/routers/field_sets.py server/src/tournament_server/routers/matches.py \
  server/src/tournament_server/routers/scores.py server/tests/test_match_control_displays.py
git commit -m "Run one match at a time per field group, switch the field group's audience displays to In Match when a match starts, and add the next-match override and the time-out to field groups, broadcasting field_set_changed whenever either changes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The reads the screens need, and display read access

**Files:**
- Modify: `server/src/tournament_server/schemas/score_record.py` (`AllianceScoreRead`)
- Modify: `server/src/tournament_server/routers/scores.py` (`list_router`, `GET /api/scores`)
- Modify: `server/src/tournament_server/routers/finals.py` (`GET /api/finals`)
- Modify: `server/src/tournament_server/routers/event.py` (`GET /api/event/scoresheet-schema`, richer match format)
- Modify: `server/src/tournament_server/schemas/event.py` (`MatchFormatRead`)
- Modify: `server/src/tournament_server/schemas/match.py`, `server/src/tournament_server/routers/matches.py` (`bracket_matchup_id`, `bracket_alliance_id` on `MatchRead`)
- Modify: `server/src/tournament_server/app.py` (include `scores.list_router`)
- Test: `server/tests/test_display_reads.py`

**Interfaces:**
- Produces: `GET /api/scores?session_id=` (any role) → `list[AllianceScoreRead{match_id, alliance_id, score, data, teams, saved_at}]` (score is the effective score: 0 when the alliance is out under the team-flag rules; `[]` when the event has no game plugin); `GET /api/finals?session_id=&division_id=` (any role) → `list[FinalsBracketRead]`, newest first, `[]` without a game plugin; `GET /api/event/scoresheet-schema` (any role) → the plugin's `scoresheet_schema()`; `MatchFormatRead` gains `game_model`, `autonomous_seconds`, `driver_seconds`; `MatchRead` gains `bracket_matchup_id`, `bracket_alliance_id`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_display_reads.py`:

```python
from __future__ import annotations

import pytest

from device_helpers import paired_device
from display_helpers import add_field_set, add_match, add_teams, score_match, setup_event
from tournament_server.models.finals_bracket import FinalsBracket


@pytest.fixture
def scored(client):
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    match = add_match(client, session_id, field_set["field_ids"][0], 1, add_teams(client))
    score_match(client, match, high_balls=(3, 1))
    display = paired_device(client, role="display_device")
    return {"session_id": session_id, "field_set": field_set, "match": match, "display": display}


def test_scores_list_each_alliances_effective_score_and_sheet(client, scored):
    rows = client.get(f"/api/scores?session_id={scored['session_id']}", headers=scored["display"]["headers"]).json()
    by_alliance = {row["alliance_id"]: row for row in rows}
    red, blue = scored["match"]["alliances"]
    assert by_alliance[red["id"]]["score"] == 9 and by_alliance[blue["id"]]["score"] == 3
    assert by_alliance[red["id"]]["match_id"] == scored["match"]["id"]
    assert by_alliance[red["id"]]["data"]["high_balls"] == 3
    assert by_alliance[red["id"]]["teams"] == [] and by_alliance[red["id"]]["saved_at"] is not None


def test_a_flagged_alliance_scores_zero_in_the_list(client, scored):
    red = scored["match"]["alliances"][0]
    flags = [{"team_id": t, "dq": True} for t in red["team_ids"]]
    client.post(
        f"/api/matches/{scored['match']['id']}/alliances/{red['id']}/score",
        json={"data": {"high_balls": 3, "low_balls": 0, "parked": False, "auto_winner": "tie"}, "teams": flags},
    )
    rows = client.get(f"/api/scores?session_id={scored['session_id']}").json()
    assert next(r for r in rows if r["alliance_id"] == red["id"])["score"] == 0


def test_finals_are_listed_newest_first_for_the_division(client, scored):
    division = client.get("/api/divisions").json()[0]["id"]
    with client.app.state.session_factory() as db:
        for division_id in (None, None, division):
            db.add(FinalsBracket(session_id=scored["session_id"], division_id=division_id,
                                 field_set_id=scored["field_set"]["id"], format="score_chase", bracket_size=2))
        db.commit()
    headers = scored["display"]["headers"]
    unscoped = client.get(f"/api/finals?session_id={scored['session_id']}", headers=headers).json()
    assert [b["division_id"] for b in unscoped] == [None, None] and unscoped[0]["id"] > unscoped[1]["id"]
    scoped = client.get(f"/api/finals?session_id={scored['session_id']}&division_id={division}", headers=headers).json()
    assert [b["division_id"] for b in scoped] == [division]


def test_the_scoresheet_schema_and_match_format_are_readable(client, scored):
    headers = scored["display"]["headers"]
    schema = client.get("/api/event/scoresheet-schema", headers=headers).json()
    assert [f["name"] for f in schema] == ["high_balls", "low_balls", "parked", "auto_winner"]
    match_format = client.get("/api/event/match-format", headers=headers).json()
    assert (match_format["game_model"], match_format["autonomous_seconds"], match_format["driver_seconds"]) == (
        "head_to_head", 15, 105,
    )


def test_matches_carry_their_finals_links(client, scored):
    match = client.get(f"/api/matches/{scored['match']['id']}").json()
    assert match["bracket_matchup_id"] is None and match["bracket_alliance_id"] is None


def test_reads_without_a_game_plugin_are_empty(client):
    session_id = setup_event(client, game=None)
    assert client.get(f"/api/scores?session_id={session_id}").json() == []
    assert client.get(f"/api/finals?session_id={session_id}").json() == []
    assert client.get("/api/event/scoresheet-schema").status_code == 422


def test_a_display_can_read_everything_a_screen_reads(client, scored):
    session_id = scored["session_id"]
    headers = scored["display"]["headers"]
    paths = [
        "/api/event", "/api/event/match-format", "/api/event/scoresheet-schema", "/api/divisions", "/api/teams",
        f"/api/matches?session_id={session_id}", f"/api/scores?session_id={session_id}",
        f"/api/field-sets?session_id={session_id}", f"/api/fields?session_id={session_id}",
        f"/api/rankings?session_id={session_id}", "/api/ranking-settings", "/api/skills/settings",
        f"/api/skills/rankings?tab=overall&session_id={session_id}",
        f"/api/sessions/{session_id}/skills/attempts", f"/api/finals?session_id={session_id}",
        "/api/time-sync", "/api/displays/me",
    ]
    for path in paths:
        assert client.get(path, headers=headers).status_code == 200, path
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd server && .venv/bin/pytest -q tests/test_display_reads.py`
Expected: FAIL (404s and missing keys).

- [ ] **Step 3: Add `GET /api/scores`**

Append to `schemas/score_record.py`:

```python
class AllianceScoreRead(BaseModel):
    match_id: int
    alliance_id: int
    score: int
    data: dict[str, Any]
    teams: list[TeamFlags]
    saved_at: dt.datetime | None
```

In `routers/scores.py` add imports (`from fastapi import Query` is not needed; add `from tournament_server.auth import require_any_role`, `from tournament_server.deps import get_optional_game_plugin, get_session_id`, and `AllianceScoreRead`), then add below `router = ...`:

```python
# Saved scores by session, for the display screens (display groups design).
list_router = APIRouter(prefix="/api/scores", tags=["scores"])


@list_router.get("", response_model=list[AllianceScoreRead])
def list_scores(
    request: Request,
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[AllianceScoreRead]:
    event = get_the_event(db)
    plugin = get_optional_game_plugin(request, event) if event is not None else None
    if plugin is None:
        return []
    rows = db.execute(
        select(ScoreRecord, Alliance, Match)
        .join(Alliance, ScoreRecord.alliance_id == Alliance.id)
        .join(Match, Alliance.match_id == Match.id)
        .where(Match.session_id == session_id)
        .order_by(Match.id, Alliance.id)
    ).all()
    result = []
    for record, alliance, match in rows:
        team_ids = team_flags.alliance_team_ids(db, alliance.id)
        result.append(
            AllianceScoreRead(
                match_id=match.id,
                alliance_id=alliance.id,
                score=team_flags.effective_score(plugin, record, team_ids, finals=match.finals_bracket_id is not None),
                data=json.loads(record.data_json),
                teams=[TeamFlags(team_id=t.team_id, no_show=t.no_show, dq=t.dq) for t in record.teams],
                saved_at=record.saved_at,
            )
        )
    return result
```

In `app.py` add `app.include_router(scores.list_router)` after `app.include_router(scores.router)`.

- [ ] **Step 4: Add `GET /api/finals`**

In `routers/finals.py` add `from fastapi import Query`, `from tournament_server.deps import get_optional_game_plugin, get_session_id, get_the_event` (merge into the existing deps import) and, **above** `@router.get("/{bracket_id}", ...)`:

```python
@router.get("", response_model=list[FinalsBracketRead])
def list_finals(
    request: Request,
    session_id: int = Depends(get_session_id),
    division_id: int | None = Query(None),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[FinalsBracketRead]:
    """The session's finals brackets for one division (or for none), newest first."""
    event = get_the_event(db)
    game_plugin = get_optional_game_plugin(request, event) if event is not None else None
    if game_plugin is None:
        return []
    query = select(FinalsBracket).where(FinalsBracket.session_id == session_id)
    if division_id is None:
        query = query.where(FinalsBracket.division_id.is_(None))
    else:
        query = query.where(FinalsBracket.division_id == division_id)
    brackets = db.execute(query.order_by(FinalsBracket.id.desc())).scalars().all()
    return [_to_finals_bracket_read(bracket, db, game_plugin) for bracket in brackets]
```

- [ ] **Step 5: Add the scoresheet schema read and the richer match format**

In `schemas/event.py` add to `MatchFormatRead`: `game_model: str`, `autonomous_seconds: int`, `driver_seconds: int`. In `routers/event.py` `read_match_format`, pass `game_model=match_format["game_model"]`, `autonomous_seconds=match_format["autonomous_seconds"]`, `driver_seconds=match_format["driver_seconds"]`, and add after it:

```python
@router.get("/scoresheet-schema", response_model=list[dict[str, Any]])
def read_scoresheet_schema(
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[dict[str, Any]]:
    """The teamwork scoresheet's fields, for score breakdowns on displays."""
    return get_game_plugin_for_event(request, db).module.scoresheet_schema()
```

(Import `Any` from `typing` and `get_game_plugin_for_event` from `deps` if `event.py` doesn't already.)

- [ ] **Step 6: Put the finals links on `MatchRead`**

In `schemas/match.py` add to `MatchRead`, after `is_finals: bool`: `bracket_matchup_id: int | None = None` and `bracket_alliance_id: int | None = None`. In `routers/matches.py` `_to_match_read`, pass `bracket_matchup_id=match.bracket_matchup_id, bracket_alliance_id=match.bracket_alliance_id`.

- [ ] **Step 7: Run the tests**

Run: `cd server && .venv/bin/pytest -q tests/test_display_reads.py tests/test_finals.py tests/test_matches.py tests/test_event.py`
Expected: all pass. If any other test asserts the exact `MatchRead` or `MatchFormatRead` key set, add the new keys to its expectation.

- [ ] **Step 8: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q -p no:cacheprovider`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add server/src/tournament_server/schemas/score_record.py server/src/tournament_server/routers/scores.py \
  server/src/tournament_server/routers/finals.py server/src/tournament_server/routers/event.py \
  server/src/tournament_server/schemas/event.py server/src/tournament_server/schemas/match.py \
  server/src/tournament_server/routers/matches.py server/src/tournament_server/app.py server/tests/test_display_reads.py
git commit -m "Add the reads display screens need: saved scores by session with each alliance's effective score and sheet, a session's finals brackets by division, the teamwork scoresheet schema, the game model and period lengths in the match format, and each match's finals links.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Shared display logic (match order, clock, screen list)

**Files:**
- Create: `frontend/packages/shared/src/display/types.ts`, `screens.ts`, `matchOrder.ts`, `clock.ts`, `index.ts`
- Modify: `frontend/packages/shared/src/index.ts`
- Test: `frontend/packages/shared/tests/display.test.ts`

**Interfaces:**
- Produces (types): `GroupKind`, `LiveAlliance`, `LiveMatch`, `AllianceScore`, `ScreenSettings`, `RotationEntry`, `DisplayGroupState`, `FieldSetLive`.
- Produces (screens): `SCREEN_KEYS`, `ScreenKey`, `AUDIENCE_SCREENS`, `PIT_SCREENS`, `SCROLLING_SCREENS`, `ROTATION_SECONDS {min 5, max 300, default 20}`, `UPCOMING_COUNT {min 1, max 20, default 3}`, `TIMEOUT_SECONDS {min 10, max 600, default 180}`, `isScreenKey(value)`, `screensFor(kind)`, `defaultSettings(screen, kind)`.
- Produces (matchOrder): `compareMatches(a, b)`, `sortMatches(matches)`, `isRunning(match)`, `isFinished(match)`, `onFields(fieldIds)`, `inDivision(divisionId, soleDivisionId)`, `currentMatchForField(matches, fieldId)`, `nextMatchForFieldSet(matches, fieldIds, queuedMatchId)`, `runningMatchForFieldSet(matches, fieldIds)`, `latestStartedMatchForFieldSet(matches, fieldIds)`, `scoredMatches(matches, scores, keep?)`, `lastScoredMatch(matches, scores, fieldIds)`, `upcomingMatches(matches, keep, count)`.
- Produces (clock): `COUNT_IN_PHASES`, `PERIOD_PHASES`, `START_SOON_MS = 30_000`, `remainingSeconds(match, nowMs)`, `formatClock(seconds)`, `StartBand`, `startBand(msToStart)`, `formatOffset(msToStart)`, `formatTime(iso, timeZone, locale?)`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/packages/shared/tests/display.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  AUDIENCE_SCREENS,
  PIT_SCREENS,
  compareMatches,
  currentMatchForField,
  defaultSettings,
  formatClock,
  formatOffset,
  inDivision,
  lastScoredMatch,
  latestStartedMatchForFieldSet,
  nextMatchForFieldSet,
  remainingSeconds,
  runningMatchForFieldSet,
  startBand,
  upcomingMatches,
  type AllianceScore,
  type LiveMatch,
} from "../src";

let nextId = 1;
function match(overrides: Partial<LiveMatch> = {}): LiveMatch {
  const id = overrides.id ?? nextId++;
  return {
    id,
    session_id: 1,
    division_id: null,
    round_type: "qualification",
    match_number: id,
    label: `Q${id}`,
    field_id: 1,
    scheduled_time: null,
    status: "scheduled",
    phase: "not_started",
    phase_deadline: null,
    paused: false,
    remaining_seconds_at_pause: null,
    is_finals: false,
    alliances: [],
    ...overrides,
  };
}
const at = (minute: number) => `2026-11-07T16:${String(minute).padStart(2, "0")}:00Z`;
const score = (match_id: number, saved: string): AllianceScore => ({
  match_id, alliance_id: match_id * 10, score: 1, data: {}, teams: [], saved_at: saved,
});

describe("match order", () => {
  it("puts timed matches first by time, then untimed ones by id", () => {
    const untimedLater = match({ id: 50 });
    const untimed = match({ id: 40 });
    const late = match({ id: 3, scheduled_time: at(30) });
    const early = match({ id: 9, scheduled_time: at(10) });
    expect([untimedLater, late, untimed, early].sort(compareMatches).map((m) => m.id)).toEqual([9, 3, 40, 50]);
  });

  it("a field shows its earliest match without a complete score", () => {
    const done = match({ scheduled_time: at(1), status: "completed", phase: "ended" });
    const ended = match({ scheduled_time: at(2), phase: "ended" });
    const later = match({ scheduled_time: at(3) });
    const skipped = match({ scheduled_time: at(0), status: "not_played" });
    const elsewhere = match({ scheduled_time: at(0), field_id: 2 });
    expect(currentMatchForField([later, ended, done, skipped, elsewhere], 1)?.id).toBe(ended.id);
    expect(currentMatchForField([done], 1)).toBeNull();
  });

  it("the field group's next match is the queued one when still valid, else the earliest unstarted", () => {
    const running = match({ scheduled_time: at(1), phase: "driver" });
    const first = match({ scheduled_time: at(2), field_id: 2 });
    const second = match({ scheduled_time: at(3) });
    const foreign = match({ scheduled_time: at(0), field_id: 9 });
    const all = [running, second, first, foreign];
    expect(nextMatchForFieldSet(all, [1, 2], null)?.id).toBe(first.id);
    expect(nextMatchForFieldSet(all, [1, 2], second.id)?.id).toBe(second.id);
    // A stale override (started, foreign or gone) is ignored.
    expect(nextMatchForFieldSet(all, [1, 2], running.id)?.id).toBe(first.id);
    expect(nextMatchForFieldSet(all, [1, 2], foreign.id)?.id).toBe(first.id);
    expect(nextMatchForFieldSet(all, [1, 2], 999)?.id).toBe(first.id);
  });

  it("finds the running match, and the latest started one after it ends", () => {
    const ended = match({ scheduled_time: at(1), phase: "ended" });
    const running = match({ scheduled_time: at(2), phase: "awaiting_driver" });
    expect(runningMatchForFieldSet([ended, running], [1])?.id).toBe(running.id);
    expect(latestStartedMatchForFieldSet([ended, running], [1])?.id).toBe(running.id);
    expect(latestStartedMatchForFieldSet([ended, match({ scheduled_time: at(3) })], [1])?.id).toBe(ended.id);
    expect(latestStartedMatchForFieldSet([match()], [1])).toBeNull();
  });

  it("the last scored match is the one saved most recently", () => {
    const a = match({ status: "completed", scheduled_time: at(5) });
    const b = match({ status: "completed", scheduled_time: at(1) });
    const c = match({ status: "completed", scheduled_time: at(9), field_id: 2 });
    const scores = [score(a.id, at(10)), score(b.id, at(20)), score(c.id, at(30))];
    expect(lastScoredMatch([a, b, c], scores, [1])?.id).toBe(b.id);
  });

  it("lists upcoming matches in order and filters by division", () => {
    const sole = 4;
    const a = match({ scheduled_time: at(2), division_id: null });
    const b = match({ scheduled_time: at(1), division_id: sole });
    const c = match({ scheduled_time: at(3), division_id: 5 });
    const started = match({ scheduled_time: at(0), phase: "driver" });
    expect(upcomingMatches([a, b, c, started], inDivision(sole, sole), 3).map((m) => m.id)).toEqual([b.id, a.id]);
    expect(upcomingMatches([a, b, c], inDivision(null, sole), 2).map((m) => m.id)).toEqual([b.id, a.id]);
    expect(upcomingMatches([a, b, c], inDivision(5, sole), 3).map((m) => m.id)).toEqual([c.id]);
  });
});

describe("clock", () => {
  it("bands the time to start: green above 30 s, yellow from 30 s to 0, red after", () => {
    expect(startBand(31_000)).toBe("early");
    expect(startBand(30_000)).toBe("soon");
    expect(startBand(0)).toBe("soon");
    expect(startBand(-1)).toBe("late");
  });

  it("formats clocks and offsets", () => {
    expect(formatClock(83)).toBe("1:23");
    expect(formatClock(59.2)).toBe("1:00");
    expect(formatClock(-4)).toBe("0:00");
    expect(formatOffset(83_000)).toBe("1:23");
    expect(formatOffset(-192_500)).toBe("3:12");
  });

  it("reads the remaining time from the deadline, or the frozen value while paused", () => {
    const now = Date.parse(at(0));
    expect(remainingSeconds({ paused: false, remaining_seconds_at_pause: null, phase_deadline: at(1) }, now)).toBe(60);
    expect(remainingSeconds({ paused: true, remaining_seconds_at_pause: 12.5, phase_deadline: null }, now)).toBe(12.5);
    expect(remainingSeconds({ paused: false, remaining_seconds_at_pause: null, phase_deadline: null }, now)).toBeNull();
  });
});

describe("screens", () => {
  it("audience groups get every screen and pit groups all but the match screens", () => {
    expect(AUDIENCE_SCREENS).toHaveLength(10);
    expect(PIT_SCREENS).not.toContain("in_match");
    expect(PIT_SCREENS).not.toContain("match_intro");
    expect(PIT_SCREENS).not.toContain("last_scored_match");
    expect(defaultSettings("upcoming_matches", "pit")).toEqual({ count: 3, scope: "division" });
    expect(defaultSettings("upcoming_matches", "audience")).toEqual({ count: 3, scope: "field_set" });
    expect(defaultSettings("logo", "audience")).toEqual({});
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/packages/shared && npx vitest run tests/display.test.ts`
Expected: FAIL, the imports are missing.

- [ ] **Step 3: Write the types**

Create `frontend/packages/shared/src/display/types.ts`:

```ts
/** Shapes the display screens and the admin's Match Control read from the server. */
export type GroupKind = "audience" | "field" | "pit";

export interface LiveAlliance {
  id: number;
  station: string;
  team_ids: number[];
}

/** A match as GET /api/matches returns it, including its live timing. */
export interface LiveMatch {
  id: number;
  session_id: number;
  division_id: number | null;
  round_type: string;
  match_number: number;
  label: string;
  field_id: number | null;
  scheduled_time: string | null;
  status: string;
  phase: string;
  phase_deadline: string | null;
  paused: boolean;
  remaining_seconds_at_pause: number | null;
  is_finals: boolean;
  bracket_matchup_id?: number | null;
  bracket_alliance_id?: number | null;
  alliances: LiveAlliance[];
}

/** One alliance's saved score, as GET /api/scores returns it. */
export interface AllianceScore {
  match_id: number;
  alliance_id: number;
  score: number;
  data: Record<string, number | boolean | string>;
  teams: { team_id: number; no_show: boolean; dq: boolean }[];
  saved_at: string | null;
}

export interface ScreenSettings {
  count?: number;
  scope?: "field_set" | "division";
}

export interface RotationEntry {
  screen: string;
  settings: ScreenSettings;
  seconds: number;
}

export interface DisplayGroupState {
  id: number;
  session_id: number;
  kind: GroupKind;
  name: string;
  field_set_id: number | null;
  field_id: number | null;
  division_id: number | null;
  screen: string | null;
  screen_settings: ScreenSettings;
  rotation: RotationEntry[] | null;
  play_sounds: boolean;
}

export interface FieldSetLive {
  queued_match_id: number | null;
  timeout_deadline: string | null;
}
```

- [ ] **Step 4: Write the screen list**

Create `frontend/packages/shared/src/display/screens.ts`:

```ts
import type { GroupKind, ScreenSettings } from "./types";

/** The server's screen registry (services/display_screens.py), in button order. */
export const SCREEN_KEYS = [
  "match_intro",
  "in_match",
  "last_scored_match",
  "teamwork_rankings",
  "skills_rankings",
  "upcoming_matches",
  "match_results",
  "schedule",
  "elimination_bracket",
  "logo",
] as const;
export type ScreenKey = (typeof SCREEN_KEYS)[number];

const AUDIENCE_ONLY: ReadonlySet<ScreenKey> = new Set(["match_intro", "in_match", "last_scored_match"]);
export const AUDIENCE_SCREENS: readonly ScreenKey[] = SCREEN_KEYS;
export const PIT_SCREENS: readonly ScreenKey[] = SCREEN_KEYS.filter((key) => !AUDIENCE_ONLY.has(key));
export const SCROLLING_SCREENS: ReadonlySet<ScreenKey> = new Set([
  "teamwork_rankings",
  "skills_rankings",
  "match_results",
  "schedule",
]);

export const ROTATION_SECONDS = { min: 5, max: 300, default: 20 } as const;
export const UPCOMING_COUNT = { min: 1, max: 20, default: 3 } as const;
export const TIMEOUT_SECONDS = { min: 10, max: 600, default: 180 } as const;

export function isScreenKey(value: unknown): value is ScreenKey {
  return typeof value === "string" && (SCREEN_KEYS as readonly string[]).includes(value);
}

export function screensFor(kind: GroupKind): readonly ScreenKey[] {
  if (kind === "audience") return AUDIENCE_SCREENS;
  if (kind === "pit") return PIT_SCREENS;
  return [];
}

export function defaultSettings(screen: ScreenKey, kind: GroupKind): ScreenSettings {
  if (screen !== "upcoming_matches") return {};
  return { count: UPCOMING_COUNT.default, scope: kind === "pit" ? "division" : "field_set" };
}
```

- [ ] **Step 5: Write the match order rules**

Create `frontend/packages/shared/src/display/matchOrder.ts`:

```ts
import type { AllianceScore, LiveMatch } from "./types";

/** "Fully scored" and "skipped at finalize": neither will be played. */
const FINISHED = new Set(["completed", "not_played"]);

/** Scheduled matches by time, then unscheduled ones (finals games) by id. */
export function compareMatches(a: LiveMatch, b: LiveMatch): number {
  const at = a.scheduled_time === null ? null : Date.parse(a.scheduled_time);
  const bt = b.scheduled_time === null ? null : Date.parse(b.scheduled_time);
  if (at !== null && bt !== null && at !== bt) return at - bt;
  if (at === null && bt !== null) return 1;
  if (at !== null && bt === null) return -1;
  return a.id - b.id;
}

export function sortMatches(matches: LiveMatch[]): LiveMatch[] {
  return [...matches].sort(compareMatches);
}

export function isRunning(match: LiveMatch): boolean {
  return match.phase !== "not_started" && match.phase !== "ended";
}

export function isFinished(match: LiveMatch): boolean {
  return FINISHED.has(match.status);
}

export function onFields(fieldIds: readonly number[]): (match: LiveMatch) => boolean {
  const ids = new Set(fieldIds);
  return (match) => match.field_id !== null && ids.has(match.field_id);
}

/** A division filter. Null means everything; the sole division of a
 * single-division event also takes the rows that carry no division. */
export function inDivision(
  divisionId: number | null,
  soleDivisionId: number | null
): (row: { division_id: number | null }) => boolean {
  return (row) =>
    divisionId === null ||
    row.division_id === divisionId ||
    (row.division_id === null && divisionId === soleDivisionId);
}

/** What a field display shows: the field's earliest match without a complete score. */
export function currentMatchForField(matches: LiveMatch[], fieldId: number): LiveMatch | null {
  return sortMatches(matches.filter((m) => m.field_id === fieldId && !isFinished(m)))[0] ?? null;
}

/** What Start begins: the queued match while it is still an unstarted match
 * on this field group, else the earliest unstarted one. */
export function nextMatchForFieldSet(
  matches: LiveMatch[],
  fieldIds: readonly number[],
  queuedMatchId: number | null
): LiveMatch | null {
  const onSet = onFields(fieldIds);
  const candidates = sortMatches(matches.filter((m) => onSet(m) && m.phase === "not_started" && !isFinished(m)));
  if (queuedMatchId !== null) {
    const queued = candidates.find((m) => m.id === queuedMatchId);
    if (queued) return queued;
  }
  return candidates[0] ?? null;
}

export function runningMatchForFieldSet(matches: LiveMatch[], fieldIds: readonly number[]): LiveMatch | null {
  const onSet = onFields(fieldIds);
  return sortMatches(matches.filter((m) => onSet(m) && isRunning(m)))[0] ?? null;
}

/** The running match, else the last one in order that has ended. */
export function latestStartedMatchForFieldSet(matches: LiveMatch[], fieldIds: readonly number[]): LiveMatch | null {
  const running = runningMatchForFieldSet(matches, fieldIds);
  if (running) return running;
  const onSet = onFields(fieldIds);
  const ended = sortMatches(matches.filter((m) => onSet(m) && m.phase === "ended"));
  return ended[ended.length - 1] ?? null;
}

function latestSave(matchId: number, scores: AllianceScore[]): number {
  let latest = Number.NEGATIVE_INFINITY;
  for (const row of scores) {
    if (row.match_id === matchId && row.saved_at !== null) latest = Math.max(latest, Date.parse(row.saved_at));
  }
  return latest;
}

/** Fully scored matches, the most recently saved first. */
export function scoredMatches(
  matches: LiveMatch[],
  scores: AllianceScore[],
  keep: (match: LiveMatch) => boolean = () => true
): LiveMatch[] {
  return matches
    .filter((m) => m.status === "completed" && keep(m))
    .sort((a, b) => latestSave(b.id, scores) - latestSave(a.id, scores) || compareMatches(b, a));
}

export function lastScoredMatch(
  matches: LiveMatch[],
  scores: AllianceScore[],
  fieldIds: readonly number[]
): LiveMatch | null {
  return scoredMatches(matches, scores, onFields(fieldIds))[0] ?? null;
}

export function upcomingMatches(
  matches: LiveMatch[],
  keep: (match: LiveMatch) => boolean,
  count: number
): LiveMatch[] {
  return sortMatches(matches.filter((m) => keep(m) && m.phase === "not_started" && !isFinished(m))).slice(0, count);
}
```

- [ ] **Step 6: Write the clock helpers and the index**

Create `frontend/packages/shared/src/display/clock.ts`:

```ts
import type { LiveMatch } from "./types";

export const COUNT_IN_PHASES: ReadonlySet<string> = new Set(["countdown_autonomous", "countdown_driver"]);
export const PERIOD_PHASES: ReadonlySet<string> = new Set(["autonomous", "driver"]);
/** Yellow from here down to the scheduled start. */
export const START_SOON_MS = 30_000;

export function remainingSeconds(
  match: Pick<LiveMatch, "paused" | "remaining_seconds_at_pause" | "phase_deadline">,
  nowMs: number
): number | null {
  if (match.paused) return match.remaining_seconds_at_pause ?? null;
  if (match.phase_deadline === null) return null;
  return Math.max(0, (Date.parse(match.phase_deadline) - nowMs) / 1000);
}

/** "m:ss", rounding up so a clock reads 0:00 only when time is up. */
export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.ceil(totalSeconds - 1e-9));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export type StartBand = "early" | "soon" | "late";

/** Green while more than 30 s remain, yellow from 30 s to 0, red after. */
export function startBand(msToStart: number): StartBand {
  if (msToStart > START_SOON_MS) return "early";
  if (msToStart >= 0) return "soon";
  return "late";
}

/** The time to a start, or since it once late, as "m:ss". */
export function formatOffset(msToStart: number): string {
  return msToStart >= 0 ? formatClock(msToStart / 1000) : formatClock(Math.floor(-msToStart / 1000));
}

export function formatTime(iso: string, timeZone: string | null, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timeZone ?? undefined,
  }).format(new Date(iso));
}
```

Create `frontend/packages/shared/src/display/index.ts`:

```ts
export * from "./types";
export * from "./screens";
export * from "./matchOrder";
export * from "./clock";
```

Add `export * from "./display";` to the end of `frontend/packages/shared/src/index.ts`.

- [ ] **Step 7: Run the tests**

Run: `cd frontend/packages/shared && npx vitest run`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/packages/shared/src/display frontend/packages/shared/src/index.ts frontend/packages/shared/tests/display.test.ts
git commit -m "Add the shared display rules: which match a field shows, which match Start begins, the running and last scored match, upcoming matches by division, the start-time colour bands, clock formatting and the screen list.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Device app display mode: the shell, live events, server clock and the Logo screen

**Files:**
- Modify: `frontend/apps/device/package.json` (`@tanstack/react-query`)
- Modify: `frontend/apps/device/src/deviceApi.ts` (`ApiStatusError`, `getJson`)
- Modify: `frontend/apps/device/src/useDeviceSocket.ts` (messages and opens)
- Modify: `frontend/apps/device/src/App.tsx`, `frontend/apps/device/src/main.tsx`
- Create: `frontend/apps/device/src/display/events.ts`, `api.ts`, `useLiveRefresh.ts`, `serverClock.ts`, `DisplayApp.tsx`, `DisplayRoot.tsx`, `GroupView.tsx`, `screenTypes.ts`, `components/ScreenFrame.tsx`, `screens/logo.tsx`, `screens/registry.ts`
- Create: `frontend/apps/device/src/styles/display.css`
- Modify: `frontend/apps/device/src/i18n/en/device.json`, `frontend/apps/device/src/i18n/zh/device.json`
- Create: `frontend/apps/device/tests/unit/displayHarness.tsx`, `frontend/apps/device/tests/unit/displayFixtures.ts`
- Test: `frontend/apps/device/tests/unit/displayRoot.test.tsx`, `frontend/apps/device/tests/unit/serverClock.test.ts`; modify `frontend/apps/device/tests/unit/App.test.tsx`

**Interfaces:**
- Consumes: Task 2's `GET /api/displays/me`; Task 6's shared types and screen keys.
- Produces (`deviceApi.ts`): `class ApiStatusError extends Error { status: number }`, `getJson<T>(path: string, accessToken: string): Promise<T>`.
- Produces (`useDeviceSocket.ts`): `useDeviceSocket(accessToken, onDeviceChanged, onReachability, onMessage?: (message: LiveEvent) => void, onOpen?: () => void)`.
- Produces (`display/events.ts`): `LiveEvent {event, data}`, `createEventBus()` → `{emit, subscribe}`, `EventBus`, `RECONNECTED = "__reconnected"`, `EventBusContext`, `useLiveEvents(names: readonly string[] | null, handler)`.
- Produces (`display/api.ts`): types `DisplayMe`, `DisplayMeGroup`, `EventInfo`, `MatchFormat`, `Team`, `Division`, `Field`, `FieldSet`, `SessionInfo`, `Ranking`, `SkillsSettings`, `SkillsRankingRow`, `SkillsAttempt`, `FinalsBracket`, `ScoresheetFieldInfo`; `TokenContext`; `paths`; hooks `useMe`, `useEventInfo`, `useMatchFormat`, `useScoresheetSchema`, `useDivisions`, `useTeams`, `useTeamsById`, `useSessions`, `useSessionTimeZone(sessionId)`, `useMatches(sessionId)`, `useScores(sessionId)`, `useFields(sessionId)`, `useFieldSets(sessionId)`, `useRankings(sessionId, divisionId)`, `useMergedRankings(sessionId, divisionId)`, `useRanks(sessionId, divisionId)`, `useSoleDivisionId()`, `useSkillsSettings`, `useSkillsRankings(sessionId, tab)`, `useSkillsAttempts(sessionId)`, `useFinals(sessionId, divisionId)`, `useFetchJson()`.
- Produces (`display/serverClock.ts`): `RESYNC_MS = 600_000`, `measureOffset(fetchImpl?)`, `useServerClockOffset(resyncKey)`, `ServerClockContext`, `useServerNow(intervalMs = 250)`.
- Produces (`display/screenTypes.ts`): `ScreenContext {sessionId, fieldSetId, divisionId, settings, queuedMatchId}`, `ScreenProps {context, onDone?, fitSeconds?}`, `ScreenModule {key, scrolls, Component}`.
- Produces (`display/screens/registry.ts`): `screenModule(key: string | null): ScreenModule` (unknown keys render `logo`); later tasks register their screens by adding entries to the `MODULES` object in this file.
- Produces (`display/components/ScreenFrame.tsx`): `ScreenFrame({title, subtitle?, className?, children})`, `WaitingForData({title})`, `ScreenNotice({title, text})`.
- Produces (`display/GroupView.tsx`): `GroupView({me})` — a field group renders the Logo screen until Task 8 replaces it; a pit group shows its single screen, or the first rotation entry until Task 12 adds the rotation runner.

- [ ] **Step 1: Add TanStack Query to the device app**

In `frontend/apps/device/package.json` add `"@tanstack/react-query": "^5.59.0"` to `dependencies`, then run `cd frontend && npm install`.

- [ ] **Step 2: Write the test harness and fixtures**

Create `frontend/apps/device/tests/unit/displayFixtures.ts`:

```ts
import type { LiveMatch } from "@tournament-admin/shared";

export const EVENT = { id: 1, name: "Spring Invitational", active_session_id: 1, game_plugin_name: "game" };
export const SESSIONS = [{ id: 1, label: "Saturday", timezone: "UTC" }];
export const DIVISIONS = [{ id: 4, name: "Division 1" }];
export const FIELD_SETS = [{ id: 10, session_id: 1, name: "Main Fields", division_id: null }];
export const FIELDS = [
  { id: 1, field_set_id: 10, name: "Field 1" },
  { id: 2, field_set_id: 10, name: "Field 2" },
];
export const TEAMS = [
  { id: 1, number: "101A", name: "Rockets", division_id: 4, city: "Springfield", state: "IL", country: null },
  { id: 2, number: "102B", name: "Gears", division_id: 4, city: null, state: null, country: null },
  { id: 3, number: "103C", name: "Bolts", division_id: 4, city: "Shelbyville", state: null, country: null },
  { id: 4, number: "104D", name: "Sparks", division_id: 4, city: null, state: null, country: "Canada" },
];
export const HEAD_TO_HEAD = { game_model: "head_to_head", autonomous_seconds: 15, driver_seconds: 105, alliance_count: 2, teams_per_alliance: 2 };
export const COOPERATIVE = { game_model: "cooperative_score", autonomous_seconds: 0, driver_seconds: 60, alliance_count: 2, teams_per_alliance: 1 };

let nextId = 100;
export function match(overrides: Partial<LiveMatch> = {}): LiveMatch {
  const id = overrides.id ?? nextId++;
  return {
    id,
    session_id: 1,
    division_id: null,
    round_type: "qualification",
    match_number: id,
    label: `Q${id}`,
    field_id: 1,
    scheduled_time: null,
    status: "scheduled",
    phase: "not_started",
    phase_deadline: null,
    paused: false,
    remaining_seconds_at_pause: null,
    is_finals: false,
    bracket_matchup_id: null,
    bracket_alliance_id: null,
    alliances: [
      { id: id * 10 + 1, station: "red", team_ids: [1, 2] },
      { id: id * 10 + 2, station: "blue", team_ids: [3, 4] },
    ],
    ...overrides,
  };
}

export function me(group: Record<string, unknown> | null, sessionId: number | null = 1) {
  return { device: { id: 7, name: "Big TV" }, session_id: sessionId, group };
}

export function audienceGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 50, session_id: 1, kind: "audience", name: "Main Fields", field_set_id: 10, field_id: null, division_id: null,
    screen: "logo", screen_settings: {}, rotation: null, play_sounds: false,
    field_set: { queued_match_id: null, timeout_deadline: null }, ...overrides,
  };
}

export function fieldGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 51, session_id: 1, kind: "field", name: "Field 1", field_set_id: 10, field_id: 1, division_id: null,
    screen: null, screen_settings: {}, rotation: null, play_sounds: false,
    field_set: { queued_match_id: null, timeout_deadline: null }, ...overrides,
  };
}

export function pitGroup(overrides: Record<string, unknown> = {}) {
  return {
    id: 52, session_id: 1, kind: "pit", name: "Pit TVs", field_set_id: null, field_id: null, division_id: null,
    screen: "logo", screen_settings: {}, rotation: null, play_sounds: false, field_set: null, ...overrides,
  };
}

/** The reads every screen shares, keyed by exact request path. */
export function baseRoutes(): Record<string, unknown> {
  return {
    "/api/event": EVENT,
    "/api/sessions": SESSIONS,
    "/api/divisions": DIVISIONS,
    "/api/teams": TEAMS,
    "/api/event/match-format": HEAD_TO_HEAD,
    "/api/field-sets?session_id=1": FIELD_SETS,
    "/api/fields?session_id=1": FIELDS,
    "/api/matches?session_id=1": [],
    "/api/scores?session_id=1": [],
    "/api/rankings?session_id=1": [],
    "/api/rankings?session_id=1&division_id=4": [],
  };
}
```

Create `frontend/apps/device/tests/unit/displayHarness.tsx`:

```tsx
import { act, render } from "@testing-library/react";
import { vi } from "vitest";
import "../../src/i18nSetup";
import { DisplayApp } from "../../src/display/DisplayApp";
import { createEventBus } from "../../src/display/events";

export type Route = unknown | ((url: string) => unknown);

/** Serves exact request paths as JSON; anything else is a 404. GET
 * /api/time-sync answers with the server clock `serverOffsetMs` ahead of
 * this device's clock. */
export function serveDisplay(routes: Record<string, Route>, { serverOffsetMs = 0 } = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/time-sync") {
      const server_time = new Date(Date.now() + serverOffsetMs).toISOString();
      return new Response(JSON.stringify({ server_time, boot_id: "boot" }), { status: 200 });
    }
    if (!(url in routes)) return new Response(JSON.stringify({ detail: "Not found" }), { status: 404 });
    const value = routes[url];
    const body = typeof value === "function" ? (value as (u: string) => unknown)(url) : value;
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

export function renderDisplay({ unreachable = false } = {}) {
  const bus = createEventBus();
  const utils = render(
    <DisplayApp
      accessToken="token"
      device={{ id: 7, name: "Big TV", role: "display_device", status: "active" }}
      bus={bus}
      unreachable={unreachable}
    />
  );
  const emit = (event: string, data: unknown = {}) => act(() => bus.emit({ event, data }));
  return { ...utils, bus, emit };
}
```

- [ ] **Step 3: Write the failing tests**

Create `frontend/apps/device/tests/unit/displayRoot.test.tsx`:

```tsx
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { audienceGroup, baseRoutes, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("display mode", () => {
  it("shows its own name when it has no group in the active session", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(null) });
    renderDisplay();
    expect(await screen.findByText("Big TV")).toBeInTheDocument();
    expect(screen.getByText("Not set up for this session")).toBeInTheDocument();
  });

  it("says so when no session is running", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(null, null) });
    renderDisplay();
    expect(await screen.findByText("No session is running")).toBeInTheDocument();
  });

  it("shows the event name on the Logo screen", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup()) });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
  });

  it("an unknown screen key falls back to Logo", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup({ screen: "future_screen" })) });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
  });

  it("re-reads its setup on display_changed and active_session_changed", async () => {
    let current: unknown = me(null);
    serveDisplay({ ...baseRoutes(), "/api/displays/me": () => current });
    const { emit } = renderDisplay();
    expect(await screen.findByText("Not set up for this session")).toBeInTheDocument();
    current = me(pitGroup());
    emit("display_changed", { session_id: 1, group_id: 52 });
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
    current = me(null, null);
    emit("active_session_changed", { active_session_id: null });
    expect(await screen.findByText("No session is running")).toBeInTheDocument();
  });

  it("shows its name for 10 seconds when identified", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup()) });
    const { emit } = renderDisplay();
    await screen.findByRole("heading", { name: "Spring Invitational" });
    emit("display_identify", { device_id: 7 });
    expect(screen.getByTestId("identify")).toHaveTextContent("Big TV");
    await act(() => vi.advanceTimersByTimeAsync(9_000));
    expect(screen.getByTestId("identify")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.queryByTestId("identify")).not.toBeInTheDocument();
  });

  it("keeps its picture and shows a corner badge while the server is unreachable", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup()) });
    renderDisplay({ unreachable: true });
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
    expect(screen.getByText("Reconnecting…")).toBeInTheDocument();
  });

  it("waits, then retries, when its setup can't be read", async () => {
    let fail = true;
    const routes = baseRoutes();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/displays/me") {
        return fail ? new Response("{}", { status: 503 }) : new Response(JSON.stringify(me(null)), { status: 200 });
      }
      if (url === "/api/time-sync") {
        return new Response(JSON.stringify({ server_time: new Date().toISOString(), boot_id: "b" }), { status: 200 });
      }
      return new Response(JSON.stringify(routes[url] ?? {}), { status: 200 });
    });
    renderDisplay();
    expect(await screen.findByText("Connecting…")).toBeInTheDocument();
    fail = false;
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(await screen.findByText("Not set up for this session")).toBeInTheDocument();
  });
});
```

Create `frontend/apps/device/tests/unit/serverClock.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureOffset } from "../../src/display/serverClock";

afterEach(() => vi.useRealTimers());

describe("measureOffset", () => {
  it("is how far the server clock is ahead of this device's, using the round trip's midpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T16:00:00Z"));
    const fetchImpl = vi.fn(async () => {
      // The answer takes 2 s; the server reads its clock halfway through.
      vi.setSystemTime(new Date("2026-11-07T16:00:02Z"));
      return new Response(JSON.stringify({ server_time: "2026-11-07T16:02:01Z", boot_id: "b" }));
    });
    expect(await measureOffset(fetchImpl as unknown as typeof fetch)).toBe(120_000);
  });

  it("is negative when the device's clock runs ahead", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T16:05:00Z"));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ server_time: "2026-11-07T16:00:00Z", boot_id: "b" })));
    expect(await measureOffset(fetchImpl as unknown as typeof fetch)).toBe(-300_000);
  });
});
```

In `frontend/apps/device/tests/unit/App.test.tsx`, add a test inside `describe("device app", ...)` (the file's `serve` helper and fake socket are already there):

```tsx
  it("a paired display runs display mode", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dev-token" }));
    serve((url) => {
      if (url === "/api/auth/device") {
        return { status: 200, body: { access_token: "a", expires_in: 1800, device: { ...DEVICE, role: "display_device", name: "Big TV" } } };
      }
      if (url === "/api/displays/me") return { status: 200, body: { device: { id: 7, name: "Big TV" }, session_id: 1, group: null } };
      if (url === "/api/time-sync") return { status: 200, body: { server_time: new Date().toISOString(), boot_id: "b" } };
      return { status: 404, body: {} };
    });
    render(<App />);
    expect(await screen.findByText("Not set up for this session")).toBeInTheDocument();
    expect(screen.queryByText("Paired as")).not.toBeInTheDocument();
  });
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd frontend/apps/device && npx vitest run tests/unit/displayRoot.test.tsx tests/unit/serverClock.test.ts tests/unit/App.test.tsx`
Expected: FAIL, `../../src/display/DisplayApp` doesn't exist.

- [ ] **Step 5: Extend the device's fetch helper and socket hook**

Append to `frontend/apps/device/src/deviceApi.ts`:

```ts
/** A request the server answered with a status other than 2xx (and not 5xx,
 * which `send` already reports as Unreachable). */
export class ApiStatusError extends Error {
  status: number;

  constructor(status: number) {
    super(`The server answered ${status}`);
    this.name = "ApiStatusError";
    this.status = status;
  }
}

/** An authorized GET for display screens' data. */
export async function getJson<T>(path: string, accessToken: string): Promise<T> {
  const response = await send(path, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new ApiStatusError(response.status);
  return readJson<T>(response);
}
```

In `frontend/apps/device/src/useDeviceSocket.ts`:
- add `import type { LiveEvent } from "./display/events";`;
- change the signature to add `onMessage?: (message: LiveEvent) => void,` and `onOpen?: () => void` after `onReachability`, keep both in `callbacks.current = { onDeviceChanged, onReachability, onMessage, onOpen };` (and the `useRef` initializer);
- in `socket.onopen`, after `callbacks.current.onReachability(true);` add `callbacks.current.onOpen?.();`;
- after `socket.onopen = ...`, add:

```ts
      socket.onmessage = (message: MessageEvent<string>) => {
        if (stopped) return;
        try {
          const parsed = JSON.parse(message.data) as LiveEvent;
          if (parsed && typeof parsed.event === "string") callbacks.current.onMessage?.(parsed);
        } catch {
          // A frame that isn't JSON is ignored.
        }
      };
```

and update the doc comment: "Every message is passed to `onMessage`, and every successful open to `onOpen`, so display mode can refresh after a reconnect."

- [ ] **Step 6: Write the event bus and the data hooks**

Create `frontend/apps/device/src/display/events.ts`:

```ts
import { createContext, useContext, useEffect, useRef } from "react";

export interface LiveEvent {
  event: string;
  data: unknown;
}
type Listener = (event: LiveEvent) => void;

/** Emitted by the device app each time its socket (re)opens. */
export const RECONNECTED = "__reconnected";

export function createEventBus() {
  const listeners = new Set<Listener>();
  return {
    emit(event: LiveEvent) {
      for (const listener of [...listeners]) listener(event);
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
export type EventBus = ReturnType<typeof createEventBus>;

export const EventBusContext = createContext<EventBus | null>(null);

/** Calls `handler` for each live event named in `names` (every event when null). */
export function useLiveEvents(names: readonly string[] | null, handler: (event: LiveEvent) => void): void {
  const bus = useContext(EventBusContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const key = names === null ? null : names.join(",");
  useEffect(() => {
    if (!bus) return undefined;
    const wanted = key === null ? null : new Set(key.split(","));
    return bus.subscribe((event) => {
      if (wanted === null || wanted.has(event.event)) handlerRef.current(event);
    });
  }, [bus, key]);
}
```

Create `frontend/apps/device/src/display/api.ts`:

```ts
import { createContext, useCallback, useContext } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AllianceScore, DisplayGroupState, FieldSetLive, LiveMatch } from "@tournament-admin/shared";
import { getJson } from "../deviceApi";

export interface DisplayMeGroup extends DisplayGroupState {
  field_set: FieldSetLive | null;
}
export interface DisplayMe {
  device: { id: number; name: string };
  session_id: number | null;
  group: DisplayMeGroup | null;
}
export interface EventInfo {
  id: number;
  name: string;
  active_session_id: number | null;
  game_plugin_name: string | null;
}
export type GameModel = "head_to_head" | "cooperative_score";
export interface MatchFormat {
  game_model: GameModel;
  autonomous_seconds: number;
  driver_seconds: number;
  alliance_count: number;
  teams_per_alliance: number;
}
export interface Team {
  id: number;
  number: string;
  name: string;
  division_id: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
}
export interface Division {
  id: number;
  name: string;
}
export interface Field {
  id: number;
  field_set_id: number;
  name: string;
}
export interface FieldSet {
  id: number;
  session_id: number;
  name: string;
  division_id: number | null;
}
export interface SessionInfo {
  id: number;
  label: string;
  timezone: string | null;
}
export interface Ranking {
  team_id: number;
  division_id: number | null;
  rank: number;
  win_points: number;
  strength_of_schedule: number;
  average_score: number;
  matches_played: number;
}
export interface SkillsSettings {
  enabled: boolean;
  attempts: Record<string, number>;
  types: { key: string; label: string }[];
}
export interface SkillsRankingRow {
  rank: number;
  team_id: number;
  score: number;
  attempts: number[];
}
export interface SkillsAttempt {
  id: number;
  team_id: number;
  skills_type: string;
  score: number;
  recorded_at: string;
}
export interface FinalsBracket {
  id: number;
  session_id: number;
  division_id: number | null;
  field_set_id: number;
  format: "single_elimination" | "score_chase";
  bracket_size: number;
  status: string;
  alliances: { id: number; seed: number; team_ids: number[]; unavailable: boolean }[];
  runs: { match_id: number; bracket_alliance_id: number | null; status: string; score: number | null }[];
  results: { bracket_alliance_id: number; score: number; rank: number }[];
  matchups: {
    id: number;
    round_number: number;
    position: number;
    matchup_number: number | null;
    alliance_a_id: number | null;
    alliance_b_id: number | null;
    winner_alliance_id: number | null;
  }[];
}
export interface ScoresheetFieldInfo {
  name: string;
  label: string;
  data_type: string;
  options: (string | number)[] | null;
}

/** Returns the device's current access token (it is renewed every half hour). */
export const TokenContext = createContext<() => string>(() => "");

export const paths = {
  me: "/api/displays/me",
  event: "/api/event",
  matchFormat: "/api/event/match-format",
  scoresheet: "/api/event/scoresheet-schema",
  divisions: "/api/divisions",
  teams: "/api/teams",
  sessions: "/api/sessions",
  skillsSettings: "/api/skills/settings",
  matches: (sessionId: number) => `/api/matches?session_id=${sessionId}`,
  scores: (sessionId: number) => `/api/scores?session_id=${sessionId}`,
  fields: (sessionId: number) => `/api/fields?session_id=${sessionId}`,
  fieldSets: (sessionId: number) => `/api/field-sets?session_id=${sessionId}`,
  rankings: (sessionId: number, divisionId: number | null) =>
    divisionId === null
      ? `/api/rankings?session_id=${sessionId}`
      : `/api/rankings?session_id=${sessionId}&division_id=${divisionId}`,
  skillsRankings: (sessionId: number, tab: string) =>
    `/api/skills/rankings?tab=${encodeURIComponent(tab)}&session_id=${sessionId}`,
  skillsAttempts: (sessionId: number) => `/api/sessions/${sessionId}/skills/attempts`,
  finals: (sessionId: number, divisionId: number | null) =>
    divisionId === null
      ? `/api/finals?session_id=${sessionId}`
      : `/api/finals?session_id=${sessionId}&division_id=${divisionId}`,
};

export function useFetchJson() {
  const getToken = useContext(TokenContext);
  return useCallback(<T,>(path: string) => getJson<T>(path, getToken()), [getToken]);
}

function useJson<T>(queryKey: readonly unknown[], path: string) {
  const fetchJson = useFetchJson();
  return useQuery({ queryKey, queryFn: () => fetchJson<T>(path) });
}

export const useMe = () => useJson<DisplayMe>(["me"], paths.me);
export const useEventInfo = () => useJson<EventInfo>(["event"], paths.event);
export const useMatchFormat = () => useJson<MatchFormat>(["matchFormat"], paths.matchFormat);
export const useScoresheetSchema = () => useJson<ScoresheetFieldInfo[]>(["scoresheetSchema"], paths.scoresheet);
export const useDivisions = () => useJson<Division[]>(["divisions"], paths.divisions);
export const useTeams = () => useJson<Team[]>(["teams"], paths.teams);
export const useSessions = () => useJson<SessionInfo[]>(["sessions"], paths.sessions);
export const useSkillsSettings = () => useJson<SkillsSettings>(["skillsSettings"], paths.skillsSettings);
export const useMatches = (sessionId: number) => useJson<LiveMatch[]>(["matches", sessionId], paths.matches(sessionId));
export const useScores = (sessionId: number) => useJson<AllianceScore[]>(["scores", sessionId], paths.scores(sessionId));
export const useFields = (sessionId: number) => useJson<Field[]>(["fields", sessionId], paths.fields(sessionId));
export const useFieldSets = (sessionId: number) => useJson<FieldSet[]>(["fieldSets", sessionId], paths.fieldSets(sessionId));
export const useRankings = (sessionId: number, divisionId: number | null) =>
  useJson<Ranking[]>(["rankings", sessionId, divisionId], paths.rankings(sessionId, divisionId));
export const useSkillsRankings = (sessionId: number, tab: string) =>
  useJson<SkillsRankingRow[]>(["skillsRankings", sessionId, tab], paths.skillsRankings(sessionId, tab));
export const useSkillsAttempts = (sessionId: number) =>
  useJson<SkillsAttempt[]>(["skillsAttempts", sessionId], paths.skillsAttempts(sessionId));
export const useFinals = (sessionId: number, divisionId: number | null) =>
  useJson<FinalsBracket[]>(["finals", sessionId, divisionId], paths.finals(sessionId, divisionId));

export function useTeamsById(): Map<number, Team> | undefined {
  const teams = useTeams();
  return teams.data ? new Map(teams.data.map((team) => [team.id, team])) : undefined;
}

export function useSessionTimeZone(sessionId: number): string | null {
  const sessions = useSessions();
  return sessions.data?.find((s) => s.id === sessionId)?.timezone ?? null;
}

/** The event's only division, or null when it has several. */
export function useSoleDivisionId(): number | null {
  const divisions = useDivisions();
  return divisions.data?.length === 1 ? divisions.data[0].id : null;
}

/** Rankings for a division together with the rows that carry no division
 * (a single-division event's), each team once, in rank order. */
export function useMergedRankings(sessionId: number, divisionId: number | null): Ranking[] | undefined {
  const own = useRankings(sessionId, divisionId);
  const unscoped = useRankings(sessionId, null);
  if (!own.data || !unscoped.data) return undefined;
  const seen = new Set<number>();
  const rows: Ranking[] = [];
  for (const row of [...own.data, ...unscoped.data]) {
    if (!seen.has(row.team_id)) {
      seen.add(row.team_id);
      rows.push(row);
    }
  }
  return rows.sort((a, b) => a.rank - b.rank);
}

/** Team id -> current session rank in the division. */
export function useRanks(sessionId: number, divisionId: number | null): Map<number, number> | undefined {
  const rows = useMergedRankings(sessionId, divisionId);
  return rows ? new Map(rows.map((row) => [row.team_id, row.rank])) : undefined;
}
```

Create `frontend/apps/device/src/display/useLiveRefresh.ts`:

```ts
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RECONNECTED, useLiveEvents } from "./events";

/** Which cached reads each live event makes stale. */
const REFRESH: Record<string, readonly string[]> = {
  display_changed: ["me"],
  field_set_changed: ["me"],
  active_session_changed: ["me"],
  match_phase_changed: ["matches"],
  match_paused: ["matches"],
  match_resumed: ["matches"],
  match_reset: ["matches"],
  new_match_created: ["matches", "finals"],
  score_saved: ["matches", "scores", "finals"],
  qualification_status_changed: ["matches"],
  ranking_updated: ["rankings"],
  skills_changed: ["skillsRankings", "skillsAttempts"],
  skills_settings_changed: ["skillsSettings", "skillsRankings"],
  finals_changed: ["finals", "matches"],
};

/** Keeps every screen's data live. Returns how many times the socket has
 * (re)opened, so the server clock can be measured again after each. */
export function useLiveRefresh(): number {
  const queryClient = useQueryClient();
  const [opens, setOpens] = useState(0);
  useLiveEvents(null, (event) => {
    if (event.event === RECONNECTED || event.event === "game_plugin_changed") {
      void queryClient.invalidateQueries();
      if (event.event === RECONNECTED) setOpens((n) => n + 1);
      return;
    }
    for (const key of REFRESH[event.event] ?? []) void queryClient.invalidateQueries({ queryKey: [key] });
  });
  return opens;
}
```

Create `frontend/apps/device/src/display/serverClock.ts`:

```ts
import { createContext, useContext, useEffect, useState } from "react";

export const RESYNC_MS = 10 * 60_000;

/** How far the server's clock is ahead of this device's, in ms. A TV's own
 * clock may be minutes off, so every countdown adds this offset. */
export async function measureOffset(fetchImpl: typeof fetch = fetch): Promise<number> {
  const sent = Date.now();
  const response = await fetchImpl("/api/time-sync");
  const body = (await response.json()) as { server_time: string };
  const received = Date.now();
  return Date.parse(body.server_time) - (sent + received) / 2;
}

/** Measures the offset now, every 10 minutes, and whenever `resyncKey` changes. */
export function useServerClockOffset(resyncKey: unknown): number {
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const measured = await measureOffset();
        if (!cancelled) setOffset(measured);
      } catch {
        // Keep the last offset; the next run tries again.
      }
    };
    void run();
    const id = setInterval(() => void run(), RESYNC_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [resyncKey]);
  return offset;
}

export const ServerClockContext = createContext(0);

/** The server's "now" in ms, re-rendering every `intervalMs`. */
export function useServerNow(intervalMs = 250): number {
  const offset = useContext(ServerClockContext);
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    const id = setInterval(() => setNow(Date.now() + offset), intervalMs);
    return () => clearInterval(id);
  }, [offset, intervalMs]);
  return now;
}
```

- [ ] **Step 7: Write the screen contract, the frame, the Logo screen and the registry**

Create `frontend/apps/device/src/display/screenTypes.ts`:

```ts
import type { ComponentType } from "react";
import type { ScreenKey, ScreenSettings } from "@tournament-admin/shared";

/** What a screen needs to know about where it is showing. */
export interface ScreenContext {
  sessionId: number;
  /** The audience group's field set; null on a pit group. */
  fieldSetId: number | null;
  /** The field set's or pit group's division; null for "every division". */
  divisionId: number | null;
  settings: ScreenSettings;
  queuedMatchId: number | null;
}

export interface ScreenProps {
  context: ScreenContext;
  /** In a rotation: a scrolling screen calls this once it has shown its whole list. */
  onDone?: () => void;
  /** In a rotation: how long a scrolling screen whose list fits stays up, in seconds. */
  fitSeconds?: number;
}

export interface ScreenModule {
  key: ScreenKey;
  scrolls: boolean;
  Component: ComponentType<ScreenProps>;
}
```

Create `frontend/apps/device/src/display/components/ScreenFrame.tsx`:

```tsx
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useEventInfo } from "../api";

/** The kiosk frame every screen shares: the event name small, the screen's title large. */
export function ScreenFrame({
  title,
  subtitle,
  className,
  children,
}: {
  title: string;
  subtitle?: string;
  className?: string;
  children?: ReactNode;
}) {
  const event = useEventInfo();
  return (
    <section className={`screen ${className ?? ""}`}>
      <header className="screen__header">
        <p className="screen__event">{event.data?.name ?? ""}</p>
        <h1 className="screen__title">{title}</h1>
        {subtitle && <p className="screen__subtitle">{subtitle}</p>}
      </header>
      <div className="screen__body">{children}</div>
    </section>
  );
}

export function ScreenNotice({ title, text }: { title: string; text: string }) {
  return (
    <ScreenFrame title={title}>
      <p className="screen__notice">{text}</p>
    </ScreenFrame>
  );
}

/** Shown while a screen's data is loading or being retried; never a blank TV. */
export function WaitingForData({ title }: { title: string }) {
  const { t } = useTranslation();
  return <ScreenNotice title={title} text={t("display.waiting")} />;
}
```

Create `frontend/apps/device/src/display/screens/logo.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { useEventInfo } from "../api";
import type { ScreenModule } from "../screenTypes";

function LogoScreen() {
  const { t } = useTranslation();
  const event = useEventInfo();
  return (
    <section className="screen logo-screen">
      <h1 className="logo-screen__name">{event.data ? event.data.name : t("display.waiting")}</h1>
    </section>
  );
}

export const logoScreen: ScreenModule = { key: "logo", scrolls: false, Component: LogoScreen };
```

Create `frontend/apps/device/src/display/screens/registry.ts`:

```ts
import { isScreenKey, type ScreenKey } from "@tournament-admin/shared";
import type { ScreenModule } from "../screenTypes";
import { logoScreen } from "./logo";

/** One module per screen key. A key with no module here (an older device
 * app than the server) shows the Logo screen. */
const MODULES: Partial<Record<ScreenKey, ScreenModule>> = {
  logo: logoScreen,
};

export function screenModule(key: string | null): ScreenModule {
  return (isScreenKey(key) && MODULES[key]) || logoScreen;
}
```

- [ ] **Step 8: Write the display root**

Create `frontend/apps/device/src/display/GroupView.tsx`:

```tsx
import type { ScreenSettings } from "@tournament-admin/shared";
import { useFieldSets, type DisplayMe, type DisplayMeGroup } from "./api";
import type { ScreenContext } from "./screenTypes";
import { screenModule } from "./screens/registry";

export function screenContext(
  sessionId: number,
  group: DisplayMeGroup,
  divisionId: number | null,
  settings: ScreenSettings
): ScreenContext {
  return {
    sessionId,
    fieldSetId: group.kind === "pit" ? null : group.field_set_id,
    divisionId,
    settings,
    queuedMatchId: group.field_set?.queued_match_id ?? null,
  };
}

/** Mounts what a display's group shows. */
export function GroupView({ me }: { me: DisplayMe & { session_id: number; group: DisplayMeGroup } }) {
  const { group, session_id: sessionId } = me;
  const fieldSets = useFieldSets(sessionId);
  const divisionId =
    group.kind === "pit"
      ? group.division_id
      : fieldSets.data?.find((fs) => fs.id === group.field_set_id)?.division_id ?? null;
  // Field groups get the field display in Task 8; pit rotations get the runner in Task 12.
  const entry = group.kind === "pit" && group.rotation?.length ? group.rotation[0] : null;
  const key = group.kind === "field" ? "logo" : entry ? entry.screen : group.screen;
  const settings = entry ? entry.settings : group.screen_settings;
  const { Component } = screenModule(key);
  return <Component context={screenContext(sessionId, group, divisionId, settings)} />;
}
```

Create `frontend/apps/device/src/display/DisplayRoot.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMe } from "./api";
import { useLiveEvents } from "./events";
import { GroupView } from "./GroupView";
import { ServerClockContext, useServerClockOffset } from "./serverClock";
import { useLiveRefresh } from "./useLiveRefresh";

export const IDENTIFY_MS = 10_000;

function NameScreen({ name, text }: { name: string; text: string }) {
  return (
    <section className="screen name-screen">
      <h1 className="name-screen__name">{name}</h1>
      <p className="name-screen__text">{text}</p>
    </section>
  );
}

export function DisplayRoot({ deviceName, unreachable }: { deviceName: string; unreachable: boolean }) {
  const { t } = useTranslation();
  const opens = useLiveRefresh();
  const offset = useServerClockOffset(opens);
  const me = useMe();
  const [identifyUntil, setIdentifyUntil] = useState(0);
  useLiveEvents(["display_identify"], () => setIdentifyUntil(Date.now() + IDENTIFY_MS));
  useEffect(() => {
    if (identifyUntil === 0) return undefined;
    const id = setTimeout(() => setIdentifyUntil(0), Math.max(0, identifyUntil - Date.now()));
    return () => clearTimeout(id);
  }, [identifyUntil]);

  const data = me.data;
  let body;
  if (!data) body = <NameScreen name={deviceName} text={t("connecting")} />;
  else if (data.session_id === null) body = <NameScreen name={data.device.name} text={t("display.noSession")} />;
  else if (data.group === null) body = <NameScreen name={data.device.name} text={t("display.notSetUp")} />;
  else body = <GroupView me={{ ...data, session_id: data.session_id, group: data.group }} />;

  return (
    <ServerClockContext.Provider value={offset}>
      <div className="display">
        {body}
        {identifyUntil > 0 && (
          <div className="identify" data-testid="identify">
            {data?.device.name ?? deviceName}
          </div>
        )}
        {unreachable && (
          <p className="display-badge" role="status">
            {t("display.reconnecting")}
          </p>
        )}
      </div>
    </ServerClockContext.Provider>
  );
}
```

Create `frontend/apps/device/src/display/DisplayApp.tsx`:

```tsx
import { useCallback, useRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DeviceSelf } from "../deviceApi";
import { TokenContext } from "./api";
import { DisplayRoot } from "./DisplayRoot";
import { EventBusContext, type EventBus } from "./events";

export const RETRY_MS = 5_000;
export const SAFETY_REFETCH_MS = 60_000;

/** A paired Display: kiosk screens fed by REST reads and live events. */
export function DisplayApp({
  accessToken,
  device,
  bus,
  unreachable,
}: {
  accessToken: string;
  device: DeviceSelf;
  bus: EventBus;
  unreachable: boolean;
}) {
  const tokenRef = useRef(accessToken);
  tokenRef.current = accessToken;
  const getToken = useCallback(() => tokenRef.current, []);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A TV has no keyboard: keep retrying, and refetch now and then in
            // case a live event was missed.
            retry: true,
            retryDelay: RETRY_MS,
            staleTime: Infinity,
            refetchInterval: SAFETY_REFETCH_MS,
            refetchOnWindowFocus: false,
          },
        },
      })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TokenContext.Provider value={getToken}>
        <EventBusContext.Provider value={bus}>
          <DisplayRoot deviceName={device.name} unreachable={unreachable} />
        </EventBusContext.Provider>
      </TokenContext.Provider>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 9: Route a paired display into display mode**

Replace `frontend/apps/device/src/App.tsx` with:

```tsx
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeviceSession } from "./useDeviceSession";
import { useDeviceSocket } from "./useDeviceSocket";
import { PairingScreen } from "./screens/PairingScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { BlockedScreen } from "./screens/BlockedScreen";
import { DisplayApp } from "./display/DisplayApp";
import { RECONNECTED, createEventBus } from "./display/events";

export function App() {
  const { t } = useTranslation();
  const session = useDeviceSession();
  const [bus] = useState(createEventBus);
  const [pairingReachable, setPairingReachable] = useState(true);
  const onReachability = useCallback((reachable: boolean) => setPairingReachable(reachable), []);
  const [socketReachable, setSocketReachable] = useState(true);
  const onSocketReachability = useCallback((reachable: boolean) => setSocketReachable(reachable), []);
  const onSocketOpen = useCallback(() => bus.emit({ event: RECONNECTED, data: null }), [bus]);
  const onHome = session.screen.kind === "home";
  useDeviceSocket(onHome ? session.accessToken : null, session.recheck, onSocketReachability, bus.emit, onSocketOpen);

  const unreachable =
    session.screen.kind === "pairing"
      ? !pairingReachable
      : session.unreachable || (onHome && !socketReachable);
  const { screen } = session;

  // A paired Display runs the kiosk screens (display groups design).
  if (screen.kind === "home" && screen.device.role === "display_device" && session.accessToken) {
    return <DisplayApp accessToken={session.accessToken} device={screen.device} bus={bus} unreachable={unreachable} />;
  }

  return (
    <main className="device-screen">
      {unreachable && (
        <p className="device-banner" role="status">
          {t("unreachable")}
        </p>
      )}
      {screen.kind === "loading" && <p className="device-connecting">{t("connecting")}</p>}
      {screen.kind === "pairing" && <PairingScreen onPaired={session.paired} onReachability={onReachability} />}
      {screen.kind === "home" && <HomeScreen device={screen.device} />}
      {screen.kind === "blocked" && <BlockedScreen name={screen.name} />}
    </main>
  );
}
```

In `frontend/apps/device/src/main.tsx`, add `import "./styles/display.css";` after the `device.css` import.

- [ ] **Step 10: Add the kiosk styles and the strings**

Create `frontend/apps/device/src/styles/display.css`:

```css
/* Kiosk screens for paired displays: a dark room, read from across it.
   Sizes follow the viewport width so one layout reads on a 24" monitor
   and on a projector. */
.display {
  --kiosk-bg: #0e0d0b;
  --kiosk-surface: #1d1b17;
  --kiosk-band: #f1ece2;
  --kiosk-band-alt: #ddd5c4;
  --kiosk-ink: #f6f3ec;
  --kiosk-ink-on-band: #1b1815;
  --kiosk-muted: #a59d8c;
  --kiosk-red: #c8322b;
  --kiosk-blue: #1f63c6;
  --kiosk-early: #2f9e5a;
  --kiosk-soon: #e3b21a;
  --kiosk-late: #d23c2c;
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: var(--kiosk-bg);
  color: var(--kiosk-ink);
  cursor: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 1.6vw;
  line-height: 1.2;
}
.display * { scrollbar-width: none; }
.display *::-webkit-scrollbar { display: none; }

.screen { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 2vw 3vw; }
.screen__header { flex: none; margin-bottom: 1.5vw; }
.screen__event { margin: 0; font-size: 1.4vw; color: var(--kiosk-muted); }
.screen__title { margin: 0.2vw 0 0; font-size: 4vw; font-weight: 800; letter-spacing: 0.02em; text-transform: uppercase; }
.screen__subtitle { margin: 0.2vw 0 0; font-size: 2vw; color: var(--kiosk-muted); }
.screen__body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.screen__notice { margin: auto; font-size: 3vw; text-align: center; color: var(--kiosk-muted); }

.logo-screen, .name-screen { align-items: center; justify-content: center; text-align: center; }
.logo-screen__name { font-size: 6vw; font-weight: 800; margin: 0; }
.name-screen__name { font-size: 7vw; font-weight: 800; margin: 0; }
.name-screen__text { font-size: 2.6vw; color: var(--kiosk-muted); }

.identify {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgb(0 0 0 / 0.85); font-size: 9vw; font-weight: 800; z-index: 20;
}
.display-badge {
  position: absolute; right: 1.5vw; bottom: 1.5vw; margin: 0; padding: 0.4vw 1vw; z-index: 30;
  border-radius: 0.5vw; background: var(--kiosk-soon); color: var(--kiosk-ink-on-band); font-size: 1.2vw;
}
```

Add to `frontend/apps/device/src/i18n/en/device.json` a top-level `"display"` object:

```json
  "display": {
    "notSetUp": "Not set up for this session",
    "noSession": "No session is running",
    "waiting": "Waiting for data",
    "reconnecting": "Reconnecting…"
  }
```

and to `frontend/apps/device/src/i18n/zh/device.json`:

```json
  "display": {
    "notSetUp": "本场次尚未设置",
    "noSession": "当前没有进行中的场次",
    "waiting": "正在等待数据",
    "reconnecting": "正在重新连接…"
  }
```

- [ ] **Step 11: Run the tests and type check**

Run: `cd frontend/apps/device && npx vitest run && npx tsc -b`
Expected: all tests pass; `tsc` prints nothing.

- [ ] **Step 12: Commit**

```bash
git add frontend/package-lock.json frontend/apps/device/package.json frontend/apps/device/src frontend/apps/device/tests
git commit -m "Run a paired display in display mode: it reads its group from the server, refreshes on live events, measures the server clock, shows its name when unassigned or identified, keeps its picture with a corner badge while reconnecting, and shows the Logo screen, which also stands in for any screen key it doesn't know.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The field display, the In Match screen and the time-out

**Files:**
- Create: `frontend/apps/device/src/display/logic/alliances.ts`, `frontend/apps/device/src/display/matchTitle.ts`
- Create: `frontend/apps/device/src/display/components/StartCountdown.tsx`, `InMatchView.tsx`, `TimeoutGate.tsx`, `PeriodIcon.tsx`
- Create: `frontend/apps/device/src/display/FieldDisplay.tsx`, `frontend/apps/device/src/display/screens/inMatch.tsx`
- Modify: `frontend/apps/device/src/display/GroupView.tsx`, `frontend/apps/device/src/display/screens/registry.ts`
- Modify: `frontend/apps/device/src/styles/display.css`, both `device.json` files
- Test: `frontend/apps/device/tests/unit/fieldDisplay.test.tsx`

**Interfaces:**
- Consumes: Task 6 `currentMatchForField`, `latestStartedMatchForFieldSet`, `remainingSeconds`, `formatClock`, `startBand`, `formatOffset`, `COUNT_IN_PHASES`; Task 7 hooks, `ScreenFrame`, `useServerNow`.
- Produces: `allianceGroups(match, gameModel) -> AllianceGroup[]` (`{station: "red" | "blue" | "all", teamIds, allianceIds}`), `teamPlace(team) -> string`; `matchTitle(t, match) -> string`; `StartCountdown({scheduledTime, now})`; `InMatchView({match, sessionId, now})`; `TimeoutGate({deadline, children})`; `FieldDisplay({sessionId, fieldId})`; `fieldIdsOf(fields, fieldSetId)` (exported from `screens/inMatch.tsx`); the `in_match` module; `GroupView` now runs `FieldDisplay` for field groups and wraps audience screens in `TimeoutGate`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/device/tests/unit/fieldDisplay.test.tsx`:

```tsx
import { act, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOPERATIVE, audienceGroup, baseRoutes, fieldGroup, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (msFromNow: number) => new Date(NOW + msFromNow).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function showField(matches: unknown[], { group = fieldGroup(), offset = 0, extra = {} } = {}) {
  serveDisplay(
    { ...baseRoutes(), "/api/displays/me": me(group), "/api/matches?session_id=1": matches, ...extra },
    { serverOffsetMs: offset }
  );
  return renderDisplay();
}

describe("field display", () => {
  it("shows the field's next match with its team numbers in alliance bars", async () => {
    showField([match({ id: 7, label: "Q7", match_number: 7, scheduled_time: iso(83_000) })]);
    expect(await screen.findByRole("heading", { name: "Qualification 7" })).toBeInTheDocument();
    expect(screen.getByText("Field 1")).toBeInTheDocument();
    expect(within(screen.getByTestId("bar-red")).getByText("101A")).toBeInTheDocument();
    expect(within(screen.getByTestId("bar-blue")).getByText("104D")).toBeInTheDocument();
    const start = screen.getByTestId("start");
    expect(start).toHaveTextContent("1:23 to go");
    expect(start).toHaveAttribute("data-band", "early");
  });

  it("turns yellow at 30 seconds and red once late", async () => {
    showField([match({ scheduled_time: iso(31_000) })]);
    const start = await screen.findByTestId("start");
    expect(start).toHaveAttribute("data-band", "early");
    await act(() => vi.advanceTimersByTimeAsync(1_500));
    expect(screen.getByTestId("start")).toHaveAttribute("data-band", "soon");
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(screen.getByTestId("start")).toHaveAttribute("data-band", "late");
    expect(screen.getByTestId("start")).toHaveTextContent("0:00 late");
  });

  it("uses the server's clock, not the TV's", async () => {
    // The server is a minute ahead: 80 s away on the TV's clock is 20 s away for real.
    showField([match({ scheduled_time: iso(80_000) })], { offset: 60_000 });
    await screen.findByTestId("start");
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(screen.getByTestId("start")).toHaveAttribute("data-band", "soon");
  });

  it("shows Up next for a match with no scheduled time, and one bar for a cooperative game", async () => {
    showField([match({ scheduled_time: null })], { extra: { "/api/event/match-format": COOPERATIVE } });
    expect(await screen.findByTestId("start")).toHaveTextContent("Up next");
    expect(screen.getByTestId("bar-all")).toHaveTextContent("101A");
    expect(screen.getByTestId("bar-all")).toHaveTextContent("104D");
    expect(screen.queryByTestId("bar-red")).not.toBeInTheDocument();
  });

  it("counts in with 3-2-1 under the period's name", async () => {
    showField([match({ phase: "countdown_autonomous", phase_deadline: iso(2_500) })]);
    expect(await screen.findByTestId("count-in")).toHaveTextContent("3");
    expect(screen.getByText("Autonomous")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(screen.getByTestId("count-in")).toHaveTextContent("2");
  });

  it("shows the period clock, a paused banner and Driver control next", async () => {
    let matches = [match({ id: 3, phase: "driver", phase_deadline: iso(95_000) })];
    const { emit } = showField([], { extra: { "/api/matches?session_id=1": () => matches } });
    expect(await screen.findByTestId("clock")).toHaveTextContent("1:35");
    expect(screen.getByText("Driver control")).toBeInTheDocument();
    matches = [match({ id: 3, phase: "driver", paused: true, remaining_seconds_at_pause: 40 })];
    emit("match_paused", { match_id: 3 });
    expect(await screen.findByText("Paused")).toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveTextContent("0:40");
    matches = [match({ id: 3, phase: "awaiting_driver" })];
    emit("match_phase_changed", { match_id: 3 });
    expect(await screen.findByText("Driver control next")).toBeInTheDocument();
    matches = [match({ id: 3, phase: "ended" })];
    emit("match_phase_changed", { match_id: 3 });
    expect(await screen.findByText("Match over")).toBeInTheDocument();
  });

  it("moves to the field's next match once the score is saved, and says when the field is done", async () => {
    let matches = [
      match({ id: 34, label: "Q34", match_number: 34, phase: "ended", scheduled_time: iso(-60_000) }),
      match({ id: 37, label: "Q37", match_number: 37, scheduled_time: iso(300_000) }),
      match({ id: 35, label: "Q35", match_number: 35, field_id: 2, scheduled_time: iso(100_000) }),
    ];
    const { emit } = showField([], { extra: { "/api/matches?session_id=1": () => matches } });
    expect(await screen.findByText("Match over")).toBeInTheDocument();
    matches = matches.map((m) => (m.id === 34 ? { ...m, status: "completed" } : m));
    emit("score_saved", { match_id: 34 });
    expect(await screen.findByRole("heading", { name: "Qualification 37" })).toBeInTheDocument();
    matches = matches.map((m) => ({ ...m, status: "completed" }));
    emit("score_saved", { match_id: 37 });
    expect(await screen.findByText("No more matches on this field")).toBeInTheDocument();
  });

  it("a running time-out replaces everything until it ends", async () => {
    const group = fieldGroup({ field_set: { queued_match_id: null, timeout_deadline: iso(5_000) } });
    showField([match({ scheduled_time: iso(300_000) })], { group });
    expect(await screen.findByRole("heading", { name: "Time-out" })).toBeInTheDocument();
    expect(screen.getByTestId("timeout-clock")).toHaveTextContent("0:05");
    await act(() => vi.advanceTimersByTimeAsync(5_500));
    expect(await screen.findByTestId("start")).toBeInTheDocument();
  });
});

describe("audience In Match", () => {
  it("shows the field group's running match with rank chips, and the last ended one after", async () => {
    let matches = [match({ id: 5, label: "Q5", match_number: 5, field_id: 2, phase: "driver", phase_deadline: iso(30_000) })];
    const { emit } = showField([], {
      group: audienceGroup({ screen: "in_match" }),
      extra: {
        "/api/matches?session_id=1": () => matches,
        "/api/rankings?session_id=1": [{ team_id: 1, division_id: null, rank: 3, win_points: 0, strength_of_schedule: 0, average_score: 0, matches_played: 1 }],
      },
    });
    expect(await screen.findByRole("heading", { name: "Qualification 5" })).toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveTextContent("0:30");
    expect(screen.getByTestId("chip-1")).toHaveTextContent("3");
    expect(screen.getByTestId("chip-2")).toHaveTextContent("–");
    matches = [{ ...matches[0], phase: "ended", phase_deadline: null }];
    emit("match_phase_changed", { match_id: 5 });
    expect(await screen.findByText("Match over")).toBeInTheDocument();
    expect(screen.getByTestId("clock")).toHaveTextContent("0:00");
  });

  it("an audience screen is covered by a running time-out", async () => {
    const group = audienceGroup({ screen: "logo", field_set: { queued_match_id: null, timeout_deadline: iso(60_000) } });
    showField([], { group });
    expect(await screen.findByRole("heading", { name: "Time-out" })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/device && npx vitest run tests/unit/fieldDisplay.test.tsx`
Expected: FAIL (the field group still shows the Logo screen).

- [ ] **Step 3: Write the alliance grouping and the match title**

Create `frontend/apps/device/src/display/logic/alliances.ts`:

```ts
import type { LiveMatch } from "@tournament-admin/shared";
import type { GameModel, Team } from "../api";

export type BandStation = "red" | "blue" | "all";

export interface AllianceGroup {
  station: BandStation;
  teamIds: number[];
  allianceIds: number[];
}

/** Red then blue for a head-to-head game; one group with every team for a
 * cooperative game, whose alliances share one outcome. */
export function allianceGroups(match: LiveMatch, gameModel: GameModel): AllianceGroup[] {
  if (gameModel === "cooperative_score") {
    const teamIds = [...new Set(match.alliances.flatMap((a) => a.team_ids))];
    return [{ station: "all", teamIds, allianceIds: match.alliances.map((a) => a.id) }];
  }
  return [...match.alliances]
    .sort((a, b) => (a.station === "blue" ? 1 : 0) - (b.station === "blue" ? 1 : 0))
    .map((a) => ({ station: a.station === "blue" ? "blue" : "red", teamIds: a.team_ids, allianceIds: [a.id] }));
}

/** "City, State, Country", whichever are set. */
export function teamPlace(team: Team | undefined): string {
  if (!team) return "";
  return [team.city, team.state, team.country].filter(Boolean).join(", ");
}
```

Create `frontend/apps/device/src/display/matchTitle.ts`:

```ts
import type { TFunction } from "i18next";
import type { LiveMatch } from "@tournament-admin/shared";

/** "Qualification 37", "Practice 4", or "Final F2-1" for a finals game. */
export function matchTitle(t: TFunction, match: LiveMatch): string {
  if (match.is_finals) return t("display.round.finals", { label: match.label });
  return t(`display.round.${match.round_type}`, { number: match.match_number, defaultValue: match.label });
}
```

- [ ] **Step 4: Write the countdown, In Match and time-out components**

Create `frontend/apps/device/src/display/components/StartCountdown.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { formatOffset, startBand } from "@tournament-admin/shared";

/** The time to a match's scheduled start: green, then yellow from 30 s, red once late. */
export function StartCountdown({ scheduledTime, now }: { scheduledTime: string | null; now: number }) {
  const { t } = useTranslation();
  if (scheduledTime === null) {
    return (
      <p className="start start--next" data-testid="start" data-band="next">
        {t("display.upNext")}
      </p>
    );
  }
  const ms = Date.parse(scheduledTime) - now;
  const band = startBand(ms);
  return (
    <p className={`start start--${band}`} data-testid="start" data-band={band}>
      {band === "late" ? t("display.late", { time: formatOffset(ms) }) : t("display.startsIn", { time: formatOffset(ms) })}
    </p>
  );
}
```

Create `frontend/apps/device/src/display/components/PeriodIcon.tsx`:

```tsx
/** Small inline pictures for the period banner: a chip for autonomous, a controller for driver control. */
export function PeriodIcon({ period }: { period: "autonomous" | "driver" }) {
  if (period === "autonomous") {
    return (
      <svg className="period-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" stroke="currentColor" strokeWidth="2" />
      </svg>
    );
  }
  return (
    <svg className="period-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M7 8h10a5 5 0 0 1 4.6 7l-.8 1.8a2.5 2.5 0 0 1-4.3.4L15 15H9l-1.5 2.2a2.5 2.5 0 0 1-4.3-.4L2.4 15A5 5 0 0 1 7 8z"
        fill="currentColor"
      />
    </svg>
  );
}
```

Create `frontend/apps/device/src/display/components/InMatchView.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { COUNT_IN_PHASES, formatClock, remainingSeconds, type LiveMatch } from "@tournament-admin/shared";
import { useRanks, useTeamsById } from "../api";
import { matchTitle } from "../matchTitle";
import { PeriodIcon } from "./PeriodIcon";
import { ScreenFrame } from "./ScreenFrame";

function periodOf(phase: string): "autonomous" | "driver" | null {
  if (phase === "countdown_autonomous" || phase === "autonomous") return "autonomous";
  if (phase === "countdown_driver" || phase === "driver") return "driver";
  return null;
}

/** The match clock, shared by the field display and the audience's In Match screen. */
export function InMatchView({ match, sessionId, now }: { match: LiveMatch; sessionId: number; now: number }) {
  const { t } = useTranslation();
  const teams = useTeamsById();
  const ranks = useRanks(sessionId, match.division_id);
  const remaining = remainingSeconds(match, now) ?? 0;
  const period = periodOf(match.phase);

  let centre;
  if (match.phase === "ended") {
    centre = (
      <>
        <p className="clock" data-testid="clock">
          0:00
        </p>
        <p className="in-match__over">{t("display.matchOver")}</p>
      </>
    );
  } else if (match.phase === "awaiting_driver") {
    centre = <p className="clock clock--message">{t("display.driverNext")}</p>;
  } else if (COUNT_IN_PHASES.has(match.phase)) {
    centre = (
      <p className="clock clock--count-in" data-testid="count-in">
        {Math.max(1, Math.ceil(remaining - 1e-9))}
      </p>
    );
  } else {
    centre = (
      <p className="clock" data-testid="clock">
        {formatClock(remaining)}
      </p>
    );
  }

  return (
    <ScreenFrame title={matchTitle(t, match)} className="in-match">
      <ul className="in-match__chips">
        {match.alliances.flatMap((alliance) =>
          alliance.team_ids.map((teamId) => (
            <li key={`${alliance.id}-${teamId}`} className={`chip chip--${alliance.station}`} data-testid={`chip-${teamId}`}>
              <span className="chip__rank">{ranks?.get(teamId) ?? "–"}</span>
              <span className="chip__number">{teams?.get(teamId)?.number ?? ""}</span>
            </li>
          ))
        )}
      </ul>
      <div className="in-match__centre">{centre}</div>
      {match.paused && (
        <p className="in-match__paused" role="status">
          {t("display.paused")}
        </p>
      )}
      {period && match.phase !== "ended" && (
        <p className="in-match__banner">
          <PeriodIcon period={period} />
          {t(`display.period.${period}`)}
        </p>
      )}
    </ScreenFrame>
  );
}
```

Create `frontend/apps/device/src/display/components/TimeoutGate.tsx`:

```tsx
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatClock } from "@tournament-admin/shared";
import { useServerNow } from "../serverClock";
import { ScreenFrame } from "./ScreenFrame";

/** While a time-out runs on the field group, shows its countdown instead of `children`. */
export function TimeoutGate({ deadline, children }: { deadline: string | null; children: ReactNode }) {
  const { t } = useTranslation();
  const now = useServerNow();
  const remainingMs = deadline === null ? 0 : Date.parse(deadline) - now;
  if (remainingMs <= 0) return <>{children}</>;
  return (
    <ScreenFrame title={t("display.timeout")} className="timeout">
      <p className="clock" data-testid="timeout-clock">
        {formatClock(remainingMs / 1000)}
      </p>
    </ScreenFrame>
  );
}
```

- [ ] **Step 5: Write the field display and the In Match screen**

Create `frontend/apps/device/src/display/FieldDisplay.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { currentMatchForField } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useTeamsById } from "./api";
import { InMatchView } from "./components/InMatchView";
import { ScreenFrame, ScreenNotice, WaitingForData } from "./components/ScreenFrame";
import { StartCountdown } from "./components/StartCountdown";
import { allianceGroups } from "./logic/alliances";
import { matchTitle } from "./matchTitle";
import { useServerNow } from "./serverClock";

/** A field's own monitor: its next match in numbers big enough for the
 * referees' robot check, then the count-in and clock, then the next match
 * once the score is saved. */
export function FieldDisplay({ sessionId, fieldId }: { sessionId: number; fieldId: number }) {
  const { t } = useTranslation();
  const now = useServerNow();
  const matches = useMatches(sessionId);
  const fields = useFields(sessionId);
  const teams = useTeamsById();
  const format = useMatchFormat();
  const fieldName = fields.data?.find((f) => f.id === fieldId)?.name ?? "";
  if (!matches.data || !teams || !format.data) return <WaitingForData title={fieldName} />;
  const match = currentMatchForField(matches.data, fieldId);
  if (!match) return <ScreenNotice title={fieldName} text={t("display.fieldDone")} />;
  if (match.phase !== "not_started") return <InMatchView match={match} sessionId={sessionId} now={now} />;
  return (
    <ScreenFrame title={matchTitle(t, match)} subtitle={fieldName} className="field-next">
      <div className="field-next__bars">
        {allianceGroups(match, format.data.game_model).map((group) => (
          <div key={group.station} className={`team-bar team-bar--${group.station}`} data-testid={`bar-${group.station}`}>
            {group.teamIds.map((id) => (
              <span key={id} className="team-bar__number">
                {teams.get(id)?.number ?? ""}
              </span>
            ))}
          </div>
        ))}
      </div>
      <StartCountdown scheduledTime={match.scheduled_time} now={now} />
    </ScreenFrame>
  );
}
```

Create `frontend/apps/device/src/display/screens/inMatch.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { latestStartedMatchForFieldSet } from "@tournament-admin/shared";
import { useFields, useMatches } from "../api";
import { InMatchView } from "../components/InMatchView";
import { ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { useServerNow } from "../serverClock";

export function fieldIdsOf(fields: { id: number; field_set_id: number }[], fieldSetId: number | null): number[] {
  return fields.filter((f) => fieldSetId === null || f.field_set_id === fieldSetId).map((f) => f.id);
}

function InMatchScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const now = useServerNow();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const title = t("display.screens.in_match");
  if (!matches.data || !fields.data) return <WaitingForData title={title} />;
  const match = latestStartedMatchForFieldSet(matches.data, fieldIdsOf(fields.data, context.fieldSetId));
  if (!match) return <ScreenNotice title={title} text={t("display.noMatchYet")} />;
  return <InMatchView match={match} sessionId={context.sessionId} now={now} />;
}

export const inMatchScreen: ScreenModule = { key: "in_match", scrolls: false, Component: InMatchScreen };
```

In `screens/registry.ts` import `inMatchScreen` and add `in_match: inMatchScreen,` to `MODULES`.

Replace the body of `GroupView` in `GroupView.tsx` (keep `screenContext`) with:

```tsx
export function GroupView({ me }: { me: DisplayMe & { session_id: number; group: DisplayMeGroup } }) {
  const { group, session_id: sessionId } = me;
  const fieldSets = useFieldSets(sessionId);
  const timeoutDeadline = group.field_set?.timeout_deadline ?? null;
  if (group.kind === "field" && group.field_id !== null) {
    return (
      <TimeoutGate deadline={timeoutDeadline}>
        <FieldDisplay sessionId={sessionId} fieldId={group.field_id} />
      </TimeoutGate>
    );
  }
  const divisionId =
    group.kind === "pit"
      ? group.division_id
      : fieldSets.data?.find((fs) => fs.id === group.field_set_id)?.division_id ?? null;
  // Pit rotations get the runner in Task 12.
  const entry = group.kind === "pit" && group.rotation?.length ? group.rotation[0] : null;
  const { Component } = screenModule(entry ? entry.screen : group.screen);
  const screen = (
    <Component context={screenContext(sessionId, group, divisionId, entry ? entry.settings : group.screen_settings)} />
  );
  return group.kind === "audience" ? <TimeoutGate deadline={timeoutDeadline}>{screen}</TimeoutGate> : screen;
}
```

(import `FieldDisplay` from `./FieldDisplay` and `TimeoutGate` from `./components/TimeoutGate`).

- [ ] **Step 6: Add the styles and strings**

Append to `display.css`:

```css
.start { margin: auto 0 0; padding: 1vw 2vw; border-radius: 1vw; font-size: 5vw; font-weight: 800; text-align: center; font-variant-numeric: tabular-nums; }
.start--early { background: var(--kiosk-early); }
.start--soon { background: var(--kiosk-soon); color: var(--kiosk-ink-on-band); }
.start--late { background: var(--kiosk-late); }
.start--next { background: var(--kiosk-surface); }

/* The field monitor's next match: the numbers are the biggest thing on the screen. */
.field-next__bars { display: flex; flex-direction: column; gap: 1.5vw; }
.team-bar { display: flex; justify-content: space-around; padding: 1.5vw 2vw; border-radius: 1vw; }
.team-bar--red { background: var(--kiosk-red); }
.team-bar--blue { background: var(--kiosk-blue); }
.team-bar--all { background: var(--kiosk-blue); flex-wrap: wrap; }
.team-bar__number { font-size: 9vw; font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }

.in-match__chips { position: absolute; top: 1vw; left: 1vw; margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 0.3vw; }
.chip { display: flex; align-items: center; gap: 0.6vw; padding: 0.2vw 1vw 0.2vw 0.3vw; font-size: 1.8vw; font-weight: 800; }
.chip--red { background: var(--kiosk-red); }
.chip--blue { background: var(--kiosk-blue); }
.chip__rank { min-width: 2.2vw; padding: 0 0.3vw; background: var(--kiosk-band); color: var(--kiosk-ink-on-band); text-align: center; font-size: 1.3vw; }
.in-match .screen__header { text-align: center; }
.in-match__centre { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.clock { margin: 0; font-size: 22vw; font-weight: 900; line-height: 1; font-variant-numeric: tabular-nums; }
.clock--count-in { font-size: 28vw; }
.clock--message { font-size: 6vw; }
.in-match__over { margin: 0; font-size: 4vw; font-weight: 800; color: var(--kiosk-muted); }
.in-match__paused { position: absolute; top: 40%; left: 0; right: 0; margin: 0; padding: 1vw; background: var(--kiosk-soon); color: var(--kiosk-ink-on-band); font-size: 5vw; font-weight: 900; text-align: center; }
.in-match__banner { align-self: center; display: flex; align-items: center; gap: 1vw; margin: 0; padding: 0.6vw 4vw; background: var(--kiosk-blue); font-size: 3vw; font-weight: 800; text-transform: uppercase; }
.period-icon { width: 3vw; height: 3vw; }
.timeout .clock { margin: auto; }
```

Add to the `"display"` object in `en/device.json`:

```json
    "upNext": "Up next",
    "startsIn": "{{time}} to go",
    "late": "{{time}} late",
    "matchOver": "Match over",
    "driverNext": "Driver control next",
    "paused": "Paused",
    "timeout": "Time-out",
    "fieldDone": "No more matches on this field",
    "noMatchYet": "No match has started yet",
    "period": { "autonomous": "Autonomous", "driver": "Driver control" },
    "round": {
      "qualification": "Qualification {{number}}",
      "practice": "Practice {{number}}",
      "elimination": "Elimination {{number}}",
      "finals": "Final {{label}}"
    },
    "screens": {
      "match_intro": "Match Intro",
      "in_match": "In Match",
      "last_scored_match": "Last Scored Match",
      "teamwork_rankings": "Teamwork Rankings",
      "skills_rankings": "Skills Rankings",
      "upcoming_matches": "Upcoming Matches",
      "match_results": "Match Results",
      "schedule": "Match Schedule",
      "elimination_bracket": "Elimination Brackets",
      "logo": "Logo"
    }
```

and to `zh/device.json`:

```json
    "upNext": "下一场",
    "startsIn": "还有 {{time}}",
    "late": "已延误 {{time}}",
    "matchOver": "比赛结束",
    "driverNext": "即将进入手动控制",
    "paused": "已暂停",
    "timeout": "暂停时间",
    "fieldDone": "本场地没有更多比赛",
    "noMatchYet": "还没有比赛开始",
    "period": { "autonomous": "自动阶段", "driver": "手动控制" },
    "round": {
      "qualification": "资格赛 {{number}}",
      "practice": "练习赛 {{number}}",
      "elimination": "淘汰赛 {{number}}",
      "finals": "决赛 {{label}}"
    },
    "screens": {
      "match_intro": "比赛介绍",
      "in_match": "比赛进行中",
      "last_scored_match": "最近计分的比赛",
      "teamwork_rankings": "团队赛排名",
      "skills_rankings": "技能赛排名",
      "upcoming_matches": "即将进行的比赛",
      "match_results": "比赛结果",
      "schedule": "比赛日程",
      "elimination_bracket": "淘汰赛对阵",
      "logo": "标志"
    }
```

- [ ] **Step 7: Run the tests and type check**

Run: `cd frontend/apps/device && npx vitest run && npx tsc -b`
Expected: all pass, `tsc` silent.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/device/src frontend/apps/device/tests
git commit -m "Show the field display: the field's next match with its team numbers in large alliance bars and a green, yellow or red time to start from the server's clock, the 3-2-1 count-in and period clock shared with the audience's In Match screen, Match over until the score is saved, and a full-screen time-out.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Match Intro and Last Scored Match

**Files:**
- Create: `frontend/apps/device/src/display/components/AllianceBands.tsx`, `ScoreBreakdown.tsx`
- Create: `frontend/apps/device/src/display/screens/matchIntro.tsx`, `lastScoredMatch.tsx`
- Modify: `frontend/apps/device/src/display/screens/registry.ts`, `display.css`, both `device.json` files
- Test: `frontend/apps/device/tests/unit/matchScreens.test.tsx`

**Interfaces:**
- Consumes: Task 6 `nextMatchForFieldSet`, `lastScoredMatch`; Task 7 hooks; Task 8 `allianceGroups`, `teamPlace`, `matchTitle`, `StartCountdown`, `fieldIdsOf` (exported from `screens/inMatch.tsx`).
- Produces: `AllianceBands({match, gameModel, teams, ranks, scores?})`, `ScoreBreakdown({match, gameModel, schema, sheets})`, `formatSheetValue(value) -> string`; the `match_intro` and `last_scored_match` modules.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/device/tests/unit/matchScreens.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOPERATIVE, audienceGroup, baseRoutes, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const SCHEMA = [
  { name: "high_balls", label: "High Balls", data_type: "integer", options: null },
  { name: "parked", label: "Robot Parked", data_type: "boolean", options: null },
  { name: "auto_winner", label: "Autonomous Winner", data_type: "enum", options: ["red", "blue", "tie"] },
];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Match Intro", () => {
  it("shows the group's next match with ranks, names and locations", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "match_intro" })),
      "/api/matches?session_id=1": [
        match({ id: 9, label: "Q9", match_number: 9, field_id: 2, scheduled_time: iso(120_000) }),
        match({ id: 8, label: "Q8", match_number: 8, phase: "driver", scheduled_time: iso(0) }),
      ],
      "/api/rankings?session_id=1": [{ team_id: 3, division_id: null, rank: 2, win_points: 2, strength_of_schedule: 0, average_score: 0, matches_played: 1 }],
    });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Qualification 9" })).toBeInTheDocument();
    expect(screen.getByText("Field 2")).toBeInTheDocument();
    expect(screen.getByTestId("start")).toHaveTextContent("2:00 to go");
    const blue = screen.getByRole("region", { name: "Blue alliance" });
    expect(within(blue).getByText("103C")).toBeInTheDocument();
    expect(within(blue).getByText("Bolts")).toBeInTheDocument();
    expect(within(blue).getByText("Shelbyville")).toBeInTheDocument();
    expect(within(blue).getByTestId("rank-3")).toHaveTextContent("2");
    expect(within(screen.getByRole("region", { name: "Red alliance" })).getByTestId("rank-1")).toHaveTextContent("–");
  });

  it("shows the queued match instead when one is queued", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "match_intro", field_set: { queued_match_id: 12, timeout_deadline: null } })),
      "/api/matches?session_id=1": [
        match({ id: 11, label: "Q11", match_number: 11, scheduled_time: iso(60_000) }),
        match({ id: 12, label: "Q12", match_number: 12, scheduled_time: iso(120_000) }),
      ],
    });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Qualification 12" })).toBeInTheDocument();
  });

  it("uses one Alliance band for a cooperative game", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/match-format": COOPERATIVE,
      "/api/displays/me": me(audienceGroup({ screen: "match_intro" })),
      "/api/matches?session_id=1": [match({ scheduled_time: iso(60_000) })],
    });
    renderDisplay();
    const band = await screen.findByRole("region", { name: "Alliance" });
    expect(within(band).getByText("101A")).toBeInTheDocument();
    expect(within(band).getByText("104D")).toBeInTheDocument();
  });

  it("says when no match is left", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup({ screen: "match_intro" })) });
    renderDisplay();
    expect(await screen.findByText("No more matches here")).toBeInTheDocument();
  });
});

describe("Last Scored Match", () => {
  it("shows each alliance's score and the score breakdown", async () => {
    const scored = match({ id: 20, label: "Q20", match_number: 20, status: "completed", phase: "ended" });
    serveDisplay({
      ...baseRoutes(),
      "/api/event/scoresheet-schema": SCHEMA,
      "/api/displays/me": me(audienceGroup({ screen: "last_scored_match" })),
      "/api/matches?session_id=1": [scored],
      "/api/scores?session_id=1": [
        { match_id: 20, alliance_id: 201, score: 19, data: { high_balls: 3, parked: true, auto_winner: "red" }, teams: [], saved_at: iso(-5_000) },
        { match_id: 20, alliance_id: 202, score: 4, data: { high_balls: 1, parked: false, auto_winner: "red" }, teams: [], saved_at: iso(-5_000) },
      ],
    });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Qualification 20" })).toBeInTheDocument();
    expect(screen.getByTestId("score-red")).toHaveTextContent("19");
    expect(screen.getByTestId("score-blue")).toHaveTextContent("4");
    const breakdown = screen.getByRole("table", { name: "Score breakdown" });
    const parked = within(breakdown).getByRole("row", { name: /Robot Parked/ });
    expect(parked).toHaveTextContent("✓");
    expect(parked).toHaveTextContent("–");
    expect(within(breakdown).getByRole("row", { name: /High Balls/ })).toHaveTextContent("3");
  });

  it("waits for data, then says when nothing is scored yet", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/scoresheet-schema": SCHEMA,
      "/api/displays/me": me(audienceGroup({ screen: "last_scored_match" })),
    });
    renderDisplay();
    expect(await screen.findByText("No match has been scored yet")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/device && npx vitest run tests/unit/matchScreens.test.tsx`
Expected: FAIL (Logo stands in for the unregistered screens).

- [ ] **Step 3: Write the bands and the breakdown**

Create `frontend/apps/device/src/display/components/AllianceBands.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import type { LiveMatch } from "@tournament-admin/shared";
import type { GameModel, Team } from "../api";
import { allianceGroups, teamPlace, type AllianceGroup } from "../logic/alliances";

/** A group's score: its alliances' best saved score (a cooperative game's
 * alliances carry the same mirrored score). */
export function groupScore(group: AllianceGroup, scores: Map<number, number>): number | null {
  const values = group.allianceIds.map((id) => scores.get(id)).filter((v): v is number => v !== undefined);
  return values.length ? Math.max(...values) : null;
}

export function AllianceBands({
  match,
  gameModel,
  teams,
  ranks,
  scores,
}: {
  match: LiveMatch;
  gameModel: GameModel;
  teams: Map<number, Team>;
  ranks: Map<number, number> | undefined;
  scores?: Map<number, number>;
}) {
  const { t } = useTranslation();
  return (
    <div className="bands">
      {allianceGroups(match, gameModel).map((group) => (
        <section key={group.station} className={`band band--${group.station}`} aria-label={t(`display.alliance.${group.station}`)}>
          <h2 className="band__label">{t(`display.alliance.${group.station}`)}</h2>
          {scores && (
            <p className="band__score" data-testid={`score-${group.station}`}>
              {groupScore(group, scores) ?? "–"}
            </p>
          )}
          <ul className="band__teams">
            {group.teamIds.map((id) => {
              const team = teams.get(id);
              return (
                <li key={id} className="band__team">
                  <span className="band__rank" data-testid={`rank-${id}`}>
                    {ranks?.get(id) ?? "–"}
                  </span>
                  <span className="band__number">{team?.number ?? ""}</span>
                  <span className="band__name">{team?.name ?? ""}</span>
                  <span className="band__place">{teamPlace(team)}</span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
```

Create `frontend/apps/device/src/display/components/ScoreBreakdown.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import type { LiveMatch } from "@tournament-admin/shared";
import type { GameModel, ScoresheetFieldInfo } from "../api";
import { allianceGroups } from "../logic/alliances";

export function formatSheetValue(value: unknown): string {
  if (value === true) return "✓";
  if (value === false || value === null || value === undefined || value === "") return "–";
  return String(value);
}

/** One row per scoresheet field, one column per alliance band. */
export function ScoreBreakdown({
  match,
  gameModel,
  schema,
  sheets,
}: {
  match: LiveMatch;
  gameModel: GameModel;
  schema: ScoresheetFieldInfo[];
  sheets: Map<number, Record<string, unknown>>;
}) {
  const { t } = useTranslation();
  const columns = allianceGroups(match, gameModel).map((group) => ({
    station: group.station,
    sheet: group.allianceIds.map((id) => sheets.get(id)).find((s) => s !== undefined) ?? {},
  }));
  return (
    <table className="breakdown" aria-label={t("display.breakdown")}>
      <tbody>
        {schema.map((field) => (
          <tr key={field.name}>
            <th scope="row">{field.label}</th>
            {columns.map((column) => (
              <td key={column.station} className={`breakdown__value breakdown__value--${column.station}`}>
                {formatSheetValue(column.sheet[field.name])}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 4: Write the two screens**

Create `frontend/apps/device/src/display/screens/matchIntro.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { nextMatchForFieldSet } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useRanks, useTeamsById } from "../api";
import { AllianceBands } from "../components/AllianceBands";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { StartCountdown } from "../components/StartCountdown";
import { matchTitle } from "../matchTitle";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { useServerNow } from "../serverClock";
import { fieldIdsOf } from "./inMatch";

function MatchIntroScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const now = useServerNow();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const next =
    matches.data && fields.data
      ? nextMatchForFieldSet(matches.data, fieldIdsOf(fields.data, context.fieldSetId), context.queuedMatchId)
      : null;
  const ranks = useRanks(context.sessionId, next?.division_id ?? context.divisionId);
  const title = t("display.screens.match_intro");
  if (!matches.data || !fields.data || !format.data || !teams) return <WaitingForData title={title} />;
  if (!next) return <ScreenNotice title={title} text={t("display.noMoreMatches")} />;
  const fieldName = fields.data.find((f) => f.id === next.field_id)?.name;
  return (
    <ScreenFrame title={matchTitle(t, next)} subtitle={fieldName} className="intro">
      <StartCountdown scheduledTime={next.scheduled_time} now={now} />
      <AllianceBands match={next} gameModel={format.data.game_model} teams={teams} ranks={ranks} />
    </ScreenFrame>
  );
}

export const matchIntroScreen: ScreenModule = { key: "match_intro", scrolls: false, Component: MatchIntroScreen };
```

Create `frontend/apps/device/src/display/screens/lastScoredMatch.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { lastScoredMatch } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useRanks, useScores, useScoresheetSchema, useTeamsById } from "../api";
import { AllianceBands } from "../components/AllianceBands";
import { ScoreBreakdown } from "../components/ScoreBreakdown";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { matchTitle } from "../matchTitle";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { fieldIdsOf } from "./inMatch";

function LastScoredMatchScreen({ context }: ScreenProps) {
  const { t } = useTranslation();
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const schema = useScoresheetSchema();
  const teams = useTeamsById();
  const match =
    matches.data && scores.data && fields.data
      ? lastScoredMatch(matches.data, scores.data, fieldIdsOf(fields.data, context.fieldSetId))
      : null;
  const ranks = useRanks(context.sessionId, match?.division_id ?? context.divisionId);
  const title = t("display.screens.last_scored_match");
  if (!matches.data || !scores.data || !fields.data || !format.data || !schema.data || !teams) {
    return <WaitingForData title={title} />;
  }
  if (!match) return <ScreenNotice title={title} text={t("display.nothingScored")} />;
  const own = scores.data.filter((s) => s.match_id === match.id);
  return (
    <ScreenFrame title={matchTitle(t, match)} className="result">
      <ScoreBreakdown
        match={match}
        gameModel={format.data.game_model}
        schema={schema.data}
        sheets={new Map(own.map((s) => [s.alliance_id, s.data]))}
      />
      <AllianceBands
        match={match}
        gameModel={format.data.game_model}
        teams={teams}
        ranks={ranks}
        scores={new Map(own.map((s) => [s.alliance_id, s.score]))}
      />
    </ScreenFrame>
  );
}

export const lastScoredMatchScreen: ScreenModule = {
  key: "last_scored_match",
  scrolls: false,
  Component: LastScoredMatchScreen,
};
```

Register both in `screens/registry.ts` (`match_intro: matchIntroScreen, last_scored_match: lastScoredMatchScreen`).

- [ ] **Step 5: Styles and strings**

Append to `display.css`:

```css
.bands { margin-top: auto; display: flex; gap: 1.5vw; }
.band { flex: 1; padding: 1vw 1.5vw; border-radius: 1vw 1vw 0 0; position: relative; }
.band--red { background: var(--kiosk-red); }
.band--blue, .band--all { background: var(--kiosk-blue); }
.band__label { margin: 0 0 0.6vw; font-size: 1.3vw; font-weight: 800; text-transform: uppercase; }
.band__score { position: absolute; top: -9vw; left: 0; right: 0; margin: 0; font-size: 8vw; font-weight: 900; text-align: center; }
.band__teams { margin: 0; padding: 0; list-style: none; display: grid; gap: 0.8vw; }
.band__team { display: grid; grid-template-columns: auto auto 1fr; grid-template-rows: auto auto; column-gap: 0.8vw; align-items: baseline; }
.band__rank { grid-row: span 2; padding: 0 0.4vw; background: var(--kiosk-band); color: var(--kiosk-ink-on-band); font-size: 1.4vw; font-weight: 800; }
.band__number { font-size: 2.6vw; font-weight: 900; }
.band__name { font-size: 2vw; font-weight: 700; text-transform: uppercase; }
.band__place { grid-column: 2 / span 2; font-size: 1.1vw; text-transform: uppercase; opacity: 0.85; }
.intro .start { margin: auto; }

.result .screen__body { gap: 1vw; }
.breakdown { align-self: center; border-collapse: collapse; font-size: 1.6vw; margin-bottom: 11vw; }
.breakdown th { text-align: left; font-weight: 600; padding: 0.3vw 3vw 0.3vw 0; }
.breakdown td { padding: 0.3vw 1.5vw; text-align: center; font-weight: 800; }
.breakdown tr + tr { border-top: 1px solid rgb(255 255 255 / 0.2); }
.breakdown__value--red { color: #ff8e86; }
.breakdown__value--blue { color: #8db8ff; }
```

Add to the `"display"` object in `en/device.json`:

```json
    "alliance": { "red": "Red alliance", "blue": "Blue alliance", "all": "Alliance" },
    "breakdown": "Score breakdown",
    "noMoreMatches": "No more matches here",
    "nothingScored": "No match has been scored yet"
```

and in `zh/device.json`:

```json
    "alliance": { "red": "红方联盟", "blue": "蓝方联盟", "all": "联盟" },
    "breakdown": "得分明细",
    "noMoreMatches": "这里没有更多比赛",
    "nothingScored": "还没有比赛计分"
```

- [ ] **Step 6: Run the tests and type check**

Run: `cd frontend/apps/device && npx vitest run && npx tsc -b`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/device/src frontend/apps/device/tests
git commit -m "Add the audience's Match Intro and Last Scored Match screens: alliance bands with each team's rank, number, name and location (one band for a cooperative game), the time to start or Up next, and each alliance's score with a breakdown built from the game's scoresheet.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Scrolling, and the list screens (Teamwork Rankings, Upcoming Matches, Match Results, Schedule)

**Files:**
- Create: `frontend/apps/device/src/display/useAutoScroll.ts`
- Create: `frontend/apps/device/src/display/logic/records.ts`
- Create: `frontend/apps/device/src/display/components/ScrollingList.tsx`, `MatchCells.tsx`, `MatchSchedulePanel.tsx`
- Create: `frontend/apps/device/src/display/screens/teamworkRankings.tsx`, `upcomingMatches.tsx`, `matchResults.tsx`, `schedule.tsx`
- Modify: `frontend/apps/device/src/display/screens/registry.ts`, `display.css`, both `device.json` files
- Test: `frontend/apps/device/tests/unit/autoScroll.test.tsx`, `frontend/apps/device/tests/unit/listScreens.test.tsx`

**Interfaces:**
- Consumes: Task 6 `scoredMatches`, `upcomingMatches`, `sortMatches`, `onFields`, `inDivision`, `formatTime`; Task 7 hooks (`useMergedRankings`, `useSoleDivisionId`, `useSessionTimeZone`), `ScreenFrame`; Task 8 `fieldIdsOf`, `allianceGroups`.
- Produces: `SCROLL_PX_PER_SECOND = 40`, `EDGE_PAUSE_MS = 3000`, `useAutoScroll(ref, {onDone?, fitSeconds?})`; `teamRecords(matches, scores) -> Map<teamId, {wins, losses, ties}>`; `ScrollingList({onDone?, fitSeconds?, children})`; `TeamNumbers({teamIds, teams, station})`, `scoreText(match, scores, gameModel) -> string`; `MatchSchedulePanel({sessionId, keep})`; `useDivisionFilter(context) -> (row) => boolean`; the `teamwork_rankings`, `upcoming_matches`, `match_results` and `schedule` modules.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/device/tests/unit/autoScroll.test.tsx`:

```tsx
import { useRef } from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EDGE_PAUSE_MS, SCROLL_PX_PER_SECOND, useAutoScroll } from "../../src/display/useAutoScroll";

function Harness({ contentHeight, onDone, fitSeconds }: { contentHeight: number; onDone: () => void; fitSeconds?: number }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useAutoScroll(ref, { onDone, fitSeconds });
  return (
    <div
      ref={(element) => {
        if (element) {
          Object.defineProperty(element, "scrollHeight", { configurable: true, value: contentHeight });
          Object.defineProperty(element, "clientHeight", { configurable: true, value: 100 });
        }
        ref.current = element;
      }}
    />
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useAutoScroll", () => {
  it("reports done once it has paused at the top, scrolled to the bottom and paused there", async () => {
    const onDone = vi.fn();
    render(<Harness contentHeight={500} onDone={onDone} />);
    const scrollMs = (400 / SCROLL_PX_PER_SECOND) * 1000;
    await act(() => vi.advanceTimersByTimeAsync(EDGE_PAUSE_MS + scrollMs + EDGE_PAUSE_MS - 500));
    expect(onDone).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(onDone).toHaveBeenCalledTimes(1);
    // It loops, but only reports once.
    await act(() => vi.advanceTimersByTimeAsync(EDGE_PAUSE_MS * 2 + scrollMs + 1_000));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a list that fits reports done after fitSeconds instead", async () => {
    const onDone = vi.fn();
    render(<Harness contentHeight={80} onDone={onDone} fitSeconds={5} />);
    await act(() => vi.advanceTimersByTimeAsync(4_900));
    expect(onDone).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(200));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
```

Create `frontend/apps/device/tests/unit/listScreens.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamRecords } from "../../src/display/logic/records";
import { COOPERATIVE, audienceGroup, baseRoutes, match, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const ranking = (team_id: number, rank: number, extra = {}) => ({
  team_id, rank, division_id: null, win_points: 6 - rank, strength_of_schedule: 1.5, average_score: 40 - rank, matches_played: 2, ...extra,
});
const scoreRow = (match_id: number, alliance_id: number, score: number, saved = iso(-1_000)) => ({
  match_id, alliance_id, score, data: {}, teams: [], saved_at: saved,
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("teamRecords", () => {
  it("counts wins, losses and ties from fully scored qualification matches", () => {
    const won = match({ id: 1, status: "completed" });
    const tied = match({ id: 2, status: "completed" });
    const practice = match({ id: 3, status: "completed", round_type: "practice" });
    const scores = [scoreRow(1, 11, 9), scoreRow(1, 12, 3), scoreRow(2, 21, 4), scoreRow(2, 22, 4), scoreRow(3, 31, 9), scoreRow(3, 32, 0)];
    const records = teamRecords([won, tied, practice], scores);
    expect(records.get(1)).toEqual({ wins: 1, losses: 0, ties: 1 });
    expect(records.get(3)).toEqual({ wins: 0, losses: 1, ties: 1 });
  });
});

describe("Teamwork Rankings", () => {
  it("lists the head-to-head columns and the schedule and results panel", async () => {
    const done = match({ id: 1, label: "Q1", status: "completed", phase: "ended", scheduled_time: iso(-600_000) });
    const next = match({ id: 2, label: "Q2", field_id: 2, scheduled_time: iso(300_000) });
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "teamwork_rankings" })),
      "/api/rankings?session_id=1": [ranking(3, 1), ranking(1, 2)],
      "/api/matches?session_id=1": [done, next],
      "/api/scores?session_id=1": [scoreRow(1, 11, 3), scoreRow(1, 12, 9)],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Teamwork Rankings" });
    const rows = within(table).getAllByRole("row");
    expect(rows[0]).toHaveTextContent(/Rank.*Team.*WP.*SoS.*W-L-T/);
    expect(rows[1]).toHaveTextContent(/1.*103C.*Bolts.*5.*1\.5.*1-0-0/);
    expect(rows[2]).toHaveTextContent(/2.*101A.*Rockets.*4.*0-1-0/);
    const panel = screen.getByRole("complementary", { name: "Match schedule & results" });
    expect(within(panel).getByText("Q1").closest("tr")).toHaveTextContent("3–9");
    expect(within(panel).getByText("Q2").closest("tr")).toHaveTextContent(/Field 2.*4:05/);
  });

  it("shows matches and average score for a cooperative game, and says when nothing is ranked", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/event/match-format": COOPERATIVE,
      "/api/displays/me": me(pitGroup({ screen: "teamwork_rankings" })),
      "/api/rankings?session_id=1": [ranking(2, 1)],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Teamwork Rankings" });
    expect(within(table).getAllByRole("row")[0]).toHaveTextContent(/Rank.*Team.*Matches.*Average/);
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(/1.*102B.*2.*39/);
  });

  it("says when nothing is ranked yet", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(pitGroup({ screen: "teamwork_rankings" })) });
    renderDisplay();
    expect(await screen.findByText("No rankings yet")).toBeInTheDocument();
  });
});

describe("match lists", () => {
  const matches = [
    match({ id: 1, label: "Q1", status: "completed", phase: "ended", scheduled_time: iso(-600_000) }),
    match({ id: 2, label: "Q2", status: "completed", phase: "ended", scheduled_time: iso(-300_000) }),
    match({ id: 3, label: "Q3", scheduled_time: iso(300_000) }),
    match({ id: 4, label: "Q4", field_id: 2, scheduled_time: iso(600_000) }),
    match({ id: 5, label: "Q5", field_id: 9, scheduled_time: iso(900_000) }),
  ];
  const scores = [scoreRow(1, 11, 5, iso(-500_000)), scoreRow(1, 12, 2, iso(-500_000)), scoreRow(2, 21, 1, iso(-100_000)), scoreRow(2, 22, 8, iso(-100_000))];

  it("Upcoming Matches shows the next few on the audience's field group", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "upcoming_matches", screen_settings: { count: 1, scope: "field_set" } })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Upcoming Matches" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Q3")).toBeInTheDocument();
  });

  it("Upcoming Matches by division includes other field groups' matches", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "upcoming_matches", screen_settings: { count: 3, scope: "division" } })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Upcoming Matches" });
    expect(within(table).getAllByRole("row").slice(1).map((r) => r.textContent?.slice(0, 2))).toEqual(["Q3", "Q4", "Q5"]);
  });

  it("Match Results lists scored matches newest first with both scores", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "match_results" })),
      "/api/matches?session_id=1": matches,
      "/api/scores?session_id=1": scores,
    });
    renderDisplay();
    const rows = within(await screen.findByRole("table", { name: "Match Results" })).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent(/Q2.*1.*8/);
    expect(rows[1]).toHaveTextContent(/Q1.*5.*2/);
  });

  it("Schedule lists every match in order with field and time", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "schedule" })),
      "/api/matches?session_id=1": matches,
    });
    renderDisplay();
    const rows = within(await screen.findByRole("table", { name: "Match Schedule" })).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent?.slice(0, 2))).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5"]);
    expect(rows[0]).toHaveClass("is-done");
    expect(rows[3]).toHaveTextContent(/Field 2.*4:10/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/device && npx vitest run tests/unit/autoScroll.test.tsx tests/unit/listScreens.test.tsx`
Expected: FAIL (missing modules).

- [ ] **Step 3: Write the scroll hook and its wrapper**

Create `frontend/apps/device/src/display/useAutoScroll.ts`:

```ts
import { useEffect, useRef, type RefObject } from "react";

/** Reading speed for a scrolling list, in pixels per second. */
export const SCROLL_PX_PER_SECOND = 40;
/** How long a list rests at its top and at its bottom. */
export const EDGE_PAUSE_MS = 3_000;
const TICK_MS = 50;

/** Scrolls a long list slowly and endlessly, pausing at the top and bottom.
 * Calls `onDone` once: after the first full pass, or, when the list already
 * fits, after `fitSeconds` (so a rotation still moves on). */
export function useAutoScroll(
  ref: RefObject<HTMLElement | null>,
  { onDone, fitSeconds = 20 }: { onDone?: () => void; fitSeconds?: number }
): void {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => {
    let position = 0;
    let stage: "top" | "scrolling" | "bottom" = "top";
    let waited = 0;
    let fitWaited = 0;
    let reported = false;
    const report = () => {
      if (!reported) {
        reported = true;
        onDoneRef.current?.();
      }
    };
    const id = setInterval(() => {
      const element = ref.current;
      if (!element) return;
      const max = element.scrollHeight - element.clientHeight;
      if (max <= 1) {
        fitWaited += TICK_MS;
        if (fitWaited >= fitSeconds * 1000) report();
        return;
      }
      if (stage === "scrolling") {
        position = Math.min(max, position + (SCROLL_PX_PER_SECOND * TICK_MS) / 1000);
        element.scrollTop = position;
        if (position >= max) stage = "bottom";
        return;
      }
      waited += TICK_MS;
      if (waited < EDGE_PAUSE_MS) return;
      waited = 0;
      if (stage === "top") {
        stage = "scrolling";
      } else {
        report();
        position = 0;
        element.scrollTop = 0;
        stage = "top";
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [ref, fitSeconds]);
}
```

Create `frontend/apps/device/src/display/components/ScrollingList.tsx`:

```tsx
import { useRef, type ReactNode } from "react";
import { useAutoScroll } from "../useAutoScroll";

export function ScrollingList({
  onDone,
  fitSeconds,
  children,
}: {
  onDone?: () => void;
  fitSeconds?: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useAutoScroll(ref, { onDone, fitSeconds });
  return (
    <div className="scroll-area" ref={ref}>
      {children}
    </div>
  );
}
```

- [ ] **Step 4: Write the records rule and the shared match cells**

Create `frontend/apps/device/src/display/logic/records.ts`:

```ts
import type { AllianceScore, LiveMatch } from "@tournament-admin/shared";

export interface WinLossTie {
  wins: number;
  losses: number;
  ties: number;
}

/** Each team's win-loss-tie record over fully scored two-alliance qualification matches. */
export function teamRecords(matches: LiveMatch[], scores: AllianceScore[]): Map<number, WinLossTie> {
  const byAlliance = new Map(scores.map((row) => [row.alliance_id, row.score]));
  const records = new Map<number, WinLossTie>();
  for (const match of matches) {
    if (match.round_type !== "qualification" || match.status !== "completed" || match.alliances.length !== 2) continue;
    const [first, second] = match.alliances;
    const a = byAlliance.get(first.id);
    const b = byAlliance.get(second.id);
    if (a === undefined || b === undefined) continue;
    for (const [alliance, own, other] of [
      [first, a, b],
      [second, b, a],
    ] as const) {
      for (const teamId of alliance.team_ids) {
        const record = records.get(teamId) ?? { wins: 0, losses: 0, ties: 0 };
        if (own > other) record.wins += 1;
        else if (own < other) record.losses += 1;
        else record.ties += 1;
        records.set(teamId, record);
      }
    }
  }
  return records;
}
```

Create `frontend/apps/device/src/display/components/MatchCells.tsx`:

```tsx
import type { AllianceScore, LiveMatch } from "@tournament-admin/shared";
import type { GameModel, Team } from "../api";
import { allianceGroups, type BandStation } from "../logic/alliances";

export function TeamNumbers({ teamIds, teams, station }: { teamIds: number[]; teams: Map<number, Team>; station: BandStation }) {
  return (
    <span className={`team-numbers team-numbers--${station}`}>
      {teamIds.map((id) => (
        <span key={id}>{teams.get(id)?.number ?? ""}</span>
      ))}
    </span>
  );
}

/** "9–3" for a head-to-head match, the shared score for a cooperative one. */
export function scoreText(match: LiveMatch, scores: AllianceScore[], gameModel: GameModel): string {
  const byAlliance = new Map(scores.filter((s) => s.match_id === match.id).map((s) => [s.alliance_id, s.score]));
  const totals = allianceGroups(match, gameModel).map((group) => {
    const values = group.allianceIds.map((id) => byAlliance.get(id)).filter((v): v is number => v !== undefined);
    return values.length ? String(Math.max(...values)) : "–";
  });
  return totals.join("–");
}
```

Create `frontend/apps/device/src/display/components/MatchSchedulePanel.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { formatTime, scoredMatches, upcomingMatches, type LiveMatch } from "@tournament-admin/shared";
import { useFields, useMatchFormat, useMatches, useScores, useSessionTimeZone, useTeamsById } from "../api";
import { allianceGroups } from "../logic/alliances";
import { TeamNumbers, scoreText } from "./MatchCells";

const RECENT = 5;
const NEXT = 5;

/** The side panel: the latest scored matches, then the next ones with field and time. */
export function MatchSchedulePanel({ sessionId, keep }: { sessionId: number; keep: (match: LiveMatch) => boolean }) {
  const { t, i18n } = useTranslation();
  const matches = useMatches(sessionId);
  const scores = useScores(sessionId);
  const fields = useFields(sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const timeZone = useSessionTimeZone(sessionId);
  if (!matches.data || !scores.data || !fields.data || !format.data || !teams) return null;
  const recent = scoredMatches(matches.data, scores.data, keep).slice(0, RECENT).reverse();
  const next = upcomingMatches(matches.data, keep, NEXT);
  const gameModel = format.data.game_model;
  const fieldName = (id: number | null) => fields.data?.find((f) => f.id === id)?.name ?? "";
  const row = (match: LiveMatch, done: boolean) => (
    <tr key={match.id} className={done ? "is-done" : undefined}>
      <th scope="row">{match.label}</th>
      {allianceGroups(match, gameModel).map((group) => (
        <td key={group.station}>
          <TeamNumbers teamIds={group.teamIds} teams={teams} station={group.station} />
        </td>
      ))}
      <td className="side-panel__end">
        {done ? (
          scoreText(match, scores.data!, gameModel)
        ) : (
          <>
            {fieldName(match.field_id)} {match.scheduled_time ? formatTime(match.scheduled_time, timeZone, i18n.language) : ""}
          </>
        )}
      </td>
    </tr>
  );
  return (
    <aside className="side-panel" aria-label={t("display.schedulePanel")}>
      <h2 className="side-panel__title">{t("display.schedulePanel")}</h2>
      <table className="kiosk-table kiosk-table--compact">
        <tbody>
          {recent.map((m) => row(m, true))}
          {next.map((m) => row(m, false))}
        </tbody>
      </table>
    </aside>
  );
}
```

- [ ] **Step 5: Write the division filter and the four screens**

Append to `frontend/apps/device/src/display/api.ts`:

```ts
/** The match filter for a screen's division (see the shared inDivision rule). */
export function useDivisionFilter(divisionId: number | null): (row: { division_id: number | null }) => boolean {
  const sole = useSoleDivisionId();
  return inDivision(divisionId, sole);
}
```

(add `inDivision` to the `@tournament-admin/shared` import at the top of `api.ts`).

Create `frontend/apps/device/src/display/screens/teamworkRankings.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { useMatchFormat, useMatches, useMergedRankings, useScores, useTeamsById, useDivisionFilter } from "../api";
import { MatchSchedulePanel } from "../components/MatchSchedulePanel";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { teamRecords } from "../logic/records";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function TeamworkRankingsScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t } = useTranslation();
  const rankings = useMergedRankings(context.sessionId, context.divisionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.screens.teamwork_rankings");
  if (!rankings || !format.data || !teams || !matches.data || !scores.data) return <WaitingForData title={title} />;
  if (rankings.length === 0) return <ScreenNotice title={title} text={t("display.noRankings")} />;
  const cooperative = format.data.game_model === "cooperative_score";
  const records = teamRecords(matches.data.filter(keep), scores.data);
  return (
    <ScreenFrame title={title} className="rankings">
      <div className="split">
        <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
          <table className="kiosk-table" aria-label={title}>
            <thead>
              <tr>
                <th scope="col">{t("display.col.rank")}</th>
                <th scope="col">{t("display.col.team")}</th>
                {cooperative ? (
                  <>
                    <th scope="col">{t("display.col.matches")}</th>
                    <th scope="col">{t("display.col.average")}</th>
                  </>
                ) : (
                  <>
                    <th scope="col">{t("display.col.winPoints")}</th>
                    <th scope="col">{t("display.col.sos")}</th>
                    <th scope="col">{t("display.col.record")}</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rankings.map((row) => {
                const team = teams.get(row.team_id);
                const record = records.get(row.team_id) ?? { wins: 0, losses: 0, ties: 0 };
                return (
                  <tr key={row.team_id}>
                    <td className="kiosk-table__rank">{row.rank}</td>
                    <td>
                      <span className="kiosk-table__number">{team?.number ?? ""}</span> {team?.name ?? ""}
                    </td>
                    {cooperative ? (
                      <>
                        <td>{row.matches_played}</td>
                        <td>{Math.round(row.average_score * 10) / 10}</td>
                      </>
                    ) : (
                      <>
                        <td>{row.win_points}</td>
                        <td>{row.strength_of_schedule}</td>
                        <td>{`${record.wins}-${record.losses}-${record.ties}`}</td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollingList>
        <MatchSchedulePanel sessionId={context.sessionId} keep={keep} />
      </div>
    </ScreenFrame>
  );
}

export const teamworkRankingsScreen: ScreenModule = {
  key: "teamwork_rankings",
  scrolls: true,
  Component: TeamworkRankingsScreen,
};
```

Create `frontend/apps/device/src/display/screens/upcomingMatches.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { UPCOMING_COUNT, formatTime, onFields, upcomingMatches } from "@tournament-admin/shared";
import { useDivisionFilter, useFields, useMatchFormat, useMatches, useSessionTimeZone, useTeamsById } from "../api";
import { TeamNumbers } from "../components/MatchCells";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { allianceGroups } from "../logic/alliances";
import type { ScreenModule, ScreenProps } from "../screenTypes";
import { fieldIdsOf } from "./inMatch";

function UpcomingMatchesScreen({ context }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const timeZone = useSessionTimeZone(context.sessionId);
  const inDivision = useDivisionFilter(context.divisionId);
  const title = t("display.screens.upcoming_matches");
  if (!matches.data || !fields.data || !format.data || !teams) return <WaitingForData title={title} />;
  const byFieldSet = context.settings.scope === "field_set" && context.fieldSetId !== null;
  const keep = byFieldSet ? onFields(fieldIdsOf(fields.data, context.fieldSetId)) : inDivision;
  const rows = upcomingMatches(matches.data, keep, context.settings.count ?? UPCOMING_COUNT.default);
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.noMoreMatches")} />;
  const fieldName = (id: number | null) => fields.data?.find((f) => f.id === id)?.name ?? "";
  return (
    <ScreenFrame title={title}>
      <table className="kiosk-table kiosk-table--large" aria-label={title}>
        <thead>
          <tr>
            <th scope="col">{t("display.col.match")}</th>
            <th scope="col">{t("display.col.teams")}</th>
            <th scope="col">{t("display.col.field")}</th>
            <th scope="col">{t("display.col.time")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((match) => (
            <tr key={match.id}>
              <th scope="row">{match.label}</th>
              <td>
                {allianceGroups(match, format.data!.game_model).map((group) => (
                  <TeamNumbers key={group.station} teamIds={group.teamIds} teams={teams} station={group.station} />
                ))}
              </td>
              <td>{fieldName(match.field_id)}</td>
              <td>{match.scheduled_time ? formatTime(match.scheduled_time, timeZone, i18n.language) : t("display.upNext")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScreenFrame>
  );
}

export const upcomingMatchesScreen: ScreenModule = {
  key: "upcoming_matches",
  scrolls: false,
  Component: UpcomingMatchesScreen,
};
```

Create `frontend/apps/device/src/display/screens/matchResults.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { scoredMatches } from "@tournament-admin/shared";
import { useDivisionFilter, useMatchFormat, useMatches, useScores, useTeamsById } from "../api";
import { TeamNumbers } from "../components/MatchCells";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { allianceGroups } from "../logic/alliances";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function MatchResultsScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t } = useTranslation();
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.screens.match_results");
  if (!matches.data || !scores.data || !format.data || !teams) return <WaitingForData title={title} />;
  const rows = scoredMatches(matches.data, scores.data, keep);
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.nothingScored")} />;
  const byAlliance = new Map(scores.data.map((s) => [s.alliance_id, s.score]));
  return (
    <ScreenFrame title={title}>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <table className="kiosk-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.match")}</th>
              <th scope="col">{t("display.col.teams")}</th>
              <th scope="col">{t("display.col.score")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((match) => (
              <tr key={match.id}>
                <th scope="row">{match.label}</th>
                <td>
                  {allianceGroups(match, format.data!.game_model).map((group) => (
                    <TeamNumbers key={group.station} teamIds={group.teamIds} teams={teams} station={group.station} />
                  ))}
                </td>
                <td className="kiosk-table__scores">
                  {allianceGroups(match, format.data!.game_model).map((group) => {
                    const values = group.allianceIds.map((id) => byAlliance.get(id)).filter((v): v is number => v !== undefined);
                    return (
                      <span key={group.station} className={`score score--${group.station}`}>
                        {values.length ? Math.max(...values) : "–"}
                      </span>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const matchResultsScreen: ScreenModule = { key: "match_results", scrolls: true, Component: MatchResultsScreen };
```

Create `frontend/apps/device/src/display/screens/schedule.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { formatTime, sortMatches } from "@tournament-admin/shared";
import { useDivisionFilter, useFields, useMatchFormat, useMatches, useSessionTimeZone, useTeamsById } from "../api";
import { TeamNumbers } from "../components/MatchCells";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import { allianceGroups } from "../logic/alliances";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function ScheduleScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const matches = useMatches(context.sessionId);
  const fields = useFields(context.sessionId);
  const format = useMatchFormat();
  const teams = useTeamsById();
  const timeZone = useSessionTimeZone(context.sessionId);
  const keep = useDivisionFilter(context.divisionId);
  const title = t("display.screens.schedule");
  if (!matches.data || !fields.data || !format.data || !teams) return <WaitingForData title={title} />;
  const rows = sortMatches(matches.data.filter((m) => keep(m) && m.status !== "not_played"));
  if (rows.length === 0) return <ScreenNotice title={title} text={t("display.noMoreMatches")} />;
  const fieldName = (id: number | null) => fields.data?.find((f) => f.id === id)?.name ?? "";
  return (
    <ScreenFrame title={title}>
      <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
        <table className="kiosk-table" aria-label={title}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.match")}</th>
              <th scope="col">{t("display.col.teams")}</th>
              <th scope="col">{t("display.col.field")}</th>
              <th scope="col">{t("display.col.time")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((match) => (
              <tr key={match.id} className={match.status === "completed" ? "is-done" : undefined}>
                <th scope="row">{match.label}</th>
                <td>
                  {allianceGroups(match, format.data!.game_model).map((group) => (
                    <TeamNumbers key={group.station} teamIds={group.teamIds} teams={teams} station={group.station} />
                  ))}
                </td>
                <td>{fieldName(match.field_id)}</td>
                <td>{match.scheduled_time ? formatTime(match.scheduled_time, timeZone, i18n.language) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollingList>
    </ScreenFrame>
  );
}

export const scheduleScreen: ScreenModule = { key: "schedule", scrolls: true, Component: ScheduleScreen };
```

Register the four modules in `screens/registry.ts`.

- [ ] **Step 6: Styles and strings**

Append to `display.css`:

```css
.split { flex: 1; min-height: 0; display: grid; grid-template-columns: 2fr 1fr; gap: 1.5vw; }
.scroll-area { flex: 1; min-height: 0; overflow: hidden; }
.kiosk-table { width: 100%; border-collapse: collapse; background: var(--kiosk-band); color: var(--kiosk-ink-on-band); font-size: 1.7vw; }
.kiosk-table thead th { position: sticky; top: 0; background: var(--kiosk-bg); color: var(--kiosk-ink); text-align: left; font-size: 1.1vw; text-transform: uppercase; padding: 0.4vw 0.8vw; }
.kiosk-table td, .kiosk-table tbody th { padding: 0.5vw 0.8vw; text-align: left; }
.kiosk-table tbody tr:nth-child(even) { background: var(--kiosk-band-alt); }
.kiosk-table--large { font-size: 2.6vw; }
.kiosk-table--compact { font-size: 1.4vw; }
.kiosk-table__rank { font-weight: 900; }
.kiosk-table__number { font-weight: 900; }
.kiosk-table .is-done { opacity: 0.55; }
.team-numbers { display: inline-flex; gap: 0.8vw; margin-right: 1.2vw; font-weight: 800; }
.team-numbers--red { color: var(--kiosk-red); }
.team-numbers--blue, .team-numbers--all { color: var(--kiosk-blue); }
.score { display: inline-block; min-width: 3vw; font-weight: 900; }
.score--red { color: var(--kiosk-red); }
.score--blue, .score--all { color: var(--kiosk-blue); }
.side-panel { min-height: 0; overflow: hidden; }
.side-panel__title { margin: 0 0 0.4vw; font-size: 1.2vw; text-transform: uppercase; }
.side-panel__end { text-align: right; font-weight: 800; white-space: nowrap; }
```

Add to the `"display"` object in `en/device.json`:

```json
    "noRankings": "No rankings yet",
    "schedulePanel": "Match schedule & results",
    "col": {
      "rank": "Rank", "team": "Team", "winPoints": "WP", "sos": "SoS", "record": "W-L-T",
      "matches": "Matches", "average": "Average", "match": "Match", "teams": "Teams",
      "field": "Field", "time": "Time", "score": "Score", "total": "Total"
    }
```

and in `zh/device.json`:

```json
    "noRankings": "暂无排名",
    "schedulePanel": "比赛日程与结果",
    "col": {
      "rank": "排名", "team": "队伍", "winPoints": "胜点", "sos": "对手强度", "record": "胜-负-平",
      "matches": "场数", "average": "平均分", "match": "比赛", "teams": "队伍",
      "field": "场地", "time": "时间", "score": "得分", "total": "总分"
    }
```

- [ ] **Step 7: Run the tests and type check**

Run: `cd frontend/apps/device && npx vitest run && npx tsc -b`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/device/src frontend/apps/device/tests
git commit -m "Add the list screens: Teamwork Rankings with the game's columns and a schedule and results panel, Upcoming Matches by field group or division, Match Results newest first, and the Schedule, with long lists scrolling slowly on the device and reporting when they have been shown in full.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Skills Rankings and Elimination Brackets

**Files:**
- Create: `frontend/apps/device/src/display/logic/bracket.ts`
- Create: `frontend/apps/device/src/display/screens/skillsRankings.tsx`, `eliminationBracket.tsx`
- Modify: `frontend/apps/device/src/display/api.ts` (`useNewestFinals`), `screens/registry.ts`, `display.css`, both `device.json` files
- Test: `frontend/apps/device/tests/unit/skillsAndBracket.test.tsx`

**Interfaces:**
- Consumes: Task 5's `GET /api/finals` and `bracket_matchup_id`; Task 7 hooks; Task 10 `ScrollingList`, `MatchSchedulePanel`, `TeamNumbers`.
- Produces: `seriesWins(bracket, matches, scores) -> Map<matchupId, {a: number, b: number}>`, `roundName(t, roundNumber, roundCount) -> string`; `useNewestFinals(sessionId, divisionId) -> FinalsBracket | null | undefined`; the `skills_rankings` and `elimination_bracket` modules.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/device/tests/unit/skillsAndBracket.test.tsx`:

```tsx
import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FinalsBracket } from "../../src/display/api";
import { seriesWins } from "../../src/display/logic/bracket";
import { baseRoutes, match, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const NOW = new Date("2026-11-07T16:00:00Z").getTime();
const iso = (ms: number) => new Date(NOW + ms).toISOString();

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SKILLS = {
  enabled: true,
  attempts: { autonomous: 3, driver: 3 },
  types: [{ key: "autonomous", label: "Autonomous" }, { key: "driver", label: "Driver" }],
};

describe("Skills Rankings", () => {
  it("lists totals and each type's best and attempts used, with top 10 and recent scores", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "skills_rankings" })),
      "/api/skills/settings": SKILLS,
      "/api/skills/rankings?tab=overall&session_id=1": [
        { rank: 1, team_id: 2, score: 197, attempts: [90, 107] },
        { rank: 2, team_id: 1, score: 50, attempts: [50, 0] },
      ],
      "/api/skills/rankings?tab=autonomous&session_id=1": [
        { rank: 1, team_id: 2, score: 90, attempts: [90, 40] },
        { rank: 2, team_id: 1, score: 50, attempts: [50] },
      ],
      "/api/skills/rankings?tab=driver&session_id=1": [{ rank: 1, team_id: 2, score: 107, attempts: [107] }],
      "/api/sessions/1/skills/attempts": [
        { id: 1, team_id: 2, skills_type: "autonomous", score: 40, recorded_at: iso(-300_000) },
        { id: 2, team_id: 2, skills_type: "autonomous", score: 90, recorded_at: iso(-200_000) },
        { id: 3, team_id: 2, skills_type: "driver", score: 107, recorded_at: iso(-100_000) },
        { id: 4, team_id: 1, skills_type: "autonomous", score: 50, recorded_at: iso(-50_000) },
      ],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Skills Rankings" });
    const rows = within(table).getAllByRole("row");
    expect(rows[0]).toHaveTextContent(/Rank.*Team.*Total.*Autonomous.*Driver/);
    expect(rows[1]).toHaveTextContent(/1.*102B.*Gears.*197.*90 \/ 2.*107 \/ 1/);
    expect(rows[2]).toHaveTextContent(/2.*101A.*50.*50 \/ 1.*0 \/ 0/);
    const top = screen.getByRole("complementary", { name: "Top 10" });
    expect(within(top).getAllByRole("row")[0]).toHaveTextContent(/1.*102B.*197.*90 \/ 107/);
    const recent = within(screen.getByRole("complementary", { name: "Recent scores" })).getAllByRole("row");
    expect(recent[0]).toHaveTextContent(/101A.*Autonomous.*50/);
    expect(recent[1]).toHaveTextContent(/102B.*Driver.*107/);
  });

  it("says so when skills challenges are off", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "skills_rankings" })),
      "/api/skills/settings": { ...SKILLS, enabled: false },
    });
    renderDisplay();
    expect(await screen.findByText("Skills challenges aren't running")).toBeInTheDocument();
  });
});

const ALLIANCES = [
  { id: 1, seed: 1, team_ids: [1], unavailable: false },
  { id: 2, seed: 2, team_ids: [2], unavailable: false },
  { id: 3, seed: 3, team_ids: [3], unavailable: false },
  { id: 4, seed: 4, team_ids: [4], unavailable: false },
];

function bracket(overrides: Partial<FinalsBracket>): FinalsBracket {
  return {
    id: 1, session_id: 1, division_id: null, field_set_id: 10, format: "single_elimination", bracket_size: 4,
    status: "in_progress", alliances: ALLIANCES, runs: [], results: [], matchups: [], ...overrides,
  };
}

describe("seriesWins", () => {
  it("counts each bracket alliance's game wins by matching its teams to a game's alliances", () => {
    const finals = bracket({
      matchups: [{ id: 7, round_number: 1, position: 0, matchup_number: 1, alliance_a_id: 1, alliance_b_id: 4, winner_alliance_id: null }],
    });
    const games = [
      match({ id: 1, is_finals: true, bracket_matchup_id: 7, status: "completed", alliances: [{ id: 11, station: "red", team_ids: [4] }, { id: 12, station: "blue", team_ids: [1] }] }),
      match({ id: 2, is_finals: true, bracket_matchup_id: 7, status: "completed", alliances: [{ id: 21, station: "red", team_ids: [1] }, { id: 22, station: "blue", team_ids: [4] }] }),
      match({ id: 3, is_finals: true, bracket_matchup_id: 7, alliances: [{ id: 31, station: "red", team_ids: [1] }, { id: 32, station: "blue", team_ids: [4] }] }),
    ];
    const scores = [
      { match_id: 1, alliance_id: 11, score: 9, data: {}, teams: [], saved_at: iso(0) },
      { match_id: 1, alliance_id: 12, score: 3, data: {}, teams: [], saved_at: iso(0) },
      { match_id: 2, alliance_id: 21, score: 8, data: {}, teams: [], saved_at: iso(0) },
      { match_id: 2, alliance_id: 22, score: 2, data: {}, teams: [], saved_at: iso(0) },
    ];
    expect(seriesWins(finals, games, scores).get(7)).toEqual({ a: 1, b: 1 });
  });
});

describe("Elimination Brackets", () => {
  it("draws a single-elimination tree with round names and winners", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "elimination_bracket" })),
      "/api/finals?session_id=1": [
        bracket({
          matchups: [
            { id: 1, round_number: 1, position: 0, matchup_number: 1, alliance_a_id: 1, alliance_b_id: 4, winner_alliance_id: 1 },
            { id: 2, round_number: 1, position: 1, matchup_number: 2, alliance_a_id: 2, alliance_b_id: 3, winner_alliance_id: null },
            { id: 3, round_number: 2, position: 0, matchup_number: 3, alliance_a_id: 1, alliance_b_id: null, winner_alliance_id: null },
          ],
        }),
      ],
    });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Semifinals" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Final" })).toBeInTheDocument();
    const first = screen.getByTestId("matchup-1");
    expect(within(first).getByTestId("side-1")).toHaveClass("is-winner");
    expect(within(first).getByTestId("side-1")).toHaveTextContent("101A");
  });

  it("shows score-chase finals rankings with the runs panel", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(pitGroup({ screen: "elimination_bracket" })),
      "/api/matches?session_id=1": [
        match({ id: 61, label: "F1", is_finals: true, status: "completed", phase: "ended", field_id: 1 }),
        match({ id: 62, label: "F2", is_finals: true, field_id: 1 }),
      ],
      "/api/finals?session_id=1": [
        bracket({
          format: "score_chase",
          alliances: [{ id: 1, seed: 1, team_ids: [1, 2], unavailable: false }, { id: 2, seed: 2, team_ids: [3, 4], unavailable: false }],
          runs: [
            { match_id: 61, bracket_alliance_id: 2, status: "completed", score: 84 },
            { match_id: 62, bracket_alliance_id: 1, status: "scheduled", score: null },
          ],
          results: [{ bracket_alliance_id: 2, score: 84, rank: 1 }],
        }),
      ],
    });
    renderDisplay();
    const table = await screen.findByRole("table", { name: "Finals rankings" });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(/1.*103C.*104D.*1.*84/);
    const runs = screen.getByRole("complementary", { name: "Match schedule & results" });
    expect(within(runs).getByText("F2").closest("tr")).toHaveClass("is-current");
  });

  it("says when there are no eliminations yet", async () => {
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(pitGroup({ screen: "elimination_bracket" })), "/api/finals?session_id=1": [] });
    renderDisplay();
    expect(await screen.findByText("No eliminations yet")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/device && npx vitest run tests/unit/skillsAndBracket.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the bracket rules and the finals hook**

Create `frontend/apps/device/src/display/logic/bracket.ts`:

```ts
import type { TFunction } from "i18next";
import type { AllianceScore, LiveMatch } from "@tournament-admin/shared";
import type { FinalsBracket } from "../api";

function sameTeams(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** Each matchup's game wins so far: a game's alliance belongs to the bracket
 * alliance with the same teams; a tie counts for neither. */
export function seriesWins(
  bracket: FinalsBracket,
  matches: LiveMatch[],
  scores: AllianceScore[]
): Map<number, { a: number; b: number }> {
  const teamsOf = new Map(bracket.alliances.map((alliance) => [alliance.id, alliance.team_ids]));
  const byAlliance = new Map(scores.map((s) => [s.alliance_id, s.score]));
  const wins = new Map<number, { a: number; b: number }>();
  for (const matchup of bracket.matchups) {
    const tally = { a: 0, b: 0 };
    const aTeams = matchup.alliance_a_id !== null ? teamsOf.get(matchup.alliance_a_id) ?? [] : [];
    for (const game of matches) {
      if (game.bracket_matchup_id !== matchup.id || game.alliances.length !== 2) continue;
      const [first, second] = game.alliances;
      const s1 = byAlliance.get(first.id);
      const s2 = byAlliance.get(second.id);
      if (s1 === undefined || s2 === undefined || s1 === s2) continue;
      const winner = s1 > s2 ? first : second;
      if (sameTeams(winner.team_ids, aTeams)) tally.a += 1;
      else tally.b += 1;
    }
    wins.set(matchup.id, tally);
  }
  return wins;
}

/** "Final", "Semifinals", "Quarterfinals", else "Round N". */
export function roundName(t: TFunction, roundNumber: number, roundCount: number): string {
  const fromEnd = roundCount - roundNumber;
  if (fromEnd === 0) return t("display.bracket.final");
  if (fromEnd === 1) return t("display.bracket.semifinals");
  if (fromEnd === 2) return t("display.bracket.quarterfinals");
  return t("display.bracket.round", { number: roundNumber });
}
```

Append to `api.ts`:

```ts
/** The division's newest finals bracket (a single-division event's carry no
 * division, so those count too); null when none exists yet. */
export function useNewestFinals(sessionId: number, divisionId: number | null): FinalsBracket | null | undefined {
  const own = useFinals(sessionId, divisionId);
  const unscoped = useFinals(sessionId, null);
  if (!own.data || !unscoped.data) return undefined;
  const all = [...own.data, ...unscoped.data].sort((a, b) => b.id - a.id);
  return all[0] ?? null;
}
```

- [ ] **Step 4: Write the two screens**

Create `frontend/apps/device/src/display/screens/skillsRankings.tsx`:

```tsx
import { useQueries } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  paths,
  useFetchJson,
  useSkillsAttempts,
  useSkillsRankings,
  useSkillsSettings,
  useTeamsById,
  type SkillsRankingRow,
} from "../api";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { ScrollingList } from "../components/ScrollingList";
import type { ScreenModule, ScreenProps } from "../screenTypes";

const TOP = 10;
const RECENT = 8;

/** Event-wide skills standings for the active session (skills are never split by division). */
function SkillsRankingsScreen({ context, onDone, fitSeconds }: ScreenProps) {
  const { t } = useTranslation();
  const fetchJson = useFetchJson();
  const settings = useSkillsSettings();
  const overall = useSkillsRankings(context.sessionId, "overall");
  const attempts = useSkillsAttempts(context.sessionId);
  const teams = useTeamsById();
  const types = settings.data?.types ?? [];
  const perType = useQueries({
    queries: types.map((type) => ({
      queryKey: ["skillsRankings", context.sessionId, type.key],
      queryFn: () => fetchJson<SkillsRankingRow[]>(paths.skillsRankings(context.sessionId, type.key)),
    })),
  });
  const title = t("display.screens.skills_rankings");
  if (settings.data && !settings.data.enabled) return <ScreenNotice title={title} text={t("display.skillsOff")} />;
  if (!settings.data || !overall.data || !attempts.data || !teams || perType.some((q) => !q.data)) {
    return <WaitingForData title={title} />;
  }
  const best = (typeIndex: number, teamId: number) =>
    perType[typeIndex].data?.find((row) => row.team_id === teamId)?.score ?? 0;
  const used = (typeKey: string, teamId: number) =>
    attempts.data!.filter((a) => a.team_id === teamId && a.skills_type === typeKey).length;
  const labelOf = new Map(types.map((type) => [type.key, type.label]));
  const recent = [...attempts.data].sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at)).slice(0, RECENT);
  return (
    <ScreenFrame title={title} className="rankings">
      <div className="split">
        <ScrollingList onDone={onDone} fitSeconds={fitSeconds}>
          <table className="kiosk-table" aria-label={title}>
            <thead>
              <tr>
                <th scope="col">{t("display.col.rank")}</th>
                <th scope="col">{t("display.col.team")}</th>
                <th scope="col">{t("display.col.total")}</th>
                {types.map((type) => (
                  <th key={type.key} scope="col">
                    {type.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {overall.data.map((row) => {
                const team = teams.get(row.team_id);
                return (
                  <tr key={row.team_id}>
                    <td className="kiosk-table__rank">{row.rank}</td>
                    <td>
                      <span className="kiosk-table__number">{team?.number ?? ""}</span> {team?.name ?? ""}
                    </td>
                    <td className="kiosk-table__number">{row.score}</td>
                    {types.map((type, index) => (
                      <td key={type.key}>{`${best(index, row.team_id)} / ${used(type.key, row.team_id)}`}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollingList>
        <div className="side-stack">
          <aside className="side-panel" aria-label={t("display.top10")}>
            <h2 className="side-panel__title">{t("display.top10")}</h2>
            <table className="kiosk-table kiosk-table--compact">
              <tbody>
                {overall.data.slice(0, TOP).map((row) => (
                  <tr key={row.team_id}>
                    <td>{row.rank}</td>
                    <td className="kiosk-table__number">{teams.get(row.team_id)?.number ?? ""}</td>
                    <td className="kiosk-table__number">{row.score}</td>
                    <td>{types.map((_, index) => best(index, row.team_id)).join(" / ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
          <aside className="side-panel" aria-label={t("display.recentScores")}>
            <h2 className="side-panel__title">{t("display.recentScores")}</h2>
            <table className="kiosk-table kiosk-table--compact">
              <tbody>
                {recent.map((attempt) => (
                  <tr key={attempt.id}>
                    <td className="kiosk-table__number">{teams.get(attempt.team_id)?.number ?? ""}</td>
                    <td>{labelOf.get(attempt.skills_type) ?? attempt.skills_type}</td>
                    <td className="side-panel__end">{attempt.score}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </aside>
        </div>
      </div>
    </ScreenFrame>
  );
}

export const skillsRankingsScreen: ScreenModule = { key: "skills_rankings", scrolls: true, Component: SkillsRankingsScreen };
```

Create `frontend/apps/device/src/display/screens/eliminationBracket.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { formatTime } from "@tournament-admin/shared";
import {
  useFields,
  useMatches,
  useNewestFinals,
  useScores,
  useSessionTimeZone,
  useTeamsById,
  type FinalsBracket,
  type Team,
} from "../api";
import { TeamNumbers } from "../components/MatchCells";
import { ScreenFrame, ScreenNotice, WaitingForData } from "../components/ScreenFrame";
import { roundName, seriesWins } from "../logic/bracket";
import type { ScreenModule, ScreenProps } from "../screenTypes";

function Side({
  bracket,
  allianceId,
  teams,
  wins,
  winnerId,
  testId,
}: {
  bracket: FinalsBracket;
  allianceId: number | null;
  teams: Map<number, Team>;
  wins: number;
  winnerId: number | null;
  testId: string;
}) {
  const alliance = bracket.alliances.find((a) => a.id === allianceId);
  return (
    <div className={`matchup__side${winnerId !== null && winnerId === allianceId ? " is-winner" : ""}`} data-testid={testId}>
      <span className="matchup__seed">{alliance?.seed ?? ""}</span>
      <span className="matchup__teams">{alliance ? alliance.team_ids.map((id) => teams.get(id)?.number ?? "").join(" ") : "—"}</span>
      <span className="matchup__wins">{alliance ? wins : ""}</span>
    </div>
  );
}

function EliminationBracketScreen({ context }: ScreenProps) {
  const { t, i18n } = useTranslation();
  const bracket = useNewestFinals(context.sessionId, context.divisionId);
  const matches = useMatches(context.sessionId);
  const scores = useScores(context.sessionId);
  const fields = useFields(context.sessionId);
  const teams = useTeamsById();
  const timeZone = useSessionTimeZone(context.sessionId);
  const title = t("display.screens.elimination_bracket");
  if (bracket === undefined || !matches.data || !scores.data || !fields.data || !teams) return <WaitingForData title={title} />;
  if (bracket === null) return <ScreenNotice title={title} text={t("display.noEliminations")} />;

  if (bracket.format === "single_elimination") {
    const wins = seriesWins(bracket, matches.data, scores.data);
    const roundCount = Math.max(1, ...bracket.matchups.map((m) => m.round_number));
    const rounds = Array.from({ length: roundCount }, (_, i) =>
      bracket.matchups.filter((m) => m.round_number === i + 1).sort((a, b) => a.position - b.position)
    );
    return (
      <ScreenFrame title={title} className="bracket">
        <div className="bracket__rounds">
          {rounds.map((matchups, index) => (
            <section key={index} className="bracket__round">
              <h2 className="bracket__round-name">{roundName(t, index + 1, roundCount)}</h2>
              {matchups.map((matchup) => {
                const tally = wins.get(matchup.id) ?? { a: 0, b: 0 };
                return (
                  <div key={matchup.id} className="matchup" data-testid={`matchup-${matchup.id}`}>
                    <Side bracket={bracket} allianceId={matchup.alliance_a_id} teams={teams} wins={tally.a} winnerId={matchup.winner_alliance_id} testId={`side-${matchup.alliance_a_id}`} />
                    <Side bracket={bracket} allianceId={matchup.alliance_b_id} teams={teams} wins={tally.b} winnerId={matchup.winner_alliance_id} testId={`side-${matchup.alliance_b_id}`} />
                  </div>
                );
              })}
            </section>
          ))}
        </div>
      </ScreenFrame>
    );
  }

  const results = [...bracket.results].sort((a, b) => a.rank - b.rank);
  const played = (allianceId: number) =>
    bracket.runs.filter((run) => run.bracket_alliance_id === allianceId && run.status === "completed").length;
  const currentRun = bracket.runs.find((run) => run.status !== "completed")?.match_id ?? null;
  const matchById = new Map(matches.data.map((m) => [m.id, m]));
  return (
    <ScreenFrame title={title} className="rankings">
      <div className="split">
        <table className="kiosk-table" aria-label={t("display.finalsRankings")}>
          <thead>
            <tr>
              <th scope="col">{t("display.col.rank")}</th>
              <th scope="col">{t("display.col.team")}</th>
              <th scope="col">{t("display.col.matches")}</th>
              <th scope="col">{t("display.col.total")}</th>
            </tr>
          </thead>
          <tbody>
            {results.map((result) => {
              const alliance = bracket.alliances.find((a) => a.id === result.bracket_alliance_id);
              return (
                <tr key={result.bracket_alliance_id}>
                  <td className="kiosk-table__rank">{result.rank}</td>
                  <td>
                    {alliance?.team_ids.map((id) => (
                      <div key={id}>
                        <span className="kiosk-table__number">{teams.get(id)?.number ?? ""}</span> {teams.get(id)?.name ?? ""}
                      </div>
                    ))}
                  </td>
                  <td>{played(result.bracket_alliance_id)}</td>
                  <td className="kiosk-table__number">{result.score}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <aside className="side-panel" aria-label={t("display.schedulePanel")}>
          <h2 className="side-panel__title">{t("display.schedulePanel")}</h2>
          <table className="kiosk-table kiosk-table--compact">
            <tbody>
              {bracket.runs.map((run) => {
                const game = matchById.get(run.match_id);
                const alliance = bracket.alliances.find((a) => a.id === run.bracket_alliance_id);
                return (
                  <tr key={run.match_id} className={run.match_id === currentRun ? "is-current" : undefined}>
                    <th scope="row">{game?.label ?? ""}</th>
                    <td>
                      <TeamNumbers teamIds={alliance?.team_ids ?? []} teams={teams} station="all" />
                    </td>
                    <td className="side-panel__end">
                      {run.score !== null
                        ? run.score
                        : `${fields.data?.find((f) => f.id === game?.field_id)?.name ?? ""} ${
                            game?.scheduled_time ? formatTime(game.scheduled_time, timeZone, i18n.language) : ""
                          }`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </aside>
      </div>
    </ScreenFrame>
  );
}

export const eliminationBracketScreen: ScreenModule = {
  key: "elimination_bracket",
  scrolls: false,
  Component: EliminationBracketScreen,
};
```

Register both in `screens/registry.ts`.

- [ ] **Step 5: Styles and strings**

Append to `display.css`:

```css
.side-stack { display: flex; flex-direction: column; gap: 1vw; min-height: 0; }
.kiosk-table .is-current { outline: 0.3vw solid var(--kiosk-soon); outline-offset: -0.3vw; }
.bracket__rounds { flex: 1; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: 2vw; }
.bracket__round { display: flex; flex-direction: column; justify-content: space-around; gap: 1vw; }
.bracket__round-name { margin: 0; font-size: 1.3vw; text-transform: uppercase; color: var(--kiosk-muted); }
.matchup { display: flex; flex-direction: column; border-radius: 0.5vw; overflow: hidden; }
.matchup__side { display: grid; grid-template-columns: 2.5vw 1fr 2.5vw; align-items: center; gap: 0.5vw; padding: 0.4vw 0.6vw; font-size: 1.6vw; font-weight: 700; }
.matchup__side:first-child { background: var(--kiosk-red); }
.matchup__side:last-child { background: var(--kiosk-blue); }
.matchup__side.is-winner { font-weight: 900; box-shadow: inset 0.4vw 0 0 var(--kiosk-soon); }
.matchup__seed { opacity: 0.8; }
.matchup__wins { text-align: right; font-weight: 900; }
```

Add to the `"display"` object in `en/device.json`:

```json
    "skillsOff": "Skills challenges aren't running",
    "top10": "Top 10",
    "recentScores": "Recent scores",
    "noEliminations": "No eliminations yet",
    "finalsRankings": "Finals rankings",
    "bracket": { "final": "Final", "semifinals": "Semifinals", "quarterfinals": "Quarterfinals", "round": "Round {{number}}" }
```

and in `zh/device.json`:

```json
    "skillsOff": "未开展技能挑战赛",
    "top10": "前 10 名",
    "recentScores": "最新成绩",
    "noEliminations": "淘汰赛尚未开始",
    "finalsRankings": "决赛排名",
    "bracket": { "final": "决赛", "semifinals": "半决赛", "quarterfinals": "四分之一决赛", "round": "第 {{number}} 轮" }
```

- [ ] **Step 6: Run the tests and type check**

Run: `cd frontend/apps/device && npx vitest run && npx tsc -b`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/device/src frontend/apps/device/tests
git commit -m "Add the Skills Rankings screen, with each skills type's best score and attempts used, the top 10 and recent scores, and the Elimination Brackets screen: a single-elimination tree with series wins and winners, or score-chase finals rankings with the runs and the current run highlighted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Pit rotations and audience sounds

**Files:**
- Create: `frontend/apps/device/src/display/RotationRunner.tsx`
- Create: `frontend/apps/device/src/display/logic/sounds.ts`, `frontend/apps/device/src/display/soundPlayer.ts`, `frontend/apps/device/src/display/AudienceSounds.tsx`
- Modify: `frontend/apps/device/src/display/GroupView.tsx`, `display.css`, both `device.json` files
- Test: `frontend/apps/device/tests/unit/rotation.test.tsx`, `frontend/apps/device/tests/unit/sounds.test.tsx`

**Interfaces:**
- Consumes: Task 7 `screenModule`, `screenContext`; Task 6 `latestStartedMatchForFieldSet`, `remainingSeconds`, `COUNT_IN_PHASES`, `PERIOD_PHASES`; Task 8 `fieldIdsOf`.
- Produces: `RotationRunner({entries, base})`; `Cue`, `ClockState`, `matchCues(prev, next) -> Cue[]`, `timeoutCues(prevRemaining, nextRemaining) -> Cue[]`; `SoundPlayer` (`blocked`, `unlock()`, `play(cue)`), `SoundPlayerContext`; `AudienceSounds({sessionId, fieldSetId, timeoutDeadline})`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/device/tests/unit/rotation.test.tsx`:

```tsx
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRoutes, me, pitGroup } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const ranked = [{ team_id: 1, rank: 1, division_id: null, win_points: 2, strength_of_schedule: 0, average_score: 0, matches_played: 1 }];

describe("pit rotation", () => {
  it("moves on from a timed screen after its seconds, and from a list that fits after its seconds too", async () => {
    serveDisplay({
      ...baseRoutes(),
      "/api/rankings?session_id=1": ranked,
      "/api/displays/me": me(
        pitGroup({
          rotation: [
            { screen: "logo", settings: {}, seconds: 5 },
            { screen: "teamwork_rankings", settings: {}, seconds: 6 },
            { screen: "upcoming_matches", settings: { count: 3, scope: "division" }, seconds: 5 },
          ],
        })
      ),
    });
    renderDisplay();
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5_200));
    expect(await screen.findByRole("table", { name: "Teamwork Rankings" })).toBeInTheDocument();
    // The rankings fit (jsdom lays nothing out), so the list's own fit timer moves it on.
    await act(() => vi.advanceTimersByTimeAsync(6_200));
    expect(await screen.findByText("No more matches here")).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5_200));
    expect(await screen.findByRole("heading", { name: "Spring Invitational" })).toBeInTheDocument();
  });

  it("starts over when the rotation is edited", async () => {
    let group = pitGroup({ rotation: [{ screen: "logo", settings: {}, seconds: 300 }] });
    serveDisplay({ ...baseRoutes(), "/api/rankings?session_id=1": ranked, "/api/displays/me": () => me(group) });
    const { emit } = renderDisplay();
    await screen.findByRole("heading", { name: "Spring Invitational" });
    group = pitGroup({ rotation: [{ screen: "teamwork_rankings", settings: {}, seconds: 20 }] });
    emit("display_changed", { session_id: 1, group_id: 52 });
    expect(await screen.findByRole("table", { name: "Teamwork Rankings" })).toBeInTheDocument();
  });
});
```

Create `frontend/apps/device/tests/unit/sounds.test.tsx`:

```tsx
import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";
import { matchCues, timeoutCues, type ClockState } from "../../src/display/logic/sounds";
import { SoundPlayer } from "../../src/display/soundPlayer";
import { audienceGroup, baseRoutes, match, me } from "./displayFixtures";
import { renderDisplay, serveDisplay } from "./displayHarness";

const state = (phase: string, whole: number, extra: Partial<ClockState> = {}): ClockState => ({
  matchId: 1, phase, whole, paused: false, ...extra,
});

describe("matchCues", () => {
  it("is silent on the first reading and while paused", () => {
    expect(matchCues(null, state("driver", 50))).toEqual([]);
    expect(matchCues(state("driver", 50), state("driver", 30, { paused: true }))).toEqual([]);
  });

  it("beats on each count-in second, then starts the period", () => {
    expect(matchCues(state("not_started", 0), state("countdown_autonomous", 3))).toEqual(["beat"]);
    expect(matchCues(state("countdown_autonomous", 3), state("countdown_autonomous", 2))).toEqual(["beat"]);
    expect(matchCues(state("countdown_autonomous", 1), state("autonomous", 15))).toEqual(["start"]);
  });

  it("warns at 30 seconds, ends periods and the match", () => {
    expect(matchCues(state("driver", 31), state("driver", 30))).toEqual(["warning"]);
    expect(matchCues(state("driver", 30), state("driver", 29))).toEqual([]);
    expect(matchCues(state("autonomous", 1), state("awaiting_driver", 0))).toEqual(["periodEnd"]);
    expect(matchCues(state("driver", 1), state("ended", 0))).toEqual(["matchEnd"]);
  });

  it("treats a new match as starting from not started", () => {
    expect(matchCues(state("ended", 0, { matchId: 1 }), state("countdown_driver", 3, { matchId: 2 }))).toEqual(["beat"]);
  });
});

describe("timeoutCues", () => {
  it("sounds when a time-out runs out, not when it is cancelled", () => {
    expect(timeoutCues(0.5, 0)).toEqual(["timeoutEnd"]);
    expect(timeoutCues(0.5, null)).toEqual([]);
    expect(timeoutCues(null, 10)).toEqual([]);
  });
});

class FakeContext {
  state = "suspended";
  currentTime = 0;
  destination = {};
  started: number[] = [];
  resume = vi.fn(async () => {
    this.state = "running";
  });
  createOscillator() {
    return { frequency: { value: 0 }, connect: vi.fn(), start: (at: number) => this.started.push(at), stop: vi.fn() };
  }
  createGain() {
    return { gain: { value: 0 }, connect: vi.fn() };
  }
}

describe("SoundPlayer", () => {
  it("is blocked until unlocked, and plays only when running", async () => {
    const context = new FakeContext();
    const player = new SoundPlayer(() => context as unknown as AudioContext);
    expect(player.blocked).toBe(true);
    player.play("start");
    expect(context.started).toEqual([]);
    await player.unlock();
    expect(player.blocked).toBe(false);
    player.play("warning");
    expect(context.started).toHaveLength(2);
  });
});

describe("audience sounds", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("asks for a click when the browser blocks sound, and only when sounds are on", async () => {
    vi.stubGlobal("AudioContext", FakeContext);
    const now = Date.now();
    serveDisplay({
      ...baseRoutes(),
      "/api/displays/me": me(audienceGroup({ screen: "logo", play_sounds: true })),
      "/api/matches?session_id=1": [match({ phase: "driver", phase_deadline: new Date(now + 40_000).toISOString() })],
    });
    renderDisplay();
    const note = await screen.findByRole("button", { name: "Click to enable sound" });
    fireEvent.click(note);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(screen.queryByRole("button", { name: "Click to enable sound" })).not.toBeInTheDocument();
  });

  it("shows no note when sounds are off", async () => {
    vi.stubGlobal("AudioContext", FakeContext);
    serveDisplay({ ...baseRoutes(), "/api/displays/me": me(audienceGroup({ screen: "logo", play_sounds: false })) });
    renderDisplay();
    await screen.findByRole("heading", { name: "Spring Invitational" });
    expect(screen.queryByRole("button", { name: "Click to enable sound" })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/device && npx vitest run tests/unit/rotation.test.tsx tests/unit/sounds.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the rotation runner and use it**

Create `frontend/apps/device/src/display/RotationRunner.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import type { RotationEntry } from "@tournament-admin/shared";
import type { ScreenContext } from "./screenTypes";
import { screenModule } from "./screens/registry";

/** Shows each rotation entry in turn. A scrolling screen moves on once it has
 * shown its whole list (or, when it fits, after the entry's seconds); any
 * other screen after the entry's seconds. */
export function RotationRunner({ entries, base }: { entries: RotationEntry[]; base: Omit<ScreenContext, "settings"> }) {
  const [step, setStep] = useState(0);
  const entry = entries[step % entries.length];
  const module = screenModule(entry.screen);
  const next = useCallback(() => setStep((n) => n + 1), []);
  useEffect(() => {
    if (module.scrolls) return undefined;
    const id = setTimeout(next, entry.seconds * 1000);
    return () => clearTimeout(id);
  }, [step, module.scrolls, entry.seconds, next]);
  const { Component } = module;
  return (
    <Component
      key={step}
      context={{ ...base, settings: entry.settings }}
      onDone={module.scrolls ? next : undefined}
      fitSeconds={entry.seconds}
    />
  );
}
```

In `GroupView.tsx`, replace the pit/audience part (from `// Pit rotations get the runner in Task 12.` to the final `return`) with:

```tsx
  const context = screenContext(sessionId, group, divisionId, group.screen_settings);
  if (group.kind === "pit" && group.rotation?.length) {
    const base = {
      sessionId: context.sessionId,
      fieldSetId: context.fieldSetId,
      divisionId: context.divisionId,
      queuedMatchId: context.queuedMatchId,
    };
    return <RotationRunner key={JSON.stringify(group.rotation)} entries={group.rotation} base={base} />;
  }
  const { Component } = screenModule(group.screen);
  if (group.kind !== "audience") return <Component context={context} />;
  return (
    <>
      <TimeoutGate deadline={timeoutDeadline}>
        <Component context={context} />
      </TimeoutGate>
      {group.play_sounds && (
        <AudienceSounds sessionId={sessionId} fieldSetId={group.field_set_id} timeoutDeadline={timeoutDeadline} />
      )}
    </>
  );
```

(import `RotationRunner` and `AudienceSounds`).

- [ ] **Step 4: Write the sound rules, the player and the audience hook**

Create `frontend/apps/device/src/display/logic/sounds.ts`:

```ts
import { COUNT_IN_PHASES, PERIOD_PHASES } from "@tournament-admin/shared";

export type Cue = "beat" | "start" | "warning" | "periodEnd" | "matchEnd" | "timeoutEnd";

/** One reading of the running match's clock, in whole seconds left. */
export interface ClockState {
  matchId: number;
  phase: string;
  whole: number;
  paused: boolean;
}

export const WARNING_SECONDS = 30;

/** The cues between two readings. The first reading is silent, so a display
 * turned on mid-match doesn't sound a start. */
export function matchCues(prev: ClockState | null, next: ClockState | null): Cue[] {
  if (prev === null || next === null || next.paused) return [];
  const before = prev.matchId === next.matchId ? prev : { ...next, phase: "not_started", whole: 0 };
  const cues: Cue[] = [];
  const phaseChanged = before.phase !== next.phase;
  if (COUNT_IN_PHASES.has(next.phase) && (phaseChanged || before.whole !== next.whole) && next.whole > 0) cues.push("beat");
  if (PERIOD_PHASES.has(next.phase) && phaseChanged) cues.push("start");
  if (PERIOD_PHASES.has(next.phase) && !phaseChanged && before.whole > WARNING_SECONDS && next.whole <= WARNING_SECONDS) {
    cues.push("warning");
  }
  if (PERIOD_PHASES.has(before.phase) && phaseChanged && next.phase !== "ended") cues.push("periodEnd");
  if (before.phase !== "ended" && next.phase === "ended") cues.push("matchEnd");
  return cues;
}

/** A time-out that runs out sounds; a cancelled one (no deadline) doesn't. */
export function timeoutCues(prevRemaining: number | null, nextRemaining: number | null): Cue[] {
  return prevRemaining !== null && prevRemaining > 0 && nextRemaining !== null && nextRemaining <= 0 ? ["timeoutEnd"] : [];
}
```

Create `frontend/apps/device/src/display/soundPlayer.ts`:

```ts
import { createContext } from "react";
import type { Cue } from "./logic/sounds";

const TONES: Record<Cue, { frequency: number; seconds: number; repeat: number }> = {
  beat: { frequency: 880, seconds: 0.15, repeat: 1 },
  start: { frequency: 1320, seconds: 0.4, repeat: 1 },
  warning: { frequency: 660, seconds: 0.25, repeat: 2 },
  periodEnd: { frequency: 440, seconds: 0.6, repeat: 1 },
  matchEnd: { frequency: 330, seconds: 0.9, repeat: 1 },
  timeoutEnd: { frequency: 520, seconds: 0.7, repeat: 2 },
};
const GAP_SECONDS = 0.1;

/** Short tones made by the browser itself, so there are no sound files. */
export class SoundPlayer {
  private context: AudioContext | null = null;

  constructor(private readonly create: () => AudioContext = () => new AudioContext()) {}

  private ensure(): AudioContext | null {
    if (this.context === null) {
      try {
        this.context = this.create();
      } catch {
        return null;
      }
    }
    return this.context;
  }

  /** True while the browser holds sound until someone clicks the page. */
  get blocked(): boolean {
    return this.ensure()?.state === "suspended";
  }

  async unlock(): Promise<void> {
    await this.ensure()?.resume();
  }

  play(cue: Cue): void {
    const context = this.ensure();
    if (context === null || context.state !== "running") return;
    const tone = TONES[cue];
    for (let i = 0; i < tone.repeat; i += 1) {
      const at = context.currentTime + i * (tone.seconds + GAP_SECONDS);
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = tone.frequency;
      gain.gain.value = 0.2;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(at);
      oscillator.stop(at + tone.seconds);
    }
  }
}

export const SoundPlayerContext = createContext<SoundPlayer | null>(null);
```

Create `frontend/apps/device/src/display/AudienceSounds.tsx`:

```tsx
import { useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { latestStartedMatchForFieldSet, remainingSeconds } from "@tournament-admin/shared";
import { useFields, useMatches } from "./api";
import { matchCues, timeoutCues, type ClockState } from "./logic/sounds";
import { useServerNow } from "./serverClock";
import { SoundPlayer, SoundPlayerContext } from "./soundPlayer";
import { fieldIdsOf } from "./screens/inMatch";

/** Plays the match and time-out tones for an audience group with sounds on,
 * whatever screen it shows, and asks for one click if the browser blocks sound. */
export function AudienceSounds({
  sessionId,
  fieldSetId,
  timeoutDeadline,
}: {
  sessionId: number;
  fieldSetId: number | null;
  timeoutDeadline: string | null;
}) {
  const { t } = useTranslation();
  const provided = useContext(SoundPlayerContext);
  const [player] = useState(() => provided ?? new SoundPlayer());
  const [blocked, setBlocked] = useState(() => player.blocked);
  const now = useServerNow();
  const matches = useMatches(sessionId);
  const fields = useFields(sessionId);
  const match =
    matches.data && fields.data ? latestStartedMatchForFieldSet(matches.data, fieldIdsOf(fields.data, fieldSetId)) : null;
  const reading: ClockState | null = match
    ? { matchId: match.id, phase: match.phase, whole: Math.ceil((remainingSeconds(match, now) ?? 0) - 1e-9), paused: match.paused }
    : null;
  const timeoutRemaining = timeoutDeadline === null ? null : (Date.parse(timeoutDeadline) - now) / 1000;
  const previous = useRef<{ clock: ClockState | null; timeout: number | null } | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = { clock: reading, timeout: timeoutRemaining };
    if (before === null) return;
    for (const cue of [...matchCues(before.clock, reading), ...timeoutCues(before.timeout, timeoutRemaining)]) {
      player.play(cue);
    }
  });

  if (!blocked) return null;
  return (
    <button
      type="button"
      className="sound-note"
      onClick={() => {
        void player.unlock().then(() => setBlocked(player.blocked));
      }}
    >
      {t("display.enableSound")}
    </button>
  );
}
```

- [ ] **Step 5: Styles and strings**

Append to `display.css`:

```css
.sound-note {
  position: absolute; left: 1.5vw; bottom: 1.5vw; z-index: 30; cursor: pointer;
  padding: 0.5vw 1vw; border: 0; border-radius: 0.5vw; background: var(--kiosk-surface); color: var(--kiosk-ink); font: inherit; font-size: 1.2vw;
}
```

Add `"enableSound": "Click to enable sound"` to the `"display"` object in `en/device.json` and `"enableSound": "点击以启用声音"` in `zh/device.json`.

- [ ] **Step 6: Run the tests and type check**

Run: `cd frontend/apps/device && npx vitest run && npx tsc -b`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/device/src frontend/apps/device/tests
git commit -m "Run pit rotations, moving on after each screen's seconds or once a list has been shown in full, and play generated match and time-out tones on audience displays with sounds on, asking for one click when the browser blocks sound.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The admin's Match Control page

**Files:**
- Create: `frontend/apps/admin/src/displays/types.ts`, `frontend/apps/admin/src/displays/ScreenSettingsEditor.tsx`
- Create: `frontend/apps/admin/src/matchControl/useMatchControl.ts`
- Create: `frontend/apps/admin/src/routes/MatchControlRoute.tsx`
- Modify: `frontend/apps/admin/src/router.tsx`, `frontend/apps/admin/src/components/AppShell.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/MatchControlRoute.test.tsx`; update `frontend/apps/admin/tests/unit/AppShell.test.tsx` if it lists the admin nav links

**Interfaces:**
- Consumes: Task 2 (`GET /api/displays`, `PATCH /api/displays/groups/{id}`), Task 4 (queued-match, time-out, `FieldSetRead` fields), Task 5 (`GET /api/scores`), Task 6 (`nextMatchForFieldSet`, `latestStartedMatchForFieldSet`, `lastScoredMatch`, `onFields`, `sortMatches`, `remainingSeconds`, `formatClock`, `AUDIENCE_SCREENS`, `TIMEOUT_SECONDS`, `UPCOMING_COUNT`).
- Produces (`displays/types.ts`): `DisplayRef`, `DisplayGroupRead`, `DisplaysRead`, `FieldSetLiveRead`, `FieldRead`.
- Produces (`displays/ScreenSettingsEditor.tsx`): `ScreenSettingsEditor({screen, kind, settings, onChange, idPrefix})` (renders nothing for screens without settings).
- Produces (`matchControl/useMatchControl.ts`): `useMatchControlData(sessionId)`, `useMatchControlActions()` with mutations `matchAction`, `queue`, `startTimeout`, `cancelTimeout`, `updateGroup`.
- Produces: route `/match-control` and the admin nav link "Match Control"; i18n `shell.matchControlLink`, `matchControl.*`, `displayScreens.*`, `displays.settings.*`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/admin/tests/unit/MatchControlRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n, type LiveMatch } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { MatchControlRoute } from "../../src/routes/MatchControlRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
function match(overrides: Partial<LiveMatch>): LiveMatch {
  const id = overrides.id ?? 1;
  return {
    id, session_id: 1, division_id: null, round_type: "qualification", match_number: id, label: `Q${id}`,
    field_id: 1, scheduled_time: soon(id), status: "scheduled", phase: "not_started", phase_deadline: null,
    paused: false, remaining_seconds_at_pause: null, is_finals: false,
    alliances: [
      { id: id * 10 + 1, station: "red", team_ids: [1] },
      { id: id * 10 + 2, station: "blue", team_ids: [2] },
    ],
    ...overrides,
  };
}

let event: { active_session_id: number | null };
let fieldSets: Record<string, unknown>[];
let matches: LiveMatch[];
let scores: Record<string, unknown>[];
let audience: Record<string, unknown>;

function stub() {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    const routes: Record<string, unknown> = {
      "GET /api/event": { id: 1, name: "E", game_plugin_name: "g", game_plugin_locked: false, created_at: "", ...event },
      "GET /api/field-sets?session_id=1": fieldSets,
      "GET /api/fields?session_id=1": [
        { id: 1, field_set_id: 10, name: "Field 1" },
        { id: 2, field_set_id: 10, name: "Field 2" },
        { id: 3, field_set_id: 11, name: "Side 1" },
      ],
      "GET /api/matches?session_id=1": matches,
      "GET /api/scores?session_id=1": scores,
      "GET /api/teams": [
        { id: 1, number: "101A", name: "Rockets", division_id: null },
        { id: 2, number: "102B", name: "Gears", division_id: null },
      ],
      "GET /api/displays?session_id=1": { session_id: 1, groups: [audience], unassigned: [], has_setup: false },
    };
    if (key in routes) return routes[key] as never;
    if (options?.method && options.method !== "GET") return {} as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <MatchControlRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  localStorage.clear();
  event = { active_session_id: 1 };
  fieldSets = [
    { id: 10, session_id: 1, name: "Main Fields", division_id: null, queued_match_id: null, timeout_deadline: null },
    { id: 11, session_id: 1, name: "Side Fields", division_id: null, queued_match_id: null, timeout_deadline: null },
  ];
  matches = [match({ id: 1 }), match({ id: 2, field_id: 2 }), match({ id: 3, field_id: 3 })];
  scores = [];
  audience = {
    id: 50, session_id: 1, kind: "audience", name: "Main Fields", field_set_id: 10, field_id: null, division_id: null,
    screen: "logo", screen_settings: {}, rotation: null, play_sounds: false, displays: [],
  };
  stub();
});

describe("Match Control", () => {
  it("asks for an active session when there is none", async () => {
    event = { active_session_id: null };
    renderRoute();
    expect(await screen.findByText(/No session is active/)).toBeInTheDocument();
  });

  it("shows the field group's next match and starts it", async () => {
    renderRoute();
    const next = await screen.findByRole("region", { name: "Next match" });
    expect(within(next).getByText("Q1 · Field 1")).toBeInTheDocument();
    expect(within(next).getByText(/101A/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/start", { method: "POST" }));
  });

  it("switches field groups with the tabs and remembers the choice", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("tab", { name: "Side Fields" }));
    expect(await within(screen.getByRole("region", { name: "Next match" })).findByText("Q3 · Side 1")).toBeInTheDocument();
    expect(localStorage.getItem("tournament-admin.matchControl.fieldSet")).toBe("11");
  });

  it("queues a different next match and clears it", async () => {
    renderRoute();
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.change(screen.getByLabelText("Queue match"), { target: { value: "2" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10/queued-match", { method: "PUT", body: { match_id: 2 } })
    );
    fieldSets[0] = { ...fieldSets[0], queued_match_id: 2 };
    stub();
    renderRoute();
    const panels = await screen.findAllByRole("region", { name: "Next match" });
    const latest = panels[panels.length - 1];
    expect(await within(latest).findByText("Q2 · Field 2")).toBeInTheDocument();
    fireEvent.click(within(latest).getByRole("button", { name: "Back to schedule order" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10/queued-match", { method: "PUT", body: { match_id: null } })
    );
  });

  it("offers Pause and End early while running, Resume while paused, and blocks Start", async () => {
    matches = [match({ id: 1, phase: "driver", phase_deadline: soon(1) }), match({ id: 2, field_id: 2 })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    expect(within(timer).getByText("Driver control")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    fireEvent.click(within(timer).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/pause", { method: "POST" }));
    fireEvent.click(within(timer).getByRole("button", { name: "End early" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "End early" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/end", { method: "POST" }));
  });

  it("starts driver control and resets the whole match", async () => {
    matches = [match({ id: 1, phase: "awaiting_driver" })];
    stub();
    renderRoute();
    const timer = await screen.findByRole("region", { name: "Timer" });
    fireEvent.click(within(timer).getByRole("button", { name: "Start driver control" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/start-driver", { method: "POST" }));
    fireEvent.click(within(timer).getByRole("button", { name: "Reset" }));
    const dialog = screen.getByRole("dialog", { name: "Reset the match?" });
    expect(within(dialog).queryByRole("button", { name: "Reset this period" })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Reset the whole match" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/matches/1/reset", { method: "POST", body: { scope: "full" } })
    );
  });

  it("shows the last saved match with its scores", async () => {
    matches = [match({ id: 1, status: "completed", phase: "ended" }), match({ id: 2, field_id: 2 })];
    scores = [
      { match_id: 1, alliance_id: 11, score: 9, data: {}, teams: [], saved_at: soon(0) },
      { match_id: 1, alliance_id: 12, score: 3, data: {}, teams: [], saved_at: soon(0) },
    ];
    stub();
    renderRoute();
    const saved = await screen.findByRole("region", { name: "Saved match" });
    expect(within(saved).getByText("Q1")).toBeInTheDocument();
    expect(saved).toHaveTextContent("9");
    expect(saved).toHaveTextContent("3");
  });

  it("picks the audience screen, its settings and sounds", async () => {
    renderRoute();
    const panel = await screen.findByRole("region", { name: "Audience screen" });
    expect(within(panel).getByRole("button", { name: "Logo" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(panel).getByRole("button", { name: "Upcoming Matches" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", { method: "PATCH", body: { screen: "upcoming_matches" } })
    );
    audience = { ...audience, screen: "upcoming_matches", screen_settings: { count: 3, scope: "field_set" } };
    stub();
    renderRoute();
    const panels = await screen.findAllByRole("region", { name: "Audience screen" });
    const latest = panels[panels.length - 1];
    fireEvent.change(await within(latest).findByLabelText("Matches to show"), { target: { value: "5" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", {
        method: "PATCH",
        body: { screen_settings: { count: 5, scope: "field_set" } },
      })
    );
    fireEvent.click(within(latest).getByLabelText("Play sounds"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", { method: "PATCH", body: { play_sounds: true } })
    );
  });

  it("starts and cancels a time-out", async () => {
    renderRoute();
    const panel = await screen.findByRole("region", { name: "Time-out" });
    expect(within(panel).getByLabelText("Length in seconds")).toHaveValue(180);
    fireEvent.click(within(panel).getByRole("button", { name: "Start time-out" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10/timeout", { method: "POST", body: { seconds: 180 } })
    );
    fieldSets[0] = { ...fieldSets[0], timeout_deadline: soon(2) };
    stub();
    renderRoute();
    const panels = await screen.findAllByRole("region", { name: "Time-out" });
    fireEvent.click(await within(panels[panels.length - 1]).findByRole("button", { name: "Cancel time-out" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10/timeout", { method: "DELETE" }));
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/MatchControlRoute.test.tsx`
Expected: FAIL, the route module is missing.

- [ ] **Step 3: Write the shared admin display types and the settings editor**

Create `frontend/apps/admin/src/displays/types.ts`:

```ts
import type { DisplayGroupState } from "@tournament-admin/shared";

export interface DisplayRef {
  device_id: number;
  name: string;
  online: boolean;
}

export interface DisplayGroupRead extends DisplayGroupState {
  displays: DisplayRef[];
}

export interface DisplaysRead {
  session_id: number;
  groups: DisplayGroupRead[];
  unassigned: DisplayRef[];
  has_setup: boolean;
}

export interface FieldSetLiveRead {
  id: number;
  session_id: number;
  name: string;
  division_id: number | null;
  queued_match_id: number | null;
  timeout_deadline: string | null;
}

export interface FieldRead {
  id: number;
  field_set_id: number;
  name: string;
}
```

Create `frontend/apps/admin/src/displays/ScreenSettingsEditor.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UPCOMING_COUNT, type GroupKind, type ScreenSettings } from "@tournament-admin/shared";

/** The settings of the screens that have any (today only Upcoming Matches). */
export function ScreenSettingsEditor({
  screen,
  kind,
  settings,
  onChange,
  idPrefix,
}: {
  screen: string | null;
  kind: GroupKind;
  settings: ScreenSettings;
  onChange: (settings: ScreenSettings) => void;
  idPrefix: string;
}) {
  const { t } = useTranslation();
  const count = settings.count ?? UPCOMING_COUNT.default;
  const scope = settings.scope ?? (kind === "pit" ? "division" : "field_set");
  const [draft, setDraft] = useState(String(count));
  useEffect(() => setDraft(String(count)), [count]);
  if (screen !== "upcoming_matches") return null;
  return (
    <div className="toolbar">
      <div className="field">
        <label className="field__label" htmlFor={`${idPrefix}-count`}>
          {t("displays.settings.count")}
        </label>
        <input
          className="input settings-number"
          id={`${idPrefix}-count`}
          type="number"
          min={UPCOMING_COUNT.min}
          max={UPCOMING_COUNT.max}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= UPCOMING_COUNT.min && value <= UPCOMING_COUNT.max) {
              onChange({ count: value, scope });
            }
          }}
        />
      </div>
      {kind === "audience" && (
        <div className="field">
          <label className="field__label" htmlFor={`${idPrefix}-scope`}>
            {t("displays.settings.scope")}
          </label>
          <select
            className="select"
            id={`${idPrefix}-scope`}
            value={scope}
            onChange={(event) => onChange({ count, scope: event.target.value as "field_set" | "division" })}
          >
            <option value="field_set">{t("displays.settings.scopeFieldSet")}</option>
            <option value="division">{t("displays.settings.scopeDivision")}</option>
          </select>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Write the data and action hooks**

Create `frontend/apps/admin/src/matchControl/useMatchControl.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  apiRequest,
  useRealtimeChannel,
  type AllianceScore,
  type LiveMatch,
  type ScreenSettings,
} from "@tournament-admin/shared";
import type { DisplaysRead, FieldRead, FieldSetLiveRead } from "../displays/types";
import type { TeamSummary } from "../types";

/** Which reads each live event makes stale on this page. */
const LIVE: Record<string, readonly string[]> = {
  match_phase_changed: ["matches"],
  match_paused: ["matches"],
  match_resumed: ["matches"],
  match_reset: ["matches"],
  new_match_created: ["matches"],
  score_saved: ["matches", "scores"],
  field_set_changed: ["fieldSets"],
  display_changed: ["displays"],
  active_session_changed: ["event"],
};

export function useMatchControlData(sessionId: number) {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      for (const key of LIVE[event.event] ?? []) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  });
  return {
    fieldSets: useQuery({
      queryKey: ["fieldSets", sessionId],
      queryFn: () => apiRequest<FieldSetLiveRead[]>(`/api/field-sets?session_id=${sessionId}`),
    }),
    fields: useQuery({
      queryKey: ["fields", sessionId],
      queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${sessionId}`),
    }),
    matches: useQuery({
      queryKey: ["matches", sessionId],
      queryFn: () => apiRequest<LiveMatch[]>(`/api/matches?session_id=${sessionId}`),
    }),
    scores: useQuery({
      queryKey: ["scores", sessionId],
      queryFn: () => apiRequest<AllianceScore[]>(`/api/scores?session_id=${sessionId}`),
    }),
    teams: useQuery({ queryKey: ["teams"], queryFn: () => apiRequest<TeamSummary[]>("/api/teams") }),
    displays: useQuery({
      queryKey: ["displays", sessionId],
      queryFn: () => apiRequest<DisplaysRead>(`/api/displays?session_id=${sessionId}`),
    }),
  };
}

export type MatchAction = "start" | "start-driver" | "pause" | "resume" | "end" | "reset";

export function useMatchControlActions() {
  const queryClient = useQueryClient();
  const refresh = (...keys: string[]) =>
    Promise.all(keys.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
  return {
    matchAction: useMutation({
      mutationFn: ({ matchId, action, body }: { matchId: number; action: MatchAction; body?: unknown }) =>
        apiRequest<LiveMatch>(`/api/matches/${matchId}/${action}`, body === undefined ? { method: "POST" } : { method: "POST", body }),
      onSuccess: () => refresh("matches", "displays", "fieldSets"),
    }),
    queue: useMutation({
      mutationFn: ({ fieldSetId, matchId }: { fieldSetId: number; matchId: number | null }) =>
        apiRequest(`/api/field-sets/${fieldSetId}/queued-match`, { method: "PUT", body: { match_id: matchId } }),
      onSuccess: () => refresh("fieldSets"),
    }),
    startTimeout: useMutation({
      mutationFn: ({ fieldSetId, seconds }: { fieldSetId: number; seconds: number }) =>
        apiRequest(`/api/field-sets/${fieldSetId}/timeout`, { method: "POST", body: { seconds } }),
      onSuccess: () => refresh("fieldSets"),
    }),
    cancelTimeout: useMutation({
      mutationFn: (fieldSetId: number) => apiRequest(`/api/field-sets/${fieldSetId}/timeout`, { method: "DELETE" }),
      onSuccess: () => refresh("fieldSets"),
    }),
    updateGroup: useMutation({
      mutationFn: ({
        groupId,
        ...body
      }: {
        groupId: number;
        screen?: string;
        screen_settings?: ScreenSettings;
        play_sounds?: boolean;
      }) => apiRequest(`/api/displays/groups/${groupId}`, { method: "PATCH", body }),
      onSuccess: () => refresh("displays"),
    }),
  };
}
```

- [ ] **Step 5: Write the page**

Create `frontend/apps/admin/src/routes/MatchControlRoute.tsx`:

```tsx
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AUDIENCE_SCREENS,
  TIMEOUT_SECONDS,
  apiRequest,
  formatClock,
  lastScoredMatch,
  latestStartedMatchForFieldSet,
  nextMatchForFieldSet,
  onFields,
  remainingSeconds,
  sortMatches,
  type AllianceScore,
  type LiveMatch,
} from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { ScreenSettingsEditor } from "../displays/ScreenSettingsEditor";
import type { DisplayGroupRead, FieldRead, FieldSetLiveRead } from "../displays/types";
import { useMatchControlActions, useMatchControlData } from "../matchControl/useMatchControl";
import type { EventRead, TeamSummary } from "../types";

const STORAGE_KEY = "tournament-admin.matchControl.fieldSet";
/** Phases a "reset this period" applies to (the server refuses it elsewhere). */
const SECTION_PHASES = new Set(["countdown_autonomous", "autonomous", "countdown_driver", "driver"]);

function readStoredFieldSet(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return null;
  }
}

function storeFieldSet(id: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(id));
  } catch {
    // Remembering the tab is a convenience only.
  }
}

function useNow(intervalMs = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function teamNumbers(match: LiveMatch, teams: Map<number, TeamSummary>): string {
  return match.alliances
    .map((alliance) => alliance.team_ids.map((id) => teams.get(id)?.number ?? "?").join(" "))
    .join("  vs  ");
}

export function MatchControlRoute() {
  const { t } = useTranslation();
  const event = useQuery({ queryKey: ["event"], queryFn: () => apiRequest<EventRead>("/api/event") });
  const sessionId = event.data?.active_session_id ?? null;
  return (
    <div>
      <h1>{t("matchControl.heading")}</h1>
      {event.data && sessionId === null && (
        <p className="alert alert-warning">
          {t("matchControl.noSession")} <Link to="/sessions">{t("matchControl.sessionsLink")}</Link>
        </p>
      )}
      {sessionId !== null && <MatchControlBody sessionId={sessionId} />}
    </div>
  );
}

function MatchControlBody({ sessionId }: { sessionId: number }) {
  const { t } = useTranslation();
  const data = useMatchControlData(sessionId);
  const [selected, setSelected] = useState<number | null>(readStoredFieldSet);
  const fieldSets = data.fieldSets.data ?? [];
  if (data.fieldSets.data && fieldSets.length === 0) return <p>{t("matchControl.noFields")}</p>;
  const fieldSet = fieldSets.find((fs) => fs.id === selected) ?? fieldSets[0];
  if (!fieldSet || !data.fields.data || !data.matches.data || !data.teams.data || !data.scores.data || !data.displays.data) {
    return <p>{t("matchControl.loading")}</p>;
  }
  const audience = data.displays.data.groups.find((g) => g.kind === "audience" && g.field_set_id === fieldSet.id) ?? null;
  return (
    <>
      <div className="division-tabs" role="tablist" aria-label={t("matchControl.fieldGroups")}>
        {fieldSets.map((fs) => (
          <button
            key={fs.id}
            type="button"
            role="tab"
            className="division-tabs__tab"
            aria-selected={fs.id === fieldSet.id}
            onClick={() => {
              setSelected(fs.id);
              storeFieldSet(fs.id);
            }}
          >
            {fs.name}
          </button>
        ))}
      </div>
      <FieldSetPanel
        key={fieldSet.id}
        fieldSet={fieldSet}
        fields={data.fields.data}
        matches={data.matches.data}
        scores={data.scores.data}
        teams={new Map(data.teams.data.map((team) => [team.id, team]))}
        audience={audience}
      />
    </>
  );
}

function FieldSetPanel({
  fieldSet,
  fields,
  matches,
  scores,
  teams,
  audience,
}: {
  fieldSet: FieldSetLiveRead;
  fields: FieldRead[];
  matches: LiveMatch[];
  scores: AllianceScore[];
  teams: Map<number, TeamSummary>;
  audience: DisplayGroupRead | null;
}) {
  const { t } = useTranslation();
  const now = useNow();
  const actions = useMatchControlActions();
  const [changing, setChanging] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [timeoutSeconds, setTimeoutSeconds] = useState(String(TIMEOUT_SECONDS.default));

  const fieldIds = fields.filter((f) => f.field_set_id === fieldSet.id).map((f) => f.id);
  const fieldName = (id: number | null) => fields.find((f) => f.id === id)?.name ?? "";
  const next = nextMatchForFieldSet(matches, fieldIds, fieldSet.queued_match_id);
  const current = latestStartedMatchForFieldSet(matches, fieldIds);
  const running = current !== null && current.phase !== "ended" ? current : null;
  const saved = lastScoredMatch(matches, scores, fieldIds);
  const unstarted = sortMatches(
    matches.filter((m) => onFields(fieldIds)(m) && m.phase === "not_started" && m.status !== "completed" && m.status !== "not_played")
  );
  const timeoutLeft = fieldSet.timeout_deadline ? (Date.parse(fieldSet.timeout_deadline) - now) / 1000 : 0;
  const failed = Object.values(actions).find((mutation) => mutation.isError);
  const act = (matchId: number, action: Parameters<typeof actions.matchAction.mutate>[0]["action"], body?: unknown) =>
    actions.matchAction.mutate({ matchId, action, body });

  return (
    <div className="match-control">
      {failed && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(failed.error, t("errors.generic"))}
        </p>
      )}

      <section className="panel" role="region" aria-label={t("matchControl.nextHeading")}>
        <h2>{t("matchControl.nextHeading")}</h2>
        {next ? (
          <>
            <p className="match-control__match">{`${next.label} · ${fieldName(next.field_id)}`}</p>
            <p className="match-control__teams">{teamNumbers(next, teams)}</p>
          </>
        ) : (
          <p>{t("matchControl.noNext")}</p>
        )}
        <div className="form-actions">
          <button
            className="btn btn-primary btn-large"
            type="button"
            disabled={next === null || running !== null || actions.matchAction.isPending}
            onClick={() => next && act(next.id, "start")}
          >
            {t("matchControl.start")}
          </button>
          <button className="btn" type="button" onClick={() => setChanging((v) => !v)} disabled={unstarted.length === 0}>
            {t("matchControl.change")}
          </button>
          {fieldSet.queued_match_id !== null && (
            <button className="btn" type="button" onClick={() => actions.queue.mutate({ fieldSetId: fieldSet.id, matchId: null })}>
              {t("matchControl.clearQueue")}
            </button>
          )}
        </div>
        {changing && (
          <div className="field">
            <label className="field__label" htmlFor="queue-match">
              {t("matchControl.queueLabel")}
            </label>
            <select
              className="select"
              id="queue-match"
              value=""
              onChange={(event) => {
                actions.queue.mutate({ fieldSetId: fieldSet.id, matchId: Number(event.target.value) });
                setChanging(false);
              }}
            >
              <option value="" disabled>
                {t("matchControl.queuePlaceholder")}
              </option>
              {unstarted.map((m) => (
                <option key={m.id} value={m.id}>{`${m.label} · ${fieldName(m.field_id)}`}</option>
              ))}
            </select>
          </div>
        )}
      </section>

      <section className="panel" role="region" aria-label={t("matchControl.timerHeading")}>
        <h2>{t("matchControl.timerHeading")}</h2>
        {current === null ? (
          <p>{t("matchControl.noRunning")}</p>
        ) : (
          <>
            <p className="match-control__match">{`${current.label} · ${fieldName(current.field_id)}`}</p>
            <p className="match-control__clock" data-testid="mc-clock">
              {current.phase === "ended" ? "0:00" : formatClock(remainingSeconds(current, now) ?? 0)}
            </p>
            <p>
              {current.paused ? t("matchControl.paused") : t(`matchControl.phase.${current.phase}`, { defaultValue: current.phase })}
            </p>
            {current.phase === "ended" ? (
              <p>{t("matchControl.waitingForScore")}</p>
            ) : (
              <div className="form-actions">
                {current.phase === "awaiting_driver" && (
                  <button className="btn btn-primary" type="button" onClick={() => act(current.id, "start-driver")}>
                    {t("matchControl.startDriver")}
                  </button>
                )}
                {SECTION_PHASES.has(current.phase) &&
                  (current.paused ? (
                    <button className="btn btn-primary" type="button" onClick={() => act(current.id, "resume")}>
                      {t("matchControl.resume")}
                    </button>
                  ) : (
                    <button className="btn" type="button" onClick={() => act(current.id, "pause")}>
                      {t("matchControl.pause")}
                    </button>
                  ))}
                <button className="btn btn-danger" type="button" onClick={() => setConfirmEnd(true)}>
                  {t("matchControl.endEarly")}
                </button>
                <button className="btn" type="button" onClick={() => setResetting(true)}>
                  {t("matchControl.reset")}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel" role="region" aria-label={t("matchControl.savedHeading")}>
        <h2>{t("matchControl.savedHeading")}</h2>
        {saved === null ? (
          <p>{t("matchControl.noneSaved")}</p>
        ) : (
          <>
            <p className="match-control__match">{saved.label}</p>
            <ul className="list-plain">
              {saved.alliances.map((alliance) => (
                <li key={alliance.id}>
                  {`${t(`matchControl.station.${alliance.station}`, { defaultValue: alliance.station })} ${alliance.team_ids
                    .map((id) => teams.get(id)?.number ?? "?")
                    .join(" ")}: `}
                  <strong>{scores.find((s) => s.alliance_id === alliance.id)?.score ?? "–"}</strong>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {audience && (
        <section className="panel" role="region" aria-label={t("matchControl.audienceHeading")}>
          <h2>{t("matchControl.audienceHeading")}</h2>
          <div className="toolbar">
            {AUDIENCE_SCREENS.map((key) => (
              <button
                key={key}
                type="button"
                className={`btn btn-small${audience.screen === key ? " btn-primary" : ""}`}
                aria-pressed={audience.screen === key}
                onClick={() => actions.updateGroup.mutate({ groupId: audience.id, screen: key })}
              >
                {t(`displayScreens.${key}`)}
              </button>
            ))}
          </div>
          <ScreenSettingsEditor
            screen={audience.screen}
            kind="audience"
            settings={audience.screen_settings}
            idPrefix={`audience-${audience.id}`}
            onChange={(settings) => actions.updateGroup.mutate({ groupId: audience.id, screen_settings: settings })}
          />
          <label className="choice">
            <input
              type="checkbox"
              checked={audience.play_sounds}
              onChange={(event) => actions.updateGroup.mutate({ groupId: audience.id, play_sounds: event.target.checked })}
            />{" "}
            {t("matchControl.playSounds")}
          </label>
        </section>
      )}

      <section className="panel" role="region" aria-label={t("matchControl.timeoutHeading")}>
        <h2>{t("matchControl.timeoutHeading")}</h2>
        {timeoutLeft > 0 ? (
          <div className="form-actions">
            <p className="match-control__clock">{formatClock(timeoutLeft)}</p>
            <button className="btn" type="button" onClick={() => actions.cancelTimeout.mutate(fieldSet.id)}>
              {t("matchControl.cancelTimeout")}
            </button>
          </div>
        ) : (
          <div className="toolbar">
            <div className="field">
              <label className="field__label" htmlFor="timeout-seconds">
                {t("matchControl.timeoutLength")}
              </label>
              <input
                className="input settings-number"
                id="timeout-seconds"
                type="number"
                min={TIMEOUT_SECONDS.min}
                max={TIMEOUT_SECONDS.max}
                value={timeoutSeconds}
                onChange={(event) => setTimeoutSeconds(event.target.value)}
              />
            </div>
            <button
              className="btn"
              type="button"
              disabled={
                !Number.isInteger(Number(timeoutSeconds)) ||
                Number(timeoutSeconds) < TIMEOUT_SECONDS.min ||
                Number(timeoutSeconds) > TIMEOUT_SECONDS.max
              }
              onClick={() => actions.startTimeout.mutate({ fieldSetId: fieldSet.id, seconds: Number(timeoutSeconds) })}
            >
              {t("matchControl.startTimeout")}
            </button>
          </div>
        )}
      </section>

      {confirmEnd && current && (
        <ConfirmDialog
          heading={t("matchControl.endHeading")}
          body={t("matchControl.endBody")}
          confirmLabel={t("matchControl.endEarly")}
          cancelLabel={t("matchControl.cancel")}
          onConfirm={() => {
            act(current.id, "end");
            setConfirmEnd(false);
          }}
          onCancel={() => setConfirmEnd(false)}
        />
      )}
      {resetting && current && (
        <Modal labelledBy="reset-heading" onCancel={() => setResetting(false)}>
          <h2 id="reset-heading">{t("matchControl.resetHeading")}</h2>
          <div className="dialog__actions">
            {SECTION_PHASES.has(current.phase) && (
              <button
                className="btn"
                type="button"
                onClick={() => {
                  act(current.id, "reset", { scope: "section" });
                  setResetting(false);
                }}
              >
                {t("matchControl.resetSection")}
              </button>
            )}
            <button
              className="btn btn-danger"
              type="button"
              onClick={() => {
                act(current.id, "reset", { scope: "full" });
                setResetting(false);
              }}
            >
              {t("matchControl.resetFull")}
            </button>
            <button className="btn" type="button" onClick={() => setResetting(false)}>
              {t("matchControl.cancel")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
```

Check `Modal`'s markup before relying on it: the test expects `getByRole("dialog", { name: "Reset the match?" })`, so `Modal` must render a `<dialog aria-labelledby={labelledBy}>`. If it doesn't set `aria-labelledby`, pass the heading through the way `ConfirmDialog` does and adjust the test's query to match.

Add a small style block to `frontend/apps/admin/src/styles/components.css`:

```css
.match-control { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.match-control__match { font-size: var(--text-xl); font-weight: 600; margin: 0; }
.match-control__teams { color: var(--color-text-secondary); margin: var(--space-1) 0 0; }
.match-control__clock { font-size: 3rem; font-weight: 700; font-variant-numeric: tabular-nums; margin: var(--space-2) 0; }
```

- [ ] **Step 6: Add the route, the nav link and the strings**

In `router.tsx` import `MatchControlRoute` and add `{ path: "match-control", element: <MatchControlRoute /> },` after the `devices` route. In `AppShell.tsx`, inside the admin `<nav>`, add after the Devices link:

```tsx
            <NavLink to="/match-control" className={navLinkClassName}>
              {t("shell.matchControlLink")}
            </NavLink>
```

Add to `en/admin.json`: `"matchControlLink": "Match Control"` inside `"shell"`, and top-level:

```json
  "displayScreens": {
    "match_intro": "Match Intro",
    "in_match": "In Match",
    "last_scored_match": "Last Scored Match",
    "teamwork_rankings": "Teamwork Rankings",
    "skills_rankings": "Skills Rankings",
    "upcoming_matches": "Upcoming Matches",
    "match_results": "Match Results",
    "schedule": "Schedule",
    "elimination_bracket": "Elimination Brackets",
    "logo": "Logo"
  },
  "matchControl": {
    "heading": "Match Control",
    "noSession": "No session is active. Make one active on the",
    "sessionsLink": "Sessions page.",
    "noFields": "This session has no fields yet.",
    "loading": "Loading…",
    "fieldGroups": "Field groups",
    "nextHeading": "Next match",
    "noNext": "No match is waiting on this field group.",
    "start": "Start",
    "change": "Change",
    "clearQueue": "Back to schedule order",
    "queueLabel": "Queue match",
    "queuePlaceholder": "Choose a match…",
    "timerHeading": "Timer",
    "noRunning": "No match has started on this field group yet.",
    "paused": "Paused",
    "waitingForScore": "Match over — waiting for the score.",
    "startDriver": "Start driver control",
    "pause": "Pause",
    "resume": "Resume",
    "endEarly": "End early",
    "reset": "Reset",
    "endHeading": "End the match early?",
    "endBody": "The clock stops and the match ends now.",
    "resetHeading": "Reset the match?",
    "resetSection": "Reset this period",
    "resetFull": "Reset the whole match",
    "cancel": "Cancel",
    "savedHeading": "Saved match",
    "noneSaved": "No match on this field group has been scored yet.",
    "station": { "red": "Red", "blue": "Blue" },
    "audienceHeading": "Audience screen",
    "playSounds": "Play sounds",
    "timeoutHeading": "Time-out",
    "timeoutLength": "Length in seconds",
    "startTimeout": "Start time-out",
    "cancelTimeout": "Cancel time-out",
    "phase": {
      "not_started": "Not started",
      "countdown_autonomous": "Autonomous count-in",
      "autonomous": "Autonomous",
      "awaiting_driver": "Waiting for driver control",
      "countdown_driver": "Driver count-in",
      "driver": "Driver control",
      "ended": "Ended"
    }
  },
```

and inside a top-level `"displays"` object (Task 14 adds more keys to it):

```json
  "displays": {
    "settings": {
      "count": "Matches to show",
      "scope": "Show matches from",
      "scopeFieldSet": "This field group",
      "scopeDivision": "The whole division"
    }
  },
```

Add the same keys to `zh/admin.json`: `"matchControlLink": "比赛控制"`, and:

```json
  "displayScreens": {
    "match_intro": "比赛介绍", "in_match": "比赛进行中", "last_scored_match": "最近计分的比赛",
    "teamwork_rankings": "团队赛排名", "skills_rankings": "技能赛排名", "upcoming_matches": "即将进行的比赛",
    "match_results": "比赛结果", "schedule": "比赛日程", "elimination_bracket": "淘汰赛对阵", "logo": "标志"
  },
  "matchControl": {
    "heading": "比赛控制",
    "noSession": "当前没有进行中的场次。请在",
    "sessionsLink": "场次页面设置。",
    "noFields": "本场次还没有场地。",
    "loading": "加载中…",
    "fieldGroups": "场地组",
    "nextHeading": "下一场比赛",
    "noNext": "本场地组没有等待中的比赛。",
    "start": "开始",
    "change": "更改",
    "clearQueue": "恢复日程顺序",
    "queueLabel": "排队比赛",
    "queuePlaceholder": "选择一场比赛…",
    "timerHeading": "计时",
    "noRunning": "本场地组还没有比赛开始。",
    "paused": "已暂停",
    "waitingForScore": "比赛结束 — 等待计分。",
    "startDriver": "开始手动控制",
    "pause": "暂停",
    "resume": "继续",
    "endEarly": "提前结束",
    "reset": "重置",
    "endHeading": "提前结束比赛？",
    "endBody": "计时停止，比赛立即结束。",
    "resetHeading": "重置比赛？",
    "resetSection": "重置本阶段",
    "resetFull": "重置整场比赛",
    "cancel": "取消",
    "savedHeading": "已保存的比赛",
    "noneSaved": "本场地组还没有比赛计分。",
    "station": { "red": "红方", "blue": "蓝方" },
    "audienceHeading": "观众屏幕",
    "playSounds": "播放声音",
    "timeoutHeading": "暂停时间",
    "timeoutLength": "时长（秒）",
    "startTimeout": "开始暂停",
    "cancelTimeout": "取消暂停",
    "phase": {
      "not_started": "未开始", "countdown_autonomous": "自动阶段倒数", "autonomous": "自动阶段",
      "awaiting_driver": "等待手动控制", "countdown_driver": "手动控制倒数", "driver": "手动控制", "ended": "已结束"
    }
  },
  "displays": {
    "settings": {
      "count": "显示场数",
      "scope": "比赛范围",
      "scopeFieldSet": "本场地组",
      "scopeDivision": "整个分组"
    }
  },
```

If `AppShell.test.tsx` asserts the exact list of admin links, add "Match Control" to it.

- [ ] **Step 7: Run the tests and type check**

Run: `cd frontend/apps/admin && npx vitest run && npx tsc -b`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit
git commit -m "Add the Match Control page: field group tabs, the next match with a queue override, Start, Pause, Resume, Start driver control, End early and Reset, the last saved match, the audience screen buttons with their settings and sounds, and the time-out, all kept live for every admin.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 14: The admin's Displays page, and each display's group on the Devices page

**Files:**
- Create: `frontend/apps/admin/src/displays/useDisplays.ts`, `frontend/apps/admin/src/displays/PitGroupEditor.tsx`, `frontend/apps/admin/src/displays/DisplayRows.tsx`
- Create: `frontend/apps/admin/src/routes/DisplaysRoute.tsx`
- Modify: `frontend/apps/admin/src/routes/DevicesRoute.tsx`, `frontend/apps/admin/src/devices/useDevices.ts`
- Modify: `frontend/apps/admin/src/router.tsx`, `frontend/apps/admin/src/components/AppShell.tsx`, both `admin.json` files
- Test: `frontend/apps/admin/tests/unit/DisplaysRoute.test.tsx`; modify `frontend/apps/admin/tests/unit/DevicesRoute.test.tsx`

**Interfaces:**
- Consumes: Task 2 and Task 3 endpoints; Task 13 `displays/types.ts`, `ScreenSettingsEditor`; Task 6 `PIT_SCREENS`, `AUDIENCE_SCREENS`, `SCROLLING_SCREENS`, `ROTATION_SECONDS`, `defaultSettings`.
- Produces: `useDisplays(sessionId)`, `useDisplayMutations(sessionId)` (`createPit`, `updateGroup`, `deleteGroup`, `assign`, `identify`, `copy`); `PitGroupEditor({group, divisions})`; `DisplayRows({displays, groups, sessionId})`; route `/displays` and nav link "Displays"; `DeviceRead.display_group`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/admin/tests/unit/DisplaysRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { DisplaysRoute } from "../../src/routes/DisplaysRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const group = (overrides: Record<string, unknown>) => ({
  session_id: 1, field_set_id: 10, field_id: null, division_id: null, screen: null, screen_settings: {},
  rotation: null, play_sounds: false, displays: [], ...overrides,
});

let displays: Record<string, unknown>;

function stub(overrides: Record<string, unknown> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: { method?: string }) => {
    const key = `${options?.method ?? "GET"} ${path}`;
    if (key in overrides) return overrides[key] as never;
    const routes: Record<string, unknown> = {
      "GET /api/event": { id: 1, name: "E", active_session_id: 1, game_plugin_name: null, game_plugin_locked: false, created_at: "" },
      "GET /api/sessions": [
        { id: 1, label: "Saturday", session_date: null, timezone: null, has_scored_matches: false },
        { id: 2, label: "Sunday", session_date: null, timezone: null, has_scored_matches: false },
      ],
      "GET /api/divisions": [{ id: 4, name: "Division 1" }],
      "GET /api/displays?session_id=1": displays,
      "GET /api/displays?session_id=2": { session_id: 2, groups: [], unassigned: [], has_setup: false },
    };
    if (key in routes) return routes[key] as never;
    if (options?.method && options.method !== "GET") return displays as never;
    throw new Error(`unexpected request: ${key}`);
  });
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <DisplaysRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  displays = {
    session_id: 1,
    has_setup: true,
    groups: [
      group({ id: 50, kind: "audience", name: "Main Fields", screen: "logo", displays: [{ device_id: 7, name: "Big TV", online: true }] }),
      group({ id: 51, kind: "field", name: "Field 1", field_id: 1 }),
      group({ id: 52, kind: "pit", name: "Pit TVs", field_set_id: null, screen: "teamwork_rankings", division_id: 4 }),
    ],
    unassigned: [{ device_id: 8, name: "Spare TV", online: false }],
  };
  stub();
});

describe("Displays page", () => {
  it("lists field groups with their audience and field groups, pit groups and unassigned displays", async () => {
    renderRoute();
    const main = await screen.findByRole("region", { name: "Main Fields" });
    expect(within(main).getByText("Big TV")).toBeInTheDocument();
    expect(within(main).getByText("Online")).toBeInTheDocument();
    expect(within(main).getByText("Field 1")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Pit TVs" })).toBeInTheDocument();
    const unassigned = screen.getByRole("region", { name: "Unassigned displays" });
    expect(within(unassigned).getByText("Spare TV")).toBeInTheDocument();
    expect(within(unassigned).getByText("Offline")).toBeInTheDocument();
  });

  it("sets the audience screen and sounds", async () => {
    renderRoute();
    const main = await screen.findByRole("region", { name: "Main Fields" });
    fireEvent.change(within(main).getByLabelText("Audience screen"), { target: { value: "schedule" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", { method: "PATCH", body: { screen: "schedule" } })
    );
    fireEvent.click(within(main).getByLabelText("Play sounds"));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/50", { method: "PATCH", body: { play_sounds: true } })
    );
  });

  it("moves and identifies displays", async () => {
    renderRoute();
    const unassigned = await screen.findByRole("region", { name: "Unassigned displays" });
    fireEvent.change(within(unassigned).getByLabelText("Put Spare TV in a group"), { target: { value: "52" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/assignments", {
        method: "PUT",
        body: { session_id: 1, device_id: 8, group_id: 52 },
      })
    );
    fireEvent.click(within(unassigned).getByRole("button", { name: "Identify Spare TV" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/displays/8/identify", { method: "POST" }));
    const main = screen.getByRole("region", { name: "Main Fields" });
    fireEvent.change(within(main).getByLabelText("Move Big TV"), { target: { value: "" } });
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/assignments", {
        method: "PUT",
        body: { session_id: 1, device_id: 7, group_id: null },
      })
    );
  });

  it("adds a pit group", async () => {
    renderRoute();
    fireEvent.change(await screen.findByLabelText("Pit group name"), { target: { value: "Hallway" } });
    fireEvent.click(screen.getByRole("button", { name: "Add pit group" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/pit-groups", {
        method: "POST",
        body: { session_id: 1, name: "Hallway", division_id: null },
      })
    );
  });

  it("builds and saves a pit rotation", async () => {
    renderRoute();
    const pit = await screen.findByRole("region", { name: "Pit TVs" });
    fireEvent.click(within(pit).getByLabelText("Rotate through screens"));
    fireEvent.click(within(pit).getByRole("button", { name: "Add screen" }));
    fireEvent.change(within(pit).getByLabelText("Screen 2"), { target: { value: "upcoming_matches" } });
    fireEvent.change(within(pit).getByLabelText("Seconds for screen 2"), { target: { value: "30" } });
    expect(within(pit).queryByLabelText("Seconds for screen 1")).not.toBeInTheDocument();
    fireEvent.click(within(pit).getByRole("button", { name: "Save rotation" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/52", {
        method: "PATCH",
        body: {
          rotation: [
            { screen: "teamwork_rankings", settings: {}, seconds: 20 },
            { screen: "upcoming_matches", settings: { count: 3, scope: "division" }, seconds: 30 },
          ],
        },
      })
    );
  });

  it("deletes a pit group after asking", async () => {
    renderRoute();
    const pit = await screen.findByRole("region", { name: "Pit TVs" });
    fireEvent.click(within(pit).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/displays/groups/52", { method: "DELETE" }));
  });

  it("copies another session's displays into an empty session and lists those it couldn't place", async () => {
    stub({ "POST /api/sessions/2/copy-displays": { unplaced: [{ device_id: 9, device_name: "Lost TV", source_group_name: "Field 3" }] } });
    renderRoute();
    fireEvent.change(await screen.findByLabelText("Session"), { target: { value: "2" } });
    const copy = await screen.findByRole("region", { name: "Copy displays" });
    fireEvent.change(within(copy).getByLabelText("Copy from"), { target: { value: "1" } });
    fireEvent.click(within(copy).getByRole("button", { name: "Copy displays" }));
    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/sessions/2/copy-displays", { method: "POST", body: { source_session_id: 1 } })
    );
    expect(await screen.findByText("Lost TV (was in Field 3)")).toBeInTheDocument();
  });
});
```

In `frontend/apps/admin/tests/unit/DevicesRoute.test.tsx`, add `display_group: null` to the `device()` builder's defaults and add a test:

```tsx
  it("shows each display's group", async () => {
    devices = [device({ id: 3, name: "Big TV", role: "display_device", display_group: "Main Fields" })];
    stub();
    renderRoute();
    const row = (await screen.findByText("Big TV")).closest("tr")!;
    expect(row).toHaveTextContent("Main Fields");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/DisplaysRoute.test.tsx tests/unit/DevicesRoute.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Write the hooks**

Create `frontend/apps/admin/src/displays/useDisplays.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, useRealtimeChannel, type RotationEntry, type ScreenSettings } from "@tournament-admin/shared";
import type { DisplaysRead } from "./types";

export function useDisplays(sessionId: number | null) {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      if (event.event === "display_changed" || event.event === "devices_changed") {
        void queryClient.invalidateQueries({ queryKey: ["displays"] });
      }
    },
  });
  return useQuery({
    queryKey: ["displays", sessionId],
    queryFn: () => apiRequest<DisplaysRead>(`/api/displays?session_id=${sessionId}`),
    enabled: sessionId !== null,
  });
}

export interface UnplacedDisplay {
  device_id: number;
  device_name: string;
  source_group_name: string;
}

export function useDisplayMutations(sessionId: number | null) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["displays"] });
  return {
    createPit: useMutation({
      mutationFn: (body: { name: string; division_id: number | null }) =>
        apiRequest("/api/displays/pit-groups", { method: "POST", body: { session_id: sessionId, ...body } }),
      onSuccess: refresh,
    }),
    updateGroup: useMutation({
      mutationFn: ({
        groupId,
        ...body
      }: {
        groupId: number;
        screen?: string;
        screen_settings?: ScreenSettings;
        rotation?: RotationEntry[] | null;
        division_id?: number | null;
        play_sounds?: boolean;
      }) => apiRequest(`/api/displays/groups/${groupId}`, { method: "PATCH", body }),
      onSuccess: refresh,
    }),
    deleteGroup: useMutation({
      mutationFn: (groupId: number) => apiRequest(`/api/displays/groups/${groupId}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
    assign: useMutation({
      mutationFn: ({ deviceId, groupId }: { deviceId: number; groupId: number | null }) =>
        apiRequest<DisplaysRead>("/api/displays/assignments", {
          method: "PUT",
          body: { session_id: sessionId, device_id: deviceId, group_id: groupId },
        }),
      onSuccess: refresh,
    }),
    identify: useMutation({
      mutationFn: (deviceId: number) => apiRequest(`/api/displays/${deviceId}/identify`, { method: "POST" }),
    }),
    copy: useMutation({
      mutationFn: (sourceSessionId: number) =>
        apiRequest<{ unplaced: UnplacedDisplay[] }>(`/api/sessions/${sessionId}/copy-displays`, {
          method: "POST",
          body: { source_session_id: sourceSessionId },
        }),
      onSuccess: refresh,
    }),
  };
}
```

- [ ] **Step 4: Write the display rows and the pit group editor**

Create `frontend/apps/admin/src/displays/DisplayRows.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import type { DisplayGroupRead, DisplayRef } from "./types";
import { useDisplayMutations } from "./useDisplays";

export function groupOptionLabel(t: (key: string, options?: Record<string, unknown>) => string, group: DisplayGroupRead, fieldSetName: (id: number | null) => string): string {
  if (group.kind === "audience") return t("displays.groupOption.audience", { name: group.name });
  if (group.kind === "field") return t("displays.groupOption.field", { fieldSet: fieldSetName(group.field_set_id), name: group.name });
  return t("displays.groupOption.pit", { name: group.name });
}

/** A list of displays with Identify and a selector that moves each one. */
export function DisplayRows({
  displays,
  groups,
  sessionId,
  currentGroupId,
  fieldSetName,
}: {
  displays: DisplayRef[];
  groups: DisplayGroupRead[];
  sessionId: number;
  currentGroupId: number | null;
  fieldSetName: (id: number | null) => string;
}) {
  const { t } = useTranslation();
  const { assign, identify } = useDisplayMutations(sessionId);
  if (displays.length === 0) return <p className="table__secondary">{t("displays.noDisplays")}</p>;
  return (
    <ul className="list-plain">
      {displays.map((display) => (
        <li key={display.device_id} className="list-row">
          <span className="list-row__main">{display.name}</span>
          <span className={`badge ${display.online ? "badge-success" : "badge-neutral"}`}>
            {display.online ? t("displays.online") : t("displays.offline")}
          </span>
          <button
            className="btn btn-small"
            type="button"
            aria-label={t("displays.identifyNamed", { name: display.name })}
            onClick={() => identify.mutate(display.device_id)}
          >
            {t("displays.identify")}
          </button>
          <select
            className="select"
            aria-label={
              currentGroupId === null
                ? t("displays.putInGroup", { name: display.name })
                : t("displays.moveNamed", { name: display.name })
            }
            value={currentGroupId === null ? "" : String(currentGroupId)}
            onChange={(event) =>
              assign.mutate({ deviceId: display.device_id, groupId: event.target.value === "" ? null : Number(event.target.value) })
            }
          >
            <option value="">{currentGroupId === null ? t("displays.chooseGroup") : t("displays.unassign")}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {groupOptionLabel(t, group, fieldSetName)}
              </option>
            ))}
          </select>
        </li>
      ))}
    </ul>
  );
}
```

Create `frontend/apps/admin/src/displays/PitGroupEditor.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PIT_SCREENS,
  ROTATION_SECONDS,
  SCROLLING_SCREENS,
  defaultSettings,
  isScreenKey,
  type RotationEntry,
} from "@tournament-admin/shared";
import { ScreenSettingsEditor } from "./ScreenSettingsEditor";
import type { DisplayGroupRead } from "./types";
import { useDisplayMutations } from "./useDisplays";

/** One screen, or an ordered rotation of screens, for a pit group. */
export function PitGroupEditor({ group }: { group: DisplayGroupRead }) {
  const { t } = useTranslation();
  const { updateGroup } = useDisplayMutations(group.session_id);
  const [rotating, setRotating] = useState(group.rotation !== null);
  const [draft, setDraft] = useState<RotationEntry[]>(
    () => group.rotation ?? [{ screen: group.screen ?? "teamwork_rankings", settings: group.screen_settings, seconds: ROTATION_SECONDS.default }]
  );
  const edit = (index: number, change: Partial<RotationEntry>) =>
    setDraft((rows) => rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  const move = (index: number, by: number) =>
    setDraft((rows) => {
      const next = [...rows];
      const [row] = next.splice(index, 1);
      next.splice(index + by, 0, row);
      return next;
    });

  return (
    <div>
      <fieldset className="settings-group">
        <legend className="field__label">{t("displays.pitMode")}</legend>
        <label className="choice">
          <input
            type="radio"
            name={`pit-mode-${group.id}`}
            checked={!rotating}
            onChange={() => {
              setRotating(false);
              updateGroup.mutate({ groupId: group.id, rotation: null });
            }}
          />{" "}
          {t("displays.oneScreen")}
        </label>
        <label className="choice">
          <input type="radio" name={`pit-mode-${group.id}`} checked={rotating} onChange={() => setRotating(true)} />{" "}
          {t("displays.rotate")}
        </label>
      </fieldset>

      {!rotating && (
        <>
          <div className="field">
            <label className="field__label" htmlFor={`pit-screen-${group.id}`}>
              {t("displays.screen")}
            </label>
            <select
              className="select"
              id={`pit-screen-${group.id}`}
              value={group.screen ?? ""}
              onChange={(event) => updateGroup.mutate({ groupId: group.id, screen: event.target.value })}
            >
              {PIT_SCREENS.map((key) => (
                <option key={key} value={key}>
                  {t(`displayScreens.${key}`)}
                </option>
              ))}
            </select>
          </div>
          <ScreenSettingsEditor
            screen={group.screen}
            kind="pit"
            settings={group.screen_settings}
            idPrefix={`pit-${group.id}`}
            onChange={(settings) => updateGroup.mutate({ groupId: group.id, screen_settings: settings })}
          />
        </>
      )}

      {rotating && (
        <>
          <ol className="list-plain">
            {draft.map((row, index) => {
              const number = index + 1;
              return (
                <li key={index} className="list-row">
                  <select
                    className="select"
                    aria-label={t("displays.screenNumber", { number })}
                    value={row.screen}
                    onChange={(event) => {
                      const screen = event.target.value;
                      edit(index, { screen, settings: isScreenKey(screen) ? defaultSettings(screen, "pit") : {} });
                    }}
                  >
                    {PIT_SCREENS.map((key) => (
                      <option key={key} value={key}>
                        {t(`displayScreens.${key}`)}
                      </option>
                    ))}
                  </select>
                  <ScreenSettingsEditor
                    screen={row.screen}
                    kind="pit"
                    settings={row.settings}
                    idPrefix={`rotation-${group.id}-${index}`}
                    onChange={(settings) => edit(index, { settings })}
                  />
                  {!(isScreenKey(row.screen) && SCROLLING_SCREENS.has(row.screen)) && (
                    <input
                      className="input settings-number"
                      type="number"
                      aria-label={t("displays.secondsFor", { number })}
                      min={ROTATION_SECONDS.min}
                      max={ROTATION_SECONDS.max}
                      value={row.seconds}
                      onChange={(event) => edit(index, { seconds: Number(event.target.value) })}
                    />
                  )}
                  <button className="btn btn-small" type="button" disabled={index === 0} onClick={() => move(index, -1)}>
                    {t("displays.moveUp")}
                  </button>
                  <button className="btn btn-small" type="button" disabled={index === draft.length - 1} onClick={() => move(index, 1)}>
                    {t("displays.moveDown")}
                  </button>
                  <button
                    className="btn btn-small btn-danger"
                    type="button"
                    disabled={draft.length === 1}
                    onClick={() => setDraft((rows) => rows.filter((_, i) => i !== index))}
                  >
                    {t("displays.removeScreen")}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="form-actions">
            <button
              className="btn"
              type="button"
              onClick={() =>
                setDraft((rows) => [...rows, { screen: "logo", settings: {}, seconds: ROTATION_SECONDS.default }])
              }
            >
              {t("displays.addScreen")}
            </button>
            <button className="btn btn-primary" type="button" onClick={() => updateGroup.mutate({ groupId: group.id, rotation: draft })}>
              {t("displays.saveRotation")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Write the page**

Create `frontend/apps/admin/src/routes/DisplaysRoute.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { AUDIENCE_SCREENS, apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DisplayRows } from "../displays/DisplayRows";
import { PitGroupEditor } from "../displays/PitGroupEditor";
import { ScreenSettingsEditor } from "../displays/ScreenSettingsEditor";
import type { DisplayGroupRead } from "../displays/types";
import { useDisplayMutations, useDisplays, type UnplacedDisplay } from "../displays/useDisplays";
import type { Division, EventRead, SessionRead } from "../types";

export function DisplaysRoute() {
  const { t } = useTranslation();
  const event = useQuery({ queryKey: ["event"], queryFn: () => apiRequest<EventRead>("/api/event") });
  const sessions = useQuery({ queryKey: ["sessions"], queryFn: () => apiRequest<SessionRead[]>("/api/sessions") });
  const divisions = useQuery({ queryKey: ["divisions"], queryFn: () => apiRequest<Division[]>("/api/divisions") });
  const [chosen, setChosen] = useState<number | null>(null);
  const sessionId = chosen ?? event.data?.active_session_id ?? sessions.data?.[0]?.id ?? null;
  const displays = useDisplays(sessionId);
  const mutations = useDisplayMutations(sessionId);
  const [pitName, setPitName] = useState("");
  const [pitDivision, setPitDivision] = useState("");
  const [copyFrom, setCopyFrom] = useState("");
  const [unplaced, setUnplaced] = useState<UnplacedDisplay[] | null>(null);
  const [deleting, setDeleting] = useState<DisplayGroupRead | null>(null);

  const data = displays.data;
  const groups = data?.groups ?? [];
  const fieldSetName = (id: number | null) => groups.find((g) => g.kind === "audience" && g.field_set_id === id)?.name ?? "";
  const audienceGroups = groups.filter((g) => g.kind === "audience");
  const pits = groups.filter((g) => g.kind === "pit");
  const failed = Object.values(mutations).find((m) => m.isError);

  function addPit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    mutations.createPit.mutate(
      { name: pitName.trim(), division_id: pitDivision === "" ? null : Number(pitDivision) },
      { onSuccess: () => setPitName("") }
    );
  }

  return (
    <div>
      <h1>{t("displays.heading")}</h1>
      <div className="field">
        <label className="field__label" htmlFor="displays-session">
          {t("displays.session")}
        </label>
        <select
          className="select"
          id="displays-session"
          value={sessionId ?? ""}
          onChange={(e) => {
            setChosen(Number(e.target.value));
            setUnplaced(null);
          }}
        >
          {sessions.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === event.data?.active_session_id ? t("displays.activeSession", { label: s.label }) : s.label}
            </option>
          ))}
        </select>
      </div>
      {failed && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(failed.error, t("errors.generic"))}
        </p>
      )}

      {data && !data.has_setup && (
        <section className="panel" role="region" aria-label={t("displays.copyHeading")}>
          <h2>{t("displays.copyHeading")}</h2>
          <p>{t("displays.copyHelp")}</p>
          <div className="toolbar">
            <div className="field">
              <label className="field__label" htmlFor="copy-from">
                {t("displays.copyFrom")}
              </label>
              <select className="select" id="copy-from" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
                <option value="">{t("displays.chooseSession")}</option>
                {sessions.data
                  ?.filter((s) => s.id !== sessionId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
              </select>
            </div>
            <button
              className="btn"
              type="button"
              disabled={copyFrom === "" || mutations.copy.isPending}
              onClick={() => mutations.copy.mutate(Number(copyFrom), { onSuccess: (result) => setUnplaced(result.unplaced) })}
            >
              {t("displays.copyAction")}
            </button>
          </div>
        </section>
      )}
      {unplaced && unplaced.length > 0 && (
        <div className="alert alert-warning" role="status">
          <p>{t("displays.unplacedHeading")}</p>
          <ul>
            {unplaced.map((u) => (
              <li key={u.device_id}>{t("displays.unplacedItem", { name: u.device_name, group: u.source_group_name })}</li>
            ))}
          </ul>
        </div>
      )}

      {sessionId !== null &&
        audienceGroups.map((audience) => {
          const fieldGroups = groups.filter((g) => g.kind === "field" && g.field_set_id === audience.field_set_id);
          return (
            <section key={audience.id} className="panel" role="region" aria-label={audience.name}>
              <h2>{audience.name}</h2>
              <h3>{t("displays.audienceHeading")}</h3>
              <div className="field">
                <label className="field__label" htmlFor={`audience-screen-${audience.id}`}>
                  {t("displays.audienceScreen")}
                </label>
                <select
                  className="select"
                  id={`audience-screen-${audience.id}`}
                  value={audience.screen ?? ""}
                  onChange={(e) => mutations.updateGroup.mutate({ groupId: audience.id, screen: e.target.value })}
                >
                  {AUDIENCE_SCREENS.map((key) => (
                    <option key={key} value={key}>
                      {t(`displayScreens.${key}`)}
                    </option>
                  ))}
                </select>
              </div>
              <ScreenSettingsEditor
                screen={audience.screen}
                kind="audience"
                settings={audience.screen_settings}
                idPrefix={`displays-audience-${audience.id}`}
                onChange={(settings) => mutations.updateGroup.mutate({ groupId: audience.id, screen_settings: settings })}
              />
              <label className="choice">
                <input
                  type="checkbox"
                  checked={audience.play_sounds}
                  onChange={(e) => mutations.updateGroup.mutate({ groupId: audience.id, play_sounds: e.target.checked })}
                />{" "}
                {t("displays.playSounds")}
              </label>
              <DisplayRows displays={audience.displays} groups={groups} sessionId={sessionId} currentGroupId={audience.id} fieldSetName={fieldSetName} />
              {fieldGroups.map((fieldGroup) => (
                <div key={fieldGroup.id}>
                  <h3>{fieldGroup.name}</h3>
                  <DisplayRows displays={fieldGroup.displays} groups={groups} sessionId={sessionId} currentGroupId={fieldGroup.id} fieldSetName={fieldSetName} />
                </div>
              ))}
            </section>
          );
        })}

      {sessionId !== null && (
        <section className="panel" aria-labelledby="pits-heading">
          <h2 id="pits-heading">{t("displays.pitsHeading")}</h2>
          <form className="toolbar" onSubmit={addPit}>
            <div className="field">
              <label className="field__label" htmlFor="pit-name">
                {t("displays.pitName")}
              </label>
              <input className="input" id="pit-name" value={pitName} onChange={(e) => setPitName(e.target.value)} />
            </div>
            {(divisions.data?.length ?? 0) > 1 && (
              <div className="field">
                <label className="field__label" htmlFor="pit-division">
                  {t("displays.pitDivision")}
                </label>
                <select className="select" id="pit-division" value={pitDivision} onChange={(e) => setPitDivision(e.target.value)}>
                  <option value="">{t("displays.allDivisions")}</option>
                  {divisions.data?.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <button className="btn" type="submit" disabled={pitName.trim() === "" || mutations.createPit.isPending}>
              {t("displays.addPit")}
            </button>
          </form>
          {pits.map((pit) => (
            <section key={pit.id} className="panel" role="region" aria-label={pit.name}>
              <h3>{pit.name}</h3>
              <PitGroupEditor key={`${pit.id}-${JSON.stringify(pit.rotation)}`} group={pit} />
              <DisplayRows displays={pit.displays} groups={groups} sessionId={sessionId} currentGroupId={pit.id} fieldSetName={fieldSetName} />
              <button className="btn btn-small btn-danger" type="button" onClick={() => setDeleting(pit)}>
                {t("displays.delete")}
              </button>
            </section>
          ))}
        </section>
      )}

      {data && sessionId !== null && (
        <section className="panel" role="region" aria-label={t("displays.unassignedHeading")}>
          <h2>{t("displays.unassignedHeading")}</h2>
          <DisplayRows displays={data.unassigned} groups={groups} sessionId={sessionId} currentGroupId={null} fieldSetName={fieldSetName} />
        </section>
      )}

      {deleting && (
        <ConfirmDialog
          heading={t("displays.deleteHeading")}
          body={t("displays.deleteBody", { name: deleting.name })}
          confirmLabel={t("displays.delete")}
          cancelLabel={t("displays.cancel")}
          isPending={mutations.deleteGroup.isPending}
          onConfirm={() => mutations.deleteGroup.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
```

(If `types.ts` has no `Division` with `id`/`name` or no `SessionRead` with `label`, use the existing names there; they exist today as `Division` and `SessionRead`.)

- [ ] **Step 6: Show each display's group on the Devices page**

In `devices/useDevices.ts` add `display_group: string | null;` to `DeviceRead`. In `DevicesRoute.tsx` add a column header after Role, `<th scope="col">{t("devices.columns.group")}</th>`, and a cell after the role cell: `<td>{device.role === "display_device" ? device.display_group ?? t("devices.noGroup") : ""}</td>`.

- [ ] **Step 7: Add the route, the nav link and the strings**

In `router.tsx` import `DisplaysRoute` and add `{ path: "displays", element: <DisplaysRoute /> },` after the `match-control` route. In `AppShell.tsx` add after the Match Control link:

```tsx
            <NavLink to="/displays" className={navLinkClassName}>
              {t("shell.displaysLink")}
            </NavLink>
```

Add to `en/admin.json`: `"displaysLink": "Displays"` in `"shell"`; `"group": "Group"` in `devices.columns`; `"noGroup": "Not set up"` in `"devices"`; and extend the top-level `"displays"` object (keep its `"settings"`):

```json
    "heading": "Displays",
    "session": "Session",
    "activeSession": "{{label}} (active)",
    "copyHeading": "Copy displays",
    "copyHelp": "Copy the screens, pit groups and display places from another session.",
    "copyFrom": "Copy from",
    "chooseSession": "Choose a session…",
    "copyAction": "Copy displays",
    "unplacedHeading": "These displays had no matching group here:",
    "unplacedItem": "{{name}} (was in {{group}})",
    "audienceHeading": "Audience",
    "audienceScreen": "Audience screen",
    "playSounds": "Play sounds",
    "pitsHeading": "Pit groups",
    "pitName": "Pit group name",
    "pitDivision": "Division",
    "allDivisions": "Every division",
    "addPit": "Add pit group",
    "pitMode": "Shows",
    "oneScreen": "One screen",
    "rotate": "Rotate through screens",
    "screen": "Screen",
    "screenNumber": "Screen {{number}}",
    "secondsFor": "Seconds for screen {{number}}",
    "moveUp": "Up",
    "moveDown": "Down",
    "removeScreen": "Remove",
    "addScreen": "Add screen",
    "saveRotation": "Save rotation",
    "delete": "Delete",
    "cancel": "Cancel",
    "deleteHeading": "Delete pit group",
    "deleteBody": "Delete {{name}}? Its displays become unassigned.",
    "unassignedHeading": "Unassigned displays",
    "noDisplays": "No displays here.",
    "online": "Online",
    "offline": "Offline",
    "identify": "Identify",
    "identifyNamed": "Identify {{name}}",
    "putInGroup": "Put {{name}} in a group",
    "moveNamed": "Move {{name}}",
    "chooseGroup": "Choose a group…",
    "unassign": "Unassigned",
    "groupOption": {
      "audience": "{{name}} (audience)",
      "field": "{{fieldSet}} › {{name}}",
      "pit": "{{name}} (pit)"
    },
```

And in `zh/admin.json`: `"displaysLink": "显示屏"`, `"group": "分组"`, `"noGroup": "未设置"`, and:

```json
    "heading": "显示屏",
    "session": "场次",
    "activeSession": "{{label}}（进行中）",
    "copyHeading": "复制显示屏设置",
    "copyHelp": "从另一个场次复制屏幕、观赛区分组和显示屏位置。",
    "copyFrom": "复制自",
    "chooseSession": "选择场次…",
    "copyAction": "复制显示屏设置",
    "unplacedHeading": "以下显示屏在这里没有对应的分组：",
    "unplacedItem": "{{name}}（原在 {{group}}）",
    "audienceHeading": "观众",
    "audienceScreen": "观众屏幕",
    "playSounds": "播放声音",
    "pitsHeading": "观赛区分组",
    "pitName": "观赛区分组名称",
    "pitDivision": "分组",
    "allDivisions": "所有分组",
    "addPit": "添加观赛区分组",
    "pitMode": "显示",
    "oneScreen": "单个屏幕",
    "rotate": "轮播多个屏幕",
    "screen": "屏幕",
    "screenNumber": "屏幕 {{number}}",
    "secondsFor": "屏幕 {{number}} 的秒数",
    "moveUp": "上移",
    "moveDown": "下移",
    "removeScreen": "移除",
    "addScreen": "添加屏幕",
    "saveRotation": "保存轮播",
    "delete": "删除",
    "cancel": "取消",
    "deleteHeading": "删除观赛区分组",
    "deleteBody": "删除 {{name}}？其显示屏将变为未分配。",
    "unassignedHeading": "未分配的显示屏",
    "noDisplays": "这里没有显示屏。",
    "online": "在线",
    "offline": "离线",
    "identify": "识别",
    "identifyNamed": "识别 {{name}}",
    "putInGroup": "将 {{name}} 放入分组",
    "moveNamed": "移动 {{name}}",
    "chooseGroup": "选择分组…",
    "unassign": "未分配",
    "groupOption": {
      "audience": "{{name}}（观众）",
      "field": "{{fieldSet}} › {{name}}",
      "pit": "{{name}}（观赛区）"
    },
```

If `AppShell.test.tsx` asserts the exact admin link list, add "Displays" to it.

- [ ] **Step 8: Run the tests and type check**

Run: `cd frontend/apps/admin && npx vitest run && npx tsc -b`
Expected: all pass.

- [ ] **Step 9: Commit**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit
git commit -m "Add the Displays page: each field group's audience screen, sounds and displays, pit groups with one screen or a rotation, unassigned displays with Identify and a group selector, a session picker, and copying displays from another session, and show each display's group on the Devices page.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 15: End-to-end tests

**Files:**
- Create: `frontend/apps/admin/tests/e2e/displays.spec.ts`

**Interfaces:**
- Consumes: everything above; `startIsolatedServer` with `devicePort`; `buildSampleCooperativePluginZip` from `tests/e2e/fixtures/buildPluginZip`.

The shipped sample game is cooperative (one alliance band, a single score field named `score`, no autonomous period, a 60-second driver period), which keeps this test short. Ports: backend 8133, admin Vite 5194, device Vite 5195.

- [ ] **Step 1: Write the spec**

Create `frontend/apps/admin/tests/e2e/displays.spec.ts`:

```ts
import fs from "node:fs";
import { test, expect, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { buildSampleCooperativePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "displays-e2e-pw";

test.describe.serial("display groups", () => {
  test.describe.configure({ timeout: 120_000 });

  let server: IsolatedServer;
  let token = "";
  let saturday = 0;
  let fieldOne = 0;
  const matches: Record<string, { id: number; alliances: { id: number; station: string }[] }> = {};
  const devices: Record<string, number> = {};
  const screens: Record<string, Page> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function call(request: APIRequestContext, method: "post" | "put" | "patch", route: string, data: unknown) {
    const response = await request[method](api(route), { headers: headers(), data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }

  async function pairDisplay(browser: Browser, request: APIRequestContext, name: string) {
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const code = (await page.getByTestId("pairing-code").textContent())!.replace(" ", "");
    const paired = await call(request, "post", "/api/devices/pair", { code, role: "display_device", name });
    devices[name] = paired.id;
    screens[name] = page;
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    return page;
  }

  async function adminPage(browser: Browser, path: string): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.baseUrl}${path}`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    return page;
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8133, frontendPort: 5194, devicePort: 5195 });
    expect((await request.post(api("/api/event"), { data: { name: "Display League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: headers(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildSampleCooperativePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    await call(request, "post", "/api/event/game-plugin", { name: "sample_cooperative" });
    const teams: number[] = [];
    for (const [number, name] of [["11A", "Alpha"], ["22B", "Bravo"], ["33C", "Charlie"], ["44D", "Delta"]]) {
      teams.push((await call(request, "post", "/api/teams", { number, name })).id);
    }
    saturday = (await call(request, "post", "/api/sessions", { label: "Saturday" })).id;
    await call(request, "post", "/api/event/active-session", { session_id: saturday });
    const fieldSet = (await call(request, "post", "/api/field-sets", { session_id: saturday, name: "Main Fields" })).id;
    fieldOne = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: fieldSet, name: "Field 1" })).id;
    const fieldTwo = (await call(request, "post", "/api/fields", { session_id: saturday, field_set_id: fieldSet, name: "Field 2" })).id;
    const start = Date.now() + 10 * 60_000;
    const plan: [string, number, number, number, number][] = [
      ["Q1", 1, fieldOne, 0, 1],
      ["Q2", 2, fieldTwo, 2, 3],
      ["Q3", 3, fieldOne, 1, 2],
      ["Q4", 4, fieldTwo, 3, 0],
    ];
    for (const [label, number, field, red, blue] of plan) {
      matches[label] = await call(request, "post", "/api/matches", {
        session_id: saturday,
        round_type: "qualification",
        match_number: number,
        field_id: field,
        scheduled_time: new Date(start + number * 5 * 60_000).toISOString(),
        alliances: [
          { station: "red", team_ids: [teams[red]] },
          { station: "blue", team_ids: [teams[blue]] },
        ],
      });
    }
  });

  test.afterAll(() => server?.stop());

  test("an unassigned display shows its name, and the Displays page places it", async ({ browser, request }) => {
    const fieldTv = await pairDisplay(browser, request, "Field TV");
    await expect(fieldTv.getByText("Not set up for this session")).toBeVisible();
    await pairDisplay(browser, request, "Big TV");

    const admin = await adminPage(browser, "/displays");
    await expect(admin.getByRole("heading", { name: "Displays", level: 1 })).toBeVisible();
    const unassigned = admin.getByRole("region", { name: "Unassigned displays" });
    await unassigned.getByLabel("Put Field TV in a group").selectOption({ label: "Main Fields › Field 1" });
    await expect(admin.getByRole("region", { name: "Main Fields" }).getByText("Field TV")).toBeVisible();
    await admin
      .getByRole("region", { name: "Unassigned displays" })
      .getByLabel("Put Big TV in a group")
      .selectOption({ label: "Main Fields (audience)" });

    await expect(fieldTv.getByRole("heading", { name: "Qualification 1" })).toBeVisible({ timeout: 10_000 });
    await expect(fieldTv.getByTestId("bar-all")).toContainText("11A");
    await expect(fieldTv.getByTestId("start")).toHaveAttribute("data-band", "early");
    await expect(screens["Big TV"].getByRole("heading", { name: "Display League" })).toBeVisible({ timeout: 10_000 });
  });

  test("Match Control starts the next match and the audience switches to In Match", async ({ browser }) => {
    const admin = await adminPage(browser, "/match-control");
    await expect(admin.getByRole("region", { name: "Next match" }).getByText("Q1 · Field 1")).toBeVisible();
    await admin.getByRole("button", { name: "Start", exact: true }).click();
    await expect(screens["Big TV"].getByTestId("count-in").or(screens["Big TV"].getByTestId("clock"))).toBeVisible({ timeout: 10_000 });
    await expect(screens["Field TV"].getByTestId("count-in").or(screens["Field TV"].getByTestId("clock"))).toBeVisible();
    await expect(screens["Big TV"].getByText("Driver control")).toBeVisible({ timeout: 10_000 });

    const timer = admin.getByRole("region", { name: "Timer" });
    await timer.getByRole("button", { name: "End early" }).click();
    await admin.getByRole("alertdialog").getByRole("button", { name: "End early" }).click();
    await expect(screens["Field TV"].getByText("Match over")).toBeVisible({ timeout: 10_000 });
    await expect(screens["Big TV"].getByText("Match over")).toBeVisible();
  });

  test("saving the score moves the field display on and Last Scored Match shows it", async ({ browser, request }) => {
    const red = matches.Q1.alliances.find((a) => a.station === "red")!;
    await call(request, "post", `/api/matches/${matches.Q1.id}/alliances/${red.id}/score`, { data: { score: 42 } });
    await expect(screens["Field TV"].getByRole("heading", { name: "Qualification 3" })).toBeVisible({ timeout: 10_000 });

    const admin = await adminPage(browser, "/match-control");
    const audience = admin.getByRole("region", { name: "Audience screen" });
    await audience.getByRole("button", { name: "Last Scored Match" }).click();
    await expect(screens["Big TV"].getByRole("heading", { name: "Qualification 1" })).toBeVisible({ timeout: 10_000 });
    await expect(screens["Big TV"].getByTestId("score-all")).toHaveText("42");
  });

  test("an override changes what Start begins", async ({ browser, request }) => {
    const admin = await adminPage(browser, "/match-control");
    const next = admin.getByRole("region", { name: "Next match" });
    await expect(next.getByText("Q2 · Field 2")).toBeVisible();
    await next.getByRole("button", { name: "Change" }).click();
    await next.getByLabel("Queue match").selectOption({ label: "Q4 · Field 2" });
    await expect(next.getByText("Q4 · Field 2")).toBeVisible();
    await admin.getByRole("button", { name: "Start", exact: true }).click();
    await expect(screens["Big TV"].getByRole("heading", { name: "Qualification 4" })).toBeVisible({ timeout: 10_000 });
    await call(request, "post", `/api/matches/${matches.Q4.id}/end`, {});
  });

  test("a time-out shows on the field display and clears", async ({ browser }) => {
    const admin = await adminPage(browser, "/match-control");
    const timeout = admin.getByRole("region", { name: "Time-out" });
    await timeout.getByLabel("Length in seconds").fill("60");
    await timeout.getByRole("button", { name: "Start time-out" }).click();
    await expect(screens["Field TV"].getByRole("heading", { name: "Time-out" })).toBeVisible({ timeout: 10_000 });
    await timeout.getByRole("button", { name: "Cancel time-out" }).click();
    await expect(screens["Field TV"].getByRole("heading", { name: "Time-out" })).toHaveCount(0, { timeout: 10_000 });
  });

  test("a pit rotation moves to its next screen", async ({ request }) => {
    const pit = await call(request, "post", "/api/displays/pit-groups", { session_id: saturday, name: "Pits" });
    await call(request, "patch", `/api/displays/groups/${pit.id}`, {
      rotation: [
        { screen: "logo", seconds: 5 },
        { screen: "upcoming_matches", seconds: 5 },
      ],
    });
    await call(request, "put", "/api/displays/assignments", { session_id: saturday, device_id: devices["Big TV"], group_id: pit.id });
    await expect(screens["Big TV"].getByRole("heading", { name: "Display League" })).toBeVisible({ timeout: 10_000 });
    await expect(screens["Big TV"].getByRole("heading", { name: "Upcoming Matches" })).toBeVisible({ timeout: 15_000 });
  });

  test("copying displays into a new session keeps every display in its place", async ({ browser, request }) => {
    const sunday = (await call(request, "post", "/api/sessions", { label: "Sunday" })).id;
    await call(request, "post", `/api/sessions/${sunday}/copy-fields`, { source_session_id: saturday });
    const admin = await adminPage(browser, "/displays");
    await admin.getByLabel("Session").selectOption({ label: "Sunday" });
    const copy = admin.getByRole("region", { name: "Copy displays" });
    await copy.getByLabel("Copy from").selectOption({ label: "Saturday" });
    await copy.getByRole("button", { name: "Copy displays" }).click();
    await expect(admin.getByRole("region", { name: "Main Fields" }).getByText("Field TV")).toBeVisible();

    await call(request, "post", "/api/event/active-session", { session_id: sunday });
    await expect(screens["Field TV"].getByText("No more matches on this field")).toBeVisible({ timeout: 10_000 });
    await expect(screens["Big TV"].getByRole("heading", { name: "Display League" })).toBeVisible({ timeout: 10_000 });
  });
});
```

Playwright matches `name` as a substring unless `exact: true` is set, so the Start button is always found with `{ name: "Start", exact: true }` (otherwise "Start time-out" also matches).

- [ ] **Step 2: Run the new spec**

Run: `cd frontend/apps/admin && npx playwright test tests/e2e/displays.spec.ts`
Expected: all tests pass. If a step fails on a label, match the label to the UI rather than the UI to the test, unless the UI contradicts the spec.

- [ ] **Step 3: Run the whole E2E suite**

Run: `cd frontend/apps/admin && npx playwright test`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/admin/tests/e2e/displays.spec.ts
git commit -m "Test display groups end to end: placing displays from the Displays page, Match Control starting a match and the audience switching to In Match, the field display moving on after the score, the next-match override, a time-out, a pit rotation, and copying displays into a new session.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 16: Documentation

**Files:**
- Modify: `server/CLAUDE.md`, `frontend/CLAUDE.md`, `PRODUCT.md`
- Modify: `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md` (§10 entry)
- Modify: `docs/superpowers/specs/2026-10-15-display-groups-design.md` (status line)

- [ ] **Step 1: `server/CLAUDE.md`**

Add a `## Display groups` section after `## Device pairing`, covering, in the file's existing style:
- the three kinds and their lifecycle (created and deleted with field sets and fields, including copy-fields and session deletion; the startup self-heal `ensure_all_groups`);
- `display_assignments` (one per session and device, displays only, dropped on device delete or role change);
- the screen registry in `services/display_screens.py` (keys, kinds, `upcoming_matches` settings, rotation rules and limits) and that adding a screen is a registry line, a device module and an admin label;
- the endpoints in spec §8, including `GET /api/displays/me`, copy-displays' refusals and matching rules;
- `field_sets.queued_match_id` (a plain integer, cleared by `delete_matches`, on start and on completion) and `timeout_deadline` (10–600 s, cleared by a match start);
- the start guard (one running match per field group) and the automatic switch of audience groups to `in_match`;
- `GET /api/scores`, `GET /api/finals`, `GET /api/event/scoresheet-schema`, and the new `MatchFormatRead` and `MatchRead` fields.

In `### Event catalog`, add `display_changed`, `field_set_changed` and `display_identify` with their payloads and channels. In `## Real-time channels and live match control`, note `realtime.send_to_device`.

- [ ] **Step 2: `frontend/CLAUDE.md`**

In the **Device app** paragraph, add display mode: `DisplayApp`/`DisplayRoot`, `GET /api/displays/me`, the live-event refresh map, the server clock offset, the screen registry in `src/display/screens/registry.ts` (unknown keys show Logo), `useAutoScroll` and the rotation runner, `TimeoutGate`, and audience sounds with the click-to-enable note. Fill in the device-app follow-ups parked in memory: the 1008 recheck, the unreachable banner (a corner badge in display mode) and the in-memory token fallback.

Add **Match Control** and **Displays** paragraphs to "Routes and role-gated nav", and add `displays.spec.ts` (8133/5194/5195, with the device app) to the isolated-server list in "Testing". Mention that `packages/shared/src/display/` holds the match-order and clock rules both apps use.

- [ ] **Step 3: `PRODUCT.md` and the specs**

In `PRODUCT.md`, describe displays: audience, field and pit groups, Match Control, and the Displays page, in the file's existing voice. In the core spec's §10 gap list, under "Display groups and screens", add a line that the first part is built (see `2026-10-15-display-groups-design.md`) and what remains for later (spec §11). Change the display groups spec's status line to `**Status:** implemented 2026-10-xx on branch display-groups.` with the actual date.

- [ ] **Step 4: Check for brand names**

Run `git diff master --stat`, then read the whole diff of this branch (`git diff master`) and confirm that no real-world competition brand or product name appears in any code, comment, test, string or document (the root `CLAUDE.md`'s hard constraint). Reference tools are only ever "a closed-source reference tool".

- [ ] **Step 5: Commit**

```bash
git add server/CLAUDE.md frontend/CLAUDE.md PRODUCT.md docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md docs/superpowers/specs/2026-10-15-display-groups-design.md
git commit -m "Document display groups: the server's groups, screen registry, Match Control endpoints and live events, the device app's display mode, the Match Control and Displays pages, and the new end-to-end test.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
