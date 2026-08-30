# Alliance Count & Game Model Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the already-declared `alliance_count` through match creation and scheduling, add a `game_model` plugin declaration (`head_to_head` vs `cooperative_score`) with a correct ranking algorithm and shared-scoresheet mirroring for the latter, and add organizer-configurable exclude/include ranking with cross-session (league) aggregation.

**Architecture:** Extend the existing game-plugin contract (`match_format()`) with `game_model`; branch `recompute_rankings` on it; add score mirroring between a `cooperative_score` match's alliances at the scoring endpoint; add a `RankingConfiguration` model and a shared exclude/include algorithm consumed by both session-scoped and a new cross-session ranking computation.

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy 2.0, SQLite, Pydantic v2, pytest.

**Spec:** `docs/superpowers/specs/2026-08-30-alliance-count-and-game-model-design.md` (the "Phase 5 spec"). Also read `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md` (the "master spec") and `docs/superpowers/specs/2026-08-29-qualification-and-practice-scheduling-design.md` (the "Phase 4 spec") for project-wide context.

## Global Constraints

- No brand names anywhere (code, comments, docs, file names, user-facing text) — master spec §0.
- Python 3.11+, FastAPI, SQLAlchemy 2.0 synchronous `Mapped`/`mapped_column` style, one SQLite file per event — matches existing codebase.
- No Alembic/migrations — this phase changes the `matches` table again (none, actually — this phase's schema changes are new tables plus `Ranking` column additions and `Ranking.session_id` becoming nullable) and adds a new `ranking_configurations` table. A pre-Phase-5 database is recreated (delete the `.db` file), not migrated, consistent with every prior phase.
- All new/changed endpoints return proper 404/422/409 errors via `HTTPException`, validated before any DB write.
- **`create_match` now requires an event to have a selected game plugin** (to read `alliance_count`) — this is an intentional behavior change from Phase 3/4, not a bug: it makes an already-implicit precondition (you can't meaningfully score a match without a game plugin) explicit at creation time too. Every test that creates a match must select a game plugin first.
- Deletions that should appear in the audit log go through ORM `db.delete(obj)`, never bulk `Table.delete()` — unchanged rule from Phase 4, still applies to `RankingConfiguration`/`Ranking` row management in this phase.

---

### Task 1: `game_model` contract addition + conformance check

**Files:**
- Modify: `src/tournament_server/plugin_registry/conformance.py`
- Modify: `tests/fixtures/plugins/games/example-game/plugin.py`
- Test: `tests/test_plugin_conformance.py`

**Interfaces:**
- Produces: `match_format()`'s required-keys set now includes `"game_model"`, checked against `{"head_to_head", "cooperative_score"}` — consumed by every later task that reads `match_format()["game_model"]`.
- Consumes: nothing new.

- [ ] **Step 1: Add `game_model` to `example-game`'s `match_format()`**

In `tests/fixtures/plugins/games/example-game/plugin.py`, change:

```python
def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
    }
```

to:

```python
def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "head_to_head",
    }
```

- [ ] **Step 2: Update `_check_match_format` to require and validate `game_model`**

In `src/tournament_server/plugin_registry/conformance.py`, replace:

```python
def _check_match_format(module: Any) -> CheckResult:
    result = module.match_format()
    required_keys = {
        "alliance_count",
        "teams_per_alliance",
        "autonomous_seconds",
        "driver_seconds",
        "round_types",
    }
    missing = required_keys - result.keys()
    if missing:
        return CheckResult(
            "match_format() shape", False, f"missing keys: {sorted(missing)}"
        )
    if not isinstance(result["round_types"], list) or not result["round_types"]:
        return CheckResult(
            "match_format() shape", False, "round_types must be a non-empty list"
        )
    return CheckResult("match_format() shape", True)
```

with:

```python
VALID_GAME_MODELS = {"head_to_head", "cooperative_score"}


def _check_match_format(module: Any) -> CheckResult:
    result = module.match_format()
    required_keys = {
        "alliance_count",
        "teams_per_alliance",
        "autonomous_seconds",
        "driver_seconds",
        "round_types",
        "game_model",
    }
    missing = required_keys - result.keys()
    if missing:
        return CheckResult(
            "match_format() shape", False, f"missing keys: {sorted(missing)}"
        )
    if not isinstance(result["round_types"], list) or not result["round_types"]:
        return CheckResult(
            "match_format() shape", False, "round_types must be a non-empty list"
        )
    if result["game_model"] not in VALID_GAME_MODELS:
        return CheckResult(
            "match_format() shape",
            False,
            f"game_model must be one of {sorted(VALID_GAME_MODELS)}, got "
            f"{result['game_model']!r}",
        )
    return CheckResult("match_format() shape", True)
```

(Place `VALID_GAME_MODELS` above `_check_match_format`, below the existing `VALID_DATA_TYPES`/`VALID_WIDGETS`/`VALID_SCOPES` constants, matching the file's existing style.)

- [ ] **Step 3: Write the failing/passing tests**

Add to `tests/test_plugin_conformance.py` (read the file first to match its existing fixture-loading style — it loads plugin folders via `Path` constants the same way other test files do; use the same `FIXTURE_EXAMPLE_PLUGIN` constant already defined there):

```python
def test_match_format_requires_game_model(tmp_path):
    import json
    import shutil

    from tournament_server.plugin_registry.conformance import run_conformance_checks

    broken_dir = tmp_path / "missing-game-model"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, broken_dir)
    manifest = json.loads((broken_dir / "manifest.json").read_text())
    manifest["name"] = "missing-game-model"
    (broken_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (broken_dir / "plugin.py").read_text()
    broken_text = plugin_text.replace(
        '"game_model": "head_to_head",\n    ', ""
    )
    assert broken_text != plugin_text, "test fixture setup did not find the line to remove"
    (broken_dir / "plugin.py").write_text(broken_text)

    report = run_conformance_checks(broken_dir)
    match_format_check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not match_format_check.passed
    assert "game_model" in match_format_check.message


def test_match_format_rejects_invalid_game_model(tmp_path):
    import json
    import shutil

    from tournament_server.plugin_registry.conformance import run_conformance_checks

    broken_dir = tmp_path / "bad-game-model"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, broken_dir)
    manifest = json.loads((broken_dir / "manifest.json").read_text())
    manifest["name"] = "bad-game-model"
    (broken_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (broken_dir / "plugin.py").read_text()
    broken_text = plugin_text.replace(
        '"game_model": "head_to_head"', '"game_model": "not-a-real-model"'
    )
    assert broken_text != plugin_text, "test fixture setup did not find the line to replace"
    (broken_dir / "plugin.py").write_text(broken_text)

    report = run_conformance_checks(broken_dir)
    match_format_check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not match_format_check.passed
```

- [ ] **Step 4: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_plugin_conformance.py -v`
Expected: all pass, including the two new tests and every pre-existing test in that file (still exercising `example-game`, which now declares `game_model`).

Run: `.venv/bin/pytest tests/ -v`
Expected: same total as the current baseline (128 passed), plus these 2 new tests.

- [ ] **Step 5: Commit**

```bash
git add src/tournament_server/plugin_registry/conformance.py \
        tests/fixtures/plugins/games/example-game/plugin.py \
        tests/test_plugin_conformance.py
git commit -m "Add game_model to the match_format() contract and conformance check"
```

---

### Task 2: Wire `alliance_count` through match creation and scheduling

**Files:**
- Modify: `src/tournament_server/routers/matches.py`
- Modify: `src/tournament_server/routers/schedule.py`
- Modify: `plugins/schedulers/simple_random/plugin.py`
- Modify: `plugins/schedulers/balanced/plugin.py`
- Modify: `src/tournament_server/plugin_registry/conformance.py`
- Modify: `tests/test_matches.py`
- Modify: `tests/test_scores.py`
- Test: `tests/test_scheduler_plugins.py`

**Interfaces:**
- Consumes: `get_game_plugin_for_event` (existing, `deps.py`).
- Produces: `generate_schedule(teams, target_matches_per_team, teams_per_alliance, alliance_count, fields, field_sets, cross_session_pairing_history, constraints) -> matches` — the scheduler-plugin contract's new signature, consumed by every later task and by any future scheduler plugin.

This task makes `POST /api/matches` require a selected game plugin (to read `alliance_count`), which breaks the implicit assumption behind several existing `test_matches.py` tests that never select one. Fix the shared setup helper once rather than each test individually.

- [ ] **Step 1: Update `create_match` to validate against the declared `alliance_count`**

In `src/tournament_server/routers/matches.py`, add the import:

```python
from tournament_server.deps import get_db, get_game_plugin_for_event, get_session_id, get_the_event
```

(replacing the existing `from tournament_server.deps import get_db, get_session_id, get_the_event` line). Add a `request: Request` parameter to `create_match` and change its alliance-count check. Replace:

```python
@router.post("", response_model=MatchRead, status_code=201)
def create_match(payload: MatchCreate, db: Session = Depends(get_db)) -> MatchRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")

    session_id = payload.session_id
    if session_id is None:
        session_id = event.active_session_id
    if session_id is None:
        raise HTTPException(
            status_code=422, detail="No session_id given and no active session is set"
        )
    if db.get(TournamentSession, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    if len(payload.alliances) != 2:
        raise HTTPException(
            status_code=422, detail="A match must have exactly 2 alliances"
        )
```

with:

```python
@router.post("", response_model=MatchRead, status_code=201)
def create_match(
    payload: MatchCreate, request: Request, db: Session = Depends(get_db)
) -> MatchRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")

    session_id = payload.session_id
    if session_id is None:
        session_id = event.active_session_id
    if session_id is None:
        raise HTTPException(
            status_code=422, detail="No session_id given and no active session is set"
        )
    if db.get(TournamentSession, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    game_plugin = get_game_plugin_for_event(request, db)
    alliance_count = game_plugin.module.match_format()["alliance_count"]
    if len(payload.alliances) != alliance_count:
        raise HTTPException(
            status_code=422,
            detail=f"A match must have exactly {alliance_count} alliances",
        )
```

Add `from fastapi import APIRouter, Depends, HTTPException, Request` (add `Request` to the existing `fastapi` import line at the top of the file).

- [ ] **Step 2: Fix `_setup_two_teams` so existing tests keep working**

In `tests/test_matches.py`, `_setup_two_teams` is called by every test in the file, always right after that test's own `client.post("/api/event", json={"name": "Regional Qualifier"})` call. Add a game-plugin-selection call as its first line:

```python
def _setup_two_teams(client):
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    team2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    team3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]
    team4 = client.post("/api/teams", json={"number": "4", "name": "Team Four"}).json()["id"]
    return session_id, team1, team2, team3, team4
```

(Only the new first line is added — everything else in this helper is unchanged.)

- [ ] **Step 3: Add the new "requires a game plugin" test, remove the now-unreachable one**

Add to `tests/test_matches.py`:

```python
def test_create_match_requires_game_plugin_selected(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    )
    assert response.status_code == 422
```

Remove `test_submit_score_requires_game_plugin_selected` from `tests/test_scores.py` entirely (its whole function body) — the scenario it tested (creating a match with no game plugin selected, then trying to score it) is no longer reachable: `POST /api/matches` itself now fails first, which is exactly what the new `test_create_match_requires_game_plugin_selected` above covers instead.

- [ ] **Step 4: Add `alliance_count` to the scheduler-plugin contract**

In `plugins/schedulers/simple_random/plugin.py`, replace the whole file with:

```python
from __future__ import annotations

import random
from typing import Any


def generate_schedule(
    teams: list[dict[str, Any]],
    target_matches_per_team: int,
    teams_per_alliance: int,
    alliance_count: int,
    fields: list[dict[str, Any]],
    field_sets: list[dict[str, Any]],
    cross_session_pairing_history: dict[Any, dict[str, int]],
    constraints: dict[str, Any],
) -> list[dict[str, Any]]:
    excluded = set(constraints.get("excluded_team_ids", []))
    team_ids = [t["team_id"] for t in teams if t["team_id"] not in excluded]

    alliance_size = teams_per_alliance
    match_size = alliance_size * alliance_count
    if len(team_ids) < match_size:
        return []

    field_set_ids = sorted({fs["field_set_id"] for fs in field_sets})
    if not field_set_ids:
        return []

    total_matches = (len(team_ids) * target_matches_per_team) // match_size
    if total_matches < 1:
        return []

    stations = (
        ("red", "blue")
        if alliance_count == 2
        else tuple(f"alliance_{i + 1}" for i in range(alliance_count))
    )

    appearances = {team_id: 0 for team_id in team_ids}
    matches: list[dict[str, Any]] = []
    time_slot = 0
    matches_made = 0

    while matches_made < total_matches:
        used_this_slot: set[int] = set()
        for field_set_id in field_set_ids:
            if matches_made >= total_matches:
                break
            available = [t for t in team_ids if t not in used_this_slot]
            if len(available) < match_size:
                break

            available.sort(key=lambda t: (appearances[t], random.random()))
            chosen = available[:match_size]
            random.shuffle(chosen)
            for team_id in chosen:
                appearances[team_id] += 1
                used_this_slot.add(team_id)

            alliances = []
            remaining = list(chosen)
            for station in stations:
                alliances.append(
                    {"station": station, "team_ids": remaining[:alliance_size]}
                )
                remaining = remaining[alliance_size:]

            matches.append(
                {
                    "time_slot": time_slot,
                    "field_set_id": field_set_id,
                    "alliances": alliances,
                }
            )
            matches_made += 1

        if not used_this_slot:
            break
        time_slot += 1

    return matches
```

(The only real changes from the current file: `alliance_count` is a new parameter; `match_size = alliance_size * alliance_count` instead of `* 2`; `stations` is computed instead of hardcoded, preserving `("red", "blue")` for the `alliance_count == 2` case that every existing test relies on.)

In `plugins/schedulers/balanced/plugin.py`, make the same three changes — replace the function signature's parameter list:

```python
def generate_schedule(
    teams: list[dict[str, Any]],
    target_matches_per_team: int,
    teams_per_alliance: int,
    fields: list[dict[str, Any]],
    field_sets: list[dict[str, Any]],
    cross_session_pairing_history: dict[Any, dict[str, int]],
    constraints: dict[str, Any],
) -> list[dict[str, Any]]:
```

with:

```python
def generate_schedule(
    teams: list[dict[str, Any]],
    target_matches_per_team: int,
    teams_per_alliance: int,
    alliance_count: int,
    fields: list[dict[str, Any]],
    field_sets: list[dict[str, Any]],
    cross_session_pairing_history: dict[Any, dict[str, int]],
    constraints: dict[str, Any],
) -> list[dict[str, Any]]:
```

Replace:

```python
    alliance_size = teams_per_alliance
    match_size = alliance_size * 2
    if len(team_ids) < match_size:
        return []

    field_set_ids = sorted({fs["field_set_id"] for fs in field_sets})
    if not field_set_ids:
        return []

    total_matches = (len(team_ids) * target_matches_per_team) // match_size
    if total_matches < 1:
        return []
```

with:

```python
    alliance_size = teams_per_alliance
    match_size = alliance_size * alliance_count
    if len(team_ids) < match_size:
        return []

    field_set_ids = sorted({fs["field_set_id"] for fs in field_sets})
    if not field_set_ids:
        return []

    total_matches = (len(team_ids) * target_matches_per_team) // match_size
    if total_matches < 1:
        return []

    stations = (
        ("red", "blue")
        if alliance_count == 2
        else tuple(f"alliance_{i + 1}" for i in range(alliance_count))
    )
```

(`group_cost`/`record_group`'s `same_alliance = (i // alliance_size) == (j // alliance_size)` check is already generic with respect to how many alliances exist — it only needs to know each alliance's *size*, not the count — so it needs no change.) Finally, replace the two occurrences of:

```python
            alliances = []
            remaining = list(chosen)
            for station in ("red", "blue"):
```

with:

```python
            alliances = []
            remaining = list(chosen)
            for station in stations:
```

(There is only one such occurrence in `balanced/plugin.py` — the phrase "two occurrences" above refers to checking both shipped plugins; `simple_random`'s was already handled in the full-file replacement above.)

- [ ] **Step 5: Update `POST /api/schedule` to pass and validate `alliance_count`**

In `src/tournament_server/routers/schedule.py`, change `_validate_generated_schedule`'s signature and body. Replace:

```python
def _validate_generated_schedule(
    generated: list, valid_field_set_ids: set[int]
) -> None:
```

with:

```python
def _validate_generated_schedule(
    generated: list, valid_field_set_ids: set[int], alliance_count: int
) -> None:
```

Replace:

```python
        alliances = entry["alliances"]
        if not isinstance(alliances, list) or len(alliances) != 2:
            raise HTTPException(
                status_code=422, detail="Each match must have exactly 2 alliances"
            )
        stations = set()
        slot_teams = teams_by_slot.setdefault(entry["time_slot"], set())
        for alliance in alliances:
            if "station" not in alliance or "team_ids" not in alliance:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned an alliance missing 'station' or 'team_ids'",
                )
            if not alliance["team_ids"]:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned an alliance with no teams",
                )
            stations.add(alliance["station"])
            for team_id in alliance["team_ids"]:
                if team_id in slot_teams:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Scheduler plugin double-booked team {team_id} in "
                            f"time_slot {entry['time_slot']}"
                        ),
                    )
                slot_teams.add(team_id)
        if stations != {"red", "blue"}:
            raise HTTPException(
                status_code=422,
                detail=f"Alliance stations must be exactly red/blue, got {sorted(stations)}",
            )
```

with:

```python
        alliances = entry["alliances"]
        if not isinstance(alliances, list) or len(alliances) != alliance_count:
            raise HTTPException(
                status_code=422,
                detail=f"Each match must have exactly {alliance_count} alliances",
            )
        stations = set()
        slot_teams = teams_by_slot.setdefault(entry["time_slot"], set())
        for alliance in alliances:
            if "station" not in alliance or "team_ids" not in alliance:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned an alliance missing 'station' or 'team_ids'",
                )
            station = alliance["station"]
            if not isinstance(station, str) or not station:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned a non-string or empty station name",
                )
            if not alliance["team_ids"]:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned an alliance with no teams",
                )
            stations.add(station)
            for team_id in alliance["team_ids"]:
                if team_id in slot_teams:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Scheduler plugin double-booked team {team_id} in "
                            f"time_slot {entry['time_slot']}"
                        ),
                    )
                slot_teams.add(team_id)
        if len(stations) != len(alliances):
            raise HTTPException(
                status_code=422,
                detail="Alliance stations must be distinct within a match",
            )
```

In `generate_schedule` (the endpoint function), replace:

```python
    teams_per_alliance = match_format["teams_per_alliance"]
```

with:

```python
    teams_per_alliance = match_format["teams_per_alliance"]
    alliance_count = match_format["alliance_count"]
```

Replace the `generate_schedule` call to the scheduler plugin:

```python
        generated = scheduler_plugin.module.generate_schedule(
            teams=[{"team_id": t.id, "organization": t.organization} for t in teams],
            target_matches_per_team=payload.target_matches_per_team,
            teams_per_alliance=teams_per_alliance,
            fields=[{"field_id": f.id, "field_set_id": f.field_set_id} for f in fields],
            field_sets=[{"field_set_id": fs.id, "name": fs.name} for fs in field_sets],
            cross_session_pairing_history=pairing_history,
            constraints={"excluded_team_ids": payload.excluded_team_ids},
        )
```

with:

```python
        generated = scheduler_plugin.module.generate_schedule(
            teams=[{"team_id": t.id, "organization": t.organization} for t in teams],
            target_matches_per_team=payload.target_matches_per_team,
            teams_per_alliance=teams_per_alliance,
            alliance_count=alliance_count,
            fields=[{"field_id": f.id, "field_set_id": f.field_set_id} for f in fields],
            field_sets=[{"field_set_id": fs.id, "name": fs.name} for fs in field_sets],
            cross_session_pairing_history=pairing_history,
            constraints={"excluded_team_ids": payload.excluded_team_ids},
        )
```

Replace the `_validate_generated_schedule` call:

```python
    _validate_generated_schedule(generated, {fs.id for fs in field_sets})
```

with:

```python
    _validate_generated_schedule(generated, {fs.id for fs in field_sets}, alliance_count)
```

- [ ] **Step 6: Update the conformance tool's `generate_schedule` sample call**

In `src/tournament_server/plugin_registry/conformance.py`'s `_check_generate_schedule`, replace:

```python
    result = module.generate_schedule(
        teams=teams,
        target_matches_per_team=2,
        teams_per_alliance=2,
        fields=fields,
        field_sets=field_sets,
        cross_session_pairing_history={},
        constraints={"excluded_team_ids": []},
    )
```

with:

```python
    result = module.generate_schedule(
        teams=teams,
        target_matches_per_team=2,
        teams_per_alliance=2,
        alliance_count=2,
        fields=fields,
        field_sets=field_sets,
        cross_session_pairing_history={},
        constraints={"excluded_team_ids": []},
    )
```

- [ ] **Step 7: Run the affected tests, then the full suite**

Run: `.venv/bin/pytest tests/test_matches.py tests/test_scores.py tests/test_schedule.py tests/test_scheduler_plugins.py tests/test_plugin_conformance.py -v`
Expected: all pass. `test_submit_score_requires_game_plugin_selected` should no longer exist (not skipped, removed).

Run: `.venv/bin/pytest tests/ -v`
Expected: same total as Task 1's end (130), minus 1 removed test, plus 1 new test (`test_create_match_requires_game_plugin_selected`) — net unchanged at 130.

- [ ] **Step 8: Add a genericity test proving `alliance_count` isn't hardcoded**

Append to `tests/test_scheduler_plugins.py`:

```python
def test_simple_random_supports_alliance_count_other_than_two():
    plugin = load_plugin(SIMPLE_RANDOM_PLUGIN, SCHEDULER_PLUGIN_KIND)
    teams = [{"team_id": i, "organization": None} for i in range(1, 13)]
    field_sets = [{"field_set_id": 1, "name": "Main Fields"}]
    fields = [{"field_id": 1, "field_set_id": 1}]

    matches = plugin.module.generate_schedule(
        teams=teams,
        target_matches_per_team=1,
        teams_per_alliance=2,
        alliance_count=3,
        fields=fields,
        field_sets=field_sets,
        cross_session_pairing_history={},
        constraints={"excluded_team_ids": []},
    )

    assert matches
    for match in matches:
        assert len(match["alliances"]) == 3
        stations = {a["station"] for a in match["alliances"]}
        assert stations == {"alliance_1", "alliance_2", "alliance_3"}
        for alliance in match["alliances"]:
            assert len(alliance["team_ids"]) == 2
```

- [ ] **Step 9: Run the new test, then the full suite**

Run: `.venv/bin/pytest tests/test_scheduler_plugins.py -v`
Expected: all pass, including the new test.

Run: `.venv/bin/pytest tests/ -v`
Expected: 131 passed (130 + this one new test).

- [ ] **Step 10: Commit**

```bash
git add src/tournament_server/routers/matches.py \
        src/tournament_server/routers/schedule.py \
        plugins/schedulers/simple_random/plugin.py \
        plugins/schedulers/balanced/plugin.py \
        src/tournament_server/plugin_registry/conformance.py \
        tests/test_matches.py \
        tests/test_scores.py \
        tests/test_scheduler_plugins.py
git commit -m "Wire alliance_count through match creation and scheduling instead of hardcoding 2"
```

---

### Task 3: `cooperative-game` fixture plugin + conformance `rank_teams()` shape branching

**Files:**
- Create: `tests/fixtures/plugins/games/cooperative-game/manifest.json`
- Create: `tests/fixtures/plugins/games/cooperative-game/plugin.py`
- Modify: `src/tournament_server/plugin_registry/conformance.py`
- Modify: `tests/conftest.py`
- Test: `tests/test_plugin_conformance.py`
- Test: `tests/test_cli.py`

**Interfaces:**
- Produces: `tests/fixtures/plugins/games/cooperative-game/` (a real, complete `cooperative_score` game plugin: `alliance_count=2, teams_per_alliance=1, game_model="cooperative_score"`) — consumed by every later task's tests. A new `cooperative_client` pytest fixture in `conftest.py` — consumed by Tasks 4-7's tests.
- Consumes: `GAME_PLUGIN_KIND`, `load_plugin` (existing, from Task 1 of the prior phase).

- [ ] **Step 1: Write the fixture's manifest**

Create `tests/fixtures/plugins/games/cooperative-game/manifest.json`:

```json
{
  "name": "cooperative-game",
  "version": "1.0.0",
  "kind": "game",
  "display_name": "Cooperative Scoring Game"
}
```

- [ ] **Step 2: Write the fixture's plugin module**

Create `tests/fixtures/plugins/games/cooperative-game/plugin.py`:

```python
from __future__ import annotations

from typing import Any


def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 1,
        "autonomous_seconds": 15,
        "driver_seconds": 90,
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "cooperative_score",
    }


def scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "objects_scored",
            "label": "Objects Scored",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 40,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "alliance",
            "default": 0,
        },
    ]


def calculate_score(scoresheet: dict[str, Any]) -> int:
    return scoresheet.get("objects_scored", 0) * 2


def validate(scoresheet: dict[str, Any]) -> list[str]:
    violations = []
    if scoresheet.get("objects_scored", 0) > 40:
        violations.append("objects_scored cannot exceed 40")
    return violations


def rank_teams(team_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(
        team_results,
        key=lambda r: (-r["average_score"], -r["tiebreaker_seed"]),
    )
    return [{**r, "rank": i + 1} for i, r in enumerate(ordered)]


def skills_scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "objects_scored",
            "label": "Objects Scored",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 30,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "team",
            "default": 0,
        },
    ]


def calculate_skills_score(scoresheet: dict[str, Any]) -> int:
    return scoresheet.get("objects_scored", 0) * 2
```

(`alliance_count=2, teams_per_alliance=1` — two solo alliances sharing one match, matching the concrete `cooperative_score` scenario worked out in the spec. `rank_teams` sorts by `average_score`/`tiebreaker_seed` — the `cooperative_score` shape from the spec, not `win_points`/`strength_of_schedule`.)

- [ ] **Step 3: Thread `game_model` through `_run_game_checks` so `_check_rank_teams` can branch its sample shape**

In `src/tournament_server/plugin_registry/conformance.py`, replace `run_conformance_checks`'s dispatch and `_run_game_checks`:

```python
    if manifest.kind == "game":
        return _run_game_checks(plugin)
    return _run_scheduler_checks(plugin)


def _run_game_checks(plugin) -> ConformanceReport:
    checks: list[CheckResult] = [CheckResult("plugin loads", True)]

    checks.append(
        _safe_check("match_format() shape", lambda: _check_match_format(plugin.module))
    )
```

with:

```python
    if manifest.kind == "game":
        return _run_game_checks(plugin)
    return _run_scheduler_checks(plugin)


def _run_game_checks(plugin) -> ConformanceReport:
    checks: list[CheckResult] = [CheckResult("plugin loads", True)]

    match_format_check = _safe_check(
        "match_format() shape", lambda: _check_match_format(plugin.module)
    )
    checks.append(match_format_check)
    game_model = None
    if match_format_check.passed:
        try:
            game_model = plugin.module.match_format().get("game_model")
        except Exception:
            game_model = None
```

Then replace the final `rank_teams()` check line:

```python
    checks.append(
        _safe_check("rank_teams() structure", lambda: _check_rank_teams(plugin.module))
    )

    return ConformanceReport(plugin_name=plugin.name, checks=checks)
```

with:

```python
    checks.append(
        _safe_check(
            "rank_teams() structure",
            lambda: _check_rank_teams(plugin.module, game_model),
        )
    )

    return ConformanceReport(plugin_name=plugin.name, checks=checks)
```

- [ ] **Step 4: Branch `_check_rank_teams`'s sample shape on `game_model`**

Replace `_check_rank_teams` in the same file:

```python
def _check_rank_teams(module: Any) -> CheckResult:
    sample = [
        {
            "team_id": 1,
            "win_points": 4,
            "strength_of_schedule": 1.0,
            "tiebreaker_seed": 100,
        },
        {
            "team_id": 2,
            "win_points": 6,
            "strength_of_schedule": 2.0,
            "tiebreaker_seed": 200,
        },
        {
            "team_id": 3,
            "win_points": 4,
            "strength_of_schedule": 3.0,
            "tiebreaker_seed": 300,
        },
    ]
    result = module.rank_teams(sample)
```

with:

```python
def _check_rank_teams(module: Any, game_model: str | None) -> CheckResult:
    if game_model == "cooperative_score":
        sample = [
            {"team_id": 1, "average_score": 10.0, "matches_played": 3, "tiebreaker_seed": 100},
            {"team_id": 2, "average_score": 15.0, "matches_played": 3, "tiebreaker_seed": 200},
            {"team_id": 3, "average_score": 10.0, "matches_played": 2, "tiebreaker_seed": 300},
        ]
    else:
        sample = [
            {
                "team_id": 1,
                "win_points": 4,
                "strength_of_schedule": 1.0,
                "tiebreaker_seed": 100,
            },
            {
                "team_id": 2,
                "win_points": 6,
                "strength_of_schedule": 2.0,
                "tiebreaker_seed": 200,
            },
            {
                "team_id": 3,
                "win_points": 4,
                "strength_of_schedule": 3.0,
                "tiebreaker_seed": 300,
            },
        ]
    result = module.rank_teams(sample)
```

(The rest of the function — the ranks-are-1..N-with-no-gaps check and the team_ids-unchanged check — stays exactly as it is; it only inspects `rank`/`team_id` on the result, which both shapes share.)

- [ ] **Step 5: Wire `cooperative-game` into a new `cooperative_client` test fixture**

In `tests/conftest.py`, add below the existing `BALANCED_SCHEDULER_PLUGIN` constant:

```python
COOPERATIVE_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "cooperative-game"
)
```

Add a new fixture function, after the existing `client` fixture:

```python
@pytest.fixture()
def cooperative_client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    plugins_root = tmp_path / "plugins"

    games_target = plugins_root / "games" / "cooperative-game"
    games_target.parent.mkdir(parents=True)
    shutil.copytree(COOPERATIVE_GAME_PLUGIN, games_target)

    schedulers_target = plugins_root / "schedulers" / "simple_random"
    schedulers_target.parent.mkdir(parents=True)
    shutil.copytree(SIMPLE_RANDOM_SCHEDULER_PLUGIN, schedulers_target)

    balanced_target = plugins_root / "schedulers" / "balanced"
    balanced_target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(BALANCED_SCHEDULER_PLUGIN, balanced_target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    return TestClient(app)
```

(This is a second, independent client fixture — analogous to `client` but pre-seeding `cooperative-game` instead of `example-game`. It does **not** replace or modify `client`, since `test_list_game_plugins_shows_preseeded_plugin` in `test_plugins_router.py` asserts `client`'s registry has exactly one game plugin — adding a second game plugin to that fixture would break it.)

- [ ] **Step 6: Write conformance/CLI tests for the new fixture**

Add to `tests/test_plugin_conformance.py`:

```python
def test_cooperative_game_passes_conformance():
    from pathlib import Path

    from tournament_server.plugin_registry.conformance import run_conformance_checks

    cooperative_game = (
        Path(__file__).parent / "fixtures" / "plugins" / "games" / "cooperative-game"
    )
    report = run_conformance_checks(cooperative_game)
    assert report.passed, [c for c in report.checks if not c.passed]
```

Add to `tests/test_cli.py`:

```python
FIXTURE_COOPERATIVE_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "cooperative-game"
)


def test_test_plugin_command_exits_zero_on_cooperative_game(capsys):
    exit_code = main(["test-plugin", str(FIXTURE_COOPERATIVE_GAME_PLUGIN)])
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "All checks passed" in captured.out
```

- [ ] **Step 7: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_plugin_conformance.py tests/test_cli.py -v`
Expected: all pass, including the 2 new tests and every pre-existing test in both files (game_model-branching is additive; `example-game`'s conformance and CLI behavior is unchanged).

Run: `.venv/bin/pytest tests/ -v`
Expected: 133 passed (131 + these 2 new tests).

- [ ] **Step 8: Commit**

```bash
git add tests/fixtures/plugins/games/cooperative-game/manifest.json \
        tests/fixtures/plugins/games/cooperative-game/plugin.py \
        src/tournament_server/plugin_registry/conformance.py \
        tests/conftest.py \
        tests/test_plugin_conformance.py \
        tests/test_cli.py
git commit -m "Add cooperative-game fixture plugin and branch rank_teams() conformance by game_model"
```

---

### Task 4: Shared-scoresheet mirroring for `cooperative_score` matches

**Files:**
- Modify: `src/tournament_server/routers/scores.py`
- Test: `tests/test_cooperative_scoring.py` (new)

**Interfaces:**
- Consumes: `cooperative-game` fixture and `cooperative_client` (Task 3).
- Produces: nothing new later tasks call directly — this is the scoring-endpoint behavior later ranking tasks build test scenarios against.

- [ ] **Step 1: Add mirroring to `submit_score`**

In `src/tournament_server/routers/scores.py`, after the existing commit/refresh block and before the match-completion check, add the mirroring step. Replace:

```python
    db.commit()
    db.refresh(record)

    all_alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match_id)
    ).scalars().all()
```

with:

```python
    db.commit()
    db.refresh(record)

    game_model = plugin.module.match_format()["game_model"]
    all_alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match_id)
    ).scalars().all()

    if game_model == "cooperative_score":
        for other_alliance in all_alliances:
            if other_alliance.id == alliance_id:
                continue
            other_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == other_alliance.id)
            ).scalars().first()
            if other_record is None:
                other_record = ScoreRecord(
                    alliance_id=other_alliance.id,
                    plugin_name=plugin.name,
                    plugin_version=plugin.version,
                    data_json=record.data_json,
                    no_show=False,
                    dq=False,
                    sitting=False,
                    submitted_by_device=audit.current_actor.get(),
                    submitted_at=now,
                    saved_at=now,
                )
                db.add(other_record)
            else:
                other_record.data_json = record.data_json
                other_record.plugin_name = plugin.name
                other_record.plugin_version = plugin.version
        db.commit()
```

(Mirroring copies only `data_json`/`plugin_name`/`plugin_version`. A newly-created mirrored record defaults `no_show`/`dq`/`sitting` to `False` — an alliance with no prior submission of its own has no flags to preserve. An *existing* mirrored record's `no_show`/`dq`/`sitting` are left completely untouched, whether they were set by an earlier direct submission to that alliance or by an earlier mirror — this is what lets a post-hoc DQ submitted directly to one alliance survive a later mirror triggered by a correction submitted to the other.)

- [ ] **Step 2: Write the mirroring tests**

Create `tests/test_cooperative_scoring.py`:

```python
def _setup_cooperative_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    return match["id"], red_id, blue_id, t1, t2


def test_submitting_to_one_alliance_mirrors_data_and_completes_match(cooperative_client):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 20

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "completed"

    blue_response = client.get(f"/api/matches/{match_id}").json()
    blue_alliance = next(a for a in blue_response["alliances"] if a["id"] == blue_id)
    assert blue_alliance["team_ids"] == [t2]


def test_dq_on_one_alliance_does_not_affect_the_other(cooperative_client):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )

    dq_response = client.post(
        f"/api/matches/{match_id}/alliances/{blue_id}/score",
        json={"data": {"objects_scored": 10}, "dq": True},
    )
    assert dq_response.status_code == 200
    assert dq_response.json()["computed_score"] == 0

    red_after = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )
    assert red_after.status_code == 200
    assert red_after.json()["computed_score"] == 20
    assert red_after.json()["dq"] is False
