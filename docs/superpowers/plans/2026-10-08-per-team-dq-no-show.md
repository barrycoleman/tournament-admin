# Per-team DQ and No-show Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move DQ and no-show from the alliance's score record to each team, so a flagged team gets nothing in practice and qualification while its partner keeps the score and win points, and in finals one DQ zeroes the alliance while a no-show is carried along.

**Architecture:**
- **Rules module:** `services/team_flags.py` owns every "does a flag zero this score" decision (`flagged_team_ids`, `alliance_out`, `effective_score`, `alliance_team_ids`). Every call site uses it.
- **Storage:** a new `score_record_teams` table (flagged teams only) replaces `ScoreRecord.no_show` / `ScoreRecord.dq`, with a data-preserving migration.
- **API:** the score submission body takes `teams: [{team_id, no_show, dq}]` (unknown fields now 422) and the response returns the same list.
- **Rankings:** head-to-head credits win points and strength of schedule per team; cooperative builds one `MatchRecord` per team.
- **Finals:** single elimination, score chase and the runs listing use `effective_score(..., finals=True)`.

**Tech Stack:** FastAPI, SQLAlchemy 2.x, Alembic, SQLite, pytest. No frontend code changes.

**Spec:** `docs/superpowers/specs/2026-10-08-per-team-dq-no-show-design.md`

## Global Constraints

From the spec and the repo:

- Never reference any real-world competition brand or product name anywhere (code, comments, tests, commit messages, docs).
- Every backend change ships with pytest unit and integration tests against a real FastAPI `TestClient` and a real temp-file SQLite database, in the same change as the code.
- Schema changes go through the project's Alembic migration mechanism; `tests/test_alembic_drift.py` must stay green (models and migrations identical).
- The plugin contract does not change; `rank_teams` input is unchanged, so the conformance tool is untouched.
- `ScoreRecord.sitting` and `ScoreRecord.mirrored` keep their current meaning.

Plan conventions:

- The new migration's revision is `e9c3f7a1b5d2` and its `down_revision` is `a7d5e2c8f1b4` (the current head).
- Work on branch `per-team-dq-no-show` in the main checkout. No worktrees, no pushing, no merging.
- Commit messages are plain sentences (no `feat:` prefixes) and end with the line `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Commands:
  - Server tests: `cd server && .venv/bin/pytest -q` (or `uv run pytest -q` if `.venv` is absent).
  - E2E: `cd frontend/apps/admin && npx playwright test`.

Plan rulings (decisions the spec leaves open):

- `alliance_out` takes the **flags** (any iterable of objects with `team_id`, `no_show`, `dq`), not the record, so the router can apply it to the request's flags before anything is written. `effective_score` still takes the record. Same behaviour as the spec's section 5.
- `ScoreSubmit` and its `teams` entries forbid unknown fields, so a stale client still sending `"dq": true` gets a 422 instead of having the flag silently dropped.
- The router validates flags **after** the existing 404 / not-played / 409 checks and **before** plugin validation.
- The migration reads the flagged rows, drops the two columns, then creates and fills `score_record_teams`, in that order, so the SQLite batch rebuild of `score_records` never runs while child rows with `ON DELETE CASCADE` exist.

## Review Focus

The five uncovered inputs most likely to bite, each pinned by a test in the owning task:

1. **Re-flagging the same team in an admin correction** (correct twice with the same team flagged) must not hit the `(score_record_id, team_id)` unique constraint. Test in Task 2 (`test_admin_correction_replaces_the_flag_set`).
2. **A stale client body with `"dq": true` or `"no_show": true`** must be refused (422), not silently scored as unflagged. Test in Task 2 (`test_the_old_alliance_level_flags_are_refused`).
3. **Deleting a finals bracket whose scored run has flagged teams** must remove the flag rows with it, with no foreign-key error. Test in Task 2 (`test_deleting_a_bracket_removes_its_flag_rows`).
4. **A flagged score record whose alliance has no teams** must not crash the migration. Test in Task 2 (`test_per_team_flags_migration_moves_alliance_flags_onto_each_team`, alliance 3).
5. **An admin correcting a cooperative partner's data** must mirror the data but keep the other alliance's own team flags. Test in Task 2 (`test_mirroring_keeps_the_partners_own_flags`).

---

### Task 1: The rules module

**Files:**
- Create: `server/src/tournament_server/services/team_flags.py`
- Test: `server/tests/test_team_flags.py`

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on these exact names):
  - `flagged_team_ids(flags: Iterable[TeamFlag]) -> set[int]`
  - `alliance_out(flags: Iterable[TeamFlag], team_ids: Sequence[int], *, finals: bool) -> bool`
  - `effective_score(plugin: LoadedPlugin, record: ScoreRecord, team_ids: Sequence[int], *, finals: bool) -> int`, which reads `record.teams` and `record.data_json`.
  - `TeamFlag` is a `typing.Protocol` with `team_id: int`, `no_show: bool`, `dq: bool`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_team_flags.py`:

```python
from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest

from tournament_server.services import team_flags


@dataclass
class Flag:
    team_id: int
    no_show: bool = False
    dq: bool = False


@dataclass
class Record:
    data_json: str = json.dumps({"points": 40})
    teams: list[Flag] = field(default_factory=list)


class Plugin:
    class module:
        @staticmethod
        def calculate_score(data):
            return data["points"]


def test_flagged_team_ids_lists_teams_with_either_flag():
    flags = [Flag(1, dq=True), Flag(2, no_show=True), Flag(3)]
    assert team_flags.flagged_team_ids(flags) == {1, 2}


@pytest.mark.parametrize(
    ("flags", "finals", "out"),
    [
        ([], False, False),
        ([Flag(2, dq=True)], False, False),
        ([Flag(2, no_show=True)], False, False),
        ([Flag(1, dq=True), Flag(2, no_show=True)], False, True),
        ([Flag(1, no_show=True), Flag(2, no_show=True)], False, True),
        ([], True, False),
        ([Flag(2, dq=True)], True, True),
        ([Flag(2, no_show=True)], True, False),
        ([Flag(1, no_show=True), Flag(2, no_show=True)], True, True),
        ([Flag(2, no_show=True, dq=True)], True, True),
    ],
)
def test_alliance_out(flags, finals, out):
    assert team_flags.alliance_out(flags, [1, 2], finals=finals) is out


def test_alliance_out_ignores_flags_for_teams_not_on_the_alliance():
    assert team_flags.alliance_out([Flag(9, dq=True)], [1, 2], finals=True) is False


def test_an_alliance_with_no_teams_is_never_out():
    assert team_flags.alliance_out([], [], finals=False) is False


def test_effective_score_is_the_scoresheet_unless_the_alliance_is_out():
    assert team_flags.effective_score(Plugin, Record(teams=[Flag(2, dq=True)]), [1, 2], finals=False) == 40
    assert team_flags.effective_score(Plugin, Record(teams=[Flag(2, dq=True)]), [1, 2], finals=True) == 0


def test_effective_score_does_not_call_the_plugin_when_the_alliance_is_out():
    record = Record(data_json=json.dumps({}), teams=[Flag(1, no_show=True)])
    assert team_flags.effective_score(Plugin, record, [1], finals=False) == 0
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && .venv/bin/pytest tests/test_team_flags.py -q`
Expected: FAIL with `ImportError` / `cannot import name 'team_flags'`.

