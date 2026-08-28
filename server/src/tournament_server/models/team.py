from __future__ import annotations

import random

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


def generate_tiebreaker_seed() -> int:
    return random.randint(1, 1_000_000_000)


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    number: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(200))
    organization: Mapped[str | None] = mapped_column(String(200), default=None)
    city: Mapped[str | None] = mapped_column(String(200), default=None)
    state: Mapped[str | None] = mapped_column(String(100), default=None)
    country: Mapped[str | None] = mapped_column(String(100), default=None)
    tiebreaker_seed: Mapped[int] = mapped_column(default=generate_tiebreaker_seed)
