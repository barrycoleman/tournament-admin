from __future__ import annotations

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class FieldSet(Base):
    __tablename__ = "field_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    name: Mapped[str] = mapped_column(String(200))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