- [ ] **Step 3: Implement**

Create `server/src/tournament_server/services/team_flags.py`:

```python
"""Per-team DQ and no-show rules.

In practice and qualification a flag removes only that team; the alliance
scores 0 only when every team on it is flagged. In finals one DQ zeroes the
whole alliance, and a no-show team is carried along unless every team on
the alliance is a no-show.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Iterable, Protocol, Sequence

if TYPE_CHECKING:
    from tournament_server.models.score_record import ScoreRecord
    from tournament_server.plugin_registry.loader import LoadedPlugin


class TeamFlag(Protocol):
    team_id: int
    no_show: bool
    dq: bool


def flagged_team_ids(flags: Iterable[TeamFlag]) -> set[int]:
    return {flag.team_id for flag in flags if flag.no_show or flag.dq}


def alliance_out(flags: Iterable[TeamFlag], team_ids: Sequence[int], *, finals: bool) -> bool:
    """True when the alliance's score counts as 0."""
    if not team_ids:
        return False
    by_team = {flag.team_id: flag for flag in flags}
    on_alliance = [by_team[team_id] for team_id in team_ids if team_id in by_team]
    if finals:
        if any(flag.dq for flag in on_alliance):
            return True
        return len(on_alliance) == len(team_ids) and all(flag.no_show for flag in on_alliance)
    return len(on_alliance) == len(team_ids) and all(
        flag.no_show or flag.dq for flag in on_alliance
    )


def effective_score(
    plugin: "LoadedPlugin", record: "ScoreRecord", team_ids: Sequence[int], *, finals: bool
) -> int:
    if alliance_out(record.teams, team_ids, finals=finals):
        return 0
    return plugin.module.calculate_score(json.loads(record.data_json))
```

`team_ids` never holds duplicates (an alliance lists each team once), so comparing lengths is safe.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && .venv/bin/pytest tests/test_team_flags.py -q`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/services/team_flags.py server/tests/test_team_flags.py
git commit -m "Add the per-team DQ and no-show rules module

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Store flags per team and take them through the API

This task removes `ScoreRecord.no_show` / `ScoreRecord.dq`, so every reader moves to `team_flags` in the same change. The ranking code changes here only enough to keep alliance-level behaviour; Tasks 3 and 4 add the per-team ranking rules.

**Files:**
- Create: `server/src/tournament_server/models/score_record_team.py`
- Create: `server/src/tournament_server/_alembic/versions/e9c3f7a1b5d2_per_team_dq_no_show.py`
- Modify: `server/src/tournament_server/models/score_record.py` (drop `no_show`, `dq`; add `teams` relationship)
- Modify: `server/src/tournament_server/models/__init__.py` (register `ScoreRecordTeam`)
- Modify: `server/src/tournament_server/services/team_flags.py` (add `alliance_team_ids`)
- Modify: `server/src/tournament_server/schemas/score_record.py`
- Modify: `server/src/tournament_server/routers/scores.py`
- Modify: `server/src/tournament_server/services/ranking.py` (`_effective_score`, `_head_to_head_stats`, `_cooperative_records`)
- Modify: `server/src/tournament_server/routers/finals.py:~80-95`
- Modify: `server/src/tournament_server/services/finals.py:~310-325` and `~385-400`
- Modify (convert old flags): `server/tests/test_scores.py`, `server/tests/test_cooperative_scoring.py`, `server/tests/test_season_rankings.py`, `server/tests/test_sample_cooperative_plugin.py`
- Test: `server/tests/test_migrations.py` (append), `server/tests/test_per_team_flags_api.py` (new), `server/tests/test_per_team_flags_finals.py` (new)

**Interfaces:**
- Consumes: Task 1's `flagged_team_ids`, `alliance_out`, `effective_score`.
- Produces:
  - `ScoreRecordTeam` model (`score_record_id`, `team_id`, `no_show`, `dq`) and `ScoreRecord.teams: list[ScoreRecordTeam]` (ordered by `team_id`, loaded with `selectin`).
  - `team_flags.alliance_team_ids(db: Session, alliance_id: int) -> list[int]`.
  - Schema `TeamFlags(team_id: int, no_show: bool = False, dq: bool = False)`; `ScoreSubmit.teams: list[TeamFlags]`; `ScoreRecordRead.teams: list[TeamFlags]`.

- [ ] **Step 1: Write the failing migration test**

Append to `server/tests/test_migrations.py`:

```python
def test_per_team_flags_migration_moves_alliance_flags_onto_each_team(tmp_path):
    db_path = str(tmp_path / "flags.db")
    config = _make_alembic_config(db_path)
    command.upgrade(config, "a7d5e2c8f1b4")  # the revision before
    raw_engine = create_engine(f"sqlite:///{db_path}")
    with raw_engine.connect() as connection:
        connection.execute(
            text("INSERT INTO events (id, name, created_at) VALUES (1, 'League', '2026-01-01 00:00:00')")
        )
        connection.execute(text("INSERT INTO sessions (id, event_id, label) VALUES (1, 1, 'Saturday')"))
        for team_id in (1, 2, 3, 4):
            connection.execute(
                text(
                    "INSERT INTO teams (id, event_id, number, name, tiebreaker_seed) "
                    "VALUES (:id, 1, :number, :name, :id)"
                ),
                {"id": team_id, "number": str(100 + team_id), "name": f"Team {team_id}"},
            )
        connection.execute(
            text(
                "INSERT INTO matches (id, session_id, division_id, round_type, match_number, "
                "status, phase, paused) VALUES (1, 1, NULL, 'qualification', 1, 'completed', "
                "'not_started', 0)"
            )
        )
        # Alliance 1 (teams 1, 2) was DQ'd, alliance 2 (teams 3, 4) has no flags,
        # alliance 3 has no teams at all but is marked no-show.
        for alliance_id, station in ((1, "red"), (2, "blue"), (3, "solo")):
            connection.execute(
                text("INSERT INTO alliances (id, match_id, station) VALUES (:id, 1, :station)"),
                {"id": alliance_id, "station": station},
            )
        for alliance_id, team_id in ((1, 1), (1, 2), (2, 3), (2, 4)):
            connection.execute(
                text("INSERT INTO alliance_teams (alliance_id, team_id) VALUES (:alliance_id, :team_id)"),
                {"alliance_id": alliance_id, "team_id": team_id},
            )
        for alliance_id, no_show, dq in ((1, 0, 1), (2, 0, 0), (3, 1, 0)):
            connection.execute(
                text(
                    "INSERT INTO score_records (id, alliance_id, plugin_name, plugin_version, "
                    "data_json, no_show, dq, sitting, mirrored, submitted_at) VALUES (:id, :id, "
                    "'example-game', '1.0.0', '{}', :no_show, :dq, 0, 0, '2026-01-01 00:00:00')"
                ),
                {"id": alliance_id, "no_show": no_show, "dq": dq},
            )
        connection.commit()
    raw_engine.dispose()

    command.upgrade(config, "head")
    engine = create_engine(f"sqlite:///{db_path}")
    columns = {column["name"] for column in inspect(engine).get_columns("score_records")}
    assert {"no_show", "dq"}.isdisjoint(columns)
    with engine.connect() as connection:
        rows = connection.execute(
            text(
                "SELECT score_record_id, team_id, no_show, dq FROM score_record_teams "
                "ORDER BY score_record_id, team_id"
            )
        ).all()
    assert [tuple(row) for row in rows] == [(1, 1, 0, 1), (1, 2, 0, 1)]
    engine.dispose()

    command.downgrade(config, "a7d5e2c8f1b4")
    engine = create_engine(f"sqlite:///{db_path}")
    assert "score_record_teams" not in inspect(engine).get_table_names()
    with engine.connect() as connection:
        flags = connection.execute(text("SELECT id, no_show, dq FROM score_records ORDER BY id")).all()
    # Alliance 3 had no teams, so its no-show had no team to move onto and is not restored.
    assert [tuple(row) for row in flags] == [(1, 0, 1), (2, 0, 0), (3, 0, 0)]
    engine.dispose()
