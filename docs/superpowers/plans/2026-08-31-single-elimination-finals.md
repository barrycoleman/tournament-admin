# Single-Elimination Finals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the single-elimination finals format end to end on top of the already-shipped score-chase foundation — seeded bracket generation with byes, game-by-game series progression with per-round `wins_to_advance`, walkovers, and a bracket-delete endpoint.

**Architecture:** A new `BracketMatchup` model represents the bracket tree (one row per cell, tree structure computed from `round_number`/`position` arithmetic, not stored as pointers). Bracket generation computes standard tournament seeding with byes and creates every matchup row upfront, resolving round-1 byes immediately. The score-submission endpoint gains a second finals branch (alongside score-chase's) that counts a matchup's decided games against that round's `wins_to_advance`, decides the matchup once one side wins enough, and places the winner into the next round — creating that next matchup's first game the instant both its sides are known. A dedicated endpoint lets an organizer mark an alliance unavailable, triggering an immediate walkover.

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy 2.0, SQLite, Pydantic v2, pytest.

**Spec:** `docs/superpowers/specs/2026-08-31-finals-and-elimination-brackets-design.md` — read the whole thing, but especially §3 (shared foundation, already built), §4 (single-elimination, this plan's core), §6 (endpoints), and the "Revision note" at the top (this plan implements everything it describes as new: `BracketAlliance.unavailable`, the two new endpoints, the captain_pick sufficiency check, and per-round `wins_to_advance`).

## Global Constraints

- No brand names anywhere (code, comments, docs, file names, user-facing text) — master spec §0.
- Python 3.11+, FastAPI, SQLAlchemy 2.0 synchronous `Mapped`/`mapped_column` style, one SQLite file per event — matches existing codebase.
- No Alembic/migrations — this plan adds a new table and new nullable/changed columns; a pre-this-plan database is recreated (delete the `.db` file), not migrated, consistent with every prior phase.
- A finals pair is always exactly 2 teams (unchanged from the shared foundation).
- Byes only ever occur in round 1 — provable from `capacity = next_power_of_2(bracket_size)` always satisfying `capacity < 2 * bracket_size` (the standard property that makes tournament seeding never produce a "double bye" matchup). Round 2 and later matchups are always eventually filled by two real winners from below, requiring an actual game — never resolved by the bye mechanism. Bracket generation (Task 2) relies on this: it only ever bye-resolves round 1, then does a single forward propagation pass into round 2 — no repeated cascade loop is needed, since nothing beyond round 1 can be "decided" at generation time.
- **Pre-existing bug this plan must fix**: `start_finals` currently rejects any `bracket_size` that isn't even, with the message "a finals pair is always 2 teams" — but `bracket_size` is the *alliance count* (N), not a team count, and there's no reason N needs to be even for either `alliance_selection` mode (an odd `bracket_size` is exactly the normal case byes exist to support — e.g. a 3, 5, or 6-captain bracket). This was flagged as a deferred Minor in the score-chase phase's final review ("harmless today" — it wasn't, since `single_elimination` didn't exist yet to make it matter) and must be removed as part of Task 2, since it otherwise blocks the single-elimination format's core use case.

---

### Task 1: `BracketMatchup` model, `Match.bracket_matchup_id`, per-round `wins_to_advance` storage

**Files:**
- Create: `src/tournament_server/models/bracket_matchup.py`
- Modify: `src/tournament_server/models/match.py`
- Modify: `src/tournament_server/models/finals_bracket.py`
- Modify: `src/tournament_server/models/__init__.py`
- Modify: `src/tournament_server/schemas/finals.py`
- Modify: `src/tournament_server/services/finals.py`
- Test: `tests/test_finals_service.py` (new — direct unit tests, no HTTP client, for the pure helper functions this task adds)

**Interfaces:**
- Produces: `BracketMatchup(id, bracket_id, round_number, position, alliance_a_id, alliance_b_id, winner_alliance_id)`; `Match.bracket_matchup_id` (nullable FK); `FinalsBracket.wins_to_advance` (now a `String` column storing a JSON-encoded list of ints instead of a plain `Integer`); `services/finals.py`'s `bracket_capacity(bracket_size: int) -> int`, `total_rounds_for_bracket_size(bracket_size: int) -> int`, `expand_wins_to_advance(raw: int | list[int], total_rounds: int) -> list[int]` (raises `ValueError` on an invalid shape), `wins_to_advance_for_round(bracket: FinalsBracket, round_number: int) -> int` — consumed by Task 2 (generation, endpoint validation) and Task 3 (series-decision lookup).
- Consumes: nothing new from other tasks in this plan.

**Note on scope:** this task does NOT wire anything into the HTTP endpoints yet — `POST /api/finals/start` still unconditionally rejects `single_elimination` at this point (Task 2 removes that). This task only lays the model/schema/pure-function groundwork, tested directly rather than through the API, since there is no meaningful way to exercise `single_elimination`-specific behavior through the endpoint until the rejection is gone.

- [ ] **Step 1: Write the `BracketMatchup` model**

Create `src/tournament_server/models/bracket_matchup.py`:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class BracketMatchup(Base):
    __tablename__ = "bracket_matchups"

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    round_number: Mapped[int] = mapped_column(Integer)
    position: Mapped[int] = mapped_column(Integer)
    alliance_a_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
    alliance_b_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
    winner_alliance_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
```

- [ ] **Step 2: Add `Match.bracket_matchup_id`**

In `src/tournament_server/models/match.py`, replace:

```python
    finals_bracket_id: Mapped[int | None] = mapped_column(
        ForeignKey("finals_brackets.id"), default=None
    )
    bracket_alliance_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
```

with:

```python
    finals_bracket_id: Mapped[int | None] = mapped_column(
        ForeignKey("finals_brackets.id"), default=None
    )
    bracket_alliance_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
    bracket_matchup_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_matchups.id"), default=None
    )
```

(`bracket_alliance_id` stays score-chase-specific; `bracket_matchup_id` is the single-elimination equivalent — a game/match belongs to exactly one matchup. Both are nullable and mutually exclusive in practice, but nothing enforces that at the DB level, matching this codebase's existing style of trusting internal code over DB constraints for cross-format invariants.)

- [ ] **Step 3: Change `FinalsBracket.wins_to_advance` to store a JSON-encoded per-round list**

In `src/tournament_server/models/finals_bracket.py`, replace:

```python
    wins_to_advance: Mapped[int] = mapped_column(Integer, default=1)
```

with:

```python
    wins_to_advance: Mapped[str] = mapped_column(String, default="[1]")
```

(`String` is already imported in this file. The column stores a JSON list like `"[1, 1, 1, 2]"` — one entry per round, index 0 is round 1, the last index is the final round. `score_chase` brackets store `"[1]"` and never read it. This is the same JSON-as-text pattern `ScoreRecord.data_json` already uses elsewhere in this codebase.)

- [ ] **Step 4: Register `BracketMatchup`**

In `src/tournament_server/models/__init__.py`, add the import `from tournament_server.models.bracket_matchup import BracketMatchup` (insert alphabetically, right after the `bracket_alliance` import and before `division`) and add `"BracketMatchup"` to `__all__` in the same alphabetical position (right after `"BracketAllianceTeam"`).

- [ ] **Step 5: Add the `BracketMatchupRead` schema and update `wins_to_advance`'s type in the existing schemas**

In `src/tournament_server/schemas/finals.py`, replace:

```python
class FinalsStartRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    bracket_size: int
    wins_to_advance: int | None = None
    field_set_id: int | None = None
```

with:

```python
class FinalsStartRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    bracket_size: int
    wins_to_advance: int | list[int] | None = None
    field_set_id: int | None = None


class BracketMatchupRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    round_number: int
    position: int
    alliance_a_id: int | None
    alliance_b_id: int | None
    winner_alliance_id: int | None
```

Then replace:

```python
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
```

with:

```python
class FinalsBracketRead(BaseModel):
    id: int
    session_id: int
    division_id: int | None
    field_set_id: int
    format: str
    bracket_size: int
    wins_to_advance: list[int]
    status: str
    alliances: list[BracketAllianceRead]
    runs: list[FinalsRunRead]
    results: list[FinalsResultRead]
    matchups: list[BracketMatchupRead]
```

(`matchups` is always present in the response shape from this task onward, even though nothing populates it with real data until Task 2 — it defaults to an empty list wherever `FinalsBracketRead` is constructed. This avoids a second schema change later, the same incremental-build pattern the score-chase phase used for `runs`/`results`.)

- [ ] **Step 6: Write the pure helper functions**

In `src/tournament_server/services/finals.py`, add these functions (near the top of the file, after the imports, before `next_finals_field_id`):

```python
def bracket_capacity(bracket_size: int) -> int:
    capacity = 1
    while capacity < bracket_size:
        capacity *= 2
    return capacity


def total_rounds_for_bracket_size(bracket_size: int) -> int:
    return bracket_capacity(bracket_size).bit_length() - 1


def expand_wins_to_advance(raw: int | list[int], total_rounds: int) -> list[int]:
    if isinstance(raw, int):
        if raw < 1:
            raise ValueError("wins_to_advance must be at least 1")
        return [raw] * total_rounds
    if len(raw) != total_rounds:
        raise ValueError(
            f"wins_to_advance list must have exactly {total_rounds} entries "
            f"for this bracket_size, got {len(raw)}"
        )
    if any(v < 1 for v in raw):
        raise ValueError("every wins_to_advance entry must be at least 1")
    return list(raw)


def wins_to_advance_for_round(bracket: FinalsBracket, round_number: int) -> int:
    return json.loads(bracket.wins_to_advance)[round_number - 1]
```

- [ ] **Step 7: Write the tests**

Create `tests/test_finals_service.py`:

```python
import pytest

from tournament_server.services.finals import (
    bracket_capacity,
    expand_wins_to_advance,
    total_rounds_for_bracket_size,
)


@pytest.mark.parametrize(
    "bracket_size,expected_capacity,expected_rounds",
    [
        (2, 2, 1),
        (3, 4, 2),
        (4, 4, 2),
        (5, 8, 3),
        (8, 8, 3),
        (9, 16, 4),
    ],
)
def test_bracket_capacity_and_total_rounds(bracket_size, expected_capacity, expected_rounds):
    assert bracket_capacity(bracket_size) == expected_capacity
    assert total_rounds_for_bracket_size(bracket_size) == expected_rounds


def test_expand_wins_to_advance_single_int_fills_every_round():
    assert expand_wins_to_advance(1, 4) == [1, 1, 1, 1]


def test_expand_wins_to_advance_accepts_correct_length_list():
    assert expand_wins_to_advance([1, 1, 1, 2], 4) == [1, 1, 1, 2]


def test_expand_wins_to_advance_rejects_wrong_length_list():
    with pytest.raises(ValueError, match="exactly 4 entries"):
        expand_wins_to_advance([1, 2], 4)


def test_expand_wins_to_advance_rejects_zero_or_negative():
    with pytest.raises(ValueError):
        expand_wins_to_advance(0, 4)
    with pytest.raises(ValueError):
        expand_wins_to_advance([1, 1, 1, 0], 4)
```

- [ ] **Step 8: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals_service.py -v`
Expected: all 10 pass (the parametrized `test_bracket_capacity_and_total_rounds` expands to 6 separate cases, plus 4 more individual test functions).

Run: `.venv/bin/pytest tests/ -v`
Expected: 178 passed (168 baseline + 10 new). No existing test reads `wins_to_advance` as a plain int (verified: only 3 tests pass it as a request field, all for `score_chase` brackets which ignore it entirely) or asserts on `matchups`, so nothing else should be affected — but if the full run surfaces an unexpected failure, read the failing test's assertion carefully before assuming this step's instructions are wrong.

- [ ] **Step 9: Commit**

```bash
git add src/tournament_server/models/bracket_matchup.py \
        src/tournament_server/models/match.py \
        src/tournament_server/models/finals_bracket.py \
        src/tournament_server/models/__init__.py \
        src/tournament_server/schemas/finals.py \
        src/tournament_server/services/finals.py \
        tests/test_finals_service.py
git commit -m "Add BracketMatchup model and per-round wins_to_advance storage"
```

---

### Task 2: Seeding-with-byes bracket generation, `single_elimination` unlocked

**Files:**
- Modify: `src/tournament_server/routers/finals.py`
- Modify: `src/tournament_server/services/finals.py`
- Test: `tests/test_finals.py`

**Interfaces:**
- Consumes: `bracket_capacity`, `total_rounds_for_bracket_size`, `expand_wins_to_advance` (Task 1); `BracketMatchup`, `BracketMatchupRead` (Task 1).
- Produces: `services/finals.py`'s `generate_bracket(db, bracket) -> None` and `_maybe_create_matchup_game(db, bracket, matchup) -> None` — consumed by Task 3 (progression calls `_maybe_create_matchup_game` after placing a winner into the next round) and Task 5 (walkover extends `_maybe_create_matchup_game` with an `unavailable` check).

- [ ] **Step 1: Remove the pre-existing `bracket_size`-must-be-even bug**

In `src/tournament_server/routers/finals.py`'s `start_finals`, replace:

```python
    if payload.bracket_size < 2:
        raise HTTPException(status_code=422, detail="bracket_size must be at least 2")
    if payload.bracket_size % 2 != 0:
        raise HTTPException(
            status_code=422,
            detail="bracket_size must be even (a finals pair is always 2 teams)",
        )
```

with:

```python
    if payload.bracket_size < 2:
        raise HTTPException(status_code=422, detail="bracket_size must be at least 2")
```

(The removed check confused "each alliance has 2 teams" — already enforced independently by the `needed` team-count checks below — with "the number of alliances (N) must be even," which has no basis: an odd `bracket_size` is the normal, expected case a single-elimination bracket's byes exist to handle.)

- [ ] **Step 2: Remove the `single_elimination` rejection and add real `wins_to_advance` handling**

Replace:

```python
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
```

with:

```python
    if payload.bracket_size < 2:
        raise HTTPException(status_code=422, detail="bracket_size must be at least 2")

    total_rounds = total_rounds_for_bracket_size(payload.bracket_size)
    if finals_format == "single_elimination":
        if payload.wins_to_advance is None:
            raise HTTPException(
                status_code=422,
                detail="wins_to_advance is required for single_elimination",
            )
        try:
            wins_to_advance_list = expand_wins_to_advance(
                payload.wins_to_advance, total_rounds
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
    else:
        wins_to_advance_list = [1] * total_rounds
```

(This moves the `bracket_size < 2` check earlier since `total_rounds_for_bracket_size` needs a valid `bracket_size` first, and removes the old blanket rejection entirely — `single_elimination` is now a real, supported path.)

Add the imports `from tournament_server.services.finals import (expand_wins_to_advance, generate_bracket, start_score_chase, total_rounds_for_bracket_size)` — replacing the existing single-name import `from tournament_server.services.finals import start_score_chase`.

- [ ] **Step 3: Store the expanded `wins_to_advance` list and remove the hardcoded value**

Replace:

```python
    bracket = FinalsBracket(
        session_id=payload.session_id,
        division_id=payload.division_id,
        field_set_id=field_set_id,
        format=finals_format,
        bracket_size=payload.bracket_size,
        wins_to_advance=1,
        status="selecting_alliances",
    )
```

with:

```python
    bracket = FinalsBracket(
        session_id=payload.session_id,
        division_id=payload.division_id,
        field_set_id=field_set_id,
        format=finals_format,
        bracket_size=payload.bracket_size,
        wins_to_advance=json.dumps(wins_to_advance_list),
        status="selecting_alliances",
    )
```

(`json` is already imported at the top of this file.)

- [ ] **Step 4: Wire `generate_bracket` into both activation points**

Replace:

```python
        bracket.status = "in_progress"
        db.commit()
        if bracket.format == "score_chase":
            start_score_chase(db, bracket)
    else:
```

with:

```python
        bracket.status = "in_progress"
        db.commit()
        if bracket.format == "score_chase":
            start_score_chase(db, bracket)
        elif bracket.format == "single_elimination":
            generate_bracket(db, bracket)
    else:
```

(This is inside `start_finals`'s `seed_pairing` branch.) Then, in `pick_partner`, replace:

```python
    if not remaining_pending:
        bracket.status = "in_progress"
        db.commit()
        if bracket.format == "score_chase":
            start_score_chase(db, bracket)
```

with:

```python
    if not remaining_pending:
        bracket.status = "in_progress"
        db.commit()
        if bracket.format == "score_chase":
            start_score_chase(db, bracket)
        elif bracket.format == "single_elimination":
            generate_bracket(db, bracket)
```

- [ ] **Step 5: Write the seeding-with-byes generation logic**

In `src/tournament_server/services/finals.py`, add the import `from tournament_server.models.bracket_matchup import BracketMatchup`, then add these functions (after `start_score_chase`):

```python
def _seed_order(capacity: int) -> list[int]:
    if capacity == 1:
        return [1]
    half = _seed_order(capacity // 2)
    order: list[int] = []
    for seed in half:
        order.append(seed)
        order.append(capacity + 1 - seed)
    return order


def _create_matchup_game(db: Session, bracket: FinalsBracket, matchup: BracketMatchup) -> Match:
    field_id = next_finals_field_id(db, bracket)
    existing_game_count = len(
        db.execute(
            select(Match).where(Match.finals_bracket_id == bracket.id)
        ).scalars().all()
    )

    match = Match(
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        round_type="elimination",
        match_number=existing_game_count + 1,
        field_id=field_id,
        finals_bracket_id=bracket.id,
        bracket_matchup_id=matchup.id,
    )
    db.add(match)
    db.flush()

    for alliance_id, station in (
        (matchup.alliance_a_id, "red"),
        (matchup.alliance_b_id, "blue"),
    ):
        alliance = Alliance(match_id=match.id, station=station)
        db.add(alliance)
        db.flush()
        team_ids = [
            row.team_id
            for row in db.execute(
                select(BracketAllianceTeam).where(
                    BracketAllianceTeam.bracket_alliance_id == alliance_id
                )
            ).scalars().all()
        ]
        for team_id in team_ids:
            db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))

    db.commit()
    db.refresh(match)
    return match


def _maybe_create_matchup_game(
    db: Session, bracket: FinalsBracket, matchup: BracketMatchup
) -> None:
    if matchup.winner_alliance_id is not None:
        return
    if matchup.alliance_a_id is None or matchup.alliance_b_id is None:
        return
    incomplete_game = db.execute(
        select(Match).where(
            Match.bracket_matchup_id == matchup.id, Match.status != "completed"
        )
    ).scalars().first()
    if incomplete_game is not None:
        return
    _create_matchup_game(db, bracket, matchup)


def generate_bracket(db: Session, bracket: FinalsBracket) -> None:
    alliances_by_seed = {
        a.seed: a.id
        for a in db.execute(
            select(BracketAlliance).where(BracketAlliance.bracket_id == bracket.id)
        ).scalars().all()
    }
    capacity = bracket_capacity(bracket.bracket_size)
    total_rounds = total_rounds_for_bracket_size(bracket.bracket_size)
    order = _seed_order(capacity)

    matchups: dict[tuple[int, int], BracketMatchup] = {}
    for round_number in range(1, total_rounds + 1):
        for position in range(capacity // (2**round_number)):
            matchup = BracketMatchup(
                bracket_id=bracket.id, round_number=round_number, position=position
            )
            db.add(matchup)
            db.flush()
            matchups[(round_number, position)] = matchup

    for position in range(capacity // 2):
        seed_a = order[2 * position]
        seed_b = order[2 * position + 1]
        matchup = matchups[(1, position)]
        matchup.alliance_a_id = alliances_by_seed.get(seed_a)
        matchup.alliance_b_id = alliances_by_seed.get(seed_b)
        if matchup.alliance_a_id is not None and matchup.alliance_b_id is None:
            matchup.winner_alliance_id = matchup.alliance_a_id
        elif matchup.alliance_b_id is not None and matchup.alliance_a_id is None:
            matchup.winner_alliance_id = matchup.alliance_b_id
    db.commit()

    if total_rounds > 1:
        for position in range(capacity // 2):
            matchup = matchups[(1, position)]
            if matchup.winner_alliance_id is None:
                continue
            next_matchup = matchups[(2, position // 2)]
            if position % 2 == 0:
                next_matchup.alliance_a_id = matchup.winner_alliance_id
            else:
                next_matchup.alliance_b_id = matchup.winner_alliance_id
        db.commit()

    for round_number in range(1, total_rounds + 1):
        for position in range(capacity // (2**round_number)):
            _maybe_create_matchup_game(db, bracket, matchups[(round_number, position)])
```

(`_seed_order` is the standard recursive tournament-bracket seeding construction — `_seed_order(8) == [1, 8, 4, 5, 2, 7, 3, 6]`, i.e. round-1 pairs `1v8, 4v5, 2v7, 3v6`. Byes only ever apply to round 1 — see this plan's Global Constraints for why a single forward-propagation pass into round 2 is sufficient and no repeated cascade loop is needed. A round-1 matchup with exactly one real `BracketAlliance` (the other seed number is beyond `bracket_size`, i.e. a bye) resolves immediately with zero games. `_maybe_create_matchup_game` is deliberately reusable — Task 3 calls it again every time a matchup gets a winner placed into the next round, and it's `unavailable`-aware from Task 5 onward.)

Add the missing imports this step needs at the top of `services/finals.py`: `from tournament_server.models.match import Match` is already imported; add `from tournament_server.models.alliance import Alliance, AllianceTeam` if not already present (it already is, from Task 4/5 of the score-chase phase).

- [ ] **Step 6: Extend `GET`/`POST /api/finals/start`'s response to include the matchup tree**

In `src/tournament_server/routers/finals.py`, add the import `from tournament_server.models.bracket_matchup import BracketMatchup` and `from tournament_server.schemas.finals import BracketMatchupRead` (add `BracketMatchupRead` to the existing `from tournament_server.schemas.finals import (...)` block). In `_to_finals_bracket_read`, replace:

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
        results=[
            FinalsResultRead.model_validate(r, from_attributes=True) for r in results
        ],
    )
```

with:

```python
    matchups = db.execute(
        select(BracketMatchup)
        .where(BracketMatchup.bracket_id == bracket.id)
        .order_by(BracketMatchup.round_number, BracketMatchup.position)
    ).scalars().all()

    return FinalsBracketRead(
        id=bracket.id,
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        field_set_id=bracket.field_set_id,
        format=bracket.format,
        bracket_size=bracket.bracket_size,
        wins_to_advance=json.loads(bracket.wins_to_advance),
        status=bracket.status,
        alliances=[_to_bracket_alliance_read(a, db) for a in alliances],
        runs=runs,
        results=[
            FinalsResultRead.model_validate(r, from_attributes=True) for r in results
        ],
        matchups=[
            BracketMatchupRead.model_validate(m, from_attributes=True) for m in matchups
        ],
    )
```

- [ ] **Step 7: Replace the now-obsolete rejection test with real generation tests**

In `tests/test_finals.py`, remove `test_start_finals_rejects_single_elimination` entirely (its behavior no longer exists — `single_elimination` is now supported) and add these tests in its place:

```python
def _setup_ranked_teams_for_example_game(client, count: int) -> tuple[int, list[int]]:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        for i in range(count)
    ]
    return session_id, team_ids


def _rank_teams_directly_head_to_head(client, session_id: int, team_ids: list[int]) -> None:
    # Pairs teams into single-team-per-alliance qualification matches (the
    # same pattern the existing captain-pick tests already use against
    # example-game) so every team ends up with a Ranking row. The exact
    # win/loss pattern doesn't matter for this plan's tests, which only
    # assert on counts (how many byes, how many real games) — never on
    # which specific team ends up holding which seed.
    match_number = 1000
    for i in range(0, len(team_ids) - 1, 2):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": match_number,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[i]]},
                    {"station": "blue", "team_ids": [team_ids[i + 1]]},
                ],
            },
        ).json()
        match_number += 1
        red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red_id}/score",
            json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
        )
        client.post(
            f"/api/matches/{match['id']}/alliances/{blue_id}/score",
            json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
        )
    if len(team_ids) % 2 == 1:
        # Odd count: give the last team a match of its own too (reusing an
        # already-ranked team as its opponent) so it still gets a Ranking row.
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": match_number,
                "field_id": None,
                "alliances": [
                    {"station": "red", "team_ids": [team_ids[-1]]},
                    {"station": "blue", "team_ids": [team_ids[0]]},
                ],
            },
        ).json()
        red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red_id}/score",
            json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
        )
        client.post(
            f"/api/matches/{match['id']}/alliances/{blue_id}/score",
            json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
        )


