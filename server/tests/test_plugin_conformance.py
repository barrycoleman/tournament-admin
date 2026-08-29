from __future__ import annotations

import json
from pathlib import Path

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


def skills_scoresheet_schema():
    return [{{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "team", "default": 0}}]


def calculate_skills_score(scoresheet):
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


def skills_scoresheet_schema():
    return [{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "team", "default": 0}]


def calculate_skills_score(scoresheet):
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


def skills_scoresheet_schema():
    return [{"name": "x", "label": "X", "data_type": "integer", "widget": "counter",
             "min": 0, "max": 10, "step": 1, "options": None, "icon": None,
             "scope": "team", "default": 0}]


def calculate_skills_score(scoresheet):
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
