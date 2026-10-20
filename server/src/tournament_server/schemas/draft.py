from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict

from tournament_server.schemas.score_record import TeamFlags


class ItemMeta(BaseModel):
    device_name: str
    at: dt.datetime


class DraftPatch(BaseModel):
    """Only the changed items. `teams` replaces the flags of each listed team."""

    model_config = ConfigDict(extra="forbid")

    changes: dict[str, Any] = {}
    teams: list[TeamFlags] | None = None


class AllianceDraftRead(BaseModel):
    alliance_id: int
    data: dict[str, Any]
    teams: list[TeamFlags]
    item_meta: dict[str, ItemMeta]
    version: int
    score: int


class MatchDraftRead(BaseModel):
    match_id: int
    submitted: bool
    alliances: list[AllianceDraftRead]


class SubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    force: bool = False
