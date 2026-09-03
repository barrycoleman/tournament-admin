from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FieldSetCreate(BaseModel):
    session_id: int
    name: str
    division_id: int | None = None


class FieldSetRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    session_id: int
    name: str
    division_id: int | None
