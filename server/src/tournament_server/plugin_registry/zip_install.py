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
from tournament_server.plugin_registry.loader import (
    GAME_PLUGIN_KIND,
    LoadedPlugin,
    PluginKind,
    load_plugin,
)
from tournament_server.plugin_registry.manifest import parse_manifest


def install_plugin_zip(
    zip_bytes: bytes, plugins_root: Path, kind: PluginKind = GAME_PLUGIN_KIND
) -> LoadedPlugin:
    try:
        zf = zipfile.ZipFile(io.BytesIO(zip_bytes))
    except zipfile.BadZipFile as exc:
        raise PluginInstallError(f"not a valid zip file: {exc}") from exc

    with zf:
        try:
            manifest_raw = zf.read("manifest.json")
        except KeyError as exc:
            raise PluginInstallError(
                "zip does not contain a manifest.json at its root"
            ) from exc
        except Exception as exc:
            raise PluginInstallError(
                f"could not read manifest.json from zip: {exc}"
            ) from exc

        try:
            manifest_data = json.loads(manifest_raw)
        except json.JSONDecodeError as exc:
            raise PluginInstallError(f"manifest.json is not valid JSON: {exc}") from exc

        try:
            manifest = parse_manifest(manifest_data)
        except PluginLoadError as exc:
            raise PluginInstallError(str(exc)) from exc

        if manifest.kind != kind.kind:
            raise PluginInstallError(
                f"expected a {kind.kind!r} plugin manifest, got kind={manifest.kind!r}"
            )

        target_dir = plugins_root / kind.folder_name / manifest.name
        if target_dir.exists():
            raise PluginAlreadyExistsError(
                f"a plugin named {manifest.name!r} is already installed"
            )

        target_dir.mkdir(parents=True)
        try:
            zf.extractall(target_dir)
        except Exception as exc:
            shutil.rmtree(target_dir, ignore_errors=True)
            raise PluginInstallError(f"could not extract zip contents: {exc}") from exc

    try:
        return load_plugin(target_dir, kind)
    except PluginLoadError as exc:
        shutil.rmtree(target_dir, ignore_errors=True)
        raise PluginInstallError(f"installed plugin failed to load: {exc}") from exc
