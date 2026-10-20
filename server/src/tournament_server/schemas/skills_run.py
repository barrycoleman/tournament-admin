"""Skills runs, skills set timers and the skills set view (live scoring spec §6)."""
from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt

from tournament_server.schemas.draft import ItemMeta


class SkillsRunCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    team_id: StrictInt
    # Defaults to the set's type; another type needs follows_set false.
    skills_type: str | None = None
    follows_set: StrictBool = True


class SkillsRunPatch(BaseModel):
    """Only the changed items; a skills run has no team flags."""

    model_config = ConfigDict(extra="forbid")

    changes: dict[str, Any] = Field(default_factory=dict)


class SkillsRunRead(BaseModel):
    id: int
    field_id: int
    field_set_id: int
    team_id: int
    team_number: str
    team_name: str
    skills_type: str
    data: dict[str, Any]
    item_meta: dict[str, ItemMeta]
    version: int
    # The plugin's score for the sheet so far; 0 while it can't be scored.
    score: int
    follows_set: bool
    # The timer this run is on (the set's while it follows the set), as it reads now.
    phase: str
    deadline: dt.datetime | None
    paused: bool
    remaining_seconds: int | None


class SkillsSetTimerRead(BaseModel):
    field_set_id: int
    skills_type: str | None
    phase: str
    deadline: dt.datetime | None
    paused: bool
    remaining_seconds: int | None
    run_seconds: int | None


class SkillsFieldRead(BaseModel):
    field_id: int
    name: str
    run: SkillsRunRead | None


class SkillsSetRead(BaseModel):
    timer: SkillsSetTimerRead
    fields: list[SkillsFieldRead]


class SkillsTypeWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    skills_type: str
