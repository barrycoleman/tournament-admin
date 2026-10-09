"""Where performance awards get their winners. Each resolver reads data and
returns the winning team ids for one slot; nothing here writes. Award plugins
will add entries to SOURCES."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_the_event
from tournament_server.models.award import Award
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.bracket_matchup import BracketMatchup
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.finals_result import FinalsResult
from tournament_server.models.ranking import Ranking
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.services import skills as skills_service
from tournament_server.services.skills_ranking import OVERALL, SkillsRankingRow

NOTE_UNKNOWN_SKILLS_TYPE = "unknown_skills_type"
NOTE_SKILLS_DISABLED = "skills_disabled"


@dataclass(frozen=True)
class Resolution:
    team_ids: list[int] = field(default_factory=list)
    # True while the result can still change (a score chase still running).
    provisional: bool = False
    note: str | None = None


def _division_filter(column, division_id: int | None):
    return column.is_(None) if division_id is None else column == division_id


def _teamwork_ranking(db: Session, plugin: LoadedPlugin | None, award: Award, division_id: int | None) -> Resolution:
    session_filter = (
        Ranking.session_id == award.session_id if award.basis == "session" else Ranking.session_id.is_(None)
    )
    team_ids = db.execute(
        select(Ranking.team_id)
        .where(session_filter, _division_filter(Ranking.division_id, division_id), Ranking.rank == award.placement)
        .order_by(Ranking.team_id)
    ).scalars().all()
    return Resolution(list(team_ids))


def _alliance_team_ids(db: Session, bracket_alliance_id: int) -> list[int]:
    return list(
        db.execute(
            select(BracketAllianceTeam.team_id)
            .where(BracketAllianceTeam.bracket_alliance_id == bracket_alliance_id)
            .order_by(BracketAllianceTeam.team_id)
        ).scalars().all()
    )


def single_elimination_placements(db: Session, bracket: FinalsBracket) -> dict[int, int]:
    """Placement -> bracket alliance id, for every placement already decided.
    1st and 2nd come from the final. Below that, alliances are grouped by the
    round they lost in (later rounds first) and ordered by seed inside a
    group; a group counts only once every matchup in its round is decided."""
    matchups = db.execute(select(BracketMatchup).where(BracketMatchup.bracket_id == bracket.id)).scalars().all()
    if not matchups:
        return {}
    seeds = {
        a.id: a.seed
        for a in db.execute(select(BracketAlliance).where(BracketAlliance.bracket_id == bracket.id)).scalars().all()
    }
    total_rounds = max(m.round_number for m in matchups)
    placements: dict[int, int] = {}
    next_place = 1
    for round_number in range(total_rounds, 0, -1):
        # A round-1 matchup with an empty side is a bye: it has no loser.
        contested = [
            m for m in matchups
            if m.round_number == round_number
            and (round_number > 1 or (m.alliance_a_id is not None and m.alliance_b_id is not None))
        ]
        decided = all(m.winner_alliance_id is not None for m in contested)
        if round_number == total_rounds:
            if decided and contested:
                final = contested[0]
                placements[1] = final.winner_alliance_id
                placements[2] = _loser(final)
            next_place = 3
            continue
        if decided:
            losers = sorted((_loser(m) for m in contested), key=lambda alliance_id: seeds[alliance_id])
            for offset, alliance_id in enumerate(losers):
                placements[next_place + offset] = alliance_id
        next_place += len(contested)
    return placements


def _loser(matchup: BracketMatchup) -> int:
    return matchup.alliance_b_id if matchup.winner_alliance_id == matchup.alliance_a_id else matchup.alliance_a_id


def _finals(db: Session, plugin: LoadedPlugin | None, award: Award, division_id: int | None) -> Resolution:
    bracket = db.execute(
        select(FinalsBracket)
        .where(FinalsBracket.session_id == award.session_id, _division_filter(FinalsBracket.division_id, division_id))
        .order_by(FinalsBracket.id.desc())
    ).scalars().first()
    if bracket is None:
        return Resolution()
    if bracket.format == "score_chase":
        result = db.execute(
            select(FinalsResult).where(
                FinalsResult.finals_bracket_id == bracket.id, FinalsResult.rank == award.placement
            )
        ).scalars().first()
        if result is None:
            return Resolution()
        return Resolution(
            _alliance_team_ids(db, result.bracket_alliance_id), provisional=bracket.status != "complete"
        )
    alliance_id = single_elimination_placements(db, bracket).get(award.placement)
    if alliance_id is None:
        return Resolution()
    return Resolution(_alliance_team_ids(db, alliance_id))


def _renumbered(rows: list[SkillsRankingRow]) -> list[tuple[int, int]]:
    """(rank, team_id) after filtering: tied rows keep sharing a rank, and the
    next rank skips, as rank_skills numbers them."""
    out: list[tuple[int, int]] = []
    previous_rank = None
    rank = 0
    for index, row in enumerate(rows, start=1):
        if row.rank != previous_rank:
            rank, previous_rank = index, row.rank
        out.append((rank, row.team_id))
    return out


def _skills(db: Session, plugin: LoadedPlugin | None, award: Award, division_id: int | None) -> Resolution:
    event = get_the_event(db)
    if event is None or not skills_service.is_enabled(db, event.id):
        return Resolution(note=NOTE_SKILLS_DISABLED)
    type_keys = [t["key"] for t in skills_service.plugin_types(plugin)]
    tab = OVERALL if award.source == "skills_overall" else award.skills_type
    if tab != OVERALL and tab not in type_keys:
        return Resolution(note=NOTE_UNKNOWN_SKILLS_TYPE)
    if award.basis == "session":
        sessions = [db.get(TournamentSession, award.session_id)]
    else:
        sessions = list(
            db.execute(select(TournamentSession).where(TournamentSession.event_id == event.id)).scalars().all()
        )
    rows = skills_service.compute_rankings(db, type_keys, tab, sessions)
    if division_id is not None:
        in_division = set(db.execute(select(Team.id).where(Team.division_id == division_id)).scalars().all())
        rows = [row for row in rows if row.team_id in in_division]
    return Resolution(sorted(team_id for rank, team_id in _renumbered(rows) if rank == award.placement))


SOURCES: dict[str, Callable[[Session, LoadedPlugin | None, Award, int | None], Resolution]] = {
    "teamwork_ranking": _teamwork_ranking,
    "finals": _finals,
    "skills_overall": _skills,
    "skills_type": _skills,
}


def resolve(db: Session, plugin: LoadedPlugin | None, award: Award, division_id: int | None) -> Resolution:
    return SOURCES[award.source](db, plugin, award, division_id)
