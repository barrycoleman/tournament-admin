# Finalize Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin finalize a session's qualification from the Matches page. Unplayed matches become "not played", cooperative teams drop an admin-chosen number of matches per played count, and finals can be generated only from a finalized session.

**Architecture:**
- **Pure rules:** `ranking_rules.py` gains an optional `finalized_drops` override and a `suggest_finalize_drops` helper.
- **Storage:** the session stores `qualification_finalized_at` and a `qualification_drops` map.
- **Service:** a new `services/qualification.py` computes the preview (played counts, blockers, unplayed matches), finalizes and reopens.
- **API:** a new `routers/qualification.py` exposes it.
- **Ranking:** `services/ranking.py` passes each finalized session's drops into the rules.
- **Guards:** finals start, score submission, schedule changes, manual match creation and match start each refuse actions that a finalized (or not-played) state forbids.
- **Admin UI:** the Matches page gets a qualification bar and a finalize dialog.

**Tech Stack:**
- Server: FastAPI, SQLAlchemy 2.x, Alembic, SQLite, pytest.
- Frontend: React 19, TanStack Query, react-i18next, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-07-finalize-qualification-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name anywhere: code, comments, commits, docs, test data.
- Every backend change ships with pytest tests against a real FastAPI `TestClient` and a real temp-file SQLite database, in the same commit as the code.
- Every frontend change ships with Vitest component tests and Playwright E2E coverage, with no mocking at the HTTP/WebSocket boundary in E2E.
- Schema changes go through Alembic. The new migration's `down_revision` is `c5f2a9e4b7d1` (the current head).
- Every user-facing string goes through `t(...)` in both `frontend/apps/admin/src/i18n/en/admin.json` and `.../zh/admin.json`.
- No change to the game-plugin interface.
- Work on branch `finalize-qualification` in the main checkout. No worktrees, no pushing, no merging.
- Commit messages are plain sentences (no `feat:` prefixes) and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands:
  - Server tests: `cd server && .venv/bin/pytest -q` (or `uv run pytest -q` if `.venv` is absent).
  - Frontend unit tests: `cd frontend && npm test --workspace apps/admin -- --run`.
  - Type check: `cd frontend && npx tsc -b apps/admin`.
  - E2E: `cd frontend/apps/admin && npx playwright test <file>`.

## Review Focus

1. **A finalized team with a played count missing from the map** (direct DB edit) gets 0 drops, never a crash. Pinned in Task 3: `test_missing_played_count_in_map_drops_nothing`.
2. **Finalizing a session whose only qualification matches are fully unscored** gives no rows and marks every match not played. Rankings for that session are empty and nothing crashes. Pinned in Task 3: `test_finalize_with_nothing_played`.
3. **A JSON body with `true` as a drop value** (bool is an int subclass) is rejected with 422, not accepted as 1. Pinned in Task 3: `test_finalize_rejects_boolean_drop_values`.
4. **Reopening, then scoring a formerly not-played match, then finalizing again** gives updated played counts and drops. Pinned in Task 3: `test_reopen_then_score_then_finalize_again`.
5. **The dialog with a blank input** shows an error and keeps Finalize disabled. It never sends `NaN` or `""`. Pinned in Task 5: `finalizeDraft` tests.

---

### Task 1: Pure rules — finalized drops and suggestions

**Files:**
- Modify: `server/src/tournament_server/services/ranking_rules.py`
- Test: `server/tests/test_ranking_rules.py`

**Interfaces:**
- Produces:
  - `session_drops(records: list[MatchRecord], scheduled: int, rules: RankingRules, finalized_drops: int | None = None) -> set[int]`
  - `suggest_finalize_drops(played: int, rules: RankingRules) -> int`

- [ ] **Step 1: Write the failing tests.** Append to `server/tests/test_ranking_rules.py`, and add `suggest_finalize_drops` to the existing import list from `tournament_server.services.ranking_rules`.

```python
def test_finalized_drops_apply_immediately_without_the_earning_gate():
    records = ascending(8)  # 10..80; 10 were scheduled, so open-session tiers would earn nothing yet
    assert session_drops(records, 10, RankingRules()) == set()
    assert session_drops(records, 10, RankingRules(), finalized_drops=2) == {1, 2}


def test_finalized_drops_never_drop_the_last_record():
    assert session_drops(ascending(2), 2, RankingRules(), finalized_drops=5) == {1}
    assert session_drops(ascending(1), 1, RankingRules(), finalized_drops=1) == set()


def test_finalized_drops_respect_no_show_and_dq_settings():
    records = [rec(1, 0, no_show=True), rec(2, 0, dq=True), rec(3, 30), rec(4, 40)]
    assert session_drops(records, 4, RankingRules(), finalized_drops=1) == {3}
    allow = RankingRules(session_drop_no_show=True)
    assert session_drops(records, 4, allow, finalized_drops=1) == {1}


def test_finalized_zero_drops_nothing():
    assert session_drops(ascending(8), 8, RankingRules(), finalized_drops=0) == set()


@pytest.mark.parametrize(
    "rules, played, expected",
    [
        (RankingRules(), 7, 1),
        (RankingRules(), 8, 2),
        (RankingRules(), 1, 0),
        (RankingRules(session_drop_mode="lowest", session_drop_count=3), 8, 3),
        (RankingRules(session_drop_mode="lowest", session_drop_count=3), 2, 1),  # capped at played - 1
        (RankingRules(session_drop_mode="none"), 8, 0),
        (RankingRules(session_drop_mode="lowest", session_drop_count=3), 0, 0),
    ],
)
def test_suggest_finalize_drops(rules, played, expected):
    assert suggest_finalize_drops(played, rules) == expected
```

- [ ] **Step 2: Run to verify failure.** `cd server && .venv/bin/pytest tests/test_ranking_rules.py -q`. Expected: ImportError for `suggest_finalize_drops`.

- [ ] **Step 3: Implement.** In `ranking_rules.py`, add the helper after `session_drop_allowance`, and replace `session_drops` with:

```python
def suggest_finalize_drops(played: int, rules: RankingRules) -> int:
    """The finalize dialog's starting value for teams that played `played` matches:
    the session drop setting applied to what was played, never dropping every match."""
    return max(0, min(session_drop_allowance(played, rules), played - 1))


def session_drops(
    records: list[MatchRecord],
    scheduled: int,
    rules: RankingRules,
    finalized_drops: int | None = None,
) -> set[int]:
    """Match ids dropped from one team's ranking in one session.

    While the session is open, drops are earned only as the last `allowance`
    scheduled matches are scored. Once qualification is finalized,
    `finalized_drops` (the admin's number for this team's played count)
    applies immediately. Either way a team's last record is never dropped.
    """
    if finalized_drops is None:
        allowance = session_drop_allowance(scheduled, rules)
        earned = min(allowance, max(0, len(records) - (scheduled - allowance)))
    else:
        earned = finalized_drops
    earned = min(earned, max(0, len(records) - 1))
    dropped: set[int] = set()
    for record in sorted(records, key=lambda r: (r.score, r.match_id)):
        if len(dropped) >= earned:
            break
        if _droppable(record, rules.session_drop_no_show, rules.session_drop_dq):
            dropped.add(record.match_id)
    return dropped
```

- [ ] **Step 4: Run to verify the tests pass.** `.venv/bin/pytest tests/test_ranking_rules.py -q`. Expected: all pass.

- [ ] **Step 5: Commit.**

```bash
git add server/src/tournament_server/services/ranking_rules.py server/tests/test_ranking_rules.py
git commit -m "Let a finalized session set each team's drops directly

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Session columns, migration, `SessionRead`

**Files:**
- Modify: `server/src/tournament_server/models/session.py`
- Create: `server/src/tournament_server/_alembic/versions/d8e4b2a6c9f3_add_session_qualification_finalize.py`
- Modify: `server/src/tournament_server/schemas/session.py`
- Test: `server/tests/test_migrations.py`, `server/tests/test_sessions.py`

**Interfaces:**
- Produces:
  - `TournamentSession.qualification_finalized_at: dt.datetime | None`
  - `TournamentSession.qualification_drops: dict[str, int] | None`
  - `SessionRead` fields of the same names.

- [ ] **Step 1: Write the failing tests.** Append to `server/tests/test_migrations.py` (it already imports `command`, `create_engine`, `text`, `make_engine`, `ensure_schema_current`, `MigrationOutcome` and defines `_make_alembic_config`):

```python
def test_existing_sessions_read_as_open_after_the_finalize_migration(tmp_path):
    db_path = str(tmp_path / "finalize.db")
    command.upgrade(_make_alembic_config(db_path), "c5f2a9e4b7d1")  # the revision before
    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text("INSERT INTO events (id, name, created_at) VALUES (1, 'League', '2026-01-01 00:00:00')")
        )
        connection.execute(text("INSERT INTO sessions (id, event_id, label) VALUES (1, 1, 'Saturday')"))
        connection.commit()
    raw_engine.dispose()

    engine = make_engine(db_path)
    assert ensure_schema_current(engine, db_path) == MigrationOutcome.UPGRADED
    with engine.connect() as connection:
        row = connection.execute(
            text("SELECT qualification_finalized_at, qualification_drops FROM sessions WHERE id = 1")
        ).one()
    assert tuple(row) == (None, None)
```

Append to `server/tests/test_sessions.py`:

```python
def test_session_read_reports_qualification_open(client):
    client.post("/api/event", json={"name": "League"})
    created = client.post("/api/sessions", json={"label": "Saturday"}).json()
    assert created["qualification_finalized_at"] is None
    assert created["qualification_drops"] is None
