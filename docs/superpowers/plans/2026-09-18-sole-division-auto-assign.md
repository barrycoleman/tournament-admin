# Sole-Division Auto-Assign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Whenever an event has exactly one division, every team belongs to it — no team is ever left showing as unassigned (and that division's team count never reads misleadingly low) purely because nothing explicitly picked a division for it.

**Architecture:** One small, reusable service function (`assign_sole_division`) that no-ops unless an event has exactly one division, in which case it assigns every currently-unassigned team in that event to it. Call it from the four places a team can end up divisionless while a sole division exists: bulk upsert (the CSV-upload/grid-save path — this is the bug the user reported), single team creation, division deletion (which can reduce a 2-division event down to exactly one), and the existing app-startup self-heal (which already exists for the "every event has ≥1 division" invariant and is the natural place to also close this gap for pre-existing databases). No schema change and no new migration are needed — this is a data-consistency fix, not a structural one, and the existing self-heal step is sufficient to fix any already-affected database on its next server launch.

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy (backend only — this change has no frontend component; the Divisions page's team count and the Teams grid's division column already read `division_id` directly, so once the backend sets it correctly, both displays correct themselves with no code change).

**Spec:** None — this was classified as a Bounded change per the brainstorming skill (all four call sites already exist and were read directly, not designed from scratch). The agreed design was presented and approved in chat; this plan is its only written record.

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit/integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database in the same change — never mocked at the HTTP boundary.
- This fix is scoped to *implicit* divisionless-ness only (a team created with no division specified, or left divisionless by a division's deletion). It must never override an admin's *explicit* action to unassign a team via `PATCH /api/teams/{id}` with `division_id: null` — that call site is deliberately untouched by this plan.
- `services/team_assignment.py` already holds this project's team/division assignment logic (`balanced_assign`); the new function belongs in the same file, not scattered into a router.

---

### Task 1: Add `assign_sole_division` and cover it with unit tests

**Files:**
- Modify: `server/src/tournament_server/services/team_assignment.py`
- Modify: `server/tests/test_team_assignment.py` (already exists — four plain-function tests for `balanced_assign`, no database, no `Session`/`tmp_path` fixtures; read it before editing so the new tests you add match/coexist with its existing style rather than colliding with its single existing import line)

**Interfaces:**
- Produces: `assign_sole_division(db: Session, event_id: int) -> int` — used by Tasks 2-5. Returns the number of teams it updated (0 when the event has zero or more than one division, or when every team already has a division). Does **not** call `db.commit()` — callers commit as part of their own existing transaction, exactly like `balanced_assign` already leaves commit/flush to its callers.

- [ ] **Step 1: Read the existing file**

`server/tests/test_team_assignment.py` currently contains exactly this (verify it still matches before editing — if it doesn't, stop and re-plan this task):

```python
from tournament_server.services.team_assignment import balanced_assign


def test_balanced_assign_distributes_evenly_from_zero():
    ...  # four existing tests total, all pure functions, no database
```

- [ ] **Step 2: Write the failing tests**

Change the file's single import line from:

```python
from tournament_server.services.team_assignment import balanced_assign
```

to:

```python
from __future__ import annotations

from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.team import Team
from tournament_server.services.team_assignment import assign_sole_division, balanced_assign


def _db(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()
```

Leave the four existing `test_balanced_assign_*` functions exactly as they are, and append the following new tests at the end of the file (after the existing `test_balanced_assign_empty_teams_returns_empty`):

```python
def test_assign_sole_division_is_a_no_op_with_zero_divisions(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    team = Team(event_id=event.id, number="1234A", name="Robo Raiders", division_id=None)
    db.add(team)
    db.commit()

    updated = assign_sole_division(db, event.id)

    assert updated == 0
    db.refresh(team)
    assert team.division_id is None


def test_assign_sole_division_is_a_no_op_with_more_than_one_division(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    division_a = Division(event_id=event.id, name="A")
    division_b = Division(event_id=event.id, name="B")
    db.add_all([division_a, division_b])
    db.flush()
    team = Team(event_id=event.id, number="1234A", name="Robo Raiders", division_id=None)
    db.add(team)
    db.commit()

    updated = assign_sole_division(db, event.id)

    assert updated == 0
    db.refresh(team)
    assert team.division_id is None


def test_assign_sole_division_assigns_every_unassigned_team(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    division = Division(event_id=event.id, name="Division 1")
    db.add(division)
    db.flush()
    unassigned1 = Team(event_id=event.id, number="1234A", name="T1", division_id=None)
    unassigned2 = Team(event_id=event.id, number="5678B", name="T2", division_id=None)
    db.add_all([unassigned1, unassigned2])
    db.commit()

    updated = assign_sole_division(db, event.id)

    assert updated == 2
    db.refresh(unassigned1)
    db.refresh(unassigned2)
    assert unassigned1.division_id == division.id
    assert unassigned2.division_id == division.id


def test_assign_sole_division_leaves_already_assigned_teams_alone(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    division = Division(event_id=event.id, name="Division 1")
    db.add(division)
    db.flush()
    team = Team(
        event_id=event.id, number="1234A", name="Already Assigned", division_id=division.id
    )
    db.add(team)
    db.commit()

    updated = assign_sole_division(db, event.id)

    assert updated == 0


def test_assign_sole_division_only_touches_teams_in_the_given_event(tmp_path):
    db = _db(tmp_path)
    event1 = Event(name="Event One")
    db.add(event1)
    db.flush()
    division1 = Division(event_id=event1.id, name="Division 1")
    db.add(division1)
    db.flush()
    team_in_event1 = Team(event_id=event1.id, number="1234A", name="T1", division_id=None)
    db.add(team_in_event1)
    db.commit()

    updated = assign_sole_division(db, event1.id)

    assert updated == 1
    db.refresh(team_in_event1)
    assert team_in_event1.division_id == division1.id
```

Note: the last test (`only_touches_teams_in_the_given_event`) only exercises one event because this project's server process is one-file-per-tournament (see `server/CLAUDE.md`'s architecture note) — there is never a second event's data in the same database to cross-contaminate. It exists to pin that the function correctly filters by `event_id` rather than accidentally querying event-wide, since a lazy implementation (e.g. a bare `select(Team).where(Team.division_id.is_(None))` with no `event_id` filter) would still pass every other test in this file.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_team_assignment.py -v`
Expected: `ImportError` or `AttributeError` — `assign_sole_division` does not exist yet.

- [ ] **Step 4: Implement `assign_sole_division`**

In `server/src/tournament_server/services/team_assignment.py`, add (the existing `balanced_assign` function and its imports stay as-is):

```python
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.division import Division
from tournament_server.models.team import Team


def assign_sole_division(db: Session, event_id: int) -> int:
    """No-op unless `event_id` has exactly one division, in which case
    every currently-unassigned team in that event is assigned to it.

    Exists so a team never sits divisionless -- and that division's team
    count never reads misleadingly low -- purely because nothing
    explicitly picked a division for it, in the common case where there
    is only one division to begin with and the choice is not actually a
    choice. Does not commit; the caller's own transaction does. Deliberately
    scoped to *implicit* divisionless-ness only: it must never run as part
    of `PATCH /api/teams/{id}` handling an explicit `division_id: null`,
    which is a real admin action to unassign a team and must stick.
    """
    division_ids = list(
        db.execute(select(Division.id).where(Division.event_id == event_id)).scalars().all()
    )
    if len(division_ids) != 1:
        return 0
    sole_division_id = division_ids[0]

    unassigned_teams = list(
        db.execute(
            select(Team).where(Team.event_id == event_id, Team.division_id.is_(None))
        ).scalars().all()
    )
    for team in unassigned_teams:
        team.division_id = sole_division_id
    return len(unassigned_teams)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_team_assignment.py -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/services/team_assignment.py server/tests/test_team_assignment.py
git commit -m "Add assign_sole_division: keep every team assigned when an event has exactly one division"
```

---

### Task 2: Call it from `POST /api/teams/bulk` (the reported bug) and `POST /api/teams`

**Files:**
- Modify: `server/src/tournament_server/routers/teams.py` (both `create_team` and `bulk_upsert_teams`)
- Modify: `server/tests/test_teams.py`

**Interfaces:**
- Consumes: `assign_sole_division(db, event_id) -> int` from Task 1.

This is the task that actually fixes the reported bug: uploading a CSV (or saving new grid rows) into a single-division event left the division showing 0 teams because nothing ever set `division_id`.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/test_teams.py`:

```python
def test_create_team_with_no_division_specified_joins_the_sole_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division_id = client.get("/api/divisions").json()[0]["id"]  # the auto-seeded "Division 1"

    response = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    assert response.status_code == 201
    assert response.json()["division_id"] == division_id


def test_bulk_upsert_with_no_division_specified_joins_the_sole_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division_id = client.get("/api/divisions").json()[0]["id"]  # the auto-seeded "Division 1"

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "created"
    assert results[0]["team"]["division_id"] == division_id

    # No dedicated GET /api/divisions/{id} endpoint exists to check a
    # division's team count directly -- confirm via GET /api/teams instead,
    # which is what the user actually observed as wrong (a team with no
    # division_id, which is what made the Divisions page's count read 0).
    teams = client.get("/api/teams").json()
    assert len(teams) == 1
    assert teams[0]["division_id"] == division_id


def test_bulk_upsert_does_not_override_an_explicitly_named_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/divisions", json={"name": "Elementary"})
    # The event now has two divisions ("Division 1" and "Elementary"), so
    # assign_sole_division must not fire at all here.

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders", "division": "Elementary"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    matched_division = next(d for d in client.get("/api/divisions").json() if d["name"] == "Elementary")
    assert results[0]["team"]["division_id"] == matched_division["id"]


def test_bulk_upsert_with_multiple_divisions_leaves_unspecified_rows_unassigned(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/divisions", json={"name": "Elementary"})
    # Two divisions now exist ("Division 1" plus "Elementary") -- omitting
    # a division for a row is a genuine ambiguity here, not an implicit
    # single choice, so the team must stay unassigned.

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders"}]},
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["team"]["division_id"] is None
```

Note: `test_bulk_upsert_creates_new_teams`, `test_bulk_upsert_partial_failure_still_commits_good_rows`, and `test_bulk_upsert_matches_existing_team_despite_surrounding_whitespace` (all pre-existing in `test_teams.py`) create teams with no division specified in what is, by default, a single-division event (the auto-seeded "Division 1") — but none of them assert anything about `division_id`, so this change does not break them. Confirm this by inspection before writing new tests, not by assumption; re-run the full file in Step 3 below to be sure.

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_teams.py -k "sole_division or does_not_override or leaves_unspecified" -v`
Expected: the three new-behavior tests FAIL (division_id is None where a division id is now expected); `test_bulk_upsert_does_not_override_an_explicitly_named_division` and `..._leaves_unspecified...` should already PASS since they don't touch the new behavior's trigger condition incorrectly — if either fails, re-read Task 1's `assign_sole_division` before proceeding, since it should never fire when more than one division exists.

- [ ] **Step 3: Implement**

In `server/src/tournament_server/routers/teams.py`, add the import:

```python
from tournament_server.services.team_assignment import assign_sole_division, balanced_assign
```

In `create_team`, call it right before `db.commit()`:

```python
    team = Team(event_id=event.id, **payload.model_dump())
    db.add(team)
    db.flush()
    assign_sole_division(db, event.id)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Team number already in use")
    db.refresh(team)
    return team
```

(The `db.flush()` before `assign_sole_division` is new — it's needed so the just-added team is visible to `assign_sole_division`'s own `SELECT ... WHERE division_id IS NULL` query, which runs against the database, not Python-side state.)

In `bulk_upsert_teams`, call it once after the `for index, row in enumerate(payload.rows):` loop, right before the existing `try: db.commit()`:

```python
    assign_sole_division(db, event.id)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Team number already in use")
    return TeamBulkResponse(results=results)
```

This works because every row in the loop already calls `db.flush()` after creating or updating its team (see the existing `db.flush()` calls inside both the `if existing is not None:` and `else:` branches), so by the time the loop finishes, every row's team is visible to `assign_sole_division`'s query regardless of whether it was newly created or updated.

One consequence worth being explicit about: `assign_sole_division` runs *after* the whole batch, so it also picks up any team that an update row left divisionless (a bulk row can carry no `division` field, which the existing code already treats as "set division_id to None" on update — see the `fields = {..., "division_id": division_id}` dict, where `division_id` defaults to `None` unless the row set `assign_random_division` or `division`). In a single-division event, that means a re-uploaded CSV that omits the division column no longer un-assigns a team that was previously assigned — it gets reassigned straight back to the sole division instead. This is the correct behavior for this plan's goal (every team belongs to the sole division), not an accidental side effect; Task 4 will not need to touch this since it falls out of Task 2's own change.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_teams.py -v`
Expected: all PASS, including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/routers/teams.py server/tests/test_teams.py
git commit -m "Assign new/updated teams to an event's sole division when no other division is specified"
```

---

### Task 3: Call it from `DELETE /api/divisions/{id}`, and fix the one pre-existing test it changes

**Files:**
- Modify: `server/src/tournament_server/routers/divisions.py` (`delete_division`)
- Modify: `server/tests/test_divisions.py`

**Interfaces:**
- Consumes: `assign_sole_division(db, event_id) -> int` from Task 1.

Deleting a division unassigns its teams (existing behavior — see `delete_division`'s existing `team.division_id = None` loop). If the event had exactly two divisions, deleting one now leaves exactly one, and the teams just freed by the delete should join it rather than sit unassigned — the same reasoning as Task 2, applied to the moment a division disappears rather than the moment a team appears.

**This task changes the observable behavior of one pre-existing test.** `test_delete_division_unassigns_its_teams` currently asserts a team's `division_id` stays `None` after its division is deleted — but in that test, the event has exactly two divisions before the delete ("Division 1" auto-seeded at event creation, plus "Elementary" created explicitly), so deleting "Elementary" leaves exactly one division remaining. Under this plan's design, the freed team must now join that remaining division instead of staying unassigned. Fix this test's expectation in this task, not as an afterthought — it will fail against this task's own change otherwise, which is expected and correct.

- [ ] **Step 1: Update the pre-existing test's expectation**

In `server/tests/test_divisions.py`, replace `test_delete_division_unassigns_its_teams`:

```python
def test_delete_division_unassigns_its_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()
    team = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders", "division_id": division["id"]}
    ).json()

    response = client.delete(f"/api/divisions/{division['id']}")
    assert response.status_code == 204

    # Exactly one division ("Division 1", auto-seeded at event creation)
    # remains after this delete, so the freed team joins it automatically
    # -- it does not stay unassigned. See
    # test_delete_division_unassigns_its_teams_when_others_remain below
    # for the case where it correctly does stay unassigned.
    remaining_division_id = client.get("/api/divisions").json()[0]["id"]
    team_after = client.get(f"/api/teams/{team['id']}").json()
    assert team_after["division_id"] == remaining_division_id

    list_response = client.get("/api/divisions")
    assert division["id"] not in [d["id"] for d in list_response.json()]
```

- [ ] **Step 2: Write a new test for the case where multiple divisions remain**

Add to `server/tests/test_divisions.py`:

```python
def test_delete_division_unassigns_its_teams_when_others_remain(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/divisions", json={"name": "A"})
    division_b = client.post("/api/divisions", json={"name": "B"}).json()
    team = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders", "division_id": division_b["id"]}
    ).json()
    # Three divisions exist now ("Division 1", "A", "B"); deleting "B"
    # leaves two, so assign_sole_division must not fire.

    response = client.delete(f"/api/divisions/{division_b['id']}")
    assert response.status_code == 204

    team_after = client.get(f"/api/teams/{team['id']}").json()
    assert team_after["division_id"] is None
```

- [ ] **Step 3: Run the tests to verify the updated/new ones fail appropriately**

Run: `cd server && .venv/bin/python -m pytest tests/test_divisions.py -k delete_division_unassigns -v`
Expected: `test_delete_division_unassigns_its_teams` FAILs against today's code (team stays unassigned instead of joining "Division 1"); `test_delete_division_unassigns_its_teams_when_others_remain` PASSes already (today's code already leaves it unassigned, and this task hasn't changed behavior for the 3-division case yet).

- [ ] **Step 4: Implement**

In `server/src/tournament_server/routers/divisions.py`, add the import:

```python
from tournament_server.services.team_assignment import assign_sole_division, balanced_assign
```

In `delete_division`, call it after the existing `remaining_count == 0` guard, right before `db.commit()`:

```python
    remaining_count = db.execute(
        select(func.count(Division.id)).where(Division.event_id == event_id)
    ).scalar_one()
    if remaining_count == 0:
        db.rollback()
        raise HTTPException(status_code=409, detail="At least one division is required")
    assign_sole_division(db, event_id)
    db.commit()
    return Response(status_code=204)
```

This is safe to call unconditionally here (rather than checking `remaining_count == 1` first) because `assign_sole_division` already checks the division count itself and no-ops otherwise — Task 1's own test `test_assign_sole_division_is_a_no_op_with_more_than_one_division` already covers exactly this case.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_divisions.py -v`
Expected: all PASS, including every pre-existing test in the file.

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/routers/divisions.py server/tests/test_divisions.py
git commit -m "Reassign a deleted division's freed teams to the remaining sole division when applicable"
```

---

### Task 4: Extend the app-startup self-heal to fix already-affected databases

**Files:**
- Modify: `server/src/tournament_server/app.py`
- Modify: `server/tests/test_migrations.py`

**Interfaces:**
- Consumes: `assign_sole_division(db, event_id) -> int` from Task 1.

Tasks 2 and 3 fix every future write. This task fixes the state that already exists today in any database that hit the bug before this plan landed — the same reasoning `create_app()`'s existing division-seeding self-heal already uses, extended to also cover this narrower gap. No new migration file is needed: this is pure data cleanup (assign existing unassigned teams to an existing sole division), not a schema change, so the existing idempotent self-heal step is the right and sufficient mechanism.

- [ ] **Step 1: Write the failing test**

Add to `server/tests/test_migrations.py`:

```python
def test_startup_self_heal_assigns_unassigned_teams_to_a_pre_existing_sole_division(tmp_path):
    """A database that hit the sole-division-teams-not-assigned bug before
    this fix existed has a real event, exactly one division, and one or
    more teams with a null division_id -- a state this project's own
    create_app() could produce before this task's own change existed.
    The startup self-heal must fix it on the next launch, the same way it
    already fixes a zero-division event."""
    db_path = str(tmp_path / "stale_unassigned_teams.db")
    engine = make_engine(db_path)
    init_db(engine)

    with engine.connect() as connection:
        connection.execute(
            text(
                "INSERT INTO events (id, name, created_at) "
                "VALUES (1, 'Regional Qualifier', '2026-01-01 00:00:00')"
            )
        )
        connection.execute(
            text("INSERT INTO divisions (id, event_id, name) VALUES (1, 1, 'Division 1')")
        )
        connection.execute(
            text(
                "INSERT INTO teams (id, event_id, number, name, division_id, tiebreaker_seed) "
                "VALUES (1, 1, '1234A', 'Robo Raiders', NULL, 0)"
            )
        )
        connection.commit()

    create_app(db_path=db_path, plugins_root=str(tmp_path / "plugins"))

    with engine.connect() as connection:
        division_id_after = connection.execute(
            text("SELECT division_id FROM teams WHERE id = 1")
        ).scalar_one()
    assert division_id_after == 1
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && .venv/bin/python -m pytest tests/test_migrations.py -k self_heal_assigns_unassigned -v`
Expected: FAIL (`division_id_after` is `None`, not `1`).

- [ ] **Step 3: Implement**

In `server/src/tournament_server/app.py`, add the import (alongside the existing `Division`/`Event` imports near the top):

```python
from tournament_server.services.team_assignment import assign_sole_division
```

Extend the existing self-heal block:

```python
    with session_factory() as db:
        event_row = db.execute(select(Event)).scalars().first()
        if event_row is not None:
            has_division = db.execute(
                select(Division.id).where(Division.event_id == event_row.id).limit(1)
            ).first()
            if has_division is None:
                db.add(Division(event_id=event_row.id, name="Division 1"))
                db.commit()
            assign_sole_division(db, event_row.id)
            db.commit()
```

The added `assign_sole_division` call runs unconditionally (not only inside the `if has_division is None:` branch) because it needs to also catch a database that already had exactly one division all along but never assigned its teams to it (this plan's actual bug) — not just the case where a division had to be freshly seeded. Calling `db.commit()` twice here (once inside the existing `if`, once after) is harmless: the second commit is a no-op when the first branch didn't run, and SQLAlchemy's `Session.commit()` on a session with no pending changes is always safe.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && .venv/bin/python -m pytest tests/test_migrations.py -v`
Expected: all PASS, including every pre-existing test in the file (in particular `test_stamped_baseline_database_with_zero_divisions_self_heals_via_create_app`, which this change must not break).

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/app.py server/tests/test_migrations.py
git commit -m "Extend the startup self-heal to also assign pre-existing unassigned teams to an event's sole division"
```

---

### Task 5: Update `server/CLAUDE.md`

**Files:**
- Modify: `server/CLAUDE.md`

**Interfaces:**
- Consumes: nothing new — this task is documentation only.

The "Teams & divisions" section already documents the sole-division-forever gap this plan closes ("In a single-division event every team keeps `division_id = NULL` forever... nothing today cares" — under "Known, deliberate gaps in this phase"). That note is no longer accurate once this plan lands and needs correcting, not just supplementing.

- [ ] **Step 1: Update the "Teams & divisions" section**

In `server/CLAUDE.md`, find the paragraph (in the "Teams & divisions" section) that currently reads:

```
`services/team_assignment.balanced_assign` is the single implementation
behind every random assignment — the bulk endpoint's per-row
`assign_random_division`, and both scopes of the randomize endpoint. It is
not round-robin: it shuffles the teams *and* the divisions, then walks the
teams in that order assigning each to whichever division currently has the
fewest teams, counting as it goes. Starting from an already-lopsided
roster it therefore fills the small divisions first and converges sizes to
within one of each other, and the division shuffle makes ties break
randomly rather than always favoring the first-listed division.
```

Add a new paragraph directly after it:

```
The same file's `assign_sole_division(db, event_id)` handles the much
narrower, much more common case: whenever an event has exactly one
division, every team belongs to it — a team is never left showing as
unassigned purely because nothing explicitly picked a division for it,
which previously made that division's team count read misleadingly low
after a CSV upload or grid save. It is called from `POST /api/teams`,
`POST /api/teams/bulk`, and `DELETE /api/divisions/{id}` (which can bring
an event back down to exactly one division), plus once more from
`create_app()`'s startup self-heal so an already-affected database is
fixed on its next launch. It deliberately does not run from
`PATCH /api/teams/{id}` — an admin's explicit `division_id: null` there is
a real unassign action and must stick, not get silently reverted.
```

Then find, in "Known, deliberate gaps in this phase", the note that currently reads:

```
- In a single-division event every team keeps `division_id = NULL`
  forever: the admin UI hides the division column, the division filter and
  the assignment controls entirely when only one division exists, so
  nothing ever writes that division's id onto a team. This is no longer an
  occasional configuration some admin happens to end up in — every new
  event now *starts* with exactly one auto-seeded division and every team
  `NULL`, so this is the guaranteed common case, not an edge case. Nothing
  today cares, but a future scheduling sub-project will have to decide
  whether a null `division_id` means "the event's only division" or is a
  data gap to backfill — don't assume the former silently, and don't
  assume it's rare either.
```

Replace it with:

```
- ~~In a single-division event every team keeps `division_id = NULL`
  forever~~ — fixed: `services/team_assignment.assign_sole_division` (see
  "Teams & divisions" above) keeps every team assigned to an event's sole
  division from the moment it's created (or from the moment a division's
  deletion brings the count back down to one), and the admin UI's
  division column/filter/assignment controls staying hidden in that case
  is now purely a display simplification, not a sign that the underlying
  `division_id` is meaningless. A future scheduling sub-project can safely
  assume a non-null `division_id` in a single-division event, though the
  admin UI itself still never surfaces it as a distinct choice.
```

- [ ] **Step 2: Commit**

```bash
git add server/CLAUDE.md
git commit -m "Document assign_sole_division and correct the now-fixed sole-division gap note"
```
