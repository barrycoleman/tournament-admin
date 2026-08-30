from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FieldSetCreate(BaseModel):
    session_id: int
    name: str


class FieldSetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    name: str
