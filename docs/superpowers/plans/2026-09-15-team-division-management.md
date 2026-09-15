# Team & Division Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tournament admin manage divisions and the team roster: manual entry, a paste-friendly spreadsheet grid, and CSV template/export/upload, all funneling through one backend bulk-upsert endpoint.

**Architecture:** Two new admin-only routes (`/divisions`, `/teams`) added to the existing router. The team roster is one tournament-wide `react-data-grid` (not per-division) with local-until-Save editing; CSV parsing/generation is entirely client-side (`papaparse`) and feeds the same bulk-upsert endpoint the grid's Save button uses. New backend: `Team.robot_name`, `Division.target_team_count`, a `(event_id, number)` uniqueness constraint, and endpoints for team delete, division update/delete/randomize, and bulk team upsert.

**Tech Stack:** React 19 (upgraded from 18 in Task 1 — required by `react-data-grid@7.0.0-beta.61`), `react-data-grid`, `papaparse`, TypeScript, FastAPI/SQLAlchemy/Alembic (unchanged backend stack).

**Spec:** `docs/superpowers/specs/2026-09-15-team-division-management-design.md`

## Global Constraints

- Team number becomes required and unique within the event (`(event_id, number)`), enforced by both a new Alembic migration and application-level `409` handling — never a raw `500`.
- Division team counts (`target_team_count`) are informational only, never enforced as a cap.
- All CSV parsing/generation and grid-paste parsing happens client-side, via `papaparse` on both paths, feeding one backend endpoint (`POST /api/teams/bulk`) — no server-side CSV file handling.
- CSV template/export always include all 8 columns (Number, Name, Robot Name, Organization, City, State, Country, Division) regardless of division count; only the on-screen grid hides the Division column/filter when the event has exactly one division.
- Grid edits (typed or pasted) and CSV-upload-populated rows stay local until an explicit "Save changes" click, which is the only thing that calls the backend. Row delete is the one exception — immediate, with a confirm dialog.
- Division name matching (in bulk upsert) is case-insensitive.
- `POST /api/divisions/randomize`'s balanced-shuffle algorithm (shuffle candidates, assign each to the currently least-populated division, tie-break via a shuffled division order) is the single implementation reused by: the "Randomly assign unassigned teams" toolbar action (`scope: "unassigned"`), the division-add/delete redistribution confirmation (`scope: "all"`), and each bulk-upsert row's `assign_random_division` flag.
- Every user-facing string goes through `react-i18next`, both `en` and `zh`, from the moment it's written.
- Team delete is blocked (`409`) if the team has any `SessionParticipation`, `Ranking`, `AllianceTeam`, or `BracketAllianceTeam` row referencing it.
- This plan does NOT touch sessions, field/field-set configuration, scheduler plugin selection, or schedule generation — deferred to a later sub-project.

---

### Task 1: Upgrade the frontend to React 19

**Files:**
- Modify: `frontend/packages/shared/package.json`
- Modify: `frontend/apps/admin/package.json`

**Interfaces:**
- Consumes: nothing from later tasks.
- Produces: React 19 as the project-wide React version — every later task's frontend code targets React 19, and `react-data-grid@7.0.0-beta.61` (Task 9 onward) requires it.

This is a pure dependency-version bump with no code changes expected: this codebase doesn't use any React 18-only API (no string refs, no legacy Context API, no `defaultProps` on function components), and every other frontend dependency already in use (`react-router-dom`, `@tanstack/react-query`, `react-i18next`, `@testing-library/react`) already supports React 19. `@vitejs/plugin-react` does not need to change — it's a JSX/Babel transform, not coupled to a specific React runtime version.

- [ ] **Step 1: Bump `packages/shared`'s React versions**

In `frontend/packages/shared/package.json`, change:
```json
  "peerDependencies": {
    "react": "^18.3.0"
  },
```
to:
```json
  "peerDependencies": {
    "react": "^19.2.0"
  },
```
And in its `devDependencies`, change `"react": "^18.3.0"` to `"react": "^19.2.0"`, and `"react-dom": "^18.3.0"` to `"react-dom": "^19.2.0"`.

- [ ] **Step 2: Bump `apps/admin`'s React versions**

In `frontend/apps/admin/package.json`, in `dependencies`, change `"react": "^18.3.0"` to `"react": "^19.2.0"` and `"react-dom": "^18.3.0"` to `"react-dom": "^19.2.0"`. In `devDependencies`, change `"@types/react": "^18.3.5"` to `"@types/react": "^19.2.0"` and `"@types/react-dom": "^18.3.0"` to `"@types/react-dom": "^19.2.0"`.

- [ ] **Step 3: Reinstall and verify the existing test suites still pass**

