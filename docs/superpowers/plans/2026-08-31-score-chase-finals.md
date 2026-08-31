# Score Chase Finals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the score-chase finals format end to end — persistent 2-team pair formation (captain-pick or seed-pairing), sequential worst-to-best runs with just-in-time match creation, field allocation, and final-score ranking.

**Architecture:** New `FinalsBracket`/`BracketAlliance`/`BracketAllianceTeam`/`FinalsResult` models; `POST /api/finals/start` forms the persistent pairs and (for `score_chase`) kicks off the first run; the existing score-submission endpoint gains a branch that recognizes a finals match and creates the next run instead of touching qualification rankings. Single-elimination (`finals_format: "single_elimination"`) is out of scope for this plan — the contract accepts the value, but starting a bracket for it returns a clear "not yet implemented" error until a follow-up plan adds that engine.

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy 2.0, SQLite, Pydantic v2, pytest.

**Spec:** `docs/superpowers/specs/2026-08-31-finals-and-elimination-brackets-design.md` (the "Phase 6 spec" — covers both finals formats; this plan implements only the `score_chase` path, §5 and the shared parts of §2/§3/§6/§7). Also read `docs/superpowers/specs/2026-08-30-alliance-count-and-game-model-design.md` (Phase 5, `game_model`/`alliance_count` foundation this plan builds on) and `docs/superpowers/specs/2026-08-29-qualification-and-practice-scheduling-design.md` (Phase 4, the `Field`/`FieldSet` model and round-robin field-assignment pattern this plan reuses).

## Global Constraints

- No brand names anywhere (code, comments, docs, file names, user-facing text) — master spec §0.
- Python 3.11+, FastAPI, SQLAlchemy 2.0 synchronous `Mapped`/`mapped_column` style, one SQLite file per event — matches existing codebase.
- No Alembic/migrations — this plan adds new tables and new nullable columns on `Match`; a pre-this-plan database is recreated (delete the `.db` file), not migrated, consistent with every prior phase.
- A finals pair is always exactly 2 teams — not a general N-team-alliance mechanism (spec §1's explicit scope decision).
- `single_elimination` is a valid **declared** value for `finals_format` (both fixture games may declare either value, and the conformance checker accepts either) but has **no engine** in this plan — `POST /api/finals/start` must explicitly reject it with a clear error, not silently accept and leave a broken bracket.
- All new endpoints return proper 404/422/409 errors via `HTTPException`, validated before any DB write — the pattern already established throughout this codebase.
- Field allocation for a finals bracket's dynamically-created matches reuses Phase 4's exact round-robin-within-one-`FieldSet` algorithm (`routers/schedule.py`'s `next_field_index` pattern), just invoked once per match instead of once per batch.

---

### Task 1: `match_format()` contract additions — `alliance_selection`, `finals_format`

**Files:**
- Modify: `src/tournament_server/plugin_registry/conformance.py`
- Modify: `tests/fixtures/plugins/games/example-game/plugin.py`
- Modify: `tests/fixtures/plugins/games/cooperative-game/plugin.py`
- Test: `tests/test_plugin_conformance.py`

**Interfaces:**
- Produces: `match_format()`'s required-keys set now includes `"alliance_selection"` (`"captain_pick"` | `"seed_pairing"`) and `"finals_format"` (`"single_elimination"` | `"score_chase"`) — consumed by every later task.
- Consumes: nothing new.

- [ ] **Step 1: Declare both new keys on both fixture games**

In `tests/fixtures/plugins/games/example-game/plugin.py`, change:

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
        "alliance_selection": "captain_pick",
        "finals_format": "single_elimination",
    }
```

In `tests/fixtures/plugins/games/cooperative-game/plugin.py`, change:

```python
def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 1,
        "autonomous_seconds": 15,
        "driver_seconds": 90,
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "cooperative_score",
    }
```

to:

```python
def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 1,
        "autonomous_seconds": 15,
        "driver_seconds": 90,
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "cooperative_score",
        "alliance_selection": "seed_pairing",
        "finals_format": "score_chase",
    }
