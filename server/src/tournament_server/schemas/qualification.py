from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, StrictInt


class QualificationRow(BaseModel):
    played: int
    teams: int
    suggested: int


class QualificationBlocker(BaseModel):
    code: Literal["no_matches", "in_progress", "ended_unscored", "partially_scored"]
    count: int


class QualificationPreviewRead(BaseModel):
    finalized: bool
    game_model: str
    rows: list[QualificationRow]
    unplayed_matches: int
    blockers: list[QualificationBlocker]


class FinalizeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Played count (string key) -> drops; {} for head-to-head.
    drops: dict[str, StrictInt]
