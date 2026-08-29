from __future__ import annotations

import io
import json
import shutil
import zipfile
from pathlib import Path

from tournament_server.plugin_registry.errors import (
    PluginAlreadyExistsError,
    PluginInstallError,
    PluginLoadError,
)
from tournament_server.plugin_registry.loader import LoadedGamePlugin, load_game_plugin
from tournament_server.plugin_registry.manifest import parse_manifest


def install_plugin_zip(zip_bytes: bytes, plugins_root: Path) -> LoadedGamePlugin:
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise PluginInstallError(f"not a valid zip file: {exc}")

    with zf:
        try:
            manifest_raw = zf.read("manifest.json")
        except KeyError:
            raise PluginInstallError(
                "zip does not contain a manifest.json at its root"
            )
        try:
            manifest_data = json.loads(manifest_raw)
        except json.JSONDecodeError as exc:
            raise PluginInstallError(f"manifest.json is not valid JSON: {exc}")

        try:
            manifest = parse_manifest(manifest_data)
        except PluginLoadError as exc:
            raise PluginInstallError(str(exc))

        if manifest.kind != "game":
            raise PluginInstallError(
                f"expected a 'game' plugin manifest, got kind={manifest.kind!r}"
            )

        target_dir = plugins_root / "games" / manifest.name
        if target_dir.exists():
            raise PluginAlreadyExistsError(
                f"a plugin named {manifest.name!r} is already installed"
            )

        target_dir.mkdir(parents=True)
        zf.extractall(target_dir)

    try:
        return load_game_plugin(target_dir)
    except PluginLoadError as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise PluginInstallError(f"installed plugin failed to load: {exc}")
