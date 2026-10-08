"""Skills-challenge rules that need no database: allowed attempts, settings
validation, and the generic scoresheet check run before any plugin code."""
from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

DEFAULT_ATTEMPTS = 3
MIN_ATTEMPTS = 1
MAX_ATTEMPTS = 20


def effective_allowed(
    type_keys: Sequence[str],
    event_attempts: Mapping[str, int],
    override: Mapping[str, int] | None,
) -> dict[str, int]:
    """Attempts allowed per type in one session: the session override, else the
    event setting, else 3. Keys the plugin doesn't list are ignored."""
    override = override or {}
    return {
        key: override.get(key, event_attempts.get(key, DEFAULT_ATTEMPTS)) for key in type_keys
    }


def skills_depth(allowed_maps: Iterable[Mapping[str, int]]) -> int:
    """How deep Overall tie-break sums go: the most attempts any type allows."""
    return max((value for allowed in allowed_maps for value in allowed.values()), default=0)


def attempts_error(attempts: Mapping[str, int], type_keys: Sequence[str]) -> str | None:
    """A readable reason an attempts map is invalid, or None. Values are already
    strict ints (the request schema rejects booleans and floats)."""
    for key, value in attempts.items():
        if key not in type_keys:
            return f"{key!r} is not a skills type for this game"
        if not MIN_ATTEMPTS <= value <= MAX_ATTEMPTS:
            return f"Attempts for {key!r} must be a whole number from {MIN_ATTEMPTS} to {MAX_ATTEMPTS}"
    return None


def _field_problem(field: Mapping[str, Any], value: Any) -> str | None:
    data_type = field["data_type"]
    if data_type == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            return "Must be a whole number."
        low, high, step = field.get("min"), field.get("max"), field.get("step")
        if low is not None and value < low:
            return f"Must be at least {low}."
        if high is not None and value > high:
            return f"Must be at most {high}."
        if step and (value - (low if low is not None else 0)) % step:
            return f"Must be in steps of {step}."
        return None
    if data_type == "boolean":
        return None if isinstance(value, bool) else "Must be true or false."
    options = list(field.get("options") or [])
    if value in options and not isinstance(value, bool):
        return None
    return f"Must be one of: {', '.join(str(option) for option in options)}."


def scoresheet_violations(
    fields: list[dict[str, Any]], data: Mapping[str, Any]
) -> list[dict[str, str]]:
    """Every problem with a submitted scoresheet, one per bad or missing field
    (in schema order) and then one per unknown key."""
    violations: list[dict[str, str]] = []
    names = [field["name"] for field in fields]
    for field in fields:
        name = field["name"]
        if name not in data:
            violations.append({"field": name, "message": "This field is required."})
            continue
        problem = _field_problem(field, data[name])
        if problem is not None:
            violations.append({"field": name, "message": problem})
    for key in data:
        if key not in names:
            violations.append({"field": key, "message": "Unknown field."})
    return violations
