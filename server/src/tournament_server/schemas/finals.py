from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, model_validator


class FinalsStartRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    bracket_size: int | None = None
    team_count: int | None = None
    alliance_selection: Literal["captain_pick", "seed_pairing"] | None = None
    field_ids: list[int] | None = None
    wins_to_advance: int | list[int] | None = None
    field_set_id: int | None = None

    @model_validator(mode="after")
    def _exactly_one_size(self) -> "FinalsStartRequest":
        if (self.bracket_size is None) == (self.team_count is None):
            raise ValueError("give exactly one of team_count or bracket_size")
        return self


class BracketMatchupRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    round_number: int
    position: int
    matchup_number: int | None
    alliance_a_id: int | None
    alliance_b_id: int | None
    winner_alliance_id: int | None


class BracketAllianceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    seed: int
    team_ids: list[int]
    unavailable: bool


class FinalsRunRead(BaseModel):
    match_id: int
    bracket_alliance_id: int | None
    status: str
    score: int | None


class FinalsResultRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    bracket_alliance_id: int
    score: int
    rank: int


class SelectionStepRead(BaseModel):
    kind: Literal["accept", "decline"]
    captain_team_id: int
    team_id: int


class SelectionRead(BaseModel):
    """Partner picking state, present while a bracket is selecting alliances."""

    captain_team_id: int | None
    invitable_team_ids: list[int]
    declined_team_ids: list[int]
    pending_team_id: int | None
    alliances_formed: int
    alliances_target: int
    last_step: SelectionStepRead | None


class FinalsBracketRead(BaseModel):
    id: int
    session_id: int
    division_id: int | None
    field_set_id: int
    format: str
    bracket_size: int
    alliance_selection: str
    field_ids: list[int] | None
    wins_to_advance: list[int]
    status: str
    alliances: list[BracketAllianceRead]
    runs: list[FinalsRunRead]
    results: list[FinalsResultRead]
    matchups: list[BracketMatchupRead]
    selection: SelectionRead | None = None


class SelectionTeamRequest(BaseModel):
    team_id: int


class FinalsExclusionCreate(BaseModel):
    session_id: int
    division_id: int | None = None
    team_id: int
    reason: Literal["disqualified", "left_early"]


class FinalsExclusionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    division_id: int | None
    team_id: int
    reason: str
