# Device Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any browser pairs with the server by showing a short code that an admin enters; pairing grants the device a role, and admins manage paired devices from a new Devices page.

**Architecture:** Pairing codes live in an in-memory store on the server; a paired device holds a long-lived device token, swaps it for normal 30-minute access tokens that carry a `device_id` claim, and every request with that claim is checked against the `devices` table, so disable/delete/role changes apply on the next request. A new `frontend/apps/device` Vite app (served at `/device/`, with `/pair` redirecting there) shows the code and the device's state; the admin app gains a Devices page.

**Tech Stack:** FastAPI, SQLAlchemy, SQLite, Alembic (baseline edited in place), PyJWT; React 19, react-i18next, `qrcode`, TanStack Query (admin only), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-13-device-pairing-design.md`

## Global Constraints

- Never name any real-world competition brand or product anywhere (code, comments, tests, docs, commit messages, UI text).
- Commit messages are plain sentences and end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Until the first release, schema changes edit `server/src/tournament_server/_alembic/versions/000000000001_baseline.py` in place; never add a revision. `tests/test_alembic_drift.py` must pass.
- Every backend change ships with pytest; every UI change ships with Vitest, and the feature ships with Playwright.
- Every user-facing string goes through i18n with English and Chinese entries.
- Pairable roles are exactly `scorer`, `referee`, `judge`, `front_desk`, `display_device`. `admin` and `attendee` are never pairable.
- Code alphabet `ACDEFGHJKMNPQRTUVWXY34679`, 6 characters, shown as two groups of three; codes expire after 5 minutes; at most 50 open codes.
- Idle timeout default 240 minutes, allowed 15 to 1440; displays never go idle.
- Error copy, verbatim: `That code isn't valid or has expired.` / `A device with that name already exists.` / `Only a paired device can submit scores.` / `This device is disabled` / `This device is no longer paired`.
- The device app stores its token under `localStorage` key `tournament-admin.device.v1` and never reads or writes the admin's `tournament-admin.auth.v1`.
- WebSocket close code for a device whose state changed: `4403`.
- Do not open a running server's tournament database with sqlite directly.
- Server tests: `cd server && .venv/bin/python -m pytest -q`. Admin unit: `cd frontend/apps/admin && npx vitest run`. Device unit: `cd frontend/apps/device && npx vitest run`. Type check: `npx tsc -b` in each app.

## Review Focus

1. **A TV with a wrong clock.** The countdown and automatic renewal must come from `expires_in`, not the device clock compared with `expires_at` — Task 6 tests a code whose `expires_at` is in the device's past but `expires_in` is 300 and expects the code to stay on screen.
2. **Admin and device in the same browser.** Both apps share an origin; pairing a browser the admin is signed into must not sign the admin out or change the admin's tokens — Task 6 tests that storing and clearing the device token leaves `tournament-admin.auth.v1` untouched.
3. **A code typed loosely** (`kx4-9tm`, `KX4 9TM`, lower case) must be accepted by both the check and the pair endpoints and by the admin form — Task 3 and Task 7 test it.
4. **Pairing in the last seconds of a code's life.** The device must still collect its token after the code expires — Task 2 tests a token attached at 4:59 and collected at 5:30.
5. **Two admins entering the same code at once.** Only one device row may be created; the second pair attempt gets the 404 — Task 3 tests a second `POST /api/devices/pair` with the same code.

---

## File Structure

**Server (`server/src/tournament_server/`)**
- Create `models/device.py` — the `Device` table.
- Modify `models/event.py` — `device_idle_minutes`.
- Modify `models/__init__.py` — export `Device`, drop `ScoringDevice` (Task 3).
- Delete `models/scoring_device.py` (Task 3).
- Modify `_alembic/versions/000000000001_baseline.py` — add `devices`, add `events.device_idle_minutes` (Task 1); drop `scoring_devices` (Task 3).
- Create `services/devices.py` — constants, status, names, codes (pure).
- Create `services/pairing.py` — the in-memory `PairingStore`.
- Modify `auth.py` — `device_id` claim, `Caller`, `resolve_caller`, `get_caller`, `require_role`.
- Rewrite `device_auth.py` — `require_paired_scoring_device` only.
- Create `routers/pairing.py` — `POST /api/pairing`, `GET /api/pairing/codes/{code}`, `GET /api/pairing/{id}`.
- Rewrite `routers/devices.py` and `schemas/device.py`.
- Modify `routers/auth.py`, `schemas/auth.py` — `POST /api/auth/device`.
- Modify `routers/scores.py`, `routers/skills.py` — the new scoring dependency.
- Modify `realtime.py`, `routers/websockets.py` — device-aware sockets and `close_device_sockets`.
- Modify `app.py`, `settings.py`, `audit.py` — wiring and removals.
- Modify `static_ui.py` — serve the device app and `/pair`.

**Server tests (`server/tests/`)**
- Create `test_devices_service.py`, `test_pairing_store.py`, `test_pairing_api.py`, `test_device_management.py`, `test_device_sockets.py`, `device_helpers.py`.
- Delete `test_device_models.py`, `test_device_auth_core.py`, `test_devices.py` (Task 3).
- Modify `test_scores.py`, `test_skills_attempts.py`, `test_per_team_flags_api.py`, `skills_helpers.py`, `test_static_ui.py`, and any other file using `X-Device-Token` or `/api/devices/register`.

**Device app (`frontend/apps/device/`, new)**
- `package.json`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `vitest.setup.ts`, `index.html`.
- `src/main.tsx`, `src/App.tsx`, `src/i18nSetup.ts`, `src/i18n/en/device.json`, `src/i18n/zh/device.json`, `src/styles/device.css`.
- `src/deviceApi.ts` — storage and the four requests.
- `src/useDeviceSession.ts` — sign-in state machine.
- `src/useDeviceSocket.ts` — the live connection.
- `src/screens/PairingScreen.tsx`, `src/screens/HomeScreen.tsx`, `src/screens/BlockedScreen.tsx`.
- `tests/unit/*.test.ts(x)`.

**Admin app (`frontend/apps/admin/`)**
- Create `src/devices/useDevices.ts`, `src/devices/PairDeviceForm.tsx`, `src/devices/EditDeviceDialog.tsx`, `src/devices/format.ts`, `src/routes/DevicesRoute.tsx`.
- Modify `src/router.tsx`, `src/components/AppShell.tsx`, `src/routes/AuthenticatedLayout.tsx`, `src/routes/LoginRoute.tsx`, `src/routeGuards.ts`, `src/i18n/en/admin.json`, `src/i18n/zh/admin.json`, `vite.config.ts`.
- Create `tests/unit/DevicesRoute.test.tsx`, `tests/unit/PairDeviceForm.test.tsx`, `tests/e2e/devicePairing.spec.ts`; modify `tests/unit/LoginRoute*` or add `tests/unit/loginReturn.test.tsx`, `tests/e2e/fixtures/isolatedServer.ts`.

**Docs:** `server/CLAUDE.md` (Task 4, Task 5), `frontend/CLAUDE.md` (Task 8).

---

### Task 1: Device table, idle setting column, and pure device rules

**Files:**
- Create: `server/src/tournament_server/models/device.py`
- Modify: `server/src/tournament_server/models/event.py`
- Modify: `server/src/tournament_server/models/__init__.py`
- Modify: `server/src/tournament_server/_alembic/versions/000000000001_baseline.py`
- Create: `server/src/tournament_server/services/devices.py`
- Test: `server/tests/test_devices_service.py`

**Interfaces:**
- Produces: `Device` (columns `id, name, name_key, role, token_hash, paired_at, paired_by, last_seen_at, disabled_at`); `Event.device_idle_minutes: int` (default 240); in `services/devices.py`: `PAIRABLE_ROLES`, `SCORING_ROLES`, `NEVER_IDLE_ROLES`, `DEFAULT_IDLE_MINUTES = 240`, `MIN_IDLE_MINUTES = 15`, `MAX_IDLE_MINUTES = 1440`, `LAST_SEEN_WRITE_INTERVAL: timedelta(minutes=1)`, `CODE_ALPHABET`, `CODE_LENGTH = 6`, `NAME_MAX_LENGTH = 100`, `device_status(device, now, idle_minutes) -> "active" | "idle" | "disabled"`, `idle_minutes_for(db) -> int`, `normalize_code(raw: str) -> str`, `generate_code(taken: set[str]) -> str`, `name_key(name: str) -> str`, `clean_name(raw: str) -> str` (raises `ValueError`), `suggest_name(taken_keys: set[str]) -> str`.

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_devices_service.py
from __future__ import annotations

import datetime as dt
from types import SimpleNamespace

import pytest

from tournament_server.services import devices as rules

NOW = dt.datetime(2026, 10, 13, 12, 0, tzinfo=dt.timezone.utc)


def _device(role="scorer", last_seen_minutes_ago=0, disabled=False):
    return SimpleNamespace(
        role=role,
        last_seen_at=NOW - dt.timedelta(minutes=last_seen_minutes_ago),
        disabled_at=NOW if disabled else None,
    )


def test_a_recent_device_is_active():
    assert rules.device_status(_device(last_seen_minutes_ago=239), NOW, 240) == "active"


def test_an_operator_device_goes_idle_at_the_timeout():
    assert rules.device_status(_device(last_seen_minutes_ago=240), NOW, 240) == "idle"


def test_a_display_never_goes_idle():
    device = _device(role="display_device", last_seen_minutes_ago=100_000)
    assert rules.device_status(device, NOW, 240) == "active"


def test_disabled_wins_over_idle_and_display():
    assert rules.device_status(_device(disabled=True), NOW, 240) == "disabled"
    assert rules.device_status(_device(role="display_device", disabled=True), NOW, 240) == "disabled"


def test_pairable_roles_exclude_admin_and_attendee():
    assert rules.PAIRABLE_ROLES == ("scorer", "referee", "judge", "front_desk", "display_device")
    assert rules.SCORING_ROLES == ("scorer", "referee")


@pytest.mark.parametrize("raw", ["kx49tm", "KX4 9TM", "kx4-9tm", " KX4-9TM "])
def test_codes_are_normalized(raw):
    assert rules.normalize_code(raw) == "KX49TM"


def test_generated_codes_use_only_the_alphabet_and_avoid_taken_codes():
    taken = set()
    for _ in range(200):
        code = rules.generate_code(taken)
        assert len(code) == 6
        assert set(code) <= set("ACDEFGHJKMNPQRTUVWXY34679")
        assert code not in taken
        taken.add(code)


def test_names_are_keyed_case_insensitively():
    assert rules.name_key("  Field 1 Tablet ") == "field 1 tablet"


def test_clean_name_strips_and_rejects_blank_and_overlong():
    assert rules.clean_name("  Pit TV ") == "Pit TV"
    with pytest.raises(ValueError):
        rules.clean_name("   ")
    with pytest.raises(ValueError):
        rules.clean_name("x" * 101)
    assert rules.clean_name("x" * 100) == "x" * 100


def test_suggested_names_avoid_taken_keys():
    taken = set()
    for _ in range(50):
        name = rules.suggest_name(taken)
        assert rules.name_key(name) not in taken
        taken.add(rules.name_key(name))


def test_idle_minutes_defaults_without_an_event(client):
    db = client.app.state.session_factory()
    try:
        assert rules.idle_minutes_for(db) == 240
    finally:
        db.close()


def test_idle_minutes_reads_the_event(client):
    client.post("/api/event", json={"name": "E"})
    db = client.app.state.session_factory()
    try:
        from tournament_server.models.event import Event

        event = db.query(Event).one()
        assert event.device_idle_minutes == 240
        event.device_idle_minutes = 30
        db.commit()
        assert rules.idle_minutes_for(db) == 30
    finally:
        db.close()
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_devices_service.py -q`
Expected: FAIL — `ImportError: cannot import name 'devices' from 'tournament_server.services'`.

- [ ] **Step 3: Add the model, the column and the rules**

```python
# server/src/tournament_server/models/device.py
from __future__ import annotations

import datetime as dt

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class Device(Base):
    """A browser paired by code (see the device pairing design). `name_key`
    is the lower-cased name, so names are unique ignoring case."""

    __tablename__ = "devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    name_key: Mapped[str] = mapped_column(String(100), unique=True)
    role: Mapped[str] = mapped_column(String(20))
    token_hash: Mapped[str] = mapped_column(String(200), unique=True)
    paired_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    paired_by: Mapped[str] = mapped_column(String(200))
    last_seen_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    disabled_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
```

In `models/event.py` add, after `game_plugin_name`:

```python
    device_idle_minutes: Mapped[int] = mapped_column(Integer, default=240)
```

In `models/__init__.py` add `from tournament_server.models.device import Device` next to the other imports (and to `__all__` if the file has one). Keep `ScoringDevice` for now; Task 3 removes it.

In the baseline's `upgrade()`, add to the `events` table (after `game_plugin_name`):

```python
    sa.Column('device_idle_minutes', sa.Integer(), nullable=False),
