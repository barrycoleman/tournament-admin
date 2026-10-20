from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict


class SessionCreate(BaseModel):
    label: str
    session_date: dt.date | None = None
    timezone: str | None = None
    live_scores_qualification: bool = True
    live_scores_finals: bool = False


class SessionUpdate(BaseModel):
    label: str | None = None
    session_date: dt.date | None = None
    timezone: str | None = None
    live_scores_qualification: bool | None = None
    live_scores_finals: bool | None = None


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
    # Whether displays get live totals: practice, qualification and skills
    # follow the first; finals the second (live scoring design §7).
    live_scores_qualification: bool = True
    live_scores_finals: bool = False


class CopyFieldsRequest(BaseModel):
    source_session_id: int
