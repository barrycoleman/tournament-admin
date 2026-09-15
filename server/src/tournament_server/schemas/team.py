from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class TeamCreate(BaseModel):
    number: str
    name: str
    robot_name: str | None = None
    organization: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    division_id: int | None = None


class TeamUpdate(BaseModel):
    number: str | None = None
    name: str | None = None
    robot_name: str | None = None
    organization: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    division_id: int | None = None


class TeamRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    division_id: int | None
    number: str
    name: str
    robot_name: str | None
    organization: str | None
    city: str | None
    state: str | None
    country: str | None
    tiebreaker_seed: int


class TeamBulkRow(BaseModel):
    number: str
    name: str
    robot_name: str | None = None
    organization: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    division: str | None = None
    assign_random_division: bool = False


class TeamBulkRequest(BaseModel):
    rows: list[TeamBulkRow]


class TeamBulkRowResult(BaseModel):
    row_index: int
    status: Literal["created", "updated", "error"]
    team: TeamRead | None = None
    error: str | None = None


class TeamBulkResponse(BaseModel):
    results: list[TeamBulkRowResult]
