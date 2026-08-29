from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel


class ScoreSubmit(BaseModel):
    data: dict[str, Any]
    no_show: bool = False
    dq: bool = False
    sitting: bool = False
    force: bool = False


class ScoreRecordRead(BaseModel):
    id: int
    alliance_id: int
    plugin_name: str
    plugin_version: str
    data: dict[str, Any]
    no_show: bool
    dq: bool
    sitting: bool
    submitted_by_device: str | None
    submitted_at: dt.datetime
    saved_at: dt.datetime | None
    computed_score: int