```

- [ ] **Step 2: Update `_check_match_format` to require and validate both new keys**

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

with:

```python
def _check_match_format(module: Any) -> CheckResult:
    result = module.match_format()
    required_keys = {
        "alliance_count",
        "teams_per_alliance",
        "autonomous_seconds",
        "driver_seconds",
        "round_types",
        "game_model",
        "alliance_selection",
        "finals_format",
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
    if result["alliance_selection"] not in VALID_ALLIANCE_SELECTIONS:
        return CheckResult(
            "match_format() shape",
            False,
            f"alliance_selection must be one of {sorted(VALID_ALLIANCE_SELECTIONS)}, "
            f"got {result['alliance_selection']!r}",
        )
    if result["finals_format"] not in VALID_FINALS_FORMATS:
        return CheckResult(
            "match_format() shape",
            False,
            f"finals_format must be one of {sorted(VALID_FINALS_FORMATS)}, got "
            f"{result['finals_format']!r}",
        )
    return CheckResult("match_format() shape", True)
```

Add the two new constants right below the existing `VALID_GAME_MODELS = {"head_to_head", "cooperative_score"}` line:

```python
VALID_ALLIANCE_SELECTIONS = {"captain_pick", "seed_pairing"}
VALID_FINALS_FORMATS = {"single_elimination", "score_chase"}
```

- [ ] **Step 3: Write the tests**

Add to `tests/test_plugin_conformance.py` (mirroring the existing `test_match_format_requires_game_model`/`test_match_format_rejects_invalid_game_model` tests in the same file — read them first to match the exact copy/replace-based fixture-corruption technique they use):

```python
def test_match_format_requires_alliance_selection(tmp_path):
    import json
    import shutil

    from tournament_server.plugin_registry.conformance import run_conformance_checks

    broken_dir = tmp_path / "missing-alliance-selection"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, broken_dir)
    manifest = json.loads((broken_dir / "manifest.json").read_text())
    manifest["name"] = "missing-alliance-selection"
    (broken_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (broken_dir / "plugin.py").read_text()
    broken_text = plugin_text.replace(
        '"alliance_selection": "captain_pick",\n        ', ""
    )
    assert broken_text != plugin_text, "test fixture setup did not find the line to remove"
    (broken_dir / "plugin.py").write_text(broken_text)

    report = run_conformance_checks(broken_dir)
    match_format_check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not match_format_check.passed
    assert "alliance_selection" in match_format_check.message


def test_match_format_rejects_invalid_finals_format(tmp_path):
    import json
    import shutil

    from tournament_server.plugin_registry.conformance import run_conformance_checks

    broken_dir = tmp_path / "bad-finals-format"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, broken_dir)
    manifest = json.loads((broken_dir / "manifest.json").read_text())
    manifest["name"] = "bad-finals-format"
    (broken_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (broken_dir / "plugin.py").read_text()
    broken_text = plugin_text.replace(
        '"finals_format": "single_elimination"', '"finals_format": "not-a-real-format"'
    )
    assert broken_text != plugin_text, "test fixture setup did not find the line to replace"
    (broken_dir / "plugin.py").write_text(broken_text)

    report = run_conformance_checks(broken_dir)
    match_format_check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not match_format_check.passed
```

- [ ] **Step 4: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_plugin_conformance.py -v`
Expected: all pass, including the 2 new tests and every pre-existing test in that file (both fixture games now declare 2 more required keys; `_write_variant_plugin`-based tests in this file already tolerate `match_format() shape` failing for unrelated reasons, per this file's existing pattern — verify by reading the file before assuming, don't guess).

Run: `.venv/bin/pytest tests/ -v`
Expected: same total as the current baseline (150 passed), plus these 2 new tests = 152.

- [ ] **Step 5: Commit**

```bash
git add src/tournament_server/plugin_registry/conformance.py \
        tests/fixtures/plugins/games/example-game/plugin.py \
        tests/fixtures/plugins/games/cooperative-game/plugin.py \
        tests/test_plugin_conformance.py
git commit -m "Add alliance_selection and finals_format to the match_format() contract"
```

---

### Task 2: `FinalsBracket`/`BracketAlliance`/`BracketAllianceTeam` models + `POST /api/finals/start` + `GET /api/finals/{id}`

**Files:**
- Create: `src/tournament_server/models/finals_bracket.py`
- Create: `src/tournament_server/models/bracket_alliance.py`
- Modify: `src/tournament_server/models/__init__.py`
- Create: `src/tournament_server/schemas/finals.py`
- Create: `src/tournament_server/routers/finals.py`
- Modify: `src/tournament_server/app.py`
- Test: `tests/test_finals.py` (new)

**Interfaces:**
- Produces: `FinalsBracket(id, session_id, division_id, field_set_id, format, bracket_size, wins_to_advance, status, next_field_index)`; `BracketAlliance(id, bracket_id, seed)`; `BracketAllianceTeam(id, bracket_alliance_id, team_id)`; `POST /api/finals/start`, `GET /api/finals/{id}` — consumed by Task 3 (pick endpoint, same router file) and Task 4 (score-chase run creation, reads these models and `next_field_index`).
- Consumes: `get_the_event`, `get_game_plugin_for_event` (existing, `deps.py`); `Ranking` (existing, Phase 5) for seeding; `FieldSet`/`Field` (existing, Phase 4) for field allocation setup.

- [ ] **Step 1: Write the `FinalsBracket` model**

Create `src/tournament_server/models/finals_bracket.py`:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class FinalsBracket(Base):
    __tablename__ = "finals_brackets"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    field_set_id: Mapped[int] = mapped_column(ForeignKey("field_sets.id"))
    format: Mapped[str] = mapped_column(String(20))
    bracket_size: Mapped[int] = mapped_column(Integer)
    wins_to_advance: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(30), default="selecting_alliances")
    next_field_index: Mapped[int] = mapped_column(Integer, default=0)
```

(`next_field_index` is the running round-robin counter for field assignment — incremented each time a match is created for this bracket, wrapping via modulo against the field set's field count. Storing it directly on the bracket avoids re-deriving "how many matches has this bracket created so far" from scratch on every new match.)

- [ ] **Step 2: Write the `BracketAlliance`/`BracketAllianceTeam` models**

Create `src/tournament_server/models/bracket_alliance.py`:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class BracketAlliance(Base):
    __tablename__ = "bracket_alliances"

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    seed: Mapped[int] = mapped_column(Integer)


class BracketAllianceTeam(Base):
    __tablename__ = "bracket_alliance_teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_alliance_id: Mapped[int] = mapped_column(ForeignKey("bracket_alliances.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
```

- [ ] **Step 3: Register all three models**

Replace `src/tournament_server/models/__init__.py`'s contents with:

```python
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.ranking import Ranking
from tournament_server.models.ranking_configuration import RankingConfiguration
from tournament_server.models.schedule_generation import ScheduleGeneration
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team

__all__ = [
    "Alliance",
    "AllianceTeam",
    "BracketAlliance",
    "BracketAllianceTeam",
    "Division",
    "Event",
    "Field",
    "FieldSet",
    "FinalsBracket",
    "Match",
    "Ranking",
    "RankingConfiguration",
    "ScheduleGeneration",
    "ScoreRecord",
    "SessionParticipation",
    "TournamentSession",
    "Team",
]
```

- [ ] **Step 4: Write the schemas**

Create `src/tournament_server/schemas/finals.py`:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FinalsStartRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    bracket_size: int
    wins_to_advance: int | None = None
    field_set_id: int | None = None


class BracketAllianceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    seed: int
    team_ids: list[int]


class FinalsRunRead(BaseModel):
    match_id: int
    bracket_alliance_id: int
    status: str
    score: int | None


class FinalsResultRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    bracket_alliance_id: int
    score: int
    rank: int


class FinalsBracketRead(BaseModel):
    id: int
    session_id: int
    division_id: int | None
    field_set_id: int
    format: str
    bracket_size: int
    wins_to_advance: int
    status: str
    alliances: list[BracketAllianceRead]
    runs: list[FinalsRunRead]
    results: list[FinalsResultRead]


class FinalsPickRequest(BaseModel):
    captain_bracket_alliance_id: int
    partner_team_id: int
```

(`runs`/`results` are always present in the response shape from this task onward, even though this task's own `POST /api/finals/start`/`GET` never populate them with real data yet — they're always empty lists until Task 4/5 add real runs. This avoids a schema change later.)

- [ ] **Step 5: Write the router — `POST /api/finals/start` and `GET /api/finals/{id}`**

Create `src/tournament_server/routers/finals.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_game_plugin_for_event, get_the_event
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.schemas.finals import (
    BracketAllianceRead,
    FinalsBracketRead,
    FinalsPickRequest,
    FinalsResultRead,
    FinalsRunRead,
    FinalsStartRequest,
)

router = APIRouter(prefix="/api/finals", tags=["finals"])


def _to_bracket_alliance_read(alliance: BracketAlliance, db: Session) -> BracketAllianceRead:
    team_ids = [
        row.team_id
        for row in db.execute(
            select(BracketAllianceTeam).where(
                BracketAllianceTeam.bracket_alliance_id == alliance.id
            )
        ).scalars().all()
    ]
    return BracketAllianceRead(id=alliance.id, seed=alliance.seed, team_ids=team_ids)


