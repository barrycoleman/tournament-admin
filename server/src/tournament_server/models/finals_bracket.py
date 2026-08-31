from __future__ import annotations

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class FinalsBracket(Base):
    __tablename__ = "finals_brackets"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    field_set_id: Mapped[int] = mapped_column(ForeignKey("field_sets.id"))
    format: Mapped[str] = mapped_column(String(20))
    bracket_size: Mapped[int] = mapped_column(Integer)
    wins_to_advance: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[str] = mapped_column(String(30), default="selecting_alliances")
    next_field_index: Mapped[int] = mapped_column(Integer, default=0)