```

and add a new table next to `scoring_devices`:

```python
    op.create_table('devices',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=100), nullable=False),
    sa.Column('name_key', sa.String(length=100), nullable=False),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('token_hash', sa.String(length=200), nullable=False),
    sa.Column('paired_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.Column('paired_by', sa.String(length=200), nullable=False),
    sa.Column('last_seen_at', tournament_server.db.UTCDateTime(), nullable=False),
    sa.Column('disabled_at', tournament_server.db.UTCDateTime(), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name_key'),
    sa.UniqueConstraint('token_hash')
    )
```

and `op.drop_table('devices')` in `downgrade()` beside `op.drop_table('scoring_devices')`. If `test_alembic_drift.py` reports a column-order or constraint difference, regenerate the baseline with Alembic autogenerate against an empty database as `server/CLAUDE.md` ("Database migrations") describes, and keep the header docstring.

```python
# server/src/tournament_server/services/devices.py
"""Pure rules for paired devices: roles, status, names and pairing codes.
See docs/superpowers/specs/2026-10-13-device-pairing-design.md."""
from __future__ import annotations

import datetime as dt
import random
import re
import secrets
from typing import Literal, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.event import Event

PAIRABLE_ROLES = ("scorer", "referee", "judge", "front_desk", "display_device")
SCORING_ROLES = ("scorer", "referee")
NEVER_IDLE_ROLES = ("display_device",)

DEFAULT_IDLE_MINUTES = 240
MIN_IDLE_MINUTES = 15
MAX_IDLE_MINUTES = 1440
LAST_SEEN_WRITE_INTERVAL = dt.timedelta(minutes=1)

CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY34679"
CODE_LENGTH = 6
NAME_MAX_LENGTH = 100

DeviceStatus = Literal["active", "idle", "disabled"]

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
_MAX_NAME_TRIES = 50


class _DeviceLike(Protocol):
    role: str
    last_seen_at: dt.datetime
    disabled_at: dt.datetime | None


def device_status(device: _DeviceLike, now: dt.datetime, idle_minutes: int) -> DeviceStatus:
    if device.disabled_at is not None:
        return "disabled"
    if device.role in NEVER_IDLE_ROLES:
        return "active"
    if now - device.last_seen_at >= dt.timedelta(minutes=idle_minutes):
        return "idle"
    return "active"


def idle_minutes_for(db: Session) -> int:
    event = db.execute(select(Event)).scalars().first()
    return event.device_idle_minutes if event is not None else DEFAULT_IDLE_MINUTES


def normalize_code(raw: str) -> str:
    return re.sub(r"[\s-]", "", raw).upper()


def generate_code(taken: set[str]) -> str:
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if code not in taken:
            return code


def name_key(name: str) -> str:
    return name.strip().casefold()


def clean_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise ValueError("Enter a name for the device.")
    if len(name) > NAME_MAX_LENGTH:
        raise ValueError(f"A device name can be at most {NAME_MAX_LENGTH} characters.")
    return name


def suggest_name(taken_keys: set[str]) -> str:
    for _ in range(_MAX_NAME_TRIES):
        candidate = f"{random.choice(_ADJECTIVES)}-{random.choice(_ANIMALS)}"
        if name_key(candidate) not in taken_keys:
            return candidate
    while True:
        candidate = f"{random.choice(_ADJECTIVES)}-{random.choice(_ANIMALS)}-{secrets.token_hex(2)}"
        if name_key(candidate) not in taken_keys:
            return candidate
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_devices_service.py tests/test_alembic_drift.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/models/device.py server/src/tournament_server/models/event.py server/src/tournament_server/models/__init__.py server/src/tournament_server/_alembic/versions/000000000001_baseline.py server/src/tournament_server/services/devices.py server/tests/test_devices_service.py
git commit -m "Add the devices table, the event's device idle setting, and the pure rules for device status, names and pairing codes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: In-memory pairing store

**Files:**
- Create: `server/src/tournament_server/services/pairing.py`
- Test: `server/tests/test_pairing_store.py`

**Interfaces:**
- Consumes: `generate_code`, `normalize_code`, `suggest_name`, `name_key` from Task 1.
- Produces: `CODE_LIFETIME = timedelta(minutes=5)`, `COLLECT_GRACE = timedelta(seconds=60)`, `MAX_OPEN_CODES = 50`; `PendingPairing` dataclass (`id, code, poll_key, suggested_name, expires_at, device_token: str | None`); `PairingStore(now: Callable[[], datetime] = utc_now)` with `open(taken_name_keys: set[str]) -> PendingPairing`, `find_open(raw_code: str) -> PendingPairing | None`, `attach_token(pairing_id: str, device_token: str) -> bool`, `poll(pairing_id: str, poll_key: str) -> tuple[Literal["waiting", "paired", "expired"], str | None] | None`.

- [ ] **Step 1: Write the failing tests**

```python
# server/tests/test_pairing_store.py
from __future__ import annotations

import datetime as dt

from tournament_server.services.pairing import MAX_OPEN_CODES, PairingStore


class Clock:
    def __init__(self):
        self.now = dt.datetime(2026, 10, 13, 12, 0, tzinfo=dt.timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, **kwargs):
        self.now += dt.timedelta(**kwargs)


def test_open_returns_a_code_that_lasts_five_minutes():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    assert len(pending.code) == 6
    assert pending.expires_at == clock.now + dt.timedelta(minutes=5)
    assert store.find_open(pending.code) is pending


def test_find_open_ignores_case_spaces_and_dashes():
    store = PairingStore(now=Clock())
    pending = store.open(set())
    loose = f"{pending.code[:3].lower()} - {pending.code[3:].lower()}"
    assert store.find_open(loose) is pending


def test_an_expired_code_is_not_found():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    clock.advance(minutes=5)
    assert store.find_open(pending.code) is None


def test_open_codes_are_unique():
    store = PairingStore(now=Clock())
    codes = {store.open(set()).code for _ in range(MAX_OPEN_CODES)}
    assert len(codes) == MAX_OPEN_CODES


def test_past_the_cap_the_oldest_code_is_dropped():
    store = PairingStore(now=Clock())
    first = store.open(set())
    for _ in range(MAX_OPEN_CODES):
        store.open(set())
    assert store.find_open(first.code) is None


def test_suggested_names_avoid_taken_names_and_each_other():
    store = PairingStore(now=Clock())
    a = store.open({"brave-otter"})
    b = store.open({"brave-otter"})
    assert a.suggested_name != "brave-otter"
    assert a.suggested_name.casefold() != b.suggested_name.casefold()


def test_poll_waits_then_hands_over_the_token_once():
    store = PairingStore(now=Clock())
    pending = store.open(set())
    assert store.poll(pending.id, pending.poll_key) == ("waiting", None)
    assert store.attach_token(pending.id, "secret-token") is True
    assert store.poll(pending.id, pending.poll_key) == ("paired", "secret-token")
    assert store.poll(pending.id, pending.poll_key) is None


def test_poll_with_a_wrong_key_or_id_is_none():
    store = PairingStore(now=Clock())
    pending = store.open(set())
    assert store.poll(pending.id, "wrong") is None
    assert store.poll("nope", pending.poll_key) is None


def test_poll_after_expiry_reports_expired():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    clock.advance(minutes=5, seconds=1)
    assert store.poll(pending.id, pending.poll_key) == ("expired", None)


def test_a_paired_code_is_no_longer_open_and_cannot_be_paired_twice():
    store = PairingStore(now=Clock())
    pending = store.open(set())
    assert store.attach_token(pending.id, "t1") is True
    assert store.find_open(pending.code) is None
    assert store.attach_token(pending.id, "t2") is False


def test_a_token_attached_at_the_last_second_is_still_collectable():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    clock.advance(minutes=4, seconds=59)
    assert store.attach_token(pending.id, "late") is True
    clock.advance(seconds=31)
    assert store.poll(pending.id, pending.poll_key) == ("paired", "late")
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_pairing_store.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'tournament_server.services.pairing'`.

- [ ] **Step 3: Write the store**

```python
# server/src/tournament_server/services/pairing.py
"""Open pairing codes, held in memory only: a restart drops them and the
device simply asks for a new one. Nothing here touches the tournament file,
so pairing traffic never writes the audit log or triggers a backup."""
from __future__ import annotations

import datetime as dt
import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

from tournament_server.db import utc_now
from tournament_server.services.devices import (
    generate_code,
    name_key,
    normalize_code,
    suggest_name,
)

CODE_LIFETIME = dt.timedelta(minutes=5)
COLLECT_GRACE = dt.timedelta(seconds=60)
MAX_OPEN_CODES = 50

PollStatus = Literal["waiting", "paired", "expired"]


@dataclass
class PendingPairing:
    id: str
    code: str
    poll_key: str
    suggested_name: str
    expires_at: dt.datetime
    device_token: str | None = None


class PairingStore:
    def __init__(self, now: Callable[[], dt.datetime] = utc_now) -> None:
        self._now = now
        self._lock = threading.Lock()
        self._by_id: dict[str, PendingPairing] = {}

    def _prune(self) -> None:
        now = self._now()
        for pairing_id in [p.id for p in self._by_id.values() if p.expires_at <= now]:
            del self._by_id[pairing_id]

    def open(self, taken_name_keys: set[str]) -> PendingPairing:
        with self._lock:
            self._prune()
            while len(self._by_id) >= MAX_OPEN_CODES:
                del self._by_id[next(iter(self._by_id))]
            taken = taken_name_keys | {name_key(p.suggested_name) for p in self._by_id.values()}
            pending = PendingPairing(
                id=secrets.token_urlsafe(12),
                code=generate_code({p.code for p in self._by_id.values()}),
                poll_key=secrets.token_urlsafe(24),
                suggested_name=suggest_name(taken),
                expires_at=self._now() + CODE_LIFETIME,
            )
            self._by_id[pending.id] = pending
            return pending

    def find_open(self, raw_code: str) -> PendingPairing | None:
        code = normalize_code(raw_code)
        with self._lock:
            self._prune()
            for pending in self._by_id.values():
                if pending.code == code and pending.device_token is None:
                    return pending
            return None

    def attach_token(self, pairing_id: str, device_token: str) -> bool:
        with self._lock:
            self._prune()
            pending = self._by_id.get(pairing_id)
            if pending is None or pending.device_token is not None:
                return False
            pending.device_token = device_token
            pending.expires_at = max(pending.expires_at, self._now() + COLLECT_GRACE)
            return True

    def poll(self, pairing_id: str, poll_key: str) -> tuple[PollStatus, str | None] | None:
        with self._lock:
            pending = self._by_id.get(pairing_id)
            if pending is None or not secrets.compare_digest(pending.poll_key, poll_key):
                return None
            if pending.expires_at <= self._now():
                del self._by_id[pairing_id]
                return ("expired", None)
            if pending.device_token is not None:
                del self._by_id[pairing_id]
                return ("paired", pending.device_token)
            return ("waiting", None)
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_pairing_store.py -q`
Expected: 11 passed.

- [ ] **Step 5: Commit**

```bash
git add server/src/tournament_server/services/pairing.py server/tests/test_pairing_store.py
git commit -m "Add the in-memory pairing store: unique 5-minute codes capped at 50, a poll key, a token handed over once, and a minute's grace to collect a late pairing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Pair devices, sign them in, and score from paired devices (replacing scorer admission)

This task swaps the whole admission path in one go, because the old `GET /api/devices` and the new one can't coexist.

**Files:**
- Modify: `server/src/tournament_server/auth.py`
- Rewrite: `server/src/tournament_server/device_auth.py`
- Create: `server/src/tournament_server/routers/pairing.py`
- Rewrite: `server/src/tournament_server/routers/devices.py`, `server/src/tournament_server/schemas/device.py`
- Modify: `server/src/tournament_server/routers/auth.py`, `server/src/tournament_server/schemas/auth.py`
- Modify: `server/src/tournament_server/routers/scores.py`, `server/src/tournament_server/routers/skills.py`
- Modify: `server/src/tournament_server/app.py`, `server/src/tournament_server/settings.py`, `server/src/tournament_server/audit.py`, `server/src/tournament_server/models/__init__.py`, the baseline migration
- Delete: `server/src/tournament_server/models/scoring_device.py`, `server/tests/test_device_models.py`, `server/tests/test_device_auth_core.py`, `server/tests/test_devices.py`
- Create: `server/tests/device_helpers.py`, `server/tests/test_pairing_api.py`
- Modify: `server/tests/test_scores.py`, `server/tests/test_skills_attempts.py`, `server/tests/test_per_team_flags_api.py`, `server/tests/skills_helpers.py`, and every other test that uses `X-Device-Token`, `/api/devices/register`, `admitted_device_token` or `ScoringDevice` (`grep -rln "X-Device-Token\|devices/register\|admitted_device_token\|ScoringDevice\|scoring_device" server/`).

**Interfaces:**
- Consumes: Task 1 rules, Task 2 `PairingStore`.
- Produces:
  - `auth.create_access_token(db, role, device_id: int | None = None) -> str`; `auth.decode_access_token(token, db) -> dict` (raises `ValueError`); `decode_role_from_token` keeps its signature.
  - `auth.Caller(role: str, device_id: int | None = None, device_name: str | None = None)`; `auth.CallerRejected(status_code, detail)`; `auth.resolve_caller(token, db) -> Caller`; `auth.get_caller` (FastAPI dependency); `require_role(...)` returns `str` exactly as before.
  - `device_auth.require_paired_scoring_device` (dependency) `-> str | None`.
  - `app.state.pairing: PairingStore`.
  - `routers/devices.py`: `audit_device(db, device, action, before, after)`, `device_snapshot(device) -> dict`, `to_device_read(device, db) -> DeviceRead`, `notify_devices_changed(request)`; Task 4 adds the rest of the routes to this file.
  - `schemas/device.py`: `DeviceRead`, `PairRequest`, `DeviceSelf`, `PairingCodeRead`, `PairingCodeCheck`, `PairingPollRead`.
  - `schemas/auth.py`: `DeviceSignInRequest`, `DeviceTokenResponse`.
  - `tests/device_helpers.py`: `paired_device(admin_client, role="scorer", name=None) -> dict` with keys `id, name, device_token, access_token, headers`.

- [ ] **Step 1: Write the test helper and the failing API tests**

```python
# server/tests/device_helpers.py
from __future__ import annotations

from fastapi.testclient import TestClient


def paired_device(admin_client, role: str = "scorer", name: str | None = None) -> dict:
    """Pairs a new device as `admin_client` (an admin) and signs it in.
    Returns its id, name, device token, access token and ready-made headers."""
    raw = TestClient(admin_client.app)
    pending = raw.post("/api/pairing").json()
    body = {"code": pending["code"], "role": role}
    body["name"] = name if name is not None else f"{role}-{pending['code']}"
    paired = admin_client.post("/api/devices/pair", json=body)
    assert paired.status_code == 201, paired.text
    polled = raw.get(f"/api/pairing/{pending['id']}", headers={"X-Pairing-Key": pending["poll_key"]}).json()
    assert polled["status"] == "paired"
    signed_in = raw.post("/api/auth/device", json={"device_token": polled["device_token"]})
    assert signed_in.status_code == 200, signed_in.text
    access = signed_in.json()["access_token"]
    return {
        "id": paired.json()["id"],
        "name": paired.json()["name"],
        "device_token": polled["device_token"],
        "access_token": access,
        "headers": {"Authorization": f"Bearer {access}"},
    }
```

```python
# server/tests/test_pairing_api.py
from __future__ import annotations

import datetime as dt

import jwt
import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from device_helpers import paired_device
from tournament_server.db import utc_now
from tournament_server.models.device import Device


@pytest.fixture
def admin(client):
    client.post("/api/event", json={"name": "Pairing Event"})
    return client


def _open(admin):
    return TestClient(admin.app).post("/api/pairing").json()


def test_requesting_a_code_needs_no_login(admin):
    response = TestClient(admin.app).post("/api/pairing")
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "code", "poll_key", "expires_at", "expires_in"}
    assert len(body["code"]) == 6
    assert body["expires_in"] == 300


def test_checking_a_code_returns_its_suggested_name(admin):
    pending = _open(admin)
    response = admin.get(f"/api/pairing/codes/{pending['code']}")
    assert response.status_code == 200
    assert response.json()["code"] == pending["code"]
    assert response.json()["suggested_name"]


@pytest.mark.parametrize("shape", [str.lower, lambda c: f"{c[:3]} {c[3:]}", lambda c: f"{c[:3]}-{c[3:]}".lower()])
def test_codes_are_accepted_loosely_typed(admin, shape):
    pending = _open(admin)
    assert admin.get(f"/api/pairing/codes/{shape(pending['code'])}").status_code == 200
    paired = admin.post("/api/devices/pair", json={"code": shape(pending["code"]), "role": "scorer", "name": "Tab"})
    assert paired.status_code == 201


def test_an_unknown_code_is_404_with_the_message(admin):
    response = admin.get("/api/pairing/codes/AAAAAA")
    assert response.status_code == 404
    assert response.json()["detail"] == "That code isn't valid or has expired."
    paired = admin.post("/api/devices/pair", json={"code": "AAAAAA", "role": "scorer", "name": "Tab"})
    assert paired.status_code == 404
    assert paired.json()["detail"] == "That code isn't valid or has expired."


def test_checking_and_pairing_are_admin_only(admin):
    pending = _open(admin)
    raw = TestClient(admin.app)
    scorer = bearer(login_as(raw, "scorer"))
    assert raw.get(f"/api/pairing/codes/{pending['code']}", headers=scorer).status_code == 403
    body = {"code": pending["code"], "role": "scorer", "name": "Tab"}
    assert raw.post("/api/devices/pair", json=body, headers=scorer).status_code == 403
    assert raw.get("/api/devices", headers=scorer).status_code == 403


@pytest.mark.parametrize("role", ["scorer", "referee", "judge", "front_desk", "display_device"])
def test_each_pairable_role_can_be_paired(admin, role):
    device = paired_device(admin, role=role)
    listed = {d["id"]: d for d in admin.get("/api/devices").json()}
    assert listed[device["id"]]["role"] == role
    assert listed[device["id"]]["status"] == "active"


@pytest.mark.parametrize("role", ["admin", "attendee", "wizard"])
def test_admin_attendee_and_unknown_roles_cannot_be_paired(admin, role):
    pending = _open(admin)
    response = admin.post("/api/devices/pair", json={"code": pending["code"], "role": role, "name": "Tab"})
    assert response.status_code == 422


@pytest.mark.parametrize("name", ["", "   ", "x" * 101])
def test_blank_and_overlong_names_are_refused(admin, name):
    pending = _open(admin)
    response = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "scorer", "name": name})
    assert response.status_code == 422


def test_duplicate_names_are_refused_ignoring_case(admin):
    paired_device(admin, name="Field 1 Tablet")
    pending = _open(admin)
    response = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "scorer", "name": " field 1 tablet "})
    assert response.status_code == 409
    assert response.json()["detail"] == "A device with that name already exists."


def test_the_same_code_cannot_be_paired_twice(admin):
    pending = _open(admin)
    first = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "scorer", "name": "One"})
    second = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "judge", "name": "Two"})
    assert first.status_code == 201
    assert second.status_code == 404
    assert [d["name"] for d in admin.get("/api/devices").json()] == ["One"]


def test_polling_needs_the_right_key_and_hands_the_token_over_once(admin):
    pending = _open(admin)
    raw = TestClient(admin.app)
    url = f"/api/pairing/{pending['id']}"
    assert raw.get(url, headers={"X-Pairing-Key": "wrong"}).status_code == 404
    assert raw.get(url, headers={"X-Pairing-Key": pending["poll_key"]}).json() == {"status": "waiting", "device_token": None}
    admin.post("/api/devices/pair", json={"code": pending["code"], "role": "scorer", "name": "Tab"})
    paired = raw.get(url, headers={"X-Pairing-Key": pending["poll_key"]}).json()
    assert paired["status"] == "paired" and paired["device_token"]
    assert raw.get(url, headers={"X-Pairing-Key": pending["poll_key"]}).status_code == 404


def test_a_device_access_token_carries_its_role_and_id(admin):
    device = paired_device(admin, role="judge")
    claims = jwt.decode(device["access_token"], options={"verify_signature": False})
    assert claims["role"] == "judge"
    assert claims["device_id"] == device["id"]


def test_device_sign_in_with_an_unknown_token_is_401(admin):
    response = TestClient(admin.app).post("/api/auth/device", json={"device_token": "nope"})
    assert response.status_code == 401


def test_device_sign_in_reports_an_idle_device(admin):
    device = paired_device(admin)
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).last_seen_at = utc_now() - dt.timedelta(hours=5)
    db.commit()
    db.close()
    response = TestClient(admin.app).post("/api/auth/device", json={"device_token": device["device_token"]})
    assert response.status_code == 403
    assert response.json() == {"detail": "This device is disabled", "status": "idle", "name": device["name"]}