Run: `cd frontend && npm install`
Expected: succeeds (this will update `frontend/package-lock.json` — that's expected and should be committed).

Run: `cd frontend/packages/shared && npm test`
Expected: all 31 tests still pass, pristine output.

Run: `cd frontend/packages/shared && npx tsc --noEmit`
Expected: zero errors.

Run: `cd frontend/apps/admin && npm test`
Expected: all 6 tests still pass, pristine output (no new React 19 warnings — if you see a warning about an outdated pattern, e.g. `ReactDOM.render`, note it and fix it as part of this task; this codebase already uses `ReactDOM.createRoot`, so none are expected).

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/packages/shared/package.json frontend/apps/admin/package.json frontend/package-lock.json
git commit -m "Upgrade frontend to React 19"
```

---

### Task 2: Backend data model — `Team.robot_name`, `Division.target_team_count`, team-number uniqueness

**Files:**
- Modify: `server/src/tournament_server/models/team.py`
- Modify: `server/src/tournament_server/models/division.py`
- Modify: `server/src/tournament_server/schemas/team.py`
- Modify: `server/src/tournament_server/schemas/division.py`
- Modify: `server/src/tournament_server/routers/teams.py`
- Create: `server/src/tournament_server/_alembic/versions/b7e4a19f6c32_add_team_robot_name_and_division_target_count.py`
- Test: `server/tests/test_teams.py`
- Test: `server/tests/test_divisions.py`

**Interfaces:**
- Produces: `Team.robot_name: str | None`; `Division.target_team_count: int | None`; `TeamRead`/`TeamCreate`/`TeamUpdate` all gain `robot_name: str | None = None`; `DivisionRead`/`DivisionCreate` gain `target_team_count: int | None = None`. `POST /api/teams` and `PATCH /api/teams/{id}` now return `409` (not `500`) on a duplicate team number within the event.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_teams.py`:

```python
def test_create_team_with_robot_name(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "robot_name": "Ironclad"},
    )
    assert response.status_code == 201
    assert response.json()["robot_name"] == "Ironclad"


def test_create_team_duplicate_number_returns_409(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    response = client.post("/api/teams", json={"number": "1234A", "name": "Circuit Breakers"})
    assert response.status_code == 409


def test_update_team_to_duplicate_number_returns_409(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    second = client.post("/api/teams", json={"number": "5678B", "name": "Circuit Breakers"})
    team_id = second.json()["id"]
    response = client.patch(f"/api/teams/{team_id}", json={"number": "1234A"})
    assert response.status_code == 409
```

Append to `server/tests/test_divisions.py`:

```python
def test_create_division_with_target_team_count(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/divisions", json={"name": "Elementary", "target_team_count": 24})
    assert response.status_code == 201
    assert response.json()["target_team_count"] == 24


def test_create_division_without_target_team_count_defaults_to_none(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 201
    assert response.json()["target_team_count"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_teams.py tests/test_divisions.py -v`
Expected: FAIL — `robot_name`/`target_team_count` unrecognized, or duplicate numbers currently succeed (`201` instead of `409`).

- [ ] **Step 3: Add the model columns**

In `server/src/tournament_server/models/team.py`, add the import and the column, and the new table-level constraint:

```python
from sqlalchemy import ForeignKey, String, UniqueConstraint
```
(replaces the existing `from sqlalchemy import ForeignKey, String` line)

Add, alongside the other `mapped_column` fields (after `name`):
```python
    robot_name: Mapped[str | None] = mapped_column(String(200), default=None)
```

Add, as a class-level attribute right after `__tablename__ = "teams"`:
```python
    __table_args__ = (
        UniqueConstraint("event_id", "number", name="uq_teams_event_number"),
    )
```

In `server/src/tournament_server/models/division.py`, add the new column after `name`:
```python
    target_team_count: Mapped[int | None] = mapped_column(default=None)
```

- [ ] **Step 4: Add the migration**

Create `server/src/tournament_server/_alembic/versions/b7e4a19f6c32_add_team_robot_name_and_division_target_count.py`:

```python
"""add team robot_name, division target_team_count, team number uniqueness

Revision ID: b7e4a19f6c32
Revises: 9ee2761f45b6
Create Date: 2026-09-15 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b7e4a19f6c32'
down_revision: Union[str, None] = '9ee2761f45b6'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Both new columns are nullable, so no server_default is needed --
    # SQLite allows ADD COLUMN with no default on a populated table as
    # long as it's nullable (unlike the NOT NULL case documented in the
    # previous migration).
    op.add_column('teams', sa.Column('robot_name', sa.String(length=200), nullable=True))
    op.add_column('divisions', sa.Column('target_team_count', sa.Integer(), nullable=True))
    # SQLite can't add a table constraint via a plain ALTER TABLE -- it
    # requires rebuilding the table, which batch_alter_table handles.
    # NOTE: this will fail on any pre-existing install that already has
    # two teams sharing a number within the same event -- matches this
    # project's established migration-safety posture (see server/CLAUDE.md's
    # "Known, deliberate gaps" section): the pre-migration backup
    # ensure_schema_current() takes is the recovery path, not an
    # automated dedup.
    with op.batch_alter_table('teams') as batch_op:
        batch_op.create_unique_constraint('uq_teams_event_number', ['event_id', 'number'])


def downgrade() -> None:
    with op.batch_alter_table('teams') as batch_op:
        batch_op.drop_constraint('uq_teams_event_number', type_='unique')
    op.drop_column('divisions', 'target_team_count')
    op.drop_column('teams', 'robot_name')
```

- [ ] **Step 5: Add the schema fields**

In `server/src/tournament_server/schemas/team.py`, add `robot_name: str | None = None` to `TeamCreate`, `TeamUpdate`, and `TeamRead` (in each class, alongside the existing `organization: str | None = None`/`organization: str | None` field).

In `server/src/tournament_server/schemas/division.py`, add `target_team_count: int | None = None` to `DivisionCreate` and to `DivisionRead` (as `target_team_count: int | None`).

- [ ] **Step 6: Catch duplicate-number IntegrityErrors as 409**

In `server/src/tournament_server/routers/teams.py`, add the import:
```python
from sqlalchemy.exc import IntegrityError
```

Change `create_team`'s body from:
```python
    team = Team(event_id=event.id, **payload.model_dump())
    db.add(team)
    db.commit()
    db.refresh(team)
    return team
```
to:
```python
    team = Team(event_id=event.id, **payload.model_dump())
    db.add(team)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Team number already in use")
    db.refresh(team)
    return team
```

Change `update_team`'s final block from:
```python
    for key, value in updates.items():
        setattr(team, key, value)
    db.commit()
    db.refresh(team)
    return team
```
to:
```python
    for key, value in updates.items():
        setattr(team, key, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Team number already in use")
    db.refresh(team)
    return team
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_teams.py tests/test_divisions.py -v`
Expected: PASS (all tests, including the 5 new ones).

- [ ] **Step 8: Run the full backend test suite**

Run: `cd server && .venv/bin/python -m pytest`
Expected: all pass — this migration is additive to two already-tested tables; no other test creates two teams with the same number in the same event.

- [ ] **Step 9: Commit**

```bash
git add server/src/tournament_server/models/team.py server/src/tournament_server/models/division.py server/src/tournament_server/schemas/team.py server/src/tournament_server/schemas/division.py server/src/tournament_server/routers/teams.py server/src/tournament_server/_alembic/versions/b7e4a19f6c32_add_team_robot_name_and_division_target_count.py server/tests/test_teams.py server/tests/test_divisions.py
git commit -m "Add Team.robot_name, Division.target_team_count, and team-number uniqueness"
```

---

### Task 3: `DELETE /api/teams/{id}`

**Files:**
- Modify: `server/src/tournament_server/routers/teams.py`
- Test: `server/tests/test_teams.py`

**Interfaces:**
- Consumes: `Team` (Task 2). `SessionParticipation` (`models/participation.py`), `Ranking` (`models/ranking.py`), `AllianceTeam` (`models/alliance.py`), `BracketAllianceTeam` (`models/bracket_alliance.py`) — all have a `team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))` column.
- Produces: `DELETE /api/teams/{id}` — `204` on success, `404` if not found, `409` (with a detail message naming what's blocking) if the team has any of the four kinds of referencing row.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_teams.py`:

```python
def test_delete_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    created = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    team_id = created.json()["id"]

    response = client.delete(f"/api/teams/{team_id}")
    assert response.status_code == 204

    get_response = client.get(f"/api/teams/{team_id}")
    assert get_response.status_code == 404


def test_delete_team_404s_when_not_found(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.delete("/api/teams/999")
    assert response.status_code == 404


def test_delete_team_409s_with_session_participation(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"}).json()
    session = client.post("/api/sessions", json={"label": "Day 1"}).json()
    client.post(
        f"/api/sessions/{session['id']}/participants",
        json={"team_id": team["id"]},
    )

    response = client.delete(f"/api/teams/{team['id']}")
    assert response.status_code == 409
    assert "participation" in response.json()["detail"].lower()
```

(Verified against `server/src/tournament_server/routers/participation.py`: the real route is `POST /api/sessions/{session_id}/participants` — plural "participants", not "participation" — with body `{"team_id": <int>, "checked_in"?: bool}` via `ParticipationCreate`, a single team per call, not a list.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_teams.py -k delete -v`
Expected: FAIL — `405 Method Not Allowed` (no `DELETE` route exists yet).

- [ ] **Step 3: Implement the endpoint**

In `server/src/tournament_server/routers/teams.py`, add the imports:
```python
from fastapi import APIRouter, Depends, HTTPException, Response
from tournament_server.models.alliance import AllianceTeam
from tournament_server.models.bracket_alliance import BracketAllianceTeam
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.ranking import Ranking
```
(the `Response` import extends the existing `from fastapi import APIRouter, Depends, HTTPException` line; the four model imports are new)

Add, at the end of the file:
```python
@router.delete("/{team_id}", status_code=204)
def delete_team(
    team_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")

    blockers = []
    if db.execute(
        select(SessionParticipation).where(SessionParticipation.team_id == team_id)
    ).first():
        blockers.append("session participation")
    if db.execute(select(Ranking).where(Ranking.team_id == team_id)).first():
        blockers.append("rankings")
    if db.execute(
        select(AllianceTeam).where(AllianceTeam.team_id == team_id)
    ).first():
        blockers.append("alliance assignments")
    if db.execute(
        select(BracketAllianceTeam).where(BracketAllianceTeam.team_id == team_id)
    ).first():
        blockers.append("bracket alliance assignments")
    if blockers:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete team: has existing {', '.join(blockers)}",
        )

    db.delete(team)
    db.commit()
    return Response(status_code=204)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_teams.py -k delete -v`
Expected: PASS.

- [ ] **Step 5: Run the full backend test suite and commit**

Run: `cd server && .venv/bin/python -m pytest`
Expected: all pass.

```bash
git add server/src/tournament_server/routers/teams.py server/tests/test_teams.py
git commit -m "Add DELETE /api/teams/{id}, blocked by existing scheduling data"
```

---

### Task 4: `PATCH`/`DELETE /api/divisions/{id}`

**Files:**
- Modify: `server/src/tournament_server/routers/divisions.py`
- Modify: `server/src/tournament_server/schemas/division.py`
- Test: `server/tests/test_divisions.py`

**Interfaces:**
- Consumes: `Division`, `Team` (Task 2).
- Produces: `DivisionUpdate` schema (`name: str | None = None`, `target_team_count: int | None = None`). `PATCH /api/divisions/{id}` — `200` with the updated `DivisionRead`, `404` if not found, `422` if `name` is explicitly set to `null`. `DELETE /api/divisions/{id}` — `204`, `404` if not found; unassigns (does not delete) every team currently in that division.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_divisions.py`:

```python
def test_update_division_name(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()

    response = client.patch(f"/api/divisions/{division['id']}", json={"name": "Elementary School"})
    assert response.status_code == 200
    assert response.json()["name"] == "Elementary School"


def test_update_division_target_team_count(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()

    response = client.patch(f"/api/divisions/{division['id']}", json={"target_team_count": 30})
    assert response.status_code == 200
    assert response.json()["target_team_count"] == 30


def test_update_division_404s_when_not_found(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.patch("/api/divisions/999", json={"name": "x"})
    assert response.status_code == 404


def test_delete_division_unassigns_its_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()
    team = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders", "division_id": division["id"]}
    ).json()

    response = client.delete(f"/api/divisions/{division['id']}")
    assert response.status_code == 204

    team_after = client.get(f"/api/teams/{team['id']}").json()
    assert team_after["division_id"] is None

    list_response = client.get("/api/divisions")
    assert division["id"] not in [d["id"] for d in list_response.json()]


def test_delete_division_404s_when_not_found(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.delete("/api/divisions/999")
    assert response.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_divisions.py -k "update_division or delete_division" -v`
Expected: FAIL — `405 Method Not Allowed`.

- [ ] **Step 3: Add the `DivisionUpdate` schema**

In `server/src/tournament_server/schemas/division.py`, add:
```python
class DivisionUpdate(BaseModel):
    name: str | None = None
    target_team_count: int | None = None
```

- [ ] **Step 4: Implement the endpoints**

In `server/src/tournament_server/routers/divisions.py`, change the import line:
```python
from fastapi import APIRouter, Depends, HTTPException, Response
```
and:
```python
from tournament_server.models.team import Team
from tournament_server.schemas.division import DivisionCreate, DivisionRead, DivisionUpdate
```
(replaces the existing `from tournament_server.schemas.division import DivisionCreate, DivisionRead` line; adds the `Team` import)

Add, at the end of the file:
```python
@router.patch("/{division_id}", response_model=DivisionRead)
def update_division(
    division_id: int,
    payload: DivisionUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Division:
    division = db.get(Division, division_id)
    if division is None:
        raise HTTPException(status_code=404, detail="Division not found")
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates and updates["name"] is None:
        raise HTTPException(status_code=422, detail="name cannot be null")
    for key, value in updates.items():
        setattr(division, key, value)
    db.commit()
    db.refresh(division)
    return division


@router.delete("/{division_id}", status_code=204)
def delete_division(
    division_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    division = db.get(Division, division_id)
    if division is None:
        raise HTTPException(status_code=404, detail="Division not found")
    teams_in_division = list(
        db.execute(select(Team).where(Team.division_id == division_id)).scalars().all()
    )
    for team in teams_in_division:
        team.division_id = None
    db.delete(division)
    db.commit()
    return Response(status_code=204)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_divisions.py -v`
Expected: PASS (all tests in the file).

- [ ] **Step 6: Run the full backend test suite and commit**

Run: `cd server && .venv/bin/python -m pytest`
Expected: all pass.

```bash
git add server/src/tournament_server/routers/divisions.py server/src/tournament_server/schemas/division.py server/tests/test_divisions.py
git commit -m "Add PATCH/DELETE /api/divisions/{id}"
```

---

### Task 5: Balanced-shuffle service and `POST /api/divisions/randomize`

**Files:**
- Create: `server/src/tournament_server/services/team_assignment.py`
- Modify: `server/src/tournament_server/routers/divisions.py`
- Test: `server/tests/test_team_assignment.py`
- Test: `server/tests/test_divisions.py`

**Interfaces:**
- Consumes: `Team`, `Division` (Task 2, 4).
- Produces: `balanced_assign(team_ids: list[int], division_ids: list[int], current_counts: dict[int, int]) -> dict[int, int]` — the pure shuffle-then-assign algorithm, reused by Task 6's `assign_random_division` handling. `RandomizeRequest` schema (`scope: Literal["unassigned", "all"]`). `POST /api/divisions/randomize` — `200` with the updated `list[TeamRead]` (only the teams it touched), `404` if the event has no divisions.

- [ ] **Step 1: Write the failing tests for the pure algorithm**

Create `server/tests/test_team_assignment.py`:

```python
from tournament_server.services.team_assignment import balanced_assign


def test_balanced_assign_distributes_evenly_from_zero():
    assignments = balanced_assign(
        team_ids=[1, 2, 3, 4, 5, 6], division_ids=[10, 20, 30], current_counts={}
    )
    assert set(assignments.keys()) == {1, 2, 3, 4, 5, 6}
    assert set(assignments.values()) <= {10, 20, 30}
    counts = {10: 0, 20: 0, 30: 0}
    for division_id in assignments.values():
        counts[division_id] += 1
    assert list(counts.values()) == [2, 2, 2]


def test_balanced_assign_accounts_for_existing_imbalance():
    # Division 10 already has 8 teams, division 20 has 0 -- 4 new teams
    # should all land in division 20 to even things out.
    assignments = balanced_assign(
        team_ids=[1, 2, 3, 4], division_ids=[10, 20], current_counts={10: 8, 20: 0}
    )
    assert all(division_id == 20 for division_id in assignments.values())


def test_balanced_assign_handles_uneven_team_count():
    assignments = balanced_assign(
        team_ids=[1, 2, 3, 4, 5], division_ids=[10, 20], current_counts={}
    )
    counts = {10: 0, 20: 0}
    for division_id in assignments.values():
        counts[division_id] += 1
    assert sorted(counts.values()) == [2, 3]


def test_balanced_assign_empty_teams_returns_empty():
    assert balanced_assign(team_ids=[], division_ids=[10, 20], current_counts={}) == {}
```

Append to `server/tests/test_divisions.py`:

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

    unassigned_after = client.get(f"/api/teams/{unassigned['id']}").json()
    assert unassigned_after["division_id"] == division["id"]
    assigned_after = client.get(f"/api/teams/{assigned['id']}").json()
    assert assigned_after["division_id"] == division["id"]  # untouched, was already here


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

    division_ids_after = {
        client.get(f"/api/teams/{team1['id']}").json()["division_id"],
        client.get(f"/api/teams/{team2['id']}").json()["division_id"],
    }
    assert division_ids_after <= {division_a["id"], division_b["id"]}


def test_randomize_404s_with_no_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/divisions/randomize", json={"scope": "all"})
    assert response.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_team_assignment.py tests/test_divisions.py -k randomize -v`
Expected: FAIL — `services/team_assignment.py` doesn't exist; `POST /api/divisions/randomize` doesn't exist.

- [ ] **Step 3: Implement the pure algorithm**

Create `server/src/tournament_server/services/team_assignment.py`:

```python
from __future__ import annotations

import random


def balanced_assign(
    team_ids: list[int],
    division_ids: list[int],
    current_counts: dict[int, int],
) -> dict[int, int]:
    """Assigns each id in `team_ids` to one of `division_ids`, keeping
    resulting division sizes as even as possible (differing by at most
    1) regardless of how unevenly `current_counts` started.

    Shuffles both the team order (so *which* team lands where is random)
    and the division order (so ties -- multiple divisions equally
    under-populated at some point in the walk -- are broken randomly
    rather than always favoring the first-listed division). Each team is
    then assigned, in shuffled order, to whichever division currently
    has the fewest teams, with a running count updated after each
    assignment so later picks in the same call see earlier ones.
    """
    shuffled_teams = list(team_ids)
    random.shuffle(shuffled_teams)
    shuffled_divisions = list(division_ids)
    random.shuffle(shuffled_divisions)

    counts = {division_id: current_counts.get(division_id, 0) for division_id in division_ids}

    assignments: dict[int, int] = {}
    for team_id in shuffled_teams:
        target = min(shuffled_divisions, key=lambda division_id: counts[division_id])
        assignments[team_id] = target
        counts[target] += 1
    return assignments
```

- [ ] **Step 4: Run the pure-algorithm tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_team_assignment.py -v`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the endpoint**

In `server/src/tournament_server/schemas/division.py`, add the imports and schema:
```python
from typing import Literal
```
(add alongside the existing imports at the top of the file)
```python
class RandomizeRequest(BaseModel):
    scope: Literal["unassigned", "all"]
```

In `server/src/tournament_server/routers/divisions.py`, add the imports:
```python
from sqlalchemy import func, select
```
(replaces the existing `from sqlalchemy import select` line)
```python
from tournament_server.schemas.division import (
    DivisionCreate,
    DivisionRead,
    DivisionUpdate,
    RandomizeRequest,
)
```
(replaces the Task 4 import line)
```python
from tournament_server.schemas.team import TeamRead
from tournament_server.services.team_assignment import balanced_assign
```

Add, at the end of the file:
```python
@router.post("/randomize", response_model=list[TeamRead])
def randomize_divisions(
    payload: RandomizeRequest,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> list[Team]:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")

    divisions = list(
        db.execute(select(Division).where(Division.event_id == event.id)).scalars().all()
    )
    if not divisions:
        raise HTTPException(status_code=404, detail="No divisions exist for this event")
    division_ids = [d.id for d in divisions]

    if payload.scope == "unassigned":
        teams_to_assign = list(
            db.execute(
                select(Team).where(Team.event_id == event.id, Team.division_id.is_(None))
            ).scalars().all()
        )
        current_counts = dict(
            db.execute(
                select(Team.division_id, func.count(Team.id))
                .where(Team.event_id == event.id, Team.division_id.is_not(None))
                .group_by(Team.division_id)
            ).all()
        )
    else:
        teams_to_assign = list(
            db.execute(select(Team).where(Team.event_id == event.id)).scalars().all()
        )
        current_counts = {}

    if not teams_to_assign:
        return []

    assignments = balanced_assign(
        [team.id for team in teams_to_assign], division_ids, current_counts
    )
    for team in teams_to_assign:
        team.division_id = assignments[team.id]
    db.commit()
    for team in teams_to_assign:
        db.refresh(team)
    return teams_to_assign
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_divisions.py -k randomize -v`
Expected: PASS (3 tests).

- [ ] **Step 7: Run the full backend test suite and commit**

Run: `cd server && .venv/bin/python -m pytest`
Expected: all pass.

```bash
git add server/src/tournament_server/services/team_assignment.py server/src/tournament_server/routers/divisions.py server/src/tournament_server/schemas/division.py server/tests/test_team_assignment.py server/tests/test_divisions.py
git commit -m "Add balanced-shuffle service and POST /api/divisions/randomize"
```

---

### Task 6: `POST /api/teams/bulk`

**Files:**
- Modify: `server/src/tournament_server/routers/teams.py`
- Modify: `server/src/tournament_server/schemas/team.py`
- Test: `server/tests/test_teams.py`

**Interfaces:**
- Consumes: `Team`, `Division` (Task 2), `balanced_assign` (Task 5).
- Produces: `TeamBulkRow` schema (`number`, `name`, `robot_name`, `organization`, `city`, `state`, `country`, `division: str | None`, `assign_random_division: bool = False`), `TeamBulkRequest` (`rows: list[TeamBulkRow]`), `TeamBulkRowResult` (`row_index: int`, `status: Literal["created", "updated", "error"]`, `team: TeamRead | None`, `error: str | None`), `TeamBulkResponse` (`results: list[TeamBulkRowResult]`). `POST /api/teams/bulk` always returns `200` — each row's outcome is independent.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_teams.py`:

```python
def test_bulk_upsert_creates_new_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={
            "rows": [
                {"number": "1234A", "name": "Robo Raiders"},
                {"number": "5678B", "name": "Circuit Breakers", "robot_name": "Ironclad"},
            ]
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert [r["status"] for r in results] == ["created", "created"]
    assert results[1]["team"]["robot_name"] == "Ironclad"


def test_bulk_upsert_updates_existing_team_by_number(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders Renamed"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "updated"
    assert results[0]["team"]["name"] == "Robo Raiders Renamed"

    list_response = client.get("/api/teams")
    assert len(list_response.json()) == 1  # no duplicate created


def test_bulk_upsert_partial_failure_still_commits_good_rows(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={
            "rows": [
                {"number": "1234A", "name": "Robo Raiders"},
                {"number": "5678B", "name": "Circuit Breakers", "division": "Nonexistent Division"},
                {"number": "9999C", "name": "Third Team"},
            ]
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "created"
    assert results[1]["status"] == "error"
    assert "Nonexistent Division" in results[1]["error"]
    assert results[2]["status"] == "created"

    list_response = client.get("/api/teams")
    numbers = {t["number"] for t in list_response.json()}
    assert numbers == {"1234A", "9999C"}


def test_bulk_upsert_division_name_is_case_insensitive(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders", "division": "elementary"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "created"
    assert results[0]["team"]["division_id"] == division["id"]


def test_bulk_upsert_missing_required_field_is_a_row_error(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "", "name": "Robo Raiders"}]},
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["status"] == "error"


def test_bulk_upsert_assign_random_division_distributes_across_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/divisions", json={"name": "A"})
    client.post("/api/divisions", json={"name": "B"})

    response = client.post(
        "/api/teams/bulk",
        json={
            "rows": [
                {"number": "0001A", "name": "T1", "assign_random_division": True},
                {"number": "0002A", "name": "T2", "assign_random_division": True},
            ]
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    division_ids = {r["team"]["division_id"] for r in results}
    assert None not in division_ids
    # With 2 teams and 2 divisions and no pre-existing teams, the
    # balanced algorithm must put one in each.
    assert len(division_ids) == 2


def test_bulk_upsert_empty_rows_is_a_no_op(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/teams/bulk", json={"rows": []})
    assert response.status_code == 200
    assert response.json()["results"] == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_teams.py -k bulk -v`
Expected: FAIL — `404 Not Found` (no `/api/teams/bulk` route exists yet).

- [ ] **Step 3: Add the schemas**

In `server/src/tournament_server/schemas/team.py`, add the imports and schemas:
```python
from typing import Literal
```
(add alongside the existing `from pydantic import BaseModel, ConfigDict` import)

Add, at the end of the file:
```python
class TeamBulkRow(BaseModel):
    number: str
    name: str
    robot_name: str | None = None
    organization: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    division: str | None = None
    assign_random_division: bool = False


class TeamBulkRequest(BaseModel):
    rows: list[TeamBulkRow]


class TeamBulkRowResult(BaseModel):
    row_index: int
    status: Literal["created", "updated", "error"]
    team: TeamRead | None = None
    error: str | None = None


class TeamBulkResponse(BaseModel):
    results: list[TeamBulkRowResult]
```

- [ ] **Step 4: Implement the endpoint**

In `server/src/tournament_server/routers/teams.py`, add the imports:
```python
from tournament_server.schemas.team import (
    TeamBulkRequest,
    TeamBulkResponse,
    TeamBulkRow,
    TeamBulkRowResult,
    TeamCreate,
    TeamRead,
    TeamUpdate,
)
```
(replaces the existing `from tournament_server.schemas.team import TeamCreate, TeamRead, TeamUpdate` line)
```python
from tournament_server.services.team_assignment import balanced_assign
```

Add, at the end of the file:
```python
@router.post("/bulk", response_model=TeamBulkResponse)
def bulk_upsert_teams(
    payload: TeamBulkRequest,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> TeamBulkResponse:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")

    divisions = list(
        db.execute(select(Division).where(Division.event_id == event.id)).scalars().all()
    )
    division_by_lower_name = {division.name.lower(): division for division in divisions}
    division_ids = [division.id for division in divisions]

    running_counts = dict(
        db.execute(
            select(Team.division_id, func.count(Team.id))
            .where(Team.event_id == event.id, Team.division_id.is_not(None))
            .group_by(Team.division_id)
        ).all()
    )
    for division_id in division_ids:
        running_counts.setdefault(division_id, 0)

    results: list[TeamBulkRowResult] = []
    for index, row in enumerate(payload.rows):
        if not row.number.strip() or not row.name.strip():
            results.append(
                TeamBulkRowResult(
                    row_index=index, status="error", error="number and name are required"
                )
            )
            continue

        division_id: int | None = None
        if row.assign_random_division:
            if not division_ids:
                results.append(
                    TeamBulkRowResult(
                        row_index=index,
                        status="error",
                        error="No divisions exist to randomly assign into",
                    )
                )
                continue
            division_id = min(division_ids, key=lambda d: running_counts[d])
            running_counts[division_id] += 1
        elif row.division:
            matched = division_by_lower_name.get(row.division.strip().lower())
            if matched is None:
                results.append(
                    TeamBulkRowResult(
                        row_index=index,
                        status="error",
                        error=f"Unknown division: {row.division!r}",
                    )
                )
                continue
            division_id = matched.id

        fields = {
            "name": row.name,
            "robot_name": row.robot_name,
            "organization": row.organization,
            "city": row.city,
            "state": row.state,
            "country": row.country,
            "division_id": division_id,
        }

        existing = db.execute(
            select(Team).where(Team.event_id == event.id, Team.number == row.number)
        ).scalars().first()

        if existing is not None:
            for key, value in fields.items():
                setattr(existing, key, value)
            db.flush()
            results.append(
                TeamBulkRowResult(
                    row_index=index, status="updated", team=TeamRead.model_validate(existing)
                )
            )
        else:
            team = Team(event_id=event.id, number=row.number, **fields)
            db.add(team)
            db.flush()
            results.append(
                TeamBulkRowResult(
                    row_index=index, status="created", team=TeamRead.model_validate(team)
                )
            )

    db.commit()
    return TeamBulkResponse(results=results)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_teams.py -k bulk -v`
Expected: PASS (7 tests).

- [ ] **Step 6: Run the full backend test suite and commit**

Run: `cd server && .venv/bin/python -m pytest`
Expected: all pass. This closes out the backend for this sub-project.

```bash
git add server/src/tournament_server/routers/teams.py server/src/tournament_server/schemas/team.py server/tests/test_teams.py
git commit -m "Add POST /api/teams/bulk: upsert-by-number with per-row results"
```

---

### Task 7: Frontend CSV/paste parsing and generation module

**Files:**
- Create: `frontend/apps/admin/src/teamCsv.ts`
- Create: `frontend/apps/admin/tests/unit/teamCsv.test.ts`
- Modify: `frontend/apps/admin/package.json` (add `papaparse`, `@types/papaparse`)

**Interfaces:**
- Consumes: nothing from earlier frontend tasks.
- Produces:
  - `interface TeamGridRow { clientId: string; id: number | null; number: string; name: string; robot_name: string; organization: string; city: string; state: string; country: string; division: string; dirty: boolean; error?: string }`
  - `TEAM_FIELD_KEYS: readonly string[]` (the 8 column keys, in order)
  - `makeBlankTeamRow(): TeamGridRow`
  - `expandPastedBlock(pastedText: string, rows: TeamGridRow[], startRowIndex: number, startColumnKey: string): TeamGridRow[]`
  - `parseCsvFile(text: string): TeamGridRow[]`
  - `teamsToCsv(rows: Pick<TeamGridRow, "number" | "name" | "robot_name" | "organization" | "city" | "state" | "country" | "division">[]): string`
  - `BLANK_TEAM_CSV_TEMPLATE: string`
  - `downloadCsv(filename: string, csvContent: string): void`

This is pure, framework-agnostic logic (no React) — every function here is independently unit-testable and is the single implementation both CSV upload and grid-paste route through (Task 11).

- [ ] **Step 1: Add dependencies**

In `frontend/apps/admin/package.json`, add to `dependencies`:
```json
    "papaparse": "^5.7.0",
```
and to `devDependencies`:
```json
    "@types/papaparse": "^5.5.2",
```
(insert alphabetically alongside the existing entries)

Run: `cd frontend && npm install`

- [ ] **Step 2: Write the failing tests**

Create `frontend/apps/admin/tests/unit/teamCsv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  BLANK_TEAM_CSV_TEMPLATE,
  expandPastedBlock,
  makeBlankTeamRow,
  parseCsvFile,
  teamsToCsv,
  type TeamGridRow,
} from "../../src/teamCsv";

describe("makeBlankTeamRow", () => {
  it("returns a row with a unique clientId, no id, all fields blank, and dirty true", () => {
    const a = makeBlankTeamRow();
    const b = makeBlankTeamRow();
    expect(a.clientId).not.toBe(b.clientId);
    expect(a.id).toBeNull();
    expect(a.number).toBe("");
    expect(a.dirty).toBe(true);
  });
});

describe("expandPastedBlock", () => {
  function rowsFixture(): TeamGridRow[] {
    return [
      { ...makeBlankTeamRow(), clientId: "r0", number: "0001A", name: "Existing", dirty: false },
    ];
  }

  it("updates a single cell when the paste is one line, one column", () => {
    const rows = rowsFixture();
    const result = expandPastedBlock("New Name", rows, 0, "name");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("New Name");
    expect(result[0].dirty).toBe(true);
    expect(result[0].number).toBe("0001A"); // untouched
  });

  it("spreads a multi-column line across adjacent columns starting at the target", () => {
    const rows = rowsFixture();
    const result = expandPastedBlock("0002B\tNew Name\tIroncladBot", rows, 0, "number");
    expect(result[0].number).toBe("0002B");
    expect(result[0].name).toBe("New Name");
    expect(result[0].robot_name).toBe("IroncladBot");
  });

  it("appends new rows when the pasted block has more lines than existing rows", () => {
    const rows = rowsFixture();
    const result = expandPastedBlock("0001A\tRow One\n0002B\tRow Two\n0003C\tRow Three", rows, 0, "number");
    expect(result).toHaveLength(3);
    expect(result[1].number).toBe("0002B");
    expect(result[1].name).toBe("Row Two");
    expect(result[2].number).toBe("0003C");
  });

  it("does nothing and returns the rows unchanged when the start column is unrecognized", () => {
    const rows = rowsFixture();
    const result = expandPastedBlock("x", rows, 0, "__not_a_column");
    expect(result).toBe(rows);
  });
});

describe("parseCsvFile", () => {
  it("parses a CSV with a header row into team grid rows", () => {
    const csv =
      "Number,Name,Robot Name,Organization,City,State,Country,Division\n" +
      "1234A,Robo Raiders,Ironclad,St Catherine School,Springfield,IL,USA,Elementary\n";
    const rows = parseCsvFile(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].number).toBe("1234A");
    expect(rows[0].robot_name).toBe("Ironclad");
    expect(rows[0].division).toBe("Elementary");
    expect(rows[0].dirty).toBe(true);
  });

  it("handles a quoted field containing a comma", () => {
    const csv =
      "Number,Name,Robot Name,Organization,City,State,Country,Division\n" +
      '1234A,"Golden Gears, Inc.",,,,,,\n';
    const rows = parseCsvFile(csv);
    expect(rows[0].name).toBe("Golden Gears, Inc.");
  });

  it("returns an empty array for a header-only CSV", () => {
    const csv = "Number,Name,Robot Name,Organization,City,State,Country,Division\n";
    expect(parseCsvFile(csv)).toEqual([]);
  });
});

describe("teamsToCsv", () => {
  it("produces a CSV with the header row and one line per team", () => {
    const csv = teamsToCsv([
      {
        number: "1234A",
        name: "Robo Raiders",
        robot_name: "Ironclad",
        organization: "St Catherine School",
        city: "Springfield",
        state: "IL",
        country: "USA",
        division: "Elementary",
      },
    ]);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe("Number,Name,Robot Name,Organization,City,State,Country,Division");
    expect(lines[1]).toBe("1234A,Robo Raiders,Ironclad,St Catherine School,Springfield,IL,USA,Elementary");
  });

  it("quotes a field containing a comma", () => {
    const csv = teamsToCsv([
      {
        number: "1234A",
        name: "Golden Gears, Inc.",
        robot_name: "",
        organization: "",
        city: "",
        state: "",
        country: "",
        division: "",
      },
    ]);
    expect(csv).toContain('"Golden Gears, Inc."');
  });
});

describe("BLANK_TEAM_CSV_TEMPLATE", () => {
  it("is just the header row", () => {
    expect(BLANK_TEAM_CSV_TEMPLATE.trim()).toBe(
      "Number,Name,Robot Name,Organization,City,State,Country,Division"
    );
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/teamCsv.test.ts`
Expected: FAIL — `../../src/teamCsv` does not exist.

- [ ] **Step 4: Implement the module**

Create `frontend/apps/admin/src/teamCsv.ts`:

```ts
import Papa from "papaparse";

export interface TeamGridRow {
  clientId: string;
  id: number | null;
  number: string;
  name: string;
  robot_name: string;
  organization: string;
  city: string;
  state: string;
  country: string;
  division: string;
  dirty: boolean;
  error?: string;
}

type TeamFieldKey =
  | "number"
  | "name"
  | "robot_name"
  | "organization"
  | "city"
  | "state"
  | "country"
  | "division";

export const TEAM_FIELD_KEYS: readonly TeamFieldKey[] = [
  "number",
  "name",
  "robot_name",
  "organization",
  "city",
  "state",
  "country",
  "division",
];

const CSV_HEADERS: Record<TeamFieldKey, string> = {
  number: "Number",
  name: "Name",
  robot_name: "Robot Name",
  organization: "Organization",
  city: "City",
  state: "State",
  country: "Country",
  division: "Division",
};

let rowIdCounter = 0;

export function makeBlankTeamRow(): TeamGridRow {
  rowIdCounter += 1;
  return {
    clientId: `new-${rowIdCounter}-${Date.now()}`,
    id: null,
    number: "",
    name: "",
    robot_name: "",
    organization: "",
    city: "",
    state: "",
    country: "",
    division: "",
    dirty: true,
  };
}

function setField(row: TeamGridRow, key: TeamFieldKey, value: string): TeamGridRow {
  return { ...row, [key]: value };
}

export function expandPastedBlock(
  pastedText: string,
  rows: TeamGridRow[],
  startRowIndex: number,
  startColumnKey: string
): TeamGridRow[] {
  const startColumnIndex = TEAM_FIELD_KEYS.indexOf(startColumnKey as TeamFieldKey);
  if (startColumnIndex === -1) {
    return rows;
  }

  const parsed = Papa.parse<string[]>(pastedText.replace(/\r?\n$/, ""), {
    delimiter: "\t",
  }).data;

  const next = [...rows];
  parsed.forEach((line, lineOffset) => {
    const targetRowIndex = startRowIndex + lineOffset;
    while (targetRowIndex >= next.length) {
      next.push(makeBlankTeamRow());
    }
    let row: TeamGridRow = { ...next[targetRowIndex], dirty: true };
    line.forEach((value, cellOffset) => {
      const key = TEAM_FIELD_KEYS[startColumnIndex + cellOffset];
      if (key) {
        row = setField(row, key, value);
      }
    });
    next[targetRowIndex] = row;
  });
  return next;
}

export function parseCsvFile(text: string): TeamGridRow[] {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });
  return parsed.data.map((record) => {
    const row = makeBlankTeamRow();
    for (const key of TEAM_FIELD_KEYS) {
      row[key] = record[CSV_HEADERS[key]] ?? "";
    }
    return row;
  });
}

export function teamsToCsv(
  rows: Pick<
    TeamGridRow,
    "number" | "name" | "robot_name" | "organization" | "city" | "state" | "country" | "division"
  >[]
): string {
  const data = rows.map((row) => {
    const record: Record<string, string> = {};
    for (const key of TEAM_FIELD_KEYS) {
      record[CSV_HEADERS[key]] = row[key];
    }
    return record;
  });
  return Papa.unparse(data, { columns: TEAM_FIELD_KEYS.map((key) => CSV_HEADERS[key]) });
}

export const BLANK_TEAM_CSV_TEMPLATE = `${TEAM_FIELD_KEYS.map((key) => CSV_HEADERS[key]).join(",")}\n`;

export function downloadCsv(filename: string, csvContent: string): void {
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/teamCsv.test.ts`
Expected: PASS (12 tests).

- [ ] **Step 6: Run the full admin test suite, typecheck, and build**

Run: `cd frontend/apps/admin && npm test`
Expected: all pass.

Run: `cd frontend/apps/admin && npx tsc --noEmit`
Expected: zero errors.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/admin/package.json frontend/package-lock.json frontend/apps/admin/src/teamCsv.ts frontend/apps/admin/tests/unit/teamCsv.test.ts
git commit -m "Add CSV/paste parsing and generation module for the team roster"
```

---

### Task 8: `types.ts` additions, `DivisionsRoute`, router registration

**Files:**
- Modify: `frontend/apps/admin/src/types.ts`
- Create: `frontend/apps/admin/src/routes/DivisionsRoute.tsx`
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/components/AppShell.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/tests/e2e/divisions.spec.ts`

**Interfaces:**
- Consumes: `apiRequest`, `ApiError` from `@tournament-admin/shared`; `EventRead` from `./types` (already present); the router/`AppShell` structure from the previous sub-project.
- Produces: `Division` type in `types.ts`; the `/divisions` route; a "Divisions" nav link in `AppShell`.

- [ ] **Step 1: Add the `Division` type**

In `frontend/apps/admin/src/types.ts`, add:
```ts
export interface Division {
  id: number;
  event_id: number;
  name: string;
  target_team_count: number | null;
}
```

- [ ] **Step 2: Add locale keys**

`frontend/apps/admin/src/i18n/en/admin.json` — merge in:
```json
{
  "divisions": {
    "heading": "Divisions",
    "nameLabel": "Division name",
    "renameFieldLabel": "Rename {{name}}",
    "targetLabel": "Target team count (optional)",
    "addSubmit": "Add division",
    "deleteAction": "Delete",
    "teamCountLabel": "{{count}} teams",
    "teamCountWithTargetLabel": "{{count}} / {{target}} teams",
    "redistributeConfirmHeading": "Redistribute teams?",
    "redistributeConfirmBody": "This will randomly reassign all {{count}} teams across the current divisions.",
    "redistributeConfirmYes": "Yes, reshuffle everyone",
    "redistributeConfirmNo": "No, I'll do it manually",
    "deleteConfirmHeading": "Delete this division?",
    "deleteConfirmBody": "Its {{count}} teams will become unassigned rather than deleted."
  },
  "shell": {
    "divisionsLink": "Divisions"
  }
}
```

`frontend/apps/admin/src/i18n/zh/admin.json` — merge in:
```json
{
  "divisions": {
    "heading": "分组",
    "nameLabel": "分组名称",
    "renameFieldLabel": "重命名 {{name}}",
    "targetLabel": "目标队伍数(可选)",
    "addSubmit": "添加分组",
    "deleteAction": "删除",
    "teamCountLabel": "{{count}} 支队伍",
    "teamCountWithTargetLabel": "{{count}} / {{target}} 支队伍",
    "redistributeConfirmHeading": "重新分配队伍?",
    "redistributeConfirmBody": "这将把全部 {{count}} 支队伍随机重新分配到当前的分组中。",
    "redistributeConfirmYes": "是,重新洗牌",
    "redistributeConfirmNo": "否,我自己手动分配",
    "deleteConfirmHeading": "删除此分组?",
    "deleteConfirmBody": "其 {{count}} 支队伍将变为未分配,而不会被删除。"
  },
  "shell": {
    "divisionsLink": "分组"
  }
}
```

(the `"shell"` block already exists in both files from the previous sub-project — merge `divisionsLink` into it, don't duplicate the `"shell"` key)

- [ ] **Step 3: Write the `DivisionsRoute`**

Create `frontend/apps/admin/src/routes/DivisionsRoute.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { Division } from "../types";

interface DivisionTeamCounts {
  [divisionId: number]: number;
}

interface TeamSummary {
  id: number;
  division_id: number | null;
}

function useTeamCountsByDivision() {
  const { data } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const counts: DivisionTeamCounts = {};
  let totalTeams = 0;
  for (const team of data ?? []) {
    totalTeams += 1;
    if (team.division_id !== null) {
      counts[team.division_id] = (counts[team.division_id] ?? 0) + 1;
    }
  }
  return { counts, totalTeams };
}

function RedistributeConfirmDialog({
  totalTeams,
  onConfirm,
  onCancel,
}: {
  totalTeams: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="alertdialog" aria-labelledby="redistribute-heading">
      <h2 id="redistribute-heading">{t("divisions.redistributeConfirmHeading")}</h2>
      <p>{t("divisions.redistributeConfirmBody", { count: totalTeams })}</p>
      <button onClick={onConfirm}>{t("divisions.redistributeConfirmYes")}</button>
      <button onClick={onCancel}>{t("divisions.redistributeConfirmNo")}</button>
    </div>
  );
}

export function DivisionsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [pendingRedistribute, setPendingRedistribute] = useState(false);
  const [deleteCandidate, setDeleteCandidate] = useState<Division | null>(null);

  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { counts, totalTeams } = useTeamCountsByDivision();

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["divisions"] });
    queryClient.invalidateQueries({ queryKey: ["teams"] });
  };

  const createMutation = useMutation({
    mutationFn: () =>
      apiRequest<Division>("/api/divisions", {
        method: "POST",
        body: { name, target_team_count: target ? Number(target) : null },
      }),
    onSuccess: () => {
      setName("");
      setTarget("");
      invalidateAll();
      if (totalTeams > 0) {
        setPendingRedistribute(true);
      }
    },
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, newName }: { id: number; newName: string }) =>
      apiRequest<Division>(`/api/divisions/${id}`, {
        method: "PATCH",
        body: { name: newName },
      }),
    onSuccess: invalidateAll,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiRequest<void>(`/api/divisions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setDeleteCandidate(null);
      invalidateAll();
      setPendingRedistribute(true);
    },
  });

  const redistributeMutation = useMutation({
    mutationFn: () =>
      apiRequest<unknown>("/api/divisions/randomize", {
        method: "POST",
        body: { scope: "all" },
      }),
    onSuccess: () => {
      setPendingRedistribute(false);
      invalidateAll();
    },
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    createMutation.mutate();
  }

  return (
    <div>
      <h1>{t("divisions.heading")}</h1>
      <ul>
        {divisions?.map((division) => {
          const count = counts[division.id] ?? 0;
          const label =
            division.target_team_count !== null
              ? t("divisions.teamCountWithTargetLabel", {
                  count,
                  target: division.target_team_count,
                })
              : t("divisions.teamCountLabel", { count });
          return (
            <li key={division.id}>
              <input
                aria-label={t("divisions.renameFieldLabel", { name: division.name })}
                defaultValue={division.name}
                onBlur={(event) => {
                  if (event.target.value !== division.name) {
                    renameMutation.mutate({ id: division.id, newName: event.target.value });
                  }
                }}
              />
              <span>{label}</span>
              <button onClick={() => setDeleteCandidate(division)}>
                {t("divisions.deleteAction")}
              </button>
            </li>
          );
        })}
      </ul>

      <form onSubmit={handleCreate}>
        <label htmlFor="new-division-name">{t("divisions.nameLabel")}</label>
        <input
          id="new-division-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <label htmlFor="new-division-target">{t("divisions.targetLabel")}</label>
        <input
          id="new-division-target"
          type="number"
          min="0"
          value={target}
          onChange={(event) => setTarget(event.target.value)}
        />
        <button type="submit" disabled={createMutation.isPending}>
          {t("divisions.addSubmit")}
        </button>
        {createMutation.isError && (
          <p role="alert">
            {createMutation.error instanceof ApiError
              ? createMutation.error.detail
              : t("errors.generic")}
          </p>
        )}
      </form>

      {deleteCandidate && (
        <div role="alertdialog" aria-labelledby="delete-division-heading">
          <h2 id="delete-division-heading">{t("divisions.deleteConfirmHeading")}</h2>
          <p>
            {t("divisions.deleteConfirmBody", {
              count: counts[deleteCandidate.id] ?? 0,
            })}
          </p>
          <button onClick={() => deleteMutation.mutate(deleteCandidate.id)}>
            {t("divisions.deleteAction")}
          </button>
          <button onClick={() => setDeleteCandidate(null)}>
            {t("divisions.redistributeConfirmNo")}
          </button>
        </div>
      )}

      {pendingRedistribute && (
        <RedistributeConfirmDialog
          totalTeams={totalTeams}
          onConfirm={() => redistributeMutation.mutate()}
          onCancel={() => setPendingRedistribute(false)}
        />
      )}
    </div>
  );
}
```

Note: this uses `t("errors.generic")` — that key already exists in both locale files from the previous sub-project's final review fix wave (`queryClient.ts`/`EventsNewRoute.tsx`'s shared error namespace). Do not redefine it.

- [ ] **Step 4: Register the route and nav link**

In `frontend/apps/admin/src/router.tsx`, add the import:
```ts
import { DivisionsRoute } from "./routes/DivisionsRoute";
```
And add a sibling entry to the `AuthenticatedLayout` children array (alongside the existing `events/setup` and `settings/roles` entries):
```ts
      { path: "divisions", element: <DivisionsRoute /> },
```

In `frontend/apps/admin/src/components/AppShell.tsx`, add a nav link inside the existing `role === "admin"` `<nav>` block, alongside the existing `NavLink`s:
```tsx
          <NavLink to="/divisions">{t("shell.divisionsLink")}</NavLink>
```

- [ ] **Step 5: Write the E2E test**

Create `frontend/apps/admin/tests/e2e/divisions.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("division management", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("create, rename, and delete a division", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL("/");

    await page.getByRole("link", { name: "Divisions" }).click();
    await expect(page).toHaveURL(/\/divisions$/);

    await page.getByLabel("Division name").fill("Elementary");
    await page.getByRole("button", { name: "Add division" }).click();
    await expect(page.getByText("Elementary")).toBeVisible();

    // Each row's rename input has its own accessible name ("Rename
    // <current name>"), distinct from the add-form's "Division name"
    // label above, so this targets the new row's input specifically.
    const renameInput = page.getByLabel("Rename Elementary");
    await renameInput.fill("Elementary School");
    await renameInput.press("Tab"); // triggers the input's onBlur handler
    await expect(page.getByText("Elementary School")).toBeVisible();

    await page.getByRole("button", { name: "Delete" }).last().click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByText("Elementary School")).not.toBeVisible();
  });
});
```

- [ ] **Step 6: Run the unit suite, typecheck, and build**

Run: `cd frontend/apps/admin && npm test`
Expected: all pass.

Run: `cd frontend/apps/admin && npx tsc --noEmit`
Expected: zero errors.

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

Attempt: `cd frontend/apps/admin && npm run test:e2e -- divisions.spec.ts` — this repo's dev sandbox cannot execute Playwright (confirmed in the previous sub-project's plan and its final review); if you're in that same sandbox, expect it to fail at the browser-launch step only (after both webServers boot and the test is collected) and report this as the known, accepted limitation rather than a blocker. If you're on a machine with a working `npx playwright install`, run it for real and report the actual result.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/admin/src/types.ts frontend/apps/admin/src/routes/DivisionsRoute.tsx frontend/apps/admin/src/router.tsx frontend/apps/admin/src/components/AppShell.tsx frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/e2e/divisions.spec.ts
git commit -m "Add division management: create, rename, delete with redistribute prompt"
```

