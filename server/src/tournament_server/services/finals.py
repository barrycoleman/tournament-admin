from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.bracket_matchup import BracketMatchup
from tournament_server.models.field import Field
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.finals_result import FinalsResult
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord


def bracket_capacity(bracket_size: int) -> int:
    capacity = 1
    while capacity < bracket_size:
        capacity *= 2
    return capacity


def total_rounds_for_bracket_size(bracket_size: int) -> int:
    return bracket_capacity(bracket_size).bit_length() - 1


def expand_wins_to_advance(raw: int | list[int], total_rounds: int) -> list[int]:
    if isinstance(raw, int):
        if raw < 1:
            raise ValueError("wins_to_advance must be at least 1")
        return [raw] * total_rounds
    if len(raw) != total_rounds:
        raise ValueError(
            f"wins_to_advance list must have exactly {total_rounds} entries "
            f"for this bracket_size, got {len(raw)}"
        )
    if any(v < 1 for v in raw):
        raise ValueError("every wins_to_advance entry must be at least 1")
    return list(raw)


def wins_to_advance_for_round(bracket: FinalsBracket, round_number: int) -> int:
    return json.loads(bracket.wins_to_advance)[round_number - 1]


def next_finals_field_id(db: Session, bracket: FinalsBracket) -> int:
    field_ids = [
        f.id
        for f in db.execute(
            select(Field).where(Field.field_set_id == bracket.field_set_id).order_by(Field.id)
        ).scalars().all()
    ]
    field_id = field_ids[bracket.next_field_index % len(field_ids)]
    bracket.next_field_index += 1
    db.add(bracket)
    return field_id


def create_score_chase_run(
    db: Session, bracket: FinalsBracket, bracket_alliance: BracketAlliance
) -> Match:
    field_id = next_finals_field_id(db, bracket)
    existing_run_count = len(
        db.execute(
            select(Match).where(Match.finals_bracket_id == bracket.id)
        ).scalars().all()
    )

    match = Match(
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        round_type="elimination",
        match_number=existing_run_count + 1,
        field_id=field_id,
        finals_bracket_id=bracket.id,
        bracket_alliance_id=bracket_alliance.id,
    )
    db.add(match)
    db.flush()

    alliance = Alliance(match_id=match.id, station="solo")
    db.add(alliance)
    db.flush()

    team_ids = [
        row.team_id
        for row in db.execute(
            select(BracketAllianceTeam).where(
                BracketAllianceTeam.bracket_alliance_id == bracket_alliance.id
            )
        ).scalars().all()
    ]
    for team_id in team_ids:
        db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))

    db.commit()
    db.refresh(match)
    return match


def start_score_chase(db: Session, bracket: FinalsBracket) -> None:
    alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket.id)
        .order_by(BracketAlliance.seed.desc())
    ).scalars().all()
    if alliances:
        create_score_chase_run(db, bracket, alliances[0])


def _seed_order(capacity: int) -> list[int]:
    if capacity == 1:
        return [1]
    half = _seed_order(capacity // 2)
    order: list[int] = []
    for seed in half:
        order.append(seed)
        order.append(capacity + 1 - seed)
    return order


def _create_matchup_game(db: Session, bracket: FinalsBracket, matchup: BracketMatchup) -> Match:
    field_id = next_finals_field_id(db, bracket)
    existing_game_count = len(
        db.execute(
            select(Match).where(Match.finals_bracket_id == bracket.id)
        ).scalars().all()
    )

    match = Match(
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        round_type="elimination",
        match_number=existing_game_count + 1,
        field_id=field_id,
        finals_bracket_id=bracket.id,
        bracket_matchup_id=matchup.id,
    )
    db.add(match)
    db.flush()

    for alliance_id, station in (
        (matchup.alliance_a_id, "red"),
        (matchup.alliance_b_id, "blue"),
    ):
        alliance = Alliance(match_id=match.id, station=station)
        db.add(alliance)
        db.flush()
        team_ids = [
            row.team_id
            for row in db.execute(
                select(BracketAllianceTeam).where(
                    BracketAllianceTeam.bracket_alliance_id == alliance_id
                )
            ).scalars().all()
        ]
        for team_id in team_ids:
            db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))

    db.commit()
    db.refresh(match)
    return match


def _maybe_create_matchup_game(
    db: Session, bracket: FinalsBracket, matchup: BracketMatchup
) -> None:
    if matchup.winner_alliance_id is not None:
        return
    if matchup.alliance_a_id is None or matchup.alliance_b_id is None:
        return
    alliance_a = db.get(BracketAlliance, matchup.alliance_a_id)
    alliance_b = db.get(BracketAlliance, matchup.alliance_b_id)
    if alliance_a.unavailable:
        _decide_matchup(db, bracket, matchup.alliance_b_id, matchup)
        return
    if alliance_b.unavailable:
        _decide_matchup(db, bracket, matchup.alliance_a_id, matchup)
        return
    incomplete_game = db.execute(
        select(Match).where(
            Match.bracket_matchup_id == matchup.id, Match.status != "completed"
        )
    ).scalars().first()
    if incomplete_game is not None:
        return
    _create_matchup_game(db, bracket, matchup)


