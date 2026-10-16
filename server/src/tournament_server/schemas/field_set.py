from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict
from pydantic import Field as PydanticField


class FieldSetCreate(BaseModel):
    session_id: int
    name: str
    division_id: int | None = None


class FieldSetUpdate(BaseModel):
    name: str | None = None
    division_id: int | None = None


class FieldSetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    name: str
    division_id: int | None
    queued_match_id: int | None = None
    timeout_deadline: dt.datetime | None = None


class QueuedMatchWrite(BaseModel):
    match_id: int | None


class TimeoutWrite(BaseModel):
    seconds: int = PydanticField(180, ge=10, le=600)
