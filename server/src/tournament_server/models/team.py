from __future__ import annotations

import random

from sqlalchemy import ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


def generate_tiebreaker_seed() -> int:
    return random.randint(1, 1_000_000_000)


class Team(Base):
    __tablename__ = "teams"

    __table_args__ = (
        UniqueConstraint("event_id", "number", name="uq_teams_event_number"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    number: Mapped[str] = mapped_column(String(20))
    name: Mapped[str] = mapped_column(String(200))
    robot_name: Mapped[str | None] = mapped_column(String(200), default=None)
    organization: Mapped[str | None] = mapped_column(String(200), default=None)
    city: Mapped[str | None] = mapped_column(String(200), default=None)
    state: Mapped[str | None] = mapped_column(String(100), default=None)
    country: Mapped[str | None] = mapped_column(String(100), default=None)
    tiebreaker_seed: Mapped[int] = mapped_column(default=generate_tiebreaker_seed)
