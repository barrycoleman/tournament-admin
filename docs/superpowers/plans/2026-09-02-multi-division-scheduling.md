# Multi-Division Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two Divisions in the same Session each generate their own schedule via `POST /api/schedule` without colliding on fields or `time_slot`s, by making `FieldSet` assignable to a `Division` and scoping schedule generation's FieldSet/Field lookup by that assignment.

**Architecture:** `FieldSet` gains a nullable `division_id` FK (mirroring `Team.division_id`'s existing single-nullable-FK precedent — no many-to-many). `POST /api/field-sets` accepts it at creation; a new `PATCH /api/field-sets/{id}` lets it be set or cleared afterward. `POST /api/schedule`'s FieldSet/Field query becomes division-aware: a division-scoped generation only ever sees that division's own FieldSets, a no-division generation only ever sees unassigned ones. Nothing else about schedule generation changes — `time_slot` numbering, round-robin field assignment within a FieldSet, and `time_blocks`/cycle-time resolution were already correctly scoped by `Team.division_id`.

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy 2.0 (synchronous, `Mapped`/`mapped_column`), SQLite, Pydantic v2, pytest, httpx.

**Spec:** `docs/superpowers/specs/2026-09-02-multi-division-scheduling-design.md`

## Global Constraints

- No brand names anywhere in code, comments, docs, filenames, or commit messages.
- Python 3.11+ / FastAPI / SQLAlchemy 2.0 style, matching existing codebase conventions.
- No database migrations — this is a schema change (new nullable column on `field_sets`) on top of every prior phase's own changes; no real deployed event data exists yet, so a pre-this-phase database is recreated (delete the `.db` file), not migrated.
- `FieldSet.division_id` is a single nullable FK, not a many-to-many relationship — mirrors `Team.division_id`'s existing precedent. A FieldSet can structurally never belong to two Divisions at once.
- `PATCH /api/field-sets/{id}`'s `division_id` key is required in the request body (no default) — the caller must always state the intended value explicitly (an id, or `null` to clear), avoiding partial-update ambiguity.
- Reassigning a FieldSet's division never touches already-created `Match` rows — it only affects which *future* `POST /api/schedule` calls will consider that FieldSet. No blocking check against "this FieldSet already has matches" is needed anywhere.
- `time_slot` numbering, round-robin field assignment within a FieldSet, and `time_blocks`/cycle-time resolution are unchanged by this plan — do not modify `services/schedule_timing.py` or the parts of `routers/schedule.py` that build `Match` rows from the plugin's returned schedule.

---

### Task 1: `FieldSet.division_id` — data model, creation, and read shape

**Files:**
- Modify: `server/src/tournament_server/models/field_set.py`
- Modify: `server/src/tournament_server/schemas/field_set.py`
- Modify: `server/src/tournament_server/routers/field_sets.py`
- Test: `server/tests/test_field_sets.py`

**Interfaces:**
- Produces: `FieldSet.division_id: int | None`; `FieldSetCreate.division_id: int | None = None`; `FieldSetRead.division_id: int | None`.
- Consumes: existing `Division` model (`tournament_server.models.division.Division`, `id: int` primary key); existing `TournamentSession` validate-or-404 pattern already present in `create_field_set` (`db.get(TournamentSession, payload.session_id)`).

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_field_sets.py`:

```python
def test_create_field_set_with_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]

    response = client.post(
        "/api/field-sets",
        json={
            "session_id": session_id,
            "name": "Red Fields",
            "division_id": division_id,
        },
    )
    assert response.status_code == 201
    assert response.json()["division_id"] == division_id


def test_create_field_set_without_division_defaults_to_none(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Main Fields"}
    )
    assert response.status_code == 201
    assert response.json()["division_id"] is None


