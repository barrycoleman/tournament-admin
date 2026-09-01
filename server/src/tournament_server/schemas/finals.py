from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FinalsStartRequest(BaseModel):
    session_id: int
    division_id: int | None = None
    bracket_size: int
    wins_to_advance: int | list[int] | None = None
    field_set_id: int | None = None


class BracketMatchupRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    round_number: int
    position: int
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


class FinalsBracketRead(BaseModel):
    id: int
    session_id: int
    division_id: int | None
    field_set_id: int
    format: str
    bracket_size: int
    wins_to_advance: list[int]
    status: str
    alliances: list[BracketAllianceRead]
    runs: list[FinalsRunRead]
    results: list[FinalsResultRead]
    matchups: list[BracketMatchupRead]


class FinalsPickRequest(BaseModel):
    captain_bracket_alliance_id: int
    partner_team_id: int
