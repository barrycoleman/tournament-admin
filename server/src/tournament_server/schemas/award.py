from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, Field, StrictInt


class AwardBody(BaseModel):
    """A full award definition (create)."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str | None = None
    kind: str
    scope: str
    division_ids: list[StrictInt] = Field(default_factory=list)
    source: str | None = None
    skills_type: str | None = None
    basis: str | None = None
    placement: StrictInt | None = None


class AwardPatch(BaseModel):
    """Any subset of an award's fields; merged onto the stored award."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    kind: str | None = None
    scope: str | None = None
    division_ids: list[StrictInt] | None = None
    source: str | None = None
    skills_type: str | None = None
    basis: str | None = None
    placement: StrictInt | None = None


class AwardOrderBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    award_ids: list[StrictInt]


class AwardCopyBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    from_session_id: StrictInt


class WinnerTeamRead(BaseModel):
    team_id: int
    number: str
    name: str
    organization: str | None


class AwardSlotRead(BaseModel):
    division_id: int | None
    division_name: str | None
    status: str
    winners: list[WinnerTeamRead]
    override_reason: str | None
    # "unknown_skills_type", "skills_disabled", or null.
    note: str | None
    # Stored winners whose team is no longer in this slot's division.
    moved_team_ids: list[int]


class AwardRead(BaseModel):
    id: int
    session_id: int
    position: int
    name: str
    description: str | None
    kind: str
    scope: str
    division_ids: list[int]
    source: str | None
    skills_type: str | None
    basis: str | None
    placement: int | None
    slots: list[AwardSlotRead]


class SessionAwardsRead(BaseModel):
    awards_finalized_at: dt.datetime | None
    awards: list[AwardRead]


class WinnerBody(BaseModel):
    """A judged award takes team_id; a performance override takes team_ids and reason."""

    model_config = ConfigDict(extra="forbid")

    team_id: StrictInt | None = None
    team_ids: list[StrictInt] | None = None
    reason: str | None = None


class TeamAwardEntryRead(BaseModel):
    award_id: int
    award_name: str
    kind: str
    session_id: int
    session_label: str


class TeamAwardHistoryRead(BaseModel):
    team_id: int
    awards: list[TeamAwardEntryRead]
