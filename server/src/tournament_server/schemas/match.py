from __future__ import annotations

import datetime as dt
from typing import Literal

from pydantic import BaseModel


class AllianceCreate(BaseModel):
    station: str
    team_ids: list[int]


class AllianceRead(BaseModel):
    id: int
    station: str
    team_ids: list[int]


class MatchCreate(BaseModel):
    session_id: int | None = None
    division_id: int | None = None
    round_type: str
    match_number: int
    field_id: int | None = None
    scheduled_time: dt.datetime | None = None
    alliances: list[AllianceCreate]


class MatchResetRequest(BaseModel):
    # Literal, not a bare str: the reset endpoint's if/elif chain treats
    # anything that isn't exactly "section" as a full reset, so a typo like
    # "Section" would silently perform the *more* destructive action. This
    # turns that into an automatic 422 instead.
    scope: Literal["section", "full"]


class MatchRead(BaseModel):
    id: int
    session_id: int
    division_id: int | None
    round_type: str
    match_number: int
    field_id: int | None
    time_slot: int | None
    scheduled_time: dt.datetime | None
    status: str
    phase: str
    phase_deadline: dt.datetime | None
    paused: bool
    remaining_seconds_at_pause: float | None
    alliances: list[AllianceRead]