```

- [ ] **Step 2: Run to verify failure.** `.venv/bin/pytest tests/test_migrations.py tests/test_sessions.py -q -k "finalize or qualification"`. Expected: FAIL. The migration test fails on its unknown column, and the sessions test fails with a KeyError.

- [ ] **Step 3: Implement.**

Model, in `models/session.py`. Add the imports `from sqlalchemy import JSON` and `from tournament_server.db import Base, UTCDateTime`, then add the columns:

```python
    # Set when an admin finalizes qualification; NULL while it is open.
    qualification_finalized_at: Mapped[dt.datetime | None] = mapped_column(
        UTCDateTime, default=None
    )
    # Played count (as a string key) -> matches each such team drops, e.g.
    # {"7": 1, "8": 2}; {} for a finalized head-to-head session.
    qualification_drops: Mapped[dict[str, int] | None] = mapped_column(JSON, default=None)
```

Migration file `d8e4b2a6c9f3_add_session_qualification_finalize.py`:

```python
"""add session qualification finalize columns

Revision ID: d8e4b2a6c9f3
Revises: c5f2a9e4b7d1
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import tournament_server.db

revision: str = 'd8e4b2a6c9f3'
down_revision: Union[str, None] = 'c5f2a9e4b7d1'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('sessions', sa.Column('qualification_finalized_at', tournament_server.db.UTCDateTime(), nullable=True))
    op.add_column('sessions', sa.Column('qualification_drops', sa.JSON(), nullable=True))


def downgrade() -> None:
    op.drop_column('sessions', 'qualification_drops')
    op.drop_column('sessions', 'qualification_finalized_at')
```

Schema, in `schemas/session.py`'s `SessionRead` after `timezone`:

```python
    # When qualification was finalized, and each played count's drops; both
    # null while qualification is open.
    qualification_finalized_at: dt.datetime | None = None
    qualification_drops: dict[str, int] | None = None
```

- [ ] **Step 4: Run to verify the tests pass.** `.venv/bin/pytest tests/test_migrations.py tests/test_sessions.py tests/test_alembic_drift.py -q`. Expected: all pass, and the drift test confirms the model matches the migrations.

- [ ] **Step 5: Commit.**

```bash
git add server/src/tournament_server/models/session.py server/src/tournament_server/_alembic/versions/d8e4b2a6c9f3_add_session_qualification_finalize.py server/src/tournament_server/schemas/session.py server/tests/test_migrations.py server/tests/test_sessions.py
git commit -m "Store whether a session's qualification is finalized

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Preview, finalize, reopen, and rankings that honour them

**Files:**
- Create: `server/src/tournament_server/services/qualification.py`
- Create: `server/src/tournament_server/schemas/qualification.py`
- Create: `server/src/tournament_server/routers/qualification.py`
- Modify: `server/src/tournament_server/app.py` (register the router next to the other `include_router` calls)
- Modify: `server/src/tournament_server/services/ranking.py`
- Modify: `server/tests/ranking_helpers.py` (add `finalize_qualification`)
- Test: `server/tests/test_qualification_finalize.py`

**Interfaces:**
- Consumes: Task 1's `session_drops(..., finalized_drops)` and `suggest_finalize_drops`, and Task 2's columns.
- Produces:
  - `GET /api/sessions/{id}/qualification/finalize-preview` → `QualificationPreviewRead`
  - `POST .../finalize` with `{"drops": {str: int}}` → `SessionRead`
  - `POST .../reopen` → `SessionRead`
  - WebSocket event `qualification_status_changed` `{session_id, finalized}`
  - `services.qualification.qualification_matches(db, session_id) -> list[Match]`
  - `services.qualification.is_finalized(session) -> bool`
  - Constants `NOT_PLAYED = "not_played"`, `FINALIZED_SCHEDULE_DETAIL`, `NOT_PLAYED_SCORE_DETAIL`, `NOT_PLAYED_START_DETAIL` and `FINALS_NEED_FINALIZE_DETAIL`, used by Task 4
  - Test helper `ranking_helpers.finalize_qualification(client, session_id) -> dict`

- [ ] **Step 1: Write the failing tests.** Create `server/tests/test_qualification_finalize.py`:

```python
import pytest

from ranking_helpers import DEFAULT_SETTINGS, finalize_qualification


def _event(client, plugin="cooperative-game", team_count=4) -> list[int]:
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": plugin})
    return [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, team_count + 1)
    ]


def _session(client, label="Saturday") -> int:
    return client.post("/api/sessions", json={"label": label}).json()["id"]


def _match(client, session_id, number, red, blue, round_type="qualification", division_id=None) -> dict:
    body = {
        "session_id": session_id,
        "round_type": round_type,
        "match_number": number,
        "field_id": None,
        "alliances": [{"station": "red", "team_ids": [red]}, {"station": "blue", "team_ids": [blue]}],
    }
    if division_id is not None:
        body["division_id"] = division_id
    response = client.post("/api/matches", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _alliance(match, station):
    return next(a["id"] for a in match["alliances"] if a["station"] == station)


def _score(client, match, objects, station="red", **flags):
    response = client.post(
        f"/api/matches/{match['id']}/alliances/{_alliance(match, station)}/score",
        json={"data": {"objects_scored": objects}, **flags},
    )
    assert response.status_code == 200, response.text


def _preview(client, session_id):
    response = client.get(f"/api/sessions/{session_id}/qualification/finalize-preview")
    assert response.status_code == 200, response.text
    return response.json()


def _finalize(client, session_id, drops):
    return client.post(f"/api/sessions/{session_id}/qualification/finalize", json={"drops": drops})


def _rows(client, **params):
    return {row["team_id"]: row for row in client.get("/api/rankings", params=params).json()}


def _uneven_session(client):
    """Teams 1+2 are scheduled 10 matches and play 8; teams 3+4 play 7 of 10."""
    t1, t2, t3, t4 = _event(client)
    s1 = _session(client)
    first = [_match(client, s1, n, t1, t2) for n in range(1, 11)]
    second = [_match(client, s1, n, t3, t4) for n in range(11, 21)]
    for match, objects in zip(first[:8], range(1, 9)):  # scores 2, 4, ..., 16
        _score(client, match, objects)
    for match, objects in zip(second[:7], range(1, 8)):  # scores 2, 4, ..., 14
        _score(client, match, objects)
    return s1, (t1, t2, t3, t4), first, second


def test_preview_lists_each_played_count_with_team_counts_and_suggestions(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    preview = _preview(client, s1)
    assert preview["finalized"] is False
    assert preview["game_model"] == "cooperative_score"
    assert preview["rows"] == [
        {"played": 7, "teams": 2, "suggested": 1},
        {"played": 8, "teams": 2, "suggested": 2},
    ]
    assert preview["unplayed_matches"] == 5
    assert preview["blockers"] == []


def test_preview_counts_teams_across_divisions_in_one_row(cooperative_client):
    client = cooperative_client
    t1, t2, t3, t4 = _event(client)
    d1 = client.get("/api/divisions").json()[0]["id"]
    d2 = client.post("/api/divisions", json={"name": "Second"}).json()["id"]
    s1 = _session(client)
    _score(client, _match(client, s1, 1, t1, t2, division_id=d1), 5)
    _score(client, _match(client, s1, 2, t3, t4, division_id=d2), 5)
    assert _preview(client, s1)["rows"] == [{"played": 1, "teams": 4, "suggested": 0}]


def test_finalize_marks_unplayed_matches_and_applies_entered_drops(cooperative_client):
    client = cooperative_client
    s1, (t1, _, t3, _), first, second = _uneven_session(client)
    before = _rows(client, session_id=s1)
    assert before[t1]["average_score"] == 9.0  # 2..16, nothing earned yet

    response = _finalize(client, s1, {"7": 0, "8": 2})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["qualification_finalized_at"] is not None
    assert body["qualification_drops"] == {"7": 0, "8": 2}

    statuses = {m["id"]: m["status"] for m in client.get("/api/matches", params={"session_id": s1}).json()}
    assert [statuses[m["id"]] for m in first[8:]] == ["not_played", "not_played"]
    assert [statuses[m["id"]] for m in second[7:]] == ["not_played"] * 3
    after = _rows(client, session_id=s1)
    assert after[t1]["average_score"] == 11.0  # drops 2 and 4: (6+...+16)/6
    assert after[t1]["matches_played"] == 8
    assert after[t3]["average_score"] == 8.0  # 0 drops: (2+...+14)/7


def test_season_uses_finalized_session_drops(cooperative_client):
    client = cooperative_client
    s1, (t1, _, _, _), _, _ = _uneven_session(client)
    client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, "season_only_session_counted": True})
    assert _finalize(client, s1, {"7": 0, "8": 2}).status_code == 200
    assert _rows(client, event_wide="true")[t1]["average_score"] == 11.0


def test_finalize_twice_is_refused(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    again = _finalize(client, s1, {"7": 1, "8": 2})
    assert again.status_code == 409
    assert "already finalized" in again.json()["detail"]


@pytest.mark.parametrize(
    "drops",
    [
        {"8": 2},  # missing 7
        {"7": 1, "8": 2, "9": 1},  # extra key
        {"7": 7, "8": 2},  # above played - 1
        {"7": -1, "8": 2},
        {"7": "1", "8": 2},
    ],
)
def test_finalize_validates_the_drops_map(cooperative_client, drops):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    assert _finalize(client, s1, drops).status_code == 422
    assert _preview(client, s1)["finalized"] is False


def test_finalize_rejects_boolean_drop_values(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": True, "8": 2}).status_code == 422


def test_blockers_refuse_finalize(cooperative_client):
    client = cooperative_client
    s1, _, first, _ = _uneven_session(client)
    assert client.post(f"/api/matches/{first[8]['id']}/start").status_code == 200
    preview = _preview(client, s1)
    assert preview["blockers"] == [{"code": "in_progress", "count": 1}]
    refused = _finalize(client, s1, {"7": 1, "8": 2})
    assert refused.status_code == 409
    assert "in progress" in refused.json()["detail"]

    assert client.post(f"/api/matches/{first[8]['id']}/end").status_code == 200
    assert _preview(client, s1)["blockers"] == [{"code": "ended_unscored", "count": 1}]


def test_partially_scored_head_to_head_match_blocks(client):
    t1, t2 = _event(client, plugin="example-game", team_count=2)
    s1 = _session(client)
    match = _match(client, s1, 1, t1, t2)
    response = client.post(
        f"/api/matches/{match['id']}/alliances/{_alliance(match, 'red')}/score",
        json={"data": {"high_balls": 3, "low_balls": 0, "auto_winner": "tie"}},
    )
    assert response.status_code == 200, response.text
    assert _preview(client, s1)["blockers"] == [{"code": "partially_scored", "count": 1}]


def test_no_matches_blocks(cooperative_client):
    client = cooperative_client
    _event(client)
    s1 = _session(client)
    assert _preview(client, s1)["blockers"] == [{"code": "no_matches", "count": 0}]
    assert _finalize(client, s1, {}).status_code == 409


def test_head_to_head_finalize_takes_no_drops(client):
    t1, t2 = _event(client, plugin="example-game", team_count=2)
    s1 = _session(client)
    played = _match(client, s1, 1, t1, t2)
    for station in ("red", "blue"):
        client.post(
            f"/api/matches/{played['id']}/alliances/{_alliance(played, station)}/score",
            json={"data": {"high_balls": 3, "low_balls": 0, "auto_winner": "tie"}},
        )
    _match(client, s1, 2, t1, t2)
    preview = _preview(client, s1)
    assert preview["game_model"] == "head_to_head"
    assert preview["rows"] == []
    assert _finalize(client, s1, {"1": 0}).status_code == 422
    response = _finalize(client, s1, {})
    assert response.status_code == 200, response.text
    assert response.json()["qualification_drops"] == {}


def test_finalize_with_nothing_played(cooperative_client):
    client = cooperative_client
    t1, t2, _, _ = _event(client)
    s1 = _session(client)
    _match(client, s1, 1, t1, t2)
    preview = _preview(client, s1)
    assert preview["rows"] == []
    assert preview["unplayed_matches"] == 1
    assert _finalize(client, s1, {}).status_code == 200
    assert _rows(client, session_id=s1) == {}


def test_missing_played_count_in_map_drops_nothing(cooperative_client):
    from tournament_server.models.session import TournamentSession

    client = cooperative_client
    s1, (t1, _, _, _), _, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    with client.app.state.session_factory() as db:
        db.get(TournamentSession, s1).qualification_drops = {"7": 1}
        db.commit()
    client.put("/api/ranking-settings", json=DEFAULT_SETTINGS)  # recomputes every scope
    assert _rows(client, session_id=s1)[t1]["average_score"] == 9.0


def test_reopen_restores_matches_and_rankings(cooperative_client):
    client = cooperative_client
    s1, (t1, _, _, _), first, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    response = client.post(f"/api/sessions/{s1}/qualification/reopen")
    assert response.status_code == 200, response.text
    assert response.json()["qualification_finalized_at"] is None
    assert response.json()["qualification_drops"] is None
    statuses = {m["id"]: m["status"] for m in client.get("/api/matches", params={"session_id": s1}).json()}
    assert statuses[first[9]["id"]] == "scheduled"
    assert _rows(client, session_id=s1)[t1]["average_score"] == 9.0


def test_reopen_refused_when_not_finalized_or_finals_exist(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    assert client.post(f"/api/sessions/{s1}/qualification/reopen").status_code == 409
    client.post("/api/fields", json={"session_id": s1, "name": "Field 1"})
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    started = client.post("/api/finals/start", json={"session_id": s1, "bracket_size": 2})
    assert started.status_code in (200, 201), started.text
    refused = client.post(f"/api/sessions/{s1}/qualification/reopen")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Delete this session's finals brackets before reopening qualification"


def test_reopen_then_score_then_finalize_again(cooperative_client):
    client = cooperative_client
    s1, (t1, _, _, _), first, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    client.post(f"/api/sessions/{s1}/qualification/reopen")
    _score(client, first[8], 9)  # team 1 now has 9 played
    assert [row["played"] for row in _preview(client, s1)["rows"]] == [7, 9]
    assert _finalize(client, s1, {"7": 1, "9": 2}).status_code == 200
    assert _rows(client, session_id=s1)[t1]["matches_played"] == 9


def test_correcting_a_score_after_finalize_recomputes(cooperative_client):
    client = cooperative_client
    s1, (t1, _, _, _), first, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 0, "8": 0}).status_code == 200
    _score(client, first[0], 18)  # 2 -> 36
    assert _rows(client, session_id=s1)[t1]["average_score"] == 13.25  # (36+4+...+16)/8


def test_finalize_and_reopen_broadcast_status(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    token = client.headers["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect(f"/ws/session/{s1}?token={token}") as socket:
        assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
        events = []
        while not any(e["event"] == "qualification_status_changed" for e in events):
            events.append(socket.receive_json())
        changed = next(e for e in events if e["event"] == "qualification_status_changed")
        assert changed["data"] == {"session_id": s1, "finalized": True}


def test_finalize_needs_admin(cooperative_client):
    from fastapi.testclient import TestClient
    from auth_helpers import bearer, login_as

    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    raw = TestClient(client.app)
    scorer = bearer(login_as(raw, "scorer"))
    assert raw.post(
        f"/api/sessions/{s1}/qualification/finalize", json={"drops": {}}, headers=scorer
    ).status_code == 403
```

Before relying on them, check the helper signatures this test file assumes:
- `client.app.state.session_factory`
- `auth_helpers.login_as` / `bearer` (including the password `login_as` needs)
- the `cooperative_client` fixture's game-plugin selection
- the example-game scoresheet keys

Do this by reading `server/tests/conftest.py`, `server/tests/auth_helpers.py` and an existing test that opens a WebSocket (`tests/test_broadcast_wiring.py`). Adapt only those mechanics, never the asserted values. If `cooperative_client` already selects the plugin, the second `POST /api/event/game-plugin` in `_event` is harmless (it 409s), so leave it.

In `server/tests/ranking_helpers.py`, add:

```python
def finalize_qualification(client, session_id: int) -> dict:
    """Finalize a session's qualification with the suggested drops (tests that start finals need this)."""
    preview = client.get(f"/api/sessions/{session_id}/qualification/finalize-preview").json()
    drops = {str(row["played"]): row["suggested"] for row in preview["rows"]}
    response = client.post(f"/api/sessions/{session_id}/qualification/finalize", json={"drops": drops})
    assert response.status_code == 200, response.text
    return response.json()
