from __future__ import annotations

import datetime as dt
from typing import Any

from pydantic import BaseModel, ConfigDict


class DisplayRef(BaseModel):
    device_id: int
    name: str
    online: bool


class DisplayGroupFields(BaseModel):
    id: int
    session_id: int
    kind: str
    name: str
    field_set_id: int | None
    field_id: int | None
    division_id: int | None
    screen: str | None
    screen_settings: dict[str, Any]
    rotation: list[dict[str, Any]] | None
    play_sounds: bool


class DisplayGroupRead(DisplayGroupFields):
    displays: list[DisplayRef]


class DisplaysRead(BaseModel):
    session_id: int
    groups: list[DisplayGroupRead]
    unassigned: list[DisplayRef]
    has_setup: bool


class PitGroupCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: int
    name: str
    division_id: int | None = None


class DisplayGroupUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    screen: str | None = None
    screen_settings: dict[str, Any] | None = None
    rotation: list[dict[str, Any]] | None = None
    name: str | None = None
    division_id: int | None = None
    play_sounds: bool | None = None


class AssignmentWrite(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: int
    device_id: int
    group_id: int | None


class FieldSetLive(BaseModel):
    queued_match_id: int | None
    timeout_deadline: dt.datetime | None


class DisplayMeGroup(DisplayGroupFields):
    field_set: FieldSetLive | None


class DisplayDevice(BaseModel):
    id: int
    name: str


class DisplayMe(BaseModel):
    device: DisplayDevice
    session_id: int | None
    group: DisplayMeGroup | None


class CopyDisplaysRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_session_id: int


class UnplacedDisplay(BaseModel):
    device_id: int
    device_name: str
    source_group_name: str


class CopyDisplaysResult(BaseModel):
    unplaced: list[UnplacedDisplay]
