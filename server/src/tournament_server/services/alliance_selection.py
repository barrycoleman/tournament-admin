"""Partner picking for a `captain_pick` finals bracket: invite, accept,
decline, cancel, undo and finish early.

The captain is always the highest-ranked eligible team not yet on an
alliance. The captain invites any eligible team that is not on an alliance
and has not declined; one invite is open at a time. Accepting forms the next
alliance (its seed is the order alliances form in); declining marks the team
so nobody can invite it again, though it can still become a captain.

Concurrency: every change starts with a conditional UPDATE of the bracket
row (`_claim`). That UPDATE carries the state the change depends on in its
WHERE clause (still selecting, the invite that is or isn't open) and is the
transaction's first write, so SQLite takes its single write lock there.
A second request racing on the same bracket waits for that lock and then
finds its WHERE clause no longer matches (rowcount 0), so two answers to one
invite, or two invites, can never both succeed; everything a change reads
after its claim is read under the lock."""

from __future__ import annotations

import json
from dataclasses import dataclass

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.finals_pick import FinalsPick
from tournament_server.models.ranking import Ranking
from tournament_server.models.team import Team
from tournament_server.services.finals import (
    excluded_team_ids,
    generate_bracket,
    start_score_chase,
    total_rounds_for_bracket_size,
)

SELECTING = "selecting_alliances"
NOT_SELECTING_DETAIL = "This bracket is not currently selecting alliances."
INVITE_OPEN_DETAIL = "An invite is already open."
NO_INVITE_DETAIL = "No invite is open."
WRONG_TEAM_DETAIL = "That team was not the one invited."
NOT_INVITABLE_DETAIL = "That team cannot be invited."
STARTED_DETAIL = "Finals have started — use Start over instead."
NOTHING_TO_UNDO_DETAIL = "There is nothing to undo."
CANNOT_FINISH_DETAIL = "Picking can only end early once no team is left to invite."
TOO_FEW_DETAIL = "Finals need at least two alliances."


class SelectionError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


@dataclass
class SelectionState:
    captain_team_id: int | None
    invitable_team_ids: list[int]  # rank order
    declined_team_ids: list[int]  # rank order
    pending_team_id: int | None
    alliances_formed: int
    alliances_target: int
    last_step: FinalsPick | None


def _eligible_team_ids(db: Session, bracket: FinalsBracket) -> list[int]:
    """Ranked teams for the bracket's session and division, in rank order,
    without the excluded ones."""
    query = select(Ranking.team_id).where(Ranking.session_id == bracket.session_id)
    if bracket.division_id is None:
        query = query.where(Ranking.division_id.is_(None))
    else:
        query = query.where(Ranking.division_id == bracket.division_id)
    excluded = excluded_team_ids(db, bracket.session_id, bracket.division_id)
    ranked = db.execute(query.order_by(Ranking.rank, Ranking.id)).scalars().all()
    return [team_id for team_id in ranked if team_id not in excluded]


def _allied_team_ids(db: Session, bracket: FinalsBracket) -> set[int]:
    return set(
        db.execute(
            select(BracketAllianceTeam.team_id)
            .join(BracketAlliance, BracketAlliance.id == BracketAllianceTeam.bracket_alliance_id)
            .where(BracketAlliance.bracket_id == bracket.id)
        ).scalars().all()
    )


def _picks(db: Session, bracket: FinalsBracket) -> list[FinalsPick]:
    return list(
        db.execute(
            select(FinalsPick).where(FinalsPick.bracket_id == bracket.id).order_by(FinalsPick.seq)
        ).scalars().all()
    )


def _alliance_count(db: Session, bracket: FinalsBracket) -> int:
    return db.execute(
        select(func.count(BracketAlliance.id)).where(BracketAlliance.bracket_id == bracket.id)
    ).scalar_one()


def selection_state(db: Session, bracket: FinalsBracket) -> SelectionState:
    eligible = _eligible_team_ids(db, bracket)
    allied = _allied_team_ids(db, bracket)
    picks = _picks(db, bracket)
    declined = {p.team_id for p in picks if p.kind == "decline"}
    formed = _alliance_count(db, bracket)
    target = bracket.bracket_size
    unallied = [t for t in eligible if t not in allied]
    captain = unallied[0] if unallied and formed < target else None
    return SelectionState(
        captain_team_id=captain,
        invitable_team_ids=[t for t in unallied if t not in declined and t != captain],
        declined_team_ids=[t for t in eligible if t in declined],
        pending_team_id=bracket.pending_team_id,
        alliances_formed=formed,
        alliances_target=target,
        last_step=picks[-1] if picks else None,
    )


def _claim(db: Session, bracket: FinalsBracket, *conditions, **values) -> bool:
    """The guarded first write of every change: updates the bracket row only
    while it is still selecting and `conditions` hold. Returns whether it
    matched; on a miss the transaction is rolled back and `bracket` reloaded."""
    if not values:
        values = {"status": FinalsBracket.status}  # a no-op write that still takes the lock
    result = db.execute(
        update(FinalsBracket)
        .where(FinalsBracket.id == bracket.id, FinalsBracket.status == SELECTING, *conditions)
        .values(**values)
        .execution_options(synchronize_session=False)
    )
    matched = result.rowcount == 1
    if not matched:
        db.rollback()
    db.refresh(bracket)
    return matched


def _fail(db: Session, status: int, detail: str) -> SelectionError:
    db.rollback()
    return SelectionError(status, detail)


def _not_selecting(bracket: FinalsBracket) -> SelectionError:
    if bracket.status in ("in_progress", "complete"):
        return SelectionError(409, STARTED_DETAIL)
    return SelectionError(409, NOT_SELECTING_DETAIL)


