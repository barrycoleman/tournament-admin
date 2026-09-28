import pytest

from tournament_server.services.match_labeling import match_label


def test_practice_round_gets_p_prefix():
    label = match_label(
        "practice", 7,
        finals_bracket_id=None, bracket_matchup_id=None, bracket_alliance_id=None,
    )
    assert label == "P7"


def test_qualification_round_gets_q_prefix():
    label = match_label(
        "qualification", 42,
        finals_bracket_id=None, bracket_matchup_id=None, bracket_alliance_id=None,
    )
    assert label == "Q42"


def test_unknown_round_type_falls_back_to_own_first_letter_uppercased():
    label = match_label(
        "tiebreaker", 3,
        finals_bracket_id=None, bracket_matchup_id=None, bracket_alliance_id=None,
    )
    assert label == "T3"


def test_single_elimination_series_game_label():
    label = match_label(
        "elimination", 2,
        finals_bracket_id=99, bracket_matchup_id=5, bracket_alliance_id=None,
        matchup_number=3,
    )
    assert label == "F3-2"


def test_single_elimination_without_matchup_number_raises():
    with pytest.raises(ValueError, match="matchup_number"):
        match_label(
            "elimination", 1,
            finals_bracket_id=99, bracket_matchup_id=5, bracket_alliance_id=None,
        )


def test_score_chase_run_label_has_no_suffix():
    label = match_label(
        "elimination", 4,
        finals_bracket_id=99, bracket_matchup_id=None, bracket_alliance_id=17,
    )
    assert label == "F4"
