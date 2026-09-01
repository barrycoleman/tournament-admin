import pytest

from tournament_server.services.finals import (
    bracket_capacity,
    expand_wins_to_advance,
    total_rounds_for_bracket_size,
)


@pytest.mark.parametrize(
    "bracket_size,expected_capacity,expected_rounds",
    [
        (2, 2, 1),
        (3, 4, 2),
        (4, 4, 2),
        (5, 8, 3),
        (8, 8, 3),
        (9, 16, 4),
    ],
)
def test_bracket_capacity_and_total_rounds(bracket_size, expected_capacity, expected_rounds):
    assert bracket_capacity(bracket_size) == expected_capacity
    assert total_rounds_for_bracket_size(bracket_size) == expected_rounds


def test_expand_wins_to_advance_single_int_fills_every_round():
    assert expand_wins_to_advance(1, 4) == [1, 1, 1, 1]


def test_expand_wins_to_advance_accepts_correct_length_list():
    assert expand_wins_to_advance([1, 1, 1, 2], 4) == [1, 1, 1, 2]


def test_expand_wins_to_advance_rejects_wrong_length_list():
    with pytest.raises(ValueError, match="exactly 4 entries"):
        expand_wins_to_advance([1, 2], 4)


def test_expand_wins_to_advance_rejects_zero_or_negative():
    with pytest.raises(ValueError):
        expand_wins_to_advance(0, 4)
    with pytest.raises(ValueError):
        expand_wins_to_advance([1, 1, 1, 0], 4)