def test_an_idle_devices_requests_are_refused_and_do_not_revive_it(admin):
    device = paired_device(admin)
    db = admin.app.state.session_factory()
    stale = utc_now() - dt.timedelta(hours=5)
    db.get(Device, device["id"]).last_seen_at = stale
    db.commit()
    db.close()
    raw = TestClient(admin.app)
    assert raw.get("/api/event", headers=device["headers"]).status_code in (200, 403)
    assert raw.get("/api/teams", headers=device["headers"]).status_code == 403
    db = admin.app.state.session_factory()
    assert db.get(Device, device["id"]).last_seen_at == stale
    db.close()


def test_last_seen_is_written_at_most_once_a_minute(admin):
    device = paired_device(admin)
    raw = TestClient(admin.app)
    db = admin.app.state.session_factory()
    first = db.get(Device, device["id"]).last_seen_at
    db.close()
    raw.get("/api/teams", headers=device["headers"])
    db = admin.app.state.session_factory()
    assert db.get(Device, device["id"]).last_seen_at == first
    db.get(Device, device["id"]).last_seen_at = first - dt.timedelta(minutes=2)
    db.commit()
    db.close()
    raw.get("/api/teams", headers=device["headers"])
    db = admin.app.state.session_factory()
    assert db.get(Device, device["id"]).last_seen_at > first - dt.timedelta(minutes=2)
    db.close()


def test_pairing_never_writes_the_audit_log_for_codes_and_polls(admin):
    before = len(admin.get("/api/audit-log").json())
    pending = _open(admin)
    TestClient(admin.app).get(f"/api/pairing/{pending['id']}", headers={"X-Pairing-Key": pending["poll_key"]})
    assert len(admin.get("/api/audit-log").json()) == before
```

Check the audit-log route path in `routers/audit_log.py` before running; if it is not `/api/audit-log` or it pages its results, use its real path and count the returned rows the same way. In `test_an_idle_devices_requests_are_refused...`, `/api/event` may be unauthenticated; the assertion on `/api/teams` is the one that matters.

- [ ] **Step 2: Run the tests to see them fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_pairing_api.py -q`
Expected: FAIL — `POST /api/pairing` is 404 / 405.

- [ ] **Step 3: Teach auth about devices**

In `auth.py`, add the imports (`from dataclasses import dataclass`, `from tournament_server.models.device import Device`, `from tournament_server.services.devices import LAST_SEEN_WRITE_INTERVAL, device_status, idle_minutes_for`) and replace `create_access_token`, `decode_role_from_token`, `_decode_role` and `require_role` with:

```python
def create_access_token(db: Session, role: str, device_id: int | None = None) -> str:
    signing_key = get_signing_key(db)
    now = utc_now()
    payload = {
        "role": role,
        "iat": int(now.timestamp()),
        "exp": int((now + ACCESS_TOKEN_LIFETIME).timestamp()),
    }
    if device_id is not None:
        payload["device_id"] = device_id
    return jwt.encode(payload, signing_key, algorithm=JWT_ALGORITHM)


def decode_access_token(token: str, db: Session) -> dict:
    signing_key = get_signing_key(db)
    try:
        return jwt.decode(token, signing_key, algorithms=[JWT_ALGORITHM])
    except jwt.PyJWTError:
        raise ValueError("Invalid or expired token")


def decode_role_from_token(token: str, db: Session) -> str:
    return decode_access_token(token, db)["role"]


class CallerRejected(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class Caller:
    role: str
    device_id: int | None = None
    device_name: str | None = None


def resolve_caller(token: str, db: Session) -> Caller:
    """Who a bearer token speaks for. A device's token is checked against
    its row on every call, so disabling, deleting or changing the role of a
    device takes effect on its very next request, and its role always comes
    from the row, never from the token."""
    try:
        payload = decode_access_token(token, db)
    except ValueError:
        raise CallerRejected(401, "Invalid or expired token")
    device_id = payload.get("device_id")
    if device_id is None:
        return Caller(role=payload["role"])
    device = db.get(Device, device_id)
    if device is None:
        raise CallerRejected(401, "This device is no longer paired")
    now = utc_now()
    if device_status(device, now, idle_minutes_for(db)) != "active":
        raise CallerRejected(403, "This device is disabled")
    if now - device.last_seen_at >= LAST_SEEN_WRITE_INTERVAL:
        device.last_seen_at = now
        db.commit()
    return Caller(role=device.role, device_id=device.id, device_name=device.name)


def get_caller(
    authorization: str | None = Header(None),
    db: Session = Depends(get_db),
) -> Caller:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=401, detail="Missing or malformed Authorization header"
        )
    try:
        return resolve_caller(authorization.removeprefix("Bearer "), db)
    except CallerRejected as rejected:
        raise HTTPException(status_code=rejected.status_code, detail=rejected.detail)


def require_role(*allowed_roles: str):
    """FastAPI dependency factory. `admin` always passes, regardless of
    `allowed_roles`. Calling with no `allowed_roles` means admin-only."""

    def _dependency(caller: Caller = Depends(get_caller)) -> str:
        role = caller.role
        if role != "admin" and (not allowed_roles or role not in allowed_roles):
            raise HTTPException(
                status_code=403, detail="This role cannot perform this operation"
            )
        return role

    return _dependency
```

If anything else imported `_decode_role`, point it at `get_caller`/`resolve_caller` instead (`grep -rn "_decode_role" server/src`). If `models/device.py` → `auth.py` → `services/devices.py` creates an import cycle, move the `services.devices` import inside `resolve_caller`.

Rewrite `device_auth.py` completely:

```python
# server/src/tournament_server/device_auth.py
from __future__ import annotations

from fastapi import Depends, HTTPException

from tournament_server.auth import Caller, get_caller
from tournament_server.services.devices import SCORING_ROLES


def require_paired_scoring_device(caller: Caller = Depends(get_caller)) -> str | None:
    """Scores and skills attempts come from a paired scorer or referee device,
    or from an admin (who needs no device). Returns the device's name for
    attribution, or None for an admin."""
    if caller.role == "admin":
        return None
    if caller.role not in SCORING_ROLES:
        raise HTTPException(status_code=403, detail="This role cannot perform this operation")
    if caller.device_id is None:
        raise HTTPException(status_code=403, detail="Only a paired device can submit scores.")
    return caller.device_name
```

In `routers/scores.py` and `routers/skills.py`, replace the import and the dependency `Depends(require_admitted_device)` with `Depends(require_paired_scoring_device)`; the attribution code that uses the returned name stays as it is.

- [ ] **Step 4: Schemas, pairing router, devices router and device sign-in**

```python
# server/src/tournament_server/schemas/device.py
from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class DeviceRead(BaseModel):
    id: int
    name: str
    role: str
    status: str
    paired_at: dt.datetime
    paired_by: str
    last_seen_at: dt.datetime
    disabled_at: dt.datetime | None


class DeviceSelf(BaseModel):
    id: int
    name: str
    role: str
    status: str


class PairRequest(BaseModel):
    code: str
    role: str
    name: str


class PairingCodeRead(BaseModel):
    id: str
    code: str
    poll_key: str
    expires_at: dt.datetime
    expires_in: int


class PairingCodeCheck(BaseModel):
    code: str
    suggested_name: str
    expires_at: dt.datetime


class PairingPollRead(BaseModel):
    status: str
    device_token: str | None = None
```

In `schemas/auth.py` add:

```python
class DeviceSignInRequest(BaseModel):
    device_token: str


class DeviceTokenResponse(BaseModel):
    access_token: str
    expires_in: int
    device: "DeviceSelf"
```

with `from tournament_server.schemas.device import DeviceSelf` at the top (and drop the quotes if the import is in place).

```python
# server/src/tournament_server/routers/pairing.py
from __future__ import annotations

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin
from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.models.device import Device
from tournament_server.schemas.device import PairingCodeCheck, PairingCodeRead, PairingPollRead

router = APIRouter(prefix="/api/pairing", tags=["pairing"])

UNKNOWN_CODE = "That code isn't valid or has expired."


@router.post("", response_model=PairingCodeRead, status_code=201)
def open_code(request: Request, db: Session = Depends(get_db)) -> PairingCodeRead:
    taken = set(db.execute(select(Device.name_key)).scalars())
    pending = request.app.state.pairing.open(taken)
    return PairingCodeRead(
        id=pending.id,
        code=pending.code,
        poll_key=pending.poll_key,
        expires_at=pending.expires_at,
        expires_in=max(0, round((pending.expires_at - utc_now()).total_seconds())),
    )


@router.get("/codes/{code}", response_model=PairingCodeCheck)
def check_code(code: str, request: Request, _role: str = Depends(require_admin)) -> PairingCodeCheck:
    pending = request.app.state.pairing.find_open(code)
    if pending is None:
        raise HTTPException(status_code=404, detail=UNKNOWN_CODE)
    return PairingCodeCheck(code=pending.code, suggested_name=pending.suggested_name, expires_at=pending.expires_at)


@router.get("/{pairing_id}", response_model=PairingPollRead)
def poll(
    pairing_id: str,
    request: Request,
    x_pairing_key: str | None = Header(None),
) -> PairingPollRead:
    result = request.app.state.pairing.poll(pairing_id, x_pairing_key or "")
    if result is None:
        raise HTTPException(status_code=404, detail="Not found")
    status, token = result
    return PairingPollRead(status=status, device_token=token)
```

`expires_in` uses the real clock (`utc_now`) while the store may use an injected clock in unit tests only; the API always uses the default clock, so they agree.

```python
# server/src/tournament_server/routers/devices.py
from __future__ import annotations

import json
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server import audit, realtime
from tournament_server.audit import AuditLog
from tournament_server.auth import hash_token, require_admin
from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.models.device import Device
from tournament_server.routers.pairing import UNKNOWN_CODE
from tournament_server.schemas.device import DeviceRead, PairRequest
from tournament_server.services.devices import (
    PAIRABLE_ROLES,
    clean_name,
    device_status,
    idle_minutes_for,
    name_key,
)

router = APIRouter(prefix="/api/devices", tags=["devices"])

DUPLICATE_NAME = "A device with that name already exists."


def to_device_read(device: Device, db: Session) -> DeviceRead:
    return DeviceRead(
        id=device.id,
        name=device.name,
        role=device.role,
        status=device_status(device, utc_now(), idle_minutes_for(db)),
        paired_at=device.paired_at,
        paired_by=device.paired_by,
        last_seen_at=device.last_seen_at,
        disabled_at=device.disabled_at,
    )


def device_snapshot(device: Device) -> dict:
    """What the audit log records about a device: never its token hash."""
    return {"name": device.name, "role": device.role, "disabled": device.disabled_at is not None}


def audit_device(db: Session, device_id: int, action: str, before: dict | None, after: dict | None) -> None:
    db.add(
        AuditLog(
            table_name="devices",
            row_pk=device_id,
            action=action,
            actor=audit.current_actor.get(),
            before_json=json.dumps(before) if before is not None else None,
            after_json=json.dumps(after) if after is not None else None,
        )
    )


def notify_devices_changed(request: Request) -> None:
    realtime.broadcast_active_session(request.app, "devices_changed", {})


def checked_role(role: str) -> str:
    if role not in PAIRABLE_ROLES:
        raise HTTPException(status_code=422, detail="This role can't be paired.")
    return role


def checked_name(raw: str) -> str:
    try:
        return clean_name(raw)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error))


@router.get("", response_model=list[DeviceRead])
def list_devices(db: Session = Depends(get_db), _role: str = Depends(require_admin)) -> list[DeviceRead]:
    devices = db.execute(select(Device).order_by(Device.name_key)).scalars().all()
    return [to_device_read(d, db) for d in devices]


@router.post("/pair", response_model=DeviceRead, status_code=201)
def pair_device(
    payload: PairRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    store = request.app.state.pairing
    pending = store.find_open(payload.code)
    if pending is None:
        raise HTTPException(status_code=404, detail=UNKNOWN_CODE)
    role = checked_role(payload.role)
    name = checked_name(payload.name)
    if db.execute(select(Device).where(Device.name_key == name_key(name))).scalars().first():
        raise HTTPException(status_code=409, detail=DUPLICATE_NAME)
    device_token = secrets.token_urlsafe(32)
    now = utc_now()
    device = Device(
        name=name,
        name_key=name_key(name),
        role=role,
        token_hash=hash_token(device_token),
        paired_at=now,
        paired_by=audit.current_actor.get(),
        last_seen_at=now,
    )
    db.add(device)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=DUPLICATE_NAME)
    if not store.attach_token(pending.id, device_token):
        db.rollback()
        raise HTTPException(status_code=404, detail=UNKNOWN_CODE)
    audit_device(db, device.id, "pair", None, device_snapshot(device))
    db.commit()
    db.refresh(device)
    notify_devices_changed(request)
    return to_device_read(device, db)
```

`attach_token` runs after the flush succeeds and before the commit, so of two admins racing on one code only one gets `True`; the loser rolls back its row and gets the 404. If the commit after `attach_token` fails, the device's poll would hand over a token whose row does not exist — its sign-in then gets 401 and it simply pairs again.

In `routers/auth.py` add (imports: `JSONResponse` from `fastapi.responses`, `Device`, `device_status`, `idle_minutes_for`, `DeviceSignInRequest`, `DeviceTokenResponse`, `DeviceSelf`):

```python
@router.post("/device", response_model=DeviceTokenResponse)
def device_sign_in(payload: DeviceSignInRequest, db: Session = Depends(get_db)):
    device = db.execute(
        select(Device).where(Device.token_hash == hash_token(payload.device_token))
    ).scalars().first()
    if device is None:
        raise HTTPException(status_code=401, detail="This device is no longer paired")
    now = utc_now()
    status = device_status(device, now, idle_minutes_for(db))
    if status != "active":
        return JSONResponse(
            status_code=403,
            content={"detail": "This device is disabled", "status": status, "name": device.name},
        )
    device.last_seen_at = now
    db.commit()
    return DeviceTokenResponse(
        access_token=create_access_token(db, device.role, device_id=device.id),
        expires_in=ACCESS_TOKEN_LIFETIME_SECONDS,
        device=DeviceSelf(id=device.id, name=device.name, role=device.role, status="active"),
    )
```

- [ ] **Step 5: Wire it into the app and remove the old admission**

In `app.py`:
- `from tournament_server.services.pairing import PairingStore`; set `app.state.pairing = PairingStore()` next to `app.state.backups`.
- Delete `app.state.device_idle_timeout` and the whole `device_activity_middleware`; drop the `device_auth` import if it is now unused.
- `app.include_router(pairing.router)` next to `devices.router` (import `pairing` from `tournament_server.routers`).

In `settings.py` delete `device_idle_timeout_minutes` and its `TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES` line.

In `audit.py` replace `"scoring_devices"` with `"devices"` in `_EXCLUDED_TABLES`.

