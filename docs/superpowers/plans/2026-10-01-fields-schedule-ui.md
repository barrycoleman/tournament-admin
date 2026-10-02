# Fields, Schedule, and Matches Session Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each session three new admin tabs — Fields (field sets, fields, division assignment), Schedule (readiness checklist, current rounds with Clear, a phases + time-blocks generate form with dry-run Preview), and Matches (read-only schedule grid) — plus a "Set as active session" control, backed by five small backend additions.

**Architecture:** Three backend tasks land first (a match-format read endpoint; field/field-set rename and delete; two additive response fields), since the frontend consumes all of them. Frontend work follows in dependency order: the session header's active-session control, the Fields tab, a task of pure, unit-tested scheduling helpers (request building, round summaries, readiness, timezone formatting), the Matches tab, then the Schedule tab in two tasks (status half, then form half). One E2E task ties it together and updates the docs.

**Tech Stack:** Python/FastAPI/SQLAlchemy/pytest (backend, `server/`); TypeScript/React 19/React Router 6/TanStack Query 5/react-i18next/react-data-grid/Vitest/Playwright (frontend, `frontend/apps/admin`).

**Spec:** `docs/superpowers/specs/2026-10-01-fields-schedule-ui-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere.
- Every backend change ships with pytest unit/integration tests against a real FastAPI `TestClient` and real temp-file SQLite, in the same commit as the code.
- Every frontend change ships with Vitest component tests and Playwright E2E coverage for user-facing flows — no mocking at the HTTP/WebSocket boundary for E2E.
- No destructive migrations. No schema change may destroy existing data. (This plan needs no schema change and no migration.)
- Every user-facing string goes through `useTranslation()`/`t(...)` in both `en`/`zh` `admin.json` files — no bare string literals.
- Follow existing conventions: TanStack Query for server state, `InlineEditableText` for inline renames, `react-data-grid` (with the shims `frontend/CLAUDE.md` documents) for large tables, native `<input type="date">`/`<input type="time">`/`<select>` for date/time entry.
- Existing callers of every changed endpoint keep working, except the one deliberate contract loosening (`PATCH /api/field-sets/{id}`'s `division_id` key becomes optional).
- Work on the feature branch `fields-schedule-ui` in the main checkout (no worktrees). Run backend commands from `server/` with `.venv/bin/pytest`; frontend commands from `frontend/apps/admin/`.

## Review Focus

- **Single-division events must omit `division_id` everywhere, and match it as `null`.** The Schedule tab hides the division picker, sends no `division_id`, counts unassigned FieldSets as usable, and summarizes matches whose `division_id` is `null`. Sending the sole division's id instead would make the server find no FieldSets and 422. (Task 6 tests `summarizeRounds`/`countUsableFields` with `null`; Task 8 tests the clear request has no `division_id`; Task 9 tests the generate body has no `division_id`.)
- **Match times must render in the session's timezone, not the browser's.** A `17:00Z` match in a `America/Los_Angeles` session in November is `09:00`, regardless of the test runner's own `TZ`. (Task 6 owns the `formatMatchTime` test; Task 7 asserts it in the grid.)
- **Clearing a scored round must require the typed phrase, and Clear all must issue exactly one DELETE per round, refreshing even if one fails.** (Task 8 owns both tests.)
- **Round types that already have a schedule must never be offered, so a Generate can't 409 on a round that exists.** This must still hold right after a Generate, once the new matches arrive. (Task 9 owns the test.)
- **Deleting a field or field set that matches (or a finals bracket) depend on must refuse and delete nothing.** (Task 2 owns the tests, including that the set's fields survive a refused delete.)

---

### Task 1: `GET /api/event/match-format`

**Files:**
- Modify: `server/src/tournament_server/schemas/event.py`
- Modify: `server/src/tournament_server/routers/event.py`
- Modify: `server/CLAUDE.md` (Scheduling section)
- Test: `server/tests/test_event.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GET /api/event/match-format` → `{"round_types": list[str], "teams_per_alliance": int, "alliance_count": int, "match_duration_seconds": int}`; any authenticated role; 422 `"No game plugin has been selected for this event"` when none selected. Consumed by Task 9 (frontend type `MatchFormat`).

- [ ] **Step 1: Create the feature branch**

```bash
git checkout -b fields-schedule-ui
```

- [ ] **Step 2: Write the failing tests**

Append to `server/tests/test_event.py`:

```python
def test_match_format_reports_the_selected_game_plugin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})

    response = client.get("/api/event/match-format")
    assert response.status_code == 200
    assert response.json() == {
        "round_types": ["practice", "qualification", "elimination"],
        "teams_per_alliance": 2,
        "alliance_count": 2,
        "match_duration_seconds": 120,
    }


def test_match_format_without_a_game_plugin_is_422(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.get("/api/event/match-format")
    assert response.status_code == 422
    assert response.json()["detail"] == "No game plugin has been selected for this event"


def test_match_format_is_readable_by_non_admin_roles(client):
    from tests.auth_helpers import bearer, login_as

    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})

    token = login_as(client, "front_desk")
    response = client.get("/api/event/match-format", headers=bearer(token))
    assert response.status_code == 200
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest tests/test_event.py -k match_format -v`
Expected: 3 FAIL (404/405, the route doesn't exist yet).

- [ ] **Step 4: Add the response schema**

Append to `server/src/tournament_server/schemas/event.py`:

```python
class MatchFormatRead(BaseModel):
    round_types: list[str]
    teams_per_alliance: int
    alliance_count: int
    match_duration_seconds: int
```

- [ ] **Step 5: Add the endpoint**

In `server/src/tournament_server/routers/event.py`, add `require_any_role` to the `tournament_server.auth` import list and `MatchFormatRead` to the `tournament_server.schemas.event` import list. Then add, directly after `read_event`:

```python
@router.get("/match-format", response_model=MatchFormatRead)
def read_match_format(
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> MatchFormatRead:
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
    match_format = game_plugin.module.match_format()
    return MatchFormatRead(
        round_types=list(match_format["round_types"]),
        teams_per_alliance=match_format["teams_per_alliance"],
        alliance_count=match_format["alliance_count"],
        match_duration_seconds=(
            match_format["autonomous_seconds"] + match_format["driver_seconds"]
        ),
    )
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd server && .venv/bin/pytest tests/test_event.py -v`
Expected: all PASS.

- [ ] **Step 7: Document it**

In `server/CLAUDE.md`, at the end of the `## Scheduling` section's first paragraph block (just before the "`POST /api/schedule` generates matches" paragraph), add:

```markdown
`GET /api/event/match-format` (any authenticated role) exposes the
selected game plugin's scheduling-relevant format — `round_types`,
`teams_per_alliance`, `alliance_count`, and `match_duration_seconds`
(`autonomous_seconds + driver_seconds`, the same value `POST
/api/schedule` uses for its cycle-time warning) — so the admin UI's
schedule form can offer real round types and warn about tight cycle
times before previewing. 422 with the same message `POST /api/schedule`
uses when no game plugin is selected.
```

- [ ] **Step 8: Commit**

```bash
git add server/src/tournament_server/schemas/event.py server/src/tournament_server/routers/event.py server/tests/test_event.py server/CLAUDE.md
git commit -m "Add GET /api/event/match-format for the schedule form"
```

---

### Task 2: Field and FieldSet rename/delete

**Files:**
- Modify: `server/src/tournament_server/schemas/field.py`
- Modify: `server/src/tournament_server/schemas/field_set.py`
- Modify: `server/src/tournament_server/routers/fields.py`
- Modify: `server/src/tournament_server/routers/field_sets.py`
- Modify: `server/CLAUDE.md` (Scheduling and Multi-division scheduling sections)
- Test: `server/tests/test_fields.py`, `server/tests/test_field_sets.py`, `server/tests/test_finals.py`

**Interfaces:**
- Consumes: nothing new.
- Produces (consumed by Task 5):
  - `PATCH /api/fields/{id}` body `{"name": str}` → `FieldRead`; 404 `"Field not found"`; 422 `"name must not be empty"`.
  - `DELETE /api/fields/{id}` → 204; 404; 409 `"Field has scheduled matches; clear the schedule first"`.
  - `PATCH /api/field-sets/{id}` body `{"name"?: str, "division_id"?: int | null}` (partial) → `FieldSetRead`; 404 `"FieldSet not found"` / `"Division not found"`; 422 `"name must not be empty"`.
  - `DELETE /api/field-sets/{id}` → 204 (deletes its fields too); 404; 409 `"Field set is used by a finals bracket"`; 409 `"Field set has scheduled matches; clear the schedule first"`.
  - All four `require_admin`.

- [ ] **Step 1: Write the failing field tests**

Append to `server/tests/test_fields.py` (it already defines `_make_session(client) -> int`):

```python
def _make_match_on_field(client, session_id: int, field_id: int) -> None:
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    team_ids = [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, 5)
    ]
    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": field_id,
            "alliances": [
                {"station": "red", "team_ids": team_ids[:2]},
                {"station": "blue", "team_ids": team_ids[2:]},
            ],
        },
    )
    assert response.status_code == 201, response.text


def test_patch_field_renames_it(client):
    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]

    response = client.patch(f"/api/fields/{field_id}", json={"name": "  Arena 2  "})
    assert response.status_code == 200
    assert response.json()["name"] == "Arena 2"


def test_patch_field_rejects_an_empty_name(client):
    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]

    response = client.patch(f"/api/fields/{field_id}", json={"name": "   "})
    assert response.status_code == 422


def test_patch_field_rejects_unknown_field(client):
    _make_session(client)
    response = client.patch("/api/fields/999", json={"name": "Arena"})
    assert response.status_code == 404


def test_delete_field_removes_it(client):
    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]

    response = client.delete(f"/api/fields/{field_id}")
    assert response.status_code == 204
    assert client.get(f"/api/fields?session_id={session_id}").json() == []


def test_delete_field_with_a_match_is_refused(client):
    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]
    _make_match_on_field(client, session_id, field_id)

    response = client.delete(f"/api/fields/{field_id}")
    assert response.status_code == 409
    assert response.json()["detail"] == "Field has scheduled matches; clear the schedule first"
    assert len(client.get(f"/api/fields?session_id={session_id}").json()) == 1


def test_delete_field_rejects_unknown_field(client):
    _make_session(client)
    assert client.delete("/api/fields/999").status_code == 404


def test_field_writes_reject_front_desk(client):
    from tests.auth_helpers import bearer, login_as

    session_id = _make_session(client)
    field_id = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()["id"]
    headers = bearer(login_as(client, "front_desk"))

    assert client.patch(f"/api/fields/{field_id}", json={"name": "X"}, headers=headers).status_code == 403
    assert client.delete(f"/api/fields/{field_id}", headers=headers).status_code == 403
```

- [ ] **Step 2: Write the failing field-set tests**

Append to `server/tests/test_field_sets.py`:

```python
def _make_session_with_set(client) -> tuple[int, int]:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    field_set_id = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Gym A"}
    ).json()["id"]
    return session_id, field_set_id


def test_patch_field_set_with_empty_body_is_a_noop(client):
    session_id, field_set_id = _make_session_with_set(client)
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    client.patch(f"/api/field-sets/{field_set_id}", json={"division_id": division_id})

    response = client.patch(f"/api/field-sets/{field_set_id}", json={})
    assert response.status_code == 200
    assert response.json()["name"] == "Gym A"
    assert response.json()["division_id"] == division_id


def test_patch_field_set_renames_without_touching_division(client):
    session_id, field_set_id = _make_session_with_set(client)
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]
    client.patch(f"/api/field-sets/{field_set_id}", json={"division_id": division_id})

    response = client.patch(f"/api/field-sets/{field_set_id}", json={"name": " Gym B "})
    assert response.status_code == 200
    assert response.json()["name"] == "Gym B"
    assert response.json()["division_id"] == division_id


def test_patch_field_set_rejects_null_or_empty_name(client):
    _, field_set_id = _make_session_with_set(client)
    assert client.patch(f"/api/field-sets/{field_set_id}", json={"name": None}).status_code == 422
    assert client.patch(f"/api/field-sets/{field_set_id}", json={"name": "  "}).status_code == 422


def test_delete_field_set_removes_it_and_its_fields(client):
    session_id, field_set_id = _make_session_with_set(client)
    for name in ("Field 1", "Field 2"):
        client.post(
            "/api/fields",
            json={"session_id": session_id, "name": name, "field_set_id": field_set_id},
        )

    response = client.delete(f"/api/field-sets/{field_set_id}")
    assert response.status_code == 204
    assert client.get(f"/api/field-sets?session_id={session_id}").json() == []
    assert client.get(f"/api/fields?session_id={session_id}").json() == []


def test_delete_field_set_with_a_match_is_refused_and_keeps_its_fields(client):
    session_id, field_set_id = _make_session_with_set(client)
    field_id = client.post(
        "/api/fields",
        json={"session_id": session_id, "name": "Field 1", "field_set_id": field_set_id},
    ).json()["id"]
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    team_ids = [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, 5)
    ]
    client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": field_id,
            "alliances": [
                {"station": "red", "team_ids": team_ids[:2]},
                {"station": "blue", "team_ids": team_ids[2:]},
            ],
        },
    )

    response = client.delete(f"/api/field-sets/{field_set_id}")
    assert response.status_code == 409
    assert response.json()["detail"] == "Field set has scheduled matches; clear the schedule first"
    assert len(client.get(f"/api/fields?session_id={session_id}").json()) == 1


def test_delete_field_set_rejects_unknown_set(client):
    _make_session_with_set(client)
    assert client.delete("/api/field-sets/999").status_code == 404


def test_field_set_writes_reject_front_desk(client):
    from tests.auth_helpers import bearer, login_as

    _, field_set_id = _make_session_with_set(client)
    headers = bearer(login_as(client, "front_desk"))
    assert client.patch(f"/api/field-sets/{field_set_id}", json={"name": "X"}, headers=headers).status_code == 403
    assert client.delete(f"/api/field-sets/{field_set_id}", headers=headers).status_code == 403
```

Append to `server/tests/test_finals.py` (it already defines `_rank_teams_directly`):

```python
def test_delete_field_set_used_by_a_finals_bracket_is_refused(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    _rank_teams_directly(client, session_id, team_ids)
    assert client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    ).status_code == 201

    field_set_id = client.get(f"/api/field-sets?session_id={session_id}").json()[0]["id"]
    response = client.delete(f"/api/field-sets/{field_set_id}")
    assert response.status_code == 409
    assert response.json()["detail"] == "Field set is used by a finals bracket"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest tests/test_fields.py tests/test_field_sets.py tests/test_finals.py -k "patch or delete" -v`
Expected: the new tests FAIL (405 for the missing routes; the empty-body PATCH fails with 422 because `division_id` is currently required).

- [ ] **Step 4: Update the schemas**

In `server/src/tournament_server/schemas/field.py`, append:

```python
class FieldUpdate(BaseModel):
    name: str
```

In `server/src/tournament_server/schemas/field_set.py`, replace `FieldSetUpdate` with:

```python
class FieldSetUpdate(BaseModel):
    name: str | None = None
    division_id: int | None = None
```

- [ ] **Step 5: Add the field endpoints**

In `server/src/tournament_server/routers/fields.py`: change the FastAPI import to `from fastapi import APIRouter, Depends, HTTPException, Response`, add `from tournament_server.models.match import Match`, and import `FieldUpdate` alongside `FieldCreate, FieldRead`. Append:

```python
@router.patch("/{field_id}", response_model=FieldRead)
def update_field(
    field_id: int,
    payload: FieldUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Field:
    field = db.get(Field, field_id)
    if field is None:
        raise HTTPException(status_code=404, detail="Field not found")
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name must not be empty")
    field.name = name
    db.commit()
    db.refresh(field)
    return field


@router.delete("/{field_id}", status_code=204)
def delete_field(
    field_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    field = db.get(Field, field_id)
    if field is None:
        raise HTTPException(status_code=404, detail="Field not found")
    in_use = db.execute(
        select(Match.id).where(Match.field_id == field_id).limit(1)
    ).first()
    if in_use is not None:
        raise HTTPException(
            status_code=409, detail="Field has scheduled matches; clear the schedule first"
        )
    db.delete(field)
    db.commit()
    return Response(status_code=204)
```

- [ ] **Step 6: Rewrite the field-set PATCH and add DELETE**

In `server/src/tournament_server/routers/field_sets.py`: change the FastAPI import to `from fastapi import APIRouter, Depends, HTTPException, Response`, and add `from tournament_server.models.field import Field`, `from tournament_server.models.finals_bracket import FinalsBracket`, `from tournament_server.models.match import Match`. Replace the body of `update_field_set` (keep its signature) with:

```python
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    updates = payload.model_dump(exclude_unset=True)
    if "name" in updates:
        name = (updates["name"] or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="name must not be empty")
        field_set.name = name
    if "division_id" in updates:
        division_id = updates["division_id"]
        if division_id is not None and db.get(Division, division_id) is None:
            raise HTTPException(status_code=404, detail="Division not found")
        field_set.division_id = division_id
    db.commit()
    db.refresh(field_set)
    return field_set
```

Append:

```python
@router.delete("/{field_set_id}", status_code=204)
def delete_field_set(
    field_set_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    # Checked before the match check: a finals bracket's own run matches
    # also sit on this set's fields, and the bracket is the reason to name.
    used_by_bracket = db.execute(
        select(FinalsBracket.id).where(FinalsBracket.field_set_id == field_set_id).limit(1)
    ).first()
    if used_by_bracket is not None:
        raise HTTPException(status_code=409, detail="Field set is used by a finals bracket")
    fields = db.execute(
        select(Field).where(Field.field_set_id == field_set_id)
    ).scalars().all()
    field_ids = [field.id for field in fields]
    if field_ids:
        in_use = db.execute(
            select(Match.id).where(Match.field_id.in_(field_ids)).limit(1)
        ).first()
        if in_use is not None:
            raise HTTPException(
                status_code=409,
                detail="Field set has scheduled matches; clear the schedule first",
            )
    for field in fields:
        db.delete(field)
    db.flush()
    db.delete(field_set)
    db.commit()
    return Response(status_code=204)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && .venv/bin/pytest tests/test_fields.py tests/test_field_sets.py tests/test_finals.py -v`
Expected: all PASS (including the pre-existing `test_patch_field_set_*` tests, which still send `division_id` explicitly).

- [ ] **Step 8: Document it**

In `server/CLAUDE.md`'s `## Scheduling` section, after the paragraph that starts "Every Field belongs to exactly one FieldSet", add:

```markdown
Fields and FieldSets can be renamed (`PATCH /api/fields/{id}` with
`{"name"}`; `PATCH /api/field-sets/{id}` with `{"name"}`) and deleted
(`DELETE /api/fields/{id}`; `DELETE /api/field-sets/{id}`, which deletes
the set's fields with it), all `admin`-only. A delete is refused (409)
while anything still depends on it: any `Match.field_id` pointing at the
field (or at any of the set's fields), or — checked first for a set —
any `FinalsBracket.field_set_id` pointing at the set. A refused delete
deletes nothing. Clearing the schedule (`DELETE /api/schedule`) is what
frees a field up again.
```

In the `## Multi-division scheduling` section, replace the sentence "or changed later via `PATCH /api/field-sets/{id}` — the request body's `division_id` key is required, so the caller always states the intended value: an id to assign, or `null` to clear)" with:

```markdown
or changed later via `PATCH /api/field-sets/{id}`, a partial update like
`PATCH /api/sessions/{id}`: only the keys present are written, so `{}` is
a no-op, `{"division_id": <id>}` assigns, and `{"division_id": null}`
clears)
```

- [ ] **Step 9: Commit**

```bash
git add server/src/tournament_server/schemas/field.py server/src/tournament_server/schemas/field_set.py server/src/tournament_server/routers/fields.py server/src/tournament_server/routers/field_sets.py server/tests/test_fields.py server/tests/test_field_sets.py server/tests/test_finals.py server/CLAUDE.md
git commit -m "Add rename and delete for fields and field sets"
```

---

### Task 3: `MatchRead.is_finals` and `ResolvedTimeBlockRead.time_slot_count`

**Files:**
- Modify: `server/src/tournament_server/schemas/match.py`
- Modify: `server/src/tournament_server/routers/matches.py` (`_to_match_read`, around line 84)
- Modify: `server/src/tournament_server/schemas/schedule.py`
- Modify: `server/src/tournament_server/routers/schedule.py` (the `ResolvedTimeBlockRead(...)` construction, around line 419)
- Modify: `server/CLAUDE.md`
- Test: `server/tests/test_finals.py`, `server/tests/test_schedule.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MatchRead.is_finals: bool` (Tasks 6–8 frontend `MatchRead` type); `ResolvedTimeBlockRead.time_slot_count: int` (Task 9 preview's projected finish).

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_finals.py`:

```python
def test_match_read_flags_finals_matches(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    _rank_teams_directly(client, session_id, team_ids)
    client.post("/api/finals/start", json={"session_id": session_id, "bracket_size": 2})

    matches = client.get(f"/api/matches?session_id={session_id}").json()
    finals = [m for m in matches if m["is_finals"]]
    qualification = [m for m in matches if m["round_type"] == "qualification"]
    assert finals, "starting a score-chase bracket creates its first run"
    assert all(m["label"].startswith("F") for m in finals)
    assert qualification and all(m["is_finals"] is False for m in qualification)
```

Append to `server/tests/test_schedule.py` (it already defines `_setup_ready_session`):

```python
def test_resolved_time_blocks_report_their_time_slot_count(client):
    session_id, _ = _setup_ready_session(client, num_teams=8)
    client.patch(f"/api/sessions/{session_id}", json={"timezone": "America/Los_Angeles"})
    payload = {
        "session_id": session_id,
        "phases": [{"round_type": "qualification", "target_matches_per_team": 3}],
        "scheduler_plugin_name": "simple_random",
        "time_blocks": [
            {"date": "2026-09-05", "start_time": "09:00", "end_time": "10:00", "cycle_time": None},
            {"date": "2026-09-05", "start_time": "11:00", "end_time": "12:00", "cycle_time": None},
        ],
    }

    dry = client.post("/api/schedule", json={**payload, "dry_run": True})
    assert dry.status_code == 201, dry.text
    assert all(b["time_slot_count"] > 0 for b in dry.json()["resolved_time_blocks"])

    real = client.post("/api/schedule", json=payload)
    assert real.status_code == 201, real.text
    counts = [b["time_slot_count"] for b in real.json()["resolved_time_blocks"]]
    matches = client.get(f"/api/matches?session_id={session_id}").json()
    assert sum(counts) == len({m["time_slot"] for m in matches})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest tests/test_finals.py::test_match_read_flags_finals_matches tests/test_schedule.py::test_resolved_time_blocks_report_their_time_slot_count -v`
Expected: both FAIL with `KeyError: 'is_finals'` / `KeyError: 'time_slot_count'`.

- [ ] **Step 3: Add `is_finals`**

In `server/src/tournament_server/schemas/match.py`'s `MatchRead`, add after `remaining_seconds_at_pause: float | None`:

```python
    is_finals: bool
```

In `server/src/tournament_server/routers/matches.py`'s `_to_match_read`, add to the `MatchRead(...)` call after `remaining_seconds_at_pause=match.remaining_seconds_at_pause,`:

```python
        is_finals=match.finals_bracket_id is not None,
```

- [ ] **Step 4: Add `time_slot_count`**

In `server/src/tournament_server/schemas/schedule.py`'s `ResolvedTimeBlockRead`, add after `cycle_time_seconds: float`:

```python
    time_slot_count: int
```

In `server/src/tournament_server/routers/schedule.py`'s `ResolvedTimeBlockRead(...)` construction, add after `cycle_time_seconds=b.cycle_time_seconds,`:

```python
            time_slot_count=b.time_slot_count,
```

(`services/schedule_timing.py`'s `ResolvedBlock` already carries `time_slot_count`.)

- [ ] **Step 5: Run the full backend suite**

Run: `cd server && .venv/bin/pytest tests/ -q`
Expected: all PASS.

- [ ] **Step 6: Document it**

In `server/CLAUDE.md`'s `### Match labeling` section, append a paragraph:

```markdown
`MatchRead.is_finals` is `true` exactly when the match belongs to a
finals bracket (`finals_bracket_id` set). Finals games share the game
plugin's ordinary `"elimination"` round type, so `round_type` alone can't
tell a schedule-generated round (which `DELETE /api/schedule` clears)
from a finals game (which it never touches); the admin UI uses this flag.
```

In the `## Time-based scheduling` section, change "Each block in the response's `resolved_time_blocks` (`ResolvedTimeBlockRead`: `date`, `start_time`, `end_time`, `cycle_time_seconds`)" to "Each block in the response's `resolved_time_blocks` (`ResolvedTimeBlockRead`: `date`, `start_time`, `end_time`, `cycle_time_seconds`, `time_slot_count` — the slots allocated to that block, which lets a client project an open-ended block's finish time)".

- [ ] **Step 7: Commit**

```bash
git add server/src/tournament_server/schemas/match.py server/src/tournament_server/routers/matches.py server/src/tournament_server/schemas/schedule.py server/src/tournament_server/routers/schedule.py server/tests/test_finals.py server/tests/test_schedule.py server/CLAUDE.md
git commit -m "Expose is_finals on matches and time_slot_count on resolved blocks"
```

---

### Task 4: Session header active-session control and shared frontend types

**Files:**
- Modify: `frontend/apps/admin/src/types.ts`
- Create: `frontend/apps/admin/src/apiErrorMessage.ts`
- Modify: `frontend/apps/admin/src/routes/SessionDetailLayout.tsx`
- Modify: `frontend/apps/admin/src/styles/components.css`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx`

**Interfaces:**
- Consumes: existing `EventRead`, `SessionRead`, `Division`, `PluginSummary` in `src/types.ts`; `POST /api/event/active-session`.
- Produces (used by Tasks 5–9):
  - Types in `src/types.ts`: `FieldSetRead`, `FieldRead`, `AllianceRead`, `MatchRead`, `MatchFormat`, `TeamSummary`, `ParticipationRead`, `ResolvedTimeBlock`, `PhaseResult`, `ScheduleGenerateResponse` (exact shapes below).
  - `apiErrorMessage(error: unknown, fallback: string): string` in `src/apiErrorMessage.ts`.
  - CSS classes `.badge-success`, `.alert-warning`, `.session-detail__activate`.
  - Query key `["event"]` for `GET /api/event` (already used by `FrontDeskCheckinRoute`).

- [ ] **Step 1: Add the shared types**

Append to `frontend/apps/admin/src/types.ts`:

```ts
export interface FieldSetRead {
  id: number;
  session_id: number;
  name: string;
  division_id: number | null;
}

export interface FieldRead {
  id: number;
  field_set_id: number;
  name: string;
}

export interface AllianceRead {
  id: number;
  station: string;
  team_ids: number[];
}

export interface MatchRead {
  id: number;
  session_id: number;
  division_id: number | null;
  round_type: string;
  match_number: number;
  label: string;
  field_id: number | null;
  time_slot: number | null;
  scheduled_time: string | null;
  status: string;
  is_finals: boolean;
  alliances: AllianceRead[];
}

export interface MatchFormat {
  round_types: string[];
  teams_per_alliance: number;
  alliance_count: number;
  match_duration_seconds: number;
}

export interface TeamSummary {
  id: number;
  number: string;
  name: string;
  division_id: number | null;
}

export interface ParticipationRead {
  id: number;
  session_id: number;
  team_id: number;
  checked_in: boolean;
}

export interface ResolvedTimeBlock {
  date: string;
  start_time: string;
  end_time: string | null;
  cycle_time_seconds: number;
  time_slot_count: number;
}

export interface PhaseResult {
  round_type: string;
  schedule_generation_id: number | null;
  match_count: number;
}

export interface ScheduleGenerateResponse {
  schedule_generation_id: number | null;
  match_count: number;
  resolved_time_blocks: ResolvedTimeBlock[];
  cycle_time_warning: string | null;
  phase_results: PhaseResult[] | null;
}
```

- [ ] **Step 2: Add the error-message helper**

Create `frontend/apps/admin/src/apiErrorMessage.ts`:

```ts
import { ApiError } from "@tournament-admin/shared";

/** A server-reported detail when there is a readable one, else `fallback`. FastAPI's own request-validation 422s carry a list, not a string, so those fall back too. */
export function apiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && typeof error.detail === "string" && error.detail) {
    return error.detail;
  }
  return fallback;
}
```

- [ ] **Step 3: Add the i18n strings**

In `frontend/apps/admin/src/i18n/en/admin.json`, add inside the `"sessions"` object (after `"noTimezoneSet"`):

```json
    "activeBadge": "Active session",
    "setActiveAction": "Set as active session",
    "setActiveHint": "The front-desk kiosk and live displays follow the active session.",
```

In `frontend/apps/admin/src/i18n/zh/admin.json`, add the same keys inside `"sessions"`:

```json
    "activeBadge": "当前场次",
    "setActiveAction": "设为当前场次",
    "setActiveHint": "前台签到终端和现场显示屏会跟随当前场次。",
```

- [ ] **Step 4: Write the failing tests**

In `frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx`, change the `@testing-library/react` import to `import { fireEvent, render, screen } from "@testing-library/react";`, then add inside the `describe` block:

```tsx
  const SATURDAY = {
    id: 1,
    event_id: 1,
    label: "Saturday",
    session_date: "2026-09-05",
    timezone: "America/Los_Angeles",
  };

  function eventWithActiveSession(activeSessionId: number | null) {
    return {
      id: 1,
      name: "Demo Event",
      active_session_id: activeSessionId,
      game_plugin_name: null,
      created_at: "2026-09-01T00:00:00Z",
    };
  }

  it("shows the Active session badge when this session is the event's active session", async () => {
    vi.mocked(apiRequest).mockImplementation(async (path: string) => {
      if (path === "/api/sessions") return [SATURDAY] as never;
      if (path === "/api/event") return eventWithActiveSession(1) as never;
      throw new Error(`unexpected request: ${path}`);
    });
    renderAt("/sessions/1/checkin");

    expect(await screen.findByText("Active session")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set as active session" })).not.toBeInTheDocument();
  });

  it("offers Set as active session otherwise and makes it active", async () => {
    let activeSessionId: number | null = 2;
    vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
      if (path === "/api/sessions") return [SATURDAY] as never;
      if (path === "/api/event") return eventWithActiveSession(activeSessionId) as never;
      if (path === "/api/event/active-session") {
        expect(options).toEqual({ method: "POST", body: { session_id: 1 } });
        activeSessionId = 1;
        return eventWithActiveSession(1) as never;
      }
      throw new Error(`unexpected request: ${path}`);
    });
    renderAt("/sessions/1/checkin");

    fireEvent.click(await screen.findByRole("button", { name: "Set as active session" }));
    expect(await screen.findByText("Active session")).toBeInTheDocument();
  });
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionDetailLayout.test.tsx`
Expected: the 2 new tests FAIL (no badge/button rendered).

- [ ] **Step 6: Implement the header control**

Replace `frontend/apps/admin/src/routes/SessionDetailLayout.tsx` with:

```tsx
import { NavLink, Outlet, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { EventRead, SessionRead } from "../types";

function tabLinkClassName({ isActive }: { isActive: boolean }): string | undefined {
  return isActive ? "active" : undefined;
}

export function SessionDetailLayout() {
  const { t } = useTranslation();
  const { sessionId } = useParams<{ sessionId: string }>();
  const queryClient = useQueryClient();

  const { data: sessions, isLoading, isError } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => apiRequest<SessionRead[]>("/api/sessions"),
  });
  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const activateMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest<EventRead>("/api/event/active-session", {
        method: "POST",
        body: { session_id: id },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event"] });
    },
  });
  const session = sessions?.find((candidate) => candidate.id === Number(sessionId));

  if (isLoading) {
    return <p>{t("sessions.loading")}</p>;
  }
  if (isError) {
    // Distinct from "session not found" below: the list fetch itself
    // failed (network/server error), not "the id isn't in a
    // successfully-loaded list".
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
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
        {event &&
          (event.active_session_id === session.id ? (
            <span className="badge badge-success">{t("sessions.activeBadge")}</span>
          ) : (
            <div className="session-detail__activate">
              <button
                type="button"
                className="btn btn-small"
                onClick={() => activateMutation.mutate(session.id)}
                disabled={activateMutation.isPending}
              >
                {t("sessions.setActiveAction")}
              </button>
              <span className="field__hint">{t("sessions.setActiveHint")}</span>
            </div>
          ))}
        {activateMutation.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(activateMutation.error, t("errors.generic"))}
          </p>
        )}
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

