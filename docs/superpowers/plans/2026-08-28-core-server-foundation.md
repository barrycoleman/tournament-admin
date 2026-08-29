# Core Server Foundation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a running FastAPI server with a real SQLite-backed data
model (Event/Session/Division/Team/SessionParticipation), basic CRUD REST
endpoints for each, and a comprehensive, automatic audit log — the
foundation every later phase (plugins, scoring, scheduling, devices,
real-time) builds on.

**Architecture:** One FastAPI process per event, one SQLite file per
event, SQLAlchemy 2.0 declarative models accessed synchronously (no
WebSockets or async DB work yet — that lands in a later phase). Every
mutation is captured automatically via SQLAlchemy mapper-level events
(`after_insert`/`after_update`/`after_delete`) writing directly to an
`audit_log` table, so no endpoint has to remember to log anything by hand.

**Tech Stack:** Python >= 3.11, FastAPI, Uvicorn, SQLAlchemy 2.0
(synchronous), Pydantic v2, pytest, httpx (for FastAPI's `TestClient`).

**Spec:** `docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`

## Global Constraints

- Never reference any real-world competition brand or product name
  anywhere in code, comments, docstrings, commit messages, file/variable/
  class names, or documentation — describe behavior in neutral/generic
  terms even when it happens to match a closed-source reference product.
- One SQLite file = one Event; this server process manages exactly one
  Event for its whole lifetime (no multi-event listing/routing).
- Every mutation must be captured in the audit log automatically via the
  SQLAlchemy mapper-event mechanism built in Task 7 — never via ad hoc
  manual logging calls added to individual endpoints.
- Every backend feature ships with pytest tests in the same change that
  introduces it — a task is not done until its tests exist and pass.
- Team's `tiebreaker_seed` is a random value committed once at team
  creation, never recomputed later, so re-ranking stays reproducible.
- This plan deliberately simplifies one thing relative to the spec's
  prose: a Team belongs to at most one Division (`Team.division_id`,
  nullable), not a many-to-many relationship. The spec didn't mandate
  many-to-many; this keeps Phase 1 YAGNI-compliant. Revisit only if a
  real need for a team to span multiple divisions in one event surfaces.
- There is no real authentication system yet (out of scope for this
  plan). Every request may optionally carry an `X-Actor-Name` header
  identifying who's making the change, defaulting to `"admin"` when
  absent, purely so the audit log has something meaningful to record.
  This is a deliberate, documented stand-in — not a security boundary —
  until a real identity/admission system exists (Device/ScoringDevice
  admission is a later phase; a general admin-auth story is a gap this
  plan does not attempt to close).

## File Structure

```
server/
  pyproject.toml
  .gitignore
  README.md
  CLAUDE.md
  src/
    tournament_server/
      __init__.py
      settings.py         # Settings dataclass (DB path)
      db.py                # Base, engine/session factory helpers, init_db
      deps.py              # FastAPI DB-session dependency
      audit.py             # AuditLog model + actor contextvar + mapper-event hooks
      app.py               # create_app() factory: wires DB, middleware, routers
      main.py              # module-level `app` + `run()` entrypoint for local dev
      models/
        __init__.py         # imports every model so metadata sees all tables
        event.py
        session.py
        division.py
        team.py
        participation.py
      schemas/
        __init__.py
        event.py
        session.py
        division.py
        team.py
        participation.py
        audit.py
      routers/
        __init__.py
        event.py
        sessions.py
        divisions.py
        teams.py
        participation.py
        audit_log.py
  tests/
    conftest.py
    test_health.py
    test_event.py
    test_sessions.py
    test_divisions.py
    test_teams.py
    test_participation.py
    test_audit_log.py
```

Each model file owns exactly one table. Each router file owns exactly one
resource's endpoints. `audit.py` is the one place that knows how audit
logging works; every other file is oblivious to it.

---

### Task 1: Project scaffolding, DB wiring, and a health check

**Files:**
- Create: `server/pyproject.toml`
- Create: `server/.gitignore`
- Create: `server/src/tournament_server/__init__.py`
- Create: `server/src/tournament_server/settings.py`
- Create: `server/src/tournament_server/db.py`
- Create: `server/src/tournament_server/deps.py`
- Create: `server/src/tournament_server/app.py`
- Create: `server/src/tournament_server/main.py`
- Create: `server/tests/conftest.py`
- Test: `server/tests/test_health.py`

**Interfaces:**
- Produces: `tournament_server.settings.Settings` (dataclass with
  `db_path: str`, classmethod `Settings.from_env() -> Settings`).
- Produces: `tournament_server.db.Base` (SQLAlchemy `DeclarativeBase`
  subclass all models inherit from), `tournament_server.db.make_engine(db_path: str) -> Engine`,
  `tournament_server.db.make_session_factory(engine: Engine) -> sessionmaker`,
  `tournament_server.db.init_db(engine: Engine) -> None`.
- Produces: `tournament_server.deps.get_db(request: Request) -> Iterator[Session]`
  (FastAPI dependency; reads `request.app.state.session_factory`).
- Produces: `tournament_server.app.create_app(db_path: str | None = None) -> FastAPI`
  — every later task adds a router registration inside this function.
- Produces: the `tests/conftest.py` `client` fixture (`FastAPI TestClient`
  bound to a fresh temp-file SQLite DB per test) — every later test file
  uses this fixture.

- [ ] **Step 1: Create the project skeleton**

```bash
mkdir -p /home/barry/src/barrycoleman/tournament-admin/server/src/tournament_server/models
mkdir -p /home/barry/src/barrycoleman/tournament-admin/server/src/tournament_server/schemas
mkdir -p /home/barry/src/barrycoleman/tournament-admin/server/src/tournament_server/routers
mkdir -p /home/barry/src/barrycoleman/tournament-admin/server/tests
touch /home/barry/src/barrycoleman/tournament-admin/server/src/tournament_server/__init__.py
touch /home/barry/src/barrycoleman/tournament-admin/server/src/tournament_server/models/__init__.py
touch /home/barry/src/barrycoleman/tournament-admin/server/src/tournament_server/schemas/__init__.py
touch /home/barry/src/barrycoleman/tournament-admin/server/src/tournament_server/routers/__init__.py
```

Create `server/pyproject.toml`:

```toml
[project]
name = "tournament-server"
version = "0.1.0"
description = "Core tournament management server"
requires-python = ">=3.11"
dependencies = [
    "fastapi>=0.115,<1.0",
    "uvicorn[standard]>=0.32,<1.0",
    "sqlalchemy>=2.0,<3.0",
    "pydantic>=2.9,<3.0",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.3,<9.0",
    "httpx>=0.27,<1.0",
]

[build-system]
requires = ["setuptools>=68", "wheel"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
where = ["src"]

[tool.pytest.ini_options]
testpaths = ["tests"]
```

Create `server/.gitignore`:

```
.venv/
__pycache__/
*.pyc
*.db
.pytest_cache/
*.egg-info/
```

- [ ] **Step 2: Create a virtualenv and install the package in editable mode**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Expected: installs cleanly with no errors (there's no real code yet, but
the package metadata is enough for `pip install -e` to succeed).

- [ ] **Step 3: Write the failing test**

Create `server/tests/conftest.py`:

```python
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from tournament_server.app import create_app


@pytest.fixture()
def client(tmp_path) -> TestClient:
    db_path = str(tmp_path / "test.db")
    app = create_app(db_path=db_path)
    return TestClient(app)
```

Create `server/tests/test_health.py`:

```python
def test_health_check(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/test_health.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'tournament_server.app'`
(or similar import error), since `app.py` doesn't exist yet.

- [ ] **Step 5: Implement settings, db, deps, and the app factory**

Create `server/src/tournament_server/settings.py`:

```python
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    db_path: str = "./tournament.db"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(db_path=os.environ.get("TOURNAMENT_DB_PATH", "./tournament.db"))
```

Create `server/src/tournament_server/db.py`:

```python
from __future__ import annotations

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, sessionmaker


class Base(DeclarativeBase):
    pass


def make_engine(db_path: str) -> Engine:
    return create_engine(
        f"sqlite:///{db_path}",
        connect_args={"check_same_thread": False},
    )


def make_session_factory(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def init_db(engine: Engine) -> None:
    Base.metadata.create_all(engine)
```

Create `server/src/tournament_server/deps.py`:

```python
from __future__ import annotations

from typing import Iterator

from fastapi import Request
from sqlalchemy.orm import Session


def get_db(request: Request) -> Iterator[Session]:
    db: Session = request.app.state.session_factory()
    try:
        yield db
    finally:
        db.close()
```

Create `server/src/tournament_server/app.py`:

```python
from __future__ import annotations

from fastapi import FastAPI

from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.settings import Settings


def create_app(db_path: str | None = None) -> FastAPI:
    settings = Settings(db_path=db_path) if db_path else Settings.from_env()
    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    init_db(engine)

    app = FastAPI(title="Tournament Server")
    app.state.session_factory = session_factory

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
```

Create `server/src/tournament_server/main.py`:

```python
from __future__ import annotations

import uvicorn

from tournament_server.app import create_app

app = create_app()


def run() -> None:
    uvicorn.run(app, host="127.0.0.1", port=8000)


if __name__ == "__main__":
    run()
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/test_health.py -v
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/pyproject.toml server/.gitignore server/src server/tests
git commit -m "$(cat <<'EOF'
Scaffold core server: app factory, DB wiring, health check

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Event model and endpoints

**Files:**
- Create: `server/src/tournament_server/models/event.py`
- Create: `server/src/tournament_server/schemas/event.py`
- Create: `server/src/tournament_server/routers/event.py`
- Modify: `server/src/tournament_server/models/__init__.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_event.py`

**Interfaces:**
- Consumes: `tournament_server.db.Base` (Task 1).
- Produces: `tournament_server.models.event.Event` — columns `id: int`,
  `name: str`, `active_session_id: int | None`, `created_at: datetime`.
  Later tasks (Session, Team, participation routers) query this via
  `db.execute(select(Event)).scalars().first()` to find "the" event.
- Produces: `EventCreate(name: str)`, `EventRead`, `ActiveSessionUpdate(session_id: int)`
  Pydantic schemas.
- Produces routes: `POST /api/event`, `GET /api/event`,
  `POST /api/event/active-session`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_event.py`:

```python
def test_create_event(client):
    response = client.post("/api/event", json={"name": "Regional Qualifier"})
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Regional Qualifier"
    assert body["active_session_id"] is None


def test_create_event_twice_fails(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/event", json={"name": "Another Event"})
    assert response.status_code == 409


def test_get_event_before_creation_returns_404(client):
    response = client.get("/api/event")
    assert response.status_code == 404


def test_get_event_after_creation(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.get("/api/event")
    assert response.status_code == 200
    assert response.json()["name"] == "Regional Qualifier"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/test_event.py -v
```

Expected: FAIL — `404 Not Found` for `/api/event` (route doesn't exist
yet; FastAPI returns 404 for unregistered routes, which will make the
`test_create_event` assertion `assert response.status_code == 201` fail).

- [ ] **Step 3: Implement the model, schemas, and router**

Create `server/src/tournament_server/models/event.py`:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    # No ForeignKey to sessions.id: at this point in the plan the sessions
    # table doesn't exist yet in Base.metadata, and Base.metadata.create_all()
    # raises NoReferencedTableError for a FK targeting a table absent from
    # the same metadata (verified empirically during Task 2's review) — this
    # is not a limitation to lift once Task 3 lands, it's the permanent
    # design. Referential integrity is enforced in application code instead
    # (see set_active_session in routers/event.py, which validates the
    # session exists and belongs to this event before assigning it).
    active_session_id: Mapped[int | None] = mapped_column(Integer, default=None)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, default=dt.datetime.utcnow
    )
