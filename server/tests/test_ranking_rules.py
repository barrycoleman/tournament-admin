import pytest

from tournament_server.services.ranking_rules import (
    MatchRecord,
    RankingRules,
    season_score,
    session_drop_allowance,
    session_drops,
    session_score,
    suggest_exclusion_count,
    suggest_finalize_drops,
)


def rec(match_id, score, session_id=1, no_show=False, dq=False):
    return MatchRecord(match_id=match_id, session_id=session_id, score=score, no_show=no_show, dq=dq)


def ascending(count):
    """count records with distinct scores 10, 20, ... so the lowest is unambiguous."""
    return [rec(i, i * 10) for i in range(1, count + 1)]


@pytest.mark.parametrize(
    "scheduled, expected",
    [(0, 0), (3, 0), (4, 1), (7, 1), (8, 2), (11, 2), (12, 3), (15, 3), (16, 4), (30, 4)],
)
def test_tier_table_on_scheduled_matches(scheduled, expected):
    assert suggest_exclusion_count(scheduled) == expected
    assert session_drop_allowance(scheduled, RankingRules()) == expected


def test_allowance_for_none_and_lowest():
    assert session_drop_allowance(20, RankingRules(session_drop_mode="none")) == 0
    assert session_drop_allowance(2, RankingRules(session_drop_mode="lowest", session_drop_count=3)) == 3


@pytest.mark.parametrize("scored, expected_drops", [(5, 0), (7, 0), (8, 1), (9, 2), (10, 3)])
def test_lowest_p_drops_are_earned_against_the_schedule(scored, expected_drops):
    rules = RankingRules(session_drop_mode="lowest", session_drop_count=3)
    records = ascending(scored)
    dropped = session_drops(records, scheduled=10, rules=rules)
    assert dropped == {r.match_id for r in records[:expected_drops]}


@pytest.mark.parametrize("scored, expected_drops", [(12, 0), (13, 1), (14, 2), (16, 4)])
def test_tiered_drops_are_earned_on_the_last_scheduled_matches(scored, expected_drops):
    records = ascending(scored)
    assert len(session_drops(records, scheduled=16, rules=RankingRules())) == expected_drops


def test_none_drops_nothing():
    assert session_drops(ascending(16), scheduled=16, rules=RankingRules(session_drop_mode="none")) == set()


def test_lowest_p_at_least_the_schedule_keeps_one_record():
    rules = RankingRules(session_drop_mode="lowest", session_drop_count=3)
    records = ascending(3)
    assert session_drops(records, scheduled=3, rules=rules) == {1, 2}
    assert session_drops([rec(1, 20)], scheduled=1, rules=rules) == set()


def test_protected_no_show_is_skipped_and_the_next_lowest_dropped():
    records = [rec(1, 0, no_show=True), rec(2, 10), rec(3, 20), rec(4, 30)]
    assert session_drops(records, scheduled=4, rules=RankingRules()) == {2}
    allowed = RankingRules(session_drop_no_show=True)
    assert session_drops(records, scheduled=4, rules=allowed) == {1}


def test_protected_dq_is_skipped_and_the_next_lowest_dropped():
    records = [rec(1, 0, dq=True), rec(2, 10), rec(3, 20), rec(4, 30)]
    assert session_drops(records, scheduled=4, rules=RankingRules()) == {2}
    # Allowing no-shows to be dropped does nothing for a DQ.
    assert session_drops(records, scheduled=4, rules=RankingRules(session_drop_no_show=True)) == {2}
    assert session_drops(records, scheduled=4, rules=RankingRules(session_drop_dq=True)) == {1}


def test_equal_scores_drop_the_earliest_match():
    records = [rec(5, 10), rec(2, 10), rec(7, 20), rec(8, 30)]
    assert session_drops(records, scheduled=4, rules=RankingRules()) == {2}


def test_session_score_is_the_mean_of_kept_records():
    records = [rec(1, 10), rec(2, 20), rec(3, 30)]
    assert session_score(records, {1}) == 25.0
    assert session_score(records, set()) == 20.0
    assert session_score([], set()) == 0.0


