from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class ScoreRecordTeam(Base):
    """One flagged team on a score record. Teams without a flag have no row."""

    __tablename__ = "score_record_teams"
    __table_args__ = (
        UniqueConstraint("score_record_id", "team_id", name="uq_score_record_team"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    score_record_id: Mapped[int] = mapped_column(ForeignKey("score_records.id", ondelete="CASCADE"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    dq: Mapped[bool] = mapped_column(Boolean, default=False)