---

### Task 9: `TeamsRoute` grid scaffold — display, add, edit, save

**Files:**
- Create: `frontend/apps/admin/src/routes/TeamsRoute.tsx`
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/components/AppShell.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Modify: `frontend/apps/admin/package.json` (add `react-data-grid`)

**Interfaces:**
- Consumes: `TeamGridRow`, `makeBlankTeamRow` from `../teamCsv` (Task 7); `Division` from `../types`; `apiRequest`, `ApiError` from `@tournament-admin/shared`.
- Produces: the `/teams` route; `visibleRows`/`allRows` state structure and `mergeRows`/`applyBulkResults` helpers that Task 10 (row delete), Task 11 (paste/CSV upload), Task 12 (export/template), and Task 13 (randomize/random-division) all extend within this same file.

This is the largest task in the plan — it establishes the grid, its state model, and the Save-changes round trip. Later tasks in this plan add to this same component rather than creating new ones, since the grid's local-row state must stay centralized in one place.

- [ ] **Step 1: Add the dependency**

In `frontend/apps/admin/package.json`, add to `dependencies`:
```json
    "react-data-grid": "^7.0.0-beta.61",
```
(insert alphabetically)

Run: `cd frontend && npm install`

- [ ] **Step 2: Add locale keys**

`frontend/apps/admin/src/i18n/en/admin.json` — merge in:
```json
{
  "teams": {
    "heading": "Teams",
    "columnNumber": "Number",
    "columnName": "Name",
    "columnRobotName": "Robot Name",
    "columnOrganization": "Organization",
    "columnCity": "City",
    "columnState": "State",
    "columnCountry": "Country",
    "columnDivision": "Division",
    "columnStatus": "Status",
    "unassigned": "(unassigned)",
    "unsavedIndicator": "unsaved",
    "divisionFilterAll": "All divisions",
    "divisionFilterLabel": "Division",
    "addRow": "Add row",
    "saveChanges": "Save changes",
    "saveSummary": "{{saved}} saved, {{failed}} need fixing",
    "saveSummaryAllOk": "{{saved}} saved"
  },
  "shell": {
    "teamsLink": "Teams"
  }
}
```

