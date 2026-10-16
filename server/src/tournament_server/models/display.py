from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, Boolean, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base


class DisplayGroup(Base):
    """Paired displays that show the same thing (see the display groups
    design). An audience group belongs to a field set, a field group to a
    field, and a pit group is made by an admin. `screen` is null for field
    groups, which always run the field display."""

    __tablename__ = "display_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    kind: Mapped[str] = mapped_column(String(20))
    field_set_id: Mapped[int | None] = mapped_column(ForeignKey("field_sets.id"), default=None)
    field_id: Mapped[int | None] = mapped_column(ForeignKey("fields.id"), default=None)
    name: Mapped[str | None] = mapped_column(String(100), default=None)
    division_id: Mapped[int | None] = mapped_column(ForeignKey("divisions.id"), default=None)
    screen: Mapped[str | None] = mapped_column(String(50), default=None)
    screen_settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    rotation: Mapped[list[dict[str, Any]] | None] = mapped_column(JSON, default=None)
    play_sounds: Mapped[bool] = mapped_column(Boolean, default=False)


class DisplayAssignment(Base):
    """The group a display follows in one session."""

    __tablename__ = "display_assignments"
    __table_args__ = (
        UniqueConstraint("session_id", "device_id", name="uq_display_assignment_session_device"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    device_id: Mapped[int] = mapped_column(ForeignKey("devices.id"))
    group_id: Mapped[int] = mapped_column(ForeignKey("display_groups.id"))
