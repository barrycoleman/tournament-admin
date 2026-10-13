from __future__ import annotations

import uuid

from fastapi import APIRouter
from pydantic import BaseModel

from tournament_server.db import utc_now

router = APIRouter(prefix="/api/time-sync", tags=["time-sync"])

# Fixed for the life of this process. A restore restarts the server from the
# normal app into the normal app, so the admin UI waits for a different id.
BOOT_ID = uuid.uuid4().hex


class TimeSyncResponse(BaseModel):
    server_time: str
    boot_id: str


@router.get("", response_model=TimeSyncResponse)
def get_server_time() -> TimeSyncResponse:
    return TimeSyncResponse(server_time=utc_now().isoformat(), boot_id=BOOT_ID)