`frontend/apps/admin/src/i18n/zh/admin.json` — merge in:
```json
{
  "teams": {
    "heading": "队伍",
    "columnNumber": "编号",
    "columnName": "名称",
    "columnRobotName": "机器人名称",
    "columnOrganization": "所属机构",
    "columnCity": "城市",
    "columnState": "省/州",
    "columnCountry": "国家",
    "columnDivision": "分组",
    "columnStatus": "状态",
    "unassigned": "(未分配)",
    "unsavedIndicator": "未保存",
    "divisionFilterAll": "所有分组",
    "divisionFilterLabel": "分组",
    "addRow": "添加行",
    "saveChanges": "保存更改",
    "saveSummary": "已保存 {{saved}} 条,{{failed}} 条需要修正",
    "saveSummaryAllOk": "已保存 {{saved}} 条"
  },
  "shell": {
    "teamsLink": "队伍"
  }
}
```

- [ ] **Step 3: Write `TeamsRoute`**

Create `frontend/apps/admin/src/routes/TeamsRoute.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DataGrid, type Column, type RenderEditCellProps } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import type { Division } from "../types";
import { makeBlankTeamRow, type TeamGridRow } from "../teamCsv";

interface TeamApiRow {
  id: number;
  number: string;
  name: string;
  robot_name: string | null;
  organization: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  division_id: number | null;
}

interface TeamBulkRowResult {
  row_index: number;
  status: "created" | "updated" | "error";
  team: TeamApiRow | null;
  error: string | null;
}

function toGridRow(team: TeamApiRow, divisionNameById: Map<number, string>): TeamGridRow {
  return {
    clientId: `server-${team.id}`,
    id: team.id,
    number: team.number,
    name: team.name,
    robot_name: team.robot_name ?? "",
    organization: team.organization ?? "",
    city: team.city ?? "",
    state: team.state ?? "",
    country: team.country ?? "",
    division: team.division_id !== null ? (divisionNameById.get(team.division_id) ?? "") : "",
    dirty: false,
  };
}

export function mergeRows(all: TeamGridRow[], updatedVisible: TeamGridRow[]): TeamGridRow[] {
  const updatedById = new Map(updatedVisible.map((row) => [row.clientId, row]));
  const existingIds = new Set(all.map((row) => row.clientId));
  const merged = all.map((row) => updatedById.get(row.clientId) ?? row);
  const brandNew = updatedVisible.filter((row) => !existingIds.has(row.clientId));
  return [...merged, ...brandNew];
}

function DivisionEditor(
  props: RenderEditCellProps<TeamGridRow> & { divisions: Division[]; unassignedLabel: string }
) {
  const { row, onRowChange, onClose, divisions, unassignedLabel } = props;
  return (
    <select
      autoFocus
      value={row.division}
      onChange={(event) => {
        onRowChange({ ...row, division: event.target.value, dirty: true }, true);
        onClose(true);
      }}
      onBlur={() => onClose(true)}
    >
      <option value="">{unassignedLabel}</option>
      {divisions.map((division) => (
        <option key={division.id} value={division.name}>
          {division.name}
        </option>
      ))}
    </select>
  );
}

export function TeamsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [allRows, setAllRows] = useState<TeamGridRow[]>([]);
  const [divisionFilter, setDivisionFilter] = useState<string>("");
  const [saveSummary, setSaveSummary] = useState<{ saved: number; failed: number } | null>(null);

  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamApiRow[]>("/api/teams"),
  });

  useEffect(() => {
    if (!teams || !divisions) return;
    const divisionNameById = new Map(divisions.map((division) => [division.id, division.name]));
    setAllRows(teams.map((team) => toGridRow(team, divisionNameById)));
    // Only re-derive from the server when the underlying query data
    // actually changes -- local edits between refetches must not be
    // clobbered by this effect re-running for unrelated reasons.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams, divisions]);

  const visibleRows = useMemo(
    () => (divisionFilter ? allRows.filter((row) => row.division === divisionFilter) : allRows),
    [allRows, divisionFilter]
  );

  const showDivisionColumn = (divisions?.length ?? 0) > 1;

  const columns: Column<TeamGridRow>[] = useMemo(() => {
    const base: Column<TeamGridRow>[] = [
      { key: "number", name: t("teams.columnNumber"), editable: true },
      { key: "name", name: t("teams.columnName"), editable: true },
      { key: "robot_name", name: t("teams.columnRobotName"), editable: true },
      { key: "organization", name: t("teams.columnOrganization"), editable: true },
      { key: "city", name: t("teams.columnCity"), editable: true },
      { key: "state", name: t("teams.columnState"), editable: true },
      { key: "country", name: t("teams.columnCountry"), editable: true },
    ];
    if (showDivisionColumn) {
      base.push({
        key: "division",
        name: t("teams.columnDivision"),
        renderEditCell: (props) => (
          <DivisionEditor
            {...props}
            divisions={divisions ?? []}
            unassignedLabel={t("teams.unassigned")}
          />
        ),
      });
    }
    base.push({
      key: "__status",
      name: t("teams.columnStatus"),
      renderCell: ({ row }) => {
        if (row.error) return <span style={{ color: "crimson" }}>{row.error}</span>;
        if (row.dirty) return <span>{t("teams.unsavedIndicator")}</span>;
        return null;
      },
    });
    return base;
  }, [t, showDivisionColumn, divisions]);

  function handleRowsChange(updatedVisible: TeamGridRow[]) {
    setAllRows((prev) => mergeRows(prev, updatedVisible));
  }

  function handleAddRow() {
    const blank = makeBlankTeamRow();
    if (divisionFilter) {
      blank.division = divisionFilter;
    }
    setAllRows((prev) => [...prev, blank]);
  }

  async function handleSave() {
    const dirtyRows = allRows.filter((row) => row.dirty);
    if (dirtyRows.length === 0) return;
    const body = {
      rows: dirtyRows.map((row) => ({
        number: row.number,
        name: row.name,
        robot_name: row.robot_name || null,
        organization: row.organization || null,
        city: row.city || null,
        state: row.state || null,
        country: row.country || null,
        division: row.division || null,
      })),
    };
    const response = await apiRequest<{ results: TeamBulkRowResult[] }>("/api/teams/bulk", {
      method: "POST",
      body,
    });
    const byIndex = new Map(response.results.map((result) => [result.row_index, result]));
    const updatedById = new Map<string, TeamGridRow>();
    let saved = 0;
    let failed = 0;
    dirtyRows.forEach((row, index) => {
      const result = byIndex.get(index);
      if (!result) return;
      if (result.status === "error") {
        failed += 1;
        updatedById.set(row.clientId, { ...row, error: result.error ?? undefined });
      } else if (result.team) {
        saved += 1;
        updatedById.set(row.clientId, {
          ...row,
          clientId: `server-${result.team.id}`,
          id: result.team.id,
          dirty: false,
          error: undefined,
        });
      }
    });
    setAllRows((prev) => prev.map((row) => updatedById.get(row.clientId) ?? row));
    setSaveSummary({ saved, failed });
    queryClient.invalidateQueries({ queryKey: ["teams"] });
    queryClient.invalidateQueries({ queryKey: ["divisions"] });
  }

  const hasUnsavedChanges = allRows.some((row) => row.dirty);

  return (
    <div>
      <h1>{t("teams.heading")}</h1>
      {showDivisionColumn && (
        <div>
          <label htmlFor="division-filter">{t("teams.divisionFilterLabel")}</label>
          <select
            id="division-filter"
            value={divisionFilter}
            onChange={(event) => setDivisionFilter(event.target.value)}
          >
            <option value="">{t("teams.divisionFilterAll")}</option>
            {divisions?.map((division) => (
              <option key={division.id} value={division.name}>
                {division.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <div>
        <button onClick={handleAddRow}>{t("teams.addRow")}</button>
        <button onClick={() => void handleSave()} disabled={!hasUnsavedChanges}>
          {t("teams.saveChanges")}
        </button>
      </div>

      {saveSummary && (
        <p role="status">
          {saveSummary.failed > 0
            ? t("teams.saveSummary", { saved: saveSummary.saved, failed: saveSummary.failed })
            : t("teams.saveSummaryAllOk", { saved: saveSummary.saved })}
        </p>
      )}

      <DataGrid
        columns={columns}
        rows={visibleRows}
        rowKeyGetter={(row) => row.clientId}
        onRowsChange={handleRowsChange}
      />
    </div>
  );
}
```

