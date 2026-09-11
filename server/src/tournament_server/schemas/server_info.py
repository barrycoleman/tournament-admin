from __future__ import annotations

from pydantic import BaseModel


class ServerInfoResponse(BaseModel):
    port: int
    addresses: list[str]
