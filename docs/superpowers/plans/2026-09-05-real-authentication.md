# Real Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the project's no-real-authentication state (an `X-Actor-Name`
header anyone can spoof) with role-based passwords, JWT access/refresh
tokens, and a `require_role(...)` dependency enforced on every API endpoint.

**Architecture:** Six fixed roles (`admin`, `scorer`, `judge`, `referee`,
`attendee`, `display_device`) share one password per role, hashed with
bcrypt into a new `RoleCredential` table. `POST /api/event` now requires a
password and creates all six credential rows from it. A new `auth` router
issues short-lived JWT access tokens (stateless, signed with a
server-generated key persisted in a new `SigningKey` singleton table) and
longer-lived opaque refresh tokens (hashed and tracked in a new
`AuthSession` table, so they can be listed/revoked). A single
`require_role(*allowed_roles)` FastAPI dependency — where `admin` always
passes regardless of the list — is wired via explicit `Depends(...)` onto
every existing endpoint per the authorization table in the spec's §4. The
`conftest.py` test fixtures gain a thin auto-authenticating `TestClient`
subclass so the 236 pre-existing tests keep working as Admin without being
rewritten.

**Tech Stack:** FastAPI + SQLAlchemy 2.0 + SQLite (existing stack). New
dependencies: `PyJWT` (token issuance/verification), `bcrypt` (password
hashing).

**Spec:**
`docs/superpowers/specs/2026-09-03-real-authentication-design.md` (read
this in full before starting — this plan implements it section by
section and calls out two places where it needed a small correction,
both explained inline in the relevant task).

## Global Constraints

- No real-world competition brand or product name anywhere in code,
  comments, docs, file/variable/class names, or user-facing text (root
  `CLAUDE.md`).
- Every backend feature ships with pytest unit tests in the same change
  (root `CLAUDE.md` testing policy) — every task below ends with a test
  run.
- Six roles, exactly: `admin`, `scorer`, `judge`, `referee`, `attendee`,
  `display_device` (spec §1).
- Access tokens: 30 minutes. Refresh tokens: 14 days (spec §5) — ordinary
  config values, not structural.
- `admin` always passes `require_role(...)`, regardless of what roles are
  listed (spec §4) — never spell out `admin` in an allowed-roles list.
- `POST /api/event`, `GET /api/event`, `POST /api/auth/login`, and
  `POST /api/auth/refresh` are the **only** endpoints that ever run with
  no `Authorization` header (spec §3). Every other endpoint gets an
  explicit `Depends(require_...)`.
- Password complexity, rate-limiting, and `Device`/`ScoringDevice`
  admission are explicitly out of scope (spec §1, §7) — do not build
  them.
- This is a schema change with no real deployed event data to migrate;
  the existing project convention (see `server/CLAUDE.md`'s "Known,
  deliberate gaps") is to delete the local `.db` file and let
  `Base.metadata.create_all()` rebuild it — no Alembic, no migration
  script.
- **Spec correction #1 (discovered during planning):** the
  authorization table in spec §4 omits the `rankings` router (its one
  endpoint, `GET /api/rankings`) entirely. Every other router is
  explicitly listed; `rankings` isn't a named exception anywhere and is
  a plain read endpoint, so Task 6 applies the general default stated in
  §4's prose (reads open to any authenticated role) to it, the same way
  every other unnamed-exception router is treated.
- **Spec correction #2 (discovered during planning):** spec §6 claims
  "every one of the 236 existing tests keeps passing completely
  unchanged." This is true for 226 of them. The other 10 all call an
  endpoint that now requires authentication using a **freshly constructed
  `client` fixture that never creates an event first** (so it never logs
  in, so it never has a token) — these are tests like
  `test_create_division_requires_event`, which currently assert `404
  Event not initialized` but will now correctly get `401` (no token)
  before the handler ever runs, since `require_role` is a `Depends(...)`
  that FastAPI evaluates before the endpoint body. This is structurally
  unavoidable (there's no way to log in before `RoleCredential` rows
  exist, and those only exist after an event is created) and is the
  objectively correct behavior once every endpoint requires auth — not a
  bug to work around. Task 9 lists and fixes all 10, with reasoning.

---

## Task 1: Data models — `RoleCredential`, `AuthSession`, `SigningKey`

**Files:**
- Create: `src/tournament_server/models/role_credential.py`
- Create: `src/tournament_server/models/auth_session.py`
- Create: `src/tournament_server/models/signing_key.py`
- Modify: `src/tournament_server/models/__init__.py`
- Modify: `src/tournament_server/audit.py:34` (`_EXCLUDED_TABLES`)
- Modify: `pyproject.toml`
- Test: `tests/test_auth_models.py`

**Interfaces:**
- Produces: `RoleCredential(id, role: str, password_hash: str)`,
  `AuthSession(id, role: str, refresh_token_hash: str, issued_at: dt.datetime,
  expires_at: dt.datetime, revoked_at: dt.datetime | None, label: str | None)`,
  `SigningKey(id, key: str)` — all importable from their modules above and
  from `tournament_server.models`.

- [ ] **Step 1: Add PyJWT and bcrypt to `pyproject.toml`**

Edit the `dependencies` list in `pyproject.toml`:

```toml
dependencies = [
    "fastapi>=0.115,<1.0",
    "uvicorn[standard]>=0.32,<1.0",
    "sqlalchemy>=2.0,<3.0",
    "pydantic>=2.9,<3.0",
    "python-multipart>=0.0.9,<1.0",
    "pyjwt>=2.9,<3.0",
    "bcrypt>=4.2,<5.0",
]
```

Run: `pip install -e ".[dev]"` (from `server/`, with the venv active)
Expected: PyJWT and bcrypt install cleanly; `python3 -c "import jwt, bcrypt"` raises no error.

- [ ] **Step 2: Write the failing test for all three models**

Create `tests/test_auth_models.py`:

```python
import datetime as dt

from sqlalchemy import select

from tournament_server.db import init_db, make_engine, make_session_factory, utc_now
from tournament_server.models.auth_session import AuthSession
from tournament_server.models.role_credential import RoleCredential
from tournament_server.models.signing_key import SigningKey


def _session_factory(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


def test_role_credential_round_trips(tmp_path):
    db = _session_factory(tmp_path)
    db.add(RoleCredential(role="admin", password_hash="hashed-value"))
    db.commit()

    row = db.execute(select(RoleCredential)).scalars().first()
    assert row.role == "admin"
    assert row.password_hash == "hashed-value"


def test_auth_session_round_trips(tmp_path):
    db = _session_factory(tmp_path)
    now = utc_now()
    db.add(
        AuthSession(
            role="scorer",
            refresh_token_hash="hashed-token",
            issued_at=now,
            expires_at=now + dt.timedelta(days=14),
            label="scoring tablet, Field 3",
        )
    )
    db.commit()

    row = db.execute(select(AuthSession)).scalars().first()
    assert row.role == "scorer"
    assert row.revoked_at is None
    assert row.label == "scoring tablet, Field 3"
    assert row.issued_at.tzinfo is not None


def test_signing_key_round_trips(tmp_path):
    db = _session_factory(tmp_path)
    db.add(SigningKey(key="a" * 64))
    db.commit()

    row = db.execute(select(SigningKey)).scalars().first()
    assert row.key == "a" * 64
```

- [ ] **Step 2b: Run test to verify it fails**

Run: `pytest tests/test_auth_models.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'tournament_server.models.role_credential'`

- [ ] **Step 3: Create the three model files**

`src/tournament_server/models/role_credential.py`:

```python
from __future__ import annotations

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class RoleCredential(Base):
    __tablename__ = "role_credentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    role: Mapped[str] = mapped_column(String(20), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
```

`src/tournament_server/models/auth_session.py`:

```python
from __future__ import annotations

import datetime as dt

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    role: Mapped[str] = mapped_column(String(20))
    refresh_token_hash: Mapped[str] = mapped_column(String(200), unique=True)
    issued_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    expires_at: Mapped[dt.datetime] = mapped_column(UTCDateTime)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
    label: Mapped[str | None] = mapped_column(String(200), default=None)
```

`src/tournament_server/models/signing_key.py`:

```python
from __future__ import annotations

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class SigningKey(Base):
    __tablename__ = "signing_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(200))
```

- [ ] **Step 4: Register the new models in `models/__init__.py`**

Edit `src/tournament_server/models/__init__.py` — add the three imports
(alphabetically, matching the existing style) and add the three names to
`__all__`:

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
    "SessionParticipation",
    "SigningKey",
    "TournamentSession",
    "Team",
]
```

- [ ] **Step 5: Exclude the three new tables from audit logging**

These tables store only password/token *hashes*, but the audit system
serializes every column of every row on insert/update/delete (see
`audit.py`'s `_serialize_all_columns`). Without this exclusion, every
password hash and refresh-token hash would get duplicated into the
`audit_log` table. Edit `src/tournament_server/audit.py:34`:

```python
_EXCLUDED_TABLES = {"audit_log", "role_credentials", "auth_sessions", "signing_keys"}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_auth_models.py -v`
Expected: PASS (3 tests)

- [ ] **Step 7: Commit**

```bash
git add pyproject.toml src/tournament_server/models/role_credential.py \
  src/tournament_server/models/auth_session.py \
  src/tournament_server/models/signing_key.py \
  src/tournament_server/models/__init__.py \
  src/tournament_server/audit.py tests/test_auth_models.py