Delete `models/scoring_device.py`, its line in `models/__init__.py`, its `op.create_table('scoring_devices', ...)` block and `op.drop_table('scoring_devices')` in the baseline. Delete `tests/test_device_models.py`, `tests/test_device_auth_core.py` and `tests/test_devices.py` (their behavior is replaced by `test_devices_service.py`, `test_pairing_store.py`, `test_pairing_api.py` and Task 4's `test_device_management.py`).

- [ ] **Step 6: Move the existing tests onto paired devices**

In `tests/skills_helpers.py` delete `admitted_device_token`. Everywhere a test built `{**bearer(login_as(raw, role)), "X-Device-Token": token}`, use `paired_device(client, role=role)["headers"]` (from `device_helpers`) instead — one paired device per role, since a device has exactly one role. Then rewrite the device tests in `tests/test_scores.py` as follows (replace `test_succeeds_for_scorer_and_referee`, `test_pending_device_cannot_submit_score_as_scorer`, `test_missing_device_token_rejected_for_scorer`, `test_unknown_device_token_rejected_for_scorer`, `test_idle_device_rejected_until_explicitly_re_admitted`, `test_idle_device_not_revived_by_a_successful_non_scoring_request`, `test_revoked_device_cannot_submit_score`, `test_admitted_device_attributes_the_score_by_friendly_name`, `test_admin_with_admitted_device_still_gets_device_attribution`; keep `test_admin_bypasses_device_gate_entirely`):

```python
def test_submit_score_succeeds_for_paired_scorer_and_referee(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    for role, alliance_id in (("scorer", red_id), ("referee", blue_id)):
        device = paired_device(client, role=role)
        response = raw.post(
            f"/api/matches/{match_id}/alliances/{alliance_id}/score",
            json=_no_show_body(client, match_id, alliance_id),
            headers=device["headers"],
        )
        assert response.status_code in (200, 201), response.text


def test_a_password_signed_in_scorer_without_a_paired_device_is_refused(client):
    match_id, red_id, _ = _setup_match(client)
    raw = client.__class__(client.app)
    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json=_no_show_body(client, match_id, red_id),
        headers=bearer(login_as(raw, "scorer")),
    )
    assert response.status_code == 403
    assert response.json()["detail"] == "Only a paired device can submit scores."


def test_a_paired_judge_cannot_submit_scores(client):
    match_id, red_id, _ = _setup_match(client)
    raw = client.__class__(client.app)
    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json=_no_show_body(client, match_id, red_id),
        headers=paired_device(client, role="judge")["headers"],
    )
    assert response.status_code == 403


def test_an_idle_device_cannot_submit_scores(client):
    import datetime as dt

    from tournament_server.db import utc_now
    from tournament_server.models.device import Device

    match_id, red_id, _ = _setup_match(client)
    device = paired_device(client)
    db = client.app.state.session_factory()
    db.get(Device, device["id"]).last_seen_at = utc_now() - dt.timedelta(hours=5)
    db.commit()
    db.close()
    raw = client.__class__(client.app)
    for _ in range(2):
        response = raw.post(
            f"/api/matches/{match_id}/alliances/{red_id}/score",
            json=_no_show_body(client, match_id, red_id),
            headers=device["headers"],
        )
        assert response.status_code == 403


def test_a_paired_device_is_credited_by_name(client):
    match_id, red_id, _ = _setup_match(client)
    device = paired_device(client, name="Field 1 Tablet")
    raw = client.__class__(client.app)
    raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json=_no_show_body(client, match_id, red_id),
        headers=device["headers"],
    )
    db = client.app.state.session_factory()
    from tournament_server.models.score_record import ScoreRecord

    record = db.query(ScoreRecord).filter_by(alliance_id=red_id).one()
    assert record.submitted_by_device == "Field 1 Tablet"
    db.close()
```

Adapt `_setup_match`/`_no_show_body` usage to whatever those helpers really return (read the top of `test_scores.py`). In `tests/test_skills_attempts.py`, rewrite `test_scorers_and_referees_record_on_an_admitted_device_only` to use `paired_device(client, role=role)["headers"]` for each role and add a password-only scorer case expecting 403 with `Only a paired device can submit scores.`. Leave every test's other assertions unchanged.

- [ ] **Step 7: Run the whole server suite**

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: everything passes, including `test_alembic_drift.py`. `grep -rn "X-Device-Token\|devices/register\|ScoringDevice\|scoring_device\|admitted_device\|device_idle_timeout" server/` prints nothing.

- [ ] **Step 8: Commit**

```bash
git add -A server
git commit -m "Pair devices by code and score only from paired devices: the pairing API, device sign-in with a device id in the access token, a per-request device check, and the old scorer admission removed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Manage devices: rename, role, disable, enable, delete, idle setting, and live sockets

**Files:**
- Modify: `server/src/tournament_server/routers/devices.py`, `server/src/tournament_server/schemas/device.py`
- Modify: `server/src/tournament_server/realtime.py`, `server/src/tournament_server/routers/websockets.py`
- Modify: `server/CLAUDE.md`
- Test: `server/tests/test_device_management.py`, `server/tests/test_device_sockets.py`

**Interfaces:**
- Consumes: Task 3's `to_device_read`, `device_snapshot`, `audit_device`, `notify_devices_changed`, `checked_role`, `checked_name`, `DUPLICATE_NAME`, `resolve_caller`, `CallerRejected`, `Caller`.
- Produces: `DeviceUpdate {name?: str, role?: str}`, `DeviceSettings {idle_minutes: int}`; routes `GET/PUT /api/devices/settings`, `GET /api/devices/me`, `PATCH /api/devices/{id}`, `POST /api/devices/{id}/disable`, `POST /api/devices/{id}/enable`, `DELETE /api/devices/{id}`; `realtime.register_device_socket(app, device_id, ws)`, `realtime.unregister_device_socket(app, device_id, ws)`, `realtime.close_device_sockets(app, device_id)`; `DEVICE_CHANGED_CLOSE_CODE = 4403` in `realtime.py`.

- [ ] **Step 1: Write the failing management tests**

```python
# server/tests/test_device_management.py
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from device_helpers import paired_device


@pytest.fixture
def admin(client):
    client.post("/api/event", json={"name": "Devices Event"})
    return client


def _device_row(admin, device_id):
    return next(d for d in admin.get("/api/devices").json() if d["id"] == device_id)


def test_rename_and_change_role(admin):
    device = paired_device(admin, name="Tab")
    response = admin.patch(f"/api/devices/{device['id']}", json={"name": "Field 2 Tablet", "role": "referee"})
    assert response.status_code == 200
    assert response.json()["name"] == "Field 2 Tablet"
    assert response.json()["role"] == "referee"


def test_rename_refuses_duplicates_ignoring_case_but_allows_a_case_change_of_itself(admin):
    paired_device(admin, name="Pit TV")
    device = paired_device(admin, name="Tab")
    assert admin.patch(f"/api/devices/{device['id']}", json={"name": "PIT tv"}).status_code == 409
    assert admin.patch(f"/api/devices/{device['id']}", json={"name": "TAB"}).status_code == 200


@pytest.mark.parametrize("body", [{"role": "admin"}, {"name": "  "}, {"name": None}, {"role": None}])
def test_patch_refuses_bad_values(admin, body):
    device = paired_device(admin)
    assert admin.patch(f"/api/devices/{device['id']}", json=body).status_code == 422


def test_a_role_change_applies_on_the_next_request(admin):
    device = paired_device(admin, role="judge")
    raw = TestClient(admin.app)
    assert raw.get("/api/devices/me", headers=device["headers"]).json()["role"] == "judge"
    admin.patch(f"/api/devices/{device['id']}", json={"role": "scorer"})
    assert raw.get("/api/devices/me", headers=device["headers"]).json()["role"] == "scorer"


def test_disable_takes_effect_on_the_next_request_and_enable_restores(admin):
    device = paired_device(admin)
    raw = TestClient(admin.app)
    assert admin.post(f"/api/devices/{device['id']}/disable").json()["status"] == "disabled"
    assert raw.get("/api/teams", headers=device["headers"]).status_code == 403
    signed_in = raw.post("/api/auth/device", json={"device_token": device["device_token"]})
    assert signed_in.status_code == 403
    assert signed_in.json()["status"] == "disabled"
    assert admin.post(f"/api/devices/{device['id']}/enable").json()["status"] == "active"
    assert raw.get("/api/teams", headers=device["headers"]).status_code == 200


def test_enable_clears_idle(admin):
    import datetime as dt

    from tournament_server.db import utc_now
    from tournament_server.models.device import Device

    device = paired_device(admin)
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).last_seen_at = utc_now() - dt.timedelta(hours=5)
    db.commit()
    db.close()
    assert _device_row(admin, device["id"])["status"] == "idle"
    assert admin.post(f"/api/devices/{device['id']}/enable").json()["status"] == "active"


def test_delete_makes_the_next_request_401(admin):
    device = paired_device(admin)
    raw = TestClient(admin.app)
    assert admin.delete(f"/api/devices/{device['id']}").status_code == 204
    assert raw.get("/api/teams", headers=device["headers"]).status_code == 401
    assert raw.post("/api/auth/device", json={"device_token": device["device_token"]}).status_code == 401


def test_unknown_device_ids_are_404(admin):
    assert admin.patch("/api/devices/999", json={"name": "x"}).status_code == 404
    assert admin.post("/api/devices/999/disable").status_code == 404
    assert admin.post("/api/devices/999/enable").status_code == 404
    assert admin.delete("/api/devices/999").status_code == 404


def test_idle_setting_reads_writes_and_bounds(admin):
    assert admin.get("/api/devices/settings").json() == {"idle_minutes": 240}
    assert admin.put("/api/devices/settings", json={"idle_minutes": 30}).json() == {"idle_minutes": 30}
    assert admin.get("/api/devices/settings").json() == {"idle_minutes": 30}
    assert admin.put("/api/devices/settings", json={"idle_minutes": 14}).status_code == 422
    assert admin.put("/api/devices/settings", json={"idle_minutes": 1441}).status_code == 422


def test_a_shorter_idle_setting_applies_at_once(admin):
    import datetime as dt

    from tournament_server.db import utc_now
    from tournament_server.models.device import Device

    device = paired_device(admin)
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).last_seen_at = utc_now() - dt.timedelta(minutes=20)
    db.commit()
    db.close()
    assert _device_row(admin, device["id"])["status"] == "active"
    admin.put("/api/devices/settings", json={"idle_minutes": 15})
    assert _device_row(admin, device["id"])["status"] == "idle"


def test_me_needs_a_paired_device(admin):
    raw = TestClient(admin.app)
    assert raw.get("/api/devices/me", headers=bearer(login_as(raw, "scorer"))).status_code == 404
    device = paired_device(admin, name="Pit TV", role="display_device")
    me = raw.get("/api/devices/me", headers=device["headers"]).json()
    assert me == {"id": device["id"], "name": "Pit TV", "role": "display_device", "status": "active"}


@pytest.mark.parametrize("role", ["scorer", "referee", "judge", "attendee", "display_device", "front_desk"])
def test_management_is_admin_only(admin, role):
    device = paired_device(admin)
    raw = TestClient(admin.app)
    headers = bearer(login_as(raw, role))
    assert raw.patch(f"/api/devices/{device['id']}", json={"name": "x"}, headers=headers).status_code == 403
    assert raw.post(f"/api/devices/{device['id']}/disable", headers=headers).status_code == 403
    assert raw.post(f"/api/devices/{device['id']}/enable", headers=headers).status_code == 403
    assert raw.delete(f"/api/devices/{device['id']}", headers=headers).status_code == 403
    assert raw.get("/api/devices/settings", headers=headers).status_code == 403
    assert raw.put("/api/devices/settings", json={"idle_minutes": 30}, headers=headers).status_code == 403


def test_each_action_writes_one_curated_audit_entry_without_the_token(admin):
    from tournament_server.audit import AuditLog

    device = paired_device(admin, name="Tab")
    admin.patch(f"/api/devices/{device['id']}", json={"name": "Tab 2"})
    admin.post(f"/api/devices/{device['id']}/disable")
    admin.post(f"/api/devices/{device['id']}/enable")
    admin.delete(f"/api/devices/{device['id']}")
    db = admin.app.state.session_factory()
    rows = db.query(AuditLog).filter(AuditLog.table_name == "devices").order_by(AuditLog.id).all()
    db.close()
    assert [r.action for r in rows] == ["pair", "update", "disable", "enable", "delete"]
    for row in rows:
        text = f"{row.before_json} {row.after_json}"
        assert "token" not in text
    assert json.loads(rows[1].after_json)["name"] == "Tab 2"
    assert rows[-1].after_json is None
```

- [ ] **Step 2: Write the failing socket tests**

Read `tests/test_websockets_router.py` first and copy how it builds an entered `TestClient` and creates an event; the tests below assume an `admin` fixture like Step 1's whose client was entered with `with TestClient(app) as client` (the `client` fixture may already be entered — check `conftest.py`).

```python
# server/tests/test_device_sockets.py
from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from device_helpers import paired_device
from skills_helpers import next_event


@pytest.fixture
def admin(client):
    client.post("/api/event", json={"name": "Socket Event"})
    return client


def _connect(admin, device):
    return admin.websocket_connect(f"/ws/active-session?token={device['access_token']}")


@pytest.mark.parametrize("action", ["disable", "delete", "role"])
def test_a_device_change_closes_its_sockets_with_4403(admin, action):
    device = paired_device(admin)
    with _connect(admin, device) as socket:
        if action == "disable":
            admin.post(f"/api/devices/{device['id']}/disable")
        elif action == "delete":
            admin.delete(f"/api/devices/{device['id']}")
        else:
            admin.patch(f"/api/devices/{device['id']}", json={"role": "judge"})
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                socket.receive_json()
        assert closed.value.code == 4403


def test_a_disabled_device_cannot_open_a_socket(admin):
    device = paired_device(admin)
    admin.post(f"/api/devices/{device['id']}/disable")
    with pytest.raises(WebSocketDisconnect):
        with _connect(admin, device) as socket:
            socket.receive_json()


def test_a_rename_does_not_close_the_socket_and_device_changes_are_broadcast(admin):
    device = paired_device(admin)
    with _connect(admin, device) as socket:
        admin.patch(f"/api/devices/{device['id']}", json={"name": "Renamed"})
        assert next_event(socket, "devices_changed")["data"] == {}
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_device_management.py tests/test_device_sockets.py -q`
Expected: FAIL — 405s for the new routes and no socket close.

- [ ] **Step 4: Device-aware sockets**

In `realtime.py`, add `import contextlib` and:

```python
DEVICE_CHANGED_CLOSE_CODE = 4403
```

give `ConnectionRegistry.__init__` `self.by_device: dict[int, set[WebSocket]] = {}`, and add:

```python
def register_device_socket(app: "FastAPI", device_id: int, websocket: WebSocket) -> None:
    app.state.realtime.by_device.setdefault(device_id, set()).add(websocket)


def unregister_device_socket(app: "FastAPI", device_id: int, websocket: WebSocket) -> None:
    sockets = app.state.realtime.by_device.get(device_id)
    if sockets is not None:
        sockets.discard(websocket)
        if not sockets:
            del app.state.realtime.by_device[device_id]


def close_device_sockets(app: "FastAPI", device_id: int) -> None:
    """Closes a device's open sockets so it reconnects and sees its new state
    (disabled, deleted or a different role)."""
    registry = app.state.realtime
    if registry.event_loop is None:
        return

    async def _close() -> None:
        for websocket in list(registry.by_device.get(device_id, ())):
            with contextlib.suppress(Exception):
                await websocket.close(code=DEVICE_CHANGED_CLOSE_CODE)

    asyncio.run_coroutine_threadsafe(_close(), registry.event_loop)
```

In `routers/websockets.py`, make `_authenticate` resolve a `Caller`:

```python
from tournament_server.auth import ROLES, Caller, CallerRejected, resolve_caller


async def _authenticate(websocket: WebSocket, allowed_roles: tuple[str, ...]) -> Caller | None:
    token = websocket.query_params.get("token")
    if token is None:
        await websocket.close(code=1008)
        return None
    db: Session = websocket.app.state.session_factory()
    try:
        caller = resolve_caller(token, db)
    except CallerRejected:
        await websocket.close(code=1008)
        return None
    finally:
        db.close()
    if caller.role != "admin" and caller.role not in allowed_roles:
        await websocket.close(code=1008)
        return None
    return caller
```

and in both channel handlers replace `role = await _authenticate(...)` / `if role is None` with `caller = ...` / `if caller is None`, then after `realtime.register_...` add `if caller.device_id is not None: realtime.register_device_socket(websocket.app, caller.device_id, websocket)`, and in the `finally` add `if caller.device_id is not None: realtime.unregister_device_socket(websocket.app, caller.device_id, websocket)`.

- [ ] **Step 5: The management routes**

Add to `schemas/device.py`:

```python
from pydantic import Field


class DeviceUpdate(BaseModel):
    name: str | None = None
    role: str | None = None


class DeviceSettings(BaseModel):
    idle_minutes: int = Field(ge=15, le=1440)
```

Add to `routers/devices.py` (imports: `Response` from fastapi, `realtime` already imported, `Caller`, `get_caller` from auth, `Event` model, `get_event_or_404` from deps, `DeviceSelf`, `DeviceSettings`, `DeviceUpdate`). Register the `/settings` and `/me` routes **before** the `/{device_id}` routes:

```python
@router.get("/settings", response_model=DeviceSettings)
def read_settings(db: Session = Depends(get_db), _role: str = Depends(require_admin)) -> DeviceSettings:
    return DeviceSettings(idle_minutes=idle_minutes_for(db))


