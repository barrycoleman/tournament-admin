# Match & Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an event record real head-to-head matches, submit scores through
a loaded game plugin, and compute live rankings — the first phase where the
plugin system built in Phase 2 actually gets used for something.

**Architecture:** An Event picks exactly one game plugin (immutable once
set). Matches are created directly via the API (no scheduler yet — that's a
later phase) with exactly two Alliances each, each Alliance holding one or
more Teams through a join table. Submitting a score calls the plugin's
`validate`/`calculate_score`, upserts one `ScoreRecord` per Alliance, and
triggers a ranking recompute: the core server computes win points (2/1/0)
and strength-of-schedule from completed matches, and the plugin's
`rank_teams` only handles the final sort/tiebreak. Every list/read endpoint
takes an explicit `session_id`, defaulting to the event's active session.

**Tech Stack:** Same as Phases 1-2 (Python >= 3.11, FastAPI, SQLAlchemy 2.0
sync, Pydantic v2, pytest, httpx). No new third-party dependencies.

**Spec:** `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`
(§2 active-session architecture, §3 Match/Alliance/ScoreRecord/Ranking data
model, §5.1 the plugin contract this phase actually calls).

## Global Constraints

- Never reference any real-world competition brand or product name anywhere
  in code, comments, docstrings, commit messages, file/variable/class
  names, or documentation.
- Every backend feature ships with pytest tests in the same change that
  introduces it.
- `Event.game_plugin_name` is set exactly once and is immutable afterward
  (spec: "fixed for the life of the event, since scoring rules can't
  sensibly change mid-tournament") — the endpoint that sets it must reject
  a second attempt.
- Every Match has exactly two Alliances. This targets essentially every
  real game this project cares about; it's a scoping assumption, not a
  hardcoded architectural wall — revisit if a real need for >2 alliances
  ever surfaces.
- Alliance-to-Team is a real join table (`AllianceTeam`), not a JSON array
  column, matching the project's existing pattern (e.g.
  `SessionParticipation`) — so "which matches has this team played" is a
  normal query.
- Score submission is single-step for this phase: `submitted_at` and
  `saved_at` are set together. The two-step draft/review workflow the spec
  describes is real, but the multi-referee/tablet scenario that motivates
  it doesn't exist until the device-admission phase — the `saved_at`
  column exists now so that phase won't need a migration.
- `ScoreRecord.submitted_by_device` is a plain nullable string sourced from
  the existing `X-Actor-Name`/`current_actor` audit convention, not a
  foreign key — `ScoringDevice` doesn't exist as a table until the
  device-admission phase.
- **Win-point allocation is core logic, not plugin logic.** Spec §5.1's
  prose says the plugin's `rank_teams` handles "win-point allocation," but
  the plugin interface actually built in Phase 2 (and its conformance
  tool) takes already-computed `win_points`/`strength_of_schedule` as
  input and only sorts/tiebreaks. This plan follows the interface that was
  actually built: the core server computes win points using the standard
  2/1/0 (win/tie/loss) convention and strength-of-schedule as the sum of
  opponents' current win points; `rank_teams` only orders and breaks ties.
- A Match's real-time timer state (start/pause/resume, live WebSocket
  updates) is out of scope for this phase — a Match is either
  `"scheduled"` or `"completed"` (completed once every Alliance has a
  saved `ScoreRecord`). Real-time timer control is a later phase's
  problem, once WebSockets exist.
- `field_id` is a plain string label on `Match`, not a foreign key — no
  `Field`/`FieldSet` management table has been designed yet; this is a
  deliberate simplification, not an oversight.
- No-show/DQ zeroing is applied by the core server wherever an alliance's
  effective score matters (the score-submission response and ranking
  computation): an alliance with `no_show` or `dq` set contributes `0`
  regardless of what `calculate_score` would otherwise return. The plugin
  function itself is never given those flags.

## File Structure

```
server/src/tournament_server/
  db.py                                # add utc_now() (public; consolidates duplicated _utc_now)
  deps.py                              # add get_the_event (moved from routers/event.py),
                                        #   get_session_id, get_game_plugin_for_event
  audit.py                             # modify: use db.utc_now() instead of its own _utc_now
  models/
    event.py                           # add game_plugin_name; use db.utc_now()
    match.py                           # new: Match
    alliance.py                        # new: Alliance, AllianceTeam
    score_record.py                    # new: ScoreRecord
    ranking.py                         # new: Ranking
  schemas/
    event.py                           # add GamePluginSelect; EventRead gets game_plugin_name
    match.py                           # new: MatchCreate, AllianceCreate, MatchRead, AllianceRead
    score_record.py                    # new: ScoreSubmit, ScoreRecordRead
    ranking.py                         # new: RankingRead
  routers/
    event.py                           # remove local get_the_event (moved to deps); add
                                        #   POST /api/event/game-plugin
    sessions.py, divisions.py, teams.py  # import get_the_event from deps instead of routers.event
    matches.py                         # new: POST/GET /api/matches, GET /api/matches/{id}
    scores.py                          # new: POST /api/matches/{id}/alliances/{id}/score
    rankings.py                        # new: GET /api/rankings
  services/
    __init__.py
    ranking.py                         # new: recompute_rankings()
  app.py                               # register matches/scores/rankings routers
server/tests/
  conftest.py                          # seed the example-game fixture plugin into plugins_root
  test_event.py                        # append game-plugin-selection tests
  test_matches.py                      # new
  test_scores.py                       # new
  test_rankings.py                     # new
```

---

### Task 1: Event game plugin selection