git commit -m "Add RoleCredential, AuthSession, and SigningKey data models"
```

---

## Task 2: Core auth module — hashing, tokens, `require_role`

**Files:**
- Create: `src/tournament_server/auth.py`
- Test: `tests/test_auth_core.py`

**Interfaces:**
- Consumes: `SigningKey` (Task 1), `tournament_server.deps.get_db`,
  `tournament_server.db.utc_now`.
- Produces (all importable from `tournament_server.auth`):
  - `ROLES: tuple[str, ...]` — the six role names, `admin` first.
  - `ACCESS_TOKEN_LIFETIME_SECONDS: int` (1800), `REFRESH_TOKEN_LIFETIME:
    dt.timedelta` (14 days).
  - `hash_password(password: str) -> str`
  - `verify_password(password: str, password_hash: str) -> bool`
  - `hash_token(token: str) -> str`
  - `generate_refresh_token() -> str`
  - `get_signing_key(db: Session) -> str`
  - `create_access_token(db: Session, role: str) -> str`
  - `require_role(*allowed_roles: str)` — factory returning a FastAPI
    dependency callable `(authorization: str | None, db: Session) -> str`
    (the decoded role) that 401s on a missing/malformed/expired/invalid
    token and 403s when the role isn't `admin` and isn't in
    `allowed_roles`. Passing no `allowed_roles` means admin-only.
  - `require_admin` = `require_role()` — a ready-to-use `Depends(...)`
    target for admin-only endpoints.
  - `require_any_role` = `require_role(*ROLES)` — for endpoints open to
    any authenticated role.
  - `require_scorer_or_referee` = `require_role("scorer", "referee")` —
    the `scores` router's write exception (spec §4).

- [ ] **Step 1: Write the failing tests**

Create `tests/test_auth_core.py`:

```python
from __future__ import annotations

import datetime as dt

import jwt
import pytest
from fastapi import HTTPException

from tournament_server.auth import (
    ACCESS_TOKEN_LIFETIME_SECONDS,
    JWT_ALGORITHM,
    REFRESH_TOKEN_LIFETIME,
    ROLES,
    create_access_token,
    generate_refresh_token,
    get_signing_key,
    hash_password,
    hash_token,
    require_admin,
    require_any_role,
    require_role,
    require_scorer_or_referee,
    verify_password,
)
from tournament_server.db import init_db, make_engine, make_session_factory


def _db(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


def test_roles_are_the_six_fixed_names():
    assert ROLES == (
        "admin",
        "scorer",
        "judge",
        "referee",
        "attendee",
        "display_device",
    )


def test_hash_password_round_trips():
    hashed = hash_password("correct horse")
    assert hashed != "correct horse"
    assert verify_password("correct horse", hashed)
    assert not verify_password("wrong password", hashed)


def test_hash_token_is_deterministic():
    assert hash_token("abc123") == hash_token("abc123")
    assert hash_token("abc123") != hash_token("xyz789")


def test_generate_refresh_token_is_unique_each_call():
    tokens = {generate_refresh_token() for _ in range(20)}
    assert len(tokens) == 20


def test_get_signing_key_persists_across_calls(tmp_path):
    db = _db(tmp_path)
    first = get_signing_key(db)
    second = get_signing_key(db)
    assert first == second
    assert len(first) >= 32


def test_create_access_token_has_only_role_iat_exp_claims(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "scorer")
    payload = jwt.decode(token, get_signing_key(db), algorithms=[JWT_ALGORITHM])
    assert set(payload.keys()) == {"role", "iat", "exp"}
    assert payload["role"] == "scorer"
    assert payload["exp"] - payload["iat"] == ACCESS_TOKEN_LIFETIME_SECONDS


def test_require_role_401s_with_no_header(tmp_path):
    db = _db(tmp_path)
    dependency = require_role()
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization=None, db=db)
    assert exc_info.value.status_code == 401


def test_require_role_401s_with_malformed_header(tmp_path):
    db = _db(tmp_path)
    dependency = require_role()
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization="not-a-bearer-token", db=db)
    assert exc_info.value.status_code == 401


def test_require_role_401s_on_expired_token(tmp_path):
    db = _db(tmp_path)
    signing_key = get_signing_key(db)
    now = dt.datetime.now(dt.UTC)
    expired = jwt.encode(
        {
            "role": "admin",
            "iat": int((now - dt.timedelta(hours=1)).timestamp()),
            "exp": int((now - dt.timedelta(minutes=1)).timestamp()),
        },
        signing_key,
        algorithm=JWT_ALGORITHM,
    )
    dependency = require_role()
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization=f"Bearer {expired}", db=db)
    assert exc_info.value.status_code == 401


def test_require_role_401s_on_bad_signature(tmp_path):
    db = _db(tmp_path)
    get_signing_key(db)  # ensure a signing key row exists
    bogus = jwt.encode(
        {"role": "admin", "iat": 0, "exp": 9999999999}, "wrong-key", algorithm=JWT_ALGORITHM
    )
    dependency = require_role()
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization=f"Bearer {bogus}", db=db)
    assert exc_info.value.status_code == 401


def test_require_role_403s_when_role_not_allowed(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "attendee")
    dependency = require_role("scorer", "referee")
    with pytest.raises(HTTPException) as exc_info:
        dependency(authorization=f"Bearer {token}", db=db)
    assert exc_info.value.status_code == 403


def test_require_role_passes_when_role_allowed(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "scorer")
    dependency = require_role("scorer", "referee")
    assert dependency(authorization=f"Bearer {token}", db=db) == "scorer"


def test_admin_always_passes_regardless_of_allowed_roles(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "admin")
    dependency = require_role("scorer", "referee")
    assert dependency(authorization=f"Bearer {token}", db=db) == "admin"


def test_require_admin_rejects_non_admin(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "judge")
    with pytest.raises(HTTPException) as exc_info:
        require_admin(authorization=f"Bearer {token}", db=db)
    assert exc_info.value.status_code == 403


def test_require_any_role_accepts_every_role(tmp_path):
    db = _db(tmp_path)
    for role in ROLES:
        token = create_access_token(db, role)
        assert require_any_role(authorization=f"Bearer {token}", db=db) == role


def test_require_scorer_or_referee_rejects_judge(tmp_path):
    db = _db(tmp_path)
    token = create_access_token(db, "judge")
    with pytest.raises(HTTPException) as exc_info:
        require_scorer_or_referee(authorization=f"Bearer {token}", db=db)
    assert exc_info.value.status_code == 403


def test_refresh_token_lifetime_is_fourteen_days():
    assert REFRESH_TOKEN_LIFETIME == dt.timedelta(days=14)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_auth_core.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'tournament_server.auth'`

- [ ] **Step 3: Write `src/tournament_server/auth.py`**

```python
from __future__ import annotations

import datetime as dt
import hashlib
import secrets

import bcrypt
import jwt
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.models.signing_key import SigningKey

ROLES = ("admin", "scorer", "judge", "referee", "attendee", "display_device")

JWT_ALGORITHM = "HS256"
ACCESS_TOKEN_LIFETIME = dt.timedelta(minutes=30)
ACCESS_TOKEN_LIFETIME_SECONDS = int(ACCESS_TOKEN_LIFETIME.total_seconds())
REFRESH_TOKEN_LIFETIME = dt.timedelta(days=14)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_refresh_token() -> str:
    return secrets.token_urlsafe(32)


def get_signing_key(db: Session) -> str:
    key_row = db.execute(select(SigningKey)).scalars().first()
    if key_row is None:
        key_row = SigningKey(key=secrets.token_hex(32))
        db.add(key_row)
        db.commit()
        db.refresh(key_row)
    return key_row.key


