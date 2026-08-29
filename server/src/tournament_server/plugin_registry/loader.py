from __future__ import annotations

import importlib.util
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.manifest import load_manifest

REQUIRED_GAME_PLUGIN_FUNCTIONS = (
    "match_format",
    "scoresheet_schema",
    "calculate_score",
    "validate",
    "rank_teams",
    "skills_scoresheet_schema",
    "calculate_skills_score",
)


@dataclass
class LoadedGamePlugin:
    name: str
    version: str
    display_name: str
    folder: Path
    module: ModuleType


def _import_plugin_module(plugin_dir: Path, module_key: str) -> ModuleType:
    module_path = plugin_dir / "plugin.py"
    if not module_path.exists():
        raise PluginLoadError(f"{plugin_dir} has no plugin.py")
    spec = importlib.util.spec_from_file_location(module_key, module_path)
    if spec is None or spec.loader is None:
        raise PluginLoadError(f"could not load plugin module at {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_key] = module
    try:
        spec.loader.exec_module(module)
    except BaseException as exc:
        del sys.modules[module_key]
        raise PluginLoadError(f"error executing {module_path}: {exc}") from exc
    return module


def _check_required_functions(module: ModuleType, module_key: str) -> None:
    missing = [
        name
        for name in REQUIRED_GAME_PLUGIN_FUNCTIONS
        if not callable(getattr(module, name, None))
    ]
    if missing:
        sys.modules.pop(module_key, None)
        raise PluginLoadError(
            f"plugin module is missing required functions: {', '.join(missing)}"
        )


def load_game_plugin(plugin_dir: Path) -> LoadedGamePlugin:
    manifest = load_manifest(plugin_dir)
    if manifest.kind != "game":
        raise PluginLoadError(
            f"{plugin_dir} declares kind={manifest.kind!r}, expected 'game'"
        )
    module_key = f"tournament_server_plugin_{manifest.name}"
    module = _import_plugin_module(plugin_dir, module_key)
    _check_required_functions(module, module_key)
    return LoadedGamePlugin(
        name=manifest.name,
        version=manifest.version,
        display_name=manifest.display_name,
        folder=plugin_dir,
        module=module,
    )
