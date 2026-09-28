from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, Field, model_validator


class TimeBlock(BaseModel):
    date: dt.date
    start_time: str = Field(pattern=r"^\d{2}:\d{2}$")
    end_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    cycle_time: int | None = Field(default=None, gt=0)


class SchedulePhase(BaseModel):
    round_type: str
    target_matches_per_team: int


class ScheduleGenerateRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    round_type: str | None = None
    target_matches_per_team: int | None = None
    phases: list[SchedulePhase] | None = None
    scheduler_plugin_name: str
    excluded_team_ids: list[int] = []
    time_blocks: list[TimeBlock] | None = None
    warn_below_multiplier: float = 1.5
    dry_run: bool = False

    @model_validator(mode="after")
    def _check_round_type_xor_phases(self) -> "ScheduleGenerateRequest":
        singular_given = (
            self.round_type is not None or self.target_matches_per_team is not None
        )
        if self.phases is not None:
            if singular_given:
                raise ValueError(
                    "Provide either round_type/target_matches_per_team or "
                    "phases, not both"
                )
            if len(self.phases) < 1:
                raise ValueError("phases must contain at least one entry")
        else:
            if self.round_type is None or self.target_matches_per_team is None:
                raise ValueError(
                    "Provide either round_type and target_matches_per_team, "
                    "or phases"
                )
        return self


class ResolvedTimeBlockRead(BaseModel):
    date: dt.date
    start_time: str
    end_time: str | None
    cycle_time_seconds: float


class PhaseResult(BaseModel):
    round_type: str
    schedule_generation_id: int | None
    match_count: int


class ScheduleGenerateResponse(BaseModel):
    schedule_generation_id: int | None
    match_count: int
    resolved_time_blocks: list[ResolvedTimeBlockRead]
    cycle_time_warning: str | None
    phase_results: list[PhaseResult] | None = None
