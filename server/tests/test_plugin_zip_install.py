import io
import zipfile
from pathlib import Path

import pytest

from plugin_helpers import zip_fixture_plugin
from tournament_server.plugin_registry.errors import (
    PluginAlreadyExistsError,
    PluginInstallError,
)
from tournament_server.plugin_registry.zip_install import install_plugin_zip

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)


def test_install_plugin_zip_extracts_and_loads(tmp_path):
    zip_bytes = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)
    plugins_root = tmp_path / "plugins"

    plugin = install_plugin_zip(zip_bytes, plugins_root)

    assert plugin.name == "example-game"
    assert (plugins_root / "games" / "example-game" / "manifest.json").exists()


def test_install_plugin_zip_refuses_duplicate_name(tmp_path):
    zip_bytes = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)
    plugins_root = tmp_path / "plugins"
    install_plugin_zip(zip_bytes, plugins_root)

    with pytest.raises(PluginAlreadyExistsError):
        install_plugin_zip(zip_bytes, plugins_root)


def test_install_plugin_zip_rejects_missing_manifest(tmp_path):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as zf:
        zf.writestr("plugin.py", "# no manifest here")

    with pytest.raises(PluginInstallError):
        install_plugin_zip(buffer.getvalue(), tmp_path / "plugins")


def test_install_plugin_zip_rejects_bad_zip_bytes(tmp_path):
    with pytest.raises(PluginInstallError):
        install_plugin_zip(b"not a zip", tmp_path / "plugins")


def test_install_plugin_zip_rolls_back_on_load_failure(tmp_path):
    zip_bytes = zip_fixture_plugin(FIXTURE_BROKEN_PLUGIN)
    plugins_root = tmp_path / "plugins"

    with pytest.raises(PluginInstallError):
        install_plugin_zip(zip_bytes, plugins_root)

    assert not (plugins_root / "games" / "broken-plugin").exists()


def test_install_plugin_zip_cleans_up_on_extraction_failure(tmp_path):
    good_zip = zip_fixture_plugin(FIXTURE_EXAMPLE_PLUGIN)
    corrupted = bytearray(good_zip)
    mid = len(corrupted) // 2
    for i in range(mid, mid + 20):
        corrupted[i] ^= 0xFF

    plugins_root = tmp_path / "plugins"
    with pytest.raises(PluginInstallError):
        install_plugin_zip(bytes(corrupted), plugins_root)

    assert not (plugins_root / "games" / "example-game").exists()