```

- [ ] **Step 2: Run to verify failure.** `.venv/bin/pytest tests/test_qualification_finalize.py -q`. Expected: 404s or import errors.

- [ ] **Step 3: Implement the service.** Create `server/src/tournament_server/services/qualification.py`:

```python
"""Finalizing a session's qualification: the preview, finalize and reopen.

Finalizing marks every unplayed qualification match `not_played` and stores
the admin's drops per played count on the session; services/ranking.py
reads them back. Reopening undoes both.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.db import utc_now
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession

NOT_PLAYED = "not_played"
FINALIZED_SCHEDULE_DETAIL = "Qualification is finalized; reopen it to change the schedule."
NOT_PLAYED_SCORE_DETAIL = "This match was not played; reopen qualification to score it."
NOT_PLAYED_START_DETAIL = "This match was not played; reopen qualification to run it."
FINALS_NEED_FINALIZE_DETAIL = "Finalize this session's qualification before generating finals."
FINALS_EXIST_DETAIL = "Delete this session's finals brackets before reopening qualification"

_IDLE_PHASES = ("not_started", "ended")


def is_finalized(session_obj: TournamentSession) -> bool:
    return session_obj.qualification_finalized_at is not None


def qualification_matches(db: Session, session_id: int) -> list[Match]:
    """The session's qualification matches in every division, any status. Practice and finals excluded."""
    return list(
        db.execute(
            select(Match)
            .where(
                Match.session_id == session_id,
                Match.finals_bracket_id.is_(None),
                Match.round_type != "practice",
            )
            .order_by(Match.id)
        ).scalars().all()
    )


def _scored_match_ids(db: Session, match_ids: list[int]) -> set[int]:
    if not match_ids:
        return set()
    return set(
        db.execute(
            select(Alliance.match_id)
            .join(ScoreRecord, ScoreRecord.alliance_id == Alliance.id)
            .where(Alliance.match_id.in_(match_ids))
            .distinct()
        ).scalars().all()
    )


def played_counts(db: Session, matches: list[Match]) -> dict[int, int]:
    """team_id -> scored alliance entries in completed matches. This is the same count
    ranking's `matches_played` uses (one per alliance the team was on)."""
    completed = [m.id for m in matches if m.status == "completed"]
    if not completed:
        return {}
    rows = db.execute(
        select(AllianceTeam.team_id, Alliance.id)
        .join(Alliance, AllianceTeam.alliance_id == Alliance.id)
        .join(ScoreRecord, ScoreRecord.alliance_id == Alliance.id)
        .where(Alliance.match_id.in_(completed))
        .distinct()
    ).all()
    return dict(Counter(team_id for team_id, _ in rows))


