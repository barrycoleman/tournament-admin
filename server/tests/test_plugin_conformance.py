from __future__ import annotations

import json
from pathlib import Path

import pytest

from tournament_server.plugin_registry.conformance import run_conformance_checks

FIXTURE_EXAMPLE_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "example-game"
)
FIXTURE_BROKEN_PLUGIN = (
    Path(__file__).parent / "fixtures" / "plugins" / "games" / "broken-plugin"
)

_TEMPLATE = '''
def match_format():
    return {{
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
    }}


def scoresheet_schema():
{scoresheet_schema_body}

def calculate_score(scoresheet):
{calculate_score_body}

def validate(scoresheet):
    return []


def rank_teams(team_results):
    ordered = sorted(team_results, key=lambda r: -r["win_points"])
    return [{{**r, "rank": i + 1}} for i, r in enumerate(ordered)]


def skills_types():
    return [{{"key": "driver", "label": "Driver"}}]


def skills_scoresheet_schema(skills_type):
    return [{{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "team", "default": 0}}]


def calculate_skills_score(skills_type, scoresheet):
    return int(scoresheet.get("x", 0))
'''

_DEFAULT_SCORESHEET_SCHEMA_BODY = (
    "    return [{'name': 'high_balls', 'label': 'High Balls', "
    "'data_type': 'integer', 'widget': 'counter', 'min': 0, 'max': 20, "
    "'step': 1, 'options': None, 'icon': None, 'scope': 'alliance', "
    "'default': 0}]\n"
)
_DEFAULT_CALCULATE_SCORE_BODY = "    return scoresheet.get('high_balls', 0)\n"


def _write_variant_plugin(
    tmp_path,
    scoresheet_schema_body: str = _DEFAULT_SCORESHEET_SCHEMA_BODY,
    calculate_score_body: str = _DEFAULT_CALCULATE_SCORE_BODY,
) -> None:
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "name": "variant-plugin",
                "version": "1.0.0",
                "kind": "game",
                "display_name": "Variant Plugin",
            }
        )
    )
    (tmp_path / "plugin.py").write_text(
        _TEMPLATE.format(
            scoresheet_schema_body=scoresheet_schema_body,
            calculate_score_body=calculate_score_body,
        )
    )


def test_example_plugin_passes_all_checks():
    report = run_conformance_checks(FIXTURE_EXAMPLE_PLUGIN)
    assert report.passed, [c for c in report.checks if not c.passed]


def test_broken_plugin_fails_on_missing_function():
    report = run_conformance_checks(FIXTURE_BROKEN_PLUGIN)
    assert not report.passed
    failing = [c for c in report.checks if not c.passed]
    assert any("validate" in c.message for c in failing)


def test_calculate_score_must_return_int(tmp_path):
    _write_variant_plugin(
        tmp_path,
        calculate_score_body="    return float(scoresheet.get('high_balls', 0))\n",
    )
    report = run_conformance_checks(tmp_path)
    failing = [c for c in report.checks if not c.passed]
    assert any("calculate_score" in c.name and "int" in c.message for c in failing)


def test_scoresheet_schema_missing_key_fails(tmp_path):
    _write_variant_plugin(
        tmp_path,
        scoresheet_schema_body=(
            "    return [{'name': 'x', 'label': 'X', 'data_type': 'integer', "
            "'widget': 'counter', 'scope': 'alliance', 'default': 0}]\n"
        ),
    )
    report = run_conformance_checks(tmp_path)
    failing = [c for c in report.checks if not c.passed]
    assert any("scoresheet_schema" in c.name for c in failing)


def test_match_format_returning_wrong_type_fails_cleanly(tmp_path):
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "name": "bad-match-format",
                "version": "1.0.0",
                "kind": "game",
                "display_name": "Bad Match Format",
            }
        )
    )
    (tmp_path / "plugin.py").write_text(
        '''
def match_format():
    return ["not", "a", "dict"]


def scoresheet_schema():
    return [{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "alliance", "default": 0}]


def calculate_score(scoresheet):
    return scoresheet.get("x", 0)


def validate(scoresheet):
    return []


def rank_teams(team_results):
    ordered = sorted(team_results, key=lambda r: -r["win_points"])
    return [{**r, "rank": i + 1} for i, r in enumerate(ordered)]


def skills_types():
    return [{"key": "driver", "label": "Driver"}]


def skills_scoresheet_schema(skills_type):
    return [{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "team", "default": 0}]


def calculate_skills_score(skills_type, scoresheet):
    return int(scoresheet.get("x", 0))
'''
    )

    report = run_conformance_checks(tmp_path)

    assert not report.passed
    match_format_check = next(
        c for c in report.checks if c.name == "match_format() shape"
    )
    assert not match_format_check.passed


