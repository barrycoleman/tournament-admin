from __future__ import annotations

import datetime as dt

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


class ScheduleGeneration(Base):
    __tablename__ = "schedule_generations"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    round_type: Mapped[str] = mapped_column(String(20))
    scheduler_plugin_name: Mapped[str] = mapped_column(String(200))
    scheduler_plugin_version: Mapped[str] = mapped_column(String(50))
    target_matches_per_team: Mapped[int] = mapped_column(Integer)
    generated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime)
