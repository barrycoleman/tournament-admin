from __future__ import annotations

from sqlalchemy import ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class BracketMatchup(Base):
    __tablename__ = "bracket_matchups"

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    round_number: Mapped[int] = mapped_column(Integer)
    position: Mapped[int] = mapped_column(Integer)
    matchup_number: Mapped[int | None] = mapped_column(Integer, default=None)
    alliance_a_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
    alliance_b_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
    winner_alliance_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
