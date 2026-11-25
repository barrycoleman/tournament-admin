from __future__ import annotations

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base

EXCLUSION_REASONS = ("disqualified", "left_early")


class FinalsExclusion(Base):
    """A team kept out of finals for a session and division (disqualified or
    left early). Independent of any bracket so it survives a start-over."""

    __tablename__ = "finals_exclusions"
    __table_args__ = (
        UniqueConstraint(
            "session_id", "division_id", "team_id", name="uq_finals_exclusion_team"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    reason: Mapped[str] = mapped_column(String(20))
