# Scoring Device Admission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let scoring tablets/phones self-register, be admin-admitted, and
gate/attribute score submission by real device identity — layered on top
of (not replacing) the role-based auth system already built.

**Architecture:** A new `ScoringDevice` table holds one row per
self-registered browser, identified by a hashed, browser-stored
`device_token` and a friendly adjective-animal name. A new
`require_admitted_device` FastAPI dependency, applied only to
`POST /api/matches/{id}/alliances/{id}/score` alongside the existing
`require_scorer_or_referee` role gate, rejects any non-admin caller whose
device isn't currently admitted; `admin` bypasses only the rejection,
never the identity lookup, so attribution stays accurate either way.
Admission status has no stored enum — it's computed lazily from
`admitted_at`/`last_seen_at` at every point of use, mirroring how
`AuthSession` already handles expiry, with a lightweight middleware
keeping `last_seen_at` current across any request a device makes.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + SQLite (existing stack). No new
dependencies.

**Spec:**
`docs/superpowers/specs/2026-09-08-scoring-device-admission-design.md`
(read this in full before starting).

## Global Constraints

- No real-world competition brand or product name anywhere in code,
  comments, docs, file/variable/class names, or user-facing text (root
  `CLAUDE.md`).
- Every backend feature ships with pytest unit tests in the same change
  (root `CLAUDE.md` testing policy) — every task below ends with a test
  run.
- Scope is `ScoringDevice` only — `Device`/Pi-display admission is a
  separate, later phase and is not touched by this plan (spec §1).
- `POST /api/devices/register` takes no `Authorization` header at all — a
  fifth bootstrap exception alongside `POST`/`GET /api/event` and
  `POST /api/auth/login`/`refresh` (spec §3).
- `admin` bypasses only `require_admitted_device`'s *rejection*, never its
  *lookup* — a present, currently-admitted device token still attributes
  `submitted_by_device` correctly even for an admin caller (spec §4-§5).
  Get this exactly right; it's the one subtle behavior in this plan.
- No stored admission-status enum, no background job — "currently
  admitted" is always computed at the point of use from
  `admitted_at`/`last_seen_at` (spec §2). This project has no job
  scheduler.
- Idle timeout default 60 minutes, configurable via
  `TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES` (spec §7) — an ordinary
  config value, not structural.
- This is a schema change with no real deployed event data to migrate;
  per this project's existing convention (`server/CLAUDE.md`), delete the
  local `.db` file and let `Base.metadata.create_all()` rebuild it — no
  Alembic, no migration script.
- **Spec correction (found during planning):** the design spec originally
  said the activity middleware touches `last_seen_at` on *every* request
  bearing `X-Device-Token`. That's wrong — it would let an idle device
  silently revive its own admission by attempting (and failing) a
  request, contradicting the "requiring one-click re-admission" goal. The
  spec (§5) and this plan (Task 3) now both require the touch to happen
  only on a *successful* (status `< 400`) response, and require
  `POST /api/devices/{id}/admit` (Task 3) to also refresh `last_seen_at`,
  not just `admitted_at`. Get this exactly right — Task 4's tests are the
  regression guard for it.

---

## Task 1: Data model — `ScoringDevice`, config, audit exclusion

**Files:**
- Create: `src/tournament_server/models/scoring_device.py`
- Modify: `src/tournament_server/models/__init__.py`
- Modify: `src/tournament_server/audit.py`
- Modify: `src/tournament_server/settings.py`
- Test: `tests/test_device_models.py`

**Interfaces:**
- Produces: `ScoringDevice(id, friendly_name: str, device_token_hash: str,
  registered_at: dt.datetime, admitted_at: dt.datetime | None, admitted_by:
  str | None, last_seen_at: dt.datetime)` — importable from
  `tournament_server.models.scoring_device` and from
  `tournament_server.models`. `Settings.device_idle_timeout_minutes: int`
  (default `60`, env var `TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES`).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_device_models.py`:

```python
from __future__ import annotations

from sqlalchemy import select

from tournament_server.db import init_db, make_engine, make_session_factory, utc_now
from tournament_server.models.scoring_device import ScoringDevice
from tournament_server.settings import Settings