- [ ] **Step 7: Add the CSS**

Append to `frontend/apps/admin/src/styles/components.css`:

```css
.badge-success {
  background: var(--color-success-bg);
  color: var(--color-success);
}

.alert-warning {
  background: var(--color-warning-bg);
  color: var(--color-warning);
}

.session-detail__activate {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}
```

- [ ] **Step 8: Run the tests and type-check**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionDetailLayout.test.tsx && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add frontend/apps/admin/src/types.ts frontend/apps/admin/src/apiErrorMessage.ts frontend/apps/admin/src/routes/SessionDetailLayout.tsx frontend/apps/admin/src/styles/components.css frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx
git commit -m "Add the active-session control to the session header"
```

---

### Task 5: Fields tab

**Files:**
- Create: `frontend/apps/admin/src/components/ConfirmDialog.tsx`
- Create: `frontend/apps/admin/src/routes/SessionFieldsRoute.tsx`
- Modify: `frontend/apps/admin/src/routes/SessionDetailLayout.tsx` (tab link)
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/styles/components.css`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/SessionFieldsRoute.test.tsx`, `frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx`

**Interfaces:**
- Consumes: Task 2's endpoints; Task 4's `FieldSetRead`, `FieldRead`, `Division`, `SessionRead`, `apiErrorMessage`; `InlineEditableText` (`src/components/InlineEditableText.tsx`).
- Produces:
  - `ConfirmDialog` props: `{ heading: string; body: string; confirmLabel: string; cancelLabel: string; requiredPhrase?: string | null; phrasePrompt?: string; isPending?: boolean; error?: string | null; onConfirm: () => void; onCancel: () => void }` (reused by Task 8).
  - Query keys `["fieldSets", sessionId]` (`GET /api/field-sets?session_id=`) and `["fields", sessionId]` (`GET /api/fields?session_id=`) — reused by Tasks 7–8.
  - Route `/sessions/:sessionId/fields`.

- [ ] **Step 1: Add the i18n strings**

In `en/admin.json`, inside `"sessions"`, add after `"checkinTab"`:

```json
    "fieldsTab": "Fields",
```

and add a new `"fields"` object inside `"sessions"` (after `"checkin"`):

```json
    "fields": {
      "empty": "This session has no fields yet.",
      "firstFieldLabel": "Add your first field",
      "addFieldAction": "Add field",
      "newFieldLabel": "New field name for {{name}}",
      "newFieldPlaceholder": "Field name",
      "setNameLabel": "Field set name",
      "renameSetAction": "Rename field set {{name}}",
      "fieldNameLabel": "Field name",
      "renameFieldAction": "Rename field {{name}}",
      "removeFieldAction": "Remove",
      "removeFieldAriaLabel": "Remove field {{name}}",
      "divisionLabel": "Division",
      "unassignedOption": "Unassigned",
      "unassignedNote": "Not used for scheduling until assigned to a division.",
      "deleteSetAction": "Delete set",
      "newSetLabel": "New field set name",
      "addSetAction": "Add field set",
      "deleteFieldHeading": "Remove field {{name}}?",
      "deleteFieldBody": "The field is removed from this session.",
      "deleteSetHeading": "Delete field set {{name}}?",
      "deleteSetBody": "The set and all of its fields are removed from this session.",
      "confirmDelete": "Delete"
    },
```

In `zh/admin.json`, the same keys:

```json
    "fieldsTab": "场地",
```

```json
    "fields": {
      "empty": "该场次还没有场地。",
      "firstFieldLabel": "添加第一个场地",
      "addFieldAction": "添加场地",
      "newFieldLabel": "{{name}} 的新场地名称",
      "newFieldPlaceholder": "场地名称",
      "setNameLabel": "场地组名称",
      "renameSetAction": "重命名场地组 {{name}}",
      "fieldNameLabel": "场地名称",
      "renameFieldAction": "重命名场地 {{name}}",
      "removeFieldAction": "移除",
      "removeFieldAriaLabel": "移除场地 {{name}}",
      "divisionLabel": "组别",
      "unassignedOption": "未分配",
      "unassignedNote": "分配到组别之前不会用于排赛程。",
      "deleteSetAction": "删除场地组",
      "newSetLabel": "新场地组名称",
      "addSetAction": "添加场地组",
      "deleteFieldHeading": "移除场地 {{name}}？",
      "deleteFieldBody": "该场地将从此场次中移除。",
      "deleteSetHeading": "删除场地组 {{name}}？",
      "deleteSetBody": "该场地组及其所有场地将从此场次中移除。",
      "confirmDelete": "删除"
    },
```

- [ ] **Step 2: Write the failing tests**

Create `frontend/apps/admin/tests/unit/SessionFieldsRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { ApiError, initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionFieldsRoute } from "../../src/routes/SessionFieldsRoute";
import type { Division, FieldRead, FieldSetRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: "2026-11-07",
  timezone: "America/Los_Angeles",
};
const ONE_DIVISION: Division[] = [{ id: 1, event_id: 1, name: "Division 1", target_team_count: null }];
const TWO_DIVISIONS: Division[] = [
  ...ONE_DIVISION,
  { id: 2, event_id: 1, name: "Blue", target_team_count: null },
];
const MAIN_SET: FieldSetRead = { id: 10, session_id: 1, name: "Main Fields", division_id: null };
const FIELD_A: FieldRead = { id: 100, field_set_id: 10, name: "Field A" };

const NOT_HANDLED = Symbol("not handled");
type Override = (path: string, options?: { method?: string; body?: unknown }) => unknown;