def test_start_finals_single_elimination_accepts_wins_to_advance_list(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": [1, 2]},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "selecting_alliances"
    assert body["wins_to_advance"] == [1, 2]


def test_start_finals_rejects_wrong_length_wins_to_advance_list(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": [1, 1, 1]},
    )
    assert response.status_code == 422


def test_generate_bracket_resolves_byes_and_seeds_pairs_correctly(client):
    # example-game is captain_pick + single_elimination. 5 captains means 5
    # alliances once every captain has picked a partner from the remaining
    # 5 teams (10 teams total). capacity = 8 for bracket_size=5, giving 3
    # round-1 byes and 1 real round-1 game.
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 10)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 5, "wins_to_advance": 1},
    ).json()
    assert bracket["status"] == "selecting_alliances"
    assert len(bracket["alliances"]) == 5

    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    final_body = final_response.json()
    assert final_body["status"] == "in_progress"

    matchups = final_body["matchups"]
    assert len(matchups) == 7  # capacity 8 -> 4 round-1 + 2 round-2 + 1 final
    round_1 = [m for m in matchups if m["round_number"] == 1]
    assert len(round_1) == 4
    decided_byes = [m for m in round_1 if m["winner_alliance_id"] is not None]
    assert len(decided_byes) == 3

    real_game_matchup = next(m for m in round_1 if m["winner_alliance_id"] is None)
    assert real_game_matchup["alliance_a_id"] is not None
    assert real_game_matchup["alliance_b_id"] is not None

    games_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games = [m for m in games_response.json() if m["round_type"] == "elimination"]
    assert len(finals_games) == 1