def invite(db: Session, bracket: FinalsBracket, team_id: int) -> None:
    if db.get(Team, team_id) is None:  # the claim below writes it into a foreign key
        raise SelectionError(422, NOT_INVITABLE_DETAIL)
    if not _claim(
        db, bracket, FinalsBracket.pending_team_id.is_(None), pending_team_id=team_id
    ):
        if bracket.status != SELECTING:
            raise _not_selecting(bracket)
        raise SelectionError(409, INVITE_OPEN_DETAIL)
    state = selection_state(db, bracket)
    if state.captain_team_id is None or team_id not in state.invitable_team_ids:
        raise _fail(db, 422, NOT_INVITABLE_DETAIL)
    bracket.pending_captain_team_id = state.captain_team_id
    db.commit()


def _close_invite(db: Session, bracket: FinalsBracket, team_id: int | None) -> None:
    """Clears the open invite, guarded on it still being open (and naming
    `team_id`, for an answer). Only one request can win this."""
    open_invite = (
        FinalsBracket.pending_team_id.is_not(None)
        if team_id is None
        else FinalsBracket.pending_team_id == team_id
    )
    if not _claim(db, bracket, open_invite, pending_team_id=None, pending_captain_team_id=None):
        if bracket.status != SELECTING:
            raise _not_selecting(bracket)
        if bracket.pending_team_id is None:
            raise SelectionError(409, NO_INVITE_DETAIL)
        raise SelectionError(409, WRONG_TEAM_DETAIL)


def _next_seq(db: Session, bracket: FinalsBracket) -> int:
    current = db.execute(
        select(func.max(FinalsPick.seq)).where(FinalsPick.bracket_id == bracket.id)
    ).scalar_one()
    return (current or 0) + 1


def accept(db: Session, bracket: FinalsBracket, team_id: int) -> None:
    _close_invite(db, bracket, team_id)
    state = selection_state(db, bracket)
    captain = state.captain_team_id
    if captain is None or team_id not in state.invitable_team_ids:
        raise _fail(db, 409, NOT_INVITABLE_DETAIL)
    alliance = BracketAlliance(bracket_id=bracket.id, seed=state.alliances_formed + 1)
    db.add(alliance)
    db.flush()
    db.add(BracketAllianceTeam(bracket_alliance_id=alliance.id, team_id=captain))
    db.add(BracketAllianceTeam(bracket_alliance_id=alliance.id, team_id=team_id))
    db.add(
        FinalsPick(
            bracket_id=bracket.id,
            seq=_next_seq(db, bracket),
            kind="accept",
            captain_team_id=captain,
            team_id=team_id,
            bracket_alliance_id=alliance.id,
        )
    )
    if state.alliances_formed + 1 >= state.alliances_target:
        _start_matches(db, bracket)
    else:
        db.commit()


def decline(db: Session, bracket: FinalsBracket, team_id: int) -> None:
    _close_invite(db, bracket, team_id)
    state = selection_state(db, bracket)
    if state.captain_team_id is None:
        raise _fail(db, 409, NOT_INVITABLE_DETAIL)
    db.add(
        FinalsPick(
            bracket_id=bracket.id,
            seq=_next_seq(db, bracket),
            kind="decline",
            captain_team_id=state.captain_team_id,
            team_id=team_id,
        )
    )
    db.commit()


def cancel(db: Session, bracket: FinalsBracket) -> None:
    _close_invite(db, bracket, None)
    db.commit()


def undo(db: Session, bracket: FinalsBracket) -> None:
    """Reverses the most recent accept or decline and clears any open invite."""
    if not _claim(db, bracket, pending_team_id=None, pending_captain_team_id=None):
        raise _not_selecting(bracket)
    picks = _picks(db, bracket)
    if not picks:
        raise _fail(db, 409, NOTHING_TO_UNDO_DETAIL)
    last = picks[-1]
    alliance_id = last.bracket_alliance_id
    db.delete(last)
    db.flush()
    if alliance_id is not None:
        for row in db.execute(
            select(BracketAllianceTeam).where(BracketAllianceTeam.bracket_alliance_id == alliance_id)
        ).scalars().all():
            db.delete(row)
        db.flush()
        alliance = db.get(BracketAlliance, alliance_id)
        if alliance is not None:
            db.delete(alliance)
    db.commit()


def finish_early(db: Session, bracket: FinalsBracket) -> None:
    """Ends picking with the alliances formed so far, once no captain or no
    invitable team is left. Shrinks the bracket and keeps the later rounds'
    games-per-round settings (the final stays the final)."""
    if not _claim(db, bracket):
        raise _not_selecting(bracket)
    state = selection_state(db, bracket)
    if state.captain_team_id is not None and state.invitable_team_ids:
        raise _fail(db, 409, CANNOT_FINISH_DETAIL)
    if state.alliances_formed < 2:
        raise _fail(db, 409, TOO_FEW_DETAIL)
    wins = json.loads(bracket.wins_to_advance)
    rounds = total_rounds_for_bracket_size(state.alliances_formed)
    bracket.bracket_size = state.alliances_formed
    bracket.wins_to_advance = json.dumps(wins[-rounds:])
    _start_matches(db, bracket)


def _start_matches(db: Session, bracket: FinalsBracket) -> None:
    bracket.status = "in_progress"
    bracket.pending_team_id = None
    bracket.pending_captain_team_id = None
    db.commit()
    if bracket.format == "score_chase":
        start_score_chase(db, bracket)
    elif bracket.format == "single_elimination":
        generate_bracket(db, bracket)
