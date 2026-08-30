from pathlib import Path

from plugin_helpers import zip_fixture_plugin
from tournament_server.cli import main
from tournament_server.plugin_registry.conformance import run_conformance_checks
from tournament_server.plugin_registry.discovery import discover_scheduler_plugins
from tournament_server.plugin_registry.loader import (
    SCHEDULER_PLUGIN_KIND,
    load_plugin,
)
from tournament_server.plugin_registry.zip_install import install_plugin_zip

SIMPLE_RANDOM_PLUGIN = (
    Path(__file__).parent.parent / "plugins" / "schedulers" / "simple_random"
)


def test_simple_random_loads_and_declares_scheduler_kind():
    plugin = load_plugin(SIMPLE_RANDOM_PLUGIN, SCHEDULER_PLUGIN_KIND)
    assert plugin.name == "simple_random"
    assert callable(plugin.module.generate_schedule)


def test_simple_random_discovered_from_a_plugins_root(tmp_path):
    import shutil

    target = tmp_path / "plugins" / "schedulers" / "simple_random"
    target.parent.mkdir(parents=True)
    shutil.copytree(SIMPLE_RANDOM_PLUGIN, target)

    registry = discover_scheduler_plugins(tmp_path / "plugins")
    assert set(registry) == {"simple_random"}


def test_simple_random_installs_via_zip(tmp_path):
    zip_bytes = zip_fixture_plugin(SIMPLE_RANDOM_PLUGIN)
    plugin = install_plugin_zip(zip_bytes, tmp_path / "plugins", SCHEDULER_PLUGIN_KIND)
    assert plugin.name == "simple_random"


def test_simple_random_passes_conformance():
    report = run_conformance_checks(SIMPLE_RANDOM_PLUGIN)
    assert report.passed, [c for c in report.checks if not c.passed]


def test_simple_random_produces_valid_schedule_shape():
    plugin = load_plugin(SIMPLE_RANDOM_PLUGIN, SCHEDULER_PLUGIN_KIND)
    # Tight fixture: 6 teams, 2 field_sets, teams_per_alliance=2 (match_size=4).
    # With only 6 teams available, there are not enough distinct teams left
    # for a second concurrent match in the same time_slot unless
    # used_this_slot correctly excludes the first field_set's picks — this
    # is what actually exercises the concurrency-safety invariant (a single
    # field_set can never trigger a double-booking with itself).
    teams = [{"team_id": i, "organization": None} for i in range(1, 7)]
    field_sets = [
        {"field_set_id": 1, "name": "Field Set 1"},
        {"field_set_id": 2, "name": "Field Set 2"},
    ]
    fields = [
        {"field_id": 1, "field_set_id": 1},
        {"field_id": 2, "field_set_id": 2},
    ]

    matches = plugin.module.generate_schedule(
        teams=teams,
        target_matches_per_team=2,
        teams_per_alliance=2,
        fields=fields,
        field_sets=field_sets,
        cross_session_pairing_history={},
        constraints={"excluded_team_ids": []},
    )

    assert matches
    teams_by_slot: dict[int, set[int]] = {}
    for match in matches:
        slot_teams = teams_by_slot.setdefault(match["time_slot"], set())
        for alliance in match["alliances"]:
            for team_id in alliance["team_ids"]:
                assert team_id not in slot_teams, (
                    f"team {team_id} double-booked in time_slot {match['time_slot']}"
                )
                slot_teams.add(team_id)


def test_cli_test_plugin_passes_for_simple_random(capsys):
    exit_code = main(["test-plugin", str(SIMPLE_RANDOM_PLUGIN)])
    assert exit_code == 0
    assert "All checks passed" in capsys.readouterr().out