```

- [ ] **Step 8: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals.py -v`
Expected: all pass (16 existing minus the 1 removed rejection test, plus 3 new = 18).

Run: `.venv/bin/pytest tests/ -v`
Expected: 180 passed (178 from Task 1, minus 1 removed test, plus 3 new = 180). 0 failures and 0 unexpected changes elsewhere.

- [ ] **Step 9: Commit**

```bash
git add src/tournament_server/routers/finals.py \
        src/tournament_server/services/finals.py \
        tests/test_finals.py
git commit -m "Add seeding-with-byes bracket generation, unlock single_elimination"
```

---

### Task 3: Game-by-game series progression via score submission

**Files:**
- Modify: `src/tournament_server/routers/scores.py`
- Modify: `src/tournament_server/services/finals.py`
- Test: `tests/test_finals.py`

**Interfaces:**
- Consumes: `wins_to_advance_for_round` (Task 1); `_maybe_create_matchup_game`, `_create_matchup_game` (Task 2).
- Produces: `services/finals.py`'s `advance_single_elimination(db, bracket, plugin, match) -> None` — consumed by Task 5 (walkover triggers the same next-matchup-game-creation path indirectly via `_maybe_create_matchup_game`, not by calling this function directly).

- [ ] **Step 1: Write the matchup-decision logic**