function stubServer(
  state: { divisions: Division[]; fieldSets: FieldSetRead[]; fields: FieldRead[] },
  override: Override = () => NOT_HANDLED
) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    const handled = override(path, opts);
    if (handled instanceof Error) throw handled;
    if (handled !== NOT_HANDLED) return handled as never;
    if (path === "/api/divisions") return state.divisions as never;
    if (path === "/api/field-sets?session_id=1") return state.fieldSets as never;
    if (path === "/api/fields?session_id=1") return state.fields as never;
    throw new Error(`unexpected request: ${opts?.method ?? "GET"} ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderFields() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionFieldsRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("SessionFieldsRoute", () => {
  it("renders a card per field set and hides the division control for a single division", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET], fields: [FIELD_A] });
    renderFields();

    const card = await screen.findByRole("region", { name: "Main Fields" });
    expect(within(card).getByText("Field A")).toBeInTheDocument();
    expect(screen.queryByLabelText("Division")).not.toBeInTheDocument();
  });

  it("creates the first field without a field_set_id when the session has none", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [], fields: [] }, (path, options) =>
      path === "/api/fields" && options?.method === "POST" ? FIELD_A : NOT_HANDLED
    );
    renderFields();

    fireEvent.change(await screen.findByLabelText("Add your first field"), {
      target: { value: " Field A " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/fields", {
        method: "POST",
        body: { session_id: 1, name: "Field A" },
      })
    );
  });

  it("adds a field to a specific set with an explicit field_set_id", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET], fields: [FIELD_A] }, (path, options) =>
      path === "/api/fields" && options?.method === "POST"
        ? { id: 101, field_set_id: 10, name: "Field B" }
        : NOT_HANDLED
    );
    renderFields();

    fireEvent.change(await screen.findByLabelText("New field name for Main Fields"), {
      target: { value: "Field B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/fields", {
        method: "POST",
        body: { session_id: 1, name: "Field B", field_set_id: 10 },
      })
    );
  });

  it("shows the division select for several divisions, notes unassigned sets, and assigns one", async () => {
    stubServer({ divisions: TWO_DIVISIONS, fieldSets: [MAIN_SET], fields: [FIELD_A] }, (path, options) =>
      path === "/api/field-sets/10" && options?.method === "PATCH"
        ? { ...MAIN_SET, division_id: 2 }
        : NOT_HANDLED
    );
    renderFields();

    expect(
      await screen.findByText("Not used for scheduling until assigned to a division.")
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "2" } });

    await waitFor(() =>
      expect(apiRequest).toHaveBeenCalledWith("/api/field-sets/10", {
        method: "PATCH",
        body: { division_id: 2 },
      })
    );
  });

  it("shows a refused delete inline on that field's card", async () => {
    stubServer({ divisions: ONE_DIVISION, fieldSets: [MAIN_SET], fields: [FIELD_A] }, (path, options) =>
      path === "/api/fields/100" && options?.method === "DELETE"
        ? new ApiError(409, "Field has scheduled matches; clear the schedule first")
        : NOT_HANDLED
    );
    renderFields();

    fireEvent.click(await screen.findByRole("button", { name: "Remove field Field A" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const card = screen.getByRole("region", { name: "Main Fields" });
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "Field has scheduled matches; clear the schedule first"
    );
  });
});
```

In `tests/unit/SessionDetailLayout.test.tsx`'s first test ("renders the session's header, meta line, and tab strip once loaded"), add after the Check-In link assertion:

```tsx
    expect(screen.getByRole("link", { name: "Fields" })).toBeInTheDocument();
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionFieldsRoute.test.tsx tests/unit/SessionDetailLayout.test.tsx`
Expected: FAIL (module `SessionFieldsRoute` not found; no Fields link).

- [ ] **Step 4: Create `ConfirmDialog`**

Create `frontend/apps/admin/src/components/ConfirmDialog.tsx`:

```tsx
import { useId, useState } from "react";

interface ConfirmDialogProps {
  heading: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  /** When set, the confirm button stays disabled until this exact text is typed. */
  requiredPhrase?: string | null;
  phrasePrompt?: string;
  isPending?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  heading,
  body,
  confirmLabel,
  cancelLabel,
  requiredPhrase,
  phrasePrompt,
  isPending = false,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const headingId = useId();
  const [typed, setTyped] = useState("");
  const phraseSatisfied = !requiredPhrase || typed.trim() === requiredPhrase;

  return (
    <div className="dialog-overlay">
      <div className="dialog" role="alertdialog" aria-labelledby={headingId}>
        <h2 id={headingId}>{heading}</h2>
        <p>{body}</p>
        {requiredPhrase && (
          <label className="field">
            <span className="field__label">{phrasePrompt}</span>
            <input
              className="input"
              value={typed}
              autoFocus
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="alert alert-danger" role="alert">
            {error}
          </p>
        )}
        <div className="dialog__actions">
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={!phraseSatisfied || isPending}
          >
            {confirmLabel}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={isPending}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create the Fields tab**

Create `frontend/apps/admin/src/routes/SessionFieldsRoute.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { InlineEditableText } from "../components/InlineEditableText";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import type { Division, FieldRead, FieldSetRead, SessionRead } from "../types";

type PendingDelete =
  | { kind: "field"; id: number; fieldSetId: number; name: string }
  | { kind: "fieldSet"; id: number; name: string };

function cardIdOf(target: PendingDelete): number {
  return target.kind === "field" ? target.fieldSetId : target.id;
}

export function SessionFieldsRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const queryClient = useQueryClient();
  const [firstFieldName, setFirstFieldName] = useState("");
  const [newFieldNames, setNewFieldNames] = useState<Record<number, string>>({});
  const [newSetName, setNewSetName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [cardErrors, setCardErrors] = useState<Record<number, string>>({});
  const generic = t("errors.generic");

  const fieldSetsQuery = useQuery({
    queryKey: ["fieldSets", session.id],
    queryFn: () => apiRequest<FieldSetRead[]>(`/api/field-sets?session_id=${session.id}`),
  });
  const fieldsQuery = useQuery({
    queryKey: ["fields", session.id],
    queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${session.id}`),
  });
  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["fieldSets", session.id] });
    queryClient.invalidateQueries({ queryKey: ["fields", session.id] });
  }

  function setCardError(fieldSetId: number, message: string | null) {
    setCardErrors((previous) => {
      const next = { ...previous };
      if (message === null) delete next[fieldSetId];
      else next[fieldSetId] = message;
      return next;
    });
  }

  const createFieldMutation = useMutation({
    mutationFn: ({ name, fieldSetId }: { name: string; fieldSetId: number | null }) =>
      apiRequest<FieldRead>("/api/fields", {
        method: "POST",
        body:
          fieldSetId === null
            ? { session_id: session.id, name }
            : { session_id: session.id, name, field_set_id: fieldSetId },
      }),
    onSuccess: (_field, { fieldSetId }) => {
      if (fieldSetId === null) {
        setFirstFieldName("");
      } else {
        setNewFieldNames((previous) => ({ ...previous, [fieldSetId]: "" }));
        setCardError(fieldSetId, null);
      }
      refresh();
    },
    onError: (error, { fieldSetId }) => {
      if (fieldSetId !== null) setCardError(fieldSetId, apiErrorMessage(error, generic));
    },
  });

  const createSetMutation = useMutation({
    mutationFn: (name: string) =>
      apiRequest<FieldSetRead>("/api/field-sets", {
        method: "POST",
        body: { session_id: session.id, name },
      }),
    onSuccess: () => {
      setNewSetName("");
      refresh();
    },
  });

  const renameSetMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiRequest<FieldSetRead>(`/api/field-sets/${id}`, { method: "PATCH", body: { name } }),
    onSuccess: refresh,
  });

  const assignDivisionMutation = useMutation({
    mutationFn: ({ id, divisionId }: { id: number; divisionId: number | null }) =>
      apiRequest<FieldSetRead>(`/api/field-sets/${id}`, {
        method: "PATCH",
        body: { division_id: divisionId },
      }),
    onSuccess: (_set, { id }) => {
      setCardError(id, null);
      refresh();
    },
    onError: (error, { id }) => setCardError(id, apiErrorMessage(error, generic)),
  });

  const renameFieldMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiRequest<FieldRead>(`/api/fields/${id}`, { method: "PATCH", body: { name } }),
    onSuccess: refresh,
  });

  const deleteMutation = useMutation({
    mutationFn: (target: PendingDelete) =>
      apiRequest<void>(
        target.kind === "field" ? `/api/fields/${target.id}` : `/api/field-sets/${target.id}`,
        { method: "DELETE" }
      ),
    onSuccess: (_result, target) => {
      setCardError(cardIdOf(target), null);
      refresh();
    },
    onError: (error, target) => setCardError(cardIdOf(target), apiErrorMessage(error, generic)),
    onSettled: () => setPendingDelete(null),
  });

  if (fieldSetsQuery.isLoading || fieldsQuery.isLoading) {
    return <p>{t("sessions.loading")}</p>;
  }

  const fieldSets = fieldSetsQuery.data ?? [];
  const fields = fieldsQuery.data ?? [];
  const multiDivision = (divisions?.length ?? 0) > 1;

  return (
    <div className="session-fields">
      {fieldSets.length === 0 ? (
        <div className="panel">
          <p>{t("sessions.fields.empty")}</p>
          <form
            className="form-actions"
            onSubmit={(event) => {
              event.preventDefault();
              const name = firstFieldName.trim();
              if (name) createFieldMutation.mutate({ name, fieldSetId: null });
            }}
          >
            <input
              className="input"
              aria-label={t("sessions.fields.firstFieldLabel")}
              placeholder={t("sessions.fields.firstFieldLabel")}
              value={firstFieldName}
              onChange={(event) => setFirstFieldName(event.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary btn-small"
              disabled={!firstFieldName.trim() || createFieldMutation.isPending}
            >
              {t("sessions.fields.addFieldAction")}
            </button>
          </form>
          {createFieldMutation.isError && createFieldMutation.variables?.fieldSetId === null && (
            <p className="alert alert-danger" role="alert">
              {apiErrorMessage(createFieldMutation.error, generic)}
            </p>
          )}
        </div>
      ) : (
        fieldSets.map((fieldSet) => {
          const setFields = fields.filter((field) => field.field_set_id === fieldSet.id);
          const newFieldName = newFieldNames[fieldSet.id] ?? "";
          const renamingThisSet = renameSetMutation.variables?.id === fieldSet.id;
          return (
            <section key={fieldSet.id} className="panel field-set-card" aria-label={fieldSet.name}>
              <div className="field-set-card__header">
                <InlineEditableText
                  value={fieldSet.name}
                  onSave={(name) => renameSetMutation.mutate({ id: fieldSet.id, name })}
                  onCancel={() => renameSetMutation.reset()}
                  isSaving={renameSetMutation.isPending && renamingThisSet}
                  error={
                    renameSetMutation.isError && renamingThisSet
                      ? apiErrorMessage(renameSetMutation.error, generic)
                      : null
                  }
                  editLabel={t("sessions.fields.renameSetAction", { name: fieldSet.name })}
                  saveLabel={t("sessions.saveAction")}
                  cancelLabel={t("sessions.cancelAction")}
                  inputLabel={t("sessions.fields.setNameLabel")}
                />
                {multiDivision && (
                  <label className="field-set-card__division">
                    <span>{t("sessions.fields.divisionLabel")}</span>
                    <select
                      className="select"
                      value={fieldSet.division_id ?? ""}
                      onChange={(event) =>
                        assignDivisionMutation.mutate({
                          id: fieldSet.id,
                          divisionId: event.target.value === "" ? null : Number(event.target.value),
                        })
                      }
                    >
                      <option value="">{t("sessions.fields.unassignedOption")}</option>
                      {(divisions ?? []).map((division) => (
                        <option key={division.id} value={division.id}>
                          {division.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  onClick={() =>
                    setPendingDelete({ kind: "fieldSet", id: fieldSet.id, name: fieldSet.name })
                  }
                >
                  {t("sessions.fields.deleteSetAction")}
                </button>
              </div>
              {multiDivision && fieldSet.division_id === null && (
                <p className="field__hint">{t("sessions.fields.unassignedNote")}</p>
              )}
              <ul className="list-plain">
                {setFields.map((field) => {
                  const renamingThisField = renameFieldMutation.variables?.id === field.id;
                  return (
                    <li key={field.id} className="list-row">
                      <InlineEditableText
                        value={field.name}
                        onSave={(name) => renameFieldMutation.mutate({ id: field.id, name })}
                        onCancel={() => renameFieldMutation.reset()}
                        isSaving={renameFieldMutation.isPending && renamingThisField}
                        error={
                          renameFieldMutation.isError && renamingThisField
                            ? apiErrorMessage(renameFieldMutation.error, generic)
                            : null
                        }
                        editLabel={t("sessions.fields.renameFieldAction", { name: field.name })}
                        saveLabel={t("sessions.saveAction")}
                        cancelLabel={t("sessions.cancelAction")}
                        inputLabel={t("sessions.fields.fieldNameLabel")}
                      />
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={t("sessions.fields.removeFieldAriaLabel", { name: field.name })}
                        onClick={() =>
                          setPendingDelete({
                            kind: "field",
                            id: field.id,
                            fieldSetId: fieldSet.id,
                            name: field.name,
                          })
                        }
                      >
                        {t("sessions.fields.removeFieldAction")}
                      </button>
                    </li>
                  );
                })}
              </ul>
              <form
                className="form-actions"
                onSubmit={(event) => {
                  event.preventDefault();
                  const name = newFieldName.trim();
                  if (name) createFieldMutation.mutate({ name, fieldSetId: fieldSet.id });
                }}
              >
                <input
                  className="input"
                  aria-label={t("sessions.fields.newFieldLabel", { name: fieldSet.name })}
                  placeholder={t("sessions.fields.newFieldPlaceholder")}
                  value={newFieldName}
                  onChange={(event) =>
                    setNewFieldNames((previous) => ({ ...previous, [fieldSet.id]: event.target.value }))
                  }
                />
                <button type="submit" className="btn btn-small" disabled={!newFieldName.trim()}>
                  {t("sessions.fields.addFieldAction")}
                </button>
              </form>
              {cardErrors[fieldSet.id] && (
                <p className="alert alert-danger" role="alert">
                  {cardErrors[fieldSet.id]}
                </p>
              )}
            </section>
          );
        })
      )}
      <form
        className="form-actions"
        onSubmit={(event) => {
          event.preventDefault();
          const name = newSetName.trim();
          if (name) createSetMutation.mutate(name);
        }}
      >
        <input
          className="input"
          aria-label={t("sessions.fields.newSetLabel")}
          placeholder={t("sessions.fields.newSetLabel")}
          value={newSetName}
          onChange={(event) => setNewSetName(event.target.value)}
        />
        <button
          type="submit"
          className="btn btn-small"
          disabled={!newSetName.trim() || createSetMutation.isPending}
        >
          {t("sessions.fields.addSetAction")}
        </button>
      </form>
      {createSetMutation.isError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(createSetMutation.error, generic)}
        </p>
      )}
      {pendingDelete && (
        <ConfirmDialog
          heading={
            pendingDelete.kind === "field"
              ? t("sessions.fields.deleteFieldHeading", { name: pendingDelete.name })
              : t("sessions.fields.deleteSetHeading", { name: pendingDelete.name })
          }
          body={
            pendingDelete.kind === "field"
              ? t("sessions.fields.deleteFieldBody")
              : t("sessions.fields.deleteSetBody")
          }
          confirmLabel={t("sessions.fields.confirmDelete")}
          cancelLabel={t("sessions.cancelAction")}
          isPending={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 6: Wire the tab and route**

In `SessionDetailLayout.tsx`, add after the Check-In `NavLink`:

```tsx
        <NavLink to={`/sessions/${session.id}/fields`} className={tabLinkClassName}>
          {t("sessions.fieldsTab")}
        </NavLink>
```

In `router.tsx`, add `import { SessionFieldsRoute } from "./routes/SessionFieldsRoute";` and, in the `sessions/:sessionId` children after the `checkin` entry:

```tsx
          { path: "fields", element: <SessionFieldsRoute /> },
```

- [ ] **Step 7: Add the CSS**

Append to `components.css`:

```css
.field-set-card__header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex-wrap: wrap;
}

.field-set-card__header .inline-edit {
  flex: 1;
  min-width: 12rem;
}

.field-set-card__division {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
}
```

- [ ] **Step 8: Run the tests and type-check**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionFieldsRoute.test.tsx tests/unit/SessionDetailLayout.test.tsx && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add frontend/apps/admin/src/components/ConfirmDialog.tsx frontend/apps/admin/src/routes/SessionFieldsRoute.tsx frontend/apps/admin/src/routes/SessionDetailLayout.tsx frontend/apps/admin/src/router.tsx frontend/apps/admin/src/styles/components.css frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/unit/SessionFieldsRoute.test.tsx frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx
git commit -m "Add the session Fields tab"
```

---

### Task 6: Pure scheduling helpers

**Files:**
- Create: `frontend/apps/admin/src/schedule/scheduleRequest.ts`
- Create: `frontend/apps/admin/src/schedule/roundSummary.ts`
- Create: `frontend/apps/admin/src/schedule/readiness.ts`
- Create: `frontend/apps/admin/src/matchTime.ts`
- Test: `frontend/apps/admin/tests/unit/scheduleRequest.test.ts`, `roundSummary.test.ts`, `readiness.test.ts`, `matchTime.test.ts` (all in `tests/unit/`)

**Interfaces:**
- Consumes: Task 4's `MatchRead`, `FieldSetRead`, `FieldRead`, `TeamSummary`, `ParticipationRead`, `ResolvedTimeBlock`.
- Produces (exact exports, used by Tasks 7–9):
  - `scheduleRequest.ts`: `type TimingMode = "fit" | "fixed"`; `interface PhaseDraft { roundType: string; matchesPerTeam: number }`; `interface BlockDraft { date: string; startTime: string; endTime: string }` (`""` = blank); `interface ScheduleFormState { schedulerPluginName: string; phases: PhaseDraft[]; timingMode: TimingMode; cycleMinutes: number; blocks: BlockDraft[] }`; `interface ScheduleRequestPayload`; `type BuildResult = { ok: true; payload: ScheduleRequestPayload } | { ok: false; errorKey: string }`; `buildScheduleRequest(state, { sessionId, divisionId, dryRun }): BuildResult`; `availableRoundTypes(all: string[], existing: string[]): string[]`; `defaultPhases(available: string[]): PhaseDraft[]`; `roundTypeOptionsForRow(available: string[], phases: PhaseDraft[], rowIndex: number): string[]`; `projectedFinish(block: Pick<ResolvedTimeBlock, "start_time" | "time_slot_count" | "cycle_time_seconds">): { time: string; dayOffset: number }`; `formatCycleTime(seconds: number): string`; `isCycleTimeTight(cycleMinutes: number, matchDurationSeconds: number): boolean`; `todayInZone(timeZone: string | null, now?: Date): string`.
  - `roundSummary.ts`: `interface RoundSummary { roundType: string; matchCount: number; scoredCount: number; firstTime: string | null; lastTime: string | null }`; `summarizeRounds(matches: MatchRead[], divisionId: number | null): RoundSummary[]`.
  - `readiness.ts`: `type ReadinessKey = "gamePlugin" | "timezone" | "teams" | "fields"`; `interface ReadinessItem { key: ReadinessKey; ok: boolean }`; `checkReadiness(input): ReadinessItem[]`; `countUsableFields(fieldSets, fields, divisionId): number`; `countCheckedInTeams(teams, participants, divisionId): number`.
  - `matchTime.ts`: `formatMatchTime(iso: string, timeZone: string | null, includeDate: boolean, locale: string): string`; `spansMultipleDays(isos: string[], timeZone: string | null): boolean`.
  - Error keys returned by `buildScheduleRequest` (Task 9 adds their strings): `sessions.schedule.form.errors.noScheduler`, `.noPhases`, `.invalidPhase`, `.noBlocks`, `.blockIncomplete`, `.endTimeRequired`, `.cycleRequired`, `.endTimeRequiredExceptLast`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/apps/admin/tests/unit/scheduleRequest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  availableRoundTypes,
  buildScheduleRequest,
  defaultPhases,
  formatCycleTime,
  isCycleTimeTight,
  projectedFinish,
  roundTypeOptionsForRow,
  todayInZone,
  type ScheduleFormState,
} from "../../src/schedule/scheduleRequest";

const BASE: ScheduleFormState = {
  schedulerPluginName: "balanced",
  phases: [
    { roundType: "practice", matchesPerTeam: 1 },
    { roundType: "qualification", matchesPerTeam: 6 },
  ],
  timingMode: "fit",
  cycleMinutes: 7,
  blocks: [{ date: "2026-11-07", startTime: "09:00", endTime: "12:00" }],
};

describe("buildScheduleRequest", () => {
  it("builds a fit-mode request with null cycle times and no division_id for a single division", () => {
    const result = buildScheduleRequest(BASE, { sessionId: 1, divisionId: null, dryRun: true });
    expect(result).toEqual({
      ok: true,
      payload: {
        session_id: 1,
        scheduler_plugin_name: "balanced",
        phases: [
          { round_type: "practice", target_matches_per_team: 1 },
          { round_type: "qualification", target_matches_per_team: 6 },
        ],
        time_blocks: [{ date: "2026-11-07", start_time: "09:00", end_time: "12:00", cycle_time: null }],
        dry_run: true,
      },
    });
  });

  it("includes division_id when a division is selected", () => {
    const result = buildScheduleRequest(BASE, { sessionId: 1, divisionId: 2, dryRun: false });
    expect(result.ok && result.payload.division_id).toBe(2);
    expect(result.ok && result.payload.dry_run).toBe(false);
  });

  it("sorts blocks ascending by date and start time", () => {
    const state: ScheduleFormState = {
      ...BASE,
      blocks: [
        { date: "2026-11-08", startTime: "09:00", endTime: "11:00" },
        { date: "2026-11-07", startTime: "13:00", endTime: "17:00" },
        { date: "2026-11-07", startTime: "09:00", endTime: "12:00" },
      ],
    };
    const result = buildScheduleRequest(state, { sessionId: 1, divisionId: null, dryRun: true });
    expect(result.ok && result.payload.time_blocks.map((b) => `${b.date} ${b.start_time}`)).toEqual([
      "2026-11-07 09:00",
      "2026-11-07 13:00",
      "2026-11-08 09:00",
    ]);
  });

  it("fixed mode sends the cycle time in seconds and allows only the last block to be open-ended", () => {
    const state: ScheduleFormState = {
      ...BASE,
      timingMode: "fixed",
      cycleMinutes: 8,
      blocks: [
        { date: "2026-11-07", startTime: "09:00", endTime: "12:00" },
        { date: "2026-11-07", startTime: "13:00", endTime: "" },
      ],
    };
    const result = buildScheduleRequest(state, { sessionId: 1, divisionId: null, dryRun: true });
    expect(result.ok && result.payload.time_blocks).toEqual([
      { date: "2026-11-07", start_time: "09:00", end_time: "12:00", cycle_time: 480 },
      { date: "2026-11-07", start_time: "13:00", end_time: null, cycle_time: 480 },
    ]);

    const earlyBlank: ScheduleFormState = {
      ...state,
      blocks: [
        { date: "2026-11-07", startTime: "09:00", endTime: "" },
        { date: "2026-11-07", startTime: "13:00", endTime: "15:00" },
      ],
    };
    expect(buildScheduleRequest(earlyBlank, { sessionId: 1, divisionId: null, dryRun: true })).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.endTimeRequiredExceptLast",
    });
  });

  it("reports the first problem as an i18n error key", () => {
    const opts = { sessionId: 1, divisionId: null, dryRun: true };
    expect(buildScheduleRequest({ ...BASE, schedulerPluginName: "" }, opts)).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.noScheduler",
    });
    expect(buildScheduleRequest({ ...BASE, phases: [] }, opts)).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.noPhases",
    });
    expect(
      buildScheduleRequest({ ...BASE, phases: [{ roundType: "practice", matchesPerTeam: 0 }] }, opts)
    ).toEqual({ ok: false, errorKey: "sessions.schedule.form.errors.invalidPhase" });
    expect(buildScheduleRequest({ ...BASE, blocks: [] }, opts)).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.noBlocks",
    });
    expect(
      buildScheduleRequest({ ...BASE, blocks: [{ date: "", startTime: "09:00", endTime: "12:00" }] }, opts)
    ).toEqual({ ok: false, errorKey: "sessions.schedule.form.errors.blockIncomplete" });
    expect(
      buildScheduleRequest({ ...BASE, blocks: [{ date: "2026-11-07", startTime: "09:00", endTime: "" }] }, opts)
    ).toEqual({ ok: false, errorKey: "sessions.schedule.form.errors.endTimeRequired" });
    expect(buildScheduleRequest({ ...BASE, timingMode: "fixed", cycleMinutes: 0 }, opts)).toEqual({
      ok: false,
      errorKey: "sessions.schedule.form.errors.cycleRequired",
    });
  });
});