**Files:**
- Modify: `server/src/tournament_server/models/event.py`
- Modify: `server/src/tournament_server/schemas/event.py`
- Modify: `server/src/tournament_server/routers/event.py`
- Modify: `server/tests/conftest.py`
- Test: `server/tests/test_event.py` (append)

**Interfaces:**
- Produces: `Event.game_plugin_name: str | None` (nullable, set at most
  once).
- Produces route: `POST /api/event/game-plugin` (body `{"name": str}`),
  201/409/422/404 per the tests below.
- Produces: the `client` fixture now always has the `example-game` fixture
  plugin discoverable at startup (copied into the temp `plugins_root`
  before `create_app()` runs) — every later task's tests can select it via
  the real API, exactly like a real client would, instead of needing a
  separate plugin-aware fixture.

- [ ] **Step 1: Write the failing tests**

Replace `server/tests/conftest.py` in full:

```python
from __future__ import annotations

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tournament_server.app import create_app

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)


@pytest.fixture()
def client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    plugins_root = tmp_path / "plugins"
    target = plugins_root / "games" / "example-game"
    target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, target)

    app = create_app(db_path=db_path, plugins_root=str(plugins_root))
    return TestClient(app)
```

Append to `server/tests/test_event.py`:

```python
def test_select_game_plugin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert response.status_code == 200
    assert response.json()["game_plugin_name"] == "example-game"


def test_select_game_plugin_requires_event(client):
    response = client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert response.status_code == 404


def test_select_game_plugin_rejects_unknown_plugin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/event/game-plugin", json={"name": "no-such-plugin"})
    assert response.status_code == 404


def test_select_game_plugin_is_immutable(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})

    response = client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert response.status_code == 409
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_event.py -v
```

