from __future__ import annotations

import datetime as dt

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    role: Mapped[str] = mapped_column(String(20))
    refresh_token_hash: Mapped[str] = mapped_column(String(200), unique=True)
    issued_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    expires_at: Mapped[dt.datetime] = mapped_column(UTCDateTime)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
    label: Mapped[str | None] = mapped_column(String(200), default=None)
