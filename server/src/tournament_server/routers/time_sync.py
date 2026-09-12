from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel

from tournament_server.db import utc_now

router = APIRouter(prefix="/api/time-sync", tags=["time-sync"])


class TimeSyncResponse(BaseModel):
    server_time: str


@router.get("", response_model=TimeSyncResponse)
def get_server_time() -> TimeSyncResponse:
    return TimeSyncResponse(server_time=utc_now().isoformat())
