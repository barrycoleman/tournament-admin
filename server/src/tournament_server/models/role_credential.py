from __future__ import annotations

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class RoleCredential(Base):
    __tablename__ = "role_credentials"

    id: Mapped[int] = mapped_column(primary_key=True)
    role: Mapped[str] = mapped_column(String(20), unique=True)
    password_hash: Mapped[str] = mapped_column(String(200))
    # Reversibly encrypted (Fernet, see auth.py), alongside the one-way
    # password_hash above -- login verification still only ever uses
    # password_hash; this column exists solely so an admin can view a
    # role's current password. Null for a credential whose password was
    # last set before this column existed (there is nothing to decrypt for
    # it -- a one-way hash can't be recovered into this column
    # retroactively; it becomes viewable the next time the password is
    # changed).
    password_encrypted: Mapped[str | None] = mapped_column(String(500), default=None)
