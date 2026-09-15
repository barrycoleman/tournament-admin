from tournament_server.services.team_assignment import balanced_assign


def test_balanced_assign_distributes_evenly_from_zero():
    assignments = balanced_assign(
        team_ids=[1, 2, 3, 4, 5, 6], division_ids=[10, 20, 30], current_counts={}
    )
    assert set(assignments.keys()) == {1, 2, 3, 4, 5, 6}
    assert set(assignments.values()) <= {10, 20, 30}
    counts = {10: 0, 20: 0, 30: 0}
    for division_id in assignments.values():
        counts[division_id] += 1
    assert list(counts.values()) == [2, 2, 2]


def test_balanced_assign_accounts_for_existing_imbalance():
    # Division 10 already has 8 teams, division 20 has 0 -- 4 new teams
    # should all land in division 20 to even things out.
    assignments = balanced_assign(
        team_ids=[1, 2, 3, 4], division_ids=[10, 20], current_counts={10: 8, 20: 0}
    )
    assert all(division_id == 20 for division_id in assignments.values())


def test_balanced_assign_handles_uneven_team_count():
    assignments = balanced_assign(
        team_ids=[1, 2, 3, 4, 5], division_ids=[10, 20], current_counts={}
    )
    counts = {10: 0, 20: 0}
    for division_id in assignments.values():
        counts[division_id] += 1
    assert sorted(counts.values()) == [2, 3]


def test_balanced_assign_empty_teams_returns_empty():
    assert balanced_assign(team_ids=[], division_ids=[10, 20], current_counts={}) == {}