```

Create `server/src/tournament_server/schemas/event.py`:

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict


class EventCreate(BaseModel):
    name: str


class EventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    active_session_id: int | None
    created_at: dt.datetime


class ActiveSessionUpdate(BaseModel):
    session_id: int
```

Create `server/src/tournament_server/routers/event.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.event import Event
from tournament_server.schemas.event import ActiveSessionUpdate, EventCreate, EventRead

router = APIRouter(prefix="/api/event", tags=["event"])


def get_the_event(db: Session) -> Event | None:
    return db.execute(select(Event)).scalars().first()


@router.post("", response_model=EventRead, status_code=201)
def create_event(payload: EventCreate, db: Session = Depends(get_db)) -> Event:
    if get_the_event(db) is not None:
        raise HTTPException(status_code=409, detail="Event already initialized")
    event = Event(name=payload.name)
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@router.get("", response_model=EventRead)
def read_event(db: Session = Depends(get_db)) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    return event


@router.post("/active-session", response_model=EventRead)
def set_active_session(
    payload: ActiveSessionUpdate, db: Session = Depends(get_db)
) -> Event:
    from tournament_server.models.session import TournamentSession

    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    session_obj = db.get(TournamentSession, payload.session_id)
    if session_obj is None or session_obj.event_id != event.id:
        raise HTTPException(status_code=404, detail="Session not found")
    event.active_session_id = session_obj.id
    db.commit()
    db.refresh(event)
    return event
```

