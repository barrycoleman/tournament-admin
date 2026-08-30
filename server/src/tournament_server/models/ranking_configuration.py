from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class RankingConfiguration(Base):
    __tablename__ = "ranking_configurations"
    __table_args__ = (
        UniqueConstraint(
            "event_id", "division_id", name="uq_ranking_config_event_division"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    mode: Mapped[str] = mapped_column(String(20))
    count: Mapped[int] = mapped_column(Integer)
    allow_drop_no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    allow_drop_dq: Mapped[bool] = mapped_column(Boolean, default=False)
