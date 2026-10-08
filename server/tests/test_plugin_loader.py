import json
from pathlib import Path

import pytest

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.loader import load_game_plugin

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)


def test_load_game_plugin_success():
    plugin = load_game_plugin(FIXTURE_EXAMPLE_PLUGIN)
    assert plugin.name == "example-game"
    assert plugin.version == "1.0.0"
    assert plugin.display_name == "Example Scoring Game"
    assert callable(plugin.module.calculate_score)


def test_load_game_plugin_computes_real_score():
    plugin = load_game_plugin(FIXTURE_EXAMPLE_PLUGIN)
    score = plugin.module.calculate_score(
        {"high_balls": 2, "low_balls": 3, "auto_winner": "red"}
    )
    assert score == 2 * 3 + 3 * 1 + 10


def test_load_game_plugin_missing_function_raises():
    with pytest.raises(PluginLoadError, match="validate"):
        load_game_plugin(FIXTURE_BROKEN_PLUGIN)


def test_load_game_plugin_handles_plugin_that_exits_at_import(tmp_path):
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "name": "exits-on-import",
                "version": "1.0.0",
                "kind": "game",
                "display_name": "Exits On Import",
            }
        )
    )
    (tmp_path / "plugin.py").write_text("import sys\nsys.exit(1)\n")

    with pytest.raises(PluginLoadError, match="error executing"):
        load_game_plugin(tmp_path)


from tournament_server.plugin_registry.loader import (
    GAME_PLUGIN_KIND,
    SCHEDULER_PLUGIN_KIND,
    load_plugin,
)


def test_load_plugin_generic_matches_load_game_plugin():
    plugin = load_plugin(FIXTURE_EXAMPLE_PLUGIN, GAME_PLUGIN_KIND)
    assert plugin.name == "example-game"
    assert plugin.version == "1.0.0"


def test_load_plugin_rejects_mismatched_kind():
    with pytest.raises(PluginLoadError, match="expected 'scheduler'"):
        load_plugin(FIXTURE_EXAMPLE_PLUGIN, SCHEDULER_PLUGIN_KIND)


def test_game_plugin_without_skills_types_fails_to_load(tmp_path):
    import shutil

    plugin_dir = tmp_path / "no-skills-types"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, plugin_dir)
    manifest = json.loads((plugin_dir / "manifest.json").read_text())
    manifest["name"] = "no-skills-types"
    (plugin_dir / "manifest.json").write_text(json.dumps(manifest))
    text = (plugin_dir / "plugin.py").read_text()
    stripped = text.replace("def skills_types(", "def _not_skills_types(")
    assert stripped != text, "fixture setup did not find skills_types"
    (plugin_dir / "plugin.py").write_text(stripped)

    with pytest.raises(PluginLoadError, match="skills_types"):
        load_game_plugin(plugin_dir)
