from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class RankingSettings(Base):
    """How an event ranks teams. One row per event, shared by every division;
    head-to-head events store it but ignore it."""

    __tablename__ = "ranking_settings"
    __table_args__ = (UniqueConstraint("event_id", name="uq_ranking_settings_event"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    session_drop_mode: Mapped[str] = mapped_column(String(20), default="tiered")
    session_drop_count: Mapped[int] = mapped_column(Integer, default=1)
    session_drop_no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    session_drop_dq: Mapped[bool] = mapped_column(Boolean, default=False)
    season_keep_best: Mapped[int | None] = mapped_column(Integer, default=None)
    season_only_session_counted: Mapped[bool] = mapped_column(Boolean, default=False)
    season_minimum: Mapped[int] = mapped_column(Integer, default=0)
    season_drop_no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    season_drop_dq: Mapped[bool] = mapped_column(Boolean, default=False)