Expected: FAIL — `404 Not Found` for `/api/event/game-plugin` (route
doesn't exist yet).

- [ ] **Step 3: Implement**

Update `server/src/tournament_server/models/event.py` — add the field
(keep everything else in the file unchanged):

```python
    active_session_id: Mapped[int | None] = mapped_column(
        Integer, default=None
    )
    game_plugin_name: Mapped[str | None] = mapped_column(String(200), default=None)
    created_at: Mapped[dt.datetime] = mapped_column(
        UTCDateTime, default=_utc_now
    )
```

(That's the `active_session_id` field with the new `game_plugin_name`
field inserted directly after it, before `created_at` — the rest of the
class and its imports are unchanged.)

Update `server/src/tournament_server/schemas/event.py` — add
`game_plugin_name` to `EventRead` and a new `GamePluginSelect` schema
(keep `EventCreate` and `ActiveSessionUpdate` unchanged):

```python
class EventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    active_session_id: int | None
    game_plugin_name: str | None
    created_at: dt.datetime


class GamePluginSelect(BaseModel):
    name: str
```

Update `server/src/tournament_server/routers/event.py` — add the import
and the new route (keep everything else, including `get_the_event` and
the other three routes, unchanged):

```python
from tournament_server.schemas.event import (
    ActiveSessionUpdate,
    EventCreate,
    EventRead,
    GamePluginSelect,
)
```

```python
@router.post("/game-plugin", response_model=EventRead)
def select_game_plugin(
    payload: GamePluginSelect, request: Request, db: Session = Depends(get_db)
) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if event.game_plugin_name is not None:
        raise HTTPException(
            status_code=409,
            detail="A game plugin has already been selected for this event",
        )
    if payload.name not in request.app.state.game_plugins:
        raise HTTPException(
            status_code=404, detail=f"No game plugin named {payload.name!r} is loaded"
        )
    event.game_plugin_name = payload.name
    db.commit()
    db.refresh(event)
    return event
```

(Add `from fastapi import APIRouter, Depends, HTTPException, Request` —
just add `Request` to the existing `fastapi` import line.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS — all tests across every file, including every Phase 1/2
test (the `client` fixture change only adds a discoverable plugin; it
doesn't select one, so nothing that didn't ask for a plugin is affected).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/models/event.py server/src/tournament_server/schemas/event.py server/src/tournament_server/routers/event.py server/tests/conftest.py server/tests/test_event.py
git commit -m "$(cat <<'EOF'
Add Event game plugin selection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Shared dependencies — relocate `get_the_event`, add active-session and plugin-lookup helpers

**Files:**
- Modify: `server/src/tournament_server/deps.py`
- Modify: `server/src/tournament_server/routers/event.py`
- Modify: `server/src/tournament_server/routers/sessions.py`
- Modify: `server/src/tournament_server/routers/divisions.py`
- Modify: `server/src/tournament_server/routers/teams.py`
- Test: `server/tests/test_matches.py` (created in Task 3, exercises
  `get_session_id` indirectly through the matches endpoints — no
  standalone test file for `deps.py` itself; its behavior is exercised
  through the routers that use it, consistent with how `get_db` has never
  had its own test file either)

**Interfaces:**
- Produces: `tournament_server.deps.get_the_event(db: Session) -> Event | None`
  (identical behavior to the function of the same name previously defined
  in `routers/event.py` — this is a pure relocation, not a behavior
  change).
- Produces: `get_session_id(session_id: int | None = Query(None), db: Session = Depends(get_db)) -> int`
  — a FastAPI dependency. Returns `session_id` if given explicitly;
  otherwise returns `Event.active_session_id`; raises 404 if neither is
  available. Task 3's `list_matches` and Task 5's `get_rankings` both use
  this via `Depends(get_session_id)`.
- Produces: `get_game_plugin_for_event(request: Request, db: Session) -> LoadedGamePlugin`
  — a plain function (not a `Depends`-injected dependency, since it needs
  both `Request` and `Session` together and is only called from inside a
  couple of route bodies, not broadly reused as a parameter default).
  Raises 404 if no event exists, 422 if the event has no game plugin
  selected yet, and 500 if the event's selected plugin name somehow isn't
  currently loaded (the spec's "opening an event file on a machine
  missing that plugin fails loudly" case). Task 4 and Task 5 both call
  this directly.

This task is a mechanical refactor (move one function, update its
importers) plus two small additions — no behavior changes to anything
that already existed, so no test file needs new assertions for the
relocation itself; the existing `test_event.py`/`test_sessions.py`/
`test_divisions.py`/`test_teams.py` suites already cover
`get_the_event`'s behavior and must keep passing unchanged.

- [ ] **Step 1: Run the existing suite to confirm the starting baseline is green**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS (this is the pre-refactor baseline — there's no new
failing test to write first for a pure relocation; the safety net is
that every existing test must still pass after the move).

- [ ] **Step 2: Move `get_the_event` into `deps.py` and add the two new functions**

Replace `server/src/tournament_server/deps.py` in full:

```python
from __future__ import annotations

from typing import Iterator

from fastapi import Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.event import Event
from tournament_server.plugin_registry.loader import LoadedGamePlugin


def get_db(request: Request) -> Iterator[Session]:
    db: Session = request.app.state.session_factory()
    try:
        yield db
    finally:
        db.close()


def get_the_event(db: Session) -> Event | None:
    return db.execute(select(Event)).scalars().first()


def get_session_id(
    session_id: int | None = Query(None),
    db: Session = Depends(get_db),
) -> int:
    if session_id is not None:
        return session_id
    event = get_the_event(db)
    if event is None or event.active_session_id is None:
        raise HTTPException(
            status_code=404,
            detail="No session_id given and no active session is set",
        )
    return event.active_session_id


def get_game_plugin_for_event(request: Request, db: Session) -> LoadedGamePlugin:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if event.game_plugin_name is None:
        raise HTTPException(
            status_code=422, detail="No game plugin has been selected for this event"
        )
    plugin = request.app.state.game_plugins.get(event.game_plugin_name)
    if plugin is None:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Event's selected game plugin {event.game_plugin_name!r} "
                "is not currently loaded"
            ),
        )
    return plugin
```

- [ ] **Step 3: Update `routers/event.py` to import `get_the_event` from `deps` instead of defining it**

Replace the top of `server/src/tournament_server/routers/event.py` (the
import block and the function definition) — delete the local
`get_the_event` function entirely and import it instead:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_the_event
from tournament_server.models.event import Event
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.event import (
    ActiveSessionUpdate,
    EventCreate,
    EventRead,
    GamePluginSelect,
)

router = APIRouter(prefix="/api/event", tags=["event"])
```

(Note: `from sqlalchemy import select` is no longer needed in this file
since `get_the_event` moved out — remove that import line. Everything
from `@router.post("", ...)` onward, including the `select_game_plugin`
route added in Task 1, is unchanged.)

- [ ] **Step 4: Update the three other routers' imports**

In `server/src/tournament_server/routers/sessions.py`, change:

```python
from tournament_server.routers.event import get_the_event
```

to:

```python
from tournament_server.deps import get_the_event
```

(and merge it into the existing `from tournament_server.deps import get_db`
line so there's one `from tournament_server.deps import get_db, get_the_event`
line instead of two separate `deps`/`routers.event` import lines. Nothing
else in the file changes.)

Make the identical change (merge into the existing `deps` import, drop
the `routers.event` import) in:
- `server/src/tournament_server/routers/divisions.py`
- `server/src/tournament_server/routers/teams.py`

- [ ] **Step 5: Run tests to verify nothing broke**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS — every test, unchanged, including all of `test_event.py`,
`test_sessions.py`, `test_divisions.py`, `test_teams.py`.

- [ ] **Step 6: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/deps.py server/src/tournament_server/routers/event.py server/src/tournament_server/routers/sessions.py server/src/tournament_server/routers/divisions.py server/src/tournament_server/routers/teams.py
git commit -m "$(cat <<'EOF'
Move get_the_event to deps.py; add active-session and plugin-lookup helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Match, Alliance, and AllianceTeam models and endpoints

**Files:**
- Create: `server/src/tournament_server/models/match.py`
- Create: `server/src/tournament_server/models/alliance.py`
- Create: `server/src/tournament_server/schemas/match.py`
- Create: `server/src/tournament_server/routers/matches.py`
- Modify: `server/src/tournament_server/models/__init__.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_matches.py`

**Interfaces:**
- Consumes: `tournament_server.deps.get_db`, `.get_the_event`,
  `.get_session_id` (Task 2); `tournament_server.models.team.Team`,
  `.models.session.TournamentSession` (Phase 1).
- Produces: `tournament_server.models.match.Match` — `id, session_id,
  division_id, round_type, match_number, field_id, scheduled_time,
  status` (`status` defaults to `"scheduled"`).
- Produces: `tournament_server.models.alliance.Alliance` — `id, match_id,
  station`; `tournament_server.models.alliance.AllianceTeam` — `id,
  alliance_id, team_id`.
- Produces routes: `POST /api/matches`, `GET /api/matches`,
  `GET /api/matches/{match_id}`. Task 4's score-submission router looks
  up `Match`/`Alliance` directly (same models, no new interface needed).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_matches.py`:

```python
def _setup_two_teams(client):
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    team2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    team3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]
    team4 = client.post("/api/teams", json={"number": "4", "name": "Team Four"}).json()["id"]
    return session_id, team1, team2, team3, team4


def test_create_match_with_two_alliances(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "scheduled"
    assert len(body["alliances"]) == 2
    stations = {a["station"] for a in body["alliances"]}
    assert stations == {"red", "blue"}


def test_create_match_uses_active_session_when_omitted(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)
    client.post("/api/event/active-session", json={"session_id": session_id})

    response = client.post(
        "/api/matches",
        json={
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    )
    assert response.status_code == 201
    assert response.json()["session_id"] == session_id


def test_create_match_rejects_wrong_alliance_count(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [{"station": "red", "team_ids": [t1, t2]}],
        },
    )
    assert response.status_code == 422


def test_create_match_rejects_unknown_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [999]},
            ],
        },
    )
    assert response.status_code == 404


def test_list_matches_defaults_to_active_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)
    client.post("/api/event/active-session", json={"session_id": session_id})
    client.post(
        "/api/matches",
        json={
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    )

    response = client.get("/api/matches")
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_list_matches_with_explicit_session_id(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.get(f"/api/matches?session_id={session_id}")
    assert response.status_code == 200
    assert response.json() == []


def test_get_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)
    match_id = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()["id"]

    response = client.get(f"/api/matches/{match_id}")
    assert response.status_code == 200
    assert response.json()["id"] == match_id


def test_get_missing_match_returns_404(client):
    response = client.get("/api/matches/999")
    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_matches.py -v
```

Expected: FAIL — `404 Not Found` for `/api/matches` (route doesn't exist
yet).

- [ ] **Step 3: Implement models, schemas, and router**

Create `server/src/tournament_server/models/match.py`:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


class Match(Base):
    __tablename__ = "matches"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    round_type: Mapped[str] = mapped_column(String(20))
    match_number: Mapped[int] = mapped_column(Integer)
    field_id: Mapped[str] = mapped_column(String(50))
    scheduled_time: Mapped[dt.datetime | None] = mapped_column(
        UTCDateTime, default=None
    )
    status: Mapped[str] = mapped_column(String(20), default="scheduled")
```

Create `server/src/tournament_server/models/alliance.py`:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class Alliance(Base):
    __tablename__ = "alliances"

    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id"))
    station: Mapped[str] = mapped_column(String(20))


class AllianceTeam(Base):
    __tablename__ = "alliance_teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    alliance_id: Mapped[int] = mapped_column(ForeignKey("alliances.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
```

Create `server/src/tournament_server/schemas/match.py`:

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class AllianceCreate(BaseModel):
    station: str
    team_ids: list[int]


class AllianceRead(BaseModel):
    id: int
    station: str
    team_ids: list[int]


class MatchCreate(BaseModel):
    session_id: int | None = None
    division_id: int | None = None
    round_type: str
    match_number: int
    field_id: str
    scheduled_time: dt.datetime | None = None
    alliances: list[AllianceCreate]


class MatchRead(BaseModel):
    id: int
    session_id: int
    division_id: int | None
    round_type: str
    match_number: int
    field_id: str
    scheduled_time: dt.datetime | None
    status: str
    alliances: list[AllianceRead]
```

Create `server/src/tournament_server/routers/matches.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id, get_the_event
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.schemas.match import AllianceRead, MatchCreate, MatchRead

router = APIRouter(prefix="/api/matches", tags=["matches"])


def _to_match_read(match: Match, db: Session) -> MatchRead:
    alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match.id)
    ).scalars().all()
    alliance_reads = []
    for alliance in alliances:
        team_ids = [
            row.team_id
            for row in db.execute(
                select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
            )
            .scalars()
            .all()
        ]
        alliance_reads.append(
            AllianceRead(id=alliance.id, station=alliance.station, team_ids=team_ids)
        )
    return MatchRead(
        id=match.id,
        session_id=match.session_id,
        division_id=match.division_id,
        round_type=match.round_type,
        match_number=match.match_number,
        field_id=match.field_id,
        scheduled_time=match.scheduled_time,
        status=match.status,
        alliances=alliance_reads,
    )


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
    for alliance_payload in payload.alliances:
        for team_id in alliance_payload.team_ids:
            if db.get(Team, team_id) is None:
                raise HTTPException(
                    status_code=404, detail=f"Team {team_id} not found"
                )

    match = Match(
        session_id=session_id,
        division_id=payload.division_id,
        round_type=payload.round_type,
        match_number=payload.match_number,
        field_id=payload.field_id,
        scheduled_time=payload.scheduled_time,
    )
    db.add(match)
    db.flush()

    for alliance_payload in payload.alliances:
        alliance = Alliance(match_id=match.id, station=alliance_payload.station)
        db.add(alliance)
        db.flush()
        for team_id in alliance_payload.team_ids:
            db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))

    db.commit()
    db.refresh(match)
    return _to_match_read(match, db)


