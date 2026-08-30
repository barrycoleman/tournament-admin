from __future__ import annotations

from pydantic import BaseModel


class ScheduleGenerateRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    round_type: str
    target_matches_per_team: int
    scheduler_plugin_name: str
    excluded_team_ids: list[int] = []


class ScheduleGenerateResponse(BaseModel):
    schedule_generation_id: int
    match_count: int