```

(The second test's final re-submission to `red_id` proves mirroring from the DQ'd `blue_id` submission didn't leak `dq: True` onto `red_id` — if it had, `red_after.json()["dq"]` would be `True` and/or its `computed_score` would be `0`.)

- [ ] **Step 3: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_cooperative_scoring.py -v`
Expected: both pass.

Run: `.venv/bin/pytest tests/ -v`
Expected: 135 passed (133 + these 2).

- [ ] **Step 4: Commit**

```bash
git add src/tournament_server/routers/scores.py tests/test_cooperative_scoring.py
git commit -m "Mirror shared scoresheet data between a cooperative_score match's alliances"
```

---

### Task 5: `recompute_rankings`'s `cooperative_score` branch (plain average)

**Files:**
- Modify: `src/tournament_server/models/ranking.py`
- Modify: `src/tournament_server/schemas/ranking.py`
- Modify: `src/tournament_server/services/ranking.py`
- Test: `tests/test_cooperative_scoring.py`

**Interfaces:**
- Produces: `Ranking.average_score: float`, `Ranking.matches_played: int` — consumed by Task 6 (exclude/include) and Task 7 (cross-session). `_compute_cooperative_score_team_results(db, plugin, matches, config) -> list[dict]` in `services/ranking.py` — consumed by Task 7's `recompute_event_rankings`. `_compute_average_score(match_records, config) -> tuple[float, int]` — consumed by Task 6 (this task calls it with `config=None`; Task 6 makes it do real exclude/include work).
- Consumes: `cooperative-game` fixture, `cooperative_client` (Task 3).

