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
    # device count) — append a short random suffix, still checked for
    # uniqueness so a rare double-collision doesn't surface as an
    # unauthenticated-endpoint 500.
    for _ in range(_MAX_NAME_RETRIES):
        candidate = f"{random.choice(_ADJECTIVES)}-{random.choice(_ANIMALS)}-{secrets.token_hex(2)}"
        exists = db.execute(
            select(ScoringDevice).where(ScoringDevice.friendly_name == candidate)
        ).scalars().first()
        if exists is None:
            return candidate
    raise RuntimeError("Could not generate a unique device friendly name")


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


def touch_device_activity(
    db: Session, device_token: str, idle_timeout: dt.timedelta
) -> None:
    token_hash = hash_token(device_token)
    device = db.execute(
        select(ScoringDevice).where(ScoringDevice.device_token_hash == token_hash)
    ).scalars().first()
    if device is None:
        return
    now = utc_now()
    if device.admitted_at is not None and not is_currently_admitted(device, now, idle_timeout):
        # This device was admitted at some point but has gone idle — only
        # an explicit re-admit may restore it (see the design spec's §5).
        # Letting any successful request refresh last_seen_at here would
        # make "idle" a self-healing sliding window instead of the
        # one-way gate the design requires, since require_admitted_device
        # only gates the one scoring endpoint — every other successful
        # request (a plain read) would otherwise silently revive it.
        return
    device.last_seen_at = now
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