def _to_finals_bracket_read(
    bracket: FinalsBracket, db: Session, game_plugin
) -> FinalsBracketRead:
    alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket.id)
        .order_by(BracketAlliance.seed)
    ).scalars().all()

    matches = db.execute(
        select(Match).where(Match.finals_bracket_id == bracket.id)
    ).scalars().all()
    runs = []
    for match in matches:
        score_record = db.execute(
            select(ScoreRecord).where(ScoreRecord.alliance_id.in_(
                select(BracketAllianceTeam.bracket_alliance_id).where(False)
            ))
        ).scalars().first()  # placeholder line replaced in Task 4
        runs.append(
            FinalsRunRead(
                match_id=match.id,
                bracket_alliance_id=match.bracket_alliance_id,
                status=match.status,
                score=None,
            )
        )

    return FinalsBracketRead(
        id=bracket.id,
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        field_set_id=bracket.field_set_id,
        format=bracket.format,
        bracket_size=bracket.bracket_size,
        wins_to_advance=bracket.wins_to_advance,
        status=bracket.status,
        alliances=[_to_bracket_alliance_read(a, db) for a in alliances],
        runs=runs,
        results=[],
    )


@router.post("/start", response_model=FinalsBracketRead, status_code=201)
def start_finals(
    payload: FinalsStartRequest, request: Request, db: Session = Depends(get_db)
) -> FinalsBracketRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")

    game_plugin = get_game_plugin_for_event(request, db)
    match_format = game_plugin.module.match_format()
    finals_format = match_format["finals_format"]
    alliance_selection = match_format["alliance_selection"]

    if finals_format == "single_elimination":
        raise HTTPException(
            status_code=422,
            detail=(
                "single_elimination finals are not implemented yet — "
                "only score_chase is supported"
            ),
        )

    if payload.bracket_size < 2:
        raise HTTPException(status_code=422, detail="bracket_size must be at least 2")
    if payload.bracket_size % 2 != 0:
        raise HTTPException(
            status_code=422,
            detail="bracket_size must be even (a finals pair is always 2 teams)",
        )

    field_set_id = payload.field_set_id
    if field_set_id is None:
        existing_sets = db.execute(
            select(FieldSet).where(FieldSet.session_id == payload.session_id)
        ).scalars().all()
        if len(existing_sets) == 0:
            raise HTTPException(
                status_code=422, detail="Session has no FieldSets configured"
            )
        if len(existing_sets) > 1:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Multiple FieldSets exist for this session; field_set_id "
                    "must be specified"
                ),
            )
        field_set_id = existing_sets[0].id
    else:
        field_set = db.get(FieldSet, field_set_id)
        if field_set is None or field_set.session_id != payload.session_id:
            raise HTTPException(status_code=404, detail="FieldSet not found")

    ranking_query = select(Ranking).where(Ranking.session_id == payload.session_id)
    if payload.division_id is None:
        ranking_query = ranking_query.where(Ranking.division_id.is_(None))
    else:
        ranking_query = ranking_query.where(Ranking.division_id == payload.division_id)
    ranking_query = ranking_query.order_by(Ranking.rank)
    ranked = db.execute(ranking_query).scalars().all()

    needed = payload.bracket_size * 2 if alliance_selection == "seed_pairing" else payload.bracket_size
    if len(ranked) < needed:
        raise HTTPException(
            status_code=422,
            detail=f"Only {len(ranked)} ranked teams available, need {needed}",
        )
    top_teams = ranked[:needed]

    bracket = FinalsBracket(
        session_id=payload.session_id,
        division_id=payload.division_id,
        field_set_id=field_set_id,
        format=finals_format,
        bracket_size=payload.bracket_size,
        wins_to_advance=1,
        status="selecting_alliances",
    )
    db.add(bracket)
    db.flush()

    if alliance_selection == "seed_pairing":
        for i in range(0, len(top_teams), 2):
            alliance = BracketAlliance(bracket_id=bracket.id, seed=(i // 2) + 1)
            db.add(alliance)
            db.flush()
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=top_teams[i].team_id
                )
            )
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=top_teams[i + 1].team_id
                )
            )
        bracket.status = "in_progress"
    else:
        for i, ranking in enumerate(top_teams):
            alliance = BracketAlliance(bracket_id=bracket.id, seed=i + 1)
            db.add(alliance)
            db.flush()
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=ranking.team_id
                )
            )

    db.commit()
    db.refresh(bracket)
    return _to_finals_bracket_read(bracket, db, game_plugin)


@router.get("/{bracket_id}", response_model=FinalsBracketRead)
def get_finals(
    bracket_id: int, request: Request, db: Session = Depends(get_db)
) -> FinalsBracketRead:
    bracket = db.get(FinalsBracket, bracket_id)
    if bracket is None:
        raise HTTPException(status_code=404, detail="Finals bracket not found")
    game_plugin = get_game_plugin_for_event(request, db)
    return _to_finals_bracket_read(bracket, db, game_plugin)
```

(The `_to_finals_bracket_read` helper's `runs` loop has a deliberately inert placeholder query — `select(BracketAllianceTeam.bracket_alliance_id).where(False)` always returns nothing — since `Match.bracket_alliance_id` doesn't exist as a column until Task 4 adds it. This task's own tests never create any `Match` rows for a bracket, so this code path is unreached by anything in THIS task — Task 4 replaces this whole loop body with real score-lookup logic once the column and the run-creation logic both exist. This is the one deliberate incremental-build seam in this plan; every other piece of code in this task is complete and real.)

- [ ] **Step 6: Wire the router into `app.py`**

In `src/tournament_server/app.py`, add `finals` to the `from tournament_server.routers import (...)` block (alphabetically), and add `app.include_router(finals.router)` alongside the other `app.include_router(...)` calls.

- [ ] **Step 7: Write the tests**

Create `tests/test_finals.py`:

```python
def _setup_ranked_teams(client, count: int) -> tuple[int, list[int]]:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        for i in range(count)
    ]
    return session_id, team_ids


def _rank_teams_directly(cooperative_client, session_id: int, team_ids: list[int]) -> None:
    # Score each team a distinct, descending amount so ranks are deterministic
    # (team_ids[0] ends up rank 1, etc.) — one solo match per team via the
    # cooperative-game fixture's alliance_count=2 shape, scoring only the
    # "red" alliance for each (mirroring copies it to "blue" automatically).
    for i, team_id in enumerate(team_ids):
        match = cooperative_client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 1000 + i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        cooperative_client.post(
            f"/api/matches/{match['id']}/alliances/{red_id}/score",
            json={"data": {"objects_scored": (len(team_ids) - i) * 10}},
        )


def test_start_finals_seed_pairing_forms_alliances_immediately(cooperative_client):
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

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "in_progress"
    assert len(body["alliances"]) == 2
    assert body["alliances"][0]["seed"] == 1
    assert set(body["alliances"][0]["team_ids"]) == {team_ids[0], team_ids[1]}
    assert body["alliances"][1]["seed"] == 2
    assert set(body["alliances"][1]["team_ids"]) == {team_ids[2], team_ids[3]}


def test_start_finals_rejects_single_elimination(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": 2},
    )
    assert response.status_code == 422
    assert "not implemented" in response.json()["detail"]


