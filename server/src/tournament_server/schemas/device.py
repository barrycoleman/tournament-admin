from __future__ import annotations

import datetime as dt

from pydantic import BaseModel


class DeviceRead(BaseModel):
    id: int
    name: str
    role: str
    status: str
    paired_at: dt.datetime
    paired_by: str
    last_seen_at: dt.datetime
    disabled_at: dt.datetime | None


class DeviceSelf(BaseModel):
    id: int
    name: str
    role: str
    status: str


class PairRequest(BaseModel):
    code: str
    role: str
    name: str


class PairingCodeRead(BaseModel):
    id: str
    code: str
    poll_key: str
    expires_at: dt.datetime
    expires_in: int


class PairingCodeCheck(BaseModel):
    code: str
    suggested_name: str
    expires_at: dt.datetime


class PairingPollRead(BaseModel):
    status: str
    device_token: str | None = None
