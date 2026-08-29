from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class SessionParticipation(Base):
    __tablename__ = "session_participation"
    __table_args__ = (
        UniqueConstraint(
            "session_id", "team_id", name="uq_session_participation_session_team"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    checked_in: Mapped[bool] = mapped_column(Boolean, default=False)