def generate_bracket(db: Session, bracket: FinalsBracket) -> None:
    alliances_by_seed = {
        a.seed: a.id
        for a in db.execute(
            select(BracketAlliance).where(BracketAlliance.bracket_id == bracket.id)
        ).scalars().all()
    }
    capacity = bracket_capacity(bracket.bracket_size)
    total_rounds = total_rounds_for_bracket_size(bracket.bracket_size)
    order = _seed_order(capacity)

    matchups: dict[tuple[int, int], BracketMatchup] = {}
    for round_number in range(1, total_rounds + 1):
        for position in range(capacity // (2**round_number)):
            matchup = BracketMatchup(
                bracket_id=bracket.id, round_number=round_number, position=position
            )
            db.add(matchup)
            db.flush()
            matchups[(round_number, position)] = matchup

    for position in range(capacity // 2):
        seed_a = order[2 * position]
        seed_b = order[2 * position + 1]
        matchup = matchups[(1, position)]
        matchup.alliance_a_id = alliances_by_seed.get(seed_a)
        matchup.alliance_b_id = alliances_by_seed.get(seed_b)
        if matchup.alliance_a_id is not None and matchup.alliance_b_id is None:
            matchup.winner_alliance_id = matchup.alliance_a_id
        elif matchup.alliance_b_id is not None and matchup.alliance_a_id is None:
            matchup.winner_alliance_id = matchup.alliance_b_id
    db.commit()

    if total_rounds > 1:
        for position in range(capacity // 2):
            matchup = matchups[(1, position)]
            if matchup.winner_alliance_id is None:
                continue
            next_matchup = matchups[(2, position // 2)]
            if position % 2 == 0:
                next_matchup.alliance_a_id = matchup.winner_alliance_id
            else:
                next_matchup.alliance_b_id = matchup.winner_alliance_id
        db.commit()

    for round_number in range(1, total_rounds + 1):
        for position in range(capacity // (2**round_number)):
            _maybe_create_matchup_game(db, bracket, matchups[(round_number, position)])


def _decide_matchup(
    db: Session, bracket: FinalsBracket, winner_id: int, matchup: BracketMatchup
) -> None:
    matchup.winner_alliance_id = winner_id
    db.add(matchup)
    db.commit()

    total_rounds = total_rounds_for_bracket_size(bracket.bracket_size)
    if matchup.round_number == total_rounds:
        bracket.status = "complete"
        db.add(bracket)
        db.commit()
        return

    next_matchup = db.execute(
        select(BracketMatchup).where(
            BracketMatchup.bracket_id == bracket.id,
            BracketMatchup.round_number == matchup.round_number + 1,
            BracketMatchup.position == matchup.position // 2,
        )
    ).scalars().first()
    if matchup.position % 2 == 0:
        next_matchup.alliance_a_id = winner_id
    else:
        next_matchup.alliance_b_id = winner_id
    db.add(next_matchup)
    db.commit()
    _maybe_create_matchup_game(db, bracket, next_matchup)


def advance_single_elimination(
    db: Session, bracket: FinalsBracket, game_plugin, match: Match
) -> None:
    matchup = db.get(BracketMatchup, match.bracket_matchup_id)
    if matchup is None or matchup.winner_alliance_id is not None:
        return

    incomplete_game = db.execute(
        select(Match).where(
            Match.bracket_matchup_id == matchup.id, Match.status != "completed"
        )
    ).scalars().first()
    if incomplete_game is not None:
        # Another game in this series is still unscored — this call is
        # either the normal in-flight game just being scored (which is
        # already "completed" by the time this function runs and so isn't
        # itself the "incomplete" one found here) or a correction to an
        # older game while a newer one in the same series is still open.
        # Either way, don't decide the matchup or create another game
        # until every existing game in the series is completed.
        return

    games = db.execute(
        select(Match).where(
            Match.bracket_matchup_id == matchup.id, Match.status == "completed"
        )
    ).scalars().all()

    wins = {matchup.alliance_a_id: 0, matchup.alliance_b_id: 0}
    for game in games:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == game.id)
        ).scalars().all()
        scores: dict[int, int] = {}
        for alliance in alliances:
            score_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
            ).scalars().first()
            if score_record is None:
                continue
            effective_score = (
                0
                if (score_record.no_show or score_record.dq)
                else game_plugin.module.calculate_score(json.loads(score_record.data_json))
            )
            bracket_alliance_id = (
                matchup.alliance_a_id if alliance.station == "red" else matchup.alliance_b_id
            )
            scores[bracket_alliance_id] = effective_score
        if len(scores) == 2:
            score_a = scores[matchup.alliance_a_id]
            score_b = scores[matchup.alliance_b_id]
            if score_a > score_b:
                wins[matchup.alliance_a_id] += 1
            elif score_b > score_a:
                wins[matchup.alliance_b_id] += 1
            # a tied game counts toward neither side's series win

    wins_needed = wins_to_advance_for_round(bracket, matchup.round_number)
    winner_id = None
    if wins[matchup.alliance_a_id] >= wins_needed:
        winner_id = matchup.alliance_a_id
    elif wins[matchup.alliance_b_id] >= wins_needed:
        winner_id = matchup.alliance_b_id

    if winner_id is None:
        _create_matchup_game(db, bracket, matchup)
        return

    _decide_matchup(db, bracket, winner_id, matchup)


def mark_unavailable(db: Session, bracket: FinalsBracket, alliance: BracketAlliance) -> None:
    alliance.unavailable = True
    db.add(alliance)
    db.commit()

    matchup = db.execute(
        select(BracketMatchup).where(
            BracketMatchup.bracket_id == bracket.id,
            BracketMatchup.winner_alliance_id.is_(None),
        ).where(
            (BracketMatchup.alliance_a_id == alliance.id)
            | (BracketMatchup.alliance_b_id == alliance.id)
        )
    ).scalars().first()
    if matchup is None:
        # Either this alliance already won its way out of the bracket, or
        # its matchup hasn't been reached yet (still waiting on an earlier
        # round) — in the latter case, `_maybe_create_matchup_game` will
        # see the `unavailable` flag and resolve the walkover itself the
        # moment that matchup's other side becomes known.
        return
    if matchup.alliance_a_id is not None and matchup.alliance_b_id is not None:
        _maybe_create_matchup_game(db, bracket, matchup)


def recompute_finals_results(db: Session, bracket: FinalsBracket, game_plugin) -> None:
    matches = db.execute(
        select(Match).where(
            Match.finals_bracket_id == bracket.id, Match.status == "completed"
        )
    ).scalars().all()

    scores: dict[int, int] = {}
    for match in matches:
        alliance = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().first()
        if alliance is None:
            continue
        score_record = db.execute(
            select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
        ).scalars().first()
        if score_record is None:
            continue
        effective_score = (
            0
            if (score_record.no_show or score_record.dq)
            else game_plugin.module.calculate_score(json.loads(score_record.data_json))
        )
        scores[match.bracket_alliance_id] = effective_score

    if not scores:
        return

    seeds = {
        a.id: a.seed
        for a in db.execute(
            select(BracketAlliance).where(BracketAlliance.bracket_id == bracket.id)
        ).scalars().all()
    }

    ordered = sorted(
        scores.items(), key=lambda item: (-item[1], seeds[item[0]])
    )

    for rank, (bracket_alliance_id, score) in enumerate(ordered, start=1):
        existing = db.execute(
            select(FinalsResult).where(
                FinalsResult.finals_bracket_id == bracket.id,
                FinalsResult.bracket_alliance_id == bracket_alliance_id,
            )
        ).scalars().first()
        if existing is None:
            db.add(
                FinalsResult(
                    finals_bracket_id=bracket.id,
                    bracket_alliance_id=bracket_alliance_id,
                    score=score,
                    rank=rank,
                )
            )
        else:
            existing.score = score
            existing.rank = rank

    db.commit()


def advance_score_chase(db: Session, bracket: FinalsBracket, game_plugin) -> None:
    recompute_finals_results(db, bracket, game_plugin)

    if bracket.status == "complete":
        return

    existing_runs = db.execute(
        select(Match).where(Match.finals_bracket_id == bracket.id)
    ).scalars().all()
    if any(m.status != "completed" for m in existing_runs):
        # A run's score was resubmitted (e.g. a post-hoc DQ correction) while
        # another run is still in progress or unscored. recompute_finals_results
        # above already refreshed standings for whatever is scored so far —
        # do not create another run or advance the bracket in this case.
        return

    all_alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket.id)
        .order_by(BracketAlliance.seed.desc())
    ).scalars().all()
    ran_alliance_ids = {m.bracket_alliance_id for m in existing_runs}

    remaining = [a for a in all_alliances if a.id not in ran_alliance_ids]
    if remaining:
        create_score_chase_run(db, bracket, remaining[0])
    else:
        bracket.status = "complete"
        db.add(bracket)
        db.commit()
