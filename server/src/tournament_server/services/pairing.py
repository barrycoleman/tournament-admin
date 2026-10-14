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

    def _evict_one(self) -> None:
        """Drop the oldest code nobody has paired; only if every code is
        paired (a token waiting to be collected) drop the oldest overall."""
        for pairing_id, pending in self._by_id.items():
            if pending.device_token is None:
                del self._by_id[pairing_id]
                return
        del self._by_id[next(iter(self._by_id))]

    def open(self, taken_name_keys: set[str]) -> PendingPairing:
        with self._lock:
            self._prune()
            while len(self._by_id) >= MAX_OPEN_CODES:
                self._evict_one()
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
            # The device may collect its token for a minute after the code's
            # own expiry, however early the code was paired.
            pending.expires_at += COLLECT_GRACE
            return True

    def poll(self, pairing_id: str, poll_key: str) -> tuple[PollStatus, str | None] | None:
        with self._lock:
            pending = self._by_id.get(pairing_id)
            # Compare bytes: compare_digest refuses non-ASCII str, and a
            # header can carry anything; a strange key is just a wrong key.
            if pending is None or not secrets.compare_digest(
                pending.poll_key.encode("utf-8"), poll_key.encode("utf-8", "surrogatepass")
            ):
                return None
            if pending.expires_at <= self._now():
                del self._by_id[pairing_id]
                return ("expired", None)
            if pending.device_token is not None:
                del self._by_id[pairing_id]
                return ("paired", pending.device_token)
            return ("waiting", None)
