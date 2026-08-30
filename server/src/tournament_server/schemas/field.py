from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class FieldCreate(BaseModel):
    session_id: int
    name: str
    field_set_id: int | None = None


class FieldRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    field_set_id: int
    name: str