def test_start_finals_rejects_odd_bracket_size(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _setup_ranked_teams(client, 4)
    _rank_teams_directly(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 3},
    )
    assert response.status_code == 422


def test_start_finals_auto_defaults_single_field_set(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    field = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    _rank_teams_directly(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2},
    )
    assert response.status_code == 201
    assert response.json()["field_set_id"] == field["field_set_id"]


def test_start_finals_requires_enough_ranked_teams(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _setup_ranked_teams(client, 2)
    _rank_teams_directly(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4},
    )
    assert response.status_code == 422


def test_get_finals_returns_current_state(cooperative_client):
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

    started = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    ).json()

    response = client.get(f"/api/finals/{started['id']}")
    assert response.status_code == 200
    assert response.json()["id"] == started["id"]
    assert response.json()["status"] == "in_progress"
```

(`_setup_ranked_teams` is a lighter helper used only by the two tests that just need *some* ranked teams present without caring about exact scores — `_rank_teams_directly` is the real ranking-producing helper both use. Read both carefully: `_setup_ranked_teams`'s own inline match-creation loop is dead weight — simplify it if you notice it doesn't actually contribute anything `_rank_teams_directly` doesn't already provide; keep whichever combination makes the two "insufficient teams"/"odd bracket size" tests pass cleanly with real ranked teams in place.)

- [ ] **Step 8: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals.py -v`
Expected: all pass.

Run: `.venv/bin/pytest tests/ -v`
Expected: same total as Task 1's end (152), plus these 7 new tests = 159.

- [ ] **Step 9: Commit**

```bash
git add src/tournament_server/models/finals_bracket.py \
        src/tournament_server/models/bracket_alliance.py \
        src/tournament_server/models/__init__.py \
        src/tournament_server/schemas/finals.py \
        src/tournament_server/routers/finals.py \
        src/tournament_server/app.py \
        tests/test_finals.py
git commit -m "Add FinalsBracket/BracketAlliance models, POST /api/finals/start, GET /api/finals/{id}"
```

---

### Task 3: `POST /api/finals/{id}/pick` — captain-pick flow

**Files:**
- Modify: `src/tournament_server/routers/finals.py`
- Test: `tests/test_finals.py`

**Interfaces:**
- Consumes: everything from Task 2 (same router file).
- Produces: `POST /api/finals/{bracket_id}/pick` — no later task depends on this directly, but it's the only way a `captain_pick` bracket ever leaves `"selecting_alliances"`.

- [ ] **Step 1: Add the pick endpoint**

In `src/tournament_server/routers/finals.py`, add the import `from tournament_server.models.team import Team` if not already present (it already is, from Task 2), then append at the end of the file:

```python
@router.post("/{bracket_id}/pick", response_model=FinalsBracketRead)
def pick_partner(
    bracket_id: int, payload: FinalsPickRequest, request: Request, db: Session = Depends(get_db)
) -> FinalsBracketRead:
    bracket = db.get(FinalsBracket, bracket_id)
    if bracket is None:
        raise HTTPException(status_code=404, detail="Finals bracket not found")
    if bracket.status != "selecting_alliances":
        raise HTTPException(
            status_code=409, detail="This bracket is not currently selecting alliances"
        )

    alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket_id)
        .order_by(BracketAlliance.seed)
    ).scalars().all()

    team_counts: dict[int, int] = {}
    claimed_team_ids: set[int] = set()
    for alliance in alliances:
        rows = db.execute(
            select(BracketAllianceTeam).where(
                BracketAllianceTeam.bracket_alliance_id == alliance.id
            )
        ).scalars().all()
        team_counts[alliance.id] = len(rows)
        for row in rows:
            claimed_team_ids.add(row.team_id)

    pending = [a for a in alliances if team_counts[a.id] < 2]
    if not pending:
        raise HTTPException(
            status_code=409, detail="Every alliance in this bracket already has a partner"
        )
    next_captain = pending[0]
    if payload.captain_bracket_alliance_id != next_captain.id:
        raise HTTPException(
            status_code=422,
            detail=(
                f"It is not this alliance's turn to pick; alliance "
                f"{next_captain.id} (seed {next_captain.seed}) picks next"
            ),
        )

    if payload.partner_team_id in claimed_team_ids:
        raise HTTPException(
            status_code=409, detail="This team is already on a bracket alliance"
        )
    if db.get(Team, payload.partner_team_id) is None:
        raise HTTPException(status_code=404, detail="Team not found")

    db.add(
        BracketAllianceTeam(
            bracket_alliance_id=next_captain.id, team_id=payload.partner_team_id
        )
    )
    db.commit()

    remaining_pending = [
        a
        for a in alliances
        if a.id != next_captain.id
        and team_counts[a.id] < 2
    ]
    if not remaining_pending:
        bracket.status = "in_progress"
        db.commit()

    db.refresh(bracket)
    game_plugin = get_game_plugin_for_event(request, db)
    return _to_finals_bracket_read(bracket, db, game_plugin)
```

(`remaining_pending` uses the `team_counts` snapshot taken *before* this pick — it deliberately excludes `next_captain` itself, since that alliance just got its partner in this same request; every other alliance's count is unchanged from the snapshot. This correctly detects "was this the last pick" without needing to re-query every alliance's team count again.)

- [ ] **Step 2: Write the tests**

Append to `tests/test_finals.py`:

```python
def test_captain_pick_rejects_out_of_turn_pick(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[0]]},
                {"station": "blue", "team_ids": [team_ids[1]]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )

    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[2]]},
                {"station": "blue", "team_ids": [team_ids[3]]},
            ],
        },
    ).json()
    red2_id = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": 2},
    ).json()
    assert bracket["status"] == "selecting_alliances"
    seed_1_alliance = bracket["alliances"][0]
    seed_2_alliance = bracket["alliances"][1]

    unclaimed = [t for t in team_ids if t not in seed_1_alliance["team_ids"] and t not in seed_2_alliance["team_ids"]]

    response = client.post(
        f"/api/finals/{bracket['id']}/pick",
        json={
            "captain_bracket_alliance_id": seed_2_alliance["id"],
            "partner_team_id": unclaimed[0],
        },
    )
    assert response.status_code == 422


def test_captain_pick_rejects_already_claimed_partner(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[0]]},
                {"station": "blue", "team_ids": [team_ids[1]]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[2]]},
                {"station": "blue", "team_ids": [team_ids[3]]},
            ],
        },
    ).json()
    red2_id = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": 2},
    ).json()
    seed_1_alliance = bracket["alliances"][0]

    response = client.post(
        f"/api/finals/{bracket['id']}/pick",
        json={
            "captain_bracket_alliance_id": seed_1_alliance["id"],
            "partner_team_id": seed_1_alliance["team_ids"][0],
        },
    )
    assert response.status_code == 409


def test_captain_pick_completes_bracket_once_every_captain_has_picked(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[0]]},
                {"station": "blue", "team_ids": [team_ids[1]]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [team_ids[2]]},
                {"station": "blue", "team_ids": [team_ids[3]]},
            ],
        },
    ).json()
    red2_id = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    client.post(
        f"/api/matches/{match2['id']}/alliances/{red2_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": 2},
    ).json()
    assert bracket["status"] == "selecting_alliances"
    seed_1 = bracket["alliances"][0]
    seed_2 = bracket["alliances"][1]
    unclaimed = [
        t for t in team_ids if t not in seed_1["team_ids"] and t not in seed_2["team_ids"]
    ]

    client.post(
        f"/api/finals/{bracket['id']}/pick",
        json={"captain_bracket_alliance_id": seed_1["id"], "partner_team_id": unclaimed[0]},
    )
    response = client.post(
        f"/api/finals/{bracket['id']}/pick",
        json={"captain_bracket_alliance_id": seed_2["id"], "partner_team_id": unclaimed[1]},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "in_progress"
    assert response.json()["runs"] == []
```

