from __future__ import annotations

import pytest

from award_helpers import create_session, db_session, setup_two_divisions
from skills_helpers import enable_skills, record_attempt
from tournament_server.models.award import Award
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.bracket_matchup import BracketMatchup
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.finals_result import FinalsResult
from tournament_server.models.ranking import Ranking
from tournament_server.services.award_sources import (
    NOTE_SKILLS_DISABLED,
    NOTE_UNKNOWN_SKILLS_TYPE,
    Resolution,
    resolve,
)


def _plugin(client):
    return client.app.state.game_plugins["example-game"]


def _award(session_id: int, source: str, placement: int, basis: str = "session", skills_type=None, scope="division"):
    return Award(
        session_id=session_id, name="X", position=0, scope=scope, division_ids=[], kind="performance",
        source=source, skills_type=skills_type, basis=basis, placement=placement,
    )


# --- teamwork rankings -------------------------------------------------------


def test_teamwork_ranking_reads_session_or_season_rankings_for_the_division(client):
    first, second, teams = setup_two_divisions(client)
    saturday = create_session(client)
    with db_session(client) as db:
        db.add_all([
            Ranking(session_id=saturday, division_id=first, team_id=teams["A1"], rank=1),
            Ranking(session_id=saturday, division_id=first, team_id=teams["A2"], rank=2),
            Ranking(session_id=saturday, division_id=second, team_id=teams["B1"], rank=1),
            Ranking(session_id=None, division_id=first, team_id=teams["A2"], rank=1),
        ])
        db.commit()
        plugin = _plugin(client)
        assert resolve(db, plugin, _award(saturday, "teamwork_ranking", 1), first) == Resolution([teams["A1"]])
        assert resolve(db, plugin, _award(saturday, "teamwork_ranking", 2), first) == Resolution([teams["A2"]])
        assert resolve(db, plugin, _award(saturday, "teamwork_ranking", 1), second) == Resolution([teams["B1"]])
        assert resolve(db, plugin, _award(saturday, "teamwork_ranking", 1, basis="season"), first) == Resolution(
            [teams["A2"]]
        )
        assert resolve(db, plugin, _award(saturday, "teamwork_ranking", 3), first) == Resolution([])


# --- finals ------------------------------------------------------------------


def _bracket(db, session_id: int, division_id: int, fmt: str, status: str = "in_progress") -> FinalsBracket:
    field_set = FieldSet(session_id=session_id, name="Finals")
    db.add(field_set)
    db.flush()
    bracket = FinalsBracket(
        session_id=session_id, division_id=division_id, field_set_id=field_set.id, format=fmt,
        bracket_size=4, status=status,
    )
    db.add(bracket)
    db.flush()
    return bracket


def _alliance(db, bracket: FinalsBracket, seed: int, *team_ids: int) -> int:
    alliance = BracketAlliance(bracket_id=bracket.id, seed=seed)
    db.add(alliance)
    db.flush()
    for team_id in team_ids:
        db.add(BracketAllianceTeam(bracket_alliance_id=alliance.id, team_id=team_id))
    db.flush()
    return alliance.id


def _matchup(db, bracket, round_number, position, a, b, winner=None) -> None:
    db.add(BracketMatchup(
        bracket_id=bracket.id, round_number=round_number, position=position,
        alliance_a_id=a, alliance_b_id=b, winner_alliance_id=winner,
    ))
    db.flush()


def _four_alliance_bracket(db, session_id, division_id, teams):
    """Seeds 1..4 = (A1,A2), (A3,A4), (A5,A6), (A7,A8). Semis: 1 v 4, 2 v 3."""
    bracket = _bracket(db, session_id, division_id, "single_elimination")
    ids = {
        seed: _alliance(db, bracket, seed, teams[f"A{2 * seed - 1}"], teams[f"A{2 * seed}"])
        for seed in (1, 2, 3, 4)
    }
    return bracket, ids


def test_single_elimination_places_champion_runner_up_then_semifinal_losers_by_seed(client):
    first, _, teams = setup_two_divisions(client, per_division=8)
    saturday = create_session(client)
    with db_session(client) as db:
        bracket, ids = _four_alliance_bracket(db, saturday, first, teams)
        # Seed 4 beats seed 1; seed 2 beats seed 3; seed 2 wins the final.
        _matchup(db, bracket, 1, 0, ids[1], ids[4], ids[4])
        _matchup(db, bracket, 1, 1, ids[2], ids[3], ids[2])
        _matchup(db, bracket, 2, 0, ids[4], ids[2], ids[2])
        db.commit()
        plugin = _plugin(client)
        placed = {p: resolve(db, plugin, _award(saturday, "finals", p), first).team_ids for p in (1, 2, 3, 4, 5)}
    assert placed[1] == [teams["A3"], teams["A4"]]  # seed 2
    assert placed[2] == [teams["A7"], teams["A8"]]  # seed 4
    assert placed[3] == [teams["A1"], teams["A2"]]  # seed 1, the better-seeded semifinal loser
    assert placed[4] == [teams["A5"], teams["A6"]]  # seed 3
    assert placed[5] == []


