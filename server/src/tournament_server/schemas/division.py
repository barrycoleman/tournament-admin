from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class DivisionCreate(BaseModel):
    name: str


class DivisionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    name: str