def test_create_field_set_rejects_unknown_division(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Main Fields", "division_id": 999},
    )
    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_field_sets.py -v` (from `server/`)
Expected: 3 new FAILs. `test_create_field_set_with_division` fails because the response has no `division_id` key yet (`KeyError`). `test_create_field_set_without_division_defaults_to_none` fails the same way. `test_create_field_set_rejects_unknown_division` fails because the unknown `division_id` in the request body is currently silently ignored (Pydantic drops the undeclared field) and the create succeeds with 201, not 404.

- [ ] **Step 3: Add the column to the model**

`server/src/tournament_server/models/field_set.py` currently:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class FieldSet(Base):
    __tablename__ = "field_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    name: Mapped[str] = mapped_column(String(200))
```

Change to:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class FieldSet(Base):
    __tablename__ = "field_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    name: Mapped[str] = mapped_column(String(200))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
```

- [ ] **Step 4: Add the field to the schemas**

`server/src/tournament_server/schemas/field_set.py` currently:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FieldSetCreate(BaseModel):
    session_id: int
    name: str


class FieldSetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    name: str
```

Change to:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FieldSetCreate(BaseModel):
    session_id: int
    name: str
    division_id: int | None = None


class FieldSetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    name: str
    division_id: int | None
```

- [ ] **Step 5: Validate `division_id` and pass it through on create**

`server/src/tournament_server/routers/field_sets.py` currently:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field_set import FieldSetCreate, FieldSetRead

router = APIRouter(prefix="/api/field-sets", tags=["field-sets"])


@router.post("", response_model=FieldSetRead, status_code=201)
def create_field_set(payload: FieldSetCreate, db: Session = Depends(get_db)) -> FieldSet:
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    field_set = FieldSet(session_id=payload.session_id, name=payload.name)
    db.add(field_set)
    db.commit()
    db.refresh(field_set)
    return field_set
```

Change to:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id
from tournament_server.models.division import Division
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field_set import FieldSetCreate, FieldSetRead

router = APIRouter(prefix="/api/field-sets", tags=["field-sets"])


@router.post("", response_model=FieldSetRead, status_code=201)
def create_field_set(payload: FieldSetCreate, db: Session = Depends(get_db)) -> FieldSet:
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")
    field_set = FieldSet(
        session_id=payload.session_id,
        name=payload.name,
        division_id=payload.division_id,
    )
    db.add(field_set)
    db.commit()
    db.refresh(field_set)
    return field_set
```

`list_field_sets` below this needs no change — `FieldSetRead`'s `from_attributes` config means `division_id` is now included automatically on every response, including from `list_field_sets`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest tests/test_field_sets.py -v`
Expected: PASS, 6 total (3 existing + 3 new).

- [ ] **Step 7: Run the full suite**

Run: `pytest tests/ -q` (from `server/`)
Expected: 224 passed (221 baseline + 3 new). No migration needed — if a stale local dev `.db` file exists, delete it; the test suite always uses a fresh temp database per test regardless.

- [ ] **Step 8: Commit**

```bash
git add src/tournament_server/models/field_set.py src/tournament_server/schemas/field_set.py src/tournament_server/routers/field_sets.py tests/test_field_sets.py
git commit -m "Add FieldSet.division_id, accepted on creation and returned in reads"
```

---

### Task 2: `PATCH /api/field-sets/{field_set_id}`

**Files:**
- Modify: `server/src/tournament_server/schemas/field_set.py`
- Modify: `server/src/tournament_server/routers/field_sets.py`
- Test: `server/tests/test_field_sets.py`

**Interfaces:**
- Consumes: `FieldSet.division_id`, `FieldSetRead` (Task 1).
- Produces: `FieldSetUpdate` schema (`division_id: int | None`, required key, no default); `PATCH /api/field-sets/{field_set_id}` endpoint returning `FieldSetRead`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_field_sets.py`:

```python
def test_patch_field_set_sets_division(client):
    session_id = _make_session(client)
    field_set_id = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Main Fields"}
    ).json()["id"]
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]

    response = client.patch(
        f"/api/field-sets/{field_set_id}", json={"division_id": division_id}
    )
    assert response.status_code == 200
    assert response.json()["division_id"] == division_id