describe("round-type helpers", () => {
  it("drops round types that already have a schedule", () => {
    expect(availableRoundTypes(["practice", "qualification", "elimination"], ["practice"])).toEqual([
      "qualification",
      "elimination",
    ]);
  });

  it("defaults to practice x1 then qualification x6, each only if available", () => {
    expect(defaultPhases(["practice", "qualification", "elimination"])).toEqual([
      { roundType: "practice", matchesPerTeam: 1 },
      { roundType: "qualification", matchesPerTeam: 6 },
    ]);
    expect(defaultPhases(["qualification", "elimination"])).toEqual([
      { roundType: "qualification", matchesPerTeam: 6 },
    ]);
    expect(defaultPhases(["elimination"])).toEqual([{ roundType: "elimination", matchesPerTeam: 1 }]);
    expect(defaultPhases([])).toEqual([]);
  });

  it("excludes round types chosen in other rows from a row's options", () => {
    const phases = [
      { roundType: "practice", matchesPerTeam: 1 },
      { roundType: "qualification", matchesPerTeam: 6 },
    ];
    expect(roundTypeOptionsForRow(["practice", "qualification", "elimination"], phases, 0)).toEqual([
      "practice",
      "elimination",
    ]);
  });
});

describe("timing helpers", () => {
  it("projects an open-ended block's finish, rolling past midnight", () => {
    expect(projectedFinish({ start_time: "13:00", time_slot_count: 10, cycle_time_seconds: 480 })).toEqual({
      time: "14:20",
      dayOffset: 0,
    });
    expect(projectedFinish({ start_time: "23:00", time_slot_count: 3, cycle_time_seconds: 1800 })).toEqual({
      time: "00:30",
      dayOffset: 1,
    });
  });

  it("formats cycle time as m:ss", () => {
    expect(formatCycleTime(450)).toBe("7:30");
    expect(formatCycleTime(480.4)).toBe("8:00");
  });

  it("flags a cycle time below 1.5x the match duration", () => {
    expect(isCycleTimeTight(2.5, 120)).toBe(true);
    expect(isCycleTimeTight(3, 120)).toBe(false);
    expect(isCycleTimeTight(0, 120)).toBe(false);
  });

  it("gives today's date in a timezone as YYYY-MM-DD", () => {
    const now = new Date("2026-11-08T03:00:00Z");
    expect(todayInZone("America/Los_Angeles", now)).toBe("2026-11-07");
    expect(todayInZone(null, now)).toBe("2026-11-08");
  });
});
```

Create `frontend/apps/admin/tests/unit/roundSummary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { summarizeRounds } from "../../src/schedule/roundSummary";
import type { MatchRead } from "../../src/types";

function match(overrides: Partial<MatchRead>): MatchRead {
  return {
    id: 1,
    session_id: 1,
    division_id: null,
    round_type: "qualification",
    match_number: 1,
    label: "Q1",
    field_id: 100,
    time_slot: 0,
    scheduled_time: "2026-11-07T17:00:00Z",
    status: "scheduled",
    is_finals: false,
    alliances: [],
    ...overrides,
  };
}

describe("summarizeRounds", () => {
  it("groups by round type, counts scored matches, and orders rounds by first match time", () => {
    const matches = [
      match({ id: 1, round_type: "qualification", scheduled_time: "2026-11-07T18:00:00Z", status: "completed" }),
      match({ id: 2, round_type: "qualification", scheduled_time: "2026-11-07T19:00:00Z" }),
      match({ id: 3, round_type: "practice", scheduled_time: "2026-11-07T17:00:00Z" }),
    ];
    expect(summarizeRounds(matches, null)).toEqual([
      {
        roundType: "practice",
        matchCount: 1,
        scoredCount: 0,
        firstTime: "2026-11-07T17:00:00Z",
        lastTime: "2026-11-07T17:00:00Z",
      },
      {
        roundType: "qualification",
        matchCount: 2,
        scoredCount: 1,
        firstTime: "2026-11-07T18:00:00Z",
        lastTime: "2026-11-07T19:00:00Z",
      },
    ]);
  });

  it("excludes finals games and other divisions", () => {
    const matches = [
      match({ id: 1, round_type: "elimination", is_finals: true }),
      match({ id: 2, division_id: 2 }),
      match({ id: 3, division_id: null }),
    ];
    expect(summarizeRounds(matches, null).map((r) => [r.roundType, r.matchCount])).toEqual([
      ["qualification", 1],
    ]);
    expect(summarizeRounds(matches, 2).map((r) => [r.roundType, r.matchCount])).toEqual([
      ["qualification", 1],
    ]);
  });
});
```

Create `frontend/apps/admin/tests/unit/readiness.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { checkReadiness, countCheckedInTeams, countUsableFields } from "../../src/schedule/readiness";

describe("readiness", () => {
  it("passes every item when everything is in place", () => {
    expect(
      checkReadiness({
        gamePluginSelected: true,
        sessionTimezone: "America/Los_Angeles",
        checkedInTeamCount: 4,
        teamsNeeded: 4,
        usableFieldCount: 1,
      })
    ).toEqual([
      { key: "gamePlugin", ok: true },
      { key: "timezone", ok: true },
      { key: "teams", ok: true },
      { key: "fields", ok: true },
    ]);
  });

  it("fails items independently, and treats an unknown team requirement as not ready", () => {
    expect(
      checkReadiness({
        gamePluginSelected: false,
        sessionTimezone: null,
        checkedInTeamCount: 10,
        teamsNeeded: 0,
        usableFieldCount: 0,
      }).map((item) => item.ok)
    ).toEqual([false, false, false, false]);
  });

  it("counts only fields in field sets scoped to the division (null = unassigned)", () => {
    const fieldSets = [
      { id: 1, session_id: 1, name: "Unassigned", division_id: null },
      { id: 2, session_id: 1, name: "Blue", division_id: 2 },
    ];
    const fields = [
      { id: 10, field_set_id: 1, name: "A" },
      { id: 11, field_set_id: 2, name: "B" },
      { id: 12, field_set_id: 2, name: "C" },
    ];
    expect(countUsableFields(fieldSets, fields, null)).toBe(1);
    expect(countUsableFields(fieldSets, fields, 2)).toBe(2);
  });

  it("counts checked-in teams, scoped to a division only when one is given", () => {
    const teams = [
      { id: 1, number: "1", name: "A", division_id: 1 },
      { id: 2, number: "2", name: "B", division_id: 2 },
      { id: 3, number: "3", name: "C", division_id: 2 },
    ];
    const participants = [
      { id: 1, session_id: 1, team_id: 1, checked_in: true },
      { id: 2, session_id: 1, team_id: 2, checked_in: true },
      { id: 3, session_id: 1, team_id: 3, checked_in: false },
    ];
    expect(countCheckedInTeams(teams, participants, null)).toBe(2);
    expect(countCheckedInTeams(teams, participants, 2)).toBe(1);
  });
});
```

Create `frontend/apps/admin/tests/unit/matchTime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatMatchTime, spansMultipleDays } from "../../src/matchTime";

describe("formatMatchTime", () => {
  it("renders in the session's timezone, not the runner's", () => {
    // 2026-11-07 is after the DST change: Los Angeles is UTC-8.
    expect(formatMatchTime("2026-11-07T17:00:00Z", "America/Los_Angeles", false, "en")).toBe("09:00");
  });

  it("includes the date when asked", () => {
    const text = formatMatchTime("2026-11-07T17:00:00Z", "America/Los_Angeles", true, "en");
    expect(text).toContain("Nov 7");
    expect(text).toContain("09:00");
  });

  it("falls back to UTC, labeled, when the session has no timezone", () => {
    expect(formatMatchTime("2026-11-07T17:00:00Z", null, false, "en")).toBe("17:00 UTC");
  });
});

