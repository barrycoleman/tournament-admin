from __future__ import annotations

import datetime as dt

from sqlalchemy import ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime


class FieldSet(Base):
    __tablename__ = "field_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("sessions.id"))
    name: Mapped[str] = mapped_column(String(200))
    division_id: Mapped[int | None] = mapped_column(
        ForeignKey("divisions.id"), default=None
    )
    # The match an admin queued out of schedule order (display groups design
    # §6.1). A plain integer like Event.active_session_id, not a foreign key:
    # matches already point at field sets through fields, and SQLite can't
    # add the reverse key afterwards. services/deletion.delete_matches clears it.
    queued_match_id: Mapped[int | None] = mapped_column(Integer, default=None)
    # A running time-out ends here; an expired deadline is simply ignored.
    timeout_deadline: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