def test_patch_field_set_clears_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    field_set_id = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Red Fields", "division_id": division_id},
    ).json()["id"]

    response = client.patch(
        f"/api/field-sets/{field_set_id}", json={"division_id": None}
    )
    assert response.status_code == 200
    assert response.json()["division_id"] is None


def test_patch_field_set_rejects_unknown_field_set(client):
    response = client.patch("/api/field-sets/999", json={"division_id": None})
    assert response.status_code == 404


def test_patch_field_set_rejects_unknown_division(client):
    session_id = _make_session(client)
    field_set_id = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Main Fields"}
    ).json()["id"]

    response = client.patch(
        f"/api/field-sets/{field_set_id}", json={"division_id": 999}
    )
    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_field_sets.py -v`
Expected: 4 new FAILs — `PATCH /api/field-sets/{id}` doesn't exist yet, so FastAPI returns 405 Method Not Allowed for all four requests.

- [ ] **Step 3: Add the update schema**

In `server/src/tournament_server/schemas/field_set.py`, add `FieldSetUpdate` between `FieldSetCreate` and `FieldSetRead`:

```python
class FieldSetUpdate(BaseModel):
    division_id: int | None
```

(No default — the field is required in the request body, so the caller must always state the intended value explicitly.)

- [ ] **Step 4: Add the PATCH endpoint**

In `server/src/tournament_server/routers/field_sets.py`, update the import to include `FieldSetUpdate`:

```python
from tournament_server.schemas.field_set import FieldSetCreate, FieldSetRead, FieldSetUpdate
```

Add this endpoint after `create_field_set`:

```python
@router.patch("/{field_set_id}", response_model=FieldSetRead)
def update_field_set(
    field_set_id: int, payload: FieldSetUpdate, db: Session = Depends(get_db)
) -> FieldSet:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")
    field_set.division_id = payload.division_id
    db.commit()
    db.refresh(field_set)
    return field_set
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pytest tests/test_field_sets.py -v`
Expected: PASS, 10 total (6 from Task 1 + 4 new).

- [ ] **Step 6: Run the full suite**

Run: `pytest tests/ -q`
Expected: 228 passed (224 + 4 new).

- [ ] **Step 7: Commit**

```bash
git add src/tournament_server/schemas/field_set.py src/tournament_server/routers/field_sets.py tests/test_field_sets.py
git commit -m "Add PATCH /api/field-sets/{id} to set or clear a FieldSet's division"
```

---

### Task 3: `POST /api/schedule`'s FieldSet/Field resolution becomes division-aware

**Files:**
- Modify: `server/src/tournament_server/routers/schedule.py`
- Test: `server/tests/test_schedule.py`

**Interfaces:**
- Consumes: `FieldSet.division_id` (Task 1).
- Produces: no new function signatures — only `generate_schedule`'s internal FieldSet/Field query and its "no FieldSets configured" error message change.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_schedule.py`:

