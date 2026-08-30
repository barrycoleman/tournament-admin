from __future__ import annotations

from sqlalchemy import Float, ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class Ranking(Base):
    __tablename__ = "rankings"
    __table_args__ = (
        UniqueConstraint(
            "session_id", "division_id", "team_id", name="uq_ranking_session_division_team"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    win_points: Mapped[int] = mapped_column(Integer, default=0)
    strength_of_schedule: Mapped[float] = mapped_column(Float, default=0.0)
    average_score: Mapped[float] = mapped_column(Float, default=0.0)
    matches_played: Mapped[int] = mapped_column(Integer, default=0)
    rank: Mapped[int] = mapped_column(Integer, default=0)
