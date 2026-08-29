from __future__ import annotations

import sys
from pathlib import Path

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.loader import LoadedGamePlugin, load_game_plugin


def discover_game_plugins(plugins_root: Path) -> dict[str, LoadedGamePlugin]:
    games_root = plugins_root / "games"
    registry: dict[str, LoadedGamePlugin] = {}
    if not games_root.is_dir():
        return registry

    for entry in sorted(games_root.iterdir()):
        if not entry.is_dir():
            continue
        try:
            plugin = load_game_plugin(entry)
        except PluginLoadError as exc:
            print(f"warning: skipping plugin folder {entry}: {exc}", file=sys.stderr)
            continue
        registry[plugin.name] = plugin
    return registry
