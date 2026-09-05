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
        if role != "admin" and (not allowed_roles or role not in allowed_roles):
            raise HTTPException(
                status_code=403, detail="This role cannot perform this operation"
            )
        return role

    return _dependency


require_admin = require_role()
require_any_role = require_role(*ROLES)
require_scorer_or_referee = require_role("scorer", "referee")
