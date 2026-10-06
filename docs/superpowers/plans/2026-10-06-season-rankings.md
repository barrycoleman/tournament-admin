# Season Rankings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Each session gets a Rankings tab and the event gets a Season Rankings page; cooperative events gain admin-set drop rules for sessions and the season; head-to-head events gain season standings.

**Architecture:** A new pure module (`services/ranking_rules.py`) holds every drop/keep rule and is unit-tested exhaustively. A one-row-per-event `ranking_settings` table replaces the per-division `ranking_configurations`. `services/ranking.py` is rewritten to gather match records, apply the rules, and *replace* a scope's `Ranking` rows on every recompute, for both game models and for the season. The admin app gets two read-only pages built from shared rankings components, plus a settings panel on Event Setup.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy 2.1 / Alembic / pytest. React 19 / TanStack Query 5 / react-i18next / Vitest / Playwright.

**Spec:** `docs/superpowers/specs/2026-10-06-season-rankings-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere (code, comments, commit messages, UI text).
- Every backend change ships with pytest tests against a real FastAPI `TestClient` and a real temp-file SQLite database, in the same change.
- Every frontend change ships with Vitest component tests and Playwright E2E coverage, with no mocking at the HTTP/WebSocket boundary in E2E.
- Schema changes go through Alembic migrations (`server/src/tournament_server/_alembic/versions/`). Existing ranking configuration is carried forward, not discarded. `tests/test_alembic_drift.py` must stay green.
- Every user-facing string goes through `t(...)` in both `frontend/apps/admin/src/i18n/en/admin.json` and `.../zh/admin.json`.
- No change to the game-plugin interface. `rank_teams` keeps its current input and output shapes.
- Work on the existing `season-rankings` branch in the main checkout. No worktrees. Commit after each task; never push.
- Server tests: `cd server && .venv/bin/pytest`. Frontend unit tests: `cd frontend/apps/admin && npm test`. Type check: `cd frontend/apps/admin && npx tsc --noEmit`. E2E: `cd frontend/apps/admin && npm run test:e2e`.

## Review Focus

1. **A single-division event whose matches carry no division** (`division_id = null`, which the scheduler produces for single-division events) while a division row exists. The Rankings pages must still show those teams. Pinned by a Task 4 unit test.
2. **An admin selects the cooperative game while Event Setup is open.** The Ranking settings panel must appear without a reload. Task 6 invalidates the settings query on plugin selection; the Task 7 E2E selects the plugin through the UI and expects the panel.
3. **Settings saved in an event with several divisions.** Every division's session rows must recompute, not just the event-wide ones. Pinned by a Task 3 integration test.
4. **Typed numbers like `2.5`, `-1` or ` 3 ` in the settings form.** Decimals and negatives get a field message and nothing is sent; surrounding spaces are trimmed and accepted. Pinned by Task 6 draft tests and a panel test.
5. **A DQ ruled on a match after its session already earned a drop.** The DQ zero stays counted (when DQs may not be dropped) and the next-lowest droppable match is dropped instead. Pinned by a Task 3 integration test.

## Rulings made while planning

- **Two Alembic revisions, not one.** The first creates `ranking_settings` and converts old rows (Task 2); the second drops `ranking_configurations` in the same commit that deletes its model (Task 3). The drift test forbids dropping a table whose model still exists, and the old model is still read until Task 3's rewrite. The spec was amended to say so.
- **Finals exclusion has no new integration test.** The `finals_bracket_id IS NULL` filter is unchanged and already relied on by the finals tests; building a finals bracket inside the season tests costs more than it proves. Practice exclusion does get a season test.
- **Rankings tables are plain `<table className="table">`, not `react-data-grid`.** They're short, read-only and need no editing or virtualization.
- **Rows are replaced, not upserted.** Each recompute deletes the scope's `Ranking` rows and inserts the new ranked list. Nothing references `Ranking.id`.

---

### Task 1: Pure ranking rules

**Files:**
- Create: `server/src/tournament_server/services/ranking_rules.py`
- Modify: `server/src/tournament_server/services/ranking.py` (delete `suggest_exclusion_count`, lines 24–33; nothing else imports it)
- Test: `server/tests/test_ranking_rules.py`

**Interfaces:**
- Produces (used by Tasks 2 and 3):
  - `MatchRecord(match_id: int, session_id: int, score: int, no_show: bool = False, dq: bool = False)`, frozen dataclass
  - `RankingRules(session_drop_mode: str = "tiered", session_drop_count: int = 1, session_drop_no_show: bool = False, session_drop_dq: bool = False, season_keep_best: int | None = None, season_only_session_counted: bool = False, season_minimum: int = 0, season_drop_no_show: bool = False, season_drop_dq: bool = False)`, frozen dataclass
  - `suggest_exclusion_count(scheduled: int) -> int`
  - `session_drop_allowance(scheduled: int, rules: RankingRules) -> int`
  - `session_drops(records: list[MatchRecord], scheduled: int, rules: RankingRules) -> set[int]` (match ids)
  - `session_score(records: list[MatchRecord], dropped: set[int]) -> float`
  - `season_score(records: list[MatchRecord], session_dropped: set[int], rules: RankingRules) -> float`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_ranking_rules.py`:

```python
import pytest

from tournament_server.services.ranking_rules import (
    MatchRecord,
    RankingRules,
    season_score,
    session_drop_allowance,
    session_drops,
    session_score,
    suggest_exclusion_count,
)


def rec(match_id, score, session_id=1, no_show=False, dq=False):
    return MatchRecord(match_id=match_id, session_id=session_id, score=score, no_show=no_show, dq=dq)


def ascending(count):
    """count records with distinct scores 10, 20, ... so the lowest is unambiguous."""
    return [rec(i, i * 10) for i in range(1, count + 1)]


@pytest.mark.parametrize(
    "scheduled, expected",
    [(0, 0), (3, 0), (4, 1), (7, 1), (8, 2), (11, 2), (12, 3), (15, 3), (16, 4), (30, 4)],
)
def test_tier_table_on_scheduled_matches(scheduled, expected):
    assert suggest_exclusion_count(scheduled) == expected
    assert session_drop_allowance(scheduled, RankingRules()) == expected


def test_allowance_for_none_and_lowest():
    assert session_drop_allowance(20, RankingRules(session_drop_mode="none")) == 0
    assert session_drop_allowance(2, RankingRules(session_drop_mode="lowest", session_drop_count=3)) == 3


@pytest.mark.parametrize("scored, expected_drops", [(5, 0), (7, 0), (8, 1), (9, 2), (10, 3)])
def test_lowest_p_drops_are_earned_against_the_schedule(scored, expected_drops):
    rules = RankingRules(session_drop_mode="lowest", session_drop_count=3)
    records = ascending(scored)
    dropped = session_drops(records, scheduled=10, rules=rules)
    assert dropped == {r.match_id for r in records[:expected_drops]}


@pytest.mark.parametrize("scored, expected_drops", [(12, 0), (13, 1), (14, 2), (16, 4)])
def test_tiered_drops_are_earned_on_the_last_scheduled_matches(scored, expected_drops):
    records = ascending(scored)
    assert len(session_drops(records, scheduled=16, rules=RankingRules())) == expected_drops


def test_none_drops_nothing():
    assert session_drops(ascending(16), scheduled=16, rules=RankingRules(session_drop_mode="none")) == set()


def test_lowest_p_at_least_the_schedule_keeps_one_record():
    rules = RankingRules(session_drop_mode="lowest", session_drop_count=3)
    records = ascending(3)
    assert session_drops(records, scheduled=3, rules=rules) == {1, 2}
    assert session_drops([rec(1, 20)], scheduled=1, rules=rules) == set()


def test_protected_no_show_is_skipped_and_the_next_lowest_dropped():
    records = [rec(1, 0, no_show=True), rec(2, 10), rec(3, 20), rec(4, 30)]
    assert session_drops(records, scheduled=4, rules=RankingRules()) == {2}
    allowed = RankingRules(session_drop_no_show=True)
    assert session_drops(records, scheduled=4, rules=allowed) == {1}


def test_protected_dq_is_skipped_and_the_next_lowest_dropped():
    records = [rec(1, 0, dq=True), rec(2, 10), rec(3, 20), rec(4, 30)]
    assert session_drops(records, scheduled=4, rules=RankingRules()) == {2}
    # Allowing no-shows to be dropped does nothing for a DQ.
    assert session_drops(records, scheduled=4, rules=RankingRules(session_drop_no_show=True)) == {2}
    assert session_drops(records, scheduled=4, rules=RankingRules(session_drop_dq=True)) == {1}


def test_equal_scores_drop_the_earliest_match():
    records = [rec(5, 10), rec(2, 10), rec(7, 20), rec(8, 30)]
    assert session_drops(records, scheduled=4, rules=RankingRules()) == {2}


def test_session_score_is_the_mean_of_kept_records():
    records = [rec(1, 10), rec(2, 20), rec(3, 30)]
    assert session_score(records, {1}) == 25.0
    assert session_score(records, set()) == 20.0
    assert session_score([], set()) == 0.0


def test_season_shortfall_fills_with_zeroes():
    records = [rec(i, i, session_id=1 if i <= 10 else 2) for i in range(1, 21)]
    rules = RankingRules(season_keep_best=24, season_minimum=24, season_only_session_counted=True)
    # Sessions dropped matches 1, 2 and 3: 17 remain, sum 204, divided by the minimum.
    assert season_score(records, {1, 2, 3}, rules) == 204 / 24


def test_season_forced_zero_takes_one_of_the_n_slots():
    records = [rec(1, 0, dq=True)] + [rec(i, s) for i, s in zip(range(2, 8), [50, 40, 30, 20, 10, 5])]
    assert season_score(records, set(), RankingRules(season_keep_best=5)) == 28.0


def test_season_more_forced_zeroes_than_n_scores_zero():
    records = [rec(i, 0, dq=True) for i in range(1, 5)] + [rec(9, 80)]
    assert season_score(records, set(), RankingRules(season_keep_best=3)) == 0.0


def test_season_keeps_a_session_dropped_zero_that_the_season_protects():
    records = [rec(1, 0, no_show=True), rec(2, 30), rec(3, 40)]
    rules = RankingRules(season_only_session_counted=True)
    assert season_score(records, {1}, rules) == pytest.approx(70 / 3)
    allowed = RankingRules(season_only_session_counted=True, season_drop_no_show=True)
    assert season_score(records, {1}, allowed) == 35.0


def test_season_defaults_are_a_plain_average():
    records = [rec(1, 10), rec(2, 20), rec(3, 60)]
    assert season_score(records, {1}, RankingRules()) == 30.0
    assert season_score([], set(), RankingRules()) == 0.0


def test_season_minimum_without_n():
    assert season_score([rec(1, 30), rec(2, 30)], set(), RankingRules(season_minimum=4)) == 15.0


def test_season_n_without_minimum():
    records = [rec(1, 10), rec(2, 20), rec(3, 30)]
    assert season_score(records, set(), RankingRules(season_keep_best=2)) == 25.0


def test_season_checkbox_off_versus_on():
    records = [rec(1, 10), rec(2, 20), rec(3, 30)]
    assert season_score(records, {1}, RankingRules()) == 20.0
    assert season_score(records, {1}, RankingRules(season_only_session_counted=True)) == 25.0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest tests/test_ranking_rules.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'tournament_server.services.ranking_rules'`.

- [ ] **Step 3: Write the module**

Create `server/src/tournament_server/services/ranking_rules.py`:

```python
"""Pure ranking rules: which of a team's cooperative matches are dropped and counted.

No database access and no plugin calls, so every rule is unit-tested directly.
services/ranking.py gathers the records, calls these, and writes the rows.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MatchRecord:
    """One team's result in one completed qualification match."""

    match_id: int
    session_id: int
    score: int  # already 0 for a no-show or DQ
    no_show: bool = False
    dq: bool = False


@dataclass(frozen=True)
class RankingRules:
    """An event's ranking settings; the defaults give a plain average with tiered session drops."""

    session_drop_mode: str = "tiered"  # tiered | none | lowest
    session_drop_count: int = 1
    session_drop_no_show: bool = False
    session_drop_dq: bool = False
    season_keep_best: int | None = None
    season_only_session_counted: bool = False
    season_minimum: int = 0
    season_drop_no_show: bool = False
    season_drop_dq: bool = False


def suggest_exclusion_count(scheduled: int) -> int:
    """The tier table, applied to a team's scheduled qualification matches."""
    if scheduled >= 16:
        return 4
    if scheduled >= 12:
        return 3
    if scheduled >= 8:
        return 2
    if scheduled >= 4:
        return 1
    return 0


def _droppable(record: MatchRecord, allow_no_show: bool, allow_dq: bool) -> bool:
    if record.no_show and not allow_no_show:
        return False
    if record.dq and not allow_dq:
        return False
    return True


def session_drop_allowance(scheduled: int, rules: RankingRules) -> int:
    if rules.session_drop_mode == "none":
        return 0
    if rules.session_drop_mode == "lowest":
        return rules.session_drop_count
    return suggest_exclusion_count(scheduled)


def session_drops(records: list[MatchRecord], scheduled: int, rules: RankingRules) -> set[int]:
    """Match ids dropped from one team's ranking in one session.

    Drops are earned only as the last `allowance` scheduled matches are
    scored, and a team's last record is never dropped.
    """
    allowance = session_drop_allowance(scheduled, rules)
    earned = min(allowance, max(0, len(records) - (scheduled - allowance)))
    earned = min(earned, max(0, len(records) - 1))
    dropped: set[int] = set()
    for record in sorted(records, key=lambda r: (r.score, r.match_id)):
        if len(dropped) >= earned:
            break
        if _droppable(record, rules.session_drop_no_show, rules.session_drop_dq):
            dropped.add(record.match_id)
    return dropped


def session_score(records: list[MatchRecord], dropped: set[int]) -> float:
    kept = [r.score for r in records if r.match_id not in dropped]
    return sum(kept) / len(kept) if kept else 0.0


def season_score(
    records: list[MatchRecord], session_dropped: set[int], rules: RankingRules
) -> float:
    """One team's season score across every session.

    `session_dropped` holds the match ids its sessions dropped; they leave the
    pool only when `season_only_session_counted` is on, and never when the
    season protects that zero. Forced zeroes fill the N slots first; the
    divisor is never below `season_minimum`.
    """

    def season_droppable(record: MatchRecord) -> bool:
        return _droppable(record, rules.season_drop_no_show, rules.season_drop_dq)

    pool = [
        r
        for r in records
        if not (
            rules.season_only_session_counted
            and r.match_id in session_dropped
            and season_droppable(r)
        )
    ]
    if rules.season_keep_best is None:
        kept = pool
    else:
        forced = sorted((r for r in pool if not season_droppable(r)), key=lambda r: r.match_id)
        others = sorted((r for r in pool if season_droppable(r)), key=lambda r: (-r.score, r.match_id))
        kept = forced[: rules.season_keep_best]
        kept = kept + others[: rules.season_keep_best - len(kept)]
    divisor = max(len(kept), rules.season_minimum)
    return sum(r.score for r in kept) / divisor if divisor else 0.0
```

