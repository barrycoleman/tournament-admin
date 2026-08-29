from pathlib import Path

import pytest

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.manifest import load_manifest, parse_manifest

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)


def test_load_manifest_success():
    manifest = load_manifest(FIXTURE_EXAMPLE_PLUGIN)
    assert manifest.name == "example-game"
    assert manifest.version == "1.0.0"
    assert manifest.kind == "game"
    assert manifest.display_name == "Example Scoring Game"


def test_load_manifest_missing_file_raises(tmp_path):
    with pytest.raises(PluginLoadError, match="manifest.json"):
        load_manifest(tmp_path)


def test_parse_manifest_rejects_unsafe_name():
    with pytest.raises(PluginLoadError, match="name"):
        parse_manifest(
            {
                "name": "../../etc",
                "version": "1.0.0",
                "kind": "game",
                "display_name": "Bad",
            }
        )


def test_parse_manifest_rejects_missing_version():
    with pytest.raises(PluginLoadError, match="version"):
        parse_manifest({"name": "ok-name", "kind": "game", "display_name": "OK"})


def test_parse_manifest_rejects_non_dict():
    with pytest.raises(PluginLoadError, match="JSON object"):
        parse_manifest([1, 2, 3])
