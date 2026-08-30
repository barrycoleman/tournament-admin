from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from tournament_server.plugin_registry.errors import PluginLoadError
from tournament_server.plugin_registry.loader import (
    GAME_PLUGIN_KIND,
    SCHEDULER_PLUGIN_KIND,
    load_plugin,
)
from tournament_server.plugin_registry.manifest import load_manifest

_KNOWN_KINDS = {
    GAME_PLUGIN_KIND.kind: GAME_PLUGIN_KIND,
    SCHEDULER_PLUGIN_KIND.kind: SCHEDULER_PLUGIN_KIND,
}

VALID_DATA_TYPES = {"integer", "boolean", "enum"}
VALID_WIDGETS = {"toggle", "counter", "select", "radio"}
VALID_SCOPES = {"alliance", "team"}
VALID_GAME_MODELS = {"head_to_head", "cooperative_score"}
_REQUIRED_FIELD_KEYS = {
    "name",
    "label",
    "data_type",
    "widget",
    "min",
    "max",
    "step",
    "options",
    "icon",
    "scope",
    "default",
}


@dataclass
class CheckResult:
    name: str
    passed: bool
    message: str = ""


@dataclass
class ConformanceReport:
    plugin_name: str | None
    checks: list[CheckResult] = field(default_factory=list)

    @property
    def passed(self) -> bool:
        return all(c.passed for c in self.checks)


def _safe_check(name: str, fn) -> CheckResult:
    try:
        return fn()
    except Exception as exc:
        return CheckResult(name, False, f"raised {type(exc).__name__}: {exc}")


def run_conformance_checks(plugin_dir: Path) -> ConformanceReport:
    try:
        manifest = load_manifest(plugin_dir)
    except PluginLoadError as exc:
        return ConformanceReport(
            plugin_name=None, checks=[CheckResult("plugin loads", False, str(exc))]
        )

    kind = _KNOWN_KINDS.get(manifest.kind)
    if kind is None:
        return ConformanceReport(
            plugin_name=None,
            checks=[
                CheckResult(
                    "plugin loads", False, f"unknown plugin kind {manifest.kind!r}"
                )
            ],
        )

    try:
        plugin = load_plugin(plugin_dir, kind)
    except PluginLoadError as exc:
        return ConformanceReport(
            plugin_name=None, checks=[CheckResult("plugin loads", False, str(exc))]
        )

    if manifest.kind == "game":
        return _run_game_checks(plugin)
    return _run_scheduler_checks(plugin)


def _run_game_checks(plugin) -> ConformanceReport:
    checks: list[CheckResult] = [CheckResult("plugin loads", True)]

    checks.append(
        _safe_check("match_format() shape", lambda: _check_match_format(plugin.module))
    )

    schema_result = _safe_check(
        "scoresheet_schema() shape",
        lambda: _check_scoresheet_schema(plugin.module, "scoresheet_schema"),
    )
    checks.append(schema_result)

    skills_schema_result = _safe_check(
        "skills_scoresheet_schema() shape",
        lambda: _check_scoresheet_schema(plugin.module, "skills_scoresheet_schema"),
    )
    checks.append(skills_schema_result)

    if schema_result.passed:
        checks.append(
            _safe_check(
                "calculate_score() determinism",
                lambda: _check_calculate_score(plugin.module, "calculate_score"),
            )
        )
        checks.append(
            _safe_check("validate() shape", lambda: _check_validate(plugin.module))
        )
    else:
        checks.append(
            CheckResult(
                "calculate_score() determinism",
                False,
                "skipped: scoresheet_schema() is invalid",
            )
        )
        checks.append(
            CheckResult(
                "validate() shape", False, "skipped: scoresheet_schema() is invalid"
            )
        )

    if skills_schema_result.passed:
        checks.append(
            _safe_check(
                "calculate_skills_score() determinism",
                lambda: _check_calculate_score(plugin.module, "calculate_skills_score"),
            )
        )
    else:
        checks.append(
            CheckResult(
                "calculate_skills_score() determinism",
                False,
                "skipped: skills_scoresheet_schema() is invalid",
            )
        )

    checks.append(
        _safe_check("rank_teams() structure", lambda: _check_rank_teams(plugin.module))
    )

    return ConformanceReport(plugin_name=plugin.name, checks=checks)


def _run_scheduler_checks(plugin) -> ConformanceReport:
    checks: list[CheckResult] = [CheckResult("plugin loads", True)]
    checks.append(
        _safe_check(
            "generate_schedule() shape",
            lambda: _check_generate_schedule(plugin.module),
        )
    )
    return ConformanceReport(plugin_name=plugin.name, checks=checks)


def _check_match_format(module: Any) -> CheckResult:
    result = module.match_format()
    required_keys = {
        "alliance_count",
        "teams_per_alliance",
        "autonomous_seconds",
        "driver_seconds",
        "round_types",
        "game_model",
    }
    missing = required_keys - result.keys()
    if missing:
        return CheckResult(
            "match_format() shape", False, f"missing keys: {sorted(missing)}"
        )
    if not isinstance(result["round_types"], list) or not result["round_types"]:
        return CheckResult(
            "match_format() shape", False, "round_types must be a non-empty list"
        )
    if result["game_model"] not in VALID_GAME_MODELS:
        return CheckResult(
            "match_format() shape",
            False,
            f"game_model must be one of {sorted(VALID_GAME_MODELS)}, got "
            f"{result['game_model']!r}",
        )
    return CheckResult("match_format() shape", True)