@router.get("", response_model=list[MatchRead])
def list_matches(
    session_id: int = Depends(get_session_id), db: Session = Depends(get_db)
) -> list[MatchRead]:
    matches = db.execute(
        select(Match).where(Match.session_id == session_id)
    ).scalars().all()
    return [_to_match_read(m, db) for m in matches]


@router.get("/{match_id}", response_model=MatchRead)
def get_match(match_id: int, db: Session = Depends(get_db)) -> MatchRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    return _to_match_read(match, db)
```

Update `server/src/tournament_server/models/__init__.py` — add the two
new modules' imports and `__all__` entries (keep every existing entry):

```python
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team

__all__ = [
    "Alliance",
    "AllianceTeam",
    "Division",
    "Event",
    "Match",
    "SessionParticipation",
    "TournamentSession",
    "Team",
]
```

Update `server/src/tournament_server/app.py` — add `matches` to the
router import and registration (keep everything else unchanged):

```python
from tournament_server.routers import (
    audit_log,
    divisions,
    event,
    matches,
    participation,
    plugins,
    sessions,
    teams,
)
```

```python
    app.include_router(event.router)
    app.include_router(sessions.router)
    app.include_router(divisions.router)
    app.include_router(teams.router)
    app.include_router(participation.router)
    app.include_router(audit_log.router)
    app.include_router(plugins.router)
    app.include_router(matches.router)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS (all tests across every file).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/models/match.py server/src/tournament_server/models/alliance.py server/src/tournament_server/schemas/match.py server/src/tournament_server/routers/matches.py server/src/tournament_server/models/__init__.py server/src/tournament_server/app.py server/tests/test_matches.py
