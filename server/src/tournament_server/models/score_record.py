from __future__ import annotations

import datetime as dt

from sqlalchemy import Boolean, ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tournament_server.db import Base, UTCDateTime, utc_now


class ScoreRecord(Base):
    __tablename__ = "score_records"
    __table_args__ = (
        UniqueConstraint("alliance_id", name="uq_score_record_alliance"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    alliance_id: Mapped[int] = mapped_column(ForeignKey("alliances.id"))
    plugin_name: Mapped[str] = mapped_column(String(200))
    plugin_version: Mapped[str] = mapped_column(String(50))
    data_json: Mapped[str] = mapped_column(Text)
    no_show: Mapped[bool] = mapped_column(Boolean, default=False)
    dq: Mapped[bool] = mapped_column(Boolean, default=False)
    sitting: Mapped[bool] = mapped_column(Boolean, default=False)
    submitted_by_device: Mapped[str | None] = mapped_column(String(200), default=None)
    submitted_at: Mapped[dt.datetime] = mapped_column(UTCDateTime, default=utc_now)
    saved_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime, default=None)
