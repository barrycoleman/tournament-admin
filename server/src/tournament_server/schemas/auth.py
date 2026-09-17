from __future__ import annotations

import datetime as dt

from pydantic import BaseModel, ConfigDict, Field


class LoginRequest(BaseModel):
    role: str
    password: str
    label: str | None = None


class RefreshRequest(BaseModel):
    refresh_token: str


class LogoutRequest(BaseModel):
    refresh_token: str


class PasswordChangeRequest(BaseModel):
    password: str = Field(min_length=1)


class RolePasswordRead(BaseModel):
    password: str | None


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    expires_in: int


class AuthSessionRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    role: str
    issued_at: dt.datetime
    label: str | None
