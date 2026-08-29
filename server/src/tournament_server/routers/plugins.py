from __future__ import annotations

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/plugins/games", tags=["plugins"])


@router.get("")
def list_game_plugins(request: Request) -> list[dict[str, str]]:
    registry = request.app.state.game_plugins
    return [
        {"name": p.name, "version": p.version, "display_name": p.display_name}
        for p in registry.values()
    ]
