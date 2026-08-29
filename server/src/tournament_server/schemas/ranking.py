from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class RankingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    session_id: int
    division_id: int | None
    team_id: int
    win_points: int
    strength_of_schedule: float
    rank: int