def test_single_elimination_placements_wait_for_their_round(client):
    first, _, teams = setup_two_divisions(client, per_division=8)
    saturday = create_session(client)
    with db_session(client) as db:
        bracket, ids = _four_alliance_bracket(db, saturday, first, teams)
        _matchup(db, bracket, 1, 0, ids[1], ids[4], ids[1])
        _matchup(db, bracket, 1, 1, ids[2], ids[3], None)  # still being played
        _matchup(db, bracket, 2, 0, ids[1], None, None)
        db.commit()
        plugin = _plugin(client)
        for placement in (1, 2, 3, 4):
            result = resolve(db, plugin, _award(saturday, "finals", placement), first)
            assert result == Resolution([]), placement


def test_single_elimination_third_place_is_known_before_the_final(client):
    first, _, teams = setup_two_divisions(client, per_division=8)
    saturday = create_session(client)
    with db_session(client) as db:
        bracket, ids = _four_alliance_bracket(db, saturday, first, teams)
        _matchup(db, bracket, 1, 0, ids[1], ids[4], ids[1])
        _matchup(db, bracket, 1, 1, ids[2], ids[3], ids[3])
        _matchup(db, bracket, 2, 0, ids[1], ids[3], None)
        db.commit()
        plugin = _plugin(client)
        assert resolve(db, plugin, _award(saturday, "finals", 1), first) == Resolution([])
        assert resolve(db, plugin, _award(saturday, "finals", 3), first).team_ids == [teams["A3"], teams["A4"]]
        assert resolve(db, plugin, _award(saturday, "finals", 4), first).team_ids == [teams["A7"], teams["A8"]]


def test_single_elimination_quarterfinal_losers_follow_semifinal_losers_and_byes_are_skipped(client):
    first, _, teams = setup_two_divisions(client, per_division=12)
    saturday = create_session(client)
    with db_session(client) as db:
        bracket = _bracket(db, saturday, first, "single_elimination")
        bracket.bracket_size = 6
        ids = {seed: _alliance(db, bracket, seed, teams[f"A{2 * seed - 1}"], teams[f"A{2 * seed}"]) for seed in range(1, 7)}
        # Capacity 8: seeds 1 and 2 have byes (their opponents 8 and 7 do not exist).
        _matchup(db, bracket, 1, 0, ids[1], None, ids[1])
        _matchup(db, bracket, 1, 1, ids[4], ids[5], ids[4])
        _matchup(db, bracket, 1, 2, ids[3], ids[6], ids[6])
        _matchup(db, bracket, 1, 3, ids[2], None, ids[2])
        _matchup(db, bracket, 2, 0, ids[1], ids[4], ids[1])
        _matchup(db, bracket, 2, 1, ids[6], ids[2], ids[2])
        _matchup(db, bracket, 3, 0, ids[1], ids[2], ids[1])
        db.commit()
        plugin = _plugin(client)

        def seed_of(placement):
            team_ids = resolve(db, plugin, _award(saturday, "finals", placement), first).team_ids
            return next(seed for seed, alliance_id in ids.items() if teams[f"A{2 * seed - 1}"] in team_ids)

        assert [seed_of(p) for p in range(1, 7)] == [1, 2, 4, 6, 3, 5]
        assert resolve(db, plugin, _award(saturday, "finals", 7), first) == Resolution([])


def test_score_chase_uses_finals_results_and_is_provisional_until_complete(client):
    first, _, teams = setup_two_divisions(client, per_division=4)
    saturday = create_session(client)
    with db_session(client) as db:
        bracket = _bracket(db, saturday, first, "score_chase")
        low = _alliance(db, bracket, 1, teams["A1"], teams["A2"])
        high = _alliance(db, bracket, 2, teams["A3"], teams["A4"])
        db.add_all([
            FinalsResult(finals_bracket_id=bracket.id, bracket_alliance_id=high, score=90, rank=1),
            FinalsResult(finals_bracket_id=bracket.id, bracket_alliance_id=low, score=40, rank=2),
        ])
        db.commit()
        plugin = _plugin(client)
        assert resolve(db, plugin, _award(saturday, "finals", 1), first) == Resolution(
            [teams["A3"], teams["A4"]], provisional=True
        )
        bracket.status = "complete"
        db.commit()
        assert resolve(db, plugin, _award(saturday, "finals", 2), first) == Resolution([teams["A1"], teams["A2"]])
        assert resolve(db, plugin, _award(saturday, "finals", 3), first) == Resolution([])


