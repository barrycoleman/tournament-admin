from __future__ import annotations

from fastapi import APIRouter, Depends, Request

from tournament_server.auth import require_admin
from tournament_server.network import enumerate_lan_addresses
from tournament_server.schemas.server_info import ServerInfoResponse

router = APIRouter(prefix="/api/server-info", tags=["server-info"])


@router.get("", response_model=ServerInfoResponse)
def get_server_info(
    request: Request,
    _role: str = Depends(require_admin),
) -> ServerInfoResponse:
    return ServerInfoResponse(
        port=request.app.state.port,
        addresses=enumerate_lan_addresses(),
    )