Note: `TournamentSession` is imported inside the function body (not at
module top) because it doesn't exist until Task 3 — this avoids a
circular/missing-module import error while Task 2 is implemented on its
own. Once Task 3 lands, this still works fine; there's no need to move
the import later.

Update `server/src/tournament_server/models/__init__.py`:

```python
from tournament_server.models.event import Event

__all__ = ["Event"]
```

Update `server/src/tournament_server/app.py` — add the model import (so
`init_db` sees the `events` table) and register the router:

```python
from __future__ import annotations

from fastapi import FastAPI

from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.routers import event
from tournament_server.settings import Settings


def create_app(db_path: str | None = None) -> FastAPI:
    settings = Settings(db_path=db_path) if db_path else Settings.from_env()
    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    init_db(engine)

    app = FastAPI(title="Tournament Server")
    app.state.session_factory = session_factory

    app.include_router(event.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/test_event.py tests/test_health.py -v
```

Expected: PASS (all tests in both files).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src server/tests/test_event.py
git commit -m "$(cat <<'EOF'
Add Event model and endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Session model, endpoints, and active-session wiring

**Files:**
- Create: `server/src/tournament_server/models/session.py`
- Create: `server/src/tournament_server/schemas/session.py`
- Create: `server/src/tournament_server/routers/sessions.py`
- Modify: `server/src/tournament_server/models/__init__.py`
- Modify: `server/src/tournament_server/routers/event.py` (move the
  `TournamentSession` import to module level now that it exists)
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_sessions.py`

**Interfaces:**
- Consumes: `tournament_server.models.event.Event` (Task 2).
- Produces: `tournament_server.models.session.TournamentSession` —
  columns `id: int`, `event_id: int`, `label: str`,
  `session_date: date | None`. Named `TournamentSession` (not `Session`)
  to avoid clashing with SQLAlchemy's own `Session` class. Table name is
  `sessions`. Later tasks (Division, Team's session-scoped features,
  participation) reference `TournamentSession.id` as a foreign key target.
- Produces: `SessionCreate(label, session_date)`, `SessionRead` schemas.
- Produces routes: `POST /api/sessions`, `GET /api/sessions`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_sessions.py`:

```python
def test_create_and_list_sessions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/sessions", json={"label": "Session 1"})
    assert response.status_code == 201
    session_id = response.json()["id"]

    list_response = client.get("/api/sessions")
    assert list_response.status_code == 200
    labels = [s["label"] for s in list_response.json()]
    assert labels == ["Session 1"]
    assert list_response.json()[0]["id"] == session_id


def test_create_session_requires_event(client):
    response = client.post("/api/sessions", json={"label": "Session 1"})
    assert response.status_code == 404


def test_set_active_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.post("/api/event/active-session", json={"session_id": session_id})
    assert response.status_code == 200
    assert response.json()["active_session_id"] == session_id


def test_set_active_session_rejects_unknown_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/event/active-session", json={"session_id": 999})
    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/test_sessions.py -v
```

Expected: FAIL — `404 Not Found` for `/api/sessions` (route doesn't exist
yet).

- [ ] **Step 3: Implement the model, schemas, and router**

Create `server/src/tournament_server/models/session.py`:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import Date, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class TournamentSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    label: Mapped[str] = mapped_column(String(200))
    session_date: Mapped[dt.date | None] = mapped_column(Date, default=None)
```

Create `server/src/tournament_server/schemas/session.py`:

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict


class SessionCreate(BaseModel):
    label: str
    session_date: dt.date | None = None


class SessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    label: str
    session_date: dt.date | None
```