- [ ] **Step 1: Add the new columns to `Ranking`**

Replace `src/tournament_server/models/ranking.py`'s class body:

```python
class Ranking(Base):
    __tablename__ = "rankings"
    __table_args__ = (
        UniqueConstraint(
            "session_id", "division_id", "team_id", name="uq_ranking_session_division_team"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    win_points: Mapped[int] = mapped_column(Integer, default=0)
    strength_of_schedule: Mapped[float] = mapped_column(Float, default=0.0)
    rank: Mapped[int] = mapped_column(Integer, default=0)
```

with:

```python
class Ranking(Base):
    __tablename__ = "rankings"
    __table_args__ = (
        UniqueConstraint(
            "session_id", "division_id", "team_id", name="uq_ranking_session_division_team"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    win_points: Mapped[int] = mapped_column(Integer, default=0)
    strength_of_schedule: Mapped[float] = mapped_column(Float, default=0.0)
    average_score: Mapped[float] = mapped_column(Float, default=0.0)
    matches_played: Mapped[int] = mapped_column(Integer, default=0)
    rank: Mapped[int] = mapped_column(Integer, default=0)
```

(`session_id` stays non-nullable for now — Task 7 makes it nullable, once cross-session ranking exists to need `NULL`. Making it nullable before anything writes a `NULL` row would be premature.)

