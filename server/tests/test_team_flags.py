from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest

from tournament_server.services import team_flags


@dataclass
class Flag:
    team_id: int
    no_show: bool = False
    dq: bool = False


@dataclass
class Record:
    data_json: str = json.dumps({"points": 40})
    teams: list[Flag] = field(default_factory=list)


class Plugin:
    class module:
        @staticmethod
        def calculate_score(data):
            return data["points"]


def test_flagged_team_ids_lists_teams_with_either_flag():
    flags = [Flag(1, dq=True), Flag(2, no_show=True), Flag(3)]
    assert team_flags.flagged_team_ids(flags) == {1, 2}


@pytest.mark.parametrize(
    ("flags", "finals", "out"),
    [
        ([], False, False),
        ([Flag(2, dq=True)], False, False),
        ([Flag(2, no_show=True)], False, False),
        ([Flag(1, dq=True), Flag(2, no_show=True)], False, True),
        ([Flag(1, no_show=True), Flag(2, no_show=True)], False, True),
        ([], True, False),
        ([Flag(2, dq=True)], True, True),
        ([Flag(2, no_show=True)], True, False),
        ([Flag(1, no_show=True), Flag(2, no_show=True)], True, True),
        ([Flag(2, no_show=True, dq=True)], True, True),
    ],
)
def test_alliance_out(flags, finals, out):
    assert team_flags.alliance_out(flags, [1, 2], finals=finals) is out


def test_alliance_out_ignores_flags_for_teams_not_on_the_alliance():
    assert team_flags.alliance_out([Flag(9, dq=True)], [1, 2], finals=True) is False


def test_an_alliance_with_no_teams_is_never_out():
    assert team_flags.alliance_out([], [], finals=False) is False


def test_effective_score_is_the_scoresheet_unless_the_alliance_is_out():
    assert team_flags.effective_score(Plugin, Record(teams=[Flag(2, dq=True)]), [1, 2], finals=False) == 40
    assert team_flags.effective_score(Plugin, Record(teams=[Flag(2, dq=True)]), [1, 2], finals=True) == 0


def test_effective_score_does_not_call_the_plugin_when_the_alliance_is_out():
    record = Record(data_json=json.dumps({}), teams=[Flag(1, no_show=True)])
    assert team_flags.effective_score(Plugin, record, [1], finals=False) == 0
