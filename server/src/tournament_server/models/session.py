from __future__ import annotations

import datetime as dt

from sqlalchemy import Date, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class TournamentSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    label: Mapped[str] = mapped_column(String(200))
    session_date: Mapped[dt.date | None] = mapped_column(Date, default=None)