@dataclass
class FinalizeState:
    played: dict[int, int]  # team_id -> played count
    blockers: list[dict] = field(default_factory=list)  # [{"code", "count"}]
    unplayed: list[Match] = field(default_factory=list)


def finalize_state(db: Session, session_id: int) -> FinalizeState:
    matches = qualification_matches(db, session_id)
    open_matches = [m for m in matches if m.status not in ("completed", NOT_PLAYED)]
    scored = _scored_match_ids(db, [m.id for m in open_matches])
    in_progress = [m for m in open_matches if m.phase not in _IDLE_PHASES]
    ended = [m for m in open_matches if m.phase == "ended" and m.id not in scored]
    partial = [m for m in open_matches if m.id in scored]
    blockers: list[dict] = []
    if not matches:
        blockers.append({"code": "no_matches", "count": 0})
    for code, blocked in (("in_progress", in_progress), ("ended_unscored", ended), ("partially_scored", partial)):
        if blocked:
            blockers.append({"code": code, "count": len(blocked)})
    blocked_ids = {m.id for m in (*in_progress, *ended, *partial)}
    unplayed = [m for m in open_matches if m.id not in blocked_ids]
    return FinalizeState(played_counts(db, matches), blockers, unplayed)


def preview_rows(state: FinalizeState, cooperative: bool, suggest) -> list[dict]:
    """One row per distinct played count, ascending. `suggest(played) -> int`."""
    if not cooperative:
        return []
    teams = Counter(state.played.values())
    return [
        {"played": played, "teams": teams[played], "suggested": suggest(played)}
        for played in sorted(teams)
    ]


def blocker_detail(blockers: list[dict]) -> str:
    phrases = {
        "no_matches": lambda n: "the session has no qualification matches",
        "in_progress": lambda n: f"{n} match{'es' if n != 1 else ''} in progress",
        "ended_unscored": lambda n: f"{n} match{'es' if n != 1 else ''} ended without a score",
        "partially_scored": lambda n: f"{n} match{'es' if n != 1 else ''} only partly scored",
    }
    return "Qualification can't be finalized yet: " + ", ".join(
        phrases[b["code"]](b["count"]) for b in blockers
    )


def finalize(db: Session, session_obj: TournamentSession, state: FinalizeState, drops: dict[str, int]) -> None:
    for match in state.unplayed:
        match.status = NOT_PLAYED
    session_obj.qualification_finalized_at = utc_now()
    session_obj.qualification_drops = dict(drops)
    db.commit()


def reopen(db: Session, session_obj: TournamentSession) -> None:
    for match in qualification_matches(db, session_obj.id):
        if match.status == NOT_PLAYED:
            match.status = "scheduled"
    session_obj.qualification_finalized_at = None
    session_obj.qualification_drops = None
    db.commit()
```

Check that `utc_now` is exported by `tournament_server.db` (it is imported from there in `models/auth_session.py`).

- [ ] **Step 4: Implement the schemas.** Create `server/src/tournament_server/schemas/qualification.py`:

```python
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, StrictInt


class QualificationRow(BaseModel):
    played: int
    teams: int
    suggested: int


class QualificationBlocker(BaseModel):
    code: Literal["no_matches", "in_progress", "ended_unscored", "partially_scored"]
    count: int


class QualificationPreviewRead(BaseModel):
    finalized: bool
    game_model: str
    rows: list[QualificationRow]
    unplayed_matches: int
    blockers: list[QualificationBlocker]


class FinalizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Played count (string key) -> drops; {} for head-to-head.
    drops: dict[str, StrictInt]
```

- [ ] **Step 5: Implement the router.** Create `server/src/tournament_server/routers/qualification.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.session import TournamentSession
from tournament_server.realtime import broadcast_for_session
from tournament_server.routers.sessions import _to_read
from tournament_server.schemas.qualification import FinalizeRequest, QualificationPreviewRead
from tournament_server.schemas.session import SessionRead
from tournament_server.services import qualification
from tournament_server.services.deletion import session_has_scores
from tournament_server.services.ranking import recompute_all_rankings
from tournament_server.services.ranking_rules import suggest_finalize_drops
from tournament_server.services.ranking_settings import load_rules
from tournament_server.services.plugins import get_game_plugin_for_event

router = APIRouter(prefix="/api/sessions/{session_id}/qualification", tags=["qualification"])


def _session_or_404(db: Session, session_id: int) -> TournamentSession:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_obj


def _is_cooperative(plugin) -> bool:
    return plugin.module.match_format()["game_model"] == "cooperative_score"


def _after_change(request: Request, db: Session, session_obj: TournamentSession, plugin) -> SessionRead:
    event = get_the_event(db)
    recompute_all_rankings(request.app, db, plugin, event.id)
    finalized = qualification.is_finalized(session_obj)
    broadcast_for_session(
        request.app, db, session_obj.id, "qualification_status_changed",
        {"session_id": session_obj.id, "finalized": finalized},
    )
    db.refresh(session_obj)
    return _to_read(session_obj, session_has_scores(db, session_obj.id))


@router.get("/finalize-preview", response_model=QualificationPreviewRead)
def finalize_preview(
    session_id: int, request: Request, db: Session = Depends(get_db), _role: str = Depends(require_admin)
) -> QualificationPreviewRead:
    session_obj = _session_or_404(db, session_id)
    plugin = get_game_plugin_for_event(request, db)
    rules = load_rules(db)
    state = qualification.finalize_state(db, session_id)
    finalized = qualification.is_finalized(session_obj)
    return QualificationPreviewRead(
        finalized=finalized,
        game_model=plugin.module.match_format()["game_model"],
        rows=qualification.preview_rows(
            state, _is_cooperative(plugin), lambda played: suggest_finalize_drops(played, rules)
        ),
        unplayed_matches=0 if finalized else len(state.unplayed),
        blockers=[] if finalized else state.blockers,
    )