def test_season_shortfall_fills_with_zeroes():
    records = [rec(i, i, session_id=1 if i <= 10 else 2) for i in range(1, 21)]
    rules = RankingRules(season_keep_best=24, season_minimum=24, season_only_session_counted=True)
    # Sessions dropped matches 1, 2 and 3: 17 remain, sum 204, divided by the minimum.
    assert season_score(records, {1, 2, 3}, rules) == 204 / 24


def test_season_forced_zero_takes_one_of_the_n_slots():
    records = [rec(1, 0, dq=True)] + [rec(i, s) for i, s in zip(range(2, 8), [50, 40, 30, 20, 10, 5])]
    assert season_score(records, set(), RankingRules(season_keep_best=5)) == 28.0


def test_season_more_forced_zeroes_than_n_scores_zero():
    records = [rec(i, 0, dq=True) for i in range(1, 5)] + [rec(9, 80)]
    assert season_score(records, set(), RankingRules(season_keep_best=3)) == 0.0


def test_season_keeps_a_session_dropped_zero_that_the_season_protects():
    records = [rec(1, 0, no_show=True), rec(2, 30), rec(3, 40)]
    rules = RankingRules(season_only_session_counted=True)
    assert season_score(records, {1}, rules) == pytest.approx(70 / 3)
    allowed = RankingRules(season_only_session_counted=True, season_drop_no_show=True)
    assert season_score(records, {1}, allowed) == 35.0


def test_season_defaults_are_a_plain_average():
    records = [rec(1, 10), rec(2, 20), rec(3, 60)]
    assert season_score(records, {1}, RankingRules()) == 30.0
    assert season_score([], set(), RankingRules()) == 0.0


def test_season_minimum_without_n():
    assert season_score([rec(1, 30), rec(2, 30)], set(), RankingRules(season_minimum=4)) == 15.0


def test_season_n_without_minimum():
    records = [rec(1, 10), rec(2, 20), rec(3, 30)]
    assert season_score(records, set(), RankingRules(season_keep_best=2)) == 25.0


def test_season_checkbox_off_versus_on():
    records = [rec(1, 10), rec(2, 20), rec(3, 30)]
    assert season_score(records, {1}, RankingRules()) == 20.0
    assert season_score(records, {1}, RankingRules(season_only_session_counted=True)) == 25.0


def test_finalized_drops_apply_immediately_without_the_earning_gate():
    records = ascending(8)  # 10..80; 10 were scheduled, so open-session tiers would earn nothing yet
    assert session_drops(records, 10, RankingRules()) == set()
    assert session_drops(records, 10, RankingRules(), finalized_drops=2) == {1, 2}


def test_finalized_drops_never_drop_the_last_record():
    assert session_drops(ascending(2), 2, RankingRules(), finalized_drops=5) == {1}
    assert session_drops(ascending(1), 1, RankingRules(), finalized_drops=1) == set()


def test_finalized_drops_respect_no_show_and_dq_settings():
    records = [rec(1, 0, no_show=True), rec(2, 0, dq=True), rec(3, 30), rec(4, 40)]
    assert session_drops(records, 4, RankingRules(), finalized_drops=1) == {3}
    allow = RankingRules(session_drop_no_show=True)
    assert session_drops(records, 4, allow, finalized_drops=1) == {1}


def test_finalized_zero_drops_nothing():
    assert session_drops(ascending(8), 8, RankingRules(), finalized_drops=0) == set()


@pytest.mark.parametrize(
    "rules, played, expected",
    [
        (RankingRules(), 7, 1),
        (RankingRules(), 8, 2),
        (RankingRules(), 1, 0),
        (RankingRules(session_drop_mode="lowest", session_drop_count=3), 8, 3),
        (RankingRules(session_drop_mode="lowest", session_drop_count=3), 2, 1),  # capped at played - 1
        (RankingRules(session_drop_mode="none"), 8, 0),
        (RankingRules(session_drop_mode="lowest", session_drop_count=3), 0, 0),
    ],
)
def test_suggest_finalize_drops(rules, played, expected):
    assert suggest_finalize_drops(played, rules) == expected