In `server/src/tournament_server/services/ranking.py`, delete the `suggest_exclusion_count` function (it now lives in `ranking_rules.py`; `grep -rn suggest_exclusion_count server/` should then only show `ranking_rules.py` and the new test).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && .venv/bin/pytest tests/test_ranking_rules.py -q && .venv/bin/pytest -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/services/ranking_rules.py server/src/tournament_server/services/ranking.py server/tests/test_ranking_rules.py
git commit -m "Add pure rules for cooperative session drops and season scores"
```

---

### Task 2: Ranking settings storage and API

**Files:**
- Create: `server/src/tournament_server/models/ranking_settings.py`
- Create: `server/src/tournament_server/_alembic/versions/b3e8d1f0a6c2_add_ranking_settings.py`
- Create: `server/src/tournament_server/services/ranking_settings.py`
- Create: `server/src/tournament_server/schemas/ranking_settings.py`
- Create: `server/src/tournament_server/routers/ranking_settings.py`
- Modify: `server/src/tournament_server/models/__init__.py` (register the model)
- Modify: `server/src/tournament_server/app.py` (import and `include_router` the new router next to `rankings`)
- Modify: `server/src/tournament_server/services/ranking.py` (add `recompute_all_rankings`)
- Create: `server/tests/ranking_helpers.py`
- Test: `server/tests/test_ranking_settings.py`, `server/tests/test_migrations.py` (append)

**Interfaces:**
- Consumes: `RankingRules` from Task 1.
- Produces:
  - Model `RankingSettings` (table `ranking_settings`), columns named exactly as `RankingRules` fields plus `id`, `event_id`.
  - `services/ranking_settings.py`: `SESSION_DROP_MODES`, `RULE_FIELDS`, `load_ranking_settings(db, event_id) -> RankingSettings`, `rules_from_settings(settings) -> RankingRules`, `load_rules(db) -> RankingRules`, `settings_error(rules: RankingRules) -> str | None`
  - `services/ranking.py`: `recompute_all_rankings(app, db, plugin, event_id) -> None`
  - HTTP: `GET /api/ranking-settings` → `RankingSettingsRead` (the nine fields + `game_model`), `PUT /api/ranking-settings` (admin) with the nine fields.
  - `tests/ranking_helpers.py`: `DEFAULT_SETTINGS: dict`
  - Alembic revision `b3e8d1f0a6c2` (down: `f6b2d4c8e1a7`).

- [ ] **Step 1: Write the failing API tests**

Create `server/tests/ranking_helpers.py`:

```python
DEFAULT_SETTINGS = {
    "session_drop_mode": "tiered",
    "session_drop_count": 1,
    "session_drop_no_show": False,
    "session_drop_dq": False,
    "season_keep_best": None,
    "season_only_session_counted": False,
    "season_minimum": 0,
    "season_drop_no_show": False,
    "season_drop_dq": False,
}
```

Create `server/tests/test_ranking_settings.py`:

```python
import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from ranking_helpers import DEFAULT_SETTINGS


def test_first_read_returns_defaults_and_no_game_model(client):
    client.post("/api/event", json={"name": "League"})
    response = client.get("/api/ranking-settings")
    assert response.status_code == 200, response.text
    assert response.json() == {**DEFAULT_SETTINGS, "game_model": None}


def test_reports_head_to_head_game_model(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert client.get("/api/ranking-settings").json()["game_model"] == "head_to_head"


def test_reports_cooperative_game_model(cooperative_client):
    cooperative_client.post("/api/event", json={"name": "League"})
    cooperative_client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    assert cooperative_client.get("/api/ranking-settings").json()["game_model"] == "cooperative_score"


def test_put_saves_every_field(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    body = {
        "session_drop_mode": "lowest",
        "session_drop_count": 2,
        "session_drop_no_show": True,
        "session_drop_dq": False,
        "season_keep_best": 24,
        "season_only_session_counted": True,
        "season_minimum": 20,
        "season_drop_no_show": False,
        "season_drop_dq": True,
    }
    response = client.put("/api/ranking-settings", json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {**body, "game_model": "cooperative_score"}
    assert client.get("/api/ranking-settings").json() == {**body, "game_model": "cooperative_score"}


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"session_drop_mode": "sometimes"}, "session_drop_mode must be one of: tiered, none, lowest"),
        ({"session_drop_count": 0}, "session_drop_count must be at least 1"),
        ({"season_keep_best": 0}, "season_keep_best must be at least 1 when set"),
        ({"season_minimum": -1}, "season_minimum must be 0 or more"),
        (
            {"season_keep_best": 10, "season_minimum": 11},
            "season_minimum cannot be more than season_keep_best",
        ),
    ],
)
def test_put_rejects_invalid_settings(client, changes, message):
    client.post("/api/event", json={"name": "League"})
    response = client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, **changes})
    assert response.status_code == 422
    assert response.json()["detail"] == message
    assert client.get("/api/ranking-settings").json() == {**DEFAULT_SETTINGS, "game_model": None}


def test_put_is_admin_only_and_get_is_open_to_any_role(client):
    client.post("/api/event", json={"name": "League"})
    raw = TestClient(client.app)
    token = login_as(raw, "scorer")
    assert raw.put("/api/ranking-settings", json=DEFAULT_SETTINGS, headers=bearer(token)).status_code == 403
    assert raw.get("/api/ranking-settings", headers=bearer(token)).status_code == 200