- [ ] **Step 2: Expose the new columns in `RankingRead`**

Replace `src/tournament_server/schemas/ranking.py`'s class body:

```python
class RankingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    session_id: int
    division_id: int | None
    team_id: int
    win_points: int
    strength_of_schedule: float
    rank: int
```

with:

```python
class RankingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    session_id: int
    division_id: int | None
    team_id: int
    win_points: int
    strength_of_schedule: float
    average_score: float
    matches_played: int
    rank: int
```

- [ ] **Step 3: Restructure `recompute_rankings` to branch on `game_model`**

Replace the entire contents of `src/tournament_server/services/ranking.py` with:

```python
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin


def _compute_average_score(
    match_records: list[dict[str, Any]], config: Any
) -> tuple[float, int]:
    matches_played = len(match_records)
    if matches_played == 0:
        return 0.0, 0

    scores = [r["score"] for r in match_records]

    if config is None:
        return sum(scores) / matches_played, matches_played

    return _apply_ranking_configuration(match_records, scores, config), matches_played


def _apply_ranking_configuration(
    match_records: list[dict[str, Any]], scores: list[int], config: Any
) -> float:
    def droppable(record: dict[str, Any]) -> bool:
        if not record["no_show"] and not record["dq"]:
            return True
        if record["no_show"] and config.allow_drop_no_show:
            return True
        if record["dq"] and config.allow_drop_dq:
            return True
        return False

    if config.mode == "exclude":
        indices_by_score_asc = sorted(range(len(scores)), key=lambda i: scores[i])
        dropped: set[int] = set()
        for i in indices_by_score_asc:
            if len(dropped) >= config.count:
                break
            if droppable(match_records[i]):
                dropped.add(i)
        remaining = [scores[i] for i in range(len(scores)) if i not in dropped]
        if not remaining:
            return 0.0
        return sum(remaining) / len(remaining)

    # include mode: keep the top `count`, zero-pad the shortfall.
    kept = sorted(scores, reverse=True)[: config.count]
    total = sum(kept)
    return total / config.count


def _compute_cooperative_score_team_results(
    db: Session, plugin: LoadedPlugin, matches: list[Match], config: Any
) -> list[dict[str, Any]]:
    team_match_records: dict[int, list[dict[str, Any]]] = {}

    for match in matches:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().all()
        for alliance in alliances:
            score_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
            ).scalars().first()
            if score_record is None:
                continue
            effective_score = (
                0
                if (score_record.no_show or score_record.dq)
                else plugin.module.calculate_score(json.loads(score_record.data_json))
            )
            team_ids = [
                row.team_id
                for row in db.execute(
                    select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
                ).scalars().all()
            ]
            for team_id in team_ids:
                team_match_records.setdefault(team_id, []).append(
                    {
                        "score": effective_score,
                        "no_show": score_record.no_show,
                        "dq": score_record.dq,
                    }
                )

    if not team_match_records:
        return []

    team_ids = list(team_match_records.keys())
    teams = {
        team.id: team
        for team in db.execute(select(Team).where(Team.id.in_(team_ids))).scalars().all()
    }

    team_results = []
    for team_id, records in team_match_records.items():
        average_score, matches_played = _compute_average_score(records, config)
        team_results.append(
            {
                "team_id": team_id,
                "average_score": average_score,
                "matches_played": matches_played,
                "tiebreaker_seed": teams[team_id].tiebreaker_seed,
            }
        )
    return team_results


def recompute_rankings(
    db: Session, plugin: LoadedPlugin, session_id: int, division_id: int | None
) -> None:
    game_model = plugin.module.match_format()["game_model"]

    query = select(Match).where(
        Match.session_id == session_id, Match.status == "completed"
    )
    if division_id is None:
        query = query.where(Match.division_id.is_(None))
    else:
        query = query.where(Match.division_id == division_id)
    matches = db.execute(query).scalars().all()

    if game_model == "cooperative_score":
        team_results = _compute_cooperative_score_team_results(db, plugin, matches, None)
        if not team_results:
            return
        ranked = plugin.module.rank_teams(team_results)
        for entry in ranked:
            division_filter = (
                Ranking.division_id.is_(None)
                if division_id is None
                else Ranking.division_id == division_id
            )
            existing = db.execute(
                select(Ranking).where(
                    Ranking.session_id == session_id,
                    division_filter,
                    Ranking.team_id == entry["team_id"],
                )
            ).scalars().first()
            if existing is None:
                db.add(
                    Ranking(
                        session_id=session_id,
                        division_id=division_id,
                        team_id=entry["team_id"],
                        average_score=entry["average_score"],
                        matches_played=entry["matches_played"],
                        rank=entry["rank"],
                    )
                )
            else:
                existing.average_score = entry["average_score"]
                existing.matches_played = entry["matches_played"]
                existing.rank = entry["rank"]
        db.commit()
        return

    win_points: dict[int, int] = {}
    match_alliance_teams: dict[int, dict[int, list[int]]] = {}

    for match in matches:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().all()
        if len(alliances) != 2:
            continue

        alliance_teams: dict[int, list[int]] = {}
        alliance_scores: dict[int, int] = {}
        incomplete = False
        for alliance in alliances:
            team_ids = [
                row.team_id
                for row in db.execute(
                    select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
                )
                .scalars()
                .all()
            ]
            alliance_teams[alliance.id] = team_ids

            score_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
            ).scalars().first()
            if score_record is None:
                incomplete = True
                break
            if score_record.no_show or score_record.dq:
                alliance_scores[alliance.id] = 0
            else:
                alliance_scores[alliance.id] = plugin.module.calculate_score(
                    json.loads(score_record.data_json)
                )
        if incomplete:
            continue

        alliance_ids = list(alliance_teams.keys())
        score_a = alliance_scores[alliance_ids[0]]
        score_b = alliance_scores[alliance_ids[1]]
        if score_a > score_b:
            points = {alliance_ids[0]: 2, alliance_ids[1]: 0}
        elif score_b > score_a:
            points = {alliance_ids[0]: 0, alliance_ids[1]: 2}
        else:
            points = {alliance_ids[0]: 1, alliance_ids[1]: 1}

        for alliance_id, team_ids in alliance_teams.items():
            for team_id in team_ids:
                win_points[team_id] = win_points.get(team_id, 0) + points[alliance_id]

        match_alliance_teams[match.id] = alliance_teams

    if not win_points:
        return

    strength_of_schedule: dict[int, float] = {team_id: 0.0 for team_id in win_points}
    for alliance_teams in match_alliance_teams.values():
        alliance_ids = list(alliance_teams.keys())
        teams_a = alliance_teams[alliance_ids[0]]
        teams_b = alliance_teams[alliance_ids[1]]
        opponent_points_for_a = sum(win_points.get(t, 0) for t in teams_b)
        opponent_points_for_b = sum(win_points.get(t, 0) for t in teams_a)
        for team_id in teams_a:
            strength_of_schedule[team_id] += opponent_points_for_a
        for team_id in teams_b:
            strength_of_schedule[team_id] += opponent_points_for_b

    team_ids = list(win_points.keys())
    teams = {
        team.id: team
        for team in db.execute(select(Team).where(Team.id.in_(team_ids))).scalars().all()
    }

    team_results = [
        {
            "team_id": team_id,
            "win_points": win_points[team_id],
            "strength_of_schedule": strength_of_schedule[team_id],
            "tiebreaker_seed": teams[team_id].tiebreaker_seed,
        }
        for team_id in team_ids
    ]

    ranked = plugin.module.rank_teams(team_results)

    for entry in ranked:
        division_filter = (
            Ranking.division_id.is_(None)
            if division_id is None
            else Ranking.division_id == division_id
        )
        existing = db.execute(
            select(Ranking).where(
                Ranking.session_id == session_id,
                division_filter,
                Ranking.team_id == entry["team_id"],
            )
        ).scalars().first()
        if existing is None:
            db.add(
                Ranking(
                    session_id=session_id,
                    division_id=division_id,
                    team_id=entry["team_id"],
                    win_points=entry["win_points"],
                    strength_of_schedule=entry["strength_of_schedule"],
                    rank=entry["rank"],
                )
            )
        else:
            existing.win_points = entry["win_points"]
            existing.strength_of_schedule = entry["strength_of_schedule"]
            existing.rank = entry["rank"]

    db.commit()
```