(This test asserts `runs == []` deliberately — `single_elimination`'s engine doesn't exist in this plan, so a `captain_pick` bracket reaching `"in_progress"` creates no matches at all yet. Every test in this task builds its own setup inline rather than sharing a helper, since each needs a slightly different match/score sequence to reach its specific assertion.)

- [ ] **Step 3: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals.py -v`
Expected: all 10 pass (7 from Task 2 + 3 new).

Run: `.venv/bin/pytest tests/ -v`
Expected: 162 passed (159 + 3).

- [ ] **Step 4: Commit**

```bash
git add src/tournament_server/routers/finals.py tests/test_finals.py
git commit -m "Add POST /api/finals/{id}/pick for the captain-pick alliance-formation flow"
```

---

### Task 4: Field allocation, `FinalsResult`, and the first score-chase run

**Files:**
- Create: `src/tournament_server/models/finals_result.py`
- Modify: `src/tournament_server/models/match.py`
- Modify: `src/tournament_server/models/__init__.py`
- Create: `src/tournament_server/services/finals.py`
- Modify: `src/tournament_server/routers/finals.py`
- Test: `tests/test_finals.py`

**Interfaces:**
- Produces: `Match.finals_bracket_id`, `Match.bracket_alliance_id` (both nullable FKs); `FinalsResult(id, finals_bracket_id, bracket_alliance_id, score, rank)`; `services/finals.py`'s `next_finals_field_id(db, bracket) -> int` and `create_score_chase_run(db, bracket, bracket_alliance) -> Match` — consumed by Task 5 (progression logic calls both after each run completes).
- Consumes: `FinalsBracket`/`BracketAlliance`/`BracketAllianceTeam` (Task 2); `Field`/`FieldSet` (existing, Phase 4).

- [ ] **Step 1: Add the new `Match` columns**

In `src/tournament_server/models/match.py`, replace:

```python
    schedule_generation_id: Mapped[int | None] = mapped_column(
        ForeignKey("schedule_generations.id"), default=None
    )
    scheduled_time: Mapped[dt.datetime | None] = mapped_column(
        UTCDateTime, default=None
    )
```

with:

```python
    schedule_generation_id: Mapped[int | None] = mapped_column(
        ForeignKey("schedule_generations.id"), default=None
    )
    finals_bracket_id: Mapped[int | None] = mapped_column(
        ForeignKey("finals_brackets.id"), default=None
    )
    bracket_alliance_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
    scheduled_time: Mapped[dt.datetime | None] = mapped_column(
        UTCDateTime, default=None
    )
```

(`finals_bracket_id` is set on every finals match regardless of format — it's the one column the score-submission integration in Task 5 checks to know "this is a finals match, don't touch qualification ranking." `bracket_alliance_id` is score-chase-specific: which persistent pair this particular run belongs to.)

- [ ] **Step 2: Write the `FinalsResult` model**

Create `src/tournament_server/models/finals_result.py`:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class FinalsResult(Base):
    __tablename__ = "finals_results"
    __table_args__ = (
        UniqueConstraint(
            "finals_bracket_id", "bracket_alliance_id", name="uq_finals_result_bracket_alliance"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    finals_bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    bracket_alliance_id: Mapped[int] = mapped_column(ForeignKey("bracket_alliances.id"))
    score: Mapped[int] = mapped_column(Integer, default=0)
    rank: Mapped[int] = mapped_column(Integer, default=0)
```

- [ ] **Step 3: Register `FinalsResult`**

In `src/tournament_server/models/__init__.py`, add the import `from tournament_server.models.finals_result import FinalsResult` (insert alphabetically, after `finals_bracket` and before `match`) and add `"FinalsResult"` to `__all__` in the same alphabetical position.

- [ ] **Step 4: Write `services/finals.py`**

Create `src/tournament_server/services/finals.py`:

```python
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.field import Field
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match


def next_finals_field_id(db: Session, bracket: FinalsBracket) -> int:
    field_ids = [
        f.id
        for f in db.execute(
            select(Field).where(Field.field_set_id == bracket.field_set_id).order_by(Field.id)
        ).scalars().all()
    ]
    field_id = field_ids[bracket.next_field_index % len(field_ids)]
    bracket.next_field_index += 1
    db.add(bracket)
    return field_id


def create_score_chase_run(
    db: Session, bracket: FinalsBracket, bracket_alliance: BracketAlliance
) -> Match:
    field_id = next_finals_field_id(db, bracket)
    existing_run_count = len(
        db.execute(
            select(Match).where(Match.finals_bracket_id == bracket.id)
        ).scalars().all()
    )

    match = Match(
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        round_type="elimination",
        match_number=existing_run_count + 1,
        field_id=field_id,
        finals_bracket_id=bracket.id,
        bracket_alliance_id=bracket_alliance.id,
    )
    db.add(match)
    db.flush()

    alliance = Alliance(match_id=match.id, station="solo")
    db.add(alliance)
    db.flush()

    team_ids = [
        row.team_id
        for row in db.execute(
            select(BracketAllianceTeam).where(
                BracketAllianceTeam.bracket_alliance_id == bracket_alliance.id
            )
        ).scalars().all()
    ]
    for team_id in team_ids:
        db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))

    db.commit()
    db.refresh(match)
    return match


def start_score_chase(db: Session, bracket: FinalsBracket) -> None:
    alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket.id)
        .order_by(BracketAlliance.seed.desc())
    ).scalars().all()
    if alliances:
        create_score_chase_run(db, bracket, alliances[0])
```