def test_put_without_a_game_plugin_saves(client):
    client.post("/api/event", json={"name": "League"})
    response = client.put(
        "/api/ranking-settings", json={**DEFAULT_SETTINGS, "session_drop_mode": "none"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["session_drop_mode"] == "none"


def test_put_recomputes_existing_rankings(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
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
    red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    client.post(f"/api/matches/{match['id']}/alliances/{red}/score", json={"data": {"objects_scored": 10}})

    response = client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, "season_minimum": 2})
    assert response.status_code == 200, response.text
    assert {row["team_id"] for row in client.get(f"/api/rankings?session_id={session_id}").json()} == {t1, t2}
```

- [ ] **Step 2: Write the failing migration test**

Add `import pytest` to the imports of `server/tests/test_migrations.py` (it has none today), then append:

```python
@pytest.mark.parametrize(
    "configurations, expected",
    [
        (
            [(1, None, "exclude", 2, 1, 0)],
            {"session_drop_mode": "lowest", "session_drop_count": 2,
             "session_drop_no_show": 1, "session_drop_dq": 0,
             "season_keep_best": None, "season_minimum": 0,
             "season_drop_no_show": 1, "season_drop_dq": 0},
        ),
        (
            [(1, None, "include", 5, 0, 1)],
            {"session_drop_mode": "tiered", "session_drop_count": 1,
             "session_drop_no_show": 0, "session_drop_dq": 1,
             "season_keep_best": 5, "season_minimum": 5,
             "season_drop_no_show": 0, "season_drop_dq": 1},
        ),
        (
            [(1, 1, "exclude", 1, 0, 0)],
            {"session_drop_mode": "lowest", "session_drop_count": 1,
             "session_drop_no_show": 0, "session_drop_dq": 0,
             "season_keep_best": None, "season_minimum": 0,
             "season_drop_no_show": 0, "season_drop_dq": 0},
        ),
        (
            # The event-wide row wins over a lower-id per-division row.
            [(1, 1, "include", 3, 0, 0), (2, None, "exclude", 1, 0, 0)],
            {"session_drop_mode": "lowest", "session_drop_count": 1,
             "session_drop_no_show": 0, "session_drop_dq": 0,
             "season_keep_best": None, "season_minimum": 0,
             "season_drop_no_show": 0, "season_drop_dq": 0},
        ),
        ([], None),
    ],
)
def test_ranking_configuration_converts_to_ranking_settings(tmp_path, configurations, expected):
    db_path = str(tmp_path / "ranking_configuration.db")
    config = _make_alembic_config(db_path)
    command.upgrade(config, "f6b2d4c8e1a7")  # the revision before ranking_settings

    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text("INSERT INTO events (id, name, created_at) VALUES (1, 'League', '2026-01-01 00:00:00')")
        )
        connection.execute(text("INSERT INTO divisions (id, event_id, name) VALUES (1, 1, 'Rookie')"))
        for row_id, division_id, mode, count, no_show, dq in configurations:
            connection.execute(
                text(
                    "INSERT INTO ranking_configurations (id, event_id, division_id, mode, count, "
                    "allow_drop_no_show, allow_drop_dq) VALUES (:id, 1, :division_id, :mode, :count, "
                    ":no_show, :dq)"
                ),
                {"id": row_id, "division_id": division_id, "mode": mode, "count": count,
                 "no_show": no_show, "dq": dq},
            )
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    assert ensure_schema_current(engine, db_path) == MigrationOutcome.UPGRADED
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT session_drop_mode, session_drop_count, session_drop_no_show, session_drop_dq, "
                "season_keep_best, season_minimum, season_drop_no_show, season_drop_dq, "
                "season_only_session_counted FROM ranking_settings WHERE event_id = 1"
            )
        ).mappings().all()
    if expected is None:
        assert rows == []
    else:
        assert len(rows) == 1
        assert dict(rows[0]) == {**expected, "season_only_session_counted": 0}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest tests/test_ranking_settings.py tests/test_migrations.py -q`
Expected: the settings tests fail with 404 (no route); the migration test fails with `no such table: ranking_settings`.

- [ ] **Step 4: Add the model**

Create `server/src/tournament_server/models/ranking_settings.py`:

```python
from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class RankingSettings(Base):
    """How an event ranks teams. One row per event, shared by every division;
    head-to-head events store it but ignore it."""

    __tablename__ = "ranking_settings"
    __table_args__ = (UniqueConstraint("event_id", name="uq_ranking_settings_event"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    session_drop_mode: Mapped[str] = mapped_column(String(20), default="tiered")
    session_drop_count: Mapped[int] = mapped_column(Integer, default=1)
    session_drop_no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    session_drop_dq: Mapped[bool] = mapped_column(Boolean, default=False)
    season_keep_best: Mapped[int | None] = mapped_column(Integer, default=None)
    season_only_session_counted: Mapped[bool] = mapped_column(Boolean, default=False)
    season_minimum: Mapped[int] = mapped_column(Integer, default=0)
    season_drop_no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    season_drop_dq: Mapped[bool] = mapped_column(Boolean, default=False)
```

In `server/src/tournament_server/models/__init__.py`, add after the `Ranking` import:

```python
from tournament_server.models.ranking_settings import RankingSettings
```

(and add `"RankingSettings"` to `__all__` if that file defines one).

- [ ] **Step 5: Add the migration**

Create `server/src/tournament_server/_alembic/versions/b3e8d1f0a6c2_add_ranking_settings.py`:

```python
"""add ranking_settings, converted from ranking_configurations

Revision ID: b3e8d1f0a6c2
Revises: f6b2d4c8e1a7
Create Date: 2026-10-06 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b3e8d1f0a6c2'
down_revision: Union[str, None] = 'f6b2d4c8e1a7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'ranking_settings',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('event_id', sa.Integer(), nullable=False),
        sa.Column('session_drop_mode', sa.String(length=20), nullable=False),
        sa.Column('session_drop_count', sa.Integer(), nullable=False),
        sa.Column('session_drop_no_show', sa.Boolean(), nullable=False),
        sa.Column('session_drop_dq', sa.Boolean(), nullable=False),
        sa.Column('season_keep_best', sa.Integer(), nullable=True),
        sa.Column('season_only_session_counted', sa.Boolean(), nullable=False),
        sa.Column('season_minimum', sa.Integer(), nullable=False),
        sa.Column('season_drop_no_show', sa.Boolean(), nullable=False),
        sa.Column('season_drop_dq', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('event_id', name='uq_ranking_settings_event'),
    )

    # Carry each event's old configuration forward: the event-wide row wins,
    # otherwise the lowest-id per-division row. "exclude N" was a session
    # drop of the lowest N; "include N" kept the best N and zero-padded the
    # shortfall, which is season N with a minimum of N.
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT event_id, mode, count, allow_drop_no_show, allow_drop_dq "
            "FROM ranking_configurations ORDER BY (division_id IS NOT NULL), id"
        )
    ).fetchall()
    converted: set[int] = set()
    for row in rows:
        if row.event_id in converted:
            continue
        converted.add(row.event_id)
        values = {
            "event_id": row.event_id,
            "session_drop_mode": "tiered",
            "session_drop_count": 1,
            "session_drop_no_show": bool(row.allow_drop_no_show),
            "session_drop_dq": bool(row.allow_drop_dq),
            "season_keep_best": None,
            "season_only_session_counted": False,
            "season_minimum": 0,
            "season_drop_no_show": bool(row.allow_drop_no_show),
            "season_drop_dq": bool(row.allow_drop_dq),
        }
        if row.mode == "exclude":
            values["session_drop_mode"] = "lowest"
            values["session_drop_count"] = row.count
        elif row.mode == "include":
            values["season_keep_best"] = row.count
            values["season_minimum"] = row.count
        bind.execute(
            sa.text(
                "INSERT INTO ranking_settings (event_id, session_drop_mode, session_drop_count, "
                "session_drop_no_show, session_drop_dq, season_keep_best, "
                "season_only_session_counted, season_minimum, season_drop_no_show, season_drop_dq) "
                "VALUES (:event_id, :session_drop_mode, :session_drop_count, :session_drop_no_show, "
                ":session_drop_dq, :season_keep_best, :season_only_session_counted, :season_minimum, "
                ":season_drop_no_show, :season_drop_dq)"
            ),
            values,
        )


def downgrade() -> None:
    op.drop_table('ranking_settings')
```

- [ ] **Step 6: Add the settings service, schemas and router**

Create `server/src/tournament_server/services/ranking_settings.py`:

```python
"""Loading an event's ranking settings as RankingRules, and validating new ones."""
from __future__ import annotations

from dataclasses import fields

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_the_event
from tournament_server.models.ranking_settings import RankingSettings
from tournament_server.services.ranking_rules import RankingRules

SESSION_DROP_MODES = ("tiered", "none", "lowest")
RULE_FIELDS = tuple(field.name for field in fields(RankingRules))


def load_ranking_settings(db: Session, event_id: int) -> RankingSettings:
    """The event's settings row, created with the defaults (and flushed) when missing."""
    settings = db.execute(
        select(RankingSettings).where(RankingSettings.event_id == event_id)
    ).scalars().first()
    if settings is None:
        defaults = RankingRules()
        settings = RankingSettings(
            event_id=event_id, **{name: getattr(defaults, name) for name in RULE_FIELDS}
        )
        db.add(settings)
        db.flush()
    return settings


def rules_from_settings(settings: RankingSettings) -> RankingRules:
    return RankingRules(**{name: getattr(settings, name) for name in RULE_FIELDS})


def load_rules(db: Session) -> RankingRules:
    event = get_the_event(db)
    if event is None:
        return RankingRules()
    return rules_from_settings(load_ranking_settings(db, event.id))


def settings_error(rules: RankingRules) -> str | None:
    """A readable reason the settings are invalid, or None."""
    if rules.session_drop_mode not in SESSION_DROP_MODES:
        return f"session_drop_mode must be one of: {', '.join(SESSION_DROP_MODES)}"
    if rules.session_drop_count < 1:
        return "session_drop_count must be at least 1"
    if rules.season_keep_best is not None and rules.season_keep_best < 1:
        return "season_keep_best must be at least 1 when set"
    if rules.season_minimum < 0:
        return "season_minimum must be 0 or more"
    if rules.season_keep_best is not None and rules.season_minimum > rules.season_keep_best:
        return "season_minimum cannot be more than season_keep_best"
    return None
```

Create `server/src/tournament_server/schemas/ranking_settings.py`:

```python
from __future__ import annotations

from pydantic import BaseModel


class RankingSettingsBody(BaseModel):
    session_drop_mode: str = "tiered"
    session_drop_count: int = 1
    session_drop_no_show: bool = False
    session_drop_dq: bool = False
    season_keep_best: int | None = None
    season_only_session_counted: bool = False
    season_minimum: int = 0
    season_drop_no_show: bool = False
    season_drop_dq: bool = False


class RankingSettingsRead(RankingSettingsBody):
    # head_to_head / cooperative_score, or None before a game plugin is chosen.
    game_model: str | None
```

Create `server/src/tournament_server/routers/ranking_settings.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.event import Event
from tournament_server.models.ranking_settings import RankingSettings
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.schemas.ranking_settings import RankingSettingsBody, RankingSettingsRead
from tournament_server.services.ranking import recompute_all_rankings
from tournament_server.services.ranking_rules import RankingRules
from tournament_server.services.ranking_settings import (
    RULE_FIELDS,
    load_ranking_settings,
    settings_error,
)

router = APIRouter(prefix="/api/ranking-settings", tags=["ranking-settings"])


def _event_or_404(db: Session) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    return event


def _game_plugin(request: Request, event: Event) -> LoadedPlugin | None:
    if event.game_plugin_name is None:
        return None
    return request.app.state.game_plugins.get(event.game_plugin_name)


def _to_read(settings: RankingSettings, plugin: LoadedPlugin | None) -> RankingSettingsRead:
    game_model = plugin.module.match_format()["game_model"] if plugin is not None else None
    return RankingSettingsRead(
        **{name: getattr(settings, name) for name in RULE_FIELDS}, game_model=game_model
    )


@router.get("", response_model=RankingSettingsRead)
def get_ranking_settings(
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> RankingSettingsRead:
    event = _event_or_404(db)
    settings = load_ranking_settings(db, event.id)
    db.commit()
    return _to_read(settings, _game_plugin(request, event))


@router.put("", response_model=RankingSettingsRead)
def put_ranking_settings(
    payload: RankingSettingsBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> RankingSettingsRead:
    event = _event_or_404(db)
    error = settings_error(RankingRules(**payload.model_dump()))
    if error is not None:
        raise HTTPException(status_code=422, detail=error)
    settings = load_ranking_settings(db, event.id)
    for name, value in payload.model_dump().items():
        setattr(settings, name, value)
    db.commit()
    plugin = _game_plugin(request, event)
    if plugin is not None:
        recompute_all_rankings(request.app, db, plugin, event.id)
    db.refresh(settings)
    return _to_read(settings, plugin)
```

In `server/src/tournament_server/app.py`, add `ranking_settings,` to the `from tournament_server.routers import (...)` list (alphabetically, after `ranking_configuration,`) and `app.include_router(ranking_settings.router)` after `app.include_router(rankings.router)`.

Add to the end of `server/src/tournament_server/services/ranking.py`:

```python
def recompute_all_rankings(
    app: "FastAPI", db: Session, plugin: LoadedPlugin, event_id: int
) -> None:
    """Every session's rankings, then the season's, for each division with qualification matches.

    Called after the ranking settings change.
    """
    session_ids = select(TournamentSession.id).where(TournamentSession.event_id == event_id)
    scopes = db.execute(
        select(Match.session_id, Match.division_id)
        .where(
            Match.session_id.in_(session_ids),
            Match.finals_bracket_id.is_(None),
            Match.round_type != "practice",
        )
        .distinct()
        .order_by(Match.session_id, Match.division_id)
    ).all()
    for session_id, division_id in scopes:
        recompute_rankings(app, db, plugin, session_id, division_id)
    for division_id in dict.fromkeys(division_id for _, division_id in scopes):
        recompute_event_rankings(app, db, plugin, event_id, division_id)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && .venv/bin/pytest tests/test_ranking_settings.py tests/test_migrations.py tests/test_alembic_drift.py -q && .venv/bin/pytest -q`
Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add server/src/tournament_server/models/ranking_settings.py server/src/tournament_server/models/__init__.py \
  server/src/tournament_server/_alembic/versions/b3e8d1f0a6c2_add_ranking_settings.py \
  server/src/tournament_server/services/ranking_settings.py server/src/tournament_server/schemas/ranking_settings.py \
  server/src/tournament_server/routers/ranking_settings.py server/src/tournament_server/app.py \
  server/src/tournament_server/services/ranking.py server/tests/ranking_helpers.py \
  server/tests/test_ranking_settings.py server/tests/test_migrations.py
git commit -m "Store an event's ranking settings and serve them over the API"
```

---

### Task 3: Recompute rankings from the settings, for both game models and the season

**Files:**
- Modify (rewrite): `server/src/tournament_server/services/ranking.py`
- Modify: `server/src/tournament_server/routers/schedule.py:735-782` (`clear_schedule` round delete)
- Create: `server/src/tournament_server/_alembic/versions/c5f2a9e4b7d1_drop_ranking_configurations.py`
- Delete: `server/src/tournament_server/models/ranking_configuration.py`, `server/src/tournament_server/schemas/ranking_configuration.py`, `server/src/tournament_server/routers/ranking_configuration.py`, `server/tests/test_ranking_configuration.py`
- Modify: `server/src/tournament_server/models/__init__.py`, `server/src/tournament_server/app.py` (remove the old model/router)
- Modify: `server/tests/test_cooperative_scoring.py` (three tests move to the new endpoint)
- Modify: `server/tests/test_migrations.py` (assert the old table is gone)
- Modify: `server/CLAUDE.md` ("Cooperative scoring" section)
- Test: `server/tests/test_season_rankings.py`

**Interfaces:**
- Consumes: Task 1 rules; Task 2 `load_rules`, `recompute_all_rankings`, `DEFAULT_SETTINGS`.
- Produces (unchanged signatures, used by `routers/scores.py`, `routers/schedule.py`, `routers/ranking_settings.py`):
  - `recompute_rankings(app, db, plugin, session_id: int, division_id: int | None) -> None`
  - `recompute_event_rankings(app, db, plugin, event_id: int, division_id: int | None) -> None` (now for both game models)
  - `recompute_all_rankings(app, db, plugin, event_id: int) -> None`

- [ ] **Step 1: Write the failing integration tests**

Create `server/tests/test_season_rankings.py`:

```python
from ranking_helpers import DEFAULT_SETTINGS


def _cooperative_event(client) -> tuple[int, int]:
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    return t1, t2


def _session(client, label: str) -> int:
    return client.post("/api/sessions", json={"label": label}).json()["id"]


def _match(client, session_id, number, red, blue, round_type="qualification", division_id=None) -> dict:
    body = {
        "session_id": session_id,
        "round_type": round_type,
        "match_number": number,
        "field_id": None,
        "alliances": [
            {"station": "red", "team_ids": [red]},
            {"station": "blue", "team_ids": [blue]},
        ],
    }
    if division_id is not None:
        body["division_id"] = division_id
    response = client.post("/api/matches", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _alliance(match: dict, station: str) -> int:
    return next(a["id"] for a in match["alliances"] if a["station"] == station)


def _score_cooperative(client, match: dict, objects: int, station: str = "red", **flags) -> None:
    response = client.post(
        f"/api/matches/{match['id']}/alliances/{_alliance(match, station)}/score",
        json={"data": {"objects_scored": objects}, **flags},
    )
    assert response.status_code == 200, response.text


def _put_settings(client, **changes) -> None:
    response = client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, **changes})
    assert response.status_code == 200, response.text


def _rows(client, **params) -> dict[int, dict]:
    return {row["team_id"]: row for row in client.get("/api/rankings", params=params).json()}


def test_tier_default_drops_nothing_until_the_last_scheduled_matches_are_scored(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1 = _session(client, "Session 1")
    matches = [_match(client, s1, n, t1, t2) for n in range(1, 5)]  # 4 scheduled: 1 drop
    for match, objects in zip(matches[:3], (5, 10, 15)):  # 10, 20, 30
        _score_cooperative(client, match, objects)
    assert _rows(client, session_id=s1)[t1]["average_score"] == 20.0

    _score_cooperative(client, matches[3], 20)  # 40; the 4th scored earns the drop
    row = _rows(client, session_id=s1)[t1]
    assert row["average_score"] == 30.0
    assert row["matches_played"] == 4


def test_lowest_p_counts_against_the_schedule_and_follows_an_extension(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1 = _session(client, "Session 1")
    _put_settings(client, session_drop_mode="lowest", session_drop_count=1)
    first, second = _match(client, s1, 1, t1, t2), _match(client, s1, 2, t1, t2)
    _score_cooperative(client, first, 5)  # 10
    _score_cooperative(client, second, 10)  # 20
    assert _rows(client, session_id=s1)[t1]["average_score"] == 20.0

    _match(client, s1, 3, t1, t2)  # scheduled, not yet scored
    _put_settings(client, session_drop_mode="lowest", session_drop_count=1)  # recompute
    assert _rows(client, session_id=s1)[t1]["average_score"] == 15.0


def test_lowest_p_never_drops_a_teams_last_match(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1 = _session(client, "Session 1")
    _put_settings(client, session_drop_mode="lowest", session_drop_count=3)
    _score_cooperative(client, _match(client, s1, 1, t1, t2), 10)
    assert _rows(client, session_id=s1)[t1]["average_score"] == 20.0


def test_dq_ruled_after_a_drop_was_earned_stays_counted(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1 = _session(client, "Session 1")
    _put_settings(client, session_drop_mode="lowest", session_drop_count=1)
    first, second = _match(client, s1, 1, t1, t2), _match(client, s1, 2, t1, t2)
    _score_cooperative(client, first, 5)  # 10
    _score_cooperative(client, second, 15)  # 30
    assert _rows(client, session_id=s1)[t1]["average_score"] == 30.0

    _score_cooperative(client, second, 15, dq=True)  # t1 is DQ'd in its 30-point match
    # The DQ zero can't be dropped, so the 10 is dropped instead.
    assert _rows(client, session_id=s1)[t1]["average_score"] == 0.0
    assert _rows(client, session_id=s1)[t2]["average_score"] == 30.0

    _put_settings(client, session_drop_mode="lowest", session_drop_count=1, session_drop_dq=True)
    assert _rows(client, session_id=s1)[t1]["average_score"] == 10.0


def test_season_keep_best_minimum_and_only_session_counted(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1, s2 = _session(client, "Session 1"), _session(client, "Session 2")
    for session_id, objects in ((s1, (5, 15)), (s2, (10, 20))):  # S1: 10, 30; S2: 20, 40
        for number, count in enumerate(objects, start=1):
            _score_cooperative(client, _match(client, session_id, number, t1, t2), count)

    settings = dict(
        session_drop_mode="lowest", session_drop_count=1,
        season_keep_best=4, season_minimum=4, season_only_session_counted=True,
    )
    _put_settings(client, **settings)
    assert _rows(client, session_id=s1)[t1]["average_score"] == 30.0
    season = _rows(client, event_wide="true")[t1]
    assert season["average_score"] == 17.5  # (30 + 40) / 4
    assert season["matches_played"] == 4
    assert season["session_id"] is None

    _put_settings(client, **{**settings, "season_only_session_counted": False})
    assert _rows(client, event_wide="true")[t1]["average_score"] == 25.0  # (10+20+30+40) / 4


def test_season_default_is_a_plain_average_and_ignores_practice(cooperative_client):
    client = cooperative_client
    t1, t2 = _cooperative_event(client)
    s1, s2 = _session(client, "Session 1"), _session(client, "Session 2")
    _score_cooperative(client, _match(client, s1, 1, t1, t2), 5)  # 10
    _score_cooperative(client, _match(client, s2, 1, t1, t2), 15)  # 30
    _score_cooperative(client, _match(client, s2, 2, t1, t2, round_type="practice"), 40)
    season = _rows(client, event_wide="true")[t1]
    assert season["average_score"] == 20.0
    assert season["matches_played"] == 2


def test_saving_settings_recomputes_every_division(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    rookie = client.post("/api/divisions", json={"name": "Rookie"}).json()["id"]
    open_ = client.post("/api/divisions", json={"name": "Open"}).json()["id"]
    teams = [client.post("/api/teams", json={"number": str(n), "name": f"T{n}"}).json()["id"] for n in range(1, 5)]
    s1 = _session(client, "Session 1")
    for division_id, (red, blue), objects in ((rookie, teams[:2], (5, 15)), (open_, teams[2:], (10, 20))):
        for number, count in enumerate(objects, start=1):
            match = _match(client, s1, number + (10 if division_id == open_ else 0), red, blue, division_id=division_id)
            _score_cooperative(client, match, count)
    assert _rows(client, session_id=s1, division_id=rookie)[teams[0]]["average_score"] == 20.0
    assert _rows(client, session_id=s1, division_id=open_)[teams[2]]["average_score"] == 30.0

    _put_settings(client, session_drop_mode="lowest", session_drop_count=1)
    assert _rows(client, session_id=s1, division_id=rookie)[teams[0]]["average_score"] == 30.0
    assert _rows(client, session_id=s1, division_id=open_)[teams[2]]["average_score"] == 40.0


def _score_head_to_head(client, match: dict, red_high: int, blue_high: int) -> None:
    for station, high in (("red", red_high), ("blue", blue_high)):
        response = client.post(
            f"/api/matches/{match['id']}/alliances/{_alliance(match, station)}/score",
            json={"data": {"high_balls": high, "low_balls": 0, "auto_winner": "tie"}},
        )
        assert response.status_code == 200, response.text


def test_head_to_head_season_totals_win_points_across_sessions(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    t1, t2, t3 = (
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in (1, 2, 3)
    )
    s1, s2 = _session(client, "Session 1"), _session(client, "Session 2")
    _score_head_to_head(client, _match(client, s1, 1, t1, t2), 16, 6)  # t1 wins
    _score_head_to_head(client, _match(client, s2, 1, t1, t2), 10, 10)  # tie
    _score_head_to_head(client, _match(client, s2, 2, t3, t2), 16, 6)  # t3 wins; t3 missed S1
    _score_head_to_head(client, _match(client, s2, 3, t2, t1, round_type="practice"), 30, 0)

    session = _rows(client, session_id=s1)
    assert (session[t1]["win_points"], session[t2]["win_points"]) == (2, 0)
    assert t3 not in session

    season = _rows(client, event_wide="true")
    assert {t: season[t]["win_points"] for t in (t1, t2, t3)} == {t1: 3, t2: 1, t3: 2}
    assert {t: season[t]["strength_of_schedule"] for t in (t1, t2, t3)} == {t1: 2.0, t2: 8.0, t3: 1.0}
    assert [season[t]["rank"] for t in (t1, t3, t2)] == [1, 2, 3]
    assert all(row["session_id"] is None for row in season.values())
```

Rewrite three tests in `server/tests/test_cooperative_scoring.py` to use the new endpoint (add `from ranking_helpers import DEFAULT_SETTINGS` at the top):

- `test_exclude_mode_drops_lowest_non_protected_match`: rename to `test_lowest_mode_drops_lowest_non_protected_match`; replace the `client.post("/api/ranking-configuration", ...)` line with
  `client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, "session_drop_mode": "lowest", "session_drop_count": 1})`. The assertions (25.0, 3 played) stay: 3 scheduled, 3 scored, P = 1 earns one drop.
- `test_exclude_mode_protects_no_show_match_until_toggle_allows_dropping_it`: rename to `test_lowest_mode_protects_no_show_match_until_toggle_allows_dropping_it`. Replace the first config call with the same `lowest`/1 PUT. Replace the second config call *and* the re-submission block after it (`match_id, red_id, plan = matches[0]` through its `client.post(...)`) with
  `client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, "session_drop_mode": "lowest", "session_drop_count": 1, "session_drop_no_show": True})`, since saving settings recomputes. Update the comment above it to say so. Assertions (10.0 then 15.0) stay.
- `test_include_mode_zero_pads_a_team_with_fewer_matches_than_count`: rename to `test_season_minimum_zero_pads_a_team_with_fewer_matches`. Replace the config call with
  `client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, "season_keep_best": 3, "season_minimum": 3})`, and read the season rows instead: `response = client.get("/api/rankings?event_wide=true")`. Assertions (10.0, 1 played) stay.

In `server/tests/test_migrations.py`, at the end of `test_ranking_configuration_converts_to_ranking_settings`, add:

```python
    assert "ranking_configurations" not in inspect(engine).get_table_names()
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && .venv/bin/pytest tests/test_season_rankings.py tests/test_cooperative_scoring.py tests/test_migrations.py -q`
Expected: failures — tier default not applied (20.0 vs 30.0 style mismatches), head-to-head season rows missing, `ranking_configurations` still present.

- [ ] **Step 3: Rewrite `services/ranking.py`**

Replace the whole file with:

```python
from __future__ import annotations

import json
from collections import defaultdict
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_active_session, broadcast_for_session
from tournament_server.services.ranking_rules import (
    MatchRecord,
    RankingRules,
    season_score,
    session_drops,
    session_score,
)
from tournament_server.services.ranking_settings import load_rules

if TYPE_CHECKING:
    from fastapi import FastAPI

# A team's numbers before the plugin orders them, keyed by Ranking column:
# win_points/strength_of_schedule (head-to-head) or
# average_score/matches_played (cooperative).
TeamStats = dict[str, Any]


def _qualification_matches(
    db: Session, session_ids: list[int], division_id: int | None
) -> list[Match]:
    """Every qualification match in scope, in any status. Practice and finals never count."""
    if not session_ids:
        return []
    query = select(Match).where(
        Match.session_id.in_(session_ids),
        Match.finals_bracket_id.is_(None),
        Match.round_type != "practice",
    )
    if division_id is None:
        query = query.where(Match.division_id.is_(None))
    else:
        query = query.where(Match.division_id == division_id)
    return list(db.execute(query.order_by(Match.id)).scalars().all())


def _alliances(db: Session, match_id: int) -> list[Alliance]:
    return list(
        db.execute(
            select(Alliance).where(Alliance.match_id == match_id).order_by(Alliance.id)
        ).scalars().all()
    )


def _team_ids(db: Session, alliance_id: int) -> list[int]:
    return [
        row.team_id
        for row in db.execute(
            select(AllianceTeam).where(AllianceTeam.alliance_id == alliance_id)
        ).scalars().all()
    ]


def _score_record(db: Session, alliance_id: int) -> ScoreRecord | None:
    return db.execute(
        select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)
    ).scalars().first()


def _effective_score(plugin: LoadedPlugin, record: ScoreRecord) -> int:
    if record.no_show or record.dq:
        return 0
    return plugin.module.calculate_score(json.loads(record.data_json))


def _scheduled_counts(db: Session, matches: list[Match]) -> dict[tuple[int, int], int]:
    """(session_id, team_id) -> qualification matches the team is scheduled into, in any status."""
    counts: dict[tuple[int, int], int] = defaultdict(int)
    for match in matches:
        for alliance in _alliances(db, match.id):
            for team_id in _team_ids(db, alliance.id):
                counts[(match.session_id, team_id)] += 1
    return counts


def _cooperative_records(
    db: Session, plugin: LoadedPlugin, matches: list[Match]
) -> dict[int, list[MatchRecord]]:
    records: dict[int, list[MatchRecord]] = defaultdict(list)
    for match in matches:
        if match.status != "completed":
            continue
        for alliance in _alliances(db, match.id):
            score_record = _score_record(db, alliance.id)
            if score_record is None:
                continue
            record = MatchRecord(
                match_id=match.id,
                session_id=match.session_id,
                score=_effective_score(plugin, score_record),
                no_show=score_record.no_show,
                dq=score_record.dq,
            )
            for team_id in _team_ids(db, alliance.id):
                records[team_id].append(record)
    return records


def _cooperative_session_stats(
    db: Session, plugin: LoadedPlugin, matches: list[Match], rules: RankingRules
) -> dict[int, TeamStats]:
    scheduled = _scheduled_counts(db, matches)
    stats: dict[int, TeamStats] = {}
    for team_id, records in _cooperative_records(db, plugin, matches).items():
        dropped = session_drops(records, scheduled[(records[0].session_id, team_id)], rules)
        stats[team_id] = {
            "average_score": session_score(records, dropped),
            "matches_played": len(records),
        }
    return stats


def _cooperative_season_stats(
    db: Session, plugin: LoadedPlugin, matches: list[Match], rules: RankingRules
) -> dict[int, TeamStats]:
    scheduled = _scheduled_counts(db, matches)
    stats: dict[int, TeamStats] = {}
    for team_id, records in _cooperative_records(db, plugin, matches).items():
        session_dropped: set[int] = set()
        if rules.season_only_session_counted:
            by_session: dict[int, list[MatchRecord]] = defaultdict(list)
            for record in records:
                by_session[record.session_id].append(record)
            for session_id, session_records in by_session.items():
                session_dropped |= session_drops(
                    session_records, scheduled[(session_id, team_id)], rules
                )
        stats[team_id] = {
            "average_score": season_score(records, session_dropped, rules),
            "matches_played": len(records),
        }
    return stats


def _head_to_head_stats(
    db: Session, plugin: LoadedPlugin, matches: list[Match]
) -> dict[int, TeamStats]:
    """Win points (2/1/0) and strength of schedule (opponents' win points) over `matches`."""
    win_points: dict[int, int] = {}
    played: list[tuple[list[int], list[int]]] = []
    for match in matches:
        if match.status != "completed":
            continue
        alliances = _alliances(db, match.id)
        if len(alliances) != 2:
            continue
        sides: list[list[int]] = []
        scores: list[int] = []
        for alliance in alliances:
            record = _score_record(db, alliance.id)
            if record is None:
                break
            sides.append(_team_ids(db, alliance.id))
            scores.append(_effective_score(plugin, record))
        if len(scores) != 2:
            continue
        if scores[0] > scores[1]:
            points = (2, 0)
        elif scores[1] > scores[0]:
            points = (0, 2)
        else:
            points = (1, 1)
        for side, side_points in zip(sides, points):
            for team_id in side:
                win_points[team_id] = win_points.get(team_id, 0) + side_points
        played.append((sides[0], sides[1]))

    strength = {team_id: 0.0 for team_id in win_points}
    for side_a, side_b in played:
        for team_id in side_a:
            strength[team_id] += sum(win_points[t] for t in side_b)
        for team_id in side_b:
            strength[team_id] += sum(win_points[t] for t in side_a)
    return {
        team_id: {"win_points": win_points[team_id], "strength_of_schedule": strength[team_id]}
        for team_id in win_points
    }


def _stats(
    db: Session, plugin: LoadedPlugin, matches: list[Match], *, season: bool
) -> dict[int, TeamStats]:
    if plugin.module.match_format()["game_model"] == "cooperative_score":
        rules = load_rules(db)
        if season:
            return _cooperative_season_stats(db, plugin, matches, rules)
        return _cooperative_session_stats(db, plugin, matches, rules)
    return _head_to_head_stats(db, plugin, matches)


def _replace_rankings(
    db: Session,
    plugin: LoadedPlugin,
    session_id: int | None,
    division_id: int | None,
    stats: dict[int, TeamStats],
) -> None:
    """Replace the scope's rows with the plugin-ordered `stats`; a team with no
    qualifying match in scope ends up with no row."""
    session_filter = (
        Ranking.session_id.is_(None) if session_id is None else Ranking.session_id == session_id
    )
    division_filter = (
        Ranking.division_id.is_(None) if division_id is None else Ranking.division_id == division_id
    )
    db.execute(delete(Ranking).where(session_filter, division_filter))
    if stats:
        seeds = {
            team.id: team.tiebreaker_seed
            for team in db.execute(select(Team).where(Team.id.in_(list(stats)))).scalars().all()
        }
        team_results = [
            {"team_id": team_id, **values, "tiebreaker_seed": seeds[team_id]}
            for team_id, values in stats.items()
        ]
        for entry in plugin.module.rank_teams(team_results):
            db.add(
                Ranking(
                    session_id=session_id,
                    division_id=division_id,
                    team_id=entry["team_id"],
                    rank=entry["rank"],
                    **stats[entry["team_id"]],
                )
            )
    db.commit()


def recompute_rankings(
    app: "FastAPI", db: Session, plugin: LoadedPlugin, session_id: int, division_id: int | None
) -> None:
    matches = _qualification_matches(db, [session_id], division_id)
    _replace_rankings(db, plugin, session_id, division_id, _stats(db, plugin, matches, season=False))
    broadcast_for_session(
        app, db, session_id, "ranking_updated",
        {"session_id": session_id, "division_id": division_id, "event_wide": False},
    )


def recompute_event_rankings(
    app: "FastAPI", db: Session, plugin: LoadedPlugin, event_id: int, division_id: int | None
) -> None:
    """The season standings: every session's qualification matches, for both game models."""
    session_ids = [
        row.id
        for row in db.execute(
            select(TournamentSession).where(TournamentSession.event_id == event_id)
        ).scalars().all()
    ]
    matches = _qualification_matches(db, session_ids, division_id)
    _replace_rankings(db, plugin, None, division_id, _stats(db, plugin, matches, season=True))
    broadcast_active_session(
        app, "ranking_updated",
        {"session_id": None, "division_id": division_id, "event_wide": True},
    )
```

Then re-append `recompute_all_rankings` exactly as written in Task 2 Step 6 (it's unchanged).

- [ ] **Step 4: Simplify the round delete**

In `server/src/tournament_server/routers/schedule.py`, in the round-clearing handler (currently lines 735–782): delete the "Delete stale rankings first" block (the comment and the `ranking_query` loop plus `db.flush()`), and the "Delete stale event-wide rankings" block (the comment, the `event_ranking_query` loop and its `db.commit()`). The end of the handler becomes:

```python
    matches_deleted = _delete_round(db, session_id, division_id, round_type)

    db.commit()

    # Best-effort: rebuild rankings from whatever qualifying matches remain
    # for this (session_id, division_id) and for the season. Each recompute
    # replaces its scope's rows, so a team left with no match loses its row.
    # If the event or its game plugin isn't available, skip silently rather
    # than turning a successful deletion into a 500.
    event = get_the_event(db)
    if event is not None and event.game_plugin_name is not None:
        game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
        if game_plugin is not None:
            recompute_rankings(request.app, db, game_plugin, session_id, division_id)
            recompute_event_rankings(request.app, db, game_plugin, event.id, division_id)

    return {"matches_deleted": matches_deleted}
```

Remove the now-unused `Ranking` import from `schedule.py` if nothing else in the file uses it (`grep -n "Ranking\b" server/src/tournament_server/routers/schedule.py`).

- [ ] **Step 5: Remove the old configuration**

Delete `models/ranking_configuration.py`, `schemas/ranking_configuration.py`, `routers/ranking_configuration.py` and `tests/test_ranking_configuration.py` (`git rm`). Remove the `RankingConfiguration` import line from `models/__init__.py` (and from `__all__` if present), and `ranking_configuration,` plus `app.include_router(ranking_configuration.router)` from `app.py`.

Create `server/src/tournament_server/_alembic/versions/c5f2a9e4b7d1_drop_ranking_configurations.py`:

```python
"""drop ranking_configurations (replaced by ranking_settings)

Revision ID: c5f2a9e4b7d1
Revises: b3e8d1f0a6c2
Create Date: 2026-10-06 12:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c5f2a9e4b7d1'
down_revision: Union[str, None] = 'b3e8d1f0a6c2'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_table('ranking_configurations')


def downgrade() -> None:
    op.create_table('ranking_configurations',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('event_id', sa.Integer(), nullable=False),
    sa.Column('division_id', sa.Integer(), nullable=True),
    sa.Column('mode', sa.String(length=20), nullable=False),
    sa.Column('count', sa.Integer(), nullable=False),
    sa.Column('allow_drop_no_show', sa.Boolean(), nullable=False),
    sa.Column('allow_drop_dq', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['division_id'], ['divisions.id'], ),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('event_id', 'division_id', name='uq_ranking_config_event_division')
    )
```

Run `grep -rn "ranking_configuration\|RankingConfiguration\|ranking-configuration" server/src server/tests` — only the two migration files may still mention it.

- [ ] **Step 6: Update `server/CLAUDE.md`**

In the "Cooperative scoring" section, replace the `RankingConfiguration` paragraph and the `GET /api/rankings?event_wide=true` paragraph (the last two paragraphs of the section) with:

```markdown
Ranking rules live in `RankingSettings` (`GET`/`PUT /api/ranking-settings`,
one row per event, shared by every division, created with defaults on first
read; `GET` also reports the event's `game_model`). They apply only to
`cooperative_score`: how a session drops a team's lowest matches (`tiered`,
the default, takes the drop allowance from the tier table on the team's
*scheduled* qualification matches; `none`; or `lowest` P), whether a no-show
or DQ zero may be dropped (separately for sessions and for the season — the
zero itself is always counted), and how the season combines matches (keep
best N, only matches a session counted, a minimum that zero-fills the
shortfall). Drops are earned only as the last scheduled matches are scored:
with 10 scheduled and P = 3, nothing drops until the 8th is scored. Every
rule is a pure function in `services/ranking_rules.py`, unit-tested in
`tests/test_ranking_rules.py`; `services/ranking.py` only gathers records and
writes rows. A `PUT` recomputes every session and season ranking
(`recompute_all_rankings`).

`GET /api/rankings?event_wide=true` returns season standings (`Ranking` rows
with `session_id: null`), recomputed alongside the session ranking on every
score save and round clear, for **both** game models: head-to-head season
standings are total win points over every session's qualification matches
(nothing dropped), with strength of schedule from season win points. Finals
and practice matches never count anywhere. Each recompute *replaces* its
scope's rows, so a team with no qualifying match left has no row.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd server && .venv/bin/pytest -q`
Expected: all pass, including `test_alembic_drift.py`, `test_schedule.py`'s clear-schedule ranking tests, `test_finals.py` and `test_rankings.py`.

- [ ] **Step 8: Commit**

```bash
git add -A server/
git commit -m "Rank sessions and seasons from the event's ranking settings

Head-to-head events now get season standings, cooperative sessions earn
drops against their scheduled matches, and every recompute replaces its
scope's rows. The per-division ranking configuration is gone."
```

---

### Task 4: Rankings data, tables and the session Rankings tab

**Files:**
- Modify: `frontend/apps/admin/src/types.ts`
- Create: `frontend/apps/admin/src/rankings/useRankingSettings.ts`
- Create: `frontend/apps/admin/src/rankings/useRankingGroups.ts`
- Create: `frontend/apps/admin/src/rankings/RankingTables.tsx`
- Create: `frontend/apps/admin/src/rankings/RankingsView.tsx`
- Create: `frontend/apps/admin/src/routes/SessionRankingsRoute.tsx`
- Modify: `frontend/apps/admin/src/routes/SessionDetailLayout.tsx` (Rankings tab after Matches)
- Modify: `frontend/apps/admin/src/router.tsx` (`rankings` child route)
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `.../zh/admin.json` (all keys for Tasks 4–6)
- Modify: `frontend/apps/admin/src/styles/components.css`
- Test: `frontend/apps/admin/tests/unit/SessionRankingsRoute.test.tsx`

**Interfaces:**
- Consumes: `GET /api/ranking-settings`, `GET /api/rankings`, `GET /api/divisions`, `GET /api/teams`, `/ws/session/{id}`.
- Produces (used by Tasks 5 and 6):
  - types `GameModel`, `SessionDropMode`, `RankingRead`, `RankingSettingsValues`, `RankingSettingsRead`
  - `RANKING_SETTINGS_KEY = ["rankingSettings"]`, `useRankingSettings()`
  - `RankingScope = { kind: "session"; sessionId: number } | { kind: "season" }`, `rankingsKeyPrefix(scope)`, `useRankingGroups(scope)`
  - `<RankingsView scope={...} />`
  - Query keys: session `["rankings", sessionId, divisionId]`, season `["rankings", "season", divisionId]`.

- [ ] **Step 1: Add types and i18n strings**

Append to `frontend/apps/admin/src/types.ts`:

```ts
export type GameModel = "head_to_head" | "cooperative_score";
export type SessionDropMode = "tiered" | "none" | "lowest";

export interface RankingRead {
  session_id: number | null;
  division_id: number | null;
  team_id: number;
  win_points: number;
  strength_of_schedule: number;
  average_score: number;
  matches_played: number;
  rank: number;
}

export interface RankingSettingsValues {
  session_drop_mode: SessionDropMode;
  session_drop_count: number;
  session_drop_no_show: boolean;
  session_drop_dq: boolean;
  season_keep_best: number | null;
  season_only_session_counted: boolean;
  season_minimum: number;
  season_drop_no_show: boolean;
  season_drop_dq: boolean;
}

export interface RankingSettingsRead extends RankingSettingsValues {
  game_model: GameModel | null;
}
```

In `src/i18n/en/admin.json`: add `"seasonRankingsLink": "Season rankings"` to `shell`, `"rankingsTab": "Rankings"` to `sessions` (next to `matchesTab`), and a new top-level block:

```json
  "rankings": {
    "loading": "Loading rankings...",
    "empty": "No rankings yet. Rankings appear once qualification matches are scored.",
    "noDivision": "No division",
    "tableLabel": "Rankings",
    "columnRank": "Rank",
    "columnTeam": "Team",
    "columnName": "Name",
    "columnScore": "Score",
    "columnMatchesPlayed": "Matches played",
    "columnWinPoints": "Win points",
    "columnStrength": "Strength of schedule",
    "seasonHeading": "Season rankings",
    "seasonTabsLabel": "Ranking type",
    "teamworkTab": "Teamwork",
    "rules": {
      "plainAverage": "Average of every qualification match.",
      "keepBest_one": "best {{count}} match",
      "keepBest_other": "best {{count}} matches",
      "minimum": "minimum {{count}}",
      "onlySessionCounted": "only matches counted in a session ranking"
    },
    "settings": {
      "heading": "Ranking settings",
      "intro": "These apply to every division. A no-show or DQ always scores 0; these settings only decide whether that zero can be dropped.",
      "sessionLegend": "Session rankings",
      "modeTiered": "Drop by matches scheduled (recommended)",
      "tieredHint": "0–3 scheduled: none · 4–7: 1 · 8–11: 2 · 12–15: 3 · 16 or more: 4. Drops are earned as the last scheduled matches are scored.",
      "modeNone": "No drops",
      "modeLowest": "Drop a set number of lowest matches",
      "dropCountLabel": "Matches to drop",
      "noShowLabel": "No-shows can be dropped",
      "dqLabel": "DQs can be dropped",
      "seasonLegend": "Season rankings",
      "keepBestLabel": "Keep best matches",
      "keepBestHint": "Leave blank to count every match.",
      "onlySessionCountedLabel": "Only use matches counted in a session ranking",
      "minimumLabel": "Minimum matches",
      "minimumHint": "Teams with fewer counted matches get zeroes for the rest. 0 means no minimum.",
      "save": "Save ranking settings",
      "saved": "Settings saved. Rankings recalculated.",
      "errors": {
        "dropCount": "Enter a whole number of 1 or more.",
        "keepBest": "Enter a whole number of 1 or more, or leave blank.",
        "minimum": "Enter a whole number of 0 or more.",
        "minimumAboveKeepBest": "Minimum can't be more than the number of matches kept."
      }
    }
  }
```

In `src/i18n/zh/admin.json`: `"seasonRankingsLink": "赛季排名"` in `shell`, `"rankingsTab": "排名"` in `sessions`, and:

```json
  "rankings": {
    "loading": "正在加载排名...",
    "empty": "暂无排名。资格赛比赛计分后将显示排名。",
    "noDivision": "无分组",
    "tableLabel": "排名",
    "columnRank": "名次",
    "columnTeam": "队伍",
    "columnName": "名称",
    "columnScore": "得分",
    "columnMatchesPlayed": "已赛场次",
    "columnWinPoints": "胜点",
    "columnStrength": "赛程强度",
    "seasonHeading": "赛季排名",
    "seasonTabsLabel": "排名类型",
    "teamworkTab": "团队赛",
    "rules": {
      "plainAverage": "所有资格赛比赛的平均分。",
      "keepBest_other": "取最佳 {{count}} 场",
      "minimum": "最少 {{count}} 场",
      "onlySessionCounted": "仅使用计入场次排名的比赛"
    },
    "settings": {
      "heading": "排名设置",
      "intro": "这些设置适用于所有分组。缺席或取消资格始终记 0 分；这些设置只决定该 0 分能否被去掉。",
      "sessionLegend": "场次排名",
      "modeTiered": "按已排比赛数去掉（推荐）",
      "tieredHint": "已排 0–3 场：不去掉 · 4–7：1 · 8–11：2 · 12–15：3 · 16 场及以上：4。去掉的名额在最后几场已排比赛计分时获得。",
      "modeNone": "不去掉",
      "modeLowest": "去掉固定数量的最低分比赛",
      "dropCountLabel": "去掉的场数",
      "noShowLabel": "缺席可被去掉",
      "dqLabel": "取消资格可被去掉",
      "seasonLegend": "赛季排名",
      "keepBestLabel": "保留最佳场数",
      "keepBestHint": "留空则计入所有比赛。",
      "onlySessionCountedLabel": "仅使用计入场次排名的比赛",
      "minimumLabel": "最少场数",
      "minimumHint": "计入场数不足的队伍，其余场次记 0 分。0 表示没有最少场数。",
      "save": "保存排名设置",
      "saved": "设置已保存，排名已重新计算。",
      "errors": {
        "dropCount": "请输入 1 或以上的整数。",
        "keepBest": "请输入 1 或以上的整数，或留空。",
        "minimum": "请输入 0 或以上的整数。",
        "minimumAboveKeepBest": "最少场数不能多于保留的场数。"
      }
    }
  }
```

Append to `src/styles/components.css`:

```css
/* Rankings */
.table__num {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.rankings-group + .rankings-group {
  margin-top: var(--space-6);
}
.rankings-rules {
  color: var(--color-text-secondary);
  margin-bottom: var(--space-4);
}
.settings-group {
  border: 0;
  padding: 0;
  margin: 0 0 var(--space-6);
}
.settings-group legend {
  font-weight: 600;
  margin-bottom: var(--space-2);
}
.choice {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-bottom: var(--space-2);
}
.settings-number {
  max-width: 8rem;
}
```

- [ ] **Step 2: Write the failing tests**

Create `frontend/apps/admin/tests/unit/SessionRankingsRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router-dom";
import { initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SessionRankingsRoute } from "../../src/routes/SessionRankingsRoute";
import type { Division, GameModel, RankingRead, RankingSettingsRead, SessionRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const SESSION: SessionRead = {
  id: 1,
  event_id: 1,
  label: "Saturday",
  session_date: null,
  timezone: null,
  has_scored_matches: true,
};
const TEAMS = [
  { id: 1, number: "101", name: "Alpha", division_id: 7 },
  { id: 2, number: "202", name: "Bravo", division_id: 7 },
  { id: 3, number: "303", name: "Charlie", division_id: 8 },
];

function ranking(team_id: number, rank: number, overrides: Partial<RankingRead> = {}): RankingRead {
  return {
    session_id: 1,
    division_id: null,
    team_id,
    rank,
    win_points: 0,
    strength_of_schedule: 0,
    average_score: 0,
    matches_played: 0,
    ...overrides,
  };
}

function settings(game_model: GameModel): RankingSettingsRead {
  return {
    session_drop_mode: "tiered",
    session_drop_count: 1,
    session_drop_no_show: false,
    session_drop_dq: false,
    season_keep_best: null,
    season_only_session_counted: false,
    season_minimum: 0,
    season_drop_no_show: false,
    season_drop_dq: false,
    game_model,
  };
}

function stub({
  gameModel = "cooperative_score",
  divisions = [],
  rankings = {},
}: { gameModel?: GameModel; divisions?: Division[]; rankings?: Record<string, RankingRead[]> }) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/ranking-settings") return settings(gameModel) as never;
    if (path === "/api/divisions") return divisions as never;
    if (path === "/api/teams") return TEAMS as never;
    if (path in rankings) return rankings[path] as never;
    if (path.startsWith("/api/rankings?")) return [] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function SessionOutlet() {
  return <Outlet context={{ session: SESSION }} />;
}

function renderRankings() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    { path: "/", element: <SessionOutlet />, children: [{ index: true, element: <SessionRankingsRoute /> }] },
  ]);
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const ROOKIE: Division = { id: 7, event_id: 1, name: "Rookie", target_team_count: null };
const OPEN: Division = { id: 8, event_id: 1, name: "Open", target_team_count: null };

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SessionRankingsRoute", () => {
  it("shows cooperative columns in rank order with two-decimal scores", async () => {
    stub({
      rankings: {
        "/api/rankings?session_id=1": [
          ranking(1, 1, { average_score: 25, matches_played: 3 }),
          ranking(2, 2, { average_score: 12.5, matches_played: 2 }),
        ],
      },
    });
    renderRankings();

    const alpha = await screen.findByRole("row", { name: /Alpha/ });
    expect(screen.getByRole("columnheader", { name: "Score" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Matches played" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Win points" })).not.toBeInTheDocument();
    expect(within(alpha).getByRole("cell", { name: "25.00" })).toBeInTheDocument();
    expect(within(alpha).getByRole("cell", { name: "101" })).toBeInTheDocument();
    expect(screen.getAllByRole("row")[1]).toBe(alpha);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("shows head-to-head columns", async () => {
    stub({
      gameModel: "head_to_head",
      rankings: { "/api/rankings?session_id=1": [ranking(1, 1, { win_points: 4, strength_of_schedule: 6 })] },
    });
    renderRankings();

    const alpha = await screen.findByRole("row", { name: /Alpha/ });
    expect(screen.getByRole("columnheader", { name: "Win points" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Strength of schedule" })).toBeInTheDocument();
    expect(within(alpha).getByRole("cell", { name: "4" })).toBeInTheDocument();
    expect(within(alpha).getByRole("cell", { name: "6" })).toBeInTheDocument();
  });

  it("shows matches with no division even when the event has a division", async () => {
    stub({ divisions: [ROOKIE], rankings: { "/api/rankings?session_id=1": [ranking(1, 1)] } });
    renderRankings();

    expect(await screen.findByRole("row", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("groups rankings by division under headings", async () => {
    stub({
      divisions: [ROOKIE, OPEN],
      rankings: {
        "/api/rankings?session_id=1&division_id=7": [ranking(1, 1, { division_id: 7 })],
        "/api/rankings?session_id=1&division_id=8": [ranking(3, 1, { division_id: 8 })],
      },
    });
    renderRankings();

    expect(await screen.findByRole("heading", { name: "Rookie" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Open" })).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Rookie" })).getByText("Alpha")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Open" })).getByText("Charlie")).toBeInTheDocument();
  });

  it("shows the empty state when nothing is ranked", async () => {
    stub({});
    renderRankings();

    expect(
      await screen.findByText("No rankings yet. Rankings appear once qualification matches are scored.")
    ).toBeInTheDocument();
  });

  it("refetches when the session channel reports a ranking update", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    stub({ rankings: { "/api/rankings?session_id=1": [ranking(1, 1)] } });
    renderRankings();
    await screen.findByRole("row", { name: /Alpha/ });

    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/session/1");
    const fetches = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/rankings?session_id=1").length;
    const before = fetches();
    act(() => onEvent?.({ event: "ranking_updated", data: { session_id: 1 } }));
    await waitFor(() => expect(fetches()).toBeGreaterThan(before));
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionRankingsRoute.test.tsx`
Expected: FAIL — cannot resolve `../../src/routes/SessionRankingsRoute`.

- [ ] **Step 4: Write the hooks, components and route**

Create `src/rankings/useRankingSettings.ts`:

```ts
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { RankingSettingsRead } from "../types";

export const RANKING_SETTINGS_KEY = ["rankingSettings"];

/** The event's ranking settings, plus its game model (null before a game is chosen). */
export function useRankingSettings() {
  return useQuery({
    queryKey: RANKING_SETTINGS_KEY,
    queryFn: () => apiRequest<RankingSettingsRead>("/api/ranking-settings"),
  });
}
```

Create `src/rankings/useRankingGroups.ts`:

```ts
import { useQueries, useQuery } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";
import type { Division, RankingRead } from "../types";

export type RankingScope = { kind: "session"; sessionId: number } | { kind: "season" };

export interface RankingGroup {
  divisionId: number | null;
  divisionName: string | null;
  rows: RankingRead[];
}

/** Invalidating this prefix refetches every division's rankings for the scope. */
export function rankingsKeyPrefix(scope: RankingScope): (string | number)[] {
  return scope.kind === "session" ? ["rankings", scope.sessionId] : ["rankings", "season"];
}

function rankingsPath(scope: RankingScope, divisionId: number | null): string {
  const params = new URLSearchParams();
  if (scope.kind === "session") params.set("session_id", String(scope.sessionId));
  else params.set("event_wide", "true");
  if (divisionId !== null) params.set("division_id", String(divisionId));
  return `/api/rankings?${params}`;
}

/**
 * Rankings for every division plus "no division": a single-division event's
 * scheduled matches carry no division, so those rows live under null even
 * when a division exists. Only groups with rows are returned.
 */
export function useRankingGroups(scope: RankingScope) {
  const divisionsQuery = useQuery({
    queryKey: ["divisions"],
    queryFn: () => apiRequest<Division[]>("/api/divisions"),
  });
  const divisions = divisionsQuery.data ?? [];
  const divisionIds: (number | null)[] = [null, ...divisions.map((division) => division.id)];
  const results = useQueries({
    queries: divisionsQuery.data
      ? divisionIds.map((divisionId) => ({
          queryKey: [...rankingsKeyPrefix(scope), divisionId],
          queryFn: () => apiRequest<RankingRead[]>(rankingsPath(scope, divisionId)),
        }))
      : [],
  });
  const nameById = new Map(divisions.map((division) => [division.id, division.name]));
  const groups: RankingGroup[] = results.flatMap((result, index) => {
    const rows = result.data ?? [];
    const divisionId = divisionIds[index];
    return rows.length > 0
      ? [{ divisionId, divisionName: divisionId === null ? null : (nameById.get(divisionId) ?? null), rows }]
      : [];
  });
  return {
    groups,
    isLoading: divisionsQuery.isLoading || results.some((result) => result.isLoading),
    isError: divisionsQuery.isError || results.some((result) => result.isError),
  };
}
```

Create `src/rankings/RankingTables.tsx`:

```tsx
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import type { GameModel, TeamSummary } from "../types";
import type { RankingGroup } from "./useRankingGroups";

/** One table per division group; headings only when there's more than one group. */
export function RankingTables({ groups, gameModel }: { groups: RankingGroup[]; gameModel: GameModel }) {
  const { t, i18n } = useTranslation();
  const { data: teams } = useQuery({
    queryKey: ["teams"],
    queryFn: () => apiRequest<TeamSummary[]>("/api/teams"),
  });
  const teamById = useMemo(() => new Map((teams ?? []).map((team) => [team.id, team])), [teams]);
  const cooperative = gameModel === "cooperative_score";
  const showHeadings = groups.length > 1;
  const score = (value: number) =>
    value.toLocaleString(i18n.language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const plain = (value: number) => value.toLocaleString(i18n.language, { maximumFractionDigits: 2 });

  return (
    <>
      {groups.map((group) => {
        const label = group.divisionName ?? (showHeadings ? t("rankings.noDivision") : t("rankings.tableLabel"));
        return (
          <section className="rankings-group" key={group.divisionId ?? "none"}>
            {showHeadings && <h2>{label}</h2>}
            <div className="table-wrap">
              <table className="table" aria-label={label}>
                <thead>
                  <tr>
                    <th className="table__num">{t("rankings.columnRank")}</th>
                    <th>{t("rankings.columnTeam")}</th>
                    <th>{t("rankings.columnName")}</th>
                    {cooperative ? (
                      <>
                        <th className="table__num">{t("rankings.columnScore")}</th>
                        <th className="table__num">{t("rankings.columnMatchesPlayed")}</th>
                      </>
                    ) : (
                      <>
                        <th className="table__num">{t("rankings.columnWinPoints")}</th>
                        <th className="table__num">{t("rankings.columnStrength")}</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {[...group.rows]
                    .sort((a, b) => a.rank - b.rank)
                    .map((row) => {
                      const team = teamById.get(row.team_id);
                      return (
                        <tr key={row.team_id}>
                          <td className="table__num">{row.rank}</td>
                          <td>{team?.number ?? row.team_id}</td>
                          <td>{team?.name ?? ""}</td>
                          {cooperative ? (
                            <>
                              <td className="table__num">{score(row.average_score)}</td>
                              <td className="table__num">{row.matches_played}</td>
                            </>
                          ) : (
                            <>
                              <td className="table__num">{row.win_points}</td>
                              <td className="table__num">{plain(row.strength_of_schedule)}</td>
                            </>
                          )}
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}
```

Create `src/rankings/RankingsView.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { RankingTables } from "./RankingTables";
import { useRankingGroups, type RankingScope } from "./useRankingGroups";
import { useRankingSettings } from "./useRankingSettings";

/** The loading, error, empty and table states for one scope's rankings. */
export function RankingsView({ scope }: { scope: RankingScope }) {
  const { t } = useTranslation();
  const settings = useRankingSettings();
  const { groups, isLoading, isError } = useRankingGroups(scope);

  if (isLoading || settings.isLoading) return <p>{t("rankings.loading")}</p>;
  if (isError || settings.isError) {
    return (
      <p className="alert alert-danger" role="alert">
        {t("errors.generic")}
      </p>
    );
  }
  if (groups.length === 0) return <p className="table__empty">{t("rankings.empty")}</p>;
  return <RankingTables groups={groups} gameModel={settings.data?.game_model ?? "head_to_head"} />;
}
```

Create `src/routes/SessionRankingsRoute.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useOutletContext } from "react-router-dom";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RankingsView } from "../rankings/RankingsView";
import { rankingsKeyPrefix } from "../rankings/useRankingGroups";
import type { SessionRead } from "../types";

export function SessionRankingsRoute() {
  const { session } = useOutletContext<{ session: SessionRead }>();
  const queryClient = useQueryClient();
  const scope = { kind: "session" as const, sessionId: session.id };
  useRealtimeChannel({
    path: `/ws/session/${session.id}`,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (realtimeEvent.event === "ranking_updated") {
        queryClient.invalidateQueries({ queryKey: rankingsKeyPrefix(scope) });
      }
    },
  });
  return <RankingsView scope={scope} />;
}
```

In `src/routes/SessionDetailLayout.tsx`, after the Matches `NavLink`, add:

```tsx
        <NavLink to={`/sessions/${session.id}/rankings`} className={tabLinkClassName}>
          {t("sessions.rankingsTab")}
        </NavLink>
```

In `src/router.tsx`, import `SessionRankingsRoute` and add `{ path: "rankings", element: <SessionRankingsRoute /> },` after the `matches` child route.

- [ ] **Step 5: Run the tests and type check**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/SessionRankingsRoute.test.tsx && npm test && npx tsc --noEmit`
Expected: all pass. (`SessionDetailLayout.test.tsx` may assert the tab list; if it counts tabs, add Rankings to its expectation.)

- [ ] **Step 6: Commit**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit/SessionRankingsRoute.test.tsx
git commit -m "Add a Rankings tab to each session"
```

---

### Task 5: Season Rankings page

**Files:**
- Create: `frontend/apps/admin/src/rankings/seasonRulesSummary.ts`
- Create: `frontend/apps/admin/src/routes/SeasonRankingsRoute.tsx`
- Modify: `frontend/apps/admin/src/router.tsx` (`rankings` route under the authenticated layout)
- Modify: `frontend/apps/admin/src/components/AppShell.tsx` (admin nav link after Sessions)
- Modify: `frontend/apps/admin/tests/unit/AppShell.test.tsx` (assert the link)
- Test: `frontend/apps/admin/tests/unit/seasonRulesSummary.test.ts`, `frontend/apps/admin/tests/unit/SeasonRankingsRoute.test.tsx`

**Interfaces:**
- Consumes: Task 4's `RankingsView`, `rankingsKeyPrefix`, `useRankingSettings`, types, i18n keys.
- Produces: `describeSeasonRules(t: TFunction, settings: RankingSettingsValues): string`; route `/rankings`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/seasonRulesSummary.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { describeSeasonRules } from "../../src/rankings/seasonRulesSummary";
import type { RankingSettingsValues } from "../../src/types";

const i18n = initI18n({ en: { translation: enAdmin } });
const DEFAULTS: RankingSettingsValues = {
  session_drop_mode: "tiered",
  session_drop_count: 1,
  session_drop_no_show: false,
  session_drop_dq: false,
  season_keep_best: null,
  season_only_session_counted: false,
  season_minimum: 0,
  season_drop_no_show: false,
  season_drop_dq: false,
};

describe("describeSeasonRules", () => {
  it("describes the defaults as a plain average", () => {
    expect(describeSeasonRules(i18n.t, DEFAULTS)).toBe("Average of every qualification match.");
  });

  it("joins every non-default rule", () => {
    expect(
      describeSeasonRules(i18n.t, {
        ...DEFAULTS,
        season_keep_best: 24,
        season_minimum: 24,
        season_only_session_counted: true,
      })
    ).toBe("Best 24 matches · minimum 24 · only matches counted in a session ranking");
  });

  it("uses the singular and capitalizes whichever rule comes first", () => {
    expect(describeSeasonRules(i18n.t, { ...DEFAULTS, season_keep_best: 1 })).toBe("Best 1 match");
    expect(describeSeasonRules(i18n.t, { ...DEFAULTS, season_minimum: 5 })).toBe("Minimum 5");
    expect(describeSeasonRules(i18n.t, { ...DEFAULTS, season_only_session_counted: true })).toBe(
      "Only matches counted in a session ranking"
    );
  });
});
```

Create `tests/unit/SeasonRankingsRoute.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { initI18n, type RealtimeEvent } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { SeasonRankingsRoute } from "../../src/routes/SeasonRankingsRoute";
import type { RankingRead, RankingSettingsRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn(), useRealtimeChannel: vi.fn() };
});

import { apiRequest, useRealtimeChannel } from "@tournament-admin/shared";

const SETTINGS: RankingSettingsRead = {
  session_drop_mode: "tiered",
  session_drop_count: 1,
  session_drop_no_show: false,
  session_drop_dq: false,
  season_keep_best: null,
  season_only_session_counted: false,
  season_minimum: 0,
  season_drop_no_show: false,
  season_drop_dq: false,
  game_model: "cooperative_score",
};
const ROW: RankingRead = {
  session_id: null,
  division_id: null,
  team_id: 1,
  rank: 1,
  win_points: 0,
  strength_of_schedule: 0,
  average_score: 30,
  matches_played: 4,
};

function stub(settings: Partial<RankingSettingsRead> = {}) {
  vi.mocked(apiRequest).mockImplementation(async (path: string) => {
    if (path === "/api/ranking-settings") return { ...SETTINGS, ...settings } as never;
    if (path === "/api/divisions") return [] as never;
    if (path === "/api/teams") return [{ id: 1, number: "101", name: "Alpha", division_id: null }] as never;
    if (path === "/api/rankings?event_wide=true") return [ROW] as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderSeason() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <MemoryRouter>
          <SeasonRankingsRoute />
        </MemoryRouter>
      </I18nextProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
  vi.mocked(useRealtimeChannel).mockReset();
  vi.mocked(useRealtimeChannel).mockReturnValue({ connected: true });
});

describe("SeasonRankingsRoute", () => {
  it("shows season rankings under a selected Teamwork tab", async () => {
    stub();
    renderSeason();

    expect(await screen.findByRole("row", { name: /Alpha/ })).toHaveTextContent("30.00");
    expect(screen.getByRole("heading", { name: "Season rankings" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Teamwork" })).toHaveAttribute("aria-selected", "true");
  });

  it("describes default cooperative rules as a plain average", async () => {
    stub();
    renderSeason();
    expect(await screen.findByText("Average of every qualification match.")).toBeInTheDocument();
  });

  it("describes non-default season rules", async () => {
    stub({ season_keep_best: 24, season_minimum: 24, season_only_session_counted: true });
    renderSeason();
    expect(
      await screen.findByText("Best 24 matches · minimum 24 · only matches counted in a session ranking")
    ).toBeInTheDocument();
  });

  it("shows no rules line for head-to-head", async () => {
    stub({ game_model: "head_to_head" });
    renderSeason();
    await screen.findByRole("row", { name: /Alpha/ });
    expect(screen.queryByText("Average of every qualification match.")).not.toBeInTheDocument();
  });

  it("refetches on event-wide ranking updates only", async () => {
    let onEvent: ((event: RealtimeEvent) => void) | undefined;
    vi.mocked(useRealtimeChannel).mockImplementation((options) => {
      onEvent = options.onEvent;
      return { connected: true };
    });
    stub();
    renderSeason();
    await screen.findByRole("row", { name: /Alpha/ });

    expect(vi.mocked(useRealtimeChannel).mock.calls[0][0].path).toBe("/ws/active-session");
    const fetches = () =>
      vi.mocked(apiRequest).mock.calls.filter(([path]) => path === "/api/rankings?event_wide=true").length;
    const before = fetches();
    act(() => onEvent?.({ event: "ranking_updated", data: { session_id: 3, event_wide: false } }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetches()).toBe(before);

    act(() => onEvent?.({ event: "ranking_updated", data: { session_id: null, event_wide: true } }));
    await waitFor(() => expect(fetches()).toBeGreaterThan(before));
  });
});
```

In `tests/unit/AppShell.test.tsx`, in the "shows the full admin nav including Sessions for the admin role" test, add:

```tsx
    expect(screen.getByRole("link", { name: "Season rankings" })).toBeInTheDocument();
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/seasonRulesSummary.test.ts tests/unit/SeasonRankingsRoute.test.tsx tests/unit/AppShell.test.tsx`
Expected: FAIL — modules not found and the nav link missing.

- [ ] **Step 3: Write the summary, route and nav link**

Create `src/rankings/seasonRulesSummary.ts`:

```ts
import type { TFunction } from "i18next";
import type { RankingSettingsValues } from "../types";

/** One line describing how the season combines matches, for the Season Rankings page. */
export function describeSeasonRules(t: TFunction, settings: RankingSettingsValues): string {
  const parts: string[] = [];
  if (settings.season_keep_best !== null) {
    parts.push(t("rankings.rules.keepBest", { count: settings.season_keep_best }));
  }
  if (settings.season_minimum > 0) {
    parts.push(t("rankings.rules.minimum", { count: settings.season_minimum }));
  }
  if (settings.season_only_session_counted) {
    parts.push(t("rankings.rules.onlySessionCounted"));
  }
  if (parts.length === 0) return t("rankings.rules.plainAverage");
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
```

Create `src/routes/SeasonRankingsRoute.tsx`:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import { RankingsView } from "../rankings/RankingsView";
import { describeSeasonRules } from "../rankings/seasonRulesSummary";
import { rankingsKeyPrefix } from "../rankings/useRankingGroups";
import { useRankingSettings } from "../rankings/useRankingSettings";

const SEASON_SCOPE = { kind: "season" as const };

/**
 * Season standings. Teamwork is the only tab for now; the skills spec adds
 * one per skills type plus Overall. Event-wide ranking updates go out on the
 * active-session channel only, so that's the one this page listens to.
 */
export function SeasonRankingsRoute() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settings = useRankingSettings();
  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (realtimeEvent: RealtimeEvent) => {
      const data = realtimeEvent.data as { event_wide?: boolean } | null;
      if (realtimeEvent.event === "ranking_updated" && data?.event_wide) {
        queryClient.invalidateQueries({ queryKey: rankingsKeyPrefix(SEASON_SCOPE) });
      }
    },
  });

  return (
    <div>
      <h1>{t("rankings.seasonHeading")}</h1>
      <div className="division-tabs" role="tablist" aria-label={t("rankings.seasonTabsLabel")}>
        <button
          type="button"
          role="tab"
          id="season-tab-teamwork"
          aria-selected={true}
          aria-controls="season-panel"
          className="division-tabs__tab"
        >
          {t("rankings.teamworkTab")}
        </button>
      </div>
      <div role="tabpanel" id="season-panel" aria-labelledby="season-tab-teamwork">
        {settings.data?.game_model === "cooperative_score" && (
          <p className="rankings-rules">{describeSeasonRules(t, settings.data)}</p>
        )}
        <RankingsView scope={SEASON_SCOPE} />
      </div>
    </div>
  );
}
```

In `src/router.tsx`, import `SeasonRankingsRoute` and add `{ path: "rankings", element: <SeasonRankingsRoute /> },` to the authenticated layout's children, after `{ path: "sessions", ... }`.

In `src/components/AppShell.tsx`, inside the `role === "admin"` nav, after the Sessions `NavLink`, add:

```tsx
            <NavLink to="/rankings" className={navLinkClassName}>
              {t("shell.seasonRankingsLink")}
            </NavLink>
```

- [ ] **Step 4: Run the tests and type check**

Run: `cd frontend/apps/admin && npm test && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit
git commit -m "Add a Season Rankings page with a Teamwork tab"
```

---

### Task 6: Ranking settings panel on Event Setup

**Files:**
- Create: `frontend/apps/admin/src/rankings/settingsDraft.ts`
- Create: `frontend/apps/admin/src/rankings/RankingSettingsPanel.tsx`
- Modify: `frontend/apps/admin/src/routes/EventSetupRoute.tsx` (render the panel; invalidate settings on game selection)
- Test: `frontend/apps/admin/tests/unit/settingsDraft.test.ts`, `frontend/apps/admin/tests/unit/RankingSettingsPanel.test.tsx`

**Interfaces:**
- Consumes: Task 4's `useRankingSettings`, `RANKING_SETTINGS_KEY`, types, i18n keys; `apiErrorMessage` (`src/apiErrorMessage.ts`).
- Produces: `SettingsDraft`, `DraftErrors`, `toDraft(settings)`, `draftErrors(draft)`, `toBody(draft)`; `<RankingSettingsPanel />`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/settingsDraft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { draftErrors, toBody, toDraft, type SettingsDraft } from "../../src/rankings/settingsDraft";
import type { RankingSettingsValues } from "../../src/types";

const DEFAULTS: RankingSettingsValues = {
  session_drop_mode: "tiered",
  session_drop_count: 1,
  session_drop_no_show: false,
  session_drop_dq: false,
  season_keep_best: null,
  season_only_session_counted: false,
  season_minimum: 0,
  season_drop_no_show: false,
  season_drop_dq: false,
};

const draft = (changes: Partial<SettingsDraft> = {}): SettingsDraft => ({ ...toDraft(DEFAULTS), ...changes });

describe("settingsDraft", () => {
  it("turns settings into text fields and back", () => {
    expect(toDraft(DEFAULTS)).toEqual({
      mode: "tiered",
      dropCount: "1",
      sessionNoShow: false,
      sessionDq: false,
      keepBest: "",
      onlySessionCounted: false,
      minimum: "0",
      seasonNoShow: false,
      seasonDq: false,
    });
    expect(toBody(toDraft(DEFAULTS))).toEqual(DEFAULTS);
  });

  it("accepts valid input, trimming spaces", () => {
    expect(draftErrors(draft())).toEqual({});
    expect(draftErrors(draft({ mode: "lowest", dropCount: " 3 ", keepBest: " 24 ", minimum: "" }))).toEqual({});
    expect(toBody(draft({ mode: "lowest", dropCount: " 3 ", keepBest: " 24 ", minimum: "" }))).toMatchObject({
      session_drop_count: 3,
      season_keep_best: 24,
      season_minimum: 0,
    });
  });

  it("checks the drop count only when dropping a set number", () => {
    expect(draftErrors(draft({ mode: "lowest", dropCount: "0" }))).toEqual({ dropCount: "dropCount" });
    expect(draftErrors(draft({ mode: "tiered", dropCount: "0" }))).toEqual({});
    expect(toBody(draft({ mode: "tiered", dropCount: "0" })).session_drop_count).toBe(1);
  });

  it("rejects decimals, negatives and zero kept matches", () => {
    expect(draftErrors(draft({ keepBest: "2.5" }))).toEqual({ keepBest: "keepBest" });
    expect(draftErrors(draft({ keepBest: "0" }))).toEqual({ keepBest: "keepBest" });
    expect(draftErrors(draft({ minimum: "-1" }))).toEqual({ minimum: "minimum" });
  });

  it("rejects a minimum above the kept matches", () => {
    expect(draftErrors(draft({ keepBest: "2", minimum: "3" }))).toEqual({ minimum: "minimumAboveKeepBest" });
    expect(draftErrors(draft({ keepBest: "", minimum: "3" }))).toEqual({});
  });
});
```

Create `tests/unit/RankingSettingsPanel.test.tsx`:

```tsx
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initI18n } from "@tournament-admin/shared";
import enAdmin from "../../src/i18n/en/admin.json";
import { RankingSettingsPanel } from "../../src/rankings/RankingSettingsPanel";
import type { GameModel, RankingSettingsRead } from "../../src/types";

vi.mock("@tournament-admin/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tournament-admin/shared")>();
  return { ...actual, apiRequest: vi.fn() };
});

import { apiRequest, ApiError } from "@tournament-admin/shared";

function settings(game_model: GameModel | null): RankingSettingsRead {
  return {
    session_drop_mode: "tiered",
    session_drop_count: 1,
    session_drop_no_show: false,
    session_drop_dq: false,
    season_keep_best: null,
    season_only_session_counted: false,
    season_minimum: 0,
    season_drop_no_show: false,
    season_drop_dq: false,
    game_model,
  };
}

function stub(gameModel: GameModel | null, onPut: (body: unknown) => unknown = (body) => body) {
  vi.mocked(apiRequest).mockImplementation(async (path: string, options?: unknown) => {
    const opts = options as { method?: string; body?: unknown } | undefined;
    if (path === "/api/ranking-settings" && opts?.method === "PUT") {
      const result = onPut(opts.body);
      if (result instanceof Error) throw result;
      return { ...(result as object), game_model: gameModel } as never;
    }
    if (path === "/api/ranking-settings") return settings(gameModel) as never;
    throw new Error(`unexpected request: ${path}`);
  });
}

function renderPanel() {
  const i18n = initI18n({ en: { translation: enAdmin } });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nextProvider i18n={i18n}>
        <RankingSettingsPanel />
      </I18nextProvider>
    </QueryClientProvider>
  );
}

const puts = () =>
  vi.mocked(apiRequest).mock.calls.filter(([, options]) => (options as { method?: string })?.method === "PUT");

beforeEach(() => {
  vi.mocked(apiRequest).mockReset();
});

describe("RankingSettingsPanel", () => {
  it("renders nothing for a head-to-head event", async () => {
    stub("head_to_head");
    const { container } = renderPanel();
    await waitFor(() => expect(apiRequest).toHaveBeenCalledWith("/api/ranking-settings"));
    expect(container).toBeEmptyDOMElement();
  });

  it("enables the drop count only for dropping a set number", async () => {
    stub("cooperative_score");
    renderPanel();
    const count = await screen.findByLabelText("Matches to drop");
    expect(count).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Drop a set number of lowest matches"));
    expect(count).toBeEnabled();
  });

  it("blocks a minimum above the kept matches without saving", async () => {
    stub("cooperative_score");
    renderPanel();
    const season = await screen.findByRole("group", { name: "Season rankings" });
    fireEvent.change(within(season).getByLabelText("Keep best matches"), { target: { value: "2" } });
    fireEvent.change(within(season).getByLabelText("Minimum matches"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ranking settings" }));

    expect(await screen.findByText("Minimum can't be more than the number of matches kept.")).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it("rejects a decimal number of kept matches", async () => {
    stub("cooperative_score");
    renderPanel();
    const season = await screen.findByRole("group", { name: "Season rankings" });
    fireEvent.change(within(season).getByLabelText("Keep best matches"), { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ranking settings" }));

    expect(await screen.findByText("Enter a whole number of 1 or more, or leave blank.")).toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it("shows the server's message when the save is refused", async () => {
    stub("cooperative_score", () => new ApiError(422, "season_minimum cannot be more than season_keep_best"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Save ranking settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "season_minimum cannot be more than season_keep_best"
    );
  });

  it("saves the form as the settings body", async () => {
    let saved: unknown = null;
    stub("cooperative_score", (body) => {
      saved = body;
      return body;
    });
    renderPanel();
    const sessionGroup = await screen.findByRole("group", { name: "Session rankings" });
    const season = screen.getByRole("group", { name: "Season rankings" });
    fireEvent.click(within(sessionGroup).getByLabelText("Drop a set number of lowest matches"));
    fireEvent.change(within(sessionGroup).getByLabelText("Matches to drop"), { target: { value: "2" } });
    fireEvent.click(within(sessionGroup).getByLabelText("DQs can be dropped"));
    fireEvent.change(within(season).getByLabelText("Keep best matches"), { target: { value: "24" } });
    fireEvent.click(within(season).getByLabelText("Only use matches counted in a session ranking"));
    fireEvent.change(within(season).getByLabelText("Minimum matches"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save ranking settings" }));

    expect(await screen.findByText("Settings saved. Rankings recalculated.")).toBeInTheDocument();
    expect(saved).toEqual({
      session_drop_mode: "lowest",
      session_drop_count: 2,
      session_drop_no_show: false,
      session_drop_dq: true,
      season_keep_best: 24,
      season_only_session_counted: true,
      season_minimum: 20,
      season_drop_no_show: false,
      season_drop_dq: false,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd frontend/apps/admin && npx vitest run tests/unit/settingsDraft.test.ts tests/unit/RankingSettingsPanel.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the draft helpers and the panel**

Create `src/rankings/settingsDraft.ts`:

```ts
import type { RankingSettingsValues, SessionDropMode } from "../types";

/** The settings form as typed: numbers stay text until saved. */
export interface SettingsDraft {
  mode: SessionDropMode;
  dropCount: string;
  sessionNoShow: boolean;
  sessionDq: boolean;
  keepBest: string;
  onlySessionCounted: boolean;
  minimum: string;
  seasonNoShow: boolean;
  seasonDq: boolean;
}

/** Field -> the key of its message under rankings.settings.errors. */
export type DraftErrors = Partial<
  Record<"dropCount" | "keepBest" | "minimum", "dropCount" | "keepBest" | "minimum" | "minimumAboveKeepBest">
>;

function parseWhole(text: string): number | null {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

export function toDraft(settings: RankingSettingsValues): SettingsDraft {
  return {
    mode: settings.session_drop_mode,
    dropCount: String(settings.session_drop_count),
    sessionNoShow: settings.session_drop_no_show,
    sessionDq: settings.session_drop_dq,
    keepBest: settings.season_keep_best === null ? "" : String(settings.season_keep_best),
    onlySessionCounted: settings.season_only_session_counted,
    minimum: String(settings.season_minimum),
    seasonNoShow: settings.season_drop_no_show,
    seasonDq: settings.season_drop_dq,
  };
}

export function draftErrors(draft: SettingsDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (draft.mode === "lowest") {
    const dropCount = parseWhole(draft.dropCount);
    if (dropCount === null || dropCount < 1) errors.dropCount = "dropCount";
  }
  let keepBest: number | null = null;
  if (draft.keepBest.trim() !== "") {
    keepBest = parseWhole(draft.keepBest);
    if (keepBest === null || keepBest < 1) {
      errors.keepBest = "keepBest";
      keepBest = null;
    }
  }
  const minimum = draft.minimum.trim() === "" ? 0 : parseWhole(draft.minimum);
  if (minimum === null) errors.minimum = "minimum";
  else if (keepBest !== null && minimum > keepBest) errors.minimum = "minimumAboveKeepBest";
  return errors;
}

/** Only call once draftErrors(draft) is empty. */
export function toBody(draft: SettingsDraft): RankingSettingsValues {
  const dropCount = parseWhole(draft.dropCount);
  return {
    session_drop_mode: draft.mode,
    // The server always needs a count of 1 or more, even when it's unused.
    session_drop_count: dropCount !== null && dropCount >= 1 ? dropCount : 1,
    session_drop_no_show: draft.sessionNoShow,
    session_drop_dq: draft.sessionDq,
    season_keep_best: draft.keepBest.trim() === "" ? null : (parseWhole(draft.keepBest) as number),
    season_only_session_counted: draft.onlySessionCounted,
    season_minimum: draft.minimum.trim() === "" ? 0 : (parseWhole(draft.minimum) as number),
    season_drop_no_show: draft.seasonNoShow,
    season_drop_dq: draft.seasonDq,
  };
}
```

Create `src/rankings/RankingSettingsPanel.tsx`:

```tsx
import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import type { RankingSettingsRead, RankingSettingsValues, SessionDropMode } from "../types";
import { draftErrors, toBody, toDraft, type SettingsDraft } from "./settingsDraft";
import { RANKING_SETTINGS_KEY, useRankingSettings } from "./useRankingSettings";

/** Event Setup's ranking settings. Only cooperative games have any. */
export function RankingSettingsPanel() {
  const { data } = useRankingSettings();
  if (!data || data.game_model !== "cooperative_score") return null;
  return <RankingSettingsForm initial={data} />;
}

const MODES: { value: SessionDropMode; labelKey: string }[] = [
  { value: "tiered", labelKey: "rankings.settings.modeTiered" },
  { value: "none", labelKey: "rankings.settings.modeNone" },
  { value: "lowest", labelKey: "rankings.settings.modeLowest" },
];

function RankingSettingsForm({ initial }: { initial: RankingSettingsRead }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<SettingsDraft>(() => toDraft(initial));
  const [attempted, setAttempted] = useState(false);
  const errors = draftErrors(draft);
  const mutation = useMutation({
    mutationFn: (body: RankingSettingsValues) =>
      apiRequest<RankingSettingsRead>("/api/ranking-settings", { method: "PUT", body }),
    onSuccess: (saved) => {
      queryClient.setQueryData(RANKING_SETTINGS_KEY, saved);
      queryClient.invalidateQueries({ queryKey: ["rankings"] });
    },
  });

  function update(changes: Partial<SettingsDraft>) {
    setDraft((current) => ({ ...current, ...changes }));
    mutation.reset();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (Object.keys(errors).length > 0) return;
    mutation.mutate(toBody(draft));
  }

  function fieldError(field: keyof typeof errors) {
    const key = attempted ? errors[field] : undefined;
    return key ? (
      <p className="field__hint field__error" id={`ranking-${field}-error`}>
        {t(`rankings.settings.errors.${key}`)}
      </p>
    ) : null;
  }

  return (
    <section className="panel" aria-labelledby="ranking-settings-heading">
      <h2 id="ranking-settings-heading">{t("rankings.settings.heading")}</h2>
      <p className="field__hint">{t("rankings.settings.intro")}</p>
      <form onSubmit={onSubmit} noValidate>
        <fieldset className="settings-group">
          <legend>{t("rankings.settings.sessionLegend")}</legend>
          {MODES.map((mode) => (
            <div key={mode.value}>
              <label className="choice">
                <input
                  type="radio"
                  name="session-drop-mode"
                  value={mode.value}
                  checked={draft.mode === mode.value}
                  onChange={() => update({ mode: mode.value })}
                />
                {t(mode.labelKey)}
              </label>
              {mode.value === "tiered" && <p className="field__hint">{t("rankings.settings.tieredHint")}</p>}
            </div>
          ))}
          <div className="field">
            <label className="field__label" htmlFor="ranking-drop-count">
              {t("rankings.settings.dropCountLabel")}
            </label>
            <input
              id="ranking-drop-count"
              className="input settings-number"
              inputMode="numeric"
              value={draft.dropCount}
              disabled={draft.mode !== "lowest"}
              aria-invalid={attempted && errors.dropCount ? true : undefined}
              aria-describedby={attempted && errors.dropCount ? "ranking-dropCount-error" : undefined}
              onChange={(event) => update({ dropCount: event.target.value })}
            />
            {fieldError("dropCount")}
          </div>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.sessionNoShow}
              onChange={(event) => update({ sessionNoShow: event.target.checked })}
            />
            {t("rankings.settings.noShowLabel")}
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.sessionDq}
              onChange={(event) => update({ sessionDq: event.target.checked })}
            />
            {t("rankings.settings.dqLabel")}
          </label>
        </fieldset>

        <fieldset className="settings-group">
          <legend>{t("rankings.settings.seasonLegend")}</legend>
          <div className="field">
            <label className="field__label" htmlFor="ranking-keep-best">
              {t("rankings.settings.keepBestLabel")}
            </label>
            <input
              id="ranking-keep-best"
              className="input settings-number"
              inputMode="numeric"
              value={draft.keepBest}
              aria-invalid={attempted && errors.keepBest ? true : undefined}
              aria-describedby={attempted && errors.keepBest ? "ranking-keepBest-error" : "ranking-keep-best-hint"}
              onChange={(event) => update({ keepBest: event.target.value })}
            />
            <p className="field__hint" id="ranking-keep-best-hint">
              {t("rankings.settings.keepBestHint")}
            </p>
            {fieldError("keepBest")}
          </div>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.onlySessionCounted}
              onChange={(event) => update({ onlySessionCounted: event.target.checked })}
            />
            {t("rankings.settings.onlySessionCountedLabel")}
          </label>
          <div className="field">
            <label className="field__label" htmlFor="ranking-minimum">
              {t("rankings.settings.minimumLabel")}
            </label>
            <input
              id="ranking-minimum"
              className="input settings-number"
              inputMode="numeric"
              value={draft.minimum}
              aria-invalid={attempted && errors.minimum ? true : undefined}
              aria-describedby={attempted && errors.minimum ? "ranking-minimum-error" : "ranking-minimum-hint"}
              onChange={(event) => update({ minimum: event.target.value })}
            />
            <p className="field__hint" id="ranking-minimum-hint">
              {t("rankings.settings.minimumHint")}
            </p>
            {fieldError("minimum")}
          </div>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.seasonNoShow}
              onChange={(event) => update({ seasonNoShow: event.target.checked })}
            />
            {t("rankings.settings.noShowLabel")}
          </label>
          <label className="choice">
            <input
              type="checkbox"
              checked={draft.seasonDq}
              onChange={(event) => update({ seasonDq: event.target.checked })}
            />
            {t("rankings.settings.dqLabel")}
          </label>
        </fieldset>

        {mutation.isError && (
          <p className="alert alert-danger" role="alert">
            {apiErrorMessage(mutation.error, t("errors.generic"))}
          </p>
        )}
        {mutation.isSuccess && (
          <p className="alert alert-success" role="status">
            {t("rankings.settings.saved")}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={mutation.isPending}>
            {t("rankings.settings.save")}
          </button>
        </div>
      </form>
    </section>
  );
}
```

Add to `src/styles/components.css` (with the other rankings rules):

```css
.field__error {
  color: var(--color-danger);
}
```

In `src/routes/EventSetupRoute.tsx`:
- import `RankingSettingsPanel` from `../rankings/RankingSettingsPanel` and `RANKING_SETTINGS_KEY` from `../rankings/useRankingSettings`;
- change `selectMutation`'s `onSuccess` so choosing a game reveals the panel without a reload:

```tsx
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["event"] });
      queryClient.invalidateQueries({ queryKey: RANKING_SETTINGS_KEY });
    },
```

- render `<RankingSettingsPanel />` between the scheduler `PluginList` and `<ServerInfoPanel />`.

- [ ] **Step 4: Run the tests and type check**

Run: `cd frontend/apps/admin && npm test && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit
git commit -m "Let admins set cooperative ranking rules on Event Setup"
```

---

### Task 7: End-to-end coverage and docs

**Files:**
- Create: `frontend/apps/admin/tests/e2e/fixtures/isolatedServer.ts`
- Modify: `frontend/apps/admin/tests/e2e/fixtures/buildPluginZip.ts` (add `buildCooperativeGamePluginZip`)
- Create: `frontend/apps/admin/tests/e2e/cooperativeRankings.spec.ts`
- Create: `frontend/apps/admin/tests/e2e/zz_seasonRankings.spec.ts`
- Modify: `frontend/CLAUDE.md`

**Interfaces:**
- Consumes: everything above, over real HTTP/WebSocket.
- Produces: `startIsolatedServer({ backendPort, frontendPort }): Promise<IsolatedServer>` with `{ baseUrl, apiUrl, stop() }`.

- [ ] **Step 1: Add the isolated-server fixture and the cooperative plugin zip**

Create `tests/e2e/fixtures/isolatedServer.ts`:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// package.json sets "type": "module" (see playwright.config.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface IsolatedServer {
  baseUrl: string;
  apiUrl: string;
  stop: () => void;
}

function waitForPort(port: number, host: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ port, host }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`Timed out waiting for ${host}:${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

/**
 * A backend on its own fresh database plus a Vite dev server proxying to it,
 * for scenarios the shared E2E event can't host (its game plugin is fixed
 * once chosen). Spawned like tournamentPicker.spec.ts's servers: no shell,
 * and each process leads its own group so stop() reaps the whole tree.
 */
export async function startIsolatedServer({
  backendPort,
  frontendPort,
}: {
  backendPort: number;
  frontendPort: number;
}): Promise<IsolatedServer> {
  const dir = mkdtempSync(path.join(tmpdir(), "tournament-admin-isolated-e2e-"));
  const backendEnv = { ...process.env };
  delete backendEnv.TOURNAMENT_DEFAULT_DIR;
  const backend: ChildProcess = spawn(".venv/bin/python", ["-m", "tournament_server.main"], {
    cwd: path.resolve(__dirname, "../../../../../../server"),
    env: {
      ...backendEnv,
      TOURNAMENT_DB_PATH: path.join(dir, "event.db"),
      TOURNAMENT_CONFIG_PATH: path.join(dir, "server-config.json"),
      TOURNAMENT_PLUGINS_ROOT: path.join(dir, "plugins"),
      TOURNAMENT_HOST: "127.0.0.1",
      TOURNAMENT_PORT: String(backendPort),
    },
    stdio: "pipe",
    detached: true,
  });
  await waitForPort(backendPort, "127.0.0.1", 30_000);

  const frontend: ChildProcess = spawn(
    "npm",
    ["run", "dev", "--", "--port", String(frontendPort), "--strictPort"],
    {
      cwd: path.resolve(__dirname, "../../.."),
      env: { ...process.env, VITE_BACKEND_PORT: String(backendPort) },
      stdio: "pipe",
      detached: true,
    }
  );
  await waitForPort(frontendPort, "127.0.0.1", 30_000);

  return {
    baseUrl: `http://127.0.0.1:${frontendPort}`,
    apiUrl: `http://127.0.0.1:${backendPort}`,
    stop: () => {
      for (const proc of [backend, frontend]) {
        if (!proc.pid) continue;
        try {
          process.kill(-proc.pid, "SIGTERM");
        } catch {
          proc.kill();
        }
      }
    },
  };
}
```

Append to `tests/e2e/fixtures/buildPluginZip.ts`:

```ts
const COOPERATIVE_GAME_PLUGIN_DIR = path.resolve(
  __dirname,
  "../../../../../../server/tests/fixtures/plugins/games/cooperative-game"
);

/** Only manifest.json and plugin.py, for the same reason as the balanced scheduler's zip. */
export async function buildCooperativeGamePluginZip(): Promise<string> {
  const outPath = path.join(os.tmpdir(), `cooperative-game-${Date.now()}.zip`);
  await new Promise<void>((resolve, reject) => {
    const output = createWriteStream(outPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(path.join(COOPERATIVE_GAME_PLUGIN_DIR, "manifest.json"), { name: "manifest.json" });
    archive.file(path.join(COOPERATIVE_GAME_PLUGIN_DIR, "plugin.py"), { name: "plugin.py" });
    void archive.finalize();
  });
  return outPath;
}
```

- [ ] **Step 2: Write the cooperative spec**

Create `tests/e2e/cooperativeRankings.spec.ts`:

```ts
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { buildCooperativeGamePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

// The shared E2E event is locked to the head-to-head example game, so the
// cooperative flows run against their own backend and Vite server.
const PASSWORD = "coop-e2e-pw";

test.describe.serial("cooperative rankings and ranking settings", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let sessionOne = 0;
  let sessionTwo = 0;
  const teams: Record<string, number> = {};
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function login(page: Page) {
    await page.goto(`${server.baseUrl}/login`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(`${server.baseUrl}/`);
  }

  async function playMatch(request: APIRequestContext, sessionId: number, number: number, objects: number) {
    const created = await request.post(api("/api/matches"), {
      headers: headers(),
      data: {
        session_id: sessionId,
        round_type: "qualification",
        match_number: number,
        field_id: null,
        alliances: [
          { station: "red", team_ids: [teams.C1] },
          { station: "blue", team_ids: [teams.C2] },
        ],
      },
    });
    expect(created.ok()).toBeTruthy();
    const match = await created.json();
    const red = match.alliances.find((a: { station: string }) => a.station === "red");
    const scored = await request.post(api(`/api/matches/${match.id}/alliances/${red.id}/score`), {
      headers: headers(),
      data: { data: { objects_scored: objects } },
    });
    expect(scored.ok()).toBeTruthy();
  }

  function cell(page: Page, teamNumber: string, column: number) {
    return page
      .getByRole("row")
      .filter({ has: page.getByRole("cell", { name: teamNumber, exact: true }) })
      .getByRole("cell")
      .nth(column);
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8125, frontendPort: 5185 });
    const created = await request.post(api("/api/event"), {
      data: { name: "Cooperative League", password: PASSWORD },
    });
    expect(created.status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json())
      .access_token;
    for (const number of ["C1", "C2"]) {
      const team = await request.post(api("/api/teams"), { headers: headers(), data: { number, name: `Crew ${number}` } });
      teams[number] = (await team.json()).id;
    }
    for (const label of ["Saturday", "Sunday"]) {
      const session = await request.post(api("/api/sessions"), { headers: headers(), data: { label } });
      if (label === "Saturday") sessionOne = (await session.json()).id;
      else sessionTwo = (await session.json()).id;
    }
  });

  test.afterAll(() => server?.stop());

  test("selecting the cooperative game reveals the ranking settings", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    await expect(page.getByRole("heading", { name: "Game plugins" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ranking settings" })).toHaveCount(0);

    await page.getByLabel("Install a plugin (.zip)").first().setInputFiles(await buildCooperativeGamePluginZip());
    await expect(page.getByText("Cooperative Scoring Game")).toBeVisible();
    await page.getByRole("button", { name: "Select for this event" }).click();

    await expect(page.getByRole("heading", { name: "Ranking settings" })).toBeVisible();
  });

  test("session and season rankings for a two-session league", async ({ page, request }) => {
    await playMatch(request, sessionOne, 1, 10); // 20
    await playMatch(request, sessionOne, 2, 5); // 10
    await playMatch(request, sessionTwo, 1, 15); // 30

    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${sessionOne}/rankings`);
    await expect(cell(page, "C1", 3)).toHaveText("15.00");
    await expect(cell(page, "C1", 4)).toHaveText("2");

    await page.getByRole("link", { name: "Season rankings" }).click();
    await expect(page.getByRole("tab", { name: "Teamwork" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByText("Average of every qualification match.")).toBeVisible();
    await expect(cell(page, "C1", 3)).toHaveText("20.00");
    await expect(cell(page, "C1", 4)).toHaveText("3");
  });

  test("saving season settings recalculates the season, live", async ({ page, request }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    const season = page.getByRole("group", { name: "Season rankings" });
    await season.getByLabel("Keep best matches").fill("2");
    await season.getByLabel("Minimum matches").fill("2");
    await page.getByRole("button", { name: "Save ranking settings" }).click();
    await expect(page.getByText("Settings saved. Rankings recalculated.")).toBeVisible();

    const socket = page.waitForEvent("websocket", (ws) => ws.url().includes("/ws/active-session"));
    await page.getByRole("link", { name: "Season rankings" }).click();
    await socket;
    await expect(page.getByText("Best 2 matches · minimum 2")).toBeVisible();
    await expect(cell(page, "C1", 3)).toHaveText("25.00");

    const saved = await request.put(api("/api/ranking-settings"), {
      headers: headers(),
      data: {
        session_drop_mode: "tiered",
        session_drop_count: 1,
        session_drop_no_show: false,
        session_drop_dq: false,
        season_keep_best: 4,
        season_only_session_counted: false,
        season_minimum: 4,
        season_drop_no_show: false,
        season_drop_dq: false,
      },
    });
    expect(saved.ok()).toBeTruthy();
    await expect(cell(page, "C1", 3)).toHaveText("15.00"); // (20 + 10 + 30) / 4, without a reload
  });

  test("a minimum above the kept matches is refused", async ({ page, request }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/events/setup`);
    const season = page.getByRole("group", { name: "Season rankings" });
    await season.getByLabel("Keep best matches").fill("2");
    await season.getByLabel("Minimum matches").fill("3");
    await page.getByRole("button", { name: "Save ranking settings" }).click();
    await expect(page.getByText("Minimum can't be more than the number of matches kept.")).toBeVisible();

    const current = await (await request.get(api("/api/ranking-settings"), { headers: headers() })).json();
    expect(current.season_keep_best).toBe(4);
  });
});
```

- [ ] **Step 3: Write the head-to-head spec**

Create `tests/e2e/zz_seasonRankings.spec.ts`:

```ts
import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { E2E_EVENT_NAME, E2E_EVENT_PASSWORD } from "./fixtures/testEvent";
import { buildExampleGamePluginZip } from "./fixtures/buildPluginZip";

// "zz_" runs this after every other spec: it adds teams to the shared event
// (the team-grid specs assume a small roster) and must not disturb
// z_sessionSchedule's division setup. Assertions are scoped to this file's
// own teams, since earlier specs leave scored matches of their own.
let token = "";
const headers = () => ({ Authorization: `Bearer ${token}` });
const teams: Record<string, number> = {};
let sessionOne = 0;
let sessionTwo = 0;

async function playMatch(
  request: APIRequestContext,
  sessionId: number,
  matchNumber: number,
  red: string,
  blue: string,
  redHigh: number,
  blueHigh: number,
  roundType = "qualification"
) {
  const created = await request.post("/api/matches", {
    headers: headers(),
    data: {
      session_id: sessionId,
      round_type: roundType,
      match_number: matchNumber,
      field_id: null,
      alliances: [
        { station: "red", team_ids: [teams[red]] },
        { station: "blue", team_ids: [teams[blue]] },
      ],
    },
  });
  expect(created.ok()).toBeTruthy();
  const match = await created.json();
  for (const alliance of match.alliances) {
    const high = alliance.station === "red" ? redHigh : blueHigh;
    const scored = await request.post(`/api/matches/${match.id}/alliances/${alliance.id}/score`, {
      headers: headers(),
      data: { data: { high_balls: high, low_balls: 0, auto_winner: "tie" } },
    });
    expect(scored.ok()).toBeTruthy();
  }
}

function cell(page: Page, teamNumber: string, column: number) {
  return page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: teamNumber, exact: true }) })
    .getByRole("cell")
    .nth(column);
}

async function loginAsAdmin(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Role").fill("admin");
  await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
}

test.describe.serial("head-to-head session and season rankings", () => {
  test.beforeAll(async ({ request }) => {
    const created = await request.post("/api/event", { data: { name: E2E_EVENT_NAME, password: E2E_EVENT_PASSWORD } });
    expect([201, 409]).toContain(created.status());
    token = (await (await request.post("/api/auth/login", { data: { role: "admin", password: E2E_EVENT_PASSWORD } })).json())
      .access_token;
    const event = await (await request.get("/api/event")).json();
    if (event.game_plugin_name === null) {
      const uploaded = await request.post("/api/plugins/games", {
        headers: headers(),
        multipart: {
          file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildExampleGamePluginZip()) },
        },
      });
      expect([201, 409]).toContain(uploaded.status());
      expect((await request.post("/api/event/game-plugin", { headers: headers(), data: { name: "example-game" } })).ok()).toBeTruthy();
    }
    for (const number of ["RK1", "RK2", "RK3"]) {
      const team = await request.post("/api/teams", { headers: headers(), data: { number, name: `Ranker ${number}` } });
      expect(team.ok()).toBeTruthy();
      teams[number] = (await team.json()).id;
    }
    sessionOne = (await (await request.post("/api/sessions", { headers: headers(), data: { label: "Rankings Saturday" } })).json()).id;
    sessionTwo = (await (await request.post("/api/sessions", { headers: headers(), data: { label: "Rankings Sunday" } })).json()).id;

    await playMatch(request, sessionOne, 1, "RK1", "RK2", 16, 6); // RK1 wins
    await playMatch(request, sessionTwo, 1, "RK1", "RK2", 10, 10); // tie
    await playMatch(request, sessionTwo, 2, "RK3", "RK2", 16, 6); // RK3 wins; RK3 missed Saturday
    await playMatch(request, sessionTwo, 3, "RK2", "RK1", 30, 0, "practice"); // never counts
  });

  test("a session's Rankings tab shows that session's win points", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto(`/sessions/${sessionOne}/matches`);
    await page.getByRole("link", { name: "Rankings", exact: true }).click();
    await expect(cell(page, "RK1", 3)).toHaveText("2");
    await expect(cell(page, "RK2", 3)).toHaveText("0");
    await expect(page.getByRole("cell", { name: "RK3", exact: true })).toHaveCount(0);
  });

  test("season rankings total every session's qualification matches", async ({ page }) => {
    await loginAsAdmin(page);
    await page.getByRole("link", { name: "Season rankings" }).click();
    await expect(cell(page, "RK1", 3)).toHaveText("3");
    await expect(cell(page, "RK3", 3)).toHaveText("2");
    await expect(cell(page, "RK2", 3)).toHaveText("1");
    const rank = async (team: string) => Number(await cell(page, team, 0).textContent());
    expect(await rank("RK1")).toBeLessThan(await rank("RK3"));
    expect(await rank("RK3")).toBeLessThan(await rank("RK2"));
  });

  test("season rankings update live when a match is scored", async ({ page, request }) => {
    await loginAsAdmin(page);
    const socket = page.waitForEvent("websocket", (ws) => ws.url().includes("/ws/active-session"));
    await page.goto("/rankings");
    await socket;
    await expect(cell(page, "RK2", 3)).toHaveText("1");

    await playMatch(request, sessionTwo, 4, "RK2", "RK3", 16, 6);
    await expect(cell(page, "RK2", 3)).toHaveText("3");
  });

  test("head-to-head events have no ranking settings panel", async ({ page }) => {
    await loginAsAdmin(page);
    await page.goto("/events/setup");
    await expect(page.getByRole("heading", { name: "Game plugins" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Ranking settings" })).toHaveCount(0);
  });
});
```

- [ ] **Step 4: Run the E2E suite**

Run: `cd frontend/apps/admin && npm run test:e2e`
Expected: all specs pass, including the 4 cooperative and 4 head-to-head tests.

- [ ] **Step 5: Update `frontend/CLAUDE.md`**

In "Routes and role-gated nav": add `rankings` to the session tab list (`/sessions/:sessionId/{checkin,fields,schedule,matches,rankings}`), and add after the Schedule paragraph:

```markdown
Rankings live in `src/rankings/`. `useRankingGroups(scope)` fetches every
division's rankings plus `division_id = null` (a single-division event's
scheduled matches carry no division) and returns only non-empty groups;
`RankingsView` renders them through `RankingTables`, with columns chosen by
`game_model` from `GET /api/ranking-settings` (`useRankingSettings`, key
`["rankingSettings"]`). The session Rankings tab invalidates
`["rankings", sessionId]` off `/ws/session/{id}`; `/rankings` (Season
rankings, a Teamwork tab for now — skills tabs come later) invalidates
`["rankings", "season"]` off `/ws/active-session`, the only channel that
carries event-wide `ranking_updated`. Event Setup's `RankingSettingsPanel`
renders only for `cooperative_score`; its form logic (`settingsDraft.ts`) is
pure and unit-tested, and choosing a game plugin invalidates the settings
query so the panel appears without a reload.
```

In "Testing", add after the shared-event paragraph:

```markdown
A scenario the shared event can't host (its game plugin can't change once
chosen) starts its own backend and Vite server with
`tests/e2e/fixtures/isolatedServer.ts`, as `cooperativeRankings.spec.ts`
does on ports 8125/5185. `zz_seasonRankings.spec.ts` runs last for the same
reason as `z_sessionSchedule.spec.ts`.
```

- [ ] **Step 6: Run everything once more and commit**

Run: `cd server && .venv/bin/pytest -q && cd ../frontend/apps/admin && npm test && npx tsc --noEmit`
Expected: all pass.

```bash
git add frontend/apps/admin/tests/e2e frontend/CLAUDE.md
git commit -m "Cover session and season rankings end to end"
```

Then restart the demo servers (backend on 8001, Vite on 5174) so the user can try the feature, and verify both serve the new code.