def test_scoresheet_field_missing_default_skips_dependent_checks_cleanly(tmp_path):
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "name": "missing-default",
                "version": "1.0.0",
                "kind": "game",
                "display_name": "Missing Default",
            }
        )
    )
    (tmp_path / "plugin.py").write_text(
        '''
def match_format():
    return {
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
    }


def scoresheet_schema():
    return [{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "alliance"}]


def calculate_score(scoresheet):
    return scoresheet.get("x", 0)


def validate(scoresheet):
    return []


def rank_teams(team_results):
    ordered = sorted(team_results, key=lambda r: -r["win_points"])
    return [{**r, "rank": i + 1} for i, r in enumerate(ordered)]


def skills_types():
    return [{"key": "driver", "label": "Driver"}]


def skills_scoresheet_schema(skills_type):
    return [{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "team", "default": 0}]


def calculate_skills_score(skills_type, scoresheet):
    return int(scoresheet.get("x", 0))
'''
    )

    report = run_conformance_checks(tmp_path)

    assert not report.passed
    schema_check = next(
        c for c in report.checks if c.name == "scoresheet_schema() shape"
    )
    assert not schema_check.passed
    assert "default" in schema_check.message

    score_check = next(
        c for c in report.checks if c.name == "calculate_score() determinism"
    )
    assert not score_check.passed
    assert "skipped" in score_check.message


def test_match_format_requires_game_model(tmp_path):
    import shutil

    broken_dir = tmp_path / "missing-game-model"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, broken_dir)
    manifest = json.loads((broken_dir / "manifest.json").read_text())
    manifest["name"] = "missing-game-model"
    (broken_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (broken_dir / "plugin.py").read_text()
    broken_text = plugin_text.replace(
        '"game_model": "head_to_head",\n    ', ""
    )
    assert broken_text != plugin_text, "test fixture setup did not find the line to remove"
    (broken_dir / "plugin.py").write_text(broken_text)

    report = run_conformance_checks(broken_dir)
    match_format_check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not match_format_check.passed
    assert "game_model" in match_format_check.message


def test_match_format_rejects_invalid_game_model(tmp_path):
    import shutil

    broken_dir = tmp_path / "bad-game-model"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, broken_dir)
    manifest = json.loads((broken_dir / "manifest.json").read_text())
    manifest["name"] = "bad-game-model"
    (broken_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (broken_dir / "plugin.py").read_text()
    broken_text = plugin_text.replace(
        '"game_model": "head_to_head"', '"game_model": "not-a-real-model"'
    )
    assert broken_text != plugin_text, "test fixture setup did not find the line to replace"
    (broken_dir / "plugin.py").write_text(broken_text)

    report = run_conformance_checks(broken_dir)
    match_format_check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not match_format_check.passed


def test_match_format_requires_alliance_selection(tmp_path):
    import shutil

    from tournament_server.plugin_registry.conformance import run_conformance_checks

    broken_dir = tmp_path / "missing-alliance-selection"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, broken_dir)
    manifest = json.loads((broken_dir / "manifest.json").read_text())
    manifest["name"] = "missing-alliance-selection"
    (broken_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (broken_dir / "plugin.py").read_text()
    broken_text = plugin_text.replace(
        '"alliance_selection": "captain_pick",\n        ', ""
    )
    assert broken_text != plugin_text, "test fixture setup did not find the line to remove"
    (broken_dir / "plugin.py").write_text(broken_text)

    report = run_conformance_checks(broken_dir)
    match_format_check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not match_format_check.passed
    assert "alliance_selection" in match_format_check.message


def test_match_format_rejects_invalid_finals_format(tmp_path):
    import shutil

    from tournament_server.plugin_registry.conformance import run_conformance_checks

    broken_dir = tmp_path / "bad-finals-format"
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, broken_dir)
    manifest = json.loads((broken_dir / "manifest.json").read_text())
    manifest["name"] = "bad-finals-format"
    (broken_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (broken_dir / "plugin.py").read_text()
    broken_text = plugin_text.replace(
        '"finals_format": "single_elimination"', '"finals_format": "not-a-real-format"'
    )
    assert broken_text != plugin_text, "test fixture setup did not find the line to replace"
    (broken_dir / "plugin.py").write_text(broken_text)

    report = run_conformance_checks(broken_dir)
    match_format_check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not match_format_check.passed


def test_cooperative_game_passes_conformance():
    from pathlib import Path

    from tournament_server.plugin_registry.conformance import run_conformance_checks

    cooperative_game = (
        Path(__file__).parent / "fixtures" / "plugins" / "games" / "cooperative-game"
    )
    report = run_conformance_checks(cooperative_game)
    assert report.passed, [c for c in report.checks if not c.passed]


def _write_variant_scheduler_plugin(tmp_path, generate_schedule_body: str) -> None:
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {
                "name": "variant-scheduler",
                "version": "1.0.0",
                "kind": "scheduler",
                "display_name": "Variant Scheduler",
            }
        )
    )
    (tmp_path / "plugin.py").write_text(
        "def generate_schedule(**kwargs):\n" + generate_schedule_body
    )