```python
def test_generate_schedule_scopes_field_sets_to_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    division_red = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    division_blue = client.post("/api/divisions", json={"name": "Blue"}).json()["id"]

    field_set_red = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Red Fields", "division_id": division_red},
    ).json()["id"]
    field_set_blue = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Blue Fields", "division_id": division_blue},
    ).json()["id"]
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Red Field 1", "field_set_id": field_set_red},
    )
    client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Blue Field 1", "field_set_id": field_set_blue},
    )

    for i in range(4):
        team_id = client.post(
            "/api/teams",
            json={
                "number": f"R{i + 1}",
                "name": f"Red Team {i + 1}",
                "division_id": division_red,
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    for i in range(4):
        team_id = client.post(
            "/api/teams",
            json={
                "number": f"B{i + 1}",
                "name": f"Blue Team {i + 1}",
                "division_id": division_blue,
            },
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

    red_response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "division_id": division_red,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert red_response.status_code == 201

    blue_response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "division_id": division_blue,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert blue_response.status_code == 201

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    red_matches = [m for m in matches if m["division_id"] == division_red]
    blue_matches = [m for m in matches if m["division_id"] == division_blue]
    assert red_matches
    assert blue_matches

    fields = client.get(f"/api/fields?session_id={session_id}").json()
    red_field_id = next(f["id"] for f in fields if f["name"] == "Red Field 1")
    blue_field_id = next(f["id"] for f in fields if f["name"] == "Blue Field 1")

    assert {m["field_id"] for m in red_matches} == {red_field_id}
    assert {m["field_id"] for m in blue_matches} == {blue_field_id}


def test_generate_schedule_rejects_division_with_no_field_set(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    other_division_id = client.post("/api/divisions", json={"name": "Blue"}).json()["id"]

    # A FieldSet exists in the session, but it belongs to a different
    # division — Red has none of its own. Pre-fix, this FieldSet would be
    # found anyway (the query ignored division entirely), so this must
    # fail even though a FieldSet technically exists in the session.
    other_field_set_id = client.post(
        "/api/field-sets",
        json={
            "session_id": session_id,
            "name": "Blue Fields",
            "division_id": other_division_id,
        },
    ).json()["id"]
    client.post(
        "/api/fields",
        json={
            "session_id": session_id,
            "name": "Blue Field 1",
            "field_set_id": other_field_set_id,
        },
    )

    for i in range(4):
        team_id = client.post(
            "/api/teams",
            json={"number": str(i + 1), "name": f"Team {i + 1}", "division_id": division_id},
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "division_id": division_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 422


def test_generate_schedule_without_division_only_uses_unassigned_field_sets(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    plugins = client.get("/api/plugins/games").json()
    client.post("/api/event/game-plugin", json={"name": plugins[0]["name"]})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    red_field_set_id = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Red Fields", "division_id": division_id},
    ).json()["id"]
    client.post(
        "/api/fields",
        json={
            "session_id": session_id,
            "name": "Red Field 1",
            "field_set_id": red_field_set_id,
        },
    )

    unassigned_field_set_id = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Unassigned Fields"}
    ).json()["id"]
    client.post(
        "/api/fields",
        json={
            "session_id": session_id,
            "name": "Unassigned Field",
            "field_set_id": unassigned_field_set_id,
        },
    )

    for i in range(4):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

    response = client.post(
        "/api/schedule",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "target_matches_per_team": 1,
            "scheduler_plugin_name": "simple_random",
        },
    )
    assert response.status_code == 201

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    fields = client.get(f"/api/fields?session_id={session_id}").json()
    unassigned_field_id = next(f["id"] for f in fields if f["name"] == "Unassigned Field")

    assert matches
    for match in matches:
        assert match["field_id"] == unassigned_field_id
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest tests/test_schedule.py -v`
Expected: 3 new FAILs. `test_generate_schedule_scopes_field_sets_to_division` fails because today's `generate_schedule` pulls in *every* FieldSet in the session for both calls, so the Blue division's fields end up used by Red matches too (the field-id assertions fail). `test_generate_schedule_rejects_division_with_no_field_set` fails because today's query never checks division assignment at all — it would find "Blue Fields" (the only FieldSet in the session) regardless of the fact it belongs to a different division, and successfully generate Red's schedule onto Blue's field (201, not the expected 422). `test_generate_schedule_without_division_only_uses_unassigned_field_sets` fails because today's query would also include "Red Fields" (ignoring the fact it's meant to be Red's own), so a match could land on `red_field_set_id`'s field, not only the unassigned one.

- [ ] **Step 3: Scope the FieldSet/Field query by division**

In `server/src/tournament_server/routers/schedule.py`, find (currently around line 175):

```python
    field_sets = db.execute(
        select(FieldSet).where(FieldSet.session_id == payload.session_id)
    ).scalars().all()
    if not field_sets:
        raise HTTPException(status_code=422, detail="Session has no FieldSets configured")
    fields = db.execute(
        select(Field).where(Field.field_set_id.in_([fs.id for fs in field_sets]))
    ).scalars().all()
    if not fields:
        raise HTTPException(status_code=422, detail="Session has no Fields configured")
```

