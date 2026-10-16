from __future__ import annotations

import pytest

from tournament_server.services.display_screens import (
    SCREENS,
    ScreenSettingsError,
    clean_rotation,
    clean_screen,
)


def test_the_registry_holds_exactly_the_spec_screens():
    assert set(SCREENS) == {
        "match_intro", "in_match", "last_scored_match", "teamwork_rankings", "skills_rankings",
        "upcoming_matches", "match_results", "schedule", "elimination_bracket", "logo",
    }
    assert {k for k, s in SCREENS.items() if s.kinds == frozenset({"audience"})} == {
        "match_intro", "in_match", "last_scored_match",
    }
    assert {k for k, s in SCREENS.items() if s.scrolls} == {
        "teamwork_rankings", "skills_rankings", "match_results", "schedule",
    }


def test_screens_without_settings_refuse_any():
    assert clean_screen("logo", None, "audience") == {}
    assert clean_screen("logo", {}, "pit") == {}
    with pytest.raises(ScreenSettingsError, match="no settings"):
        clean_screen("logo", {"count": 3}, "audience")


def test_unknown_screens_and_wrong_kinds_are_refused():
    with pytest.raises(ScreenSettingsError, match="Unknown screen: banner"):
        clean_screen("banner", {}, "audience")
    with pytest.raises(ScreenSettingsError, match="can't be shown on a pit group"):
        clean_screen("in_match", {}, "pit")
    with pytest.raises(ScreenSettingsError, match="can't be shown on a field group"):
        clean_screen("logo", {}, "field")


def test_upcoming_matches_settings_get_defaults_and_bounds():
    assert clean_screen("upcoming_matches", {}, "audience") == {"count": 3, "scope": "field_set"}
    assert clean_screen("upcoming_matches", {}, "pit") == {"count": 3, "scope": "division"}
    assert clean_screen("upcoming_matches", {"count": 20, "scope": "division"}, "audience") == {
        "count": 20, "scope": "division",
    }
    for bad in ({"count": 0}, {"count": 21}, {"count": True}, {"count": "3"}, {"scope": "event"}, {"colour": "red"}):
        with pytest.raises(ScreenSettingsError):
            clean_screen("upcoming_matches", bad, "audience")
    with pytest.raises(ScreenSettingsError, match="division"):
        clean_screen("upcoming_matches", {"scope": "field_set"}, "pit")


def test_rotations_are_cleaned_entry_by_entry():
    assert clean_rotation([{"screen": "teamwork_rankings"}, {"screen": "upcoming_matches", "seconds": 30}]) == [
        {"screen": "teamwork_rankings", "settings": {}, "seconds": 20},
        {"screen": "upcoming_matches", "settings": {"count": 3, "scope": "division"}, "seconds": 30},
    ]
    with pytest.raises(ScreenSettingsError, match="at least one"):
        clean_rotation([])
    with pytest.raises(ScreenSettingsError, match="Rotation entry 2: seconds"):
        clean_rotation([{"screen": "logo"}, {"screen": "logo", "seconds": 4}])
    with pytest.raises(ScreenSettingsError, match="Rotation entry 1: seconds"):
        clean_rotation([{"screen": "logo", "seconds": 301}])
    with pytest.raises(ScreenSettingsError, match="Rotation entry 1: The in_match screen"):
        clean_rotation([{"screen": "in_match"}])
    with pytest.raises(ScreenSettingsError, match="at most 20"):
        clean_rotation([{"screen": "logo"}] * 21)
    with pytest.raises(ScreenSettingsError, match="Rotation entry 1: unknown key"):
        clean_rotation([{"screen": "logo", "colour": "red"}])
