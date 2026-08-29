from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict


class EventCreate(BaseModel):
    name: str


class EventRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    active_session_id: int | None
    game_plugin_name: str | None
    created_at: dt.datetime


class ActiveSessionUpdate(BaseModel):
    session_id: int


class GamePluginSelect(BaseModel):
    name: str
