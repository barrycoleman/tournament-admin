from __future__ import annotations

import datetime as dt

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


class Match(Base):
    __tablename__ = "matches"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    round_type: Mapped[str] = mapped_column(String(20))
    match_number: Mapped[int] = mapped_column(Integer)
    field_id: Mapped[int | None] = mapped_column(ForeignKey("fields.id"), default=None)
    time_slot: Mapped[int | None] = mapped_column(Integer, default=None)
    schedule_generation_id: Mapped[int | None] = mapped_column(
        ForeignKey("schedule_generations.id"), default=None
    )
    finals_bracket_id: Mapped[int | None] = mapped_column(
        ForeignKey("finals_brackets.id"), default=None
    )
    bracket_alliance_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
    bracket_matchup_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_matchups.id"), default=None
    )
    scheduled_time: Mapped[dt.datetime | None] = mapped_column(
        UTCDateTime, default=None
    )
    status: Mapped[str] = mapped_column(String(20), default="scheduled")