@router.post("/finalize", response_model=SessionRead)
def finalize(
    session_id: int,
    payload: FinalizeRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionRead:
    session_obj = _session_or_404(db, session_id)
    plugin = get_game_plugin_for_event(request, db)
    if qualification.is_finalized(session_obj):
        raise HTTPException(status_code=409, detail="Qualification is already finalized for this session")
    state = qualification.finalize_state(db, session_id)
    if state.blockers:
        raise HTTPException(status_code=409, detail=qualification.blocker_detail(state.blockers))
    expected = {str(p) for p in state.played.values()} if _is_cooperative(plugin) else set()
    if set(payload.drops) != expected:
        raise HTTPException(
            status_code=422,
            detail=f"Drops must be given for exactly these played counts: {sorted(expected, key=int)}",
        )
    for played, drops in payload.drops.items():
        if not 0 <= drops <= int(played) - 1:
            raise HTTPException(
                status_code=422,
                detail=f"Teams that played {played} can drop between 0 and {int(played) - 1} matches",
            )
    qualification.finalize(db, session_obj, state, payload.drops)
    return _after_change(request, db, session_obj, plugin)


@router.post("/reopen", response_model=SessionRead)
def reopen(
    session_id: int, request: Request, db: Session = Depends(get_db), _role: str = Depends(require_admin)
) -> SessionRead:
    session_obj = _session_or_404(db, session_id)
    plugin = get_game_plugin_for_event(request, db)
    if not qualification.is_finalized(session_obj):
        raise HTTPException(status_code=409, detail="Qualification is not finalized for this session")
    has_finals = db.execute(
        select(FinalsBracket.id).where(FinalsBracket.session_id == session_id)
    ).first()
    if has_finals is not None:
        raise HTTPException(status_code=409, detail=qualification.FINALS_EXIST_DETAIL)
    qualification.reopen(db, session_obj)
    return _after_change(request, db, session_obj, plugin)
```

Before writing these imports, confirm where each one lives and adjust only the import paths:
- `get_game_plugin_for_event` (`grep -rn "def get_game_plugin_for_event" server/src`);
- the `FinalsBracket` model module;
- `session_has_scores` in `services/deletion.py`.

`_to_read` is the sessions router's helper. Import it as shown. Register the router in `app.py` beside `sessions.router`.

- [ ] **Step 6: Make rankings honour finalized drops.** In `services/ranking.py`:

```python
def _finalized_drops(db: Session, matches: list[Match]) -> dict[int, dict[str, int] | None]:
    """session_id -> its finalize drops map, or None while that session's qualification is open."""
    session_ids = sorted({match.session_id for match in matches})
    if not session_ids:
        return {}
    return {
        row.id: row.qualification_drops
        for row in db.execute(
            select(TournamentSession).where(TournamentSession.id.in_(session_ids))
        ).scalars()
    }


def _drops_for(finalized: dict[int, dict[str, int] | None], session_id: int, played: int) -> int | None:
    drops = finalized.get(session_id)
    if drops is None:
        return None
    return drops.get(str(played), 0)
```

- In `_scheduled_counts`, skip matches whose `status == "not_played"`, so a finalized session's scheduled count equals what was played.
- Give `_cooperative_session_stats` and `_cooperative_season_stats` a `finalized` parameter. Pass `_drops_for(finalized, session_id, len(session_records))` as `session_drops`' fourth argument. In the session stats, `session_id` is `records[0].session_id`, and the records list is per session.
- In `_stats`, compute `finalized = _finalized_drops(db, matches)` inside the cooperative branch and pass it to both.

- [ ] **Step 7: Run to verify the tests pass.** `.venv/bin/pytest tests/test_qualification_finalize.py tests/test_season_rankings.py tests/test_ranking_rules.py -q`. Expected: all pass.

- [ ] **Step 8: Commit.**

```bash
git add server/src/tournament_server/services/qualification.py server/src/tournament_server/schemas/qualification.py server/src/tournament_server/routers/qualification.py server/src/tournament_server/app.py server/src/tournament_server/services/ranking.py server/tests/ranking_helpers.py server/tests/test_qualification_finalize.py
git commit -m "Finalize and reopen a session's qualification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Guards — finals, scores, schedule, match creation, match start

**Files:**
- Modify:
  - `server/src/tournament_server/routers/finals.py` (`start_finals`)
  - `routers/scores.py` (`submit_score`)
  - `routers/schedule.py` (`generate_schedule`, `clear_schedule`)
  - `routers/matches.py` (`create_match`, `start_match`)
- Modify (existing tests that start finals): `server/tests/test_finals.py`, `test_broadcast_wiring.py`, `test_session_delete.py`, `test_sample_cooperative_plugin.py`, `test_season_rankings.py`
- Test: `server/tests/test_qualification_guards.py`
- Docs: `server/CLAUDE.md`

**Interfaces:**
- Consumes: Task 3's `qualification.is_finalized`, `NOT_PLAYED`, the `*_DETAIL` constants and `ranking_helpers.finalize_qualification`.

- [ ] **Step 1: Write the failing tests.** Create `server/tests/test_qualification_guards.py`:

```python
from ranking_helpers import finalize_qualification


def _setup(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    t1 = client.post("/api/teams", json={"number": "1", "name": "One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Two"}).json()["id"]
    s1 = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    client.post("/api/fields", json={"session_id": s1, "name": "Field 1"})

    def match(number, round_type="qualification"):
        response = client.post("/api/matches", json={
            "session_id": s1, "round_type": round_type, "match_number": number, "field_id": None,
            "alliances": [{"station": "red", "team_ids": [t1]}, {"station": "blue", "team_ids": [t2]}],
        })
        assert response.status_code == 201, response.text
        return response.json()

    played, unplayed = match(1), match(2)
    red = next(a["id"] for a in played["alliances"] if a["station"] == "red")
    assert client.post(
        f"/api/matches/{played['id']}/alliances/{red}/score", json={"data": {"objects_scored": 5}}
    ).status_code == 200
    return s1, match, played, unplayed


def test_finals_require_finalized_qualification(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _setup(client)
    refused = client.post("/api/finals/start", json={"session_id": s1, "bracket_size": 2})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Finalize this session's qualification before generating finals."
    finalize_qualification(client, s1)
    started = client.post("/api/finals/start", json={"session_id": s1, "bracket_size": 2})
    assert started.status_code in (200, 201), started.text


def test_not_played_match_cannot_be_scored_or_started(cooperative_client):
    client = cooperative_client
    s1, _, _, unplayed = _setup(client)
    finalize_qualification(client, s1)
    red = next(a["id"] for a in unplayed["alliances"] if a["station"] == "red")
    scored = client.post(
        f"/api/matches/{unplayed['id']}/alliances/{red}/score", json={"data": {"objects_scored": 5}}
    )
    assert scored.status_code == 409
    assert scored.json()["detail"] == "This match was not played; reopen qualification to score it."
    started = client.post(f"/api/matches/{unplayed['id']}/start")
    assert started.status_code == 409
    assert started.json()["detail"] == "This match was not played; reopen qualification to run it."


def test_completed_match_can_be_corrected_after_finalize(cooperative_client):
    client = cooperative_client
    s1, _, played, _ = _setup(client)
    finalize_qualification(client, s1)
    red = next(a["id"] for a in played["alliances"] if a["station"] == "red")
    assert client.post(
        f"/api/matches/{played['id']}/alliances/{red}/score", json={"data": {"objects_scored": 9}}
    ).status_code == 200


def test_qualification_schedule_changes_refused_after_finalize(cooperative_client):
    client = cooperative_client
    s1, match, _, _ = _setup(client)
    finalize_qualification(client, s1)
    detail = "Qualification is finalized; reopen it to change the schedule."

    created = client.post("/api/matches", json={
        "session_id": s1, "round_type": "qualification", "match_number": 3, "field_id": None,
        "alliances": [{"station": "red", "team_ids": []}, {"station": "blue", "team_ids": []}],
    })
    assert created.status_code == 409 and created.json()["detail"] == detail
    assert match(4, round_type="practice")["round_type"] == "practice"

    cleared = client.delete("/api/schedule", params={"session_id": s1, "round_type": "qualification"})
    assert cleared.status_code == 409 and cleared.json()["detail"] == detail

    generated = client.post("/api/schedule", json={
        "session_id": s1, "scheduler_name": "simple_random", "dry_run": True,
        "rounds": [{"round_type": "qualification", "target_matches_per_team": 1, "cycle_time_seconds": 300}],
    })
    assert generated.status_code == 409 and generated.json()["detail"] == detail
```

Check `ScheduleGenerateRequest` (`server/src/tournament_server/schemas/schedule.py`) for its exact required keys, and fix the request body in the last test if a key name differs. The finalize guard must run before any other validation, so missing playing windows doesn't matter.

- [ ] **Step 2: Run to verify failure.** `.venv/bin/pytest tests/test_qualification_guards.py -q`. Expected: FAIL. Finals start 201s, scoring returns 200, and so on.

- [ ] **Step 3: Implement the guards.** Each uses `from tournament_server.services import qualification`.
- **`routers/finals.py` `start_finals`:** replace the bare existence check with `session_obj = db.get(TournamentSession, payload.session_id)`, then 404 if it is `None`. Immediately before the line `ranking_query = select(Ranking).where(Ranking.session_id == payload.session_id)`, add:
  ```python
  if not qualification.is_finalized(session_obj):
      raise HTTPException(status_code=409, detail=qualification.FINALS_NEED_FINALIZE_DETAIL)
  ```
  This placement keeps the existing request-validation 422s ahead of the gate.
- **`routers/scores.py` `submit_score`:** right after the alliance 404 check:
  ```python
  if match.status == qualification.NOT_PLAYED:
      raise HTTPException(status_code=409, detail=qualification.NOT_PLAYED_SCORE_DETAIL)
  ```
- **`routers/matches.py` `start_match`:** right after the 404, before the phase check:
  ```python
  if match.status == qualification.NOT_PLAYED:
      raise HTTPException(status_code=409, detail=qualification.NOT_PLAYED_START_DETAIL)
  ```
- **`routers/matches.py` `create_match`:** after the session 404 check, load the session object and:
  ```python
  if qualification.is_finalized(session_obj) and payload.round_type != "practice":
      raise HTTPException(status_code=409, detail=qualification.FINALIZED_SCHEDULE_DETAIL)
  ```
- **`routers/schedule.py` `generate_schedule`:** right after `session_obj` is loaded and its 404 raised:
  ```python
  if qualification.is_finalized(session_obj) and any(r.round_type != "practice" for r in payload.rounds):
      raise HTTPException(status_code=409, detail=qualification.FINALIZED_SCHEDULE_DETAIL)
  ```
- **`routers/schedule.py` `clear_schedule`:** keep the session object from the 404 check and:
  ```python
  if qualification.is_finalized(session_obj) and round_type != "practice":
      raise HTTPException(status_code=409, detail=qualification.FINALIZED_SCHEDULE_DETAIL)
  ```

- [ ] **Step 4: Run the whole server suite.** `.venv/bin/pytest -q`. Tests elsewhere that start finals without finalizing now get 409. Fix each failing test as follows:
  - Call `finalize_qualification(client, session_id)` (import it from `ranking_helpers`) immediately before its `POST /api/finals/start`, once per session. Put it in the shared helpers of `test_finals.py` where every caller starts finals right afterwards, otherwise inline.
  - A test that creates or scores more qualification matches *after* starting finals must finalize after those writes instead.
  - A test that starts finals for a session with no qualification matches, and asserts a later error, now asserts the 409 finalize detail. Note it in the commit body.
  - Never weaken an assertion about bracket contents.

  Rerun until the full suite is green.

- [ ] **Step 5: Document.** In `server/CLAUDE.md`:
  - Under "Cooperative scoring", after the paragraph about drops being earned, add a paragraph describing finalize:
    - the endpoints;
    - `not_played`;
    - drops per played count;
    - blockers;
    - reopen only without finals;
    - finals, scores, schedule and match-start guards.
  - In the Event catalog, add `qualification_status_changed` — `{session_id, finalized}` (via `broadcast_for_session`).
  - Under "Finals", add one sentence: `POST /api/finals/start` 409s until the session's qualification is finalized.

- [ ] **Step 6: Commit.**

```bash
git add server/src server/tests server/CLAUDE.md
git commit -m "Refuse finals before finalizing and changes to finalized qualification

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Matches page — qualification bar and finalize dialog

**Files:**
- Modify: `frontend/apps/admin/src/types.ts`
- Create:
  - `frontend/apps/admin/src/qualification/useQualificationPreview.ts`
  - `frontend/apps/admin/src/qualification/finalizeDraft.ts`
  - `frontend/apps/admin/src/qualification/FinalizeDialog.tsx`
  - `frontend/apps/admin/src/qualification/QualificationBar.tsx`
- Modify: `frontend/apps/admin/src/routes/SessionMatchesRoute.tsx`
- Modify: `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Modify: every unit test that builds a `SessionRead` literal (`grep -rln "has_scored_matches" frontend/apps/admin/tests/unit`). Add `qualification_finalized_at: null, qualification_drops: null`.
- Test:
  - `frontend/apps/admin/tests/unit/finalizeDraft.test.ts`
  - `frontend/apps/admin/tests/unit/FinalizeDialog.test.tsx`
  - `frontend/apps/admin/tests/unit/QualificationBar.test.tsx`
  - extend `tests/unit/SessionMatchesRoute.test.tsx`
- Docs: `frontend/CLAUDE.md`

**Interfaces:**
- Consumes: Task 3's preview, finalize and reopen endpoints and the `qualification_status_changed` event.
- Produces: `QualificationBar({ session })`, rendered by `SessionMatchesRoute` above its filter toolbar.

- [ ] **Step 1: Add types.** In `types.ts`, add to `SessionRead`:

```ts
  /** When qualification was finalized; null while it is open. */
  qualification_finalized_at: string | null;
  /** Played count -> drops chosen at finalize; {} for head-to-head; null while open. */
  qualification_drops: Record<string, number> | null;
```

and add:

```ts
export type QualificationBlockerCode = "no_matches" | "in_progress" | "ended_unscored" | "partially_scored";

export interface QualificationPreview {
  finalized: boolean;
  game_model: GameModel;
  rows: { played: number; teams: number; suggested: number }[];
  unplayed_matches: number;
  blockers: { code: QualificationBlockerCode; count: number }[];
}
```

Update every existing `SessionRead` literal in the unit tests with the two null fields.

- [ ] **Step 2: Write the failing pure test.** Create `tests/unit/finalizeDraft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { draftFromRows, validateDraft } from "../../src/qualification/finalizeDraft";

const ROWS = [
  { played: 7, teams: 4, suggested: 1 },
  { played: 8, teams: 12, suggested: 2 },
];

describe("finalizeDraft", () => {
  it("starts from the suggestions", () => {
    expect(draftFromRows(ROWS)).toEqual({ "7": "1", "8": "2" });
  });

  it("turns a valid draft into the drops body", () => {
    expect(validateDraft(ROWS, { "7": "0", "8": "3" })).toEqual({ drops: { "7": 0, "8": 3 }, errors: {} });
  });

  it("flags blank, fractional, negative and too-large values", () => {
    const result = validateDraft(ROWS, { "7": "", "8": "8" });
    expect(result.drops).toBeNull();
    expect(result.errors).toEqual({ "7": { max: 6 }, "8": { max: 7 } });
    expect(validateDraft(ROWS, { "7": "1.5", "8": "2" }).errors).toEqual({ "7": { max: 6 } });
    expect(validateDraft(ROWS, { "7": "-1", "8": "2" }).errors).toEqual({ "7": { max: 6 } });
  });

  it("accepts an empty row list (head-to-head)", () => {
    expect(validateDraft([], {})).toEqual({ drops: {}, errors: {} });
  });
});
```

- [ ] **Step 3: Run to verify failure, then implement** `src/qualification/finalizeDraft.ts`:

```ts
import type { QualificationPreview } from "../types";

type Row = QualificationPreview["rows"][number];
export type FinalizeDraft = Record<string, string>;
export type DraftErrors = Record<string, { max: number }>;

export function draftFromRows(rows: Row[]): FinalizeDraft {
  return Object.fromEntries(rows.map((row) => [String(row.played), String(row.suggested)]));
}

/** Each row must be a whole number from 0 to played - 1. `drops` is null while any row is invalid. */
export function validateDraft(
  rows: Row[],
  draft: FinalizeDraft
): { drops: Record<string, number> | null; errors: DraftErrors } {
  const drops: Record<string, number> = {};
  const errors: DraftErrors = {};
  for (const row of rows) {
    const key = String(row.played);
    const text = (draft[key] ?? "").trim();
    const value = Number(text);
    const max = row.played - 1;
    if (text === "" || !Number.isInteger(value) || value < 0 || value > max) {
      errors[key] = { max };
    } else {
      drops[key] = value;
    }
  }
  return { drops: Object.keys(errors).length ? null : drops, errors };
}
```

Run `npm test --workspace apps/admin -- --run finalizeDraft`. Expected: pass.

- [ ] **Step 4: Add the i18n strings.** In `en/admin.json`, add under `sessions.matches.status`: `"not_played": "Not played"`. Add `sessions.qualification`:

```json
"qualification": {
  "finalize": "Finalize qualification",
  "finalizedOn": "Qualification finalized on {{date}}. Finals can now be generated.",
  "reopen": "Reopen qualification",
  "reopenHeading": "Reopen qualification?",
  "reopenBody": "Matches marked Not played return to the schedule and the chosen drops are cleared.",
  "blocker": {
    "no_matches": "This session has no qualification matches.",
    "in_progress_one": "{{count}} match is in progress.",
    "in_progress_other": "{{count}} matches are in progress.",
    "ended_unscored_one": "{{count}} match has ended but has no score.",
    "ended_unscored_other": "{{count}} matches have ended but have no score.",
    "partially_scored_one": "{{count}} match is only partly scored.",
    "partially_scored_other": "{{count}} matches are only partly scored."
  },
  "dialogHeading": "Finalize qualification",
  "dialogIntro": "No more qualification matches will be played. Choose how many of each team's lowest matches to drop.",
  "dialogIntroHeadToHead": "No more qualification matches will be played. Rankings will use the matches played so far.",
  "rowLabel_one": "{{played}} played ({{count}} team)",
  "rowLabel_other": "{{played}} played ({{count}} teams)",
  "rowError": "Enter a whole number from 0 to {{max}}.",
  "notPlayed_one": "{{count}} unplayed match will be marked Not played.",
  "notPlayed_other": "{{count}} unplayed matches will be marked Not played.",
  "confirm": "Finalize",
  "cancel": "Cancel"
}
```

In `zh/admin.json`, add the same keys:

```json
"qualification": {
  "finalize": "确认资格赛结果",
  "finalizedOn": "资格赛已于 {{date}} 确认。现在可以生成决赛。",
  "reopen": "重新开放资格赛",
  "reopenHeading": "重新开放资格赛？",
  "reopenBody": "标记为未进行的比赛将回到赛程中，已选择的舍弃场次将被清除。",
  "blocker": {
    "no_matches": "本场次没有资格赛比赛。",
    "in_progress_one": "{{count}} 场比赛正在进行。",
    "in_progress_other": "{{count}} 场比赛正在进行。",
    "ended_unscored_one": "{{count}} 场比赛已结束但没有成绩。",
    "ended_unscored_other": "{{count}} 场比赛已结束但没有成绩。",
    "partially_scored_one": "{{count}} 场比赛只录入了部分成绩。",
    "partially_scored_other": "{{count}} 场比赛只录入了部分成绩。"
  },
  "dialogHeading": "确认资格赛结果",
  "dialogIntro": "不再进行资格赛比赛。请选择每支队伍舍弃多少场最低分比赛。",
  "dialogIntroHeadToHead": "不再进行资格赛比赛。排名将使用目前已进行的比赛。",
  "rowLabel_one": "已赛 {{played}} 场（{{count}} 支队伍）",
  "rowLabel_other": "已赛 {{played}} 场（{{count}} 支队伍）",
  "rowError": "请输入 0 到 {{max}} 之间的整数。",
  "notPlayed_one": "{{count}} 场未进行的比赛将标记为未进行。",
  "notPlayed_other": "{{count}} 场未进行的比赛将标记为未进行。",
  "confirm": "确认",
  "cancel": "取消"
}
```

with `sessions.matches.status.not_played`: `"未进行"`.

- [ ] **Step 5: Write the failing component tests.**
- **`tests/unit/FinalizeDialog.test.tsx`:** follow `tests/unit/RankingSettingsPanel.test.tsx`'s setup (I18nextProvider + QueryClientProvider, `apiRequest` mocked through `vi.mock("@tournament-admin/shared", ...)`). Cover:
  1. A cooperative preview renders one labelled spinbutton per row, "7 played (4 teams)" with value 1 and "8 played (12 teams)" with value 2, plus "5 unplayed matches will be marked Not played."
  2. Typing 7 into the "7 played" input shows "Enter a whole number from 0 to 6." in an element with `aria-live="polite"`, and the Finalize button is disabled.
  3. Finalize calls `apiRequest("/api/sessions/1/qualification/finalize", { method: "POST", body: { drops: { "7": 1, "8": 2 } } })` and then calls `onDone`.
  4. A head-to-head preview renders no spinbuttons and shows the head-to-head intro. Finalize sends `{ drops: {} }`.
  5. When `apiRequest` rejects with `new ApiError(409, "Qualification can't be finalized yet: 1 match in progress")`, that text appears in the dialog and it stays open.
- **`tests/unit/QualificationBar.test.tsx`:**
  1. Open, no blockers: an enabled "Finalize qualification" button.
  2. Blockers `[{code: "in_progress", count: 2}, {code: "ended_unscored", count: 1}]`: the button is disabled, and both sentences are shown and linked by `aria-describedby`.
  3. A finalized session (`qualification_finalized_at: "2026-10-07T18:00:00Z"`) shows text starting "Qualification finalized on" and a "Reopen qualification" button. Confirming calls `apiRequest(".../reopen", { method: "POST" })`.
  4. A rejected reopen shows the server detail inline.
  5. It registers `useRealtimeChannel` with path `/ws/session/1`. Feeding `{event: "qualification_status_changed"}` to its `onEvent` invalidates `["sessions"]`, `["matches", 1]` and `["qualification-preview", 1]`, which you check with a `QueryClient` spy.
- **Extend `tests/unit/SessionMatchesRoute.test.tsx`:** a match with `status: "not_played"` renders "Not played", and the bar's button is present.

Run them. Expected: FAIL because the modules are missing.

- [ ] **Step 6: Implement the preview hook.** `src/qualification/useQualificationPreview.ts`:

```ts
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, useRealtimeChannel, type RealtimeEvent } from "@tournament-admin/shared";
import type { QualificationPreview } from "../types";

export const qualificationPreviewKey = (sessionId: number) => ["qualification-preview", sessionId];

const PREVIEW_EVENTS = new Set([
  "qualification_status_changed",
  "match_phase_changed",
  "match_reset",
  "score_saved",
  "new_match_created",
]);

/** The finalize preview, refreshed whenever a match or the qualification status changes. */
export function useQualificationPreview(sessionId: number) {
  const queryClient = useQueryClient();
  useRealtimeChannel({
    path: `/ws/session/${sessionId}`,
    onEvent: (realtimeEvent: RealtimeEvent) => {
      if (!PREVIEW_EVENTS.has(realtimeEvent.event)) return;
      queryClient.invalidateQueries({ queryKey: qualificationPreviewKey(sessionId) });
      if (realtimeEvent.event === "qualification_status_changed") {
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
        queryClient.invalidateQueries({ queryKey: ["matches", sessionId] });
      }
    },
  });
  return useQuery({
    queryKey: qualificationPreviewKey(sessionId),
    queryFn: () =>
      apiRequest<QualificationPreview>(`/api/sessions/${sessionId}/qualification/finalize-preview`),
  });
}
```

- [ ] **Step 7: Implement the dialog.** `src/qualification/FinalizeDialog.tsx`:

```tsx
import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { Modal } from "../components/Modal";
import { apiErrorMessage } from "../apiErrorMessage";
import type { QualificationPreview, SessionRead } from "../types";
import { draftFromRows, validateDraft } from "./finalizeDraft";

interface FinalizeDialogProps {
  sessionId: number;
  preview: QualificationPreview;
  onDone: (session: SessionRead) => void;
  onCancel: () => void;
}

export function FinalizeDialog({ sessionId, preview, onDone, onCancel }: FinalizeDialogProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const [draft, setDraft] = useState(() => draftFromRows(preview.rows));
  const { drops, errors } = validateDraft(preview.rows, draft);
  const mutation = useMutation({
    mutationFn: (body: { drops: Record<string, number> }) =>
      apiRequest<SessionRead>(`/api/sessions/${sessionId}/qualification/finalize`, { method: "POST", body }),
    onSuccess: onDone,
  });
  const cooperative = preview.game_model === "cooperative_score";

  return (
    <Modal labelledBy={headingId} onCancel={onCancel}>
      <h2 id={headingId}>{t("sessions.qualification.dialogHeading")}</h2>
      <p>{t(cooperative ? "sessions.qualification.dialogIntro" : "sessions.qualification.dialogIntroHeadToHead")}</p>
      {preview.rows.map((row, index) => {
        const key = String(row.played);
        const errorId = `${headingId}-error-${key}`;
        return (
          <label key={key} className="field">
            <span className="field__label">
              {t("sessions.qualification.rowLabel", { played: row.played, count: row.teams })}
            </span>
            <input
              className="input"
              type="number"
              min={0}
              max={row.played - 1}
              step={1}
              value={draft[key]}
              data-autofocus={index === 0 ? true : undefined}
              aria-invalid={errors[key] ? true : undefined}
              aria-describedby={errors[key] ? errorId : undefined}
              onChange={(e) => {
                setDraft((current) => ({ ...current, [key]: e.target.value }));
                mutation.reset();
              }}
            />
            <span id={errorId} className="field__error" aria-live="polite">
              {errors[key] ? t("sessions.qualification.rowError", { max: errors[key].max }) : ""}
            </span>
          </label>
        );
      })}
      <p>{t("sessions.qualification.notPlayed", { count: preview.unplayed_matches })}</p>
      {mutation.error && (
        <p className="form-error" role="alert">
          {apiErrorMessage(t, mutation.error)}
        </p>
      )}
      <div className="dialog__actions">
        <button type="button" className="button" onClick={onCancel}>
          {t("sessions.qualification.cancel")}
        </button>
        <button
          type="button"
          className="button button--primary"
          disabled={drops === null || mutation.isPending}
          onClick={() => drops && mutation.mutate({ drops })}
        >
          {t("sessions.qualification.confirm")}
        </button>
      </div>
    </Modal>
  );
}
```

Match the class names (`field__error`, `form-error`, `dialog__actions`, `button--primary`) to the ones `ConfirmDialog.tsx` and `RankingSettingsPanel.tsx` already use. Read both, and use their names wherever these differ. Also confirm the signature of `apiErrorMessage(t, error)` in `src/apiErrorMessage.ts`.

- [ ] **Step 8: Implement the bar.** `src/qualification/QualificationBar.tsx`:

```tsx
import { useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiRequest } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import type { SessionRead } from "../types";
import { FinalizeDialog } from "./FinalizeDialog";
import { qualificationPreviewKey, useQualificationPreview } from "./useQualificationPreview";

/** The Matches page's qualification status: Finalize (or why not yet), or finalized with Reopen. */
export function QualificationBar({ session }: { session: SessionRead }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const blockersId = useId();
  const { data: preview } = useQualificationPreview(session.id);
  const [dialog, setDialog] = useState<"finalize" | "reopen" | null>(null);

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["sessions"] });
    queryClient.invalidateQueries({ queryKey: ["matches", session.id] });
    queryClient.invalidateQueries({ queryKey: qualificationPreviewKey(session.id) });
    queryClient.invalidateQueries({ queryKey: ["rankings"] });
  }

  const reopen = useMutation({
    mutationFn: () =>
      apiRequest<SessionRead>(`/api/sessions/${session.id}/qualification/reopen`, { method: "POST" }),
    onSuccess: () => {
      setDialog(null);
      refresh();
    },
  });

  if (session.qualification_finalized_at) {
    const date = new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(session.qualification_finalized_at)
    );
    return (
      <div className="qualification-bar">
        <p className="qualification-bar__status">{t("sessions.qualification.finalizedOn", { date })}</p>
        <button type="button" className="button" onClick={() => setDialog("reopen")}>
          {t("sessions.qualification.reopen")}
        </button>
        {reopen.error && dialog === null && (
          <p className="form-error" role="alert">
            {apiErrorMessage(t, reopen.error)}
          </p>
        )}
        {dialog === "reopen" && (
          <ConfirmDialog
            heading={t("sessions.qualification.reopenHeading")}
            body={t("sessions.qualification.reopenBody")}
            confirmLabel={t("sessions.qualification.reopen")}
            cancelLabel={t("sessions.qualification.cancel")}
            isPending={reopen.isPending}
            error={reopen.error ? apiErrorMessage(t, reopen.error) : null}
            onConfirm={() => reopen.mutate()}
            onCancel={() => {
              setDialog(null);
              reopen.reset();
            }}
          />
        )}
      </div>
    );
  }

  const blockers = preview?.blockers ?? [];
  return (
    <div className="qualification-bar">
      <button
        type="button"
        className="button button--primary"
        disabled={!preview || blockers.length > 0}
        aria-describedby={blockers.length ? blockersId : undefined}
        onClick={() => setDialog("finalize")}
      >
        {t("sessions.qualification.finalize")}
      </button>
      {blockers.length > 0 && (
        <ul id={blockersId} className="qualification-bar__blockers">
          {blockers.map((blocker) => (
            <li key={blocker.code}>{t(`sessions.qualification.blocker.${blocker.code}`, { count: blocker.count })}</li>
          ))}
        </ul>
      )}
      {dialog === "finalize" && preview && (
        <FinalizeDialog
          sessionId={session.id}
          preview={preview}
          onCancel={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}
```

`ConfirmDialog` shows the `error` prop inside the dialog, so a reopen refused because of finals appears there. Keep the inline `reopen.error` paragraph only if `ConfirmDialog` lacks an error slot. Check its implementation and remove whichever path is redundant.

Add CSS to the stylesheet that holds the session pages' styles (find it with `grep -rn "toolbar--filters" frontend/apps/admin/src/*.css`). Use only existing tokens:

```css
.qualification-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin-block-end: var(--space-4); }
.qualification-bar__status { margin: 0; }
.qualification-bar__blockers { margin: 0; padding-inline-start: var(--space-4); color: var(--color-text-muted); }
```

Use the real token names from `tokens.css` (spacing, muted text colour) if these differ.

- [ ] **Step 9: Wire the Matches page.** In `SessionMatchesRoute.tsx`, import `QualificationBar` and render `<QualificationBar session={session} />` as the first child of the main returned `<div>`, above `toolbar--filters`. Leave the empty-state branch alone (no matches means nothing to finalize).

- [ ] **Step 10: Run the frontend checks.** `cd frontend && npm test --workspace apps/admin -- --run && npx tsc -b apps/admin`. Expected: all unit tests pass and tsc is clean.

- [ ] **Step 11: Document.** In `frontend/CLAUDE.md`, add a short paragraph under the session pages section:
  - `qualification/` holds the Matches page's finalize bar and dialog;
  - the preview query key is `["qualification-preview", sessionId]`, refreshed off `/ws/session/{id}`;
  - the future Finals page must disable its generate action while `qualification_finalized_at` is null, with the message "Finalize qualification on the Matches page before generating finals." and a link to `/sessions/{id}/matches`.

- [ ] **Step 12: Commit.**

```bash
git add frontend/apps/admin/src frontend/apps/admin/tests/unit frontend/CLAUDE.md
git commit -m "Finalize and reopen qualification from the Matches page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: End-to-end coverage

**Files:**
- Create: `frontend/apps/admin/tests/e2e/finalizeQualification.spec.ts` (isolated server, ports 8127/5187)
- Create: `frontend/apps/admin/tests/e2e/zzz_finalizeHeadToHead.spec.ts` (shared event; `zzz_` makes it run after `zz_seasonRankings`, which asserts on shared season rows)

**Interfaces:**
- Consumes: Task 5's UI (button and label texts from the en strings), Task 3's API, and `startIsolatedServer` / `buildCooperativeGamePluginZip` / `E2E_EVENT_*` fixtures.

- [ ] **Step 1: Write the cooperative spec.** `finalizeQualification.spec.ts`:

```ts
import fs from "node:fs";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { buildCooperativeGamePluginZip } from "./fixtures/buildPluginZip";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "finalize-e2e-pw";

test.describe.serial("finalizing cooperative qualification", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;
  let token = "";
  let session = 0;
  const teams: Record<string, number> = {};
  const unplayed: number[] = [];
  const api = (route: string) => `${server.apiUrl}${route}`;
  const headers = () => ({ Authorization: `Bearer ${token}` });

  async function login(page: Page) {
    await page.goto(`${server.baseUrl}/login`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page).toHaveURL(`${server.baseUrl}/`);
  }

  async function createMatch(request: APIRequestContext, number: number, red: string, blue: string) {
    const created = await request.post(api("/api/matches"), {
      headers: headers(),
      data: {
        session_id: session,
        round_type: "qualification",
        match_number: number,
        field_id: null,
        alliances: [
          { station: "red", team_ids: [teams[red]] },
          { station: "blue", team_ids: [teams[blue]] },
        ],
      },
    });
    expect(created.ok()).toBeTruthy();
    return created.json();
  }

  async function score(request: APIRequestContext, match: { id: number; alliances: { id: number; station: string }[] }, objects: number) {
    const red = match.alliances.find((a) => a.station === "red")!;
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
    server = await startIsolatedServer({ backendPort: 8127, frontendPort: 5187 });
    expect((await request.post(api("/api/event"), { data: { name: "Finalize League", password: PASSWORD } })).status()).toBe(201);
    token = (await (await request.post(api("/api/auth/login"), { data: { role: "admin", password: PASSWORD } })).json()).access_token;
    const uploaded = await request.post(api("/api/plugins/games"), {
      headers: headers(),
      multipart: {
        file: { name: "plugin.zip", mimeType: "application/zip", buffer: fs.readFileSync(await buildCooperativeGamePluginZip()) },
      },
    });
    expect(uploaded.status()).toBe(201);
    expect((await request.post(api("/api/event/game-plugin"), { headers: headers(), data: { name: "cooperative-game" } })).ok()).toBeTruthy();
    for (const number of ["F1", "F2", "F3", "F4"]) {
      teams[number] = (await (await request.post(api("/api/teams"), { headers: headers(), data: { number, name: `Finisher ${number}` } })).json()).id;
    }
    session = (await (await request.post(api("/api/sessions"), { headers: headers(), data: { label: "Short Saturday" } })).json()).id;
    await request.post(api("/api/fields"), { headers: headers(), data: { session_id: session, name: "Field 1" } });
    // F1+F2: 5 scheduled, 4 played (scores 10, 20, 30, 40). F3+F4: 5 scheduled, 5 played (10..50).
    for (let n = 1; n <= 5; n += 1) {
      const match = await createMatch(request, n, "F1", "F2");
      if (n <= 4) await score(request, match, n * 5);
      else unplayed.push(match.id);
    }
    for (let n = 6; n <= 10; n += 1) {
      await score(request, await createMatch(request, n, "F3", "F4"), (n - 5) * 5);
    }
  });

  test.afterAll(() => server?.stop());

  test("finalize is blocked while a match is in progress", async ({ page, request }) => {
    expect((await request.post(api(`/api/matches/${unplayed[0]}/start`), { headers: headers() })).ok()).toBeTruthy();
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${session}/matches`);
    const finalize = page.getByRole("button", { name: "Finalize qualification" });
    await expect(page.getByText("1 match is in progress.")).toBeVisible();
    await expect(finalize).toBeDisabled();

    expect((await request.post(api(`/api/matches/${unplayed[0]}/reset`), { headers: headers(), data: { scope: "full" } })).ok()).toBeTruthy();
    await expect(finalize).toBeEnabled();
  });

  test("finalize with adjusted drops, then rankings and Not played reflect it", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${session}/matches`);
    await page.getByRole("button", { name: "Finalize qualification" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Finalize qualification" });
    const four = dialog.getByLabel("4 played (2 teams)");
    const five = dialog.getByLabel("5 played (2 teams)");
    await expect(four).toHaveValue("1");
    await expect(five).toHaveValue("1");
    await expect(dialog.getByText("1 unplayed match will be marked Not played.")).toBeVisible();

    await four.fill("4");
    await expect(dialog.getByText("Enter a whole number from 0 to 3.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Finalize", exact: true })).toBeDisabled();
    await four.fill("1");
    await five.fill("0");
    await dialog.getByRole("button", { name: "Finalize", exact: true }).click();

    await expect(page.getByText(/^Qualification finalized on/)).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Not played" })).toHaveCount(1);

    await page.getByRole("link", { name: "Rankings", exact: true }).click();
    await expect(cell(page, "F1", 3)).toHaveText("30.00"); // 10 dropped: (20+30+40)/3
    await expect(cell(page, "F3", 3)).toHaveText("30.00"); // nothing dropped: (10+...+50)/5
  });

  test("reopen restores the schedule and rankings", async ({ page }) => {
    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${session}/matches`);
    await page.getByRole("button", { name: "Reopen qualification" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Reopen qualification" }).click();
    await expect(page.getByRole("button", { name: "Finalize qualification" })).toBeVisible();
    await expect(page.getByRole("gridcell", { name: "Not played" })).toHaveCount(0);
    await page.getByRole("link", { name: "Rankings", exact: true }).click();
    await expect(cell(page, "F1", 3)).toHaveText("25.00");
  });

  test("reopen is refused once finals exist", async ({ page, request }) => {
    const finalized = await request.post(api(`/api/sessions/${session}/qualification/finalize`), {
      headers: headers(),
      data: { drops: { "4": 1, "5": 1 } },
    });
    expect(finalized.ok()).toBeTruthy();
    const finals = await request.post(api("/api/finals/start"), { headers: headers(), data: { session_id: session, bracket_size: 2 } });
    expect(finals.ok()).toBeTruthy();

    await login(page);
    await page.goto(`${server.baseUrl}/sessions/${session}/matches`);
    await page.getByRole("button", { name: "Reopen qualification" }).click();
    const dialog = page.getByRole("alertdialog");
    await dialog.getByRole("button", { name: "Reopen qualification" }).click();
    await expect(dialog.getByText("Delete this session's finals brackets before reopening qualification")).toBeVisible();
  });
});
```

If the Matches grid exposes cells under a role other than `gridcell` (react-data-grid uses `gridcell`), match what `z_sessionSchedule.spec.ts` uses.

- [ ] **Step 2: Write the head-to-head spec.** `zzz_finalizeHeadToHead.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import { E2E_EVENT_PASSWORD } from "./fixtures/testEvent";

test("head-to-head finalize asks only for confirmation", async ({ page, request }) => {
  const token = (await (await request.post("/api/auth/login", { data: { role: "admin", password: E2E_EVENT_PASSWORD } })).json())
    .access_token;
  const headers = { Authorization: `Bearer ${token}` };
  const ids: number[] = [];
  for (const number of ["HF1", "HF2"]) {
    ids.push((await (await request.post("/api/teams", { headers, data: { number, name: `Head ${number}` } })).json()).id);
  }
  const session = (await (await request.post("/api/sessions", { headers, data: { label: "Finalize H2H" } })).json()).id;
  for (const number of [1, 2]) {
    const match = await (
      await request.post("/api/matches", {
        headers,
        data: {
          session_id: session, round_type: "qualification", match_number: number, field_id: null,
          alliances: [{ station: "red", team_ids: [ids[0]] }, { station: "blue", team_ids: [ids[1]] }],
        },
      })
    ).json();
    if (number === 1) {
      for (const alliance of match.alliances) {
        await request.post(`/api/matches/${match.id}/alliances/${alliance.id}/score`, {
          headers,
          data: { data: { high_balls: alliance.station === "red" ? 5 : 2, low_balls: 0, auto_winner: "tie" } },
        });
      }
    }
  }

  await page.goto("/login");
  await page.getByLabel("Role").fill("admin");
  await page.getByLabel("Password").fill(E2E_EVENT_PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page).toHaveURL("/");
  await page.goto(`/sessions/${session}/matches`);
  await page.getByRole("button", { name: "Finalize qualification" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Finalize qualification" });
  await expect(dialog.getByText("Rankings will use the matches played so far.", { exact: false })).toBeVisible();
  await expect(dialog.getByRole("spinbutton")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Finalize", exact: true }).click();
  await expect(page.getByText(/^Qualification finalized on/)).toBeVisible();
  await expect(page.getByRole("gridcell", { name: "Not played" })).toHaveCount(1);
});
```

- [ ] **Step 3: Run the new specs, then the whole E2E suite.**
  - `cd frontend/apps/admin && npx playwright test finalizeQualification.spec.ts zzz_finalizeHeadToHead.spec.ts`
  - then `npx playwright test`

  Expected: all pass. The shared server must be on 8123/5183 per `playwright.config.ts`. If the multipart upload helper or the `apiUrl` / `baseUrl` field names differ from `isolatedServer.ts`, adapt only those mechanics.

- [ ] **Step 4: Commit.**

```bash
git add frontend/apps/admin/tests/e2e/finalizeQualification.spec.ts frontend/apps/admin/tests/e2e/zzz_finalizeHeadToHead.spec.ts
git commit -m "Cover finalizing and reopening qualification end to end

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
