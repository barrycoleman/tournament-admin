from __future__ import annotations

import datetime as dt

from sqlalchemy import JSON, Boolean, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class Award(Base):
    """One award in a session. Judged awards are entered by people;
    performance awards take their winners from a source (see
    services/award_sources.py) at a placement."""

    __tablename__ = "awards"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(String(2000), default=None)
    # Ceremony order within the session, 0-based.
    position: Mapped[int] = mapped_column(Integer)
    # "event" (one winner slot) or "division" (a slot per division).
    scope: Mapped[str] = mapped_column(String(20))
    # Division scope only; [] means every division of the event.
    division_ids: Mapped[list[int]] = mapped_column(JSON, default=list)
    # "judged" or "performance".
    kind: Mapped[str] = mapped_column(String(20))
    # Performance only.
    source: Mapped[str | None] = mapped_column(String(30), default=None)
    skills_type: Mapped[str | None] = mapped_column(String(50), default=None)
    basis: Mapped[str | None] = mapped_column(String(20), default=None)
    placement: Mapped[int | None] = mapped_column(Integer, default=None)


class AwardWinner(Base):
    """A stored recipient in one slot (an award in one division, or the event
    slot when division_id is NULL). Every row in a slot shares an origin:
    "judged", "override" or "finalized"."""

    __tablename__ = "award_winners"
    __table_args__ = (UniqueConstraint("award_id", "division_id", "team_id", name="uq_award_winner"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    award_id: Mapped[int] = mapped_column(ForeignKey("awards.id", ondelete="CASCADE"))
    division_id: Mapped[int | None] = mapped_column(ForeignKey("divisions.id"), default=None)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    origin: Mapped[str] = mapped_column(String(20))
    override_reason: Mapped[str | None] = mapped_column(String(500), default=None)
    # Reserved for the audience display's reveal mode.
    presented: Mapped[bool] = mapped_column(Boolean, default=False)
    recorded_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    recorded_by: Mapped[str] = mapped_column(String(200))
