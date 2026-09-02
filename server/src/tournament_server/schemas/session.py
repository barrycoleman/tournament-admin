from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict


class SessionCreate(BaseModel):
    label: str
    session_date: dt.date | None = None
    timezone: str | None = None


class SessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    label: str
    session_date: dt.date | None
    timezone: str | None
