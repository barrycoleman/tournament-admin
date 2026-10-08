import datetime as dt

from tournament_server.services.skills_ranking import (
    OVERALL,
    AttemptScore,
    rank_skills,
    session_order_key,
    team_number_sort_key,
)
from tournament_server.services.skills_rules import effective_allowed, skills_depth

KEYS = ["autonomous", "driver"]
ORDER = {1: session_order_key(dt.date(2026, 10, 10), 1), 2: session_order_key(dt.date(2026, 10, 11), 2)}
NUMBERS = {1: "1", 2: "2", 3: "3", 4: "4", 10: "10"}


def a(team, skills_type, score, session=1):
    return AttemptScore(session_id=session, team_id=team, skills_type=skills_type, score=score)


def table(rows):
    return [(r.rank, r.team_id, r.score, r.attempts, r.session_id) for r in rows]


def rank(attempts, tab, depth=3, keys=KEYS, order=ORDER, numbers=NUMBERS):
    return table(rank_skills(attempts, keys, tab, depth, order, numbers))


def test_a_type_tab_lists_only_teams_with_that_type_best_first():
    attempts = [a(1, "driver", 20), a(1, "driver", 28), a(2, "driver", 25), a(3, "autonomous", 40)]
    assert rank(attempts, "driver") == [(1, 1, 28, [28, 20], 1), (2, 2, 25, [25], 1)]


def test_overall_adds_each_type_best_and_a_missing_type_adds_nothing():
    attempts = [a(1, "driver", 30), a(2, "autonomous", 10), a(2, "driver", 25)]
    assert rank(attempts, OVERALL) == [(1, 2, 35, [10, 25], 1), (2, 1, 30, [30], 1)]


def test_a_missing_entry_ranks_below_zero():
    attempts = [a(1, "driver", 10), a(1, "driver", 0), a(2, "driver", 10)]
    assert rank(attempts, "driver") == [(1, 1, 10, [10, 0], 1), (2, 2, 10, [10], 1)]
    # Overall: equal sums and bests; team 1's second-best (0) beats team 2's missing one.
    assert rank(attempts, OVERALL) == [(1, 1, 10, [10, 0], 1), (2, 2, 10, [10], 1)]


def test_a_missing_type_best_ranks_below_a_zero_best():
    attempts = [a(1, "autonomous", 0), a(1, "driver", 20), a(2, "driver", 20)]
    assert rank(attempts, OVERALL)[0][1] == 1


def test_overall_ties_go_to_the_types_in_plugin_order():
    attempts = [a(1, "autonomous", 30), a(1, "driver", 20), a(2, "autonomous", 20), a(2, "driver", 30)]
    assert [row[1] for row in rank(attempts, OVERALL)] == [1, 2]
    assert [row[1] for row in rank(attempts, OVERALL, keys=["driver", "autonomous"])] == [2, 1]


def test_three_way_ties_share_a_rank_ordered_by_team_number():
    attempts = [a(10, "driver", 20), a(2, "driver", 20), a(3, "driver", 20)]
    assert rank(attempts, "driver") == [(1, 2, 20, [20], 1), (1, 3, 20, [20], 1), (1, 10, 20, [20], 1)]


def test_shared_ranks_skip_the_next_number():
    attempts = [a(1, "driver", 30), a(2, "driver", 20), a(3, "driver", 20), a(4, "driver", 10)]
    assert [(row[0], row[1]) for row in rank(attempts, "driver")] == [(1, 1), (2, 2), (2, 3), (4, 4)]


def test_ties_are_broken_at_depth_three():
    attempts = [a(1, "driver", s) for s in (20, 15, 10)] + [a(2, "driver", s) for s in (20, 15, 5)]
    assert [row[1] for row in rank(attempts, "driver")] == [1, 2]
    assert [(row[0], row[1]) for row in rank(attempts, OVERALL, depth=3)] == [(1, 1), (2, 2)]


def test_ties_are_broken_beyond_depth_three_only_as_deep_as_allowed():
    attempts = (
        [a(1, "autonomous", 5)] + [a(1, "driver", s) for s in (20, 15, 10, 8)]
        + [a(2, "autonomous", 5)] + [a(2, "driver", s) for s in (20, 15, 10, 7)]
    )
    assert [(row[0], row[1]) for row in rank(attempts, "driver")] == [(1, 1), (2, 2)]
    assert [(row[0], row[1]) for row in rank(attempts, OVERALL, depth=4)] == [(1, 1), (2, 2)]
    # With three attempts allowed, the fourth entries are not compared: a shared rank.
    assert [(row[0], row[1]) for row in rank(attempts, OVERALL, depth=3)] == [(1, 1), (1, 2)]


def test_overall_depth_follows_the_most_attempts_any_type_allows():
    allowed = effective_allowed(KEYS, {"autonomous": 1, "driver": 3}, None)
    depth = skills_depth([allowed])
    assert depth == 3
    attempts = (
        [a(1, "autonomous", 10)] + [a(1, "driver", s) for s in (20, 5, 5)]
        + [a(2, "autonomous", 10)] + [a(2, "driver", s) for s in (20, 5, 4)]
    )
    assert [(row[0], row[1]) for row in rank(attempts, OVERALL, depth=depth)] == [(1, 1), (2, 2)]


def test_season_overall_takes_the_best_session_and_never_mixes_sessions():
    attempts = [
        a(1, "autonomous", 34, session=1), a(1, "driver", 20, session=1),  # 54
        a(1, "autonomous", 24, session=2), a(1, "driver", 28, session=2),  # 52
    ]
    assert rank(attempts, OVERALL) == [(1, 1, 54, [34, 20], 1)]


def test_season_type_tab_comes_from_the_session_holding_the_best_attempt():
    attempts = [a(1, "driver", 20, session=1), a(1, "driver", 18, session=1), a(1, "driver", 25, session=2)]
    assert rank(attempts, "driver") == [(1, 1, 25, [25], 2)]


def test_equal_season_keys_name_the_earlier_session_by_date_then_id():
    order = {
        1: session_order_key(dt.date(2026, 10, 11), 1),
        2: session_order_key(dt.date(2026, 10, 10), 2),
        3: session_order_key(None, 3),
    }
    attempts = [a(1, "driver", 20, session=1), a(1, "driver", 20, session=2), a(1, "driver", 20, session=3)]
    assert rank(attempts, "driver", order=order)[0][4] == 2
    same_day = {1: session_order_key(dt.date(2026, 10, 10), 1), 2: session_order_key(dt.date(2026, 10, 10), 2)}
    assert rank(attempts[:2], "driver", order=same_day)[0][4] == 1


def test_undated_sessions_count_as_later_than_dated_ones():
    assert session_order_key(dt.date(2026, 10, 10), 5) < session_order_key(None, 1)


def test_no_attempts_ranks_nobody():
    assert rank([], OVERALL) == []
    assert rank([], "driver") == []


def test_team_numbers_sort_naturally():
    numbers = ["10", "9A", "A1", "9", "b2"]
    assert sorted(numbers, key=team_number_sort_key) == ["9", "9A", "10", "A1", "b2"]