def test_scheduler_with_non_red_blue_station_names_passes_conformance(tmp_path):
    # The real server (routers/schedule.py's _validate_generated_schedule)
    # accepts any distinct, non-empty station names for a scheduler
    # plugin's alliances, not just "red"/"blue" — the conformance tool
    # must not enforce a stricter, stale rule than the server actually
    # applies.
    _write_variant_scheduler_plugin(
        tmp_path,
        "    teams = kwargs['teams']\n"
        "    return [{\n"
        "        'time_slot': 0,\n"
        "        'field_set_id': kwargs['field_sets'][0]['field_set_id'],\n"
        "        'alliances': [\n"
        "            {'station': 'alliance_1', 'team_ids': [teams[0]['team_id'], teams[1]['team_id']]},\n"
        "            {'station': 'alliance_2', 'team_ids': [teams[2]['team_id'], teams[3]['team_id']]},\n"
        "        ],\n"
        "    }]\n",
    )
    report = run_conformance_checks(tmp_path)
    assert report.passed, [c for c in report.checks if not c.passed]


def test_scheduler_with_duplicate_station_names_fails_conformance(tmp_path):
    _write_variant_scheduler_plugin(
        tmp_path,
        "    teams = kwargs['teams']\n"
        "    return [{\n"
        "        'time_slot': 0,\n"
        "        'field_set_id': kwargs['field_sets'][0]['field_set_id'],\n"
        "        'alliances': [\n"
        "            {'station': 'alliance_1', 'team_ids': [teams[0]['team_id'], teams[1]['team_id']]},\n"
        "            {'station': 'alliance_1', 'team_ids': [teams[2]['team_id'], teams[3]['team_id']]},\n"
        "        ],\n"
        "    }]\n",
    )
    report = run_conformance_checks(tmp_path)
    assert not report.passed
    failing = [c for c in report.checks if not c.passed]
    assert any("distinct" in c.message for c in failing)


def _example_with_default_cycle(tmp_path, name: str, value: str):
    import shutil

    plugin_dir = tmp_path / name
    shutil.copytree(FIXTURE_EXAMPLE_PLUGIN, plugin_dir)
    manifest = json.loads((plugin_dir / "manifest.json").read_text())
    manifest["name"] = name
    (plugin_dir / "manifest.json").write_text(json.dumps(manifest))
    plugin_text = (plugin_dir / "plugin.py").read_text()
    anchor = '"finals_format": "single_elimination",'
    assert anchor in plugin_text, "test fixture setup did not find the line to extend"
    (plugin_dir / "plugin.py").write_text(
        plugin_text.replace(anchor, f'{anchor}\n        "default_cycle_time_seconds": {value},')
    )
    return plugin_dir


def test_a_default_cycle_time_of_at_least_the_match_length_passes(tmp_path):
    report = run_conformance_checks(_example_with_default_cycle(tmp_path, "cycle-ok", "300"))
    check = next(c for c in report.checks if c.name == "match_format() shape")
    assert check.passed, check.message


def test_a_default_cycle_time_shorter_than_the_match_fails(tmp_path):
    report = run_conformance_checks(_example_with_default_cycle(tmp_path, "cycle-short", "90"))
    check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not check.passed
    assert "at least the match length (120s)" in check.message


def test_a_non_integer_default_cycle_time_fails(tmp_path):
    report = run_conformance_checks(_example_with_default_cycle(tmp_path, "cycle-float", "300.5"))
    check = next(c for c in report.checks if c.name == "match_format() shape")
    assert not check.passed
    assert "default_cycle_time_seconds must be an integer" in check.message


_SKILLS_BASE = '''
def match_format():
    return {
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "head_to_head",
        "alliance_selection": "captain_pick",
        "finals_format": "single_elimination",
    }


def _field(name, scope):
    return {"name": name, "label": name.upper(), "data_type": "integer", "widget": "counter",
            "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
            "scope": scope, "default": 0}


def scoresheet_schema():
    return [_field("x", "alliance")]


def calculate_score(scoresheet):
    return int(scoresheet.get("x", 0))


def validate(scoresheet):
    return []


def rank_teams(team_results):
    ordered = sorted(team_results, key=lambda r: -r["win_points"])
    return [{**r, "rank": i + 1} for i, r in enumerate(ordered)]
'''