describe("spansMultipleDays", () => {
  it("decides by calendar day in the given timezone", () => {
    const isos = ["2026-11-07T06:30:00Z", "2026-11-07T17:00:00Z"];
    expect(spansMultipleDays(isos, "America/Los_Angeles")).toBe(true);
    expect(spansMultipleDays(isos, null)).toBe(false);
    expect(spansMultipleDays([], "America/Los_Angeles")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/scheduleRequest.test.ts tests/unit/roundSummary.test.ts tests/unit/readiness.test.ts tests/unit/matchTime.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `scheduleRequest.ts`**

Create `frontend/apps/admin/src/schedule/scheduleRequest.ts`:

```ts
import type { ResolvedTimeBlock } from "../types";

export type TimingMode = "fit" | "fixed";

export interface PhaseDraft {
  roundType: string;
  matchesPerTeam: number;
}

/** `endTime: ""` means left blank. */
export interface BlockDraft {
  date: string;
  startTime: string;
  endTime: string;
}

export interface ScheduleFormState {
  schedulerPluginName: string;
  phases: PhaseDraft[];
  timingMode: TimingMode;
  cycleMinutes: number;
  blocks: BlockDraft[];
}

export interface ScheduleRequestPayload {
  session_id: number;
  division_id?: number;
  scheduler_plugin_name: string;
  phases: { round_type: string; target_matches_per_team: number }[];
  time_blocks: { date: string; start_time: string; end_time: string | null; cycle_time: number | null }[];
  dry_run: boolean;
}

export type BuildResult = { ok: true; payload: ScheduleRequestPayload } | { ok: false; errorKey: string };

const ERRORS = "sessions.schedule.form.errors";

function fail(name: string): BuildResult {
  return { ok: false, errorKey: `${ERRORS}.${name}` };
}

/**
 * Turns the form into a `POST /api/schedule` body. "fit" sends every block
 * with an end time and `cycle_time: null` (the server computes cycle time);
 * "fixed" sends one cycle time on every block and lets only the last block
 * leave its end time blank (open-ended). The backend forbids mixing those
 * two kinds of block, which is why the mode is form-wide.
 */
export function buildScheduleRequest(
  state: ScheduleFormState,
  { sessionId, divisionId, dryRun }: { sessionId: number; divisionId: number | null; dryRun: boolean }
): BuildResult {
  if (!state.schedulerPluginName) return fail("noScheduler");
  if (state.phases.length === 0) return fail("noPhases");
  if (state.phases.some((p) => !p.roundType || !Number.isInteger(p.matchesPerTeam) || p.matchesPerTeam < 1)) {
    return fail("invalidPhase");
  }
  if (state.blocks.length === 0) return fail("noBlocks");
  if (state.blocks.some((b) => !b.date || !b.startTime)) return fail("blockIncomplete");

  const sorted = [...state.blocks].sort((a, b) =>
    `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`)
  );
  let cycleSeconds: number | null = null;
  if (state.timingMode === "fit") {
    if (sorted.some((b) => !b.endTime)) return fail("endTimeRequired");
  } else {
    if (!(state.cycleMinutes > 0)) return fail("cycleRequired");
    if (sorted.slice(0, -1).some((b) => !b.endTime)) return fail("endTimeRequiredExceptLast");
    cycleSeconds = Math.round(state.cycleMinutes * 60);
  }

  const payload: ScheduleRequestPayload = {
    session_id: sessionId,
    scheduler_plugin_name: state.schedulerPluginName,
    phases: state.phases.map((p) => ({ round_type: p.roundType, target_matches_per_team: p.matchesPerTeam })),
    time_blocks: sorted.map((b) => ({
      date: b.date,
      start_time: b.startTime,
      end_time: b.endTime || null,
      cycle_time: cycleSeconds,
    })),
    dry_run: dryRun,
  };
  if (divisionId !== null) payload.division_id = divisionId;
  return { ok: true, payload };
}

export function availableRoundTypes(all: string[], existing: string[]): string[] {
  return all.filter((roundType) => !existing.includes(roundType));
}

export function defaultPhases(available: string[]): PhaseDraft[] {
  const phases: PhaseDraft[] = [];
  if (available.includes("practice")) phases.push({ roundType: "practice", matchesPerTeam: 1 });
  if (available.includes("qualification")) phases.push({ roundType: "qualification", matchesPerTeam: 6 });
  if (phases.length === 0 && available.length > 0) phases.push({ roundType: available[0], matchesPerTeam: 1 });
  return phases;
}

export function roundTypeOptionsForRow(available: string[], phases: PhaseDraft[], rowIndex: number): string[] {
  const takenElsewhere = phases.filter((_, index) => index !== rowIndex).map((p) => p.roundType);
  return available.filter((roundType) => !takenElsewhere.includes(roundType));
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Wall-clock finish (`start + slots x cycle`) of a block, with how many days it rolled past midnight. */
export function projectedFinish(
  block: Pick<ResolvedTimeBlock, "start_time" | "time_slot_count" | "cycle_time_seconds">
): { time: string; dayOffset: number } {
  const [hours, minutes] = block.start_time.split(":").map(Number);
  const total = hours * 60 + minutes + Math.round((block.time_slot_count * block.cycle_time_seconds) / 60);
  const minuteOfDay = total % 1440;
  return {
    time: `${pad(Math.floor(minuteOfDay / 60))}:${pad(minuteOfDay % 60)}`,
    dayOffset: Math.floor(total / 1440),
  };
}

export function formatCycleTime(seconds: number): string {
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

/** Mirrors the server's default `warn_below_multiplier` of 1.5. */
export function isCycleTimeTight(cycleMinutes: number, matchDurationSeconds: number): boolean {
  return cycleMinutes > 0 && cycleMinutes * 60 < matchDurationSeconds * 1.5;
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

- [ ] **Step 4: Implement `roundSummary.ts`**

Create `frontend/apps/admin/src/schedule/roundSummary.ts`:

```ts
import type { MatchRead } from "../types";

export interface RoundSummary {
  roundType: string;
  matchCount: number;
  scoredCount: number;
  firstTime: string | null;
  lastTime: string | null;
}

/**
 * Schedule-generated rounds for one division (`null` = the no-division
 * scope a single-division event schedules into). Finals games are left
 * out: they share the plugin's "elimination" round type but are never
 * cleared by DELETE /api/schedule.
 */
export function summarizeRounds(matches: MatchRead[], divisionId: number | null): RoundSummary[] {
  const byRound = new Map<string, RoundSummary>();
  for (const match of matches) {
    if (match.is_finals || match.division_id !== divisionId) continue;
    let summary = byRound.get(match.round_type);
    if (!summary) {
      summary = { roundType: match.round_type, matchCount: 0, scoredCount: 0, firstTime: null, lastTime: null };
      byRound.set(match.round_type, summary);
    }
    summary.matchCount += 1;
    if (match.status === "completed") summary.scoredCount += 1;
    const time = match.scheduled_time;
    if (time) {
      if (summary.firstTime === null || time < summary.firstTime) summary.firstTime = time;
      if (summary.lastTime === null || time > summary.lastTime) summary.lastTime = time;
    }
  }
  return [...byRound.values()].sort((a, b) => (a.firstTime ?? "").localeCompare(b.firstTime ?? ""));
}
```

- [ ] **Step 5: Implement `readiness.ts`**

Create `frontend/apps/admin/src/schedule/readiness.ts`:

```ts
import type { FieldRead, FieldSetRead, ParticipationRead, TeamSummary } from "../types";

export type ReadinessKey = "gamePlugin" | "timezone" | "teams" | "fields";

export interface ReadinessItem {
  key: ReadinessKey;
  ok: boolean;
}

export function checkReadiness(input: {
  gamePluginSelected: boolean;
  sessionTimezone: string | null;
  checkedInTeamCount: number;
  teamsNeeded: number;
  usableFieldCount: number;
}): ReadinessItem[] {
  return [
    { key: "gamePlugin", ok: input.gamePluginSelected },
    { key: "timezone", ok: input.sessionTimezone !== null },
    { key: "teams", ok: input.teamsNeeded > 0 && input.checkedInTeamCount >= input.teamsNeeded },
    { key: "fields", ok: input.usableFieldCount > 0 },
  ];
}

/** Fields the generator will use for this division: those in sets assigned to it (`null` = unassigned sets). */
export function countUsableFields(
  fieldSets: FieldSetRead[],
  fields: FieldRead[],
  divisionId: number | null
): number {
  const setIds = new Set(fieldSets.filter((fs) => fs.division_id === divisionId).map((fs) => fs.id));
  return fields.filter((field) => setIds.has(field.field_set_id)).length;
}

/** `divisionId: null` means a single-division event, where every checked-in team counts. */
export function countCheckedInTeams(
  teams: TeamSummary[],
  participants: ParticipationRead[],
  divisionId: number | null
): number {
  const checkedIn = new Set(participants.filter((p) => p.checked_in).map((p) => p.team_id));
  return teams.filter(
    (team) => checkedIn.has(team.id) && (divisionId === null || team.division_id === divisionId)
  ).length;
}
```

- [ ] **Step 6: Implement `matchTime.ts`**

Create `frontend/apps/admin/src/matchTime.ts`:

```ts
/** A match's time in the session's own timezone (never the browser's); UTC, labeled, when the session has none. */
export function formatMatchTime(
  iso: string,
  timeZone: string | null,
  includeDate: boolean,
  locale: string
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: timeZone ?? "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  };
  if (includeDate) {
    options.weekday = "short";
    options.month = "short";
    options.day = "numeric";
  }
  const text = new Intl.DateTimeFormat(locale, options).format(new Date(iso));
  return timeZone ? text : `${text} UTC`;
}

export function spansMultipleDays(isos: string[], timeZone: string | null): boolean {
  const dayOf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return new Set(isos.map((iso) => dayOf.format(new Date(iso)))).size > 1;
}
```

- [ ] **Step 7: Run the tests and type-check**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/scheduleRequest.test.ts tests/unit/roundSummary.test.ts tests/unit/readiness.test.ts tests/unit/matchTime.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc exits 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/admin/src/schedule frontend/apps/admin/src/matchTime.ts frontend/apps/admin/tests/unit/scheduleRequest.test.ts frontend/apps/admin/tests/unit/roundSummary.test.ts frontend/apps/admin/tests/unit/readiness.test.ts frontend/apps/admin/tests/unit/matchTime.test.ts
git commit -m "Add pure helpers for schedule requests, round summaries, readiness, and match times"
```

---

### Task 7: Matches tab and the shared live matches query

**Files:**
- Create: `frontend/apps/admin/src/useSessionMatches.ts`
- Create: `frontend/apps/admin/src/routes/SessionMatchesRoute.tsx`
- Modify: `frontend/apps/admin/src/routes/SessionDetailLayout.tsx` (tab link)
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/SessionMatchesRoute.test.tsx`, `frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx`

**Interfaces:**
- Consumes: Task 3's `is_finals`; Task 4's types; Task 5's `["fields", sessionId]` key; Task 6's `formatMatchTime`, `spansMultipleDays`; `useRealtimeChannel({ path, onEvent })` and `RealtimeEvent` (`{ event: string; data: unknown }`) from `@tournament-admin/shared`.
- Produces:
  - `useSessionMatches(sessionId: number)` → the TanStack `useQuery` result for `["matches", sessionId]` (`GET /api/matches?session_id=`), refetched on `new_match_created`/`score_saved` from `/ws/session/{sessionId}`. Reused by Task 8.
  - Route `/sessions/:sessionId/matches`.

- [ ] **Step 1: Add the i18n strings**

In `en/admin.json`, inside `"sessions"`, after `"fieldsTab"`:

```json
    "matchesTab": "Matches",
```

and a new `"matches"` object inside `"sessions"`:

```json
    "matches": {
      "columnMatch": "Match",
      "columnTime": "Time",
      "columnField": "Field",
      "columnStatus": "Status",
      "status": {
        "scheduled": "Scheduled",
        "completed": "Completed"
      },
      "noTime": "—",
      "divisionFilterLabel": "Division",
      "allDivisions": "All divisions",
      "roundFilterLabel": "Round",
      "allRounds": "All rounds",
      "teamSearchLabel": "Search by team number or name",
      "empty": "No matches yet.",
      "goToSchedule": "Go to Schedule"
    },
```

In `zh/admin.json`:

```json
    "matchesTab": "比赛",
```

```json
    "matches": {
      "columnMatch": "比赛",
      "columnTime": "时间",
      "columnField": "场地",
      "columnStatus": "状态",
      "status": {
        "scheduled": "已排定",
        "completed": "已完成"
      },
      "noTime": "—",
      "divisionFilterLabel": "组别",
      "allDivisions": "所有组别",
      "roundFilterLabel": "轮次",
      "allRounds": "所有轮次",
      "teamSearchLabel": "按队伍编号或名称搜索",
      "empty": "还没有比赛。",
      "goToSchedule": "前往赛程"
    },
```

- [ ] **Step 2: Write the failing tests**

Create `frontend/apps/admin/tests/unit/SessionMatchesRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionMatchesRoute } from "../../src/routes/SessionMatchesRoute";
import type { MatchRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: "2026-11-07",
  timezone: "America/Los_Angeles",
};
const TEAMS = [
  { id: 1, number: "101", name: "Alpha", division_id: 1 },
  { id: 2, number: "202", name: "Bravo", division_id: 1 },
  { id: 3, number: "303", name: "Charlie", division_id: 1 },
  { id: 4, number: "404", name: "Delta", division_id: 1 },
  { id: 5, number: "505", name: "Echo", division_id: 1 },
  { id: 6, number: "606", name: "Foxtrot", division_id: 1 },
];
const MATCHES: MatchRead[] = [
  {
    id: 2,
    session_id: 1,
    division_id: null,
    round_type: "qualification",
    match_number: 1,
    label: "Q1",
    field_id: 100,
    time_slot: 1,
    scheduled_time: "2026-11-07T17:10:00Z",
    status: "completed",
    is_finals: false,
    alliances: [
      { id: 3, station: "red", team_ids: [1, 2] },
      { id: 4, station: "blue", team_ids: [5, 6] },
    ],
  },
  {
    id: 1,
    session_id: 1,
    division_id: null,
    round_type: "practice",
    match_number: 1,
    label: "P1",
    field_id: 100,
    time_slot: 0,
    scheduled_time: "2026-11-07T17:00:00Z",
    status: "scheduled",
    is_finals: false,
    alliances: [
      { id: 1, station: "red", team_ids: [1, 2] },
      { id: 2, station: "blue", team_ids: [3, 4] },
    ],
  },
];

function stub(matches: MatchRead[]) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/matches?session_id=1") return matches as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path === "/api/fields?session_id=1") return [{ id: 100, field_set_id: 10, name: "Field A" }] as never;
    if (path === "/api/divisions") return [{ id: 1, event_id: 1, name: "Division 1", target_team_count: null }] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderMatches() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionMatchesRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionMatchesRoute", () => {
  it("lists matches in time order with session-timezone times, field names, and team numbers", async () => {
    stub(MATCHES);
    renderMatches();

    const p1 = await screen.findByRole("gridcell", { name: "P1" });
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toContainElement(p1);
    expect(screen.getByRole("gridcell", { name: "09:00" })).toBeInTheDocument();
    expect(screen.getAllByRole("gridcell", { name: "Field A" })).toHaveLength(2);
    expect(screen.getByRole("gridcell", { name: "303, 404" })).toBeInTheDocument();
  });

  it("filters by round type and by team search", async () => {
    stub(MATCHES);
    renderMatches();
    await screen.findByRole("gridcell", { name: "P1" });

    fireEvent.change(screen.getByLabelText("Round"), { target: { value: "qualification" } });
    expect(screen.queryByRole("gridcell", { name: "P1" })).not.toBeInTheDocument();
    expect(screen.getByRole("gridcell", { name: "Q1" })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Round"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Search by team number or name"), { target: { value: "charlie" } });
    expect(screen.getByRole("gridcell", { name: "P1" })).toBeInTheDocument();
    expect(screen.queryByRole("gridcell", { name: "Q1" })).not.toBeInTheDocument();
  });

  it("shows an empty state linking to the Schedule tab", async () => {
    stub([]);
    renderMatches();

    expect(await screen.findByText("No matches yet.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to Schedule" })).toHaveAttribute(
      "href",
      "/sessions/1/schedule"
    );
  });

  it("refetches matches when the session channel reports a new match", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    stub(MATCHES);
    renderMatches();
    await screen.findByRole("gridcell", { name: "P1" });

    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/session/1");
    const matchFetches = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/matches?session_id=1").length;
    const before = matchFetches();
    act(() => onEvent?.({ event: "new_match_created", data: {} } as RealtimeEvent));
    await waitFor(() => expect(matchFetches()).toBeGreaterThan(before));
  });
});
```

In `tests/unit/SessionDetailLayout.test.tsx`'s first test, add:

```tsx
    expect(screen.getByRole("link", { name: "Matches" })).toBeInTheDocument();
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionMatchesRoute.test.tsx tests/unit/SessionDetailLayout.test.tsx`
Expected: FAIL (module not found; no Matches link).

- [ ] **Step 4: Create the shared hook**

Create `frontend/apps/admin/src/useSessionMatches.ts`:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import type { MatchRead } from "./types";

/**
 * The session's matches, kept live off the admin-only session channel.
 * DELETE /api/schedule broadcasts nothing, so a client that clears a round
 * must invalidate ["matches", sessionId] itself.
 */
export function useSessionMatches(sessionId: number) {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: `/ws/session/${sessionId}`,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "new_match_created" || realtimeEvent.event === "score_saved") {
        queryClient.invalidateQueries({ queryKey: ["matches", sessionId] });
      }
    },
  });
  return useQuery({
    queryKey: ["matches", sessionId],
    queryFn: () => apiRequest<MatchRead[]>(`/api/matches?session_id=${sessionId}`),
  });
}
```

- [ ] **Step 5: Create the Matches tab**

Create `frontend/apps/admin/src/routes/SessionMatchesRoute.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useOutletContext } from "react-router-dom";
import { DataGrid, type Column } from "react-data-grid";
import "react-data-grid/lib/styles.css";
import { apiRequest } from "@tournament-admin/shared";
import { formatMatchTime, spansMultipleDays } from "../matchTime";
import { useSessionMatches } from "../useSessionMatches";
import type { Division, FieldRead, SessionRead, TeamSummary } from "../types";

interface MatchGridRow {
  id: number;
  label: string;
  time: string;
  field: string;
  status: string;
  alliances: Record<string, string>;
}

const NO_TIME_SORT_KEY = "￿";

export function SessionMatchesRoute() {
  const { t, i18n } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const [divisionFilter, setDivisionFilter] = useState("");
  const [roundFilter, setRoundFilter] = useState("");
  const [teamQuery, setTeamQuery] = useState("");

  const { data: matches, isLoading } = useSessionMatches(session.id);
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const { data: fields } = useQuery({
    queryKey: ["fields", session.id],
    queryFn: () => apiRequest<FieldRead[]>(`/api/fields?session_id=${session.id}`),
  });
  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });

  const allMatches = useMemo(() => matches ?? [], [matches]);
  const teamById = useMemo(() => new Map((teams ?? []).map((team) => [team.id, team])), [teams]);
  const fieldNameById = useMemo(
    () => new Map((fields ?? []).map((field) => [field.id, field.name])),
    [fields]
  );
  const stations = useMemo(() => {
    const seen: string[] = [];
    for (const match of allMatches) {
      for (const alliance of match.alliances) {
        if (!seen.includes(alliance.station)) seen.push(alliance.station);
      }
    }
    return seen;
  }, [allMatches]);
  const roundTypes = useMemo(() => [...new Set(allMatches.map((m) => m.round_type))], [allMatches]);
  const includeDate = useMemo(
    () =>
      spansMultipleDays(
        allMatches.flatMap((m) => (m.scheduled_time ? [m.scheduled_time] : [])),
        session.timezone
      ),
    [allMatches, session.timezone]
  );

  const rows = useMemo(() => {
    const query = teamQuery.trim().toLowerCase();
    const teamMatches = (teamId: number) => {
      const team = teamById.get(teamId);
      return team !== undefined && (team.number.toLowerCase().includes(query) || team.name.toLowerCase().includes(query));
    };
    return allMatches
      .filter((m) => divisionFilter === "" || String(m.division_id) === divisionFilter)
      .filter((m) => roundFilter === "" || m.round_type === roundFilter)
      .filter((m) => !query || m.alliances.some((a) => a.team_ids.some(teamMatches)))
      .sort((a, b) => {
        const aTime = a.scheduled_time ?? NO_TIME_SORT_KEY;
        const bTime = b.scheduled_time ?? NO_TIME_SORT_KEY;
        if (aTime !== bTime) return aTime.localeCompare(bTime);
        return a.label.localeCompare(b.label, undefined, { numeric: true });
      })
      .map(
        (m): MatchGridRow => ({
          id: m.id,
          label: m.label,
          time: m.scheduled_time
            ? formatMatchTime(m.scheduled_time, session.timezone, includeDate, i18n.language)
            : t("sessions.matches.noTime"),
          field: m.field_id !== null ? (fieldNameById.get(m.field_id) ?? "") : "",
          status: m.status,
          alliances: Object.fromEntries(
            m.alliances.map((a) => [
              a.station,
              a.team_ids.map((id) => teamById.get(id)?.number ?? String(id)).join(", "),
            ])
          ),
        })
      );
  }, [allMatches, divisionFilter, roundFilter, teamQuery, teamById, fieldNameById, session.timezone, includeDate, i18n.language, t]);

  const columns: Column<MatchGridRow>[] = useMemo(
    () => [
      { key: "label", name: t("sessions.matches.columnMatch") },
      { key: "time", name: t("sessions.matches.columnTime") },
      { key: "field", name: t("sessions.matches.columnField") },
      ...stations.map(
        (station): Column<MatchGridRow> => ({
          key: `station:${station}`,
          name: station,
          renderCell: ({ row }) => row.alliances[station] ?? "",
        })
      ),
      {
        key: "status",
        name: t("sessions.matches.columnStatus"),
        renderCell: ({ row }) => t(`sessions.matches.status.${row.status}`, { defaultValue: row.status }),
      },
    ],
    [t, stations]
  );

  if (isLoading) {
    return <p>{t("sessions.loading")}</p>;
  }

  if (allMatches.length === 0) {
    return (
      <div className="panel">
        <p>{t("sessions.matches.empty")}</p>
        <Link to={`/sessions/${session.id}/schedule`}>{t("sessions.matches.goToSchedule")}</Link>
      </div>
    );
  }

  const multiDivision = (divisions?.length ?? 0) > 1;

  return (
    <div>
      <div className="form-actions">
        {multiDivision && (
          <label className="field">
            <span className="field__label">{t("sessions.matches.divisionFilterLabel")}</span>
            <select className="select" value={divisionFilter} onChange={(e) => setDivisionFilter(e.target.value)}>
              <option value="">{t("sessions.matches.allDivisions")}</option>
              {(divisions ?? []).map((division) => (
                <option key={division.id} value={division.id}>
                  {division.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span className="field__label">{t("sessions.matches.roundFilterLabel")}</span>
          <select className="select" value={roundFilter} onChange={(e) => setRoundFilter(e.target.value)}>
            <option value="">{t("sessions.matches.allRounds")}</option>
            {roundTypes.map((roundType) => (
              <option key={roundType} value={roundType}>
                {roundType}
              </option>
            ))}
          </select>
        </label>
        <input
          className="input"
          aria-label={t("sessions.matches.teamSearchLabel")}
          placeholder={t("sessions.matches.teamSearchLabel")}
          value={teamQuery}
          onChange={(e) => setTeamQuery(e.target.value)}
        />
      </div>
      <DataGrid columns={columns} rows={rows} rowKeyGetter={(row) => row.id} />
    </div>
  );
}
```

- [ ] **Step 6: Wire the tab and route**

In `SessionDetailLayout.tsx`, add after the Fields `NavLink`:

```tsx
        <NavLink to={`/sessions/${session.id}/matches`} className={tabLinkClassName}>
          {t("sessions.matchesTab")}
        </NavLink>
```

In `router.tsx`, import `SessionMatchesRoute` and add to the `sessions/:sessionId` children:

```tsx
          { path: "matches", element: <SessionMatchesRoute /> },
```

- [ ] **Step 7: Run the tests and type-check**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionMatchesRoute.test.tsx tests/unit/SessionDetailLayout.test.tsx && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc exits 0.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/admin/src/useSessionMatches.ts frontend/apps/admin/src/routes/SessionMatchesRoute.tsx frontend/apps/admin/src/routes/SessionDetailLayout.tsx frontend/apps/admin/src/router.tsx frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/unit/SessionMatchesRoute.test.tsx frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx
git commit -m "Add the session Matches tab with live updates"
```

---

### Task 8: Schedule tab — division scope, readiness, current rounds, Clear

**Files:**
- Create: `frontend/apps/admin/src/schedule/ReadinessChecklist.tsx`
- Create: `frontend/apps/admin/src/schedule/CurrentRounds.tsx`
- Create: `frontend/apps/admin/src/routes/SessionScheduleRoute.tsx`
- Modify: `frontend/apps/admin/src/routes/SessionDetailLayout.tsx` (tab link)
- Modify: `frontend/apps/admin/src/router.tsx`
- Modify: `frontend/apps/admin/src/styles/components.css`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/SessionScheduleRoute.test.tsx`, `frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx`

**Interfaces:**
- Consumes: Task 5's `ConfirmDialog` and `["fieldSets"|"fields", sessionId]` keys; Task 6's `checkReadiness`, `countCheckedInTeams`, `countUsableFields`, `summarizeRounds`, `RoundSummary`, `ReadinessItem`, `formatMatchTime`; Task 7's `useSessionMatches`; `GET /api/event/match-format` (query key `["matchFormat"]`, enabled only when `event.game_plugin_name` is set); `GET /api/sessions/{id}/participants` (key `["participants", sessionId]`, same as the Check-In tab); `DELETE /api/schedule`.
- Produces (used by Task 9): `SessionScheduleRoute` computing, in its body, `divisionId: number | null`, `rounds: RoundSummary[]`, `matchFormat: MatchFormat | undefined`, and `ready: boolean`. Route `/sessions/:sessionId/schedule`.

- [ ] **Step 1: Add the i18n strings**

In `en/admin.json`, inside `"sessions"`, after `"matchesTab"`:

```json
    "scheduleTab": "Schedule",
```

and a new `"schedule"` object inside `"sessions"`:

```json
    "schedule": {
      "divisionLabel": "Division",
      "readiness": {
        "heading": "Ready to schedule?",
        "ok": "Ready",
        "missing": "Missing",
        "gamePlugin": "A game plugin is selected",
        "gamePluginFix": "Select a game plugin",
        "timezone": "The session has a timezone",
        "timezoneFix": "Set the timezone",
        "teams": "Enough teams are checked in to fill a match",
        "teamsFix": "Check teams in",
        "fields": "This division has at least one field",
        "fieldsFix": "Add fields"
      },
      "rounds": {
        "heading": "Current rounds",
        "none": "No rounds have been generated yet.",
        "columnRound": "Round",
        "columnMatches": "Matches",
        "columnScored": "Scored",
        "columnFirst": "First match",
        "columnLast": "Last match",
        "noTime": "—",
        "clearAction": "Clear",
        "clearAriaLabel": "Clear {{round}}",
        "clearAllAction": "Clear all rounds",
        "clearHeading": "Clear {{round}}?",
        "clearBody": "This deletes the round's {{count}} matches.",
        "clearAllHeading": "Clear all rounds?",
        "clearAllBody": "This deletes every generated round in this division. Rounds generated together have to be regenerated together.",
        "scoredWarning": "{{count}} of them have scores, which are deleted too.",
        "clearAllPhrase": "clear all",
        "typeToConfirm": "Type \"{{phrase}}\" to confirm",
        "confirmClear": "Clear"
      }
    },
```

In `zh/admin.json`:

```json
    "scheduleTab": "赛程",
```