def _check_scoresheet_schema(module: Any, function_name: str) -> CheckResult:
    fields = getattr(module, function_name)()
    if not isinstance(fields, list) or not fields:
        return CheckResult(
            f"{function_name}() shape", False, "must be a non-empty list"
        )
    for field_def in fields:
        missing = _REQUIRED_FIELD_KEYS - field_def.keys()
        if missing:
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"field {field_def.get('name', '?')!r} missing keys: "
                f"{sorted(missing)}",
            )
        if field_def["data_type"] not in VALID_DATA_TYPES:
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"field {field_def['name']!r} has invalid data_type "
                f"{field_def['data_type']!r}",
            )
        if field_def["widget"] not in VALID_WIDGETS:
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"field {field_def['name']!r} has invalid widget "
                f"{field_def['widget']!r}",
            )
        if field_def["scope"] not in VALID_SCOPES:
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"field {field_def['name']!r} has invalid scope "
                f"{field_def['scope']!r}",
            )
        if field_def["data_type"] == "enum" and not field_def.get("options"):
            return CheckResult(
                f"{function_name}() shape",
                False,
                f"enum field {field_def['name']!r} must declare options",
            )
    return CheckResult(f"{function_name}() shape", True)


def _sample_scoresheet(module: Any, function_name: str) -> dict[str, Any]:
    schema_fn_name = (
        "scoresheet_schema"
        if function_name == "calculate_score"
        else "skills_scoresheet_schema"
    )
    fields = getattr(module, schema_fn_name)()
    return {f["name"]: f["default"] for f in fields}


def _check_calculate_score(module: Any, function_name: str) -> CheckResult:
    fn = getattr(module, function_name)
    sample = _sample_scoresheet(module, function_name)
    first = fn(sample)
    second = fn(sample)
    if first != second:
        return CheckResult(
            f"{function_name}() determinism",
            False,
            "calling with the same input twice produced different results",
        )
    if not isinstance(first, int):
        return CheckResult(
            f"{function_name}() determinism",
            False,
            f"must return an int, got {type(first).__name__}",
        )
    return CheckResult(f"{function_name}() determinism", True)


def _check_validate(module: Any) -> CheckResult:
    sample = _sample_scoresheet(module, "calculate_score")
    result = module.validate(sample)
    if not isinstance(result, list):
        return CheckResult("validate() shape", False, "must return a list")
    return CheckResult("validate() shape", True)


def _check_rank_teams(module: Any) -> CheckResult:
    sample = [
        {
            "team_id": 1,
            "win_points": 4,
            "strength_of_schedule": 1.0,
            "tiebreaker_seed": 100,
        },
        {
            "team_id": 2,
            "win_points": 6,
            "strength_of_schedule": 2.0,
            "tiebreaker_seed": 200,
        },
        {
            "team_id": 3,
            "win_points": 4,
            "strength_of_schedule": 3.0,
            "tiebreaker_seed": 300,
        },
    ]
    result = module.rank_teams(sample)
    if len(result) != len(sample):
        return CheckResult(
            "rank_teams() structure", False, "must return one entry per input team"
        )
    ranks = sorted(r["rank"] for r in result)
    if ranks != list(range(1, len(sample) + 1)):
        return CheckResult(
            "rank_teams() structure",
            False,
            f"ranks must be exactly 1..{len(sample)} with no gaps or "
            f"duplicates, got {ranks}",
        )
    team_ids = {r["team_id"] for r in result}
    if team_ids != {r["team_id"] for r in sample}:
        return CheckResult(
            "rank_teams() structure", False, "must not add, drop, or change team_ids"
        )
    return CheckResult("rank_teams() structure", True)


def _check_generate_schedule(module: Any) -> CheckResult:
    teams = [{"team_id": i, "organization": None} for i in range(1, 5)]
    field_sets = [{"field_set_id": 1, "name": "Main Fields"}]
    fields = [{"field_id": 1, "field_set_id": 1}, {"field_id": 2, "field_set_id": 1}]

    result = module.generate_schedule(
        teams=teams,
        target_matches_per_team=2,
        teams_per_alliance=2,
        alliance_count=2,
        fields=fields,
        field_sets=field_sets,
        cross_session_pairing_history={},
        constraints={"excluded_team_ids": []},
    )

    if not isinstance(result, list):
        return CheckResult("generate_schedule() shape", False, "must return a list")

    for match in result:
        if not isinstance(match, dict):
            return CheckResult(
                "generate_schedule() shape", False, "each match must be a dict"
            )
        missing = {"time_slot", "field_set_id", "alliances"} - match.keys()
        if missing:
            return CheckResult(
                "generate_schedule() shape",
                False,
                f"match missing keys: {sorted(missing)}",
            )
        alliances = match["alliances"]
        if not isinstance(alliances, list) or len(alliances) != 2:
            return CheckResult(
                "generate_schedule() shape",
                False,
                "each match must have exactly 2 alliances",
            )
        stations = set()
        for alliance in alliances:
            if "station" not in alliance or "team_ids" not in alliance:
                return CheckResult(
                    "generate_schedule() shape",
                    False,
                    "alliance missing 'station' or 'team_ids'",
                )
            if not alliance["team_ids"]:
                return CheckResult(
                    "generate_schedule() shape",
                    False,
                    "alliance team_ids must be non-empty",
                )
            stations.add(alliance["station"])
        if stations != {"red", "blue"}:
            return CheckResult(
                "generate_schedule() shape",
                False,
                f"alliance stations must be exactly red/blue, got {sorted(stations)}",
            )

    return CheckResult("generate_schedule() shape", True)
