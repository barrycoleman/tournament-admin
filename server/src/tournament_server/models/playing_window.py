from __future__ import annotations

import datetime as dt

from sqlalchemy import Date, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class SessionPlayingWindow(Base):
    """A span of session-local clock time on one date during which matches
    may be played. A session's windows never overlap; matches flow through
    them in (date, start_time) order, and the gaps between them are breaks."""

    __tablename__ = "session_playing_windows"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    date: Mapped[dt.date] = mapped_column(Date)
    start_time: Mapped[str] = mapped_column(String(5))
    end_time: Mapped[str] = mapped_column(String(5))
