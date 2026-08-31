from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class FinalsResult(Base):
    __tablename__ = "finals_results"
    __table_args__ = (
        UniqueConstraint(
            "finals_bracket_id", "bracket_alliance_id", name="uq_finals_result_bracket_alliance"
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    finals_bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    bracket_alliance_id: Mapped[int] = mapped_column(ForeignKey("bracket_alliances.id"))
    score: Mapped[int] = mapped_column(Integer, default=0)
    rank: Mapped[int] = mapped_column(Integer, default=0)