(`start_score_chase` creates the run for the **worst** seed first — `.order_by(BracketAlliance.seed.desc())` puts the highest seed number, i.e. the worst qualifier, at index 0 — matching the spec's "worst to best" run order. Match numbering (`existing_run_count + 1`) is scoped per-bracket, counting only that bracket's own runs, not the session's matches overall — this is intentionally independent of `Match.match_number`'s meaning for qualification matches in the same session, the same way `round_type: "elimination"` already separates finals matches from qualification ones by convention.)

- [ ] **Step 5: Trigger the first run when a `score_chase` bracket becomes `"in_progress"`**

In `src/tournament_server/routers/finals.py`, add the import `from tournament_server.services.finals import start_score_chase`. In `start_finals`, replace:

```python
    if alliance_selection == "seed_pairing":
        for i in range(0, len(top_teams), 2):
            alliance = BracketAlliance(bracket_id=bracket.id, seed=(i // 2) + 1)
            db.add(alliance)
            db.flush()
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=top_teams[i].team_id
                )
            )
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=top_teams[i + 1].team_id
                )
            )
        bracket.status = "in_progress"

    db.commit()
    db.refresh(bracket)
    return _to_finals_bracket_read(bracket, db, game_plugin)
```

with:

```python
    if alliance_selection == "seed_pairing":
        for i in range(0, len(top_teams), 2):
            alliance = BracketAlliance(bracket_id=bracket.id, seed=(i // 2) + 1)
            db.add(alliance)
            db.flush()
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=top_teams[i].team_id
                )
            )
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=top_teams[i + 1].team_id
                )
            )
        bracket.status = "in_progress"
        db.commit()
        if bracket.format == "score_chase":
            start_score_chase(db, bracket)

    db.commit()
    db.refresh(bracket)
    return _to_finals_bracket_read(bracket, db, game_plugin)
```

