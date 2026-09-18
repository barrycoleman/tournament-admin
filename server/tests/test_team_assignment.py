from __future__ import annotations

from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.models.division import Division
from tournament_server.models.event import Event
from tournament_server.models.team import Team
from tournament_server.services.team_assignment import (
    assign_sole_division,
    balanced_assign,
    get_sole_division_id,
)


def _db(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


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


def test_assign_sole_division_is_a_no_op_with_zero_divisions(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    team = Team(event_id=event.id, number="1234A", name="Robo Raiders", division_id=None)
    db.add(team)
    db.commit()

    updated = assign_sole_division(db, event.id)

    assert updated == 0
    db.refresh(team)
    assert team.division_id is None


def test_assign_sole_division_is_a_no_op_with_more_than_one_division(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    division_a = Division(event_id=event.id, name="A")
    division_b = Division(event_id=event.id, name="B")
    db.add_all([division_a, division_b])
    db.flush()
    team = Team(event_id=event.id, number="1234A", name="Robo Raiders", division_id=None)
    db.add(team)
    db.commit()

    updated = assign_sole_division(db, event.id)

    assert updated == 0
    db.refresh(team)
    assert team.division_id is None


def test_assign_sole_division_assigns_every_unassigned_team(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    division = Division(event_id=event.id, name="Division 1")
    db.add(division)
    db.flush()
    unassigned1 = Team(event_id=event.id, number="1234A", name="T1", division_id=None)
    unassigned2 = Team(event_id=event.id, number="5678B", name="T2", division_id=None)
    db.add_all([unassigned1, unassigned2])
    db.commit()

    updated = assign_sole_division(db, event.id)

    assert updated == 2
    db.refresh(unassigned1)
    db.refresh(unassigned2)
    assert unassigned1.division_id == division.id
    assert unassigned2.division_id == division.id


def test_assign_sole_division_leaves_already_assigned_teams_alone(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    division = Division(event_id=event.id, name="Division 1")
    db.add(division)
    db.flush()
    team = Team(
        event_id=event.id, number="1234A", name="Already Assigned", division_id=division.id
    )
    db.add(team)
    db.commit()

    updated = assign_sole_division(db, event.id)

    assert updated == 0


def test_assign_sole_division_only_touches_teams_in_the_given_event(tmp_path):
    db = _db(tmp_path)
    event1 = Event(name="Event One")
    db.add(event1)
    db.flush()
    division1 = Division(event_id=event1.id, name="Division 1")
    db.add(division1)
    db.flush()
    team_in_event1 = Team(event_id=event1.id, number="1234A", name="T1", division_id=None)
    db.add(team_in_event1)
    db.commit()

    updated = assign_sole_division(db, event1.id)

    assert updated == 1
    db.refresh(team_in_event1)
    assert team_in_event1.division_id == division1.id


def test_get_sole_division_id_returns_none_with_zero_divisions(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.commit()

    assert get_sole_division_id(db, event.id) is None


def test_get_sole_division_id_returns_none_with_more_than_one_division(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    db.add_all([Division(event_id=event.id, name="A"), Division(event_id=event.id, name="B")])
    db.commit()

    assert get_sole_division_id(db, event.id) is None


def test_get_sole_division_id_returns_the_id_when_exactly_one_exists(tmp_path):
    db = _db(tmp_path)
    event = Event(name="Regional Qualifier")
    db.add(event)
    db.flush()
    division = Division(event_id=event.id, name="Division 1")
    db.add(division)
    db.commit()

    assert get_sole_division_id(db, event.id) == division.id
