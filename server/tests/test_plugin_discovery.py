import shutil
from pathlib import Path

from tournament_server.plugin_registry.discovery import discover_game_plugins

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)


def test_discover_game_plugins_finds_valid_plugin(tmp_path):
    target = tmp_path / "plugins" / "games" / "example-game"
    target.parent.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, target)

    registry = discover_game_plugins(tmp_path / "plugins")

    assert set(registry) == {"example-game"}
    assert registry["example-game"].version == "1.0.0"


def test_discover_game_plugins_empty_root_returns_empty_dict(tmp_path):
    registry = discover_game_plugins(tmp_path / "plugins")
    assert registry == {}


def test_discover_game_plugins_skips_broken_folder_but_keeps_good_one(tmp_path):
    games_root = tmp_path / "plugins" / "games"
    games_root.mkdir(parents=True)
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, games_root / "example-game")
    shutil.copytree(FIXTURE_BROKEN_PLUGIN, games_root / "broken-plugin")

    registry = discover_game_plugins(tmp_path / "plugins")

    assert set(registry) == {"example-game"}


from tournament_server.plugin_registry.discovery import discover_scheduler_plugins


def test_discover_scheduler_plugins_empty_root_returns_empty_dict(tmp_path):
    registry = discover_scheduler_plugins(tmp_path / "plugins")
    assert registry == {}
