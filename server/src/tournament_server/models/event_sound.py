from __future__ import annotations

import datetime as dt

from sqlalchemy import LargeBinary, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class EventSound(Base):
    """An organiser's replacement for one of the five sound slots."""

    __tablename__ = "event_sounds"

    id: Mapped[int] = mapped_column(primary_key=True)
    slot: Mapped[str] = mapped_column(String(20), unique=True)
    filename: Mapped[str] = mapped_column(String(200))
    content_type: Mapped[str] = mapped_column(String(50))
    data: Mapped[bytes] = mapped_column(LargeBinary)
    uploaded_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
