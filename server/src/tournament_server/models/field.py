from __future__ import annotations

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class Field(Base):
    __tablename__ = "fields"

    id: Mapped[int] = mapped_column(primary_key=True)
    field_set_id: Mapped[int] = mapped_column(ForeignKey("field_sets.id"))
    name: Mapped[str] = mapped_column(String(200))
