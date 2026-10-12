from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, Field


class EventCreate(BaseModel):
    name: str
    password: str = Field(min_length=1)


class EventRename(BaseModel):
    name: str


class EventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    active_session_id: int | None
    game_plugin_name: str | None
    game_plugin_locked: bool = False
    created_at: dt.datetime


class ActiveSessionUpdate(BaseModel):
    session_id: int


class GamePluginSelect(BaseModel):
    name: str


class MatchFormatRead(BaseModel):
    round_types: list[str]
    teams_per_alliance: int
    alliance_count: int
    match_duration_seconds: int
    default_cycle_time_seconds: int | None = None


class WouldReset(BaseModel):
    skills_enabled: bool
    session_attempt_overrides: int
    ranking_settings: bool


class AwardNeedingAttention(BaseModel):
    award_id: int
    session_id: int
    session_label: str
    name: str
    reason: str  # "unavailable" | "unknown_skills_type"


class GamePluginChangePreview(BaseModel):
    would_reset: WouldReset
    awards_needing_attention: list[AwardNeedingAttention]
