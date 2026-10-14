from __future__ import annotations

import datetime as dt

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class Device(Base):
    """A browser paired by code (see the device pairing design). `name_key`
    is the lower-cased name, so names are unique ignoring case."""

    __tablename__ = "devices"
    # AUTOINCREMENT so a deleted device's id is never handed to a later one:
    # its unexpired access token carries that id and must not speak for it.
    __table_args__ = {"sqlite_autoincrement": True}

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    name_key: Mapped[str] = mapped_column(String(100), unique=True)
    role: Mapped[str] = mapped_column(String(20))
    token_hash: Mapped[str] = mapped_column(String(200), unique=True)
    paired_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    paired_by: Mapped[str] = mapped_column(String(200))
    last_seen_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    disabled_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
