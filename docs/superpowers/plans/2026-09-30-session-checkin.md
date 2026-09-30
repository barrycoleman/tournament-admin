# Session Check-In Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the tournament-admin server a Sessions admin screen and two team check-in surfaces — an admin data-grid tab and a dedicated, role-gated front-desk kiosk screen — backed by a new `PATCH /api/sessions/{id}` endpoint, a real upsert fix for the check-in endpoint, and a new `front_desk` role.

**Architecture:** Four small backend pieces (session editing, a participation-upsert bug fix, the new role, and a startup self-heal for existing databases) land first, since the frontend consumes all of them. Five frontend pieces follow: a Sessions list screen, a per-session detail layout with a tab strip (only the Check-in tab populated — the strip itself is built generically so a later sub-project can add more tabs without rebuilding it), the admin check-in data grid, the `front_desk` role's frontend wiring, and the dedicated front-desk screen. One end-to-end test ties the whole flow together.

**Tech Stack:** Python/FastAPI/SQLAlchemy/pytest (backend); TypeScript/React/React Router/TanStack Query/react-i18next/react-data-grid/Playwright (frontend, `frontend/apps/admin`).

**Spec:** `docs/superpowers/specs/2026-09-29-session-checkin-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit/integration tests against a real `TestClient` and real temp-file SQLite, in the same commit as the code.
- Every frontend change ships with Vitest component tests; user-facing flows get Playwright E2E coverage — no mocking at the HTTP/WebSocket boundary for E2E.
- No destructive migrations. No schema change may destroy existing data (this plan makes no schema change — only route/logic additions and one new `ROLES` tuple entry).
- Every user-facing string goes through `useTranslation()`/`t(...)` in both `en`/`zh` `admin.json` — no bare string literals.
- Follow existing conventions: TanStack Query for server state, the `InlineEditableText`-style explicit-edit/Save/Cancel pattern, `react-data-grid` (with the shims `frontend/CLAUDE.md` documents) for spreadsheet-style tables, native `<input type="date">`/`<select>` for date/timezone entry.

## Review Focus

- **`front_desk`'s broadened access must be scoped to exactly one endpoint.** The spec only widens `POST /api/sessions/{id}/participants`'s gate — every other admin-only endpoint (`POST /api/sessions`, `PATCH /api/sessions/{id}`, `PATCH /api/teams/{id}`, etc.) must still 403 a `front_desk` caller. A careless `require_role()` change elsewhere would silently over-grant. (Task 3 owns the test.)
- **`PATCH /api/sessions/{id}` with an empty body (`{}`) must be a no-op success, not a validation error.** `exclude_unset=True` makes this work naturally, but it's exactly the kind of thing that looks done without a test that actually sends `{}`. (Task 1 owns the test.)
- **The startup self-heal must be idempotent across repeated launches.** Calling `create_app()` twice against the same database must never create a second `RoleCredential` row for a role that already has one. (Task 4 owns the test.)
- **A team with zero participation rows for a session must show as unchecked, not be omitted or error.** The check-in grid's row set comes from `GET /api/teams`, not from `GET /api/sessions/{id}/participants` — a team nobody has touched yet for this session must still appear. (Task 6 owns the test.)
- **Re-checking in an already-checked-in team must succeed idempotently and leave exactly one row** — the core motivating bug fix for this whole plan. This must hold from both the admin grid and the front-desk screen, and across a state toggle (checked in → out → in again), not just a bare repeat of the same call. (Task 2 owns the test.)

---

### Task 1: `PATCH /api/sessions/{id}`

**Files:**
- Modify: `server/src/tournament_server/schemas/session.py`
- Modify: `server/src/tournament_server/routers/sessions.py`
- Test: `server/tests/test_sessions.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PATCH /api/sessions/{id}` (admin-only, 404 on missing session, 422 if `label` is explicitly given as `null`, 422 on an invalid `timezone`), consumed by Task 5's session-edit form.

- [ ] **Step 1: Write the failing tests**

Add to `server/tests/test_sessions.py`:

```python
def test_patch_session_updates_given_fields(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.patch(
        f"/api/sessions/{session_id}",
        json={"label": "Saturday", "timezone": "America/Los_Angeles"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["label"] == "Saturday"
    assert body["timezone"] == "America/Los_Angeles"
    assert body["session_date"] is None


def test_patch_session_with_empty_body_is_a_noop(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post(
        "/api/sessions",
        json={"label": "Session 1", "timezone": "America/Los_Angeles"},
    ).json()["id"]

    response = client.patch(f"/api/sessions/{session_id}", json={})
    assert response.status_code == 200
    body = response.json()
    assert body["label"] == "Session 1"
    assert body["timezone"] == "America/Los_Angeles"


def test_patch_session_can_clear_timezone_and_date(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]

    response = client.patch(
        f"/api/sessions/{session_id}",
        json={"session_date": None, "timezone": None},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["session_date"] is None
    assert body["timezone"] is None


def test_patch_session_rejects_null_label(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.patch(f"/api/sessions/{session_id}", json={"label": None})
    assert response.status_code == 422


def test_patch_session_rejects_invalid_timezone(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.patch(
        f"/api/sessions/{session_id}", json={"timezone": "Not/A/Real/Zone"}
    )
    assert response.status_code == 422


def test_patch_unknown_session_404s(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.patch("/api/sessions/999", json={"label": "Nope"})
    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pytest tests/test_sessions.py -v`
Expected: FAIL — `405 Method Not Allowed` for every new test (no `PATCH` route exists yet).

- [ ] **Step 3: Update `server/src/tournament_server/schemas/session.py`**

Add to the existing file (after `SessionCreate`, before `SessionRead`):

```python
class SessionUpdate(BaseModel):
    label: str | None = None
    session_date: dt.date | None = None
    timezone: str | None = None
```

- [ ] **Step 4: Update `server/src/tournament_server/routers/sessions.py`**

Add `SessionUpdate` to the existing schema import, and add the new endpoint after `create_session`:

```python
from tournament_server.schemas.session import SessionCreate, SessionRead, SessionUpdate
```

```python
@router.patch("/{session_id}", response_model=SessionRead)
def update_session(
    session_id: int,
    payload: SessionUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> TournamentSession:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    updates = payload.model_dump(exclude_unset=True)
    if "label" in updates and updates["label"] is None:
        raise HTTPException(status_code=422, detail="label cannot be null")
    if "timezone" in updates and updates["timezone"] is not None:
        try:
            ZoneInfo(updates["timezone"])
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(
                status_code=422, detail=f"Unknown timezone: {updates['timezone']!r}"
            )
    for key, value in updates.items():
        setattr(session_obj, key, value)
    db.commit()
    db.refresh(session_obj)
    return session_obj
```

(`ZoneInfo`/`ZoneInfoNotFoundError` are already imported at the top of this file for `create_session`'s own validation — no new import needed for them.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && pytest tests/test_sessions.py -v`
Expected: all PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd server
git add src/tournament_server/schemas/session.py src/tournament_server/routers/sessions.py tests/test_sessions.py
git commit -m "Add PATCH /api/sessions/{id} for editing an existing session"
```

---

### Task 2: Fix `POST /api/sessions/{id}/participants` to be a real upsert

**Files:**
- Modify: `server/src/tournament_server/routers/participation.py`
- Test: `server/tests/test_participation.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `POST /api/sessions/{id}/participants` now upserts instead of 409ing on a repeat call for the same `(session_id, team_id)` — consumed by every later frontend task that toggles check-in.

- [ ] **Step 1: Replace the now-obsolete 409 test and add the upsert test**

In `server/tests/test_participation.py`, replace `test_duplicate_checkin_returns_409` (its assertion is exactly what this task fixes) with:

```python
def test_recheckin_updates_existing_row_instead_of_409ing(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    first = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
    )
    assert first.status_code == 201
    participation_id = first.json()["id"]

    second = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": False},
    )
    assert second.status_code == 201
    assert second.json()["id"] == participation_id
    assert second.json()["checked_in"] is False

    third = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
    )
    assert third.status_code == 201
    assert third.json()["id"] == participation_id
    assert third.json()["checked_in"] is True

    list_response = client.get(f"/api/sessions/{session_id}/participants")
    assert len(list_response.json()) == 1
```

- [ ] **Step 2: Run tests to verify the new test fails**

Run: `cd server && pytest tests/test_participation.py -v`
Expected: `test_recheckin_updates_existing_row_instead_of_409ing` FAILS — the second call returns 409, not 201.

- [ ] **Step 3: Rewrite `add_participant` in `server/src/tournament_server/routers/participation.py`**

Replace the function body:

```python
@router.post(
    "/{session_id}/participants", response_model=ParticipationRead, status_code=201
)
def add_participant(
    session_id: int,
    payload: ParticipationCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionParticipation:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    team = db.get(Team, payload.team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")

    participation = db.execute(
        select(SessionParticipation).where(
            SessionParticipation.session_id == session_id,
            SessionParticipation.team_id == payload.team_id,
        )
    ).scalars().first()
    if participation is not None:
        participation.checked_in = payload.checked_in
        db.commit()
        db.refresh(participation)
        return participation

    participation = SessionParticipation(
        session_id=session_id, team_id=payload.team_id, checked_in=payload.checked_in
    )
    db.add(participation)
    try:
        db.commit()
    except IntegrityError:
        # A concurrent request inserted this (session_id, team_id) row
        # between our SELECT and this INSERT -- fall back to updating the
        # row it created, since the caller's intent (this team's
        # checked_in state) is still achievable without a 409.
        db.rollback()
        participation = db.execute(
            select(SessionParticipation).where(
                SessionParticipation.session_id == session_id,
                SessionParticipation.team_id == payload.team_id,
            )
        ).scalars().first()
        participation.checked_in = payload.checked_in
        db.commit()
    db.refresh(participation)
    return participation
```

The existing `from sqlalchemy.exc import IntegrityError` import stays — it's still used for the narrow concurrent-insert race above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && pytest tests/test_participation.py -v`
Expected: all PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd server
git add src/tournament_server/routers/participation.py tests/test_participation.py
git commit -m "Fix check-in endpoint to upsert instead of 409ing on re-check-in"
```

---

### Task 3: `front_desk` role

**Files:**
- Modify: `server/src/tournament_server/auth.py`
- Modify: `server/src/tournament_server/routers/participation.py`
- Test: `server/tests/test_participation.py`
- Test: `server/tests/test_auth_core.py` (check this file's exact name first — grep for `ROLES` usage; if the existing `ROLES`-related tests live in a different file, add there instead)

**Interfaces:**
- Consumes: nothing new.
- Produces: `auth.ROLES` includes `"front_desk"`; `auth.require_admin_or_front_desk` (a new `require_role("front_desk")` dependency) — consumed by Task 4 (self-heal iterates `ROLES` generically, needs no new consumption) and by Task 7's frontend `ROLES` array addition.

- [ ] **Step 1: Write the failing tests**

First, confirm where `ROLES` itself is tested:

```bash
grep -rn "ROLES" server/tests/*.py
```

Add a test (to whichever file already tests `ROLES`/`require_role`, or to `server/tests/test_participation.py` if none does) confirming the new role exists and is scoped correctly:

```python
def test_front_desk_role_exists():
    from tournament_server.auth import ROLES

    assert "front_desk" in ROLES
```

Add to `server/tests/test_participation.py`:

```python
def test_front_desk_can_check_in_teams(client):
    from tests.auth_helpers import bearer, login_as

    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    front_desk_token = login_as(client, "front_desk")
    response = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
        headers=bearer(front_desk_token),
    )
    assert response.status_code == 201
    assert response.json()["checked_in"] is True


def test_front_desk_cannot_create_sessions(client):
    from tests.auth_helpers import bearer, login_as

    client.post("/api/event", json={"name": "Regional Qualifier"})
    front_desk_token = login_as(client, "front_desk")

    response = client.post(
        "/api/sessions",
        json={"label": "Session 1"},
        headers=bearer(front_desk_token),
    )
    assert response.status_code == 403


def test_other_roles_still_cannot_check_in_teams(client):
    from tests.auth_helpers import bearer, login_as

    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    scorer_token = login_as(client, "scorer")
    response = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
        headers=bearer(scorer_token),
    )
    assert response.status_code == 403
```

Note: `client` here is the `_AutoAuthTestClient` fixture, which is already authenticated as `admin` for its own requests — `login_as`/`bearer` (from `tests/auth_helpers.py`) let a single test also act as a different role by passing explicit `headers=` on that one call, overriding the fixture's default `admin` bearer token for that request only. Check `tests/auth_helpers.py`'s `login_as` signature before using it — it takes a raw `TestClient`-like object and posts to `/api/auth/login`, which works fine against the `client` fixture too since it's a `TestClient` subclass.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && pytest tests/test_participation.py -k "front_desk" -v`
Expected: FAIL — `"front_desk" in ROLES` is false, and login as `"front_desk"` fails (the role doesn't exist, so `POST /api/auth/login` 422s or the event's role-credential seeding never created one for it).

- [ ] **Step 3: Update `server/src/tournament_server/auth.py`**

```python
ROLES = ("admin", "scorer", "judge", "referee", "attendee", "display_device", "front_desk")
```

Add, right after `require_scorer_or_referee`:

```python
require_admin_or_front_desk = require_role("front_desk")
```

- [ ] **Step 4: Update `server/src/tournament_server/routers/participation.py`**

Change `add_participant`'s dependency:

```python
from tournament_server.auth import require_admin_or_front_desk, require_any_role
```

```python
def add_participant(
    session_id: int,
    payload: ParticipationCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin_or_front_desk),
) -> SessionParticipation:
```

(`list_participants` keeps `require_any_role`, unchanged.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && pytest tests/test_participation.py -v`
Expected: all PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS — in particular, confirm no existing test asserted an exhaustive/hardcoded copy of `ROLES` elsewhere that would now be stale (grep `ROLES` across `server/tests/` once more after this change to be sure).

- [ ] **Step 7: Commit**

```bash
cd server
git add src/tournament_server/auth.py src/tournament_server/routers/participation.py tests/test_participation.py
git commit -m "Add front_desk role, scoped to check-in only"
```

---

### Task 4: Startup self-heal for missing role credentials

**Files:**
- Create: `server/src/tournament_server/services/role_credentials.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_migrations.py`

**Interfaces:**
- Consumes: `auth.ROLES` (Task 3).
- Produces: `backfill_role_credentials(db: Session) -> None` — a generic, idempotent self-heal step invoked once per `create_app()` startup. No later task consumes this directly; it exists so an existing event's database gets a `front_desk` credential without manual intervention, and so the *next* role this project ever adds self-heals the same way for free.

- [ ] **Step 1: Write the failing test**

Add to `server/tests/test_migrations.py` (following the exact pattern of `test_startup_self_heal_assigns_unassigned_teams_to_a_pre_existing_sole_division` just above it — raw SQL against a pre-existing database, then `create_app()`, then re-inspect):

```python
def test_startup_self_heal_backfills_missing_role_credential(tmp_path):
    """A database created before `front_desk` existed has RoleCredential
    rows for the original six roles only -- the next launch must backfill
    a front_desk row, seeded from the admin row's own password (both the
    hash and the encrypted copy), without touching any existing row."""
    db_path = str(tmp_path / "missing_role_credential.db")
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
        for role in ("admin", "scorer", "judge", "referee", "attendee", "display_device"):
            password_hash = f"hash-for-{role}"
            password_encrypted = f"encrypted-for-{role}" if role == "admin" else None
            connection.execute(
                text(
                    "INSERT INTO role_credentials (role, password_hash, password_encrypted) "
                    "VALUES (:role, :password_hash, :password_encrypted)"
                ),
                {"role": role, "password_hash": password_hash, "password_encrypted": password_encrypted},
            )
        connection.commit()

    create_app(db_path=db_path, plugins_root=str(tmp_path / "plugins"))

    with engine.connect() as connection:
        rows = connection.execute(
            text("SELECT role, password_hash, password_encrypted FROM role_credentials")
        ).all()
    by_role = {row.role: row for row in rows}
    assert set(by_role.keys()) == {
        "admin", "scorer", "judge", "referee", "attendee", "display_device", "front_desk",
    }
    assert by_role["front_desk"].password_hash == "hash-for-admin"
    assert by_role["front_desk"].password_encrypted == "encrypted-for-admin"
    # Pre-existing rows are untouched.
    assert by_role["scorer"].password_hash == "hash-for-scorer"

    # Idempotence: a second startup must not create a duplicate front_desk row.
    create_app(db_path=db_path, plugins_root=str(tmp_path / "plugins"))
    with engine.connect() as connection:
        front_desk_count = connection.execute(
            text("SELECT COUNT(*) FROM role_credentials WHERE role = 'front_desk'")
        ).scalar_one()
    assert front_desk_count == 1
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && pytest tests/test_migrations.py -k backfills_missing_role_credential -v`
Expected: FAIL — no `front_desk` row is ever created (`set(by_role.keys())` is missing it).

- [ ] **Step 3: Create `server/src/tournament_server/services/role_credentials.py`**

```python
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import ROLES
from tournament_server.models.role_credential import RoleCredential


def backfill_role_credentials(db: Session) -> None:
    """Ensures every role in ROLES has a RoleCredential row, for an event
    database that existed before a role was added to ROLES (e.g.
    front_desk). A backfilled row's password is copied from the current
    `admin` credential (both password_hash and password_encrypted) --
    mirroring POST /api/event's own original behavior of every role
    starting from one shared password until an admin differentiates them
    via Settings > Role Passwords. RoleCredential rows are not scoped per
    event (this project is one event per database file), so this needs no
    event argument. Idempotent: a no-op once every role already has a row."""
    existing_roles = {
        row for row in db.execute(select(RoleCredential.role)).scalars().all()
    }
    missing_roles = [role for role in ROLES if role not in existing_roles]
    if not missing_roles:
        return
    admin_credential = db.execute(
        select(RoleCredential).where(RoleCredential.role == "admin")
    ).scalars().first()
    if admin_credential is None:
        # No admin credential at all -- shouldn't happen for any real
        # event, since POST /api/event always seeds one. Nothing sensible
        # to copy from, so leave the missing roles missing rather than guess.
        return
    for role in missing_roles:
        db.add(
            RoleCredential(
                role=role,
                password_hash=admin_credential.password_hash,
                password_encrypted=admin_credential.password_encrypted,
            )
        )
```

- [ ] **Step 4: Wire it into `create_app()`'s self-heal in `server/src/tournament_server/app.py`**

Add the import alongside the existing `assign_sole_division` one:

```python
from tournament_server.services.role_credentials import backfill_role_credentials
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
            backfill_role_credentials(db)
            db.commit()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && pytest tests/test_migrations.py -v`
Expected: all PASS.

- [ ] **Step 6: Run the full backend suite**

Run: `cd server && pytest tests/ -v`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd server
git add src/tournament_server/services/role_credentials.py src/tournament_server/app.py tests/test_migrations.py
git commit -m "Self-heal missing role credentials for existing event databases"
```

---

### Task 5: Sessions list screen (`/sessions`)

**Files:**
- Modify: `frontend/apps/admin/src/types.ts`
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/components/AppShell.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/src/routes/SessionsRoute.tsx`
- Test: `frontend/apps/admin/tests/unit/SessionsRoute.test.tsx`

**Interfaces:**
- Consumes: `PATCH /api/sessions/{id}` (Task 1), `POST`/`GET /api/sessions` (already existed).
- Produces: `SessionRead` type (in `types.ts`) — consumed by Task 6's `SessionDetailLayout` and Task 6/7's check-in components; the `["sessions"]` TanStack Query key — consumed by Task 6 (reused, not re-fetched).

- [ ] **Step 1: Add `SessionRead` to `frontend/apps/admin/src/types.ts`**

```ts
export interface SessionRead {
  id: number;
  event_id: number;
  label: string;
  session_date: string | null;
  timezone: string | null;
}
```

- [ ] **Step 2: Add i18n strings**

Add to `frontend/apps/admin/src/i18n/en/admin.json`'s `shell` section:

```json
"sessionsLink": "Sessions"
```

Add a new top-level `sessions` section (after `divisions`, before `dashboard`, matching the file's existing key order):

```json
"sessions": {
  "heading": "Sessions",
  "columnLabel": "Label",
  "columnDate": "Date",
  "columnTimezone": "Timezone",
  "labelLabel": "Label",
  "dateLabel": "Date (optional)",
  "timezoneLabel": "Timezone (optional)",
  "noTimezoneOption": "No timezone set",
  "editAction": "Edit",
  "saveAction": "Save",
  "cancelAction": "Cancel",
  "addSessionAction": "Add session...",
  "addSubmit": "Add session"
}
```

Add the matching keys to `frontend/apps/admin/src/i18n/zh/admin.json`'s `shell` section:

```json
"sessionsLink": "场次"
```

And a new `sessions` section there:

```json
"sessions": {
  "heading": "场次",
  "columnLabel": "名称",
  "columnDate": "日期",
  "columnTimezone": "时区",
  "labelLabel": "名称",
  "dateLabel": "日期(可选)",
  "timezoneLabel": "时区(可选)",
  "noTimezoneOption": "未设置时区",
  "editAction": "编辑",
  "saveAction": "保存",
  "cancelAction": "取消",
  "addSessionAction": "添加场次...",
  "addSubmit": "添加场次"
}
```

- [ ] **Step 3: Create `frontend/apps/admin/src/routes/SessionsRoute.tsx`**

```tsx
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { SessionRead } from "../types";

function listTimezones(): string[] {
  const intlWithZones = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  return intlWithZones.supportedValuesOf?.("timeZone") ?? [];
}

interface SessionFormValues {
  label: string;
  sessionDate: string;
  timezone: string;
}

const EMPTY_FORM: SessionFormValues = { label: "", sessionDate: "", timezone: "" };

function SessionForm({
  initial,
  onSubmit,
  onCancel,
  submitLabel,
  isSaving,
  error,
}: {
  initial: SessionFormValues;
  onSubmit: (values: SessionFormValues) => void;
  onCancel: () => void;
  submitLabel: string;
  isSaving: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState(initial);
  const timezones = listTimezones();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSubmit(values);
  }

  return (
    <form className="panel panel--form" onSubmit={handleSubmit}>
      <div className="field">
        <label className="field__label" htmlFor="session-label">
          {t("sessions.labelLabel")}
        </label>
        <input
          className="input"
          id="session-label"
          value={values.label}
          onChange={(event) => setValues({ ...values, label: event.target.value })}
          autoFocus
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="session-date">
          {t("sessions.dateLabel")}
        </label>
        <input
          className="input"
          id="session-date"
          type="date"
          value={values.sessionDate}
          onChange={(event) => setValues({ ...values, sessionDate: event.target.value })}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="session-timezone">
          {t("sessions.timezoneLabel")}
        </label>
        <select
          className="select"
          id="session-timezone"
          value={values.timezone}
          onChange={(event) => setValues({ ...values, timezone: event.target.value })}
        >
          <option value="">{t("sessions.noTimezoneOption")}</option>
          {timezones.map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="alert alert-danger" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={isSaving}>
          {submitLabel}
        </button>
        <button className="btn" type="button" onClick={onCancel} disabled={isSaving}>
          {t("sessions.cancelAction")}
        </button>
      </div>
    </form>
  );
}

export function SessionsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);

  const { data: sessions } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
  });

  const createMutation = useMutation({
    mutationFn: (values: SessionFormValues) =>
      apiRequest<SessionRead>("/api/sessions", {
        method: "POST",
        body: {
          label: values.label,
          session_date: values.sessionDate || null,
          timezone: values.timezone || null,
        },
      }),
    onSuccess: () => {
      setCreating(false);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: number; values: SessionFormValues }) =>
      apiRequest<SessionRead>(`/api/sessions/${id}`, {
        method: "PATCH",
        body: {
          label: values.label,
          session_date: values.sessionDate || null,
          timezone: values.timezone || null,
        },
      }),
    onSuccess: () => {
      setEditingId(null);
      queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  return (
    <div>
      <h1>{t("sessions.heading")}</h1>
      <table className="table">
        <thead>
          <tr>
            <th>{t("sessions.columnLabel")}</th>
            <th>{t("sessions.columnDate")}</th>
            <th>{t("sessions.columnTimezone")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sessions?.map((session) =>
            editingId === session.id ? (
              <tr key={session.id}>
                <td colSpan={4}>
                  <SessionForm
                    initial={{
                      label: session.label,
                      sessionDate: session.session_date ?? "",
                      timezone: session.timezone ?? "",
                    }}
                    onSubmit={(values) => updateMutation.mutate({ id: session.id, values })}
                    onCancel={() => {
                      setEditingId(null);
                      updateMutation.reset();
                    }}
                    submitLabel={t("sessions.saveAction")}
                    isSaving={updateMutation.isPending && updateMutation.variables?.id === session.id}
                    error={
                      updateMutation.isError && updateMutation.variables?.id === session.id
                        ? updateMutation.error instanceof ApiError
                          ? updateMutation.error.detail
                          : t("errors.generic")
                        : null
                    }
                  />
                </td>
              </tr>
            ) : (
              <tr key={session.id}>
                <td>
                  <Link to={`/sessions/${session.id}`}>{session.label}</Link>
                </td>
                <td>{session.session_date ?? "—"}</td>
                <td>{session.timezone ?? "—"}</td>
                <td>
                  <button className="btn btn-small" onClick={() => setEditingId(session.id)}>
                    {t("sessions.editAction")}
                  </button>
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>

      {!creating && (
        <button className="btn" type="button" onClick={() => setCreating(true)}>
          {t("sessions.addSessionAction")}
        </button>
      )}
      {creating && (
        <SessionForm
          initial={EMPTY_FORM}
          onSubmit={(values) => createMutation.mutate(values)}
          onCancel={() => {
            setCreating(false);
            createMutation.reset();
          }}
          submitLabel={t("sessions.addSubmit")}
          isSaving={createMutation.isPending}
          error={
            createMutation.isError
              ? createMutation.error instanceof ApiError
                ? createMutation.error.detail
                : t("errors.generic")
              : null
          }
        />
      )}
    </div>
  );
}
```

- [ ] **Step 4: Wire the route into `frontend/apps/admin/src/router.tsx`**

Add the import:

```tsx
import { SessionsRoute } from "./routes/SessionsRoute";
```

Add to the `AuthenticatedLayout`'s `children` array (after `{ path: "teams", element: <TeamsRoute /> }`):

```tsx
{ path: "sessions", element: <SessionsRoute /> },
```

- [ ] **Step 5: Add the nav item in `frontend/apps/admin/src/components/AppShell.tsx`**

Add, after the Teams `NavLink`, still inside the existing `role === "admin" && (<nav>...)` block:

```tsx
<NavLink to="/sessions" className={navLinkClassName}>
  {t("shell.sessionsLink")}
</NavLink>
```

- [ ] **Step 6: Write component tests**

Create `frontend/apps/admin/tests/unit/SessionsRoute.test.tsx`, following `DashboardRoute.test.tsx`'s exact setup pattern (a `vi.mock("@tournament-admin/shared", ...)` for `apiRequest`, `initI18n` with the real `en/admin.json`, a fresh `QueryClient` per test):

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionsRoute } from "../../src/routes/SessionsRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SessionsRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("SessionsRoute", () => {
  it("lists existing sessions", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: "2026-09-05", timezone: "America/Los_Angeles" },
        ] as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    expect(await screen.findByText("Saturday")).toBeInTheDocument();
    expect(screen.getByText("2026-09-05")).toBeInTheDocument();
    expect(screen.getByText("America/Los_Angeles")).toBeInTheDocument();
  });

  it("creates a new session", async () => {
    let createBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) return [] as never;
      if (path === "/api/sessions" && (options as { method?: string })?.method === "POST") {
        createBody = (options as { body: unknown }).body;
        return { id: 2, event_id: 1, label: "Sunday", session_date: null, timezone: null } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByRole("button", { name: "Add session..." });
    fireEvent.click(screen.getByRole("button", { name: "Add session..." }));
    fireEvent.change(screen.getByLabelText("Label"), { target: { value: "Sunday" } });
    fireEvent.click(screen.getByRole("button", { name: "Add session" }));

    await waitFor(() =>
      expect(createBody).toEqual({ label: "Sunday", session_date: null, timezone: null })
    );
  });

  it("edits an existing session", async () => {
    let patchBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) {
        return [
          { id: 1, event_id: 1, label: "Saturday", session_date: null, timezone: null },
        ] as never;
      }
      if (path === "/api/sessions/1" && (options as { method?: string })?.method === "PATCH") {
        patchBody = (options as { body: unknown }).body;
        return { id: 1, event_id: 1, label: "Renamed", session_date: null, timezone: null } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Saturday");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const labelInputs = screen.getAllByLabelText("Label");
    fireEvent.change(labelInputs[labelInputs.length - 1], { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patchBody).toEqual({ label: "Renamed", session_date: null, timezone: null })
    );
  });

  it("shows an inline error on a failed create", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions" && !options) return [] as never;
      if (path === "/api/sessions" && (options as { method?: string })?.method === "POST") {
        throw new ApiError(422, "Label cannot be empty");
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByRole("button", { name: "Add session..." });
    fireEvent.click(screen.getByRole("button", { name: "Add session..." }));
    fireEvent.click(screen.getByRole("button", { name: "Add session" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Label cannot be empty");
  });
});
```

Note: the "creates a new session" test's create form and the "edits" test's edit form both render a `<label>Label</label>` input — `getAllByLabelText("Label")` in the edit test picks the last one deliberately (there is exactly one visible at a time per test, but `getAllByLabelText` is the safer query if `SessionForm` is ever rendered twice on screen). If `screen.getByLabelText("Label")` proves unambiguous in practice (only one `SessionForm` mounted per test), simplify to that instead — verify by running the test.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd frontend/apps/admin && npm test -- SessionsRoute`
Expected: all PASS.

- [ ] **Step 8: Run the full frontend unit suite**

Run: `cd frontend/apps/admin && npm test`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
cd frontend/apps/admin
git add src/types.ts src/router.tsx src/components/AppShell.tsx src/i18n/en/admin.json src/i18n/zh/admin.json src/routes/SessionsRoute.tsx tests/unit/SessionsRoute.test.tsx
git commit -m "Add Sessions list screen with create/edit"
```

---

### Task 6: `SessionDetailLayout` and the admin check-in tab

**Files:**
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/src/routes/SessionDetailLayout.tsx`
- Create: `frontend/apps/admin/src/routes/SessionCheckinRoute.tsx`
- Test: `frontend/apps/admin/tests/unit/SessionCheckinRoute.test.tsx`

**Interfaces:**
- Consumes: `SessionRead` (Task 5), the `["sessions"]` query key (Task 5, reused rather than re-fetched — there is no `GET /api/sessions/{id}` endpoint, matching this project's existing convention for `Division`/`FieldSet`, so the layout finds its session client-side from the already-fetched list).
- Produces: the `Outlet` context shape `{ session: SessionRead }` — consumed by this task's own `SessionCheckinRoute` and by any later tab a future sub-project adds to the same layout.

- [ ] **Step 1: Add i18n strings**

Add to `frontend/apps/admin/src/i18n/en/admin.json`'s `sessions` section (added in Task 5):

```json
"checkinTab": "Check-In",
"loading": "Loading…",
"notFound": "Session not found.",
"noDateSet": "No date set",
"noTimezoneSet": "No timezone set",
"checkin": {
  "columnNumber": "Number",
  "columnName": "Name",
  "columnDivision": "Division",
  "columnCheckedIn": "Checked In",
  "toggleAction": "Toggle check-in for {{name}}",
  "filterPlaceholder": "Filter by number or name",
  "checkInAllVisible": "Check in all visible",
  "checkOutAllVisible": "Check out all visible"
}
```

Add the matching keys to `frontend/apps/admin/src/i18n/zh/admin.json`'s `sessions` section:

```json
"checkinTab": "签到",
"loading": "加载中…",
"notFound": "未找到该场次。",
"noDateSet": "未设置日期",
"noTimezoneSet": "未设置时区",
"checkin": {
  "columnNumber": "编号",
  "columnName": "名称",
  "columnDivision": "分组",
  "columnCheckedIn": "已签到",
  "toggleAction": "切换 {{name}} 的签到状态",
  "filterPlaceholder": "按编号或名称筛选",
  "checkInAllVisible": "全部签到(当前可见)",
  "checkOutAllVisible": "全部取消签到(当前可见)"
}
```

- [ ] **Step 2: Create `frontend/apps/admin/src/routes/SessionDetailLayout.tsx`**

```tsx
import { NavLink, Outlet, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import type { SessionRead } from "../types";

function tabLinkClassName({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

export function SessionDetailLayout() {
  const { t } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();

  const { data: sessions, isLoading } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
  });
  const session = sessions?.find((candidate) => candidate.id === Number(sessionId));

  if (isLoading) {
    return <p>{t("sessions.loading")}</p>;
  }
  if (!session) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("sessions.notFound")}
      </p>
    );
  }

  return (
    <div>
      <div className="session-detail__header">
        <h1>{session.label}</h1>
        <p className="session-detail__meta">
          {session.session_date ?? t("sessions.noDateSet")}
          {" · "}
          {session.timezone ?? t("sessions.noTimezoneSet")}
        </p>
      </div>
      <nav className="app-nav app-nav--sub">
        <NavLink to={`/sessions/${session.id}/checkin`} className={tabLinkClassName}>
          {t("sessions.checkinTab")}
        </NavLink>
      </nav>
      <Outlet context={{ session }} />
    </div>
  );
}
```

- [ ] **Step 3: Create `frontend/apps/admin/src/routes/SessionCheckinRoute.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { DataGrid, type Column } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { Division, SessionRead } from "../types";

interface TeamApiRow {
  id: number;
  number: string;
  name: string;
  division_id: number | null;
}

interface ParticipationApiRow {
  id: number;
  session_id: number;
  team_id: number;
  checked_in: boolean;
}

interface CheckinGridRow {
  id: number;
  number: string;
  name: string;
  division: string;
  checkedIn: boolean;
}

export function SessionCheckinRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const queryClient = useQueryClient();
  const [filterText, setFilterText] = useState("");

  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamApiRow[]>("/api/teams"),
  });
  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { data: participants } = useQuery({
    queryKey: ["participants", session.id],
    queryFn: () =>
      apiRequest<ParticipationApiRow[]>(`/api/sessions/${session.id}/participants`),
  });

  const divisionNameById = useMemo(() => {
    const map = new Map<number, string>();
    for (const division of divisions ?? []) map.set(division.id, division.name);
    return map;
  }, [divisions]);

  const checkedInByTeamId = useMemo(() => {
    const map = new Map<number, boolean>();
    for (const participation of participants ?? []) {
      map.set(participation.team_id, participation.checked_in);
    }
    return map;
  }, [participants]);

  const allRows: CheckinGridRow[] = useMemo(
    () =>
      (teams ?? []).map((team) => ({
        id: team.id,
        number: team.number,
        name: team.name,
        division: team.division_id !== null ? (divisionNameById.get(team.division_id) ?? "") : "",
        checkedIn: checkedInByTeamId.get(team.id) ?? false,
      })),
    [teams, divisionNameById, checkedInByTeamId]
  );

  const filteredRows = useMemo(() => {
    const query = filterText.trim().toLowerCase();
    if (!query) return allRows;
    return allRows.filter(
      (row) => row.number.toLowerCase().includes(query) || row.name.toLowerCase().includes(query)
    );
  }, [allRows, filterText]);

  const sortedRows = useMemo(
    () =>
      [...filteredRows].sort((a, b) =>
        a.division !== b.division
          ? a.division.localeCompare(b.division)
          : a.number.localeCompare(b.number)
      ),
    [filteredRows]
  );

  const toggleMutation = useMutation({
    mutationFn: ({ teamId, checkedIn }: { teamId: number; checkedIn: boolean }) =>
      apiRequest(`/api/sessions/${session.id}/participants`, {
        method: "POST",
        body: { team_id: teamId, checked_in: checkedIn },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["participants", session.id] });
    },
  });

  const bulkMutation = useMutation({
    mutationFn: async (checkedIn: boolean) => {
      await Promise.all(
        sortedRows.map((row) =>
          apiRequest(`/api/sessions/${session.id}/participants`, {
            method: "POST",
            body: { team_id: row.id, checked_in: checkedIn },
          })
        )
      );
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["participants", session.id] });
    },
  });

  const showDivisionColumn = (divisions?.length ?? 0) > 1;

  const columns: Column<CheckinGridRow>[] = useMemo(() => {
    const base: Column<CheckinGridRow>[] = [
      { key: "number", name: t("sessions.checkin.columnNumber") },
      { key: "name", name: t("sessions.checkin.columnName") },
    ];
    if (showDivisionColumn) {
      base.push({ key: "division", name: t("sessions.checkin.columnDivision") });
    }
    base.push({
      key: "checkedIn",
      name: t("sessions.checkin.columnCheckedIn"),
      renderCell: ({ row }) => (
        <input
          type="checkbox"
          aria-label={t("sessions.checkin.toggleAction", { name: row.name })}
          checked={row.checkedIn}
          onChange={(event) =>
            toggleMutation.mutate({ teamId: row.id, checkedIn: event.target.checked })
          }
        />
      ),
    });
    return base;
  }, [t, showDivisionColumn, toggleMutation]);

  return (
    <div>
      <div className="form-actions">
        <input
          className="input"
          placeholder={t("sessions.checkin.filterPlaceholder")}
          aria-label={t("sessions.checkin.filterPlaceholder")}
          value={filterText}
          onChange={(event) => setFilterText(event.target.value)}
        />
        <button className="btn btn-small" onClick={() => bulkMutation.mutate(true)}>
          {t("sessions.checkin.checkInAllVisible")}
        </button>
        <button className="btn btn-small" onClick={() => bulkMutation.mutate(false)}>
          {t("sessions.checkin.checkOutAllVisible")}
        </button>
      </div>
      {bulkMutation.isError && (
        <p className="alert alert-danger" role="alert">
          {bulkMutation.error instanceof ApiError ? bulkMutation.error.detail : t("errors.generic")}
        </p>
      )}
      <DataGrid columns={columns} rows={sortedRows} rowKeyGetter={(row) => row.id} />
    </div>
  );
}
```

- [ ] **Step 4: Wire the nested routes into `frontend/apps/admin/src/router.tsx`**

Add the imports:

```tsx
import { redirect } from "react-router-dom"; // already imported at the top — just add to the existing import
import { SessionDetailLayout } from "./routes/SessionDetailLayout";
import { SessionCheckinRoute } from "./routes/SessionCheckinRoute";
```

(`redirect` is already imported at the top of `router.tsx` — don't duplicate the import, just reuse it.)

Add, as a sibling of the `sessions` route added in Task 5 (inside `AuthenticatedLayout`'s `children`):

```tsx
{
  path: "sessions/:sessionId",
  element: <SessionDetailLayout />,
  children: [
    {
      index: true,
      loader: ({ params }) => redirect(`/sessions/${params.sessionId}/checkin`),
    },
    { path: "checkin", element: <SessionCheckinRoute /> },
  ],
},
```

- [ ] **Step 5: Write component tests**

Create `frontend/apps/admin/tests/unit/SessionCheckinRoute.test.tsx`. Since `SessionCheckinRoute` reads its session via `useOutletContext`, wrap it in a `MemoryRouter` with a route tree that supplies that context directly (simpler than mounting the real `SessionDetailLayout`):

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionCheckinRoute } from "../../src/routes/SessionCheckinRoute";
import type { SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: null,
  timezone: null,
};

function TestLayout() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    {
      path: "/",
      element: <TestLayout />,
      children: [{ index: true, element: <SessionCheckinRoute /> }],
    },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("SessionCheckinRoute", () => {
  it("shows a team with no participation row as unchecked", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/teams") {
        return [{ id: 1, number: "1234A", name: "Robo Raiders", division_id: null }] as never;
      }
      if (path === "/api/divisions") return [] as never;
      if (path === "/api/sessions/1/participants") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const checkbox = await screen.findByLabelText("Toggle check-in for Robo Raiders");
    expect(checkbox).not.toBeChecked();
  });

  it("shows a checked-in team as checked, and toggling posts the new state", async () => {
    let postBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/teams") {
        return [{ id: 1, number: "1234A", name: "Robo Raiders", division_id: null }] as never;
      }
      if (path === "/api/divisions") return [] as never;
      if (path === "/api/sessions/1/participants" && !options) {
        return [{ id: 1, session_id: 1, team_id: 1, checked_in: true }] as never;
      }
      if (path === "/api/sessions/1/participants" && (options as { method?: string })?.method === "POST") {
        postBody = (options as { body: unknown }).body;
        return { id: 1, session_id: 1, team_id: 1, checked_in: false } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const checkbox = await screen.findByLabelText("Toggle check-in for Robo Raiders");
    expect(checkbox).toBeChecked();

    fireEvent.click(checkbox);
    await waitFor(() => expect(postBody).toEqual({ team_id: 1, checked_in: false }));
  });

  it("only shows the Division column when the event has more than one division", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/teams") return [] as never;
      if (path === "/api/divisions") return [{ id: 1, event_id: 1, name: "Division 1", target_team_count: null }] as never;
      if (path === "/api/sessions/1/participants") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText("Number");
    expect(screen.queryByText("Division")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend/apps/admin && npm test -- SessionCheckinRoute`
Expected: all PASS.

- [ ] **Step 7: Run the full frontend unit suite**

Run: `cd frontend/apps/admin && npm test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
cd frontend/apps/admin
git add src/router.tsx src/i18n/en/admin.json src/i18n/zh/admin.json src/routes/SessionDetailLayout.tsx src/routes/SessionCheckinRoute.tsx tests/unit/SessionCheckinRoute.test.tsx
git commit -m "Add per-session layout with a tab strip and the admin check-in grid"
```

---

### Task 7: `front_desk` role frontend wiring

**Files:**
- Modify: `frontend/apps/admin/src/routes/SettingsRolesRoute.tsx`
- Modify: `frontend/apps/admin/src/components/AppShell.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/AppShell.test.tsx` (check whether this file already exists — if so, add to it; if not, create it)

**Interfaces:**
- Consumes: `front_desk` role (Task 3, backend).
- Produces: nothing new for later tasks — this makes the already-existing `SettingsRolesRoute` and the role-gated nav aware of the new role, which Task 8's `/checkin` route depends on for its nav link to appear, but the route itself is independent.

- [ ] **Step 1: Update `SettingsRolesRoute.tsx`'s `ROLES` array**

```tsx
const ROLES = ["admin", "scorer", "judge", "referee", "attendee", "display_device", "front_desk"];
```

- [ ] **Step 2: Add the `shell.checkinLink` i18n key**

Add to `frontend/apps/admin/src/i18n/en/admin.json`'s `shell` section:

```json
"checkinLink": "Check-In"
```

Add to `frontend/apps/admin/src/i18n/zh/admin.json`'s `shell` section:

```json
"checkinLink": "签到"
```

- [ ] **Step 3: Write the failing test for `AppShell`'s role-gated nav**

First, check whether `frontend/apps/admin/tests/unit/AppShell.test.tsx` already exists:

```bash
ls frontend/apps/admin/tests/unit/AppShell.test.tsx
```

If it exists, add this test to it, matching its existing setup pattern. If it doesn't, create it following `DashboardRoute.test.tsx`'s pattern (mock `@tournament-admin/shared`'s `apiRequest`, but here the more relevant mock target is `useAuth` — mock the whole `@tournament-admin/shared` module and override both `apiRequest` and `useAuth`):

```tsx
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { AppShell } from "../../src/components/AppShell";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return {
    ...actual,
    apiRequest: vi.fn(async () => ({})),
    useAuth: vi.fn(),
  };
});

import { useAuth } from "@tournament-admin/shared";

function renderShell() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter>
        <AppShell />
      </MemoryRouter>
    </I18nextProvider>
  );
}

describe("AppShell role-gated navigation", () => {
  it("shows only the Check-In link for the front_desk role", () => {
    vi.mocked(useAuth).mockReturnValue({
      role: "front_desk",
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    renderShell();

    expect(screen.getByRole("link", { name: "Check-In" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Divisions" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sessions" })).not.toBeInTheDocument();
  });

  it("shows the full admin nav including Sessions for the admin role", () => {
    vi.mocked(useAuth).mockReturnValue({
      role: "admin",
      isAuthenticated: true,
      login: vi.fn(),
      logout: vi.fn(),
    });
    renderShell();

    expect(screen.getByRole("link", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Check-In" })).not.toBeInTheDocument();
  });
});
```

If an `AppShell.test.tsx` already exists with a different mocking setup (e.g. it renders through a full router with real loaders), adapt these two test cases to that file's existing conventions rather than introducing a second, inconsistent pattern — the two assertions (front_desk sees only Check-In; admin sees Sessions but not Check-In) are what matters, not the exact harness.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend/apps/admin && npm test -- AppShell`
Expected: FAIL — there is no `front_desk`-gated nav block yet, and no "Check-In" link exists at all.

- [ ] **Step 3: Update `AppShell.tsx`'s nav**

Add the Sessions link to the existing admin nav block (after the Teams link):

```tsx
<NavLink to="/sessions" className={navLinkClassName}>
  {t("shell.sessionsLink")}
</NavLink>
```

(This may already be done if Task 5 landed first in execution order — check before duplicating.)

Add a new sibling block, right after the closing `)}` of the `role === "admin" && (...)` nav block:

```tsx
{role === "front_desk" && (
  <nav className="app-nav" ref={navRef}>
    <NavLink to="/checkin" className={navLinkClassName}>
      {t("shell.checkinLink")}
    </NavLink>
  </nav>
)}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend/apps/admin && npm test -- AppShell`
Expected: all PASS.

- [ ] **Step 5: Run the full frontend unit suite**

Run: `cd frontend/apps/admin && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd frontend/apps/admin
git add src/routes/SettingsRolesRoute.tsx src/components/AppShell.tsx src/i18n/en/admin.json src/i18n/zh/admin.json tests/unit/AppShell.test.tsx
git commit -m "Wire front_desk role into Settings and AppShell's role-gated nav"
```

---

### Task 8: Dedicated front-desk check-in screen (`/checkin`)

**Files:**
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Modify: `frontend/apps/admin/src/styles/components.css` (or `tokens.css` for new design tokens, per that file's own convention — read both before adding)
- Create: `frontend/apps/admin/src/routes/FrontDeskCheckinRoute.tsx`
- Test: `frontend/apps/admin/tests/unit/FrontDeskCheckinRoute.test.tsx`

**Interfaces:**
- Consumes: `EventRead` (already in `types.ts`), the upsert-capable `POST /api/sessions/{id}/participants` (Task 2), `front_desk` role (Task 3/7).
- Produces: nothing new for later tasks — this is the last piece of frontend functionality this plan builds.

- [ ] **Step 1: Add i18n strings**

Add a new top-level `frontDeskCheckin` section to `frontend/apps/admin/src/i18n/en/admin.json` (after `sessions`):

```json
"frontDeskCheckin": {
  "heading": "Team Check-In",
  "searchPlaceholder": "Search by team number or name",
  "noActiveSession": "No active session — ask an admin to set one.",
  "checkInAction": "Check In",
  "checkedInState": "Checked In"
}
```

Add the matching section to `frontend/apps/admin/src/i18n/zh/admin.json`:

```json
"frontDeskCheckin": {
  "heading": "队伍签到",
  "searchPlaceholder": "按队伍编号或名称搜索",
  "noActiveSession": "当前没有激活的场次 — 请联系管理员设置。",
  "checkInAction": "签到",
  "checkedInState": "已签到"
}
```

- [ ] **Step 2: Create `frontend/apps/admin/src/routes/FrontDeskCheckinRoute.tsx`**

```tsx
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { EventRead } from "../types";

interface TeamApiRow {
  id: number;
  number: string;
  name: string;
}

interface ParticipationApiRow {
  team_id: number;
  checked_in: boolean;
}

export function FrontDeskCheckinRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const sessionId = event?.active_session_id ?? null;

  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamApiRow[]>("/api/teams"),
  });
  const { data: participants } = useQuery({
    queryKey: ["participants", sessionId],
    queryFn: () => apiRequest<ParticipationApiRow[]>(`/api/sessions/${sessionId}/participants`),
    enabled: sessionId !== null,
  });

  const checkedInByTeamId = useMemo(() => {
    const map = new Map<number, boolean>();
    for (const participation of participants ?? []) {
      map.set(participation.team_id, participation.checked_in);
    }
    return map;
  }, [participants]);

  const visibleTeams = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return teams ?? [];
    return (teams ?? []).filter(
      (team) =>
        team.number.toLowerCase().includes(normalizedQuery) ||
        team.name.toLowerCase().includes(normalizedQuery)
    );
  }, [teams, query]);

  const checkInMutation = useMutation({
    mutationFn: (teamId: number) =>
      apiRequest(`/api/sessions/${sessionId}/participants`, {
        method: "POST",
        body: { team_id: teamId, checked_in: true },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["participants", sessionId] });
    },
  });

  if (sessionId === null) {
    return (
      <div className="front-desk-checkin">
        <p className="alert alert-danger" role="alert">
          {t("frontDeskCheckin.noActiveSession")}
        </p>
      </div>
    );
  }

  return (
    <div className="front-desk-checkin">
      <h1>{t("frontDeskCheckin.heading")}</h1>
      <input
        className="input input--large"
        placeholder={t("frontDeskCheckin.searchPlaceholder")}
        aria-label={t("frontDeskCheckin.searchPlaceholder")}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        autoFocus
      />
      {checkInMutation.isError && (
        <p className="alert alert-danger" role="alert">
          {checkInMutation.error instanceof ApiError
            ? checkInMutation.error.detail
            : t("errors.generic")}
        </p>
      )}
      <ul className="front-desk-checkin__list">
        {visibleTeams.map((team) => {
          const checkedIn = checkedInByTeamId.get(team.id) ?? false;
          return (
            <li className="front-desk-checkin__row" key={team.id}>
              <span className="front-desk-checkin__team">
                {team.number} — {team.name}
              </span>
              <button
                type="button"
                className={checkedIn ? "btn btn-success btn-large" : "btn btn-primary btn-large"}
                disabled={checkedIn || checkInMutation.isPending}
                onClick={() => checkInMutation.mutate(team.id)}
              >
                {checkedIn ? t("frontDeskCheckin.checkedInState") : t("frontDeskCheckin.checkInAction")}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

- [ ] **Step 3: Add CSS for the new classes**

Read `frontend/apps/admin/src/styles/tokens.css` and `components.css` first to match existing spacing/color/font-size token names. Add rules for `.front-desk-checkin`, `.front-desk-checkin__list`, `.front-desk-checkin__row`, `.front-desk-checkin__team`, `.input--large`, `.btn-large`, `.btn-success` — this screen is meant to be usable at a glance by non-technical front-desk staff, so prioritize large touch targets (minimum ~48px tall interactive elements) and generous spacing between rows over information density. Use the existing design system's tokens (colors, spacing scale, font sizes) rather than introducing new hardcoded values — `.btn-success` in particular should reuse whatever "positive/confirmed" color token `badge-warning`/`alert-success`-style classes elsewhere in `components.css` already establish, not a new arbitrary green.

- [ ] **Step 4: Wire the route into `frontend/apps/admin/src/router.tsx`**

Add the import:

```tsx
import { FrontDeskCheckinRoute } from "./routes/FrontDeskCheckinRoute";
```

Add to `AuthenticatedLayout`'s `children` array:

```tsx
{ path: "checkin", element: <FrontDeskCheckinRoute /> },
```

- [ ] **Step 5: Write component tests**

Create `frontend/apps/admin/tests/unit/FrontDeskCheckinRoute.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { FrontDeskCheckinRoute } from "../../src/routes/FrontDeskCheckinRoute";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

function renderRoute() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <FrontDeskCheckinRoute />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

describe("FrontDeskCheckinRoute", () => {
  it("shows a clear empty state when no session is active", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: null, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/teams") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No active session — ask an admin to set one."
    );
  });

  it("shows teams and lets you check one in, disabling the button once checked", async () => {
    let postBody: unknown = null;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: 5, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/teams") {
        return [{ id: 1, number: "1234A", name: "Robo Raiders" }] as never;
      }
      if (path === "/api/sessions/5/participants" && !options) {
        return [] as never;
      }
      if (path === "/api/sessions/5/participants" && (options as { method?: string })?.method === "POST") {
        postBody = (options as { body: unknown }).body;
        return { id: 1, session_id: 5, team_id: 1, checked_in: true } as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText(/1234A/);
    const checkInButton = screen.getByRole("button", { name: "Check In" });
    fireEvent.click(checkInButton);

    await waitFor(() => expect(postBody).toEqual({ team_id: 1, checked_in: true }));
  });

  it("shows an already-checked-in team as checked in from the start", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: 5, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/teams") {
        return [{ id: 1, number: "1234A", name: "Robo Raiders" }] as never;
      }
      if (path === "/api/sessions/5/participants") {
        return [{ team_id: 1, checked_in: true }] as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    const checkedButton = await screen.findByRole("button", { name: "Checked In" });
    expect(checkedButton).toBeDisabled();
  });

  it("filters the visible list by the search query", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/event") {
        return { id: 1, name: "Regional Qualifier", active_session_id: 5, game_plugin_name: null, created_at: "2026-01-01T00:00:00Z" } as never;
      }
      if (path === "/api/teams") {
        return [
          { id: 1, number: "1234A", name: "Robo Raiders" },
          { id: 2, number: "5678B", name: "Circuit Breakers" },
        ] as never;
      }
      if (path === "/api/sessions/5/participants") return [] as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderRoute();

    await screen.findByText(/1234A/);
    fireEvent.change(screen.getByLabelText("Search by team number or name"), {
      target: { value: "5678B" },
    });

    expect(screen.queryByText(/1234A/)).not.toBeInTheDocument();
    expect(screen.getByText(/5678B/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd frontend/apps/admin && npm test -- FrontDeskCheckinRoute`
Expected: all PASS.

- [ ] **Step 7: Run the full frontend unit suite**

Run: `cd frontend/apps/admin && npm test`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
cd frontend/apps/admin
git add src/router.tsx src/i18n/en/admin.json src/i18n/zh/admin.json src/styles/components.css src/styles/tokens.css src/routes/FrontDeskCheckinRoute.tsx tests/unit/FrontDeskCheckinRoute.test.tsx
git commit -m "Add dedicated front-desk check-in screen"
```

---

### Task 9: End-to-end test

**Files:**
- Create: `frontend/apps/admin/tests/e2e/sessionCheckin.spec.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-8.
- Produces: nothing — this is the final integration proof for this plan.

- [ ] **Step 1: Write the E2E test**

```ts
import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("session check-in", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());

    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    const { access_token: token } = await loginResponse.json();

    for (const number of ["9001A", "9002A"]) {
      const response = await request.post("/api/teams", {
        headers: { Authorization: `Bearer ${token}` },
        data: { number, name: `Checkin Team ${number}` },
      });
      expect([201, 409]).toContain(response.status());
    }
  });

  test("admin creates a session and checks in a team; front_desk sees and extends it; admin sees the result", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Sessions" }).click();
    await expect(page).toHaveURL(/\/sessions$/);

    await page.getByRole("button", { name: "Add session..." }).click();
    await page.getByLabel("Label").fill("Check-In Day");
    await page.getByRole("button", { name: "Add session", exact: true }).click();
    await expect(page.getByText("Check-In Day")).toBeVisible();

    await page.getByRole("link", { name: "Check-In Day" }).click();
    await expect(page).toHaveURL(/\/sessions\/\d+\/checkin$/);
    const sessionId = page.url().match(/\/sessions\/(\d+)\//)?.[1];
    expect(sessionId).toBeTruthy();

    const firstRowCheckbox = page.getByLabel(/Toggle check-in for Checkin Team 9001A/);
    await firstRowCheckbox.check();
    await expect(firstRowCheckbox).toBeChecked();

    await page.request.post("/api/event/active-session", {
      data: { session_id: Number(sessionId) },
    });

    await page.getByRole("button", { name: "Log out" }).click();
    await expect(page).toHaveURL("/login");

    await page.getByLabel("Role").fill("front_desk");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/checkin");

    await expect(page.getByRole("link", { name: "Check-In" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Sessions" })).not.toBeVisible();
    await expect(page.getByRole("link", { name: "Divisions" })).not.toBeVisible();

    await expect(page.getByText(/9001A/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Checked In" })).toBeVisible();

    await page.getByLabel("Search by team number or name").fill("9002A");
    await page.getByRole("button", { name: "Check In", exact: true }).click();
    await expect(page.getByRole("button", { name: "Checked In" })).toBeVisible();

    await page.getByRole("button", { name: "Log out" }).click();
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.goto(`/sessions/${sessionId}/checkin`);

    await expect(page.getByLabel(/Toggle check-in for Checkin Team 9002A/)).toBeChecked();
  });
});
```

Note: the "no active session" empty state is deliberately NOT tested here via E2E — it's already covered by Task 8's Vitest component test (`FrontDeskCheckinRoute.test.tsx`'s "shows a clear empty state..." case), which is the more reliable layer for it: this E2E spec file runs alongside every other spec file against one shared, mutable backend where some other test may have already set an active session by the time this one runs, making a true "no session has ever been active" E2E scenario non-deterministic to arrange.

- [ ] **Step 2: Run the E2E suite to verify it fails first**

Run: `cd frontend/apps/admin && npm run test:e2e -- sessionCheckin`
Expected: FAIL if run against a checkout that doesn't yet have Tasks 1-8's changes — since this task runs last, in a properly sequenced execution all of Tasks 1-8 are already in place, so this step instead just confirms the test as written actually exercises real behavior: temporarily rename or comment out one assertion (e.g. the "Sessions" nav-link-hidden-for-front_desk check) and confirm it would have caught a regression, then restore it. Skip this if the plan is being executed strictly in order and Tasks 1-8 are already committed — in that case just run the suite and expect it to pass; there is no meaningful "RED" state to demonstrate for a pure integration test written after its dependencies already exist.

- [ ] **Step 3: Run the full E2E suite**

Run: `cd frontend/apps/admin && npm run test:e2e`
Expected: all PASS, including every pre-existing spec file (confirms nothing in this plan — particularly the new `front_desk` role, the broadened nav, and the upsert fix — broke an existing flow).

- [ ] **Step 4: Commit**

```bash
cd frontend/apps/admin
git add tests/e2e/sessionCheckin.spec.ts
git commit -m "Add end-to-end test for session check-in (admin grid + front-desk kiosk)"
```

---

## Self-Review

**Spec coverage:**
- Section 1 (routing/layout) → Tasks 5, 6. ✅
- Section 2 (Sessions list/CRUD + `PATCH /api/sessions/{id}`) → Tasks 1, 5. ✅
- Section 3 (admin check-in data grid) → Task 6. ✅
- Section 4 (`front_desk` role + upsert fix + self-heal) → Tasks 2, 3, 4, 7. ✅
- Section 5 (dedicated front-desk screen) → Task 8. ✅
- Section 6 (error handling & testing) → every task's own tests, plus Task 9's E2E tying the golden path together. ✅
- Out-of-scope items (Fields/Schedule-generation, Inspections, session deletion, import/export) — correctly not addressed by any task. ✅

**Placeholder scan:** no `TBD`/`TODO`/"add appropriate handling" phrasing found. Task 7's Step 1 has a conditional "if this file already exists, adapt" instruction — this is a concrete, bounded instruction with a stated fallback (the two test assertions that must hold either way), not an open-ended placeholder. Task 9's Step 2 similarly gives a concrete alternative action rather than leaving "verify it fails" unanswered for a task where a true RED state doesn't meaningfully exist.

**Type consistency check:**
- `SessionRead` (Task 5) is used identically in Task 6's `SessionDetailLayout`/`SessionCheckinRoute` (via `useOutletContext<{ session: SessionRead }>()`).
- `PATCH /api/sessions/{id}`'s accepted body shape (Task 1: `label`/`session_date`/`timezone`, all optional) matches exactly what Task 5's `SessionsRoute` sends.
- `front_desk` appears identically in `auth.py`'s `ROLES` (Task 3), `SettingsRolesRoute.tsx`'s `ROLES` (Task 7), and `AppShell.tsx`'s role check (Task 7) — no typo drift between the Python string literal and the two TypeScript ones.
- `ParticipationApiRow`/`TeamApiRow` field names (`team_id`, `checked_in`, `number`, `name`, `division_id`) are consistent between Task 6's `SessionCheckinRoute` and Task 8's `FrontDeskCheckinRoute` — both independently define their own local interfaces (matching this project's existing per-file convention, e.g. `TeamApiRow` in `TeamsRoute.tsx`), but the field names match the real `ParticipationRead`/`TeamRead` backend schemas in both places.

No gaps found.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-09-30-session-checkin.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** - A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** - I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end. Runs well with a mid-tier session model, since the plan carries the design.

For this plan I recommend **subagent-driven**, because it spans both backend and frontend (9 tasks, ~5 backend/auth-sensitive and ~4 UI-heavy) with real cross-cutting interfaces (the `front_desk` role touches Python auth code, two TypeScript `ROLES` arrays, and nav-gating logic that a shipped mistake — over-broadening a role's access — would be a real security regression, not just a cosmetic bug). A fresh reviewer per task catches that class of mistake before it compounds across tasks, the way it did for the multi-round-scheduling plan's own Task 8 fix loop. Does the plan capture what you want, and which approach should we use?