```json
    "schedule": {
      "divisionLabel": "组别",
      "readiness": {
        "heading": "可以排赛程了吗？",
        "ok": "就绪",
        "missing": "缺少",
        "gamePlugin": "已选择比赛插件",
        "gamePluginFix": "选择比赛插件",
        "timezone": "场次已设置时区",
        "timezoneFix": "设置时区",
        "teams": "已签到的队伍足够组成一场比赛",
        "teamsFix": "签到队伍",
        "fields": "此组别有至少一个场地",
        "fieldsFix": "添加场地"
      },
      "rounds": {
        "heading": "当前轮次",
        "none": "尚未生成任何轮次。",
        "columnRound": "轮次",
        "columnMatches": "比赛数",
        "columnScored": "已计分",
        "columnFirst": "第一场",
        "columnLast": "最后一场",
        "noTime": "—",
        "clearAction": "清除",
        "clearAriaLabel": "清除 {{round}}",
        "clearAllAction": "清除所有轮次",
        "clearHeading": "清除 {{round}}？",
        "clearBody": "将删除该轮次的 {{count}} 场比赛。",
        "clearAllHeading": "清除所有轮次？",
        "clearAllBody": "将删除此组别所有已生成的轮次。一起生成的轮次需要一起重新生成。",
        "scoredWarning": "其中 {{count}} 场已有分数，分数也会被删除。",
        "clearAllPhrase": "全部清除",
        "typeToConfirm": "输入“{{phrase}}”以确认",
        "confirmClear": "清除"
      }
    },
```

- [ ] **Step 2: Write the failing tests**

Create `frontend/apps/admin/tests/unit/SessionScheduleRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionScheduleRoute } from "../../src/routes/SessionScheduleRoute";
import type { Division, FieldRead, FieldSetRead, MatchRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: "2026-11-07",
  timezone: "America/Los_Angeles",
};
const ONE_DIVISION: Division[] = [{ id: 1, event_id: 1, name: "Division 1", target_team_count: null }];
const TWO_DIVISIONS: Division[] = [
  ...ONE_DIVISION,
  { id: 2, event_id: 1, name: "Blue", target_team_count: null },
];
const EVENT = {
  id: 1,
  name: "Demo Event",
  active_session_id: 1,
  game_plugin_name: "example-game",
  created_at: "2026-09-01T00:00:00Z",
};
const MATCH_FORMAT = {
  round_types: ["practice", "qualification", "elimination"],
  teams_per_alliance: 2,
  alliance_count: 2,
  match_duration_seconds: 120,
};
const TEAMS = [1, 2, 3, 4].map((id) => ({ id, number: `${id}0${id}`, name: `Team ${id}`, division_id: 1 }));
const PARTICIPANTS = TEAMS.map((team) => ({ id: team.id, session_id: 1, team_id: team.id, checked_in: true }));
const MAIN_SET: FieldSetRead = { id: 10, session_id: 1, name: "Main Fields", division_id: null };
const FIELD_A: FieldRead = { id: 100, field_set_id: 10, name: "Field A" };
const SCHEDULERS = [
  { name: "simple_random", version: "1.0.0", display_name: "Simple random" },
  { name: "balanced", version: "1.0.0", display_name: "Balanced" },
];

function scheduleMatch(overrides: Partial<MatchRead>): MatchRead {
  return {
    id: 1,
    session_id: 1,
    division_id: null,
    round_type: "practice",
    match_number: 1,
    label: "P1",
    field_id: 100,
    time_slot: 0,
    scheduled_time: "2026-11-07T17:00:00Z",
    status: "scheduled",
    is_finals: false,
    alliances: [],
    ...overrides,
  };
}

interface StubOptions {
  divisions?: Division[];
  /** A function is re-read on every fetch, for tests where the server's matches change mid-test. */
  matches?: MatchRead[] | (() => MatchRead[]);
  fieldSets?: FieldSetRead[];
  fields?: FieldRead[];
  onWrite?: (path: string, options: { method?: string; body?: unknown }) => unknown;
}

function stub({
  divisions = ONE_DIVISION,
  matches = [],
  fieldSets = [MAIN_SET],
  fields = [FIELD_A],
  onWrite = () => undefined,
}: StubOptions = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = (options ?? {}) as { method?: string; body?: unknown };
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
    if (path === "/api/field-sets?session_id=1") return fieldSets as never;
    if (path === "/api/fields?session_id=1") return fields as never;
    if (path === "/api/matches?session_id=1") {
      return (typeof matches === "function" ? matches() : matches) as never;
    }
    if (path === "/api/plugins/schedulers") return SCHEDULERS as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderSchedule() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionScheduleRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

function deleteCalls(): string[] {
  return vi
    .mocked(apiRequest)
    .mock.calls.filter(([, options]) => (options as { method?: string } | undefined)?.method === "DELETE")
    .map(([path]) => path as string);
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionScheduleRoute — readiness and rounds", () => {
  it("shows every readiness item as ready and no rounds when nothing is scheduled", async () => {
    stub();
    renderSchedule();

    const checklist = await screen.findByRole("region", { name: "Ready to schedule?" });
    await waitFor(() => expect(within(checklist).getAllByText("Ready")).toHaveLength(4));
    expect(screen.getByText("No rounds have been generated yet.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Division")).not.toBeInTheDocument();
  });

  it("flags missing fields with a link to the Fields tab", async () => {
    stub({ fields: [] });
    renderSchedule();

    const link = await screen.findByRole("link", { name: "Add fields" });
    expect(link).toHaveAttribute("href", "/sessions/1/fields");
  });

  it("lists rounds for the scope with match and scored counts, leaving out finals", async () => {
    stub({
      matches: [
        scheduleMatch({ id: 1, status: "completed" }),
        scheduleMatch({ id: 2, label: "P2", scheduled_time: "2026-11-07T17:10:00Z" }),
        scheduleMatch({ id: 3, round_type: "elimination", label: "F1", is_finals: true }),
      ],
    });
    renderSchedule();

    const row = await screen.findByRole("row", { name: /practice/ });
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText("1")).toBeInTheDocument();
    expect(screen.queryByRole("row", { name: /elimination/ })).not.toBeInTheDocument();
  });

  it("requires typing the round name to clear a round with scored matches", async () => {
    stub({ matches: [scheduleMatch({ status: "completed" })] });
    renderSchedule();

    fireEvent.click(await screen.findByRole("button", { name: "Clear practice" }));
    const dialog = screen.getByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Clear" });
    expect(confirm).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText('Type "practice" to confirm'), {
      target: { value: "practice" },
    });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(deleteCalls()).toEqual(["/api/schedule?session_id=1&round_type=practice"]));
  });

  it("Clear all rounds issues one DELETE per round", async () => {
    stub({
      matches: [
        scheduleMatch({ id: 1 }),
        scheduleMatch({ id: 2, round_type: "qualification", label: "Q1", scheduled_time: "2026-11-07T18:00:00Z" }),
      ],
    });
    renderSchedule();

    fireEvent.click(await screen.findByRole("button", { name: "Clear all rounds" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(deleteCalls()).toEqual([
        "/api/schedule?session_id=1&round_type=practice",
        "/api/schedule?session_id=1&round_type=qualification",
      ])
    );
  });

  it("in a multi-division event, scopes rounds and the clear request to the selected division", async () => {
    stub({
      divisions: TWO_DIVISIONS,
      fieldSets: [{ ...MAIN_SET, division_id: 2 }],
      matches: [scheduleMatch({ division_id: 2, round_type: "qualification", label: "Q1" })],
    });
    renderSchedule();

    expect(await screen.findByText("No rounds have been generated yet.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Division"), { target: { value: "2" } });
    fireEvent.click(await screen.findByRole("button", { name: "Clear qualification" }));
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Clear" }));

    await waitFor(() =>
      expect(deleteCalls()).toEqual(["/api/schedule?session_id=1&round_type=qualification&division_id=2"])
    );
  });
});
```

In `tests/unit/SessionDetailLayout.test.tsx`'s first test, add:

```tsx
    expect(screen.getByRole("link", { name: "Schedule" })).toBeInTheDocument();
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionScheduleRoute.test.tsx tests/unit/SessionDetailLayout.test.tsx`
Expected: FAIL (module not found; no Schedule link).

- [ ] **Step 4: Create `ReadinessChecklist`**

Create `frontend/apps/admin/src/schedule/ReadinessChecklist.tsx`:

```tsx
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { ReadinessItem, ReadinessKey } from "./readiness";

function fixLink(key: ReadinessKey, sessionId: number): string {
  switch (key) {
    case "gamePlugin":
      return "/events/setup";
    case "timezone":
      return "/sessions";
    case "teams":
      return `/sessions/${sessionId}/checkin`;
    case "fields":
      return `/sessions/${sessionId}/fields`;
  }
}

export function ReadinessChecklist({ items, sessionId }: { items: ReadinessItem[]; sessionId: number }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("sessions.schedule.readiness.heading")}</h2>
      <ul className="list-plain">
        {items.map((item) => (
          <li key={item.key} className="list-row readiness-item">
            <span className={item.ok ? "badge badge-success" : "badge badge-warning"}>
              {item.ok ? t("sessions.schedule.readiness.ok") : t("sessions.schedule.readiness.missing")}
            </span>
            <span>{t(`sessions.schedule.readiness.${item.key}`)}</span>
            {!item.ok && (
              <Link to={fixLink(item.key, sessionId)}>{t(`sessions.schedule.readiness.${item.key}Fix`)}</Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
```

- [ ] **Step 5: Create `CurrentRounds`**

Create `frontend/apps/admin/src/schedule/CurrentRounds.tsx`:

```tsx
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import { formatMatchTime } from "../matchTime";
import type { RoundSummary } from "./roundSummary";

interface CurrentRoundsProps {
  sessionId: number;
  divisionId: number | null;
  sessionTimezone: string | null;
  rounds: RoundSummary[];
}

export function CurrentRounds({ sessionId, divisionId, sessionTimezone, rounds }: CurrentRoundsProps) {
  const { t, i18n } = useTranslation();
  const headingId = useId();
  const queryClient = useQueryClient();
  const [targets, setTargets] = useState<RoundSummary[] | null>(null);

  const clearMutation = useMutation({
    // Sequential, one DELETE per round: the endpoint clears one round_type
    // at a time, and stopping at the first failure leaves the rest intact.
    mutationFn: async (toClear: RoundSummary[]) => {
      for (const round of toClear) {
        const params = new URLSearchParams({ session_id: String(sessionId), round_type: round.roundType });
        if (divisionId !== null) params.set("division_id", String(divisionId));
        await apiRequest(`/api/schedule?${params.toString()}`, { method: "DELETE" });
      }
    },
    onSuccess: () => setTargets(null),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["matches", sessionId] });
    },
  });

  const formatTime = (iso: string | null) =>
    iso ? formatMatchTime(iso, sessionTimezone, true, i18n.language) : t("sessions.schedule.rounds.noTime");

  function openDialog(toClear: RoundSummary[]) {
    clearMutation.reset();
    setTargets(toClear);
  }

  const isAll = targets !== null && targets.length > 1;
  const scored = targets?.reduce((sum, round) => sum + round.scoredCount, 0) ?? 0;
  const phrase = targets === null || scored === 0
    ? null
    : isAll
      ? t("sessions.schedule.rounds.clearAllPhrase")
      : targets[0].roundType;
  const body = targets === null
    ? ""
    : [
        isAll
          ? t("sessions.schedule.rounds.clearAllBody")
          : t("sessions.schedule.rounds.clearBody", { count: targets[0].matchCount }),
        scored > 0 ? t("sessions.schedule.rounds.scoredWarning", { count: scored }) : "",
      ]
        .filter(Boolean)
        .join(" ");

  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("sessions.schedule.rounds.heading")}</h2>
      {rounds.length === 0 ? (
        <p>{t("sessions.schedule.rounds.none")}</p>
      ) : (
        <>
          <table className="schedule-table">
            <thead>
              <tr>
                <th>{t("sessions.schedule.rounds.columnRound")}</th>
                <th>{t("sessions.schedule.rounds.columnMatches")}</th>
                <th>{t("sessions.schedule.rounds.columnScored")}</th>
                <th>{t("sessions.schedule.rounds.columnFirst")}</th>
                <th>{t("sessions.schedule.rounds.columnLast")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rounds.map((round) => (
                <tr key={round.roundType}>
                  <td>{round.roundType}</td>
                  <td>{round.matchCount}</td>
                  <td>{round.scoredCount}</td>
                  <td>{formatTime(round.firstTime)}</td>
                  <td>{formatTime(round.lastTime)}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-small"
                      aria-label={t("sessions.schedule.rounds.clearAriaLabel", { round: round.roundType })}
                      onClick={() => openDialog([round])}
                    >
                      {t("sessions.schedule.rounds.clearAction")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rounds.length > 1 && (
            <button type="button" className="btn btn-danger btn-small" onClick={() => openDialog(rounds)}>
              {t("sessions.schedule.rounds.clearAllAction")}
            </button>
          )}
        </>
      )}
      {targets !== null && (
        <ConfirmDialog
          key={targets.map((round) => round.roundType).join(",")}
          heading={
            isAll
              ? t("sessions.schedule.rounds.clearAllHeading")
              : t("sessions.schedule.rounds.clearHeading", { round: targets[0].roundType })
          }
          body={body}
          confirmLabel={t("sessions.schedule.rounds.confirmClear")}
          cancelLabel={t("sessions.cancelAction")}
          requiredPhrase={phrase}
          phrasePrompt={phrase ? t("sessions.schedule.rounds.typeToConfirm", { phrase }) : undefined}
          isPending={clearMutation.isPending}
          error={clearMutation.isError ? apiErrorMessage(clearMutation.error, t("errors.generic")) : null}
          onConfirm={() => clearMutation.mutate(targets)}
          onCancel={() => setTargets(null)}
        />
      )}
    </section>
  );
}
```

- [ ] **Step 6: Create the Schedule tab**

Create `frontend/apps/admin/src/routes/SessionScheduleRoute.tsx`:

```tsx
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import { apiRequest } from "@tournament-admin/shared";
import { ReadinessChecklist } from "../schedule/ReadinessChecklist";
import { CurrentRounds } from "../schedule/CurrentRounds";
import { checkReadiness, countCheckedInTeams, countUsableFields } from "../schedule/readiness";
import { summarizeRounds } from "../schedule/roundSummary";
import { useSessionMatches } from "../useSessionMatches";
import type {
  Division,
  EventRead,
  FieldRead,
  FieldSetRead,
  MatchFormat,
  ParticipationRead,
  SessionRead,
  TeamSummary,
} from "../types";

export function SessionScheduleRoute() {
  const { t } = useTranslation();
  const { session } = useOutletContext<{ session: SessionRead }>();
  const [selectedDivisionId, setSelectedDivisionId] = useState<number | null>(null);

  const { data: divisions } = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const { data: event } = useQuery({
    queryKey: ["event"],
    queryFn: () => apiRequest<EventRead>("/api/event"),
  });
  const { data: matchFormat } = useQuery({
    queryKey: ["matchFormat"],
    queryFn: () => apiRequest<MatchFormat>("/api/event/match-format"),
    enabled: Boolean(event?.game_plugin_name),
  });
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
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
  const { data: matches } = useSessionMatches(session.id);

  // A single-division event schedules with no division_id at all: the
  // backend then uses unassigned FieldSets and the sole division's teams.
  const multiDivision = (divisions?.length ?? 0) > 1;
  const divisionId = multiDivision ? (selectedDivisionId ?? divisions![0].id) : null;

  const rounds = summarizeRounds(matches ?? [], divisionId);
  const readiness = checkReadiness({
    gamePluginSelected: Boolean(event?.game_plugin_name),
    sessionTimezone: session.timezone,
    checkedInTeamCount: countCheckedInTeams(teams ?? [], participants ?? [], divisionId),
    teamsNeeded: matchFormat ? matchFormat.teams_per_alliance * matchFormat.alliance_count : 0,
    usableFieldCount: countUsableFields(fieldSets ?? [], fields ?? [], divisionId),
  });

  return (
    <div className="session-schedule">
      {multiDivision && (
        <label className="field">
          <span className="field__label">{t("sessions.schedule.divisionLabel")}</span>
          <select
            className="select"
            value={divisionId ?? ""}
            onChange={(event) => setSelectedDivisionId(Number(event.target.value))}
          >
            {(divisions ?? []).map((division) => (
              <option key={division.id} value={division.id}>
                {division.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ReadinessChecklist items={readiness} sessionId={session.id} />
      <CurrentRounds
        sessionId={session.id}
        divisionId={divisionId}
        sessionTimezone={session.timezone}
        rounds={rounds}
      />
    </div>
  );
}
```

- [ ] **Step 7: Wire the tab, route, and CSS**

In `SessionDetailLayout.tsx`, add between the Fields and Matches `NavLink`s:

```tsx
        <NavLink to={`/sessions/${session.id}/schedule`} className={tabLinkClassName}>
          {t("sessions.scheduleTab")}
        </NavLink>
```

In `router.tsx`, import `SessionScheduleRoute` and add to the `sessions/:sessionId` children (between `fields` and `matches`):

```tsx
          { path: "schedule", element: <SessionScheduleRoute /> },
```

Append to `components.css`:

```css
.readiness-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.schedule-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: var(--space-3);
  font-size: var(--text-sm);
}

.schedule-table th,
.schedule-table td {
  text-align: left;
  padding: var(--space-2) var(--space-3);
  border-bottom: var(--border-width) solid var(--color-border);
}
```

- [ ] **Step 8: Run the tests and type-check**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionScheduleRoute.test.tsx tests/unit/SessionDetailLayout.test.tsx && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add frontend/apps/admin/src/schedule/ReadinessChecklist.tsx frontend/apps/admin/src/schedule/CurrentRounds.tsx frontend/apps/admin/src/routes/SessionScheduleRoute.tsx frontend/apps/admin/src/routes/SessionDetailLayout.tsx frontend/apps/admin/src/router.tsx frontend/apps/admin/src/styles/components.css frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/unit/SessionScheduleRoute.test.tsx frontend/apps/admin/tests/unit/SessionDetailLayout.test.tsx
git commit -m "Add the session Schedule tab's readiness checklist and round clearing"
```

---

### Task 9: Schedule tab — generate form and preview

**Files:**
- Create: `frontend/apps/admin/src/schedule/ScheduleForm.tsx`
- Create: `frontend/apps/admin/src/schedule/PreviewPanel.tsx`
- Modify: `frontend/apps/admin/src/routes/SessionScheduleRoute.tsx`
- Modify: `frontend/apps/admin/src/styles/components.css`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/SessionScheduleRoute.test.tsx` (append a second `describe`)

**Interfaces:**
- Consumes: Task 6's `buildScheduleRequest`, `availableRoundTypes`, `defaultPhases`, `roundTypeOptionsForRow`, `projectedFinish`, `formatCycleTime`, `isCycleTimeTight`, `todayInZone`, `ScheduleFormState`, `ScheduleRequestPayload`; Task 8's `SessionScheduleRoute` locals (`divisionId`, `rounds`, `matchFormat`, `readiness`); Task 4's `ScheduleGenerateResponse`, `PluginSummary`, `apiErrorMessage`; `showTransientError` from `src/errorBanner.ts`; `GET /api/plugins/schedulers` (key `["schedulerPlugins"]`); `POST /api/schedule`.
- Produces: `ScheduleForm` props `{ sessionId: number; divisionId: number | null; session: SessionRead; matchFormat: MatchFormat; existingRoundTypes: string[]; ready: boolean; onGenerated: (response: ScheduleGenerateResponse) => void }`; `PreviewPanel` props `{ response: ScheduleGenerateResponse; stale: boolean }`.

- [ ] **Step 1: Add the i18n strings**

In `en/admin.json`, inside `"sessions"."schedule"`, add after `"rounds"`:

```json
      "form": {
        "heading": "Generate a schedule",
        "schedulerLabel": "Scheduler",
        "noSchedulers": "No scheduler plugin is installed.",
        "phasesHeading": "Phases",
        "phaseRoundTypeLabel": "Round type for phase {{n}}",
        "phaseMatchesLabel": "Matches per team for phase {{n}}",
        "moveUpAction": "Move up",
        "moveDownAction": "Move down",
        "removePhaseAction": "Remove phase",
        "addPhaseAction": "Add phase",
        "timingHeading": "Timing",
        "timingFit": "Fit into these windows",
        "timingFixed": "Fixed cycle time",
        "cycleMinutesLabel": "Cycle time (minutes)",
        "fixedHint": "Leave the last block's end time blank to run until done. Blocks with an end time hold a fixed number of matches, and the server rejects them if that's more or fewer than the schedule needs.",
        "cycleTight": "This cycle time is under 1.5x the {{seconds}}-second match length.",
        "blockDateLabel": "Date for block {{n}}",
        "blockStartLabel": "Start time for block {{n}}",
        "blockEndLabel": "End time for block {{n}}",
        "removeBlockAction": "Remove block",
        "addBlockAction": "Add time block",
        "previewAction": "Preview",
        "generateAction": "Generate",
        "needsGamePlugin": "Select a game plugin to set up the schedule.",
        "generated": "Generated {{count}} matches.",
        "viewMatches": "View matches",
        "errors": {
          "noScheduler": "Choose a scheduler.",
          "noPhases": "Add at least one phase.",
          "invalidPhase": "Every phase needs a round type and at least 1 match per team.",
          "noBlocks": "Add at least one time block.",
          "blockIncomplete": "Every time block needs a date and a start time.",
          "endTimeRequired": "Every time block needs an end time.",
          "cycleRequired": "Enter a cycle time.",
          "endTimeRequiredExceptLast": "Every time block except the last needs an end time."
        }
      },
      "preview": {
        "heading": "Preview",
        "stale": "Out of date — preview again",
        "phaseLine": "{{round}}: {{count}} matches",
        "columnDate": "Date",
        "columnStart": "Start",
        "columnEnd": "End",
        "columnCycle": "Cycle time",
        "columnSlots": "Slots",
        "projectedFinish": "projected finish {{time}}",
        "nextDay": " (+{{count}} day)"
      }
```

In `zh/admin.json`, the same keys:

```json
      "form": {
        "heading": "生成赛程",
        "schedulerLabel": "排程插件",
        "noSchedulers": "未安装排程插件。",
        "phasesHeading": "阶段",
        "phaseRoundTypeLabel": "阶段 {{n}} 的轮次类型",
        "phaseMatchesLabel": "阶段 {{n}} 每队比赛数",
        "moveUpAction": "上移",
        "moveDownAction": "下移",
        "removePhaseAction": "移除阶段",
        "addPhaseAction": "添加阶段",
        "timingHeading": "时间安排",
        "timingFit": "安排在这些时间段内",
        "timingFixed": "固定循环时间",
        "cycleMinutesLabel": "循环时间（分钟）",
        "fixedHint": "最后一个时间段的结束时间可留空，表示一直进行到结束。设定了结束时间的时间段可容纳的比赛数固定，若多于或少于所需，服务器会拒绝。",
        "cycleTight": "该循环时间不到 {{seconds}} 秒比赛时长的 1.5 倍。",
        "blockDateLabel": "时间段 {{n}} 的日期",
        "blockStartLabel": "时间段 {{n}} 的开始时间",
        "blockEndLabel": "时间段 {{n}} 的结束时间",
        "removeBlockAction": "移除时间段",
        "addBlockAction": "添加时间段",
        "previewAction": "预览",
        "generateAction": "生成",
        "needsGamePlugin": "请先选择比赛插件再设置赛程。",
        "generated": "已生成 {{count}} 场比赛。",
        "viewMatches": "查看比赛",
        "errors": {
          "noScheduler": "请选择排程插件。",
          "noPhases": "至少添加一个阶段。",
          "invalidPhase": "每个阶段都需要轮次类型，且每队至少 1 场比赛。",
          "noBlocks": "至少添加一个时间段。",
          "blockIncomplete": "每个时间段都需要日期和开始时间。",
          "endTimeRequired": "每个时间段都需要结束时间。",
          "cycleRequired": "请输入循环时间。",
          "endTimeRequiredExceptLast": "除最后一个外，每个时间段都需要结束时间。"
        }
      },
      "preview": {
        "heading": "预览",
        "stale": "已过期——请重新预览",
        "phaseLine": "{{round}}：{{count}} 场比赛",
        "columnDate": "日期",
        "columnStart": "开始",
        "columnEnd": "结束",
        "columnCycle": "循环时间",
        "columnSlots": "时段数",
        "projectedFinish": "预计 {{time}} 结束",
        "nextDay": "（+{{count}} 天）"
      }
```

- [ ] **Step 2: Write the failing tests**

Append to `frontend/apps/admin/tests/unit/SessionScheduleRoute.test.tsx` (after the first `describe`; add `ApiError` to the `@tournament-admin/shared` import at the top):

```tsx
const PREVIEW_RESPONSE = {
  schedule_generation_id: null,
  match_count: 14,
  resolved_time_blocks: [
    { date: "2026-11-07", start_time: "09:00", end_time: "12:00", cycle_time_seconds: 771.4, time_slot_count: 14 },
  ],
  cycle_time_warning: null,
  phase_results: [
    { round_type: "practice", schedule_generation_id: null, match_count: 2 },
    { round_type: "qualification", schedule_generation_id: null, match_count: 12 },
  ],
};

function scheduleBodies(): unknown[] {
  return vi
    .mocked(apiRequest)
    .mock.calls.filter(([path, options]) => path === "/api/schedule" && (options as { method?: string })?.method === "POST")
    .map(([, options]) => (options as { body: unknown }).body);
}

describe("SessionScheduleRoute — generate form", () => {
  it("pre-fills practice x1 then qualification x6 and previews with a fit-mode request", async () => {
    stub({ onWrite: () => PREVIEW_RESPONSE });
    renderSchedule();

    const preview = await screen.findByRole("button", { name: "Preview" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);

    await waitFor(() =>
      expect(scheduleBodies()).toEqual([
        {
          session_id: 1,
          scheduler_plugin_name: "balanced",
          phases: [
            { round_type: "practice", target_matches_per_team: 1 },
            { round_type: "qualification", target_matches_per_team: 6 },
          ],
          time_blocks: [{ date: "2026-11-07", start_time: "09:00", end_time: "12:00", cycle_time: null }],
          dry_run: true,
        },
      ])
    );
    const panel = await screen.findByRole("region", { name: "Preview" });
    expect(within(panel).getByText("practice: 2 matches")).toBeInTheDocument();
    expect(within(panel).getByText("12:51")).toBeInTheDocument();
  });

  it("does not offer round types that already have a schedule", async () => {
    stub({ matches: [scheduleMatch({})] });
    renderSchedule();

    const roundType = await screen.findByLabelText("Round type for phase 1");
    expect((roundType as HTMLSelectElement).value).toBe("qualification");
    expect(within(roundType).queryByRole("option", { name: "practice" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Round type for phase 2")).not.toBeInTheDocument();
  });

  it("fixed cycle mode sends cycle_time on every block and allows an open-ended last block", async () => {
    stub({ onWrite: () => PREVIEW_RESPONSE });
    renderSchedule();

    fireEvent.click(await screen.findByLabelText("Fixed cycle time"));
    fireEvent.change(screen.getByLabelText("Cycle time (minutes)"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("End time for block 1"), { target: { value: "" } });
    const preview = screen.getByRole("button", { name: "Preview" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);

    await waitFor(() =>
      expect((scheduleBodies()[0] as { time_blocks: unknown }).time_blocks).toEqual([
        { date: "2026-11-07", start_time: "09:00", end_time: null, cycle_time: 480 },
      ])
    );
  });

  it("marks the preview out of date once an input changes", async () => {
    stub({ onWrite: () => PREVIEW_RESPONSE });
    renderSchedule();

    const preview = await screen.findByRole("button", { name: "Preview" });
    await waitFor(() => expect(preview).toBeEnabled());
    fireEvent.click(preview);
    await screen.findByRole("region", { name: "Preview" });
    expect(screen.queryByText("Out of date — preview again")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Matches per team for phase 2"), { target: { value: "4" } });
    expect(screen.getByText("Out of date — preview again")).toBeInTheDocument();
  });

  it("shows a server rejection verbatim", async () => {
    stub({ onWrite: () => new ApiError(422, "round_type 'qualification': Scheduler plugin returned no matches") });
    renderSchedule();

    const generate = await screen.findByRole("button", { name: "Generate" });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "round_type 'qualification': Scheduler plugin returned no matches"
    );
  });

  it("keeps Preview and Generate disabled until every readiness item passes", async () => {
    stub({ fields: [] });
    renderSchedule();

    await screen.findByRole("link", { name: "Add fields" });
    expect(screen.getByRole("button", { name: "Preview" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  it("after Generate, links to Matches and stops offering the generated round types", async () => {
    let generated = false;
    stub({
      matches: () =>
        generated
          ? [
              scheduleMatch({ id: 1 }),
              scheduleMatch({ id: 2, round_type: "qualification", label: "Q1", scheduled_time: "2026-11-07T18:00:00Z" }),
            ]
          : [],
      onWrite: () => {
        generated = true;
        return { ...PREVIEW_RESPONSE, schedule_generation_id: 7 };
      },
    });
    renderSchedule();

    const generate = await screen.findByRole("button", { name: "Generate" });
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);

    expect(await screen.findByText("Generated 14 matches.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View matches" })).toHaveAttribute("href", "/sessions/1/matches");
    const roundType = await screen.findByLabelText("Round type for phase 1");
    await waitFor(() => expect((roundType as HTMLSelectElement).value).toBe("elimination"));
  });
});
```

