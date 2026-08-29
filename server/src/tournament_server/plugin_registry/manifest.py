from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from tournament_server.plugin_registry.errors import PluginLoadError

_VALID_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]*$")


@dataclass
class PluginManifest:
    name: str
    version: str
    kind: str
    display_name: str


def parse_manifest(data: dict[str, Any]) -> PluginManifest:
    if not isinstance(data, dict):
        raise PluginLoadError(
            f"manifest must be a JSON object, got {type(data).__name__}"
        )
    name = data.get("name")
    if not isinstance(name, str) or not _VALID_NAME_RE.match(name):
        raise PluginLoadError(
            "manifest 'name' must be a non-empty string of letters, "
            f"numbers, hyphens, or underscores (got {name!r})"
        )
    version = data.get("version")
    if not isinstance(version, str) or not version:
        raise PluginLoadError(
            f"manifest 'version' must be a non-empty string (got {version!r})"
        )
    kind = data.get("kind")
    if not isinstance(kind, str) or not kind:
        raise PluginLoadError(
            f"manifest 'kind' must be a non-empty string (got {kind!r})"
        )
    display_name = data.get("display_name")
    if not isinstance(display_name, str) or not display_name:
        raise PluginLoadError(
            f"manifest 'display_name' must be a non-empty string "
            f"(got {display_name!r})"
        )
    return PluginManifest(
        name=name, version=version, kind=kind, display_name=display_name
    )


def load_manifest(plugin_dir: Path) -> PluginManifest:
    manifest_path = plugin_dir / "manifest.json"
    if not manifest_path.exists():
        raise PluginLoadError(f"{plugin_dir} has no manifest.json")
    try:
        data = json.loads(manifest_path.read_text())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PluginLoadError(
            f"{manifest_path} could not be read as JSON: {exc}"
        ) from exc
    return parse_manifest(data)