Create `server/src/tournament_server/routers/sessions.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.session import TournamentSession
from tournament_server.routers.event import get_the_event
from tournament_server.schemas.session import SessionCreate, SessionRead

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=SessionRead, status_code=201)
def create_session(
    payload: SessionCreate, db: Session = Depends(get_db)
) -> TournamentSession:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    session_obj = TournamentSession(
        event_id=event.id, label=payload.label, session_date=payload.session_date
    )
    db.add(session_obj)
    db.commit()
    db.refresh(session_obj)
    return session_obj


@router.get("", response_model=list[SessionRead])
def list_sessions(db: Session = Depends(get_db)) -> list[TournamentSession]:
    return list(db.execute(select(TournamentSession)).scalars().all())
```

Replace the full contents of `server/src/tournament_server/routers/event.py`
with this (the only change from Task 2 is moving the `TournamentSession`
import from inside `set_active_session` to the top of the file, now that
the module it points to exists):

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.event import Event
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.event import ActiveSessionUpdate, EventCreate, EventRead

router = APIRouter(prefix="/api/event", tags=["event"])


def get_the_event(db: Session) -> Event | None:
    return db.execute(select(Event)).scalars().first()


@router.post("", response_model=EventRead, status_code=201)
def create_event(payload: EventCreate, db: Session = Depends(get_db)) -> Event:
    if get_the_event(db) is not None:
        raise HTTPException(status_code=409, detail="Event already initialized")
    event = Event(name=payload.name)
    db.add(event)
    db.commit()
    db.refresh(event)
    return event


@router.get("", response_model=EventRead)
def read_event(db: Session = Depends(get_db)) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    return event


@router.post("/active-session", response_model=EventRead)
def set_active_session(
    payload: ActiveSessionUpdate, db: Session = Depends(get_db)
) -> Event:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    session_obj = db.get(TournamentSession, payload.session_id)
    if session_obj is None or session_obj.event_id != event.id:
        raise HTTPException(status_code=404, detail="Session not found")
    event.active_session_id = session_obj.id
    db.commit()
    db.refresh(event)
    return event
```

Update `server/src/tournament_server/models/__init__.py`:

```python
from tournament_server.models.event import Event
from tournament_server.models.session import TournamentSession

__all__ = ["Event", "TournamentSession"]
```

Update `server/src/tournament_server/app.py` — register the new router:

```python
from tournament_server.routers import event, sessions
```

and

```python
    app.include_router(event.router)
    app.include_router(sessions.router)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/ -v
```

Expected: PASS (all tests across every file so far).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src server/tests/test_sessions.py
git commit -m "$(cat <<'EOF'
Add Session model, endpoints, and active-session wiring

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Division model and endpoints

**Files:**
- Create: `server/src/tournament_server/models/division.py`
- Create: `server/src/tournament_server/schemas/division.py`
- Create: `server/src/tournament_server/routers/divisions.py`
- Modify: `server/src/tournament_server/models/__init__.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_divisions.py`

**Interfaces:**
- Consumes: `tournament_server.models.event.Event` (Task 2).
- Produces: `tournament_server.models.division.Division` — columns
  `id: int`, `event_id: int`, `name: str`. Task 5 (Team) references
  `Division.id` as a nullable foreign key.
- Produces: `DivisionCreate(name)`, `DivisionRead` schemas.
- Produces routes: `POST /api/divisions`, `GET /api/divisions`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_divisions.py`:

```python
def test_create_and_list_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 201
    division_id = response.json()["id"]

    list_response = client.get("/api/divisions")
    assert list_response.status_code == 200
    assert list_response.json()[0]["id"] == division_id
    assert list_response.json()[0]["name"] == "Elementary"


def test_create_division_requires_event(client):
    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/test_divisions.py -v
```

Expected: FAIL — `404 Not Found` for `/api/divisions`.

- [ ] **Step 3: Implement the model, schemas, and router**

Create `server/src/tournament_server/models/division.py`:

```python
from __future__ import annotations

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class Division(Base):
    __tablename__ = "divisions"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    name: Mapped[str] = mapped_column(String(200))
```

Create `server/src/tournament_server/schemas/division.py`:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class DivisionCreate(BaseModel):
    name: str


class DivisionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    name: str
```

Create `server/src/tournament_server/routers/divisions.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.division import Division
from tournament_server.routers.event import get_the_event
from tournament_server.schemas.division import DivisionCreate, DivisionRead

router = APIRouter(prefix="/api/divisions", tags=["divisions"])


@router.post("", response_model=DivisionRead, status_code=201)
def create_division(
    payload: DivisionCreate, db: Session = Depends(get_db)
) -> Division:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    division = Division(event_id=event.id, name=payload.name)
    db.add(division)
    db.commit()
    db.refresh(division)
    return division


@router.get("", response_model=list[DivisionRead])
def list_divisions(db: Session = Depends(get_db)) -> list[Division]:
    return list(db.execute(select(Division)).scalars().all())
```

Update `server/src/tournament_server/models/__init__.py`:

```python
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.session import TournamentSession

__all__ = ["Division", "Event", "TournamentSession"]
```

Update `server/src/tournament_server/app.py`:

```python
from tournament_server.routers import divisions, event, sessions
```

and

```python
    app.include_router(event.router)
    app.include_router(sessions.router)
    app.include_router(divisions.router)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/ -v
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src server/tests/test_divisions.py
git commit -m "$(cat <<'EOF'
Add Division model and endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Team model and endpoints

**Files:**
- Create: `server/src/tournament_server/models/team.py`
- Create: `server/src/tournament_server/schemas/team.py`
- Create: `server/src/tournament_server/routers/teams.py`
- Modify: `server/src/tournament_server/models/__init__.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_teams.py`

