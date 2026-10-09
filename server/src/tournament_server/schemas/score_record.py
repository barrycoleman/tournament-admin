from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict


class TeamFlags(BaseModel):
    model_config = ConfigDict(extra="forbid")

    team_id: int
    no_show: bool = False
    dq: bool = False


class ScoreSubmit(BaseModel):
    # Unknown fields are refused so a client still sending the old
    # alliance-level `no_show`/`dq` gets a 422 instead of losing the flag.
    model_config = ConfigDict(extra="forbid")

    data: dict[str, Any]
    teams: list[TeamFlags] = []
    sitting: bool = False
    force: bool = False


class ScoreRecordRead(BaseModel):
    id: int
    alliance_id: int
    plugin_name: str
    plugin_version: str
    data: dict[str, Any]
    teams: list[TeamFlags]
    sitting: bool
    submitted_by_device: str | None
    submitted_at: dt.datetime
    saved_at: dt.datetime | None
    computed_score: int