(The `head_to_head` branch below the `if game_model == "cooperative_score": ... return` block is byte-for-byte the pre-existing algorithm, just now reached only when `game_model != "cooperative_score"`. `_apply_ranking_configuration` is written now, in full, even though this task always calls `_compute_average_score` with `config=None` — Task 6 is what starts passing a real `RankingConfiguration` row instead of `None`; writing the function complete now, rather than as a stub, avoids rewriting `_compute_average_score`'s signature twice.)

- [ ] **Step 4: Write the ranking test**

Append to `tests/test_cooperative_scoring.py`:

```python
def test_cooperative_score_ranking_is_average_no_win_loss(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    t3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]

    # Match 1: T1 (red) + T2 (blue) share a scoresheet scoring 20 total.
    match1 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red1 = next(a["id"] for a in match1["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match1['id']}/alliances/{red1}/score",
        json={"data": {"objects_scored": 10}},
    )

    # Match 2: T1 (red) + T3 (blue) share a scoresheet scoring 30 total.
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t3]},
            ],
        },
    ).json()
    red2 = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2}/score",
        json={"data": {"objects_scored": 15}},
    )

    response = client.get(f"/api/rankings?session_id={session_id}")
    assert response.status_code == 200
    rows = {row["team_id"]: row for row in response.json()}

    # T1 played both matches: average = (20 + 30) / 2 = 25.
    assert rows[t1]["average_score"] == 25.0
    assert rows[t1]["matches_played"] == 2
    assert rows[t1]["win_points"] == 0
    # T2 played only match 1: average = 20.
    assert rows[t2]["average_score"] == 20.0
    assert rows[t2]["matches_played"] == 1
    # T3 played only match 2: average = 30.
    assert rows[t3]["average_score"] == 30.0
    assert rows[t3]["matches_played"] == 1

    # rank_teams sorts by -average_score, so T3 (30) > T1 (25) > T2 (20).
    assert rows[t3]["rank"] == 1
    assert rows[t1]["rank"] == 2
    assert rows[t2]["rank"] == 3
```

- [ ] **Step 5: Run the test, then the full suite**

Run: `.venv/bin/pytest tests/test_cooperative_scoring.py -v`
Expected: all 3 pass.

Run: `.venv/bin/pytest tests/ -v`
Expected: 136 passed (135 + this one new test).

- [ ] **Step 6: Commit**

```bash
git add src/tournament_server/models/ranking.py \
        src/tournament_server/schemas/ranking.py \
        src/tournament_server/services/ranking.py \
        tests/test_cooperative_scoring.py
git commit -m "Add cooperative_score ranking branch: average score, per-alliance crediting"
```

---

### Task 6: `RankingConfiguration` — exclude/include ranking rules

**Files:**
- Create: `src/tournament_server/models/ranking_configuration.py`
- Modify: `src/tournament_server/models/__init__.py`
- Create: `src/tournament_server/schemas/ranking_configuration.py`
- Create: `src/tournament_server/routers/ranking_configuration.py`
- Modify: `src/tournament_server/services/ranking.py`
- Modify: `src/tournament_server/app.py`
- Test: `tests/test_ranking_configuration.py` (new)
- Test: `tests/test_cooperative_scoring.py`

**Interfaces:**
- Produces: `RankingConfiguration(id, event_id, division_id, mode, count, allow_drop_no_show, allow_drop_dq)`; `POST /api/ranking-configuration`, `GET /api/ranking-configuration`; `suggest_exclusion_count(total_matches: int) -> int` — consumed by Task 7 (the same configuration and helper apply to cross-session ranking).
- Consumes: `_compute_average_score`, `_apply_ranking_configuration` (Task 5, `services/ranking.py`).

- [ ] **Step 1: Write the `RankingConfiguration` model**

Create `src/tournament_server/models/ranking_configuration.py`:

```python
from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class RankingConfiguration(Base):
    __tablename__ = "ranking_configurations"
    __table_args__ = (
        UniqueConstraint(
            "event_id", "division_id", name="uq_ranking_config_event_division"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    mode: Mapped[str] = mapped_column(String(20))
    count: Mapped[int] = mapped_column(Integer)
    allow_drop_no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_drop_dq: Mapped[bool] = mapped_column(Boolean, default=False)
```

- [ ] **Step 2: Register the model**

In `src/tournament_server/models/__init__.py`, add the import `from tournament_server.models.ranking_configuration import RankingConfiguration` (insert alphabetically, after `ranking` and before `schedule_generation`) and add `"RankingConfiguration"` to `__all__` in the same alphabetical position.

- [ ] **Step 3: Write the schemas**

Create `src/tournament_server/schemas/ranking_configuration.py`:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class RankingConfigurationSet(BaseModel):
    division_id: int | None = None
    mode: str
    count: int
    allow_drop_no_show: bool = False
    allow_drop_dq: bool = False


class RankingConfigurationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    division_id: int | None
    mode: str
    count: int
    allow_drop_no_show: bool
    allow_drop_dq: bool
```

- [ ] **Step 4: Write the router**

Create `src/tournament_server/routers/ranking_configuration.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_the_event
from tournament_server.models.division import Division
from tournament_server.models.ranking_configuration import RankingConfiguration
from tournament_server.schemas.ranking_configuration import (
    RankingConfigurationRead,
    RankingConfigurationSet,
)

router = APIRouter(prefix="/api/ranking-configuration", tags=["ranking-configuration"])

VALID_MODES = {"exclude", "include"}


@router.post("", response_model=RankingConfigurationRead, status_code=201)
def set_ranking_configuration(
    payload: RankingConfigurationSet, db: Session = Depends(get_db)
) -> RankingConfiguration:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if payload.mode not in VALID_MODES:
        raise HTTPException(
            status_code=422, detail=f"mode must be one of {sorted(VALID_MODES)}"
        )
    if payload.count < 1:
        raise HTTPException(status_code=422, detail="count must be at least 1")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")

    division_filter = (
        RankingConfiguration.division_id.is_(None)
        if payload.division_id is None
        else RankingConfiguration.division_id == payload.division_id
    )
    existing = db.execute(
        select(RankingConfiguration).where(
            RankingConfiguration.event_id == event.id, division_filter
        )
    ).scalars().first()

    if existing is None:
        config = RankingConfiguration(
            event_id=event.id,
            division_id=payload.division_id,
            mode=payload.mode,
            count=payload.count,
            allow_drop_no_show=payload.allow_drop_no_show,
            allow_drop_dq=payload.allow_drop_dq,
        )
        db.add(config)
    else:
        existing.mode = payload.mode
        existing.count = payload.count
        existing.allow_drop_no_show = payload.allow_drop_no_show
        existing.allow_drop_dq = payload.allow_drop_dq
        config = existing

    db.commit()
    db.refresh(config)
    return config


@router.get("", response_model=RankingConfigurationRead)
def get_ranking_configuration(
    division_id: int | None = Query(None), db: Session = Depends(get_db)
) -> RankingConfiguration:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")

    division_filter = (
        RankingConfiguration.division_id.is_(None)
        if division_id is None
        else RankingConfiguration.division_id == division_id
    )
    config = db.execute(
        select(RankingConfiguration).where(
            RankingConfiguration.event_id == event.id, division_filter
        )
    ).scalars().first()
    if config is None:
        raise HTTPException(
            status_code=404, detail="No ranking configuration set for this division"
        )
    return config
```

- [ ] **Step 5: Wire the router into `app.py`**

In `src/tournament_server/app.py`, add `ranking_configuration` to the `from tournament_server.routers import (...)` block (alphabetically), and add `app.include_router(ranking_configuration.router)` alongside the other `app.include_router(...)` calls.

- [ ] **Step 6: Add the suggested-count helper**

In `src/tournament_server/services/ranking.py`, add this function (anywhere in the file — e.g. above `_compute_average_score`):

```python
def suggest_exclusion_count(total_matches: int) -> int:
    if total_matches >= 16:
        return 4
    if total_matches >= 12:
        return 3
    if total_matches >= 8:
        return 2
    if total_matches >= 4:
        return 1
    return 0
```

- [ ] **Step 7: Consult `RankingConfiguration` in `recompute_rankings`**

In `src/tournament_server/services/ranking.py`, add the import `from tournament_server.models.ranking_configuration import RankingConfiguration` and `from tournament_server.deps import get_the_event` at the top of the file. Replace the `cooperative_score` branch's team-results line:

```python
    if game_model == "cooperative_score":
        team_results = _compute_cooperative_score_team_results(db, plugin, matches, None)
```

with:

```python
    if game_model == "cooperative_score":
        event = get_the_event(db)
        config = None
        if event is not None:
            division_filter = (
                RankingConfiguration.division_id.is_(None)
                if division_id is None
                else RankingConfiguration.division_id == division_id
            )
            config = db.execute(
                select(RankingConfiguration).where(
                    RankingConfiguration.event_id == event.id, division_filter
                )
            ).scalars().first()
        team_results = _compute_cooperative_score_team_results(db, plugin, matches, config)
```

(`_compute_average_score`/`_apply_ranking_configuration` already handle `config=None` as "plain average, no drops" — this change is what starts passing a real configuration when one exists, with no other code path affected.)

- [ ] **Step 8: Write the tests**

Create `tests/test_ranking_configuration.py`:

```python
def test_set_and_get_ranking_configuration(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post(
        "/api/ranking-configuration",
        json={"mode": "exclude", "count": 1},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["mode"] == "exclude"
    assert body["count"] == 1
    assert body["division_id"] is None

    get_response = client.get("/api/ranking-configuration")
    assert get_response.status_code == 200
    assert get_response.json()["count"] == 1


def test_get_ranking_configuration_404_when_unset(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.get("/api/ranking-configuration")
    assert response.status_code == 404


def test_set_ranking_configuration_rejects_invalid_mode(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/ranking-configuration",
        json={"mode": "not-a-real-mode", "count": 1},
    )
    assert response.status_code == 422


def test_set_ranking_configuration_upserts(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/ranking-configuration", json={"mode": "exclude", "count": 1})
    response = client.post(
        "/api/ranking-configuration", json={"mode": "include", "count": 5}
    )
    assert response.status_code == 201
    assert response.json()["mode"] == "include"
    assert response.json()["count"] == 5

    listed = client.get("/api/ranking-configuration").json()
    assert listed["mode"] == "include"
    assert listed["count"] == 5
```

Append to `tests/test_cooperative_scoring.py`:

```python
def test_exclude_mode_drops_lowest_non_protected_match(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    client.post("/api/ranking-configuration", json={"mode": "exclude", "count": 1})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    scores = [30, 10, 20]
    for i, total in enumerate(scores, start=1):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [t1]},
                    {"station": "blue", "team_ids": [t2]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": total // 2}},
        )

    response = client.get(f"/api/rankings?session_id={session_id}")
    rows = {row["team_id"]: row for row in response.json()}

    # Lowest match (10) is dropped: average of (30, 20) = 25. matches_played
    # still reports all 3 real matches played, not the post-exclusion count.
    assert rows[t1]["average_score"] == 25.0
    assert rows[t1]["matches_played"] == 3


def test_include_mode_zero_pads_a_team_with_fewer_matches_than_count(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    client.post("/api/ranking-configuration", json={"mode": "include", "count": 3})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red}/score",
        json={"data": {"objects_scored": 15}},
    )

    response = client.get(f"/api/rankings?session_id={session_id}")
    rows = {row["team_id"]: row for row in response.json()}

    # T1 played 1 real match scoring 30; count=3 pads in 2 zero matches:
    # (30 + 0 + 0) / 3 = 10.
    assert rows[t1]["average_score"] == 10.0
    assert rows[t1]["matches_played"] == 1
```

- [ ] **Step 9: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_ranking_configuration.py tests/test_cooperative_scoring.py -v`
Expected: all pass.

Run: `.venv/bin/pytest tests/ -v`
Expected: 142 passed (136 + 4 in test_ranking_configuration.py + 2 in test_cooperative_scoring.py).

- [ ] **Step 10: Commit**

```bash
git add src/tournament_server/models/ranking_configuration.py \
        src/tournament_server/models/__init__.py \
        src/tournament_server/schemas/ranking_configuration.py \
        src/tournament_server/routers/ranking_configuration.py \
        src/tournament_server/services/ranking.py \
        src/tournament_server/app.py \
        tests/test_ranking_configuration.py \
        tests/test_cooperative_scoring.py
git commit -m "Add RankingConfiguration: exclude-lowest/include-highest-N ranking"
```

---

### Task 7: Cross-session (event-wide / league) ranking

**Files:**
- Modify: `src/tournament_server/models/ranking.py`
- Modify: `src/tournament_server/schemas/ranking.py`
- Modify: `src/tournament_server/services/ranking.py`
- Modify: `src/tournament_server/routers/scores.py`
- Modify: `src/tournament_server/routers/schedule.py`
- Modify: `src/tournament_server/routers/rankings.py`
- Test: `tests/test_cooperative_scoring.py`

**Interfaces:**
- Produces: `recompute_event_rankings(db, plugin, event_id, division_id) -> None`; `GET /api/rankings?event_wide=true`.
- Consumes: `_compute_cooperative_score_team_results`, `RankingConfiguration` lookup pattern (Task 5/6).

- [ ] **Step 1: Make `Ranking.session_id` nullable**

In `src/tournament_server/models/ranking.py`, change:

```python
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
```

to:

```python
    session_id: Mapped[int | None] = mapped_column(ForeignKey("sessions.id"), default=None)
```

In `src/tournament_server/schemas/ranking.py`, change:

```python
    session_id: int
```

to:

```python
    session_id: int | None
```

- [ ] **Step 2: Write `recompute_event_rankings`**

In `src/tournament_server/services/ranking.py`, add the import `from tournament_server.models.session import TournamentSession` at the top, and add this function (after `recompute_rankings`):

```python
def recompute_event_rankings(
    db: Session, plugin: LoadedPlugin, event_id: int, division_id: int | None
) -> None:
    game_model = plugin.module.match_format()["game_model"]
    if game_model != "cooperative_score":
        return

    session_ids = [
        row.id
        for row in db.execute(
            select(TournamentSession).where(TournamentSession.event_id == event_id)
        ).scalars().all()
    ]
    if not session_ids:
        return

    query = select(Match).where(
        Match.session_id.in_(session_ids), Match.status == "completed"
    )
    if division_id is None:
        query = query.where(Match.division_id.is_(None))
    else:
        query = query.where(Match.division_id == division_id)
    matches = db.execute(query).scalars().all()

    division_filter = (
        RankingConfiguration.division_id.is_(None)
        if division_id is None
        else RankingConfiguration.division_id == division_id
    )
    config = db.execute(
        select(RankingConfiguration).where(
            RankingConfiguration.event_id == event_id, division_filter
        )
    ).scalars().first()

    team_results = _compute_cooperative_score_team_results(db, plugin, matches, config)
    if not team_results:
        return
    ranked = plugin.module.rank_teams(team_results)

    for entry in ranked:
        ranking_division_filter = (
            Ranking.division_id.is_(None)
            if division_id is None
            else Ranking.division_id == division_id
        )
        existing = db.execute(
            select(Ranking).where(
                Ranking.session_id.is_(None),
                ranking_division_filter,
                Ranking.team_id == entry["team_id"],
            )
        ).scalars().first()
        if existing is None:
            db.add(
                Ranking(
                    session_id=None,
                    division_id=division_id,
                    team_id=entry["team_id"],
                    average_score=entry["average_score"],
                    matches_played=entry["matches_played"],
                    rank=entry["rank"],
                )
            )
        else:
            existing.average_score = entry["average_score"]
            existing.matches_played = entry["matches_played"]
            existing.rank = entry["rank"]

    db.commit()
```

- [ ] **Step 3: Call it alongside `recompute_rankings` when a `cooperative_score` score is submitted**

In `src/tournament_server/routers/scores.py`, add the import `from tournament_server.deps import get_db, get_game_plugin_for_event, get_the_event` (adding `get_the_event` to the existing import) and `from tournament_server.services.ranking import recompute_event_rankings, recompute_rankings` (adding `recompute_event_rankings`). Replace the final line of `submit_score`:

```python
    recompute_rankings(db, plugin, match.session_id, match.division_id)

    return _to_score_record_read(record, computed_score)
```

with:

```python
    recompute_rankings(db, plugin, match.session_id, match.division_id)
    event = get_the_event(db)
    if event is not None:
        recompute_event_rankings(db, plugin, event.id, match.division_id)

    return _to_score_record_read(record, computed_score)
```

(`recompute_event_rankings` itself no-ops for `head_to_head` — see Step 2 — so this call is safe to make unconditionally for every game model.)

- [ ] **Step 4: Also recompute event rankings after `DELETE /api/schedule`**

In `src/tournament_server/routers/schedule.py`, add `recompute_event_rankings` to the existing `from tournament_server.services.ranking import recompute_rankings` import. Replace `clear_schedule`'s final best-effort block:

```python
    event = get_the_event(db)
    if event is not None and event.game_plugin_name is not None:
        game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
        if game_plugin is not None:
            recompute_rankings(db, game_plugin, session_id, division_id)

    return {"matches_deleted": len(matches)}
```

with:

```python
    event = get_the_event(db)
    if event is not None and event.game_plugin_name is not None:
        game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
        if game_plugin is not None:
            recompute_rankings(db, game_plugin, session_id, division_id)
            recompute_event_rankings(db, game_plugin, event.id, division_id)

    return {"matches_deleted": len(matches)}
```

- [ ] **Step 5: Add the `event_wide` query option to `GET /api/rankings`**

Replace `src/tournament_server/routers/rankings.py`'s `get_rankings`:

```python
@router.get("", response_model=list[RankingRead])
def get_rankings(
    session_id: int = Depends(get_session_id),
    division_id: int | None = Query(None),
    db: Session = Depends(get_db),
) -> list[Ranking]:
    query = select(Ranking).where(Ranking.session_id == session_id).order_by(Ranking.rank)
    if division_id is None:
        query = query.where(Ranking.division_id.is_(None))
    else:
        query = query.where(Ranking.division_id == division_id)
    return list(db.execute(query).scalars().all())
```

with:

```python
@router.get("", response_model=list[RankingRead])
def get_rankings(
    division_id: int | None = Query(None),
    event_wide: bool = Query(False),
    session_id: int | None = Query(None),
    db: Session = Depends(get_db),
) -> list[Ranking]:
    if event_wide:
        query = select(Ranking).where(Ranking.session_id.is_(None)).order_by(Ranking.rank)
    else:
        resolved_session_id = (
            session_id if session_id is not None else get_session_id(session_id, db)
        )
        query = (
            select(Ranking)
            .where(Ranking.session_id == resolved_session_id)
            .order_by(Ranking.rank)
        )
    if division_id is None:
        query = query.where(Ranking.division_id.is_(None))
    else:
        query = query.where(Ranking.division_id == division_id)
    return list(db.execute(query).scalars().all())
```

(`get_session_id` is still imported and used directly rather than via `Depends`, since `session_id`'s resolution now needs to be conditional on `event_wide` — calling it as a plain function with the same two arguments it already takes works identically to how FastAPI would have called it.)

- [ ] **Step 6: Write the cross-session test**

Append to `tests/test_cooperative_scoring.py`:

```python
def test_event_wide_ranking_aggregates_across_sessions(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]

    session_scores = {"Session 1": 20, "Session 2": 40}
    for label, total in session_scores.items():
        session_id = client.post("/api/sessions", json={"label": label}).json()["id"]
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 1,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [t1]},
                    {"station": "blue", "team_ids": [t2]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": total // 2}},
        )

    response = client.get("/api/rankings?event_wide=true")
    assert response.status_code == 200
    rows = {row["team_id"]: row for row in response.json()}

    # Average across both sessions: (20 + 40) / 2 = 30.
    assert rows[t1]["average_score"] == 30.0
    assert rows[t1]["matches_played"] == 2
    assert rows[t1]["session_id"] is None
```

- [ ] **Step 7: Run the test, then the full suite**

Run: `.venv/bin/pytest tests/test_cooperative_scoring.py -v`
Expected: all pass, including this new test.

Run: `.venv/bin/pytest tests/ -v`
Expected: 143 passed (142 + this one new test).

- [ ] **Step 8: Commit**

```bash
git add src/tournament_server/models/ranking.py \
        src/tournament_server/schemas/ranking.py \
        src/tournament_server/services/ranking.py \
        src/tournament_server/routers/scores.py \
        src/tournament_server/routers/schedule.py \
        src/tournament_server/routers/rankings.py \
        tests/test_cooperative_scoring.py
git commit -m "Add cross-session (event-wide/league) ranking aggregation for cooperative_score"
```

---

### Task 8: Documentation

**Files:**
- Modify: `server/CLAUDE.md` (repo-relative path: `CLAUDE.md` from the `server/` directory this plan's Global Constraints assume as CWD)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (documentation only).

- [ ] **Step 1: Update the "Match & scoring" section for `game_model`/`alliance_count`**

In `CLAUDE.md`'s "## Match & scoring" section, after the existing paragraph about win-point allocation (the one starting "Win-point allocation (2/1/0 for win/tie/loss)..."), add:

```markdown
A game plugin declares `game_model` in `match_format()`: `head_to_head`
(everything above — adversarial alliances, win/tie/loss ranking) or
`cooperative_score` (alliances share one combined outcome, no winner,
ranking is by average score — see the next section). `alliance_count`
(also declared in `match_format()`) is read everywhere a match's alliance
count matters — `POST /api/matches`, the scheduler-plugin contract, and
`POST /api/schedule`'s structural validation — instead of being hardcoded,
even though both game models shipped so far declare `alliance_count: 2`.
```

- [ ] **Step 2: Add a "Cooperative scoring" section**

After the "## Match & scoring" section, add a new section:

```markdown
## Cooperative scoring

A `cooperative_score` match's alliances aren't adversarial — they share
one physical outcome. Submitting a score to either alliance via the
existing scoring endpoint mirrors the raw scoresheet data (not the
`no_show`/`dq`/`sitting` flags) onto the match's other alliance, so both
end up scored identically unless one is independently marked `no_show` or
`dq` afterward (a post-hoc DQ ruling is just a second submission directly
to that one alliance with `dq: true` — see `routers/scores.py`'s
`submit_score`).

Qualification ranking for `cooperative_score` is average score, not
win/tie/loss — each alliance in a completed match is credited
independently to its own member teams (so a DQ'd alliance's teams get `0`
for that match while the other alliance's teams keep their real score).
`Ranking.average_score`/`matches_played` hold this; `win_points`/
`strength_of_schedule` stay at their defaults and are meaningless for this
game model. A game plugin's `rank_teams()` receives a different
`team_results` shape depending on its declared `game_model` — see
`services/ranking.py`'s `_compute_cooperative_score_team_results`.

`RankingConfiguration` (`POST`/`GET /api/ranking-configuration`, one per
event/division) lets an organizer exclude a team's lowest N matches or
keep only their highest N (zero-padding the shortfall if they played
fewer than N), with separate toggles for whether `no_show`/`dq` matches
are eligible to be excluded. It's consulted only for `cooperative_score`
ranking — `head_to_head` has no concept of dropping a match.

`GET /api/rankings?event_wide=true` returns standings aggregated across
every session in the event (a `Ranking` row with `session_id: null`),
recomputed alongside the normal per-session ranking whenever a
`cooperative_score` score is submitted or a schedule is cleared. This is
what makes a multi-session league's overall standings work; `head_to_head`
never populates this (`recompute_event_rankings` no-ops for it).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document game_model, cooperative scoring, and ranking configuration"
```
