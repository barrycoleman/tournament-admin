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