git commit -m "$(cat <<'EOF'
Add Match/Alliance/AllianceTeam models and endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: ScoreRecord model and score submission endpoint

**Files:**
- Modify: `server/src/tournament_server/db.py` (add `utc_now()`)
- Modify: `server/src/tournament_server/models/event.py` (use `db.utc_now`)
- Modify: `server/src/tournament_server/audit.py` (use `db.utc_now`)
- Create: `server/src/tournament_server/models/score_record.py`
- Create: `server/src/tournament_server/schemas/score_record.py`
- Create: `server/src/tournament_server/routers/scores.py`
- Modify: `server/src/tournament_server/models/__init__.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_scores.py`

**Interfaces:**
- Consumes: `tournament_server.deps.get_game_plugin_for_event` (Task 2);
  `tournament_server.models.match.Match`,
  `.models.alliance.Alliance` (Task 3).
- Produces: `tournament_server.db.utc_now() -> dt.datetime` — a public
  replacement for the two previously-duplicated private `_utc_now()`
  functions in `models/event.py` and `audit.py`.
- Produces: `tournament_server.models.score_record.ScoreRecord` — `id,
  alliance_id, plugin_name, plugin_version, data_json, no_show, dq,
  sitting, submitted_by_device, submitted_at, saved_at`. One row per
  Alliance (unique constraint on `alliance_id`); resubmitting updates the
  existing row rather than creating a new one — full history of any
  change is already captured by the existing audit log.
- Produces route: `POST /api/matches/{match_id}/alliances/{alliance_id}/score`.
  Task 5's ranking service reads `ScoreRecord` rows directly (same model,
  no new interface needed).

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_scores.py`:

```python
def _setup_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    t3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]
    t4 = client.post("/api/teams", json={"number": "4", "name": "Team Four"}).json()["id"]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    return match["id"], red_id, blue_id


def test_submit_score(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}},
        headers={"X-Actor-Name": "shifty-squirrel"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["computed_score"] == 5 * 3 + 2 * 1
    assert body["submitted_by_device"] == "shifty-squirrel"
    assert body["saved_at"] is not None


def test_resubmitting_score_updates_existing_record(client):
    match_id, red_id, blue_id = _setup_match(client)
    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}},
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 17

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "scheduled"  # blue alliance hasn't scored yet


def test_submit_score_rejects_out_of_range_violations(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 999, "low_balls": 0, "auto_winner": "tie"}},
    )
    assert response.status_code == 422


def test_submit_score_force_overrides_violations(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={
            "data": {"high_balls": 999, "low_balls": 0, "auto_winner": "tie"},
            "force": True,
        },
    )
    assert response.status_code == 200


def test_no_show_zeroes_computed_score(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={
            "data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"},
            "no_show": True,
        },
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 0


def test_match_marked_completed_once_both_alliances_scored(client):
    match_id, red_id, blue_id = _setup_match(client)
    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match_id}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 1, "auto_winner": "tie"}},
    )

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "completed"


def test_submit_score_requires_game_plugin_selected(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red_id = match["alliances"][0]["id"]

    response = client.post(
        f"/api/matches/{match['id']}/alliances/{red_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0}},
    )
    assert response.status_code == 422
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_scores.py -v
```

Expected: FAIL — `404 Not Found` for the score-submission route (doesn't
exist yet).

- [ ] **Step 3: Implement**

Update `server/src/tournament_server/db.py` — add `utc_now()` (add the
`import datetime as dt` usage the file already has via `UTCDateTime`;
insert this function right after the `UTCDateTime` class, before
`make_engine`):

```python
def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)
```

Update `server/src/tournament_server/models/event.py` — replace the
private copy with the shared one:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    active_session_id: Mapped[int | None] = mapped_column(
        Integer, default=None
    )
    game_plugin_name: Mapped[str | None] = mapped_column(String(200), default=None)
    created_at: Mapped[dt.datetime] = mapped_column(
        UTCDateTime, default=utc_now
    )
```

(This removes the local `def _utc_now(): return dt.datetime.now(dt.UTC)`
function entirely and uses the imported `utc_now` in its place — the
`game_plugin_name` field from Task 1 stays exactly as it was.)

Update `server/src/tournament_server/audit.py` — same substitution.
Change the import line:

```python
from tournament_server.db import Base, UTCDateTime, utc_now
```

Delete the local function:

```python
def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)
```

