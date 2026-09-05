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