- [ ] **Step 4: Register the route and nav link**

In `frontend/apps/admin/src/router.tsx`, add the import:
```ts
import { TeamsRoute } from "./routes/TeamsRoute";
```
And add a sibling entry to the `AuthenticatedLayout` children array:
```ts
      { path: "teams", element: <TeamsRoute /> },
```

In `frontend/apps/admin/src/components/AppShell.tsx`, add a nav link alongside the others:
```tsx
          <NavLink to="/teams">{t("shell.teamsLink")}</NavLink>
```

- [ ] **Step 5: Run the unit suite, typecheck, and build**

Run: `cd frontend/apps/admin && npm test`
Expected: all pass.

Run: `cd frontend/apps/admin && npx tsc --noEmit`
Expected: zero errors.

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/admin/package.json frontend/package-lock.json frontend/apps/admin/src/routes/TeamsRoute.tsx frontend/apps/admin/src/router.tsx frontend/apps/admin/src/components/AppShell.tsx frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json
git commit -m "Add team roster grid: display, add row, edit, save via bulk upsert"
```

---

### Task 10: Row delete

**Files:**
- Modify: `frontend/apps/admin/src/routes/TeamsRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/tests/e2e/teamDelete.spec.ts`

**Interfaces:**
- Consumes: the grid state (`allRows`, `visibleRows`, `columns`) from Task 9, in the same file.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add locale keys**

`frontend/apps/admin/src/i18n/en/admin.json` — merge into the existing `"teams"` block:
```json
    "deleteAction": "Delete",
    "deleteConfirmHeading": "Delete this team?",
    "deleteConfirmBody": "This cannot be undone.",
    "cancelAction": "Cancel"