@router.put("/settings", response_model=DeviceSettings)
def write_settings(
    payload: DeviceSettings,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceSettings:
    event = get_event_or_404(db)
    event.device_idle_minutes = payload.idle_minutes
    db.commit()
    notify_devices_changed(request)
    return DeviceSettings(idle_minutes=event.device_idle_minutes)


@router.get("/me", response_model=DeviceSelf)
def read_me(caller: Caller = Depends(get_caller), db: Session = Depends(get_db)) -> DeviceSelf:
    if caller.device_id is None:
        raise HTTPException(status_code=404, detail="Not a paired device")
    device = db.get(Device, caller.device_id)
    return DeviceSelf(id=device.id, name=device.name, role=device.role, status="active")


def _device_or_404(db: Session, device_id: int) -> Device:
    device = db.get(Device, device_id)
    if device is None:
        raise HTTPException(status_code=404, detail="Device not found")
    return device


@router.patch("/{device_id}", response_model=DeviceRead)
def update_device(
    device_id: int,
    payload: DeviceUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = _device_or_404(db, device_id)
    changes = payload.model_dump(exclude_unset=True)
    if "name" in changes and changes["name"] is None or "role" in changes and changes["role"] is None:
        raise HTTPException(status_code=422, detail="Name and role can't be empty.")
    before = device_snapshot(device)
    role_changed = False
    if "role" in changes:
        role = checked_role(changes["role"])
        role_changed = role != device.role
        device.role = role
    if "name" in changes:
        name = checked_name(changes["name"])
        clash = db.execute(
            select(Device).where(Device.name_key == name_key(name), Device.id != device.id)
        ).scalars().first()
        if clash is not None:
            raise HTTPException(status_code=409, detail=DUPLICATE_NAME)
        device.name = name
        device.name_key = name_key(name)
    audit_device(db, device.id, "update", before, device_snapshot(device))
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail=DUPLICATE_NAME)
    db.refresh(device)
    if role_changed:
        realtime.close_device_sockets(request.app, device.id)
    notify_devices_changed(request)
    return to_device_read(device, db)


@router.post("/{device_id}/disable", response_model=DeviceRead)
def disable_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = _device_or_404(db, device_id)
    before = device_snapshot(device)
    if device.disabled_at is None:
        device.disabled_at = utc_now()
    audit_device(db, device.id, "disable", before, device_snapshot(device))
    db.commit()
    db.refresh(device)
    realtime.close_device_sockets(request.app, device.id)
    notify_devices_changed(request)
    return to_device_read(device, db)


@router.post("/{device_id}/enable", response_model=DeviceRead)
def enable_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> DeviceRead:
    device = _device_or_404(db, device_id)
    before = device_snapshot(device)
    device.disabled_at = None
    device.last_seen_at = utc_now()
    audit_device(db, device.id, "enable", before, device_snapshot(device))
    db.commit()
    db.refresh(device)
    notify_devices_changed(request)
    return to_device_read(device, db)


@router.delete("/{device_id}", status_code=204)
def delete_device(
    device_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    device = _device_or_404(db, device_id)
    audit_device(db, device.id, "delete", device_snapshot(device), None)
    db.delete(device)
    db.commit()
    realtime.close_device_sockets(request.app, device_id)
    notify_devices_changed(request)
    return Response(status_code=204)
```

The idle setting is a column on `events`, which the generic audit hook already records, so it needs no curated entry.

- [ ] **Step 6: Run the tests to see them pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_device_management.py tests/test_device_sockets.py tests/test_websockets_router.py tests/test_pairing_api.py -q`
Expected: all pass.

- [ ] **Step 7: Document the server side**

In `server/CLAUDE.md`, replace the whole "Scoring device admission" section with a "Device pairing" section covering, in this file's style: pairing codes in `app.state.pairing` (memory only, 5 minutes, 50 max, 60 s collect grace, `expires_in`); `POST /api/pairing`, `GET /api/pairing/codes/{code}` (admin), `GET /api/pairing/{id}` with `X-Pairing-Key`; `POST /api/devices/pair`; `POST /api/auth/device` and its 401/403 bodies; the `device_id` claim and `resolve_caller`'s per-request check (role from the row, `last_seen_at` written at most once a minute, idle never revived by requests); status rules and `events.device_idle_minutes`; the management routes; `require_paired_scoring_device` replacing `require_admitted_device`; the curated audit entries and `devices` in `_EXCLUDED_TABLES`; `devices_changed`; sockets closed with 4403. Update the event catalog with `devices_changed — {}` (active-session channel). In "Known, deliberate gaps", remove the sentences saying `Device`/`ScoringDevice` admission is unbuilt, and in "Real-time channels" note that `/ws/*` checks a device token's device on connect. Remove every mention of `TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES` and `X-Device-Token`.

- [ ] **Step 8: Run the whole server suite and commit**

Run: `cd server && .venv/bin/python -m pytest -q`
Expected: all pass.

```bash
git add server
git commit -m "Let admins rename paired devices, change their role, disable, enable and delete them, and set the idle timeout; a change closes the device's live connections so it sees its new state at once.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Serve the device app and the /pair shortcut

**Files:**
- Modify: `server/src/tournament_server/static_ui.py`, `server/src/tournament_server/app.py`, `server/src/tournament_server/settings.py`
- Test: `server/tests/test_static_ui.py`

**Interfaces:**
- Produces: `DEFAULT_DEVICE_STATIC_DIR` (`frontend/apps/device/dist`), `mount_device_ui(app, device_static_dir: str | None)`, `Settings.device_static_dir` (env `TOURNAMENT_DEVICE_STATIC_DIR`), `create_app(..., device_static_dir: str | None = None)`.

- [ ] **Step 1: Write the failing tests**

Read `tests/test_static_ui.py` and follow how it builds a temporary `dist` and an app with `static_dir=`. Add:

```python
def _device_dist(tmp_path):
    dist = tmp_path / "device-dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>device app</html>")
    (dist / "assets" / "app.js").write_text("console.log('device')")
    return dist


def _admin_dist(tmp_path):
    dist = tmp_path / "admin-dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>admin app</html>")
    return dist


def _app(tmp_path, device=True):
    from tournament_server.app import create_app

    return create_app(
        db_path=str(tmp_path / "e.db"),
        plugins_root=str(tmp_path / "plugins"),
        static_dir=str(_admin_dist(tmp_path)),
        device_static_dir=str(_device_dist(tmp_path)) if device else str(tmp_path / "missing"),
        config_path=tmp_path / "server-config.json",
    )


def test_pair_redirects_to_the_device_app(tmp_path):
    client = TestClient(_app(tmp_path))
    response = client.get("/pair", follow_redirects=False)
    assert response.status_code == 307
    assert response.headers["location"] == "/device/"


def test_device_routes_serve_the_device_app_and_fall_back_to_its_index(tmp_path):
    client = TestClient(_app(tmp_path))
    assert "device app" in client.get("/device/").text
    assert "device app" in client.get("/device/anything/deep").text
    assert "console.log('device')" in client.get("/device/assets/app.js").text


def test_the_admin_fallback_is_unchanged(tmp_path):
    client = TestClient(_app(tmp_path))
    assert "admin app" in client.get("/devices").text
    assert "admin app" in client.get("/teams").text


def test_without_a_device_build_device_paths_are_404_not_the_admin_app(tmp_path):
    client = TestClient(_app(tmp_path, device=False))
    assert client.get("/device/").status_code == 404
    assert client.get("/pair", follow_redirects=False).status_code == 307
```

Use the same `TestClient` import and any `TOURNAMENT_*` env handling the existing tests in that file use.

- [ ] **Step 2: Run them to see them fail**

Run: `cd server && .venv/bin/python -m pytest tests/test_static_ui.py -q`
Expected: FAIL — `create_app() got an unexpected keyword argument 'device_static_dir'`.

- [ ] **Step 3: Serve the device app**

In `static_ui.py` add:

```python
from fastapi.responses import RedirectResponse

DEFAULT_DEVICE_STATIC_DIR = (
    Path(__file__).resolve().parents[3] / "frontend" / "apps" / "device" / "dist"
)


def mount_device_ui(app: FastAPI, device_static_dir: str | None) -> None:
    """Serves the device app (built with base "/device/") under /device/,
    with its own SPA fallback, plus the short /pair address a TV can type.
    Must be registered before mount_static_admin_ui's catch-all."""

    @app.get("/pair", include_in_schema=False)
    def pair_shortcut() -> RedirectResponse:
        return RedirectResponse("/device/", status_code=307)

    resolved = Path(device_static_dir) if device_static_dir else DEFAULT_DEVICE_STATIC_DIR
    if not resolved.is_dir():
        return
    assets_dir = resolved / "assets"
    if assets_dir.is_dir():
        app.mount("/device/assets", StaticFiles(directory=assets_dir), name="device-ui-assets")

    @app.get("/device", include_in_schema=False)
    @app.get("/device/{full_path:path}", include_in_schema=False)
    def serve_device_ui(full_path: str = "") -> FileResponse:
        return FileResponse(resolved / "index.html")
```

and in `mount_static_admin_ui`'s catch-all, also 404 for `full_path == "device" or full_path.startswith("device/")`, so a missing device build never serves the admin app at a device address.

In `settings.py` add `device_static_dir: str | None = None` and `device_static_dir=os.environ.get("TOURNAMENT_DEVICE_STATIC_DIR")`. In `app.py` add the `device_static_dir: str | None = None` parameter to `create_app` and, just before `mount_static_admin_ui(...)`, call `mount_device_ui(app, device_static_dir or settings.device_static_dir)`. Mirror how `static_dir` is resolved there (explicit argument first, then the setting).

- [ ] **Step 4: Run the tests to see them pass**

Run: `cd server && .venv/bin/python -m pytest tests/test_static_ui.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add server
git commit -m "Serve the device app under /device/ with its own fallback, and redirect /pair there so a TV only types a short address.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The device app

**Files:**
- Create: everything under `frontend/apps/device/` listed in File Structure.

**Interfaces:**
- Consumes: the server API from Tasks 3-4 (`POST /api/pairing` → `{id, code, poll_key, expires_at, expires_in}`; `GET /api/pairing/{id}` with `X-Pairing-Key` → `{status, device_token}` or 404; `POST /api/auth/device` → 200 `{access_token, expires_in, device: {id, name, role, status}}` / 401 / 403 `{detail, status, name}`; `/ws/active-session?token=` closing with 4403); `initI18n` from `@tournament-admin/shared`.
- Produces (for Task 8): the dev server serves under base `/device/` and proxies `/api` and `/ws` to `VITE_BACKEND_PORT` (default 8000); screens use these accessible texts: heading "Pair this device", the code in an element with `data-testid="pairing-code"`, "Paired as", "This device is disabled.", "Can't reach the server. Retrying…".

- [ ] **Step 1: Scaffold the app**

```json
// frontend/apps/device/package.json
{
  "name": "@tournament-admin/device",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run"
  },
  "dependencies": {
    "@tournament-admin/shared": "*",
    "i18next": "^23.15.0",
    "qrcode": "^1.5.4",
    "react": "^19.2.0",
    "react-dom": "^19.2.0",
    "react-i18next": "^15.0.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.0",
    "@types/qrcode": "^1.5.5",
    "@types/react": "^19.2.0",
    "@types/react-dom": "^19.2.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "typescript": "^5.6.2",
    "vite": "^5.4.6",
    "vitest": "^2.1.1"
  }
}
```

Copy `frontend/apps/admin/tsconfig.json` to `frontend/apps/device/tsconfig.json` unchanged, `frontend/apps/admin/vitest.config.ts` to the device app unchanged, and `frontend/apps/admin/vitest.setup.ts` to the device app (keep only the jest-dom import and any generic setup; drop anything admin-specific).

```ts
// frontend/apps/device/vite.config.ts
import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const backendPort = env.VITE_BACKEND_PORT ?? "8000";
  return {
    base: "/device/",
    plugins: [react()],
    resolve: {
      alias: {
        "@tournament-admin/shared": path.resolve(__dirname, "../../packages/shared/src"),
      },
    },
    server: {
      proxy: {
        "/api": `http://127.0.0.1:${backendPort}`,
        "/ws": { target: `ws://127.0.0.1:${backendPort}`, ws: true },
      },
    },
  };
});
```

```html
<!-- frontend/apps/device/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Tournament Device</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Run `cd frontend && npm install` so the workspace links the new app.

- [ ] **Step 2: Strings**

```json
// frontend/apps/device/src/i18n/en/device.json
{
  "connecting": "Connecting…",
  "unreachable": "Can't reach the server. Retrying…",
  "pairing": {
    "heading": "Pair this device",
    "instructions": "In the admin app, open Devices and enter this code.",
    "expiresIn": "New code in {{seconds}} s",
    "qrLabel": "QR code that opens the admin app's Devices page with this code"
  },
  "home": {
    "pairedAs": "Paired as",
    "ready": "Ready."
  },
  "blocked": {
    "heading": "This device is disabled.",
    "askAdmin": "Ask an admin to enable {{name}}."
  },
  "roles": {
    "scorer": "Scorer",
    "referee": "Referee",
    "judge": "Judge",
    "front_desk": "Check-in",
    "display_device": "Display"
  }
}
```

```json
// frontend/apps/device/src/i18n/zh/device.json
{
  "connecting": "正在连接…",
  "unreachable": "无法连接服务器，正在重试…",
  "pairing": {
    "heading": "配对此设备",
    "instructions": "在管理应用中打开“设备”，输入此代码。",
    "expiresIn": "{{seconds}} 秒后更换新代码",
    "qrLabel": "二维码：打开管理应用的设备页面并填入此代码"
  },
  "home": {
    "pairedAs": "已配对为",
    "ready": "就绪。"
  },
  "blocked": {
    "heading": "此设备已停用。",
    "askAdmin": "请管理员启用 {{name}}。"
  },
  "roles": {
    "scorer": "记分员",
    "referee": "裁判",
    "judge": "评委",
    "front_desk": "签到",
    "display_device": "显示屏"
  }
}
```

```ts
// frontend/apps/device/src/i18nSetup.ts
import { initI18n } from "@tournament-admin/shared";
import en from "./i18n/en/device.json";
import zh from "./i18n/zh/device.json";

initI18n({
  en: { translation: en },
  zh: { translation: zh },
});
```

- [ ] **Step 3: Write the failing API and storage tests**

```ts
// frontend/apps/device/tests/unit/deviceApi.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Unreachable,
  clearDeviceToken,
  getDeviceToken,
  pollPairing,
  requestPairingCode,
  signIn,
  storeDeviceToken,
} from "../../src/deviceApi";

function respond(status: number, body?: unknown) {
  return Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status }));
}

describe("device storage", () => {
  beforeEach(() => localStorage.clear());

  it("keeps its own key and never touches the admin's sign-in", () => {
    localStorage.setItem("tournament-admin.auth.v1", "admin-tokens");
    storeDeviceToken("device-secret");
    expect(getDeviceToken()).toBe("device-secret");
    expect(localStorage.getItem("tournament-admin.device.v1")).toContain("device-secret");
    clearDeviceToken();
    expect(getDeviceToken()).toBeNull();
    expect(localStorage.getItem("tournament-admin.auth.v1")).toBe("admin-tokens");
  });

  it("treats garbage in storage as no token", () => {
    localStorage.setItem("tournament-admin.device.v1", "{not json");
    expect(getDeviceToken()).toBeNull();
  });
});

describe("device requests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requests a pairing code", async () => {
    const code = { id: "p1", code: "KX49TM", poll_key: "k", expires_at: "x", expires_in: 300 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => respond(201, code));
    await expect(requestPairingCode()).resolves.toEqual(code);
    expect(fetchMock).toHaveBeenCalledWith("/api/pairing", expect.objectContaining({ method: "POST" }));
  });

  it("polls with the key and treats 404 as expired", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => respond(404, { detail: "Not found" }));
    await expect(pollPairing({ id: "p1", poll_key: "k" })).resolves.toEqual({ status: "expired" });
    const [, init] = fetchMock.mock.calls[0];
    expect((init as RequestInit).headers).toEqual({ "X-Pairing-Key": "k" });
  });

  it("maps sign-in answers", async () => {
    const device = { id: 1, name: "Tab", role: "scorer", status: "active" };
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() =>
      respond(200, { access_token: "a", expires_in: 1800, device })
    );
    await expect(signIn("t")).resolves.toEqual({ kind: "active", accessToken: "a", expiresIn: 1800, device });
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() =>
      respond(403, { detail: "This device is disabled", status: "idle", name: "Tab" })
    );
    await expect(signIn("t")).resolves.toEqual({ kind: "blocked", status: "idle", name: "Tab" });
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => respond(401, { detail: "gone" }));
    await expect(signIn("t")).resolves.toEqual({ kind: "unknown" });
  });

  it("reports a network failure or a server error as unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => Promise.reject(new TypeError("down")));
    await expect(signIn("t")).rejects.toBeInstanceOf(Unreachable);
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => respond(502));
    await expect(requestPairingCode()).rejects.toBeInstanceOf(Unreachable);
  });
});
```

Run: `cd frontend/apps/device && npx vitest run tests/unit/deviceApi.test.ts`
Expected: FAIL — cannot resolve `../../src/deviceApi`.

- [ ] **Step 4: Write `deviceApi.ts`**

