from __future__ import annotations

from sqlalchemy import func, select

from award_helpers import create_session, db_session, enter, setup_two_divisions
from tournament_server.models.award import Award, AwardWinner


def _award(db, session_id: int, **overrides) -> Award:
    fields = dict(
        session_id=session_id, name="Judges Award", description=None, position=0, scope="division",
        division_ids=[], kind="judged", source=None, skills_type=None, basis=None, placement=None,
    )
    fields.update(overrides)
    award = Award(**fields)
    db.add(award)
    db.flush()
    return award


def _winner(db, award: Award, division_id, team_id: int) -> None:
    db.add(AwardWinner(award_id=award.id, division_id=division_id, team_id=team_id, origin="judged", recorded_by="admin"))


def _count(db, model, *where) -> int:
    return db.execute(select(func.count()).select_from(model).where(*where)).scalar_one()


def test_deleting_a_session_deletes_its_awards_and_winners(client):
    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client, "Saturday")
    sunday = create_session(client, "Sunday")
    enter(client, saturday, teams["A1"])
    with db_session(client) as db:
        kept = _award(db, sunday)
        gone = _award(db, saturday)
        _winner(db, gone, first, teams["A1"])
        db.commit()
        kept_id = kept.id

    assert client.delete(f"/api/sessions/{saturday}").status_code == 204

    with db_session(client) as db:
        assert _count(db, Award, Award.session_id == saturday) == 0
        assert _count(db, AwardWinner) == 0
        assert db.get(Award, kept_id) is not None


def test_deleting_a_division_drops_it_from_awards_and_deletes_its_winners(client):
    first, second, teams = setup_two_divisions(client)
    saturday = create_session(client)
    enter(client, saturday, teams["A1"], teams["B1"])
    with db_session(client) as db:
        both = _award(db, saturday, division_ids=[first, second])
        only_second = _award(db, saturday, position=1, division_ids=[second])
        _winner(db, both, first, teams["A1"])
        _winner(db, both, second, teams["B1"])
        db.commit()
        both_id, only_second_id = both.id, only_second.id

    assert client.delete(f"/api/divisions/{second}").status_code == 204

    with db_session(client) as db:
        assert db.get(Award, both_id).division_ids == [first]
        # An award left with no divisions covers every division.
        assert db.get(Award, only_second_id).division_ids == []
        remaining = db.execute(select(AwardWinner)).scalars().all()
        assert [(w.division_id, w.team_id) for w in remaining] == [(first, teams["A1"])]


def test_delete_team_award_winners_removes_only_that_teams_rows(client):
    from tournament_server.services.deletion import delete_team_award_winners

    first, _, teams = setup_two_divisions(client)
    saturday = create_session(client)
    with db_session(client) as db:
        award = _award(db, saturday)
        _winner(db, award, first, teams["A1"])
        _winner(db, award, first, teams["A2"])
        db.commit()
        delete_team_award_winners(db, teams["A1"])
        db.commit()
        assert [w.team_id for w in db.execute(select(AwardWinner)).scalars().all()] == [teams["A2"]]
