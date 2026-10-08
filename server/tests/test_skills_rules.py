import pytest

from tournament_server.services.skills_rules import (
    attempts_error,
    effective_allowed,
    scoresheet_violations,
    skills_depth,
)

KEYS = ["autonomous", "driver"]


def test_effective_allowed_defaults_to_three():
    assert effective_allowed(KEYS, {}, None) == {"autonomous": 3, "driver": 3}


def test_effective_allowed_uses_the_event_setting_then_the_override():
    assert effective_allowed(KEYS, {"driver": 5}, None) == {"autonomous": 3, "driver": 5}
    assert effective_allowed(KEYS, {"driver": 5}, {"autonomous": 1}) == {"autonomous": 1, "driver": 5}
    assert effective_allowed(KEYS, {"driver": 5}, {"driver": 2}) == {"autonomous": 3, "driver": 2}


def test_effective_allowed_ignores_keys_the_plugin_does_not_list():
    assert effective_allowed(["driver"], {"teleop": 9}, {"teleop": 1}) == {"driver": 3}


def test_skills_depth_is_the_largest_allowed_number():
    assert skills_depth([{"autonomous": 1, "driver": 3}, {"autonomous": 4, "driver": 2}]) == 4
    assert skills_depth([]) == 0
    assert skills_depth([{}]) == 0


@pytest.mark.parametrize(
    ("attempts", "message"),
    [
        ({"teleop": 3}, "'teleop' is not a skills type for this game"),
        ({"driver": 0}, "Attempts for 'driver' must be a whole number from 1 to 20"),
        ({"driver": 21}, "Attempts for 'driver' must be a whole number from 1 to 20"),
    ],
)
def test_attempts_error(attempts, message):
    assert attempts_error(attempts, KEYS) == message


def test_attempts_error_accepts_the_bounds_and_an_empty_map():
    assert attempts_error({"autonomous": 1, "driver": 20}, KEYS) is None
    assert attempts_error({}, KEYS) is None


FIELDS = [
    {"name": "balls", "label": "Balls", "data_type": "integer", "widget": "counter",
     "min": 0, "max": 10, "step": 2, "options": None, "icon": None, "scope": "team", "default": 0},
    {"name": "parked", "label": "Parked", "data_type": "boolean", "widget": "toggle",
     "min": None, "max": None, "step": None, "options": None, "icon": None, "scope": "team", "default": False},
    {"name": "zone", "label": "Zone", "data_type": "enum", "widget": "select",
     "min": None, "max": None, "step": None, "options": ["near", "far"], "icon": None, "scope": "team",
     "default": "near"},
]
VALID = {"balls": 4, "parked": True, "zone": "far"}


def test_a_valid_sheet_has_no_violations():
    assert scoresheet_violations(FIELDS, VALID) == []


@pytest.mark.parametrize(
    ("changes", "field", "message"),
    [
        ({"balls": 12}, "balls", "Must be at most 10."),
        ({"balls": -2}, "balls", "Must be at least 0."),
        ({"balls": 3}, "balls", "Must be in steps of 2."),
        ({"balls": True}, "balls", "Must be a whole number."),
        ({"balls": 4.0}, "balls", "Must be a whole number."),
        ({"balls": "4"}, "balls", "Must be a whole number."),
        ({"balls": None}, "balls", "Must be a whole number."),
        ({"parked": 1}, "parked", "Must be true or false."),
        ({"parked": "true"}, "parked", "Must be true or false."),
        ({"zone": "middle"}, "zone", "Must be one of: near, far."),
        ({"zone": None}, "zone", "Must be one of: near, far."),
    ],
)
def test_each_bad_value_is_reported_on_its_field(changes, field, message):
    assert scoresheet_violations(FIELDS, {**VALID, **changes}) == [{"field": field, "message": message}]


def test_missing_and_unknown_fields_are_each_reported_in_order():
    data = {"parked": False, "extra": 1, "balls": 99}
    assert scoresheet_violations(FIELDS, data) == [
        {"field": "balls", "message": "Must be at most 10."},
        {"field": "zone", "message": "This field is required."},
        {"field": "extra", "message": "Unknown field."},
    ]


def test_step_counts_from_the_minimum():
    fields = [{**FIELDS[0], "min": 1, "max": 9, "step": 2}]
    assert scoresheet_violations(fields, {"balls": 5}) == []
    assert scoresheet_violations(fields, {"balls": 4}) == [{"field": "balls", "message": "Must be in steps of 2."}]


def test_unset_bounds_and_step_are_not_checked():
    fields = [{**FIELDS[0], "min": None, "max": None, "step": None}]
    assert scoresheet_violations(fields, {"balls": -7}) == []
    assert scoresheet_violations(fields, {"balls": 1001}) == []