In `src/tournament_server/services/finals.py`, add these functions (after `generate_bracket`):

```python
def _decide_matchup(
    db: Session, bracket: FinalsBracket, winner_id: int, matchup: BracketMatchup
) -> None:
    matchup.winner_alliance_id = winner_id
    db.add(matchup)
    db.commit()

    total_rounds = total_rounds_for_bracket_size(bracket.bracket_size)
    if matchup.round_number == total_rounds:
        bracket.status = "complete"
        db.add(bracket)
        db.commit()
        return

    next_matchup = db.execute(
        select(BracketMatchup).where(
            BracketMatchup.bracket_id == bracket.id,
            BracketMatchup.round_number == matchup.round_number + 1,
            BracketMatchup.position == matchup.position // 2,
        )
    ).scalars().first()
    if matchup.position % 2 == 0:
        next_matchup.alliance_a_id = winner_id
    else:
        next_matchup.alliance_b_id = winner_id
    db.add(next_matchup)
    db.commit()
    _maybe_create_matchup_game(db, bracket, next_matchup)


def advance_single_elimination(
    db: Session, bracket: FinalsBracket, game_plugin, match: Match
) -> None:
    matchup = db.get(BracketMatchup, match.bracket_matchup_id)
    if matchup is None or matchup.winner_alliance_id is not None:
        return

    incomplete_game = db.execute(
        select(Match).where(
            Match.bracket_matchup_id == matchup.id, Match.status != "completed"
        )
    ).scalars().first()
    if incomplete_game is not None:
        # Another game in this series is still unscored — this call is
        # either the normal in-flight game just being scored (which is
        # already "completed" by the time this function runs and so isn't
        # itself the "incomplete" one found here) or a correction to an
        # older game while a newer one in the same series is still open.
        # Either way, don't decide the matchup or create another game
        # until every existing game in the series is completed.
        return

    games = db.execute(
        select(Match).where(
            Match.bracket_matchup_id == matchup.id, Match.status == "completed"
        )
    ).scalars().all()

    wins = {matchup.alliance_a_id: 0, matchup.alliance_b_id: 0}
    for game in games:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == game.id)
        ).scalars().all()
        scores: dict[int, int] = {}
        for alliance in alliances:
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
            bracket_alliance_id = (
                matchup.alliance_a_id if alliance.station == "red" else matchup.alliance_b_id
            )
            scores[bracket_alliance_id] = effective_score
        if len(scores) == 2:
            score_a = scores[matchup.alliance_a_id]
            score_b = scores[matchup.alliance_b_id]
            if score_a > score_b:
                wins[matchup.alliance_a_id] += 1
            elif score_b > score_a:
                wins[matchup.alliance_b_id] += 1
            # a tied game counts toward neither side's series win

    wins_needed = wins_to_advance_for_round(bracket, matchup.round_number)
    winner_id = None
    if wins[matchup.alliance_a_id] >= wins_needed:
        winner_id = matchup.alliance_a_id
    elif wins[matchup.alliance_b_id] >= wins_needed:
        winner_id = matchup.alliance_b_id

    if winner_id is None:
        _create_matchup_game(db, bracket, matchup)
        return

    _decide_matchup(db, bracket, winner_id, matchup)
```