And replace both of its call sites (`AuditLog.timestamp`'s
`default=_utc_now` and `_write_audit_row`'s `timestamp=_utc_now()`) with
`utc_now`/`utc_now()` respectively. Nothing else in the file changes.

Create `server/src/tournament_server/models/score_record.py`:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import Boolean, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class ScoreRecord(Base):
    __tablename__ = "score_records"
    __table_args__ = (
        UniqueConstraint("alliance_id", name="uq_score_record_alliance"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    alliance_id: Mapped[int] = mapped_column(ForeignKey("alliances.id"))
    plugin_name: Mapped[str] = mapped_column(String(200))
    plugin_version: Mapped[str] = mapped_column(String(50))
    data_json: Mapped[str] = mapped_column(Text)
    no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    dq: Mapped[bool] = mapped_column(Boolean, default=False)
    sitting: Mapped[bool] = mapped_column(Boolean, default=False)
    submitted_by_device: Mapped[str | None] = mapped_column(String(200), default=None)
    submitted_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    saved_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
```

Create `server/src/tournament_server/schemas/score_record.py`:

```python
from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel


class ScoreSubmit(BaseModel):
    data: dict[str, Any]
    no_show: bool = False
    dq: bool = False
    sitting: bool = False
    force: bool = False


class ScoreRecordRead(BaseModel):
    id: int
    alliance_id: int
    plugin_name: str
    plugin_version: str
    data: dict[str, Any]
    no_show: bool
    dq: bool
    sitting: bool
    submitted_by_device: str | None
    submitted_at: dt.datetime
    saved_at: dt.datetime | None
    computed_score: int
```

Create `server/src/tournament_server/routers/scores.py`:

```python
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import audit
from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_game_plugin_for_event
from tournament_server.models.alliance import Alliance
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.schemas.score_record import ScoreRecordRead, ScoreSubmit

router = APIRouter(prefix="/api/matches", tags=["scores"])


def _to_score_record_read(record: ScoreRecord, computed_score: int) -> ScoreRecordRead:
    return ScoreRecordRead(
        id=record.id,
        alliance_id=record.alliance_id,
        plugin_name=record.plugin_name,
        plugin_version=record.plugin_version,
        data=json.loads(record.data_json),
        no_show=record.no_show,
        dq=record.dq,
        sitting=record.sitting,
        submitted_by_device=record.submitted_by_device,
        submitted_at=record.submitted_at,
        saved_at=record.saved_at,
        computed_score=computed_score,
    )


@router.post("/{match_id}/alliances/{alliance_id}/score", response_model=ScoreRecordRead)
def submit_score(
    match_id: int,
    alliance_id: int,
    payload: ScoreSubmit,
    request: Request,
    db: Session = Depends(get_db),
) -> ScoreRecordRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    alliance = db.get(Alliance, alliance_id)
    if alliance is None or alliance.match_id != match_id:
        raise HTTPException(status_code=404, detail="Alliance not found on this match")

    plugin = get_game_plugin_for_event(request, db)

    violations = plugin.module.validate(payload.data)
    if violations and not payload.force:
        raise HTTPException(status_code=422, detail={"violations": violations})

    now = utc_now()
    existing = db.execute(
        select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)
    ).scalars().first()

    if existing is None:
        record = ScoreRecord(
            alliance_id=alliance_id,
            plugin_name=plugin.name,
            plugin_version=plugin.version,
            data_json=json.dumps(payload.data),
            no_show=payload.no_show,
            dq=payload.dq,
            sitting=payload.sitting,
            submitted_by_device=audit.current_actor.get(),
            submitted_at=now,
            saved_at=now,
        )
        db.add(record)
    else:
        existing.data_json = json.dumps(payload.data)
        existing.no_show = payload.no_show
        existing.dq = payload.dq
        existing.sitting = payload.sitting
        existing.submitted_by_device = audit.current_actor.get()
        existing.submitted_at = now
        existing.saved_at = now
        record = existing

    db.commit()
    db.refresh(record)

    all_alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match_id)
    ).scalars().all()
    scored_alliance_ids = {
        row.alliance_id
        for row in db.execute(
            select(ScoreRecord).where(
                ScoreRecord.alliance_id.in_([a.id for a in all_alliances])
            )
        ).scalars().all()
    }
    if len(scored_alliance_ids) == len(all_alliances):
        match.status = "completed"
        db.commit()

    computed_score = (
        0
        if (record.no_show or record.dq)
        else plugin.module.calculate_score(payload.data)
    )
    return _to_score_record_read(record, computed_score)
```

Update `server/src/tournament_server/models/__init__.py` — add
`ScoreRecord`:

```python
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team

__all__ = [
    "Alliance",
    "AllianceTeam",
    "Division",
    "Event",
    "Match",
    "ScoreRecord",
    "SessionParticipation",
    "TournamentSession",
    "Team",
]
```

Update `server/src/tournament_server/app.py` — add `scores` to the
router import and registration:

```python
from tournament_server.routers import (
    audit_log,
    divisions,
    event,
    matches,
    participation,
    plugins,
    scores,
    sessions,
    teams,
)
```

```python
    app.include_router(matches.router)
    app.include_router(scores.router)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS (all tests across every file).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/db.py server/src/tournament_server/models/event.py server/src/tournament_server/audit.py server/src/tournament_server/models/score_record.py server/src/tournament_server/schemas/score_record.py server/src/tournament_server/routers/scores.py server/src/tournament_server/models/__init__.py server/src/tournament_server/app.py server/tests/test_scores.py
git commit -m "$(cat <<'EOF'
Add ScoreRecord model and score submission endpoint

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Ranking computation and endpoint

