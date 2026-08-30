from pathlib import Path

from tournament_server.cli import main

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)

FIXTURE_COOPERATIVE_GAME_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "cooperative-game"
)


def test_test_plugin_command_exits_zero_on_good_plugin(capsys):
    exit_code = main(["test-plugin", str(FIXTURE_EXAMPLE_PLUGIN)])
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "All checks passed" in captured.out


def test_test_plugin_command_exits_nonzero_on_broken_plugin(capsys):
    exit_code = main(["test-plugin", str(FIXTURE_BROKEN_PLUGIN)])
    assert exit_code == 1
    captured = capsys.readouterr()
    assert "FAIL" in captured.out


def test_test_plugin_command_exits_zero_on_cooperative_game(capsys):
    exit_code = main(["test-plugin", str(FIXTURE_COOPERATIVE_GAME_PLUGIN)])
    assert exit_code == 0
    captured = capsys.readouterr()
    assert "All checks passed" in captured.out