def test_finals_uses_the_newest_bracket_and_no_bracket_is_no_result(client):
    first, second, teams = setup_two_divisions(client, per_division=4)
    saturday = create_session(client)
    with db_session(client) as db:
        old = _bracket(db, saturday, first, "score_chase", status="complete")
        old_alliance = _alliance(db, old, 1, teams["A1"])
        db.add(FinalsResult(finals_bracket_id=old.id, bracket_alliance_id=old_alliance, score=10, rank=1))
        new = _bracket(db, saturday, first, "score_chase", status="complete")
        new_alliance = _alliance(db, new, 1, teams["A2"])
        db.add(FinalsResult(finals_bracket_id=new.id, bracket_alliance_id=new_alliance, score=20, rank=1))
        db.commit()
        plugin = _plugin(client)
        assert resolve(db, plugin, _award(saturday, "finals", 1), first).team_ids == [teams["A2"]]
        assert resolve(db, plugin, _award(saturday, "finals", 1), second) == Resolution([])


# --- skills ------------------------------------------------------------------


def _skills_session(client, teams, scores: dict[str, int]) -> int:
    """Records one driver attempt per team (example-game scores objects * 2)."""
    session_id = create_session(client)
    enable_skills(client)
    for number, score in scores.items():
        client.post(f"/api/sessions/{session_id}/participants", json={"team_id": teams[number], "checked_in": True})
        assert record_attempt(client, session_id, teams[number], "driver", objects=score // 2).status_code == 201
    return session_id


def test_skills_overall_and_type_event_wide(client):
    _, _, teams = setup_two_divisions(client)
    saturday = _skills_session(client, teams, {"A1": 10, "B1": 20, "A2": 6})
    with db_session(client) as db:
        plugin = _plugin(client)
        overall = _award(saturday, "skills_overall", 1, scope="event")
        driver = _award(saturday, "skills_type", 2, skills_type="driver", scope="event")
        assert resolve(db, plugin, overall, None).team_ids == [teams["B1"]]
        assert resolve(db, plugin, driver, None).team_ids == [teams["A1"]]


def test_division_skills_renumbers_and_keeps_ties(client):
    first, second, teams = setup_two_divisions(client)
    # Event-wide: B1 30, A1 20 and A2 20 (tied), B2 16, A3 10.
    saturday = _skills_session(client, teams, {"B1": 30, "A1": 20, "A2": 20, "B2": 16, "A3": 10})
    with db_session(client) as db:
        plugin = _plugin(client)
        first_place = resolve(db, plugin, _award(saturday, "skills_overall", 1), first)
        assert first_place.team_ids == sorted([teams["A1"], teams["A2"]])
        # The tie takes places 1 and 2 in Division 1, so A3 is third and nobody is second.
        assert resolve(db, plugin, _award(saturday, "skills_overall", 2), first) == Resolution([])
        assert resolve(db, plugin, _award(saturday, "skills_overall", 3), first).team_ids == [teams["A3"]]
        assert resolve(db, plugin, _award(saturday, "skills_overall", 2), second).team_ids == [teams["B2"]]


def test_skills_season_basis_uses_every_session(client):
    _, _, teams = setup_two_divisions(client)
    saturday = _skills_session(client, teams, {"A1": 10})
    sunday = create_session(client, "Sunday")
    client.post(f"/api/sessions/{sunday}/participants", json={"team_id": teams["A2"], "checked_in": True})
    assert record_attempt(client, sunday, teams["A2"], "driver", objects=15).status_code == 201
    with db_session(client) as db:
        plugin = _plugin(client)
        assert resolve(db, plugin, _award(saturday, "skills_overall", 1, scope="event"), None).team_ids == [teams["A1"]]
        assert resolve(
            db, plugin, _award(saturday, "skills_overall", 1, basis="season", scope="event"), None
        ).team_ids == [teams["A2"]]


@pytest.mark.parametrize(("enabled", "skills_type", "note"), [
    (False, "driver", NOTE_SKILLS_DISABLED),
    (True, "juggling", NOTE_UNKNOWN_SKILLS_TYPE),
])
def test_skills_no_result_notes(client, enabled, skills_type, note):
    _, _, _ = setup_two_divisions(client)
    saturday = create_session(client)
    if enabled:
        enable_skills(client)
    with db_session(client) as db:
        award = _award(saturday, "skills_type", 1, skills_type=skills_type, scope="event")
        assert resolve(db, _plugin(client), award, None) == Resolution([], note=note)