Replace with:

```python
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
```

Nothing else in `generate_schedule` changes — `fields_by_set`, the round-robin `next_field_index` loop, `time_slot`/`scheduled_time` assignment, and the plugin call all already operate purely on this `field_sets`/`fields` result, so scoping it correctly here is the entire fix.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest tests/test_schedule.py -v`
Expected: PASS, 25 total (22 existing + 3 new).

- [ ] **Step 5: Run the full suite**

Run: `pytest tests/ -q`
Expected: 231 passed (228 + 3 new).

- [ ] **Step 6: Commit**

```bash
git add src/tournament_server/routers/schedule.py tests/test_schedule.py
git commit -m "Scope POST /api/schedule's FieldSets to the requested division"
```

---

### Task 4: Documentation

**Files:**
- Modify: `server/CLAUDE.md`

**Interfaces:**
- Consumes: Tasks 1-3 (documents their shipped behavior). Produces nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Run the baseline test count**

Run: `pytest tests/ -q` (from `server/`)
Expected: 231 passed (this must not change — this is a documentation-only task).

- [ ] **Step 2: Add a "Multi-division scheduling" section**

In `server/CLAUDE.md`, find the `## Time-based scheduling` section and its content (ending just before `## Known, deliberate gaps in this phase`). Insert this new section immediately after the `Time-based scheduling` section's last paragraph (the one about `cycle_time_warning`) and before `## Known, deliberate gaps in this phase`:

```markdown
## Multi-division scheduling

A `FieldSet` can be assigned exclusively to one `Division` via
`division_id` (set on `POST /api/field-sets`, or changed later via
`PATCH /api/field-sets/{id}` — the request body's `division_id` key is
required, so the caller always states the intended value: an id to
assign, or `null` to clear). `POST /api/schedule` only ever draws its
FieldSets/Fields from this assignment: a division-scoped generation
(`division_id` given) only considers that division's own FieldSets; a
no-division generation (`division_id` omitted) only considers unassigned
FieldSets. This is what lets two Divisions in the same Session each
generate their own schedule without colliding on fields or `time_slot`s
— each division's schedule generation, its `time_slot` numbering, and
its `time_blocks`/cycle-time resolution were already correctly scoped by
`Team.division_id`; only the FieldSet lookup itself was blind to which
division a call was for.

A FieldSet's single nullable `division_id` makes true double-assignment
structurally impossible — reassigning it after the fact only affects
which *future* `POST /api/schedule` calls will consider that FieldSet,
never any already-created `Match`.
```

- [ ] **Step 3: Remove the now-fixed "known gap" bullet**

In the `## Known, deliberate gaps in this phase` section, find and delete this bullet in full (it describes exactly the bug this plan fixes):

```markdown
- Scheduling two Divisions within the same Session currently produces a
  broken schedule. Each `POST /api/schedule` call is self-contained — it
  restarts `time_slot` numbering at 0 and round-robins fields starting
  from the session's lowest field id, with no way to scope a generation
  to a subset of the session's FieldSets. Two divisions scheduled in the
  same session will collide on both fields and time_slots, even though
  FieldSets running concurrently is exactly the scenario `time_slot`
  exists to keep safe within one generation call. A real fix needs a way
  to scope a `POST /api/schedule` call to specific FieldSets (or
  session-wide slot/field arbitration across all divisions), which is
  real design work, not a bounded bugfix — deferred to a later phase. For
  now, an event with multiple divisions that need concurrent physical
  fields in the same session should not use this endpoint for more than
  one division per session until that's built.
```

Leave every other bullet in that section untouched.

- [ ] **Step 4: Run the full suite**

Run: `pytest tests/ -q`
Expected: 231 passed (unchanged — this is a documentation-only change).

- [ ] **Step 5: Commit**

```bash
git add server/CLAUDE.md
git commit -m "Document multi-division scheduling and remove the now-fixed known gap"
```
