from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class RankingConfigurationSet(BaseModel):
    division_id: int | None = None
    mode: str
    count: int
    allow_drop_no_show: bool = False
    allow_drop_dq: bool = False


class RankingConfigurationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    event_id: int
    division_id: int | None
    mode: str
    count: int
    allow_drop_no_show: bool
    allow_drop_dq: bool