**Files:**
- Create: `server/src/tournament_server/models/ranking.py`
- Create: `server/src/tournament_server/schemas/ranking.py`
- Create: `server/src/tournament_server/services/__init__.py` (empty)
- Create: `server/src/tournament_server/services/ranking.py`
- Create: `server/src/tournament_server/routers/rankings.py`
- Modify: `server/src/tournament_server/routers/scores.py` (wire in the
  recompute call)
- Modify: `server/src/tournament_server/models/__init__.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_rankings.py`

**Interfaces:**
- Consumes: `tournament_server.deps.get_session_id`,
  `.get_game_plugin_for_event` (Task 2); `tournament_server.models.match.Match`,
  `.models.alliance.Alliance`, `.models.alliance.AllianceTeam` (Task 3);
  `tournament_server.models.score_record.ScoreRecord` (Task 4).
- Produces: `tournament_server.models.ranking.Ranking` — `id, session_id,
  division_id, team_id, win_points, strength_of_schedule, rank`.
- Produces: `tournament_server.services.ranking.recompute_rankings(db: Session, plugin: LoadedGamePlugin, session_id: int, division_id: int | None) -> None`.
  Task 4's `submit_score` calls this after every save.
- Produces route: `GET /api/rankings`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_rankings.py`:

```python
def _score(client, match_id, alliance_id, high_balls, low_balls):
    return client.post(
        f"/api/matches/{match_id}/alliances/{alliance_id}/score",
        json={
            "data": {
                "high_balls": high_balls,
                "low_balls": low_balls,
                "auto_winner": "tie",
            }
        },
    )


def test_rankings_reflect_win_points_and_strength_of_schedule(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    team_ids = {}
    for number in ["1", "2", "3", "4"]:
        team = client.post(
            "/api/teams", json={"number": number, "name": f"Team {number}"}
        ).json()
        team_ids[number] = team["id"]
    t1, t2, t3, t4 = team_ids["1"], team_ids["2"], team_ids["3"], team_ids["4"]

    tiebreaker_seeds = {
        number: client.get(f"/api/teams/{team_id}").json()["tiebreaker_seed"]
        for number, team_id in team_ids.items()
    }

    # Match 1: (T1,T2) vs (T3,T4), red wins 50-20.
    match1 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    red1 = next(a["id"] for a in match1["alliances"] if a["station"] == "red")
    blue1 = next(a["id"] for a in match1["alliances"] if a["station"] == "blue")
    _score(client, match1["id"], red1, high_balls=16, low_balls=2)  # 50
    _score(client, match1["id"], blue1, high_balls=6, low_balls=2)  # 20

    # Match 2: (T1,T3) vs (T2,T4), red wins 40-10.
    match2 = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 2,
            "field_id": "Field 1",
            "alliances": [
                {"station": "red", "team_ids": [t1, t3]},
                {"station": "blue", "team_ids": [t2, t4]},
            ],
        },
    ).json()
    red2 = next(a["id"] for a in match2["alliances"] if a["station"] == "red")
    blue2 = next(a["id"] for a in match2["alliances"] if a["station"] == "blue")
    _score(client, match2["id"], red2, high_balls=13, low_balls=1)  # 40
    _score(client, match2["id"], blue2, high_balls=3, low_balls=1)  # 10

    # Hand-computed expectations:
    # win_points: T1=4 (won both), T2=2 (won m1, lost m2),
    #             T3=2 (lost m1, won m2), T4=0 (lost both)
    # strength_of_schedule: sum of opponents' final win_points per match
    #   T1: m1 opp(T3,T4)=2+0=2, m2 opp(T2,T4)=2+0=2 -> 4
    #   T2: m1 opp(T3,T4)=2+0=2, m2 opp(T1,T3)=4+2=6 -> 8
    #   T3: m1 opp(T1,T2)=4+2=6, m2 opp(T2,T4)=2+0=2 -> 8
    #   T4: m1 opp(T1,T2)=4+2=6, m2 opp(T1,T3)=4+2=6 -> 12
    expected = {
        t1: {"win_points": 4, "strength_of_schedule": 4.0},
        t2: {"win_points": 2, "strength_of_schedule": 8.0},
        t3: {"win_points": 2, "strength_of_schedule": 8.0},
        t4: {"win_points": 0, "strength_of_schedule": 12.0},
    }

    response = client.get(f"/api/rankings?session_id={session_id}")
    assert response.status_code == 200
    rows = {row["team_id"]: row for row in response.json()}

    for team_id, exp in expected.items():
        assert rows[team_id]["win_points"] == exp["win_points"]
        assert rows[team_id]["strength_of_schedule"] == exp["strength_of_schedule"]

    # Replicate the example plugin's own sort key to compute the expected
    # rank order deterministically, regardless of the random tiebreaker
    # seeds actually assigned to these teams.
    id_to_number = {v: k for k, v in team_ids.items()}
    expected_order = sorted(
        expected.keys(),
        key=lambda tid: (
            -expected[tid]["win_points"],
            -expected[tid]["strength_of_schedule"],
            -tiebreaker_seeds[id_to_number[tid]],
        ),
    )
    actual_order = sorted(rows.keys(), key=lambda tid: rows[tid]["rank"])
    assert actual_order == expected_order
    assert [rows[tid]["rank"] for tid in actual_order] == [1, 2, 3, 4]


def test_rankings_default_to_active_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    client.post("/api/event/active-session", json={"session_id": session_id})

    response = client.get("/api/rankings")
    assert response.status_code == 200
    assert response.json() == []
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/test_rankings.py -v
```

Expected: FAIL — `404 Not Found` for `/api/rankings` (route doesn't exist
yet).

- [ ] **Step 3: Implement**

Create `server/src/tournament_server/models/ranking.py`:

```python
from __future__ import annotations

