from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base

PICK_KINDS = ("accept", "decline")


class FinalsPick(Base):
    """One answered invite during partner picking, in order (`seq`), so the
    admin can undo picking step by step. An accept points at the alliance it
    formed; a decline has none. A cancelled invite leaves no row."""

    __tablename__ = "finals_picks"
    __table_args__ = (
        UniqueConstraint("bracket_id", "seq", name="uq_finals_pick_bracket_seq"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    bracket_id: Mapped[int] = mapped_column(ForeignKey("finals_brackets.id"))
    seq: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(10))
    captain_team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    bracket_alliance_id: Mapped[int | None] = mapped_column(
        ForeignKey("bracket_alliances.id"), default=None
    )
