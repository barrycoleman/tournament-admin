from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict


class SessionCreate(BaseModel):
    label: str
    session_date: dt.date | None = None
    timezone: str | None = None


class SessionUpdate(BaseModel):
    label: str | None = None
    session_date: dt.date | None = None
    timezone: str | None = None


class SessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    label: str
    session_date: dt.date | None
    timezone: str | None
    # Whether any match in the session has a score; a scored session can't
    # be deleted.
    has_scored_matches: bool = False
    # When qualification was finalized, and each played count's drops; both
    # null while qualification is open.
    qualification_finalized_at: dt.datetime | None = None
    qualification_drops: dict[str, int] | None = None


class CopyFieldsRequest(BaseModel):
    source_session_id: int
