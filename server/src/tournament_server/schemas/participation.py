from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ParticipationCreate(BaseModel):
    team_id: int
    checked_in: bool = False


class ParticipationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    team_id: int
    checked_in: bool
