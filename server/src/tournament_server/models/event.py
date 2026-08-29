from __future__ import annotations

import datetime as dt

from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


def _utc_now() -> dt.datetime:
    return dt.datetime.now(dt.UTC)


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    active_session_id: Mapped[int | None] = mapped_column(
        Integer, default=None
    )
    game_plugin_name: Mapped[str | None] = mapped_column(String(200), default=None)
    created_at: Mapped[dt.datetime] = mapped_column(
        UTCDateTime, default=_utc_now
    )