```

`frontend/apps/admin/src/i18n/zh/admin.json` — merge into the existing `"teams"` block:
```json
    "deleteAction": "删除",
    "deleteConfirmHeading": "删除此队伍?",
    "deleteConfirmBody": "此操作无法撤销。",
    "cancelAction": "取消"
```

- [ ] **Step 2: Add the delete column and confirm dialog**

In `frontend/apps/admin/src/routes/TeamsRoute.tsx`, add state near the other `useState` calls:
```tsx
  const [deleteCandidate, setDeleteCandidate] = useState<TeamGridRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
```

Add a delete handler function alongside `handleSave`. This must catch a blocked-deletion `409` (the team has existing scheduling data — see Task 3) and show it rather than letting it become an unhandled rejection:
```tsx
  async function handleConfirmDelete() {
    if (!deleteCandidate || deleteCandidate.id === null) {
      setDeleteCandidate(null);
      return;
    }
    setDeleteError(null);
    try {
      await apiRequest<void>(`/api/teams/${deleteCandidate.id}`, { method: "DELETE" });
      setAllRows((prev) => prev.filter((row) => row.clientId !== deleteCandidate.clientId));
      setDeleteCandidate(null);
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.detail : t("errors.generic"));
    }
  }
```

Add a delete column to the `columns` array (inside the `useMemo`, before the `__status` column is pushed — insert this `base.push(...)` call right after the `showDivisionColumn` block and before the `__status` push):
```tsx
    base.push({
      key: "__delete",
      name: "",
      renderCell: ({ row }) => (
        <button
          aria-label={t("teams.deleteAction")}
          onClick={() => {
            setDeleteError(null);
            setDeleteCandidate(row);
          }}
          disabled={row.id === null}
        >
          {t("teams.deleteAction")}
        </button>
      ),
    });