(`advance_single_elimination`'s first guard — returning immediately if the matchup already has a `winner_alliance_id` — mirrors the exact defensive pattern `advance_score_chase` already uses to make a post-hoc score correction on an already-decided game safe: it can never re-decide or re-progress a matchup that's already finished. The `incomplete_game` guard extends that same safety to the *in-progress* case: a correction to an older game in a series while a newer one is still unscored can't accidentally recompute and decide the matchup out from under the newer game.)

- [ ] **Step 2: Wire the new branch into `submit_score`**

In `src/tournament_server/routers/scores.py`, add the import `from tournament_server.services.finals import advance_score_chase, advance_single_elimination` (replacing the existing `from tournament_server.services.finals import advance_score_chase`). Replace:

```python
    if match.finals_bracket_id is not None:
        bracket = db.get(FinalsBracket, match.finals_bracket_id)
        if bracket is not None and bracket.format == "score_chase" and match.status == "completed":
            advance_score_chase(db, bracket, plugin)
        return _to_score_record_read(record, computed_score)
```

with:

```python
    if match.finals_bracket_id is not None:
        bracket = db.get(FinalsBracket, match.finals_bracket_id)
        if bracket is not None and match.status == "completed":
            if bracket.format == "score_chase":
                advance_score_chase(db, bracket, plugin)
            elif bracket.format == "single_elimination":
                advance_single_elimination(db, bracket, plugin, match)
        return _to_score_record_read(record, computed_score)
```

- [ ] **Step 3: Write a full hand-traced end-to-end test**

Append to `tests/test_finals.py`:

```python
def _score_matchup_game(client, session_id: int, matchup_id: int, red_score: int, blue_score: int):
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    game = next(
        m for m in matches_response.json()
        if m.get("status") != "completed"
        and any(a["station"] == "red" for a in m["alliances"])
        and m["round_type"] == "elimination"
    )
    red_id = next(a["id"] for a in game["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in game["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{game['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": red_score, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{game['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": blue_score, "low_balls": 0, "auto_winner": "tie"}},
    )


def test_single_elimination_full_4_alliance_bracket_traced_end_to_end(client):
    # bracket_size=4, capacity=4, no byes: 2 round-1 games, 1 final.
    # wins_to_advance=[1, 2]: round 1 is single-game, the final is best-of-3.
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": [1, 2]},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    bracket = final_response.json()
    assert bracket["status"] == "in_progress"
    assert len(bracket["matchups"]) == 3  # 2 round-1 + 1 final

    matches_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games = [m for m in matches_response.json() if m["round_type"] == "elimination"]
    assert len(finals_games) == 2  # both round-1 games created immediately (no byes)

    # Round 1, matchup 0: red wins 10-0 (decides the series, wins_to_advance[0]=1).
    _score_matchup_game(client, session_id, None, red_score=10, blue_score=0)
    # Round 1, matchup 1: red wins 10-0.
    _score_matchup_game(client, session_id, None, red_score=10, blue_score=0)

    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    final_matchup = next(m for m in bracket["matchups"] if m["round_number"] == 2)
    assert final_matchup["alliance_a_id"] is not None
    assert final_matchup["alliance_b_id"] is not None

    matches_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games = [m for m in matches_response.json() if m["round_type"] == "elimination"]
    assert len(finals_games) == 3  # the final's first game was created immediately

    # Final, game 1: a tie — doesn't count toward either side's series win.
    _score_matchup_game(client, session_id, None, red_score=5, blue_score=5)
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    finals_games = [m for m in matches_response.json() if m["round_type"] == "elimination"]
    assert len(finals_games) == 4  # an extra game was generated after the tie

    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    assert bracket["status"] == "in_progress"  # still not decided after the tie

    # Final, game 2: red wins (1 win so far, needs 2).
    _score_matchup_game(client, session_id, None, red_score=10, blue_score=0)
    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    assert bracket["status"] == "in_progress"

    # Final, game 3: red wins again (2 wins, reaches wins_to_advance[1]=2).
    _score_matchup_game(client, session_id, None, red_score=10, blue_score=0)
    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    assert bracket["status"] == "complete"
    final_matchup = next(m for m in bracket["matchups"] if m["round_number"] == 2)
    assert final_matchup["winner_alliance_id"] is not None
```

(`_score_matchup_game`'s `matchup_id` parameter is unused by its body — it always finds whichever elimination match is currently unscored, since only one game is ever incomplete at a time in this test's sequence. It's kept as a documentation-only parameter naming which matchup the caller intends, making the test's call sites self-explanatory; pass `None` for it throughout, as shown above.)

- [ ] **Step 4: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals.py -v`
Expected: all pass, including the new end-to-end test.

Run: `.venv/bin/pytest tests/ -v`
Expected: 181 passed (180 from Task 2 + 1 new end-to-end test), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/tournament_server/routers/scores.py \
        src/tournament_server/services/finals.py \
        tests/test_finals.py
git commit -m "Add single-elimination series progression via score submission"
```

---

### Task 4: Captain-pick team-sufficiency check (both finals formats)

**Files:**
- Modify: `src/tournament_server/routers/finals.py`
- Test: `tests/test_finals.py`

**Interfaces:**
- Consumes: `SessionParticipation` (existing, Phase 4), `Team` (existing) — the same query pattern `routers/schedule.py`'s `generate_schedule` already uses for its own eligible-team pool.
- Produces: nothing new for later tasks — this closes a standalone gap.

- [ ] **Step 1: Add the sufficiency check**

In `src/tournament_server/routers/finals.py`, add the imports `from tournament_server.models.participation import SessionParticipation`. Replace:

```python
    field_ids_for_set = db.execute(
        select(Field.id).where(Field.field_set_id == field_set_id)
    ).scalars().all()
    if not field_ids_for_set:
        raise HTTPException(
            status_code=422, detail="This FieldSet has no fields configured"
        )

    ranking_query = select(Ranking).where(Ranking.session_id == payload.session_id)
```

with:

```python
    field_ids_for_set = db.execute(
        select(Field.id).where(Field.field_set_id == field_set_id)
    ).scalars().all()
    if not field_ids_for_set:
        raise HTTPException(
            status_code=422, detail="This FieldSet has no fields configured"
        )

    if alliance_selection == "captain_pick":
        participation_query = select(SessionParticipation).where(
            SessionParticipation.session_id == payload.session_id,
            SessionParticipation.checked_in.is_(True),
        )
        checked_in_team_ids = [
            row.team_id for row in db.execute(participation_query).scalars().all()
        ]
        eligible_team_query = select(Team).where(Team.id.in_(checked_in_team_ids))
        if payload.division_id is None:
            eligible_team_query = eligible_team_query.where(Team.division_id.is_(None))
        else:
            eligible_team_query = eligible_team_query.where(
                Team.division_id == payload.division_id
            )
        eligible_team_count = len(db.execute(eligible_team_query).scalars().all())
        needed_total_teams = payload.bracket_size * 2
        if eligible_team_count < needed_total_teams:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Only {eligible_team_count} teams checked into this "
                    f"session, need {needed_total_teams} for a captain_pick "
                    f"bracket of size {payload.bracket_size}"
                ),
            )

    ranking_query = select(Ranking).where(Ranking.session_id == payload.session_id)
```

(`Team` is already imported in this file.)

- [ ] **Step 2: Update the 3 existing captain-pick tests to check their teams in**

The new check requires `2 * bracket_size` teams checked into the session — each of the following 3 existing tests already creates exactly 4 teams for a `bracket_size=2` bracket (needing exactly 4), so they only need check-in calls added, not more teams.

In `tests/test_finals.py`, in `test_captain_pick_rejects_out_of_turn_pick`, `test_captain_pick_rejects_already_claimed_partner`, and `test_captain_pick_completes_bracket_once_every_captain_has_picked`, each currently has this team-creation block:

```python
    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
```

Immediately after that block (in all 3 tests), add:

```python
    for team_id in team_ids:
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
```

- [ ] **Step 3: Write the new tests**

Append to `tests/test_finals.py`:

```python
def test_start_finals_rejects_insufficient_checked_in_teams_for_captain_pick(captain_pick_client):
    client = captain_pick_client
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "captain-pick-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})

    team_ids = [
        client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        for i in range(4)
    ]
    # Only check in 3 of the 4 teams a bracket_size=2 captain_pick bracket needs.
    for team_id in team_ids[:3]:
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )

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
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": 2},
    )
    assert response.status_code == 422
```

- [ ] **Step 4: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals.py -v`
Expected: all pass, including the new insufficiency test and the 3 updated captain-pick tests (still passing, now with check-ins added).

Run: `.venv/bin/pytest tests/ -v`
Expected: 182 passed (181 from Task 3 + 1 new insufficiency test), 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/tournament_server/routers/finals.py tests/test_finals.py
git commit -m "Add captain_pick team-sufficiency check for both finals formats"
```

---

### Task 5: Walkovers — `BracketAlliance.unavailable` and the marking endpoint

**Files:**
- Modify: `src/tournament_server/models/bracket_alliance.py`
- Modify: `src/tournament_server/schemas/finals.py`
- Modify: `src/tournament_server/services/finals.py`
- Modify: `src/tournament_server/routers/finals.py`
- Test: `tests/test_finals.py`

**Interfaces:**
- Consumes: `_decide_matchup`, `_maybe_create_matchup_game` (Task 2/3).
- Produces: `BracketAlliance.unavailable`; `services/finals.py`'s `mark_unavailable(db, bracket, alliance) -> None` — no later task in this plan depends on it.

- [ ] **Step 1: Add the `unavailable` column**

In `src/tournament_server/models/bracket_alliance.py`, add `from sqlalchemy import Boolean` to the existing `from sqlalchemy import ForeignKey, Integer` import line (making it `from sqlalchemy import Boolean, ForeignKey, Integer`), then replace:

```python
class BracketAlliance(Base):
    __tablename__ = "bracket_alliances"

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    seed: Mapped[int] = mapped_column(Integer)
```

with:

```python
class BracketAlliance(Base):
    __tablename__ = "bracket_alliances"

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    seed: Mapped[int] = mapped_column(Integer)
    unavailable: Mapped[bool] = mapped_column(Boolean, default=False)
```

- [ ] **Step 2: Add `unavailable` to the `BracketAllianceRead` schema**

In `src/tournament_server/schemas/finals.py`, replace:

```python
class BracketAllianceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    seed: int
    team_ids: list[int]
```

with:

```python
class BracketAllianceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    seed: int
    team_ids: list[int]
    unavailable: bool
```

In `src/tournament_server/routers/finals.py`, `_to_bracket_alliance_read` builds `BracketAllianceRead` by keyword arguments — replace:

```python
    return BracketAllianceRead(id=alliance.id, seed=alliance.seed, team_ids=team_ids)
```

with:

```python
    return BracketAllianceRead(
        id=alliance.id, seed=alliance.seed, team_ids=team_ids, unavailable=alliance.unavailable
    )
```

- [ ] **Step 3: Make `_maybe_create_matchup_game` unavailable-aware and add the walkover resolution function**

In `src/tournament_server/services/finals.py`, replace:

```python
def _maybe_create_matchup_game(
    db: Session, bracket: FinalsBracket, matchup: BracketMatchup
) -> None:
    if matchup.winner_alliance_id is not None:
        return
    if matchup.alliance_a_id is None or matchup.alliance_b_id is None:
        return
    incomplete_game = db.execute(
        select(Match).where(
            Match.bracket_matchup_id == matchup.id, Match.status != "completed"
        )
    ).scalars().first()
    if incomplete_game is not None:
        return
    _create_matchup_game(db, bracket, matchup)
```

with:

```python
def _maybe_create_matchup_game(
    db: Session, bracket: FinalsBracket, matchup: BracketMatchup
) -> None:
    if matchup.winner_alliance_id is not None:
        return
    if matchup.alliance_a_id is None or matchup.alliance_b_id is None:
        return
    alliance_a = db.get(BracketAlliance, matchup.alliance_a_id)
    alliance_b = db.get(BracketAlliance, matchup.alliance_b_id)
    if alliance_a.unavailable:
        _decide_matchup(db, bracket, matchup.alliance_b_id, matchup)
        return
    if alliance_b.unavailable:
        _decide_matchup(db, bracket, matchup.alliance_a_id, matchup)
        return
    incomplete_game = db.execute(
        select(Match).where(
            Match.bracket_matchup_id == matchup.id, Match.status != "completed"
        )
    ).scalars().first()
    if incomplete_game is not None:
        return
    _create_matchup_game(db, bracket, matchup)
```

(`_maybe_create_matchup_game` is defined before `_decide_matchup` in this file — Python resolves the call at call time, not definition time, so this forward reference is fine as long as both are defined at module level before either is actually invoked, which they are.)

Then add, after `advance_single_elimination`:

```python
def mark_unavailable(db: Session, bracket: FinalsBracket, alliance: BracketAlliance) -> None:
    alliance.unavailable = True
    db.add(alliance)
    db.commit()

    matchup = db.execute(
        select(BracketMatchup).where(
            BracketMatchup.bracket_id == bracket.id,
            BracketMatchup.winner_alliance_id.is_(None),
        ).where(
            (BracketMatchup.alliance_a_id == alliance.id)
            | (BracketMatchup.alliance_b_id == alliance.id)
        )
    ).scalars().first()
    if matchup is None:
        # Either this alliance already won its way out of the bracket, or
        # its matchup hasn't been reached yet (still waiting on an earlier
        # round) — in the latter case, `_maybe_create_matchup_game` will
        # see the `unavailable` flag and resolve the walkover itself the
        # moment that matchup's other side becomes known.
        return
    if matchup.alliance_a_id is not None and matchup.alliance_b_id is not None:
        _maybe_create_matchup_game(db, bracket, matchup)
```

(`mark_unavailable` only needs to actively resolve anything when the alliance's *current* matchup already has both sides known — `_maybe_create_matchup_game`'s own `unavailable` check then immediately decides it as a walkover instead of creating a game, whether or not a game already exists for it, since the function is called unconditionally here. If the matchup's other side isn't known yet, nothing needs to happen now: the same check fires naturally later, when `_decide_matchup` places a winner into this matchup and calls `_maybe_create_matchup_game` on it.)

- [ ] **Step 4: Add the endpoint**

In `src/tournament_server/routers/finals.py`, add the import `from tournament_server.services.finals import mark_unavailable` (add to the existing `from tournament_server.services.finals import (...)` block). Append at the end of the file:

```python
@router.post(
    "/{bracket_id}/alliances/{alliance_id}/unavailable", response_model=FinalsBracketRead
)
def mark_alliance_unavailable(
    bracket_id: int, alliance_id: int, request: Request, db: Session = Depends(get_db)
) -> FinalsBracketRead:
    bracket = db.get(FinalsBracket, bracket_id)
    if bracket is None:
        raise HTTPException(status_code=404, detail="Finals bracket not found")
    if bracket.format != "single_elimination":
        raise HTTPException(
            status_code=422,
            detail="Marking an alliance unavailable only applies to single_elimination brackets",
        )
    if bracket.status != "in_progress":
        raise HTTPException(
            status_code=409, detail="This bracket is not currently in progress"
        )
    alliance = db.get(BracketAlliance, alliance_id)
    if alliance is None or alliance.bracket_id != bracket_id:
        raise HTTPException(status_code=404, detail="Alliance not found on this bracket")

    mark_unavailable(db, bracket, alliance)

    db.refresh(bracket)
    game_plugin = get_game_plugin_for_event(request, db)
    return _to_finals_bracket_read(bracket, db, game_plugin)
```

- [ ] **Step 5: Write the tests**

Append to `tests/test_finals.py`:

```python
def test_unavailable_alliance_with_known_opponent_resolves_immediately(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 8)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 4, "wins_to_advance": 1},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    bracket = final_response.json()
    round_1_matchup = bracket["matchups"][0]
    alliance_to_forfeit = round_1_matchup["alliance_b_id"]

    response = client.post(
        f"/api/finals/{bracket['id']}/alliances/{alliance_to_forfeit}/unavailable"
    )
    assert response.status_code == 200
    body = response.json()
    decided_matchup = next(m for m in body["matchups"] if m["id"] == round_1_matchup["id"])
    assert decided_matchup["winner_alliance_id"] == round_1_matchup["alliance_a_id"]


def test_unavailable_alliance_waiting_on_earlier_round_resolves_later(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 10)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 5, "wins_to_advance": 1},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    final_response = None
    for i, alliance in enumerate(bracket["alliances"]):
        final_response = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={
                "captain_bracket_alliance_id": alliance["id"],
                "partner_team_id": unclaimed[i],
            },
        )
    bracket = final_response.json()
    round_1 = [m for m in bracket["matchups"] if m["round_number"] == 1]
    bye_matchup = next(m for m in round_1 if m["winner_alliance_id"] is not None)
    real_game_matchup = next(m for m in round_1 if m["winner_alliance_id"] is None)

    # bye_matchup's winner is already sitting in round 2, waiting on
    # real_game_matchup's still-unplayed result. Mark that winner
    # unavailable now — its round-2 matchup has only one side known, so
    # nothing resolves yet.
    response = client.post(
        f"/api/finals/{bracket['id']}/alliances/{bye_matchup['winner_alliance_id']}/unavailable"
    )
    body = response.json()
    round_2_matchup = next(
        m for m in body["matchups"]
        if m["round_number"] == 2
        and (m["alliance_a_id"] == bye_matchup["winner_alliance_id"]
             or m["alliance_b_id"] == bye_matchup["winner_alliance_id"])
    )
    assert round_2_matchup["winner_alliance_id"] is None

    # Now play the still-pending round-1 real game — the moment its winner
    # is placed into round 2, the earlier unavailable flag resolves that
    # round-2 matchup as a walkover instead of creating a game for it.
    matches_response = client.get(f"/api/matches?session_id={session_id}")
    game = next(
        m for m in matches_response.json()
        if m["round_type"] == "elimination" and m["status"] != "completed"
    )
    red_id = next(a["id"] for a in game["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in game["alliances"] if a["station"] == "blue")
    client.post(
        f"/api/matches/{game['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{game['id']}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 0, "low_balls": 0, "auto_winner": "tie"}},
    )

    bracket = client.get(f"/api/finals/{bracket['id']}").json()
    round_2_matchup = next(m for m in bracket["matchups"] if m["id"] == round_2_matchup["id"])
    assert round_2_matchup["winner_alliance_id"] is not None
    assert round_2_matchup["winner_alliance_id"] != bye_matchup["winner_alliance_id"]
```

- [ ] **Step 6: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals.py -v`
Expected: all pass, including both new walkover tests.

Run: `.venv/bin/pytest tests/ -v`
Expected: 184 passed (182 from Task 4 + 2 new walkover tests), 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/tournament_server/models/bracket_alliance.py \
        src/tournament_server/schemas/finals.py \
        src/tournament_server/services/finals.py \
        src/tournament_server/routers/finals.py \
        tests/test_finals.py
git commit -m "Add BracketAlliance.unavailable and the walkover-marking endpoint"
```

---

### Task 6: `DELETE /api/finals/{id}`

**Files:**
- Modify: `src/tournament_server/routers/finals.py`
- Test: `tests/test_finals.py`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Add the cascade-delete endpoint**

In `src/tournament_server/routers/finals.py`, add the imports `from fastapi import Response` (add `Response` to the existing `from fastapi import (...)` line) and `from tournament_server.models.alliance import AllianceTeam` (add to the existing `from tournament_server.models.alliance import Alliance` line, making it `from tournament_server.models.alliance import Alliance, AllianceTeam`) and `from tournament_server.models.bracket_matchup import BracketMatchup` (already added in Task 2). Append at the end of the file:

```python
@router.delete("/{bracket_id}", status_code=204)
def delete_finals(bracket_id: int, db: Session = Depends(get_db)) -> Response:
    bracket = db.get(FinalsBracket, bracket_id)
    if bracket is None:
        raise HTTPException(status_code=404, detail="Finals bracket not found")
    if bracket.status == "complete":
        raise HTTPException(
            status_code=409, detail="Cannot delete a completed finals bracket"
        )

    matches = db.execute(
        select(Match).where(Match.finals_bracket_id == bracket.id)
    ).scalars().all()
    for match in matches:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().all()
        for alliance in alliances:
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
    db.flush()

    for matchup in db.execute(
        select(BracketMatchup).where(BracketMatchup.bracket_id == bracket.id)
    ).scalars().all():
        db.delete(matchup)

    for result in db.execute(
        select(FinalsResult).where(FinalsResult.finals_bracket_id == bracket.id)
    ).scalars().all():
        db.delete(result)

    bracket_alliances = db.execute(
        select(BracketAlliance).where(BracketAlliance.bracket_id == bracket.id)
    ).scalars().all()
    for alliance in bracket_alliances:
        for team_row in db.execute(
            select(BracketAllianceTeam).where(
                BracketAllianceTeam.bracket_alliance_id == alliance.id
            )
        ).scalars().all():
            db.delete(team_row)
        db.flush()
        db.delete(alliance)

    db.delete(bracket)
    db.commit()
    return Response(status_code=204)
```

(This mirrors `routers/schedule.py`'s `clear_schedule` cascade-delete pattern exactly — delete leaf rows before the rows they reference, `flush()` between levels so foreign-key-dependent deletes see a consistent session state.)

- [ ] **Step 2: Write the tests**

Append to `tests/test_finals.py`:

```python
def test_delete_finals_cascades_everything(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _setup_ranked_teams(client, 4)
    _rank_teams_directly(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    ).json()
    first_run_match_id = bracket["runs"][0]["match_id"]

    response = client.delete(f"/api/finals/{bracket['id']}")
    assert response.status_code == 204

    assert client.get(f"/api/finals/{bracket['id']}").status_code == 404
    assert client.get(f"/api/matches/{first_run_match_id}").status_code == 404


def test_delete_finals_rejects_completed_bracket(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _setup_ranked_teams(client, 4)
    _rank_teams_directly(client, session_id, team_ids)

    bracket = client.post(
        "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
    ).json()
    for _ in range(2):
        current = client.get(f"/api/finals/{bracket['id']}").json()
        if current["status"] == "complete":
            break
        pending_run = next(r for r in current["runs"] if r["score"] is None)
        match = client.get(f"/api/matches/{pending_run['match_id']}").json()
        alliance_id = match["alliances"][0]["id"]
        client.post(
            f"/api/matches/{pending_run['match_id']}/alliances/{alliance_id}/score",
            json={"data": {"objects_scored": 5}},
        )
    final = client.get(f"/api/finals/{bracket['id']}").json()
    assert final["status"] == "complete"

    response = client.delete(f"/api/finals/{bracket['id']}")
    assert response.status_code == 409
```

- [ ] **Step 3: Run the tests, then the full suite**

Run: `.venv/bin/pytest tests/test_finals.py -v`
Expected: all pass, including both new delete tests.

Run: `.venv/bin/pytest tests/ -v`
Expected: 186 passed (184 from Task 5 + 2 new delete tests), 0 failures.

- [ ] **Step 4: Commit**

```bash
git add src/tournament_server/routers/finals.py tests/test_finals.py
git commit -m "Add DELETE /api/finals/{id} with full cascade"
```

---

### Task 7: Documentation

**Files:**
- Modify: `server/CLAUDE.md` (repo-relative path: `CLAUDE.md` from the `server/` directory this plan's Global Constraints assume as CWD)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: nothing (documentation only).

- [ ] **Step 1: Extend the "Finals" section**

In `CLAUDE.md`, find the "## Finals" section (added by the score-chase phase) and its "**Only `score_chase` has an engine right now.**" paragraph. Replace that whole paragraph:

```markdown
**Only `score_chase` has an engine right now.** `POST /api/finals/start`
explicitly rejects `single_elimination` with a 422 — the contract accepts
either declared value and the conformance tool validates both, but
starting a bracket for a `single_elimination` game isn't implemented yet.
```

with:

```markdown
`single_elimination` brackets use `BracketMatchup` (`id, bracket_id,
round_number, position, alliance_a_id, alliance_b_id, winner_alliance_id`)
for the tree — which matchup feeds which is computed from
`round_number`/`position` arithmetic (`(round, position)` feeds into
`(round + 1, position // 2)`), never stored as an explicit pointer.
Seeding uses the standard recursive tournament-bracket order
(`services/finals.py`'s `_seed_order`), with byes going to the top seeds
when `bracket_size` isn't a power of two — byes only ever occur in round
1 (a property guaranteed by `bracket_capacity` always picking the
smallest power of two `>= bracket_size`), so bracket generation resolves
them with a single forward pass into round 2, not a repeated cascade.

A matchup's first game is created the instant both its sides are known
(from seeding, a bye, or an earlier matchup's winner) — `submit_score`
detects `Match.bracket_matchup_id` and calls
`services/finals.py`'s `advance_single_elimination`, which counts a
series' decided games (a tie counts toward neither side) against that
round's `wins_to_advance` and creates another game, decides the matchup,
or does nothing if the last completed game wasn't the last one currently
in flight (the same score-correction safety `advance_score_chase` already
has for score-chase). `wins_to_advance` is a per-round list (`POST
/api/finals/start` accepts a single int, expanded uniformly, or an
explicit list whose length must exactly match the bracket's round count)
— e.g. `[1, 1, 1, 2]` for a bracket where every round is single-game
except a best-of-3 final.

`POST /api/finals/{id}/alliances/{alliance_id}/unavailable`
(`single_elimination` only, bracket must be `"in_progress"`) marks a
`BracketAlliance.unavailable` and resolves an immediate walkover if its
current matchup's opponent is already known (mid-series or not);
otherwise the flag is simply checked later, at the moment that matchup
would otherwise get its first game.

`DELETE /api/finals/{id}` cascades the bracket and everything it created
(alliances, matchups or results, matches/alliances/scores) — 409 once the
bracket is `"complete"`, matching `DELETE /api/schedule`'s existing
cascade-delete pattern for qualification rounds.

Starting a `captain_pick` bracket (either format) additionally requires
`2 * bracket_size` teams checked into the session
(`SessionParticipation.checked_in`) — enough for both the captains and
the partners they'll pick — using the same eligible-team-pool query
`routers/schedule.py`'s `generate_schedule` already builds.
```

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "Document single-elimination brackets"
```

