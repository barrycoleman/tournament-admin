from __future__ import annotations

import datetime as dt

from sqlalchemy import Date, ForeignKey, JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


class TournamentSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    label: Mapped[str] = mapped_column(String(200))
    session_date: Mapped[dt.date | None] = mapped_column(Date, default=None)
    timezone: Mapped[str | None] = mapped_column(String(100), default=None)
    # Set when an admin finalizes qualification; NULL while it is open.
    qualification_finalized_at: Mapped[dt.datetime | None] = mapped_column(
        UTCDateTime, default=None
    )
    # Played count (as a string key) -> matches each such team drops, e.g.
    # {"7": 1, "8": 2}; {} for a finalized head-to-head session.
    qualification_drops: Mapped[dict[str, int] | None] = mapped_column(JSON, default=None)
    # Per-session skills attempts override (type key -> allowed attempts);
    # NULL uses the event setting, and a type missing here falls back to it.
    skills_attempts: Mapped[dict[str, int] | None] = mapped_column(JSON, default=None)
