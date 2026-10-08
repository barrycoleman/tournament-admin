from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt


class SkillsTypeRead(BaseModel):
    key: str
    label: str


class SkillsSettingsRead(BaseModel):
    enabled: bool
    # Every plugin type, with 3 filled in where unset.
    attempts: dict[str, int]
    types: list[SkillsTypeRead]


class SkillsSettingsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: StrictBool
    attempts: dict[str, StrictInt] = Field(default_factory=dict)


class SessionSkillsTypeRead(SkillsTypeRead):
    allowed: int


class SessionSkillsRead(BaseModel):
    types: list[SessionSkillsTypeRead]
    override: dict[str, int] | None


class SessionSkillsBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # null (or {}) clears the override.
    attempts: dict[str, StrictInt] | None


class SkillsAttemptCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    team_id: StrictInt
    skills_type: str
    data: dict[str, Any]


class SkillsAttemptUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: dict[str, Any]


class SkillsAttemptRead(BaseModel):
    id: int
    team_id: int
    skills_type: str
    # 1, 2, 3, ... per team and type in this session, by (recorded_at, id).
    number: int
    score: int
    data: dict[str, Any]
    recorded_at: dt.datetime
    updated_at: dt.datetime


class SkillsRankingRowRead(BaseModel):
    rank: int
    team_id: int
    score: int
    # Best first; for Overall, each type's list in plugin order.
    attempts: list[int]
    session_id: int