(`12:51` is the block's cycle time, `formatCycleTime(771.4)` → 771 seconds → `12:51`. The block has an `end_time`, so its End column shows `12:00`, not a projected finish.)

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionScheduleRoute.test.tsx`
Expected: the new `generate form` tests FAIL (no Preview button); the Task 8 tests still PASS.

- [ ] **Step 4: Create `PreviewPanel`**

Create `frontend/apps/admin/src/schedule/PreviewPanel.tsx`:

```tsx
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { formatCycleTime, projectedFinish } from "./scheduleRequest";
import type { ScheduleGenerateResponse } from "../types";

export function PreviewPanel({ response, stale }: { response: ScheduleGenerateResponse; stale: boolean }) {
  const { t } = useTranslation();
  const headingId = useId();
  return (
    <section className="panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{t("sessions.schedule.preview.heading")}</h2>
      {stale && (
        <p className="alert alert-warning" role="status">
          {t("sessions.schedule.preview.stale")}
        </p>
      )}
      {response.cycle_time_warning && <p className="alert alert-warning">{response.cycle_time_warning}</p>}
      <ul className="list-plain">
        {(response.phase_results ?? []).map((phase) => (
          <li key={phase.round_type} className="list-row">
            {t("sessions.schedule.preview.phaseLine", { round: phase.round_type, count: phase.match_count })}
          </li>
        ))}
      </ul>
      <table className="schedule-table">
        <thead>
          <tr>
            <th>{t("sessions.schedule.preview.columnDate")}</th>
            <th>{t("sessions.schedule.preview.columnStart")}</th>
            <th>{t("sessions.schedule.preview.columnEnd")}</th>
            <th>{t("sessions.schedule.preview.columnCycle")}</th>
            <th>{t("sessions.schedule.preview.columnSlots")}</th>
          </tr>
        </thead>
        <tbody>
          {response.resolved_time_blocks.map((block, index) => {
            let end = block.end_time;
            if (end === null) {
              const finish = projectedFinish(block);
              end =
                t("sessions.schedule.preview.projectedFinish", { time: finish.time }) +
                (finish.dayOffset > 0 ? t("sessions.schedule.preview.nextDay", { count: finish.dayOffset }) : "");
            }
            return (
              <tr key={index}>
                <td>{block.date}</td>
                <td>{block.start_time}</td>
                <td>{end}</td>
                <td>{formatCycleTime(block.cycle_time_seconds)}</td>
                <td>{block.time_slot_count}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
```

- [ ] **Step 5: Create `ScheduleForm`**

Create `frontend/apps/admin/src/schedule/ScheduleForm.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest, ApiError } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { showTransientError } from "../errorBanner";
import { PreviewPanel } from "./PreviewPanel";
import {
  availableRoundTypes,
  buildScheduleRequest,
  defaultPhases,
  isCycleTimeTight,
  roundTypeOptionsForRow,
  todayInZone,
  type BlockDraft,
  type PhaseDraft,
  type ScheduleFormState,
  type ScheduleRequestPayload,
} from "./scheduleRequest";
import type { MatchFormat, PluginSummary, ScheduleGenerateResponse, SessionRead } from "../types";

interface ScheduleFormProps {
  sessionId: number;
  divisionId: number | null;
  session: SessionRead;
  matchFormat: MatchFormat;
  existingRoundTypes: string[];
  ready: boolean;
  onGenerated: (response: ScheduleGenerateResponse) => void;
}

export function ScheduleForm({
  sessionId,
  divisionId,
  session,
  matchFormat,
  existingRoundTypes,
  ready,
  onGenerated,
}: ScheduleFormProps) {
  const { t } = useTranslation();
  const available = useMemo(
    () => availableRoundTypes(matchFormat.round_types, existingRoundTypes),
    [matchFormat.round_types, existingRoundTypes]
  );
  const [state, setState] = useState<ScheduleFormState>(() => ({
    schedulerPluginName: "",
    phases: defaultPhases(available),
    timingMode: "fit",
    cycleMinutes: 7,
    blocks: [{ date: session.session_date ?? todayInZone(session.timezone), startTime: "09:00", endTime: "12:00" }],
  }));
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ response: ScheduleGenerateResponse; snapshot: string } | null>(null);

  const { data: schedulers } = useQuery({
    queryKey: ["schedulerPlugins"],
    queryFn: () => apiRequest<PluginSummary[]>("/api/plugins/schedulers"),
  });
  const effectiveScheduler =
    state.schedulerPluginName ||
    (schedulers?.some((plugin) => plugin.name === "balanced") ? "balanced" : (schedulers?.[0]?.name ?? ""));
  const effectiveState: ScheduleFormState = { ...state, schedulerPluginName: effectiveScheduler };
  const snapshot = JSON.stringify(effectiveState);
  const stale = preview !== null && preview.snapshot !== snapshot;

  const submitMutation = useMutation({
    mutationFn: (payload: ScheduleRequestPayload) =>
      apiRequest<ScheduleGenerateResponse>("/api/schedule", { method: "POST", body: payload }),
    onError: (error) => {
      if (!(error instanceof ApiError)) showTransientError(t("errors.network"));
    },
  });

  function submit(dryRun: boolean) {
    const result = buildScheduleRequest(effectiveState, { sessionId, divisionId, dryRun });
    if (!result.ok) {
      setFormError(result.errorKey);
      return;
    }
    setFormError(null);
    const submittedSnapshot = snapshot;
    submitMutation.mutate(result.payload, {
      onSuccess: (response) => {
        if (dryRun) setPreview({ response, snapshot: submittedSnapshot });
        else onGenerated(response);
      },
    });
  }

  function update(patch: Partial<ScheduleFormState>) {
    setState((previous) => ({ ...previous, ...patch }));
  }
  function updatePhase(index: number, patch: Partial<PhaseDraft>) {
    update({ phases: state.phases.map((phase, i) => (i === index ? { ...phase, ...patch } : phase)) });
  }
  function movePhase(index: number, offset: -1 | 1) {
    const phases = [...state.phases];
    [phases[index], phases[index + offset]] = [phases[index + offset], phases[index]];
    update({ phases });
  }
  function updateBlock(index: number, patch: Partial<BlockDraft>) {
    update({ blocks: state.blocks.map((block, i) => (i === index ? { ...block, ...patch } : block)) });
  }

  const nextRoundType = available.find((roundType) => !state.phases.some((p) => p.roundType === roundType));
  const lastBlock = state.blocks[state.blocks.length - 1];
  const busy = submitMutation.isPending;

  return (
    <section className="panel schedule-form" aria-label={t("sessions.schedule.form.heading")}>
      <h2>{t("sessions.schedule.form.heading")}</h2>

      {schedulers && schedulers.length === 0 ? (
        <p className="alert alert-danger">{t("sessions.schedule.form.noSchedulers")}</p>
      ) : (
        <label className="field">
          <span className="field__label">{t("sessions.schedule.form.schedulerLabel")}</span>
          <select
            className="select"
            value={effectiveScheduler}
            onChange={(event) => update({ schedulerPluginName: event.target.value })}
          >
            {(schedulers ?? []).map((plugin) => (
              <option key={plugin.name} value={plugin.name}>
                {plugin.display_name}
              </option>
            ))}
          </select>
        </label>
      )}

      <fieldset className="schedule-form__group">
        <legend>{t("sessions.schedule.form.phasesHeading")}</legend>
        {state.phases.map((phase, index) => (
          <div key={index} className="form-actions">
            <select
              className="select"
              aria-label={t("sessions.schedule.form.phaseRoundTypeLabel", { n: index + 1 })}
              value={phase.roundType}
              onChange={(event) => updatePhase(index, { roundType: event.target.value })}
            >
              {roundTypeOptionsForRow(available, state.phases, index).map((roundType) => (
                <option key={roundType} value={roundType}>
                  {roundType}
                </option>
              ))}
            </select>
            <input
              className="input schedule-form__number"
              type="number"
              min={1}
              aria-label={t("sessions.schedule.form.phaseMatchesLabel", { n: index + 1 })}
              value={phase.matchesPerTeam}
              onChange={(event) => updatePhase(index, { matchesPerTeam: Number(event.target.value) })}
            />
            <button type="button" className="btn btn-small" disabled={index === 0} onClick={() => movePhase(index, -1)}>
              {t("sessions.schedule.form.moveUpAction")}
            </button>
            <button
              type="button"
              className="btn btn-small"
              disabled={index === state.phases.length - 1}
              onClick={() => movePhase(index, 1)}
            >
              {t("sessions.schedule.form.moveDownAction")}
            </button>
            <button
              type="button"
              className="btn btn-small"
              onClick={() => update({ phases: state.phases.filter((_, i) => i !== index) })}
            >
              {t("sessions.schedule.form.removePhaseAction")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-small"
          disabled={nextRoundType === undefined}
          onClick={() =>
            nextRoundType && update({ phases: [...state.phases, { roundType: nextRoundType, matchesPerTeam: 1 }] })
          }
        >
          {t("sessions.schedule.form.addPhaseAction")}
        </button>
      </fieldset>

      <fieldset className="schedule-form__group">
        <legend>{t("sessions.schedule.form.timingHeading")}</legend>
        <div className="form-actions">
          <label>
            <input
              type="radio"
              name="timing-mode"
              checked={state.timingMode === "fit"}
              onChange={() => update({ timingMode: "fit" })}
            />{" "}
            {t("sessions.schedule.form.timingFit")}
          </label>
          <label>
            <input
              type="radio"
              name="timing-mode"
              checked={state.timingMode === "fixed"}
              onChange={() => update({ timingMode: "fixed" })}
            />{" "}
            {t("sessions.schedule.form.timingFixed")}
          </label>
        </div>
        {state.timingMode === "fixed" && (
          <div className="field">
            <label className="field__label" htmlFor="schedule-cycle-minutes">
              {t("sessions.schedule.form.cycleMinutesLabel")}
            </label>
            <input
              id="schedule-cycle-minutes"
              className="input schedule-form__number"
              type="number"
              min={1}
              step={0.5}
              value={state.cycleMinutes}
              onChange={(event) => update({ cycleMinutes: Number(event.target.value) })}
            />
            <span className="field__hint">{t("sessions.schedule.form.fixedHint")}</span>
            {isCycleTimeTight(state.cycleMinutes, matchFormat.match_duration_seconds) && (
              <p className="alert alert-warning">
                {t("sessions.schedule.form.cycleTight", { seconds: matchFormat.match_duration_seconds })}
              </p>
            )}
          </div>
        )}
        {state.blocks.map((block, index) => (
          <div key={index} className="form-actions">
            <input
              className="input"
              type="date"
              aria-label={t("sessions.schedule.form.blockDateLabel", { n: index + 1 })}
              value={block.date}
              onChange={(event) => updateBlock(index, { date: event.target.value })}
            />
            <input
              className="input"
              type="time"
              aria-label={t("sessions.schedule.form.blockStartLabel", { n: index + 1 })}
              value={block.startTime}
              onChange={(event) => updateBlock(index, { startTime: event.target.value })}
            />
            <input
              className="input"
              type="time"
              aria-label={t("sessions.schedule.form.blockEndLabel", { n: index + 1 })}
              value={block.endTime}
              onChange={(event) => updateBlock(index, { endTime: event.target.value })}
            />
            <button
              type="button"
              className="btn btn-small"
              disabled={state.blocks.length === 1}
              onClick={() => update({ blocks: state.blocks.filter((_, i) => i !== index) })}
            >
              {t("sessions.schedule.form.removeBlockAction")}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-small"
          onClick={() =>
            update({
              blocks: [
                ...state.blocks,
                { date: lastBlock.date, startTime: lastBlock.endTime || lastBlock.startTime, endTime: "" },
              ],
            })
          }
        >
          {t("sessions.schedule.form.addBlockAction")}
        </button>
      </fieldset>

      {formError && (
        <p className="alert alert-danger" role="alert">
          {t(formError)}
        </p>
      )}
      {submitMutation.error instanceof ApiError && (
        <p className="alert alert-danger" role="alert">
          {apiErrorMessage(submitMutation.error, t("errors.generic"))}
        </p>
      )}
      <div className="form-actions">
        <button type="button" className="btn" disabled={!ready || busy} onClick={() => submit(true)}>
          {t("sessions.schedule.form.previewAction")}
        </button>
        <button type="button" className="btn btn-primary" disabled={!ready || busy} onClick={() => submit(false)}>
          {t("sessions.schedule.form.generateAction")}
        </button>
      </div>
      {preview && <PreviewPanel response={preview.response} stale={stale} />}
    </section>
  );
}
```

- [ ] **Step 6: Mount the form in the Schedule tab**

In `SessionScheduleRoute.tsx`: add `Link` to the `react-router-dom` import and `useQueryClient` to the `@tanstack/react-query` import; import `ScheduleForm` from `../schedule/ScheduleForm` and `ScheduleGenerateResponse` from `../types`. Inside the component, add after `const [selectedDivisionId, ...]`:

```tsx
  const queryClient = useQueryClient();
  const [lastGenerated, setLastGenerated] = useState<ScheduleGenerateResponse | null>(null);
```

and after the `readiness` computation:

```tsx
  const ready = readiness.every((item) => item.ok);
  const existingRoundTypes = rounds.map((round) => round.roundType);
```

Then, after `<CurrentRounds ... />` in the JSX, add:

```tsx
      {lastGenerated && (
        <p className="alert alert-success" role="status">
          {t("sessions.schedule.form.generated", { count: lastGenerated.match_count })}{" "}
          <Link to={`/sessions/${session.id}/matches`}>{t("sessions.schedule.form.viewMatches")}</Link>
        </p>
      )}
      {matchFormat ? (
        <ScheduleForm
          // Remounting on the existing round types (and division) resets
          // the form after a Generate or Clear lands, so it never offers a
          // round type that now has a schedule.
          key={`${divisionId ?? "none"}:${existingRoundTypes.join(",")}`}
          sessionId={session.id}
          divisionId={divisionId}
          session={session}
          matchFormat={matchFormat}
          existingRoundTypes={existingRoundTypes}
          ready={ready}
          onGenerated={(response) => {
            setLastGenerated(response);
            queryClient.invalidateQueries({ queryKey: ["matches", session.id] });
          }}
        />
      ) : (
        <p className="field__hint">{t("sessions.schedule.form.needsGamePlugin")}</p>
      )}
```

- [ ] **Step 7: Add the CSS**

Append to `components.css`:

```css
.schedule-form__group {
  border: none;
  padding: 0;
  margin: 0 0 var(--space-4);
}

.schedule-form__group legend {
  font-weight: 700;
  margin-bottom: var(--space-2);
}

.schedule-form__number {
  width: 6rem;
}
```

- [ ] **Step 8: Run the tests and type-check**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionScheduleRoute.test.tsx && npm test && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add frontend/apps/admin/src/schedule/ScheduleForm.tsx frontend/apps/admin/src/schedule/PreviewPanel.tsx frontend/apps/admin/src/routes/SessionScheduleRoute.tsx frontend/apps/admin/src/styles/components.css frontend/apps/admin/src/i18n/en/admin.json frontend/apps/admin/src/i18n/zh/admin.json frontend/apps/admin/tests/unit/SessionScheduleRoute.test.tsx
git commit -m "Add the schedule generate form with dry-run preview"
```

---

### Task 10: End-to-end tests and frontend docs

**Files:**
- Modify: `frontend/apps/admin/tests/e2e/fixtures/buildPluginZip.ts`
- Create: `frontend/apps/admin/tests/e2e/sessionSchedule.spec.ts`
- Modify: `frontend/CLAUDE.md` (Routes and role-gated nav section)

**Interfaces:**
- Consumes: everything above; shared `E2E_EVENT_NAME`/`E2E_EVENT_PASSWORD` from `tests/e2e/fixtures/testEvent.ts`; existing `buildExampleGamePluginZip()`.
- Produces: `buildBalancedSchedulerPluginZip(): Promise<string>`.

**E2E environment facts this task must respect:** the E2E backend starts with an empty plugins root, so this spec installs the `balanced` scheduler itself (tolerating 409); `eventSetup.spec.ts` normally selects the example game plugin first, and game-plugin selection is immutable per event, so only select it if `game_plugin_name` is still null; every spec shares one event, so the two-division test must put the event back to one division (clear its schedule, delete its field set, delete the division) whether it passes or fails.

- [ ] **Step 1: Add the scheduler zip fixture**

Append to `frontend/apps/admin/tests/e2e/fixtures/buildPluginZip.ts`:

```ts
const BALANCED_SCHEDULER_PLUGIN_DIR = path.resolve(
  __dirname,
  "../../../../../../server/plugins/schedulers/balanced"
);

/** Only manifest.json and plugin.py: the folder can also hold a __pycache__ that doesn't belong in a plugin zip. */
export async function buildBalancedSchedulerPluginZip(): Promise<string> {
  const outPath = path.join(os.tmpdir(), `balanced-scheduler-${Date.now()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(path.join(BALANCED_SCHEDULER_PLUGIN_DIR, "manifest.json"), { name: "manifest.json" });
    archive.file(path.join(BALANCED_SCHEDULER_PLUGIN_DIR, "plugin.py"), { name: "plugin.py" });
    void archive.finalize();
  });
  return outPath;
}
```

- [ ] **Step 2: Write the E2E spec**

Create `frontend/apps/admin/tests/e2e/sessionSchedule.spec.ts`:

```ts
import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";
import { buildBalancedSchedulerPluginZip, buildExampleGamePluginZip } from "./fixtures/buildPluginZip";

let token = "";
const headers = () => ({ Authorization: `Bearer ${token}` });

async function uploadPlugin(request: APIRequestContext, endpoint: string, zipPath: string) {
  const response = await request.post(endpoint, {
    headers: headers(),
    multipart: {
      file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(zipPath) },
    },
  });
  expect([201, 409]).toContain(response.status());
}

interface ReadySession {
  sessionId: number;
  teamIds: number[];
}

async function createReadySession(
  request: APIRequestContext,
  label: string,
  teamPrefix: string,
  divisionName: string | null = null
): Promise<ReadySession> {
  const session = await (
    await request.post("/api/sessions", {
      headers: headers(),
      data: { label, session_date: "2026-11-07", timezone: "America/Los_Angeles" },
    })
  ).json();
  const rows = Array.from({ length: 8 }, (_, i) => ({
    number: `${teamPrefix}${i + 1}`,
    name: `${label} Team ${i + 1}`,
    division: divisionName,
  }));
  const bulk = await (await request.post("/api/teams/bulk", { headers: headers(), data: { rows } })).json();
  const teamIds: number[] = bulk.results.map((result: { team: { id: number } }) => result.team.id);
  for (const teamId of teamIds) {
    await request.post(`/api/sessions/${session.id}/participants`, {
      headers: headers(),
      data: { team_id: teamId, checked_in: true },
    });
  }
  return { sessionId: session.id, teamIds };
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Role").fill("admin");
  await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
}

test.describe.serial("session fields, schedule, and matches", () => {
  let main: ReadySession;

  test.beforeAll(async ({ request }) => {
    const created = await request.post("/api/event", {
      data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD },
    });
    expect([201, 409]).toContain(created.status());
    const login = await request.post("/api/auth/login", {
      data: { role: "admin", password: E2E_EVENT_PASSWORD },
    });
    token = (await login.json()).access_token;

    await uploadPlugin(request, "/api/plugins/schedulers", await buildBalancedSchedulerPluginZip());
    const event = await (await request.get("/api/event")).json();
    if (event.game_plugin_name === null) {
      await uploadPlugin(request, "/api/plugins/games", await buildExampleGamePluginZip());
      const selected = await request.post("/api/event/game-plugin", {
        headers: headers(),
        data: { name: "example-game" },
      });
      expect(selected.ok()).toBeTruthy();
    }

    main = await createReadySession(request, "Schedule E2E", "SCH");
  });

  test("set up fields, preview, generate, view matches, clear all, and regenerate", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/fields`);

    await page.getByLabel("Add your first field").fill("Field A");
    await page.getByRole("button", { name: "Add field" }).click();
    const card = page.getByRole("region", { name: "Main Fields" });
    await expect(card.getByText("Field A")).toBeVisible();
    await card.getByLabel("New field name for Main Fields").fill("Field B");
    await card.getByRole("button", { name: "Add field" }).click();
    await expect(card.getByText("Field B")).toBeVisible();

    await page.getByRole("link", { name: "Schedule" }).click();
    const checklist = page.getByRole("region", { name: "Ready to schedule?" });
    await expect(checklist.getByText("Ready", { exact: true })).toHaveCount(4);

    await page.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("region", { name: "Preview" });
    await expect(preview.getByText(/^practice: \d+ matches$/)).toBeVisible();
    await expect(preview.getByText(/^qualification: \d+ matches$/)).toBeVisible();
    await page.getByLabel("End time for block 1").fill("13:00");
    await expect(page.getByText("Out of date — preview again")).toBeVisible();

    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByText(/^Generated \d+ matches\./)).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear practice" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Clear qualification" })).toBeVisible();

    await page.getByRole("link", { name: "View matches" }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${main.sessionId}/matches$`));
    await expect(page.getByRole("gridcell", { name: "P1", exact: true })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "09:00", exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Schedule" }).click();
    await page.getByRole("button", { name: "Clear all rounds" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Clear" }).click();
    await expect(page.getByText("No rounds have been generated yet.")).toBeVisible();

    await page.getByRole("button", { name: "Generate" }).click();
    await expect(page.getByRole("button", { name: "Clear practice" })).toBeVisible();
  });

  test("a scored round needs its name typed before Clear works", async ({ page, request }) => {
    const matches = await (
      await request.get(`/api/matches?session_id=${main.sessionId}`, { headers: headers() })
    ).json();
    const practice = matches.find((m: { round_type: string }) => m.round_type === "practice");
    for (const alliance of practice.alliances) {
      const scored = await request.post(`/api/matches/${practice.id}/alliances/${alliance.id}/score`, {
        headers: headers(),
        data: { data: { high_balls: 5, low_balls: 2, auto_winner: "tie" } },
      });
      expect(scored.ok()).toBeTruthy();
    }

    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/schedule`);
    await page.getByRole("button", { name: "Clear practice" }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog.getByRole("button", { name: "Clear" })).toBeDisabled();
    await dialog.getByLabel('Type "practice" to confirm').fill("practice");
    await dialog.getByRole("button", { name: "Clear" }).click();
    await expect(page.getByRole("button", { name: "Clear practice" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Clear qualification" })).toBeVisible();
  });

  test("deleting a field that has matches shows the server's refusal", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${main.sessionId}/fields`);
    await page.getByRole("button", { name: "Remove field Field A" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(
      page.getByRole("region", { name: "Main Fields" }).getByRole("alert")
    ).toHaveText("Field has scheduled matches; clear the schedule first");
  });

  test("the checklist blocks generating when the division has no fields", async ({ page, request }) => {
    const bare = await createReadySession(request, "No Fields E2E", "NOF");
    await loginAsAdmin(page);
    await page.goto(`/sessions/${bare.sessionId}/schedule`);
    await expect(page.getByRole("link", { name: "Add fields" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Preview" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Generate" })).toBeDisabled();
  });

  test("two divisions each generate on their own field set", async ({ page, request }) => {
    const divisions = await (await request.get("/api/divisions", { headers: headers() })).json();
    expect(divisions).toHaveLength(1);
    const first = divisions[0];
    const second = await (
      await request.post("/api/divisions", { headers: headers(), data: { name: "E2E Blue" } })
    ).json();
    const sessionA = await createReadySession(request, "Two Div E2E", "TDA", first.name);
    const sessionId = sessionA.sessionId;
    const blueTeams = Array.from({ length: 8 }, (_, i) => ({
      number: `TDB${i + 1}`,
      name: `Blue Team ${i + 1}`,
      division: second.name,
    }));
    const bulk = await (await request.post("/api/teams/bulk", { headers: headers(), data: { rows: blueTeams } })).json();
    for (const result of bulk.results) {
      await request.post(`/api/sessions/${sessionId}/participants`, {
        headers: headers(),
        data: { team_id: result.team.id, checked_in: true },
      });
    }
    const setIds: number[] = [];
    for (const [name, divisionId] of [
      ["Gym A", first.id],
      ["Gym B", second.id],
    ] as const) {
      const set = await (
        await request.post("/api/field-sets", {
          headers: headers(),
          data: { session_id: sessionId, name, division_id: divisionId },
        })
      ).json();
      setIds.push(set.id);
      await request.post("/api/fields", {
        headers: headers(),
        data: { session_id: sessionId, name: `${name} Field 1`, field_set_id: set.id },
      });
    }

    try {
      await loginAsAdmin(page);
      await page.goto(`/sessions/${sessionId}/schedule`);
      await page.getByLabel("Division").selectOption(String(first.id));
      await page.getByRole("button", { name: "Generate" }).click();
      await expect(page.getByRole("button", { name: "Clear qualification" })).toBeVisible();

      await page.getByLabel("Division").selectOption(String(second.id));
      await expect(page.getByText("No rounds have been generated yet.")).toBeVisible();
      await page.getByRole("button", { name: "Generate" }).click();
      await expect(page.getByRole("button", { name: "Clear qualification" })).toBeVisible();

      await page.getByRole("link", { name: "Matches" }).click();
      await page.getByLabel("Division").selectOption(String(second.id));
      await expect(page.getByRole("gridcell", { name: "Q1", exact: true })).toBeVisible();
    } finally {
      // Put the shared event back to one division for every later spec.
      for (const divisionId of [first.id, second.id]) {
        for (const roundType of ["practice", "qualification"]) {
          await request.delete(
            `/api/schedule?session_id=${sessionId}&division_id=${divisionId}&round_type=${roundType}`,
            { headers: headers() }
          );
        }
      }
      for (const setId of setIds) {
        await request.delete(`/api/field-sets/${setId}`, { headers: headers() });
      }
      await request.delete(`/api/divisions/${second.id}`, { headers: headers() });
    }
  });
});
```

- [ ] **Step 3: Run the new E2E spec**

Run: `cd frontend/apps/admin && npx playwright test tests/e2e/sessionSchedule.spec.ts`
Expected: 5 PASS. If a selector misses, fix the spec (not the app) unless the app genuinely violates the spec — and if it does, fix the app in the task that owns that code and note it in your report.

- [ ] **Step 4: Run the whole E2E suite**

Run: `cd frontend/apps/admin && npx playwright test`
Expected: all PASS — this checks the shared-event cleanup didn't break later specs.

- [ ] **Step 5: Document the routes**

In `frontend/CLAUDE.md`'s "Routes and role-gated nav" section, replace "`/sessions/:sessionId/checkin` (the admin check-in data grid, via `SessionDetailLayout`'s tab-strip `Outlet` context — see the session-checkin design spec)," with:

```markdown
`/sessions/:sessionId/{checkin,fields,schedule,matches}` (the session
tabs, all rendered through `SessionDetailLayout`'s tab-strip `Outlet`
context — see the session-checkin and fields-schedule-ui design specs;
the layout's header also carries the "Set as active session" control),
```

and add a paragraph at the end of that section:

```markdown
The Schedule tab is split so the risky logic is unit-testable without
rendering: `src/schedule/scheduleRequest.ts` (form state → `POST
/api/schedule` body, round-type defaults, preview timing math),
`roundSummary.ts`, and `readiness.ts` are pure; `ScheduleForm`,
`CurrentRounds`, `ReadinessChecklist`, and `PreviewPanel` are the
components. A single-division event never sends `division_id` (the
backend then uses unassigned FieldSets); a multi-division event always
sends the picked one. `useSessionMatches` (`src/useSessionMatches.ts`)
is the one `["matches", sessionId]` query both the Schedule and Matches
tabs share, kept live off `/ws/session/{id}`; `DELETE /api/schedule`
broadcasts nothing, so anything that clears a round invalidates that key
itself. Match times always render in the session's timezone
(`src/matchTime.ts`), never the browser's.
```

- [ ] **Step 6: Run every suite once more**

Run: `cd server && .venv/bin/pytest tests/ -q` then `cd frontend/apps/admin && npm test && npx tsc --noEmit -p tsconfig.json`
Expected: all PASS; tsc exits 0.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/admin/tests/e2e/fixtures/buildPluginZip.ts frontend/apps/admin/tests/e2e/sessionSchedule.spec.ts frontend/CLAUDE.md
git commit -m "Add end-to-end tests for the Fields, Schedule, and Matches tabs"
```

---

## Self-Review

**Spec coverage:** §1 match-format → Task 1; field/field-set PATCH/DELETE with 409s → Task 2; `is_finals`, `time_slot_count` → Task 3; active session (no backend change) → Task 4. §2 header badge/button → Task 4; tab strip → Tasks 5/7/8; Fields cards, rename, division select visibility, unassigned note, empty state, inline 409 → Task 5. §3.1 division picker, §3.2 checklist, §3.3 rounds/Clear/Clear all/typed confirm → Task 8; §3.4 form (scheduler default, phases, timing modes, blocks, explicit `time_blocks`, phases shape), §3.5 preview (per-phase counts, blocks, projected finish, warning, out of date, post-Generate summary/reset), §3.6 verbatim errors and network banner → Task 9 (pure parts in Task 6). §4 Matches grid, timezone, filters, sort, finals included, empty state, live updates → Tasks 6–7. Testing strategy → each task plus Task 10. Out-of-scope items are not built.

**Placeholder scan:** no TBD/TODO; every code step has full code. CSS uses only tokens confirmed in `tokens.css`.

**Type consistency:** `MatchRead`, `FieldSetRead`, `FieldRead`, `TeamSummary`, `ParticipationRead`, `MatchFormat`, `ScheduleGenerateResponse` defined once (Task 4) and imported everywhere; `RoundSummary`/`summarizeRounds`, `ReadinessItem`/`checkReadiness`, `ScheduleFormState`/`buildScheduleRequest` defined in Task 6 and used with the same names in Tasks 8–9; query keys `["event"]`, `["fieldSets", id]`, `["fields", id]`, `["matches", id]`, `["participants", id]`, `["matchFormat"]`, `["schedulerPlugins"]` used consistently.

**Review Focus:** each of the five lines has an owning test (Tasks 2, 6, 7, 8, 9).

## Execution Handoff

See the conversation for the execution choice.
