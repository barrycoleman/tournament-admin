from __future__ import annotations

import datetime as dt

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
    alliances: list[AllianceRead]