def create_access_token(db: Session, role: str) -> str:
    signing_key = get_signing_key(db)
    now = utc_now()
    payload = {
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + ACCESS_TOKEN_LIFETIME).timestamp()),
    }
    return jwt.encode(payload, signing_key, algorithm=JWT_ALGORITHM)


def _decode_role(authorization: str | None, db: Session) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401, detail="Missing or malformed Authorization header"
        )
    token = authorization.removeprefix("Bearer ")
    signing_key = get_signing_key(db)
    try:
        payload = jwt.decode(token, signing_key, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid or expired token")
    return payload["role"]


def require_role(*allowed_roles: str):
    """FastAPI dependency factory. `admin` always passes, regardless of
    `allowed_roles`. Calling with no `allowed_roles` means admin-only."""

    def _dependency(
        authorization: str | None = Header(None),
        db: Session = Depends(get_db),
    ) -> str:
        role = _decode_role(authorization, db)
        if allowed_roles and role != "admin" and role not in allowed_roles:
            raise HTTPException(
                status_code=403, detail="This role cannot perform this operation"
            )
        return role

    return _dependency


require_admin = require_role()
require_any_role = require_role(*ROLES)
require_scorer_or_referee = require_role("scorer", "referee")
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest tests/test_auth_core.py -v`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/tournament_server/auth.py tests/test_auth_core.py
git commit -m "Add core auth module: password hashing, JWT tokens, require_role"
```

---

## Task 3: Auth router — login, refresh, logout, password-change, sessions

**Files:**
- Create: `src/tournament_server/schemas/auth.py`
- Create: `src/tournament_server/routers/auth.py`
- Create: `tests/auth_helpers.py`
- Modify: `src/tournament_server/app.py`
- Test: `tests/test_auth.py`

**Interfaces:**
- Consumes: everything from Task 2's `tournament_server.auth`; `RoleCredential`,
  `AuthSession` (Task 1).
- Produces: `POST /api/auth/login`, `POST /api/auth/refresh`,
  `POST /api/auth/logout`, `PATCH /api/auth/passwords/{role}`,
  `GET /api/auth/sessions`, `DELETE /api/auth/sessions/{id}`. Also
  `tests/auth_helpers.py`'s `TEST_PASSWORD: str` and
  `login_as(raw_client, role, password=TEST_PASSWORD) -> str` (returns an
  access token), used by this task's tests, Task 4's tests, and Task 10's
  representative authorization tests.

Note: `RoleCredential` rows don't exist yet at this point in the plan
(Task 4 wires `POST /api/event` to create them) — so this task's tests
build their own `RoleCredential`/`Event` rows directly via a raw SQLAlchemy
session against the app's temp db, bypassing the HTTP layer, exactly the
way `tests/test_db.py` and this plan's Task 1/2 tests already do.

- [ ] **Step 1: Write `tests/auth_helpers.py`**

```python
from __future__ import annotations

from fastapi.testclient import TestClient

TEST_PASSWORD = "test-password"


def login_as(raw_client: TestClient, role: str, password: str = TEST_PASSWORD) -> str:
    response = raw_client.post(
        "/api/auth/login", json={"role": role, "password": password}
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
```

- [ ] **Step 2: Write the failing tests**

Create `tests/test_auth.py`:

```python
from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from auth_helpers import TEST_PASSWORD, bearer, login_as
from tournament_server.auth import ROLES, hash_password
from tournament_server.models.event import Event
from tournament_server.models.role_credential import RoleCredential


def _seed_event_and_credentials(app, password: str = TEST_PASSWORD) -> None:
    db = app.state.session_factory()
    try:
        db.add(Event(name="Regional Qualifier"))
        password_hash = hash_password(password)
        for role in ROLES:
            db.add(RoleCredential(role=role, password_hash=password_hash))
        db.commit()
    finally:
        db.close()


def _raw_client(client: TestClient) -> TestClient:
    # `client`'s app is already built; construct an unwrapped TestClient
    # against the same app so login state isn't auto-injected.
    raw = TestClient(client.app)
    _seed_event_and_credentials(client.app)
    return raw


def test_login_succeeds_for_every_role(client):
    raw = _raw_client(client)
    for role in ROLES:
        response = raw.post(
            "/api/auth/login", json={"role": role, "password": TEST_PASSWORD}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert "access_token" in body
        assert "refresh_token" in body
        assert body["expires_in"] == 1800


def test_login_rejects_wrong_password(client):
    raw = _raw_client(client)
    response = raw.post(
        "/api/auth/login", json={"role": "admin", "password": "wrong-password"}
    )
    assert response.status_code == 401


def test_login_rejects_unknown_role(client):
    raw = _raw_client(client)
    response = raw.post(
        "/api/auth/login", json={"role": "coach", "password": TEST_PASSWORD}
    )
    assert response.status_code == 422


def test_refresh_issues_a_new_token_pair(client):
    raw = _raw_client(client)
    login = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": TEST_PASSWORD}
    ).json()

    response = raw.post(
        "/api/auth/refresh", json={"refresh_token": login["refresh_token"]}
    )
    assert response.status_code == 200
    refreshed = response.json()
    assert refreshed["access_token"] != login["access_token"]
    assert refreshed["refresh_token"] != login["refresh_token"]


def test_replaying_a_rotated_refresh_token_fails(client):
    raw = _raw_client(client)
    login = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": TEST_PASSWORD}
    ).json()
    raw.post("/api/auth/refresh", json={"refresh_token": login["refresh_token"]})

    replay = raw.post(
        "/api/auth/refresh", json={"refresh_token": login["refresh_token"]}
    )
    assert replay.status_code == 401


def test_refresh_rejects_unknown_token(client):
    raw = _raw_client(client)
    response = raw.post(
        "/api/auth/refresh", json={"refresh_token": "not-a-real-token"}
    )
    assert response.status_code == 401


def test_logout_revokes_the_session(client):
    raw = _raw_client(client)
    login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": TEST_PASSWORD}
    ).json()

    logout = raw.post(
        "/api/auth/logout", json={"refresh_token": login["refresh_token"]}
    )
    assert logout.status_code == 204

    replay = raw.post(
        "/api/auth/refresh", json={"refresh_token": login["refresh_token"]}
    )
    assert replay.status_code == 401


def test_password_change_is_admin_only(client):
    raw = _raw_client(client)
    judge_token = login_as(raw, "judge")

    response = raw.patch(
        "/api/auth/passwords/judge",
        json={"password": "new-password"},
        headers=bearer(judge_token),
    )
    assert response.status_code == 403


def test_password_change_revokes_existing_sessions_for_that_role(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")
    judge_login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": TEST_PASSWORD}
    ).json()

    response = raw.patch(
        "/api/auth/passwords/judge",
        json={"password": "new-judge-password"},
        headers=bearer(admin_token),
    )
    assert response.status_code == 204

    # The old session's refresh token no longer works.
    stale_refresh = raw.post(
        "/api/auth/refresh", json={"refresh_token": judge_login["refresh_token"]}
    )
    assert stale_refresh.status_code == 401

    # The old password no longer logs in; the new one does.
    old_login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": TEST_PASSWORD}
    )
    assert old_login.status_code == 401
    new_login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": "new-judge-password"}
    )
    assert new_login.status_code == 200


def test_session_list_is_admin_only(client):
    raw = _raw_client(client)
    scorer_token = login_as(raw, "scorer")

    response = raw.get("/api/auth/sessions", headers=bearer(scorer_token))
    assert response.status_code == 403


def test_session_list_shows_active_sessions(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")
    raw.post(
        "/api/auth/login",
        json={"role": "scorer", "password": TEST_PASSWORD, "label": "Field 3 tablet"},
    )

    response = raw.get("/api/auth/sessions", headers=bearer(admin_token))
    assert response.status_code == 200
    sessions = response.json()
    labels = {s["label"] for s in sessions}
    assert "Field 3 tablet" in labels
    roles = {s["role"] for s in sessions}
    assert "admin" in roles and "scorer" in roles


def test_session_revoke_is_admin_only(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")
    scorer_login = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": TEST_PASSWORD}
    ).json()
    scorer_token = login_as(raw, "attendee")

    session_id = next(
        s["id"]
        for s in raw.get("/api/auth/sessions", headers=bearer(admin_token)).json()
        if s["role"] == "scorer"
    )

    forbidden = raw.delete(
        f"/api/auth/sessions/{session_id}", headers=bearer(scorer_token)
    )
    assert forbidden.status_code == 403

    response = raw.delete(
        f"/api/auth/sessions/{session_id}", headers=bearer(admin_token)
    )
    assert response.status_code == 204

    replay = raw.post(
        "/api/auth/refresh", json={"refresh_token": scorer_login["refresh_token"]}
    )
    assert replay.status_code == 401


def test_session_revoke_rejects_unknown_id(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")

    response = raw.delete("/api/auth/sessions/999999", headers=bearer(admin_token))
    assert response.status_code == 404
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pytest tests/test_auth.py -v`
Expected: FAIL with 404s (no `/api/auth/*` routes registered yet) or
`ModuleNotFoundError` for `tournament_server.schemas.auth`.

- [ ] **Step 4: Write `src/tournament_server/schemas/auth.py`**

```python
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict


class LoginRequest(BaseModel):
    role: str
    password: str
    label: str | None = None


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


class PasswordChangeRequest(BaseModel):
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int


class AuthSessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    issued_at: dt.datetime
    label: str | None
```

- [ ] **Step 5: Write `src/tournament_server/routers/auth.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import (
    ACCESS_TOKEN_LIFETIME_SECONDS,
    REFRESH_TOKEN_LIFETIME,
    ROLES,
    create_access_token,
    generate_refresh_token,
    hash_password,
    hash_token,
    require_admin,
    require_any_role,
    verify_password,
)
from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.models.auth_session import AuthSession
from tournament_server.models.role_credential import RoleCredential
from tournament_server.schemas.auth import (
    AuthSessionRead,
    LoginRequest,
    LogoutRequest,
    PasswordChangeRequest,
    RefreshRequest,
    TokenResponse,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _get_credential(db: Session, role: str) -> RoleCredential | None:
    return db.execute(
        select(RoleCredential).where(RoleCredential.role == role)
    ).scalars().first()


def _issue_tokens(db: Session, role: str, label: str | None) -> TokenResponse:
    access_token = create_access_token(db, role)
    refresh_token = generate_refresh_token()
    now = utc_now()
    db.add(
        AuthSession(
            role=role,
            refresh_token_hash=hash_token(refresh_token),
            issued_at=now,
            expires_at=now + REFRESH_TOKEN_LIFETIME,
            label=label,
        )
    )
    db.commit()
    return TokenResponse(
        access_token=access_token,
        refresh_token=refresh_token,
        expires_in=ACCESS_TOKEN_LIFETIME_SECONDS,
    )


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, db: Session = Depends(get_db)) -> TokenResponse:
    if payload.role not in ROLES:
        raise HTTPException(status_code=422, detail=f"Unknown role: {payload.role!r}")
    credential = _get_credential(db, payload.role)
    if credential is None or not verify_password(payload.password, credential.password_hash):
        raise HTTPException(status_code=401, detail="Invalid role or password")
    return _issue_tokens(db, payload.role, payload.label)


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, db: Session = Depends(get_db)) -> TokenResponse:
    token_hash = hash_token(payload.refresh_token)
    session_row = db.execute(
        select(AuthSession).where(AuthSession.refresh_token_hash == token_hash)
    ).scalars().first()
    now = utc_now()
    if session_row is None or session_row.revoked_at is not None or session_row.expires_at < now:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")
    session_row.revoked_at = now
    db.commit()
    return _issue_tokens(db, session_row.role, session_row.label)


@router.post("/logout", status_code=204)
def logout(
    payload: LogoutRequest,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> Response:
    token_hash = hash_token(payload.refresh_token)
    session_row = db.execute(
        select(AuthSession).where(AuthSession.refresh_token_hash == token_hash)
    ).scalars().first()
    if session_row is not None:
        session_row.revoked_at = utc_now()
        db.commit()
    return Response(status_code=204)


@router.patch("/passwords/{role}", status_code=204)
def change_password(
    role: str,
    payload: PasswordChangeRequest,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    if role not in ROLES:
        raise HTTPException(status_code=422, detail=f"Unknown role: {role!r}")
    credential = _get_credential(db, role)
    if credential is None:
        raise HTTPException(status_code=404, detail="Role credential not found")
    credential.password_hash = hash_password(payload.password)
    now = utc_now()
    active_sessions = db.execute(
        select(AuthSession).where(
            AuthSession.role == role, AuthSession.revoked_at.is_(None)
        )
    ).scalars().all()
    for session_row in active_sessions:
        session_row.revoked_at = now
    db.commit()
    return Response(status_code=204)


@router.get("/sessions", response_model=list[AuthSessionRead])
def list_sessions(
    db: Session = Depends(get_db), _role: str = Depends(require_admin)
) -> list[AuthSession]:
    now = utc_now()
    return list(
        db.execute(
            select(AuthSession).where(
                AuthSession.revoked_at.is_(None), AuthSession.expires_at >= now
            )
        ).scalars().all()
    )


@router.delete("/sessions/{session_id}", status_code=204)
def revoke_session(
    session_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    session_row = db.get(AuthSession, session_id)
    if session_row is None:
        raise HTTPException(status_code=404, detail="Session not found")
    session_row.revoked_at = utc_now()
    db.commit()
    return Response(status_code=204)
```

- [ ] **Step 6: Wire the auth router into `app.py`**

Edit `src/tournament_server/app.py` — add `auth` to the router import
list and `app.include_router(auth.router)` alongside the others:

```python
from tournament_server.routers import (
    audit_log,
    auth,
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
```

```python
    app.include_router(event.router)
    app.include_router(auth.router)
    app.include_router(sessions.router)
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pytest tests/test_auth.py tests/test_auth_core.py tests/test_auth_models.py -v`
Expected: PASS (all tests)

- [ ] **Step 8: Run the full existing suite to confirm no regressions**

Run: `pytest tests/ -v`
Expected: PASS — nothing outside the new auth files has changed yet, so
every pre-existing test still passes unchanged.

- [ ] **Step 9: Commit**

```bash
git add src/tournament_server/schemas/auth.py src/tournament_server/routers/auth.py \
  src/tournament_server/app.py tests/auth_helpers.py tests/test_auth.py
git commit -m "Add the auth router: login, refresh, logout, password-change, sessions"
```

---

## Task 4: Event creation requires a password; auto-authenticating test fixtures

**Files:**
- Modify: `src/tournament_server/schemas/event.py`
- Modify: `src/tournament_server/routers/event.py`
- Modify: `tests/conftest.py`
- Modify: `tests/test_event.py` (new tests only — nothing existing changes)
- Modify: `tests/test_auth.py` (new tests only)

**Interfaces:**
- Consumes: `hash_password`, `require_admin`, `ROLES` from
  `tournament_server.auth` (Task 2); `RoleCredential` (Task 1);
  `TEST_PASSWORD` from `tests/auth_helpers.py` (Task 3).
- Produces: `EventCreate.password: str` (required); `POST /api/event`
  creates all six `RoleCredential` rows; `POST /api/event/active-session`
  and `POST /api/event/game-plugin` now require `admin`.

This task is the pivot point: after Step 1-4 land, every pre-existing
test calling `client.post("/api/event", json={"name": ...})` would 422
(missing `password`) until Step 5's fixture change lands in the same
task. Do Steps 1-6 together before running the full suite.

- [ ] **Step 1: Write the failing "password required" test**

Add to `tests/test_event.py` (uses a raw, unwrapped client — per spec §6,
a test exercising the bootstrap flow itself constructs its own client
rather than using the auto-authenticating `client` fixture):

```python
def test_create_event_requires_password(tmp_path):
    from fastapi.testclient import TestClient

    from tournament_server.app import create_app

    app = create_app(db_path=str(tmp_path / "test.db"), plugins_root=str(tmp_path / "plugins"))
    raw_client = TestClient(app)

    response = raw_client.post("/api/event", json={"name": "Regional Qualifier"})
    assert response.status_code == 422
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest tests/test_event.py::test_create_event_requires_password -v`
Expected: FAIL — currently 201, since `password` isn't required yet.

- [ ] **Step 3: Add `password` to `EventCreate`**

Edit `src/tournament_server/schemas/event.py`:

```python
class EventCreate(BaseModel):
    name: str
    password: str
```

- [ ] **Step 4: Wire `RoleCredential` creation and `require_admin` into `event.py`**

Edit `src/tournament_server/routers/event.py`:

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from tournament_server.auth import ROLES, hash_password, require_admin
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.event import Event
from tournament_server.models.role_credential import RoleCredential
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.event import (
    ActiveSessionUpdate,
    EventCreate,
    EventRead,
    GamePluginSelect,
)

router = APIRouter(prefix="/api/event", tags=["event"])


@router.post("", response_model=EventRead, status_code=201)
def create_event(payload: EventCreate, db: Session = Depends(get_db)) -> Event:
    if get_the_event(db) is not None:
        raise HTTPException(status_code=409, detail="Event already initialized")
    event = Event(name=payload.name)
    db.add(event)
    password_hash = hash_password(payload.password)
    for role in ROLES:
        db.add(RoleCredential(role=role, password_hash=password_hash))
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
    payload: ActiveSessionUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
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


@router.post("/game-plugin", response_model=EventRead)
def select_game_plugin(
    payload: GamePluginSelect,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
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

(Only the imports, `create_event`'s body, and the two `Depends(require_admin)`
parameters changed; `read_event`'s body is unchanged and still takes no
auth dependency at all.)

- [ ] **Step 5: Add the auto-authenticating `TestClient` subclass to `conftest.py`**

Edit `tests/conftest.py` — add the import and subclass, then use it in
place of `TestClient` in all three fixtures:

```python
from auth_helpers import TEST_PASSWORD
```

```python
class _AutoAuthTestClient(TestClient):
    def request(self, method, url, *args, **kwargs):
        if method.upper() == "POST" and url == "/api/event":
            json_body = kwargs.get("json")
            if json_body is not None and "password" not in json_body:
                kwargs["json"] = {**json_body, "password": TEST_PASSWORD}
            response = super().request(method, url, *args, **kwargs)
            if response.status_code == 201:
                login = super().request(
                    "POST",
                    "/api/auth/login",
                    json={"role": "admin", "password": TEST_PASSWORD},
                )
                token = login.json()["access_token"]
                self.headers["Authorization"] = f"Bearer {token}"
            return response
        return super().request(method, url, *args, **kwargs)
```

Then, in each of `client`, `cooperative_client`, and `captain_pick_client`,
replace `return TestClient(app)` with `return _AutoAuthTestClient(app)`
(three call sites, one per fixture).

- [ ] **Step 6: Run test to verify it passes**

Run: `pytest tests/test_event.py::test_create_event_requires_password -v`
Expected: PASS

- [ ] **Step 7: Write and run the `RoleCredential` shared-hash / independent-password tests**

Add to `tests/test_auth.py`:

```python
def test_event_creation_seeds_all_six_roles_with_the_shared_password(client):
    raw = TestClient(client.app)
    raw.post(
        "/api/event", json={"name": "Regional Qualifier", "password": TEST_PASSWORD}
    )
    for role in ROLES:
        response = raw.post(
            "/api/auth/login", json={"role": role, "password": TEST_PASSWORD}
        )
        assert response.status_code == 200, f"{role} could not log in"


def test_changing_one_roles_password_does_not_affect_others(client):
    raw = TestClient(client.app)
    raw.post(
        "/api/event", json={"name": "Regional Qualifier", "password": TEST_PASSWORD}
    )
    admin_token = login_as(raw, "admin")

    raw.patch(
        "/api/auth/passwords/scorer",
        json={"password": "scorer-only-password"},
        headers=bearer(admin_token),
    )

    scorer_old = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": TEST_PASSWORD}
    )
    assert scorer_old.status_code == 401
    scorer_new = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": "scorer-only-password"}
    )
    assert scorer_new.status_code == 200

    for other_role in ("judge", "referee", "attendee", "display_device"):
        response = raw.post(
            "/api/auth/login", json={"role": other_role, "password": TEST_PASSWORD}
        )
        assert response.status_code == 200, f"{other_role} should be unaffected"
```

Add `from fastapi.testclient import TestClient` to `tests/test_auth.py`'s
imports if not already present (it is, from Step 2 of Task 3).

Run: `pytest tests/test_auth.py -v`
Expected: PASS (all tests, including the two new ones)

- [ ] **Step 8: Run the full suite**

Run: `pytest tests/ -v`
Expected: PASS, with exactly one known, expected failure:
`test_event.py::test_select_game_plugin_requires_event` — it calls
`POST /api/event/game-plugin` without ever creating an event (so without
ever logging in), and that endpoint now correctly 401s before it can 404.
This is fixed in Task 9 (see Global Constraints, "Spec correction #2").
Confirm no *other* tests fail at this point — if any do, something
besides this known case regressed and must be investigated before moving
on.

- [ ] **Step 9: Commit**

```bash
git add src/tournament_server/schemas/event.py src/tournament_server/routers/event.py \
  tests/conftest.py tests/test_event.py tests/test_auth.py
git commit -m "Require a password on event creation; seed all six role credentials"
```

---

## Task 5: Gate the simple CRUD routers (admin-write / any-role-read)

**Files:**
- Modify: `src/tournament_server/routers/sessions.py`
- Modify: `src/tournament_server/routers/divisions.py`
- Modify: `src/tournament_server/routers/field_sets.py`
- Modify: `src/tournament_server/routers/fields.py`
- Modify: `src/tournament_server/routers/teams.py`
- Modify: `src/tournament_server/routers/participation.py`

**Interfaces:**
- Consumes: `require_admin`, `require_any_role` from `tournament_server.auth`.

Per spec §4's table: all six of these routers get `admin`-only writes
(POST/PATCH) and any-authenticated-role reads (GET), with no named
exceptions.

- [ ] **Step 1: `sessions.py`**

```python
from __future__ import annotations

from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.session import SessionCreate, SessionRead

router = APIRouter(prefix="/api/sessions", tags=["sessions"])


@router.post("", response_model=SessionRead, status_code=201)
def create_session(
    payload: SessionCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> TournamentSession:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if payload.timezone is not None:
        try:
            ZoneInfo(payload.timezone)
        except (ZoneInfoNotFoundError, ValueError):
            raise HTTPException(
                status_code=422, detail=f"Unknown timezone: {payload.timezone!r}"
            )
    session_obj = TournamentSession(
        event_id=event.id,
        label=payload.label,
        session_date=payload.session_date,
        timezone=payload.timezone,
    )
    db.add(session_obj)
    db.commit()
    db.refresh(session_obj)
    return session_obj


@router.get("", response_model=list[SessionRead])
def list_sessions(
    db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> list[TournamentSession]:
    return list(db.execute(select(TournamentSession)).scalars().all())
```

- [ ] **Step 2: `divisions.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.division import Division
from tournament_server.schemas.division import DivisionCreate, DivisionRead

router = APIRouter(prefix="/api/divisions", tags=["divisions"])


@router.post("", response_model=DivisionRead, status_code=201)
def create_division(
    payload: DivisionCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
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
def list_divisions(
    db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> list[Division]:
    return list(db.execute(select(Division)).scalars().all())
```

- [ ] **Step 3: `field_sets.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_session_id
from tournament_server.models.division import Division
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field_set import FieldSetCreate, FieldSetRead, FieldSetUpdate

router = APIRouter(prefix="/api/field-sets", tags=["field-sets"])


@router.post("", response_model=FieldSetRead, status_code=201)
def create_field_set(
    payload: FieldSetCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FieldSet:
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")
    field_set = FieldSet(
        session_id=payload.session_id,
        name=payload.name,
        division_id=payload.division_id,
    )
    db.add(field_set)
    db.commit()
    db.refresh(field_set)
    return field_set


@router.patch("/{field_set_id}", response_model=FieldSetRead)
def update_field_set(
    field_set_id: int,
    payload: FieldSetUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FieldSet:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")
    field_set.division_id = payload.division_id
    db.commit()
    db.refresh(field_set)
    return field_set


@router.get("", response_model=list[FieldSetRead])
def list_field_sets(
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[FieldSet]:
    return list(
        db.execute(
            select(FieldSet).where(FieldSet.session_id == session_id)
        ).scalars().all()
    )
```

- [ ] **Step 4: `fields.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_session_id
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.field import FieldCreate, FieldRead

router = APIRouter(prefix="/api/fields", tags=["fields"])


@router.post("", response_model=FieldRead, status_code=201)
def create_field(
    payload: FieldCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Field:
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    field_set_id = payload.field_set_id
    if field_set_id is None:
        existing_sets = db.execute(
            select(FieldSet).where(FieldSet.session_id == payload.session_id)
        ).scalars().all()
        if len(existing_sets) == 0:
            default_set = FieldSet(session_id=payload.session_id, name="Main Fields")
            db.add(default_set)
            db.flush()
            field_set_id = default_set.id
        elif len(existing_sets) == 1:
            field_set_id = existing_sets[0].id
        else:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Multiple FieldSets exist for this session; field_set_id "
                    "must be specified"
                ),
            )
    else:
        field_set = db.get(FieldSet, field_set_id)
        if field_set is None or field_set.session_id != payload.session_id:
            raise HTTPException(status_code=404, detail="FieldSet not found")

    field = Field(field_set_id=field_set_id, name=payload.name)
    db.add(field)
    db.commit()
    db.refresh(field)
    return field


@router.get("", response_model=list[FieldRead])
def list_fields(
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[Field]:
    field_set_ids = [
        row.id
        for row in db.execute(
            select(FieldSet).where(FieldSet.session_id == session_id)
        ).scalars().all()
    ]
    if not field_set_ids:
        return []
    return list(
        db.execute(
            select(Field).where(Field.field_set_id.in_(field_set_ids))
        ).scalars().all()
    )
```

- [ ] **Step 5: `teams.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.division import Division
from tournament_server.models.team import Team
from tournament_server.schemas.team import TeamCreate, TeamRead, TeamUpdate

router = APIRouter(prefix="/api/teams", tags=["teams"])


@router.post("", response_model=TeamRead, status_code=201)
def create_team(
    payload: TeamCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Team:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if payload.division_id is not None:
        if db.get(Division, payload.division_id) is None:
            raise HTTPException(status_code=404, detail="Division not found")
    team = Team(event_id=event.id, **payload.model_dump())
    db.add(team)
    db.commit()
    db.refresh(team)
    return team


@router.get("", response_model=list[TeamRead])
def list_teams(
    db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> list[Team]:
    return list(db.execute(select(Team)).scalars().all())


@router.get("/{team_id}", response_model=TeamRead)
def get_team(
    team_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    return team


@router.patch("/{team_id}", response_model=TeamRead)
def update_team(
    team_id: int,
    payload: TeamUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    updates = payload.model_dump(exclude_unset=True)
    for required_field in ("number", "name"):
        if required_field in updates and updates[required_field] is None:
            raise HTTPException(
                status_code=422, detail=f"{required_field} cannot be null"
            )
    if "division_id" in updates and updates["division_id"] is not None:
        if db.get(Division, updates["division_id"]) is None:
            raise HTTPException(status_code=404, detail="Division not found")
    for key, value in updates.items():
        setattr(team, key, value)
    db.commit()
    db.refresh(team)
    return team
```

- [ ] **Step 6: `participation.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
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
    session_id: int,
    payload: ParticipationCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
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
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=409, detail="Team already checked in for this session"
        )
    db.refresh(participation)
    return participation


@router.get(
    "/{session_id}/participants", response_model=list[ParticipationRead]
)
def list_participants(
    session_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
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

- [ ] **Step 7: Run the full suite**

Run: `pytest tests/ -v`
Expected: same single known failure as after Task 4
(`test_select_game_plugin_requires_event`), plus three new known failures
from this task: `test_divisions.py::test_create_division_requires_event`,
`test_sessions.py::test_create_session_requires_event`,
`test_teams.py::test_create_team_requires_event`, and
`test_field_sets.py::test_create_field_set_rejects_unknown_session` — all
for the identical structural reason (401 before 404, no way to log in
before an event exists), all fixed together in Task 9. Confirm no *other*
tests fail.

- [ ] **Step 8: Commit**

```bash
git add src/tournament_server/routers/sessions.py src/tournament_server/routers/divisions.py \
  src/tournament_server/routers/field_sets.py src/tournament_server/routers/fields.py \
  src/tournament_server/routers/teams.py src/tournament_server/routers/participation.py
git commit -m "Gate sessions/divisions/field-sets/fields/teams/participation with require_role"
```

---

## Task 6: Gate matches, ranking-configuration, rankings, schedule, finals

**Files:**
- Modify: `src/tournament_server/routers/matches.py`
- Modify: `src/tournament_server/routers/ranking_configuration.py`
- Modify: `src/tournament_server/routers/rankings.py`
- Modify: `src/tournament_server/routers/schedule.py`
- Modify: `src/tournament_server/routers/finals.py`

**Interfaces:**
- Consumes: `require_admin`, `require_any_role` from `tournament_server.auth`.

`rankings` is the one router not explicitly named in the spec's §4 table
(see Global Constraints, "Spec correction #1") — it gets the same
any-authenticated-role read as every other unnamed-exception router,
since it's a plain `GET`-only router with no write endpoints at all.

- [ ] **Step 1: `matches.py`** — add the import, and
  `_role: str = Depends(require_admin)` to `create_match`,
  `_role: str = Depends(require_any_role)` to `list_matches` and `get_match`:

```python
from tournament_server.auth import require_admin, require_any_role
```

```python
@router.post("", response_model=MatchRead, status_code=201)
def create_match(
    payload: MatchCreate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> MatchRead:
```

```python
@router.get("", response_model=list[MatchRead])
def list_matches(
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[MatchRead]:
```

```python
@router.get("/{match_id}", response_model=MatchRead)
def get_match(
    match_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> MatchRead:
```

(Function bodies are unchanged — only the added import and the new
`_role` parameter on each of the three route functions.)

- [ ] **Step 2: `ranking_configuration.py`** — add the import, and
  `_role: str = Depends(require_admin)` to `set_ranking_configuration`,
  `_role: str = Depends(require_any_role)` to `get_ranking_configuration`:

```python
from tournament_server.auth import require_admin, require_any_role
```

```python
@router.post("", response_model=RankingConfigurationRead, status_code=201)
def set_ranking_configuration(
    payload: RankingConfigurationSet,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> RankingConfiguration:
```

```python
@router.get("", response_model=RankingConfigurationRead)
def get_ranking_configuration(
    division_id: int | None = Query(None),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> RankingConfiguration:
```

- [ ] **Step 3: `rankings.py`** — add the import and
  `_role: str = Depends(require_any_role)` to `get_rankings`:

```python
from tournament_server.auth import require_any_role
```

```python
@router.get("", response_model=list[RankingRead])
def get_rankings(
    division_id: int | None = Query(None),
    event_wide: bool = Query(False),
    session_id: int | None = Query(None),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[Ranking]:
```

- [ ] **Step 4: `schedule.py`** — add the import, and
  `_role: str = Depends(require_admin)` to `generate_schedule` and
  `clear_schedule`:

```python
from tournament_server.auth import require_admin
```

```python
@router.post("", response_model=ScheduleGenerateResponse, status_code=201)
def generate_schedule(
    payload: ScheduleGenerateRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> ScheduleGenerateResponse:
```

```python
@router.delete("")
def clear_schedule(
    request: Request,
    session_id: int = Query(...),
    division_id: int | None = Query(None),
    round_type: str = Query(...),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> dict[str, int]:
```

- [ ] **Step 5: `finals.py`** — add the import, and
  `_role: str = Depends(require_admin)` to `start_finals`, `pick_partner`,
  `mark_alliance_unavailable`, and `delete_finals`;
  `_role: str = Depends(require_any_role)` to `get_finals`:

```python
from tournament_server.auth import require_admin, require_any_role
```

```python
@router.post("/start", response_model=FinalsBracketRead, status_code=201)
def start_finals(
    payload: FinalsStartRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FinalsBracketRead:
```

```python
@router.get("/{bracket_id}", response_model=FinalsBracketRead)
def get_finals(
    bracket_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> FinalsBracketRead:
```

```python
@router.post("/{bracket_id}/pick", response_model=FinalsBracketRead)
def pick_partner(
    bracket_id: int,
    payload: FinalsPickRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FinalsBracketRead:
```

```python
@router.post(
    "/{bracket_id}/alliances/{alliance_id}/unavailable", response_model=FinalsBracketRead
)
def mark_alliance_unavailable(
    bracket_id: int,
    alliance_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> FinalsBracketRead:
```

```python
@router.delete("/{bracket_id}", status_code=204)
def delete_finals(
    bracket_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
```

(All five function bodies are unchanged — only the added import and the
new `_role` parameter on each.)

- [ ] **Step 6: Run the full suite**

Run: `pytest tests/ -v`
Expected: same known failures as after Task 5, plus one new one:
`test_matches.py::test_get_missing_match_returns_404` (calls `GET
/api/matches/999` with no event ever created — same structural reason,
fixed in Task 9). Confirm no other tests fail.

- [ ] **Step 7: Commit**

```bash
git add src/tournament_server/routers/matches.py src/tournament_server/routers/ranking_configuration.py \
  src/tournament_server/routers/rankings.py src/tournament_server/routers/schedule.py \
  src/tournament_server/routers/finals.py
git commit -m "Gate matches/ranking-configuration/rankings/schedule/finals with require_role"
```

---

## Task 7: Gate the scores router (scorer/referee write exception)

**Files:**
- Modify: `src/tournament_server/routers/scores.py`

**Interfaces:**
- Consumes: `require_scorer_or_referee` from `tournament_server.auth`.

Per spec §4: `scores` is the one router whose write is *not* admin-only —
`admin`, `scorer`, and `referee` may all submit scores. There's no `GET`
endpoint in this router to gate separately.

- [ ] **Step 1: Add the import and dependency to `submit_score`**

```python
from tournament_server.auth import require_scorer_or_referee
```

```python
@router.post("/{match_id}/alliances/{alliance_id}/score", response_model=ScoreRecordRead)
def submit_score(
    match_id: int,
    alliance_id: int,
    payload: ScoreSubmit,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
) -> ScoreRecordRead:
```

(The rest of the function body is unchanged.)

- [ ] **Step 2: Run the full suite**

Run: `pytest tests/ -v`
Expected: identical failure set to the end of Task 6 — `_setup_match`
(used throughout `test_scores.py` and `test_cooperative_scoring.py`)
always creates an event first via the `client` fixture, so it's already
authenticated as admin, which passes `require_scorer_or_referee`.

- [ ] **Step 3: Commit**

```bash
git add src/tournament_server/routers/scores.py
git commit -m "Gate the scores router: admin, scorer, and referee may submit scores"
```

---

## Task 8: Gate audit-log and plugins routers (admin-only read exception)

**Files:**
- Modify: `src/tournament_server/routers/audit_log.py`
- Modify: `src/tournament_server/routers/plugins.py`

**Interfaces:**
- Consumes: `require_admin` from `tournament_server.auth`.

Per spec §4: both routers are admin-only for *reads too* (not just
writes) — "operational/sensitive, not event-day data."

- [ ] **Step 1: `audit_log.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.audit import AuditLog
from tournament_server.auth import require_admin
from tournament_server.deps import get_db
from tournament_server.schemas.audit import AuditLogRead

router = APIRouter(prefix="/api/audit-log", tags=["audit-log"])


@router.get("", response_model=list[AuditLogRead])
def list_audit_log(
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> list[AuditLogRead]:
    rows = (
        db.execute(
            select(AuditLog).order_by(AuditLog.id).limit(limit).offset(offset)
        )
        .scalars()
        .all()
    )
    return [AuditLogRead.from_orm_obj(row) for row in rows]
```

- [ ] **Step 2: `plugins.py`**

```python
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, UploadFile

from tournament_server.auth import require_admin
from tournament_server.plugin_registry.errors import (
    PluginAlreadyExistsError,
    PluginInstallError,
)
from tournament_server.plugin_registry.loader import SCHEDULER_PLUGIN_KIND
from tournament_server.plugin_registry.zip_install import install_plugin_zip

router = APIRouter(prefix="/api/plugins/games", tags=["plugins"])


@router.get("")
def list_game_plugins(
    request: Request, _role: str = Depends(require_admin)
) -> list[dict[str, str]]:
    registry = request.app.state.game_plugins
    return [
        {"name": p.name, "version": p.version, "display_name": p.display_name}
        for p in registry.values()
    ]


@router.post("", status_code=201)
def upload_game_plugin(
    request: Request, file: UploadFile, _role: str = Depends(require_admin)
) -> dict[str, str]:
    zip_bytes = file.file.read()
    plugins_root = request.app.state.plugins_root
    try:
        plugin = install_plugin_zip(zip_bytes, plugins_root)
    except PluginAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except PluginInstallError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    request.app.state.game_plugins[plugin.name] = plugin
    return {
        "name": plugin.name,
        "version": plugin.version,
        "display_name": plugin.display_name,
    }


scheduler_router = APIRouter(prefix="/api/plugins/schedulers", tags=["plugins"])


@scheduler_router.get("")
def list_scheduler_plugins(
    request: Request, _role: str = Depends(require_admin)
) -> list[dict[str, str]]:
    registry = request.app.state.scheduler_plugins
    return [
        {"name": p.name, "version": p.version, "display_name": p.display_name}
        for p in registry.values()
    ]


@scheduler_router.post("", status_code=201)
def upload_scheduler_plugin(
    request: Request, file: UploadFile, _role: str = Depends(require_admin)
) -> dict[str, str]:
    zip_bytes = file.file.read()
    plugins_root = request.app.state.plugins_root
    try:
        plugin = install_plugin_zip(zip_bytes, plugins_root, SCHEDULER_PLUGIN_KIND)
    except PluginAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except PluginInstallError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    request.app.state.scheduler_plugins[plugin.name] = plugin
    return {
        "name": plugin.name,
        "version": plugin.version,
        "display_name": plugin.display_name,
    }
```

- [ ] **Step 3: Run the full suite**

Run: `pytest tests/ -v`
Expected: the known failure set grows by the four `test_plugins_router.py`
tests that use the `client` fixture without ever creating an event
(`test_list_game_plugins_shows_preseeded_plugin`,
`test_upload_game_plugin_installs_and_lists_immediately`,
`test_upload_duplicate_plugin_name_returns_409`,
`test_upload_malformed_zip_returns_422`) — same structural reason, fixed
in Task 9. `test_list_game_plugins_discovers_at_startup` is unaffected
(it builds its own raw `TestClient` and only asserts against a fresh,
un-authenticated 200 response today — check this one specifically; if it
still expects 200, it needs the same 401 fix as the others in Task 9).
Confirm no other tests fail.

- [ ] **Step 4: Commit**

```bash
git add src/tournament_server/routers/audit_log.py src/tournament_server/routers/plugins.py
git commit -m "Gate audit-log and plugins routers as admin-only, including reads"
```

---

## Task 9: Fix the 10 pre-existing tests that now correctly 401

**Files:**
- Modify: `tests/test_event.py`
- Modify: `tests/test_divisions.py`
- Modify: `tests/test_sessions.py`
- Modify: `tests/test_teams.py`
- Modify: `tests/test_field_sets.py`
- Modify: `tests/test_matches.py`
- Modify: `tests/test_plugins_router.py`

Every test touched here calls an endpoint that now requires
authentication using a client that never created an event (so never
logged in, so has no token). Before this phase, these tests asserted
whatever domain-logic status code the handler happened to return first
(404, or even 200/201/409/422 for the plugins ones); now `require_role`'s
`Depends(...)` runs first and correctly 401s. This is the fix described
in Global Constraints, "Spec correction #2" — not a workaround, the
actual correct behavior.

- [ ] **Step 1: `tests/test_event.py`** — change
  `test_select_game_plugin_requires_event`:

```python
def test_select_game_plugin_requires_event(client):
    response = client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert response.status_code == 401
```

(Was `assert response.status_code == 404`.)

- [ ] **Step 2: `tests/test_divisions.py`** — change
  `test_create_division_requires_event`:

```python
def test_create_division_requires_event(client):
    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 401
```

- [ ] **Step 3: `tests/test_sessions.py`** — change
  `test_create_session_requires_event`:

```python
def test_create_session_requires_event(client):
    response = client.post("/api/sessions", json={"label": "Session 1"})
    assert response.status_code == 401
```

- [ ] **Step 4: `tests/test_teams.py`** — change
  `test_create_team_requires_event`:

```python
def test_create_team_requires_event(client):
    response = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    assert response.status_code == 401
```

- [ ] **Step 5: `tests/test_field_sets.py`** — change
  `test_create_field_set_rejects_unknown_session`:

```python
def test_create_field_set_rejects_unknown_session(client):
    response = client.post(
        "/api/field-sets", json={"session_id": 999, "name": "Main Fields"}
    )
    assert response.status_code == 401
```

- [ ] **Step 6: `tests/test_matches.py`** — change
  `test_get_missing_match_returns_404`:

```python
def test_get_missing_match_returns_401_without_a_session(client):
    response = client.get("/api/matches/999")
    assert response.status_code == 401
```

(Renamed too, since it no longer tests a 404.)

- [ ] **Step 7: `tests/test_plugins_router.py`** — change all four
  affected tests to create an event and log in first (they can use the
  `client` fixture's auto-auth simply by calling `client.post("/api/event",
  ...)` before the rest of the test body, rather than asserting 401 —
  these are meant to keep testing the plugin-listing/upload behavior
  itself, not authentication):

```python
def test_list_game_plugins_shows_preseeded_plugin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.get("/api/plugins/games")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["name"] == "example-game"


def test_upload_game_plugin_installs_and_lists_immediately(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    zip_bytes = zip_fixture_plugin(FIXTURE_SECOND_GAME_PLUGIN)

    response = client.post(
        "/api/plugins/games",
        files={"file": ("second-game.zip", zip_bytes, "application/zip")},
    )
    assert response.status_code == 201
    assert response.json()["name"] == "second-game"

    listed = client.get("/api/plugins/games").json()
    names = {p["name"] for p in listed}
    assert "second-game" in names
    assert "example-game" in names  # the pre-seeded one is still there too


def test_upload_duplicate_plugin_name_returns_409(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    zip_bytes = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)
    client.post(
        "/api/plugins/games",
        files={"file": ("example-game.zip", zip_bytes, "application/zip")},
    )

    response = client.post(
        "/api/plugins/games",
        files={"file": ("example-game.zip", zip_bytes, "application/zip")},
    )
    assert response.status_code == 409


def test_upload_malformed_zip_returns_422(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/plugins/games",
        files={"file": ("bad.zip", b"not a zip file", "application/zip")},
    )
    assert response.status_code == 422
```

Also check `test_list_game_plugins_discovers_at_startup` (it builds its
own raw `TestClient`, not the `client` fixture): if it still expects a
plain `200` from an unauthenticated `GET /api/plugins/games`, update it
the same way this task fixes the others — create an event and log in
first using the same `auth_helpers.login_as` helper and pass the token:

```python
def test_list_game_plugins_discovers_at_startup(tmp_path):
    plugins_root = tmp_path / "plugins"
    target = plugins_root / "games" / "example-game"
    target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, target)

    app = create_app(
        db_path=str(tmp_path / "test.db"), plugins_root=str(plugins_root)
    )
    test_client = TestClient(app)
    test_client.post(
        "/api/event", json={"name": "Regional Qualifier", "password": TEST_PASSWORD}
    )
    token = login_as(test_client, "admin")

    response = test_client.get(
        "/api/plugins/games", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["name"] == "example-game"
    assert body[0]["version"] == "1.0.0"
```

Add `from auth_helpers import TEST_PASSWORD, login_as` to this file's imports.

- [ ] **Step 8: Run the full suite**

Run: `pytest tests/ -v`
Expected: PASS — every test in the suite passes (all 10 fixed here, plus
every test from Tasks 1-8 unaffected).

- [ ] **Step 9: Commit**

```bash
git add tests/test_event.py tests/test_divisions.py tests/test_sessions.py \
  tests/test_teams.py tests/test_field_sets.py tests/test_matches.py \
  tests/test_plugins_router.py
git commit -m "Update the 10 pre-existing tests whose 404 is now correctly a 401"
```

---

## Task 10: Representative 401/403 authorization tests

**Files:**
- Modify: `tests/test_divisions.py`
- Modify: `tests/test_scores.py`
- Modify: `tests/test_audit_log.py`

Per spec §6: "a handful of representative 401/403 checks spread across a
few different existing routers... to prove the `require_role` wiring is
actually active everywhere" — one test per distinct role-set shape, not
per endpoint. The four shapes: admin-only write + any-role read (covered
via `divisions`), the `scores` scorer/referee exception, and the
`audit_log`/`plugins` admin-only-read exception (covered via
`audit_log`).

- [ ] **Step 1: Admin-only write / any-role read — add to `tests/test_divisions.py`**

```python
from auth_helpers import bearer, login_as


def test_create_division_401s_without_a_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)  # a client sharing the same app, no auth header
    response = raw.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 401


def test_create_division_403s_for_non_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")

    response = raw.post(
        "/api/divisions", json={"name": "Elementary"}, headers=bearer(attendee_token)
    )
    assert response.status_code == 403


def test_list_divisions_open_to_any_authenticated_role(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")

    response = raw.get("/api/divisions", headers=bearer(attendee_token))
    assert response.status_code == 200
```

- [ ] **Step 2: The `scores` scorer/referee exception — add to `tests/test_scores.py`**

```python
from auth_helpers import bearer, login_as


def test_submit_score_403s_for_attendee(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers=bearer(attendee_token),
    )
    assert response.status_code == 403


def test_submit_score_succeeds_for_scorer_and_referee(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)

    for role in ("scorer", "referee"):
        token = login_as(raw, role)
        response = raw.post(
            f"/api/matches/{match_id}/alliances/{red_id}/score",
            json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
            headers=bearer(token),
        )
        assert response.status_code == 200, f"{role} should be able to submit a score"
```

(Uses `no_show: true` so the plugin's `calculate_score` is never invoked
and the payload's exact scoresheet shape doesn't matter — matching how
`test_no_show_zeroes_computed_score` in the same file already does this.)

- [ ] **Step 3: The `audit_log`/`plugins` admin-only-read exception — add to `tests/test_audit_log.py`**

```python
from auth_helpers import bearer, login_as


def test_list_audit_log_403s_for_non_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    scorer_token = login_as(raw, "scorer")

    response = raw.get("/api/audit-log", headers=bearer(scorer_token))
    assert response.status_code == 403
```

- [ ] **Step 4: Run the full suite**

Run: `pytest tests/ -v`
Expected: PASS (all tests, including the seven new ones added in this task)

- [ ] **Step 5: Commit**

```bash
git add tests/test_divisions.py tests/test_scores.py tests/test_audit_log.py
git commit -m "Add representative 401/403 authorization tests across role-set shapes"
```

---

## Task 11: Update `server/CLAUDE.md`'s known-gaps section

**Files:**
- Modify: `server/CLAUDE.md`

**Interfaces:** none (documentation only).

The "Known, deliberate gaps in this phase" section currently documents
the no-real-authentication state this phase closes. Update it so it no
longer describes a gap that no longer exists.

- [ ] **Step 1: Replace the stale bullet**

In `server/CLAUDE.md`, find the bullet starting "There's no real
authentication yet." and the following bullet about the plugin-install
endpoints' "same 'no real authentication' gap." Replace both with:

```markdown
- Real authentication now exists — see
  `docs/superpowers/specs/2026-09-03-real-authentication-design.md`. Six
  roles (`admin`, `scorer`, `judge`, `referee`, `attendee`,
  `display_device`) share one password per event until the Admin
  differentiates them; every endpoint requires a bearer JWT via
  `tournament_server.auth.require_role(...)`, with `admin` always
  passing regardless of what a given endpoint's allowed-roles list says.
  The plugin-install endpoints (`POST /api/plugins/games` and
  `POST /api/plugins/schedulers`) are gated `admin`-only like every other
  write in the `plugins` router — but note this is still a
  code-execution primitive available to any admin, not a sandboxed
  install; that hardening (checksums, capability scanning) is still a
  separate, later phase per the design spec's §9. `Device`/
  `ScoringDevice` admission — an *additional* per-device admission layer
  on top of a role's session — remains a distinct, unbuilt future phase
  (design spec §7).
```

- [ ] **Step 2: Commit**

```bash
git add server/CLAUDE.md
git commit -m "Update known-gaps doc now that real authentication exists"
```

---

## Task 12: Final full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the complete test suite from a clean venv state**

Run: `pytest tests/ -v`
Expected: PASS — every test passes, with no skips or expected failures
remaining.

- [ ] **Step 2: Spot-check the dev server boots**

Run: `rm -f tournament.db* && python -m tournament_server.main &` then
`curl -s http://127.0.0.1:8000/health` (expect `{"status":"ok"}`), then
`curl -s -X POST http://127.0.0.1:8000/api/event -H 'Content-Type:
application/json' -d '{"name": "Smoke Test", "password": "smoke-test"}'`
(expect a 201 with the event body), then stop the server.

Expected: the app starts cleanly against a fresh `.db` file (new tables
created via `Base.metadata.create_all()`) and event creation with a
password succeeds end-to-end.

- [ ] **Step 3: Confirm no stray references to the old header-based actor
  model exist in auth-relevant code paths**

Run: `grep -rn "X-Actor-Name" server/src/` — expected: only in
`app.py`'s `actor_middleware` (audit-log attribution, explicitly out of
scope for this phase per spec §1 — it's a convenience label, not a
security boundary, and this phase doesn't touch it).

This task has no commit of its own — it's the final gate before
considering the branch done. If Step 1 or Step 2 fails, return to the
relevant earlier task and fix it there (with its own commit) rather than
patching ad hoc here.
