from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.session import TournamentSession


def build_pairing_history(
    db: Session, event_id: int
) -> dict[frozenset[int], dict[str, int]]:
    session_ids = [
        row.id
        for row in db.execute(
            select(TournamentSession).where(TournamentSession.event_id == event_id)
        ).scalars().all()
    ]
    if not session_ids:
        return {}

    matches = db.execute(
        select(Match).where(Match.session_id.in_(session_ids))
    ).scalars().all()

    history: dict[frozenset[int], dict[str, int]] = {}

    def bump(a: int, b: int, key: str) -> None:
        pair = frozenset((a, b))
        entry = history.setdefault(pair, {"partner_count": 0, "opponent_count": 0})
        entry[key] += 1

    for match in matches:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().all()
        if len(alliances) != 2:
            continue

        teams_by_alliance: list[list[int]] = []
        for alliance in alliances:
            team_ids = [
                row.team_id
                for row in db.execute(
                    select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
                ).scalars().all()
            ]
            teams_by_alliance.append(team_ids)
            for i in range(len(team_ids)):
                for j in range(i + 1, len(team_ids)):
                    bump(team_ids[i], team_ids[j], "partner_count")

        for a in teams_by_alliance[0]:
            for b in teams_by_alliance[1]:
                bump(a, b, "opponent_count")

    return history