```

Add the confirm dialog to the rendered JSX, after the `<DataGrid ... />` element. It stays open and shows `deleteError` inline if the delete was blocked (a `409`), rather than closing on failure — this is a real scenario in this project (a team already scheduled into a match can't be deleted, per Task 3), and it should surface as text near the dialog's own buttons, not be lost:
```tsx
      {deleteCandidate && (
        <div role="alertdialog" aria-labelledby="delete-team-heading">
          <h2 id="delete-team-heading">{t("teams.deleteConfirmHeading")}</h2>
          <p>{t("teams.deleteConfirmBody")}</p>
          {deleteError && <p role="alert">{deleteError}</p>}
          <button onClick={() => void handleConfirmDelete()}>{t("teams.deleteAction")}</button>
          <button
            onClick={() => {
              setDeleteCandidate(null);
              setDeleteError(null);
            }}
          >
            {t("teams.cancelAction")}
          </button>
        </div>
      )}
```

Add `"cancelAction": "Cancel"` to both locale files' `"teams"` block in Step 1 above (add it to the same merge blocks already specified there — `"cancelAction": "Cancel"` for `en`, `"cancelAction": "取消"` for `zh`).

- [ ] **Step 3: Write the E2E test**

Create `frontend/apps/admin/tests/e2e/teamDelete.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("team delete", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("deleting a team removes it from the grid", async ({ page, request }) => {
    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    const { access_token: accessToken } = await loginResponse.json();
    await request.post("/api/teams", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { number: "9999Z", name: "Team To Delete" },
    });

    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await expect(page.getByText("Team To Delete")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).first().click();
    await page.getByRole("button", { name: "Delete", exact: true }).last().click();
    await expect(page.getByText("Team To Delete")).not.toBeVisible();
  });
});
```

- [ ] **Step 4: Run the unit suite, typecheck, and build**

Run: `cd frontend/apps/admin && npm test`
Expected: all pass.

Run: `cd frontend/apps/admin && npx tsc --noEmit`
Expected: zero errors.

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

Attempt `npm run test:e2e -- teamDelete.spec.ts` per the note in Task 8 Step 6 (expect a browser-launch-only failure in this sandbox).

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/admin/src/routes/TeamsRoute.tsx frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/e2e/teamDelete.spec.ts
git commit -m "Add team row delete with confirmation"
```

---

### Task 11: Paste-into-grid and CSV upload

**Files:**
- Modify: `frontend/apps/admin/src/routes/TeamsRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/tests/e2e/teamPasteAndCsv.spec.ts`

**Interfaces:**
- Consumes: `expandPastedBlock`, `parseCsvFile` from `../teamCsv` (Task 7); `mergeRows` (Task 9, same file).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add locale keys**

`frontend/apps/admin/src/i18n/en/admin.json` — merge into the existing `"teams"` block:
```json
    "uploadCsvLabel": "Upload CSV"
```

`frontend/apps/admin/src/i18n/zh/admin.json` — merge into the existing `"teams"` block:
```json
    "uploadCsvLabel": "上传 CSV"
```

- [ ] **Step 2: Wire paste support**

In `frontend/apps/admin/src/routes/TeamsRoute.tsx`, add the import:
```ts
import { expandPastedBlock, makeBlankTeamRow, parseCsvFile, type TeamGridRow } from "../teamCsv";
```
(replaces the Task 9 import line — adds `expandPastedBlock` and `parseCsvFile`, needed by the paste and CSV-upload handlers below)
```ts
import type { CellPasteArgs, CellClipboardEvent } from "react-data-grid";
```

Add a paste handler function alongside `handleAddRow`:
```tsx
  function handleCellPaste(
    args: CellPasteArgs<TeamGridRow>,
    event: CellClipboardEvent
  ): TeamGridRow {
    const text = event.clipboardData.getData("text/plain");
    const rowIndex = visibleRows.findIndex((row) => row.clientId === args.row.clientId);
    if (rowIndex === -1) {
      return args.row;
    }
    const expanded = expandPastedBlock(text, visibleRows, rowIndex, args.column.key);
    setAllRows((prev) => mergeRows(prev, expanded));
    return args.row;
  }
```

Wire it into the `<DataGrid ... />` element:
```tsx
        onCellPaste={handleCellPaste}
```

- [ ] **Step 3: Wire CSV upload**

Add a file-input change handler alongside `handleAddRow`:
```tsx
  function handleCsvFileSelected(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const parsedRows = parseCsvFile(text);
      setAllRows((prev) => [...prev, ...parsedRows]);
    };
    reader.readAsText(file);
    event.target.value = "";
  }
```

Add the file input to the toolbar `<div>` alongside the "Add row"/"Save changes" buttons:
```tsx
        <label htmlFor="csv-upload">{t("teams.uploadCsvLabel")}</label>
        <input id="csv-upload" type="file" accept=".csv" onChange={handleCsvFileSelected} />
```

- [ ] **Step 4: Write the E2E test**

Create `frontend/apps/admin/tests/e2e/teamPasteAndCsv.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("team paste and CSV upload", () => {
  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());
  });

  test("pasting multi-row tab-delimited data populates and saves multiple teams", async ({
    page,
  }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await page.getByRole("button", { name: "Add row" }).click();
    const numberCell = page.getByRole("gridcell").first();
    await numberCell.click();

    await page.evaluate(() => {
      const pasteData = new DataTransfer();
      pasteData.setData("text/plain", "8001A\tPaste Team One\n8002B\tPaste Team Two");
      const target = document.activeElement;
      target?.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: pasteData, bubbles: true })
      );
    });

    await expect(page.getByText("Paste Team One")).toBeVisible();
    await expect(page.getByText("Paste Team Two")).toBeVisible();

    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toContainText("saved");
  });
});
```

Note: simulating a real clipboard paste event in Playwright is inherently a bit fragile (browser clipboard permissions, focus timing). If this exact `page.evaluate` approach doesn't reliably trigger react-data-grid's `onCellPaste` handler when you get to run this for real, an acceptable fallback is `page.keyboard.press("Control+V")` after using `page.context().grantPermissions(["clipboard-read", "clipboard-write"])` and seeding the clipboard via `navigator.clipboard.writeText(...)` in an earlier `page.evaluate` call — adjust if the first approach doesn't work when you actually run this in a browser.

- [ ] **Step 5: Run the unit suite, typecheck, and build**

Run: `cd frontend/apps/admin && npm test`
Expected: all pass.

Run: `cd frontend/apps/admin && npx tsc --noEmit`
Expected: zero errors.

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

Attempt `npm run test:e2e -- teamPasteAndCsv.spec.ts` per the note in Task 8 Step 6.

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/admin/src/routes/TeamsRoute.tsx frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/e2e/teamPasteAndCsv.spec.ts
git commit -m "Add grid paste and CSV upload, both feeding the local row state"
```

---

### Task 12: CSV export and blank template download

**Files:**
- Modify: `frontend/apps/admin/src/routes/TeamsRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`

**Interfaces:**
- Consumes: `teamsToCsv`, `BLANK_TEAM_CSV_TEMPLATE`, `downloadCsv` from `../teamCsv` (Task 7).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add locale keys**

`frontend/apps/admin/src/i18n/en/admin.json` — merge into the existing `"teams"` block:
```json
    "downloadCsvLabel": "Download CSV",
    "downloadTemplateLabel": "Download blank template"
