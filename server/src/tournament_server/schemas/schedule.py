from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, Field


class ScheduleRound(BaseModel):
    round_type: str
    target_matches_per_team: int = Field(ge=1)
    cycle_time_seconds: int = Field(gt=0)


class ScheduleGenerateRequest(BaseModel):
    # Forbid unknown keys so a client still sending the old time_blocks/
    # phases shape fails loudly instead of being half-understood.
    model_config = ConfigDict(extra="forbid")

    session_id: int
    division_id: int | None = None
    scheduler_plugin_name: str
    rounds: list[ScheduleRound] = Field(min_length=1)
    excluded_team_ids: list[int] = []
    dry_run: bool = False


class RoundResult(BaseModel):
    round_type: str
    schedule_generation_id: int | None
    match_count: int
    slot_count: int
    first_start: dt.datetime | None
    # Null when the round doesn't fully fit in the playing windows.
    last_end: dt.datetime | None


class ScheduleOverflow(BaseModel):
    unplaced_slot_count: int
    unplaced_match_count: int
    over_by_seconds: int
    suggested_cycle_time_seconds: int | None
    suggested_last_window_end: str | None


class ScheduleGenerateResponse(BaseModel):
    fits: bool
    rounds: list[RoundResult]
    overflow: ScheduleOverflow | None


class ScheduledRoundRead(BaseModel):
    round_type: str
    target_matches_per_team: int | None
    cycle_time_seconds: int | None
    match_count: int
    scored_count: int
    first_start: dt.datetime | None
    last_end: dt.datetime | None
    locked: bool
    outside_playing_windows: bool


class ScheduleRoundsRead(BaseModel):
    rounds: list[ScheduledRoundRead]
    session_last_cycle_time_seconds: int | None
