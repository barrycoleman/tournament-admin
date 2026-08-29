from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, UploadFile

from tournament_server.plugin_registry.errors import (
    PluginAlreadyExistsError,
    PluginInstallError,
)
from tournament_server.plugin_registry.zip_install import install_plugin_zip

router = APIRouter(prefix="/api/plugins/games", tags=["plugins"])


@router.get("")
def list_game_plugins(request: Request) -> list[dict[str, str]]:
    registry = request.app.state.game_plugins
    return [
        {"name": p.name, "version": p.version, "display_name": p.display_name}
        for p in registry.values()
    ]


@router.post("", status_code=201)
def upload_game_plugin(request: Request, file: UploadFile) -> dict[str, str]:
    zip_bytes = file.file.read()
    plugins_root = request.app.state.plugins_root
    try:
        plugin = install_plugin_zip(zip_bytes, plugins_root)
    except PluginAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except PluginInstallError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    request.app.state.game_plugins[plugin.name] = plugin
    return {
        "name": plugin.name,
        "version": plugin.version,
        "display_name": plugin.display_name,
    }