In `pick_partner` (Task 3's function, same file), replace:

```python
    remaining_pending = [
        a
        for a in alliances
        if a.id != next_captain.id
        and team_counts[a.id] < 2
    ]
    if not remaining_pending:
        bracket.status = "in_progress"
        db.commit()

    db.refresh(bracket)
```

with:

```python
    remaining_pending = [
        a
        for a in alliances
        if a.id != next_captain.id
        and team_counts[a.id] < 2
    ]
    if not remaining_pending:
        bracket.status = "in_progress"
        db.commit()
        if bracket.format == "score_chase":
            start_score_chase(db, bracket)

    db.refresh(bracket)
```

(A `captain_pick` bracket reaching `"in_progress"` in this plan is only ever `format == "head_to_head"`'s `single_elimination` in practice — `example-game` declares `captain_pick` + `single_elimination` — so the `if bracket.format == "score_chase"` branch here won't actually fire for either shipped fixture today; it's still the correct, complete condition for any future game that combines `captain_pick` with `score_chase`, and costs nothing to write correctly now.)

- [ ] **Step 6: Replace `_to_finals_bracket_read`'s placeholder run-lookup with the real one**

In `src/tournament_server/routers/finals.py`, add the import `from tournament_server.models.score_record import ScoreRecord` if not already present (it already is), and `import json` at the top of the file. Replace:

```python
    matches = db.execute(
        select(Match).where(Match.finals_bracket_id == bracket.id)
    ).scalars().all()
    runs = []
    for match in matches:
        score_record = db.execute(
            select(ScoreRecord).where(ScoreRecord.alliance_id.in_(
                select(BracketAllianceTeam.bracket_alliance_id).where(False)
            ))
        ).scalars().first()  # placeholder line replaced in Task 4
        runs.append(
            FinalsRunRead(
                match_id=match.id,
                bracket_alliance_id=match.bracket_alliance_id,
                status=match.status,
                score=None,
            )
        )
```

with:

```python
    matches = db.execute(
        select(Match).where(Match.finals_bracket_id == bracket.id)
    ).scalars().all()
    runs = []
    for match in matches:
        match_alliance = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().first()
        score = None
        if match_alliance is not None:
            score_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == match_alliance.id)
            ).scalars().first()
            if score_record is not None:
                score = (
                    0
                    if (score_record.no_show or score_record.dq)
                    else game_plugin.module.calculate_score(json.loads(score_record.data_json))
                )
        runs.append(
            FinalsRunRead(
                match_id=match.id,
                bracket_alliance_id=match.bracket_alliance_id,
                status=match.status,
                score=score,
            )
        )
```

Add the import `from tournament_server.models.alliance import Alliance` to the top of the file if not already present (it already is, from Task 2/3's other uses).

- [ ] **Step 7: Write the tests**

Append to `tests/test_finals.py`:

```python
def test_starting_a_score_chase_bracket_creates_the_first_run_for_the_worst_seed(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    for i, team_id in enumerate(team_ids):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 100 + i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": (4 - i) * 10}},
        )

    bracket = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    ).json()
    assert bracket["status"] == "in_progress"
    assert len(bracket["runs"]) == 1
    worst_seed_alliance = bracket["alliances"][-1]
    assert bracket["runs"][0]["bracket_alliance_id"] == worst_seed_alliance["id"]
    assert bracket["runs"][0]["score"] is None


def test_field_allocation_round_robins_across_multiple_fields(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    field1 = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 1"}
    ).json()
    field2 = client.post(
        "/api/fields", json={"session_id": session_id, "name": "Field 2"}
    ).json()

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    for i, team_id in enumerate(team_ids):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 100 + i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": (4 - i) * 10}},
        )

    bracket = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    ).json()

    first_run_match = client.get(f"/api/matches/{bracket['runs'][0]['match_id']}").json()
    assert first_run_match["field_id"] in {field1["id"], field2["id"]}
```

- [ ] **Step 8: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals.py -v`
Expected: all 12 pass (10 from Tasks 2-3 + 2 new).

Run: `.venv/bin/pytest tests/ -v`
Expected: 164 passed (162 + 2).

- [ ] **Step 9: Commit**

```bash
git add src/tournament_server/models/finals_result.py \
        src/tournament_server/models/match.py \
        src/tournament_server/models/__init__.py \
        src/tournament_server/services/finals.py \
        src/tournament_server/routers/finals.py \
        tests/test_finals.py
git commit -m "Add FinalsResult, Match finals columns, and the first score-chase run"
```

---

### Task 5: Score-chase progression via score submission, and the qualification-ranking exclusion fix

**Files:**
- Modify: `src/tournament_server/routers/scores.py`
- Modify: `src/tournament_server/services/ranking.py`
- Modify: `src/tournament_server/services/finals.py`
- Test: `tests/test_finals.py`

**Interfaces:**
- Produces: `recompute_finals_results(db, bracket) -> None` in `services/finals.py` — no later task in this plan depends on it, but a future single-elimination plan would reuse the same "finals matches are excluded from qualification ranking" fix.
- Consumes: `create_score_chase_run`, `next_finals_field_id` (Task 4).

- [ ] **Step 1: Exclude finals matches from qualification ranking**

In `src/tournament_server/services/ranking.py`, both `recompute_rankings` and `recompute_event_rankings` each query `Match` exactly once, and that one query feeds both the `cooperative_score` and `head_to_head` branches below it — so one added condition per function covers both branches.

In `recompute_rankings`, replace:

```python
    query = select(Match).where(
        Match.session_id == session_id, Match.status == "completed"
    )
```

with:

```python
    query = select(Match).where(
        Match.session_id == session_id,
        Match.status == "completed",
        Match.finals_bracket_id.is_(None),
    )
```

In `recompute_event_rankings`, replace:

```python
    query = select(Match).where(
        Match.session_id.in_(session_ids), Match.status == "completed"
    )
```

with:

```python
    query = select(Match).where(
        Match.session_id.in_(session_ids),
        Match.status == "completed",
        Match.finals_bracket_id.is_(None),
    )
```

- [ ] **Step 2: Write `recompute_finals_results`**

In `src/tournament_server/services/finals.py`, add the imports `import json` and `from tournament_server.models.finals_result import FinalsResult`, then add this function:

```python
def recompute_finals_results(db: Session, bracket: FinalsBracket, game_plugin) -> None:
    matches = db.execute(
        select(Match).where(
            Match.finals_bracket_id == bracket.id, Match.status == "completed"
        )
    ).scalars().all()

    scores: dict[int, int] = {}
    for match in matches:
        alliance = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().first()
        if alliance is None:
            continue
        score_record = db.execute(
            select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
        ).scalars().first()
        if score_record is None:
            continue
        effective_score = (
            0
            if (score_record.no_show or score_record.dq)
            else game_plugin.module.calculate_score(json.loads(score_record.data_json))
        )
        scores[match.bracket_alliance_id] = effective_score

    if not scores:
        return

    seeds = {
        a.id: a.seed
        for a in db.execute(
            select(BracketAlliance).where(BracketAlliance.bracket_id == bracket.id)
        ).scalars().all()
    }

    ordered = sorted(
        scores.items(), key=lambda item: (-item[1], seeds[item[0]])
    )

    for rank, (bracket_alliance_id, score) in enumerate(ordered, start=1):
        existing = db.execute(
            select(FinalsResult).where(
                FinalsResult.finals_bracket_id == bracket.id,
                FinalsResult.bracket_alliance_id == bracket_alliance_id,
            )
        ).scalars().first()
        if existing is None:
            db.add(
                FinalsResult(
                    finals_bracket_id=bracket.id,
                    bracket_alliance_id=bracket_alliance_id,
                    score=score,
                    rank=rank,
                )
            )
        else:
            existing.score = score
            existing.rank = rank

    db.commit()
```

Add the imports `from tournament_server.models.score_record import ScoreRecord` to `services/finals.py`'s existing import block.

(Ties broken by `seeds[item[0]]` ascending — a lower seed number, the better qualifier, wins a tie, matching the spec's stated rule. `sorted`'s key tuple `(-item[1], seeds[item[0]])` sorts by score descending first, then seed ascending as the tiebreak.)

- [ ] **Step 3: Write the score-chase progression function**

In `src/tournament_server/services/finals.py`, add this function (after `recompute_finals_results`):

```python
def advance_score_chase(db: Session, bracket: FinalsBracket, game_plugin) -> None:
    recompute_finals_results(db, bracket, game_plugin)

    all_alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket.id)
        .order_by(BracketAlliance.seed.desc())
    ).scalars().all()
    ran_alliance_ids = {
        m.bracket_alliance_id
        for m in db.execute(
            select(Match).where(Match.finals_bracket_id == bracket.id)
        ).scalars().all()
    }

    remaining = [a for a in all_alliances if a.id not in ran_alliance_ids]
    if remaining:
        create_score_chase_run(db, bracket, remaining[0])
    else:
        bracket.status = "complete"
        db.add(bracket)
        db.commit()
```

(`all_alliances` is already ordered worst-to-best via `seed.desc()` — `remaining[0]` is always the next alliance in that same order that hasn't run yet, since `ran_alliance_ids` only grows monotonically as runs are created, never shrinks. `ran_alliance_ids` tracks "has a Match been created for this alliance" — not "has it been scored" — so this function is only meant to be called once a run has actually been scored, which Task 5's `scores.py` integration guarantees.)

- [ ] **Step 4: Integrate with score submission**

In `src/tournament_server/routers/scores.py`, add the import `from tournament_server.models.finals_bracket import FinalsBracket` and `from tournament_server.services.finals import advance_score_chase` at the top of the file. Replace the final block of `submit_score`:

```python
    recompute_rankings(db, plugin, match.session_id, match.division_id)
    event = get_the_event(db)
    if event is not None:
        recompute_event_rankings(db, plugin, event.id, match.division_id)

    return _to_score_record_read(record, computed_score)
```

with:

```python
    if match.finals_bracket_id is not None:
        bracket = db.get(FinalsBracket, match.finals_bracket_id)
        if bracket is not None and bracket.format == "score_chase" and match.status == "completed":
            advance_score_chase(db, bracket, plugin)
        return _to_score_record_read(record, computed_score)

    recompute_rankings(db, plugin, match.session_id, match.division_id)
    event = get_the_event(db)
    if event is not None:
        recompute_event_rankings(db, plugin, event.id, match.division_id)

    return _to_score_record_read(record, computed_score)
```

(The `match.status == "completed"` guard matters: `submit_score` only marks the match `"completed"` a few lines earlier, once every alliance on it has a `ScoreRecord` — for a score-chase run, that's always true after its one submission, since there's only one `Alliance` per run. This guard is what stops `advance_score_chase` from firing on some hypothetical resubmission path before the match is actually done, keeping this integration point consistent with how `recompute_rankings` is already only meaningful for completed matches.)

- [ ] **Step 5: Extend `GET /api/finals/{id}` to include `FinalsResult` standings**

In `src/tournament_server/routers/finals.py`, add the import `from tournament_server.models.finals_result import FinalsResult`. In `_to_finals_bracket_read`, replace:

```python
    return FinalsBracketRead(
        id=bracket.id,
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        field_set_id=bracket.field_set_id,
        format=bracket.format,
        bracket_size=bracket.bracket_size,
        wins_to_advance=bracket.wins_to_advance,
        status=bracket.status,
        alliances=[_to_bracket_alliance_read(a, db) for a in alliances],
        runs=runs,
        results=[],
    )
```

with:

```python
    results = db.execute(
        select(FinalsResult)
        .where(FinalsResult.finals_bracket_id == bracket.id)
        .order_by(FinalsResult.rank)
    ).scalars().all()

    return FinalsBracketRead(
        id=bracket.id,
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        field_set_id=bracket.field_set_id,
        format=bracket.format,
        bracket_size=bracket.bracket_size,
        wins_to_advance=bracket.wins_to_advance,
        status=bracket.status,
        alliances=[_to_bracket_alliance_read(a, db) for a in alliances],
        runs=runs,
        results=[
            FinalsResultRead.model_validate(r, from_attributes=True) for r in results
        ],
    )
```

- [ ] **Step 6: Write the tests**

Append to `tests/test_finals.py`:

```python
def _setup_and_start_score_chase(client, scores: list[int]):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(len(scores) * 2)
    ]
    for i, team_id in enumerate(team_ids):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 100 + i,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_id]},
                    {"station": "blue", "team_ids": [team_id]},
                ],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": (len(team_ids) - i) * 10}},
        )

    bracket = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": len(scores)}
    ).json()
    return bracket


