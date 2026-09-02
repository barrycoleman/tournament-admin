from __future__ import annotations

from pydantic import BaseModel, Field


class TimeBlock(BaseModel):
    start_time: str = Field(pattern=r"^\d{2}:\d{2}$")
    end_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    cycle_time: int | None = Field(default=None, gt=0)


class ScheduleGenerateRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    round_type: str
    target_matches_per_team: int
    scheduler_plugin_name: str
    excluded_team_ids: list[int] = []
    time_blocks: list[TimeBlock] | None = None
    warn_below_multiplier: float = 1.5


class ResolvedTimeBlockRead(BaseModel):
    start_time: str
    end_time: str | None
    cycle_time_seconds: float


class ScheduleGenerateResponse(BaseModel):
    schedule_generation_id: int
    match_count: int
    resolved_time_blocks: list[ResolvedTimeBlockRead]
    cycle_time_warning: str | None
