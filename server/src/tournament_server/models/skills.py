from __future__ import annotations

import datetime as dt

from sqlalchemy import JSON, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class SkillsSettings(Base):
    """An event's skills-challenge settings. One row per event, created on the
    first save; until then reads use the defaults (off, 3 attempts per type)."""

    __tablename__ = "skills_settings"
    __table_args__ = (UniqueConstraint("event_id", name="uq_skills_settings_event"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    event_id: Mapped[int] = mapped_column(ForeignKey("events.id"))
    # The "Run skills challenges" switch.
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    # Type key -> attempts allowed per team per session; a missing type means 3.
    attempts: Mapped[dict[str, int]] = mapped_column(JSON, default=dict)


class SkillsAttempt(Base):
    """One recorded skills run. Its attempt number is derived (the team's
    attempts of this type in this session, ordered by recorded_at then id),
    so deleting one moves the later ones up."""

    __tablename__ = "skills_attempts"
    __table_args__ = (
        Index("ix_skills_attempts_session_team_type", "session_id", "team_id", "skills_type"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"))
    skills_type: Mapped[str] = mapped_column(String(50))
    data_json: Mapped[str] = mapped_column(Text)
    score: Mapped[int] = mapped_column(Integer)
    plugin_name: Mapped[str] = mapped_column(String(200))
    plugin_version: Mapped[str] = mapped_column(String(50))
    recorded_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