```ts
// frontend/apps/device/src/deviceApi.ts
/**
 * The device app's own storage and requests. It shares an origin with the
 * admin app, so it uses its own storage key and never the shared
 * apiRequest (which reads and refreshes the admin's sign-in).
 */
const STORAGE_KEY = "tournament-admin.device.v1";

export interface PairingCode {
  id: string;
  code: string;
  poll_key: string;
  expires_at: string;
  expires_in: number;
}

export interface DeviceSelf {
  id: number;
  name: string;
  role: string;
  status: "active" | "idle" | "disabled";
}

export type PollResult =
  | { status: "waiting" }
  | { status: "paired"; device_token: string }
  | { status: "expired" };

export type SignInResult =
  | { kind: "active"; accessToken: string; expiresIn: number; device: DeviceSelf }
  | { kind: "blocked"; status: "idle" | "disabled"; name: string }
  | { kind: "unknown" };

export class Unreachable extends Error {
  constructor() {
    super("Can't reach the server");
    this.name = "Unreachable";
  }
}

export function getDeviceToken(): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const token = (parsed as { deviceToken?: unknown } | null)?.deviceToken;
    return typeof token === "string" ? token : null;
  } catch {
    return null;
  }
}

export function storeDeviceToken(deviceToken: string): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ deviceToken }));
}

export function clearDeviceToken(): void {
  localStorage.removeItem(STORAGE_KEY);
}

async function send(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new Unreachable();
  }
  if (response.status >= 500) throw new Unreachable();
  return response;
}

export async function requestPairingCode(): Promise<PairingCode> {
  const response = await send("/api/pairing", { method: "POST" });
  if (!response.ok) throw new Unreachable();
  return (await response.json()) as PairingCode;
}

export async function pollPairing(code: Pick<PairingCode, "id" | "poll_key">): Promise<PollResult> {
  const response = await send(`/api/pairing/${encodeURIComponent(code.id)}`, {
    headers: { "X-Pairing-Key": code.poll_key },
  });
  if (response.status === 404) return { status: "expired" };
  if (!response.ok) throw new Unreachable();
  return (await response.json()) as PollResult;
}

export async function signIn(deviceToken: string): Promise<SignInResult> {
  const response = await send("/api/auth/device", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_token: deviceToken }),
  });
  if (response.status === 401) return { kind: "unknown" };
  if (response.status === 403) {
    const body = (await response.json()) as { status: "idle" | "disabled"; name: string };
    return { kind: "blocked", status: body.status, name: body.name };
  }
  if (!response.ok) throw new Unreachable();
  const body = (await response.json()) as { access_token: string; expires_in: number; device: DeviceSelf };
  return { kind: "active", accessToken: body.access_token, expiresIn: body.expires_in, device: body.device };
}

export function pairingLink(origin: string, code: string): string {
  return `${origin}/devices?pair=${encodeURIComponent(code)}`;
}

export function formatCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`;
}
```

Run the test again. Expected: PASS.

- [ ] **Step 5: Write the failing screen tests**

```tsx
// frontend/apps/device/tests/unit/App.test.tsx
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../src/i18nSetup";

vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn(() => Promise.resolve()) } }));

import QRCode from "qrcode";
import { App } from "../../src/App";

const sockets: { url: string; onclose?: (e: { code: number }) => void; close: () => void }[] = [];
class FakeSocket {
  url: string;
  onclose?: (e: { code: number }) => void;
  onmessage?: unknown;
  onopen?: unknown;
  constructor(url: string) {
    this.url = url;
    sockets.push(this);
  }
  close() {}
}

type Route = (url: string, init?: RequestInit) => { status: number; body?: unknown } | Promise<never>;
function serve(route: Route) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const result = route(String(input), init);
    if (result instanceof Promise) return result;
    return Promise.resolve(
      new Response(result.body === undefined ? null : JSON.stringify(result.body), { status: result.status })
    );
  });
}

const CODE = { id: "p1", code: "KX49TM", poll_key: "k", expires_at: "2000-01-01T00:00:00Z", expires_in: 300 };
const DEVICE = { id: 7, name: "Field 1 Tablet", role: "scorer", status: "active" };

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  localStorage.clear();
  sockets.length = 0;
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("device app", () => {
  it("shows a code and a QR link, and keeps it although the device clock is past expires_at", async () => {
    serve((url) => (url === "/api/pairing" ? { status: 201, body: CODE } : { status: 200, body: { status: "waiting" } }));
    render(<App />);
    expect(await screen.findByTestId("pairing-code")).toHaveTextContent("KX4 9TM");
    expect(QRCode.toCanvas).toHaveBeenCalledWith(
      expect.anything(),
      `${window.location.origin}/devices?pair=KX49TM`,
      expect.anything()
    );
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(screen.getByTestId("pairing-code")).toHaveTextContent("KX4 9TM");
  });

  it("asks for a new code when the countdown runs out", async () => {
    let issued = 0;
    serve((url) => {
      if (url === "/api/pairing") {
        issued += 1;
        return { status: 201, body: { ...CODE, id: `p${issued}`, code: issued === 1 ? "KX49TM" : "AAAAAA", expires_in: 5 } };
      }
      return { status: 200, body: { status: "waiting" } };
    });
    render(<App />);
    expect(await screen.findByTestId("pairing-code")).toHaveTextContent("KX4 9TM");
    await act(() => vi.advanceTimersByTimeAsync(6_000));
    expect(await screen.findByTestId("pairing-code")).toHaveTextContent("AAA AAA");
  });

  it("stores the token when paired and shows home", async () => {
    let polls = 0;
    serve((url) => {
      if (url === "/api/pairing") return { status: 201, body: CODE };
      if (url.startsWith("/api/pairing/")) {
        polls += 1;
        return { status: 200, body: polls < 2 ? { status: "waiting" } : { status: "paired", device_token: "dt" } };
      }
      if (url === "/api/auth/device") return { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } };
      return { status: 404 };
    });
    render(<App />);
    await screen.findByTestId("pairing-code");
    await act(() => vi.advanceTimersByTimeAsync(4_500));
    expect(await screen.findByText("Field 1 Tablet")).toBeInTheDocument();
    expect(screen.getByText(/Scorer/)).toBeInTheDocument();
    expect(localStorage.getItem("tournament-admin.device.v1")).toContain("dt");
  });

  it("shows the disabled screen and returns home once enabled", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dt" }));
    let enabled = false;
    serve((url) =>
      url === "/api/auth/device"
        ? enabled
          ? { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } }
          : { status: 403, body: { detail: "This device is disabled", status: "disabled", name: "Field 1 Tablet" } }
        : { status: 404 }
    );
    render(<App />);
    expect(await screen.findByText("This device is disabled.")).toBeInTheDocument();
    enabled = true;
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(await screen.findByText("Field 1 Tablet")).toBeInTheDocument();
  });

  it("clears a deleted device's token and shows a pairing code", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dt" }));
    serve((url) => {
      if (url === "/api/auth/device") return { status: 401, body: { detail: "gone" } };
      if (url === "/api/pairing") return { status: 201, body: CODE };
      return { status: 200, body: { status: "waiting" } };
    });
    render(<App />);
    expect(await screen.findByTestId("pairing-code")).toBeInTheDocument();
    expect(localStorage.getItem("tournament-admin.device.v1")).toBeNull();
  });

  it("signs in again at once when the server closes the socket with 4403", async () => {
    localStorage.setItem("tournament-admin.device.v1", JSON.stringify({ deviceToken: "dt" }));
    let calls = 0;
    serve((url) => {
      if (url !== "/api/auth/device") return { status: 404 };
      calls += 1;
      return calls === 1
        ? { status: 200, body: { access_token: "a", expires_in: 1800, device: DEVICE } }
        : { status: 403, body: { detail: "This device is disabled", status: "disabled", name: "Field 1 Tablet" } };
    });
    render(<App />);
    await screen.findByText("Field 1 Tablet");
    expect(sockets[0].url).toContain("/ws/active-session?token=a");
    act(() => sockets[0].onclose?.({ code: 4403 }));
    expect(await screen.findByText("This device is disabled.")).toBeInTheDocument();
  });

  it("says when the server can't be reached and recovers", async () => {
    let up = false;
    serve((url) => {
      if (!up) return Promise.reject(new TypeError("down")) as never;
      return url === "/api/pairing" ? { status: 201, body: CODE } : { status: 200, body: { status: "waiting" } };
    });
    render(<App />);
    expect(await screen.findByText("Can't reach the server. Retrying…")).toBeInTheDocument();
    up = true;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(await screen.findByTestId("pairing-code")).toBeInTheDocument();
    expect(screen.queryByText("Can't reach the server. Retrying…")).not.toBeInTheDocument();
  });
});
```

Run: `cd frontend/apps/device && npx vitest run tests/unit/App.test.tsx`
Expected: FAIL — cannot resolve `../../src/App`.

- [ ] **Step 6: Write the session hook, the socket hook, the screens and the app**

```ts
// frontend/apps/device/src/useDeviceSession.ts
import { useCallback, useEffect, useState } from "react";
import { Unreachable, clearDeviceToken, getDeviceToken, signIn, storeDeviceToken, type DeviceSelf } from "./deviceApi";

export const BLOCKED_RETRY_MS = 30_000;
export const UNREACHABLE_RETRY_MS = 5_000;
const RENEW_BEFORE_EXPIRY_MS = 60_000;

export type Screen =
  | { kind: "loading" }
  | { kind: "pairing" }
  | { kind: "home"; device: DeviceSelf }
  | { kind: "blocked"; name: string };