```

If an `INSERT` fails because the schema at `a7d5e2c8f1b4` has another NOT NULL column without a default, add that column to the insert with a plain value. Do not change what the test asserts.

- [ ] **Step 2: Write the failing API tests**

Create `server/tests/test_per_team_flags_api.py`:

```python
from sqlalchemy import func, select

from auth_helpers import bearer, login_as
from skills_helpers import admitted_device_token
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.score_record_team import ScoreRecordTeam

SHEET = {"high_balls": 10, "low_balls": 0, "auto_winner": "tie"}  # 30 points in example-game


def _setup(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1, t2, t3, t4 = (
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in (1, 2, 3, 4)
    )
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    return f"/api/matches/{match['id']}/alliances/{red}/score", (t1, t2, t3, t4), red


def _flag_rows(client):
    db = client.app.state.session_factory()
    try:
        return db.execute(select(func.count()).select_from(ScoreRecordTeam)).scalar_one()
    finally:
        db.close()


def _record_count(client):
    db = client.app.state.session_factory()
    try:
        return db.execute(select(func.count()).select_from(ScoreRecord)).scalar_one()
    finally:
        db.close()


def test_flags_round_trip_and_one_flagged_team_keeps_the_alliance_score(client):
    path, (t1, t2, _, _), _ = _setup(client)
    response = client.post(path, json={"data": SHEET, "teams": [{"team_id": t2, "dq": True}]})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["teams"] == [{"team_id": t2, "no_show": False, "dq": True}]
    assert body["computed_score"] == 30
    assert "dq" not in body and "no_show" not in body


def test_every_team_flagged_zeroes_the_alliance(client):
    path, (t1, t2, _, _), _ = _setup(client)
    response = client.post(
        path,
        json={"data": SHEET, "teams": [{"team_id": t1, "no_show": True}, {"team_id": t2, "dq": True}]},
    )
    assert response.status_code == 200, response.text
    assert response.json()["computed_score"] == 0


def test_a_team_not_on_the_alliance_is_refused_and_nothing_is_written(client):
    path, (_, _, t3, _), _ = _setup(client)
    response = client.post(path, json={"data": SHEET, "teams": [{"team_id": t3, "dq": True}]})
    assert response.status_code == 422
    assert _record_count(client) == 0


def test_a_team_listed_twice_is_refused(client):
    path, (t1, _, _, _), _ = _setup(client)
    response = client.post(
        path,
        json={"data": SHEET, "teams": [{"team_id": t1, "dq": True}, {"team_id": t1, "no_show": True}]},
    )
    assert response.status_code == 422
    assert _record_count(client) == 0


def test_an_entry_with_no_flags_is_not_stored(client):
    path, (t1, _, _, _), _ = _setup(client)
    response = client.post(path, json={"data": SHEET, "teams": [{"team_id": t1}]})
    assert response.status_code == 200, response.text
    assert response.json()["teams"] == []
    assert _flag_rows(client) == 0


def test_admin_correction_replaces_the_flag_set(client):
    path, (t1, t2, _, _), _ = _setup(client)
    client.post(path, json={"data": SHEET, "teams": [{"team_id": t1, "no_show": True}]})
    second = client.post(path, json={"data": SHEET, "teams": [{"team_id": t2, "dq": True}]})
    assert second.json()["teams"] == [{"team_id": t2, "no_show": False, "dq": True}]
    # The same team flagged again must not trip the (score_record_id, team_id) unique constraint.
    again = client.post(path, json={"data": SHEET, "teams": [{"team_id": t2, "dq": True}]})
    assert again.status_code == 200, again.text
    cleared = client.post(path, json={"data": SHEET})
    assert cleared.json()["teams"] == []
    assert _flag_rows(client) == 0


def test_the_old_alliance_level_flags_are_refused(client):
    path, _, _ = _setup(client)
    for old_field in ("dq", "no_show"):
        response = client.post(path, json={"data": SHEET, old_field: True})
        assert response.status_code == 422, old_field
    assert _record_count(client) == 0


def test_a_scorer_still_cannot_resubmit(client):
    path, (t1, _, _, _), _ = _setup(client)
    raw = client.__class__(client.app)
    scorer = {**bearer(login_as(raw, "scorer")), "X-Device-Token": admitted_device_token(client)}
    assert raw.post(path, json={"data": SHEET}, headers=scorer).status_code == 200
    refused = raw.post(path, json={"data": SHEET, "teams": [{"team_id": t1, "dq": True}]}, headers=scorer)
    assert refused.status_code == 409
```

`client.app.state.session_factory` is the same handle `tests/test_scores.py`'s `_score_record` helper uses. `ScoreRecord.teams` loads eagerly (`selectin`), so reading it after the session closes is safe.

Append cooperative mirroring tests to the same file:

```python
def _setup_cooperative(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1, t2, t3, t4 = (
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in (1, 2, 3, 4)
    )
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    ids = {a["station"]: a["id"] for a in match["alliances"]}
    base = f"/api/matches/{match['id']}/alliances"
    return f"{base}/{ids['red']}/score", f"{base}/{ids['blue']}/score", (t1, t2, t3, t4), ids


def _record(client, alliance_id):
    db = client.app.state.session_factory()
    try:
        record = db.execute(select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)).scalar_one()
        return record.data_json, [(f.team_id, f.no_show, f.dq) for f in record.teams]
    finally:
        db.close()


def test_one_flagged_team_still_mirrors(cooperative_client):
    red_path, _, (t1, t2, t3, t4), ids = _setup_cooperative(cooperative_client)
    response = cooperative_client.post(
        red_path, json={"data": {"objects_scored": 10}, "teams": [{"team_id": t2, "dq": True}]}
    )
    assert response.status_code == 200, response.text
    assert _record(cooperative_client, ids["blue"]) == ('{"objects_scored": 10}', [])


def test_a_fully_flagged_alliance_does_not_mirror(cooperative_client):
    red_path, _, (t1, t2, _, _), ids = _setup_cooperative(cooperative_client)
    cooperative_client.post(
        red_path,
        json={"data": {"objects_scored": 10}, "teams": [{"team_id": t1, "dq": True}, {"team_id": t2, "no_show": True}]},
    )
    db = cooperative_client.app.state.session_factory()
    try:
        assert db.execute(select(ScoreRecord).where(ScoreRecord.alliance_id == ids["blue"])).first() is None
    finally:
        db.close()


def test_a_scorer_may_score_the_partner_of_a_fully_flagged_alliance(cooperative_client):
    red_path, blue_path, (t1, t2, _, _), _ = _setup_cooperative(cooperative_client)
    raw = cooperative_client.__class__(cooperative_client.app)
    scorer = {**bearer(login_as(raw, "scorer")), "X-Device-Token": admitted_device_token(cooperative_client)}
    flagged = raw.post(
        red_path,
        json={"data": {"objects_scored": 3}, "teams": [{"team_id": t1, "dq": True}, {"team_id": t2, "dq": True}]},
        headers=scorer,
    )
    assert flagged.status_code == 200, flagged.text
    blue = raw.post(blue_path, json={"data": {"objects_scored": 10}}, headers=scorer)
    assert blue.status_code == 200, blue.text


def test_mirroring_keeps_the_partners_own_flags(cooperative_client):
    red_path, blue_path, (_, _, t3, _), ids = _setup_cooperative(cooperative_client)
    cooperative_client.post(blue_path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": t3, "dq": True}]})
    cooperative_client.post(red_path, json={"data": {"objects_scored": 10}})
    assert _record(cooperative_client, ids["blue"]) == ('{"objects_scored": 10}', [(t3, False, True)])
```

- [ ] **Step 3: Write the failing finals tests**

Create `server/tests/test_per_team_flags_finals.py`. It reuses the finals helpers from `test_finals.py`:

```python
from test_finals import (
    _rank_teams_directly_head_to_head,
    _setup_and_start_score_chase,
    _setup_ranked_teams_for_example_game,
)


def _start_two_alliance_bracket(client):
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, 4)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)
    bracket = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "bracket_size": 2, "wins_to_advance": [1]},
    ).json()
    claimed = {tid for alliance in bracket["alliances"] for tid in alliance["team_ids"]}
    unclaimed = [t for t in team_ids if t not in claimed]
    for i, alliance in enumerate(bracket["alliances"]):
        bracket = client.post(
            f"/api/finals/{bracket['id']}/pick",
            json={"captain_bracket_alliance_id": alliance["id"], "partner_team_id": unclaimed[i]},
        ).json()
    assert bracket["status"] == "in_progress"
    return session_id, bracket


