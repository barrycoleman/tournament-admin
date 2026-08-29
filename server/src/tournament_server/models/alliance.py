from __future__ import annotations

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class Alliance(Base):
    __tablename__ = "alliances"

    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id"))
    station: Mapped[str] = mapped_column(String(20))


class AllianceTeam(Base):
    __tablename__ = "alliance_teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    alliance_id: Mapped[int] = mapped_column(ForeignKey("alliances.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