**Interfaces:**
- Consumes: `tournament_server.models.event.Event` (Task 2),
  `tournament_server.models.division.Division` (Task 4).
- Produces: `tournament_server.models.team.Team` — columns `id: int`,
  `event_id: int`, `division_id: int | None`, `number: str`, `name: str`,
  `organization: str | None`, `city: str | None`, `state: str | None`,
  `country: str | None`, `tiebreaker_seed: int` (auto-generated,
  read-only). Later phases (Match/Alliance/ScoreRecord) reference
  `Team.id`.
- Produces: `generate_tiebreaker_seed() -> int` helper (a plain function,
  not tied to any request context — later tests can call it directly if
  needed).
- Produces: `TeamCreate`, `TeamUpdate` (all fields optional, for partial
  PATCH), `TeamRead` schemas.
- Produces routes: `POST /api/teams`, `GET /api/teams`,
  `GET /api/teams/{team_id}`, `PATCH /api/teams/{team_id}`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_teams.py`:

```python
def test_create_team_assigns_tiebreaker_seed(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "organization": "Example School"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["number"] == "1234A"
    assert body["organization"] == "Example School"
    assert isinstance(body["tiebreaker_seed"], int)


def test_create_team_requires_event(client):
    response = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    assert response.status_code == 404


def test_list_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    client.post("/api/teams", json={"number": "5678B", "name": "Circuit Breakers"})

    response = client.get("/api/teams")
    assert response.status_code == 200
    numbers = {t["number"] for t in response.json()}
    assert numbers == {"1234A", "5678B"}


def test_get_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.get(f"/api/teams/{team_id}")
    assert response.status_code == 200
    assert response.json()["number"] == "1234A"


def test_get_missing_team_returns_404(client):
    response = client.get("/api/teams/999")
    assert response.status_code == 404


def test_update_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"name": "Robo Raiders Renamed"})
    assert response.status_code == 200
    assert response.json()["name"] == "Robo Raiders Renamed"
    assert response.json()["number"] == "1234A"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/test_teams.py -v
```

Expected: FAIL — `404 Not Found` for `/api/teams` (route doesn't exist
yet).

- [ ] **Step 3: Implement the model, schemas, and router**

Create `server/src/tournament_server/models/team.py`:

```python
from __future__ import annotations

import random

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


def generate_tiebreaker_seed() -> int:
    return random.randint(1, 1_000_000_000)


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    number: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(200))
    organization: Mapped[str | None] = mapped_column(String(200), default=None)
    city: Mapped[str | None] = mapped_column(String(200), default=None)
    state: Mapped[str | None] = mapped_column(String(100), default=None)
    country: Mapped[str | None] = mapped_column(String(100), default=None)
    tiebreaker_seed: Mapped[int] = mapped_column(default=generate_tiebreaker_seed)
```

Create `server/src/tournament_server/schemas/team.py`:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class TeamCreate(BaseModel):
    number: str
    name: str
    organization: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    division_id: int | None = None


class TeamUpdate(BaseModel):
    number: str | None = None
    name: str | None = None
    organization: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    division_id: int | None = None


class TeamRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    division_id: int | None
    number: str
    name: str
    organization: str | None
    city: str | None
    state: str | None
    country: str | None
    tiebreaker_seed: int
```

Create `server/src/tournament_server/routers/teams.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.team import Team
from tournament_server.routers.event import get_the_event
from tournament_server.schemas.team import TeamCreate, TeamRead, TeamUpdate

router = APIRouter(prefix="/api/teams", tags=["teams"])


@router.post("", response_model=TeamRead, status_code=201)
def create_team(payload: TeamCreate, db: Session = Depends(get_db)) -> Team:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    team = Team(event_id=event.id, **payload.model_dump())
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


@router.get("", response_model=list[TeamRead])
def list_teams(db: Session = Depends(get_db)) -> list[Team]:
    return list(db.execute(select(Team)).scalars().all())


@router.get("/{team_id}", response_model=TeamRead)
def get_team(team_id: int, db: Session = Depends(get_db)) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    return team


@router.patch("/{team_id}", response_model=TeamRead)
def update_team(
    team_id: int, payload: TeamUpdate, db: Session = Depends(get_db)
) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(team, key, value)
    db.commit()
    db.refresh(team)
    return team
```

Update `server/src/tournament_server/models/__init__.py`:

```python
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team

__all__ = ["Division", "Event", "TournamentSession", "Team"]
```

Update `server/src/tournament_server/app.py`:

```python
from tournament_server.routers import divisions, event, sessions, teams
```

and

```python
    app.include_router(event.router)
    app.include_router(sessions.router)
    app.include_router(divisions.router)
    app.include_router(teams.router)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/ -v
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src server/tests/test_teams.py
git commit -m "$(cat <<'EOF'
Add Team model and endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: SessionParticipation model and endpoints

**Files:**
- Create: `server/src/tournament_server/models/participation.py`
- Create: `server/src/tournament_server/schemas/participation.py`
- Create: `server/src/tournament_server/routers/participation.py`
- Modify: `server/src/tournament_server/models/__init__.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_participation.py`

**Interfaces:**
- Consumes: `tournament_server.models.session.TournamentSession` (Task 3),
  `tournament_server.models.team.Team` (Task 5).
- Produces: `tournament_server.models.participation.SessionParticipation`
  — columns `id: int`, `session_id: int`, `team_id: int`,
  `checked_in: bool`.
- Produces: `ParticipationCreate(team_id, checked_in)`,
  `ParticipationRead` schemas.
- Produces routes: `POST /api/sessions/{session_id}/participants`,
  `GET /api/sessions/{session_id}/participants`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_participation.py`:

```python
def test_check_in_team_for_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
    )
    assert response.status_code == 201
    assert response.json()["team_id"] == team_id
    assert response.json()["checked_in"] is True


def test_list_participants(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]
    client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": False},
    )

    response = client.get(f"/api/sessions/{session_id}/participants")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["team_id"] == team_id


def test_check_in_requires_existing_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.post(
        "/api/sessions/999/participants", json={"team_id": team_id}
    )
    assert response.status_code == 404


def test_check_in_requires_existing_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.post(
        f"/api/sessions/{session_id}/participants", json={"team_id": 999}
    )
    assert response.status_code == 404
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/test_participation.py -v
```

Expected: FAIL — `404 Not Found` for the participants routes (they don't
exist yet, so this fails for the wrong reason on every test, including
the ones that expect 404 for a different reason — confirm by reading the
response body/detail message, which will be FastAPI's generic
"Not Found" rather than this router's own `HTTPException` details).

- [ ] **Step 3: Implement the model, schemas, and router**

Create `server/src/tournament_server/models/participation.py`:

```python
from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class SessionParticipation(Base):
    __tablename__ = "session_participation"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    checked_in: Mapped[bool] = mapped_column(Boolean, default=False)
```

Create `server/src/tournament_server/schemas/participation.py`:

```python
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ParticipationCreate(BaseModel):
    team_id: int
    checked_in: bool = False


class ParticipationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    team_id: int
    checked_in: bool
```

Create `server/src/tournament_server/routers/participation.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.schemas.participation import (
    ParticipationCreate,
    ParticipationRead,
)

router = APIRouter(prefix="/api/sessions", tags=["participation"])


@router.post(
    "/{session_id}/participants", response_model=ParticipationRead, status_code=201
)
def add_participant(
    session_id: int, payload: ParticipationCreate, db: Session = Depends(get_db)
) -> SessionParticipation:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    team = db.get(Team, payload.team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    participation = SessionParticipation(
        session_id=session_id, team_id=payload.team_id, checked_in=payload.checked_in
    )
    db.add(participation)
    db.commit()
    db.refresh(participation)
    return participation


@router.get(
    "/{session_id}/participants", response_model=list[ParticipationRead]
)
def list_participants(
    session_id: int, db: Session = Depends(get_db)
) -> list[SessionParticipation]:
    return list(
        db.execute(
            select(SessionParticipation).where(
                SessionParticipation.session_id == session_id
            )
        )
        .scalars()
        .all()
    )
```

Update `server/src/tournament_server/models/__init__.py`:

```python
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team

__all__ = [
    "Division",
    "Event",
    "SessionParticipation",
    "TournamentSession",
    "Team",
]
```

Update `server/src/tournament_server/app.py`:

```python
from tournament_server.routers import divisions, event, participation, sessions, teams
```

and

```python
    app.include_router(event.router)
    app.include_router(sessions.router)
    app.include_router(divisions.router)
    app.include_router(teams.router)
    app.include_router(participation.router)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/ -v
```

Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src server/tests/test_participation.py
git commit -m "$(cat <<'EOF'
Add SessionParticipation model and endpoints

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Comprehensive audit log

**Files:**
- Create: `server/src/tournament_server/audit.py`
- Create: `server/src/tournament_server/schemas/audit.py`
- Create: `server/src/tournament_server/routers/audit_log.py`
- Modify: `server/src/tournament_server/app.py`
- Test: `server/tests/test_audit_log.py`

**Interfaces:**
- Consumes: `tournament_server.db.Base` (Task 1); implicitly covers every
  model defined in Tasks 2–6 since it hooks at the `Base` level with
  `propagate=True`, not per-model.
- Produces: `tournament_server.audit.AuditLog` — columns `id: int`,
  `timestamp: datetime`, `table_name: str`, `row_pk: int | None`,
  `action: str` (`"insert" | "update" | "delete"`), `actor: str`,
  `before_json: str | None`, `after_json: str | None`.
- Produces: `tournament_server.audit.current_actor` — a
  `contextvars.ContextVar[str]` (default `"system"`) that
  `app.py`'s request middleware sets from the `X-Actor-Name` header
  (default `"admin"` when the header is absent).
- Produces: `tournament_server.audit.register_audit_hooks() -> None` —
  called once at module import time; nothing else needs to call it.
- Produces: `AuditLogRead` schema with classmethod
  `AuditLogRead.from_orm_obj(obj: AuditLog) -> AuditLogRead` (parses the
  JSON text columns into real `dict`s for the API response).
- Produces route: `GET /api/audit-log`.

- [ ] **Step 1: Write the failing tests**

Create `server/tests/test_audit_log.py`:

```python
def test_creating_event_logs_insert_with_default_actor(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.get("/api/audit-log")
    assert response.status_code == 200
    entries = response.json()
    event_entries = [e for e in entries if e["table_name"] == "events" and e["action"] == "insert"]
    assert len(event_entries) == 1
    assert event_entries[0]["actor"] == "admin"
    assert event_entries[0]["before"] is None
    assert event_entries[0]["after"]["name"] == "Regional Qualifier"


def test_creating_team_logs_insert_with_custom_actor(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders"},
        headers={"X-Actor-Name": "shifty-squirrel"},
    )
    team_id = response.json()["id"]

    entries = client.get("/api/audit-log").json()
    team_entries = [
        e for e in entries if e["table_name"] == "teams" and e["action"] == "insert"
    ]
    assert len(team_entries) == 1
    entry = team_entries[0]
    assert entry["row_pk"] == team_id
    assert entry["actor"] == "shifty-squirrel"
    assert entry["after"]["number"] == "1234A"


def test_updating_team_logs_before_and_after(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    client.patch(f"/api/teams/{team_id}", json={"name": "Renamed Raiders"})

    entries = client.get("/api/audit-log").json()
    update_entries = [
        e for e in entries if e["table_name"] == "teams" and e["action"] == "update"
    ]
    assert len(update_entries) == 1
    entry = update_entries[0]
    assert entry["before"]["name"] == "Robo Raiders"
    assert entry["after"]["name"] == "Renamed Raiders"
    # Unrelated fields shouldn't appear in the diff.
    assert "number" not in entry["before"]


def test_patch_with_no_changes_logs_nothing(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    before_count = len(client.get("/api/audit-log").json())
    client.patch(f"/api/teams/{team_id}", json={})
    after_count = len(client.get("/api/audit-log").json())

    assert before_count == after_count
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/test_audit_log.py -v
```

Expected: FAIL — `404 Not Found` for `/api/audit-log` (route doesn't
exist yet).

- [ ] **Step 3: Implement the audit model, hooks, schema, and router**

Create `server/src/tournament_server/audit.py`:

```python
from __future__ import annotations

import contextvars
import datetime as dt
import json
from typing import Any

from sqlalchemy import DateTime, Integer, String, Text, event, insert
from sqlalchemy.orm import Mapped, Mapper, mapped_column
from sqlalchemy.orm.attributes import get_history

from tournament_server.db import Base

current_actor: contextvars.ContextVar[str] = contextvars.ContextVar(
    "current_actor", default="system"
)

# Guards against ever recursively auditing the audit table itself. In
# practice audit rows are only ever written via the raw `connection.execute`
# calls below (never through `session.add(AuditLog(...))`), so this can't
# currently trigger — it's cheap insurance against a future change that
# adds an ORM-level write to this table.
_EXCLUDED_TABLES = {"audit_log"}


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    timestamp: Mapped[dt.datetime] = mapped_column(
        DateTime, default=dt.datetime.utcnow
    )
    table_name: Mapped[str] = mapped_column(String(100))
    row_pk: Mapped[int | None] = mapped_column(Integer, default=None)
    action: Mapped[str] = mapped_column(String(20))
    actor: Mapped[str] = mapped_column(String(200))
    before_json: Mapped[str | None] = mapped_column(Text, default=None)
    after_json: Mapped[str | None] = mapped_column(Text, default=None)


def _to_jsonable(value: Any) -> Any:
    if isinstance(value, (dt.datetime, dt.date)):
        return value.isoformat()
    return value


def _serialize_all_columns(target: Any, mapper: Mapper) -> dict[str, Any]:
    return {
        col.key: _to_jsonable(getattr(target, col.key)) for col in mapper.columns
    }


def _write_audit_row(
    connection: Any,
    table_name: str,
    row_pk: int | None,
    action: str,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> None:
    connection.execute(
        insert(AuditLog.__table__).values(
            timestamp=dt.datetime.utcnow(),
            table_name=table_name,
            row_pk=row_pk,
            action=action,
            actor=current_actor.get(),
            before_json=json.dumps(before) if before is not None else None,
            after_json=json.dumps(after) if after is not None else None,
        )
    )


def _after_insert(mapper: Mapper, connection: Any, target: Any) -> None:
    if mapper.local_table.name in _EXCLUDED_TABLES:
        return
    pk = mapper.primary_key_from_instance(target)[0]
    after = _serialize_all_columns(target, mapper)
    _write_audit_row(connection, mapper.local_table.name, pk, "insert", None, after)


def _after_update(mapper: Mapper, connection: Any, target: Any) -> None:
    if mapper.local_table.name in _EXCLUDED_TABLES:
        return
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    for col in mapper.columns:
        history = get_history(target, col.key)
        if not history.has_changes():
            continue
        if history.deleted:
            before[col.key] = _to_jsonable(history.deleted[0])
        if history.added:
            after[col.key] = _to_jsonable(history.added[0])
    if not before and not after:
        return
    pk = mapper.primary_key_from_instance(target)[0]
    _write_audit_row(connection, mapper.local_table.name, pk, "update", before, after)


def _after_delete(mapper: Mapper, connection: Any, target: Any) -> None:
    if mapper.local_table.name in _EXCLUDED_TABLES:
        return
    pk = mapper.primary_key_from_instance(target)[0]
    before = _serialize_all_columns(target, mapper)
    _write_audit_row(connection, mapper.local_table.name, pk, "delete", before, None)


def register_audit_hooks() -> None:
    event.listen(Base, "after_insert", _after_insert, propagate=True)
    event.listen(Base, "after_update", _after_update, propagate=True)
    event.listen(Base, "after_delete", _after_delete, propagate=True)


register_audit_hooks()
```

Create `server/src/tournament_server/schemas/audit.py`:

```python
from __future__ import annotations

import datetime as dt
import json
from typing import Any

from pydantic import BaseModel

from tournament_server.audit import AuditLog


class AuditLogRead(BaseModel):
    id: int
    timestamp: dt.datetime
    table_name: str
    row_pk: int | None
    action: str
    actor: str
    before: dict[str, Any] | None
    after: dict[str, Any] | None

    @classmethod
    def from_orm_obj(cls, obj: AuditLog) -> "AuditLogRead":
        return cls(
            id=obj.id,
            timestamp=obj.timestamp,
            table_name=obj.table_name,
            row_pk=obj.row_pk,
            action=obj.action,
            actor=obj.actor,
            before=json.loads(obj.before_json) if obj.before_json else None,
            after=json.loads(obj.after_json) if obj.after_json else None,
        )
```

Create `server/src/tournament_server/routers/audit_log.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.audit import AuditLog
from tournament_server.deps import get_db
from tournament_server.schemas.audit import AuditLogRead

router = APIRouter(prefix="/api/audit-log", tags=["audit-log"])


@router.get("", response_model=list[AuditLogRead])
def list_audit_log(db: Session = Depends(get_db)) -> list[AuditLogRead]:
    rows = db.execute(select(AuditLog).order_by(AuditLog.id)).scalars().all()
    return [AuditLogRead.from_orm_obj(row) for row in rows]
```

Update `server/src/tournament_server/app.py` — import `audit` (so its
table is registered and its hooks activate), add the request middleware
that sets `current_actor`, and register the new router:

```python
from __future__ import annotations

from fastapi import FastAPI, Request

from tournament_server import audit  # noqa: F401  (registers AuditLog + hooks)
from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.routers import audit_log, divisions, event, participation, sessions, teams
from tournament_server.settings import Settings


def create_app(db_path: str | None = None) -> FastAPI:
    settings = Settings(db_path=db_path) if db_path else Settings.from_env()
    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    init_db(engine)

    app = FastAPI(title="Tournament Server")
    app.state.session_factory = session_factory

    @app.middleware("http")
    async def actor_middleware(request: Request, call_next):
        token = audit.current_actor.set(request.headers.get("x-actor-name", "admin"))
        try:
            return await call_next(request)
        finally:
            audit.current_actor.reset(token)

    app.include_router(event.router)
    app.include_router(sessions.router)
    app.include_router(divisions.router)
    app.include_router(teams.router)
    app.include_router(participation.router)
    app.include_router(audit_log.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/ -v
```

Expected: PASS (all tests across every file).

- [ ] **Step 5: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/src server/tests/test_audit_log.py
git commit -m "$(cat <<'EOF'
Add comprehensive audit log via SQLAlchemy mapper events

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Scoped CLAUDE.md, README, and full-suite verification

**Files:**
- Create: `server/CLAUDE.md`
- Create: `server/README.md`

**Interfaces:**
- Consumes: nothing new — this task documents Tasks 1–7's output.
- Produces: nothing new for later tasks to consume; it's documentation.

- [ ] **Step 1: Write `server/CLAUDE.md`**

```markdown
# Server-specific instructions

This is the core tournament server: FastAPI + SQLAlchemy 2.0 + SQLite,
one process and one database file per event. The full architecture is in
`../docs/superpowers/specs/2026-08-28-core-server-plugin-architecture-design.md`;
the root `../CLAUDE.md` has the project-wide constraints (no brand names,
mandatory testing policy) that apply here too.

## Local development

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest tests/ -v
python -m tournament_server.main   # runs the dev server on 127.0.0.1:8000
```

## Layout

- `models/` — one SQLAlchemy model per file, one table each.
- `schemas/` — Pydantic request/response schemas, one file per resource,
  matching the `models/` file it serves.
- `routers/` — one FastAPI `APIRouter` per resource.
- `audit.py` — the only place that knows how audit logging works. It
  hooks in generically via SQLAlchemy mapper events
  (`after_insert`/`after_update`/`after_delete` on `Base`, with
  `propagate=True`), so a new model defined anywhere automatically gets
  audited — nothing needs to call into `audit.py` by hand.
- `db.py` — the SQLAlchemy `Base`, engine/session-factory helpers, and
  `init_db()`. Every model module does `from tournament_server.db import Base`.

## Known, deliberate gaps in this phase

- There's no real authentication yet. Requests can pass an
  `X-Actor-Name` header to identify who's making a change (used only for
  the audit log); it defaults to `"admin"`. Don't mistake this for a
  security boundary — anyone can claim to be anyone. A real
  identity/admission system is a later phase (Device/ScoringDevice
  admission is designed in the spec but not implemented in this plan).