def _play_final(client, session_id, red_high_balls, blue_high_balls, red_flag):
    game = next(
        m for m in client.get(f"/api/matches?session_id={session_id}").json()
        if m["round_type"] == "elimination" and m["status"] != "completed"
    )
    red = next(a for a in game["alliances"] if a["station"] == "red")
    blue = next(a for a in game["alliances"] if a["station"] == "blue")
    flag = {"team_id": red["team_ids"][0], red_flag: True}
    for alliance, high_balls, teams in ((red, red_high_balls, [flag]), (blue, blue_high_balls, [])):
        response = client.post(
            f"/api/matches/{game['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": high_balls, "low_balls": 0, "auto_winner": "tie"}, "teams": teams},
        )
        assert response.status_code == 200, response.text


def _winner(client, bracket):
    final = client.get(f"/api/finals/{bracket['id']}").json()
    assert final["status"] == "complete"
    return final["matchups"][0]["winner_alliance_id"], final["matchups"][0]


def test_one_dq_zeroes_the_finals_alliance_and_loses_the_game(client):
    session_id, bracket = _start_two_alliance_bracket(client)
    _play_final(client, session_id, red_high_balls=10, blue_high_balls=1, red_flag="dq")
    winner, matchup = _winner(client, bracket)
    assert winner == matchup["alliance_b_id"]  # blue: red scored 0 against 3


def test_one_no_show_is_carried_and_the_alliance_still_wins(client):
    session_id, bracket = _start_two_alliance_bracket(client)
    _play_final(client, session_id, red_high_balls=10, blue_high_balls=1, red_flag="no_show")
    winner, matchup = _winner(client, bracket)
    assert winner == matchup["alliance_a_id"]  # red: 30 against 3


def _first_run(client, bracket):
    match_id = bracket["runs"][0]["match_id"]
    alliance = client.get(f"/api/matches/{match_id}").json()["alliances"][0]
    assert len(alliance["team_ids"]) == 2
    return f"/api/matches/{match_id}/alliances/{alliance['id']}/score", alliance["team_ids"]


def test_a_dq_in_a_score_chase_run_scores_zero(cooperative_client):
    bracket = _setup_and_start_score_chase(cooperative_client, [1, 2])
    path, team_ids = _first_run(cooperative_client, bracket)
    response = cooperative_client.post(
        path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": team_ids[0], "dq": True}]}
    )
    assert response.json()["computed_score"] == 0
    runs = cooperative_client.get(f"/api/finals/{bracket['id']}").json()["runs"]
    assert runs[0]["score"] == 0


def test_one_no_show_in_a_score_chase_run_keeps_the_score(cooperative_client):
    bracket = _setup_and_start_score_chase(cooperative_client, [1, 2])
    path, team_ids = _first_run(cooperative_client, bracket)
    response = cooperative_client.post(
        path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": team_ids[0], "no_show": True}]}
    )
    assert response.json()["computed_score"] == 10
    runs = cooperative_client.get(f"/api/finals/{bracket['id']}").json()["runs"]
    assert runs[0]["score"] == 10


def test_deleting_a_bracket_removes_its_flag_rows(cooperative_client):
    from sqlalchemy import func, select

    from tournament_server.models.score_record_team import ScoreRecordTeam

    bracket = _setup_and_start_score_chase(cooperative_client, [1, 2])
    path, team_ids = _first_run(cooperative_client, bracket)
    cooperative_client.post(path, json={"data": {"objects_scored": 5}, "teams": [{"team_id": team_ids[0], "dq": True}]})
    assert cooperative_client.delete(f"/api/finals/{bracket['id']}").status_code == 204
    db = cooperative_client.app.state.session_factory()
    try:
        assert db.execute(select(func.count()).select_from(ScoreRecordTeam)).scalar_one() == 0
    finally:
        db.close()
