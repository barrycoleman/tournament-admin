"""add bracket_matchups matchup_number

Revision ID: c9d34b7a1f02
Revises: a2c6f19e4d80
Create Date: 2026-09-28 09:05:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'c9d34b7a1f02'
down_revision: Union[str, None] = 'a2c6f19e4d80'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Nullable: this column is added to every row (new and pre-existing)
    # as nullable, since a fresh INSERT via the ORM going forward always
    # supplies a real value and there's no NOT NULL constraint to satisfy
    # for SQLite's ADD COLUMN here.
    op.add_column(
        'bracket_matchups', sa.Column('matchup_number', sa.Integer(), nullable=True)
    )

    # Backfill matchup_number for any pre-existing bracket_matchups rows.
    # It's fully derivable from each row's own (bracket_id, round_number,
    # position): services/finals.py's generate_bracket assigns it as a
    # running counter per bracket, in round-ascending-then-position-
    # ascending order -- exactly the ORDER BY below. Without this
    # backfill, a pre-existing bracket's matchups would all have
    # matchup_number NULL, and services/match_labeling.py's match_label()
    # raises ValueError whenever bracket_matchup_id is set but
    # matchup_number is None -- which routers/matches.py's _to_match_read
    # hits once per match, taking down the entire GET /api/matches list
    # for any session containing such a bracket (see this fix wave's
    # Finding 1; routers/matches.py also gets its own defense-in-depth
    # fallback for any row this backfill still can't correctly account
    # for).
    connection = op.get_bind()
    rows = connection.execute(
        sa.text(
            "SELECT id, bracket_id FROM bracket_matchups "
            "ORDER BY bracket_id, round_number, position"
        )
    ).all()
    counters: dict[int, int] = {}
    for row in rows:
        counters[row.bracket_id] = counters.get(row.bracket_id, 0) + 1
        connection.execute(
            sa.text(
                "UPDATE bracket_matchups SET matchup_number = :matchup_number "
                "WHERE id = :id"
            ),
            {"matchup_number": counters[row.bracket_id], "id": row.id},
        )


def downgrade() -> None:
    op.drop_column('bracket_matchups', 'matchup_number')