def test_score_chase_progression_creates_runs_in_worst_to_best_order(cooperative_client):
    client = cooperative_client
    bracket = _setup_and_start_score_chase(client, [1, 2])

    assert len(bracket["runs"]) == 1
    worst_seed_alliance_id = bracket["alliances"][-1]["id"]
    assert bracket["runs"][0]["bracket_alliance_id"] == worst_seed_alliance_id

    first_run_match_id = bracket["runs"][0]["match_id"]
    first_run_alliance_id = client.get(f"/api/matches/{first_run_match_id}").json()["alliances"][0]["id"]
    client.post(
        f"/api/matches/{first_run_match_id}/alliances/{first_run_alliance_id}/score",
        json={"data": {"objects_scored": 5}},
    )

    updated = client.get(f"/api/finals/{bracket['id']}").json()
    assert len(updated["runs"]) == 2
    best_seed_alliance_id = updated["alliances"][0]["id"]
    assert updated["runs"][1]["bracket_alliance_id"] == best_seed_alliance_id
    assert updated["status"] == "in_progress"


def test_score_chase_completes_after_the_last_run_and_ranks_by_score(cooperative_client):
    client = cooperative_client
    bracket = _setup_and_start_score_chase(client, [1, 2])

    first_run_match_id = bracket["runs"][0]["match_id"]
    first_run_alliance_id = client.get(f"/api/matches/{first_run_match_id}").json()["alliances"][0]["id"]
    client.post(
        f"/api/matches/{first_run_match_id}/alliances/{first_run_alliance_id}/score",
        json={"data": {"objects_scored": 5}},
    )

    updated = client.get(f"/api/finals/{bracket['id']}").json()
    second_run_match_id = updated["runs"][1]["match_id"]
    second_run_alliance_id = client.get(f"/api/matches/{second_run_match_id}").json()["alliances"][0]["id"]
    client.post(
        f"/api/matches/{second_run_match_id}/alliances/{second_run_alliance_id}/score",
        json={"data": {"objects_scored": 20}},
    )

    final = client.get(f"/api/finals/{bracket['id']}").json()
    assert final["status"] == "complete"
    assert len(final["results"]) == 2
    assert final["results"][0]["score"] == 40
    assert final["results"][0]["rank"] == 1
    assert final["results"][1]["score"] == 10
    assert final["results"][1]["rank"] == 2


def test_finals_matches_are_excluded_from_qualification_rankings(cooperative_client):
    client = cooperative_client
    bracket = _setup_and_start_score_chase(client, [1, 2])
    session_id = bracket["session_id"]

    before = client.get(f"/api/rankings?session_id={session_id}").json()
    total_matches_before = {row["team_id"]: row["matches_played"] for row in before}

    first_run_match_id = bracket["runs"][0]["match_id"]
    first_run_alliance_id = client.get(f"/api/matches/{first_run_match_id}").json()["alliances"][0]["id"]
    client.post(
        f"/api/matches/{first_run_match_id}/alliances/{first_run_alliance_id}/score",
        json={"data": {"objects_scored": 5}},
    )

    after = client.get(f"/api/rankings?session_id={session_id}").json()
    total_matches_after = {row["team_id"]: row["matches_played"] for row in after}
    assert total_matches_after == total_matches_before
```

- [ ] **Step 7: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals.py -v`
Expected: all 15 pass (12 from Tasks 2-4 + 3 new).

Run: `.venv/bin/pytest tests/ -v`
Expected: 167 passed (164 + 3).

- [ ] **Step 8: Commit**

```bash
git add src/tournament_server/routers/scores.py \
        src/tournament_server/services/ranking.py \
        src/tournament_server/services/finals.py \
        src/tournament_server/routers/finals.py \
        tests/test_finals.py
git commit -m "Add score-chase progression and exclude finals matches from qualification ranking"
```

---

### Task 6: Documentation

**Files:**
- Modify: `server/CLAUDE.md` (repo-relative path: `CLAUDE.md` from the `server/` directory this plan's Global Constraints assume as CWD)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (documentation only).

- [ ] **Step 1: Add a "Finals" section**

After the existing "## Cooperative scoring" section in `CLAUDE.md`, add:

```markdown
## Finals

A game plugin declares `alliance_selection` (`captain_pick` or
`seed_pairing`) and `finals_format` (`single_elimination` or
`score_chase`) in `match_format()`. A finals pair is always exactly 2
teams, persistent for the whole finals stage, regardless of the game's
qualification-stage `teams_per_alliance` — formed once via `POST
/api/finals/start` (immediately, for `seed_pairing`) or via a sequence of
`POST /api/finals/{id}/pick` calls in strict seed order (for
`captain_pick`).

**Only `score_chase` has an engine right now.** `POST /api/finals/start`
explicitly rejects `single_elimination` with a 422 — the contract accepts
either declared value and the conformance tool validates both, but
starting a bracket for a `single_elimination` game isn't implemented yet.

A `score_chase` bracket runs its `BracketAlliance` entrants one at a time,
worst seed to best, each as a single solo `Match` (one `Alliance`
containing both of the pair's teams — there's no opponent, unlike a
qualification `cooperative_score` match's two separate mirrored
alliances). The next run is created automatically the moment the current
one's score is submitted (`routers/scores.py`'s `submit_score` detects
`Match.finals_bracket_id` and calls `services/finals.py`'s
`advance_score_chase` instead of touching qualification rankings at all).
Final standings live in `FinalsResult` (score descending, ties broken by
the alliance's own bracket seed) — not the qualification `Ranking` table,
which has no meaning for a format with no opponent.

A finals bracket runs on exactly one `FieldSet` for its entire lifetime
(chosen at `POST /api/finals/start`, auto-defaulting when the session has
only one) — each dynamically-created run round-robins across that set's
fields via `FinalsBracket.next_field_index`, the same algorithm
`routers/schedule.py` uses for qualification, just applied one match at a
time instead of one batch at a time.

**Known, deliberate gap**: `recompute_rankings`/`recompute_event_rankings`
now exclude finals matches (`Match.finals_bracket_id IS NOT NULL`) from
qualification ranking — but they still don't exclude `practice`-round
matches, a pre-existing gap from an earlier phase this plan didn't
introduce and doesn't fix.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document score-chase finals"
```
