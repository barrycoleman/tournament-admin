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