export function useDeviceSession() {
  const [screen, setScreen] = useState<Screen>(() => (getDeviceToken() ? { kind: "loading" } : { kind: "pairing" }));
  const [unreachable, setUnreachable] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const recheck = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const deviceToken = getDeviceToken();
    if (!deviceToken) {
      setAccessToken(null);
      setScreen({ kind: "pairing" });
      return undefined;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async () => {
      try {
        const result = await signIn(deviceToken);
        if (cancelled) return;
        setUnreachable(false);
        if (result.kind === "unknown") {
          clearDeviceToken();
          setAccessToken(null);
          setScreen({ kind: "pairing" });
        } else if (result.kind === "blocked") {
          setAccessToken(null);
          setScreen({ kind: "blocked", name: result.name });
          timer = setTimeout(run, BLOCKED_RETRY_MS);
        } else {
          setAccessToken(result.accessToken);
          setScreen({ kind: "home", device: result.device });
          timer = setTimeout(run, Math.max(result.expiresIn * 1000 - RENEW_BEFORE_EXPIRY_MS, 5_000));
        }
      } catch (error) {
        if (cancelled) return;
        if (!(error instanceof Unreachable)) throw error;
        setUnreachable(true);
        timer = setTimeout(run, UNREACHABLE_RETRY_MS);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt]);

  const paired = useCallback((deviceToken: string) => {
    storeDeviceToken(deviceToken);
    setScreen({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  return { screen, unreachable, accessToken, paired, recheck };
}
```

```ts
// frontend/apps/device/src/useDeviceSocket.ts
import { useEffect, useRef } from "react";

const DEVICE_CHANGED = 4403;
const RECONNECT_MS = 3_000;

/** Keeps the active-session socket open while signed in. A 4403 close means
 * this device was disabled, deleted or changed role, so it signs in again. */
export function useDeviceSocket(accessToken: string | null, onDeviceChanged: () => void): void {
  const callback = useRef(onDeviceChanged);
  callback.current = onDeviceChanged;

  useEffect(() => {
    if (!accessToken) return undefined;
    let stopped = false;
    let socket: WebSocket | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const connect = () => {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${protocol}//${window.location.host}/ws/active-session?token=${encodeURIComponent(accessToken)}`
      );
      socket.onclose = (event: CloseEvent | { code: number }) => {
        if (stopped) return;
        if (event.code === DEVICE_CHANGED || event.code === 1008) {
          callback.current();
          return;
        }
        timer = setTimeout(connect, RECONNECT_MS);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, [accessToken]);
}
```

```tsx
// frontend/apps/device/src/screens/PairingScreen.tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import QRCode from "qrcode";
import { Unreachable, formatCode, pairingLink, pollPairing, requestPairingCode, type PairingCode } from "../deviceApi";
import { UNREACHABLE_RETRY_MS } from "../useDeviceSession";

const POLL_MS = 2_000;

interface Props {
  onPaired: (deviceToken: string) => void;
  onReachability: (reachable: boolean) => void;
}

export function PairingScreen({ onPaired, onReachability }: Props) {
  const { t } = useTranslation();
  const [code, setCode] = useState<PairingCode | null>(null);
  // Expiry is counted on this device's own clock from expires_in, because a
  // TV's clock is often wrong; expires_at is never compared with Date.now().
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (code) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fetchCode = async () => {
      try {
        const next = await requestPairingCode();
        if (cancelled) return;
        onReachability(true);
        setDeadline(Date.now() + next.expires_in * 1000);
        setNow(Date.now());
        setCode(next);
      } catch (error) {
        if (cancelled) return;
        if (!(error instanceof Unreachable)) throw error;
        onReachability(false);
        timer = setTimeout(fetchCode, UNREACHABLE_RETRY_MS);
      }
    };
    void fetchCode();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, onReachability]);

  useEffect(() => {
    if (!code) return undefined;
    let stopped = false;
    const id = setInterval(() => {
      void (async () => {
        try {
          const result = await pollPairing(code);
          if (stopped) return;
          onReachability(true);
          if (result.status === "paired") {
            stopped = true;
            clearInterval(id);
            onPaired(result.device_token);
          } else if (result.status === "expired") {
            setCode(null);
          }
        } catch (error) {
          if (!(error instanceof Unreachable)) throw error;
          if (!stopped) onReachability(false);
        }
      })();
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [code, onPaired, onReachability]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (code && now >= deadline) setCode(null);
  }, [code, now, deadline]);

  useEffect(() => {
    if (code && canvas.current) {
      void QRCode.toCanvas(canvas.current, pairingLink(window.location.origin, code.code), { width: 240, margin: 1 });
    }
  }, [code]);

  return (
    <section className="pairing">
      <h1>{t("pairing.heading")}</h1>
      {code && (
        <>
          <p className="pairing__code" data-testid="pairing-code">
            {formatCode(code.code)}
          </p>
          <canvas ref={canvas} className="pairing__qr" role="img" aria-label={t("pairing.qrLabel")} />
          <p className="pairing__instructions">{t("pairing.instructions")}</p>
          <p className="pairing__countdown">
            {t("pairing.expiresIn", { seconds: Math.max(0, Math.ceil((deadline - now) / 1000)) })}
          </p>
        </>
      )}
    </section>
  );
}
```

```tsx
// frontend/apps/device/src/screens/HomeScreen.tsx
import { useTranslation } from "react-i18next";
import type { DeviceSelf } from "../deviceApi";

export function HomeScreen({ device }: { device: DeviceSelf }) {
  const { t } = useTranslation();
  return (
    <section className="home">
      <p className="home__label">{t("home.pairedAs")}</p>
      <h1 className="home__name">{device.name}</h1>
      <p className="home__role">
        {t(`roles.${device.role}`, { defaultValue: device.role })} · {t("home.ready")}
      </p>
    </section>
  );
}
```

```tsx
// frontend/apps/device/src/screens/BlockedScreen.tsx
import { useTranslation } from "react-i18next";

export function BlockedScreen({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <section className="blocked">
      <h1>{t("blocked.heading")}</h1>
      <p>{t("blocked.askAdmin", { name })}</p>
    </section>
  );
}
```

```tsx
// frontend/apps/device/src/App.tsx
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useDeviceSession } from "./useDeviceSession";
import { useDeviceSocket } from "./useDeviceSocket";
import { PairingScreen } from "./screens/PairingScreen";
import { HomeScreen } from "./screens/HomeScreen";
import { BlockedScreen } from "./screens/BlockedScreen";

export function App() {
  const { t } = useTranslation();
  const session = useDeviceSession();
  const [pairingReachable, setPairingReachable] = useState(true);
  const onReachability = useCallback((reachable: boolean) => setPairingReachable(reachable), []);
  useDeviceSocket(session.screen.kind === "home" ? session.accessToken : null, session.recheck);

  const unreachable = session.screen.kind === "pairing" ? !pairingReachable : session.unreachable;
  const { screen } = session;

  return (
    <main className="device-screen">
      {unreachable && (
        <p className="device-banner" role="status">
          {t("unreachable")}
        </p>
      )}
      {screen.kind === "loading" && <p className="device-connecting">{t("connecting")}</p>}
      {screen.kind === "pairing" && <PairingScreen onPaired={session.paired} onReachability={onReachability} />}
      {screen.kind === "home" && <HomeScreen device={screen.device} />}
      {screen.kind === "blocked" && <BlockedScreen name={screen.name} />}
    </main>
  );
}
```

```tsx
// frontend/apps/device/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import "./i18nSetup";
import "./styles/device.css";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

```css
/* frontend/apps/device/src/styles/device.css */
:root {
  --device-bg: #f7f7f5;
  --device-fg: #1b1b1f;
  --device-muted: #5c5c66;
  --device-accent: #2f5bd3;
  --device-banner-bg: #fff3cd;
  --device-banner-fg: #5c4400;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --device-bg: #121216;
    --device-fg: #f2f2f5;
    --device-muted: #a3a3ad;
    --device-accent: #8aa8ff;
    --device-banner-bg: #3d3000;
    --device-banner-fg: #ffe08a;
  }
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--device-bg);
  color: var(--device-fg);
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
}
.device-screen {
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
  text-align: center;
  gap: 1.5rem;
}
.device-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  margin: 0;
  padding: 0.75rem 1rem;
  background: var(--device-banner-bg);
  color: var(--device-banner-fg);
  font-size: clamp(1rem, 2.5vw, 1.5rem);
}
.pairing h1, .blocked h1 { font-size: clamp(1.5rem, 4vw, 3rem); margin: 0 0 1rem; }
.pairing__code {
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-size: clamp(3rem, 14vw, 10rem);
  font-weight: 700;
  letter-spacing: 0.08em;
  margin: 0;
  color: var(--device-accent);
}
.pairing__qr { background: #fff; padding: 0.5rem; border-radius: 0.5rem; width: min(240px, 60vw); height: auto; }
.pairing__instructions, .blocked p { font-size: clamp(1.1rem, 3vw, 2rem); margin: 0; }
.pairing__countdown, .home__label, .home__role, .device-connecting {
  color: var(--device-muted);
  font-size: clamp(1rem, 2.5vw, 1.5rem);
  margin: 0;
}
.home__name { font-size: clamp(2.5rem, 9vw, 6rem); margin: 0.25rem 0; }
```

- [ ] **Step 7: Run the tests and the type check**

Run: `cd frontend/apps/device && npx vitest run && npx tsc -b && npx vite build`
Expected: all tests pass, no type errors, `dist/index.html` references `/device/assets/...`. If a timing test is flaky, fix the hook or the test's timer handling; never raise a wait to paper over it.

- [ ] **Step 8: Commit**

```bash
git add frontend/apps/device frontend/package-lock.json
git commit -m "Add the device app: a large pairing code with a QR link that renews by itself, the paired home placeholder, the disabled screen, and recovery when the server is unreachable or the device is deleted.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(`frontend/apps/device/dist` must stay untracked; check `.gitignore` covers `dist` the way it does for the admin app.)

---

### Task 7: Admin Devices page, return-after-sign-in, and the Pair this device button

**Files:**
- Create: `frontend/apps/admin/src/devices/useDevices.ts`, `frontend/apps/admin/src/devices/format.ts`, `frontend/apps/admin/src/devices/PairDeviceForm.tsx`, `frontend/apps/admin/src/devices/EditDeviceDialog.tsx`, `frontend/apps/admin/src/routes/DevicesRoute.tsx`
- Modify: `frontend/apps/admin/src/router.tsx`, `frontend/apps/admin/src/components/AppShell.tsx`, `frontend/apps/admin/src/routes/AuthenticatedLayout.tsx`, `frontend/apps/admin/src/routes/LoginRoute.tsx`, `frontend/apps/admin/src/routeGuards.ts`, `frontend/apps/admin/src/i18n/en/admin.json`, `frontend/apps/admin/src/i18n/zh/admin.json`
- Test: `frontend/apps/admin/tests/unit/DevicesRoute.test.tsx`, `frontend/apps/admin/tests/unit/PairDeviceForm.test.tsx`, `frontend/apps/admin/tests/unit/loginReturn.test.tsx`

**Interfaces:**
- Consumes: the server API from Tasks 3-4; `apiRequest`, `ApiError`, `useRealtimeChannel` from `@tournament-admin/shared`; `ConfirmDialog`, `Modal`, `apiErrorMessage`.
- Produces: the Devices page at `/devices` with nav link "Devices"; `safeReturnPath(value: unknown): string | null` in `routeGuards.ts`; login page link "Pair this device" to `/pair`. Labels used by Task 8: "Pairing code", "Role", "Device name", button "Pair", success text "Paired {{name}}.", row buttons "Edit", "Disable", "Enable", "Delete", confirm button "Delete", status texts "Active", "Idle", "Disabled".

- [ ] **Step 1: Strings**

Add to `src/i18n/en/admin.json` (`shell.devicesLink` inside `shell`, `login.pairThisDevice` inside `login`, and a new top-level `devices` block):

```json
"devicesLink": "Devices",
```

```json
"pairThisDevice": "Pair this device",
```

```json
"devices": {
  "heading": "Devices",
  "pairHeading": "Pair a device",
  "pairHelp": "Open the server address followed by /pair on the device, then enter the code it shows.",
  "codeLabel": "Pairing code",
  "roleLabel": "Role",
  "nameLabel": "Device name",
  "pair": "Pair",
  "paired": "Paired {{name}}.",
  "checking": "Checking code…",
  "unknownCode": "That code isn't valid or has expired.",
  "listHeading": "Paired devices",
  "empty": "No devices are paired yet.",
  "columns": { "name": "Name", "role": "Role", "status": "Status", "lastSeen": "Last seen", "actions": "Actions" },
  "status": { "active": "Active", "idle": "Idle", "disabled": "Disabled" },
  "roles": { "scorer": "Scorer", "referee": "Referee", "judge": "Judge", "front_desk": "Check-in", "display_device": "Display" },
  "edit": "Edit",
  "editHeading": "Edit {{name}}",
  "save": "Save",
  "cancel": "Cancel",
  "disable": "Disable",
  "enable": "Enable",
  "delete": "Delete",
  "deleteHeading": "Delete device",
  "deleteBody": "Delete {{name}}? It will need to be paired again.",
  "idleHeading": "Inactivity",
  "idleLabel": "Disable operator devices after this many minutes without activity",
  "idleHelp": "Displays are never disabled for inactivity. Allowed: 15 to 1,440 minutes.",
  "idleSave": "Save",
  "idleSaved": "Saved.",
  "justNow": "just now",
  "loadError": "Couldn't load the devices."
}
```

and the same keys in `src/i18n/zh/admin.json`:

```json
"devicesLink": "设备",
```

```json
"pairThisDevice": "配对此设备",
```

```json
"devices": {
  "heading": "设备",
  "pairHeading": "配对设备",
  "pairHelp": "在设备上打开服务器地址并加上 /pair，然后输入设备显示的代码。",
  "codeLabel": "配对代码",
  "roleLabel": "角色",
  "nameLabel": "设备名称",
  "pair": "配对",
  "paired": "已配对 {{name}}。",
  "checking": "正在检查代码…",
  "unknownCode": "该代码无效或已过期。",
  "listHeading": "已配对的设备",
  "empty": "尚未配对任何设备。",
  "columns": { "name": "名称", "role": "角色", "status": "状态", "lastSeen": "最近活动", "actions": "操作" },
  "status": { "active": "活动", "idle": "闲置", "disabled": "已停用" },
  "roles": { "scorer": "记分员", "referee": "裁判", "judge": "评委", "front_desk": "签到", "display_device": "显示屏" },
  "edit": "编辑",
  "editHeading": "编辑 {{name}}",
  "save": "保存",
  "cancel": "取消",
  "disable": "停用",
  "enable": "启用",
  "delete": "删除",
  "deleteHeading": "删除设备",
  "deleteBody": "删除 {{name}}？之后需要重新配对。",
  "idleHeading": "闲置",
  "idleLabel": "操作设备无活动多少分钟后停用",
  "idleHelp": "显示屏不会因闲置而停用。范围：15 到 1440 分钟。",
  "idleSave": "保存",
  "idleSaved": "已保存。",
  "justNow": "刚刚",
  "loadError": "无法加载设备。"
}
```

If the admin app has a test that checks en and zh have the same keys, it will now cover these.

- [ ] **Step 2: Write the failing tests**

Read `tests/unit/BackupsRoute.test.tsx` first and reuse its way of rendering a route with a `QueryClientProvider`, a router and i18n, and of stubbing `fetch`/`apiRequest`. Write the tests in that style:

```tsx
// frontend/apps/admin/tests/unit/PairDeviceForm.test.tsx  (outline of the cases, in the BackupsRoute test style)
// 1. Typing "kx4-9tm" checks GET /api/pairing/codes/KX49TM once and fills the name box with the suggested name.
// 2. An unknown code shows "That code isn't valid or has expired." and keeps Pair disabled.
// 3. Pair sends POST /api/devices/pair {code: "KX49TM", role: "scorer", name} and shows "Paired <name>." then clears the form.
// 4. A 409 shows "A device with that name already exists." from the server's detail.
// 5. Choosing "Display" in Role sends role "display_device".
// 6. Rendering with initialCode="KX49TM" checks the code straight away.
// 7. A name the admin typed is not replaced when the check returns a suggestion.
```

```tsx
// frontend/apps/admin/tests/unit/DevicesRoute.test.tsx  (cases)
// 1. Lists devices by name with role label, status label and last seen ("3 min ago" for 3 minutes; "just now" under a minute).
// 2. "No devices are paired yet." for an empty list.
// 3. Edit opens a dialog with name and role; Save sends PATCH /api/devices/{id} {name, role} and closes; a 409 detail shows in the dialog.
// 4. Disable on an active row sends POST .../disable; an Idle or Disabled row shows Enable, which sends POST .../enable.
// 5. Delete asks "Delete Pit TV? It will need to be paired again." and sends DELETE on confirm.
// 6. The idle form shows 240, refuses 14 and 1441 in the browser (min/max), and Save sends PUT /api/devices/settings {idle_minutes}.
// 7. /devices?pair=KX49TM passes the code to the pair form (the check request is made).
// 8. A devices_changed realtime event refetches GET /api/devices (mock useRealtimeChannel the way other admin tests do, or spy on it and call its onEvent).
```

```tsx
// frontend/apps/admin/tests/unit/loginReturn.test.tsx  (cases)
// 1. safeReturnPath("/devices?pair=X") === "/devices?pair=X"; safeReturnPath("//evil.example") === null; safeReturnPath("https://x") === null; safeReturnPath(42) === null.
// 2. AuthenticatedLayout, signed out at /devices?pair=X, navigates to /login with state.from "/devices?pair=X".
// 3. LoginRoute with location.state.from "/devices?pair=X" navigates there after a successful login, and to "/" without it.
// 4. LoginRoute shows a "Pair this device" link whose href is "/pair".
```

Write each case as a real test with assertions on the requests made and the visible text, following the existing tests' helpers; no case may be left as a comment.

Run: `cd frontend/apps/admin && npx vitest run tests/unit/PairDeviceForm.test.tsx tests/unit/DevicesRoute.test.tsx tests/unit/loginReturn.test.tsx`
Expected: FAIL — the modules don't exist.

- [ ] **Step 3: Return after sign-in and the Pair this device link**

In `routeGuards.ts`:

```ts
/** A same-app path to return to after signing in, or null for anything else
 * (an absolute URL or a protocol-relative "//host" would leave the app). */
export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}
```

In `AuthenticatedLayout.tsx` change the redirect to:

```tsx
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
```

In `LoginRoute.tsx`: `import { useLocation, useNavigate } from "react-router-dom";`, `import { safeReturnPath } from "../routeGuards";`, then `const location = useLocation();` and after a successful login:

```tsx
      const from = safeReturnPath((location.state as { from?: unknown } | null)?.from);
      navigate(from ?? "/", { replace: true });
```

and after the form, inside `auth-card`:

```tsx
        <p className="auth-card__pair">
          <a className="btn btn-secondary" href="/pair">
            {t("login.pairThisDevice")}
          </a>
        </p>
```

(a plain link, not a router `Link`: `/pair` belongs to the device app). If `.auth-card__pair` needs spacing, add a rule in `styles/components.css` using the existing spacing tokens.

- [ ] **Step 4: Data hooks and formatting**

```ts
// frontend/apps/admin/src/devices/useDevices.ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@tournament-admin/shared";

export type DeviceStatus = "active" | "idle" | "disabled";

export interface DeviceRead {
  id: number;
  name: string;
  role: string;
  status: DeviceStatus;
  paired_at: string;
  paired_by: string;
  last_seen_at: string;
  disabled_at: string | null;
}

export interface PairingCodeCheck {
  code: string;
  suggested_name: string;
  expires_at: string;
}

export const PAIRABLE_ROLES = ["scorer", "referee", "judge", "front_desk", "display_device"] as const;
export const DEVICES_KEY = ["devices"];
export const DEVICE_SETTINGS_KEY = ["devices", "settings"];

export function useDevices() {
  return useQuery({
    queryKey: DEVICES_KEY,
    queryFn: () => apiRequest<DeviceRead[]>("/api/devices"),
    refetchOnWindowFocus: true,
  });
}

export function useDeviceSettings() {
  return useQuery({
    queryKey: DEVICE_SETTINGS_KEY,
    queryFn: () => apiRequest<{ idle_minutes: number }>("/api/devices/settings"),
  });
}

export function useDeviceMutations() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
  return {
    pair: useMutation({
      mutationFn: (body: { code: string; role: string; name: string }) =>
        apiRequest<DeviceRead>("/api/devices/pair", { method: "POST", body }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: number; name: string; role: string }) =>
        apiRequest<DeviceRead>(`/api/devices/${id}`, { method: "PATCH", body }),
      onSuccess: refresh,
    }),
    setEnabled: useMutation({
      mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
        apiRequest<DeviceRead>(`/api/devices/${id}/${enabled ? "enable" : "disable"}`, { method: "POST" }),
      onSuccess: refresh,
    }),
    remove: useMutation({
      mutationFn: (id: number) => apiRequest<void>(`/api/devices/${id}`, { method: "DELETE" }),
      onSuccess: refresh,
    }),
    saveSettings: useMutation({
      mutationFn: (idle_minutes: number) =>
        apiRequest<{ idle_minutes: number }>("/api/devices/settings", { method: "PUT", body: { idle_minutes } }),
      onSuccess: (data) => {
        queryClient.setQueryData(DEVICE_SETTINGS_KEY, data);
        return refresh();
      },
    }),
  };
}

export function checkPairingCode(code: string) {
  return apiRequest<PairingCodeCheck>(`/api/pairing/codes/${encodeURIComponent(code)}`);
}
```

```ts
// frontend/apps/admin/src/devices/format.ts
export function normalizeCode(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/** "3 min ago" style text in the page's language; null under a minute. */
export function relativeTime(iso: string, now: number, locale: string): string | null {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return null;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "always", style: "short" });
  if (minutes < 60) return format.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return format.format(-hours, "hour");
  return format.format(-Math.round(hours / 24), "day");
}
```

- [ ] **Step 5: The pair form, the edit dialog and the page**

```tsx
// frontend/apps/admin/src/devices/PairDeviceForm.tsx
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiError } from "@tournament-admin/shared";
import { apiErrorMessage } from "../apiErrorMessage";
import { normalizeCode } from "./format";
import { PAIRABLE_ROLES, checkPairingCode, useDeviceMutations, type PairingCodeCheck } from "./useDevices";

const CODE_LENGTH = 6;

export function PairDeviceForm({ initialCode = "" }: { initialCode?: string }) {
  const { t } = useTranslation();
  const { pair } = useDeviceMutations();
  const [code, setCode] = useState(initialCode);
  const [role, setRole] = useState<string>("scorer");
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<PairingCodeCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [pairedName, setPairedName] = useState<string | null>(null);
  const lastSuggestion = useRef("");

  const normalized = normalizeCode(code);

  useEffect(() => {
    setChecked(null);
    setCodeError(null);
    if (normalized.length !== CODE_LENGTH) return undefined;
    let cancelled = false;
    setChecking(true);
    checkPairingCode(normalized)
      .then((result) => {
        if (cancelled) return;
        setChecked(result);
        setName((current) => (current === "" || current === lastSuggestion.current ? result.suggested_name : current));
        lastSuggestion.current = result.suggested_name;
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) setCodeError(t("devices.unknownCode"));
        else setCodeError(apiErrorMessage(error, t("errors.generic")));
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [normalized, t]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPairedName(null);
    const device = await pair.mutateAsync({ code: normalized, role, name }).catch(() => null);
    if (!device) return;
    setPairedName(device.name);
    setCode("");
    setName("");
    lastSuggestion.current = "";
  }

  return (
    <form className="card" onSubmit={handleSubmit} aria-labelledby="pair-heading">
      <h2 id="pair-heading">{t("devices.pairHeading")}</h2>
      <p className="muted">{t("devices.pairHelp")}</p>
      <div className="field">
        <label className="field__label" htmlFor="pair-code">{t("devices.codeLabel")}</label>
        <input
          className="input"
          id="pair-code"
          value={code}
          autoComplete="off"
          autoCapitalize="characters"
          onChange={(event) => setCode(event.target.value)}
          aria-invalid={codeError ? true : undefined}
          aria-describedby={codeError ? "pair-code-error" : undefined}
        />
        {checking && <p className="muted">{t("devices.checking")}</p>}
        {codeError && <p className="alert alert-danger" id="pair-code-error" role="alert">{codeError}</p>}
      </div>
      <div className="field">
        <label className="field__label" htmlFor="pair-role">{t("devices.roleLabel")}</label>
        <select className="input" id="pair-role" value={role} onChange={(event) => setRole(event.target.value)}>
          {PAIRABLE_ROLES.map((r) => (
            <option key={r} value={r}>{t(`devices.roles.${r}`)}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="pair-name">{t("devices.nameLabel")}</label>
        <input className="input" id="pair-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
      </div>
      {pair.isError && (
        <p className="alert alert-danger" role="alert">{apiErrorMessage(pair.error, t("errors.generic"))}</p>
      )}
      {pairedName && <p className="alert alert-success" role="status">{t("devices.paired", { name: pairedName })}</p>}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={!checked || !name.trim() || pair.isPending}>
          {t("devices.pair")}
        </button>
      </div>
    </form>
  );
}
```

Check which alert and helper classes `styles/components.css` really defines (`alert-success`, `muted`, `card`); use the existing equivalents if those names differ, and don't add new colors.

```tsx
// frontend/apps/admin/src/devices/EditDeviceDialog.tsx
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Modal } from "../components/Modal";
import { apiErrorMessage } from "../apiErrorMessage";
import { PAIRABLE_ROLES, useDeviceMutations, type DeviceRead } from "./useDevices";

export function EditDeviceDialog({ device, onClose }: { device: DeviceRead; onClose: () => void }) {
  const { t } = useTranslation();
  const { update } = useDeviceMutations();
  const [name, setName] = useState(device.name);
  const [role, setRole] = useState(device.role);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const saved = await update.mutateAsync({ id: device.id, name, role }).catch(() => null);
    if (saved) onClose();
  }

  return (
    <Modal labelledBy="edit-device-heading" onCancel={onClose}>
      <form onSubmit={handleSubmit}>
        <h2 id="edit-device-heading">{t("devices.editHeading", { name: device.name })}</h2>
        <div className="field">
          <label className="field__label" htmlFor="edit-device-name">{t("devices.nameLabel")}</label>
          <input className="input" id="edit-device-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="edit-device-role">{t("devices.roleLabel")}</label>
          <select className="input" id="edit-device-role" value={role} onChange={(e) => setRole(e.target.value)}>
            {PAIRABLE_ROLES.map((r) => (
              <option key={r} value={r}>{t(`devices.roles.${r}`)}</option>
            ))}
          </select>
        </div>
        {update.isError && <p className="alert alert-danger" role="alert">{apiErrorMessage(update.error, t("errors.generic"))}</p>}
        <div className="form-actions">
          <button className="btn btn-secondary" type="button" onClick={onClose}>{t("devices.cancel")}</button>
          <button className="btn btn-primary" type="submit" disabled={!name.trim() || update.isPending}>{t("devices.save")}</button>
        </div>
      </form>
    </Modal>
  );
}
```

Read `components/Modal.tsx` first: if it expects its own heading or footer markup, adapt the dialog to it rather than nesting a second structure.

```tsx
// frontend/apps/admin/src/routes/DevicesRoute.tsx
import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useRealtimeChannel } from "@tournament-admin/shared";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { apiErrorMessage } from "../apiErrorMessage";
import { EditDeviceDialog } from "../devices/EditDeviceDialog";
import { PairDeviceForm } from "../devices/PairDeviceForm";
import { relativeTime } from "../devices/format";
import { DEVICES_KEY, useDeviceMutations, useDeviceSettings, useDevices, type DeviceRead } from "../devices/useDevices";

export function DevicesRoute() {
  const { t, i18n } = useTranslation();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const devices = useDevices();
  const settings = useDeviceSettings();
  const { setEnabled, remove, saveSettings } = useDeviceMutations();
  const [editing, setEditing] = useState<DeviceRead | null>(null);
  const [deleting, setDeleting] = useState<DeviceRead | null>(null);
  const [idleDraft, setIdleDraft] = useState("");
  const [now, setNow] = useState(() => Date.now());

  useRealtimeChannel({
    path: "/ws/active-session",
    onEvent: (event) => {
      if (event.event === "devices_changed") void queryClient.invalidateQueries({ queryKey: DEVICES_KEY });
    },
  });

  useEffect(() => {
    if (settings.data) setIdleDraft(String(settings.data.idle_minutes));
  }, [settings.data]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  function handleIdleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    saveSettings.mutate(Number(idleDraft));
  }

  return (
    <div className="page">
      <h1>{t("devices.heading")}</h1>
      <PairDeviceForm initialCode={params.get("pair") ?? ""} />

      <section className="card" aria-labelledby="devices-list-heading">
        <h2 id="devices-list-heading">{t("devices.listHeading")}</h2>
        {devices.isError && <p className="alert alert-danger" role="alert">{t("devices.loadError")}</p>}
        {devices.data && devices.data.length === 0 && <p>{t("devices.empty")}</p>}
        {devices.data && devices.data.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{t("devices.columns.name")}</th>
                <th scope="col">{t("devices.columns.role")}</th>
                <th scope="col">{t("devices.columns.status")}</th>
                <th scope="col">{t("devices.columns.lastSeen")}</th>
                <th scope="col">{t("devices.columns.actions")}</th>
              </tr>
            </thead>
            <tbody>
              {devices.data.map((device) => (
                <tr key={device.id}>
                  <td>{device.name}</td>
                  <td>{t(`devices.roles.${device.role}`, { defaultValue: device.role })}</td>
                  <td>
                    <span className={`badge badge-${device.status}`}>{t(`devices.status.${device.status}`)}</span>
                  </td>
                  <td>{relativeTime(device.last_seen_at, now, i18n.language) ?? t("devices.justNow")}</td>
                  <td className="table__actions">
                    <button className="btn btn-secondary" type="button" onClick={() => setEditing(device)}>
                      {t("devices.edit")}
                    </button>
                    <button
                      className="btn btn-secondary"
                      type="button"
                      onClick={() => setEnabled.mutate({ id: device.id, enabled: device.status !== "active" })}
                    >
                      {device.status === "active" ? t("devices.disable") : t("devices.enable")}
                    </button>
                    <button className="btn btn-danger" type="button" onClick={() => setDeleting(device)}>
                      {t("devices.delete")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {setEnabled.isError && (
          <p className="alert alert-danger" role="alert">{apiErrorMessage(setEnabled.error, t("errors.generic"))}</p>
        )}
      </section>

      <form className="card" onSubmit={handleIdleSubmit} aria-labelledby="idle-heading">
        <h2 id="idle-heading">{t("devices.idleHeading")}</h2>
        <div className="field">
          <label className="field__label" htmlFor="idle-minutes">{t("devices.idleLabel")}</label>
          <input
            className="input"
            id="idle-minutes"
            type="number"
            min={15}
            max={1440}
            required
            value={idleDraft}
            onChange={(event) => setIdleDraft(event.target.value)}
          />
          <p className="muted">{t("devices.idleHelp")}</p>
        </div>
        {saveSettings.isError && (
          <p className="alert alert-danger" role="alert">{apiErrorMessage(saveSettings.error, t("errors.generic"))}</p>
        )}
        {saveSettings.isSuccess && <p role="status">{t("devices.idleSaved")}</p>}
        <div className="form-actions">
          <button className="btn btn-primary" type="submit" disabled={saveSettings.isPending}>{t("devices.idleSave")}</button>
        </div>
      </form>

      {editing && <EditDeviceDialog device={editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          heading={t("devices.deleteHeading")}
          body={t("devices.deleteBody", { name: deleting.name })}
          confirmLabel={t("devices.delete")}
          cancelLabel={t("devices.cancel")}
          isPending={remove.isPending}
          error={remove.isError ? apiErrorMessage(remove.error, t("errors.generic")) : null}
          onConfirm={() => remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) })}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
```

Use the page wrapper, table, badge and danger-button classes the other admin pages use (read `BackupsRoute.tsx` and `components.css`); rename the classes above to match rather than inventing new ones. If no status badge style exists, show the status as plain text.

Register the route in `router.tsx` (`import { DevicesRoute } from "./routes/DevicesRoute";` and `{ path: "devices", element: <DevicesRoute /> },` after `backups`) and add the nav link in `AppShell.tsx` after Backups:

```tsx
            <NavLink to="/devices" className={navLinkClassName}>
              {t("shell.devicesLink")}
            </NavLink>
```

- [ ] **Step 6: Run the tests and the type check**

Run: `cd frontend/apps/admin && npx vitest run && npx tsc -b`
Expected: all pass; existing AppShell/nav tests updated if they assert the exact list of links.

- [ ] **Step 7: Commit**

```bash
git add frontend/apps/admin
git commit -m "Add the admin Devices page: pair by code with a suggested name, edit, disable, enable and delete devices, set the idle timeout, and return to the page after signing in; the sign-in page links to pairing.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Dev wiring, end-to-end tests and frontend docs

**Files:**
- Modify: `frontend/apps/admin/vite.config.ts`, `frontend/apps/admin/tests/e2e/fixtures/isolatedServer.ts`
- Create: `frontend/apps/admin/tests/e2e/devicePairing.spec.ts`
- Modify: `frontend/CLAUDE.md`

**Interfaces:**
- Consumes: everything above. Ports: backend 8132, admin Vite 5192, device Vite 5193.
- Produces: `startIsolatedServer({ backendPort, frontendPort, devicePort? })` also starts the device dev server when `devicePort` is given and points the admin dev server's `/device` and `/pair` proxy at it.

- [ ] **Step 1: Proxy the device app through the admin dev server**

In `frontend/apps/admin/vite.config.ts` read `const devicePort = env.VITE_DEVICE_PORT ?? "5175";` and add to `server.proxy`:

```ts
        "/device": { target: `http://127.0.0.1:${devicePort}`, ws: true },
        "^/pair/?$": { target: `http://127.0.0.1:${devicePort}`, rewrite: () => "/device/" },
```

so in development, as in production, the admin app and the device app share one origin (the QR link and `/pair` then work from the admin dev URL).

- [ ] **Step 2: Let the isolated server start the device app**

In `isolatedServer.ts`, add an optional `devicePort?: number` to the options; include it in the port-in-use check; when set, spawn `npm run dev -- --port <devicePort> --strictPort` with `cwd` `path.resolve(__dirname, "../../../../device")` and env `VITE_BACKEND_PORT`, wait for the port, and pass `VITE_DEVICE_PORT: String(devicePort)` in the admin dev server's env. Push it onto `spawned` like the others so `stop()` reaps it.

- [ ] **Step 3: Write the end-to-end tests**

```ts
// frontend/apps/admin/tests/e2e/devicePairing.spec.ts
import { test, expect, type Browser, type Page } from "@playwright/test";
import { startIsolatedServer, type IsolatedServer } from "./fixtures/isolatedServer";

const PASSWORD = "pairing-e2e-pw";

test.describe.serial("device pairing", () => {
  test.describe.configure({ timeout: 90_000 });

  let server: IsolatedServer;

  async function adminPage(browser: Browser, path = "/devices"): Promise<Page> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.baseUrl}${path}`);
    await page.getByLabel("Role").fill("admin");
    await page.getByLabel("Password").fill(PASSWORD);
    await page.getByRole("button", { name: "Log in" }).click();
    await expect(page.getByRole("heading", { name: "Devices", level: 1 })).toBeVisible();
    return page;
  }

  async function devicePage(browser: Browser): Promise<{ page: Page; code: string }> {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${server.baseUrl}/pair`);
    const shown = page.getByTestId("pairing-code");
    await expect(shown).toHaveText(/^[A-Z0-9]{3} [A-Z0-9]{3}$/);
    return { page, code: (await shown.textContent())!.replace(" ", "") };
  }

  async function pair(admin: Page, code: string, name: string, role = "Scorer") {
    await admin.getByLabel("Pairing code").fill(code);
    await expect(admin.getByLabel("Device name")).not.toHaveValue("");
    await admin.getByLabel("Role").selectOption({ label: role });
    await admin.getByLabel("Device name").fill(name);
    await admin.getByRole("button", { name: "Pair" }).click();
    await expect(admin.getByText(`Paired ${name}.`)).toBeVisible();
  }

  test.beforeAll(async ({ request }) => {
    server = await startIsolatedServer({ backendPort: 8132, frontendPort: 5192, devicePort: 5193 });
    const created = await request.post(`${server.apiUrl}/api/event`, { data: { name: "Pairing League", password: PASSWORD } });
    expect(created.status()).toBe(201);
  });

  test.afterAll(() => server?.stop());

  test("pair a scorer, stay paired after a reload, disable, enable and delete", async ({ browser }) => {
    const device = await devicePage(browser);
    const admin = await adminPage(browser);
    await pair(admin, device.code.toLowerCase(), "Field 1 Tablet");

    await expect(device.page.getByText("Field 1 Tablet")).toBeVisible({ timeout: 10_000 });
    await expect(device.page.getByText(/Scorer/)).toBeVisible();
    await device.page.reload();
    await expect(device.page.getByText("Field 1 Tablet")).toBeVisible();

    const row = admin.getByRole("row").filter({ hasText: "Field 1 Tablet" });
    await row.getByRole("button", { name: "Disable" }).click();
    await expect(row.getByText("Disabled")).toBeVisible();
    await expect(device.page.getByText("This device is disabled.")).toBeVisible({ timeout: 10_000 });

    await row.getByRole("button", { name: "Enable" }).click();
    await expect(device.page.getByText("Field 1 Tablet")).toBeVisible({ timeout: 40_000 });

    await row.getByRole("button", { name: "Delete" }).click();
    const dialog = admin.getByRole("alertdialog");
    await expect(dialog).toContainText("Delete Field 1 Tablet? It will need to be paired again.");
    await dialog.getByRole("button", { name: "Delete" }).click();
    await expect(admin.getByRole("row").filter({ hasText: "Field 1 Tablet" })).toHaveCount(0);
    await expect(device.page.getByTestId("pairing-code")).toBeVisible({ timeout: 10_000 });
  });

  test("the QR link fills in and checks the code after signing in", async ({ browser }) => {
    const device = await devicePage(browser);
    const admin = await adminPage(browser, `/devices?pair=${device.code}`);
    await expect(admin.getByLabel("Pairing code")).toHaveValue(device.code);
    await expect(admin.getByLabel("Device name")).not.toHaveValue("");
  });

  test("an unknown or expired code is refused", async ({ browser }) => {
    const admin = await adminPage(browser);
    await admin.getByLabel("Pairing code").fill("AAA AAA");
    await expect(admin.getByText("That code isn't valid or has expired.")).toBeVisible();
    await expect(admin.getByRole("button", { name: "Pair" })).toBeDisabled();
  });

  test("pairing a device in the admin's own browser keeps the admin signed in", async ({ browser }) => {
    const admin = await adminPage(browser);
    const sameBrowser = await admin.context().newPage();
    await sameBrowser.goto(`${server.baseUrl}/pair`);
    const code = (await sameBrowser.getByTestId("pairing-code").textContent())!.replace(" ", "");
    await pair(admin, code, "Admin Laptop Display", "Display");
    await expect(sameBrowser.getByText("Admin Laptop Display")).toBeVisible({ timeout: 10_000 });
    await admin.reload();
    await expect(admin.getByRole("heading", { name: "Devices", level: 1 })).toBeVisible();
  });
});
```

The "enable" wait is up to 40 s because a disabled device rechecks every 30 s. If the login form's labels or button differ from `backups.spec.ts`, use the real ones.

- [ ] **Step 4: Run the end-to-end suite**

Run: `cd frontend/apps/admin && npx playwright test tests/e2e/devicePairing.spec.ts`
Expected: 4 passed. Then run the whole suite once: `npx playwright test` — all pass (the admin Vite proxy change must not break other specs).

- [ ] **Step 5: Document the frontend side**

In `frontend/CLAUDE.md`: add `apps/device` to the workspace description; a **Device app** paragraph (base `/device/`, served by the server at `/device/` with `/pair` redirecting; own storage key `tournament-admin.device.v1` and its own fetch helper in `deviceApi.ts`, never the shared `apiRequest`; screens pairing/home/blocked; countdown from `expires_in`; 30 s recheck when blocked; re-sign-in on a 4403 socket close; dev server proxied through the admin dev server's `/device` and `/pair` via `VITE_DEVICE_PORT`, default 5175); a **Devices page** paragraph for the admin app (pair form, `?pair=` prefill, return-after-sign-in via `safeReturnPath`, `devices_changed` refetch); and add `devicePairing.spec.ts` on 8132/5192 (device 5193) to the isolated-server port list.

- [ ] **Step 6: Final full run and commit**

Run: `cd server && .venv/bin/python -m pytest -q`, `cd frontend/apps/admin && npx vitest run && npx tsc -b`, `cd frontend/apps/device && npx vitest run && npx tsc -b`.
Expected: all green.

```bash
git add frontend
git commit -m "Run the device app through the admin dev server, cover pairing end to end (pair, reload, disable, enable, delete, QR link, unknown code, same-browser pairing), and document the device app and the Devices page.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
