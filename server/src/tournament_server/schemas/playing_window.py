from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, Field

CLOCK_PATTERN = r"^([01]\d|2[0-3]):[0-5]\d$"


class PlayingWindowIn(BaseModel):
    date: dt.date
    start_time: str = Field(pattern=CLOCK_PATTERN)
    end_time: str = Field(pattern=CLOCK_PATTERN)


class PlayingWindowsReplace(BaseModel):
    windows: list[PlayingWindowIn]


class PlayingWindowRead(BaseModel):
    date: dt.date
    start_time: str
    end_time: str
    # Null only when the session has no timezone to resolve them against.
    start_utc: dt.datetime | None
    end_utc: dt.datetime | None