def _session_factory(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


def test_scoring_device_round_trips(tmp_path):
    db = _session_factory(tmp_path)
    now = utc_now()
    db.add(
        ScoringDevice(
            friendly_name="shifty-squirrel",
            device_token_hash="hashed-token",
            registered_at=now,
            last_seen_at=now,
        )
    )
    db.commit()

    row = db.execute(select(ScoringDevice)).scalars().first()
    assert row.friendly_name == "shifty-squirrel"
    assert row.admitted_at is None
    assert row.admitted_by is None
    assert row.registered_at.tzinfo is not None
    assert row.last_seen_at.tzinfo is not None


def test_settings_device_idle_timeout_defaults_to_sixty_minutes(monkeypatch):
    monkeypatch.delenv("TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES", raising=False)
    settings = Settings.from_env()
    assert settings.device_idle_timeout_minutes == 60


def test_settings_device_idle_timeout_reads_env_override(monkeypatch):
    monkeypatch.setenv("TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES", "15")
    settings = Settings.from_env()
    assert settings.device_idle_timeout_minutes == 15
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_device_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named
'tournament_server.models.scoring_device'`

- [ ] **Step 3: Create `src/tournament_server/models/scoring_device.py`**

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class ScoringDevice(Base):
    __tablename__ = "scoring_devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    friendly_name: Mapped[str] = mapped_column(String(100), unique=True)
    device_token_hash: Mapped[str] = mapped_column(String(200), unique=True)
    registered_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    admitted_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
    admitted_by: Mapped[str | None] = mapped_column(String(200), default=None)
    last_seen_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
```

- [ ] **Step 4: Register the model in `models/__init__.py`**

Edit `src/tournament_server/models/__init__.py` — add the import
(alphabetically — between `ScoreRecord` and `SessionParticipation`) and
the `__all__` entry:

```python
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.auth_session import AuthSession
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.bracket_matchup import BracketMatchup
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.finals_result import FinalsResult
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.ranking import Ranking
from tournament_server.models.ranking_configuration import RankingConfiguration
from tournament_server.models.role_credential import RoleCredential
from tournament_server.models.schedule_generation import ScheduleGeneration
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.scoring_device import ScoringDevice
from tournament_server.models.session import TournamentSession
from tournament_server.models.signing_key import SigningKey
from tournament_server.models.team import Team

__all__ = [
    "Alliance",
    "AllianceTeam",
    "AuthSession",
    "BracketAlliance",
    "BracketAllianceTeam",
    "BracketMatchup",
    "Division",
    "Event",
    "Field",
    "FieldSet",
    "FinalsBracket",
    "FinalsResult",
    "Match",
    "Ranking",
    "RankingConfiguration",
    "RoleCredential",
    "ScheduleGeneration",
    "ScoreRecord",
    "ScoringDevice",
    "SessionParticipation",
    "SigningKey",
    "TournamentSession",
    "Team",
]
```

- [ ] **Step 5: Exclude `scoring_devices` from audit logging**

`ScoringDevice.device_token_hash` is a secret hash, same principle as
`AuthSession.refresh_token_hash` — it must not leak into the generic
audit log. Edit `src/tournament_server/audit.py` (the comment and set
near line 29-42):

```python
# Tables this module refuses to audit, for two distinct reasons:
#
# - "audit_log" guards against ever recursively auditing the audit table
#   itself. In practice audit rows are only ever written via the raw
#   `connection.execute` calls below (never through
#   `session.add(AuditLog(...))`), so this can't currently trigger — it's
#   cheap insurance against a future change that adds an ORM-level write to
#   this table.
# - "role_credentials", "auth_sessions", "signing_keys", and
#   "scoring_devices" hold password/token hashes and the JWT signing key.
#   Excluding them is load-bearing, not insurance: without it, every login,
#   event creation, and device registration would write hashed secrets
#   straight into the audit log. This is exercised by every login, event
#   creation, and device registration in the test suite.
_EXCLUDED_TABLES = {
    "audit_log",
    "role_credentials",
    "auth_sessions",
    "signing_keys",
    "scoring_devices",
}
```

- [ ] **Step 6: Add the idle-timeout setting**

Edit `src/tournament_server/settings.py`:

```python
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass
class Settings:
    db_path: str = "./tournament.db"
    plugins_root: str = "./plugins"
    device_idle_timeout_minutes: int = 60

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=os.environ.get("TOURNAMENT_DB_PATH", "./tournament.db"),
            plugins_root=os.environ.get("TOURNAMENT_PLUGINS_ROOT", "./plugins"),
            device_idle_timeout_minutes=int(
                os.environ.get("TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES", "60")
            ),
        )
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pytest tests/test_device_models.py -v`
Expected: PASS (3 tests)

- [ ] **Step 8: Run the full existing suite to confirm no regressions**

Run: `pytest tests/ -v`
Expected: PASS (286 pre-existing + 3 new = 289)

- [ ] **Step 9: Commit**

```bash
git add src/tournament_server/models/scoring_device.py \
  src/tournament_server/models/__init__.py \
  src/tournament_server/audit.py src/tournament_server/settings.py \
  tests/test_device_models.py
git commit -m "Add ScoringDevice data model, idle-timeout config, audit exclusion"
```

---

## Task 2: Core device-auth module — tokens, friendly names, admission logic

**Files:**
- Create: `src/tournament_server/device_auth.py`
- Test: `tests/test_device_auth_core.py`

**Interfaces:**
- Consumes: `ScoringDevice` (Task 1); `hash_token`,
  `require_scorer_or_referee` from `tournament_server.auth`
  (already exist); `tournament_server.deps.get_db`;
  `tournament_server.db.utc_now`.
- Produces (all importable from `tournament_server.device_auth`):
  - `generate_device_token() -> str`
  - `generate_friendly_name(db: Session) -> str`
  - `is_currently_admitted(device: ScoringDevice, now: dt.datetime,
    idle_timeout: dt.timedelta) -> bool`
  - `device_status(device: ScoringDevice, now: dt.datetime, idle_timeout:
    dt.timedelta) -> str` — one of `"pending"`, `"admitted"`, `"idle"`.
  - `touch_device_activity(db: Session, device_token: str) -> None` —
    best-effort; silently does nothing if the token doesn't match any row.
  - `require_admitted_device(request: Request, x_device_token: str | None,
    db: Session, role: str) -> str | None` — a FastAPI dependency. Returns
    the resolved device's `friendly_name` on success, or `None` when no
    device was resolved. 401s if the header is missing/unknown (unless the
    caller is `admin`); 403s if the device exists but isn't currently
    admitted (unless the caller is `admin`). Reads
    `request.app.state.device_idle_timeout` (a `dt.timedelta`, wired in
    Task 3).

Note: `require_admitted_device` itself is exercised end-to-end through
`TestClient` in Task 4, once it's actually wired onto an endpoint and
`request.app.state.device_idle_timeout` is a real value from a real app
— it needs a `Request`, which isn't worth faking here. This task's own
tests cover every other function directly (all of them are pure or
take only a plain `Session`).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_device_auth_core.py`:

```python
from __future__ import annotations

import datetime as dt

from tournament_server.auth import hash_token
from tournament_server.db import init_db, make_engine, make_session_factory, utc_now
from tournament_server.device_auth import (
    device_status,
    generate_device_token,
    generate_friendly_name,
    is_currently_admitted,
    touch_device_activity,
)
from tournament_server.models.scoring_device import ScoringDevice


def _db(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


def test_generate_device_token_is_unique_each_call():
    tokens = {generate_device_token() for _ in range(20)}
    assert len(tokens) == 20


def test_generate_friendly_name_is_adjective_animal_shaped(tmp_path):
    db = _db(tmp_path)
    name = generate_friendly_name(db)
    parts = name.split("-")
    assert len(parts) == 2
    assert all(parts)


def test_generate_friendly_name_avoids_collisions(tmp_path):
    db = _db(tmp_path)
    first = generate_friendly_name(db)
    now = utc_now()
    db.add(
        ScoringDevice(
            friendly_name=first,
            device_token_hash="some-hash",
            registered_at=now,
            last_seen_at=now,
        )
    )
    db.commit()

    names = {generate_friendly_name(db) for _ in range(30)}
    assert first not in names


def test_is_currently_admitted_false_when_never_admitted():
    now = utc_now()
    device = ScoringDevice(
        friendly_name="brave-otter",
        device_token_hash="hash",
        registered_at=now,
        last_seen_at=now,
        admitted_at=None,
    )
    assert not is_currently_admitted(device, now, dt.timedelta(minutes=60))


def test_is_currently_admitted_true_within_timeout():
    now = utc_now()
    device = ScoringDevice(
        friendly_name="brave-otter",
        device_token_hash="hash",
        registered_at=now,
        last_seen_at=now,
        admitted_at=now,
    )
    assert is_currently_admitted(device, now, dt.timedelta(minutes=60))


def test_is_currently_admitted_false_after_idle_timeout():
    now = utc_now()
    stale = now - dt.timedelta(hours=2)
    device = ScoringDevice(
        friendly_name="brave-otter",
        device_token_hash="hash",
        registered_at=stale,
        last_seen_at=stale,
        admitted_at=stale,
    )
    assert not is_currently_admitted(device, now, dt.timedelta(minutes=60))


def test_device_status_pending_admitted_idle():
    now = utc_now()
    idle_timeout = dt.timedelta(minutes=60)

    pending = ScoringDevice(
        friendly_name="a", device_token_hash="h1", registered_at=now, last_seen_at=now,
    )
    assert device_status(pending, now, idle_timeout) == "pending"

    admitted = ScoringDevice(
        friendly_name="b", device_token_hash="h2", registered_at=now, last_seen_at=now,
        admitted_at=now,
    )
    assert device_status(admitted, now, idle_timeout) == "admitted"

    stale = now - dt.timedelta(hours=2)
    idle = ScoringDevice(
        friendly_name="c", device_token_hash="h3", registered_at=stale, last_seen_at=stale,
        admitted_at=stale,
    )
    assert device_status(idle, now, idle_timeout) == "idle"


def test_touch_device_activity_updates_last_seen(tmp_path):
    db = _db(tmp_path)
    stale = utc_now() - dt.timedelta(hours=1)
    device = ScoringDevice(
        friendly_name="quiet-hawk",
        device_token_hash=hash_token("raw-device-token"),
        registered_at=stale,
        last_seen_at=stale,
    )
    db.add(device)
    db.commit()

    touch_device_activity(db, "raw-device-token")

    db.refresh(device)
    assert device.last_seen_at > stale


def test_touch_device_activity_silently_ignores_unknown_token(tmp_path):
    db = _db(tmp_path)
    touch_device_activity(db, "no-such-token")  # must not raise
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_device_auth_core.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named
'tournament_server.device_auth'`

- [ ] **Step 3: Write `src/tournament_server/device_auth.py`**

```python
from __future__ import annotations

import datetime as dt
import random
import secrets

from fastapi import Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import hash_token, require_scorer_or_referee
from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.models.scoring_device import ScoringDevice

_ADJECTIVES = [
    "shifty", "brave", "quiet", "swift", "clever", "bold", "lucky", "sneaky",
    "happy", "grumpy", "sturdy", "gentle", "fierce", "curious", "nimble",
    "sleepy", "jolly", "plucky", "wily", "steady", "spry", "chipper",
    "scrappy", "breezy",
]
_ANIMALS = [
    "squirrel", "badger", "otter", "hawk", "fox", "beaver", "heron", "lynx",
    "raven", "marten", "weasel", "falcon", "wombat", "gecko", "mole",
    "shrew", "vole", "stoat", "ibis", "tern", "newt", "moth", "cricket",
    "finch",
]
_MAX_NAME_RETRIES = 20


def generate_device_token() -> str:
    return secrets.token_urlsafe(32)


def generate_friendly_name(db: Session) -> str:
    for _ in range(_MAX_NAME_RETRIES):
        candidate = f"{random.choice(_ADJECTIVES)}-{random.choice(_ANIMALS)}"
        exists = db.execute(
            select(ScoringDevice).where(ScoringDevice.friendly_name == candidate)
        ).scalars().first()
        if exists is None:
            return candidate
    # Word list exhausted (never expected in practice for a single event's
    # device count) — append a short random suffix to guarantee termination.
    return f"{random.choice(_ADJECTIVES)}-{random.choice(_ANIMALS)}-{secrets.token_hex(2)}"


def is_currently_admitted(
    device: ScoringDevice, now: dt.datetime, idle_timeout: dt.timedelta
) -> bool:
    return device.admitted_at is not None and (now - device.last_seen_at) < idle_timeout


def device_status(
    device: ScoringDevice, now: dt.datetime, idle_timeout: dt.timedelta
) -> str:
    if device.admitted_at is None:
        return "pending"
    return "admitted" if is_currently_admitted(device, now, idle_timeout) else "idle"


def touch_device_activity(db: Session, device_token: str) -> None:
    token_hash = hash_token(device_token)
    device = db.execute(
        select(ScoringDevice).where(ScoringDevice.device_token_hash == token_hash)
    ).scalars().first()
    if device is not None:
        device.last_seen_at = utc_now()
        db.commit()


def require_admitted_device(
    request: Request,
    x_device_token: str | None = Header(None),
    db: Session = Depends(get_db),
    role: str = Depends(require_scorer_or_referee),
) -> str | None:
    idle_timeout = request.app.state.device_idle_timeout
    device = None
    if x_device_token:
        token_hash = hash_token(x_device_token)
        device = db.execute(
            select(ScoringDevice).where(ScoringDevice.device_token_hash == token_hash)
        ).scalars().first()

    now = utc_now()
    if device is not None and is_currently_admitted(device, now, idle_timeout):
        return device.friendly_name

    if role == "admin":
        return None

    if device is None:
        raise HTTPException(status_code=401, detail="Missing or unknown device token")
    raise HTTPException(status_code=403, detail="This device has not been admitted")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_device_auth_core.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Run the full suite**

Run: `pytest tests/ -v`
Expected: PASS (289 + 9 new = 298)

- [ ] **Step 6: Commit**

```bash
git add src/tournament_server/device_auth.py tests/test_device_auth_core.py
git commit -m "Add core device-auth module: tokens, friendly names, admission logic"
```

---

## Task 3: Devices schemas + router + app wiring

**Files:**
- Create: `src/tournament_server/schemas/device.py`
- Create: `src/tournament_server/routers/devices.py`
- Modify: `src/tournament_server/app.py`
- Test: `tests/test_devices.py`

**Interfaces:**
- Consumes: `ScoringDevice` (Task 1); `generate_device_token`,
  `generate_friendly_name`, `device_status`, `touch_device_activity`
  (Task 2); `hash_token`, `require_admin` from `tournament_server.auth`.
- Produces: `POST /api/devices/register`, `GET /api/devices`,
  `POST /api/devices/{id}/admit`, `POST /api/devices/{id}/revoke`.
  `app.state.device_idle_timeout: dt.timedelta` (read by
  `require_admitted_device` in Task 2/4 and by this router's list/admit/
  revoke handlers).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_devices.py`:

```python
from __future__ import annotations

import datetime as dt

from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from tournament_server.db import utc_now
from tournament_server.models.scoring_device import ScoringDevice


def test_register_device_returns_pending_with_unique_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)

    response = raw.post("/api/devices/register")
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "pending"
    assert "-" in body["friendly_name"]
    assert len(body["device_token"]) > 20

    second = raw.post("/api/devices/register").json()
    assert second["friendly_name"] != body["friendly_name"]
    assert second["device_token"] != body["device_token"]


def test_register_device_requires_no_auth_and_no_event(client):
    # A completely fresh, never-logged-in client with no event created at
    # all can still register — this is a bootstrap endpoint.
    raw = TestClient(client.app)
    response = raw.post("/api/devices/register")
    assert response.status_code == 201


def test_list_devices_is_admin_only(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    raw.post("/api/devices/register")
    scorer_token = login_as(raw, "scorer")

    response = raw.get("/api/devices", headers=bearer(scorer_token))
    assert response.status_code == 403


def test_admin_can_list_and_admit_a_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    device = client.post("/api/devices/register").json()

    listed = client.get("/api/devices").json()
    assert len(listed) == 1
    assert listed[0]["status"] == "pending"
    assert listed[0]["friendly_name"] == device["friendly_name"]

    device_id = listed[0]["id"]
    admitted = client.post(f"/api/devices/{device_id}/admit")
    assert admitted.status_code == 200
    assert admitted.json()["status"] == "admitted"
    assert admitted.json()["admitted_by"] == "admin"

    listed_again = client.get("/api/devices").json()
    assert listed_again[0]["status"] == "admitted"


def test_admit_rejects_unknown_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/devices/999/admit")
    assert response.status_code == 404


def test_admit_and_revoke_are_admin_only(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    raw.post("/api/devices/register")
    scorer_token = login_as(raw, "scorer")

    admit_response = raw.post("/api/devices/1/admit", headers=bearer(scorer_token))
    assert admit_response.status_code == 403
    revoke_response = raw.post("/api/devices/1/revoke", headers=bearer(scorer_token))
    assert revoke_response.status_code == 403


def test_revoke_un_admits_a_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()

    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")

    response = client.post(f"/api/devices/{device_id}/revoke")
    assert response.status_code == 200
    assert response.json()["status"] == "pending"

    listed = client.get("/api/devices").json()
    matched = next(d for d in listed if d["id"] == device_id)
    assert matched["status"] == "pending"


def test_revoke_rejects_unknown_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/devices/999/revoke")
    assert response.status_code == 404


def test_revoke_is_idempotent_on_a_pending_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )

    response = client.post(f"/api/devices/{device_id}/revoke")
    assert response.status_code == 200
    assert response.json()["status"] == "pending"


def test_idle_timeout_flips_admitted_device_to_idle(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")

    # Simulate the idle timeout having lapsed by seeding a stale
    # last_seen_at directly (matching the auth phase's own pattern for
    # seeding an expired AuthSession in tests/test_auth.py).
    db = client.app.state.session_factory()
    row = db.get(ScoringDevice, device_id)
    row.last_seen_at = utc_now() - dt.timedelta(hours=2)
    db.commit()
    db.close()

    listed = client.get("/api/devices").json()
    matched = next(d for d in listed if d["id"] == device_id)
    assert matched["status"] == "idle"


def test_activity_middleware_updates_last_seen_on_any_request(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    registration = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == registration["friendly_name"]
    )

    db = client.app.state.session_factory()
    row = db.get(ScoringDevice, device_id)
    row.last_seen_at = utc_now() - dt.timedelta(hours=2)
    db.commit()
    db.close()

    attendee_token = login_as(raw, "attendee")
    raw.get(
        "/api/divisions",
        headers={**bearer(attendee_token), "X-Device-Token": registration["device_token"]},
    )

    db2 = client.app.state.session_factory()
    refreshed = db2.get(ScoringDevice, device_id)
    db2.close()
    assert refreshed.last_seen_at > utc_now() - dt.timedelta(minutes=1)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_devices.py -v`
Expected: FAIL with 404s (no `/api/devices/*` routes registered yet)

- [ ] **Step 3: Write `src/tournament_server/schemas/device.py`**

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class DeviceRegisterResponse(BaseModel):
    device_token: str
    friendly_name: str
    status: str


class DeviceRead(BaseModel):
    id: int
    friendly_name: str
    status: str
    registered_at: dt.datetime
    admitted_at: dt.datetime | None
    admitted_by: str | None
    last_seen_at: dt.datetime
```

- [ ] **Step 4: Write `src/tournament_server/routers/devices.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import audit
from tournament_server.auth import hash_token, require_admin
from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.device_auth import (
    device_status,
    generate_device_token,
    generate_friendly_name,
)
from tournament_server.models.scoring_device import ScoringDevice
from tournament_server.schemas.device import DeviceRead, DeviceRegisterResponse

router = APIRouter(prefix="/api/devices", tags=["devices"])


def _to_device_read(device: ScoringDevice, idle_timeout) -> DeviceRead:
    now = utc_now()
    return DeviceRead(
        id=device.id,
        friendly_name=device.friendly_name,
        status=device_status(device, now, idle_timeout),
        registered_at=device.registered_at,
        admitted_at=device.admitted_at,
        admitted_by=device.admitted_by,
        last_seen_at=device.last_seen_at,
    )


@router.post("/register", response_model=DeviceRegisterResponse, status_code=201)
def register_device(db: Session = Depends(get_db)) -> DeviceRegisterResponse:
    friendly_name = generate_friendly_name(db)
    device_token = generate_device_token()
    now = utc_now()
    db.add(
        ScoringDevice(
            friendly_name=friendly_name,
            device_token_hash=hash_token(device_token),
            registered_at=now,
            last_seen_at=now,
        )
    )
    db.commit()
    return DeviceRegisterResponse(
        device_token=device_token, friendly_name=friendly_name, status="pending"
    )


@router.get("", response_model=list[DeviceRead])
def list_devices(
    request: Request, db: Session = Depends(get_db), _role: str = Depends(require_admin)
) -> list[DeviceRead]:
    idle_timeout = request.app.state.device_idle_timeout
    devices = db.execute(select(ScoringDevice)).scalars().all()
    return [_to_device_read(d, idle_timeout) for d in devices]


@router.post("/{device_id}/admit", response_model=DeviceRead)
def admit_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = db.get(ScoringDevice, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    now = utc_now()
    device.admitted_at = now
    device.admitted_by = audit.current_actor.get()
    # Also refresh last_seen_at: otherwise re-admitting a device that has
    # been silent longer than the idle timeout would set a fresh
    # admitted_at but leave is_currently_admitted() false until the
    # device's next successful request happens to touch last_seen_at —
    # re-admitting must take effect immediately.
    device.last_seen_at = now
    db.commit()
    db.refresh(device)
    return _to_device_read(device, request.app.state.device_idle_timeout)


@router.post("/{device_id}/revoke", response_model=DeviceRead)
def revoke_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = db.get(ScoringDevice, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    device.admitted_at = None
    device.admitted_by = None
    db.commit()
    db.refresh(device)
    return _to_device_read(device, request.app.state.device_idle_timeout)
```

- [ ] **Step 5: Wire the router, `app.state.device_idle_timeout`, and the
  activity middleware into `app.py`**

Edit `src/tournament_server/app.py`:

```python
from __future__ import annotations

import datetime as dt
from pathlib import Path

from fastapi import FastAPI, Request

from tournament_server import audit, device_auth  # noqa: F401  (audit registers hooks)
from tournament_server import models  # noqa: F401  (registers all tables)
from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.plugin_registry.discovery import (
    discover_game_plugins,
    discover_scheduler_plugins,
)
from tournament_server.routers import (
    audit_log,
    auth,
    devices,
    divisions,
    event,
    field_sets,
    fields,
    finals,
    matches,
    participation,
    plugins,
    ranking_configuration,
    rankings,
    schedule,
    scores,
    sessions,
    teams,
)
from tournament_server.settings import Settings


def create_app(
    db_path: str | None = None, plugins_root: str | None = None
) -> FastAPI:
    settings = Settings.from_env()
    if db_path is not None:
        settings.db_path = db_path
    if plugins_root is not None:
        settings.plugins_root = plugins_root

    engine = make_engine(settings.db_path)
    session_factory = make_session_factory(engine)
    init_db(engine)

    app = FastAPI(title="Tournament Server")
    app.state.session_factory = session_factory
    app.state.plugins_root = Path(settings.plugins_root)
    app.state.game_plugins = discover_game_plugins(app.state.plugins_root)
    app.state.scheduler_plugins = discover_scheduler_plugins(app.state.plugins_root)
    app.state.device_idle_timeout = dt.timedelta(
        minutes=settings.device_idle_timeout_minutes
    )

    @app.middleware("http")
    async def actor_middleware(request: Request, call_next):
        with audit.actor_scope(request.headers.get("x-actor-name", "admin")):
            return await call_next(request)

    @app.middleware("http")
    async def device_activity_middleware(request: Request, call_next):
        device_token = request.headers.get("x-device-token")
        response = await call_next(request)
        # Only a *successful* request counts as activity. Touching
        # last_seen_at unconditionally — including on a rejected request —
        # would let an idle device silently revive its own admission just
        # by attempting (and failing) a request, defeating the "requires
        # one-click re-admission" goal: see the design spec's §5.
        if device_token and response.status_code < 400:
            db = request.app.state.session_factory()
            try:
                device_auth.touch_device_activity(db, device_token)
            finally:
                db.close()
        return response

    app.include_router(event.router)
    app.include_router(auth.router)
    app.include_router(devices.router)
    app.include_router(sessions.router)
    app.include_router(divisions.router)
    app.include_router(field_sets.router)
    app.include_router(fields.router)
    app.include_router(teams.router)
    app.include_router(participation.router)
    app.include_router(audit_log.router)
    app.include_router(plugins.router)
    app.include_router(plugins.scheduler_router)
    app.include_router(matches.router)
    app.include_router(scores.router)
    app.include_router(ranking_configuration.router)
    app.include_router(rankings.router)
    app.include_router(schedule.router)
    app.include_router(finals.router)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    return app
```

(Only the `datetime` import, the `device_auth` import, `devices` added
to the router import list, `app.state.device_idle_timeout`, the new
`device_activity_middleware`, and `app.include_router(devices.router)`
are new — everything else is unchanged.)

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_devices.py -v`
Expected: PASS (all tests)

- [ ] **Step 7: Run the full suite**

Run: `pytest tests/ -v`
Expected: PASS (298 + 11 new = 309)

- [ ] **Step 8: Commit**

```bash
git add src/tournament_server/schemas/device.py src/tournament_server/routers/devices.py \
  src/tournament_server/app.py tests/test_devices.py
git commit -m "Add devices router: register, list, admit, revoke; activity middleware"
```

---

## Task 4: Gate and attribute score submission by device

**Files:**
- Modify: `src/tournament_server/routers/scores.py`
- Modify: `tests/test_scores.py`

**Interfaces:**
- Consumes: `require_admitted_device` (Task 2).
- Produces: `submit_score` now requires an admitted device for any
  non-admin caller, and attributes `ScoreRecord.submitted_by_device` from
  the resolved device when one is present.

This is the one existing test this plan is known to break:
`test_submit_score_succeeds_for_scorer_and_referee` currently submits as
`scorer`/`referee` with no device token at all, which will now correctly
401 (the device-admission gate is new and applies to every non-admin
caller). Fix it in this task by registering and admitting a device first
— do not weaken the gate to avoid touching this test.

- [ ] **Step 1: Update the one test this task is expected to break, and add new device-gate tests**

Edit `tests/test_scores.py` — replace
`test_submit_score_succeeds_for_scorer_and_referee` and add four new
tests after it:

```python
def test_submit_score_succeeds_for_scorer_and_referee(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)

    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")

    for role in ("scorer", "referee"):
        token = login_as(raw, role)
        response = raw.post(
            f"/api/matches/{match_id}/alliances/{red_id}/score",
            json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
            headers={**bearer(token), "X-Device-Token": device["device_token"]},
        )
        assert response.status_code == 200, f"{role} should be able to submit a score"


def test_pending_device_cannot_submit_score_as_scorer(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert response.status_code == 403


def test_missing_device_token_rejected_for_scorer(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers=bearer(scorer_token),
    )
    assert response.status_code == 401


def test_unknown_device_token_rejected_for_scorer(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": "not-a-real-token"},
    )
    assert response.status_code == 401


def test_idle_device_rejected_until_explicitly_re_admitted(client):
    import datetime as dt

    from tournament_server.db import utc_now
    from tournament_server.models.scoring_device import ScoringDevice

    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")
    scorer_token = login_as(raw, "scorer")

    db = client.app.state.session_factory()
    row = db.get(ScoringDevice, device_id)
    row.last_seen_at = utc_now() - dt.timedelta(hours=2)
    db.commit()
    db.close()

    stale_response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert stale_response.status_code == 403

    # The rejected attempt above must NOT have silently revived the
    # device — a second, immediately-following identical attempt still
    # 403s, proving only an explicit re-admit (not mere retrying) restores
    # access.
    still_rejected = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert still_rejected.status_code == 403

    client.post(f"/api/devices/{device_id}/admit")
    fresh_response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert fresh_response.status_code == 200


def test_revoked_device_cannot_submit_score(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")
    client.post(f"/api/devices/{device_id}/revoke")
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert response.status_code == 403


def test_admitted_device_attributes_the_score_by_friendly_name(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert response.status_code == 200
    assert response.json()["submitted_by_device"] == device["friendly_name"]


def test_admin_bypasses_device_gate_entirely(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
    )
    assert response.status_code == 200


def test_admin_with_admitted_device_still_gets_device_attribution(client):
    # The subtle case: admin bypasses require_admitted_device's *rejection*,
    # but the dependency still *resolves* a present, valid device token —
    # so attribution stays accurate for an admin using a real device too,
    # it's not just "admin always falls back to the actor header."
    match_id, red_id, blue_id = _setup_match(client)
    device = client.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={"X-Device-Token": device["device_token"]},
    )
    assert response.status_code == 200
    assert response.json()["submitted_by_device"] == device["friendly_name"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_scores.py -v`
Expected: FAIL — `test_submit_score_succeeds_for_scorer_and_referee` now
401s (device gate not wired into `submit_score` yet); all eight new
device-gate tests also fail, since `submit_score` doesn't yet enforce or
use the device gate at all — e.g. `test_pending_device_cannot_submit_score_as_scorer`
gets 200 instead of 403, `test_idle_device_rejected_until_explicitly_re_admitted`
gets 200 on its first (should-be-403) attempt.

- [ ] **Step 3: Wire `require_admitted_device` and attribution into `submit_score`**

Edit `src/tournament_server/routers/scores.py`:

```python
from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import audit
from tournament_server.auth import require_scorer_or_referee
from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_game_plugin_for_event, get_the_event
from tournament_server.device_auth import require_admitted_device
from tournament_server.models.alliance import Alliance
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.schemas.score_record import ScoreRecordRead, ScoreSubmit
from tournament_server.services.finals import advance_score_chase, advance_single_elimination
from tournament_server.services.ranking import recompute_event_rankings, recompute_rankings

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
    _role: str = Depends(require_scorer_or_referee),
    device_friendly_name: str | None = Depends(require_admitted_device),
) -> ScoreRecordRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    alliance = db.get(Alliance, alliance_id)
    if alliance is None or alliance.match_id != match_id:
        raise HTTPException(status_code=404, detail="Alliance not found on this match")

    submitted_by = (
        device_friendly_name if device_friendly_name is not None else audit.current_actor.get()
    )

    plugin = get_game_plugin_for_event(request, db)

    try:
        violations = plugin.module.validate(payload.data)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Plugin could not validate this scoresheet: {exc}",
        )
    if violations and not payload.force:
        raise HTTPException(status_code=422, detail={"violations": violations})

    try:
        computed_score = (
            0
            if (payload.no_show or payload.dq)
            else plugin.module.calculate_score(payload.data)
        )
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Plugin could not score this scoresheet: {exc}",
        )

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
            submitted_by_device=submitted_by,
            submitted_at=now,
            saved_at=now,
        )
        db.add(record)
    else:
        existing.data_json = json.dumps(payload.data)
        existing.no_show = payload.no_show
        existing.dq = payload.dq
        existing.sitting = payload.sitting
        existing.submitted_by_device = submitted_by
        existing.submitted_at = now
        existing.saved_at = now
        record = existing

    db.commit()
    db.refresh(record)

    game_model = plugin.module.match_format()["game_model"]
    all_alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match_id)
    ).scalars().all()

    if game_model == "cooperative_score" and not (payload.no_show or payload.dq):
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
                    submitted_by_device=submitted_by,
                    submitted_at=now,
                    saved_at=now,
                )
                db.add(other_record)
            else:
                other_record.data_json = record.data_json
                other_record.plugin_name = plugin.name
                other_record.plugin_version = plugin.version
        db.commit()
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

    if match.finals_bracket_id is not None:
        bracket = db.get(FinalsBracket, match.finals_bracket_id)
        if bracket is not None and match.status == "completed":
            if bracket.format == "score_chase":
                advance_score_chase(db, bracket, plugin)
            elif bracket.format == "single_elimination":
                advance_single_elimination(db, bracket, plugin, match)
        return _to_score_record_read(record, computed_score)

    recompute_rankings(db, plugin, match.session_id, match.division_id)
    event = get_the_event(db)
    if event is not None:
        recompute_event_rankings(db, plugin, event.id, match.division_id)

    return _to_score_record_read(record, computed_score)
```

(Only the `device_auth` import, the new `device_friendly_name` parameter,
the `submitted_by` computation, and using `submitted_by` in place of the
three previous `audit.current_actor.get()` calls changed — nothing else
in the function's logic moved.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_scores.py -v`
Expected: PASS (all tests, including the updated one and the eight new ones)

- [ ] **Step 5: Run the full suite**

Run: `pytest tests/ -v`
Expected: PASS (309 + 8 new = 317; one existing test was modified, not
added, so it doesn't change the total)

- [ ] **Step 6: Commit**

```bash
git add src/tournament_server/routers/scores.py tests/test_scores.py
git commit -m "Gate score submission on device admission; attribute by device name"
```

---

## Task 5: Document the subsystem in `server/CLAUDE.md`

**Files:**
- Modify: `server/CLAUDE.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add a new section**

In `server/CLAUDE.md`, insert a new `## Scoring device admission` section
immediately after the existing `## Multi-division scheduling` section
(and before `## Known, deliberate gaps in this phase`):

```markdown
## Scoring device admission

A `ScoringDevice` (`POST /api/devices/register` — no auth required,
matching `POST /api/auth/login`'s bootstrap-endpoint status) self-registers
and gets a persistent, human-friendly random name (`shifty-squirrel`-style,
adjective-animal) plus a browser-storable `device_token`; it starts
`pending`. An admin reviews `GET /api/devices` and calls
`POST /api/devices/{id}/admit` (or `.../revoke` to un-admit). This is a
distinct, additional layer on top of role-based auth (see
`docs/superpowers/specs/2026-09-03-real-authentication-design.md`), not a
replacement for it: role auth gates *whether a caller can act at all*;
device admission gates *whether score-writes count as coming from a
trusted, admin-vetted device* and attributes them to a real name instead
of the spoofable `X-Actor-Name` header.

Admission has no stored status enum — `admitted_at is not None AND (now -
last_seen_at) < idle_timeout` is computed at every point of use (list,
enforcement), mirroring `AuthSession`'s existing lazy-expiry pattern; no
background job sweeps expired admissions. `last_seen_at` is kept current
by a request-level middleware (`app.py`) that touches it on *any* request
carrying a valid `X-Device-Token`, not just scoring ones — so the
idle-timeout (`TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES`, default 60)
reflects real device activity.

`require_admitted_device` (`device_auth.py`) is applied only to
`POST /api/matches/{id}/alliances/{id}/score`, in addition to the existing
`require_scorer_or_referee` role gate. `admin` bypasses only the
*rejection*, never the *lookup*: a present, currently-admitted device
token still attributes `ScoreRecord.submitted_by_device` to the real
device name even for an admin caller, but an admin is never blocked by a
missing/invalid/un-admitted one — every other role is. Every caller that
never sends `X-Device-Token` (including all pre-device-phase tests) keeps
falling back to today's `audit.current_actor.get()`-based attribution,
unchanged.

`Device`/Pi-display admission (the master spec's other, separate device
concept — admin-driven, for unattended kiosk displays) is not built —
still a distinct, later phase once a Pi client and a WebSocket
"active-session" push mechanism exist. See
`docs/superpowers/specs/2026-09-08-scoring-device-admission-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add server/CLAUDE.md
git commit -m "Document scoring device admission in server/CLAUDE.md"
```

---

## Task 6: Final full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the complete test suite**

Run: `pytest tests/ -v`
Expected: PASS — every test passes (317 total), no skips.

- [ ] **Step 2: Manual end-to-end smoke test**

Run: `rm -f tournament.db* && python -m tournament_server.main &`, then:

```bash
curl -s -X POST http://127.0.0.1:8000/api/event \
  -H 'Content-Type: application/json' \
  -d '{"name": "Smoke Test", "password": "smoke-test"}'

ADMIN_TOKEN=$(curl -s -X POST http://127.0.0.1:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"role": "admin", "password": "smoke-test"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

DEVICE=$(curl -s -X POST http://127.0.0.1:8000/api/devices/register)
echo "$DEVICE"
DEVICE_ID=$(curl -s http://127.0.0.1:8000/api/devices -H "Authorization: Bearer $ADMIN_TOKEN" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["id"])')

curl -s -X POST "http://127.0.0.1:8000/api/devices/$DEVICE_ID/admit" \
  -H "Authorization: Bearer $ADMIN_TOKEN"

curl -s -X POST "http://127.0.0.1:8000/api/devices/$DEVICE_ID/revoke" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Expected: event creation succeeds; admin login issues a token; device
registration returns a `pending` device with a token and friendly name;
the admin's device list shows it; admit flips it to `admitted`; revoke
flips it back to `pending`. Stop the server afterward
(`kill %1` or equivalent) and delete the smoke-test `.db` file.

- [ ] **Step 3: Confirm no stray references or leftover TODOs**

Run: `grep -rn "TODO\|FIXME" server/src/tournament_server/device_auth.py
server/src/tournament_server/routers/devices.py
server/src/tournament_server/models/scoring_device.py` — expected: no
output.

This task has no commit of its own — it's the final gate before
considering the branch done. If any step fails, return to the relevant
earlier task and fix it there (with its own commit) rather than patching
ad hoc here.
