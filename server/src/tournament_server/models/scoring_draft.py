"""Live scoring's working rows (live scoring design §4): draft scores,
skills field-set timers, skills runs and scorer bindings. None of them is
audited (audit._EXCLUDED_TABLES). Their foreign keys cascade on delete, so
deleting a match's alliances, a field, a field set, a team, a session or a
device takes them along without any helper."""
from __future__ import annotations

import datetime as dt

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class ScoreDraft(Base):
    """One alliance's unsubmitted scoresheet. A cooperative game keeps one
    shared draft per match, on the match's lowest alliance id."""

    __tablename__ = "score_drafts"
    __table_args__ = (UniqueConstraint("alliance_id", name="uq_score_draft_alliance"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    match_id: Mapped[int] = mapped_column(ForeignKey("matches.id", ondelete="CASCADE"))
    alliance_id: Mapped[int] = mapped_column(ForeignKey("alliances.id", ondelete="CASCADE"))
    # Scoresheet items, item -> value.
    data_json: Mapped[str] = mapped_column(Text, default="{}")
    # Flagged teams only: [{team_id, no_show, dq}].
    teams_json: Mapped[str] = mapped_column(Text, default="[]")
    # item -> {device_name, at}; team flags use team:<id>:no_show / team:<id>:dq.
    item_meta_json: Mapped[str] = mapped_column(Text, default="{}")
    # 0 until the first change, then +1 per accepted PATCH.
    version: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)


class SkillsSetTimer(Base):
    """The shared timer of one skills field set; every run that follows the
    set uses it."""

    __tablename__ = "skills_set_timers"
    __table_args__ = (UniqueConstraint("field_set_id", name="uq_skills_set_timer_field_set"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    field_set_id: Mapped[int] = mapped_column(ForeignKey("field_sets.id", ondelete="CASCADE"))
    # Null until first set; readers fall back to the game's first skills type.
    skills_type: Mapped[str | None] = mapped_column(String(50), default=None)
    # ready / running / ended; a running timer past its deadline reads as ended.
    phase: Mapped[str] = mapped_column(String(20), default="ready")
    deadline: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    remaining_seconds_at_pause: Mapped[int | None] = mapped_column(Integer, default=None)


class SkillsRun(Base):
    """The run in progress on one skills field: at most one per field.
    Submit turns it into a skills_attempts row; Discard deletes it."""

    __tablename__ = "skills_runs"
    __table_args__ = (UniqueConstraint("field_id", name="uq_skills_run_field"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    field_id: Mapped[int] = mapped_column(ForeignKey("fields.id", ondelete="CASCADE"))
    # Plain integers: the field already ties the run to its set and session.
    field_set_id: Mapped[int] = mapped_column(Integer)
    session_id: Mapped[int] = mapped_column(Integer)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id", ondelete="CASCADE"))
    skills_type: Mapped[str] = mapped_column(String(50))
    data_json: Mapped[str] = mapped_column(Text, default="{}")
    item_meta_json: Mapped[str] = mapped_column(Text, default="{}")
    version: Mapped[int] = mapped_column(Integer, default=0)
    # True while the run uses the set's timer; the first field-level timer
    # action sets it false and the run's own timer columns take over.
    follows_set: Mapped[bool] = mapped_column(Boolean, default=True)
    phase: Mapped[str] = mapped_column(String(20), default="ready")
    deadline: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
    paused: Mapped[bool] = mapped_column(Boolean, default=False)
    remaining_seconds_at_pause: Mapped[int | None] = mapped_column(Integer, default=None)
    created_by_device: Mapped[str | None] = mapped_column(String(200), default=None)
    created_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)


class ScorerBinding(Base):
    """The field a scorer or referee device follows in one session (optional)."""

    __tablename__ = "scorer_bindings"
    __table_args__ = (UniqueConstraint("session_id", "device_id", name="uq_scorer_binding_session_device"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id", ondelete="CASCADE"))
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id", ondelete="CASCADE"))
    field_id: Mapped[int] = mapped_column(ForeignKey("fields.id", ondelete="CASCADE"))
