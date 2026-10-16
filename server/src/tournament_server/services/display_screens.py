"""The one registry of display screens (display groups design §5.4).
Adding a screen is one entry here, one device module and one admin label."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

DEFAULT_ROTATION_SECONDS = 20
MIN_ROTATION_SECONDS = 5
MAX_ROTATION_SECONDS = 300
MAX_ROTATION_ENTRIES = 20
DEFAULT_UPCOMING_COUNT = 3
MAX_UPCOMING_COUNT = 20


class ScreenSettingsError(ValueError):
    pass


def _whole_number(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _no_settings(settings: dict[str, Any], kind: str) -> dict[str, Any]:
    if settings:
        raise ScreenSettingsError("This screen has no settings.")
    return {}


def _upcoming_settings(settings: dict[str, Any], kind: str) -> dict[str, Any]:
    unknown = sorted(set(settings) - {"count", "scope"})
    if unknown:
        raise ScreenSettingsError(f"Unknown setting: {unknown[0]}")
    count = settings.get("count", DEFAULT_UPCOMING_COUNT)
    if not _whole_number(count) or not 1 <= count <= MAX_UPCOMING_COUNT:
        raise ScreenSettingsError(f"count must be a whole number from 1 to {MAX_UPCOMING_COUNT}.")
    scope = settings.get("scope", "division" if kind == "pit" else "field_set")
    if kind == "pit" and scope != "division":
        raise ScreenSettingsError("scope must be division on a pit group.")
    if scope not in ("field_set", "division"):
        raise ScreenSettingsError("scope must be field_set or division.")
    return {"count": count, "scope": scope}


@dataclass(frozen=True)
class ScreenSpec:
    kinds: frozenset[str]
    clean_settings: Callable[[dict[str, Any], str], dict[str, Any]]
    scrolls: bool = False


_AUDIENCE = frozenset({"audience"})
_AUDIENCE_AND_PIT = frozenset({"audience", "pit"})

SCREENS: dict[str, ScreenSpec] = {
    "match_intro": ScreenSpec(_AUDIENCE, _no_settings),
    "in_match": ScreenSpec(_AUDIENCE, _no_settings),
    "last_scored_match": ScreenSpec(_AUDIENCE, _no_settings),
    "teamwork_rankings": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings, scrolls=True),
    "skills_rankings": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings, scrolls=True),
    "upcoming_matches": ScreenSpec(_AUDIENCE_AND_PIT, _upcoming_settings),
    "match_results": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings, scrolls=True),
    "schedule": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings, scrolls=True),
    "elimination_bracket": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings),
    "logo": ScreenSpec(_AUDIENCE_AND_PIT, _no_settings),
}


def clean_screen(screen: str, settings: Any, kind: str) -> dict[str, Any]:
    """The settings to store for `screen` on a group of `kind`, with
    defaults filled in. Raises ScreenSettingsError naming the problem."""
    spec = SCREENS.get(screen)
    if spec is None:
        raise ScreenSettingsError(f"Unknown screen: {screen}")
    if kind not in spec.kinds:
        raise ScreenSettingsError(f"The {screen} screen can't be shown on a {kind} group.")
    if settings is None:
        settings = {}
    if not isinstance(settings, dict):
        raise ScreenSettingsError("Screen settings must be an object.")
    return spec.clean_settings(settings, kind)


def clean_rotation(rotation: Any) -> list[dict[str, Any]]:
    """A pit group's rotation, each entry as {screen, settings, seconds}."""
    if not isinstance(rotation, list) or not rotation:
        raise ScreenSettingsError("A rotation needs at least one screen.")
    if len(rotation) > MAX_ROTATION_ENTRIES:
        raise ScreenSettingsError(f"A rotation can have at most {MAX_ROTATION_ENTRIES} screens.")
    cleaned = []
    for number, entry in enumerate(rotation, start=1):
        try:
            if not isinstance(entry, dict):
                raise ScreenSettingsError("each entry must be an object.")
            unknown = sorted(set(entry) - {"screen", "settings", "seconds"})
            if unknown:
                raise ScreenSettingsError(f"unknown key {unknown[0]}.")
            screen = entry.get("screen")
            if not isinstance(screen, str):
                raise ScreenSettingsError("it needs a screen.")
            settings = clean_screen(screen, entry.get("settings"), "pit")
            seconds = entry.get("seconds", DEFAULT_ROTATION_SECONDS)
            if not _whole_number(seconds) or not MIN_ROTATION_SECONDS <= seconds <= MAX_ROTATION_SECONDS:
                raise ScreenSettingsError(
                    f"seconds must be a whole number from {MIN_ROTATION_SECONDS} to {MAX_ROTATION_SECONDS}."
                )
        except ScreenSettingsError as error:
            raise ScreenSettingsError(f"Rotation entry {number}: {error}") from None
        cleaned.append({"screen": screen, "settings": settings, "seconds": seconds})
    return cleaned