from sqlalchemy import Float, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


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

(Note: the `UniqueConstraint` doesn't fully protect the `division_id IS
NULL` case — SQLite treats each `NULL` as distinct for uniqueness
purposes, so it's defense-in-depth for the non-null case only. The
service function below does its own explicit lookup-before-insert, which
is what actually prevents duplicate rows in the `division_id IS NULL`
case; this is a known, accepted limitation, not a fix to make here.)

Create `server/src/tournament_server/schemas/ranking.py`:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class RankingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    session_id: int
    division_id: int | None
    team_id: int
    win_points: int
    strength_of_schedule: float
    rank: int
```

Create `server/src/tournament_server/services/__init__.py` (empty file).

Create `server/src/tournament_server/services/ranking.py`:

```python
from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedGamePlugin


def recompute_rankings(
    db: Session, plugin: LoadedGamePlugin, session_id: int, division_id: int | None
) -> None:
    query = select(Match).where(
        Match.session_id == session_id, Match.status == "completed"
    )
    if division_id is None:
        query = query.where(Match.division_id.is_(None))
    else:
        query = query.where(Match.division_id == division_id)
    matches = db.execute(query).scalars().all()

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

Create `server/src/tournament_server/routers/rankings.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id
from tournament_server.models.ranking import Ranking
from tournament_server.schemas.ranking import RankingRead

router = APIRouter(prefix="/api/rankings", tags=["rankings"])


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

Update `server/src/tournament_server/routers/scores.py` — add the
recompute call. Add this import at the top:

```python
from tournament_server.services.ranking import recompute_rankings
```

And in `submit_score`, right after the `if len(scored_alliance_ids) ==
len(all_alliances): ... db.commit()` block (i.e., after the
match-completion check, before the `computed_score = ...` line at the
end of the function), add:

```python
    recompute_rankings(db, plugin, match.session_id, match.division_id)
```

Update `server/src/tournament_server/models/__init__.py` — add `Ranking`:

```python
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team

__all__ = [
    "Alliance",
    "AllianceTeam",
    "Division",
    "Event",
    "Match",
    "Ranking",
    "ScoreRecord",
    "SessionParticipation",
    "TournamentSession",
    "Team",
]
```

Update `server/src/tournament_server/app.py` — add `rankings`:

```python
from tournament_server.routers import (
    audit_log,
    divisions,
    event,
    matches,
    participation,
    plugins,
    rankings,
    scores,
    sessions,
    teams,
)
```

```python
    app.include_router(scores.router)
    app.include_router(rankings.router)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS (all tests across every file).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src/tournament_server/models/ranking.py server/src/tournament_server/schemas/ranking.py server/src/tournament_server/services server/src/tournament_server/routers/rankings.py server/src/tournament_server/routers/scores.py server/src/tournament_server/models/__init__.py server/src/tournament_server/app.py server/tests/test_rankings.py
git commit -m "$(cat <<'EOF'
Add ranking computation and GET /api/rankings

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Docs and final verification

**Files:**
- Modify: `server/CLAUDE.md`

**Interfaces:**
- Consumes: nothing new — this task documents Tasks 1-5's output.
- Produces: nothing new for later tasks to consume; it's documentation.

- [ ] **Step 1: Add a "Match & scoring" section to `server/CLAUDE.md`**

Insert this new section right after the existing "## Plugin system"
section and before "## Known, deliberate gaps in this phase":

```markdown
## Match & scoring

An Event selects exactly one game plugin via `POST /api/event/game-plugin`
— immutable once set. A Match always has exactly two Alliances (created
together via `POST /api/matches`), each holding one or more Teams through
the `alliance_teams` join table. `POST /api/matches/{id}/alliances/{id}/score`
runs the event's plugin's `validate()` (blocking on violations unless
`force: true` is passed) and stores the raw scoresheet as JSON — an
alliance's actual score is always *derived* via `calculate_score()`, never
stored redundantly, so it can never go stale relative to the plugin's
logic. A Match becomes `"completed"` once every Alliance has a saved
`ScoreRecord`, which triggers a ranking recompute for its session/division.

Win-point allocation (2/1/0 for win/tie/loss) and strength-of-schedule
(sum of opponents' current win points) are computed by the core server,
not the plugin — see `services/ranking.py`. The plugin's `rank_teams()`
only receives those pre-computed numbers plus each team's
`tiebreaker_seed` and handles the final sort/tiebreak. This is narrower
than the design spec's §5.1 prose ("win-point allocation" as something
`rank_teams` does), but matches the plugin interface actually built and
tested in Phase 2 — see that phase's plan for the reasoning.

Every list/read endpoint that's scoped to a session (`GET /api/matches`,
`GET /api/rankings`) takes an explicit `session_id` query parameter,
defaulting to `Event.active_session_id` via the shared
`deps.get_session_id` dependency when omitted.

No-show/DQ handling: an alliance's effective score is `0` wherever it
matters (the score-submission response, ranking computation) when its
`ScoreRecord.no_show` or `.dq` is set — this zeroing is core-server logic,
never passed into the plugin's `calculate_score()`.
```

- [ ] **Step 2: Run the full test suite one final time**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
.venv/bin/pytest tests/ -v
```

Expected: PASS — every test from every task in this plan, all green,
alongside every Phase 1/2 test still passing unchanged.

- [ ] **Step 3: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/CLAUDE.md
git commit -m "$(cat <<'EOF'
Document match & scoring in server/CLAUDE.md

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
