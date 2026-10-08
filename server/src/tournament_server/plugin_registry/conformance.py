from __future__ import annotations

import re
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
VALID_ALLIANCE_SELECTIONS = {"captain_pick", "seed_pairing"}
VALID_FINALS_FORMATS = {"single_elimination", "score_chase"}
_SKILLS_KEY_PATTERN = re.compile(r"[a-z0-9_]+")
# "overall" names the rankings tab that sums every type, so no type may use it.
RESERVED_SKILLS_KEYS = {"overall"}
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

    match_format_check = _safe_check(
        "match_format() shape", lambda: _check_match_format(plugin.module)
    )
    checks.append(match_format_check)
    game_model = None
    if match_format_check.passed:
        try:
            game_model = plugin.module.match_format().get("game_model")
        except Exception:
            game_model = None

    schema_result = _safe_check(
        "scoresheet_schema() shape",
        lambda: _check_scoresheet_schema(plugin.module, "scoresheet_schema"),
    )
    checks.append(schema_result)

    if schema_result.passed:
        checks.append(
            _safe_check(
                "calculate_score() determinism",
                lambda: _check_calculate_score(plugin.module),
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

    types_result = _safe_check("skills_types() shape", lambda: _check_skills_types(plugin.module))
    checks.append(types_result)
    if types_result.passed:
        for key in [t["key"] for t in plugin.module.skills_types()]:
            schema_check = _safe_check(
                f"skills_scoresheet_schema({key!r}) shape",
                lambda key=key: _check_skills_scoresheet_schema(plugin.module, key),
            )
            checks.append(schema_check)
            score_name = f"calculate_skills_score({key!r}) determinism"
            if schema_check.passed:
                checks.append(
                    _safe_check(score_name, lambda key=key: _check_calculate_skills_score(plugin.module, key))
                )
            else:
                checks.append(
                    CheckResult(score_name, False, f"skipped: skills_scoresheet_schema({key!r}) is invalid")
                )

    checks.append(
        _safe_check(
            "rank_teams() structure",
            lambda: _check_rank_teams(plugin.module, game_model),
        )
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
        "alliance_selection",
        "finals_format",
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
    if result["alliance_selection"] not in VALID_ALLIANCE_SELECTIONS:
        return CheckResult(
            "match_format() shape",
            False,
            f"alliance_selection must be one of {sorted(VALID_ALLIANCE_SELECTIONS)}, "
            f"got {result['alliance_selection']!r}",
        )
    if result["finals_format"] not in VALID_FINALS_FORMATS:
        return CheckResult(
            "match_format() shape",
            False,
            f"finals_format must be one of {sorted(VALID_FINALS_FORMATS)}, got "
            f"{result['finals_format']!r}",
        )
    default_cycle = result.get("default_cycle_time_seconds")
    if default_cycle is not None:
        match_seconds = result["autonomous_seconds"] + result["driver_seconds"]
        if isinstance(default_cycle, bool) or not isinstance(default_cycle, int):
            return CheckResult(
                "match_format() shape",
                False,
                "default_cycle_time_seconds must be an integer number of seconds, got "
                f"{default_cycle!r}",
            )
        if default_cycle < match_seconds:
            return CheckResult(
                "match_format() shape",
                False,
                f"default_cycle_time_seconds ({default_cycle}) must be at least the "
                f"match length ({match_seconds}s)",
            )
    return CheckResult("match_format() shape", True)


def _check_scoresheet_schema(module: Any, function_name: str) -> CheckResult:
    return _check_fields(f"{function_name}() shape", getattr(module, function_name)())


def _check_skills_scoresheet_schema(module: Any, key: str) -> CheckResult:
    return _check_fields(f"skills_scoresheet_schema({key!r}) shape", module.skills_scoresheet_schema(key))


def _check_fields(check_name: str, fields: Any) -> CheckResult:
    if not isinstance(fields, list) or not fields:
        return CheckResult(check_name, False, "must be a non-empty list")
    for field_def in fields:
        missing = _REQUIRED_FIELD_KEYS - field_def.keys()
        if missing:
            return CheckResult(
                check_name,
                False,
                f"field {field_def.get('name', '?')!r} missing keys: {sorted(missing)}",
            )
        if field_def["data_type"] not in VALID_DATA_TYPES:
            return CheckResult(
                check_name, False, f"field {field_def['name']!r} has invalid data_type {field_def['data_type']!r}"
            )
        if field_def["widget"] not in VALID_WIDGETS:
            return CheckResult(
                check_name, False, f"field {field_def['name']!r} has invalid widget {field_def['widget']!r}"
            )
        if field_def["scope"] not in VALID_SCOPES:
            return CheckResult(
                check_name, False, f"field {field_def['name']!r} has invalid scope {field_def['scope']!r}"
            )
        if field_def["data_type"] == "enum" and not field_def.get("options"):
            return CheckResult(check_name, False, f"enum field {field_def['name']!r} must declare options")
    return CheckResult(check_name, True)


def _defaults(fields: list[dict[str, Any]]) -> dict[str, Any]:
    return {f["name"]: f["default"] for f in fields}


def _check_deterministic_int(check_name: str, score) -> CheckResult:
    first = score()
    second = score()
    if first != second:
        return CheckResult(check_name, False, "calling with the same input twice produced different results")
    if not isinstance(first, int):
        return CheckResult(check_name, False, f"must return an int, got {type(first).__name__}")
    return CheckResult(check_name, True)


def _check_calculate_score(module: Any) -> CheckResult:
    sample = _defaults(module.scoresheet_schema())
    return _check_deterministic_int("calculate_score() determinism", lambda: module.calculate_score(sample))


def _check_calculate_skills_score(module: Any, key: str) -> CheckResult:
    sample = _defaults(module.skills_scoresheet_schema(key))
    return _check_deterministic_int(
        f"calculate_skills_score({key!r}) determinism",
        lambda: module.calculate_skills_score(key, sample),
    )


def _check_skills_types(module: Any) -> CheckResult:
    name = "skills_types() shape"
    types = module.skills_types()
    if not isinstance(types, list):
        return CheckResult(name, False, "must return a list")
    seen: set[str] = set()
    for item in types:
        if not isinstance(item, dict) or set(item) != {"key", "label"}:
            return CheckResult(name, False, "each type must be a dict with exactly 'key' and 'label'")
        key, label = item["key"], item["label"]
        if not isinstance(key, str) or not _SKILLS_KEY_PATTERN.fullmatch(key):
            return CheckResult(name, False, f"type key {key!r} must match ^[a-z0-9_]+$")
        if key in RESERVED_SKILLS_KEYS:
            return CheckResult(name, False, f"type key {key!r} is reserved")
        if key in seen:
            return CheckResult(name, False, f"duplicate type key {key!r}")
        seen.add(key)
        if not isinstance(label, str) or not label.strip():
            return CheckResult(name, False, f"type {key!r} needs a non-empty label")
    return CheckResult(name, True)


def _check_validate(module: Any) -> CheckResult:
    sample = _defaults(module.scoresheet_schema())
    result = module.validate(sample)
    if not isinstance(result, list):
        return CheckResult("validate() shape", False, "must return a list")
    return CheckResult("validate() shape", True)


def _check_rank_teams(module: Any, game_model: str | None) -> CheckResult:
    if game_model == "cooperative_score":
        sample = [
            {"team_id": 1, "average_score": 10.0, "matches_played": 3, "tiebreaker_seed": 100},
            {"team_id": 2, "average_score": 15.0, "matches_played": 3, "tiebreaker_seed": 200},
            {"team_id": 3, "average_score": 10.0, "matches_played": 2, "tiebreaker_seed": 300},
        ]
    else:
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
            station = alliance["station"]
            if not isinstance(station, str) or not station:
                return CheckResult(
                    "generate_schedule() shape",
                    False,
                    "alliance station must be a non-empty string",
                )
            if not alliance["team_ids"]:
                return CheckResult(
                    "generate_schedule() shape",
                    False,
                    "alliance team_ids must be non-empty",
                )
            stations.add(station)
        if len(stations) != len(alliances):
            return CheckResult(
                "generate_schedule() shape",
                False,
                "alliance stations must be distinct within a match",
            )

    return CheckResult("generate_schedule() shape", True)
