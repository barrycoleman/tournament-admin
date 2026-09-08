from __future__ import annotations

import datetime as dt

from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class ScoringDevice(Base):
    __tablename__ = "scoring_devices"

    id: Mapped[int] = mapped_column(primary_key=True)
    friendly_name: Mapped[str] = mapped_column(String(100), unique=True)
    device_token_hash: Mapped[str] = mapped_column(String(200), unique=True)
    registered_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    admitted_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
    admitted_by: Mapped[str | None] = mapped_column(String(200), default=None)
    last_seen_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