- A Team belongs to at most one Division (nullable `division_id`), not a
  many-to-many relationship, as a deliberate YAGNI simplification — see
  the plan's Global Constraints for why.
- No Alembic/migrations yet — schema changes go through
  `Base.metadata.create_all()`, which only adds new tables, never alters
  existing ones. Introduce real migrations before the schema needs to
  change on a database that already has real event data in it.

## Testing

Every test in `tests/` uses the `client` fixture from `conftest.py`,
which builds a fresh `FastAPI` app against a fresh temp-file SQLite
database per test — never a shared or mocked database. Follow that
pattern for new tests: real HTTP calls through `TestClient`, a real
(temporary) SQLite file underneath.
```

- [ ] **Step 2: Write `server/README.md`**

```markdown
# Core tournament server

A free, self-hostable tournament management server. See
`../docs/superpowers/specs/` for the full design.

## Requirements

- Python 3.11 or newer

## Setup

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

## Run the tests

```bash
pytest tests/ -v
```

## Run the dev server

```bash
python -m tournament_server.main
```

Then, in another terminal:

```bash
curl http://127.0.0.1:8000/health
# {"status":"ok"}
```

By default the server creates/uses `./tournament.db` in the current
directory. Override with the `TOURNAMENT_DB_PATH` environment variable:

```bash
TOURNAMENT_DB_PATH=/path/to/my-event.db python -m tournament_server.main
```
```

- [ ] **Step 3: Run the full test suite one final time**

```bash
cd /home/barry/src/barrycoleman/tournament-admin/server
source .venv/bin/activate
pytest tests/ -v
```

Expected: PASS — every test from every task in this plan, all green.

- [ ] **Step 4: Commit**

```bash
cd /home/barry/src/barrycoleman/tournament-admin
git add server/CLAUDE.md server/README.md
git commit -m "$(cat <<'EOF'
Add server-scoped CLAUDE.md and README

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
