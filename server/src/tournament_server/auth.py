from __future__ import annotations

import datetime as dt
import hashlib
import secrets
from dataclasses import dataclass

import bcrypt
import jwt
from cryptography.fernet import Fernet
from fastapi import Depends, Header, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.db import utc_now
from tournament_server.deps import get_db
from tournament_server.models.device import Device
from tournament_server.models.password_encryption_key import PasswordEncryptionKey
from tournament_server.models.signing_key import SigningKey
from tournament_server.services.devices import (
    LAST_SEEN_WRITE_INTERVAL,
    device_status,
    idle_minutes_for,
)

ROLES = (
    "admin",
    "scorer",
    "judge",
    "referee",
    "attendee",
    "display_device",
    "front_desk",
)

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


def get_password_encryption_key(db: Session) -> bytes:
    """A per-database Fernet key, lazily created and persisted the same way
    get_signing_key() persists the JWT key -- the key must live alongside
    the ciphertext it decrypts so a tournament's .db file stays
    self-contained and portable to another machine. Role passwords are
    also, and still primarily, verified via the one-way password_hash
    below; this key only backs the *reversible* copy
    (RoleCredential.password_encrypted) that lets an admin view a role's
    current password rather than only ever set a new one."""
    key_row = db.execute(select(PasswordEncryptionKey)).scalars().first()
    if key_row is None:
        key_row = PasswordEncryptionKey(key=Fernet.generate_key().decode("utf-8"))
        db.add(key_row)
        db.commit()
        db.refresh(key_row)
    return key_row.key.encode("utf-8")


def encrypt_password(password: str, key: bytes) -> str:
    return Fernet(key).encrypt(password.encode("utf-8")).decode("utf-8")


def decrypt_password(token: str, key: bytes) -> str:
    return Fernet(key).decrypt(token.encode("utf-8")).decode("utf-8")


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


require_admin = require_role()
require_any_role = require_role(*ROLES)
require_scorer_or_referee = require_role("scorer", "referee")
require_admin_or_front_desk = require_role("front_desk")