```

`frontend/apps/admin/src/i18n/zh/admin.json` — merge into the existing `"teams"` block:
```json
    "downloadCsvLabel": "下载 CSV",
    "downloadTemplateLabel": "下载空白模板"
```

- [ ] **Step 2: Wire export and template download**

In `frontend/apps/admin/src/routes/TeamsRoute.tsx`, add the import:
```ts
import { BLANK_TEAM_CSV_TEMPLATE, downloadCsv, expandPastedBlock, makeBlankTeamRow, parseCsvFile, teamsToCsv, type TeamGridRow } from "../teamCsv";
```
(replaces Task 11's import line — adds `BLANK_TEAM_CSV_TEMPLATE`, `downloadCsv`, `teamsToCsv`)

Add two handlers alongside `handleAddRow`:
```tsx
  function handleDownloadCsv() {
    downloadCsv("teams.csv", teamsToCsv(visibleRows));
  }

  function handleDownloadTemplate() {
    downloadCsv("teams-template.csv", BLANK_TEAM_CSV_TEMPLATE);
  }
```

Note: `visibleRows` (not `allRows`) is passed to `teamsToCsv` here, matching the spec's "exports whatever the current filter shows." The 8-column CSV format itself always includes Division (per the Global Constraints and Task 7's `teamsToCsv`) even when the on-screen grid is currently hiding that column for a single-division event — `TeamGridRow.division` is always populated on every row regardless of whether the Division grid column is currently rendered, so this requires no special-casing here.

Add the two buttons to the toolbar `<div>`:
```tsx
        <button onClick={handleDownloadCsv}>{t("teams.downloadCsvLabel")}</button>
        <button onClick={handleDownloadTemplate}>{t("teams.downloadTemplateLabel")}</button>
```

- [ ] **Step 3: Run the unit suite, typecheck, and build**

Run: `cd frontend/apps/admin && npm test`
Expected: all pass.

Run: `cd frontend/apps/admin && npx tsc --noEmit`
Expected: zero errors.

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

(No new E2E test for this task: Playwright downloads are inert in this project's sandboxed E2E environment in the same way they're inert in the Artifact viewer sandbox referenced elsewhere in this project's tooling documentation — verifying an actual file download round-trip isn't reliably testable via `page.on("download")` without a real, unsandboxed browser context. `teamsToCsv`/`BLANK_TEAM_CSV_TEMPLATE`'s correctness is already covered by Task 7's unit tests; this task only wires two buttons to already-tested pure functions.)

- [ ] **Step 4: Commit**

```bash
git add frontend/apps/admin/src/routes/TeamsRoute.tsx frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json
git commit -m "Add CSV export and blank template download"
```

---

### Task 13: "Randomly assign unassigned teams" and random-division grid option

**Files:**
- Modify: `frontend/apps/admin/src/routes/TeamsRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`
- Modify: `frontend/apps/admin/src/i18n/zh/admin.json`
- Create: `frontend/apps/admin/tests/e2e/teamRandomize.spec.ts`

**Interfaces:**
- Consumes: the grid state from Task 9, `DivisionEditor` from Task 9 (same file).
- Produces: nothing later tasks depend on — this is the final task of the sub-project.

**Design note on the "(random)" grid option:** a new, not-yet-saved row's Division dropdown offers a `"__random__"` sentinel value alongside real division names and "(unassigned)". This sentinel never reaches the backend as a division name — when building the bulk-save request body (Task 9's `handleSave`), a row whose `division` equals the sentinel is sent with `assign_random_division: true` and no `division` field, instead of the normal `division: row.division || null`. This keeps the "random" choice entirely on the single existing `/api/teams/bulk` endpoint (per Task 6), rather than requiring a second code path.

- [ ] **Step 1: Add locale keys**

`frontend/apps/admin/src/i18n/en/admin.json` — merge into the existing `"teams"` block:
```json
    "randomDivisionOption": "(random)",
    "randomizeUnassignedAction": "Randomly assign unassigned teams"
```

`frontend/apps/admin/src/i18n/zh/admin.json` — merge into the existing `"teams"` block:
```json
    "randomDivisionOption": "(随机)",
    "randomizeUnassignedAction": "随机分配未分组队伍"
```

- [ ] **Step 2: Add the "(random)" option to `DivisionEditor`**

In `frontend/apps/admin/src/routes/TeamsRoute.tsx`, add a constant near the top of the file (after the imports):
```ts
const RANDOM_DIVISION_SENTINEL = "__random__";
```

Update `DivisionEditor`'s props type and JSX to accept and render a "(random)" option, only for not-yet-saved rows (`row.id === null` — an already-saved team's division should be changed to a specific division or unassigned, not re-randomized inline):
```tsx
function DivisionEditor(
  props: RenderEditCellProps<TeamGridRow> & {
    divisions: Division[];
    unassignedLabel: string;
    randomLabel: string;
  }
) {
  const { row, onRowChange, onClose, divisions, unassignedLabel, randomLabel } = props;
  return (
    <select
      autoFocus
      value={row.division}
      onChange={(event) => {
        onRowChange({ ...row, division: event.target.value, dirty: true }, true);
        onClose(true);
      }}
      onBlur={() => onClose(true)}
    >
      <option value="">{unassignedLabel}</option>
      {divisions.map((division) => (
        <option key={division.id} value={division.name}>
          {division.name}
        </option>
      ))}
      {row.id === null && <option value={RANDOM_DIVISION_SENTINEL}>{randomLabel}</option>}
    </select>
  );
}
```

In the `columns` `useMemo`, find the Division column definition (the object with `key: "division"`, inside the `if (showDivisionColumn)` block) — currently:
```tsx
      base.push({
        key: "division",
        name: t("teams.columnDivision"),
        renderEditCell: (props) => (
          <DivisionEditor
            {...props}
            divisions={divisions ?? []}
            unassignedLabel={t("teams.unassigned")}
          />
        ),
      });
```
Replace it with (adds the `randomLabel` prop, and a `renderCell` so a row showing the random sentinel displays the translated "(random)" label instead of the literal internal string `"__random__"`):
```tsx
      base.push({
        key: "division",
        name: t("teams.columnDivision"),
        renderCell: ({ row }) =>
          row.division === RANDOM_DIVISION_SENTINEL
            ? t("teams.randomDivisionOption")
            : row.division,
        renderEditCell: (props) => (
          <DivisionEditor
            {...props}
            divisions={divisions ?? []}
            unassignedLabel={t("teams.unassigned")}
            randomLabel={t("teams.randomDivisionOption")}
          />
        ),
      });
```

- [ ] **Step 3: Send `assign_random_division` for sentinel rows on Save**

In `handleSave`'s `body` construction, change:
```tsx
        division: row.division || null,
```
to:
```tsx
        division: row.division === RANDOM_DIVISION_SENTINEL ? null : row.division || null,
        assign_random_division: row.division === RANDOM_DIVISION_SENTINEL,
```

- [ ] **Step 4: Add the "Randomly assign unassigned teams" toolbar button**

Add a handler alongside `handleAddRow`:
```tsx
  const randomizeMutation = useMutation({
    mutationFn: () =>
      apiRequest<TeamApiRow[]>("/api/divisions/randomize", {
        method: "POST",
        body: { scope: "unassigned" },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
  });
```
(requires adding `useMutation` to the existing `import { useQuery, useQueryClient } from "@tanstack/react-query";` line, changing it to `import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";`)

Compute whether the button should be enabled (needs both an unassigned team and more than one division) alongside the other derived values:
```tsx
  const hasUnassignedTeams = allRows.some((row) => row.id !== null && row.division === "");
  const canRandomize = hasUnassignedTeams && (divisions?.length ?? 0) > 1;
```

Add the button to the toolbar `<div>`:
```tsx
        <button
          onClick={() => randomizeMutation.mutate()}
          disabled={!canRandomize || randomizeMutation.isPending}
        >
          {t("teams.randomizeUnassignedAction")}
        </button>
```

- [ ] **Step 5: Write the E2E test**

Create `frontend/apps/admin/tests/e2e/teamRandomize.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test.describe.serial("randomize unassigned teams", () => {
  let accessToken = "";

  test.beforeAll(async ({ request }) => {
    const createResponse = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(createResponse.status());

    const loginResponse = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    const body = await loginResponse.json();
    accessToken = body.access_token as string;

    await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division One" },
    });
    await request.post("/api/divisions", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { name: "Randomize Division Two" },
    });
    await request.post("/api/teams", {
      headers: { Authorization: `Bearer ${accessToken}` },
      data: { number: "7001A", name: "Unassigned Team" },
    });
  });

  test("clicking the button assigns previously-unassigned teams", async ({ page, request }) => {
    await page.goto("/login");
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await page.getByRole("link", { name: "Teams" }).click();
    await expect(page).toHaveURL(/\/teams$/);

    await page.getByRole("button", { name: "Randomly assign unassigned teams" }).click();

    await expect
      .poll(async () => {
        const teamsResponse = await request.get("/api/teams", {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        const teams = await teamsResponse.json();
        const team = teams.find((t: { number: string }) => t.number === "7001A");
        return team?.division_id ?? null;
      })
      .not.toBeNull();
  });
});
```

- [ ] **Step 6: Run the full frontend verification**

Run: `cd frontend/packages/shared && npm test`
Expected: all pass (unaffected by this sub-project — confirms no regression).

Run: `cd frontend/apps/admin && npm test`
Expected: all pass.

Run: `cd frontend/apps/admin && npx tsc --noEmit`
Expected: zero errors.

Run: `cd frontend/apps/admin && npm run build`
Expected: succeeds.

Attempt `npm run test:e2e` (the full suite this time, not just this task's file) per the note in Task 8 Step 6 — this exercises every spec file from this plan plus the previous sub-project's, together.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/admin/src/routes/TeamsRoute.tsx frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/e2e/teamRandomize.spec.ts
git commit -m "Add randomize-unassigned action and random-division grid option"
```

## Post-implementation checklist (whole-branch review scope)

- All 13 tasks committed, each with its own passing tests.
- `cd server && .venv/bin/python -m pytest` — all pass.
- `cd frontend/packages/shared && npm test` — all pass.
- `cd frontend/apps/admin && npm test` — all pass.
- `cd frontend/apps/admin && npx tsc --noEmit` — zero errors.
- `cd frontend/apps/admin && npm run build` — succeeds.
- `cd frontend/apps/admin && npm run test:e2e` — attempt; report actual results if runnable, or confirm the failure is browser-launch-only if not.
- i18n check: every string introduced in this sub-project has both an `en` and a `zh` entry.
- WCAG spot check: the two new confirm dialogs (`role="alertdialog"`) are labeled via `aria-labelledby`; the grid's delete buttons have `aria-label`s; form fields have associated `<label>`s.
- Confirm `frontend/CLAUDE.md` doesn't need an update for anything this sub-project changed structurally (it shouldn't — no new workspace packages, no new dev-server wiring — but double check nothing here contradicts what it currently says about the workspace).
