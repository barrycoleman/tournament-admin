from __future__ import annotations

from sqlalchemy import Boolean, ForeignKey, Integer
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class BracketAlliance(Base):
    __tablename__ = "bracket_alliances"

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    seed: Mapped[int] = mapped_column(Integer)
    unavailable: Mapped[bool] = mapped_column(Boolean, default=False)


class BracketAllianceTeam(Base):
    __tablename__ = "bracket_alliance_teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_alliance_id: Mapped[int] = mapped_column(ForeignKey("bracket_alliances.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