```

In `_winner`, the bracket of size 2 has one matchup. If the finals read returns matchups in a different shape, adapt the lookup, not the assertions. If deleting an in-progress bracket with a scored run is refused by an existing rule, keep the rule and instead assert the flag rows go when `services.deletion.delete_finals_bracket` is called directly.

- [ ] **Step 4: Run to verify failure**

Run: `cd server && .venv/bin/pytest tests/test_migrations.py::test_per_team_flags_migration_moves_alliance_flags_onto_each_team tests/test_per_team_flags_api.py tests/test_per_team_flags_finals.py -q`
Expected: FAIL (no `score_record_team` module, no revision `e9c3f7a1b5d2`, `teams` not accepted).

- [ ] **Step 5: Add the model**

Create `server/src/tournament_server/models/score_record_team.py`:

```python
from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class ScoreRecordTeam(Base):
    """One flagged team on a score record. Teams without a flag have no row."""

    __tablename__ = "score_record_teams"
    __table_args__ = (
        UniqueConstraint("score_record_id", "team_id", name="uq_score_record_team"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    score_record_id: Mapped[int] = mapped_column(ForeignKey("score_records.id", ondelete="CASCADE"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    dq: Mapped[bool] = mapped_column(Boolean, default=False)
```

In `server/src/tournament_server/models/score_record.py` remove the `no_show` and `dq` columns and add:

```python
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tournament_server.models.score_record_team import ScoreRecordTeam

    # Flagged teams only (DQ or no-show); see services/team_flags.py.
    teams: Mapped[list[ScoreRecordTeam]] = relationship(
        cascade="all, delete-orphan", lazy="selectin", order_by=ScoreRecordTeam.team_id
    )
```

Register `ScoreRecordTeam` in `server/src/tournament_server/models/__init__.py` next to `ScoreRecord` (import and `__all__`).

- [ ] **Step 6: Add the migration**

Create `server/src/tournament_server/_alembic/versions/e9c3f7a1b5d2_per_team_dq_no_show.py`:

```python
"""per-team DQ and no-show: score_record_teams replaces score_records.no_show/dq

Revision ID: e9c3f7a1b5d2
Revises: a7d5e2c8f1b4
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = 'e9c3f7a1b5d2'
down_revision: Union[str, None] = 'a7d5e2c8f1b4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    # Read the flags first: the batch rebuild below must run before
    # score_record_teams (ON DELETE CASCADE) holds any rows.
    flagged = bind.execute(
        sa.text(
            "SELECT DISTINCT sr.id, at.team_id, sr.no_show, sr.dq FROM score_records sr "
            "JOIN alliance_teams at ON at.alliance_id = sr.alliance_id "
            "WHERE sr.no_show OR sr.dq ORDER BY sr.id, at.team_id"
        )
    ).all()
    with op.batch_alter_table('score_records') as batch_op:
        batch_op.drop_column('no_show')
        batch_op.drop_column('dq')
    score_record_teams = op.create_table(
        'score_record_teams',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('score_record_id', sa.Integer(), nullable=False),
        sa.Column('team_id', sa.Integer(), nullable=False),
        sa.Column('no_show', sa.Boolean(), nullable=False),
        sa.Column('dq', sa.Boolean(), nullable=False),
        sa.ForeignKeyConstraint(['score_record_id'], ['score_records.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['team_id'], ['teams.id'], ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('score_record_id', 'team_id', name='uq_score_record_team'),
    )
    if flagged:
        op.bulk_insert(
            score_record_teams,
            [
                {"score_record_id": row[0], "team_id": row[1], "no_show": bool(row[2]), "dq": bool(row[3])}
                for row in flagged
            ],
        )


def downgrade() -> None:
    op.add_column(
        'score_records',
        sa.Column('no_show', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        'score_records',
        sa.Column('dq', sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.execute(
        "UPDATE score_records SET no_show = 1 WHERE id IN "
        "(SELECT score_record_id FROM score_record_teams WHERE no_show)"
    )
    op.execute(
        "UPDATE score_records SET dq = 1 WHERE id IN "
        "(SELECT score_record_id FROM score_record_teams WHERE dq)"
    )
    op.drop_table('score_record_teams')
```

If `tests/test_alembic_drift.py` reports a difference (for example the model's nullability or the FK's `ondelete`), make the migration match the model, not the other way round.

- [ ] **Step 7: Schemas**

Replace `server/src/tournament_server/schemas/score_record.py`'s two classes with:

```python
from pydantic import BaseModel, ConfigDict


class TeamFlags(BaseModel):
    model_config = ConfigDict(extra="forbid")

    team_id: int
    no_show: bool = False
    dq: bool = False


class ScoreSubmit(BaseModel):
    # Unknown fields are refused so a client still sending the old
    # alliance-level `no_show`/`dq` gets a 422 instead of losing the flag.
    model_config = ConfigDict(extra="forbid")

    data: dict[str, Any]
    teams: list[TeamFlags] = []
    sitting: bool = False
    force: bool = False


class ScoreRecordRead(BaseModel):
    id: int
    alliance_id: int
    plugin_name: str
    plugin_version: str
    data: dict[str, Any]
    teams: list[TeamFlags]
    sitting: bool
    submitted_by_device: str | None
    submitted_at: dt.datetime
    saved_at: dt.datetime | None
    computed_score: int
```

Keep the existing imports (`datetime as dt`, `Any`).

- [ ] **Step 8: `alliance_team_ids` in the rules module**

Append to `server/src/tournament_server/services/team_flags.py` (add the imports at the top: `from sqlalchemy import select`, `from sqlalchemy.orm import Session`, `from tournament_server.models.alliance import AllianceTeam`):

```python
def alliance_team_ids(db: Session, alliance_id: int) -> list[int]:
    return list(
        db.execute(
            select(AllianceTeam.team_id)
            .where(AllianceTeam.alliance_id == alliance_id)
            .order_by(AllianceTeam.id)
        ).scalars()
    )
```

- [ ] **Step 9: The score router**

In `server/src/tournament_server/routers/scores.py`:

1. Imports: add `from tournament_server.models.score_record_team import ScoreRecordTeam`, `from tournament_server.schemas.score_record import ScoreRecordRead, ScoreSubmit, TeamFlags`, and `from tournament_server.services import qualification, team_flags`.

2. `_to_score_record_read`: replace `no_show=record.no_show, dq=record.dq,` with

```python
        teams=[TeamFlags(team_id=flag.team_id, no_show=flag.no_show, dq=flag.dq) for flag in record.teams],
```

3. Add below `SCORE_ALREADY_SUBMITTED_DETAIL`:

```python
def _validated_flags(entries: list[TeamFlags], alliance_team_ids: list[int]) -> list[TeamFlags]:
    """The flagged entries, ordered by team; 422 for a team not on the
    alliance or listed twice."""
    seen: set[int] = set()
    for entry in entries:
        if entry.team_id not in alliance_team_ids:
            raise HTTPException(status_code=422, detail=f"Team {entry.team_id} is not on this alliance.")
        if entry.team_id in seen:
            raise HTTPException(status_code=422, detail=f"Team {entry.team_id} is listed more than once.")
        seen.add(entry.team_id)
    return sorted((entry for entry in entries if entry.no_show or entry.dq), key=lambda entry: entry.team_id)
```

4. Rewrite `_overwrites_a_submitted_partner`:

```python
def _overwrites_a_submitted_partner(
    db: Session, match_id: int, alliance_id: int, data: dict
) -> bool:
    """True when another alliance on the match has a submitted (not mirrored)
    record whose data differs from `data`. A partner whose teams are all
    flagged is skipped: its data never counts toward a score."""
    partner_records = db.execute(
        select(ScoreRecord)
        .join(Alliance, Alliance.id == ScoreRecord.alliance_id)
        .where(Alliance.match_id == match_id, Alliance.id != alliance_id)
    ).scalars().all()
    return any(
        not record.mirrored
        and not team_flags.alliance_out(
            record.teams, team_flags.alliance_team_ids(db, record.alliance_id), finals=False
        )
        and json.loads(record.data_json) != data
        for record in partner_records
    )
```

5. In `submit_score`, directly after the 409 check (`if existing is not None and not existing.mirrored and role != "admin": ...`), add:

```python
    alliance_team_ids = team_flags.alliance_team_ids(db, alliance_id)
    flags = _validated_flags(payload.teams, alliance_team_ids)
    finals = match.finals_bracket_id is not None
```

6. Replace the `computed_score` block's condition `(payload.no_show or payload.dq)` with `team_flags.alliance_out(flags, alliance_team_ids, finals=finals)`.

7. Replace `mirrors = game_model == "cooperative_score" and not (payload.no_show or payload.dq)` with:

```python
    mirrors = game_model == "cooperative_score" and not team_flags.alliance_out(
        flags, alliance_team_ids, finals=False
    )
```

8. In the `existing is None` branch, drop `no_show=payload.no_show, dq=payload.dq,` from the `ScoreRecord(...)` call and, before `db.add(record)`, add:

```python
        record.teams = [ScoreRecordTeam(team_id=f.team_id, no_show=f.no_show, dq=f.dq) for f in flags]
```

9. In the `else` branch, replace `existing.no_show = payload.no_show` and `existing.dq = payload.dq` with:

```python
        # Clear and flush before adding, so re-flagging the same team never
        # meets its old row in the unique constraint.
        existing.teams.clear()
        db.flush()
        existing.teams.extend(
            ScoreRecordTeam(team_id=f.team_id, no_show=f.no_show, dq=f.dq) for f in flags
        )
```

10. In the mirroring loop's `ScoreRecord(...)` for a new mirrored copy, drop `no_show=False, dq=False,`. Mirroring into an existing record must not touch its `teams`.

- [ ] **Step 10: Rankings (alliance-level only for now)**

In `server/src/tournament_server/services/ranking.py`:

1. Add `from tournament_server.services import team_flags`.
2. Delete `_effective_score`.
3. In `_head_to_head_stats`, replace `scores.append(_effective_score(plugin, record))` with:

```python
            scores.append(
                team_flags.effective_score(plugin, record, data.team_ids[alliance.id], finals=False)
            )
```

4. In `_cooperative_records`, replace the `MatchRecord(...)` arguments `score=_effective_score(plugin, score_record), no_show=score_record.no_show, dq=score_record.dq,` with:

```python
                score=team_flags.effective_score(
                    plugin, score_record, data.team_ids[alliance.id], finals=False
                ),
                no_show=any(flag.no_show for flag in score_record.teams),
                dq=any(flag.dq for flag in score_record.teams),
```

Task 3 and Task 4 replace these with the per-team rules.

- [ ] **Step 11: Finals**

`server/src/tournament_server/routers/finals.py` (runs listing, around line 85): replace

```python
                    score = (
                        0
                        if (score_record.no_show or score_record.dq)
                        else game_plugin.module.calculate_score(json.loads(score_record.data_json))
                    )
```

with

```python
                    score = team_flags.effective_score(
                        game_plugin,
                        score_record,
                        team_flags.alliance_team_ids(db, match_alliance.id),
                        finals=True,
                    )
```

`server/src/tournament_server/services/finals.py`, in `advance_single_elimination` (around line 316) and `recompute_finals_results` (around line 393): replace each `effective_score = (0 if (score_record.no_show or score_record.dq) else game_plugin.module.calculate_score(...))` with

```python
            effective_score = team_flags.effective_score(
                game_plugin, score_record, team_flags.alliance_team_ids(db, alliance.id), finals=True
            )
```

Add `from tournament_server.services import team_flags` to both files (in `services/finals.py` use `from tournament_server.services import team_flags` only if that does not create an import cycle; otherwise `from tournament_server.services.team_flags import alliance_team_ids, effective_score` and call them directly). Remove any `json` import that is no longer used.

Run `grep -rn "\.no_show\|\.dq\b" server/src/tournament_server --include=*.py | grep -v ranking_rules | grep -v team_flags` and confirm nothing reads the removed columns (the ranking-settings `session_drop_*`/`season_drop_*` fields and `MatchRecord.no_show`/`.dq` are unrelated and stay).

- [ ] **Step 12: Convert the existing tests to `teams`**

Run `grep -rnE '"(no_show|dq)"|no_show=|dq=' server/tests` and convert every **score submission or score read** that still uses the alliance-level flags (leave ranking-settings keys such as `session_drop_dq` and raw SQL in older migration tests alone):

- `server/tests/test_scores.py`:
  - Add a helper and use it wherever a body is `{"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True}`:

    ```python
    def _no_show_body(client, match_id, alliance_id):
        """Every team on the alliance is a no-show, so the empty sheet is never scored."""
        alliance = next(
            a for a in client.get(f"/api/matches/{match_id}").json()["alliances"] if a["id"] == alliance_id
        )
        return {
            "data": {},
            "teams": [{"team_id": team_id, "no_show": True} for team_id in alliance["team_ids"]],
            "force": True,
        }
    ```

    Where the request is made with a client that cannot read matches (for example an attendee or an unadmitted device), build the body with the admin `client` first.
  - `test_no_show_zeroes_computed_score`: flag every red team as a no-show and keep the assertion `computed_score == 0`.
  - `test_a_mirrored_cooperative_copy_can_be_submitted_once_by_a_scorer`: send `"teams": [{"team_id": <blue's team>, "dq": True}]` and assert `blue.json()["teams"] == [{"team_id": <blue's team>, "no_show": False, "dq": True}]`.
  - `test_a_scorer_may_score_the_partner_of_a_disqualified_alliance`: same conversion; assert `[f.dq for f in blue_record.teams] == [True]` instead of `blue_record.dq`.
  - Get team ids from `client.get(f"/api/matches/{match_id}")`'s `alliances[*].team_ids`.
- `server/tests/test_cooperative_scoring.py`: `_setup_cooperative_match` already returns `t1, t2` (red is `[t1]`, blue is `[t2]`). Replace `"dq": True` with `"teams": [{"team_id": t2, "dq": True}]` on blue and `{"team_id": t1, ...}` on red; replace `assert red_after.json()["dq"] is False` with `assert red_after.json()["teams"] == []`; in the drop-rule test send `"teams": [{"team_id": t1, "no_show": True}] if plan["no_show"] else []`.
- `server/tests/test_season_rankings.py`: `_score_cooperative(client, second, 15, dq=True)` becomes `_score_cooperative(client, second, 15, teams=[{"team_id": t1, "dq": True}])` (red is `t1`).
- `server/tests/test_sample_cooperative_plugin.py`: `_score(sample_client, match["id"], blue, 57, dq=True)` becomes `_score(..., teams=[{"team_id": <blue's team>, "dq": True}])`, reading the team id from the match's alliances.

Each converted test keeps its original assertion about the score or ranking.

- [ ] **Step 13: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q`
Expected: PASS, including `test_alembic_drift.py`, the new migration test, `test_per_team_flags_api.py` and `test_per_team_flags_finals.py`.

- [ ] **Step 14: Commit**

```bash
git add server
git commit -m "Store DQ and no-show per team and take the flags through the score API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Head-to-head win points and strength of schedule per team

**Files:**
- Modify: `server/src/tournament_server/services/ranking.py` (`_head_to_head_stats`)
- Test: `server/tests/test_per_team_flags_ranking.py` (new)

**Interfaces:**
- Consumes: `team_flags.effective_score`, `team_flags.flagged_team_ids` (Task 1), `ScoreRecord.teams` (Task 2).
- Produces: `_head_to_head_stats(data, plugin, matches) -> dict[int, TeamStats]` with unchanged signature and key shape (`win_points`, `strength_of_schedule`).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_per_team_flags_ranking.py`:

```python
def _event(client, count):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    teams = [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, count + 1)
    ]
    return session_id, teams


def _match(client, session_id, number, red, blue):
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": number,
            "field_id": None,
            "alliances": [{"station": "red", "team_ids": red}, {"station": "blue", "team_ids": blue}],
        },
    ).json()
    return {"id": match["id"], **{a["station"]: a["id"] for a in match["alliances"]}}


def _score(client, match, station, high_balls, teams=()):
    # example-game: 3 points per high ball.
    response = client.post(
        f"/api/matches/{match['id']}/alliances/{match[station]}/score",
        json={"data": {"high_balls": high_balls, "low_balls": 0, "auto_winner": "tie"}, "teams": list(teams)},
    )
    assert response.status_code == 200, response.text


def _rows(client, session_id):
    return {
        row["team_id"]: (row["win_points"], row["strength_of_schedule"])
        for row in client.get("/api/rankings", params={"session_id": session_id}).json()
    }


def test_a_dqd_partner_gets_nothing_and_the_other_keeps_the_win(client):
    session_id, (t1, t2, t3, t4, t5, t6) = _event(client, 6)
    first = _match(client, session_id, 1, [t1, t2], [t3, t4])
    _score(client, first, "red", 10, [{"team_id": t2, "dq": True}])  # 30
    _score(client, first, "blue", 5)  # 15
    second = _match(client, session_id, 2, [t3, t4], [t5, t6])
    _score(client, second, "red", 10)
    _score(client, second, "blue", 5)

    rows = _rows(client, session_id)
    # Win points: t1 2, t2 0 (DQ'd), t3 2, t4 2 (won match 2), t5 0, t6 0.
    # Strength of schedule: t1 adds t3 + t4 = 4; t2 adds nothing from its DQ'd
    # match; t3 and t4 add t1 + t2 = 2 and t5 + t6 = 0; t5 and t6 add t3 + t4 = 4.
    assert rows == {
        t1: (2, 4.0),
        t2: (0, 0.0),
        t3: (2, 2.0),
        t4: (2, 2.0),
        t5: (0, 4.0),
        t6: (0, 4.0),
    }


def test_a_fully_flagged_alliance_loses_to_a_lower_scoresheet(client):
    session_id, (t1, t2, t3, t4) = _event(client, 4)
    match = _match(client, session_id, 1, [t1, t2], [t3, t4])
    _score(client, match, "red", 10, [{"team_id": t1, "dq": True}, {"team_id": t2, "no_show": True}])
    _score(client, match, "blue", 5)

    rows = _rows(client, session_id)
    assert rows[t3][0] == 2 and rows[t4][0] == 2
    # Flagged in their only match, t1 and t2 are still listed, with nothing.
    assert rows[t1] == (0, 0.0)
    assert rows[t2] == (0, 0.0)


def test_a_tie_with_one_flagged_team(client):
    session_id, (t1, t2, t3, t4) = _event(client, 4)
    match = _match(client, session_id, 1, [t1, t2], [t3, t4])
    _score(client, match, "red", 5, [{"team_id": t2, "no_show": True}])
    _score(client, match, "blue", 5)

    rows = _rows(client, session_id)
    assert {team: points for team, (points, _) in rows.items()} == {t1: 1, t2: 0, t3: 1, t4: 1}
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && .venv/bin/pytest tests/test_per_team_flags_ranking.py -q`
Expected: FAIL. Today every team on a side gets that side's win points, so `t2` shows 2 in the first test and 1 in the third.

- [ ] **Step 3: Implement**

Replace `_head_to_head_stats` in `server/src/tournament_server/services/ranking.py` with:

```python
def _head_to_head_stats(
    data: _ScopeData, plugin: LoadedPlugin, matches: list[Match]
) -> dict[int, TeamStats]:
    """Win points (2/1/0) and strength of schedule (opponents' win points) over `matches`.

    A team flagged DQ or no-show in a match gets no win points and no strength
    of schedule from it, but is still listed; its partners keep both.
    """
    win_points: dict[int, int] = {}
    # (team, its opponents in one match) for every match that earns the team strength of schedule.
    schedule: list[tuple[int, list[int]]] = []
    for match in matches:
        if match.status != "completed":
            continue
        alliances = data.alliances[match.id]
        if len(alliances) != 2:
            continue
        records = [data.records.get(alliance.id) for alliance in alliances]
        if any(record is None for record in records):
            continue
        sides = [data.team_ids[alliance.id] for alliance in alliances]
        scores = [
            team_flags.effective_score(plugin, record, side, finals=False)
            for record, side in zip(records, sides)
        ]
        if scores[0] > scores[1]:
            points = (2, 0)
        elif scores[1] > scores[0]:
            points = (0, 2)
        else:
            points = (1, 1)
        for index, (side, record, side_points) in enumerate(zip(sides, records, points)):
            flagged = team_flags.flagged_team_ids(record.teams)
            opponents = sides[1 - index]
            for team_id in side:
                if team_id in flagged:
                    win_points.setdefault(team_id, 0)
                    continue
                win_points[team_id] = win_points.get(team_id, 0) + side_points
                schedule.append((team_id, opponents))

    strength = {team_id: 0.0 for team_id in win_points}
    for team_id, opponents in schedule:
        strength[team_id] += sum(win_points[t] for t in opponents)
    return {
        team_id: {"win_points": win_points[team_id], "strength_of_schedule": strength[team_id]}
        for team_id in win_points
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && .venv/bin/pytest tests/test_per_team_flags_ranking.py tests/test_rankings.py tests/test_season_rankings.py -q`
Expected: PASS.

- [ ] **Step 5: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/services/ranking.py server/tests/test_per_team_flags_ranking.py
git commit -m "Give head-to-head win points and strength of schedule only to unflagged teams

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Cooperative match records per team

**Files:**
- Modify: `server/src/tournament_server/services/ranking.py` (`_cooperative_records`)
- Test: `server/tests/test_per_team_flags_ranking.py` (append)

**Interfaces:**
- Consumes: `team_flags.effective_score` (Task 1), `ScoreRecord.teams` (Task 2), `MatchRecord(match_id, session_id, score, no_show, dq)` from `services/ranking_rules.py`.
- Produces: `_cooperative_records(data, plugin, matches) -> dict[int, list[MatchRecord]]` with unchanged signature; each team now gets its own `MatchRecord`.

- [ ] **Step 1: Write the failing tests**

Append to `server/tests/test_per_team_flags_ranking.py`:

```python
from ranking_helpers import DEFAULT_SETTINGS


def _cooperative_event(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    teams = [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, 5)
    ]
    return session_id, teams


def _cooperative_score(client, match, objects, teams=()):
    # cooperative-game: 2 points per object; scoring red mirrors onto blue.
    response = client.post(
        f"/api/matches/{match['id']}/alliances/{match['red']}/score",
        json={"data": {"objects_scored": objects}, "teams": list(teams)},
    )
    assert response.status_code == 200, response.text


def _averages(client, session_id):
    return {
        row["team_id"]: row["average_score"]
        for row in client.get("/api/rankings", params={"session_id": session_id}).json()
    }


def test_a_dqd_cooperative_partner_gets_zero_and_the_other_keeps_the_score(cooperative_client):
    client = cooperative_client
    session_id, (t1, t2, t3, t4) = _cooperative_event(client)
    match = _match(client, session_id, 1, [t1, t2], [t3, t4])
    _cooperative_score(client, match, 10, [{"team_id": t2, "dq": True}])  # 20, mirrored to blue

    assert _averages(client, session_id) == {t1: 20.0, t2: 0.0, t3: 20.0, t4: 20.0}


def test_a_drop_rule_drops_only_the_flagged_teams_match(cooperative_client):
    client = cooperative_client
    session_id, (t1, t2, t3, t4) = _cooperative_event(client)
    client.put(
        "/api/ranking-settings",
        json={**DEFAULT_SETTINGS, "session_drop_mode": "lowest", "session_drop_count": 1},
    )
    matches = [_match(client, session_id, n, [t1, t2], [t3, t4]) for n in (1, 2, 3)]
    _cooperative_score(client, matches[0], 5)  # 10
    _cooperative_score(client, matches[1], 10)  # 20
    _cooperative_score(client, matches[2], 15, [{"team_id": t2, "dq": True}])  # 30, t2 DQ'd

    averages = _averages(client, session_id)
    # t1 is unflagged: 10, 20, 30, drop the lowest -> 25.
    assert averages[t1] == 25.0
    # t2 has 10, 20, 0 (DQ). DQ matches are protected while session_drop_dq is
    # off, so the 10 is dropped instead -> (20 + 0) / 2.
    assert averages[t2] == 10.0

    client.put(
        "/api/ranking-settings",
        json={**DEFAULT_SETTINGS, "session_drop_mode": "lowest", "session_drop_count": 1, "session_drop_dq": True},
    )
    averages = _averages(client, session_id)
    assert averages[t2] == 15.0  # the DQ'd 0 is dropped -> (10 + 20) / 2
    assert averages[t1] == 25.0
```

With three scheduled matches and `lowest` mode with a count of 1, each team earns its one drop once all three are scored (see `session_drops` in `services/ranking_rules.py`).

- [ ] **Step 2: Run to verify failure**

Run: `cd server && .venv/bin/pytest tests/test_per_team_flags_ranking.py -q -k cooperative`
Expected: FAIL. Today the alliance's single `MatchRecord` gives `t2` the full 20, so its average is 20.0, not 0.0.

- [ ] **Step 3: Implement**

Replace `_cooperative_records` in `server/src/tournament_server/services/ranking.py` with:

```python
def _cooperative_records(
    data: _ScopeData, plugin: LoadedPlugin, matches: list[Match]
) -> dict[int, list[MatchRecord]]:
    """One MatchRecord per team per completed match. A flagged team's record
    scores 0 and carries its own no-show/DQ flag, so the drop rules apply to
    it alone; its partners get the alliance's score with no flag."""
    records: dict[int, list[MatchRecord]] = defaultdict(list)
    for match in matches:
        if match.status != "completed":
            continue
        for alliance in data.alliances[match.id]:
            score_record = data.records.get(alliance.id)
            if score_record is None:
                continue
            team_ids = data.team_ids[alliance.id]
            score = team_flags.effective_score(plugin, score_record, team_ids, finals=False)
            flags = {flag.team_id: flag for flag in score_record.teams}
            for team_id in team_ids:
                flag = flags.get(team_id)
                records[team_id].append(
                    MatchRecord(
                        match_id=match.id,
                        session_id=match.session_id,
                        score=0 if flag is not None else score,
                        no_show=flag is not None and flag.no_show,
                        dq=flag is not None and flag.dq,
                    )
                )
    return records
```

A `ScoreRecordTeam` row always has at least one flag set (Task 2's router drops all-false entries), so `flag is not None` means the team is flagged.

- [ ] **Step 4: Run to verify pass**

Run: `cd server && .venv/bin/pytest tests/test_per_team_flags_ranking.py tests/test_cooperative_scoring.py tests/test_season_rankings.py tests/test_sample_cooperative_plugin.py -q`
Expected: PASS.

- [ ] **Step 5: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/src/tournament_server/services/ranking.py server/tests/test_per_team_flags_ranking.py
git commit -m "Build cooperative match records per team so a flag zeroes only that team

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Docs and end-to-end check

**Files:**
- Modify: `server/CLAUDE.md` (the "No-show/DQ handling" paragraph and the "Cooperative scoring" section)

**Interfaces:**
- Consumes: everything above.
- Produces: docs only.

- [ ] **Step 1: Update `server/CLAUDE.md`**

Replace the paragraph that starts `No-show/DQ handling: an alliance's effective score is` with:

```markdown
No-show/DQ handling is per team. A score record's flagged teams live in
`score_record_teams` (`ScoreRecord.teams`; only flagged teams have a row),
and the score API takes them as `teams: [{team_id, no_show, dq}]` (a team
not on the alliance, or listed twice, is a 422; unknown fields such as the
old alliance-level `no_show`/`dq` are refused). `services/team_flags.py`
owns every rule: in practice and qualification a flagged team gets nothing
from the match (no win points, no strength of schedule, a 0 in cooperative
averages) while its partners keep the score, and the alliance scores 0 only
when every team on it is flagged; in finals one DQ zeroes the alliance and a
no-show team is carried along unless every team is a no-show. This zeroing
is core-server logic, never passed into the plugin's `calculate_score()`.
```

In the "Cooperative scoring" section, update the mirroring paragraphs so they say:
- the raw scoresheet data (not the team flags or `sitting`) is mirrored, and a mirrored copy is written with no team flags; mirroring into an existing record leaves its team flags alone;
- a post-hoc ruling is a second submission to that alliance with `teams: [{team_id, dq: true}]`;
- a submission mirrors unless every team on its alliance is flagged, and the overwrite guard skips a partner whose teams are all flagged;
- cooperative ranking builds one `MatchRecord` per team, so a flagged team gets 0 for that match while its partners and the other alliance's teams keep the real score.

Keep the surrounding wording and every other rule in that section as it is.

- [ ] **Step 2: Run the whole server suite**

Run: `cd server && .venv/bin/pytest -q`
Expected: PASS.

- [ ] **Step 3: Run the Playwright suite once**

No frontend code changed, but the admin E2E tests post scores and read rankings.

Run: `cd frontend/apps/admin && npx playwright test`
Expected: PASS (every spec). If a spec fails because its score body sends a field the API now refuses, convert that body to `teams` the same way as Task 2 Step 12 and re-run.

- [ ] **Step 4: Commit**

```bash
git add server/CLAUDE.md
git commit -m "Document per-team DQ and no-show

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