_GOOD_SKILLS = '''
def skills_types():
    return [{"key": "autonomous", "label": "Autonomous"}, {"key": "driver", "label": "Driver"}]


def skills_scoresheet_schema(skills_type):
    return [_field("x", "team")]


def calculate_skills_score(skills_type, scoresheet):
    return int(scoresheet.get("x", 0))
'''


def _write_skills_plugin(tmp_path, skills_code: str):
    (tmp_path / "manifest.json").write_text(
        json.dumps(
            {"name": "skills-variant", "version": "1.0.0", "kind": "game", "display_name": "Skills Variant"}
        )
    )
    (tmp_path / "plugin.py").write_text(_SKILLS_BASE + skills_code)
    return tmp_path


def _named(report, name):
    return next(c for c in report.checks if c.name == name)


def test_valid_skills_types_pass_with_a_check_per_type(tmp_path):
    report = run_conformance_checks(_write_skills_plugin(tmp_path, _GOOD_SKILLS))
    assert report.passed, [c for c in report.checks if not c.passed]
    names = [c.name for c in report.checks]
    assert "skills_types() shape" in names
    for key in ("autonomous", "driver"):
        assert f"skills_scoresheet_schema({key!r}) shape" in names
        assert f"calculate_skills_score({key!r}) determinism" in names


def test_an_empty_type_list_passes_and_skips_per_type_checks(tmp_path):
    code = _GOOD_SKILLS.replace(
        'return [{"key": "autonomous", "label": "Autonomous"}, {"key": "driver", "label": "Driver"}]',
        "return []",
    ).replace('return [_field("x", "team")]', "return []")
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    assert report.passed, [c for c in report.checks if not c.passed]
    assert not any(c.name.startswith("skills_scoresheet_schema(") for c in report.checks)
    assert not any(c.name.startswith("calculate_skills_score(") for c in report.checks)


@pytest.mark.parametrize(
    ("types_literal", "message"),
    [
        ('[{"key": "driver", "label": "Driver"}, {"key": "driver", "label": "Again"}]', "duplicate"),
        ('[{"key": "Driver", "label": "Driver"}]', "must match"),
        ('[{"key": "driver-1", "label": "Driver"}]', "must match"),
        ('[{"key": 5, "label": "Driver"}]', "must match"),
        ('[{"key": "overall", "label": "Overall"}]', "reserved"),
        ('[{"key": "driver", "label": "  "}]', "non-empty label"),
        ('[{"key": "driver", "label": 7}]', "non-empty label"),
        ('[{"key": "driver"}]', "exactly"),
        ('[{"key": "driver", "label": "Driver", "icon": None}]', "exactly"),
        ('["driver"]', "exactly"),
        ('{"key": "driver", "label": "Driver"}', "must return a list"),
    ],
)
def test_bad_skills_types_fail(tmp_path, types_literal, message):
    code = _GOOD_SKILLS.replace(
        '[{"key": "autonomous", "label": "Autonomous"}, {"key": "driver", "label": "Driver"}]', types_literal
    )
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    check = _named(report, "skills_types() shape")
    assert not check.passed
    assert message in check.message
    assert not report.passed


def test_an_invalid_schema_for_one_type_fails_only_that_type(tmp_path):
    code = _GOOD_SKILLS.replace(
        'return [_field("x", "team")]',
        'field = _field("x", "team")\n'
        '    if skills_type == "driver":\n'
        '        del field["default"]\n'
        "    return [field]",
    )
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    assert _named(report, "skills_scoresheet_schema('autonomous') shape").passed
    driver = _named(report, "skills_scoresheet_schema('driver') shape")
    assert not driver.passed
    assert "default" in driver.message
    skipped = _named(report, "calculate_skills_score('driver') determinism")
    assert not skipped.passed
    assert "skipped" in skipped.message
    assert _named(report, "calculate_skills_score('autonomous') determinism").passed


def test_non_int_skills_scoring_fails(tmp_path):
    code = _GOOD_SKILLS.replace(
        'return int(scoresheet.get("x", 0))',
        'return float(scoresheet.get("x", 0)) if skills_type == "driver" else int(scoresheet.get("x", 0))',
    )
    report = run_conformance_checks(_write_skills_plugin(tmp_path, code))
    check = _named(report, "calculate_skills_score('driver') determinism")
    assert not check.passed
    assert "int" in check.message
