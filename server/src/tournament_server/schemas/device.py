from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class DeviceRegisterResponse(BaseModel):
    device_token: str
    friendly_name: str
    status: str


class DeviceRead(BaseModel):
    id: int
    friendly_name: str
    status: str
    registered_at: dt.datetime
    admitted_at: dt.datetime | None
    admitted_by: str | None
    last_seen_at: dt.datetime
