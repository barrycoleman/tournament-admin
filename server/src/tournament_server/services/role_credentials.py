from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import ROLES
from tournament_server.models.role_credential import RoleCredential


def backfill_role_credentials(db: Session) -> None:
    """Ensures every role in ROLES has a RoleCredential row, for an event
    database that existed before a role was added to ROLES (e.g.
    front_desk). A backfilled row's password is copied from the current
    `admin` credential (both password_hash and password_encrypted) --
    mirroring POST /api/event's own original behavior of every role
    starting from one shared password until an admin differentiates them
    via Settings > Role Passwords. RoleCredential rows are not scoped per
    event (this project is one event per database file), so this needs no
    event argument. Idempotent: a no-op once every role already has a row."""
    existing_roles = {
        row for row in db.execute(select(RoleCredential.role)).scalars().all()
    }
    missing_roles = [role for role in ROLES if role not in existing_roles]
    if not missing_roles:
        return
    admin_credential = db.execute(
        select(RoleCredential).where(RoleCredential.role == "admin")
    ).scalars().first()
    if admin_credential is None:
        # No admin credential at all -- shouldn't happen for any real
        # event, since POST /api/event always seeds one. Nothing sensible
        # to copy from, so leave the missing roles missing rather than guess.
        return
    for role in missing_roles:
        db.add(
            RoleCredential(
                role=role,
                password_hash=admin_credential.password_hash,
                password_encrypted=admin_credential.password_encrypted,
            )
        )
