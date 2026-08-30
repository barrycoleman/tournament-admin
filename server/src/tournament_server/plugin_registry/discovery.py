from __future__ import annotations

import sys
from pathlib import Path

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.loader import (
    GAME_PLUGIN_KIND,
    SCHEDULER_PLUGIN_KIND,
    LoadedPlugin,
    PluginKind,
    load_plugin,
)


def discover_plugins(plugins_root: Path, kind: PluginKind) -> dict[str, LoadedPlugin]:
    kind_root = plugins_root / kind.folder_name
    registry: dict[str, LoadedPlugin] = {}
    if not kind_root.is_dir():
        return registry

    for entry in sorted(kind_root.iterdir()):
        if not entry.is_dir():
            continue
        try:
            plugin = load_plugin(entry, kind)
        except PluginLoadError as exc:
            print(f"warning: skipping plugin folder {entry}: {exc}", file=sys.stderr)
            continue
        registry[plugin.name] = plugin
    return registry


def discover_game_plugins(plugins_root: Path) -> dict[str, LoadedPlugin]:
    return discover_plugins(plugins_root, GAME_PLUGIN_KIND)


def discover_scheduler_plugins(plugins_root: Path) -> dict[str, LoadedPlugin]:
    return discover_plugins(plugins_root, SCHEDULER_PLUGIN_KIND)
