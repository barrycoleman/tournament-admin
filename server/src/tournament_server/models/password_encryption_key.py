from __future__ import annotations

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class PasswordEncryptionKey(Base):
    __tablename__ = "password_encryption_keys"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(200))
