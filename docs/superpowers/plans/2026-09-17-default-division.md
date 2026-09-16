# Default Division Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tournament always has at least one division — one is auto-created ("Division 1", renamable) the moment an event is created, existing tournaments with none get backfilled by migration, and the last remaining division can no longer be deleted.

**Architecture:** A small behavior change to `POST /api/event` (seed one `Division` row in the same transaction) plus a guard on `DELETE /api/divisions/{id}` (409 if it's the only one), a data-only Alembic migration to backfill pre-existing tournaments, and two `DivisionsRoute.tsx` UI changes (hide the now-impossible delete action; turn the always-visible create form into a toggle).

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy, Alembic (backend); TypeScript, React 19, TanStack Query, Playwright (frontend).

**Spec:** None — this was classified as a Bounded change per the brainstorming skill (all four flows it touches already exist and were read directly rather than re-designed from scratch). The agreed design was presented and approved in chat; this plan is its only written record.

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit/integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database in the same change — never mocked at the HTTP boundary.
- Every user-facing frontend string goes through `useTranslation()`/`t(...)` with both an English (`frontend/apps/admin/src/i18n/en/admin.json`) and Chinese (`.../zh/admin.json`) entry.
- The auto-created division's name is the fixed literal `"Division 1"` (English, not translated) — this project's other server-generated strings (API error details, etc.) are already English-only; the admin can rename it immediately regardless of locale.
- The 409 guard on `DELETE /api/divisions/{division_id}` is the real enforcement; the frontend hiding the delete button is a courtesy on top of it, never a substitute for it.

---

### Task 1: Auto-create a default division on event creation

**Files:**
- Modify: `server/src/tournament_server/routers/event.py` (the `create_event` handler)
- Modify: `server/tests/test_event.py` (add one test)
- Modify: `server/tests/test_divisions.py` (fix three pre-existing tests whose assumptions this change breaks)

**Interfaces:**
- Consumes: `tournament_server.models.division.Division` (existing — `id`, `event_id`, `name`, `target_team_count`, see `server/src/tournament_server/models/division.py`).
- Produces: nothing new for later tasks — this task's effect (every event has ≥1 division immediately after creation) is the precondition Tasks 2-4 build on.

Three existing tests currently assume an event has **zero** divisions immediately after creation, or that a specific division "wins" a random assignment among what used to be the only available divisions. Both assumptions become false once every event is seeded with one — fix them as part of this task, not as an afterthought, since they'd otherwise fail the moment this change lands.

- [ ] **Step 1: Fix the three pre-existing tests to match the new behavior (they will fail against today's code — that's the point)**

In `server/tests/test_divisions.py`, replace `test_create_and_list_divisions` (it currently assumes the division it just created is the *only* one, at list index 0 — no longer true once "Division 1" is seeded first):

```python
def test_create_and_list_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 201
    division_id = response.json()["id"]

    list_response = client.get("/api/divisions")
    assert list_response.status_code == 200
    divisions_by_id = {d["id"]: d["name"] for d in list_response.json()}
    assert divisions_by_id[division_id] == "Elementary"
```

Replace `test_randomize_unassigned_only_touches_unassigned_teams` (it currently asserts the newly-assigned team lands specifically in "Elementary" — but with "Division 1" also present and starting with zero teams, the balanced-assignment algorithm may just as validly prefer it; only the "which teams were touched" and "the already-assigned team is untouched" behaviors are actually this endpoint's contract):

```python
def test_randomize_unassigned_only_touches_unassigned_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()
    assigned = client.post(
        "/api/teams", json={"number": "0001A", "name": "Already Assigned", "division_id": division["id"]}
    ).json()
    unassigned = client.post("/api/teams", json={"number": "0002A", "name": "New Team"}).json()

    response = client.post("/api/divisions/randomize", json={"scope": "unassigned"})
    assert response.status_code == 200
    touched_ids = {t["id"] for t in response.json()}
    assert touched_ids == {unassigned["id"]}

    all_division_ids = {d["id"] for d in client.get("/api/divisions").json()}
    unassigned_after = client.get(f"/api/teams/{unassigned['id']}").json()
    assert unassigned_after["division_id"] in all_division_ids
    assigned_after = client.get(f"/api/teams/{assigned['id']}").json()
    assert assigned_after["division_id"] == division["id"]  # untouched, was already here
```

Replace `test_randomize_all_reassigns_every_team` (it currently asserts every team ends up in one of exactly the two divisions it created — but a third division, "Division 1", is now also a valid destination):

```python
def test_randomize_all_reassigns_every_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division_a = client.post("/api/divisions", json={"name": "A"}).json()
    division_b = client.post("/api/divisions", json={"name": "B"}).json()
    team1 = client.post(
        "/api/teams", json={"number": "0001A", "name": "T1", "division_id": division_a["id"]}
    ).json()
    team2 = client.post(
        "/api/teams", json={"number": "0002A", "name": "T2", "division_id": division_a["id"]}
    ).json()

    response = client.post("/api/divisions/randomize", json={"scope": "all"})
    assert response.status_code == 200
    touched_ids = {t["id"] for t in response.json()}
    assert touched_ids == {team1["id"], team2["id"]}

    all_division_ids = {d["id"] for d in client.get("/api/divisions").json()}
    division_ids_after = {
        client.get(f"/api/teams/{team1['id']}").json()["division_id"],
        client.get(f"/api/teams/{team2['id']}").json()["division_id"],
    }
    assert division_ids_after <= all_division_ids
```

Replace `test_randomize_404s_with_no_divisions` (this endpoint's "no divisions at all" 404 branch can no longer be reached through the normal API once every event always has one — delete the seeded division directly via the DB, bypassing the API, to still exercise this defensive branch):

```python
def test_randomize_404s_with_no_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    # Event creation always seeds one division now (see routers/event.py).
    # Deleting the last division through the API is blocked (see Task 2),
    # so reach the "no divisions at all" state directly via the DB instead
    # -- this is exercising randomize's own defensive guard, not something
    # reachable through normal use anymore.
    from sqlalchemy import select

    from tournament_server.models.division import Division

    session = client.app.state.session_factory()
    try:
        for division in session.execute(select(Division)).scalars().all():
            session.delete(division)
        session.commit()
    finally:
        session.close()

    response = client.post("/api/divisions/randomize", json={"scope": "all"})
    assert response.status_code == 404
```

Add the new positive test to `server/tests/test_event.py`:

```python
def test_create_event_seeds_a_default_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.get("/api/divisions")
    assert response.status_code == 200
    assert [d["name"] for d in response.json()] == ["Division 1"]
    assert response.json()[0]["target_team_count"] is None
```

- [ ] **Step 2: Run the tests to verify they fail for the right reason**

Run: `cd server && .venv/bin/python -m pytest tests/test_event.py tests/test_divisions.py -v`
Expected: `test_create_event_seeds_a_default_division` FAILS (`/api/divisions` returns `[]`, not `["Division 1"]`). The three rewritten tests should still PASS at this point — they were rewritten to describe the *new* behavior, but each one's core assertion (membership, not exact match) also happens to be compatible with today's zero-division reality... actually check this concretely: `test_create_and_list_divisions` and the two randomize tests only ever look at divisions *they explicitly created*, so they still pass unchanged today; only the brand-new test should fail. If any of the three rewritten ones fail unexpectedly at this step, re-read them — that's a sign the rewrite accidentally depends on the seeded division already existing.

- [ ] **Step 3: Implement the change**

In `server/src/tournament_server/routers/event.py`, add the import and update `create_event`:

```python
from tournament_server.models.division import Division
```

(add alongside the existing `from tournament_server.models.event import Event` import)

```python
@router.post("", response_model=EventRead, status_code=201)
def create_event(payload: EventCreate, db: Session = Depends(get_db)) -> Event:
    if get_the_event(db) is not None:
        raise HTTPException(status_code=409, detail="Event already initialized")
    event = Event(name=payload.name)
    db.add(event)
    db.flush()  # populates event.id, needed by the Division row below
    db.add(Division(event_id=event.id, name="Division 1"))
    password_hash = hash_password(payload.password)
    for role in ROLES:
        db.add(RoleCredential(role=role, password_hash=password_hash))
    db.commit()
    db.refresh(event)
    return event
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_event.py tests/test_divisions.py -v`
Expected: PASS, all tests in both files.

- [ ] **Step 5: Run the full backend suite to catch any other fallout**

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: PASS. If anything outside these two files fails, it's a test this plan didn't anticipate relying on the zero-division assumption — read it, and fix its assertion the same way (membership/count-based, not index- or identity-based), following the pattern above.

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/routers/event.py server/tests/test_event.py server/tests/test_divisions.py
git commit -m "Seed a default division when an event is created"
```

---

### Task 2: Forbid deleting the last division

**Files:**
- Modify: `server/src/tournament_server/routers/divisions.py` (the `delete_division` handler)
- Modify: `server/tests/test_divisions.py` (add two tests)

**Interfaces:**
- Consumes: Task 1's guarantee that a freshly-created event already has one division (so `test_delete_division_409s_when_it_is_the_only_one` doesn't need to create one itself).
- Produces: a `409` response (detail: `"At least one division is required"`) from `DELETE /api/divisions/{division_id}` when it's the event's only remaining division — Task 4's frontend work relies on this being the real, load-bearing check (its own hidden-button behavior is cosmetic on top of it).

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/test_divisions.py`:

```python
def test_delete_division_409s_when_it_is_the_only_one(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    only_division = client.get("/api/divisions").json()[0]  # the seeded "Division 1"

    response = client.delete(f"/api/divisions/{only_division['id']}")
    assert response.status_code == 409

    list_response = client.get("/api/divisions")
    assert only_division["id"] in [d["id"] for d in list_response.json()]


def test_delete_division_succeeds_when_others_remain(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    second = client.post("/api/divisions", json={"name": "Elementary"}).json()

    response = client.delete(f"/api/divisions/{second['id']}")
    assert response.status_code == 204

    list_response = client.get("/api/divisions")
    assert second["id"] not in [d["id"] for d in list_response.json()]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_divisions.py::test_delete_division_409s_when_it_is_the_only_one -v`
Expected: FAIL — today's `delete_division` has no count guard, so this currently returns `204`, not `409`.

- [ ] **Step 3: Implement the guard**

In `server/src/tournament_server/routers/divisions.py`, update `delete_division` (the `func` and `select` imports already exist at the top of this file — no new imports needed):

```python
@router.delete("/{division_id}", status_code=204)
def delete_division(
    division_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    division = db.get(Division, division_id)
    if division is None:
        raise HTTPException(status_code=404, detail="Division not found")
    remaining_count = db.execute(
        select(func.count(Division.id)).where(Division.event_id == division.event_id)
    ).scalar_one()
    if remaining_count <= 1:
        raise HTTPException(status_code=409, detail="At least one division is required")
    teams_in_division = list(
        db.execute(select(Team).where(Team.division_id == division_id)).scalars().all()
    )
    for team in teams_in_division:
        team.division_id = None
    db.delete(division)
    db.commit()
    return Response(status_code=204)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_divisions.py -v`
Expected: PASS, all tests in the file (including `test_delete_division_unassigns_its_teams`, which deletes a *second* division alongside the seeded one and is unaffected by this guard).

- [ ] **Step 5: Run the full backend suite**

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/routers/divisions.py server/tests/test_divisions.py
git commit -m "Forbid deleting an event's last remaining division"
```

---

### Task 3: Backfill a default division for existing tournaments

**Files:**
- Create: `server/src/tournament_server/_alembic/versions/d47c8e21f9a3_backfill_default_division.py`
- Modify: `server/tests/test_migrations.py` (add one test)

**Interfaces:**
- Consumes: nothing from Tasks 1-2 (this is a data migration for tournament files that existed *before* Task 1 shipped — it runs through the existing `ensure_schema_current`/Alembic pipeline in `server/src/tournament_server/migrations.py`, unchanged by this plan).
- Produces: nothing later tasks depend on. This closes the gap for any tournament DB that was created before Task 1: `POST /api/event` only seeds a division for events created *after* this plan ships, so a pre-existing event with zero divisions needs this migration to gain one.

- [ ] **Step 1: Write the failing test**

Add to `server/tests/test_migrations.py` (this file already imports `command`, `create_engine`, `inspect`, `text`, `_make_alembic_config`, `ensure_schema_current`, `MigrationOutcome`, `make_engine` — no new imports needed):

```python
def test_backfill_migration_adds_a_default_division_for_event_with_none(tmp_path):
    """An event created before this migration existed could have zero
    divisions (nothing seeded one at event-creation time back then).
    Upgrading such a database must give it one, but must NOT touch an
    event that already has divisions of its own."""
    db_path = str(tmp_path / "pre_existing_events.db")
    config = _make_alembic_config(db_path)
    command.upgrade(config, "b7e4a19f6c32")  # baseline, before this task's migration

    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text(
                "INSERT INTO events (id, name, created_at) "
                "VALUES (1, 'No Divisions Yet', '2026-01-01 00:00:00')"
            )
        )
        connection.execute(
            text(
                "INSERT INTO events (id, name, created_at) "
                "VALUES (2, 'Already Has One', '2026-01-01 00:00:00')"
            )
        )
        connection.execute(
            text("INSERT INTO divisions (id, event_id, name) VALUES (1, 2, 'Existing Division')")
        )
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    outcome = ensure_schema_current(engine, db_path)

    assert outcome == MigrationOutcome.UPGRADED

    with engine.connect() as connection:
        event_1_divisions = connection.execute(
            text("SELECT name FROM divisions WHERE event_id = 1")
        ).scalars().all()
        event_2_divisions = connection.execute(
            text("SELECT name FROM divisions WHERE event_id = 2")
        ).scalars().all()

    assert event_1_divisions == ["Division 1"]
    assert event_2_divisions == ["Existing Division"]  # untouched -- already had one
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && .venv/bin/python -m pytest tests/test_migrations.py::test_backfill_migration_adds_a_default_division_for_event_with_none -v`
Expected: FAIL — `command.upgrade(config, "b7e4a19f6c32")` is currently the head revision (no migration exists yet to move past it), so `ensure_schema_current` returns `ALREADY_CURRENT`, not `UPGRADED`, and no division was ever inserted for event 1.

- [ ] **Step 3: Write the migration**

Create `server/src/tournament_server/_alembic/versions/d47c8e21f9a3_backfill_default_division.py`:

```python
"""backfill a default division for any event with none

Revision ID: d47c8e21f9a3
Revises: b7e4a19f6c32
Create Date: 2026-09-17 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd47c8e21f9a3'
down_revision: Union[str, None] = 'b7e4a19f6c32'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A pure data migration, not a schema change -- every tournament from
    # here on always has at least one division (routers/event.py seeds one
    # at creation; routers/divisions.py refuses to delete the last one),
    # but an event created before that shipped could still have zero.
    # Give any such event a "Division 1" so the invariant genuinely holds
    # for every tournament, not just ones created after this landed.
    connection = op.get_bind()
    event_ids_without_a_division = connection.execute(
        sa.text(
            "SELECT events.id FROM events "
            "LEFT JOIN divisions ON divisions.event_id = events.id "
            "WHERE divisions.id IS NULL"
        )
    ).scalars().all()
    for event_id in event_ids_without_a_division:
        connection.execute(
            sa.text(
                "INSERT INTO divisions (event_id, name, target_team_count) "
                "VALUES (:event_id, 'Division 1', NULL)"
            ),
            {"event_id": event_id},
        )


def downgrade() -> None:
    # Deliberately a no-op: a backfilled "Division 1" is indistinguishable
    # from one an admin created or renamed by hand afterward, and teams
    # may already be assigned to it by the time anyone downgrades -- there
    # is no safe, unambiguous way to reverse this. Downgrading past this
    # revision leaves any backfilled divisions in place.
    pass
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && .venv/bin/python -m pytest tests/test_migrations.py -v`
Expected: PASS, every test in the file (this also re-confirms `test_upgrade_over_pre_existing_team_rows_succeeds` and the other pre-existing migration tests still pass unaffected, since none of them upgrade all the way to `head` in a way this new migration's backfill loop would touch unexpectedly — check this explicitly if anything unexpected fails).

- [ ] **Step 5: Run the full backend suite**

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/_alembic/versions/d47c8e21f9a3_backfill_default_division.py server/tests/test_migrations.py
git commit -m "Backfill a default division for tournaments created before it was seeded automatically"
```

---

### Task 4: Frontend — hide the impossible delete action, and turn "Add Division" into a toggle

**Files:**
- Modify: `frontend/apps/admin/src/routes/DivisionsRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json` (one new key)
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json` (matching key)
- Modify: `frontend/apps/admin/tests/e2e/divisions.spec.ts`

**Interfaces:**
- Consumes: Task 2's `409` guard (the reason the delete button is hidden at all — the frontend never has to handle a 409 from this button, since it's simply not rendered when it would fire one) and Task 1's guarantee that a freshly-created event's Divisions screen always shows at least "Division 1".
- Produces: nothing later tasks depend on — this is the plan's last task.

This project's Vitest component-test coverage is selective (`DivisionsRoute.tsx` has none today, matching `EventsNewRoute.tsx`/`LoginRoute.tsx` — some routes rely on Playwright E2E alone rather than a paired unit test). Follow that existing convention: no new `DivisionsRoute.test.tsx`, extend the E2E spec instead.

- [ ] **Step 1: Add the new i18n key**

In `frontend/apps/admin/src/i18n/en/admin.json`, inside the existing `"divisions"` block, add (alongside the existing keys — this is a new key, not a replacement):

```json
    "addDivisionAction": "Add a division...",
```

(Insert it near `"addSubmit": "Add division",` — e.g. right before that line.)

In `frontend/apps/admin/src/i18n/zh/admin.json`, inside its own `"divisions"` block, add:

```json
    "addDivisionAction": "添加分组...",
```

- [ ] **Step 2: Write the failing E2E test**

Replace `frontend/apps/admin/tests/e2e/divisions.spec.ts`'s one test with:

```ts
  test("create, rename, and delete a division", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Divisions" }).click();
    await expect(page).toHaveURL(/\/divisions$/);

    // Event creation always seeds one division ("Division 1"); as the
    // only division, its delete button must not be present at all.
    await expect(page.getByLabel("Rename Division 1")).toHaveValue("Division 1");
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);

    // The create form starts hidden behind a toggle button.
    await expect(page.getByLabel("Division name")).not.toBeVisible();
    await page.getByRole("button", { name: "Add a division..." }).click();

    await page.getByLabel("Division name").fill("Elementary");
    await page.getByRole("button", { name: "Add division" }).click();
    // The division's name only ever appears as the value of its inline
    // rename <input> (there's no separate read-only text node for it),
    // so it must be asserted via that input's accessible name/value
    // rather than getByText.
    await expect(page.getByLabel("Rename Elementary")).toHaveValue("Elementary");

    // With two divisions now, both rows show a delete button.
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(2);

    // Each row's rename input has its own accessible name ("Rename
    // <current name>"), distinct from the add-form's "Division name"
    // label above, so this targets the new row's input specifically.
    const renameInput = page.getByLabel("Rename Elementary");
    await renameInput.fill("Elementary School");
    await renameInput.press("Tab"); // triggers the input's onBlur handler
    await expect(page.getByLabel("Rename Elementary School")).toHaveValue("Elementary School");

    await page.getByRole("button", { name: "Delete" }).last().click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByLabel("Rename Elementary School")).not.toBeVisible();

    // Back down to one division -- its delete button is hidden again.
    await expect(page.getByRole("button", { name: "Delete" })).toHaveCount(0);
  });
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend/apps/admin && npx playwright test divisions.spec.ts`
Expected: FAIL. Multiple assertions fail against today's code: the seeded "Division 1" doesn't exist yet (`event.py` hasn't been touched by this task — but Task 1 already shipped it in an earlier commit, so this part will actually pass); the create form is always visible today (`not.toBeVisible()` on "Division name" fails); "Add a division..." doesn't exist yet; the delete-button counts don't match since today's delete button always renders.

- [ ] **Step 4: Implement the frontend changes**

In `frontend/apps/admin/src/routes/DivisionsRoute.tsx`, add one new piece of state near the other `useState` calls at the top of `DivisionsRoute`:

```tsx
  const [addingDivision, setAddingDivision] = useState(false);
```

Update `createMutation`'s `onSuccess` to also close the form (add `setAddingDivision(false);` alongside the existing resets):

```tsx
  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<Division>("/api/divisions", {
        method: "POST",
        body: { name, target_team_count: target ? Number(target) : null },
      }),
    onSuccess: () => {
      setName("");
      setTarget("");
      setAddingDivision(false);
      invalidateAll();
      if (totalTeams > 0) {
        setRedistributeError(null);
        setPendingRedistribute(true);
      }
    },
  });
```

Replace the per-row delete button so it only renders when more than one division exists:

```tsx
              <span className="list-row__meta">{label}</span>
              {(divisions?.length ?? 0) > 1 && (
                <button
                  className="btn btn-danger btn-small"
                  onClick={() => setDeleteCandidate(division)}
                >
                  {t("divisions.deleteAction")}
                </button>
              )}
```

(This replaces the existing unconditional `<button className="btn btn-danger btn-small" onClick={() => setDeleteCandidate(division)}>{t("divisions.deleteAction")}</button>` — same button, now conditionally rendered.)

Replace the always-visible create `<form>` with a toggle button plus the same form, now conditionally rendered and with a Cancel button added:

```tsx
      {!addingDivision && (
        <button className="btn" onClick={() => setAddingDivision(true)}>
          {t("divisions.addDivisionAction")}
        </button>
      )}

      {addingDivision && (
        <form className="panel" onSubmit={handleCreate}>
          <div className="field">
            <label className="field__label" htmlFor="new-division-name">
              {t("divisions.nameLabel")}
            </label>
            <input
              className="input"
              id="new-division-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor="new-division-target">
              {t("divisions.targetLabel")}
            </label>
            <input
              className="input"
              id="new-division-target"
              type="number"
              min="0"
              value={target}
              onChange={(event) => setTarget(event.target.value)}
            />
          </div>
          {createMutation.isError && (
            <p className="alert alert-danger" role="alert">
              {createMutation.error instanceof ApiError
                ? createMutation.error.detail
                : t("errors.generic")}
            </p>
          )}
          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={createMutation.isPending}>
              {t("divisions.addSubmit")}
            </button>
            <button className="btn" type="button" onClick={() => setAddingDivision(false)}>
              {t("divisions.cancelAction")}
            </button>
          </div>
        </form>
      )}
```

(This replaces the existing unconditional `<form className="panel" onSubmit={handleCreate}>...</form>` block in full — same fields, same submit button, now wrapped in the `addingDivision` conditional with a toggle button and a Cancel button added. `divisions.cancelAction` already exists as an i18n key, reused here from the delete-confirmation dialog.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend/apps/admin && npx playwright test divisions.spec.ts`
Expected: PASS.

- [ ] **Step 6: Type-check and run the full frontend suites**

Run: `cd frontend/apps/admin && npx tsc -b --noEmit`
Expected: clean, no errors.

Run: `cd frontend/apps/admin && npm test -- --run`
Expected: PASS (this task doesn't touch any file a unit test covers, so the count should be unchanged from before this task).

Run: `cd frontend/apps/admin && npm run test:e2e`
Expected: PASS, full suite (confirms this change doesn't disturb any other spec file's shared-backend assumptions).

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/admin/src/routes/DivisionsRoute.tsx frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/e2e/divisions.spec.ts
git commit -m "Hide the impossible delete action and make Add Division a toggle"
```
